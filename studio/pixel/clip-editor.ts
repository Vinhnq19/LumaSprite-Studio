import { createClip, removeClip, renameClip, updateClipMetadata, addClipSlot, duplicateClipSlot,
  removeClipSlot, reorderClipSlots, setSlotDuration, setClipDurations, setSlotSelection,
  setSlotFrozen, setSlotKeyframe, updateSlotPose, resetSlotPose, captureNativeFrameToSlot,
  setClipMovementMask } from '../../src/studio/clip-commands.ts';
import { checkClipReadiness, type CharacterClip, type ClipFacing, type ClipMode } from '../../src/studio/clips.ts';
import { ACTION_TEMPLATES, checkCharacterReadiness, resolvePixelPivot, type CharacterProfile, type ActionTemplate } from '../../src/studio/characters.ts';
import { composite, type PixelDocument } from '../../src/studio/pixel/model.ts';
import type { Session } from './session.ts';
import type { SelectionContext } from './character-editor.ts';
import type { StartBatchOptions } from './generation-workspace.ts';
import { isActiveAiProvider } from '../../src/studio/ai-providers.ts';
import { ClipPoseView } from './clip-pose-view.ts';
import { ClipTimelineView } from './clip-timeline.ts';

interface ClipEditorOptions {
  session: Session;
  prepare: () => Promise<void>;
  getSelectionContext: () => SelectionContext;
  navigateToSource: (assetId: string, frameId: string) => Promise<void>;
  start: (options: StartBatchOptions) => Promise<void>;
  onError: (error: unknown) => void;
}
const option = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
/** DeepSeek backends reject clip image contexts; the clip editor only generates through Codex. */
const DEEPSEEK_CLIP_REASON = 'DeepSeek chưa hỗ trợ tạo phương án clip từ ngữ cảnh hình ảnh. Chọn Codex để tiếp tục.';

export class ClipEditorController {
  readonly dialog: HTMLDialogElement;
  private options: ClipEditorOptions;
  private session: Session;
  private pose: ClipPoseView;
  private timeline: ClipTimelineView;
  private profileId = '';
  private creating = false;
  private clipId = '';
  private slotId = '';
  private landmarkId = '';
  private ticket = 0;
  private action = 0;
  private opening = 0;
  private stamp = '';
  private draft = false;
  private composing = false;
  private mutating = false;
  private busy = false;
  private posting = false;
  private ready = false;
  private createReady = false;
  private loaded?: { master: Uint32Array; pixels: Uint32Array; previous?: Uint32Array; next?: Uint32Array; mask?: Uint32Array };

