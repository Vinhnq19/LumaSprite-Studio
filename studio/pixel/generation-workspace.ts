import { openFigureReview } from './figure-review.ts';
import type { CompactBatchInfo, CompactCandidateInfo, RegionEditInput } from '../../src/studio/batch-types.ts';
import type { VariantPreview, VariantFrame } from '../../src/studio/variants.ts';
import type { AnimationOptions } from '../../src/studio/types.ts';
import { DEFAULT_CANDIDATE_TIMEOUT, DEFAULT_BATCH_TIMEOUT } from '../../src/studio/ai-budget.ts';
import type { ActiveAiProvider } from '../../src/studio/ai-providers.ts';
import { isActiveAiProvider } from '../../src/studio/ai-providers.ts';

export interface StartBatchOptions {
  clipGeneration?: { clipId: string };
  clipPaletteMode?: 'asset' | 'auto16';
  provider?: ActiveAiProvider;
  animation?: AnimationOptions;
  motion?: string;
  regionEdit?: RegionEditInput;
  prompt?: string;
  expectedSource?: {
    projectId?: string;
    assetId: string;
    frameId: string;
    revision: number;
    w?: number;
    h?: number;
  };
}
import { generationStyles, generationViews } from '../../src/studio/generation.ts';
import type { Session } from './session.ts';
import { api } from './session.ts';
import { ArtDirectionFormController } from './art-direction-form.ts';
import { VariantPreviewController } from './variants.ts';
import { ExternalEnginePanel } from './external-engine-panel.ts';
import type { PixelAsset } from '../../src/studio/pixel/model.ts';
import { type LibraryKind, type ApplyLibraryOptions, getAssetLibraryInfo } from '../../src/studio/asset-library.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;

export class GenerationWorkspaceController {
  public onClose?: () => void;
  public onEditClip?: (clipId: string) => Promise<void>;
  public onTileset?: () => Promise<void>;
  private session: Session;
  public variantPreview!: VariantPreviewController;
  public artForm!: ArtDirectionFormController;
  private dialog: HTMLDialogElement;
  private activeBatch?: CompactBatchInfo;
  private pollTimer?: ReturnType<typeof setInterval>;
  private elapsedTimer?: ReturnType<typeof setInterval>;
  private selectedCandidateIndex = -1;
  private candidateThumbs = new Map<string, VariantFrame>();
  private inFlightThumbs = new Set<string>();
  private dismissedBatches = new Set<string>();
  private currentPreview?: VariantPreview;
  private previewMode: 'none' | 'batch' | 'standalone' = 'none';
  private standaloneProposal?: { proposalId: string; revision: number };
  private selectionTicket = 0;
  private pollTicket = 0;
  private restoreTicket = 0;
  private actionTicket = 0;
  private applying = false;
  private starting = false;
  private lastBatchUpdateTimestamp = Date.now();
  private onProjectApplied: (savedDoc: any, historyLabel?: string) => Promise<void>;
  private external: ExternalEnginePanel;
  private projectLock: (enter: boolean) => void;
  private writeRevision: (path: string, value: Record<string, unknown>) => Promise<any>;
  private prepareAi: () => Promise<void>;
  private onerror: (err: unknown) => void;

  constructor(
    session: Session,
    onProjectApplied: (savedDoc: any, historyLabel?: string) => Promise<void>,
    projectLock: (enter: boolean) => void,
    writeRevision: (path: string, value: Record<string, unknown>) => Promise<any>,
    prepareAi: () => Promise<void>,
    onerror: (err: unknown) => void,
    selection: () => Uint8Array | undefined,
  ) {
    this.session = session;
    this.onProjectApplied = onProjectApplied;
    this.projectLock = projectLock;
    this.writeRevision = writeRevision;
    this.prepareAi = prepareAi;
    this.onerror = onerror;

    this.dialog = document.createElement('dialog');
    this.dialog.id = 'generation-workspace';
    this.dialog.className = 'large-workspace';
    document.body.append(this.dialog);

    this.render();
    this.external = new ExternalEnginePanel($('external-engine-panel'), session, prepareAi, selection, writeRevision, async saved => {
      await onProjectApplied(saved, 'Áp dụng External Engine');
      this.close(true);
    });

    // Construct VariantPreviewController internally now that the proposal DOM exists
    this.variantPreview = new VariantPreviewController(
      () => this.session.doc ? { path: this.session.path, revision: this.session.doc.revision } : undefined,
      () => this.session.flush(),
      onerror,
      () => this.updateApplyGate()
    );

    this.bindEvents();
  }

