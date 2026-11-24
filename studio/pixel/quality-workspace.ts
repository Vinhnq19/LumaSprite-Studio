import { Session, api } from './session.ts';
import { sampleMotionPlayback } from '../../src/studio/quality/playback.ts';
import { composite, isLocked, type PixelDocument } from '../../src/studio/pixel/model.ts';
import type { RecipeRect } from '../../src/studio/quality/recipe.ts';
import type { QualityProjectApproval } from '../../src/studio/quality/project.ts';
import type { QualityRun, QualityVariantSummary } from '../../src/studio/quality/run.ts';
import { aiProviderLabel } from '../../src/studio/ai-providers.ts';
import { editQualityVariant } from './quality-retouch.ts';
import './quality-workspace.css';
export interface QualityWorkspaceOptions {
  session: Session; prepare: () => Promise<void>; projectLock: (enter: boolean) => void;
  writeRevision: (path: string, value: Record<string, unknown>) => Promise<any>;
  onSaved: (doc: PixelDocument, assetId?: string, frameId?: string) => Promise<void>;
  onError: (error: unknown) => void; onMotionSource?: () => Promise<QualityProjectApproval | undefined>;
  sourceRegion?: () => RecipeRect | undefined;
}
interface RunInfo extends QualityRun { approvalId: string; previewAvailable: boolean; appliedAssetId?: string }
const running = (r?: QualityRun) => !!r && ['running', 'canceling', 'unknown'].includes(r.status);
const option = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
const roles = { director: 'lập cấu trúc', builder: 'dựng đề xuất', reviewer: 'kiểm tra ảnh' };
const statuses = { running: 'Đang chạy', canceling: 'Đang hủy', unknown: 'Chưa xác nhận dừng', ready: 'Sẵn sàng', failed: 'Lỗi', canceled: 'Đã hủy', succeeded: 'Hoàn thành', invalid: 'Dữ liệu không hợp lệ' };

