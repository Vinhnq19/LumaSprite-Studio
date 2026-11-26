import './workbench.css';
import {
  analyzeTimingSync,
  expandPlaybackSequence,
  getLoopBoundaryFrames,
  sampleSyncedPlayback,
  type SyncedPlaybackSample,
} from '../../../src/studio/art-review/animation-sync.ts';
import { parseAnimationMetadata, parseReviewManifest } from '../../../src/studio/art-review/metadata.ts';
import {
  checkCompatibility,
  computeFrameDiff,
  computeSilhouette,
  sliceSpriteStrip,
  type PixelDiffResult,
} from '../../../src/studio/art-review/pixel-ops.ts';
import {
  createAssetReferenceSnapshot,
  createEmptyReviewSession,
  parseReviewJson,
  renderReviewMarkdown,
  serializeReviewJson,
} from '../../../src/studio/art-review/report.ts';
import {
  DEFAULT_WORKBENCH_RUBRIC,
  parseRubricJson,
  summarizeReviewScores,
} from '../../../src/studio/art-review/rubrics.ts';
import {
  ART_REVIEW_TOOL_VERSION,
  ASSET_FAMILIES,
  type AlignmentMode,
  type AssetFamily,
  type BackgroundMode,
  type CriterionSeverity,
  type LoadedAsset,
  type Pivot,
  type ReviewDecision,
  type ReviewFrame,
  type ReviewSessionData,
  type ReviewSlot,
  type RubricDefinition,
  type SilhouetteMode,
  type SyncMode,
  type ViewMode,
  type ZoomLevel,
} from '../../../src/studio/art-review/types.ts';
import { composite, type PixelAsset } from '../../../src/studio/pixel/model.ts';
import type { Session } from '../session.ts';
import {
  base64ToBytes,
  bytesToBase64,
  decodeLocalPng,
  sha256Hex,
  type DecodedPng,
} from './png-decode.ts';
import {
  ComparisonViewer,
  renderFrameThumbnail,
  type HoverInspection,
  type ViewerFrameSelection,
} from './viewer.ts';

interface WorkbenchOptions {
  session: Session;
  error: (err: unknown) => void;
}

interface SlotRawBuffer {
  decoded: DecodedPng;
  metadataText?: string;
  metadataFileName?: string;
  metadataSha256?: string;
}

interface PersistedDraft {
  session: ReviewSessionData;
  rubric: RubricDefinition;
  viewMode: ViewMode;
  zoom: ZoomLevel;
  background: BackgroundMode;
  silhouetteMode: SilhouetteMode;
  syncMode: SyncMode;
  loop: boolean;
  slots: Partial<
    Record<
      ReviewSlot,
      {
        name: string;
        fileName: string;
        pngBase64?: string;
        metadataText?: string;
        metadataFileName?: string;
        pivot?: Pivot;
      }
    >
  >;
}

const STORAGE_KEY = 'pxl.art-review.workbench.v1';
const MAX_CACHED_PNG_BYTES = 256 * 1024;

