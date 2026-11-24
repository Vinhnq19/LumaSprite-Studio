import { Session } from './session.ts';
import { composite, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { createRecipeRenderer, type RecipeResources } from '../../src/studio/quality/renderer.ts';
import { compileMotionRecipe, type CompiledMotion } from '../../src/studio/quality/motion-render.ts';
import { assertMotionArtwork } from '../../src/studio/quality/motion-art.ts';
import { sampleMotionPlayback } from '../../src/studio/quality/playback.ts';
import { validateAssetRecipe, type AssetRecipe } from '../../src/studio/quality/recipe.ts';
import type { MotionRig } from '../../src/studio/quality/motion.ts';
import type { QualityProjectApproval } from '../../src/studio/quality/project.ts';
import './quality-source-review.css';

interface ReviewOptions {
  session: Session; prepare: () => Promise<void>;
  writeRevision: (path: string, value: Record<string, unknown>) => Promise<any>;
  onSaved: (doc: PixelDocument, assetId?: string, frameId?: string) => Promise<void>;
  projectLock: (enter: boolean) => void; onError: (error: unknown) => void;
}
interface MotionDraft { version: 1; recipe: unknown; rig: unknown; plan: unknown; resources: QualityProjectApproval['resources']; movementMaskResourceId: string | null; frozenFrames: { frameId: string; sourceFrameId: string }[] }
const option = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
function picture(canvas: HTMLCanvasElement, pixels: Uint32Array, w: number, h: number, zoom: number): void {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((c, i) => { data[i * 4] = c >>> 24; data[i * 4 + 1] = c >>> 16 & 255; data[i * 4 + 2] = c >>> 8 & 255; data[i * 4 + 3] = c & 255; });
  canvas.width = w; canvas.height = h; canvas.style.width = w * zoom + 'px'; canvas.style.height = h * zoom + 'px';
  const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.putImageData(new ImageData(data, w, h), 0, 0);
}
export class QualitySourceReviewController {
  readonly dialog = document.createElement('dialog');
  private options: ReviewOptions; private draft?: MotionDraft; private compiled?: CompiledMotion; private base?: AssetRecipe;
  private resources?: RecipeResources; private source?: Uint32Array; private sourceScope?: { project: string; revision: number; asset: string; frame: string };
  private movementMask?: Uint8Array; private frozen = new Map<string, Uint32Array>();
  private ticket = 0; private saving = false; private timer?: ReturnType<typeof setTimeout>; private resolve?: (a: QualityProjectApproval | undefined) => void;
  constructor(options: ReviewOptions) {
    this.options = options; this.dialog.id = 'quality-source-review'; this.dialog.className = 'large-workspace';
    this.dialog.setAttribute('aria-labelledby', 'quality-review-title');
    this.dialog.innerHTML = `<div class="workspace-header"><h2 id="quality-review-title">Duyệt nguồn chuyển động</h2><button id="quality-review-close" type="button">Đóng</button></div>
<div class="quality-review-body"><p class="hint">Xem ảnh nguồn, bộ phận/vẽ bù và toàn bộ pose trước khi duyệt. Duyệt nguồn chưa phải nghiệm thu chất lượng animation.</p>
<label>Bộ nguồn đã lưu<select id="quality-review-saved"><option value="">Chọn bản nháp</option></select></label>
<details><summary>Nhập bộ nguồn đã dựng (nâng cao)</summary><label>Bản JSON LumaSprite<input id="quality-review-file" type="file" accept=".json,application/json"></label><p class="hint">Gồm recipe, rig, plan và ID tài nguyên trong dự án này. Có thể dựng trực tiếp qua bảng Dựng rig. Không nhận mã chạy hoặc tự chuyển landmark thành rig.</p></details>
<p id="quality-review-error" role="alert"></p><p id="quality-review-info" role="status"></p>
<div class="row wrap"><label>Bộ phận<select id="quality-review-part"><option value="">Tất cả bộ phận</option></select></label><label>Frame<select id="quality-review-frame"></select></label><button id="quality-review-play" type="button">Phát pose</button><label>Phóng<select id="quality-review-zoom"><option>1</option><option>2</option><option selected>4</option><option>8</option></select></label></div>
<label><input id="quality-review-bones" type="checkbox" checked>Hiện xương/điểm gắn (không xuất ảnh)</label>
<label><input id="quality-review-mask" type="checkbox">Tô vùng được phép sửa (không xuất ảnh)</label>
<div class="compare"><figure><figcaption>Nguồn đang chọn · kích thước gốc</figcaption><div class="proposal-image"><canvas id="quality-review-source"></canvas></div></figure><figure><figcaption>Bộ phận / pose được điều khiển</figcaption><div class="proposal-image"><canvas id="quality-review-pose"></canvas></div></figure></div>
<figure id="quality-review-locked-view" hidden><figcaption>Frame nguồn bị khóa · phải giữ nguyên RGBA</figcaption><div class="proposal-image"><canvas id="quality-review-locked"></canvas></div></figure>
<p id="quality-review-part-info" class="hint"></p><pre id="quality-review-parts" class="hint"></pre>
<label><input id="quality-review-source-ok" type="checkbox">Tôi duyệt ảnh nguồn và palette này.</label>
<label><input id="quality-review-parts-ok" type="checkbox">Tôi đã xem các bộ phận/vẽ bù và chấp nhận chúng.</label>
<label><input id="quality-review-pose-ok" type="checkbox">Tôi đã xem pose, timing, điểm gắn và vùng/frame khóa.</label>
<button id="quality-review-approve" class="primary" type="button" disabled>Duyệt bộ nguồn chuyển động</button></div>`;
    document.body.append(this.dialog);
    this.el<HTMLButtonElement>('close').onclick = () => this.close();
    this.dialog.addEventListener('cancel', e => { e.preventDefault(); if (!this.saving) this.close(); });
    this.el<HTMLInputElement>('file').onchange = () => void this.importFile().catch(e => this.error(e));
    this.el<HTMLSelectElement>('saved').onchange = () => {
      const a = this.options.session.doc?.studio?.quality?.approvals[this.el<HTMLSelectElement>('saved').value];
      if (a) void this.load({ version: 1, recipe: a.recipe, rig: a.rig, plan: a.plan, resources: a.resources, movementMaskResourceId: a.movementMaskResourceId, frozenFrames: a.frozenFrames.map(f => ({ frameId: f.frameId, sourceFrameId: f.sourceFrameId })) }).catch(e => this.error(e));
    };
    for (const name of ['part', 'frame', 'zoom', 'bones', 'mask']) this.el(name).addEventListener('change', () => { this.stop(); this.draw(); });
    for (const name of ['source-ok', 'parts-ok', 'pose-ok']) this.el(name).addEventListener('change', () => this.updateGate());
    this.el<HTMLButtonElement>('play').onclick = () => { if (this.timer) this.stop(); else this.play(); };
    this.el<HTMLButtonElement>('approve').onclick = () => void this.approve().catch(e => this.error(e));
  }
  private el<T extends HTMLElement = HTMLElement>(name: string): T { return this.dialog.querySelector('#quality-review-' + name)! as T; }
  private current(): boolean { const s = this.sourceScope, doc = this.options.session.doc; return !!s && doc?.id === s.project && doc.revision === s.revision && !this.options.session.dirty && !this.options.session.conflict; }
  private error(value: unknown): void { this.el('error').textContent = (value as Error).message ?? String(value); this.options.onError(value); this.updateGate(); }
  async open(initial?: MotionDraft): Promise<QualityProjectApproval | undefined> {
    if (this.dialog.open) throw Error('Bảng duyệt nguồn đang mở.');
    await this.options.prepare(); const { doc, asset, frame } = this.options.session;
    if (!doc || !asset || !frame) throw Error('Chọn asset/frame nguồn trước.');
    this.sourceScope = { project: doc.id, revision: doc.revision, asset: asset.id, frame: frame.id }; this.source = composite(asset, frame.id).data.slice();
    this.draft = undefined; this.compiled = undefined; this.base = undefined; this.resources = undefined; this.movementMask = undefined; this.frozen.clear(); this.ticket++;
    this.el('locked-view').hidden = true; this.el<HTMLInputElement>('mask').checked = false;
    this.el('error').textContent = ''; this.el('info').textContent = `${asset.name} · ${asset.w}×${asset.h} · cần chọn bộ nguồn để xem trước`;
    for (const name of ['source-ok', 'parts-ok', 'pose-ok']) this.el<HTMLInputElement>(name).checked = false;
    const list = this.el<HTMLSelectElement>('saved'); list.replaceChildren(option('', 'Chọn bộ nguồn đã dựng'));
    for (const a of Object.values(doc.studio?.quality?.approvals ?? {})) if (a.kind === 'motion') list.append(option(a.id, `${a.recipe.name} · ${a.recipe.frames.length} frame · bản nháp từ r${a.revision}`));
    picture(this.el('source'), this.source, asset.w, asset.h, 4); this.el<HTMLCanvasElement>('pose').width = 1;
    this.updateGate(); this.dialog.showModal();
    const result = new Promise<QualityProjectApproval | undefined>(resolve => { this.resolve = resolve; });
    const scope = this.sourceScope;
    if (initial) void this.load(initial).catch(e => { if (this.dialog.open && this.sourceScope === scope) this.error(e); });
    return result;
  }
  private async importFile(): Promise<void> {
    const file = this.el<HTMLInputElement>('file').files?.[0]; if (!file) return;
    if (file.size > 5_000_000) throw Error('Bộ nguồn JSON tối đa 5 MB.');
    const ticket = this.ticket, value = JSON.parse(await file.text()); if (ticket !== this.ticket || !this.dialog.open) return;
    await this.load(value);
  }
  private async load(value: MotionDraft): Promise<void> {
    this.stop(); this.draft = undefined; this.compiled = undefined; this.base = undefined; this.movementMask = undefined; this.frozen.clear(); this.el('locked-view').hidden = true; this.updateGate(); this.el('error').textContent = '';
    const ticket = ++this.ticket, session = this.options.session;
    if (!this.current() || !session.asset || !this.sourceScope || !this.source) throw Error('Nguồn đã đổi; đóng và mở lại bảng duyệt.');
    if (!value || value.version !== 1 || !value.recipe || !value.rig || !value.plan || !value.resources || !Array.isArray(value.resources.sources) || !Array.isArray(value.resources.masks) || value.resources.sources.length > 256 || value.resources.masks.length > 256 || !Array.isArray(value.frozenFrames)) throw Error('Bộ nguồn không đúng định dạng recipe/rig/plan/mapping.');
    const source = this.source, a = session.asset, w = a.w, h = a.h, bound = structuredClone(value);
    const resource = async (key: string, kind: 'rgba' | 'mask') => { const r = await session.loadResource(key); if (!r?.data || r.kind !== kind) throw Error('Thiếu tài nguyên ' + key + ' đúng loại ' + kind); return r; };
    const sources = await Promise.all(bound.resources.sources.map(async b => { const r = await resource(b.resourceId, 'rgba'); return { id: b.id, w: r.w, h: r.h, pixels: r.data!.slice() }; }));
    const masks = await Promise.all(bound.resources.masks.map(async b => { const r = await resource(b.resourceId, 'mask'); return { id: b.id, w: r.w, h: r.h, data: Uint8Array.from(r.data!) }; }));
    const resources = { sources, masks }, context = { sources: sources.map(({ id, w, h }) => ({ id, w, h })), masks: masks.map(({ id, w, h }) => ({ id, w, h })) };
    const recipe = validateAssetRecipe(bound.recipe, context), pivot = a.metadata.pivot ? { x: a.metadata.pivot.x * w, y: a.metadata.pivot.y * h } : { x: w / 2, y: h };
    if (recipe.canvas.w !== w || recipe.canvas.h !== h || JSON.stringify(recipe.palette) !== JSON.stringify([...new Set(a.palette.filter(c => (c & 255) === 255))]) || recipe.pivot.x !== pivot.x || recipe.pivot.y !== pivot.y) throw Error('Canvas, palette hoặc điểm neo khác nguồn. Chuẩn hóa bản sao hoặc chỉnh bộ nguồn rồi thử lại.');
    if (w * h * recipe.frames.length > 8_000_000) throw Error('Clip vượt giới hạn review 8 triệu pixel.');
    const rest = createRecipeRenderer(recipe, resources).renderFrame(recipe.frames[0].id).image.data;
    if (rest.some((c, i) => c !== source[i])) throw Error('Bộ phận ở tư thế nghỉ không ghép lại đúng RGBA nguồn; chưa được duyệt.');
    const bytes = new Uint8Array(source.length * 4), view = new DataView(bytes.buffer); source.forEach((c, i) => view.setUint32(i * 4, c, false));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    const rig = bound.rig as MotionRig; rig.source = { projectId: this.sourceScope.project, assetId: a.id, frameId: this.sourceScope.frame, revision: this.sourceScope.revision, rgbaSha256: hash, canvas: { w, h }, pivot };
    const compiled = compileMotionRecipe(recipe, rig, bound.plan, context);
    assertMotionArtwork(compiled, resources);
    let movementMask: Uint8Array | undefined;
    if (bound.movementMaskResourceId !== null) {
      const r = await resource(bound.movementMaskResourceId, 'mask');
      if (r.w !== w || r.h !== h || r.data!.some(n => n !== 0 && n !== 1) || !r.data!.some(Boolean)) throw Error('Vùng chuyển động phải là mask 0/1 không rỗng, đúng canvas.');
      movementMask = Uint8Array.from(r.data!);
    }
    if (w * h * (bound.frozenFrames.length + 1) > 32_000_000) throw Error('Frame khóa vượt ngân sách 32 triệu pixel.');
    const frozen = new Map<string, Uint32Array>();
    for (const f of bound.frozenFrames) {
      if (!recipe.frames.some(k => k.id === f.frameId) || !a.frames.some(k => k.id === f.sourceFrameId) || frozen.has(f.frameId)) throw Error('Frame khóa trùng hoặc không tồn tại.');
      frozen.set(f.frameId, await session.readFrame(f.sourceFrameId, a));
    }
    const renderer = createRecipeRenderer(compiled.recipe, resources);
    for (const f of recipe.frames) {
      const p = renderer.renderFrame(f.id).image.data, locked = frozen.get(f.id);
      if (locked && p.some((c, i) => c !== locked[i])) throw Error(`Pose ${f.id} thay đổi frame đã khóa; sửa bộ nguồn trước khi duyệt.`);
      if (movementMask && p.some((c, i) => !movementMask![i] && c !== source[i])) throw Error(`Pose ${f.id} thay đổi pixel ngoài vùng cho phép; sửa bộ nguồn trước khi duyệt.`);
    }
    if (ticket !== this.ticket || !this.current() || !this.dialog.open) return;
    this.base = recipe; this.resources = resources; this.compiled = compiled; this.movementMask = movementMask; this.frozen = frozen; this.draft = { ...bound, recipe, rig: compiled.rig, plan: compiled.plan };
    this.el<HTMLSelectElement>('part').replaceChildren(option('', 'Tất cả bộ phận'), ...recipe.parts.map(p => option(p.id, `${p.name} · ${{ visible: 'từ mẫu', authored: 'vẽ bù', derived: 'bản sao/chỉnh' }[p.origin]}`)));
    this.el<HTMLSelectElement>('frame').replaceChildren(...recipe.frames.map((f, i) => option(f.id, `${i + 1} · ${f.durationMs} ms${frozen.has(f.id) ? ' · khóa RGBA' : ''}`)));
    this.el('parts').textContent = recipe.parts.map(p => `${p.name}: ${p.origin} · ${p.paint.length} mảng · điểm xoay (${p.pivot.x}, ${p.pivot.y})`).join('\n');
    this.el('info').textContent = `${w}×${h} · ${recipe.frames.length} frame · ${recipe.palette.length} màu · ${bound.movementMaskResourceId ? 'Khóa ngoài mask ' + bound.movementMaskResourceId : 'Toàn nhân vật'} · ${bound.frozenFrames.length} frame khóa`;
    for (const name of ['source-ok', 'parts-ok', 'pose-ok']) this.el<HTMLInputElement>(name).checked = false;
    this.draw(); this.updateGate();
  }
  private draw(): void {
    if (!this.base || !this.compiled || !this.resources || !this.source) return;
    const frame = this.el<HTMLSelectElement>('frame').value, part = this.el<HTMLSelectElement>('part').value, zoom = Number(this.el<HTMLSelectElement>('zoom').value), { w, h } = this.base.canvas;
    const recipe = part ? { ...this.compiled.recipe, parts: this.compiled.recipe.parts.map(p => ({ ...p, paint: p.id === part ? p.paint : [] })) } : this.compiled.recipe;
    try {
      const pixels = createRecipeRenderer(recipe, this.resources).renderFrame(frame).image.data;
      picture(this.el('source'), this.source, w, h, zoom); picture(this.el('pose'), pixels, w, h, zoom);
      const locked = this.frozen.get(frame); this.el('locked-view').hidden = !locked;
      if (locked) picture(this.el('locked'), locked, w, h, zoom);
      if (this.movementMask && this.el<HTMLInputElement>('mask').checked) {
        for (const name of ['source', 'pose']) {
          const ctx = this.el<HTMLCanvasElement>(name).getContext('2d')!; ctx.fillStyle = '#55e2b866';
          this.movementMask.forEach((n, i) => { if (n) ctx.fillRect(i % w, Math.floor(i / w), 1, 1); });
        }
      }
      const geometry = this.compiled.geometry.find(g => g.frameId === frame)!;
      if (this.el<HTMLInputElement>('bones').checked) {
        const ctx = this.el<HTMLCanvasElement>('pose').getContext('2d')!; ctx.strokeStyle = '#ffdb59'; ctx.fillStyle = '#63f5ff'; ctx.lineWidth = 0.4;
        for (const j of this.compiled.rig.joints) { const p = geometry.joints[j.id]; if (j.parentId) { const parent = geometry.joints[j.parentId]; ctx.beginPath(); ctx.moveTo(parent.x, parent.y); ctx.lineTo(p.x, p.y); ctx.stroke(); } ctx.fillRect(p.x - 0.3, p.y - 0.3, 0.6, 0.6); }
      }
      this.el('part-info').textContent = `Sai số khớp ${geometry.maxBoneError.toFixed(3)} px · điểm gắn ${geometry.maxAttachmentError.toFixed(3)} px${locked ? ' · Frame khóa: khớp RGBA nguồn' : ''}${this.movementMask ? ' · Ngoài vùng sửa: khớp RGBA nguồn' : ''}. Overlay chỉ để xem, không xuất vào ảnh.`;
    } catch (e) { this.stop(); this.error(e); }
  }
  private play(): void {
    if (!this.compiled || !this.current()) return;
    this.el('play').textContent = 'Dừng pose';
    const owner = this.compiled, frames = owner.recipe.frames, select = this.el<HTMLSelectElement>('frame');
    const startIndex = Math.max(0, frames.findIndex(f => f.id === select.value)), started = performance.now();
    const tick = () => {
      if (!this.dialog.open || !this.current() || this.compiled !== owner) { this.stop(); return; }
      const stamp = performance.now(), sample = sampleMotionPlayback(frames, stamp - started, owner.recipe.loop, startIndex);
      if (select.value !== frames[sample.index].id) { select.value = frames[sample.index].id; this.draw(); }
      if (sample.done) { this.stop(); return; }
      this.timer = setTimeout(tick, Math.max(1, sample.delayMs - (performance.now() - stamp)));
    };
    tick();
  }
  private stop(): void { clearTimeout(this.timer); this.timer = undefined; this.el('play').textContent = 'Phát pose'; }
  updateGate(): void {
    this.el<HTMLButtonElement>('approve').disabled = this.saving || !this.draft || !this.current() || ['source-ok', 'parts-ok', 'pose-ok'].some(n => !this.el<HTMLInputElement>(n).checked);
    this.el<HTMLButtonElement>('close').disabled = this.saving;
    this.el<HTMLButtonElement>('play').disabled = !this.compiled || !this.current();
    this.el<HTMLInputElement>('mask').disabled = !this.movementMask;
    for (const name of ['file', 'saved', 'source-ok', 'parts-ok', 'pose-ok']) (this.el(name) as HTMLInputElement | HTMLSelectElement).disabled = this.saving;
    if (this.dialog.open && !this.saving && this.sourceScope && !this.current()) { this.stop(); this.el('error').textContent = 'Nguồn đã đổi; đóng và mở lại để xem đúng revision.'; }
  }
  private async approve(): Promise<void> {
    this.updateGate(); if (this.el<HTMLButtonElement>('approve').disabled || !this.sourceScope || !this.draft) return;
    const scope = { ...this.sourceScope }, draft = structuredClone(this.draft); this.saving = true; this.stop(); this.options.projectLock(true); this.updateGate();
    try {
      const accepted = await this.options.writeRevision(`projects/${scope.project}/quality/approvals`, { revision: scope.revision, assetId: scope.asset, frameId: scope.frame, kind: 'motion', sourceApproved: true, poseApproved: true, partsApproved: true, recipe: draft.recipe, rig: draft.rig, plan: draft.plan, resources: draft.resources, movementMaskResourceId: draft.movementMaskResourceId, frozenFrames: draft.frozenFrames });
      if (this.options.session.doc?.id !== scope.project || this.options.session.doc.revision !== scope.revision || this.options.session.dirty || this.options.session.conflict) throw Error('Giữ bản nháp: dự án đổi trong lúc duyệt. Tải lại nguồn mới.');
      await this.options.onSaved(accepted.document, scope.asset, scope.frame);
      this.saving = false; const resolve = this.resolve; this.resolve = undefined; this.close(); resolve?.(accepted.approval);
    } finally { this.saving = false; this.options.projectLock(false); this.updateGate(); }
  }
  close(): void { if (this.saving) return; this.ticket++; this.stop(); this.dialog.close(); this.resolve?.(undefined); this.resolve = undefined; this.resources = undefined; this.source = undefined; this.draft = undefined; this.compiled = undefined; this.base = undefined; this.movementMask = undefined; this.frozen.clear(); }
  resetProject(): void { if (!this.saving) this.close(); }
}