  private render(): void {
    this.dialog.innerHTML = `
      <div class="workspace-header">
        <div class="header-left">
          <h2>Không gian tạo asset</h2>
          <span id="ai-context-info" class="hint">Canvas 32×32</span>
        </div>
        <div class="header-right">
          <label>Nguồn tạo asset
            <select id="generation-source">
              <option value="legacy">Legacy Generation</option>
              <option value="external">External Engine (Mock)</option>
            </select>
          </label>
          <button id="ai-close" type="button" class="button">← Quay lại vẽ pixel</button>
        </div>
      </div>

      <div id="external-engine-panel" hidden></div>
      <div id="legacy-generation-panel">
      <div class="workspace-modes">
        <button id="mode-new-sprite" type="button" class="mode-tab active">Tạo sprite mới</button>
        <button id="ai-animate" type="button" class="mode-tab">Tạo animation từ frame hiện tại…</button>
        <button id="ai-region-edit" type="button" class="mode-tab">Chỉnh sửa vùng đã chọn…</button>
        <button id="ai-edit-clip" type="button" class="mode-tab" hidden>Chỉnh clip và tạo lại…</button>
        <button id="ai-tileset" type="button" class="mode-tab">Tileset từ vật liệu…</button>
        <button id="normalize-reference" type="button" class="button mode-aux">Chuẩn hóa mẫu</button>
      </div>

      <div class="workspace-body">
        <div id="art-direction-form-container" class="workspace-sidebar"></div>

        <div id="generation-results-container" class="workspace-results">
          <div class="batch-controls-row">
            <button id="figure-open" type="button">Nhân vật · duyệt dáng</button><button id="ai-generate" class="primary" type="button">Tạo 3 phương án</button>
            <button id="ai-cancel" type="button" disabled>Hủy đợt tạo</button>
            <span id="batch-limits-info" class="hint">Tối đa ${DEFAULT_BATCH_TIMEOUT / 1000}s / đợt · ${DEFAULT_CANDIDATE_TIMEOUT / 1000}s / phương án</span>
          </div>

          <div class="batch-status-bar">
            <span id="ai-status" role="status">Sẵn sàng tạo đề xuất.</span>
            <div id="ai-modal-error" class="inline-error" role="alert" style="color: #ff6b6b; margin-top: 6px; font-weight: 500;" hidden></div>
          </div>

          <div class="candidate-cards">
            ${[0, 1, 2].map(i => `
              <div class="candidate-card" data-index="${i}">
                <div class="card-header">
                  <strong>Phương án ${i + 1}</strong>
                  <span class="card-status badge">Chờ</span>
                </div>
                <div class="card-thumb-wrap">
                  <canvas class="candidate-thumb" width="64" height="64"></canvas>
                </div>
                <div class="card-info">
                  <span class="card-dim">—</span>
                  <span class="card-calls">—</span>
                  <span class="card-elapsed">—</span>
                </div>
                <p class="card-msg"></p>
                <button type="button" class="candidate-retry button" hidden>Thử lại</button>
              </div>
            `).join('')}
          </div>

          <div id="proposal" class="selected-candidate-detail" hidden>
            <h3>Chi tiết phương án đã chọn</h3>
            <p id="proposal-description"></p>
            <p id="proposal-settings" class="hint"></p>
            <p id="proposal-stats"></p>

            <div class="row align-center" style="margin-top: 8px;">
              <label>Phóng preview
                <select id="proposal-zoom" aria-label="Phóng preview">
                  <option value="1">1× — kích thước gốc</option>
                  <option value="2">2×</option>
                  <option value="4" selected>4×</option>
                  <option value="8">8×</option>
                </select>
              </label>
            </div>

            <div class="compare">
              <figure>
                <figcaption id="proposal-before-label">Asset hiện tại</figcaption>
                <div class="proposal-image"><canvas id="before"></canvas></div>
              </figure>
              <figure>
                <figcaption id="proposal-after-label">Đề xuất · frame 1</figcaption>
                <div class="proposal-image"><canvas id="after"></canvas></div>
              </figure>
            </div>

            <p id="proposal-warnings" role="status"></p>
            <p id="proposal-errors" role="alert"></p>

            <div class="proposal-library-controls">
              <h4>Lưu vào Thư viện asset</h4>
              <div class="row align-center" style="gap: 16px; margin-bottom: 8px;">
                <label class="radio-label">
                  <input type="radio" name="proposal-apply-mode" id="proposal-mode-new" value="new" checked>
                  Tạo asset mới
                </label>
                <label class="radio-label">
                  <input type="radio" name="proposal-apply-mode" id="proposal-mode-version" value="version">
                  Tạo phiên bản mới của asset có sẵn
                </label>
              </div>

              <div id="proposal-version-target-row" class="row" style="margin-bottom: 8px;" hidden>
                <label style="flex: 1;">Asset gốc (phiên bản trước)
                  <select id="proposal-version-target" aria-label="Asset gốc để tạo phiên bản mới"></select>
                </label>
              </div>

              <div class="row" style="margin-bottom: 8px; gap: 12px;">
                <label style="flex: 2;">Tên asset
                  <input id="proposal-asset-name" type="text" maxlength="100" placeholder="Tên asset (1–100 ký tự)" aria-label="Tên asset">
                </label>
                <label style="flex: 1;">Phân loại
                  <select id="proposal-asset-kind" aria-label="Phân loại asset">
                    <option value="object" selected>Đồ vật</option>
                    <option value="character">Nhân vật</option>
                    <option value="tileset">Tileset</option>
                  </select>
                </label>
              </div>
              <small id="proposal-kind-hint" class="hint"></small>
            </div>

            <div class="row" style="margin-top: 12px;">
              <button id="proposal-apply" class="primary" type="button">Áp dụng thành asset mới</button>
            </div>
          </div>
        </div>
      </div>
      </div>
    `;

    this.artForm = new ArtDirectionFormController(this.session, $('art-direction-form-container'));
  }

  private bindEvents(): void {
    $('ai-close').onclick = () => this.close();
    $<HTMLSelectElement>('generation-source').onchange = () => {
      const select = $<HTMLSelectElement>('generation-source');
      if (this.external.isBusy || this.isLocked()) {
        select.value = $('external-engine-panel').hidden ? 'legacy' : 'external';
        return;
      }
      this.showExternal(select.value === 'external');
    };
    this.dialog.addEventListener('cancel', (e) => {
      if (this.applying || this.external.isBusy) e.preventDefault();
    });
    this.dialog.onclose = () => {
      this.variantPreview.stop();
      this.showExternal(false);
      this.onClose?.();
    };

    $('mode-new-sprite').onclick = () => {
      if (this.isLocked()) return;
      this.dialog.querySelectorAll('.workspace-modes .mode-tab').forEach(t => t.classList.remove('active'));
      $('mode-new-sprite').classList.add('active');
      if (this.isClipBatch()) {
        if (this.activeBatch) this.dismissedBatches.add(this.activeBatch.id);
        while (this.dismissedBatches.size > 100) this.dismissedBatches.delete(this.dismissedBatches.values().next().value!);
        this.selectionTicket++;
        this.pollTicket++;
        this.restoreTicket++;
        this.stopPolling();
        this.stopElapsedTimer();
        this.activeBatch = undefined;
        this.currentPreview = undefined;
        this.selectedCandidateIndex = -1;
        this.candidateThumbs.clear();
        this.inFlightThumbs.clear();
        this.previewMode = 'none';
        this.variantPreview.reset();
        $('proposal').hidden = true;
        this.clearModalError();
        this.renderBatchState();
      }
    };
    $('ai-tileset').onclick = () => { if (!this.isLocked() && this.onTileset) { this.close(); void this.onTileset().catch(this.handleError.bind(this)); } };

    $('figure-open').onclick = () => {
      if (!this.isLocked()) void openFigureReview(this.session, this.artForm, ($('ai-prompt') as HTMLTextAreaElement).value).catch(this.handleError.bind(this));
    };
    $('ai-generate').onclick = () => {
      if (this.applying) return;
      void this.startBatch().catch(this.handleError.bind(this));
    };
    $('ai-edit-clip').onclick = () => {
      if (this.isLocked()) return;
      const id = this.activeBatch?.config?.clip?.clipId ?? this.currentPreview?.generation?.clip?.context.clipId;
      if (id && this.onEditClip) { this.close(); void this.onEditClip(id).catch(this.handleError.bind(this)); }
    };

    $('ai-cancel').onclick = () => {
      if (this.applying) return;
      void this.cancelBatch().catch(this.handleError.bind(this));
    };

    $('proposal-apply').onclick = () => {
      if (this.applying) return;
      void this.applySelectedProposal().catch(this.handleError.bind(this));
    };

    const modeNew = $('proposal-mode-new') as HTMLInputElement | null;
    const modeVersion = $('proposal-mode-version') as HTMLInputElement | null;
    if (modeNew && modeVersion) {
      modeNew.onchange = () => this.updateProposalLibraryState();
      modeVersion.onchange = () => this.updateProposalLibraryState();
    }
    const versionTarget = $('proposal-version-target') as HTMLSelectElement | null;
    if (versionTarget) {
      versionTarget.onchange = () => this.updateProposalLibraryState();
    }

    const cards = this.dialog.querySelectorAll<HTMLElement>('.candidate-card');
    cards.forEach((card, i) => {
      card.onclick = (e) => {
        if (this.applying) return;
        if ((e.target as HTMLElement).closest('.candidate-retry')) return;
        if (this.activeBatch && this.activeBatch.candidates[i]?.status === 'ready') {
          void this.selectCandidate(i).catch(this.handleError.bind(this));
        }
      };

      const retryBtn = card.querySelector<HTMLButtonElement>('.candidate-retry')!;
      retryBtn.onclick = (e) => {
        if (this.applying) return;
        e.stopPropagation();
        void this.retryCandidate(i).catch(this.handleError.bind(this));
      };
    });
  }

