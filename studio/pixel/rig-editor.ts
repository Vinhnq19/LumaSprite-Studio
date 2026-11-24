import { Session } from './session.ts';
import {
  celFor,
  composite,
  isLocked,
  newLayer,
  uid,
  type PixelAsset,
  type PixelLayer,
  type PixelDocument,
} from '../../src/studio/pixel/model.ts';
import { rectangle } from '../../src/studio/pixel/tools.ts';
import { validateRigDraft, rigDraftContext, type RigDraft } from '../../src/studio/quality/rig-draft.ts';
import { splitRigPart, addRigLayer } from '../../src/studio/quality/rig-parts.ts';
import { applyMotionEdits, type MotionEditCommand } from '../../src/studio/quality/motion-edit.ts';
import { solveMotionTarget } from '../../src/studio/quality/motion-ik.ts';
import { createWalkPlan } from '../../src/studio/quality/motion-walk.ts';
import { compileMotionRecipe, type CompiledMotion, type MotionGeometry } from '../../src/studio/quality/motion-render.ts';
import { assertMotionArtwork } from '../../src/studio/quality/motion-art.ts';
import { sampleMotionPlayback } from '../../src/studio/quality/playback.ts';
import { createRecipeRenderer, type RecipeResources } from '../../src/studio/quality/renderer.ts';
import type { MotionJoint, MotionSocket, MotionChain, MotionFrame, MotionPartBinding } from '../../src/studio/quality/motion.ts';
import './rig-editor.css';

export interface RigEditorOptions {
  session: Session;
  prepare: () => Promise<void>;
  projectLock: (enter: boolean) => void;
  writeRevision: (path: string, value: Record<string, unknown>) => Promise<any>;
  onSaved: (doc: PixelDocument, assetId?: string, frameId?: string, historyLabel?: string) => Promise<void>;
  navigate: (assetId: string, frameId: string, layerId?: string) => Promise<void>;
  onDrawLayer: (assetId: string, frameId: string, layerId: string) => Promise<void>;
  onReview: (draft: RigDraft) => Promise<void>;
  onError: (error: unknown) => void;
}

type ViewMode = 'rest' | 'pose';

interface JointDragGesture {
  type: 'drag-joint';
  jointId: string;
  startX: number;
  startY: number;
  initialRest: Map<string, { x: number; y: number }>;
  beforeDoc: PixelDocument;
}

interface SelectRectGesture {
  type: 'select-rect';
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

type ActiveGesture = JointDragGesture | SelectRectGesture;

const option = (value: string, text: string): HTMLOptionElement => {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
};

function picture(canvas: HTMLCanvasElement, pixels: Uint32Array, w: number, h: number, zoom: number): void {
  const data = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const c = pixels[i];
    const off = i * 4;
    data[off] = c >>> 24;
    data[off + 1] = (c >>> 16) & 255;
    data[off + 2] = (c >>> 8) & 255;
    data[off + 3] = c & 255;
  }
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w * zoom}px`;
  canvas.style.height = `${h * zoom}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
}

function getDescendants(joints: MotionJoint[], rootId: string): Set<string> {
  const set = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const j of joints) {
      if (j.parentId === cur && !set.has(j.id)) {
        set.add(j.id);
        queue.push(j.id);
      }
    }
  }
  return set;
}

export class RigEditorController {
  public readonly dialog: HTMLDialogElement;
  private readonly options: RigEditorOptions;

  private draft?: RigDraft;
  private currentDraftId = '';
  private viewMode: ViewMode = 'rest';
  private zoom = 4;
  private ticket = 0;
  private saving = false;
  private loading = false;
  private projectId = '';
  private playTimer?: ReturnType<typeof setTimeout>;

  private selectedLayerId = '';
  private selectedJointId = '';
  private selectedSocketId = '';
  private selectedChainId = '';
  private selectedFrameId = '';

  private addingJoint = false;
  private selectionMask?: Uint8Array;
  private activeGesture?: ActiveGesture;

  private needsRefresh = false;
  private refreshReason = '';
  private poseError = '';
  private compiled?: CompiledMotion;
  private cachedResources?: RecipeResources;
  private restPixels?: Uint32Array;
  private sourcePixels?: Uint32Array;
  private movementMask?: Uint8Array;
  private frozenFrames = new Map<string, Uint32Array>();

  constructor(options: RigEditorOptions) {
    this.options = options;
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'rig-editor';
    this.dialog.className = 'large-workspace';
    this.dialog.setAttribute('aria-labelledby', 'rig-editor-title');

    this.dialog.innerHTML = `
<div class="workspace-header">
  <div class="row">
    <h2 id="rig-editor-title">Biên tập Rig & Chuyển động</h2>
    <span id="rig-status-badge" class="badge"></span>
  </div>
  <div class="header-actions">
    <button id="rig-btn-undo" type="button" title="Hoàn tác (Ctrl+Z)">Hoàn tác</button>
    <button id="rig-btn-redo" type="button" title="Làm lại (Ctrl+Y)">Làm lại</button>
    <button id="rig-btn-review" class="primary" type="button">Duyệt nguồn…</button>
    <button id="rig-btn-close" type="button">Đóng</button>
  </div>
</div>

<p id="rig-error" class="banner-error" role="alert" hidden></p>
<div class="rig-editor-body">
  <!-- Cột trái: Nguồn, Bộ phận, Rig cấu trúc -->
  <aside class="panel left-panel">
    <div class="section-box">
      <div class="section-title">Nguồn Rig (Rig Draft)</div>
      <label>Bản nháp rig
        <select id="rig-draft-select"></select>
      </label>
      <div class="row">
        <button id="rig-btn-create-source" type="button" class="primary">Tạo nguồn mới</button>
        <button id="rig-btn-refresh-draft" type="button">Làm mới nguồn</button>
      </div>
      <p id="rig-refresh-warning" class="banner-warning" hidden></p>
    </div>

    <div class="section-box">
      <div class="section-title">Bộ phận (Source Parts)</div>
      <label>Layer làm việc
        <select id="rig-part-select"></select>
      </label>
      <p id="rig-layer-status" class="hint"></p>
      <div class="rig-part-fields">
        <label>Nguồn gốc
          <select id="rig-part-origin">
            <option value="visible">Từ mẫu (visible)</option>
            <option value="authored">Vẽ bù (authored)</option>
            <option value="derived">Bản sao (derived)</option>
          </select>
        </label>
        <div class="grid-2">
          <label>Pivot X <input id="rig-part-pivot-x" type="number" step="0.5"></label>
          <label>Pivot Y <input id="rig-part-pivot-y" type="number" step="0.5"></label>
        </div>
      </div>
      <div class="row">
        <button id="rig-btn-split-part" type="button">Tách layer theo vùng chọn</button>
      </div>
      <div class="row">
        <button id="rig-btn-new-authored" type="button">Thêm layer vẽ bù</button>
        <button id="rig-btn-draw-layer" type="button">Vẽ layer này</button>
      </div>
    </div>

    <div class="section-box">
      <div class="section-title">Khớp & Khung xương (Rig Joints)</div>
      <label>Danh sách khớp
        <select id="rig-joint-select"></select>
      </label>
      <label>Khớp cha
        <select id="rig-joint-parent"></select>
      </label>
      <div class="grid-2">
        <label>Rest X <input id="rig-joint-rest-x" type="number" step="0.5"></label>
        <label>Rest Y <input id="rig-joint-rest-y" type="number" step="0.5"></label>
      </div>
      <div class="grid-2">
        <label>Góc min <input id="rig-joint-min-rot" type="number" step="1"></label>
        <label>Góc max <input id="rig-joint-max-rot" type="number" step="1"></label>
      </div>
      <div class="row">
        <button id="rig-btn-add-joint" type="button">+ Thêm khớp (click canvas)</button>
        <button id="rig-btn-remove-joint" class="danger" type="button">Xóa khớp</button>
      </div>
    </div>

    <div class="section-box">
      <div class="section-title">Socket & Gắn kết (Sockets & Bindings)</div>
      <label>Gắn bộ phận vào khớp
        <select id="rig-binding-joint"></select>
      </label>
      <label>Socket của bộ phận
        <select id="rig-binding-socket"></select>
      </label>
      <div class="row">
        <button id="rig-btn-add-socket" type="button">Thêm socket tại pivot</button>
        <button id="rig-btn-remove-socket" class="danger" type="button">Xóa socket</button>
      </div>
    </div>
  </aside>

  <!-- Khu vực giữa: Viewport & Canvas -->
  <main class="center-viewport">
    <div class="viewport-toolbar">
      <div class="row">
        <label class="inline"><input id="rig-mode-rest" type="radio" name="rig-view-mode" value="rest" checked> Xem nguồn / Nghỉ</label>
        <label class="inline"><input id="rig-mode-pose" type="radio" name="rig-view-mode" value="pose"> Xem tư thế (Pose)</label>
      </div>
      <div class="row">
        <button id="rig-btn-play" type="button">Phát animation</button>
        <label class="inline">Phóng:
          <select id="rig-zoom-select">
            <option value="1">1×</option>
            <option value="2">2×</option>
            <option value="4" selected>4×</option>
            <option value="8">8×</option>
          </select>
        </label>
        <label class="inline"><input id="rig-chk-bones" type="checkbox" checked> Hiện xương</label>
        <label class="inline"><input id="rig-chk-art" type="checkbox" checked> Hiện ảnh</label>
      </div>
    </div>

    <div id="rig-pose-error-banner" class="banner-error" hidden></div>

    <div class="canvas-container">
      <div class="proposal-image">
        <div class="canvas-wrapper">
          <canvas id="rig-canvas"></canvas>
        </div>
      </div>
    </div>

    <footer class="viewport-footer">
      <span id="rig-footer-status">Sẵn sàng.</span>
    </footer>
  </main>

  <!-- Cột phải: Timeline & Pose Inspector & Chains -->
  <aside class="panel right-panel">
    <div class="section-box">
      <div class="section-title">Timeline & Kế hoạch (Motion Plan)</div>
      <div class="grid-2">
        <label>Hành động
          <select id="rig-plan-action">
            <option value="idle">Nghỉ (idle)</option>
            <option value="walk">Đi bộ (walk)</option>
            <option value="run">Chạy (run)</option>
            <option value="jump">Nhảy (jump)</option>
            <option value="attack">Tấn công (attack)</option>
            <option value="custom">Tùy biến (custom)</option>
          </select>
        </label>
        <div class="row">
          <label class="inline"><input id="rig-plan-loop" type="checkbox"> Lặp</label>
          <label class="inline"><input id="rig-plan-rootmotion" type="checkbox"> Root motion</label>
        </div>
      </div>
      <div class="section-title" style="margin-top:6px;">Danh sách Frame</div>
      <div id="rig-timeline-strip" class="timeline-strip"></div>
      <div class="row">
        <button id="rig-btn-frame-add" type="button">+ Trống (100ms)</button>
        <button id="rig-btn-frame-dup" type="button">Nhân bản</button>
        <button id="rig-btn-frame-left" type="button">◀</button>
        <button id="rig-btn-frame-right" type="button">▶</button>
        <button id="rig-btn-frame-del" class="danger" type="button">Xóa</button>
      </div>
      <label>Thời lượng frame (ms)
        <input id="rig-frame-duration" type="number" min="1" max="60000" step="10">
      </label>
    </div>

    <div class="section-box">
      <div class="section-title">Thông số Frame đang chọn</div>
      <label>Xoay khớp đang chọn (độ)
        <input id="rig-frame-joint-rot" type="range" min="-180" max="180" step="1">
      </label>
      <div class="row"><button id="rig-order-back" type="button">Bộ phận ra sau</button><button id="rig-order-front" type="button">Bộ phận ra trước</button></div>
      <div class="grid-2">
        <label>Độ nhún Root DX <input id="rig-frame-root-dx" type="number" step="0.5"></label>
        <label>Độ nhún Root DY <input id="rig-frame-root-dy" type="number" step="0.5"></label>
      </div>
      <div class="grid-2">
        <label>Travel DX (Root motion) <input id="rig-frame-travel-dx" type="number" step="0.5"></label>
        <label>Travel DY (Root motion) <input id="rig-frame-travel-dy" type="number" step="0.5"></label>
      </div>
    </div>

    <div class="section-box">
      <div class="section-title">Chuỗi chi & Tiếp đất (Chains & IK)</div>
      <label>Chuỗi chi
        <select id="rig-chain-select"></select>
      </label>
      <div class="grid-2">
        <label>Loại chi
          <select id="rig-chain-kind">
            <option value="arm">Tay (arm)</option>
            <option value="leg">Chân (leg)</option>
          </select>
        </label>
        <label>Hướng gập
          <select id="rig-chain-bend">
            <option value="1">Thuận (1)</option>
            <option value="-1">Nghịch (-1)</option>
          </select>
        </label>
      </div>
      <label>Khớp gốc <select id="rig-chain-root"></select></label>
      <label>Khớp giữa <select id="rig-chain-mid"></select></label>
      <label>Khớp cuối <select id="rig-chain-end"></select></label>
      <label>Socket tiếp đất <select id="rig-chain-contact-socket"></select></label>
      <div class="row">
        <button id="rig-btn-save-chain" type="button">Lưu chuỗi chi</button>
        <button id="rig-btn-remove-chain" class="danger" type="button">Xóa chi</button>
      </div>
      <div class="section-title" style="margin-top:6px;">Pha tiếp đất ở frame này</div>
      <label>Pha
        <select id="rig-contact-phase">
          <option value="none">Không tiếp xúc (none)</option>
          <option value="stance">Tiếp đất (stance)</option>
          <option value="swing">Vung chân (swing)</option>
        </select>
      </label>
      <label>Điểm tiếp đất ở frame này<select id="rig-contact-socket"></select></label>
      <div class="grid-2">
        <label>Target X <input id="rig-contact-target-x" type="number" step="1"></label>
        <label>Target Y <input id="rig-contact-target-y" type="number" step="1"></label>
      </div>
      <button id="rig-ik-solve" type="button">Đặt đích cả chuỗi chi (IK)</button>
      <p id="rig-chain-geometry-info" class="hint"></p>
    </div>
    <details class="section-box"><summary>Tạo nhịp đi ngang +X (thử nghiệm)</summary>
      <p class="hint">Thay pose toàn clip, giữ ID và timing. Cần 4–24 frame, hai chân có bộ phận thật. Duyệt pose trước khi hoàn thiện nét pixel.</p>
      <label>Chân A<select id="rig-walk-leg-a"></select></label><label>Chân B<select id="rig-walk-leg-b"></select></label>
      <label>Tay A<select id="rig-walk-arm-a"></select></label><label>Tay B<select id="rig-walk-arm-b"></select></label>
      <div class="grid-2"><label>Độ dài bước (px)<input id="rig-walk-stride" type="number" value="4" min="0.1" step="0.5"></label><label>Nhấc chân (px)<input id="rig-walk-lift" type="number" value="3" min="0" step="0.5"></label></div>
      <div class="grid-2"><label>Hạ hông (px)<input id="rig-walk-crouch" type="number" value="2" min="0" step="0.5"></label><label>Biên độ tay (độ)<input id="rig-walk-swing" type="number" value="15" min="0" max="90"></label></div>
      <label><input id="rig-walk-confirm" type="checkbox">Thay các pose hiện tại bằng nhịp đi thử</label>
      <button id="rig-walk-create" type="button">Dựng nhịp đi thử</button><p id="rig-walk-info" class="hint"></p>
    </details>
  </aside>
</div>
`;

    document.body.append(this.dialog);
    this.bindEvents();
  }

