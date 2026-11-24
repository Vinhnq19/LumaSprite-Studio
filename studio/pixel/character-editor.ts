import {
  ensureCharacterExtension,
  createCharacterProfile,
  approveCharacterProfile,
  recaptureCharacterProfile,
  renameCharacterProfile,
  removeCharacterProfile,
  addCharacterPart,
  updateCharacterPart,
  removeCharacterPart,
  addCharacterLandmark,
  updateCharacterLandmark,
  removeCharacterLandmark,
  addCharacterLink,
  removeCharacterLink,
} from '../../src/studio/character-commands.ts';
import {
  checkCharacterReadiness,
  resolvePixelPivot,
  validateCharacterId,
  validateName,
  MAX_CHARACTER_PARTS,
  MAX_CHARACTER_LANDMARKS,
  type CharacterProfile,
  type CharacterReadiness,
} from '../../src/studio/characters.ts';
import { validateDesignManifest } from '../../src/studio/design-manifest.ts';
import { composite, celFor, type PixelDocument } from '../../src/studio/pixel/model.ts';
import type { Session } from './session.ts';

export interface SelectionContext {
  assetId: string;
  frameId: string;
  w: number;
  h: number;
  selection?: Uint8Array;
}

export interface CharacterEditorOptions {
  session: Session;
  prepare: () => Promise<void>;
  getSelectionContext: () => SelectionContext;
  navigateToSource: (assetId: string, frameId: string) => Promise<void>;
  onError: (error: unknown) => void;
  onStatus: (status: string) => void;
}

interface DragState {
  doc: PixelDocument;
  docId: string;
  docVersion: number;
  profileId: string;
  landmarkId: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  pointerId: number;
}

export class CharacterEditorController {
  private readonly session: Session;
  private readonly prepare: () => Promise<void>;
  private readonly getSelectionContext: () => SelectionContext;
  private readonly navigateToSource: (assetId: string, frameId: string) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly onStatus: (status: string) => void;

  readonly dialog: HTMLDialogElement;
  private selectedProfileId = '';
  private selectedPartId = '';
  private selectedLandmarkId = '';
  private currentTab: 'parts' | 'landmarks' | 'links' | 'manifest' = 'parts';

  private zoom = 4;
  private viewMode: 'master' | 'current' | 'diff' = 'master';
  private showGrid = true;
  private showMask = true;
  private showPoints = true;
  private showPivot = true;

  private openTicket = 0;
  private actionTicket = 0;
  private loadTicket = 0;
  private isOpen = false;
  private isPlacingLandmark = false;
  private activeDrag?: DragState;
  private editLandmarkOwner = '';

  // Single active bounded working buffers, cleared on switch/close
  private cachedMasterData?: Uint32Array;
  private cachedCurrentComposite?: Uint32Array;
  private activeMaskResourceId?: string;
  private activeMaskData?: Uint32Array;

  constructor(options: CharacterEditorOptions) {
    this.session = options.session;
    this.prepare = options.prepare;
    this.getSelectionContext = options.getSelectionContext;
    this.navigateToSource = options.navigateToSource;
    this.onError = error => {
      if (this.isOpen) this.$('char-dialog-status').textContent = error instanceof Error ? error.message : String(error);
      options.onError(error);
    };
    this.onStatus = options.onStatus;

    this.dialog = document.createElement('dialog');
    this.dialog.id = 'character-dialog';
    this.dialog.className = 'large-workspace character-dialog';
    this.dialog.setAttribute('aria-labelledby', 'char-dialog-title');
    this.dialog.innerHTML = `
<div class="workspace-header">
  <h2 id="char-dialog-title">Nhân vật (Character Editor)</h2>
  <span id="char-dialog-status" class="hint" role="alert"></span>
  <button id="char-dialog-close" type="button">Đóng (Esc)</button>
</div>
<div class="character-editor-body">
  <!-- Left column: Profile List & Profile Actions -->
  <aside class="char-sidebar">
    <div class="char-section-header">
      <h3>Hồ sơ nhân vật</h3>
      <button id="char-create-profile-btn" class="primary" title="Tạo nhân vật từ asset và frame hiện tại">+ Tạo mới</button>
    </div>
    <div id="char-profile-list" class="char-profile-list" role="listbox" aria-label="Danh sách nhân vật"></div>

    <div id="char-profile-details" class="char-profile-details" hidden>
      <div class="char-details-header">
        <strong id="char-profile-name-display"></strong>
        <span id="char-profile-approval-badge" class="badge"></span>
      </div>
      <div id="char-source-meta" class="hint"></div>

      <div class="row wrap char-action-row">
        <button id="char-approve-btn" class="primary" title="Chụp lại ảnh hiện tại và đánh dấu đã duyệt">Duyệt mẫu hiện tại</button>
        <button id="char-recapture-btn" title="Chụp lại ảnh hiện tại nhưng chưa duyệt">Chụp lại</button>
        <button id="char-rename-btn">Đổi tên</button>
        <button id="char-delete-btn" class="danger">Xóa</button>
        <button id="char-nav-source-btn">Mở frame nguồn trên canvas</button>
      </div>

      <div id="char-readiness-container" class="char-readiness-box">
        <strong>Trạng thái:</strong> <span id="char-readiness-status"></span>
        <p id="char-readiness-reason" class="hint"></p>
      </div>
    </div>
  </aside>

  <!-- Middle column: Preview Canvas & Overlays -->
  <main class="char-preview-area">
    <div class="char-canvas-toolbar">
      <div class="char-zoom-controls">
        <button id="char-zoom-out" title="Thu nhỏ">−</button>
        <span id="char-zoom-label">400%</span>
        <button id="char-zoom-in" title="Phóng to">+</button>
        <button id="char-zoom-fit" title="Vừa khung">Vừa</button>
        <button id="char-zoom-100" title="Kích thước 100%">100%</button>
      </div>
      <div class="char-view-controls">
        <select id="char-view-mode-select" aria-label="Chế độ hiển thị">
          <option value="master">Ảnh mẫu đã duyệt</option>
          <option value="current">Ảnh composite hiện tại</option>
          <option value="diff">So sánh khác biệt</option>
        </select>
      </div>
      <div class="char-overlay-toggles">
        <label><input type="checkbox" id="char-chk-grid" checked> Lưới</label>
        <label><input type="checkbox" id="char-chk-mask" checked> Mặt nạ</label>
        <label><input type="checkbox" id="char-chk-points" checked> Khớp & xương</label>
        <label><input type="checkbox" id="char-chk-pivot" checked> Pivot</label>
      </div>
    </div>

    <div id="char-stage" class="char-stage">
      <canvas id="char-canvas" tabindex="0" aria-label="Canvas xem trước và chỉnh sửa điểm mốc"></canvas>
    </div>

    <div class="char-stage-footer">
      <small class="hint">Kéo điểm mốc để di chuyển (1 thao tác hoàn tác). Esc hủy kéo. Vàng: Pivot · Cyan: Mặt nạ bộ phận.</small>
      <span id="char-coords-info" class="hint"></span>
    </div>
  </main>

  <!-- Right column: Parts / Landmarks / Links Inspector -->
  <aside class="char-inspector">
    <div class="char-inspector-tabs">
      <button class="char-tab-btn active" data-tab="parts">Bộ phận</button>
      <button class="char-tab-btn" data-tab="landmarks">Điểm mốc</button>
      <button class="char-tab-btn" data-tab="links">Liên kết</button>
      <button class="char-tab-btn" data-tab="manifest" id="char-manifest-tab-btn" hidden>Gợi ý AI</button>
    </div>

    <!-- Parts Tab Content -->
    <div id="char-tab-parts" class="char-tab-content">
      <div class="char-tab-header">
        <h4>Danh sách bộ phận</h4>
        <button id="char-add-part-btn" class="primary" title="Thêm bộ phận từ vùng chọn trên canvas">+ Thêm từ vùng chọn</button>
      </div>
      <p id="char-selection-guidance" class="hint"></p>
      <div id="char-parts-list" class="char-item-list" role="listbox"></div>

      <div id="char-selected-part-controls" class="char-selected-controls" hidden>
        <h5 id="char-part-name-display"></h5>
        <div class="row wrap">
          <button id="char-replace-part-mask-btn" title="Cập nhật lại mặt nạ bộ phận từ vùng chọn hiện tại">Cập nhật vùng chọn</button>
          <button id="char-rename-part-btn">Đổi tên</button>
          <button id="char-remove-part-btn" class="danger">Xóa bộ phận</button>
        </div>
      </div>
      <p class="hint char-movement-note">Vùng chuyển động được chọn riêng ở bước tạo animation.</p>
    </div>

    <!-- Landmarks Tab Content -->
    <div id="char-tab-landmarks" class="char-tab-content" hidden>
      <div class="char-tab-header">
        <h4>Điểm mốc (Khớp nối)</h4>
      </div>
      <div id="char-landmarks-list" class="char-item-list" role="listbox"></div>

      <form id="char-add-landmark-form" class="char-subform">
        <h5>Thêm điểm mốc mới</h5>
        <label>Tên: <input id="char-new-lm-name" placeholder="Ví dụ: head, hand_l" required maxlength="100"></label>
        <div class="row">
          <label>X: <input id="char-new-lm-x" type="number" min="0" value="0" required></label>
          <label>Y: <input id="char-new-lm-y" type="number" min="0" value="0" required></label>
        </div>
        <label>Gán bộ phận:
          <select id="char-new-lm-part">
            <option value="">(Không gán bộ phận)</option>
          </select>
        </label>
        <button type="submit" class="primary">+ Thêm điểm mốc</button>
      </form>

      <div id="char-selected-lm-controls" class="char-selected-controls" hidden>
        <h5 id="char-lm-name-display"></h5>
        <form id="char-edit-landmark-form" class="char-subform">
          <label>Tên điểm mốc:
            <input type="text" id="char-edit-lm-name" required maxlength="100" />
          </label>
          <div class="row">
            <label>Tọa độ X:
              <input type="number" id="char-edit-lm-x" required min="0" />
            </label>
            <label>Tọa độ Y:
              <input type="number" id="char-edit-lm-y" required min="0" />
            </label>
          </div>
          <label>Bộ phận liên kết:
            <select id="char-edit-lm-part">
              <option value="">(Không gán bộ phận)</option>
            </select>
          </label>
          <div class="row wrap">
            <button type="button" id="char-place-lm-btn" class="button">Đặt vị trí trên canvas</button>
            <button type="submit" id="char-save-lm-btn" class="primary">Lưu thay đổi</button>
            <button type="button" id="char-delete-lm-btn" class="danger">Xóa điểm mốc</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Links Tab Content -->
    <div id="char-tab-links" class="char-tab-content" hidden>
      <div class="char-tab-header">
        <h4>Liên kết xương (Links)</h4>
      </div>
      <div id="char-links-list" class="char-item-list" role="listbox"></div>

      <form id="char-add-link-form" class="char-subform">
        <h5>Thêm liên kết mới</h5>
        <label>Từ: <select id="char-link-from" required></select></label>
        <label>Đến: <select id="char-link-to" required></select></label>
        <button type="submit" class="primary">+ Nối liên kết</button>
      </form>
    </div>

    <!-- Manifest Suggestions Tab Content -->
    <div id="char-tab-manifest" class="char-tab-content" hidden>
      <div class="char-tab-header">
        <h4>Gợi ý từ AI Manifest</h4>
      </div>
      <p id="char-manifest-desc" class="hint"></p>
      <div id="char-manifest-preview" class="char-manifest-preview"></div>
      <div class="row">
        <button id="char-import-manifest-btn" class="primary">Nhập gợi ý vào bản nháp</button>
      </div>
      <small class="hint">Gợi ý AI luôn được nhập dưới dạng bản nháp chưa duyệt. Bạn cần kiểm tra và bấm "Duyệt mẫu hiện tại" sau khi xác nhận.</small>
    </div>
  </aside>
</div>
`;
    document.body.appendChild(this.dialog);
    this.bindEvents();
  }