  constructor(options: ClipEditorOptions) {
    this.options = options; this.session = options.session;
    this.dialog = document.createElement('dialog'); this.dialog.id = 'clip-dialog'; this.dialog.className = 'large-workspace clip-dialog';
    this.dialog.setAttribute('aria-labelledby', 'clip-title');
    this.dialog.innerHTML = `<div class="workspace-header"><h2 id="clip-title">Animation nhân vật</h2><button id="clip-close" type="button">Đóng (Esc)</button></div>
<p id="clip-status" role="status" class="hint"></p><div class="clip-editor-body">
<aside class="clip-inspector"><label>Nhân vật đã duyệt<select id="clip-profile"></select></label><label>Clip<select id="clip-list"></select></label><button id="clip-new-draft" type="button">+ Clip mới</button>
<form id="clip-create-form"><h3>Tạo clip</h3><label>Tên<input id="clip-new-name" maxlength="100" value="Chuyển động mới" required></label>
<label>Mẫu chuyển động<select id="clip-template">${ACTION_TEMPLATES.map(t => `<option value="${t}">${({ idle: 'Đứng nghỉ', walk: 'Đi', run: 'Chạy', jump: 'Nhảy', attack: 'Tấn công', custom: 'Tùy chỉnh' } as Record<string, string>)[t] ?? t}</option>`).join('')}</select></label>
<div class="row"><label>Số frame<input id="clip-count" type="number" min="2" max="24" value="4" required></label><label>ms/frame<input id="clip-new-duration" type="number" min="1" max="60000" value="100" required></label></div>
<label>Phạm vi sửa<select id="clip-mode"><option value="region">Khóa ngoài vùng chọn</option><option value="whole">Toàn nhân vật</option></select></label>
<p id="clip-mask-info" class="hint"></p><button id="clip-create-submit" class="primary" type="submit">Tạo clip từ mẫu đã duyệt</button></form>
<section id="clip-properties" hidden><h3>Clip hiện tại</h3><label>Tên<input id="clip-name" maxlength="100"></label><button id="clip-rename" type="button">Lưu tên</button>
<label><input id="clip-loop" type="checkbox">Phát lặp</label><label>Hướng nhân vật<select id="clip-facing"><option value="source">Theo mẫu gốc</option><option value="left">Trái (hướng dẫn AI)</option><option value="right">Phải (hướng dẫn AI)</option></select></label>
<small>Hướng và pose là hướng dẫn AI. Kiểm tra trang bị bất đối xứng; app giữ nguyên pixel mẫu và không tự lật ảnh.</small>
<div class="row wrap"><button id="clip-source" type="button">Xem frame nguồn</button><button id="clip-mask-replace" type="button">Dùng vùng chọn mới</button><button id="clip-delete" type="button">Xóa clip</button></div></section></aside>
<main class="clip-main"><p id="clip-source-info" class="hint"></p><div class="row wrap"><button id="clip-fit" type="button">Vừa khung</button><label>Zoom<select id="clip-zoom">${[1, 2, 4, 8, 16, 32].map(v => `<option ${v === 8 ? 'selected' : ''} value="${v}">${v}×</option>`).join('')}</select></label><label><input id="clip-onion" type="checkbox">Onion-skin</label><button id="clip-undo" type="button">Hoàn tác</button><button id="clip-redo" type="button">Làm lại</button><button id="clip-discard" type="button">Hủy bản nháp ô nhập</button></div>
<div id="clip-stage" class="clip-stage"><canvas id="clip-pose-canvas" aria-label="Pose của frame"></canvas></div>
<div id="clip-timeline" class="clip-timeline" aria-label="Timeline clip"></div>
<section id="clip-slot-tools" hidden><div class="row wrap"><label><input id="clip-slot-selected" type="checkbox">Tạo lại bằng AI</label><label><input id="clip-slot-frozen" type="checkbox">Đóng băng pixel</label><label><input id="clip-slot-keyframe" type="checkbox">Keyframe hướng dẫn</label><label>ms<input id="clip-slot-duration" type="number" min="1" max="60000"></label><button id="clip-duration-save" type="button">Lưu timing</button><button id="clip-duration-group" type="button">Timing các frame chọn</button></div>
<div class="row wrap"><button id="clip-slot-add" type="button">+ Frame</button><button id="clip-slot-duplicate" type="button">Nhân bản</button><button id="clip-slot-remove" type="button">Xóa frame</button><button id="clip-slot-prev" type="button">← Đổi chỗ</button><button id="clip-slot-next" type="button">Đổi chỗ →</button><button id="clip-slot-capture" type="button">Chụp frame đang vẽ vào đây…</button></div>
<div class="row wrap"><label>Điểm pose<select id="clip-landmark"></select></label><label>X<input id="clip-pose-x" type="number" min="0"></label><label>Y<input id="clip-pose-y" type="number" min="0"></label><button id="clip-pose-save" type="button">Lưu điểm</button><button id="clip-pose-reset" type="button">Pose theo mẫu</button></div><small>Kéo một điểm là một thao tác undo. Pose hướng dẫn chuyển động; đóng băng giữ pixel chính xác.</small></section>
<section id="clip-generate-panel" hidden><div class="row wrap"><label>CLI<select id="clip-provider" aria-describedby="clip-provider-info"><option value="codex">Codex</option><option value="deepseek">DeepSeek</option></select></label><label>Palette cố định<select id="clip-palette"><option value="asset">Palette nhân vật đã duyệt</option><option value="auto16">Tối đa 16 màu từ mẫu</option></select></label></div><p id="clip-provider-info" class="hint" role="note"></p><label>Mô tả chuyển động<textarea id="clip-motion" rows="3" maxlength="12000" placeholder="Ví dụ: đi tại chỗ, giữ thiết kế, chân tiếp đất ổn định"></textarea></label><p id="clip-generate-info" class="hint"></p><button id="clip-generate" class="primary" type="button">Tạo 3 phương án cho frame được chọn</button></section></main></div>`;
    document.body.append(this.dialog);
    this.pose = new ClipPoseView(this.el<HTMLCanvasElement>('clip-pose-canvas'));
    this.timeline = new ClipTimelineView(this.el('clip-timeline'));
    this.bind();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.dialog.querySelector<T>(`#${id}`)!; }
  private input(id: string): HTMLInputElement { return this.el<HTMLInputElement>(id); }
  private select(id: string): HTMLSelectElement { return this.el<HTMLSelectElement>(id); }
  private get profile(): CharacterProfile | undefined { return this.session.doc?.studio?.characters?.[this.profileId]; }
  private get clip(): CharacterClip | undefined { return this.session.doc?.studio?.clips?.[this.clipId]; }
  private get slot() { return this.clip?.slots.find(s => s.id === this.slotId); }
  get hasGesture(): boolean { return this.dialog.open && (this.editingFields || !!this.el<HTMLTextAreaElement>('clip-motion').value.trim()); }
  private get editingFields(): boolean { return this.pose.dragging || this.draft || this.composing || this.busy || this.posting; }
  private status(text: string): void { this.el('clip-status').textContent = text; }
  private fail(error: unknown): void { this.status(error instanceof Error ? error.message : String(error)); this.options.onError(error); }
  private run(fn: () => unknown | Promise<unknown>): void { try { void Promise.resolve(fn()).catch(e => this.fail(e)); } catch (e) { this.fail(e); } }
  private button(id: string, fn: () => unknown | Promise<unknown>): void { this.el(id).onclick = () => this.run(fn); }
  private guardDraft(): boolean {
    if (!this.editingFields) return true;
    this.status('Lưu hoặc hủy thay đổi trong ô nhập trước khi đổi frame/nhân vật.'); return false;
  }
  private bind(): void {
    this.button('clip-close', () => this.close());
    this.dialog.addEventListener('cancel', e => { e.preventDefault(); if (!this.pose.cancel()) this.close(); });
    this.dialog.addEventListener('compositionstart', () => { this.composing = true; this.updateGate(); });
    this.dialog.addEventListener('compositionend', () => { this.composing = false; this.updateGate(); });
    this.dialog.addEventListener('input', e => {
      if ((e.target as HTMLElement).matches('#clip-name,#clip-new-name,#clip-count,#clip-new-duration,#clip-slot-duration,#clip-pose-x,#clip-pose-y')) this.draft = true;
      this.updateGate();
    });
    this.dialog.addEventListener('keydown', e => {
      if (e.isComposing || (e.target as HTMLElement).matches('input,textarea,select,[contenteditable]')) return;
      if (e.key === 'Escape' && this.pose.cancel()) { e.preventDefault(); e.stopPropagation(); }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ['z', 'y', 's'].includes(e.key.toLowerCase())) {
        e.preventDefault(); e.stopPropagation();
        if (this.posting) return;
        if (e.key.toLowerCase() === 's') this.run(() => this.session.flush(true));
        else this.run(() => this.undo(e.shiftKey || e.key.toLowerCase() === 'y'));
      }
    });
    this.select('clip-profile').onchange = () => {
      if (!this.guardDraft()) { this.select('clip-profile').value = this.profileId; return; }
      this.profileId = this.select('clip-profile').value; this.creating = false; this.clipId = ''; this.slotId = ''; this.refresh();
    };
    this.select('clip-list').onchange = () => {
      if (!this.guardDraft()) { this.select('clip-list').value = this.clipId; return; }
      this.clipId = this.select('clip-list').value; this.creating = !this.clipId; this.slotId = ''; this.refresh();
    };
    this.el<HTMLFormElement>('clip-create-form').onsubmit = e => { e.preventDefault(); this.run(() => this.create()); };
    this.select('clip-mode').onchange = () => { this.maskInfo(); if (!this.clip && this.profile) this.run(() => this.loadView()); };
    this.button('clip-new-draft', () => { if (this.guardDraft()) { this.creating = true; this.clipId = ''; this.slotId = ''; this.refresh(); } });
    this.button('clip-discard', () => { this.draft = false; this.pose.cancel(); this.refresh(); });
    this.button('clip-fit', () => this.pose.fit()); this.select('clip-zoom').onchange = () => this.pose.setZoom(Number(this.select('clip-zoom').value));
    this.input('clip-onion').onchange = () => this.refresh();
    this.button('clip-undo', () => this.undo()); this.button('clip-redo', () => this.undo(true));
    this.button('clip-rename', () => this.change('Đổi tên clip', doc => renameClip(doc, this.clipId, this.input('clip-name').value)));
    this.input('clip-loop').onchange = () => this.run(() => this.change('Chế độ phát clip', doc => updateClipMetadata(doc, this.clipId, { loop: this.input('clip-loop').checked })));
    this.select('clip-facing').onchange = () => this.run(() => this.change('Hướng clip', doc => updateClipMetadata(doc, this.clipId, { facing: this.select('clip-facing').value as ClipFacing })));
    this.button('clip-delete', () => { if (this.clip && confirm(`Xóa clip “${this.clip.name}”? Asset gốc được giữ.`)) this.change('Xóa clip', doc => { removeClip(doc, this.clipId); this.clipId = ''; }); });
    this.button('clip-source', async () => { if (this.profile) await this.options.navigateToSource(this.profile.source.assetId, this.profile.source.frameId); });
    this.button('clip-mask-replace', () => this.change('Thay vùng chuyển động', doc => setClipMovementMask(doc, this.clipId, { selection: this.selection() })));
    this.input('clip-slot-selected').onchange = () => this.run(() => this.change('Chọn frame tạo lại', doc => setSlotSelection(doc, this.clipId, this.slotId, this.input('clip-slot-selected').checked)));
    this.input('clip-slot-frozen').onchange = () => this.run(() => this.change('Đóng băng frame', doc => setSlotFrozen(doc, this.clipId, this.slotId, this.input('clip-slot-frozen').checked)));
    this.input('clip-slot-keyframe').onchange = () => this.run(() => this.change('Keyframe hướng dẫn', doc => setSlotKeyframe(doc, this.clipId, this.slotId, this.input('clip-slot-keyframe').checked)));
    this.button('clip-duration-save', () => this.change('Timing clip', doc => setSlotDuration(doc, this.clipId, this.slotId, Number(this.input('clip-slot-duration').value))));
    this.button('clip-duration-group', () => this.change('Timing các frame chọn', doc => setClipDurations(doc, this.clipId, Number(this.input('clip-slot-duration').value), this.clip!.slots.filter(s => s.selected && !s.frozen).map(s => s.id))));
    this.button('clip-slot-add', () => this.change('Thêm frame clip', doc => { this.slotId = addClipSlot(doc, this.clipId).id; }));
    this.button('clip-slot-duplicate', () => this.change('Nhân bản frame clip', doc => { this.slotId = duplicateClipSlot(doc, this.clipId, this.slotId).id; }));
    this.button('clip-slot-remove', () => this.change('Xóa frame clip', doc => { removeClipSlot(doc, this.clipId, this.slotId); this.slotId = ''; }));
    for (const [id, delta] of [['clip-slot-prev', -1], ['clip-slot-next', 1]] as const) this.button(id, () => this.change('Đổi thứ tự clip', doc => {
      const ids = this.clip!.slots.map(s => s.id), i = ids.indexOf(this.slotId), j = i + delta;
      if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; reorderClipSlots(doc, this.clipId, ids);
    }));
    this.button('clip-slot-capture', () => this.capture());
    this.select('clip-landmark').onchange = () => { if (!this.guardDraft()) { this.select('clip-landmark').value = this.landmarkId; return; } this.landmarkId = this.select('clip-landmark').value; this.pointFields(); this.pose.select(this.landmarkId); };
    this.button('clip-pose-save', () => this.change('Sửa điểm pose', doc => updateSlotPose(doc, this.clipId, this.slotId, { [this.landmarkId]: { x: Number(this.input('clip-pose-x').value), y: Number(this.input('clip-pose-y').value) } })));
    this.button('clip-pose-reset', () => this.change('Pose theo mẫu', doc => resetSlotPose(doc, this.clipId, this.slotId)));
    this.select('clip-provider').onchange = () => this.updateGate();
    this.button('clip-generate', () => this.generate());
  }
  /** Selected provider as raw string; DeepSeek stays selectable but unsupported for clip image context. */
  private get clipProvider(): unknown { return this.select('clip-provider').value; }
  /** Copy the main provider when it is active; otherwise keep the current clip selection (no fallback). */
  private adoptProvider(mainProvider: unknown): void {
    const next = isActiveAiProvider(mainProvider) ? mainProvider : this.clipProvider;
    this.select('clip-provider').value = next === 'deepseek' ? 'deepseek' : 'codex';
  }
  /** Clip image context is Codex-only; reject anything else instead of falling back silently. */
  private requireCodexProvider(): 'codex' {
    if (this.clipProvider !== 'codex') throw new Error(DEEPSEEK_CLIP_REASON);
    return 'codex';
  }
  async open(profileId?: string, clipId?: string): Promise<void> {
    const doc = this.session.doc; if (!doc) throw new Error('Mở dự án trước khi chỉnh animation.');
    const ticket = ++this.opening, assetId = this.session.assetId, frameId = this.session.frameId;
    const pending = this.options.prepare(), version = this.session.version;
    try { await pending; } catch (e) { if (ticket === this.opening && this.session.doc === doc) this.fail(e); return; }
    if (ticket !== this.opening || this.session.doc !== doc || this.session.version !== version || this.session.assetId !== assetId || this.session.frameId !== frameId) return;
    if (profileId) this.profileId = profileId;
    if (clipId) {
      const clip = doc.studio?.clips?.[clipId]; if (!clip) throw new Error('Clip nguồn đã bị xóa; chọn hoặc tạo clip khác.');
      this.clipId = clip.id; this.profileId = clip.characterId; this.creating = false;
    }
    this.select('clip-provider').value = (document.getElementById('provider') as HTMLSelectElement | null)?.value ?? 'codex';
    this.draft = false; this.status(''); if (!this.dialog.open) this.dialog.showModal(); this.refresh();
  }
  close(): void { if (this.posting) return; this.reset(); }
  reset(): void {
    this.opening++; this.ticket++; this.action++; this.busy = false; this.posting = false; this.draft = false; this.composing = false;
    this.loaded = undefined; this.ready = false; this.stamp = ''; this.pose.reset(); this.timeline.reset(); if (this.dialog.open) this.dialog.close();
  }
  private refresh(): void { this.stamp = ''; this.update(); }
  update(): void {
    if (!this.dialog.open || this.mutating) return;
    this.updateGate(); if (this.editingFields) return;
    const doc = this.session.doc; if (!doc) { this.reset(); return; }
    const stamp = `${doc.id}:${this.session.version}:${doc.revision}:${this.profileId}:${this.clipId}:${this.slotId}`;
    if (stamp === this.stamp) return; this.stamp = stamp;
    const profiles = Object.values(doc.studio?.characters ?? {});
    if (!profiles.some(p => p.id === this.profileId)) this.profileId = profiles.find(p => p.approved)?.id ?? profiles[0]?.id ?? '';
    this.select('clip-profile').replaceChildren(option('', 'Chọn nhân vật…'), ...profiles.map(p => option(p.id, `${p.name}${p.approved ? '' : ' · chưa duyệt'}`)));
    this.select('clip-profile').value = this.profileId;
    const clips = Object.values(doc.studio?.clips ?? {}).filter(c => c.characterId === this.profileId);
    if (!clips.some(c => c.id === this.clipId)) this.clipId = this.creating ? '' : clips[0]?.id ?? '';
    this.select('clip-list').replaceChildren(option('', '+ Clip mới'), ...clips.map(c => option(c.id, c.name))); this.select('clip-list').value = this.clipId;
    const clip = this.clip;
    this.el('clip-properties').hidden = !clip; this.el('clip-slot-tools').hidden = !clip; this.el('clip-generate-panel').hidden = !clip;
    this.el('clip-create-form').hidden = !!clip;
    this.maskInfo(); this.loaded = undefined; this.ready = false; this.createReady = false; this.pose.reset();
    if (!this.profile) { this.status('Tạo và duyệt hồ sơ ở mục Nhân vật trước.'); this.timeline.reset(); this.updateGate(); return; }
    if (clip) {
      if (!clip.slots.some(s => s.id === this.slotId)) this.slotId = clip.slots[0].id;
      this.input('clip-name').value = clip.name; this.input('clip-loop').checked = clip.loop; this.select('clip-facing').value = clip.facing;
      const slot = this.slot!;
      this.input('clip-slot-selected').checked = slot.selected; this.input('clip-slot-selected').disabled = slot.frozen;
      this.input('clip-slot-frozen').checked = slot.frozen; this.input('clip-slot-keyframe').checked = slot.keyframe;
      this.input('clip-slot-duration').value = String(slot.duration);
      this.el<HTMLButtonElement>('clip-mask-replace').disabled = clip.mode !== 'region';
      const keys = new Map(clip.slots.map(s => { const r = doc.studio?.resources?.[s.rgbaResourceId]; return [s.rgbaResourceId, `${doc.id}:${s.rgbaResourceId}:${r?.blob ?? this.session.version}`]; }));
      const owner = doc, version = this.session.version;
      this.timeline.show(clip, this.slotId, keys, this.profile.source.w, this.profile.source.h, async id => {
        const res = await this.session.loadResource(id);
        return this.session.doc === owner && this.session.version === version ? res?.data ?? owner.studio?.resources?.[id]?.data : undefined;
      }, id => { if (this.guardDraft()) { this.slotId = id; this.refresh(); } });
      this.select('clip-landmark').replaceChildren(...Object.entries(this.profile.landmarks).map(([id, p]) => option(id, p.name)));
      if (!Object.hasOwn(this.profile.landmarks, this.landmarkId)) this.landmarkId = Object.keys(this.profile.landmarks)[0] ?? '';
      this.select('clip-landmark').value = this.landmarkId; this.pointFields();
    } else this.timeline.reset();
    this.updateGate(); this.run(() => this.loadView());
  }
  updateGate(): void {
    if (!this.dialog.open) return;
    const locked = this.busy || this.posting;
    this.pose.setInteractionLocked(locked);
    this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(el => { if (el.id !== 'clip-close') el.disabled = locked; });
    const blocked = this.busy || this.posting || this.session.conflict;
    const providerUnsupported = this.clipProvider !== 'codex';
    this.el('clip-provider-info').textContent = providerUnsupported ? DEEPSEEK_CLIP_REASON : '';
    this.el<HTMLButtonElement>('clip-close').disabled = this.posting;
    this.el<HTMLButtonElement>('clip-create-submit').disabled = blocked || !this.createReady;
    this.el<HTMLButtonElement>('clip-generate').disabled = blocked || providerUnsupported || !this.ready || !this.clip || this.pose.dragging || this.draft || this.composing;
    const clip = this.clip, slot = this.slot, index = clip?.slots.findIndex(s => s.id === this.slotId) ?? -1;
    this.input('clip-slot-selected').disabled = locked || !slot || slot.frozen;
    this.el<HTMLButtonElement>('clip-slot-capture').disabled = locked || !slot || slot.frozen;
    this.el<HTMLButtonElement>('clip-slot-add').disabled = locked || !clip || clip.slots.length >= 24;
    this.el<HTMLButtonElement>('clip-slot-duplicate').disabled = locked || !slot || (clip?.slots.length ?? 24) >= 24;
    this.el<HTMLButtonElement>('clip-slot-remove').disabled = locked || !clip || clip.slots.length <= 2;
    this.el<HTMLButtonElement>('clip-slot-prev').disabled = locked || index <= 0;
    this.el<HTMLButtonElement>('clip-slot-next').disabled = locked || index < 0 || index === (clip?.slots.length ?? 0) - 1;
    this.el<HTMLButtonElement>('clip-mask-replace').disabled = locked || clip?.mode !== 'region';
    const pointLocked = locked || !slot?.pose[this.landmarkId] || slot.frozen;
    for (const id of ['clip-pose-x', 'clip-pose-y', 'clip-pose-save', 'clip-pose-reset']) (this.el(id) as HTMLInputElement | HTMLButtonElement).disabled = pointLocked;
    const n = this.clip?.slots.filter(s => s.selected && !s.frozen).length ?? 0;
    this.el('clip-generate-info').textContent = this.session.conflict ? 'Có xung đột; giữ bản nháp và xử lý trước khi tạo.' : `${n}/${this.clip?.slots.length ?? 0} frame sẽ được tạo lại. Các frame khác giữ nguyên. ${this.clip?.mode === 'region' ? 'Pixel ngoài vùng khóa được giữ chính xác.' : 'Toàn nhân vật: xem lại tỷ lệ, màu và điểm tiếp đất.'}`;
  }
  private pointFields(): void {
    const point = this.slot?.pose[this.landmarkId];
    this.input('clip-pose-x').value = String(point?.x ?? 0); this.input('clip-pose-y').value = String(point?.y ?? 0);
    this.input('clip-pose-x').max = String((this.profile?.source.w ?? 1) - 1); this.input('clip-pose-y').max = String((this.profile?.source.h ?? 1) - 1);
    this.el<HTMLButtonElement>('clip-pose-save').disabled = !point || !!this.slot?.frozen;
  }
  private selection(): Uint32Array {
    const p = this.profile, context = this.options.getSelectionContext();
    if (!p || context.assetId !== p.source.assetId || context.frameId !== p.source.frameId || context.w !== p.source.w || context.h !== p.source.h
      || !context.selection || context.selection.length !== context.w * context.h || !context.selection.some(v => v === 1)) throw new Error('Chọn vùng chuyển động trên đúng frame nguồn đã duyệt trước. Vùng cần gồm cả vị trí cũ và mới.');
    return Uint32Array.from(context.selection);
  }
  private maskInfo(): void {
    let text = 'Toàn nhân vật: AI có thể thay đổi mọi pixel; cần duyệt kết quả.';
    if (this.select('clip-mode').value === 'region') {
      try { const mask = this.selection(); text = `${mask.reduce((n, p) => n + p, 0)} pixel được phép sửa. Xác nhận overlay khi tạo clip.`; }
      catch (e) { text = (e as Error).message; }
    }
    this.el('clip-mask-info').textContent = text;
  }
  private async loadView(): Promise<void> {
    const doc = this.session.doc!, version = this.session.version, p = this.profile!, clip = this.clip, slot = this.slot, ticket = ++this.ticket;
    const current = () => this.dialog.open && this.session.doc === doc && this.session.version === version && this.profile === p && this.clip === clip && this.slot === slot && this.ticket === ticket;
    try {
      const asset = doc.assets.find(a => a.id === p.source.assetId); if (!asset) throw new Error('Asset nguồn đã mất.');
      await this.session.loadFrame(p.source.frameId, asset); if (!current()) return;
      const source = composite(asset, p.source.frameId).data;
      const masterRes = await this.session.loadResource(p.source.rgbaResourceId); if (!current()) return;
      const master = masterRes?.data ?? doc.studio?.resources?.[p.source.rgbaResourceId]?.data; if (!master) throw new Error('Chưa nạp được mẫu chuẩn.');
      let pixels = master, mask: Uint32Array | undefined, previous: Uint32Array | undefined, next: Uint32Array | undefined;
      if (slot) { const res = await this.session.loadResource(slot.rgbaResourceId); if (!current()) return; const data = res?.data ?? doc.studio?.resources?.[slot.rgbaResourceId]?.data; if (!data) throw new Error('Chưa nạp được frame clip.'); pixels = data; }
      if (clip?.movementMaskResourceId) { const res = await this.session.loadResource(clip.movementMaskResourceId); if (!current()) return; mask = res?.data ?? doc.studio?.resources?.[clip.movementMaskResourceId]?.data; if (!mask) throw new Error('Chưa nạp được vùng chuyển động.'); }
      if (!clip && this.select('clip-mode').value === 'region') { try { mask = this.selection(); } catch { /* Selection instructions remain visible. */ } }
      if (clip && slot && this.input('clip-onion').checked) {
        const i = clip.slots.indexOf(slot);
        if (i > 0) { const id = clip.slots[i - 1].rgbaResourceId; const res = await this.session.loadResource(id); if (!current()) return; previous = res?.data ?? doc.studio?.resources?.[id]?.data; }
        if (i + 1 < clip.slots.length) { const id = clip.slots[i + 1].rgbaResourceId; const res = await this.session.loadResource(id); if (!current()) return; next = res?.data ?? doc.studio?.resources?.[id]?.data; }
      }
      const sourceStatus = checkCharacterReadiness({ profile: p, sourceResourceData: master, currentComposite: source,
        currentWidth: asset.w, currentHeight: asset.h, currentPalette: asset.palette, currentPivot: resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h) });
      this.createReady = sourceStatus.status === 'ready';
      const readiness = clip ? checkClipReadiness(clip, doc, { sourceResourceData: master, currentComposite: source, currentWidth: asset.w,
        currentHeight: asset.h, currentPalette: asset.palette, currentPivot: resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h), movementMaskData: mask }) : undefined;
      this.ready = !!readiness?.ready; this.loaded = { master, pixels, mask, previous, next };
      if (!this.draft) this.status(readiness?.reason ?? (sourceStatus.status === 'ready' ? 'Mẫu đã duyệt sẵn sàng. Pose là hướng dẫn; hãy duyệt chuyển động AI.' : sourceStatus.reason ?? 'Cần duyệt lại mẫu.'));
      this.el('clip-source-info').textContent = `${p.name} · ${asset.name} · frame ${asset.frames.findIndex(f => f.id === p.source.frameId) + 1} · ${p.source.w}×${p.source.h} · Neo ${p.source.pivot.x}, ${p.source.pivot.y}`;
      this.pose.show({ w: p.source.w, h: p.source.h, pixels, previous, next, mask, pivot: p.source.pivot,
        points: slot?.pose ?? Object.fromEntries(Object.entries(p.landmarks).map(([id, point]) => [id, { x: point.x, y: point.y }])),
        names: Object.fromEntries(Object.entries(p.landmarks).map(([id, point]) => [id, point.name])), links: p.links, locked: !slot || slot.frozen,
        onion: this.input('clip-onion').checked, onSelect: id => { if (!current()) return; this.landmarkId = id; this.select('clip-landmark').value = id; this.pointFields(); },
        onGesture: () => { if (current()) this.updateGate(); },
        onCommit: (id, point) => { if (current()) this.run(() => this.change('Kéo điểm pose', d => updateSlotPose(d, clip!.id, slot!.id, { [id]: point }))); } });
      this.pose.select(this.landmarkId); this.updateGate();
    } catch (e) { if (current()) { this.loaded = undefined; this.ready = false; this.createReady = false; this.pose.reset(); this.fail(e); this.updateGate(); } }
  }
  private change(label: string, fn: (doc: PixelDocument) => unknown): void {
    if (this.busy || this.posting || !this.session.doc) return;
    if (this.composing) { this.status('Hoàn tất nhập tiếng Việt trước khi áp dụng thao tác.'); return; }
    const hadDraft = this.draft;
    const fields = ['clip-name', 'clip-slot-duration', 'clip-pose-x', 'clip-pose-y'].map(id => [id, this.input(id).value] as const);
    this.draft = false; this.mutating = true;
    try {
      this.session.change(label, () => {
        if (hadDraft && this.clip) {
          if (this.input('clip-name').value !== this.clip.name) renameClip(this.session.doc!, this.clipId, this.input('clip-name').value);
          if (this.slot && Number(this.input('clip-slot-duration').value) !== this.slot.duration) setSlotDuration(this.session.doc!, this.clipId, this.slotId, Number(this.input('clip-slot-duration').value));
          const point = this.slot?.pose[this.landmarkId];
          const x = Number(this.input('clip-pose-x').value), y = Number(this.input('clip-pose-y').value);
          if (point && (point.x !== x || point.y !== y)) updateSlotPose(this.session.doc!, this.clipId, this.slotId, { [this.landmarkId]: { x, y } });
        }
        fn(this.session.doc!);
      });
    } catch (error) {
      this.mutating = false; this.refresh();
      if (hadDraft) { for (const [id, value] of fields) this.input(id).value = value; this.draft = true; }
      throw error;
    } finally { this.mutating = false; if (!this.draft) this.refresh(); }
  }
  private async undo(redo = false): Promise<void> {
    if (this.posting || this.busy) return;
    this.draft = false; this.pose.cancel(); this.mutating = true;
    try { await this.session.undo(redo); } finally { this.mutating = false; this.refresh(); }
  }
  private async create(): Promise<void> {
    if (this.busy || this.posting || !this.profile || !this.createReady) return;
    const doc = this.session.doc!, p = this.profile, version = this.session.version, action = ++this.action;
    const mode = this.select('clip-mode').value as ClipMode;
    const mask = mode === 'region' ? this.selection() : undefined;
    if (mask && !confirm(`Cho phép AI sửa ${mask.reduce((n, v) => n + v, 0)} pixel của vùng đã chọn? Ngoài vùng sẽ được giữ nguyên.`)) return;
    const settings = { name: this.input('clip-new-name').value, characterId: p.id, mode, movementMaskSelection: mask,
      template: this.select('clip-template').value as ActionTemplate, slotCount: Number(this.input('clip-count').value), slotDuration: Number(this.input('clip-new-duration').value) };
    this.busy = true; this.updateGate();
    try {
      await this.options.navigateToSource(p.source.assetId, p.source.frameId);
      if (this.action !== action || this.session.doc !== doc || this.session.version !== version || !this.dialog.open || this.session.conflict) return;
      const master = await this.session.loadResource(p.source.rgbaResourceId);
      if (this.action !== action || this.session.doc !== doc || this.session.version !== version || !this.dialog.open || this.session.conflict) return;
      if (!master?.data) throw new Error('Chưa nạp mẫu nguồn.');
      this.busy = false; this.change('Tạo clip nhân vật', d => { const clip = createClip(d, settings); this.creating = false; this.clipId = clip.id; this.slotId = clip.slots[0].id; });
      this.dialog.querySelector<HTMLElement>('.clip-inspector')!.scrollTop = 0;
      this.el('clip-name').focus({ preventScroll: true });
    } finally { if (this.action === action) { this.busy = false; this.updateGate(); } }
  }
  private async capture(): Promise<void> {
    if (!this.clip || !this.slot || this.slot.frozen || this.busy || this.posting) return;
    const doc = this.session.doc!, version = this.session.version, clipId = this.clipId, slotId = this.slotId, context = this.options.getSelectionContext(), action = ++this.action;
    if (!confirm('Thay pixel nền của frame clip bằng frame đang vẽ? Có thể hoàn tác.')) return;
    this.busy = true; this.updateGate();
    try {
      const asset = doc.assets.find(a => a.id === context.assetId); if (!asset) throw new Error('Không có frame đang vẽ.');
      await this.session.loadFrame(context.frameId, asset);
      if (this.action !== action || this.session.doc !== doc || this.session.version !== version || this.clipId !== clipId || this.slotId !== slotId || !this.dialog.open || this.session.conflict) return;
      this.busy = false; this.change('Chụp frame vẽ vào clip', d => captureNativeFrameToSlot(d, clipId, slotId, asset.id, context.frameId));
    } finally { if (this.action === action) { this.busy = false; this.updateGate(); } }
  }
  private async generate(): Promise<void> {
    if (!this.ready || !this.clip || !this.profile || this.busy || this.posting || this.draft || this.composing) return;
    const provider = this.requireCodexProvider();
    const doc = this.session.doc!, clipId = this.clipId, p = this.profile, version = this.session.version, action = ++this.action;
    const prompt = this.el<HTMLTextAreaElement>('clip-motion').value.trim(); if (!prompt) throw new Error('Nhập mô tả chuyển động trước.');
    this.posting = true; this.updateGate();
    try {
      await this.options.navigateToSource(p.source.assetId, p.source.frameId);
      if (this.action !== action || this.session.doc !== doc || this.session.version !== version || !this.dialog.open || this.session.conflict) return;
      await this.session.flush();
      if (this.action !== action || this.session.doc !== doc || this.session.version !== version || !this.dialog.open || this.session.conflict) return;
      await this.options.start({ clipGeneration: { clipId }, clipPaletteMode: this.select('clip-palette').value as 'asset' | 'auto16', prompt, provider, expectedSource: { projectId: doc.id, revision: doc.revision,
        assetId: p.source.assetId, frameId: p.source.frameId, w: p.source.w, h: p.source.h } });
      if (this.action === action && this.session.doc === doc) { this.posting = false; this.close(); }
    } finally { if (this.action === action) { this.posting = false; this.updateGate(); } }
  }
}