function downloadTextOrBlob(content: BlobPart, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Independent Human Art Review Workbench for pixel art A/B comparison,
 * synchronized animation review, and family-specific human scoring.
 */
export class ArtReviewWorkbench {
  readonly dialog: HTMLDialogElement;
  private readonly options: WorkbenchOptions;
  private readonly viewer: ComparisonViewer;

  private rubric: RubricDefinition = DEFAULT_WORKBENCH_RUBRIC;
  private review: ReviewSessionData;
  private assets: Partial<Record<ReviewSlot, LoadedAsset>> = {};
  private rawSlots: Partial<Record<ReviewSlot, SlotRawBuffer>> = {};
  private pendingMeta: Partial<Record<ReviewSlot, { text: string; fileName: string; sha256: string }>> = {};
  private slotQueues: Record<ReviewSlot, Promise<void>> = {
    baseline: Promise.resolve(),
    candidate: Promise.resolve(),
  };

  private syncMode: SyncMode = 'time';
  private loop = true;
  private playing = false;
  private elapsedMs = 0;
  private manualFrameIndex = 0;
  private playTimer?: ReturnType<typeof setTimeout>;
  private lastTickAt = 0;
  private showLoopBoundary = false;
  private pinMode = false;
  private activeRegionNoteId?: string;

  constructor(options: WorkbenchOptions) {
    this.options = options;
    this.review = createEmptyReviewSession('character', this.rubric);

    this.dialog = document.createElement('dialog');
    this.dialog.id = 'art-review-workbench';
    this.dialog.className = 'large-workspace art-review-dialog';
    this.dialog.setAttribute('aria-labelledby', 'arw-title');
    this.dialog.innerHTML = this.buildMarkup();
    document.body.append(this.dialog);

    this.viewer = new ComparisonViewer({
      hostDual: this.el('arw-dual'),
      hostSingle: this.el('arw-single'),
      canvasA: this.el<HTMLCanvasElement>('arw-canvas-a'),
      canvasB: this.el<HTMLCanvasElement>('arw-canvas-b'),
      canvasSingle: this.el<HTMLCanvasElement>('arw-canvas-single'),
    });

    this.viewer.onHover = (info, locked) => this.renderInspector(info, locked);
    this.viewer.onPickPixel = info => {
      if (this.pinMode) {
        this.addRegionNoteFromClick(info);
      }
    };
    this.viewer.onStateChange = () => {
      this.syncToolbarButtons();
      this.persistDraft();
    };
    this.viewer.onDiffComputed = diff => {
      this.review.diffStats = diff?.stats;
      this.renderDiffReadout(diff);
    };

    this.bindEvents();
    void this.restorePersistedDraft();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.dialog.querySelector<T>(`#${id}`)!;
  }

  private buildMarkup(): string {
    const familyOptions = ASSET_FAMILIES.map(
      f => `<option value="${f.id}">${escapeHtml(f.label)}</option>`,
    ).join('');

    return `
      <div class="arw-header">
        <h2 id="arw-title">Art Review Workbench</h2>
        <span class="arw-badge">INDEPENDENT · NO AI REVIEWER · v${ART_REVIEW_TOOL_VERSION}</span>
        <label>Asset family
          <select id="arw-family" aria-label="Loại asset review">${familyOptions}</select>
        </label>
        <label class="button">Nạp Manifest<input id="arw-manifest-input" type="file" accept="application/json,.json" hidden></label>
        <label class="button">Mở Review JSON<input id="arw-review-import" type="file" accept="application/json,.json" hidden></label>
        <label class="button">Nạp Rubric JSON<input id="arw-rubric-import" type="file" accept="application/json,.json" hidden></label>
        <button id="arw-export-json" type="button">Xuất Review JSON</button>
        <button id="arw-export-md" type="button">Xuất Markdown</button>
        <button id="arw-reset" type="button">Làm mới phiên</button>
        <span class="grow"></span>
        <button id="arw-close" type="button">Đóng</button>
      </div>

      <p id="arw-error" class="arw-error" role="alert" hidden></p>

      <div id="arw-alignment-bar" class="arw-alignment-bar" hidden>
        <strong id="arw-mismatch-reasons"></strong>
        <label>Căn chỉnh
          <select id="arw-align-mode" aria-label="Chế độ căn chỉnh">
            <option value="top-left">Góc trên-trái (0,0)</option>
            <option value="center">Tâm ảnh</option>
            <option value="bottom-center">Đáy giữa (chân sprite)</option>
            <option value="pivot">Theo Pivot</option>
            <option value="manual">Tọa độ tay (px)</option>
          </select>
        </label>
        <label>ΔX <input id="arw-align-x" type="number" step="1" value="0" aria-label="Dịch ngang B (px)"></label>
        <label>ΔY <input id="arw-align-y" type="number" step="1" value="0" aria-label="Dịch dọc B (px)"></label>
        <label><input id="arw-align-confirm" type="checkbox"> Xác nhận căn chỉnh trước khi kết luận Pixel Diff</label>
      </div>

      <div class="arw-body">
        <div class="arw-main">
          <div class="arw-slots">
            ${this.buildSlotMarkup('baseline', 'A — Baseline')}
            ${this.buildSlotMarkup('candidate', 'B — Candidate')}
          </div>

          <div class="arw-toolbar" role="toolbar" aria-label="Công cụ so sánh hình ảnh">
            <div class="arw-tool-group" aria-label="Chế độ so sánh">
              <button type="button" data-arw-mode="side-by-side" class="active">Song song</button>
              <button type="button" data-arw-mode="toggle-a">Chỉ A</button>
              <button type="button" data-arw-mode="toggle-b">Chỉ B</button>
              <button type="button" data-arw-mode="blink">Blink A/B</button>
              <button type="button" data-arw-mode="diff">Pixel Diff</button>
              <button type="button" data-arw-mode="silhouette">Silhouette / Alpha</button>
            </div>
            <div class="arw-tool-group" aria-label="Phóng nguyên lần">
              <button type="button" data-arw-zoom="1" class="active" title="Kích thước gốc 1:1 (bắt buộc kiểm tra)">1× Native</button>
              ${([2, 4, 8, 12, 16] as const)
                .map(z => `<button type="button" data-arw-zoom="${z}">${z}×</button>`)
                .join('')}
              <button id="arw-zoom-fit" type="button" title="Phóng nguyên lần lớn nhất vừa khung (F)">Focus / Fit</button>
              <button id="arw-stage-focus" type="button" aria-pressed="false" title="Thu gọn thanh nạp tệp để mở rộng vùng xem (Z)">Mở rộng xem</button>
              <button id="arw-pan-reset" type="button">Canh giữa</button>
              <span id="arw-zoom-indicator" class="arw-zoom-pill" aria-live="polite">1× Native</span>
            </div>
            <div class="arw-tool-group" aria-label="Tùy chọn hiển thị">
              <label>Nền
                <select id="arw-bg" aria-label="Nền hiển thị">
                  <option value="checker">Checkerboard</option>
                  <option value="dark">Nền tối</option>
                  <option value="light">Nền sáng</option>
                </select>
              </label>
              <label id="arw-blink-wrap" hidden>Nhịp Blink
                <select id="arw-blink-ms" aria-label="Tốc độ blink">
                  <option value="250">250 ms</option>
                  <option value="500" selected>500 ms</option>
                  <option value="800">800 ms</option>
                </select>
              </label>
              <label id="arw-sil-wrap" hidden>Alpha view
                <select id="arw-sil-mode" aria-label="Chế độ silhouette">
                  <option value="binary">Silhouette (alpha &gt; 0)</option>
                  <option value="alpha-channel">Kênh Alpha (0–255)</option>
                </select>
              </label>
              <label><input id="arw-grid" type="checkbox"> Lưới (≥4×)</label>
              <label><input id="arw-pivot-overlay" type="checkbox" checked> Pivot</label>
              <label><input id="arw-pin-mode" type="checkbox"> Ghim vùng</label>
            </div>
          </div>

          <div class="arw-stage">
            <div id="arw-dual" class="arw-dual">
              <div class="arw-pane">
                <span class="arw-pane-label" id="arw-pane-label-a">A · Baseline</span>
                <canvas id="arw-canvas-a" class="arw-canvas" aria-label="Canvas A Baseline" tabindex="0"></canvas>
              </div>
              <div class="arw-pane">
                <span class="arw-pane-label" id="arw-pane-label-b">B · Candidate</span>
                <canvas id="arw-canvas-b" class="arw-canvas" aria-label="Canvas B Candidate" tabindex="0"></canvas>
              </div>
            </div>
            <div id="arw-single" class="arw-single" hidden>
              <canvas id="arw-canvas-single" class="arw-canvas" aria-label="Canvas so sánh đơn" tabindex="0"></canvas>
            </div>
            <div id="arw-diff-guard" class="arw-diff-guard" hidden>
              Cảnh báo: A và B khác kích thước hoặc pivot. Hãy xác nhận căn chỉnh ở thanh phía trên trước khi kết luận Pixel Diff (không tự co giãn ảnh).
            </div>
          </div>

          <div class="arw-inspector">
            <span id="arw-rgba-readout">Di chuột lên pixel để xem RGBA chính xác (0–255) · Nhấp để khóa/mở khóa điểm đo</span>
            <span class="grow"></span>
            <span id="arw-diff-readout"></span>
          </div>

          <div class="arw-anim-panel" aria-label="Animation Review">
            <div class="arw-anim-bar">
              <button id="arw-anim-play" type="button">▶ Phát</button>
              <button id="arw-anim-prev" type="button">◀ Frame</button>
              <button id="arw-anim-next" type="button">Frame ▶</button>
              <button id="arw-anim-reset" type="button">Về đầu</button>
              <label><input id="arw-anim-loop" type="checkbox" checked> Lặp (Loop)</label>
              <label>Đồng bộ A/B
                <select id="arw-anim-sync" aria-label="Chế độ đồng bộ animation">
                  <option value="time">Theo thời gian phát (ms)</option>
                  <option value="frame">Theo chỉ số frame thủ công</option>
                </select>
              </label>
              <label><input id="arw-anim-onion" type="checkbox"> Onion-skin</label>
              <label><input id="arw-anim-framediff" type="checkbox"> Frame diff</label>
              <label><input id="arw-anim-boundary" type="checkbox"> Biên lặp (Last → First)</label>
              <span id="arw-anim-clock" class="hint">0 ms</span>
            </div>
            <div id="arw-sync-note" class="arw-sync-note">Nạp sprite strip + timing JSON để kiểm tra nhịp và đồng bộ A/B.</div>
            <div class="arw-strips">
              <div>
                <small class="hint">Strip A (Baseline)</small>
                <div id="arw-strip-a" class="arw-strip-row"></div>
              </div>
              <div>
                <small class="hint">Strip B (Candidate)</small>
                <div id="arw-strip-b" class="arw-strip-row"></div>
              </div>
            </div>
            <div id="arw-loop-boundary" class="arw-loop-boundary" hidden></div>
          </div>
        </div>

        <aside class="arw-review-panel" aria-label="Đánh giá mỹ thuật của con người">
          <div class="arw-disclaimer" id="arw-rubric-info"></div>
          <div id="arw-critical-alert" class="arw-critical-alert" hidden>
            Phát hiện lỗi nghiêm trọng (Critical). Điểm trung bình không che lỗi — không tự đánh dấu PASS.
          </div>

          <section>
            <h2>Lựa chọn so sánh (Không phải Artistic PASS)</h2>
            <small class="hint">Chọn A/B chỉ ghi nhận bản đối chiếu tốt hơn; không tự đánh dấu Artistic PASS.</small>
            <div class="arw-decisions" role="group" aria-label="Chọn kết quả so sánh A B hoặc Neither">
              <button type="button" data-arw-decision="baseline">Chọn A — Baseline</button>
              <button type="button" data-arw-decision="candidate">Chọn B — Candidate</button>
              <button type="button" data-arw-decision="neither">Neither (Chưa đạt)</button>
              <button type="button" data-arw-decision="undecided" class="active">Chưa kết luận</button>
            </div>
            <div id="arw-critical-override-box" class="arw-critical-override" hidden>
              <strong>⚠ Đang chọn bản khi vẫn còn lỗi Critical</strong>
              <span>Việc chọn để đối chiếu KHÔNG phải duyệt đạt mỹ thuật. Hãy ghi rõ lý do:</span>
              <textarea id="arw-critical-rationale" rows="2" aria-label="Lý do chọn khi còn lỗi Critical" placeholder="Ví dụ: B vẫn tốt hơn A ở silhouette, giữ để sửa tiếp phần vật liệu…"></textarea>
            </div>
          </section>

          <section>
            <h2>Bảng chấm điểm</h2>
            <div id="arw-score-summary" class="arw-score-summary"></div>
            <div id="arw-criteria-list" class="arw-criteria-list"></div>
          </section>

          <section>
            <h2>Ghim nhận xét theo vùng</h2>
            <small class="hint">Bật "Ghim nhận xét vùng" trên thanh công cụ rồi nhấp trực tiếp lên pixel trên canvas.</small>
            <div id="arw-region-list" class="arw-region-list"></div>
          </section>

          <section>
            <h2>Nhận xét tổng kết</h2>
            <textarea id="arw-summary-note" rows="4" aria-label="Nhận xét tổng kết" placeholder="Ghi nhận xét nghệ thuật, lỗi pixel/timing hoặc hướng sửa…"></textarea>
          </section>
        </aside>
      </div>
    `;
  }

  private buildSlotMarkup(slot: ReviewSlot, title: string): string {
    return `
      <div class="arw-slot-card" id="arw-card-${slot}" data-slot="${slot}">
        <div class="arw-slot-head">
          <strong>${title}</strong>
          <span class="grow"></span>
          <span id="arw-meta-${slot}" class="arw-slot-meta">Chưa nạp PNG</span>
        </div>
        <div class="arw-slot-actions">
          <label class="button">Mở PNG<input id="arw-png-${slot}" type="file" accept="image/png" hidden></label>
          <label class="button">Timing/Meta JSON<input id="arw-json-${slot}" type="file" accept="application/json,.json" hidden></label>
          <select id="arw-project-asset-${slot}" aria-label="Nạp asset từ dự án cho ${title}" hidden></select>
          <button id="arw-project-load-${slot}" type="button" hidden>Từ dự án</button>
          <button id="arw-clear-${slot}" type="button">Xóa</button>
        </div>
        <details class="arw-slot-tools">
          <summary>Cắt strip / Pivot thủ công</summary>
          <div class="arw-strip-slice">
            <label>W <input id="arw-slice-w-${slot}" type="number" min="1" max="4096" value="32" aria-label="Chiều rộng frame ${title}"></label>
            <label>H <input id="arw-slice-h-${slot}" type="number" min="1" max="4096" value="32" aria-label="Chiều cao frame ${title}"></label>
            <button id="arw-slice-btn-${slot}" type="button">Cắt ô</button>
            <label>Pivot X <input id="arw-pivot-x-${slot}" type="number" step="1" placeholder="—" aria-label="Pivot X ${title}"></label>
            <label>Y <input id="arw-pivot-y-${slot}" type="number" step="1" placeholder="—" aria-label="Pivot Y ${title}"></label>
            <button id="arw-pivot-btn-${slot}" type="button">Đặt pivot</button>
          </div>
        </details>
      </div>
    `;
  }

  private bindEvents(): void {
    this.el('arw-close').onclick = () => this.close();
    this.dialog.addEventListener('close', () => {
      this.stopPlayback();
      this.viewer.stopBlink();
    });

    this.el<HTMLSelectElement>('arw-family').onchange = () => {
      this.changeFamily(this.el<HTMLSelectElement>('arw-family').value as AssetFamily);
    };

    this.el<HTMLInputElement>('arw-manifest-input').onchange = event => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.importManifestFile(file);
      (event.target as HTMLInputElement).value = '';
    };

    this.el<HTMLInputElement>('arw-review-import').onchange = event => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.importReviewFile(file);
      (event.target as HTMLInputElement).value = '';
    };

    this.el<HTMLInputElement>('arw-rubric-import').onchange = event => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.importRubricFile(file);
      (event.target as HTMLInputElement).value = '';
    };

    this.el('arw-export-json').onclick = () => this.exportReviewJson();
    this.el('arw-export-md').onclick = () => this.exportReviewMarkdown();
    this.el('arw-reset').onclick = () => this.resetSession();

    // Alignment controls
    this.el<HTMLSelectElement>('arw-align-mode').onchange = () => {
      this.review.alignment.mode = this.el<HTMLSelectElement>('arw-align-mode').value as AlignmentMode;
      this.refreshAlignmentAndViewer();
    };
    const onOffsetChange = () => {
      this.review.alignment.mode = 'manual';
      this.el<HTMLSelectElement>('arw-align-mode').value = 'manual';
      this.review.alignment.offsetX = Math.trunc(Number(this.el<HTMLInputElement>('arw-align-x').value) || 0);
      this.review.alignment.offsetY = Math.trunc(Number(this.el<HTMLInputElement>('arw-align-y').value) || 0);
      this.refreshAlignmentAndViewer();
    };
    this.el<HTMLInputElement>('arw-align-x').onchange = onOffsetChange;
    this.el<HTMLInputElement>('arw-align-y').onchange = onOffsetChange;
    this.el<HTMLInputElement>('arw-align-confirm').onchange = () => {
      this.review.alignment.confirmed = this.el<HTMLInputElement>('arw-align-confirm').checked;
      this.refreshAlignmentAndViewer();
    };

    // Viewer toolbar
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('[data-arw-mode]')) {
      btn.onclick = () => this.viewer.setViewMode(btn.dataset.arwMode as ViewMode);
    }
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('[data-arw-zoom]')) {
      btn.onclick = () => this.viewer.setZoom(Number(btn.dataset.arwZoom) as ZoomLevel);
    }
    this.el('arw-zoom-fit').onclick = () => this.viewer.fitIntegerZoom();
    this.el('arw-stage-focus').onclick = () => this.toggleStageFocus();
    this.el('arw-pan-reset').onclick = () => this.viewer.resetPan();
    this.el<HTMLSelectElement>('arw-bg').onchange = () => {
      this.viewer.state.background = this.el<HTMLSelectElement>('arw-bg').value as BackgroundMode;
      this.viewer.render();
      this.persistDraft();
    };
    this.el<HTMLSelectElement>('arw-blink-ms').onchange = () => {
      this.viewer.setBlinkInterval(Number(this.el<HTMLSelectElement>('arw-blink-ms').value));
    };
    this.el<HTMLSelectElement>('arw-sil-mode').onchange = () => {
      this.viewer.state.silhouetteMode = this.el<HTMLSelectElement>('arw-sil-mode').value as SilhouetteMode;
      this.viewer.render();
      this.persistDraft();
    };
    this.el<HTMLInputElement>('arw-grid').onchange = () => {
      this.viewer.state.showGrid = this.el<HTMLInputElement>('arw-grid').checked;
      this.viewer.render();
    };
    this.el<HTMLInputElement>('arw-pivot-overlay').onchange = () => {
      this.viewer.state.showPivot = this.el<HTMLInputElement>('arw-pivot-overlay').checked;
      this.viewer.render();
    };
    this.el<HTMLInputElement>('arw-pin-mode').onchange = () => {
      this.pinMode = this.el<HTMLInputElement>('arw-pin-mode').checked;
    };

    // Slot loaders (PNG, metadata JSON, drag/drop, project snapshot, slice, pivot, clear)
    for (const slot of ['baseline', 'candidate'] as const) {
      this.el<HTMLInputElement>(`arw-png-${slot}`).onchange = event => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) void this.loadPngFile(slot, file);
        (event.target as HTMLInputElement).value = '';
      };
      this.el<HTMLInputElement>(`arw-json-${slot}`).onchange = event => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) void this.loadMetadataFile(slot, file);
        (event.target as HTMLInputElement).value = '';
      };
      this.el(`arw-slice-btn-${slot}`).onclick = () => this.applyManualSlice(slot);
      this.el(`arw-pivot-btn-${slot}`).onclick = () => this.applyManualPivot(slot);
      this.el(`arw-clear-${slot}`).onclick = () => this.clearSlot(slot);
      this.el(`arw-project-load-${slot}`).onclick = () => void this.loadFromOpenProject(slot);

      const card = this.el(`arw-card-${slot}`);
      card.addEventListener('dragover', e => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const files = [...(e.dataTransfer?.files ?? [])];
        for (const f of files) {
          if (f.name.toLowerCase().endsWith('.json')) void this.loadMetadataFile(slot, f);
          else void this.loadPngFile(slot, f);
        }
      });
    }

    // Animation controls
    this.el('arw-anim-play').onclick = () => {
      if (this.playing) this.stopPlayback();
      else this.startPlayback();
    };
    this.el('arw-anim-prev').onclick = () => this.stepFrame(-1);
    this.el('arw-anim-next').onclick = () => this.stepFrame(1);
    this.el('arw-anim-reset').onclick = () => {
      this.stopPlayback();
      this.elapsedMs = 0;
      this.manualFrameIndex = 0;
      this.renderAll();
    };
    this.el<HTMLInputElement>('arw-anim-loop').onchange = () => {
      this.loop = this.el<HTMLInputElement>('arw-anim-loop').checked;
      this.persistDraft();
      this.renderAnimationState();
    };
    this.el<HTMLSelectElement>('arw-anim-sync').onchange = () => {
      this.syncMode = this.el<HTMLSelectElement>('arw-anim-sync').value as SyncMode;
      this.persistDraft();
      this.renderAll();
    };
    this.el<HTMLInputElement>('arw-anim-onion').onchange = () => {
      this.viewer.state.onionSkin = this.el<HTMLInputElement>('arw-anim-onion').checked;
      this.viewer.render();
    };
    this.el<HTMLInputElement>('arw-anim-framediff').onchange = () => {
      this.viewer.state.frameDiffOverlay = this.el<HTMLInputElement>('arw-anim-framediff').checked;
      this.viewer.render();
    };
    this.el<HTMLInputElement>('arw-anim-boundary').onchange = () => {
      this.showLoopBoundary = this.el<HTMLInputElement>('arw-anim-boundary').checked;
      this.renderLoopBoundary();
    };

    // Human review controls
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('[data-arw-decision]')) {
      btn.onclick = () => {
        this.review.decision = btn.dataset.arwDecision as ReviewDecision;
        this.renderDecisionButtons();
        this.renderReviewSummaryOnly();
        this.persistDraft();
      };
    }
    this.el<HTMLTextAreaElement>('arw-critical-rationale').oninput = () => {
      this.review.criticalOverrideRationale = this.el<HTMLTextAreaElement>('arw-critical-rationale').value;
      this.persistDraft();
    };
    this.el<HTMLTextAreaElement>('arw-summary-note').oninput = () => {
      this.review.summaryNote = this.el<HTMLTextAreaElement>('arw-summary-note').value;
      this.persistDraft();
    };

    // Scoped keyboard shortcuts inside the Workbench dialog
    this.dialog.addEventListener('keydown', event => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable]')) return;
      const key = event.key.toLowerCase();
      if (key === '1' || key === '2' || key === '4' || key === '8') {
        event.preventDefault();
        this.viewer.setZoom(Number(key) as ZoomLevel);
      } else if (key === 'f') {
        event.preventDefault();
        this.viewer.fitIntegerZoom();
      } else if (key === 'z') {
        event.preventDefault();
        this.toggleStageFocus();
      } else if (key === 't') {
        event.preventDefault();
        this.viewer.setViewMode(this.viewer.state.viewMode === 'toggle-a' ? 'toggle-b' : 'toggle-a');
      } else if (key === 'a') {
        event.preventDefault();
        this.viewer.setViewMode('toggle-a');
      } else if (key === 'b') {
        event.preventDefault();
        this.viewer.setViewMode('toggle-b');
      } else if (key === 'k') {
        event.preventDefault();
        this.viewer.setViewMode('blink');
      } else if (key === 'd') {
        event.preventDefault();
        this.viewer.setViewMode('diff');
      } else if (key === 's') {
        event.preventDefault();
        this.viewer.setViewMode('silhouette');
      } else if (key === 'g') {
        event.preventDefault();
        this.viewer.state.showGrid = !this.viewer.state.showGrid;
        this.el<HTMLInputElement>('arw-grid').checked = this.viewer.state.showGrid;
        this.viewer.render();
      } else if (key === 'p') {
        event.preventDefault();
        this.viewer.state.showPivot = !this.viewer.state.showPivot;
        this.el<HTMLInputElement>('arw-pivot-overlay').checked = this.viewer.state.showPivot;
        this.viewer.render();
      } else if (key === 'o') {
        event.preventDefault();
        this.viewer.state.onionSkin = !this.viewer.state.onionSkin;
        this.el<HTMLInputElement>('arw-anim-onion').checked = this.viewer.state.onionSkin;
        this.viewer.render();
      } else if (event.key === ' ') {
        event.preventDefault();
        if (this.playing) this.stopPlayback();
        else this.startPlayback();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.stepFrame(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.stepFrame(1);
      }
    });
  }

  open(): void {
    this.clearError();
    this.refreshProjectAssetOptions();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    if (this.viewer.state.viewMode === 'blink') {
      this.viewer.startBlink();
    }
    this.renderAll();
  }

  close(): void {
    this.stopPlayback();
    this.viewer.stopBlink();
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  private showError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const box = this.el('arw-error');
    box.textContent = message;
    box.hidden = false;
  }

  private clearError(): void {
    const box = this.el('arw-error');
    box.textContent = '';
    box.hidden = true;
  }

  private refreshProjectAssetOptions(): void {
    const doc = this.options.session.doc;
    for (const slot of ['baseline', 'candidate'] as const) {
      const select = this.el<HTMLSelectElement>(`arw-project-asset-${slot}`);
      const button = this.el<HTMLButtonElement>(`arw-project-load-${slot}`);
      if (!doc || !doc.assets.length) {
        select.hidden = true;
        button.hidden = true;
        select.replaceChildren();
        continue;
      }
      select.hidden = false;
      button.hidden = false;
      const previous = select.value;
      select.replaceChildren(
        ...doc.assets.map(asset => new Option(`${asset.name} (${asset.w}×${asset.h}, ${asset.frames.length}f)`, asset.id)),
      );
      if (doc.assets.some(a => a.id === previous)) {
        select.value = previous;
      }
    }
  }

  private async loadFromOpenProject(slot: ReviewSlot): Promise<void> {
    try {
      this.clearError();
      const doc = this.options.session.doc;
      const assetId = this.el<HTMLSelectElement>(`arw-project-asset-${slot}`).value;
      const asset: PixelAsset | undefined = doc?.assets.find(a => a.id === assetId);
      if (!asset) throw new Error('Không tìm thấy asset trong dự án đang mở.');

      for (const frame of asset.frames) {
        await this.options.session.loadFrame(frame.id, asset);
      }

      const pivot =
        asset.metadata.pivot && typeof asset.metadata.pivot.x === 'number' && typeof asset.metadata.pivot.y === 'number'
          ? { x: Math.trunc(asset.metadata.pivot.x), y: Math.trunc(asset.metadata.pivot.y) }
          : undefined;

      const frames: ReviewFrame[] = asset.frames.map((f, index) => ({
        index,
        width: asset.w,
        height: asset.h,
        rgba: composite(asset, f.id).data.slice(),
        durationMs: f.duration,
        pivot,
      }));

      this.assets[slot] = {
        slot,
        name: asset.name,
        fileName: `${asset.name}.studio-snapshot`,
        width: asset.w,
        height: asset.h,
        sourceWidth: asset.w,
        sourceHeight: asset.h,
        frames,
        loop: asset.tags[0]?.loop ?? true,
        direction: asset.tags[0]?.direction ?? 'forward',
        pivot,
        timingSource: frames.length > 1 ? 'metadata' : 'single-frame',
        tags: [],
        warnings: [],
      };
      delete this.rawSlots[slot];
      this.updateSlotMetadataSnapshot(slot);
      this.renderAll();
      this.persistDraft();
    } catch (err) {
      this.showError(err);
    }
  }

  private enqueueSlotTask(slot: ReviewSlot, task: () => Promise<void>): Promise<void> {
    const next = this.slotQueues[slot].then(task, task);
    this.slotQueues[slot] = next.catch(() => {});
    return next;
  }

  async loadPngFile(slot: ReviewSlot, file: Blob & { name?: string }): Promise<void> {
    return this.enqueueSlotTask(slot, async () => {
      try {
        this.clearError();
        const fileName = file.name ?? `${slot}.png`;
        const decoded = await decodeLocalPng(file, fileName);
        const pending = this.pendingMeta[slot];
        const existingRaw = this.rawSlots[slot];
        this.rawSlots[slot] = {
          decoded,
          metadataText: pending?.text ?? existingRaw?.metadataText,
          metadataFileName: pending?.fileName ?? existingRaw?.metadataFileName,
          metadataSha256: pending?.sha256 ?? existingRaw?.metadataSha256,
        };
        delete this.pendingMeta[slot];
        this.rebuildAssetFromRaw(slot);
        this.renderAll();
        this.persistDraft();
      } catch (err) {
        this.showError(err);
      }
    });
  }

  async loadMetadataFile(slot: ReviewSlot, file: Blob & { name?: string }): Promise<void> {
    return this.enqueueSlotTask(slot, async () => {
      try {
        this.clearError();
        const text = await file.text();
        const raw = this.rawSlots[slot];
        const probeW = raw?.decoded.width ?? this.assets[slot]?.sourceWidth ?? 4096;
        const probeH = raw?.decoded.height ?? this.assets[slot]?.sourceHeight ?? 4096;
        // Validate JSON immediately before storing so invalid JSON never corrupts state.
        parseAnimationMetadata(text, probeW, probeH);

        const metaHash = await sha256Hex(new TextEncoder().encode(text));
        const fileName = file.name ?? 'metadata.json';
        if (raw) {
          raw.metadataText = text;
          raw.metadataFileName = fileName;
          raw.metadataSha256 = metaHash;
          this.rebuildAssetFromRaw(slot);
        } else {
          this.pendingMeta[slot] = { text, fileName, sha256: metaHash };
        }
        this.renderAll();
        this.persistDraft();
      } catch (err) {
        this.showError(err);
      }
    });
  }

  private rebuildAssetFromRaw(slot: ReviewSlot): void {
    const raw = this.rawSlots[slot];
    if (!raw) return;
    const { decoded, metadataText, metadataFileName, metadataSha256 } = raw;
    const baseName = decoded.fileName.replace(/\.png$/i, '');

    if (metadataText) {
      const parsed = parseAnimationMetadata(metadataText, decoded.width, decoded.height);
      const frames = sliceSpriteStrip(decoded.rgba, decoded.width, decoded.height, parsed.frames);
      this.loop = parsed.loop;
      this.assets[slot] = {
        slot,
        name: baseName,
        fileName: decoded.fileName,
        sourceSha256: decoded.sha256,
        metadataFileName,
        metadataSha256,
        width: frames[0].width,
        height: frames[0].height,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
        frames,
        loop: parsed.loop,
        direction: parsed.direction,
        pivot: parsed.pivot,
        timingSource: parsed.timingSource,
        tags: parsed.tags,
        warnings: parsed.warnings,
      };
    } else {
      const frames = sliceSpriteStrip(decoded.rgba, decoded.width, decoded.height, [
        { x: 0, y: 0, w: decoded.width, h: decoded.height, durationMs: 100 },
      ]);
      this.assets[slot] = {
        slot,
        name: baseName,
        fileName: decoded.fileName,
        sourceSha256: decoded.sha256,
        width: decoded.width,
        height: decoded.height,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
        frames,
        loop: true,
        direction: 'forward',
        timingSource: 'single-frame',
        tags: [],
        warnings: [],
      };
    }

    const loaded = this.assets[slot]!;
    this.el<HTMLInputElement>(`arw-slice-w-${slot}`).value = String(loaded.width);
    this.el<HTMLInputElement>(`arw-slice-h-${slot}`).value = String(loaded.height);
    this.el<HTMLInputElement>(`arw-pivot-x-${slot}`).value = loaded.pivot ? String(loaded.pivot.x) : '';
    this.el<HTMLInputElement>(`arw-pivot-y-${slot}`).value = loaded.pivot ? String(loaded.pivot.y) : '';
    this.updateSlotMetadataSnapshot(slot);
  }

  private applyManualSlice(slot: ReviewSlot): void {
    try {
      this.clearError();
      const raw = this.rawSlots[slot];
      if (!raw) throw new Error('Hãy nạp PNG trước khi cắt sprite strip.');
      const fw = Math.trunc(Number(this.el<HTMLInputElement>(`arw-slice-w-${slot}`).value));
      const fh = Math.trunc(Number(this.el<HTMLInputElement>(`arw-slice-h-${slot}`).value));
      if (!Number.isInteger(fw) || !Number.isInteger(fh) || fw < 1 || fh < 1) {
        throw new Error('Kích thước frame cắt strip phải là số nguyên dương.');
      }
      if (raw.decoded.width % fw !== 0 || raw.decoded.height % fh !== 0) {
        throw new Error(`Ảnh ${raw.decoded.width}×${raw.decoded.height} không chia hết cho ô ${fw}×${fh}.`);
      }
      const rects = [];
      for (let y = 0; y < raw.decoded.height; y += fh) {
        for (let x = 0; x < raw.decoded.width; x += fw) {
          rects.push({ x, y, w: fw, h: fh, durationMs: 100, pivot: this.assets[slot]?.pivot });
        }
      }
      const frames = sliceSpriteStrip(raw.decoded.rgba, raw.decoded.width, raw.decoded.height, rects);
      const existing = this.assets[slot];
      this.assets[slot] = {
        slot,
        name: existing?.name ?? raw.decoded.fileName.replace(/\.png$/i, ''),
        fileName: raw.decoded.fileName,
        sourceSha256: raw.decoded.sha256,
        width: fw,
        height: fh,
        sourceWidth: raw.decoded.width,
        sourceHeight: raw.decoded.height,
        frames,
        loop: true,
        direction: 'forward',
        pivot: existing?.pivot,
        timingSource: 'explicit-default',
        tags: [],
        warnings: ['Chưa có timing JSON — đang dùng thời lượng tạm 100 ms/frame.'],
      };
      this.updateSlotMetadataSnapshot(slot);
      this.renderAll();
      this.persistDraft();
    } catch (err) {
      this.showError(err);
    }
  }

  private applyManualPivot(slot: ReviewSlot): void {
    try {
      this.clearError();
      const asset = this.assets[slot];
      if (!asset) throw new Error('Hãy nạp ảnh cho slot này trước khi đặt pivot.');
      const xRaw = this.el<HTMLInputElement>(`arw-pivot-x-${slot}`).value.trim();
      const yRaw = this.el<HTMLInputElement>(`arw-pivot-y-${slot}`).value.trim();
      if (!xRaw && !yRaw) {
        asset.pivot = undefined;
        asset.frames.forEach(f => {
          f.pivot = undefined;
        });
      } else {
        const x = Number(xRaw);
        const y = Number(yRaw);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Pivot X, Y phải là số nguyên.');
        }
        const pivot = { x: Math.trunc(x), y: Math.trunc(y) };
        asset.pivot = pivot;
        asset.frames.forEach(f => {
          f.pivot = pivot;
        });
      }
      this.updateSlotMetadataSnapshot(slot);
      this.renderAll();
      this.persistDraft();
    } catch (err) {
      this.showError(err);
    }
  }

  private clearSlot(slot: ReviewSlot): void {
    delete this.assets[slot];
    delete this.rawSlots[slot];
    delete this.pendingMeta[slot];
    if (slot === 'baseline') delete this.review.baselineRef;
    else delete this.review.candidateRef;
    this.renderAll();
    this.persistDraft();
  }

  private updateSlotMetadataSnapshot(slot: ReviewSlot): void {
    const snapshot = createAssetReferenceSnapshot(this.assets[slot]);
    if (slot === 'baseline') this.review.baselineRef = snapshot;
    else this.review.candidateRef = snapshot;
  }

  private changeFamily(family: AssetFamily): void {
    this.review.assetFamily = family;
    for (const criterion of this.rubric.families[family]) {
      if (!this.review.scores[criterion.id]) {
        this.review.scores[criterion.id] = { score: null, severity: 'none', note: '' };
      }
    }
    this.renderReviewPanel();
    this.persistDraft();
  }

  private async importManifestFile(file: Blob): Promise<void> {
    try {
      this.clearError();
      const manifest = parseReviewManifest(await file.text());
      if (manifest.rubric) {
        this.rubric = manifest.rubric;
        this.review.rubricId = this.rubric.id;
        this.review.rubricName = this.rubric.name;
        this.review.rubricVersion = this.rubric.version;
        this.review.rubricIsWorkbenchDefault = this.rubric.isWorkbenchDefault;
      }
      if (manifest.assetFamily) {
        this.changeFamily(manifest.assetFamily);
      }
      if (manifest.title) {
        this.review.summaryNote = manifest.title;
      }
      for (const slot of ['baseline', 'candidate'] as const) {
        const entry = manifest[slot];
        if (entry?.pivot && this.assets[slot]) {
          this.assets[slot]!.pivot = entry.pivot;
          this.assets[slot]!.frames.forEach(f => {
            f.pivot = entry.pivot;
          });
          this.updateSlotMetadataSnapshot(slot);
        }
      }
      this.renderAll();
      this.persistDraft();
    } catch (err) {
      this.showError(err);
    }
  }

  private async importReviewFile(file: Blob): Promise<void> {
    try {
      this.clearError();
      const parsed = parseReviewJson(await file.text());
      this.review = parsed;
      this.el<HTMLSelectElement>('arw-family').value = parsed.assetFamily;
      this.el<HTMLSelectElement>('arw-align-mode').value = parsed.alignment.mode;
      this.el<HTMLInputElement>('arw-align-x').value = String(parsed.alignment.offsetX);
      this.el<HTMLInputElement>('arw-align-y').value = String(parsed.alignment.offsetY);
      this.el<HTMLInputElement>('arw-align-confirm').checked = parsed.alignment.confirmed;
      this.renderAll();
      this.persistDraft();
    } catch (err) {
      this.showError(err);
    }
  }

  private async importRubricFile(file: Blob): Promise<void> {
    try {
      this.clearError();
      const imported = parseRubricJson(await file.text());
      this.rubric = imported;
      this.review.rubricId = imported.id;
      this.review.rubricName = imported.name;
      this.review.rubricVersion = imported.version;
      this.review.rubricIsWorkbenchDefault = imported.isWorkbenchDefault;
      this.changeFamily(this.review.assetFamily);
      this.renderReviewPanel();
      this.persistDraft();
    } catch (err) {
      this.showError(err);
    }
  }

  private assertCriticalRationaleIfNeeded(): void {
    const criteria = this.rubric.families[this.review.assetFamily] ?? [];
    const summary = summarizeReviewScores(criteria, this.review.scores, this.review.regionNotes);
    const choosing = this.review.decision === 'baseline' || this.review.decision === 'candidate';
    if (summary.hasCriticalDefect && choosing && !this.review.criticalOverrideRationale?.trim()) {
      const box = this.el<HTMLTextAreaElement>('arw-critical-rationale');
      box.focus();
      throw new Error(
        'Đang chọn A/B khi vẫn còn lỗi Critical. Hãy ghi rõ lý do vào ô "Lý do chọn khi còn lỗi Critical" trước khi xuất báo cáo.',
      );
    }
  }

  private exportReviewJson(): void {
    try {
      this.clearError();
      this.assertCriticalRationaleIfNeeded();
      this.review.timestamp = new Date().toISOString();
      this.updateSlotMetadataSnapshot('baseline');
      this.updateSlotMetadataSnapshot('candidate');
      const content = serializeReviewJson(this.review);
      downloadTextOrBlob(content, `art-review-${this.review.assetFamily}.json`, 'application/json;charset=utf-8');
    } catch (err) {
      this.showError(err);
    }
  }

  private exportReviewMarkdown(): void {
    try {
      this.clearError();
      this.assertCriticalRationaleIfNeeded();
      this.review.timestamp = new Date().toISOString();
      this.updateSlotMetadataSnapshot('baseline');
      this.updateSlotMetadataSnapshot('candidate');
      const content = renderReviewMarkdown(this.review, this.rubric);
      downloadTextOrBlob(content, `art-review-${this.review.assetFamily}.md`, 'text/markdown;charset=utf-8');
    } catch (err) {
      this.showError(err);
    }
  }

  private resetSession(): void {
    this.stopPlayback();
    this.assets = {};
    this.rawSlots = {};
    this.pendingMeta = {};
    this.rubric = DEFAULT_WORKBENCH_RUBRIC;
    this.review = createEmptyReviewSession('character', this.rubric);
    this.loop = true;
    this.syncMode = 'time';
    this.elapsedMs = 0;
    this.manualFrameIndex = 0;
    this.activeRegionNoteId = undefined;
    this.dialog.classList.remove('arw-stage-focused');
    this.viewer.state.viewMode = 'side-by-side';
    this.viewer.state.zoom = 1;
    this.viewer.state.panX = 0;
    this.viewer.state.panY = 0;
    this.viewer.state.onionSkin = false;
    this.viewer.state.frameDiffOverlay = false;
    this.viewer.stopBlink();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Storage optional */
    }
    this.clearError();
    this.renderAll();
  }

  private getSequences(): { seqA: ReviewFrame[]; seqB: ReviewFrame[] } {
    const a = this.assets.baseline;
    const b = this.assets.candidate;
    return {
      seqA: a ? expandPlaybackSequence(a.frames, a.direction, a.tags[0]) : [],
      seqB: b ? expandPlaybackSequence(b.frames, b.direction, b.tags[0]) : [],
    };
  }

  private getSampledFrames(): SyncedPlaybackSample {
    const { seqA, seqB } = this.getSequences();
    return sampleSyncedPlayback(seqA, seqB, this.elapsedMs, this.loop, this.syncMode, this.manualFrameIndex);
  }

  private startPlayback(): void {
    const { seqA, seqB } = this.getSequences();
    if (!seqA.length && !seqB.length) return;
    if (this.playing) return;
    const sample = this.getSampledFrames();
    if (!this.loop && sample.done) {
      this.elapsedMs = 0;
      this.manualFrameIndex = 0;
    }
    this.playing = true;
    this.lastTickAt = performance.now();
    this.el('arw-anim-play').textContent = '❚❚ Tạm dừng';
    this.scheduleNextTick();
  }

  private stopPlayback(): void {
    this.playing = false;
    clearTimeout(this.playTimer);
    this.playTimer = undefined;
    const btn = this.dialog.querySelector<HTMLButtonElement>('#arw-anim-play');
    if (btn) btn.textContent = '▶ Phát';
  }

  private scheduleNextTick(): void {
    if (!this.playing) return;
    const { seqA, seqB } = this.getSequences();
    const now = performance.now();
    this.elapsedMs += Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;

    if (this.syncMode === 'frame') {
      const maxFrames = Math.max(seqA.length, seqB.length, 1);
      const sample = this.getSampledFrames();
      const stepDelay = Math.max(16, sample.nextDelayMs || 100);
      this.renderAnimationAndViewer(sample);
      if (!this.loop && this.manualFrameIndex >= maxFrames - 1) {
        this.stopPlayback();
        return;
      }
      this.playTimer = setTimeout(() => {
        this.manualFrameIndex = this.loop
          ? (this.manualFrameIndex + 1) % maxFrames
          : Math.min(maxFrames - 1, this.manualFrameIndex + 1);
        this.scheduleNextTick();
      }, stepDelay);
      return;
    }

    const sample = sampleSyncedPlayback(seqA, seqB, this.elapsedMs, this.loop, 'time', this.manualFrameIndex);
    this.renderAnimationAndViewer(sample);
    if (sample.done) {
      this.stopPlayback();
      return;
    }
    const waitMs = Math.max(12, Math.min(250, sample.nextDelayMs || 30));
    this.playTimer = setTimeout(() => this.scheduleNextTick(), waitMs);
  }

  private stepFrame(delta: 1 | -1): void {
    this.stopPlayback();
    const { seqA, seqB } = this.getSequences();
    if (!seqA.length && !seqB.length) return;

    if (this.syncMode === 'frame' || (!seqB.length && seqA.length) || (!seqA.length && seqB.length)) {
      const primary = seqA.length ? seqA : seqB;
      const sample = this.getSampledFrames();
      const currentIdx = sample.a?.sequenceIndex ?? sample.b?.sequenceIndex ?? this.manualFrameIndex;
      const nextIdx = this.loop
        ? (currentIdx + delta + primary.length) % primary.length
        : Math.max(0, Math.min(primary.length - 1, currentIdx + delta));
      this.manualFrameIndex = nextIdx;
      this.elapsedMs = primary.slice(0, nextIdx).reduce((sum, f) => sum + f.durationMs, 0);
      this.renderAll();
      return;
    }

    // Time-based step: advance/rewind elapsedMs to the next frame boundary across A/B
    const sample = this.getSampledFrames();
    if (delta > 0) {
      this.elapsedMs += Math.max(1, sample.nextDelayMs || 1);
    } else {
      const stepBack = Math.min(
        sample.a?.frame.durationMs ?? 100,
        sample.b?.frame.durationMs ?? 100,
      );
      this.elapsedMs = Math.max(0, this.elapsedMs - Math.max(1, stepBack));
    }
    this.renderAll();
  }

  private buildSelection(
    slot: ReviewSlot,
    seq: ReviewFrame[],
    activeSeqIdx: number | undefined,
  ): ViewerFrameSelection {
    const asset = this.assets[slot];
    if (!asset || !seq.length) return { asset };
    const idx = activeSeqIdx ?? 0;
    const frame = seq[idx];
    const prevFrame = seq[(idx - 1 + seq.length) % seq.length];
    const nextFrame = seq[(idx + 1) % seq.length];
    return { asset, frame, prevFrame, nextFrame };
  }

  private renderAnimationAndViewer(sample: SyncedPlaybackSample): void {
    const { seqA, seqB } = this.getSequences();
    const selA = this.buildSelection('baseline', seqA, sample.a?.sequenceIndex);
    const selB = this.buildSelection('candidate', seqB, sample.b?.sequenceIndex);

    this.viewer.setInputs({
      baseline: selA,
      candidate: selB,
      alignment: this.review.alignment,
      regionNotes: this.review.regionNotes,
      activeRegionNoteId: this.activeRegionNoteId,
    });

    const partsA = sample.a
      ? `A: f${sample.a.frame.index + 1}/${seqA.length} (${sample.a.frame.durationMs}ms · tổng ${sample.a.totalMs}ms)`
      : 'A: —';
    const partsB = sample.b
      ? `B: f${sample.b.frame.index + 1}/${seqB.length} (${sample.b.frame.durationMs}ms · tổng ${sample.b.totalMs}ms)`
      : 'B: —';
    this.el('arw-anim-clock').textContent = `${Math.round(sample.elapsedMs)} ms · ${partsA} · ${partsB}`;

    const syncNote = this.el('arw-sync-note');
    syncNote.textContent = sample.analysis.explanation;
    syncNote.classList.toggle('warn', sample.analysis.timingsDiffer);

    for (const [stripId, activeIdx] of [
      ['arw-strip-a', sample.a?.sequenceIndex],
      ['arw-strip-b', sample.b?.sequenceIndex],
    ] as const) {
      const strip = this.el(stripId);
      for (const btn of strip.querySelectorAll<HTMLButtonElement>('.arw-frame-btn')) {
        btn.classList.toggle('selected', Number(btn.dataset.seqIndex) === activeIdx);
      }
    }
  }

  private renderAll(): void {
    this.el<HTMLSelectElement>('arw-family').value = this.review.assetFamily;
    this.el<HTMLTextAreaElement>('arw-summary-note').value = this.review.summaryNote;
    this.el<HTMLTextAreaElement>('arw-critical-rationale').value =
      this.review.criticalOverrideRationale ?? '';
    this.renderSlotCards();
    this.renderStrips();
    this.refreshAlignmentAndViewer();
    this.renderAnimationState();
    this.renderLoopBoundary();
    this.renderReviewPanel();
    this.syncToolbarButtons();
  }

  private refreshAlignmentAndViewer(): void {
    const a = this.assets.baseline;
    const b = this.assets.candidate;
    const bar = this.el('arw-alignment-bar');
    const guard = this.el('arw-diff-guard');

    if (a && b) {
      const compat = checkCompatibility(a, b);
      bar.hidden = !compat.requiresAlignment;
      this.el('arw-mismatch-reasons').textContent = compat.reasons.join(' ');
      this.el<HTMLSelectElement>('arw-align-mode').value = this.review.alignment.mode;
      this.el<HTMLInputElement>('arw-align-x').value = String(this.review.alignment.offsetX);
      this.el<HTMLInputElement>('arw-align-y').value = String(this.review.alignment.offsetY);
      this.el<HTMLInputElement>('arw-align-confirm').checked = this.review.alignment.confirmed;
      guard.hidden = !(
        this.viewer.state.viewMode === 'diff' &&
        compat.requiresAlignment &&
        !this.review.alignment.confirmed
      );
    } else {
      bar.hidden = true;
      guard.hidden = true;
    }

    const sample = this.getSampledFrames();
    this.renderAnimationAndViewer(sample);
  }

  private renderSlotCards(): void {
    for (const slot of ['baseline', 'candidate'] as const) {
      const asset = this.assets[slot];
      const metaEl = this.el(`arw-meta-${slot}`);
      if (!asset) {
        const savedRef = slot === 'baseline' ? this.review.baselineRef : this.review.candidateRef;
        metaEl.textContent = savedRef
          ? `Cần nạp lại PNG "${savedRef.fileName}" (${savedRef.frameWidth}×${savedRef.frameHeight})`
          : 'Chưa nạp PNG';
        continue;
      }
      const pivotStr = asset.pivot ? ` · pivot (${asset.pivot.x},${asset.pivot.y})` : '';
      const hashStr = asset.sourceSha256 ? ` · ${asset.sourceSha256.slice(0, 8)}` : '';
      const timingTag =
        asset.timingSource === 'metadata'
          ? 'timing JSON'
          : asset.timingSource === 'state-sheet'
            ? 'UI states'
            : asset.timingSource === 'explicit-default'
              ? 'cắt tay 100ms'
              : '1 frame';
      metaEl.textContent = `${asset.fileName} · ${asset.width}×${asset.height} · ${asset.frames.length}f (${timingTag})${pivotStr}${hashStr}`;
    }
  }

  private renderStrips(): void {
    const { seqA, seqB } = this.getSequences();
    const renderRow = (containerId: string, slot: ReviewSlot, seq: ReviewFrame[]) => {
      const row = this.el(containerId);
      const asset = this.assets[slot];
      row.replaceChildren();
      if (!seq.length) {
        const empty = document.createElement('span');
        empty.className = 'hint';
        empty.textContent = 'Chưa có frame.';
        row.append(empty);
        return;
      }
      seq.forEach((frame, seqIdx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'arw-frame-btn';
        btn.dataset.seqIndex = String(seqIdx);
        btn.title = `Frame #${frame.index + 1} · ${frame.durationMs} ms`;
        const thumb = document.createElement('canvas');
        thumb.width = 28;
        thumb.height = 28;
        renderFrameThumbnail(thumb, frame.rgba, frame.width, frame.height);
        const label = document.createElement('span');
        label.textContent =
          asset?.timingSource === 'state-sheet' && frame.label
            ? `#${frame.index + 1} · ${frame.label}`
            : `#${frame.index + 1} · ${frame.durationMs}ms`;
        btn.title = frame.label
          ? `Frame #${frame.index + 1} (${frame.label}) · ${frame.durationMs} ms`
          : `Frame #${frame.index + 1} · ${frame.durationMs} ms`;
        btn.append(thumb, label);
        btn.onclick = () => {
          this.stopPlayback();
          this.manualFrameIndex = seqIdx;
          this.elapsedMs = seq.slice(0, seqIdx).reduce((s, f) => s + f.durationMs, 0);
          this.renderAll();
        };
        row.append(btn);
      });
    };

    renderRow('arw-strip-a', 'baseline', seqA);
    renderRow('arw-strip-b', 'candidate', seqB);
  }

  private renderAnimationState(): void {
    this.el<HTMLInputElement>('arw-anim-loop').checked = this.loop;
    this.el<HTMLSelectElement>('arw-anim-sync').value = this.syncMode;
    this.el<HTMLInputElement>('arw-anim-boundary').checked = this.showLoopBoundary;
  }

  private renderLoopBoundary(): void {
    const panel = this.el('arw-loop-boundary');
    panel.replaceChildren();
    panel.hidden = !this.showLoopBoundary;
    if (!this.showLoopBoundary) return;

    const { seqA, seqB } = this.getSequences();
    for (const [label, seq] of [
      ['A — Baseline', seqA],
      ['B — Candidate', seqB],
    ] as const) {
      const pair = getLoopBoundaryFrames(seq);
      if (!pair) continue;
      const box = document.createElement('div');
      box.style.display = 'inline-flex';
      box.style.alignItems = 'center';
      box.style.gap = '6px';
      const title = document.createElement('strong');
      title.textContent = `${label}: f${pair.lastFrame.index + 1} → f${pair.firstFrame.index + 1}`;
      const cLast = document.createElement('canvas');
      cLast.width = 36;
      cLast.height = 36;
      renderFrameThumbnail(cLast, pair.lastFrame.rgba, pair.lastFrame.width, pair.lastFrame.height);
      const arrow = document.createElement('span');
      arrow.textContent = '→';
      const cFirst = document.createElement('canvas');
      cFirst.width = 36;
      cFirst.height = 36;
      renderFrameThumbnail(cFirst, pair.firstFrame.rgba, pair.firstFrame.width, pair.firstFrame.height);
      const seamDiff = computeFrameDiff(pair.lastFrame, pair.firstFrame);
      const stat = document.createElement('span');
      stat.className = 'hint';
      stat.textContent = `Đổi ${seamDiff.stats.changedPixels} px`;
      box.append(title, cLast, arrow, cFirst, stat);
      panel.append(box);
    }
  }

  private renderInspector(info: HoverInspection | null, locked: boolean): void {
    const out = this.el('arw-rgba-readout');
    if (!info) {
      out.textContent = 'Di chuột lên pixel để xem RGBA chính xác (0–255) · Nhấp để khóa/mở khóa điểm đo';
      return;
    }
    const fmt = (label: string, px: HoverInspection['a']) => {
      if (!px) return `${label}: ngoài vùng`;
      return `<span class="arw-swatch" style="background:rgba(${px.r},${px.g},${px.b},${(px.a / 255).toFixed(3)})"></span>${label} RGBA(${px.r}, ${px.g}, ${px.b}, ${px.a}) ${px.hex}`;
    };
    const lockTag = locked ? ' [ĐÃ KHÓA]' : '';
    out.innerHTML = `(${info.x}, ${info.y})${lockTag} · ${fmt('A', info.a)} · ${fmt('B', info.b)}`;
  }

  private renderDiffReadout(diff?: PixelDiffResult): void {
    const out = this.el('arw-diff-readout');
    if (this.viewer.state.viewMode === 'silhouette') {
      const a = this.viewer.state.viewMode === 'silhouette' ? this.assets.baseline?.frames[0] : undefined;
      const b = this.viewer.state.viewMode === 'silhouette' ? this.assets.candidate?.frames[0] : undefined;
      const parts: string[] = [];
      if (a) {
        const sa = computeSilhouette(a.rgba, a.width, a.height, this.viewer.state.silhouetteMode);
        parts.push(`A alpha: ${sa.opaquePixels} đặc / ${sa.semiTransparentPixels} bán trong / ${sa.transparentPixels} rỗng`);
      }
      if (b) {
        const sb = computeSilhouette(b.rgba, b.width, b.height, this.viewer.state.silhouetteMode);
        parts.push(`B alpha: ${sb.opaquePixels} đặc / ${sb.semiTransparentPixels} bán trong / ${sb.transparentPixels} rỗng`);
      }
      out.textContent = parts.join(' | ');
      return;
    }

    if (!diff) {
      out.textContent = '';
      return;
    }
    const s = diff.stats;
    out.textContent = `Diff: ${s.changedPixels}/${s.totalUnionPixels} px khác (RGB: ${s.rgbDiffPixels}, Alpha: ${s.alphaDiffPixels}, Only-A: ${s.onlyAPixels}, Only-B: ${s.onlyBPixels}, max Δ=${s.maxChannelDelta})`;
  }

  private toggleStageFocus(): void {
    const focused = this.dialog.classList.toggle('arw-stage-focused');
    const btn = this.el<HTMLButtonElement>('arw-stage-focus');
    btn.setAttribute('aria-pressed', String(focused));
    btn.classList.toggle('active', focused);
    btn.textContent = focused ? 'Thu gọn xem' : 'Mở rộng xem';
    this.viewer.render();
  }

  private syncToolbarButtons(): void {
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('[data-arw-mode]')) {
      btn.classList.toggle('active', btn.dataset.arwMode === this.viewer.state.viewMode);
    }
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('[data-arw-zoom]')) {
      btn.classList.toggle('active', Number(btn.dataset.arwZoom) === this.viewer.state.zoom);
    }
    this.el('arw-zoom-indicator').textContent =
      this.viewer.state.zoom === 1 ? '1× Native' : `${this.viewer.state.zoom}× Nearest`;
    this.el('arw-blink-wrap').hidden = this.viewer.state.viewMode !== 'blink';
    this.el('arw-sil-wrap').hidden = this.viewer.state.viewMode !== 'silhouette';
    this.el<HTMLSelectElement>('arw-bg').value = this.viewer.state.background;
    this.el<HTMLSelectElement>('arw-sil-mode').value = this.viewer.state.silhouetteMode;
    this.el<HTMLInputElement>('arw-grid').checked = this.viewer.state.showGrid;
    this.el<HTMLInputElement>('arw-pivot-overlay').checked = this.viewer.state.showPivot;
    const guard = this.el('arw-diff-guard');
    const a = this.assets.baseline;
    const b = this.assets.candidate;
    if (a && b) {
      const compat = checkCompatibility(a, b);
      guard.hidden = !(
        this.viewer.state.viewMode === 'diff' &&
        compat.requiresAlignment &&
        !this.review.alignment.confirmed
      );
    } else {
      guard.hidden = true;
    }
    this.renderDiffReadout(this.viewer.getLatestDiff());
  }

  private renderReviewPanel(): void {
    const criteria = this.rubric.families[this.review.assetFamily] ?? [];
    this.el('arw-rubric-info').textContent = `${this.rubric.name} (v${this.rubric.version}) — ${this.rubric.disclaimer}`;

    const summary = summarizeReviewScores(criteria, this.review.scores, this.review.regionNotes);
    this.el('arw-critical-alert').hidden = !summary.hasCriticalDefect;
    this.updateCriticalOverrideBox(summary.hasCriticalDefect);
    this.el('arw-score-summary').textContent =
      `Đã chấm ${summary.scoredCount}/${summary.totalCount} tiêu chí` +
      (summary.minScore !== null ? ` · Thấp nhất: ${summary.minScore} · Cao nhất: ${summary.maxScore}` : '') +
      ` · Critical: ${summary.criticalCriteriaIds.length + summary.criticalRegionCount}`;

    this.renderDecisionButtons();

    const list = this.el('arw-criteria-list');
    list.replaceChildren();
    for (const c of criteria) {
      const current = this.review.scores[c.id] ?? { score: null, severity: 'none', note: '' };
      this.review.scores[c.id] = current;

      const card = document.createElement('div');
      card.className = 'arw-criterion-card';
      card.dataset.criterionId = c.id;

      const head = document.createElement('div');
      head.className = 'arw-criterion-head';
      const title = document.createElement('strong');
      title.textContent = c.label;
      const scoreSelect = document.createElement('select');
      scoreSelect.setAttribute('aria-label', `Điểm ${c.label}`);
      scoreSelect.append(new Option('—', ''));
      for (let v = 1; v <= c.maxScore; v++) {
        scoreSelect.append(new Option(`${v}/${c.maxScore}`, String(v)));
      }
      scoreSelect.value = current.score === null ? '' : String(current.score);
      scoreSelect.onchange = () => {
        current.score = scoreSelect.value === '' ? null : Number(scoreSelect.value);
        this.renderReviewSummaryOnly();
        this.persistDraft();
      };
      head.append(title, scoreSelect);

      const desc = document.createElement('div');
      desc.className = 'arw-criterion-desc';
      desc.textContent = c.description;

      const controls = document.createElement('div');
      controls.className = 'arw-criterion-controls';

      const sevSelect = document.createElement('select');
      sevSelect.setAttribute('aria-label', `Mức lỗi ${c.label}`);
      for (const [val, label] of [
        ['none', 'Không lỗi'],
        ['minor', 'Minor'],
        ['major', 'Major'],
        ['critical', 'Critical'],
      ] as const) {
        sevSelect.append(new Option(label, val));
      }
      sevSelect.value = current.severity;
      sevSelect.onchange = () => {
        current.severity = sevSelect.value as CriterionSeverity;
        this.renderReviewSummaryOnly();
        this.persistDraft();
      };

      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.placeholder = 'Ghi chú tiêu chí…';
      noteInput.setAttribute('aria-label', `Ghi chú ${c.label}`);
      noteInput.value = current.note;
      noteInput.oninput = () => {
        current.note = noteInput.value;
        this.persistDraft();
      };

      controls.append(sevSelect, noteInput);
      card.append(head, desc, controls);
      list.append(card);
    }

    this.renderRegionNotes();
  }

  private updateCriticalOverrideBox(hasCriticalDefect: boolean): void {
    const choosing = this.review.decision === 'baseline' || this.review.decision === 'candidate';
    this.el('arw-critical-override-box').hidden = !(hasCriticalDefect && choosing);
  }

  private renderReviewSummaryOnly(): void {
    const criteria = this.rubric.families[this.review.assetFamily] ?? [];
    const summary = summarizeReviewScores(criteria, this.review.scores, this.review.regionNotes);
    this.el('arw-critical-alert').hidden = !summary.hasCriticalDefect;
    this.updateCriticalOverrideBox(summary.hasCriticalDefect);
    this.updateCriticalOverrideBox(summary.hasCriticalDefect);
    this.el('arw-score-summary').textContent =
      `Đã chấm ${summary.scoredCount}/${summary.totalCount} tiêu chí` +
      (summary.minScore !== null ? ` · Thấp nhất: ${summary.minScore} · Cao nhất: ${summary.maxScore}` : '') +
      ` · Critical: ${summary.criticalCriteriaIds.length + summary.criticalRegionCount}`;
  }

  private renderDecisionButtons(): void {
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>('[data-arw-decision]')) {
      btn.classList.toggle('active', btn.dataset.arwDecision === this.review.decision);
    }
  }

  private addRegionNoteFromClick(info: HoverInspection): void {
    const sample = this.getSampledFrames();
    const slot: ReviewSlot | 'diff' =
      info.pane === 'baseline' ? 'baseline' : info.pane === 'candidate' ? 'candidate' : 'diff';
    const frameIndex =
      slot === 'baseline'
        ? sample.a?.frame.index ?? 0
        : slot === 'candidate'
          ? sample.b?.frame.index ?? 0
          : 0;
    const id = `rn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.review.regionNotes.push({
      id,
      slot,
      frameIndex,
      x: info.x,
      y: info.y,
      width: 1,
      height: 1,
      severity: 'minor',
      note: `Vùng (${info.x}, ${info.y})`,
    });
    this.activeRegionNoteId = id;
    this.renderRegionNotes();
    this.renderReviewSummaryOnly();
    this.refreshAlignmentAndViewer();
    this.persistDraft();
  }

  private renderRegionNotes(): void {
    const container = this.el('arw-region-list');
    container.replaceChildren();
    if (!this.review.regionNotes.length) {
      const empty = document.createElement('span');
      empty.className = 'hint';
      empty.textContent = 'Chưa có ghim vùng nào.';
      container.append(empty);
      return;
    }

    this.review.regionNotes.forEach((note, index) => {
      const item = document.createElement('div');
      item.className = 'arw-region-item';

      const head = document.createElement('div');
      head.className = 'arw-region-item-head';
      const title = document.createElement('strong');
      title.textContent = `#${index + 1} · ${note.slot} f${note.frameIndex + 1} (${note.x}, ${note.y})`;
      const focusBtn = document.createElement('button');
      focusBtn.type = 'button';
      focusBtn.textContent = 'Xem';
      focusBtn.onclick = () => {
        this.activeRegionNoteId = note.id;
        this.viewer.render();
      };
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = 'Xóa';
      delBtn.onclick = () => {
        this.review.regionNotes = this.review.regionNotes.filter(r => r.id !== note.id);
        this.renderRegionNotes();
        this.renderReviewSummaryOnly();
        this.viewer.render();
        this.persistDraft();
      };
      head.append(title, focusBtn, delBtn);

      const controls = document.createElement('div');
      controls.className = 'arw-criterion-controls';
      const sev = document.createElement('select');
      sev.setAttribute('aria-label', `Mức lỗi ghim ${index + 1}`);
      for (const s of ['minor', 'major', 'critical'] as const) {
        sev.append(new Option(s, s));
      }
      sev.value = note.severity;
      sev.onchange = () => {
        note.severity = sev.value as CriterionSeverity;
        this.renderReviewSummaryOnly();
        this.viewer.render();
        this.persistDraft();
      };

      const text = document.createElement('input');
      text.type = 'text';
      text.value = note.note;
      text.setAttribute('aria-label', `Ghi chú ghim ${index + 1}`);
      text.oninput = () => {
        note.note = text.value;
        this.persistDraft();
      };

      controls.append(sev, text);
      item.append(head, controls);
      container.append(item);
    });
  }

  private persistDraft(): void {
    try {
      const slots: PersistedDraft['slots'] = {};
      for (const slot of ['baseline', 'candidate'] as const) {
        const asset = this.assets[slot];
        const raw = this.rawSlots[slot];
        if (!asset) continue;
        slots[slot] = {
          name: asset.name,
          fileName: asset.fileName,
          pngBase64:
            raw && raw.decoded.byteLength <= MAX_CACHED_PNG_BYTES
              ? bytesToBase64(raw.decoded.rawBytes)
              : undefined,
          metadataText: raw?.metadataText,
          metadataFileName: raw?.metadataFileName,
          pivot: asset.pivot,
        };
      }

      const payload: PersistedDraft = {
        session: this.review,
        rubric: this.rubric,
        viewMode: this.viewer.state.viewMode,
        zoom: this.viewer.state.zoom,
        background: this.viewer.state.background,
        silhouetteMode: this.viewer.state.silhouetteMode,
        syncMode: this.syncMode,
        loop: this.loop,
        slots,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* Persistence is best-effort and never blocks review interaction. */
    }
  }

  private async restorePersistedDraft(): Promise<void> {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) return;
      const parsed = JSON.parse(text) as PersistedDraft;
      if (!parsed || !parsed.session || !parsed.rubric) return;

      this.rubric = parsed.rubric.isWorkbenchDefault
        ? DEFAULT_WORKBENCH_RUBRIC
        : parseRubricJson(JSON.stringify(parsed.rubric));
      this.review = parseReviewJson(JSON.stringify(parsed.session));
      this.viewer.state.viewMode = parsed.viewMode ?? 'side-by-side';
      this.viewer.state.zoom = parsed.zoom ?? 1;
      this.viewer.state.background = parsed.background ?? 'checker';
      this.viewer.state.silhouetteMode = parsed.silhouetteMode ?? 'binary';
      this.syncMode = parsed.syncMode ?? 'time';
      this.loop = typeof parsed.loop === 'boolean' ? parsed.loop : true;

      for (const slot of ['baseline', 'candidate'] as const) {
        const cached = parsed.slots?.[slot];
        if (!cached?.pngBase64) continue;
        const rawBytes = base64ToBytes(cached.pngBase64);
        const decoded = await decodeLocalPng(
          new Blob([rawBytes.slice()], { type: 'image/png' }),
          cached.fileName,
        );
        this.rawSlots[slot] = {
          decoded,
          metadataText: cached.metadataText,
          metadataFileName: cached.metadataFileName,
          metadataSha256: cached.metadataText
            ? await sha256Hex(new TextEncoder().encode(cached.metadataText))
            : undefined,
        };
        this.rebuildAssetFromRaw(slot);
        if (cached.pivot && this.assets[slot]) {
          this.assets[slot]!.pivot = cached.pivot;
          this.assets[slot]!.frames.forEach(f => {
            f.pivot = cached.pivot;
          });
        }
      }
      this.renderAll();
    } catch {
      /* Ignore corrupted local draft rather than crashing startup. */
    }
  }
}