export class QualityWorkspaceController {
  readonly dialog = document.createElement('dialog');
  private options: QualityWorkspaceOptions; private run?: RunInfo; private jobs: RunInfo[] = []; private project = '';
  private busy = false; private poll?: ReturnType<typeof setInterval>; private polling = false; private playTimer?: ReturnType<typeof setTimeout>;
  private request = 0; private seenTick = performance.now(); private abort = new AbortController();
  private refreshNeeded = false; private warming = false;
  private variantChosen = false;
  private sourceRequest = 0; private drawRequest = 0;
  private frames = new Map<string, ImageBitmap>(); private cacheKey = ''; private source?: { pixels: Uint32Array; w: number; h: number };
  constructor(options: QualityWorkspaceOptions) {
    this.options = options; this.dialog.id = 'quality-workspace'; this.dialog.className = 'large-workspace'; this.dialog.setAttribute('aria-labelledby', 'quality-title');
    this.dialog.innerHTML = `<div class="workspace-header"><div><h2 id="quality-title">Chế độ chất lượng · thử nghiệm</h2><p class="hint">Một phương án · Codex → DeepSeek → Codex · tối đa 15 phút · xem rồi áp dụng</p></div><button id="quality-close" type="button">Quay lại vẽ</button></div>
<div class="quality-body"><aside class="quality-settings"><h3>Nguồn tạo ảnh</h3><p id="quality-context" class="hint"></p>
<label>Nguồn đã duyệt<select id="quality-source"></select></label><label><input id="quality-source-ok" type="checkbox">Tôi duyệt frame đang chọn làm nguồn tĩnh.</label>
<label><input id="quality-source-layers" type="checkbox" disabled>Giữ riêng các layer ảnh đang hiện</label>
<fieldset id="quality-template-fields" hidden><legend>Chỉnh từ mẫu</legend>
<label><input id="quality-template" type="checkbox">Khóa phạm vi chỉnh</label>
<label>Layer được sửa<select id="quality-template-parts" multiple size="4"></select></label>
<p id="quality-template-area" class="hint"></p></fieldset>
<p id="quality-approved-scope" class="hint" hidden></p>
<button id="quality-approve" type="button">Duyệt frame hiện tại</button><button id="quality-motion" type="button">Duyệt nguồn chuyển động…</button>
<p class="hint">Giữ canvas và palette nguồn. Chỉ tạo asset mới; nét vẽ hiện tại được giữ nguyên.</p>
<label>Mô tả<textarea id="quality-prompt" rows="5" maxlength="12000" placeholder="Ví dụ: thay mũ giáp bằng mũ trùm xanh, giữ khuôn mặt và tỷ lệ."></textarea></label>
<p class="hint">RPG/fantasy rõ nét · viền mảnh · sáng trên trái. Skill đang thử nghiệm, chưa đổi mặc định.</p>
<div class="row"><button id="quality-generate" class="primary" type="button">Tạo chất lượng</button><button id="quality-cancel" type="button">Hủy tác vụ</button></div>
<label>Lịch sử<select id="quality-history"></select></label><div class="row"><button id="quality-refresh" type="button">Tải lại</button><button id="quality-delete" type="button">Xóa đề xuất</button></div>
<small>Xóa đề xuất giữ nguyên asset đã áp dụng. Đóng bảng vẫn để tác vụ đang chạy; mở lại để theo dõi hoặc hủy.</small></aside>
<main class="quality-results"><p id="quality-status" role="status">Chọn nguồn và duyệt trước khi tạo.</p><p id="quality-error" role="alert"></p><ol id="quality-calls"></ol>
<div class="row wrap"><label>Bản xem trước<select id="quality-variant"></select></label><label>Frame<select id="quality-frame"></select></label><button id="quality-play" type="button">Phát</button><label>Phóng<select id="quality-zoom"><option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="8">8×</option></select></label></div>
<div class="row"><label><input id="quality-onion" type="checkbox">Onion frame trước</label><label><input id="quality-diff" type="checkbox">Khác biệt với mẫu</label></div>
<div class="compare"><figure><figcaption id="quality-before-label">Frame đang chọn</figcaption><div class="proposal-image"><canvas id="quality-before"></canvas></div></figure><figure><figcaption id="quality-after-label">Đề xuất · kích thước gốc</figcaption><div class="proposal-image"><canvas id="quality-after"></canvas></div></figure></div>
<p id="quality-description"></p><div class="row"><button id="quality-retouch-open" type="button">Sửa nét pixel…</button><button id="quality-apply" class="primary" type="button">Áp dụng thành asset mới</button></div>
<details><summary>Lịch sử từng vai</summary><pre id="quality-history-detail"></pre><label>Kết quả AI<select id="quality-call-select"></select></label><button id="quality-call-read" type="button">Xem JSON đã nhận</button><pre id="quality-raw"></pre></details>
</main></div>`;
    document.body.append(this.dialog);
    this.el<HTMLButtonElement>('close').onclick = () => this.close();
    this.dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.el<HTMLButtonElement>('approve').onclick = () => void this.approveSource().catch(e => this.error(e));
    this.el<HTMLButtonElement>('motion').onclick = () => void this.motionSource().catch(e => this.error(e));
    this.el<HTMLButtonElement>('generate').onclick = () => void this.generate().catch(e => this.error(e));
    this.el<HTMLButtonElement>('cancel').onclick = () => void this.cancel().catch(e => this.error(e));
    this.el<HTMLButtonElement>('apply').onclick = () => void this.apply().catch(e => this.error(e));
    this.el<HTMLButtonElement>('retouch-open').onclick = () => void this.retouch().catch(e => this.error(e));
    this.el<HTMLButtonElement>('refresh').onclick = () => void this.refresh().catch(e => this.error(e));
    this.el<HTMLButtonElement>('delete').onclick = () => void this.remove().catch(e => this.error(e));
    this.el<HTMLSelectElement>('history').onchange = () => { const r = this.jobs.find(r => r.id === this.el<HTMLSelectElement>('history').value); if (r) this.selectRun(r); };
    this.el<HTMLSelectElement>('source').onchange = () => { this.el<HTMLInputElement>('source-ok').checked = false; if (this.run?.approvalId !== this.approval?.id) this.clearRun(); this.source = undefined; void this.sourcePreview().catch(e => this.error(e)); this.updateGate(); };
    this.el<HTMLInputElement>('source-ok').onchange = () => { if (this.el<HTMLInputElement>('source-ok').checked) { this.el<HTMLSelectElement>('source').value = ''; this.clearRun(); void this.sourcePreview().catch(e => this.error(e)); } this.updateGate(); };
    for (const name of ['source-layers', 'template', 'template-parts']) this.el(name).addEventListener('change', () => this.updateGate());
    this.el('prompt').addEventListener('input', () => this.updateGate());
    this.el<HTMLSelectElement>('variant').onchange = () => { this.variantChosen = true; this.clearImages(); this.frameOptions(); void this.preview().catch(e => this.error(e)); this.updateGate(); };
    this.el<HTMLSelectElement>('frame').onchange = () => { this.stop(); void this.preview().catch(e => this.error(e)); };
    for (const name of ['zoom', 'diff', 'onion']) this.el(name).addEventListener('change', () => void this.preview().catch(e => this.error(e)));
    this.el<HTMLButtonElement>('play').onclick = () => void this.play().catch(e => this.error(e));
    this.el<HTMLButtonElement>('call-read').onclick = () => void this.readCall().catch(e => this.error(e));
  }
  private el<T extends HTMLElement = HTMLElement>(name: string): T { return this.dialog.querySelector('#quality-' + name)! as T; }
  private get session() { return this.options.session; }
  private get approval() { return this.session.doc?.studio?.quality?.approvals[this.el<HTMLSelectElement>('source').value]; }
  private get variant(): QualityVariantSummary | undefined { return this.run?.variants.find(v => v.id === this.el<HTMLSelectElement>('variant').value); }
  private current(project = this.project): boolean { return this.session.doc?.id === project && this.dialog.open; }
  private error(e: unknown): void { if ((e as Error).name === 'AbortError') return; this.el('error').textContent = (e as Error).message ?? String(e); this.options.onError(e); this.updateGate(); }
  async open(): Promise<void> {
    if (this.dialog.open) return;
    await this.options.prepare(); if (!this.session.doc || !this.session.asset) throw Error('Mở dự án và chọn asset trước.');
    this.project = this.session.doc.id; this.el('error').textContent = ''; this.dialog.showModal(); this.sources();
    await this.sourcePreview(); await this.refresh(); this.poll = setInterval(() => void this.tick(), 1000); this.updateGate();
  }
  async openForApproval(approval: QualityProjectApproval): Promise<void> {
    await this.open();
    if (!this.current(approval.projectId)) return;
    this.clearRun(); this.sources(approval.id); await this.sourcePreview(); this.updateGate();
  }
  close(): void { if (this.busy) return; this.sourceRequest++; this.stop(); clearInterval(this.poll); this.poll = undefined; this.clearImages(); this.dialog.close(); }
  resetProject(): void {
    if (this.busy) return;
    this.close(); this.run = undefined; this.jobs = []; this.source = undefined; this.project = '';
    this.el<HTMLTextAreaElement>('prompt').value = '';
    this.el<HTMLInputElement>('source-ok').checked = false;
    this.el<HTMLInputElement>('source-layers').checked = false;
    this.el<HTMLInputElement>('template').checked = false;
  }
  private sources(selected = this.el<HTMLSelectElement>('source').value): void {
    const list = this.el<HTMLSelectElement>('source'); list.replaceChildren(option('', 'Chọn nguồn đã duyệt'));
    const layers = this.el<HTMLSelectElement>('template-parts'); layers.replaceChildren();
    const asset = this.session.asset;
    for (const layer of asset?.layers ?? []) {
      if (layer.type === 'image' && layer.visible && !isLocked(asset!, layer) && layer.cels[this.session.frameId]) layers.append(option(layer.id, layer.name));
    }
    for (const a of Object.values(this.session.doc?.studio?.quality?.approvals ?? {})) {
      const label = a.kind === 'motion' ? 'chuyển động' : a.recipe.parts.length > 1 ? `${a.recipe.parts.length} layer` : 'tĩnh';
      const stale = a.revision !== this.session.doc?.revision || a.projectId !== this.project;
      list.append(option(a.id, `${a.recipe.name} · ${label} · r${a.revision}${stale ? ' · cần duyệt lại' : ''}`));
    }
    list.value = selected;
    this.el('context').textContent = this.session.asset ? `${this.session.asset.name} · ${this.session.asset.w}×${this.session.asset.h} · frame ${this.session.asset.frames.findIndex(f => f.id === this.session.frameId) + 1}` : '';
  }
  private async sourcePreview(): Promise<void> {
    const ticket = ++this.sourceRequest, doc = this.session.doc, a = this.approval, asset = this.session.asset, frame = this.session.frameId;
    if (!doc) return;
    let pixels: Uint32Array, w: number, h: number;
    if (a) { const r = await this.session.loadResource(a.source.resourceId); if (!r?.data) throw Error('Nguồn đã duyệt không còn dữ liệu ảnh.'); pixels = r.data; w = r.w; h = r.h; }
    else { await this.session.loadFrame(frame, asset); if (!asset) return; const image = composite(asset, frame); pixels = image.data; w = image.w; h = image.h; }
    if (ticket !== this.sourceRequest || this.session.doc !== doc || !this.current(doc.id)) return;
    this.source = { pixels: pixels.slice(), w, h }; this.el('before-label').textContent = a ? 'Mẫu đã duyệt · r' + a.revision : 'Frame đang chọn · chưa duyệt'; this.paintSource();
  }
  private paintSource(): void {
    if (!this.source) return; const { pixels, w, h } = this.source, c = this.el<HTMLCanvasElement>('before'), data = new Uint8ClampedArray(pixels.length * 4);
    pixels.forEach((v, i) => { data[i * 4] = v >>> 24; data[i * 4 + 1] = v >>> 16 & 255; data[i * 4 + 2] = v >>> 8 & 255; data[i * 4 + 3] = v & 255; });
    c.width = w; c.height = h; c.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0); this.zoom(c);
  }
  private async approveSource(): Promise<void> {
    if (!this.el<HTMLInputElement>('source-ok').checked || this.busy) return;
    const preserveLayers = this.el<HTMLInputElement>('source-layers').checked;
    const scoped = preserveLayers && this.el<HTMLInputElement>('template').checked;
    const region = scoped ? this.options.sourceRegion?.() : undefined;
    const partIds = scoped ? Array.from(this.el<HTMLSelectElement>('template-parts').selectedOptions, option => option.value) : [];
    if (scoped && (!region || !partIds.length || partIds.length > 8)) throw Error('Chọn vùng chữ nhật trên canvas và 1–8 layer để sửa.');
    this.busy = true; this.updateGate(); let locked = false;
    try {
      await this.options.prepare(); const d = this.session.doc!, asset = this.session.assetId, frame = this.session.frameId;
      this.options.projectLock(true); locked = true;
      const result = await this.options.writeRevision(`projects/${d.id}/quality/approvals`, {
        revision: d.revision, assetId: asset, frameId: frame, kind: 'static', sourceApproved: true,
        ...(preserveLayers ? { preserveLayers } : {}),
        ...(region ? { templateScope: { region, partIds } } : {}),
      });
      if (this.session.doc !== d || this.session.dirty || this.session.conflict) throw Error('Nguồn đổi trong lúc duyệt; giữ bản nháp và tải lại.');
      await this.options.onSaved(result.document, asset, frame); this.clearRun(); this.el<HTMLInputElement>('source-ok').checked = false; this.sources(result.approval.id); await this.sourcePreview();
    } finally { this.busy = false; if (locked) this.options.projectLock(false); this.updateGate(); }
  }
  private async motionSource(): Promise<void> { if (this.busy || !this.options.onMotionSource) return; const a = await this.options.onMotionSource(); if (a && this.current()) { this.clearRun(); this.sources(a.id); await this.sourcePreview(); this.updateGate(); } }
  private async generate(): Promise<void> {
    this.updateGate(); if (this.el<HTMLButtonElement>('generate').disabled) return;
    this.busy = true; this.el('error').textContent = ''; this.updateGate();
    try { await this.options.prepare(); const d = this.session.doc!, approvalId = this.approval!.id; const run = await api(`projects/${d.id}/quality-runs`, 'POST', { revision: d.revision, approvalId, prompt: this.el<HTMLTextAreaElement>('prompt').value }); if (this.current(d.id)) { this.jobs.unshift(run); this.historyOptions(); this.selectRun(run); } }
    finally { this.busy = false; this.updateGate(); }
  }
  private historyOptions(): void { const select = this.el<HTMLSelectElement>('history'), selected = this.run?.id; select.replaceChildren(option('', 'Chọn lượt tạo'), ...this.jobs.map(r => option(r.id, `${new Date(r.started).toLocaleTimeString('vi-VN')} · ${statuses[r.status]} · ${r.id.slice(0, 6)}`))); if (selected) select.value = selected; }
  async refresh(): Promise<void> {
    const project = this.project; if (!this.current(project)) return;
    const jobs: RunInfo[] = await api(`projects/${project}/quality-runs`); if (!this.current(project)) return;
    this.jobs = jobs; this.historyOptions(); const next = jobs.find(r => r.id === this.run?.id) ?? jobs.find(r => running(r)) ?? jobs[0]; if (next) this.selectRun(next); else { this.run = undefined; this.renderState(); }
  }
  private selectRun(run: RunInfo): void {
    const changed = this.run?.id !== run.id; if (changed) { this.variantChosen = false; this.clearImages(); } this.run = run; this.seenTick = performance.now();
    this.el<HTMLSelectElement>('history').value = run.id; this.sources(run.approvalId); this.renderState();
    if (changed) { void this.sourcePreview().catch(e => this.error(e)); void this.preview().catch(e => this.error(e)); }
  }
  handleSSE(run: QualityRun): void { if (!this.current(run.projectId) || this.run?.id !== run.id) return; this.run = { ...this.run, ...run }; this.refreshNeeded = true; this.seenTick = performance.now(); this.renderState(); }
  private async tick(): Promise<void> {
    if (!this.current() || this.polling || this.busy) return; this.polling = true;
    try { if (this.run && (running(this.run) || this.refreshNeeded)) { const project = this.project, id = this.run.id, run = await api(`projects/${project}/quality-runs/${id}`); if (this.current(project) && this.run?.id === id) { this.run = run; this.refreshNeeded = false; this.seenTick = performance.now(); this.renderState(); } } else this.renderState(); }
    catch (e) { this.error(e); } finally { this.polling = false; }
  }
  private renderState(): void {
    const r = this.run, state = r ? `${r.status === 'ready' ? r.appliedAssetId ? 'Đã lưu asset mới' : 'Sẵn sàng xem và áp dụng' : statuses[r.status]} · ${Math.round(((r.elapsedMs ?? 0) + (running(r) ? performance.now() - this.seenTick : 0)) / 1000)} giây · ${r.cliCalls}/4 lượt thử · ${r.technicalRepairs}/1 sửa kỹ thuật\n${r.message}${r.revision !== this.session.doc?.revision ? '\nNguồn có revision mới; không áp dụng đề xuất cũ.' : ''}${!r.previewAvailable && r.status === 'ready' ? '\nChỉ còn lịch sử hoặc đã áp dụng; tạo lại để xem đề xuất mới.' : ''}` : 'Duyệt nguồn rồi nhập mô tả.';
    this.el('status').textContent = state; this.el('calls').replaceChildren(...(r?.calls ?? []).map(c => { const li = document.createElement('li'); li.textContent = `${aiProviderLabel(c.provider)} · ${roles[c.role]} · ${statuses[c.status]} · ${Math.round((c.elapsedMs ?? 0) / 1000)}s${c.message ? ' · ' + c.message : ''}`; return li; }));
    this.el('history-detail').textContent = r ? `Nguồn: ${r.approvalId}\nRevision: ${r.revision}\n${r.calls.map(c => `${aiProviderLabel(c.provider)} · ${roles[c.role]}: ${c.status}${c.repair ? ' (sửa kỹ thuật)' : ''}`).join('\n')}` : '';
    const old = this.el<HTMLSelectElement>('variant').value, variantList = this.el<HTMLSelectElement>('variant'), ids = (r?.variants ?? []).map(v => v.id).join();
    if (variantList.dataset.ids !== ids) { variantList.dataset.ids = ids; variantList.replaceChildren(...(r?.variants ?? []).map((v, i) => option(v.id, v.kind === 'builder' ? 'Bản dựng' : v.kind === 'edited' ? 'Chỉnh pixel · ' + (i + 1) : 'Sau kiểm tra'))); variantList.value = this.variantChosen && r?.variants.some(v => v.id === old) ? old : r?.selectedVariantId ?? r?.variants[0]?.id ?? ''; this.clearImages(); this.frameOptions(); void this.preview().catch(e => this.error(e)); }
    const callList = this.el<HTMLSelectElement>('call-select'), selectedCall = callList.value; callList.replaceChildren(...(r?.calls ?? []).map(c => option(c.id, `${aiProviderLabel(c.provider)} · ${roles[c.role]} · ${c.status}`))); if (selectedCall) callList.value = selectedCall;
    this.updateGate();
  }
  private frameOptions(): void { this.el<HTMLSelectElement>('frame').replaceChildren(...(this.variant?.frames ?? []).map((f, i) => option(f.id, `${i + 1} · ${f.durationMs} ms`))); }
  private clearRun(): void { this.run = undefined; this.variantChosen = false; this.clearImages(); this.renderState(); }
  private clearImages(): void { this.stop(); this.warming = false; this.request++; this.abort.abort(); this.abort = new AbortController(); this.frames.forEach(b => b.close()); this.frames.clear(); this.cacheKey = ''; this.el<HTMLCanvasElement>('after').width = 1; }
  private async bitmap(frameId: string): Promise<ImageBitmap | undefined> {
    const r = this.run, v = this.variant, ticket = this.request; if (!r || !v || !this.current() || !r.previewAvailable || r.revision !== this.session.doc?.revision) return;
    const key = `${r.id}/${v.id}/${r.revision}`; if (this.cacheKey && this.cacheKey !== key) { this.frames.forEach(b => b.close()); this.frames.clear(); } this.cacheKey = key;
    if (this.frames.has(frameId)) return this.frames.get(frameId);
    const response = await fetch(`/api/pixel/projects/${this.project}/quality-runs/${r.id}/variants/${v.id}/frame?revision=${r.revision}&frame=${encodeURIComponent(frameId)}`, { signal: this.abort.signal });
    if (!response.ok) { let message = `Preview HTTP ${response.status}`; try { message = (await response.json()).error ?? message; } catch {} throw Error(message); }
    const bitmap = await createImageBitmap(await response.blob());
    if (ticket !== this.request || !this.current() || this.run?.id !== r.id || this.variant?.id !== v.id) { bitmap.close(); return; }
    if (bitmap.width !== v.w || bitmap.height !== v.h || v.w * v.h * v.frames.length > 8_000_000) { bitmap.close(); throw Error('Preview sai kích thước hoặc vượt ngân sách native.'); }
    const prior = this.frames.get(frameId); if (prior) { bitmap.close(); return prior; } this.frames.set(frameId, bitmap); return bitmap;
  }
  private zoom(c: HTMLCanvasElement): void { const n = Number(this.el<HTMLSelectElement>('zoom').value); c.style.width = c.width * n + 'px'; c.style.height = c.height * n + 'px'; }
  private async preview(): Promise<void> {
    const v = this.variant, id = this.el<HTMLSelectElement>('frame').value, ticket = this.request, draw = ++this.drawRequest; this.paintSource(); if (!v || !id) return;
    const bitmap = await this.bitmap(id); if (!bitmap || ticket !== this.request || draw !== this.drawRequest) return;
    const index = v.frames.findIndex(f => f.id === id), previous = this.el<HTMLInputElement>('onion').checked && index > 0 ? await this.bitmap(v.frames[index - 1].id) : undefined;
    if (ticket !== this.request || draw !== this.drawRequest) return;
    const c = this.el<HTMLCanvasElement>('after'), ctx = c.getContext('2d')!; c.width = v.w; c.height = v.h; ctx.imageSmoothingEnabled = false;
    if (previous) { ctx.globalAlpha = .25; ctx.drawImage(previous, 0, 0); ctx.globalAlpha = 1; }
    ctx.drawImage(bitmap, 0, 0);
    if (this.el<HTMLInputElement>('diff').checked && this.source?.w === v.w && this.source.h === v.h) {
      const image = ctx.getImageData(0, 0, v.w, v.h); this.source.pixels.forEach((p, i) => { const n = i * 4, data = image.data; if (data[n] !== p >>> 24 || data[n + 1] !== (p >>> 16 & 255) || data[n + 2] !== (p >>> 8 & 255) || data[n + 3] !== (p & 255)) { data[n] = 255; data[n + 1] = 80; data[n + 2] = 160; data[n + 3] = 255; } }); ctx.putImageData(image, 0, 0);
    }
    this.zoom(c); this.el('after-label').textContent = `${v.w}×${v.h} · frame ${v.frames.findIndex(f => f.id === id) + 1} · ${v.frames.find(f => f.id === id)!.durationMs} ms${this.el<HTMLInputElement>('diff').checked ? ' · lớp khác biệt, không xuất' : ''}`; this.el('description').textContent = v.description;
  }
  private async play(): Promise<void> {
    if (this.playTimer) { this.stop(); return; } const v = this.variant; if (!v || !this.run?.previewAvailable || this.warming) return;
    const ticket = this.request; this.warming = true; this.updateGate(); this.el('play').textContent = 'Đang tải frame…'; let next = 0;
    try { await Promise.all(Array.from({ length: 2 }, async () => { while (next < v.frames.length && ticket === this.request) await this.bitmap(v.frames[next++].id); })); }
    finally { if (ticket === this.request) { this.warming = false; this.updateGate(); } }
    if (ticket !== this.request || !this.current()) return;
    const select = this.el<HTMLSelectElement>('frame'), startIndex = Math.max(0, v.frames.findIndex(f => f.id === select.value)), started = performance.now();
    const advance = () => {
      if (ticket !== this.request || this.variant?.id !== v.id) return;
      if (!this.current()) { this.stop(); return; }
      const stamp = performance.now(), sample = sampleMotionPlayback(v.frames, stamp - started, v.loop, startIndex);
      select.value = v.frames[sample.index].id; this.el('play').textContent = 'Dừng'; void this.preview().catch(e => this.error(e));
      if (sample.done) { this.stop(); return; }
      this.playTimer = setTimeout(advance, Math.max(1, sample.delayMs - (performance.now() - stamp)));
    }; advance();
  }
  private stop(): void { clearTimeout(this.playTimer); this.playTimer = undefined; this.el('play').textContent = 'Phát'; }
  private async cancel(): Promise<void> { if (!this.run || !running(this.run)) return; const project = this.project, run = await api(`projects/${project}/quality-runs/${this.run.id}/cancel`, 'POST', { revision: this.session.doc?.revision }); if (this.current(project)) { this.run = run; this.renderState(); } }
  private async retouch(): Promise<void> {
    this.updateGate(); if (this.el<HTMLButtonElement>('retouch-open').disabled) return;
    const run = this.run!, variant = this.variant!, project = this.project, frameId = this.el<HTMLSelectElement>('frame').value;
    this.clearImages(); this.busy = true; this.updateGate();
    try {
      const result = await editQualityVariant({ projectId: project, run, variant, frameId,
        current: () => this.current(project) && this.run?.id === run.id && this.session.doc?.revision === run.revision && !this.session.dirty && !this.session.conflict,
        onError: error => this.options.onError(error) });
      if (!this.current(project)) return;
      await this.refresh();
      if (result && this.run?.id === result.id) {
        this.variantChosen = false; this.el<HTMLSelectElement>('variant').value = result.selectedVariantId ?? '';
        this.clearImages(); this.frameOptions();
      }
      if (this.variant?.frames.some(f => f.id === frameId)) this.el<HTMLSelectElement>('frame').value = frameId;
      await this.preview();
    } finally { this.busy = false; this.updateGate(); }
  }
  private async apply(): Promise<void> {
    this.updateGate(); if (this.el<HTMLButtonElement>('apply').disabled) return;
    this.busy = true; this.updateGate(); let locked = false;
    try { await this.options.prepare(); const d = this.session.doc!, run = this.run!, variant = this.variant!; this.options.projectLock(true); locked = true; const result = await this.options.writeRevision(`projects/${d.id}/quality-runs/${run.id}/apply`, { revision: d.revision, variantId: variant.id, library: { kind: this.approval?.kind === 'motion' ? 'character' : 'object' } }); if (this.session.doc !== d || this.session.dirty || this.session.conflict) throw Error('Dự án đổi trong lúc áp dụng; giữ bản nháp và tải lại.'); await this.options.onSaved(result.document, result.assetId); this.run = result.run; this.renderState(); if (result.warning) this.error(Error(result.warning)); }
    finally { this.busy = false; if (locked) this.options.projectLock(false); this.sources(); this.updateGate(); }
  }
  private async remove(): Promise<void> { if (!this.run || running(this.run)) return; const id = this.run.id, project = this.project; await api(`projects/${project}/quality-runs/${id}`, 'DELETE', { revision: this.session.doc?.revision }); if (this.current(project)) { this.run = undefined; this.clearImages(); await this.refresh(); } }
  private async readCall(): Promise<void> { if (!this.run) return; const project = this.project, id = this.run.id, call = this.el<HTMLSelectElement>('call-select').value; if (!call) return; const value = await api(`projects/${project}/quality-runs/${id}/calls/${call}`); if (this.current(project) && this.run?.id === id) this.el('raw').textContent = value.output.length > 50000 ? value.output.slice(0, 50000) + '\n… Rút gọn phần hiển thị 50.000 ký tự.' : value.output; }
  updateGate(): void {
    const d = this.session.doc, a = this.approval, valid = !!d && d.id === this.project && !this.session.dirty && !this.session.conflict, source = valid && a?.projectId === d!.id && a?.revision === d!.revision;
    this.el<HTMLButtonElement>('generate').disabled = this.busy || !source || running(this.run) || !this.el<HTMLTextAreaElement>('prompt').value.trim();
    const layers = this.el<HTMLInputElement>('source-layers');
    const approving = this.el<HTMLInputElement>('source-ok').checked;
    layers.disabled = this.busy || !valid || running(this.run) || !approving;
    if (!approving) layers.checked = false;
    const template = this.el<HTMLInputElement>('template'), parts = this.el<HTMLSelectElement>('template-parts');
    if (!layers.checked) template.checked = false;
    const region = layers.checked ? this.options.sourceRegion?.() : undefined;
    this.el('template-fields').hidden = !layers.checked;
    this.el('template-area').textContent = region ? `Vùng chọn ${region.w}×${region.h} tại (${region.x}, ${region.y})` : 'Chọn vùng chữ nhật trên canvas trước khi mở bảng này.';
    template.disabled = layers.disabled;
    parts.disabled = template.disabled || !template.checked;
    const layerCount = parts.selectedOptions.length;
    this.el<HTMLButtonElement>('approve').disabled = layers.disabled || (template.checked && (!region || layerCount < 1 || layerCount > 8));
    const scope = a?.templateScope;
    const scopeStatus = this.el('approved-scope');
    scopeStatus.hidden = !scope;
    scopeStatus.textContent = scope ? `Vùng khóa sửa ${scope.region.w}×${scope.region.h} · ${a.recipe.parts.filter(part => scope.partIds.includes(part.id)).map(part => part.name).join(', ')}` : '';
    this.el<HTMLButtonElement>('motion').disabled = this.busy || !valid || running(this.run) || !this.options.onMotionSource;
    this.el<HTMLButtonElement>('cancel').disabled = this.busy || !running(this.run);
    this.el<HTMLButtonElement>('apply').disabled = this.busy || !valid || this.run?.status !== 'ready' || !this.run.previewAvailable || this.run.revision !== d!.revision || !this.variant;
    const runApproval = this.run ? d?.studio?.quality?.approvals[this.run.approvalId] : undefined;
    this.el<HTMLButtonElement>('retouch-open').disabled = this.el<HTMLButtonElement>('apply').disabled || !!runApproval?.templateScope || (this.run?.variants.length ?? 0) >= 20;
    this.el<HTMLButtonElement>('delete').disabled = this.busy || !this.run || running(this.run);
    this.el<HTMLButtonElement>('play').disabled = this.busy || this.warming || !this.variant || !this.run?.previewAvailable || this.run.revision !== d?.revision;
    this.el<HTMLButtonElement>('close').disabled = this.busy;
    for (const name of ['source', 'source-ok', 'history', 'variant', 'frame']) (this.el(name) as HTMLInputElement | HTMLSelectElement).disabled = this.busy;
  }
}
