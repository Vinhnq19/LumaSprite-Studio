import { api, type Session } from './session.ts';
import { CANONICAL_MASKS, canonicalMask } from '../../src/studio/terrain.ts';
import { unlinkTileset } from '../../src/studio/map-commands.ts';

interface Options { session: Session; prepare: () => Promise<void>; applied: (assetId: string) => Promise<void>; write: (path: string, value: any) => Promise<any>; error: (error: unknown) => void }
interface Job { id: string; projectId: string; revision: number; status: string; started: number; error?: string; warnings?: string[]; w?: number; h?: number }
const option = (id: string, text: string) => { const el = document.createElement('option'); el.value = id; el.textContent = text; return el; };
export class TerrainEditorController {
  readonly dialog: HTMLDialogElement;
  private options: Options;
  private ticket = 0;
  private job?: Job;
  private projectId = '';
  private busy = false;
  private draft = false;
  private timer?: ReturnType<typeof setTimeout>;
  private objectUrl?: string;
  constructor(options: Options) {
    this.options = options; this.dialog = document.createElement('dialog'); this.dialog.id = 'terrain-dialog'; this.dialog.className = 'large-workspace terrain-dialog'; this.dialog.setAttribute('aria-labelledby', 'terrain-title');
    this.dialog.innerHTML = `<div class="workspace-header"><h2 id="terrain-title">Tileset từ vật liệu</h2><button id="terrain-close">Đóng (Esc)</button></div><p id="terrain-message" role="status" class="hint"></p><div class="terrain-editor-body"><aside class="terrain-inspector"><p>Vẽ hoặc duyệt một ô vật liệu trước. App dùng chung vật liệu và 5 mẫu góc/mép để dựng 47 ô địa hình cùng 1 ô dự phòng; không gọi AI thêm.</p><form id="terrain-create"><label>Asset vật liệu<select id="terrain-source"></select></label><label>Frame<select id="terrain-frame"></select></label><label>Tên tileset<input id="terrain-name" maxlength="100" required value="Tileset mới"></label><label>Kích thước ô<select id="terrain-size"><option value="32">32×32</option><option value="16">16×16</option></select></label><label>Độ dày mép trong suốt (px)<input id="terrain-inset" type="number" min="1" max="15" value="2" required></label><label>Lấy mẫu vật liệu<select id="terrain-sampling"><option value="repeat">Lặp nguyên pixel nguồn</option><option value="mirror">Đối xứng texture trong ô</option></select></label><small>Không thu nhỏ ảnh nguồn. Mép là hình cắt cứng theo ô lưới; preview có thể cần chỉnh tay thêm để đạt phong cách mong muốn.</small><button id="terrain-generate" type="submit" class="primary">Dựng atlas xem trước</button></form><div class="row wrap"><button id="terrain-cancel">Hủy tác vụ / bỏ đề xuất</button><button id="terrain-apply" class="primary">Áp dụng thành tileset mới</button></div><p id="terrain-elapsed" class="hint"></p><p id="terrain-warning" class="hint"></p><small>Áp dụng tạo atlas pixel mới có thể vẽ tay. Bản đồ tham chiếu atlas này; nét vẽ tay sẽ được giữ.</small></aside><main class="terrain-main"><h3>Atlas 8×6 · 47 mask + ô dự phòng</h3><img id="terrain-preview" alt="Atlas địa hình xem trước" hidden><h3>Thử nối mép, tường và lỗ</h3><canvas id="terrain-seams" width="384" height="256" aria-label="Thử nối tileset"></canvas><p class="hint">Mẫu nối chỉ để kiểm tra. Không xuất overlay hoặc tự sửa đường nối.</p></main></div>`;
    document.body.append(this.dialog);
    const registrations = document.createElement('section'); registrations.className = 'terrain-registrations';
    registrations.innerHTML = '<h3>Tileset đã đăng ký</h3><label>Tileset<select id="terrain-registered"></select></label><p id="terrain-dependents" class="hint"></p><button id="terrain-unlink">Gỡ liên kết tileset chưa dùng…</button><button id="terrain-registration-undo">Hoàn tác</button><small>Gỡ đăng ký giữ nguyên ảnh atlas. Sau đó có thể xóa asset ở danh sách bên trái. Tileset đang có bản đồ phải được thay hoặc gỡ khỏi bản đồ trước.</small>';
    this.el('terrain-create').parentElement!.append(registrations);
    this.select('terrain-registered').onchange = () => this.gate();
    this.el('terrain-unlink').onclick = () => {
      try {
        const session = this.options.session, doc = session.doc, id = this.select('terrain-registered').value;
        if (!doc || this.busy || this.job?.status === 'running' || session.conflict) return;
        const used = Object.values(doc.studio?.mapIndex ?? {}).filter(m => m.layers.some(l => l.tilesetId === id));
        if (used.length) throw new Error(`Tileset còn được dùng bởi: ${used.map(m => m.name).join(', ')}.`);
        if (confirm('Gỡ đăng ký tileset này? Ảnh atlas được giữ nguyên; Undo có thể khôi phục liên kết.')) session.change('Gỡ đăng ký tileset', () => unlinkTileset(doc, id));
        this.gate();
      } catch (e) { this.error(e); }
    };
    this.el('terrain-registration-undo').onclick = () => { void Promise.resolve().then(() => this.options.session.undo()).then(() => this.gate()).catch(e => this.error(e)); };
    this.select('terrain-source').onchange = () => { this.frames(); this.gate(); };
    this.select('terrain-size').onchange = () => { this.input('terrain-inset').max = String(Number(this.select('terrain-size').value) / 2 - 1); this.gate(); };
    this.select('terrain-frame').onchange = () => this.gate();
    this.dialog.addEventListener('input', () => { this.draft = true; });
    this.el<HTMLFormElement>('terrain-create').onsubmit = e => { e.preventDefault(); void this.start(); };
    this.el('terrain-cancel').onclick = () => { void this.cancel().catch(e => this.error(e)); };
    this.el('terrain-apply').onclick = () => { void this.apply(); };
    this.el('terrain-close').onclick = () => { void this.close(); };
    this.dialog.oncancel = e => { e.preventDefault(); void this.close(); };
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.dialog.querySelector<T>(`#${id}`)!; }
  private select(id: string): HTMLSelectElement { return this.el<HTMLSelectElement>(id); }
  private input(id: string): HTMLInputElement { return this.el<HTMLInputElement>(id); }
  get hasGesture(): boolean { return this.busy || this.draft || this.job?.status === 'running'; }
  private error(e: unknown): void { this.el('terrain-message').textContent = (e as Error).message; this.options.error(e); }
  private owner(ticket: number, projectId: string): boolean { return this.ticket === ticket && this.projectId === projectId && this.options.session.doc?.id === projectId && this.dialog.open; }
  async open(): Promise<void> {
    const doc = this.options.session.doc; if (!doc) throw new Error('Mở dự án trước.');
    await this.options.prepare(); if (this.options.session.doc !== doc) return;
    this.projectId = doc.id; this.select('terrain-source').replaceChildren(...doc.assets.map(a => option(a.id, `${a.name} · ${a.w}×${a.h}`)));
    this.select('terrain-source').value = this.options.session.assetId;
    const source = this.options.session.asset; this.select('terrain-size').value = source?.w === 16 && source.h === 16 ? '16' : '32';
    this.frames(); this.dialog.showModal(); this.gate();
  }
  private frames(): void {
    const source = this.options.session.doc?.assets.find(a => a.id === this.select('terrain-source').value);
    this.select('terrain-frame').replaceChildren(...(source?.frames ?? []).map((f, i) => option(f.id, `${i + 1} · ${f.duration} ms`)));
    if (source?.frames.some(f => f.id === this.options.session.frameId)) this.select('terrain-frame').value = this.options.session.frameId;
  }
  private async start(): Promise<void> {
    if (this.busy || this.job?.status === 'running') return;
    const session = this.options.session, doc = session.doc, projectId = this.projectId; if (!doc) return;
    const ticket = ++this.ticket; this.busy = true; this.gate();
    try {
      await session.flush(); if (!this.owner(ticket, projectId) || session.doc !== doc || session.conflict) return;
      if (this.job) await this.cancelJob(this.job);
      if (!this.owner(ticket, projectId)) return;
      const job = await api(`projects/${projectId}/terrain/proposal`, 'POST', { revision: doc.revision, assetId: this.select('terrain-source').value, frameId: this.select('terrain-frame').value, name: this.input('terrain-name').value, tileSize: Number(this.select('terrain-size').value), inset: Number(this.input('terrain-inset').value), sampling: this.select('terrain-sampling').value });
      if (!this.owner(ticket, projectId)) return;
      this.job = job; this.clearPreview(); this.el('terrain-warning').textContent = ''; this.el('terrain-message').textContent = 'Đang dựng atlas cục bộ…'; this.draft = false; this.poll(ticket, projectId);
    } catch (e) { if (this.owner(ticket, projectId)) this.error(e); }
    finally { if (this.owner(ticket, projectId)) { this.busy = false; this.gate(); } }
  }
  private poll(ticket: number, projectId: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void (async () => {
      if (!this.owner(ticket, projectId) || !this.job) return;
      try {
        const job: Job = await api(`projects/${projectId}/terrain/jobs/${this.job.id}`);
        if (!this.owner(ticket, projectId)) return; this.job = job;
        this.el('terrain-elapsed').textContent = `${((Date.now() - job.started) / 1000).toFixed(1)} giây · ${job.status === 'running' ? 'đang dựng' : 'đã kết thúc'}`;
        this.el('terrain-message').textContent = job.status === 'ready' ? `${job.w}×${job.h} px · Chưa áp dụng vào dự án` : job.error ?? (job.status === 'running' ? 'Đang dựng atlas…' : 'Đã hủy / kết thúc');
        this.el('terrain-warning').textContent = job.warnings?.join('\n') ?? '';
        this.gate();
        if (job.status === 'running') this.poll(ticket, projectId);
        else if (job.status === 'ready') await this.preview(job, ticket);
      } catch (e) { if (this.owner(ticket, projectId)) this.error(e); }
    })(); }, 250);
  }
  private async preview(job: Job, ticket: number): Promise<void> {
    const response = await fetch(`/api/pixel/projects/${job.projectId}/terrain/jobs/${job.id}/preview?revision=${job.revision}`);
    if (!response.ok) throw new Error((await response.json()).error);
    const blob = await response.blob(); if (!this.owner(ticket, job.projectId) || this.job?.id !== job.id) return;
    this.clearPreview(); const url = URL.createObjectURL(blob); this.objectUrl = url;
    const image = this.el<HTMLImageElement>('terrain-preview'); image.src = url; await image.decode();
    if (!this.owner(ticket, job.projectId) || this.objectUrl !== url || this.job?.id !== job.id) return;
    image.hidden = false; this.seams(image, job.w! / 8);
  }
  private seams(image: HTMLImageElement, size: number): void {
    const c = this.el<HTMLCanvasElement>('terrain-seams'), ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height); ctx.imageSmoothingEnabled = false;
    const pattern = ['............', '..####......', '..####..##..', '##########..', '####..####..', '####..####..', '##########..', '############'];
    const filled = (x: number, y: number) => pattern[y]?.[x] === '#';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) if (filled(x, y)) {
      let mask = 0; for (const [dx, dy, bit] of [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8], [1, -1, 16], [1, 1, 32], [-1, 1, 64], [-1, -1, 128]]) if (filled(x + dx, y + dy)) mask |= bit;
      const slot = CANONICAL_MASKS.indexOf(canonicalMask(mask)); ctx.drawImage(image, slot % 8 * size, Math.floor(slot / 8) * size, size, size, x * 32, y * 32, 32, 32);
    }
  }
  private async cancelJob(job: Job): Promise<void> {
    // A cancel never edits art. Read the latest saved revision when external
    // changes made the originating revision stale; do not replace local drafts.
    const saved = await api(`projects/${job.projectId}`);
    await api(`projects/${job.projectId}/terrain/jobs/${job.id}/cancel`, 'POST', { revision: saved.revision });
  }
  private async cancel(): Promise<void> {
    if (this.busy) return; const job = this.job; this.busy = true; this.gate();
    try { if (job) await this.cancelJob(job); this.ticket++; clearTimeout(this.timer); this.job = undefined; this.clearPreview(); this.el('terrain-message').textContent = 'Đã bỏ đề xuất tileset.'; }
    finally { this.busy = false; this.gate(); }
  }
  private async apply(): Promise<void> {
    const job = this.job, session = this.options.session, doc = session.doc, ticket = this.ticket;
    if (!job || job.status !== 'ready' || !doc || this.busy) return;
    this.busy = true; this.gate();
    try {
      await session.flush(); if (!this.owner(ticket, job.projectId) || session.doc !== doc || session.conflict || doc.revision !== job.revision) throw new Error('Dự án đã đổi; dựng lại tileset trước khi áp dụng.');
      const result = await this.options.write(`projects/${job.projectId}/terrain/jobs/${job.id}/apply`, { revision: doc.revision });
      if (!this.owner(ticket, job.projectId)) return;
      this.job = undefined; this.draft = false; this.reset(); await this.options.applied(result.assetId);
    } catch (e) { if (this.owner(ticket, job.projectId)) this.error(e); }
    finally { if (this.owner(ticket, job.projectId)) { this.busy = false; this.gate(); } }
  }
  gate(): void {
    if (!this.dialog.open) return;
    const session = this.options.session, active = this.job?.status === 'running', mismatch = session.doc?.revision !== this.job?.revision;
    const source = session.doc?.assets.find(a => a.id === this.select('terrain-source').value), size = Number(this.select('terrain-size').value);
    for (const control of this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) control.disabled = this.busy || !!active;
    this.el<HTMLButtonElement>('terrain-close').disabled = this.busy;
    this.el<HTMLButtonElement>('terrain-cancel').disabled = this.busy || !this.job;
    this.el<HTMLButtonElement>('terrain-generate').disabled = this.busy || !!active || session.conflict || source?.w !== size || source.h !== size;
    this.el<HTMLButtonElement>('terrain-apply').disabled = this.busy || this.job?.status !== 'ready' || session.conflict || mismatch || session.dirty;
    const registered = this.select('terrain-registered'), sets = Object.values(session.doc?.studio?.tilesets ?? {}), signature = JSON.stringify(sets.map(s => [s.id, s.name]));
    if (registered.dataset.signature !== signature) {
      const old = registered.value; registered.replaceChildren(...sets.map(s => option(s.id, s.name))); registered.dataset.signature = signature;
      if (sets.some(s => s.id === old)) registered.value = old;
    }
    const used = Object.values(session.doc?.studio?.mapIndex ?? {}).filter(m => m.layers.some(l => l.tilesetId === registered.value));
    this.el('terrain-dependents').textContent = used.length ? `Bản đồ đang dùng: ${used.map(m => m.name).join(', ')}. Thay/gỡ liên kết trong Bản đồ trước.` : sets.length ? 'Chưa có bản đồ tham chiếu tileset này.' : 'Chưa có tileset đã đăng ký.';
    this.el<HTMLButtonElement>('terrain-unlink').disabled = this.busy || !!active || session.conflict || !registered.value || !!used.length;
    this.el<HTMLButtonElement>('terrain-registration-undo').disabled = this.busy || !!active || session.conflict;
    if (!this.job && source && (source.w !== size || source.h !== size)) this.el('terrain-message').textContent = `Nguồn ${source.w}×${source.h}; cần đúng ${size}×${size}. Tạo hoặc chọn ô vật liệu đúng cỡ, app không tự thu nhỏ.`;
  }
  private clearPreview(): void {
    const img = this.el<HTMLImageElement>('terrain-preview'); img.hidden = true; img.removeAttribute('src');
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined;
    const c = this.el<HTMLCanvasElement>('terrain-seams'); c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  }
  private async close(): Promise<void> {
    if (this.busy) return; try { await this.cancel(); this.reset(); } catch (e) { this.error(e); }
  }
  reset(): void { this.ticket++; clearTimeout(this.timer); this.job = undefined; this.projectId = ''; this.draft = false; this.busy = false; this.clearPreview(); this.dialog.close(); }
}