  public get hasGesture(): boolean {
    return this.activeGesture !== undefined;
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.dialog.querySelector('#' + id)! as T;
  }

  private bindEvents(): void {
    this.el('rig-btn-close').onclick = () => this.close();
    this.dialog.addEventListener('cancel', e => {
      e.preventDefault();
      if (this.hasGesture) {
        this.cancelGesture();
        return;
      }
      if (!this.saving) this.close();
    });

    window.addEventListener('blur', () => {
      if (this.hasGesture) this.cancelGesture();
    });

    // Keyboard & Undo/Redo
    this.dialog.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement;
      const isInput = target.closest('input,textarea,select,[contenteditable="true"]');

      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.hasGesture) {
          this.cancelGesture();
          return;
        }
        if (!this.saving) this.close();
        return;
      }

      if (isInput) return;

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          void this.undo(e.shiftKey);
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          void this.undo(true);
        }
      }
    });

    this.el('rig-btn-undo').onclick = () => void this.undo();
    this.el('rig-btn-redo').onclick = () => void this.undo(true);

    // API Source Actions
    this.el('rig-draft-select').onchange = () => {
      const select = this.el<HTMLSelectElement>('rig-draft-select');
      if (select.value) void this.selectDraft(select.value);
    };

    this.el('rig-btn-create-source').onclick = () => void this.createSource().catch(e => this.report(e));
    this.el('rig-btn-refresh-draft').onclick = () => void this.refreshDraft().catch(e => this.report(e));
    this.el('rig-btn-review').onclick = () => void this.startReview().catch(e => this.report(e));

    // Layer / Parts
    this.el('rig-part-select').onchange = () => {
      this.selectedLayerId = this.el<HTMLSelectElement>('rig-part-select').value;
      this.updatePartControls(); this.updateSocketControls();
      this.renderCanvas();
    };

    this.el('rig-part-origin').onchange = () => this.updatePartMetadata();
    this.el('rig-part-pivot-x').onchange = () => this.updatePartMetadata();
    this.el('rig-part-pivot-y').onchange = () => this.updatePartMetadata();

    this.el('rig-btn-split-part').onclick = () => this.splitSelectedPart();
    this.el('rig-btn-new-authored').onclick = () => void this.newAuthoredLayer().catch(e => this.report(e));
    this.el('rig-btn-draw-layer').onclick = () => void this.drawCurrentLayer().catch(e => this.report(e));

    // Joints
    this.el('rig-joint-select').onchange = () => {
      this.selectedJointId = this.el<HTMLSelectElement>('rig-joint-select').value;
      this.updateJointControls(); this.updateFrameInspector();
      this.renderCanvas();
    };

    this.el('rig-joint-parent').onchange = () => this.updateJointFields();
    this.el('rig-joint-rest-x').onchange = () => this.updateJointFields();
    this.el('rig-joint-rest-y').onchange = () => this.updateJointFields();
    this.el('rig-joint-min-rot').onchange = () => this.updateJointFields();
    this.el('rig-joint-max-rot').onchange = () => this.updateJointFields();

    this.el('rig-btn-add-joint').onclick = () => {
      this.addingJoint = !this.addingJoint;
      this.el('rig-btn-add-joint').textContent = this.addingJoint ? 'Hủy thêm khớp' : '+ Thêm khớp (click canvas)';
      this.el('rig-footer-status').textContent = this.addingJoint ? 'Nhấp vào vị trí trên canvas để đặt khớp mới...' : 'Đã hủy thêm khớp.';
    };

    this.el('rig-btn-remove-joint').onclick = () => this.removeJoint();

    // Sockets & Bindings
    this.el('rig-binding-joint').onchange = () => this.updateBinding();
    this.el('rig-binding-socket').onchange = () => { this.selectedSocketId = this.el<HTMLSelectElement>('rig-binding-socket').value; this.updateBinding(); };
    this.el('rig-btn-add-socket').onclick = () => this.addSocketAtPivot();
    this.el('rig-btn-remove-socket').onclick = () => this.removeSocket();

    // Viewport Toolbar
    this.el('rig-mode-rest').onchange = () => {
      this.viewMode = 'rest';
      this.stopPlay();
      this.renderCanvas();
    };
    this.el('rig-mode-pose').onchange = () => {
      this.viewMode = 'pose';
      this.renderCanvas();
    };
    this.el('rig-zoom-select').onchange = () => {
      this.zoom = Number(this.el<HTMLSelectElement>('rig-zoom-select').value);
      this.renderCanvas();
    };
    this.el('rig-chk-bones').onchange = () => { if (!this.el<HTMLInputElement>('rig-chk-bones').checked) this.el<HTMLInputElement>('rig-chk-art').checked = true; this.renderCanvas(); };
    this.el('rig-chk-art').onchange = () => { if (!this.el<HTMLInputElement>('rig-chk-art').checked) this.el<HTMLInputElement>('rig-chk-bones').checked = true; this.renderCanvas(); };
    this.el('rig-btn-play').onclick = () => {
      if (this.playTimer) this.stopPlay();
      else this.startPlay();
    };

    // Timeline & Frame Controls
    this.el('rig-plan-action').onchange = () => this.updatePlanConfigure();
    this.el('rig-plan-loop').onchange = () => this.updatePlanConfigure();
    this.el('rig-plan-rootmotion').onchange = () => this.updatePlanConfigure();

    this.el('rig-btn-frame-add').onclick = () => this.addBlankFrame();
    this.el('rig-btn-frame-dup').onclick = () => this.duplicateFrame();
    this.el('rig-btn-frame-left').onclick = () => this.moveFrame(-1);
    this.el('rig-btn-frame-right').onclick = () => this.moveFrame(1);
    this.el('rig-btn-frame-del').onclick = () => this.deleteFrame();
    this.el('rig-frame-duration').onchange = () => this.updateFrameDuration();

    // Frame Inspector
    this.el('rig-frame-joint-rot').onchange = () => this.updateFrameJointRotation();
    this.el('rig-order-back').onclick = () => this.movePartOrder(-1);
    this.el('rig-order-front').onclick = () => this.movePartOrder(1);
    this.el('rig-ik-solve').onclick = () => this.solveTarget();
    this.el('rig-walk-create').onclick = () => this.createWalk();
    this.el('rig-frame-root-dx').onchange = () => this.updateFrameVectors();
    this.el('rig-frame-root-dy').onchange = () => this.updateFrameVectors();
    this.el('rig-frame-travel-dx').onchange = () => this.updateFrameVectors();
    this.el('rig-frame-travel-dy').onchange = () => this.updateFrameVectors();

    // Chains & IK
    this.el('rig-chain-select').onchange = () => {
      this.selectedChainId = this.el<HTMLSelectElement>('rig-chain-select').value;
      this.updateChainControls();
    };
    this.el('rig-btn-save-chain').onclick = () => this.saveChain();
    this.el('rig-btn-remove-chain').onclick = () => this.removeChain();
    this.el('rig-contact-phase').onchange = () => this.updateContactPhase();
    this.el('rig-contact-socket').onchange = () => this.updateContactPhase();
    this.el('rig-contact-target-x').onchange = () => this.updateContactPhase();
    this.el('rig-contact-target-y').onchange = () => this.updateContactPhase();

    // Canvas pointer interaction
    const canvas = this.el<HTMLCanvasElement>('rig-canvas');
    canvas.addEventListener('pointerdown', e => this.onCanvasPointerDown(e));
    canvas.addEventListener('pointermove', e => this.onCanvasPointerMove(e));
    canvas.addEventListener('pointerup', e => this.onCanvasPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelGesture());
  }

  public async open(draftId?: string): Promise<void> {
    if (this.dialog.open) return;
    await this.options.prepare();
    const doc = this.options.session.doc;
    if (!doc) throw Error('Mở dự án trước khi dựng rig.');
    this.projectId = doc.id; this.ticket++; this.loading = false; this.stopPlay();
    this.selectionMask = undefined; this.activeGesture = undefined; this.addingJoint = false;
    this.el('rig-error').hidden = true;
    const drafts = Object.values(doc.studio?.rigDrafts ?? {});
    const selected = drafts.find(d => d.id === draftId) ?? drafts.find(d => d.rig.source.assetId === this.options.session.assetId || d.origin.assetId === this.options.session.assetId) ?? drafts[0];
    this.populateDraftSelect(selected?.id); this.dialog.showModal();
    if (selected) await this.selectDraft(selected.id);
    else { this.draft = undefined; this.currentDraftId = ''; this.cachedResources = undefined; this.renderUI(); }
    this.updateGate();
  }

  public close(): void {
    if (this.saving) return;
    this.ticket++;
    this.stopPlay();
    this.cancelGesture();
    this.dialog.close(); this.loading = false; this.cachedResources = undefined; this.compiled = undefined; this.restPixels = undefined;
    this.sourcePixels = undefined; this.movementMask = undefined; this.frozenFrames.clear();
  }

  public resetProject(): void {
    if (!this.saving) {
      this.close();
      this.draft = undefined;
      this.currentDraftId = '';
      this.cachedResources = undefined;
      this.compiled = undefined;
    }
  }

  public updateGate(): void {
    const session = this.options.session, canMutate = !this.saving && !this.loading && !session.conflict && session.doc?.id === this.projectId;
    const status = this.el('rig-status-badge');
    status.textContent = session.conflict ? 'Xung đột revision' : this.loading ? 'Đang nạp nguồn…' : this.needsRefresh ? 'Cần làm mới nguồn' : 'Bản nháp chưa duyệt';
    status.className = 'badge ' + (session.conflict ? 'error' : this.needsRefresh ? 'warning' : 'active');
    for (const element of this.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) element.disabled = !canMutate || !this.draft;
    this.el<HTMLButtonElement>('rig-btn-create-source').disabled = !canMutate;
    this.el<HTMLButtonElement>('rig-btn-close').disabled = this.saving;
    this.el<HTMLButtonElement>('rig-btn-review').disabled = !canMutate || session.dirty || !this.draft || this.needsRefresh || !!this.poseError;
    for (const id of ['rig-btn-undo', 'rig-btn-redo']) this.el<HTMLButtonElement>(id).disabled = !canMutate || this.hasGesture;
    if (session.conflict) this.stopPlay();
  }

  private canEdit(): boolean { return !!this.draft && !this.saving && !this.loading && !this.options.session.conflict && this.options.session.doc?.id === this.projectId; }
  private get motion() { const { recipe, rig, plan } = this.draft!; return { recipe, rig, plan }; }
  private live(ticket: number, doc: PixelDocument, draft?: RigDraft): boolean {
    return ticket === this.ticket && this.dialog.open && this.options.session.doc === doc && !this.options.session.conflict && (!draft || this.draft === draft);
  }
  private report(error: unknown): void {
    if (!this.dialog.open || this.options.session.doc?.id !== this.projectId) return;
    const box = this.el('rig-error'); box.hidden = false; box.textContent = error instanceof Error ? error.message : String(error);
    this.options.onError(error); this.updateGate();
  }
  private async undo(redo = false): Promise<void> {
    if (!this.canEdit() && (this.saving || this.loading || this.options.session.conflict)) return;
    try {
      await this.options.session.undo(redo);
      const drafts = this.options.session.doc?.studio?.rigDrafts ?? {}, id = drafts[this.currentDraftId] ? this.currentDraftId : Object.keys(drafts)[0];
      this.populateDraftSelect(id);
      if (id) await this.selectDraft(id);
      else { this.draft = undefined; this.cachedResources = undefined; this.renderUI(); }
    } catch (e) { this.report(e); }
  }
  private visibleLayers(asset: PixelAsset): PixelLayer[] {
    const result: PixelLayer[] = [];
    const visit = (parent?: string) => {
      for (const l of asset.layers) if ((l.parent ?? undefined) === parent && l.visible) {
        if (l.opacity !== 255) throw Error('Layer/nhóm nguồn phải có độ đục 255; chuẩn hóa bản sao trước.');
        if (l.type === 'group') visit(l.id); else result.push(l);
      }
    };
    visit(); return result;
  }

  private async selectDraft(id: string): Promise<void> {
    if (this.saving || this.activeGesture) return;
    const doc = this.options.session.doc, stored = doc?.studio?.rigDrafts?.[id];
    if (!doc || !stored) return;
    const switched = this.currentDraftId !== id, ticket = ++this.ticket;
    this.currentDraftId = id; const draft = this.draft = structuredClone(stored);
    this.loading = true; this.updateGate();
    try {
      const asset = doc.assets.find(a => a.id === draft.rig.source.assetId);
      if (!asset?.frames.some(f => f.id === draft.rig.source.frameId)) throw Error('Nguồn rig đã bị xóa. Giữ nháp này và tạo nguồn mới.');
      await this.options.navigate(draft.rig.source.assetId, draft.rig.source.frameId);
      if (!this.live(ticket, doc, draft)) return;
      await this.loadResources(); if (!this.live(ticket, doc, draft)) return;
      await this.checkSourceRefresh(); if (!this.live(ticket, doc, draft)) return;
      if (switched || !draft.recipe.parts.some(p => p.id === this.selectedLayerId)) this.selectedLayerId = draft.recipe.parts[0]?.id ?? '';
      if (switched || !draft.rig.joints.some(j => j.id === this.selectedJointId)) this.selectedJointId = draft.rig.joints[0]?.id ?? '';
      if (switched || !draft.rig.sockets.some(j => j.id === this.selectedSocketId)) this.selectedSocketId = draft.rig.sockets[0]?.id ?? '';
      if (switched || !draft.rig.chains.some(j => j.id === this.selectedChainId)) this.selectedChainId = draft.rig.chains[0]?.id ?? '';
      if (switched || !draft.plan.frames.some(j => j.id === this.selectedFrameId)) this.selectedFrameId = draft.plan.frames[0]?.id ?? '';
      this.el<HTMLSelectElement>('rig-draft-select').value = id; this.renderUI();
    } catch (e) { if (this.live(ticket, doc, draft)) { this.needsRefresh = true; this.poseError = 'Nguồn chưa nạp được'; this.cachedResources = undefined; this.report(e); } }
    finally { if (ticket === this.ticket) { this.loading = false; this.updateGate(); } }
  }

  private populateDraftSelect(selectedId?: string): void {
    const select = this.el<HTMLSelectElement>('rig-draft-select');
    select.replaceChildren();
    const drafts = this.options.session.doc?.studio?.rigDrafts ?? {};
    for (const d of Object.values(drafts)) {
      select.append(option(d.id, `${d.name} (${d.recipe.parts.length} bộ phận · ${d.plan.frames.length} frame)`));
    }
    if (selectedId) select.value = selectedId;
  }

  private async loadResources(): Promise<void> {
    if (!this.draft) return;
    const session = this.options.session, doc = session.doc!, draft = this.draft, ticket = this.ticket;
    const sources = await Promise.all(
      this.draft.resources.sources.map(async b => {
        const r = await session.loadResource(b.resourceId);
        if (!r?.data || r.kind !== 'rgba') throw new Error(`Thiếu tài nguyên rgba: ${b.resourceId}`);
        return { id: b.id, w: r.w, h: r.h, pixels: r.data.slice() };
      })
    );
    const masks = await Promise.all(
      this.draft.resources.masks.map(async b => {
        const r = await session.loadResource(b.resourceId);
        if (!r?.data || r.kind !== 'mask') throw new Error(`Thiếu tài nguyên mask: ${b.resourceId}`);
        return { id: b.id, w: r.w, h: r.h, data: Uint8Array.from(r.data) };
      })
    );
    const asset = doc.assets.find(a => a.id === draft.rig.source.assetId);
    if (!asset) throw Error('Nguồn rig đã bị xóa.');
    const source = await session.readFrame(draft.rig.source.frameId, asset);
    const frozen = new Map<string, Uint32Array>();
    for (const frame of draft.frozenFrames) frozen.set(frame.frameId, await session.readFrame(frame.sourceFrameId, asset));
    let movementMask: Uint8Array | undefined;
    if (draft.movementMaskResourceId) {
      const r = await session.loadResource(draft.movementMaskResourceId);
      if (!r?.data || r.kind !== 'mask' || r.w !== asset.w || r.h !== asset.h || r.data.some(v => v !== 0 && v !== 1)) throw Error('Mask chuyển động thiếu hoặc không khớp nguồn.');
      movementMask = Uint8Array.from(r.data);
    }
    if (this.live(ticket, doc, draft)) { this.cachedResources = { sources, masks }; this.sourcePixels = source; this.movementMask = movementMask; this.frozenFrames = frozen; }
  }

  private async checkSourceRefresh(): Promise<void> {
    const draft = this.draft, doc = this.options.session.doc, ticket = this.ticket;
    if (!draft || !doc) return;
    let reason = '';
    const asset = doc.assets.find(a => a.id === draft.rig.source.assetId);
    try {
      if (!asset?.frames.some(f => f.id === draft.rig.source.frameId)) throw Error('Không tìm thấy asset/frame nguồn.');
      if (asset.w !== draft.recipe.canvas.w || asset.h !== draft.recipe.canvas.h) throw Error('Kích thước canvas nguồn đã đổi; tạo nháp mới.');
      const palette = [...new Set(asset.palette.filter(c => (c & 255) === 255))], pivot = asset.metadata.pivot ?? { x: .5, y: 1 };
      if (JSON.stringify(palette) !== JSON.stringify(draft.recipe.palette) || pivot.x * asset.w !== draft.recipe.pivot.x || pivot.y * asset.h !== draft.recipe.pivot.y) throw Error('Palette hoặc điểm neo nguồn đã đổi.');
      const layers = this.visibleLayers(asset);
      if (layers.length !== draft.recipe.parts.length || layers.some((l, i) => l.id !== draft.recipe.parts[i].id || l.name !== draft.recipe.parts[i].name)) throw Error('ID, thứ tự hoặc tên layer đã đổi.');
      await this.options.session.loadFrame(draft.rig.source.frameId, asset);
      if (!this.live(ticket, doc, draft)) return;
      if (!this.cachedResources) throw Error('Thiếu snapshot nguồn.');
      for (const part of draft.recipe.parts) {
        const isolated = { ...draft.recipe, parts: draft.recipe.parts.map(p => ({ ...p, paint: p.id === part.id ? p.paint : [] })) };
        const snapshot = createRecipeRenderer(isolated, this.cachedResources).renderFrame(draft.recipe.frames[0].id).image.data;
        const pixels = celFor(asset, part.id, draft.rig.source.frameId)?.data;
        if (snapshot.some((c, i) => c !== (pixels?.[i] ?? 0))) throw Error('Pixel bộ phận đã đổi: ' + part.name);
      }
    } catch (e) { reason = (e as Error).message; }
    if (!this.live(ticket, doc, draft)) return;
    this.needsRefresh = !!reason; this.refreshReason = reason; this.showRefreshWarning();
  }

  private showRefreshWarning(): void {
    const banner = this.el('rig-refresh-warning');
    if (this.needsRefresh) {
      banner.hidden = false;
      banner.textContent = `⚠️ Nguồn cần làm mới: ${this.refreshReason}. Bấm "Làm mới nguồn" để cập nhật.`;
    } else {
      banner.hidden = true;
    }
    this.updateGate();
  }

  private async createSource(): Promise<void> { await this.commitSource(false); }
  private async refreshDraft(): Promise<void> { await this.commitSource(true); }
  private async commitSource(refresh: boolean): Promise<void> {
    if (this.saving || this.loading || this.options.session.conflict || (refresh && !this.draft)) return;
    const ticket = ++this.ticket, project = this.projectId;
    this.saving = true; this.options.projectLock(true); this.updateGate();
    try {
      await this.options.prepare();
      const session = this.options.session, doc = session.doc;
      if (!doc || doc.id !== project || !this.live(ticket, doc)) return;
      const asset = refresh ? doc.assets.find(a => a.id === this.draft!.rig.source.assetId) : session.asset;
      if (!asset) throw Error('Không tìm thấy asset nguồn.');
      const revision = doc.revision, draft = this.draft;
      const path = `projects/${doc.id}/rig-drafts` + (refresh ? `/${draft!.id}/refresh` : '');
      const parts = refresh ? this.visibleLayers(asset).map(l => {
        const old = draft!.recipe.parts.find(p => p.id === l.id);
        return { layerId: l.id, origin: old?.origin ?? 'authored', pivot: old?.pivot ?? { x: asset.w / 2, y: asset.h / 2 } };
      }) : undefined;
      const result = await this.options.writeRevision(path, refresh ? { revision, parts } : { revision, assetId: asset.id, frameId: session.frameId });
      if (!this.live(ticket, doc) || doc.revision !== revision || session.dirty) throw Error('Dự án đã đổi; giữ nháp và tải lại nguồn mới.');
      await this.options.onSaved(result.document, result.assetId, result.draft.rig.source.frameId, refresh ? 'Làm mới nguồn rig' : 'Tạo nguồn rig');
      this.saving = false; this.populateDraftSelect(result.draft.id); await this.selectDraft(result.draft.id);
    } catch (e) { this.report(e); }
    finally { this.saving = false; this.options.projectLock(false); this.updateGate(); }
  }

  private async startReview(): Promise<void> {
    if (!this.draft || this.needsRefresh || this.poseError || this.saving) return;
    await this.options.prepare();
    const currentDraft = structuredClone(this.draft);
    this.close();
    await this.options.onReview(currentDraft);
  }

  private splitSelectedPart(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedLayerId) return;
    const doc = this.options.session.doc;
    const workingAsset = doc?.assets.find(a => a.id === this.draft!.rig.source.assetId);
    if (!workingAsset) return;

    if (!this.selectionMask) {
      this.report(new Error('Kéo chọn một vùng hình chữ nhật trên canvas trước khi tách.'));
      return;
    }

    const workingFrameId = this.draft.rig.source.frameId;
    const partName = prompt('Nhập tên cho bộ phận mới:', 'Bộ phận tách'); if (partName === null) return;

    try {
      this.options.session.change('Tách bộ phận rig', () => {
        const { asset: nextAsset, layer: newPartLayer, pivot } = splitRigPart(
          workingAsset,
          workingFrameId,
          this.selectedLayerId,
          this.selectionMask!,
          partName
        );

        const assetIdx = this.options.session.doc!.assets.findIndex(a => a.id === nextAsset.id);
        this.options.session.doc!.assets[assetIdx] = nextAsset;

        const updatedDraft = addRigLayer(this.draft!, newPartLayer, pivot, 'visible');
        this.options.session.doc!.studio!.rigDrafts![this.draft!.id] = updatedDraft;
        this.draft = updatedDraft;
      });

      this.selectionMask = undefined;
      this.needsRefresh = true;
      this.refreshReason = 'Đã tách bộ phận mới; cần bấm "Làm mới nguồn" để tạo tài nguyên điểm ảnh.';
      this.showRefreshWarning();
      this.renderUI();
    } catch (err) {
      const stored = this.options.session.doc?.studio?.rigDrafts?.[this.currentDraftId];
      if (stored) this.draft = structuredClone(stored);
      this.report(err);
    }
  }

  private async newAuthoredLayer(): Promise<void> {
    if (!this.canEdit()) return;
    if (!this.draft) return;
    const doc = this.options.session.doc;
    const workingAsset = doc?.assets.find(a => a.id === this.draft!.rig.source.assetId);
    if (!workingAsset) return;

    const layerName = prompt('Nhập tên cho layer vẽ bù mới:', 'Vẽ bù'); if (layerName === null) return;
    let newLayerId = '';
    const workingFrameId = this.draft.rig.source.frameId;

    try {
      this.options.session.change('Thêm layer vẽ bù', () => {
        const targetLayer = workingAsset.layers.find(l => l.id === this.selectedLayerId);
        const layer = newLayer(layerName, 'image', targetLayer?.parent);
        newLayerId = layer.id;
        const insertIdx = targetLayer ? workingAsset.layers.indexOf(targetLayer) + 1 : workingAsset.layers.length;
        workingAsset.layers.splice(insertIdx, 0, layer);
        celFor(workingAsset, layer.id, workingFrameId, true);

        const pivot = { x: Math.round(workingAsset.w / 2), y: Math.round(workingAsset.h / 2) };
        const updatedDraft = addRigLayer(this.draft!, layer, pivot, 'authored');
        this.options.session.doc!.studio!.rigDrafts![this.draft!.id] = updatedDraft;
        this.draft = updatedDraft;
      });

      this.close();
      await this.options.onDrawLayer(workingAsset.id, workingFrameId, newLayerId);
    } catch (err) {
      const stored = this.options.session.doc?.studio?.rigDrafts?.[this.currentDraftId];
      if (stored) this.draft = structuredClone(stored);
      this.report(err);
    }
  }

  private async drawCurrentLayer(): Promise<void> {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedLayerId) return;
    const workingAssetId = this.draft.rig.source.assetId;
    const workingFrameId = this.draft.rig.source.frameId;
    this.close();
    await this.options.onDrawLayer(workingAssetId, workingFrameId, this.selectedLayerId);
  }

  private commitDraft(label: string, candidate: RigDraft): void {
    if (!this.canEdit()) return;
    try {
      const next = validateRigDraft(candidate, this.options.session.doc!.studio?.resources ?? {});
      this.options.session.change(label, () => { this.options.session.doc!.studio!.rigDrafts![next.id] = next; });
      this.draft = structuredClone(next); this.el('rig-error').hidden = true; this.renderUI();
    } catch (e) { this.report(e); }
  }
  private updatePartMetadata(): void {
    if (!this.canEdit() || !this.draft) return;
    const draft = structuredClone(this.draft), part = draft.recipe.parts.find(p => p.id === this.selectedLayerId);
    if (!part) return;
    part.origin = this.el<HTMLSelectElement>('rig-part-origin').value as 'visible' | 'authored' | 'derived';
    part.pivot = { x: Number(this.el<HTMLInputElement>('rig-part-pivot-x').value), y: Number(this.el<HTMLInputElement>('rig-part-pivot-y').value) };
    const binding = draft.rig.bindings.find(b => b.partId === part.id), socket = draft.rig.sockets.find(s => s.id === binding?.socketId);
    if (socket) {
      socket.rest = { ...part.pivot };
      for (const b of draft.rig.bindings.filter(b => b.socketId === socket.id)) draft.recipe.parts.find(p => p.id === b.partId)!.pivot = { ...part.pivot };
    }
    this.commitDraft('Cập nhật thông số bộ phận', draft);
  }
  private applyCommands(label: string, commands: MotionEditCommand[]): void {
    if (!this.canEdit() || !this.draft) return;
    this.stopPlay();
    try {
      const next = applyMotionEdits(this.motion, commands, rigDraftContext(this.draft, this.options.session.doc!.studio?.resources ?? {}));
      this.commitDraft(label, { ...this.draft, ...next });
    } catch (e) { this.report(e); }
  }
  private movePartOrder(delta: number): void {
    const f = this.draft?.plan.frames.find(f => f.id === this.selectedFrameId); if (!f) return;
    const frame = structuredClone(f), index = frame.order.indexOf(this.selectedLayerId), to = index + delta;
    if (index < 0 || to < 0 || to >= frame.order.length) return;
    [frame.order[index], frame.order[to]] = [frame.order[to], frame.order[index]];
    this.applyCommands('Thứ tự che khuất ở frame', [{ type: 'frame.set', frame }]);
  }
  private solveTarget(): void {
    if (!this.canEdit() || !this.draft) return;
    try {
      const target = { x: Number(this.el<HTMLInputElement>('rig-contact-target-x').value), y: Number(this.el<HTMLInputElement>('rig-contact-target-y').value) };
      const next = solveMotionTarget(this.motion, this.selectedFrameId, this.selectedChainId, target, rigDraftContext(this.draft, this.options.session.doc!.studio?.resources ?? {}));
      this.commitDraft('Đặt đích cả chuỗi chi', { ...this.draft, ...next });
    } catch (e) { this.report(e); }
  }
  private createWalk(): void {
    if (!this.canEdit() || !this.draft) return;
    if (!this.el<HTMLInputElement>('rig-walk-confirm').checked) { this.report(Error('Xác nhận thay pose của clip trước khi dựng nhịp đi thử.')); return; }
    if (this.draft.frozenFrames.length) { this.report(Error('Clip có frame khóa; tạo bản nháp riêng để thử nhịp đi.')); return; }
    try {
      const number = (id: string) => Number(this.el<HTMLInputElement>(id).value), select = (id: string) => this.el<HTMLSelectElement>(id).value;
      const next = createWalkPlan(this.motion, { legIds: [select('rig-walk-leg-a'), select('rig-walk-leg-b')], armIds: [select('rig-walk-arm-a'), select('rig-walk-arm-b')].filter(Boolean), stridePx: number('rig-walk-stride'), liftPx: number('rig-walk-lift'), crouchPx: number('rig-walk-crouch'), armSwingDegrees: number('rig-walk-swing'), rootMotion: this.draft.plan.rootMotion }, rigDraftContext(this.draft, this.options.session.doc!.studio?.resources ?? {}));
      this.commitDraft('Dựng nhịp đi thử', { ...this.draft, ...next }); this.el<HTMLInputElement>('rig-walk-confirm').checked = false;
      this.viewMode = 'pose'; this.el<HTMLInputElement>('rig-mode-pose').checked = true; this.renderCanvas();
      const duration = next.plan.frames.reduce((n, f) => n + f.durationMs, 0);
      this.el('rig-walk-info').textContent = `Chu kỳ ${duration} ms · tốc độ bước ${(2 * number('rig-walk-stride') * 1000 / duration).toFixed(2)} px/s. Kiểm tra nét khớp nối trên từng frame.`;
    } catch (e) { this.report(e); }
  }

  private updateJointFields(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedJointId) return;
    const joint = this.draft.rig.joints.find(j => j.id === this.selectedJointId);
    if (!joint) return;

    const parentVal = this.el<HTMLSelectElement>('rig-joint-parent').value;
    const nextJoint: MotionJoint = {
      id: joint.id,
      parentId: parentVal === '' ? null : parentVal,
      rest: {
        x: Number(this.el<HTMLInputElement>('rig-joint-rest-x').value),
        y: Number(this.el<HTMLInputElement>('rig-joint-rest-y').value),
      },
      minRotation: Number(this.el<HTMLInputElement>('rig-joint-min-rot').value),
      maxRotation: Number(this.el<HTMLInputElement>('rig-joint-max-rot').value),
    };

    this.applyCommands('Cập nhật khớp', [{ type: 'joint.update', joint: nextJoint }]);
  }

  private removeJoint(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedJointId) return;
    this.applyCommands('Xóa khớp', [{ type: 'joint.remove', id: this.selectedJointId }]);
    this.selectedJointId = this.draft.rig.joints[0]?.id ?? '';
    this.renderUI();
  }

  private updateBinding(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedLayerId) return;
    const jointId = this.el<HTMLSelectElement>('rig-binding-joint').value;
    const socketVal = this.el<HTMLSelectElement>('rig-binding-socket').value;
    const socketId = socketVal === '' ? null : socketVal;

    const binding: MotionPartBinding = {
      partId: this.selectedLayerId,
      jointId,
      socketId,
    };
    this.applyCommands('Gắn bộ phận vào khớp', [{ type: 'binding.set', binding }]);
  }

  private addSocketAtPivot(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedLayerId || !this.selectedJointId) return;
    const part = this.draft.recipe.parts.find(p => p.id === this.selectedLayerId);
    if (!part) return;

    const newSocketId = 'socket_' + uid();
    const socket: MotionSocket = {
      id: newSocketId,
      jointId: this.selectedJointId,
      rest: { ...part.pivot },
    };

    this.applyCommands('Thêm socket', [{ type: 'socket.set', socket }]);
    this.selectedSocketId = newSocketId;
  }

  private removeSocket(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedSocketId) return;
    this.applyCommands('Xóa socket', [{ type: 'socket.remove', id: this.selectedSocketId }]);
    this.selectedSocketId = this.draft.rig.sockets[0]?.id ?? '';
  }

  private updatePlanConfigure(): void {
    if (!this.canEdit()) return;
    if (!this.draft) return;
    const action = this.el<HTMLSelectElement>('rig-plan-action').value as any;
    const loop = this.el<HTMLInputElement>('rig-plan-loop').checked;
    const rootMotion = this.el<HTMLInputElement>('rig-plan-rootmotion').checked;

    this.applyCommands('Cấu hình kế hoạch', [
      {
        type: 'plan.configure',
        action,
        loop,
        rootMotion,
      },
    ]);
  }

  private addBlankFrame(): void {
    if (!this.canEdit()) return;
    if (!this.draft) return;
    const newId = uid();
    this.applyCommands('Thêm frame trống', [
      {
        type: 'frame.add',
        id: newId,
        afterId: this.selectedFrameId || null,
        copyFrom: null,
        durationMs: 100,
      },
    ]);
    this.selectedFrameId = newId;
    this.renderUI();
  }

  private duplicateFrame(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId) return;
    const cur = this.draft.plan.frames.find(f => f.id === this.selectedFrameId);
    if (!cur) return;
    const newId = uid();
    this.applyCommands('Nhân bản frame', [
      {
        type: 'frame.add',
        id: newId,
        afterId: cur.id,
        copyFrom: cur.id,
        durationMs: cur.durationMs,
      },
    ]);
    this.selectedFrameId = newId;
    this.renderUI();
  }

  private moveFrame(delta: -1 | 1): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId) return;
    const frames = this.draft.plan.frames;
    const idx = frames.findIndex(f => f.id === this.selectedFrameId);
    if (idx === -1) return;

    if (delta === -1 && idx > 0) {
      const afterId = idx === 1 ? null : frames[idx - 2].id;
      this.applyCommands('Di chuyển frame', [{ type: 'frame.move', id: this.selectedFrameId, afterId }]);
    } else if (delta === 1 && idx < frames.length - 1) {
      const afterId = frames[idx + 1].id;
      this.applyCommands('Di chuyển frame', [{ type: 'frame.move', id: this.selectedFrameId, afterId }]);
    }
  }

  private deleteFrame(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId) return;
    if (this.draft.plan.frames.length <= 1) {
      this.report(new Error('Kế hoạch chuyển động cần giữ lại ít nhất 1 frame.'));
      return;
    }
    const frames = this.draft.plan.frames;
    const idx = frames.findIndex(f => f.id === this.selectedFrameId);
    const nextSelect = idx > 0 ? frames[idx - 1].id : frames[1]?.id;

    this.applyCommands('Xóa frame', [{ type: 'frame.remove', id: this.selectedFrameId }]);
    this.selectedFrameId = nextSelect;
    this.renderUI();
  }

  private updateFrameDuration(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId) return;
    const cur = this.draft.plan.frames.find(f => f.id === this.selectedFrameId);
    if (!cur) return;
    const durationMs = Math.max(1, Number(this.el<HTMLInputElement>('rig-frame-duration').value));
    this.applyCommands('Đổi thời lượng frame', [
      {
        type: 'frame.set',
        frame: { ...cur, durationMs },
      },
    ]);
  }

  private updateFrameJointRotation(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId || !this.selectedJointId) return;
    const cur = this.draft.plan.frames.find(f => f.id === this.selectedFrameId);
    if (!cur) return;

    const degrees = Number(this.el<HTMLInputElement>('rig-frame-joint-rot').value);
    const rotations = cur.rotations.filter(r => r.jointId !== this.selectedJointId);
    if (degrees !== 0) {
      rotations.push({ jointId: this.selectedJointId, degrees });
    }

    this.applyCommands('Chỉnh góc khớp frame', [
      {
        type: 'frame.set',
        frame: { ...cur, rotations },
      },
    ]);
  }

  private updateFrameVectors(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId) return;
    const cur = this.draft.plan.frames.find(f => f.id === this.selectedFrameId);
    if (!cur) return;

    const rootDx = Number(this.el<HTMLInputElement>('rig-frame-root-dx').value);
    const rootDy = Number(this.el<HTMLInputElement>('rig-frame-root-dy').value);
    const travelDx = Number(this.el<HTMLInputElement>('rig-frame-travel-dx').value);
    const travelDy = Number(this.el<HTMLInputElement>('rig-frame-travel-dy').value);

    this.applyCommands('Chỉnh vector vị trí frame', [
      {
        type: 'frame.set',
        frame: {
          ...cur,
          root: { dx: rootDx, dy: rootDy },
          travel: { dx: travelDx, dy: travelDy },
        },
      },
    ]);
  }

  private saveChain(): void {
    if (!this.canEdit()) return;
    if (!this.draft) return;
    const kind = this.el<HTMLSelectElement>('rig-chain-kind').value as 'arm' | 'leg';
    const bend = Number(this.el<HTMLSelectElement>('rig-chain-bend').value) as 1 | -1;
    const rootJointId = this.el<HTMLSelectElement>('rig-chain-root').value;
    const midJointId = this.el<HTMLSelectElement>('rig-chain-mid').value;
    const endJointId = this.el<HTMLSelectElement>('rig-chain-end').value;
    const socketVal = this.el<HTMLSelectElement>('rig-chain-contact-socket').value;
    const contactSocketId = socketVal === '' ? null : socketVal;

    const chainId = this.selectedChainId || 'chain_' + uid();
    const chain: MotionChain = {
      id: chainId,
      kind,
      bend,
      rootJointId,
      midJointId,
      endJointId,
      contactSocketId,
    };

    this.applyCommands('Lưu chuỗi chi', [{ type: 'chain.set', chain }]);
    this.selectedChainId = chainId;
    this.renderUI();
  }

  private removeChain(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedChainId) return;
    this.applyCommands('Xóa chuỗi chi', [{ type: 'chain.remove', id: this.selectedChainId }]);
    this.selectedChainId = this.draft.rig.chains[0]?.id ?? '';
    this.renderUI();
  }

  private updateContactPhase(): void {
    if (!this.canEdit()) return;
    if (!this.draft || !this.selectedFrameId || !this.selectedChainId) return;
    const cur = this.draft.plan.frames.find(f => f.id === this.selectedFrameId);
    if (!cur) return;

    const phase = this.el<HTMLSelectElement>('rig-contact-phase').value;
    const tx = Number(this.el<HTMLInputElement>('rig-contact-target-x').value);
    const ty = Number(this.el<HTMLInputElement>('rig-contact-target-y').value);
    const selectedSocket = this.el<HTMLSelectElement>('rig-contact-socket').value;
    const override = selectedSocket === '' ? {} : { contactSocketId: selectedSocket === '@joint' ? null : selectedSocket };

    let contacts = cur.contacts.filter(c => c.chainId !== this.selectedChainId);
    if (phase === 'stance') {
      contacts.push({ chainId: this.selectedChainId, phase: 'stance', target: { x: tx, y: ty }, ...override });
    } else if (phase === 'swing') {
      contacts.push({ chainId: this.selectedChainId, phase: 'swing', target: null, ...override });
    }

    this.applyCommands('Cập nhật pha tiếp đất', [
      {
        type: 'frame.set',
        frame: { ...cur, contacts },
      },
    ]);
  }

  // --- Rendering UI & Controls ---

  private renderUI(): void {
    if (this.draft && !this.draft.plan.frames.some(f => f.id === this.selectedFrameId)) this.selectedFrameId = this.draft.plan.frames[0]?.id ?? '';
    this.updatePartControls();
    this.updateJointControls();
    this.updateSocketControls();
    this.updateTimelineStrip();
    this.updateFrameInspector();
    this.updateChainControls();
    for (const [ids, kind] of [[['rig-walk-leg-a', 'rig-walk-leg-b'], 'leg'], [['rig-walk-arm-a', 'rig-walk-arm-b'], 'arm']] as const) {
      const chains = this.draft?.rig.chains.filter(c => c.kind === kind) ?? [];
      for (let i = 0; i < ids.length; i++) {
        const select = this.el<HTMLSelectElement>(ids[i]), old = select.value;
        select.replaceChildren(...(kind === 'arm' ? [option('', 'Không dùng')] : []), ...chains.map((c, n) => option(c.id, `${kind === 'leg' ? 'Chân' : 'Tay'} ${n + 1}`)));
        select.value = chains.some(c => c.id === old) ? old : kind === 'arm' ? '' : chains[i]?.id ?? '';
      }
    }
    this.renderCanvas();
    this.updateGate();
  }

  private updatePartControls(): void {
    const draft = this.draft;
    const select = this.el<HTMLSelectElement>('rig-part-select');
    select.replaceChildren();
    if (!draft) return;

    for (const p of draft.recipe.parts) {
      select.append(option(p.id, `${p.name} (${p.origin})`));
    }
    if (this.selectedLayerId && draft.recipe.parts.some(p => p.id === this.selectedLayerId)) {
      select.value = this.selectedLayerId;
    } else {
      this.selectedLayerId = draft.recipe.parts[0]?.id ?? '';
      select.value = this.selectedLayerId;
    }

    const currentPart = draft.recipe.parts.find(p => p.id === this.selectedLayerId);
    const active = document.activeElement;

    if (currentPart) {
      this.el<HTMLSelectElement>('rig-part-origin').value = currentPart.origin;
      if (active !== this.el('rig-part-pivot-x')) this.el<HTMLInputElement>('rig-part-pivot-x').value = String(currentPart.pivot.x);
      if (active !== this.el('rig-part-pivot-y')) this.el<HTMLInputElement>('rig-part-pivot-y').value = String(currentPart.pivot.y);
    }

    // Check layer status
    const workingAsset = this.options.session.doc?.assets.find(a => a.id === draft.rig.source.assetId);
    const layer = workingAsset?.layers.find(l => l.id === this.selectedLayerId);
    const statusEl = this.el('rig-layer-status');
    if (!layer) {
      statusEl.textContent = 'Trạng thái: Không tìm thấy layer tương ứng trong asset.';
      statusEl.style.color = '#ff9999';
    } else if (layer.type !== 'image' || isLocked(workingAsset!, layer) || !layer.visible || layer.opacity < 255) {
      statusEl.textContent = `Trạng thái: ${layer.type !== 'image' ? 'Nhóm layer' : isLocked(workingAsset!, layer) ? 'Bị khóa' : !layer.visible ? 'Đang ẩn' : 'Độ đục < 255'}. Không thể tách.`;
      statusEl.style.color = '#ffcc66';
    } else {
      statusEl.textContent = `Layer ảnh: ${layer.name} · ${workingAsset!.w}×${workingAsset!.h} · Hợp lệ.`;
      statusEl.style.color = '#7de8a3';
    }
  }

  private updateJointControls(): void {
    const draft = this.draft;
    const select = this.el<HTMLSelectElement>('rig-joint-select');
    const parentSelect = this.el<HTMLSelectElement>('rig-joint-parent');
    select.replaceChildren();
    parentSelect.replaceChildren(option('', '(Không có - Khớp gốc)'));
    if (!draft) return;

    for (let i = 0; i < draft.rig.joints.length; i++) {
      const j = draft.rig.joints[i];
      const boundPart = draft.recipe.parts.find(p => draft.rig.bindings.some(b => b.jointId === j.id && b.partId === p.id));
      const label = boundPart ? `${boundPart.name} (Khớp ${i + 1})` : `Khớp ${i + 1}`;
      select.append(option(j.id, label));
      parentSelect.append(option(j.id, label));
    }

    if (this.selectedJointId && draft.rig.joints.some(j => j.id === this.selectedJointId)) {
      select.value = this.selectedJointId;
    } else {
      this.selectedJointId = draft.rig.joints[0]?.id ?? '';
      select.value = this.selectedJointId;
    }

    const cur = draft.rig.joints.find(j => j.id === this.selectedJointId);
    const active = document.activeElement;
    if (cur) {
      parentSelect.value = cur.parentId ?? '';
      if (active !== this.el('rig-joint-rest-x')) this.el<HTMLInputElement>('rig-joint-rest-x').value = String(cur.rest.x);
      if (active !== this.el('rig-joint-rest-y')) this.el<HTMLInputElement>('rig-joint-rest-y').value = String(cur.rest.y);
      if (active !== this.el('rig-joint-min-rot')) this.el<HTMLInputElement>('rig-joint-min-rot').value = String(cur.minRotation);
      if (active !== this.el('rig-joint-max-rot')) this.el<HTMLInputElement>('rig-joint-max-rot').value = String(cur.maxRotation);
    }
  }

  private updateSocketControls(): void {
    const draft = this.draft;
    const jointSelect = this.el<HTMLSelectElement>('rig-binding-joint');
    const socketSelect = this.el<HTMLSelectElement>('rig-binding-socket');
    jointSelect.replaceChildren();
    socketSelect.replaceChildren(option('', '(Không dùng socket)'));
    if (!draft) return;

    for (let i = 0; i < draft.rig.joints.length; i++) {
      const j = draft.rig.joints[i];
      jointSelect.append(option(j.id, `Khớp ${i + 1}`));
    }
    for (const s of draft.rig.sockets) {
      socketSelect.append(option(s.id, `Socket (${s.rest.x}, ${s.rest.y})`));
    }

    const binding = draft.rig.bindings.find(b => b.partId === this.selectedLayerId);
    if (binding) {
      jointSelect.value = binding.jointId;
      socketSelect.value = binding.socketId ?? '';
    }
  }

  private updateTimelineStrip(): void {
    const draft = this.draft;
    const strip = this.el('rig-timeline-strip');
    strip.replaceChildren();
    if (!draft) return;

    for (let i = 0; i < draft.plan.frames.length; i++) {
      const f = draft.plan.frames[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `frame-tab ${f.id === this.selectedFrameId ? 'active' : ''}`;
      btn.textContent = `${i + 1} (${f.durationMs}ms)`;
      btn.onclick = () => {
        this.stopPlay();
        this.selectedFrameId = f.id;
        this.renderUI();
      };
      strip.append(btn);
    }
  }

  private updateFrameInspector(): void {
    const draft = this.draft;
    if (!draft) return;

    this.el<HTMLSelectElement>('rig-plan-action').value = draft.plan.action;
    this.el<HTMLInputElement>('rig-plan-loop').checked = draft.plan.loop;
    this.el<HTMLInputElement>('rig-plan-rootmotion').checked = draft.plan.rootMotion;

    const cur = draft.plan.frames.find(f => f.id === this.selectedFrameId);
    const active = document.activeElement;
    if (cur) {
      if (active !== this.el('rig-frame-duration')) this.el<HTMLInputElement>('rig-frame-duration').value = String(cur.durationMs);

      const rot = cur.rotations.find(r => r.jointId === this.selectedJointId)?.degrees ?? 0;
      if (active !== this.el('rig-frame-joint-rot')) this.el<HTMLInputElement>('rig-frame-joint-rot').value = String(rot);

      if (active !== this.el('rig-frame-root-dx')) this.el<HTMLInputElement>('rig-frame-root-dx').value = String(cur.root.dx);
      if (active !== this.el('rig-frame-root-dy')) this.el<HTMLInputElement>('rig-frame-root-dy').value = String(cur.root.dy);
      if (active !== this.el('rig-frame-travel-dx')) this.el<HTMLInputElement>('rig-frame-travel-dx').value = String(cur.travel.dx);
      if (active !== this.el('rig-frame-travel-dy')) this.el<HTMLInputElement>('rig-frame-travel-dy').value = String(cur.travel.dy);
    }
  }

  private updateChainControls(): void {
    const draft = this.draft;
    const select = this.el<HTMLSelectElement>('rig-chain-select');
    const rootSel = this.el<HTMLSelectElement>('rig-chain-root');
    const midSel = this.el<HTMLSelectElement>('rig-chain-mid');
    const endSel = this.el<HTMLSelectElement>('rig-chain-end');
    const sockSel = this.el<HTMLSelectElement>('rig-chain-contact-socket');

    select.replaceChildren(option('', '+ Thêm chuỗi chi mới'));
    rootSel.replaceChildren();
    midSel.replaceChildren();
    endSel.replaceChildren();
    sockSel.replaceChildren(option('', '(Không có socket tiếp đất)'));
    if (!draft) return;

    for (const c of draft.rig.chains) {
      select.append(option(c.id, `${c.id} (${c.kind === 'arm' ? 'Tay' : 'Chân'})`));
    }
    if (this.selectedChainId && draft.rig.chains.some(c => c.id === this.selectedChainId)) {
      select.value = this.selectedChainId;
    } else {
      select.value = '';
    }

    for (let i = 0; i < draft.rig.joints.length; i++) {
      const j = draft.rig.joints[i];
      rootSel.append(option(j.id, `Khớp ${i + 1}`));
      midSel.append(option(j.id, `Khớp ${i + 1}`));
      endSel.append(option(j.id, `Khớp ${i + 1}`));
    }
    for (const s of draft.rig.sockets) {
      sockSel.append(option(s.id, `Socket (${s.rest.x}, ${s.rest.y})`));
    }

    const curChain = draft.rig.chains.find(c => c.id === this.selectedChainId);
    if (curChain) {
      this.el<HTMLSelectElement>('rig-chain-kind').value = curChain.kind;
      this.el<HTMLSelectElement>('rig-chain-bend').value = String(curChain.bend);
      rootSel.value = curChain.rootJointId;
      midSel.value = curChain.midJointId;
      endSel.value = curChain.endJointId;
      sockSel.value = curChain.contactSocketId ?? '';
    }

    // Contacts
    const curFrame = draft.plan.frames.find(f => f.id === this.selectedFrameId);
    const contact = curFrame?.contacts.find(c => c.chainId === this.selectedChainId);
    const active = document.activeElement;

    const frameSocket = this.el<HTMLSelectElement>('rig-contact-socket');
    frameSocket.replaceChildren(option('', 'Mặc định của chuỗi chi'), option('@joint', 'Khớp cổ chân'));
    if (curChain) for (const s of draft.rig.sockets.filter(s => s.jointId === curChain.endJointId)) frameSocket.append(option(s.id, `${s.id} (${s.rest.x}, ${s.rest.y})`));
    frameSocket.value = contact?.contactSocketId === undefined ? '' : contact.contactSocketId === null ? '@joint' : contact.contactSocketId;
    if (contact) {
      this.el<HTMLSelectElement>('rig-contact-phase').value = contact.phase;
      if (contact.target) {
        if (active !== this.el('rig-contact-target-x')) this.el<HTMLInputElement>('rig-contact-target-x').value = String(contact.target.x);
        if (active !== this.el('rig-contact-target-y')) this.el<HTMLInputElement>('rig-contact-target-y').value = String(contact.target.y);
      }
    } else {
      this.el<HTMLSelectElement>('rig-contact-phase').value = 'none';
    }

    // Foot raster distance info
    const geomInfo = this.el('rig-chain-geometry-info');
    if (this.compiled && curFrame) {
      const geo = this.compiled.geometry.find(g => g.frameId === curFrame.id);
      const cg = geo?.contacts.find(c => c.chainId === this.selectedChainId);
      if (cg) {
        geomInfo.textContent = `Pha: ${cg.phase === 'stance' ? 'Tiếp đất' : 'Vung'} · Lệch raster: ${cg.rasterError}px · Khoảng cách: ${cg.distance.toFixed(2)}px`;
      } else {
        geomInfo.textContent = '';
      }
    } else {
      geomInfo.textContent = '';
    }
  }

  // --- Canvas Rendering & Diagnostics Overlay ---

  private renderCanvas(): void {
    const draft = this.draft;
    const canvas = this.el<HTMLCanvasElement>('rig-canvas');
    if (!draft || !this.cachedResources) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }

    const { w, h } = draft.recipe.canvas;
    const banner = this.el('rig-pose-error-banner');
    const footerStatus = this.el('rig-footer-status');

    let renderPixels: Uint32Array | undefined;
    this.poseError = '';

    // Attempt compiling motion recipe
    try {
      const context = rigDraftContext(draft, this.options.session.doc?.studio?.resources ?? {});
      this.compiled = compileMotionRecipe(draft.recipe, draft.rig, draft.plan, context);
      const renderer = createRecipeRenderer(this.compiled.recipe, this.cachedResources);
      for (const f of this.compiled.recipe.frames) {
        const pixels = renderer.renderFrame(f.id).image.data, frozen = this.frozenFrames.get(f.id);
        if (frozen && pixels.some((c, i) => c !== frozen[i])) throw Error('Pose thay đổi frame đã khóa.');
        if (this.movementMask && pixels.some((c, i) => !this.movementMask![i] && c !== this.sourcePixels?.[i])) throw Error('Pose thay đổi pixel ngoài vùng cho phép.');
      }
      banner.hidden = true;
    } catch (err) {
      this.compiled = undefined;
      this.poseError = (err as Error).message ?? String(err);
      banner.hidden = false;
      banner.textContent = `⚠️ Lỗi tư thế: ${this.poseError}. Hiển thị nguồn/nghỉ.`;
    }

    // A skeleton draft stays previewable while incomplete art blocks Review.
    if (this.compiled) {
      try { assertMotionArtwork(this.compiled, this.cachedResources); }
      catch (e) { this.poseError = (e as Error).message; banner.hidden = false; banner.textContent = this.poseError; }
    }

    // Decide which pixels to display
    if (this.viewMode === 'pose' && this.compiled) {
      try {
        const renderer = createRecipeRenderer(this.compiled.recipe, this.cachedResources);
        const curFrameId = this.selectedFrameId || draft.plan.frames[0].id;
        renderPixels = renderer.renderFrame(curFrameId).image.data;
      } catch (err) {
        this.poseError = (err as Error).message;
        banner.hidden = false;
        banner.textContent = `⚠️ Lỗi dựng tư thế: ${(err as Error).message}. Hiển thị nguồn/nghỉ.`;
      }
    }

    if (!renderPixels) {
      try {
        const renderer = createRecipeRenderer(draft.recipe, this.cachedResources);
        renderPixels = renderer.renderFrame(draft.recipe.frames[0].id).image.data;
      } catch {
        renderPixels = new Uint32Array(w * h);
      }
    }

    this.restPixels = renderPixels;
    picture(canvas, this.el<HTMLInputElement>('rig-chk-art').checked ? renderPixels : new Uint32Array(w * h), w, h, this.zoom);

    // Draw diagnostic overlay (bones, joints, sockets, contacts, selection)
    const ctx = canvas.getContext('2d')!;
    const showBones = this.el<HTMLInputElement>('rig-chk-bones').checked;

    if (showBones) {
      this.drawBonesOverlay(ctx, w, h);
    }

    // Selection marquee
    if (this.activeGesture?.type === 'select-rect') {
      const g = this.activeGesture;
      const x0 = Math.min(g.startX, g.currentX);
      const y0 = Math.min(g.startY, g.currentY);
      const bw = Math.abs(g.currentX - g.startX) + 1;
      const bh = Math.abs(g.currentY - g.startY) + 1;

      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(x0, y0, bw, bh);
      ctx.fillStyle = 'rgba(0, 240, 255, 0.15)';
      ctx.fillRect(x0, y0, bw, bh);
      ctx.setLineDash([]);
    }

    // Footer info
    if (this.compiled && this.viewMode === 'pose') {
      const geo = this.compiled.geometry.find(g => g.frameId === this.selectedFrameId);
      footerStatus.textContent = `Frame ${draft.plan.frames.findIndex(f => f.id === this.selectedFrameId) + 1}/${draft.plan.frames.length} · Sai số xương: ${geo?.maxBoneError.toFixed(3) ?? 0}px · Sai số gắn: ${geo?.maxAttachmentError.toFixed(3) ?? 0}px. Overlay chỉ để chẩn đoán, không xuất ảnh.`;
    } else {
      footerStatus.textContent = `Chế độ nguồn / nghỉ · Canvas: ${w}×${h} · Zoom: ${this.zoom}×.`;
    }
  }

  private drawBonesOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const draft = this.draft;
    if (!draft) return;

    let jointPoints: Record<string, { x: number; y: number }> = {};
    let socketPoints: Record<string, { x: number; y: number }> = {};

    if (this.viewMode === 'pose' && this.compiled) {
      const geo = this.compiled.geometry.find(g => g.frameId === this.selectedFrameId);
      if (geo) {
        jointPoints = geo.joints;
        socketPoints = geo.sockets;
      }
    }

    if (Object.keys(jointPoints).length === 0) {
      for (const j of draft.rig.joints) {
        jointPoints[j.id] = { ...j.rest };
      }
      for (const s of draft.rig.sockets) {
        socketPoints[s.id] = { ...s.rest };
      }
    }

    // Draw bones connecting parent to child
    ctx.strokeStyle = '#ffdb59';
    ctx.lineWidth = 1;
    for (const j of draft.rig.joints) {
      if (j.parentId && jointPoints[j.parentId] && jointPoints[j.id]) {
        const p1 = jointPoints[j.parentId];
        const p2 = jointPoints[j.id];
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    // Draw joints
    for (const j of draft.rig.joints) {
      const p = jointPoints[j.id];
      if (!p) continue;
      const isSelected = j.id === this.selectedJointId;
      ctx.fillStyle = isSelected ? '#63f5ff' : '#ff9900';
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      ctx.strokeStyle = isSelected ? '#ffffff' : '#000000';
      ctx.strokeRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }

    // Draw sockets
    for (const s of draft.rig.sockets) {
      const p = socketPoints[s.id];
      if (!p) continue;
      ctx.fillStyle = '#ff79c6';
      ctx.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5);
    }

    // Draw contact target & actual point in pose view
    if (this.viewMode === 'pose' && this.compiled) {
      const geo = this.compiled.geometry.find(g => g.frameId === this.selectedFrameId);
      if (geo) {
        for (const c of geo.contacts) {
          if (c.phase === 'stance' && c.target) {
            // Target
            ctx.fillStyle = '#50fa7b';
            ctx.fillRect(c.target.x - 1, c.target.y - 1, 2, 2);
            // Actual
            ctx.fillStyle = c.rasterError > 1 ? '#ff5555' : '#8be9fd';
            ctx.fillRect(c.actual.x - 0.75, c.actual.y - 0.75, 1.5, 1.5);
            // Error line
            ctx.strokeStyle = '#ff5555';
            ctx.setLineDash([1, 1]);
            ctx.beginPath();
            ctx.moveTo(c.actual.x, c.actual.y);
            ctx.lineTo(c.target.x, c.target.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    }
  }

  // --- Animation Playback ---

  private startPlay(): void {
    if (!this.compiled || !this.draft || !this.canEdit()) return;
    this.viewMode = 'pose'; this.el<HTMLInputElement>('rig-mode-pose').checked = true; this.renderCanvas();
    this.el('rig-btn-play').textContent = 'Dừng';
    const owner = this.draft, frames = owner.plan.frames;
    const startIndex = Math.max(0, frames.findIndex(f => f.id === this.selectedFrameId)), started = performance.now();
    const tick = () => {
      if (!this.dialog.open || !this.canEdit() || this.draft !== owner) { this.stopPlay(); return; }
      const stamp = performance.now(), sample = sampleMotionPlayback(frames, stamp - started, owner.plan.loop, startIndex);
      if (this.selectedFrameId !== frames[sample.index].id) {
        this.selectedFrameId = frames[sample.index].id;
        this.renderCanvas();
        this.updateTimelineStrip();
      }
      if (sample.done) { this.stopPlay(); return; }
      this.playTimer = setTimeout(tick, Math.max(1, sample.delayMs - (performance.now() - stamp)));
    };
    tick();
  }

  private stopPlay(): void {
    clearTimeout(this.playTimer);
    this.playTimer = undefined;
    this.el('rig-btn-play').textContent = 'Phát animation';
  }

  // --- Pointer Gestures on Canvas ---

  private canvasCoords(e: PointerEvent): { x: number; y: number } {
    const canvas = this.el<HTMLCanvasElement>('rig-canvas');
    const rect = canvas.getBoundingClientRect();
    const w = this.draft?.recipe.canvas.w ?? 1;
    const h = this.draft?.recipe.canvas.h ?? 1;
    const x = Math.max(0, Math.min(w - 1, Math.floor(((e.clientX - rect.left) / rect.width) * w)));
    const y = Math.max(0, Math.min(h - 1, Math.floor(((e.clientY - rect.top) / rect.height) * h)));
    return { x, y };
  }

  private onCanvasPointerDown(e: PointerEvent): void {
    if (!this.canEdit() || !this.draft || e.button !== 0) return;
    this.stopPlay();
    const { x, y } = this.canvasCoords(e);

    // 1. Adding Joint Mode
    if (this.addingJoint && this.viewMode === 'rest') {
      const parentId = this.selectedJointId || this.draft.rig.joints[0]?.id || null;
      const newJoint: MotionJoint = {
        id: 'joint_' + uid(),
        parentId,
        rest: { x, y },
        minRotation: -180,
        maxRotation: 180,
      };
      this.applyCommands('Thêm khớp', [{ type: 'joint.add', joint: newJoint }]);
      this.selectedJointId = newJoint.id;
      this.addingJoint = false;
      this.el('rig-btn-add-joint').textContent = '+ Thêm khớp (click canvas)';
      this.renderUI();
      return;
    }

    // 2. Check if clicked near an existing joint
    const threshold = Math.max(2, 6 / this.zoom);
    const clickedJoint = this.draft.rig.joints.find(j => Math.hypot(j.rest.x - x, j.rest.y - y) <= threshold);

    if (clickedJoint) {
      this.selectedJointId = clickedJoint.id;
      this.updateJointControls(); this.updateFrameInspector();
      this.renderCanvas();

      if (this.viewMode === 'rest') {
        const session = this.options.session;
        session.hold();
        const beforeDoc = session.begin()!;

        // Collect initial rest positions for joint and all its descendants
        const descendants = getDescendants(this.draft.rig.joints, clickedJoint.id);
        const affectedIds = new Set([clickedJoint.id, ...descendants]);
        const initialRest = new Map<string, { x: number; y: number }>();
        for (const j of this.draft.rig.joints) {
          if (affectedIds.has(j.id)) initialRest.set(j.id, { ...j.rest });
        }

        this.activeGesture = {
          type: 'drag-joint',
          jointId: clickedJoint.id,
          startX: x,
          startY: y,
          initialRest,
          beforeDoc,
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    // 3. Empty canvas click -> Start rectangle selection
    if (this.viewMode === 'rest') {
      this.activeGesture = {
        type: 'select-rect',
        startX: x,
        startY: y,
        currentX: x,
        currentY: y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  }

  private onCanvasPointerMove(e: PointerEvent): void {
    if (!this.activeGesture || !this.draft) return;
    const { x, y } = this.canvasCoords(e);
    const { w, h } = this.draft.recipe.canvas;

    if (this.activeGesture.type === 'drag-joint') {
      const g = this.activeGesture;
      const dx = x - g.startX;
      const dy = y - g.startY;

      const original = g.beforeDoc.studio!.rigDrafts![this.draft.id];
      const positions = [...g.initialRest.values()];
      const moveX = Math.max(-Math.min(...positions.map(p => p.x)), Math.min(w - Math.max(...positions.map(p => p.x)), dx));
      const moveY = Math.max(-Math.min(...positions.map(p => p.y)), Math.min(h - Math.max(...positions.map(p => p.y)), dy));
      for (const [id, initial] of g.initialRest) {
        const joint = this.draft.rig.joints.find(j => j.id === id)!;
        joint.rest = { x: initial.x + moveX, y: initial.y + moveY };
        for (const socket of this.draft.rig.sockets.filter(s => s.jointId === id)) {
          const previous = original.rig.sockets.find(s => s.id === socket.id)!;
          socket.rest = { x: previous.rest.x + moveX, y: previous.rest.y + moveY };
          for (const binding of this.draft.rig.bindings.filter(b => b.socketId === socket.id)) this.draft.recipe.parts.find(p => p.id === binding.partId)!.pivot = { ...socket.rest };
        }
      }
      this.renderCanvas();
    } else if (this.activeGesture.type === 'select-rect') {
      this.activeGesture.currentX = x;
      this.activeGesture.currentY = y;
      this.renderCanvas();
    }
  }

  private onCanvasPointerUp(e: PointerEvent): void {
    if (!this.activeGesture || !this.draft) return;
    const { w, h } = this.draft.recipe.canvas;

    if (this.activeGesture.type === 'drag-joint') {
      const beforeDoc = this.activeGesture.beforeDoc;
      this.activeGesture = undefined;
      try {
        this.options.session.doc!.studio!.rigDrafts![this.draft.id] = structuredClone(this.draft);
        this.options.session.end(beforeDoc, 'Di chuyển khớp');
        this.options.session.release();
      } catch (err) {
        this.options.session.rollback(beforeDoc);
        this.draft = structuredClone(beforeDoc.studio!.rigDrafts![this.currentDraftId]);
        this.options.session.release();
        this.report(err);
      }
      this.renderUI();
    } else if (this.activeGesture.type === 'select-rect') {
      const g = this.activeGesture;
      const a = { x: Math.round(g.startX), y: Math.round(g.startY) };
      const b = { x: Math.round(g.currentX), y: Math.round(g.currentY) };
      this.selectionMask = rectangle(w, h, a, b);
      this.activeGesture = undefined;
      this.renderCanvas();
      this.el('rig-footer-status').textContent = 'Đã chọn vùng hình chữ nhật. Bấm "Tách layer theo vùng chọn" để tách.';
    }
  }

  private cancelGesture(): void {
    if (!this.activeGesture) return;
    if (this.activeGesture.type === 'drag-joint') {
      this.options.session.release();
      this.options.session.rollback(this.activeGesture.beforeDoc);
      if (this.draft && this.options.session.doc?.studio?.rigDrafts?.[this.draft.id]) {
        this.draft = structuredClone(this.options.session.doc.studio.rigDrafts[this.draft.id]);
      }
    }
    this.activeGesture = undefined;
    this.renderCanvas();
  }
}