  get hasGesture(): boolean {
    if (this.activeDrag) return true;
    const profile = this.getSelectedProfile(), point = profile?.landmarks[this.selectedLandmarkId];
    const owner = this.session.doc?.id + ':' + profile?.id + ':' + this.selectedLandmarkId;
    if (!this.isOpen || !point || owner !== this.editLandmarkOwner) return false;
    // An external save must preserve unsubmitted inspector text just like a local drag.
    return (this.$('char-edit-lm-name') as HTMLInputElement).value !== point.name ||
      (this.$('char-edit-lm-x') as HTMLInputElement).value !== String(point.x) ||
      (this.$('char-edit-lm-y') as HTMLInputElement).value !== String(point.y) ||
      (this.$('char-edit-lm-part') as HTMLSelectElement).value !== (point.partId ?? '');
  }

  private $(id: string): HTMLElement {
    return this.dialog.querySelector(`#${id}`) as HTMLElement;
  }

  private bindEvents(): void {
    // Dialog close
    this.$('char-dialog-close').onclick = () => this.close();

    // Escape and shortcut handling
    this.dialog.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement;
      if (target && target.matches('input, textarea, select')) {
        return; // Allow native text/IME editing and native Ctrl+Z
      }

      if (e.key === 'Escape') {
        if (this.isPlacingLandmark) {
          e.preventDefault();
          e.stopPropagation();
          this.togglePlaceLandmarkMode(false);
          return;
        }
        if (this.activeDrag) {
          e.preventDefault();
          e.stopPropagation();
          this.cancelDrag();
          return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          e.stopPropagation();
          this.finalize();
          void this.runSessionAction(() => this.session.undo(e.shiftKey));
          return;
        }
        if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          e.stopPropagation();
          this.finalize();
          void this.runSessionAction(() => this.session.undo(true));
          return;
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          this.finalize();
          void this.runSessionAction(() => this.session.flush(true));
          return;
        }
      }
    });

    window.addEventListener('blur', () => {
      if (this.activeDrag) this.cancelDrag();
      if (this.isPlacingLandmark) this.togglePlaceLandmarkMode(false);
    });

    this.dialog.addEventListener('cancel', e => {
      e.preventDefault();
      if (this.isPlacingLandmark) this.togglePlaceLandmarkMode(false);
      else if (this.activeDrag) this.cancelDrag();
      else this.close();
    });

    // Profile creation
    this.$('char-create-profile-btn').onclick = () => {
      void this.handleCreateProfile();
    };

    // Profile actions
    this.$('char-approve-btn').onclick = () => {
      void this.handleApproveProfile();
    };
    this.$('char-recapture-btn').onclick = () => {
      void this.handleRecaptureProfile();
    };
    this.$('char-rename-btn').onclick = () => {
      void this.handleRenameProfile();
    };
    this.$('char-delete-btn').onclick = () => {
      void this.handleDeleteProfile();
    };
    this.$('char-nav-source-btn').onclick = () => {
      void this.handleNavSource();
    };

    // Zoom controls
    this.$('char-zoom-in').onclick = () => {
      this.setZoom(this.zoom * 2);
    };
    this.$('char-zoom-out').onclick = () => {
      this.setZoom(Math.max(1, Math.floor(this.zoom / 2)));
    };
    this.$('char-zoom-fit').onclick = () => {
      this.fitZoom();
    };
    this.$('char-zoom-100').onclick = () => {
      this.setZoom(1);
    };

    // View mode selector
    (this.$('char-view-mode-select') as HTMLSelectElement).onchange = (e) => {
      this.viewMode = (e.target as HTMLSelectElement).value as 'master' | 'current' | 'diff';
      this.renderCanvas();
    };

    // Overlay checkboxes
    (this.$('char-chk-grid') as HTMLInputElement).onchange = (e) => {
      this.showGrid = (e.target as HTMLInputElement).checked;
      this.renderCanvas();
    };
    (this.$('char-chk-mask') as HTMLInputElement).onchange = (e) => {
      this.showMask = (e.target as HTMLInputElement).checked;
      this.renderCanvas();
    };
    (this.$('char-chk-points') as HTMLInputElement).onchange = (e) => {
      this.showPoints = (e.target as HTMLInputElement).checked;
      this.renderCanvas();
    };
    (this.$('char-chk-pivot') as HTMLInputElement).onchange = (e) => {
      this.showPivot = (e.target as HTMLInputElement).checked;
      this.renderCanvas();
    };

    // Tab buttons
    this.dialog.querySelectorAll('.char-tab-btn').forEach((btn) => {
      (btn as HTMLButtonElement).onclick = () => {
        const tab = (btn as HTMLElement).dataset.tab as 'parts' | 'landmarks' | 'links' | 'manifest';
        this.switchTab(tab);
      };
    });

    // Add part
    this.$('char-add-part-btn').onclick = () => {
      void this.handleAddPart();
    };
    this.$('char-replace-part-mask-btn').onclick = () => {
      void this.handleReplacePartMask();
    };
    this.$('char-rename-part-btn').onclick = () => {
      void this.handleRenamePart();
    };
    this.$('char-remove-part-btn').onclick = () => {
      void this.handleRemovePart();
    };

    // Add landmark form
    (this.$('char-add-landmark-form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      void this.handleAddLandmark();
    };

    // Edit landmark form
    (this.$('char-edit-landmark-form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      void this.handleUpdateLandmark();
    };

    // Click to place landmark
    this.$('char-place-lm-btn').onclick = () => {
      this.togglePlaceLandmarkMode();
    };

    this.$('char-delete-lm-btn').onclick = () => {
      void this.handleDeleteLandmark();
    };

    // Add link form
    (this.$('char-add-link-form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      void this.handleAddLink();
    };

    // Import manifest suggestions
    this.$('char-import-manifest-btn').onclick = () => {
      void this.handleImportManifest();
    };

    // Pointer events on canvas
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    canvas.addEventListener('pointerdown', (e) => this.onCanvasPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onCanvasPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onCanvasPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
    canvas.addEventListener('lostpointercapture', () => {
      if (this.activeDrag) this.cancelDrag();
    });
  }

  private switchTab(tab: 'parts' | 'landmarks' | 'links' | 'manifest'): void {
    this.currentTab = tab;
    if (tab !== 'landmarks') {
      this.togglePlaceLandmarkMode(false);
    }
    this.dialog.querySelectorAll('.char-tab-btn').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
    });
    this.dialog.querySelectorAll('.char-tab-content').forEach((content) => {
      (content as HTMLElement).hidden = content.id !== `char-tab-${tab}`;
    });
    this.updateTabUI();
  }

  private setZoom(z: number): void {
    this.zoom = Math.max(1, Math.min(32, Math.round(z)));
    this.$('char-zoom-label').textContent = `${this.zoom * 100}%`;
    this.renderCanvas();
  }

  private fitZoom(): void {
    const profile = this.getSelectedProfile();
    if (!profile) return;
    const stage = this.$('char-stage');
    const availW = Math.max(100, stage.clientWidth - 40);
    const availH = Math.max(100, stage.clientHeight - 40);
    const zx = Math.floor(availW / profile.source.w);
    const zy = Math.floor(availH / profile.source.h);
    this.setZoom(Math.max(1, Math.min(zx, zy, 16)));
  }

  async open(profileId?: string): Promise<void> {
    const doc = this.session.doc;
    if (!doc) {
      throw new Error('Cần mở một dự án trước khi vào trình chỉnh sửa nhân vật.');
    }
    const docId = doc.id;
    const assetId = this.session.assetId;
    const frameId = this.session.frameId;
    const ticket = ++this.openTicket;
    let version = this.session.version;
    this.actionTicket++;
    this.loadTicket++;

    try {
      const preparing = this.prepare();
      version = this.session.version;
      await preparing;
    } catch (err) {
      if (
        this.openTicket === ticket &&
        this.session.doc === doc &&
        this.session.doc?.id === docId &&
        this.session.assetId === assetId &&
        this.session.frameId === frameId
      ) {
        this.onError(err);
      }
      return;
    }

    // Ownership guard: abort if context changed during prepare
    if (
      this.openTicket !== ticket ||
      this.session.doc !== doc ||
      this.session.doc?.id !== docId ||
      this.session.assetId !== assetId ||
      this.session.frameId !== frameId ||
      this.session.version !== version
    ) {
      return;
    }

    this.isOpen = true;
    this.togglePlaceLandmarkMode(false);

    // Do NOT call ensureCharacterExtension here (viewing must be read-only!)
    const characters = this.session.doc.studio?.characters ?? {};
    const ids = Object.keys(characters);
    if (profileId && Object.hasOwn(characters, profileId)) {
      this.selectedProfileId = profileId;
    } else if (ids.length > 0) {
      if (!this.selectedProfileId || !Object.hasOwn(characters, this.selectedProfileId)) {
        this.selectedProfileId = ids[0];
      }
    } else {
      this.selectedProfileId = '';
    }

    this.$('char-dialog-status').textContent = '';
    if (!this.dialog.open) this.dialog.showModal();
    await this.refreshAll();
    if (this.isOpen && this.openTicket === ticket && this.session.doc === doc) this.fitZoom();
  }

  close(): void {
    this.openTicket++;
    this.actionTicket++;
    this.loadTicket++;
    if (this.activeDrag) {
      this.cancelDrag();
    }
    this.togglePlaceLandmarkMode(false);
    this.isOpen = false;
    this.dialog.close();
    this.releaseWorkingBuffers();
  }

  reset(): void {
    this.openTicket++;
    this.actionTicket++;
    this.loadTicket++;
    if (this.activeDrag) {
      this.cancelDrag();
    }
    this.togglePlaceLandmarkMode(false);
    this.selectedProfileId = '';
    this.selectedPartId = '';
    this.selectedLandmarkId = '';
    this.editLandmarkOwner = '';
    this.releaseWorkingBuffers();
    if (this.isOpen) {
      this.close();
    }
  }

  finalize(): void {
    if (this.activeDrag) {
      this.commitDrag();
    }
  }

  update(): void {
    if (!this.isOpen || !this.session.doc) return;
    // Do NOT call ensureCharacterExtension here
    const characters = this.session.doc.studio?.characters ?? {};
    if (this.selectedProfileId && !Object.hasOwn(characters, this.selectedProfileId)) {
      const keys = Object.keys(characters);
      this.selectedProfileId = keys.length > 0 ? keys[0] : '';
    }
    void this.refreshAll();
  }

  private releaseWorkingBuffers(): void {
    this.cachedMasterData = undefined;
    this.cachedCurrentComposite = undefined;
    this.activeMaskResourceId = undefined;
    this.activeMaskData = undefined;
    this.activeDrag = undefined;
  }

  private getSelectedProfile(): CharacterProfile | undefined {
    if (!this.session.doc?.studio?.characters || !this.selectedProfileId) return undefined;
    return this.session.doc.studio.characters[this.selectedProfileId];
  }

  private async runSessionAction(work: () => Promise<void> | void): Promise<void> {
    const doc = this.session.doc, ticket = this.openTicket;
    try { await work(); }
    catch (error) { if (this.isOpen && this.session.doc === doc && this.openTicket === ticket) this.onError(error); }
  }

  private async refreshAll(): Promise<void> {
    const doc = this.session.doc;
    if (!doc || !this.isOpen) return;
    const ticket = ++this.loadTicket, version = this.session.version, profileId = this.selectedProfileId;
    const current = () => this.isOpen && this.loadTicket === ticket && this.session.doc === doc &&
      this.session.version === version && this.selectedProfileId === profileId;
    this.cachedMasterData = undefined;
    this.cachedCurrentComposite = undefined;
    this.activeMaskResourceId = undefined;
    this.activeMaskData = undefined;
    this.renderProfileList();
    const profile = this.getSelectedProfile(), details = this.$('char-profile-details');
    if (!profile) { details.hidden = true; this.clearCanvas(); this.updateTabUI(); return; }
    details.hidden = false;
    this.$('char-profile-name-display').textContent = profile.name;
    const badge = this.$('char-profile-approval-badge');
    badge.textContent = profile.approved ? 'Đã duyệt' : 'Chưa duyệt';
    badge.className = 'badge ' + (profile.approved ? 'ready' : 'unapproved');
    const asset = doc.assets.find(a => a.id === profile.source.assetId);
    this.$('char-source-meta').textContent = (asset?.name ?? profile.source.assetId) + ' · ' +
      profile.source.w + '×' + profile.source.h + ' px · Frame: ' + profile.source.frameId + ' · Mẫu r' + profile.source.captureRevision;
    this.renderReadiness({ status: 'missing-data', reason: 'Đang tải mẫu nhân vật…' });
    this.updateTabUI(); // resolves the first active part before its lazy mask is loaded
    this.renderCanvas();
    try {
      const master = await this.session.loadResource(profile.source.rgbaResourceId);
      if (!current()) return;
      if (!(master?.data instanceof Uint32Array)) throw new Error('Không tải được dữ liệu mẫu nhân vật.');
      this.cachedMasterData = master.data;
      if (asset) {
        await this.session.loadFrame(profile.source.frameId, asset);
        if (!current()) return;
        // Missing visible cels must be an error, not an apparently empty composite.
        for (const layer of asset.layers) {
          const id = layer.cels[profile.source.frameId];
          if (id && !asset.cels[id]?.data) throw new Error('Cel của frame mẫu chưa tải được.');
        }
        this.cachedCurrentComposite = composite(asset, profile.source.frameId).data;
      }
      this.renderReadiness(checkCharacterReadiness({ profile, sourceResourceData: this.cachedMasterData,
        currentComposite: this.cachedCurrentComposite, currentWidth: asset?.w, currentHeight: asset?.h,
        currentPalette: asset?.palette, currentPivot: asset ? resolvePixelPivot(asset.metadata?.pivot, asset.w, asset.h) : undefined }));
      const part = profile.parts[this.selectedPartId];
      if (part) {
        const partId = this.selectedPartId, mask = await this.session.loadResource(part.maskResourceId);
        if (!current() || partId !== this.selectedPartId) return;
        if (!(mask?.data instanceof Uint32Array)) throw new Error('Không tải được mặt nạ bộ phận.');
        this.activeMaskResourceId = part.maskResourceId;
        this.activeMaskData = mask.data;
      }
      if (!current()) return;
      this.checkManifestSuggestions(asset);
      this.updateTabUI();
      this.renderCanvas();
    } catch (error) {
      if (!current()) return;
      this.cachedMasterData = undefined;
      this.cachedCurrentComposite = undefined;
      this.activeMaskData = undefined;
      this.renderReadiness({ status: 'error', reason: error instanceof Error ? error.message : String(error) });
      this.renderCanvas();
      this.onError(error);
    }
  }

  private renderProfileList(): void {
    const listEl = this.$('char-profile-list');
    listEl.replaceChildren();

    const characters = this.session.doc?.studio?.characters ?? {};
    const entries = Object.entries(characters);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'Chưa có hồ sơ nhân vật. Nhấp "+ Tạo mới" để bắt đầu.';
      listEl.appendChild(empty);
      return;
    }

    for (const [id, prof] of entries) {
      const row = document.createElement('div');
      row.className = `char-profile-item ${id === this.selectedProfileId ? 'selected' : ''}`;
      row.onclick = () => {
        if (this.selectedProfileId === id) return;
        this.finalize();
        this.openTicket++; this.actionTicket++; this.loadTicket++;
        this.togglePlaceLandmarkMode(false);
        this.$('char-dialog-status').textContent = '';
        this.editLandmarkOwner = '';
        this.selectedProfileId = id;
        this.selectedPartId = '';
        this.selectedLandmarkId = '';
        void this.refreshAll();
      };

      const title = document.createElement('span');
      title.className = 'char-item-title';
      title.textContent = prof.name;

      const meta = document.createElement('small');
      meta.className = 'char-item-sub';
      meta.textContent = `${prof.source.w}×${prof.source.h} · ${prof.approved ? 'Đã duyệt' : 'Chưa duyệt'}`;

      row.appendChild(title);
      row.appendChild(meta);
      listEl.appendChild(row);
    }
  }

  private renderReadiness(readiness: CharacterReadiness): void {
    const statusEl = this.$('char-readiness-status');
    const reasonEl = this.$('char-readiness-reason');

    let label = '';
    let cls = '';
    switch (readiness.status) {
      case 'ready':
        label = 'Sẵn sàng';
        cls = 'ready';
        break;
      case 'unapproved':
        label = 'Chưa duyệt';
        cls = 'unapproved';
        break;
      case 'stale':
        label = 'Cần duyệt lại (Stale)';
        cls = 'stale';
        break;
      case 'missing-data':
        label = 'Thiếu dữ liệu';
        cls = 'missing';
        break;
      case 'error':
      default:
        label = 'Lỗi';
        cls = 'error';
        break;
    }

    statusEl.textContent = label;
    statusEl.className = `badge ${cls}`;

    let reasonText = readiness.reason ?? '';
    if (readiness.differences) {
      const diffs: string[] = [];
      if (readiness.differences.pixelsChanged) diffs.push('Điểm ảnh đã thay đổi');
      if (readiness.differences.paletteChanged) diffs.push('Palette đã đổi');
      if (readiness.differences.pivotChanged) diffs.push('Pivot đã đổi');
      if (readiness.differences.dimensionsChanged) diffs.push('Kích thước đã đổi');
      if (diffs.length > 0) {
        reasonText += ` (${diffs.join(', ')})`;
      }
    }
    reasonEl.textContent = reasonText;
  }

  private checkManifestSuggestions(asset?: any): void {
    const tabBtn = this.$('char-manifest-tab-btn');
    const manifest = asset?.provenance?.batch?.manifest;
    const hasSuggestions =
      manifest &&
      ((Array.isArray(manifest.parts) && manifest.parts.length > 0) ||
        (Array.isArray(manifest.landmarks) && manifest.landmarks.length > 0));

    tabBtn.hidden = !hasSuggestions;
    if (hasSuggestions) {
      this.$('char-manifest-desc').textContent = `Tìm thấy ${manifest.parts?.length ?? 0} bộ phận và ${manifest.landmarks?.length ?? 0} điểm mốc được gợi ý từ AI manifest.`;
    }
  }

  private updateTabUI(): void {
    const profile = this.getSelectedProfile();
    const selCtx = this.getSelectionContext();

    // 1. Parts Tab
    const guidanceEl = this.$('char-selection-guidance');
    const addPartBtn = this.$('char-add-part-btn') as HTMLButtonElement;
    const replacePartBtn = this.$('char-replace-part-mask-btn') as HTMLButtonElement;

    if (!profile) {
      addPartBtn.disabled = true;
      guidanceEl.textContent = 'Chọn một hồ sơ nhân vật.';
    } else {
      const isMatch =
        selCtx.assetId === profile.source.assetId &&
        selCtx.frameId === profile.source.frameId &&
        selCtx.w === profile.source.w &&
        selCtx.h === profile.source.h;

      const hasSelection = !!selCtx.selection?.some(Boolean);

      if (!isMatch) {
        addPartBtn.disabled = true;
        guidanceEl.textContent = `Vùng chọn hiện tại thuộc asset khác hoặc frame khác. Cần chọn trên asset "${profile.source.assetId}" frame "${profile.source.frameId}" (${profile.source.w}×${profile.source.h} px).`;
      } else if (!hasSelection) {
        addPartBtn.disabled = true;
        guidanceEl.textContent = 'Vui lòng dùng công cụ Chọn (M) hoặc Đũa thần (W) trên canvas chính để chọn vùng pixel cho bộ phận.';
      } else {
        addPartBtn.disabled = false;
        guidanceEl.textContent = 'Vùng chọn hợp lệ! Sẵn sàng thêm hoặc cập nhật bộ phận.';
      }

      if (replacePartBtn) {
        replacePartBtn.disabled = !isMatch || !hasSelection || !this.selectedPartId;
      }
    }

    this.renderPartsList(profile);
    this.renderLandmarksList(profile);
    this.renderLinksList(profile);
  }

  private renderPartsList(profile?: CharacterProfile): void {
    const listEl = this.$('char-parts-list');
    listEl.replaceChildren();
    const ctrlEl = this.$('char-selected-part-controls');

    if (!profile || Object.keys(profile.parts).length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'Chưa có bộ phận nào.';
      listEl.appendChild(empty);
      ctrlEl.hidden = true;
      return;
    }

    if (!this.selectedPartId || !Object.hasOwn(profile.parts, this.selectedPartId)) {
      this.selectedPartId = Object.keys(profile.parts)[0];
    }

    ctrlEl.hidden = false;
    this.$('char-part-name-display').textContent = profile.parts[this.selectedPartId]?.name ?? '';

    for (const [partId, part] of Object.entries(profile.parts)) {
      const item = document.createElement('div');
      item.className = `char-sub-item ${partId === this.selectedPartId ? 'selected' : ''}`;
      item.onclick = () => {
        this.selectedPartId = partId;
        this.updateTabUI();
        void this.refreshAll();
      };

      const name = document.createElement('span');
      name.textContent = part.name;

      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'char-delete-small';
      del.title = 'Xóa bộ phận';
      del.onclick = (e) => {
        e.stopPropagation();
        this.selectedPartId = partId;
        void this.handleRemovePart();
      };

      item.appendChild(name);
      item.appendChild(del);
      listEl.appendChild(item);
    }
  }

  private renderLandmarksList(profile?: CharacterProfile): void {
    const listEl = this.$('char-landmarks-list');
    listEl.replaceChildren();
    const ctrlEl = this.$('char-selected-lm-controls');

    // Populate landmark part dropdown in add form
    const partSelect = this.$('char-new-lm-part') as HTMLSelectElement;
    const currentPartVal = partSelect.value;
    partSelect.replaceChildren();
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '(Không gán bộ phận)';
    partSelect.appendChild(defaultOpt);

    if (profile) {
      for (const [pId, part] of Object.entries(profile.parts)) {
        const opt = document.createElement('option');
        opt.value = pId;
        opt.textContent = part.name;
        partSelect.appendChild(opt);
      }
      if (currentPartVal && Object.hasOwn(profile.parts, currentPartVal)) {
        partSelect.value = currentPartVal;
      }
    }

    if (!profile || Object.keys(profile.landmarks).length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'Chưa có điểm mốc nào.';
      listEl.appendChild(empty);
      ctrlEl.hidden = true;
      return;
    }

    if (this.selectedLandmarkId && !Object.hasOwn(profile.landmarks, this.selectedLandmarkId)) {
      this.selectedLandmarkId = '';
    }

    ctrlEl.hidden = !this.selectedLandmarkId;
    if (this.selectedLandmarkId && profile.landmarks[this.selectedLandmarkId]) {
      const lm = profile.landmarks[this.selectedLandmarkId];
      this.$('char-lm-name-display').textContent = `${lm.name} (${lm.x}, ${lm.y})${lm.partId ? ' · ' + (profile.parts[lm.partId]?.name ?? lm.partId) : ''}`;
    }

    const selected = profile.landmarks[this.selectedLandmarkId];
    const owner = this.session.doc?.id + ':' + profile.id + ':' + this.selectedLandmarkId;
    const form = this.$('char-edit-landmark-form');
    if (selected && (owner !== this.editLandmarkOwner || !form.contains(document.activeElement))) {
      this.editLandmarkOwner = owner;
      (this.$('char-edit-lm-name') as HTMLInputElement).value = selected.name;
      (this.$('char-edit-lm-x') as HTMLInputElement).value = String(selected.x);
      (this.$('char-edit-lm-y') as HTMLInputElement).value = String(selected.y);
      const part = this.$('char-edit-lm-part') as HTMLSelectElement;
      part.replaceChildren(new Option('(Không gán bộ phận)', ''));
      for (const [id, p] of Object.entries(profile.parts)) part.add(new Option(p.name, id));
      part.value = selected.partId ?? '';
    }
    for (const id of ['char-edit-lm-x', 'char-new-lm-x']) (this.$(id) as HTMLInputElement).max = String(profile.source.w - 1);
    for (const id of ['char-edit-lm-y', 'char-new-lm-y']) (this.$(id) as HTMLInputElement).max = String(profile.source.h - 1);

    for (const [lmId, lm] of Object.entries(profile.landmarks)) {
      const item = document.createElement('div');
      item.className = `char-sub-item ${lmId === this.selectedLandmarkId ? 'selected' : ''}`;
      item.onclick = () => {
        this.selectedLandmarkId = lmId;
        this.renderLandmarksList(profile);
        this.renderCanvas();
      };

      const title = document.createElement('span');
      title.textContent = `${lm.name} (${lm.x}, ${lm.y})`;

      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'char-delete-small';
      del.title = 'Xóa điểm mốc';
      del.onclick = (e) => {
        e.stopPropagation();
        this.selectedLandmarkId = lmId;
        void this.handleDeleteLandmark();
      };

      item.appendChild(title);
      item.appendChild(del);
      listEl.appendChild(item);
    }
  }

  private renderLinksList(profile?: CharacterProfile): void {
    const listEl = this.$('char-links-list');
    listEl.replaceChildren();

    const fromSel = this.$('char-link-from') as HTMLSelectElement;
    const toSel = this.$('char-link-to') as HTMLSelectElement;

    const prevFrom = fromSel.value;
    const prevTo = toSel.value;

    fromSel.replaceChildren();
    toSel.replaceChildren();

    if (profile) {
      const lmEntries = Object.entries(profile.landmarks);
      for (const [lmId, lm] of lmEntries) {
        const o1 = document.createElement('option');
        o1.value = lmId;
        o1.textContent = `${lm.name} (${lm.x}, ${lm.y})`;
        fromSel.appendChild(o1);

        const o2 = document.createElement('option');
        o2.value = lmId;
        o2.textContent = `${lm.name} (${lm.x}, ${lm.y})`;
        toSel.appendChild(o2);
      }

      // Preserve still-valid selections
      if (prevFrom && Object.hasOwn(profile.landmarks, prevFrom)) {
        fromSel.value = prevFrom;
      } else if (lmEntries.length > 0) {
        fromSel.value = lmEntries[0][0];
      }

      if (prevTo && Object.hasOwn(profile.landmarks, prevTo) && prevTo !== fromSel.value) {
        toSel.value = prevTo;
      } else {
        // Initialize second option to a distinct endpoint
        const distinct = lmEntries.find(([id]) => id !== fromSel.value);
        if (distinct) {
          toSel.value = distinct[0];
        }
      }

      fromSel.onchange = () => {
        if (toSel.value === fromSel.value) {
          const distinct = lmEntries.find(([id]) => id !== fromSel.value);
          if (distinct) toSel.value = distinct[0];
        }
      };
    }

    if (!profile || profile.links.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'Chưa có liên kết xương nào.';
      listEl.appendChild(empty);
      return;
    }

    for (const link of profile.links) {
      const item = document.createElement('div');
      item.className = 'char-sub-item';

      const fromName = profile.landmarks[link.from]?.name ?? link.from;
      const toName = profile.landmarks[link.to]?.name ?? link.to;

      const span = document.createElement('span');
      span.textContent = `${fromName} ↔ ${toName}`;

      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'char-delete-small';
      del.title = 'Xóa liên kết';
      del.onclick = () => {
        this.handleRemoveLink(link.from, link.to);
      };

      item.appendChild(span);
      item.appendChild(del);
      listEl.appendChild(item);
    }
  }

  private clearCanvas(): void {
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, 1, 1);
  }

  private renderCanvas(): void {
    const profile = this.getSelectedProfile();
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    if (!profile) {
      this.clearCanvas();
      return;
    }

    const w = profile.source.w;
    const h = profile.source.h;
    const zoom = this.zoom;

    canvas.width = w * zoom;
    canvas.height = h * zoom;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // 1. Draw checkerboard
    const checkSize = Math.max(8, zoom);
    for (let cy = 0; cy < canvas.height; cy += checkSize) {
      for (let cx = 0; cx < canvas.width; cx += checkSize) {
        const isDark = ((cx / checkSize) ^ (cy / checkSize)) & 1;
        ctx.fillStyle = isDark ? '#232c38' : '#1d2530';
        ctx.fillRect(cx, cy, checkSize, checkSize);
      }
    }

    // 2. Select base image pixels according to viewMode
    let basePixels: Uint32Array | undefined;
    if (this.viewMode === 'master') {
      basePixels = this.cachedMasterData;
    } else if (this.viewMode === 'current') {
      basePixels = this.cachedCurrentComposite;
    } else if (this.viewMode === 'diff') {
      if (this.cachedMasterData && this.cachedCurrentComposite) {
        const diff = new Uint32Array(w * h);
        for (let i = 0; i < diff.length; i++) {
          const m = this.cachedMasterData[i];
          const c = this.cachedCurrentComposite[i];
          if (m !== c) {
            diff[i] = 0xff00ffff; // Bright magenta for differences
          } else {
            diff[i] = m;
          }
        }
        basePixels = diff;
      } else {
        basePixels = this.cachedMasterData ?? this.cachedCurrentComposite;
      }
    }

    if (basePixels && basePixels.length === w * h) {
      // Convert 0xRRGGBBAA to Canvas RGBA
      const imgData = ctx.createImageData(w, h);
      const b = imgData.data;
      for (let i = 0; i < basePixels.length; i++) {
        const p = basePixels[i];
        b[i * 4] = p >>> 24;
        b[i * 4 + 1] = (p >>> 16) & 255;
        b[i * 4 + 2] = (p >>> 8) & 255;
        b[i * 4 + 3] = p & 255;
      }

      // Draw onto offscreen canvas and scale up without smoothing
      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      offscreen.getContext('2d')!.putImageData(imgData, 0, 0);

      ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
    }

    // 3. Grid overlay
    if (this.showGrid && zoom >= 4) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        ctx.moveTo(x * zoom - 0.5, 0);
        ctx.lineTo(x * zoom - 0.5, h * zoom);
      }
      for (let y = 0; y <= h; y++) {
        ctx.moveTo(0, y * zoom - 0.5);
        ctx.lineTo(w * zoom, y * zoom - 0.5);
      }
      ctx.stroke();
    }

    // 4. Cyan mask overlay for active selected part
    if (this.showMask && this.activeMaskData && this.activeMaskData.length === w * h) {
      ctx.fillStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (this.activeMaskData[y * w + x] === 1) {
            ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
          }
        }
      }
    }

    // 5. Links overlay
    if (this.showPoints && profile.links.length > 0) {
      ctx.strokeStyle = '#4dd0e1';
      ctx.lineWidth = Math.max(1.5, Math.floor(zoom / 3));

      for (const link of profile.links) {
        let p1 = profile.landmarks[link.from];
        let p2 = profile.landmarks[link.to];

        if (this.activeDrag) {
          if (link.from === this.activeDrag.landmarkId) {
            p1 = { ...p1, x: this.activeDrag.currentX, y: this.activeDrag.currentY };
          }
          if (link.to === this.activeDrag.landmarkId) {
            p2 = { ...p2, x: this.activeDrag.currentX, y: this.activeDrag.currentY };
          }
        }

        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo((p1.x + 0.5) * zoom, (p1.y + 0.5) * zoom);
          ctx.lineTo((p2.x + 0.5) * zoom, (p2.y + 0.5) * zoom);
          ctx.stroke();
        }
      }
    }

    // 6. Landmarks overlay
    if (this.showPoints) {
      for (const [lmId, lm] of Object.entries(profile.landmarks)) {
        let x = lm.x;
        let y = lm.y;
        if (this.activeDrag && this.activeDrag.landmarkId === lmId) {
          x = this.activeDrag.currentX;
          y = this.activeDrag.currentY;
        }

        const cx = (x + 0.5) * zoom;
        const cy = (y + 0.5) * zoom;
        const isSelected = lmId === this.selectedLandmarkId;
        const r = Math.max(3.5, Math.min(zoom * 0.4, 7));

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#ff4081' : '#00e5ff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isSelected ? '#ffffff' : '#0a1017';
        ctx.stroke();

        // Label landmark name
        if (zoom >= 4) {
          ctx.font = '10px sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 2.5;
          ctx.strokeText(lm.name, cx + r + 2, cy + 3);
          ctx.fillText(lm.name, cx + r + 2, cy + 3);
        }
      }
    }

    // 7. Gold Pivot overlay
    if (this.showPivot) {
      const p = profile.source.pivot;
      const px = p.x * zoom;
      const py = p.y * zoom;

      ctx.strokeStyle = '#ffd700';
      ctx.fillStyle = '#ffd700';
      ctx.lineWidth = 2;

      // Circle at pivot
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.stroke();

      // Cross lines
      ctx.beginPath();
      ctx.moveTo(px - 7, py);
      ctx.lineTo(px + 7, py);
      ctx.moveTo(px, py - 7);
      ctx.lineTo(px, py + 7);
      ctx.stroke();
    }
  }

  // Pointer drag for landmarks
  private onCanvasPointerDown(e: PointerEvent): void {
    const profile = this.getSelectedProfile();
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    const doc = this.session.doc;
    if (!profile || !doc || e.button !== 0) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });

    const rect = canvas.getBoundingClientRect();
    const px = Math.max(0, Math.min(profile.source.w - 1, Math.floor((e.clientX - rect.left) * profile.source.w / rect.width)));
    const py = Math.max(0, Math.min(profile.source.h - 1, Math.floor((e.clientY - rect.top) * profile.source.h / rect.height)));
    if (this.isPlacingLandmark && this.selectedLandmarkId) {
      const id = this.selectedLandmarkId;
      this.togglePlaceLandmarkMode(false);
      try { this.session.change('Đặt vị trí điểm mốc', () => updateCharacterLandmark(doc, profile.id, id, { x: px, y: py })); }
      catch (error) { this.onError(error); }
      return;
    }

    // Hit-test landmarks
    let foundLmId = '';
    const hitRadius = Math.max(2, Math.ceil(10 / this.zoom));

    for (const [id, lm] of Object.entries(profile.landmarks)) {
      const dist = Math.hypot(lm.x - px, lm.y - py);
      if (dist <= hitRadius) {
        foundLmId = id;
        break;
      }
    }

    if (foundLmId) {
      const foundLm = profile.landmarks[foundLmId];
      this.selectedLandmarkId = foundLmId;
      canvas.setPointerCapture(e.pointerId);

      this.activeDrag = {
        doc,
        docId: doc.id,
        docVersion: this.session.version,
        profileId: profile.id,
        landmarkId: foundLmId,
        startX: foundLm.x,
        startY: foundLm.y,
        currentX: foundLm.x,
        currentY: foundLm.y,
        pointerId: e.pointerId,
      };

      this.renderLandmarksList(profile);
      this.renderCanvas();
    }
  }

  private onCanvasPointerMove(e: PointerEvent): void {
    const profile = this.getSelectedProfile();
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    if (!profile) return;

    const rect = canvas.getBoundingClientRect();
    const px = Math.max(0, Math.min(profile.source.w - 1, Math.floor((e.clientX - rect.left) * profile.source.w / rect.width)));
    const py = Math.max(0, Math.min(profile.source.h - 1, Math.floor((e.clientY - rect.top) * profile.source.h / rect.height)));

    this.$('char-coords-info').textContent = `Tọa độ: ${px}, ${py}`;

    if (this.activeDrag) {
      if (px !== this.activeDrag.currentX || py !== this.activeDrag.currentY) {
        this.activeDrag.currentX = px;
        this.activeDrag.currentY = py;
        this.renderCanvas();
      }
    }
  }

  private onCanvasPointerUp(e: PointerEvent): void {
    if (!this.activeDrag) return;
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Ignored if capture already lost
    }
    this.commitDrag();
  }

  private commitDrag(): void {
    if (!this.activeDrag) return;
    const drag = this.activeDrag;
    this.activeDrag = undefined;
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    try {
      canvas.releasePointerCapture(drag.pointerId);
    } catch {}

    const doc = this.session.doc;
    const profile = this.getSelectedProfile();
    if (!profile || !doc) return;

    // Validate ownership before committing
    if (
      doc !== drag.doc ||
      doc.id !== drag.docId ||
      this.session.version !== drag.docVersion ||
      profile.id !== drag.profileId
    ) {
      this.renderCanvas();
      return;
    }

    if (drag.currentX !== drag.startX || drag.currentY !== drag.startY) {
      try {
        this.session.change('Di chuyển điểm mốc', () => {
          updateCharacterLandmark(this.session.doc!, drag.profileId, drag.landmarkId, {
            x: drag.currentX,
            y: drag.currentY,
          });
        });
        this.onStatus(`Đã chuyển điểm mốc sang (${drag.currentX}, ${drag.currentY})`);
      } catch (err) {
        this.onError(err);
      }
    }

    this.renderLandmarksList(profile);
    this.renderCanvas();
  }

  private cancelDrag(): void {
    if (!this.activeDrag) return;
    const pointerId = this.activeDrag.pointerId;
    this.activeDrag = undefined;
    const canvas = this.$('char-canvas') as HTMLCanvasElement;
    try {
      canvas.releasePointerCapture(pointerId);
    } catch {}
    this.onStatus('Đã hủy kéo điểm mốc');
    this.renderCanvas();
  }

  // --- Profile CRUD handlers ---

  private async handleCreateProfile(): Promise<void> {
    const doc = this.session.doc;
    const asset = this.session.asset;
    if (!doc || !asset) return;
    const docId = doc.id;
    const assetId = asset.id;
    const frameId = this.session.frameId;
    const ticket = ++this.actionTicket;

    try {
      await this.prepare();
      if (
        !this.isOpen ||
        this.actionTicket !== ticket ||
        this.session.doc !== doc ||
        this.session.doc.id !== docId ||
        this.session.assetId !== assetId ||
        this.session.frameId !== frameId
      ) {
        return;
      }

      const existingCount = Object.keys(this.session.doc.studio?.characters ?? {}).length;
      const defaultName = `Nhân vật ${existingCount + 1}`;
      const nameInput = window.prompt('Nhập tên nhân vật mới:', defaultName);
      if (!nameInput || !nameInput.trim()) return;

      const name = nameInput.trim();
      // Ensure markers exist before first mutation
      ensureCharacterExtension(this.session.doc);

      let createdId = '';
      this.session.change(`Tạo nhân vật ${name}`, () => {
        const p = createCharacterProfile(this.session.doc!, {
          name,
          assetId,
          frameId,
        });
        createdId = p.id;
      });

      if (createdId) {
        this.selectedProfileId = createdId;
        this.selectedPartId = '';
        this.selectedLandmarkId = '';
        await this.refreshAll();
        this.onStatus(`Đã tạo hồ sơ "${name}"`);
      }
    } catch (err) {
      if (this.isOpen && this.actionTicket === ticket && this.session.doc === doc) {
        this.onError(err);
      }
    }
  }

  private async handleApproveProfile(): Promise<void> {
    const profile = this.getSelectedProfile();
    const doc = this.session.doc;
    if (!profile || !doc) return;
    const docId = doc.id;
    const profileId = profile.id;
    const assetId = profile.source.assetId;
    const frameId = profile.source.frameId;
    const ticket = ++this.actionTicket;

    try {
      await this.prepare();
      if (
        !this.isOpen ||
        this.actionTicket !== ticket ||
        this.session.doc !== doc ||
        this.session.doc.id !== docId ||
        this.selectedProfileId !== profileId
      ) {
        return;
      }
      const currentProfile = this.session.doc.studio?.characters?.[profileId];
      if (!currentProfile || currentProfile.source.assetId !== assetId || currentProfile.source.frameId !== frameId) {
        return;
      }

      this.session.change(`Duyệt nhân vật ${currentProfile.name}`, () => {
        approveCharacterProfile(this.session.doc!, profileId);
      });

      await this.refreshAll();
      this.onStatus(`Đã duyệt mẫu nhân vật "${currentProfile.name}"`);
    } catch (err) {
      if (
        this.isOpen &&
        this.actionTicket === ticket &&
        this.session.doc === doc &&
        this.selectedProfileId === profileId
      ) {
        this.onError(err);
      }
    }
  }

  private async handleRecaptureProfile(): Promise<void> {
    const profile = this.getSelectedProfile();
    const doc = this.session.doc;
    if (!profile || !doc) return;
    const docId = doc.id;
    const profileId = profile.id;
    const assetId = profile.source.assetId;
    const frameId = profile.source.frameId;
    const ticket = ++this.actionTicket;

    try {
      await this.prepare();
      if (
        !this.isOpen ||
        this.actionTicket !== ticket ||
        this.session.doc !== doc ||
        this.session.doc.id !== docId ||
        this.selectedProfileId !== profileId
      ) {
        return;
      }
      const currentProfile = this.session.doc.studio?.characters?.[profileId];
      if (!currentProfile || currentProfile.source.assetId !== assetId || currentProfile.source.frameId !== frameId) {
        return;
      }

      this.session.change(`Chụp lại nhân vật ${currentProfile.name}`, () => {
        recaptureCharacterProfile(this.session.doc!, profileId);
      });

      await this.refreshAll();
      this.onStatus(`Đã chụp lại mẫu nhân vật "${currentProfile.name}" (chưa duyệt)`);
    } catch (err) {
      if (
        this.isOpen &&
        this.actionTicket === ticket &&
        this.session.doc === doc &&
        this.selectedProfileId === profileId
      ) {
        this.onError(err);
      }
    }
  }

  private async handleRenameProfile(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc) return;

    const newName = window.prompt('Nhập tên mới cho nhân vật:', profile.name);
    if (!newName || !newName.trim() || newName.trim() === profile.name) return;

    try {
      this.session.change(`Đổi tên nhân vật thành ${newName.trim()}`, () => {
        renameCharacterProfile(this.session.doc!, profile.id, newName.trim());
      });
      await this.refreshAll();
    } catch (err) {
      this.onError(err);
    }
  }

  private async handleDeleteProfile(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc) return;

    const ok = window.confirm(`Bạn có chắc chắn muốn xóa nhân vật "${profile.name}"?`);
    if (!ok) return;

    try {
      this.session.change(`Xóa nhân vật ${profile.name}`, () => {
        removeCharacterProfile(this.session.doc!, profile.id);
      });

      this.selectedProfileId = '';
      this.selectedPartId = '';
      this.selectedLandmarkId = '';
      this.releaseWorkingBuffers();
      await this.refreshAll();
      this.onStatus(`Đã xóa nhân vật. Dùng Ctrl+Z để khôi phục.`);
    } catch (err) {
      this.onError(err);
    }
  }

  private async handleNavSource(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile) return;
    this.finalize();
    try {
      await this.navigateToSource(profile.source.assetId, profile.source.frameId);
      this.updateTabUI();
      this.onStatus(`Đã chuyển canvas chính tới asset "${profile.source.assetId}" frame "${profile.source.frameId}"`);
    } catch (err) {
      this.onError(err);
    }
  }

  // --- Parts CRUD handlers ---

  private async handleAddPart(): Promise<void> {
    const profile = this.getSelectedProfile();
    const selCtx = this.getSelectionContext();
    if (!profile || !this.session.doc) return;

    if (
      selCtx.assetId !== profile.source.assetId ||
      selCtx.frameId !== profile.source.frameId ||
      selCtx.w !== profile.source.w ||
      selCtx.h !== profile.source.h ||
      !selCtx.selection?.some(Boolean)
    ) {
      this.onError(new Error('Vùng chọn không khớp với frame hoặc kích thước của nhân vật này.'));
      return;
    }

    const defaultPartName = `Bộ phận ${Object.keys(profile.parts).length + 1}`;
    const nameInput = window.prompt('Nhập tên bộ phận mới:', defaultPartName);
    if (!nameInput || !nameInput.trim()) return;

    const name = nameInput.trim();
    const partId = `part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // Convert Uint8Array to Uint32Array (0 and 1)
    const mask = new Uint32Array(profile.source.w * profile.source.h);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = selCtx.selection[i] ? 1 : 0;
    }

    try {
      this.session.change(`Thêm bộ phận ${name}`, () => {
        addCharacterPart(this.session.doc!, profile.id, partId, {
          name,
          selection: mask,
        });
      });

      this.selectedPartId = partId;
      this.activeMaskResourceId = profile.parts[partId]?.maskResourceId;
      this.activeMaskData = mask;
      await this.refreshAll();
      this.onStatus(`Đã thêm bộ phận "${name}"`);
    } catch (err) {
      this.onError(err);
    }
  }

  private async handleReplacePartMask(): Promise<void> {
    const profile = this.getSelectedProfile();
    const selCtx = this.getSelectionContext();
    if (!profile || !this.session.doc || !this.selectedPartId) return;

    if (
      selCtx.assetId !== profile.source.assetId ||
      selCtx.frameId !== profile.source.frameId ||
      selCtx.w !== profile.source.w ||
      selCtx.h !== profile.source.h ||
      !selCtx.selection?.some(Boolean)
    ) {
      this.onError(new Error('Vùng chọn không khớp với frame hoặc kích thước của nhân vật này.'));
      return;
    }

    const part = profile.parts[this.selectedPartId];
    if (!part) return;

    const mask = new Uint32Array(profile.source.w * profile.source.h);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = selCtx.selection[i] ? 1 : 0;
    }

    try {
      this.session.change(`Cập nhật mặt nạ bộ phận ${part.name}`, () => {
        updateCharacterPart(this.session.doc!, profile.id, this.selectedPartId, {
          selection: mask,
        });
      });

      this.activeMaskResourceId = part.maskResourceId;
      this.activeMaskData = mask;
      await this.refreshAll();
      this.onStatus(`Đã cập nhật mặt nạ cho "${part.name}"`);
    } catch (err) {
      this.onError(err);
    }
  }

  private async handleRenamePart(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc || !this.selectedPartId) return;

    const part = profile.parts[this.selectedPartId];
    if (!part) return;

    const newName = window.prompt('Nhập tên mới cho bộ phận:', part.name);
    if (!newName || !newName.trim() || newName.trim() === part.name) return;

    try {
      this.session.change(`Đổi tên bộ phận thành ${newName.trim()}`, () => {
        updateCharacterPart(this.session.doc!, profile.id, this.selectedPartId, {
          name: newName.trim(),
        });
      });
      await this.refreshAll();
    } catch (err) {
      this.onError(err);
    }
  }

  private async handleRemovePart(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc || !this.selectedPartId) return;

    const part = profile.parts[this.selectedPartId];
    if (!part) return;

    const ok = window.confirm(`Xóa bộ phận "${part.name}"? (Điểm mốc liên quan sẽ được gỡ liên kết)`);
    if (!ok) return;

    const oldPartId = this.selectedPartId;
    try {
      this.session.change(`Xóa bộ phận ${part.name}`, () => {
        removeCharacterPart(this.session.doc!, profile.id, oldPartId);
      });

      this.selectedPartId = '';
      this.activeMaskResourceId = undefined;
      this.activeMaskData = undefined;
      await this.refreshAll();
      this.onStatus(`Đã xóa bộ phận "${part.name}"`);
    } catch (err) {
      this.onError(err);
    }
  }

  // --- Landmarks CRUD handlers ---

  private async handleAddLandmark(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc) return;

    const nameInput = (this.$('char-new-lm-name') as HTMLInputElement).value.trim();
    const xInput = Number((this.$('char-new-lm-x') as HTMLInputElement).value);
    const yInput = Number((this.$('char-new-lm-y') as HTMLInputElement).value);
    const partSelect = (this.$('char-new-lm-part') as HTMLSelectElement).value || undefined;

    if (!nameInput) {
      this.onError(new Error('Tên điểm mốc không được để trống.'));
      return;
    }

    const lmId = `lm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const x = Math.max(0, Math.min(profile.source.w - 1, Math.round(xInput)));
    const y = Math.max(0, Math.min(profile.source.h - 1, Math.round(yInput)));

    try {
      this.session.change(`Thêm điểm mốc ${nameInput}`, () => {
        addCharacterLandmark(this.session.doc!, profile.id, lmId, {
          name: nameInput,
          x,
          y,
          partId: partSelect,
        });
      });

      (this.$('char-new-lm-name') as HTMLInputElement).value = '';
      this.selectedLandmarkId = lmId;
      await this.refreshAll();
      this.onStatus(`Đã thêm điểm mốc "${nameInput}" tại (${x}, ${y})`);
    } catch (err) {
      this.onError(err);
    }
  }

  private togglePlaceLandmarkMode(force = !this.isPlacingLandmark): void {
    this.isPlacingLandmark = force && !!this.getSelectedProfile()?.landmarks[this.selectedLandmarkId];
    const button = this.$('char-place-lm-btn');
    button.setAttribute('aria-pressed', String(this.isPlacingLandmark));
    button.textContent = this.isPlacingLandmark ? 'Nhấp canvas để đặt · Esc hủy' : 'Đặt vị trí trên canvas';
    this.$('char-canvas').style.cursor = this.isPlacingLandmark ? 'crosshair' : 'default';
  }

  private async handleUpdateLandmark(): Promise<void> {
    const profile = this.getSelectedProfile(), doc = this.session.doc, id = this.selectedLandmarkId;
    if (!doc || !profile?.landmarks[id]) return;
    const name = (this.$('char-edit-lm-name') as HTMLInputElement).value.trim();
    const x = Number((this.$('char-edit-lm-x') as HTMLInputElement).value);
    const y = Number((this.$('char-edit-lm-y') as HTMLInputElement).value);
    const partId = (this.$('char-edit-lm-part') as HTMLSelectElement).value;
    try { this.session.change('Sửa điểm mốc', () => updateCharacterLandmark(doc, profile.id, id, { name, x, y, partId })); }
    catch (error) { this.onError(error); }
  }

  private async handleDeleteLandmark(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc || !this.selectedLandmarkId) return;

    const lm = profile.landmarks[this.selectedLandmarkId];
    if (!lm) return;

    const oldLmId = this.selectedLandmarkId;
    try {
      this.session.change(`Xóa điểm mốc ${lm.name}`, () => {
        removeCharacterLandmark(this.session.doc!, profile.id, oldLmId);
      });

      this.selectedLandmarkId = '';
      await this.refreshAll();
      this.onStatus(`Đã xóa điểm mốc "${lm.name}"`);
    } catch (err) {
      this.onError(err);
    }
  }

  // --- Links CRUD handlers ---

  private async handleAddLink(): Promise<void> {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc) return;

    const from = (this.$('char-link-from') as HTMLSelectElement).value;
    const to = (this.$('char-link-to') as HTMLSelectElement).value;

    if (!from || !to || from === to) {
      this.onError(new Error('Chọn hai điểm mốc khác nhau để liên kết.'));
      return;
    }

    try {
      this.session.change('Thêm liên kết xương', () => {
        addCharacterLink(this.session.doc!, profile.id, from, to);
      });

      await this.refreshAll();
      this.onStatus('Đã thêm liên kết');
    } catch (err) {
      this.onError(err);
    }
  }

  private handleRemoveLink(from: string, to: string): void {
    const profile = this.getSelectedProfile();
    if (!profile || !this.session.doc) return;

    try {
      this.session.change('Xóa liên kết xương', () => {
        removeCharacterLink(this.session.doc!, profile.id, from, to);
      });

      void this.refreshAll();
      this.onStatus('Đã xóa liên kết');
    } catch (err) {
      this.onError(err);
    }
  }

  // --- Manifest Suggestion Import ---

  private async handleImportManifest(): Promise<void> {
    const profile = this.getSelectedProfile(), doc = this.session.doc;
    if (!profile || !doc) return;
    try {
      const asset = doc.assets.find(a => a.id === profile.source.assetId);
      const checked = validateDesignManifest(asset?.provenance?.batch?.manifest, profile.source.w, profile.source.h);
      if (!checked.valid || !checked.manifest) throw new Error(checked.errors.join(' ') || 'Không có gợi ý AI.');
      const parts = checked.manifest.parts ?? [], points = checked.manifest.landmarks ?? [];
      if (!parts.length && !points.length) throw new Error('Manifest không chứa bộ phận hay điểm mốc.');
      if (parts.length + Object.keys(profile.parts).length > 64 || points.length + Object.keys(profile.landmarks).length > 64)
        throw new Error('Tổng bộ phận/điểm mốc vượt giới hạn 64.');
      if (parts.length * profile.source.w * profile.source.h * 4 > 64 * 1024 * 1024)
        throw new Error('Mặt nạ gợi ý vượt bộ nhớ 64 MiB. Nhập ít bộ phận hơn.');
      for (const p of parts) {
        validateName(p.name, 'Tên bộ phận');
        if (![p.box.x, p.box.y, p.box.w, p.box.h].every(Number.isInteger))
          throw new Error('Hộp bộ phận cần tọa độ nguyên trên lưới pixel.');
      }
      for (const p of points) {
        validateName(p.name, 'Tên điểm mốc');
        if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x >= profile.source.w || p.y >= profile.source.h)
          throw new Error('Điểm mốc AI phải nằm trong ô pixel của canvas.');
      }
      // All limits/geometry checked before allocating; one transaction, no swallowed partial failures.
      this.session.change('Nhập gợi ý AI chưa duyệt', () => {
        for (const part of parts) {
          const mask = new Uint32Array(profile.source.w * profile.source.h), b = part.box;
          for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) mask[y * profile.source.w + x] = 1;
          addCharacterPart(doc, profile.id, 'part_' + crypto.randomUUID(), { name: part.name, selection: mask });
        }
        for (const point of points) addCharacterLandmark(doc, profile.id, 'lm_' + crypto.randomUUID(), point);
        profile.approved = false;
      });
      this.onStatus('Đã nhập gợi ý vào bản nháp chưa duyệt. Kiểm tra rồi duyệt mẫu.');
    } catch (error) { this.onError(error); }
  }


}