  private updateProposalLibraryState(): void {
    const doc = this.session.doc;
    const isVersion = ($('proposal-mode-version') as HTMLInputElement | null)?.checked ?? false;
    const targetRow = $('proposal-version-target-row');
    const targetSelect = $('proposal-version-target') as HTMLSelectElement | null;
    const kindSelect = $('proposal-asset-kind') as HTMLSelectElement | null;
    const kindHint = $('proposal-kind-hint');
    const applyBtn = $('proposal-apply') as HTMLButtonElement | null;

    if (targetRow) targetRow.hidden = !isVersion;
    if (applyBtn) {
      applyBtn.textContent = isVersion ? 'Áp dụng thành phiên bản mới' : 'Áp dụng thành asset mới';
    }

    if (!doc || !isVersion) {
      if (kindSelect) {
        kindSelect.disabled = this.applying;
      }
      if (kindHint) kindHint.textContent = '';
      return;
    }

    const targetId = targetSelect?.value;
    const targetAsset = doc.assets.find(a => a.id === targetId);

    if (!targetAsset) {
      if (kindHint) kindHint.textContent = 'Vui lòng chọn asset hợp lệ trong dự án.';
      return;
    }

    const info = getAssetLibraryInfo(doc, targetAsset.id);
    if (info.isExplicit) {
      if (kindSelect) {
        kindSelect.value = info.kind;
        kindSelect.disabled = true;
      }
      if (kindHint) {
        const kindLabel = info.kind === 'character' ? 'Nhân vật' : info.kind === 'tileset' ? 'Tileset' : 'Đồ vật';
        kindHint.textContent = `Kế thừa phân loại '${kindLabel}' từ nhóm phiên bản có sẵn.`;
      }
    } else {
      if (kindSelect) {
        kindSelect.disabled = this.applying;
      }
      if (kindHint) {
        kindHint.textContent = 'Asset gốc chưa phân loại. Chọn phân loại sẽ gán cho cả asset gốc (v1) và phiên bản mới (v2).';
      }
    }
  }

  private populateVersionTargets(): void {
    const doc = this.session.doc;
    const select = $('proposal-version-target') as HTMLSelectElement | null;
    if (!select || !doc) return;

    const previousValue = select.value;
    select.replaceChildren();

    for (const asset of doc.assets) {
      const opt = document.createElement('option');
      opt.value = asset.id;
      opt.textContent = `${asset.name} (${asset.w}×${asset.h})`;
      select.append(opt);
    }

    if (this.session.assetId && doc.assets.some(a => a.id === this.session.assetId)) {
      select.value = this.session.assetId;
    } else if (previousValue && doc.assets.some(a => a.id === previousValue)) {
      select.value = previousValue;
    } else if (doc.assets[0]) {
      select.value = doc.assets[0].id;
    }
  }

  private resetProposalLibraryControls(defaultName?: string): void {
    const newRadio = $('proposal-mode-new') as HTMLInputElement | null;
    if (newRadio) newRadio.checked = true;
    const nameInput = $('proposal-asset-name') as HTMLInputElement | null;
    if (nameInput) nameInput.value = defaultName ?? '';
    const kindSelect = $('proposal-asset-kind') as HTMLSelectElement | null;
    if (kindSelect) kindSelect.value = 'object';

    this.populateVersionTargets();
    this.updateProposalLibraryState();
  }

  private isClipBatch(): boolean {
    return (
      this.activeBatch?.config?.operation === 'clip-regenerate' ||
      !!this.activeBatch?.config?.clip ||
      !!this.currentPreview?.generation?.clip
    );
  }

  open(): void {
    const a = this.session.asset;
    $('ai-context-info').textContent = a ? `${a.name} · ${a.w}×${a.h}` : (this.session.doc ? `Dự án: ${this.session.doc.name}` : 'Chưa có dự án');
    this.clearModalError();
    this.artForm.loadFromDoc(false);
    this.dialog.showModal();
    if (this.activeBatch) {
      this.renderBatchState();
    } else {
      void this.restoreRecentBatch();
    }
  }

  private showExternal(visible: boolean): void {
    $('legacy-generation-panel').hidden = visible;
    $('external-engine-panel').hidden = !visible;
    $<HTMLSelectElement>('generation-source').value = visible ? 'external' : 'legacy';
    if (visible) void this.external.show();
    else this.external.hide();
  }

  close(force = false): void {
    if ((this.applying || this.external.isBusy) && !force) return;
    this.variantPreview.stop();
    this.dialog.close();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  handleSSEBatch(batch: CompactBatchInfo): void {
    if (this.applying) return;
    if (this.dismissedBatches.has(batch.id)) return;
    if (!this.session.doc || batch.projectId !== this.session.doc.id) return;
    if (this.activeBatch && this.activeBatch.id !== batch.id) return;
    this.activeBatch = batch;
    this.lastBatchUpdateTimestamp = Date.now();
    this.renderBatchState();
  }

  async restoreRecentBatch(): Promise<void> {
    if (!this.session.doc) return;
    const projectId = this.session.doc.id;
    const currentRev = this.session.doc.revision;
    const ticket = ++this.restoreTicket;

    try {
      const batches: CompactBatchInfo[] = await api(`${this.session.path}/generation-batches`);
      if (ticket !== this.restoreTicket || !this.session.doc || this.session.doc.id !== projectId || this.session.doc.revision !== currentRev) return;
      if (this.activeBatch && (this.activeBatch.status === 'running' || this.activeBatch.revision === currentRev)) return;

      const matching = batches.filter(b => b.revision === currentRev && !this.dismissedBatches.has(b.id));
      const recent = matching.find(b => b.status === 'running') || matching[matching.length - 1];
      if (!recent) return;

      this.activeBatch = recent;
      this.lastBatchUpdateTimestamp = Date.now();
      if (recent.status === 'running') {
        this.startPolling();
        this.startElapsedTimer();
      } else {
        this.stopPolling();
        this.stopElapsedTimer();
      }
      this.renderBatchState();
    } catch {
      // Ignore restore errors silently
    }
  }

  async startBatch(options?: StartBatchOptions): Promise<void> {
    if (this.starting || this.applying) return;
    const doc = this.session.doc;
    if (!doc) throw new Error('Vui lòng chọn hoặc tạo dự án trước.');

    if (this.activeBatch?.status === 'running') {
      throw new Error('Đợt tạo đang chạy; không thể khởi tạo đợt mới.');
    }
    if (this.activeBatch?.status === 'unknown') {
      throw new Error('Đợt tạo trước đó chưa rõ trạng thái tiến trình; không thể khởi tạo đợt mới.');
    }
    if (this.isClipBatch() && !options?.animation && !options?.regionEdit && !options?.clipGeneration) {
      throw new Error('Đợt tạo clip cần được tạo lại từ Trình chỉnh sửa clip. Chọn "Tạo sprite mới" để tạo sprite độc lập.');
    }

    this.starting = true;
    this.renderBatchState();
    this.clearModalError();
    const actionTicket = ++this.actionTicket;
    let batchRev = doc.revision;
    const batchProjId = doc.id;
    this.restoreTicket++;

    try {
      // Invoke app prepareAi callback on EVERY start to stop/confirm/flush
      await this.prepareAi();
      if (actionTicket !== this.actionTicket || this.session.doc !== doc) {
        throw new Error('Thao tác khởi tạo bị hủy hoặc dự án đã thay đổi.');
      }
      batchRev = doc.revision;

      if (options?.expectedSource) {
        const curAsset = this.session.asset;
        if (
          !curAsset ||
          curAsset.id !== options.expectedSource.assetId ||
          this.session.frameId !== options.expectedSource.frameId ||
          doc.revision !== options.expectedSource.revision ||
          (options.expectedSource.projectId && doc.id !== options.expectedSource.projectId) ||
          (options.expectedSource.w !== undefined && curAsset.w !== options.expectedSource.w) ||
          (options.expectedSource.h !== undefined && curAsset.h !== options.expectedSource.h)
        ) {
          throw new Error('Nguồn hoặc phiên bản đã thay đổi. Đóng và mở lại hộp thoại.');
        }
      }

      // Resolve + validate the provider capability BEFORE touching prepared preview/result
      // state so an unsupported request keeps the existing proposal visible.
      const requestedProvider: unknown = options?.provider ?? ($('provider') as HTMLSelectElement).value;
      if (!isActiveAiProvider(requestedProvider)) {
        throw new Error('Nhà cung cấp AI không hợp lệ. Chọn Codex hoặc DeepSeek.');
      }
      const provider: ActiveAiProvider = requestedProvider;

      const prompt = options?.prompt ?? options?.motion ?? ($('ai-prompt') as HTMLTextAreaElement).value.trim();
      if (!prompt) throw new Error('Chọn nhà cung cấp AI và nhập yêu cầu 1–12.000 ký tự.');

      const genOpts = this.artForm.getGenerationOptions();
      const artDirection = this.artForm.getArtDirection();

      if (options?.animation) {
        genOpts.animation = options.animation;
      }

      // DeepSeek backends reject image contexts; never silently drop refs/options.
      if (
        provider === 'deepseek' &&
        (genOpts.reference ||
          genOpts.animation ||
          !!artDirection.references?.length ||
          options?.regionEdit ||
          options?.clipGeneration)
      ) {
        throw new Error('DeepSeek chưa hỗ trợ tác vụ cần ngữ cảnh hình ảnh (tham chiếu frame, animation, chỉnh sửa vùng hoặc tạo lại clip). Hãy chọn Codex cho tác vụ này.');
      }

      if (options?.provider) ($('provider') as HTMLSelectElement).value = options.provider;

      this.variantPreview.reset();
      $('proposal').hidden = true;
      this.previewMode = 'batch';
      this.standaloneProposal = undefined;
      this.selectedCandidateIndex = -1;
      this.currentPreview = undefined;
      this.candidateThumbs.clear();
      this.inFlightThumbs.clear();
      this.activeBatch = undefined;
      this.renderBatchState();

      // Always include session.assetId even fresh/no-reference
      const payload: Record<string, unknown> = {
        revision: doc.revision,
        provider,
        prompt,
        assetId: this.session.assetId,
        generationOptions: genOpts,
        artDirection,
      };

      if (options?.regionEdit) {
        payload.regionEdit = options.regionEdit;
      }
      if (options?.clipGeneration) {
        const clip = doc.studio?.clips?.[options.clipGeneration.clipId];
        const profile = clip && doc.studio?.characters?.[clip.characterId];
        if (!profile) throw new Error('Không tìm thấy clip hoặc nhân vật nguồn.');
        const mode = options.clipPaletteMode ?? 'asset';
        genOpts.paletteMode = mode; artDirection.paletteMode = mode;
        if (mode === 'asset') artDirection.palette = [...profile.source.palette];
        payload.clipGeneration = options.clipGeneration;
        payload.assetId = profile.source.assetId;
      }

      $('ai-generate').setAttribute('disabled', 'true');
      $('ai-cancel').removeAttribute('disabled');
      $('ai-status').textContent = 'Đang khởi tạo đợt tạo 3 phương án…';

      const batch: CompactBatchInfo = await api(`${this.session.path}/generation-batches`, 'POST', payload);
      if (actionTicket !== this.actionTicket || !this.session.doc || this.session.doc.id !== batchProjId || this.session.doc.revision !== batchRev) {
        throw new Error('Dự án đã đổi trong khi tạo đề xuất.');
      }
      this.activeBatch = batch;
      this.lastBatchUpdateTimestamp = Date.now();

      if (!this.isOpen) {
        this.open();
      }

      this.renderBatchState();
      this.startPolling();
      this.startElapsedTimer();
    } catch (err) {
      if (actionTicket !== this.actionTicket || !this.session.doc || this.session.doc.id !== batchProjId) {
        return;
      }
      // Restore buttons on failure
      $('ai-generate').removeAttribute('disabled');
      $('ai-cancel').setAttribute('disabled', 'true');
      $('ai-status').textContent = (err as Error).message;
      this.handleError(err);
      throw err;
    } finally {
      if (actionTicket === this.actionTicket && this.session.doc?.id === batchProjId) {
        this.starting = false;
        this.renderBatchState();
      }
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollBatch();
    }, 800);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      if (!this.activeBatch) return;
      if (['running'].includes(this.activeBatch.status)) {
        const delta = Math.max(0, Date.now() - this.lastBatchUpdateTimestamp);
        const batchSec = Math.floor(((this.activeBatch.elapsedMs ?? 0) + delta) / 1000);
        $('ai-status').textContent = `Đang chạy tuần tự: ${batchSec}s / ${(this.activeBatch.limits?.batchMs ?? DEFAULT_BATCH_TIMEOUT) / 1000}s (mỗi phương án tối đa ${(this.activeBatch.limits?.candidateMs ?? DEFAULT_CANDIDATE_TIMEOUT) / 1000}s)`;

        // Also update running candidate elapsed
        const cards = this.dialog.querySelectorAll<HTMLElement>('.candidate-card');
        for (let i = 0; i < 3; i++) {
          const cand = this.activeBatch.candidates[i];
          if (cand && cand.status === 'running') {
            const candSec = (((cand.elapsedMs ?? 0) + delta) / 1000).toFixed(1);
            const elapsedSpan = cards[i]?.querySelector<HTMLElement>('.card-elapsed');
            if (elapsedSpan) elapsedSpan.textContent = `${candSec}s`;
          }
        }
      }
    }, 500);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

  private async pollBatch(): Promise<void> {
    if (!this.activeBatch || !this.session.doc) return;
    const pollTicket = ++this.pollTicket;
    const batchId = this.activeBatch.id;
    const projectId = this.session.doc.id;

    try {
      const updated: CompactBatchInfo = await api(`${this.session.path}/generation-batches/${batchId}`);
      if (pollTicket !== this.pollTicket || !this.session.doc || this.session.doc.id !== projectId) return;
      if (this.activeBatch?.id !== batchId) return;

      this.activeBatch = updated;
      this.lastBatchUpdateTimestamp = Date.now();
      this.renderBatchState();

      if (['ready', 'partial', 'failed', 'canceled', 'unknown', 'applied'].includes(updated.status)) {
        this.stopPolling();
        this.stopElapsedTimer();
      }
    } catch {
      this.stopPolling();
      this.stopElapsedTimer();
    }
  }

  private renderBatchState(): void {
    $('mode-new-sprite').toggleAttribute('disabled', this.isLocked());
    $('ai-tileset').toggleAttribute('disabled', this.isLocked() || !this.onTileset);
    $('ai-edit-clip').hidden = !this.isClipBatch() || !this.onEditClip;
    $('ai-edit-clip').toggleAttribute('disabled', this.isLocked());
    if (this.applying) {
      this.setModalActionsDisabled(true);
      return;
    }
    if (this.starting) {
      $('ai-generate').setAttribute('disabled', 'true');
      $('ai-cancel').setAttribute('disabled', 'true');
      const regionBtn = $('ai-region-edit') as HTMLButtonElement | null;
      if (regionBtn) regionBtn.setAttribute('disabled', 'true');
      const animBtn = $('ai-animate') as HTMLButtonElement | null;
      if (animBtn) animBtn.setAttribute('disabled', 'true');
      $('ai-status').textContent = 'Đang khởi tạo đợt tạo 3 phương án…';
      this.updateApplyGate();
      return;
    }
    if (!this.activeBatch) {
      $('ai-generate').removeAttribute('disabled');
      $('ai-cancel').setAttribute('disabled', 'true');
      $('ai-status').textContent = 'Sẵn sàng tạo đề xuất.';
      const regionBtn = $('ai-region-edit') as HTMLButtonElement | null;
      if (regionBtn) regionBtn.toggleAttribute('disabled', false);
      const animBtn = $('ai-animate') as HTMLButtonElement | null;
      if (animBtn) animBtn.toggleAttribute('disabled', false);
      const cards = this.dialog.querySelectorAll<HTMLElement>('.candidate-card');
      for (let i = 0; i < 3; i++) {
        const card = cards[i];
        if (!card) continue;
        card.classList.remove('selected');
        const statusBadge = card.querySelector<HTMLElement>('.card-status');
        if (statusBadge) { statusBadge.textContent = 'Chờ'; statusBadge.className = 'card-status badge'; }
        const dimSpan = card.querySelector<HTMLElement>('.card-dim');
        if (dimSpan) dimSpan.textContent = '—';
        const callsSpan = card.querySelector<HTMLElement>('.card-calls');
        if (callsSpan) callsSpan.textContent = '—';
        const elapsedSpan = card.querySelector<HTMLElement>('.card-elapsed');
        if (elapsedSpan) elapsedSpan.textContent = '—';
        const msgP = card.querySelector<HTMLElement>('.card-msg');
        if (msgP) msgP.textContent = '';
        const retryBtn = card.querySelector<HTMLButtonElement>('.candidate-retry');
        if (retryBtn) retryBtn.hidden = true;
      }
      return;
    }
    const batch = this.activeBatch;

    const isRunning = batch.status === 'running';
    const isUnknown = batch.status === 'unknown' || batch.candidates.some(c => c.status === 'unknown');
    const isClip = this.isClipBatch();
    const generateBtn = $('ai-generate') as HTMLButtonElement | null;
    if (generateBtn) {
      const disabled = isRunning || isUnknown || isClip;
      generateBtn.toggleAttribute('disabled', disabled);
      generateBtn.title = isClip
        ? 'Đợt tạo clip: Tạo lại cần thông qua Trình chỉnh sửa clip. Chọn "Tạo sprite mới" để tạo độc lập.'
        : '';
    }
    $('ai-cancel').toggleAttribute('disabled', !(isRunning || isUnknown));
    $('ai-cancel').textContent = isUnknown ? 'Kiểm tra lại việc hủy' : 'Hủy đợt tạo';
    const regionBtn = $('ai-region-edit') as HTMLButtonElement | null;
    if (regionBtn) regionBtn.toggleAttribute('disabled', isRunning || isUnknown);
    const animBtn = $('ai-animate') as HTMLButtonElement | null;
    if (animBtn) animBtn.toggleAttribute('disabled', isRunning || isUnknown);

    // Status message
    if (batch.status === 'ready') {
      const totalSec = ((batch.elapsedMs ?? 0) / 1000).toFixed(1);
      $('ai-status').textContent = `Hoàn thành 3 phương án (${totalSec}s). Chọn phương án để xem chi tiết hoặc chuẩn hóa.`;
    } else if (batch.status === 'partial') {
      $('ai-status').textContent = 'Đợt tạo hoàn thành một phần. Có thể thử lại phương án lỗi hoặc áp dụng phương án sẵn sàng.';
    } else if (batch.status === 'failed') {
      $('ai-status').textContent = 'Đợt tạo thất bại.';
    } else if (batch.status === 'canceled') {
      $('ai-status').textContent = 'Đợt tạo đã hủy.';
    } else if (batch.status === 'unknown') {
      $('ai-status').textContent = 'Không rõ trạng thái tiến trình. Nhấn "Kiểm tra lại việc hủy" để xác nhận dừng cục bộ; nhà cung cấp từ xa có thể vẫn xử lý và tính phí.';
    } else if (isRunning) {
      const delta = Math.max(0, Date.now() - this.lastBatchUpdateTimestamp);
      const sec = Math.floor(((batch.elapsedMs ?? 0) + delta) / 1000);
      $('ai-status').textContent = `Đang tạo 3 phương án: ${sec}s / ${(this.activeBatch?.limits?.batchMs ?? DEFAULT_BATCH_TIMEOUT) / 1000}s`;
    }

    // Render candidate cards
    const cards = this.dialog.querySelectorAll<HTMLElement>('.candidate-card');
    for (let i = 0; i < 3; i++) {
      const card = cards[i];
      if (!card) continue;
      const cand: CompactCandidateInfo | undefined = batch.candidates[i];

      const statusBadge = card.querySelector<HTMLElement>('.card-status')!;
      const dimSpan = card.querySelector<HTMLElement>('.card-dim')!;
      const callsSpan = card.querySelector<HTMLElement>('.card-calls')!;
      const elapsedSpan = card.querySelector<HTMLElement>('.card-elapsed')!;
      const msgP = card.querySelector<HTMLElement>('.card-msg')!;
      const retryBtn = card.querySelector<HTMLButtonElement>('.candidate-retry')!;
      const thumbCanvas = card.querySelector<HTMLCanvasElement>('.candidate-thumb')!;

      card.classList.toggle('selected', i === this.selectedCandidateIndex);

      if (!cand) {
        statusBadge.textContent = 'Chờ';
        statusBadge.className = 'card-status badge';
        dimSpan.textContent = '—';
        callsSpan.textContent = '—';
        elapsedSpan.textContent = '—';
        msgP.textContent = '';
        retryBtn.hidden = true;
        continue;
      }

      const statusMap: Record<string, string> = {
        pending: 'Chờ',
        running: 'Đang tạo…',
        ready: 'Sẵn sàng',
        failed: 'Thất bại',
        canceled: 'Đã hủy',
        unknown: 'Không rõ',
      };
      statusBadge.textContent = statusMap[cand.status] ?? cand.status;
      statusBadge.className = `card-status badge ${cand.status}`;

      const dims = cand.dimensions ?? batch.config?.target;
      dimSpan.textContent = dims ? `${dims.w}×${dims.h}` : '—';

      const calls = cand.cliExecutions ?? 0;
      const repairs = cand.repairs ? ` · ${cand.repairs} lần sửa` : '';
      callsSpan.textContent = `${calls} lần gọi CLI${repairs}`;

      const delta = cand.status === 'running' ? Math.max(0, Date.now() - this.lastBatchUpdateTimestamp) : 0;
      const candElapsed = (cand.elapsedMs ?? 0) + delta;
      elapsedSpan.textContent = cand.status !== 'pending' ? `${(candElapsed / 1000).toFixed(1)}s` : '—';
      msgP.textContent = cand.error ?? cand.message ?? '';

      retryBtn.hidden = cand.status !== 'failed' || batch.status === 'running' || isUnknown;

      if (cand.status === 'ready' && this.isOpen) {
        this.ensureCandidateThumbnail(cand, thumbCanvas);
      }
    }

    // Auto-select candidate 0 if ready and nothing selected yet, only if workspace is open
    if (this.selectedCandidateIndex === -1 && this.isOpen && !this.applying) {
      const firstReady = batch.candidates.findIndex(c => c.status === 'ready');
      if (firstReady !== -1) {
        void this.selectCandidate(firstReady).catch(this.handleError.bind(this));
      }
    }

    this.updateApplyGate();
  }

  private ensureCandidateThumbnail(cand: CompactCandidateInfo, canvas: HTMLCanvasElement): void {
    const cached = this.candidateThumbs.get(cand.id);
    if (cached) {
      this.drawThumb(canvas, cached);
      return;
    }

    if (this.inFlightThumbs.has(cand.id)) return;
    if (!this.activeBatch || !this.session.doc) return;

    const batchId = this.activeBatch.id;
    const candId = cand.id;
    const rev = this.activeBatch.revision;
    const projectId = this.session.doc.id;

    this.inFlightThumbs.add(candId);
    api(`${this.session.path}/generation-batches/${batchId}/candidates/${candId}/preview`, 'POST', { revision: rev })
      .then(async (preview: VariantPreview) => {
        try {
          if (!this.session.doc || this.session.doc.id !== projectId || this.session.doc.revision !== rev) return;
          if (!this.activeBatch || this.activeBatch.id !== batchId) return;
          const isClip = !!preview.generation?.clip;
          const v = (isClip ? preview.variants.find(x => x.kind === 'protected') : undefined)
            ?? preview.variants.find(x => x.id === preview.selectedVariantId)
            ?? preview.variants[0];
          const a = v.assets[0];
          const f = a.frames[0];
          const frameData: VariantFrame = await api(`${this.session.path}/proposals/${preview.proposalId}/variants/${v.id}/frame?revision=${rev}&asset=${a.id}&frame=${f.id}`);
          if (!this.session.doc || this.session.doc.id !== projectId || this.session.doc.revision !== rev || this.activeBatch?.id !== batchId) return;
          this.candidateThumbs.set(candId, frameData);
          this.drawThumb(canvas, frameData);
        } finally {
          this.inFlightThumbs.delete(candId);
        }
      })
      .catch(() => {
        this.inFlightThumbs.delete(candId);
      });
  }

  private drawThumb(canvas: HTMLCanvasElement, frame: VariantFrame): void {
    const scale = Math.max(1, Math.floor(64 / Math.max(frame.w, frame.h)));
    const targetW = frame.w * scale;
    const targetH = frame.h * scale;
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${targetH}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const offscreen = document.createElement('canvas');
    offscreen.width = frame.w;
    offscreen.height = frame.h;
    const offCtx = offscreen.getContext('2d')!;
    const imgData = offCtx.createImageData(frame.w, frame.h);
    const bytes = imgData.data;
    for (let i = 0; i < frame.data.length; i++) {
      const p = frame.data[i];
      bytes[i * 4] = p >>> 24;
      bytes[i * 4 + 1] = (p >>> 16) & 255;
      bytes[i * 4 + 2] = (p >>> 8) & 255;
      bytes[i * 4 + 3] = p & 255;
    }
    offCtx.putImageData(imgData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(offscreen, 0, 0, targetW, targetH);
  }

  async selectCandidate(index: number): Promise<void> {
    if (this.applying) return;
    if (!this.activeBatch || !this.session.doc) return;
    const cand = this.activeBatch.candidates[index];
    if (!cand || cand.status !== 'ready') return;

    this.selectedCandidateIndex = index;
    this.currentPreview = undefined;
    this.previewMode = 'batch';
    this.standaloneProposal = undefined;
    this.variantPreview.reset();
    $('proposal').hidden = true;
    this.updateApplyGate();

    const ticket = ++this.selectionTicket;
    const batchId = this.activeBatch.id;
    const candidateId = cand.id;
    const rev = this.session.doc.revision;
    const projectId = this.session.doc.id;
    const current = () => ticket === this.selectionTicket && this.session.doc?.id === projectId
      && this.session.doc.revision === rev && this.activeBatch?.id === batchId && this.selectedCandidateIndex === index;
    const selectionError = (error: unknown) => { if (current()) throw error; };

    const preview: VariantPreview | undefined = await api(
      `${this.session.path}/generation-batches/${batchId}/candidates/${candidateId}/preview`,
      'POST',
      { revision: rev }
    ).catch(selectionError);

    // Monotonic guard: verify this is still the active selection ticket
    if (
      !preview || !current()
    ) {
      return;
    }

    this.currentPreview = preview;

    const beforeAsset = this.activeBatch.config?.target?.assetId
      ? this.session.doc.assets.find(a => a.id === this.activeBatch!.config!.target.assetId)
      : this.session.asset;

    if (beforeAsset) {
      const frameId = preview.generation?.clip?.context?.sourceFrameId
        ?? preview.generation?.animation?.frameId
        ?? beforeAsset.frames[0]?.id;
      if (frameId) {
        await this.session.loadFrame(frameId, beforeAsset).catch(selectionError);
      }
    }

    if (ticket !== this.selectionTicket || this.activeBatch?.id !== batchId || this.session.doc?.revision !== rev) return;

    $('proposal').hidden = false;
    this.resetProposalLibraryControls(preview.generation?.clip?.context.name ?? cand.description ?? 'Sprite');
    if (preview.generation?.clip) ($('proposal-asset-kind') as HTMLSelectElement).value = 'character';
    await this.variantPreview.show(preview, beforeAsset).catch(selectionError);
    if (ticket !== this.selectionTicket || this.activeBatch?.id !== batchId || this.session.doc?.revision !== rev) return;

    $('proposal-description').textContent = cand.description ?? 'Đề xuất AI';

    if (this.activeBatch.config) {
      const c = this.activeBatch.config;
      const opt = c.options;
      const s = opt?.style ? (generationStyles as Record<string, string>)[opt.style] ?? opt.style : 'Game';
      const v = opt?.view ? (generationViews as Record<string, string>)[opt.view] ?? opt.view : 'Chính diện';
      if (c.clip) {
        const k = c.clip.slots.filter(slot => slot.selected).length;
        const n = c.clip.slots.length;
        const p = c.clip.paletteMode === 'asset' ? 'Palette cố định từ asset' : 'Palette cố định (≤16 màu)';
        const modeStr = c.clip.mode === 'region' ? 'Khóa vùng' : 'Toàn bộ';
        const sourceFrame = beforeAsset?.frames.findIndex(frame => frame.id === c.clip!.sourceFrameId) ?? -1;
        $('proposal-settings').textContent = `${c.clip.w}×${c.clip.h} · ${s} · ${v} · ${p} · ${k}/${n} frame (${modeStr}) · ${sourceFrame >= 0 ? `Frame nguồn ${sourceFrame + 1}` : 'Frame nguồn đã duyệt'}`;
      } else {
        const p = opt?.paletteMode === 'asset' ? 'Palette asset' : 'AI chọn ≤16 màu';
        const r = c.operation === 'region-edit'
          ? 'Chỉnh sửa vùng từ frame đã chọn'
          : opt?.reference
          ? 'Tham chiếu frame 1'
          : (c.artDirection.references?.length ? `${c.artDirection.references.length} tham chiếu` : 'Không tham chiếu');
        $('proposal-settings').textContent = `${c.target.w}×${c.target.h} · ${s} · ${v} · ${p} · ${r}`;
      }
    }

    this.renderBatchState();
  }

  async showReferenceProposal(preview: VariantPreview, beforeAsset?: PixelAsset): Promise<void> {
    if (this.applying) return;
    this.previewMode = 'standalone';
    this.standaloneProposal = {
      proposalId: preview.proposalId,
      revision: this.session.doc!.revision,
    };
    this.currentPreview = preview;
    this.activeBatch = undefined;
    this.selectedCandidateIndex = -1;

    $('proposal').hidden = false;
    $('proposal-description').textContent = 'Mẫu chuẩn từ frame hiện tại';
    this.resetProposalLibraryControls(beforeAsset ? `${beforeAsset.name} (Chuẩn)` : 'Mẫu chuẩn');
    await this.variantPreview.show(preview, beforeAsset);
    this.updateApplyGate();
  }

  async retryCandidate(index: number): Promise<void> {
    if (this.applying) return;
    if (!this.activeBatch || !this.session.doc) return;
    const cand = this.activeBatch.candidates[index];
    if (!cand || cand.status !== 'failed') return;
    if (this.activeBatch.status === 'unknown') return;

    this.clearModalError();
    const actionTicket = ++this.actionTicket;
    const batchId = this.activeBatch.id;
    const projectId = this.session.doc.id;
    const rev = this.session.doc.revision;

    try {
      const res: CompactBatchInfo = await api(
        `${this.session.path}/generation-batches/${batchId}/candidates/${cand.id}/retry`,
        'POST',
        { revision: rev }
      );

      if (actionTicket !== this.actionTicket || !this.session.doc || this.session.doc.id !== projectId || this.session.doc.revision !== rev || this.activeBatch?.id !== batchId) {
        return;
      }

      this.activeBatch = res;
      this.lastBatchUpdateTimestamp = Date.now();
      this.renderBatchState();
      this.startPolling();
      this.startElapsedTimer();
    } catch (err) {
      this.handleError(err);
    }
  }

  async cancelBatch(): Promise<void> {
    if (this.applying) return;
    if (!this.activeBatch || !this.session.doc) return;
    const actionTicket = ++this.actionTicket;
    const batchId = this.activeBatch.id;
    const projectId = this.session.doc.id;
    const rev = this.session.doc.revision;

    try {
      const res: CompactBatchInfo = await api(
        `${this.session.path}/generation-batches/${batchId}/cancel`,
        'POST',
        { revision: rev }
      );

      if (actionTicket !== this.actionTicket || !this.session.doc || this.session.doc.id !== projectId || this.session.doc.revision !== rev || this.activeBatch?.id !== batchId) {
        return;
      }

      this.activeBatch = res;
      this.lastBatchUpdateTimestamp = Date.now();
      this.stopPolling();
      this.stopElapsedTimer();
      this.renderBatchState();
    } catch (err) {
      this.handleError(err);
    }
  }

  canApplyCurrent(): boolean {
    const doc = this.session.doc;
    if (!doc || this.session.dirty || this.session.conflict || this.session.saving || this.starting || this.applying) return false;

    if (this.previewMode === 'batch') {
      if (!this.activeBatch) return false;
      if (!['ready', 'partial'].includes(this.activeBatch.status)) return false;
      const cand = this.activeBatch.candidates[this.selectedCandidateIndex];
      if (!cand || cand.status !== 'ready') return false;
      if (doc.revision !== this.activeBatch.revision) return false;
      if (!this.currentPreview || this.variantPreview.currentProposal?.proposalId !== this.currentPreview.proposalId) return false;
      return this.variantPreview.canApply;
    }

    if (this.previewMode === 'standalone') {
      if (!this.standaloneProposal) return false;
      if (doc.revision !== this.standaloneProposal.revision) return false;

      return this.variantPreview.canApply;
    }

    return false;
  }

  updateApplyGate(): void {
    const applyBtn = document.getElementById('proposal-apply') as HTMLButtonElement | null;
    if (applyBtn) {
      applyBtn.disabled = !this.canApplyCurrent();
    }
  }

  public isLocked(): boolean {
    return this.starting || this.applying || this.activeBatch?.status === 'running' || this.activeBatch?.status === 'unknown';
  }

  private setModalActionsDisabled(disabled: boolean): void {
    const ids = [
      'proposal-apply',
      'proposal-mode-new',
      'proposal-mode-version',
      'proposal-version-target',
      'proposal-asset-name',
      'proposal-asset-kind',
      'ai-generate',
      'ai-cancel',
      'normalize-reference',
      'ai-animate',
      'ai-region-edit',
      'ai-close',
      'save-art-direction',
      'mode-new-sprite',
      'proposal-normalize',
      'provider-check',
    ];
    for (const id of ids) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | null;
      if (el) el.disabled = disabled;
    }
    this.dialog.querySelectorAll<HTMLButtonElement>('.candidate-retry').forEach(b => {
      b.disabled = disabled;
    });
    this.dialog.querySelectorAll<HTMLElement>('.candidate-card').forEach(card => {
      card.style.pointerEvents = disabled ? 'none' : '';
    });
  }

  async applySelectedProposal(): Promise<void> {
    if (this.applying) return;
    const doc = this.session.doc;
    if (!doc) return;
    if (!this.canApplyCurrent()) {
      throw new Error('Chưa thể áp dụng đề xuất này.');
    }

    const proposalId = this.variantPreview.currentProposal?.proposalId ?? (
      this.previewMode === 'batch'
        ? this.currentPreview?.proposalId
        : this.standaloneProposal?.proposalId
    );
    const variantId = this.variantPreview.selection;
    if (!proposalId) return;

    const isVersion = ($('proposal-mode-version') as HTMLInputElement | null)?.checked ?? false;
    const kind = (($('proposal-asset-kind') as HTMLSelectElement | null)?.value ?? 'object') as LibraryKind;
    const rawName = ($('proposal-asset-name') as HTMLInputElement | null)?.value.trim() ?? '';
    const targetSelect = $('proposal-version-target') as HTMLSelectElement | null;
    const versionOf = isVersion ? targetSelect?.value : undefined;

    if (isVersion) {
      if (!versionOf || !doc.assets.some(a => a.id === versionOf)) {
        throw new Error('Asset gốc để tạo phiên bản không tồn tại.');
      }
    }

    const library: ApplyLibraryOptions = {
      kind,
      ...(rawName ? { name: rawName } : {}),
      ...(isVersion ? { versionOf } : {}),
    };

    const proposalEl = $('proposal');
    const wasProposalVisible = proposalEl && !proposalEl.hidden;

    this.applying = true;
    this.setModalActionsDisabled(true);
    if (proposalEl) proposalEl.hidden = true;
    this.projectLock(true);

    try {
      await this.session.flush();
      const saved = await this.writeRevision(`${this.session.path}/apply-proposal`, {
        revision: doc.revision,
        proposalId,
        variantId,
        library,
      });

      this.close(true);
      await this.onProjectApplied(saved);
    } catch (err) {
      if (proposalEl && wasProposalVisible) {
        proposalEl.hidden = false;
      }
      this.handleError(err);
      throw err;
    } finally {
      this.applying = false;
      this.projectLock(false);
      this.setModalActionsDisabled(false);
      this.updateProposalLibraryState();
      this.updateApplyGate();
    }
  }

  resetProject(): void {
    this.dismissedBatches.clear();
    this.starting = false;
    this.stopPolling();
    this.stopElapsedTimer();
    this.restoreTicket++;
    this.selectionTicket++;
    this.pollTicket++;
    this.actionTicket++;
    this.activeBatch = undefined;
    this.selectedCandidateIndex = -1;
    this.currentPreview = undefined;
    this.previewMode = 'none';
    this.standaloneProposal = undefined;
    this.candidateThumbs.clear();
    this.inFlightThumbs.clear();
    this.variantPreview.reset();
    $('proposal').hidden = true;
    this.clearModalError();
    this.renderBatchState();
    this.updateApplyGate();
  }

  private handleError(err: unknown): void {
    const msg = (err as Error).message || String(err);
    const modalError = document.getElementById('ai-modal-error');
    if (modalError) {
      modalError.textContent = msg;
      modalError.hidden = false;
    }
    const status = document.getElementById('ai-status');
    if (status) {
      status.textContent = msg;
    }
    this.onerror(err);
  }

  private clearModalError(): void {
    const modalError = document.getElementById('ai-modal-error');
    if (modalError) {
      modalError.textContent = '';
      modalError.hidden = true;
    }
  }
}
