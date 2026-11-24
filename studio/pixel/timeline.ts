import { Session } from './session.ts';
import { assertAtlasMutationAllowed } from '../../src/studio/tilemaps.ts';
import { celFor, uid, newLayer, collectCels, duplicateFrame, deleteFrames, unlinkCel, isLocked, type PixelAsset } from '../../src/studio/pixel/model.ts';

export class Timeline {
  readonly session: Session; readonly root: HTMLElement; selectedFrames = new Set<string>(); selectedCells = new Set<string>();
  beforeSelect: () => void = () => {}; onselect: () => void = () => {}; onerror: (e: unknown) => void = () => {}; private observer?: IntersectionObserver; private anchor?: { l: number; f: number };
  private clipboard?: { items: { x: number; y: number; id?: string; data?: Uint32Array; blob?: string }[]; w: number; h: number };
  private thumbnails: Promise<void> = Promise.resolve();
  constructor(root: HTMLElement, session: Session) { this.root = root; this.session = session; root.addEventListener('click', () => root.focus()); }
  clear(): void { this.selectedFrames.clear(); this.selectedCells.clear(); this.anchor = undefined; }
  render(): void {
    this.observer?.disconnect(); this.root.replaceChildren(); const a = this.session.asset; if (!a) return;
    this.observer = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { this.observer?.unobserve(e.target); const c = e.target as HTMLCanvasElement; this.thumbnails = this.thumbnails.then(async () => { if (c.isConnected) await this.thumbnail(c, c.dataset.layer!, c.dataset.frame!, a); }).catch(this.onerror); } }, { root: this.root, rootMargin: '50px' });
    const table = document.createElement('table'), head = table.createTHead().insertRow(), title = document.createElement('th'); title.textContent = 'Layer / Frame'; head.append(title);
    a.frames.forEach((f, index) => {
      const th = document.createElement('th'), b = document.createElement('button'); b.textContent = `${index + 1} · ${f.duration}ms`; b.title = 'Ctrl chọn nhiều; kéo thả để đổi thứ tự'; b.classList.toggle('selected', f.id === this.session.frameId || this.selectedFrames.has(f.id));
      b.onclick = e => { try { this.beforeSelect(); if (e.shiftKey) { const start = a.frames.findIndex(k => k.id === this.session.frameId); for (const k of a.frames.slice(Math.min(start, index), Math.max(start, index) + 1)) this.selectedFrames.add(k.id); } else if (e.ctrlKey || e.metaKey) { if (this.selectedFrames.has(f.id)) this.selectedFrames.delete(f.id); else this.selectedFrames.add(f.id); } else { this.selectedFrames.clear(); this.selectedFrames.add(f.id); } this.session.frameId = f.id; this.onselect(); } catch (e) { this.onerror(e); } };
      b.draggable = true; b.ondragstart = e => e.dataTransfer!.setData('application/pxl-frame', f.id); b.ondragover = e => e.preventDefault(); b.ondrop = e => { e.preventDefault(); const id = e.dataTransfer!.getData('application/pxl-frame'); if (id) this.reorderFrames(id, f.id); };
      th.append(b); head.append(th);
    });
    const body = table.createTBody(); const ordered: { id: string; depth: number }[] = [];
    const walk = (parent?: string, depth = 0) => { for (const l of [...a.layers].reverse().filter(l => l.parent === parent)) { ordered.push({ id: l.id, depth }); walk(l.id, depth + 1); } }; walk();
    for (const item of ordered) {
      const layer = a.layers.find(l => l.id === item.id)!, row = body.insertRow(), label = document.createElement('th'); label.style.paddingLeft = `${item.depth * 12 + 4}px`;
      const eye = document.createElement('button'), lock = document.createElement('button'), name = document.createElement('button'); eye.textContent = layer.visible ? '◉' : '○'; eye.title = 'Ẩn/hiện layer'; lock.textContent = layer.locked ? '🔒' : '◇'; lock.title = 'Khóa/mở layer'; name.textContent = `${layer.type === 'group' ? '▣ ' : ''}${layer.name}`; name.classList.toggle('selected', layer.id === this.session.layerId);
      eye.onclick = () => this.safe(() => this.session.change('Ẩn/hiện layer', () => { layer.visible = !layer.visible; })); lock.onclick = () => this.safe(() => this.session.change('Khóa layer', () => { layer.locked = !layer.locked; }));
      name.onclick = () => this.safe(() => { this.beforeSelect(); this.session.layerId = layer.id; this.onselect(); });
      name.draggable = true; name.ondragstart = e => e.dataTransfer!.setData('application/pxl-layer', layer.id); name.ondragover = e => e.preventDefault(); name.ondrop = e => { e.preventDefault(); const id = e.dataTransfer!.getData('application/pxl-layer'); if (id) this.safe(() => this.session.change('Sắp xếp layer', () => { const l = a.layers.find(k => k.id === id)!; if (l.parent !== layer.parent) throw new Error('Dùng Nhóm cha để chuyển nhóm.'); a.layers.splice(a.layers.indexOf(l), 1); a.layers.splice(a.layers.indexOf(layer), 0, l); })); };
      label.append(eye, lock, name); row.append(label);
      for (const f of a.frames) {
        const cell = row.insertCell(), key = `${layer.id}/${f.id}`, b = document.createElement('button'); b.className = 'cel'; b.classList.toggle('selected', this.selectedCells.has(key) || layer.id === this.session.layerId && f.id === this.session.frameId); b.dataset.layer = layer.id; b.dataset.frame = f.id;
        const cel = celFor(a, layer.id, f.id), links = cel ? a.layers.reduce((n, l) => n + Object.values(l.cels).filter(id => id === cel.id).length, 0) : 0;
        b.title = cel ? `${links > 1 ? 'Cel liên kết' : 'Cel độc lập'} · Ctrl/Shift chọn nhiều` : 'Cel trống';
        const thumb = document.createElement('canvas'); thumb.width = 24; thumb.height = 24; thumb.dataset.layer = layer.id; thumb.dataset.frame = f.id; b.append(thumb); if (links > 1) { const link = document.createElement('span'); link.textContent = '↔'; b.append(link); }
        b.onclick = e => this.safe(() => { this.beforeSelect(); const li = a.layers.indexOf(layer), fi = a.frames.indexOf(f); if (e.shiftKey && this.anchor) { for (let l = Math.min(li, this.anchor.l); l <= Math.max(li, this.anchor.l); l++) for (let j = Math.min(fi, this.anchor.f); j <= Math.max(fi, this.anchor.f); j++) this.selectedCells.add(`${a.layers[l].id}/${a.frames[j].id}`); } else { if (!e.ctrlKey && !e.metaKey) this.selectedCells.clear(); if (this.selectedCells.has(key)) this.selectedCells.delete(key); else this.selectedCells.add(key); this.anchor = { l: li, f: fi }; } this.selectedFrames.clear(); this.session.layerId = layer.id; this.session.frameId = f.id; this.onselect(); });
        b.draggable = true; b.ondragstart = e => { e.dataTransfer!.setData('application/pxl-cel', key); }; b.ondragover = e => e.preventDefault(); b.ondrop = e => { e.preventDefault(); const from = e.dataTransfer!.getData('application/pxl-cel'); if (from) this.moveCells(from, key, e.ctrlKey); };
        cell.append(b); if (cel) this.observer.observe(thumb);
      }
    }
    this.root.append(table);
  }
  private safe(fn: () => void) { try { fn(); } catch (e) { this.onerror(e); } }
  private async thumbnail(c: HTMLCanvasElement, layerId: string, frameId: string, asset: PixelAsset): Promise<void> {
    const cell = celFor(asset, layerId, frameId); if (!cell) return; if (!cell.data) await this.session.loadFrame(frameId, asset);
    if (!cell.data || !c.isConnected) return;
    const temp = document.createElement('canvas'); temp.width = asset.w; temp.height = asset.h; const data = new Uint8ClampedArray(asset.w * asset.h * 4);
    for (let i = 0; i < cell.data.length; i++) { const p = cell.data[i]; data[i * 4] = p >>> 24; data[i * 4 + 1] = p >>> 16 & 255; data[i * 4 + 2] = p >>> 8 & 255; data[i * 4 + 3] = p & 255; }
    temp.getContext('2d')!.putImageData(new ImageData(data, asset.w, asset.h), 0, 0); const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; const z = Math.min(24 / asset.w, 24 / asset.h); ctx.clearRect(0, 0, 24, 24); ctx.drawImage(temp, 0, 0, asset.w * z, asset.h * z);
  }
  addLayer(group = false): void { this.beforeSelect(); const a = this.session.asset; if (!a) return; this.session.change(group ? 'Thêm nhóm' : 'Thêm layer', () => { const l = newLayer(`${group ? 'Nhóm' : 'Layer'} ${a.layers.length + 1}`, group ? 'group' : 'image', this.session.layer?.type === 'group' ? this.session.layerId : this.session.layer?.parent); a.layers.push(l); this.session.layerId = l.id; }); }
  async duplicateLayer(): Promise<void> {
    this.beforeSelect();
    const a = this.session.asset, source = this.session.layer; if (!a || !source) return;
    await this.session.loadAll();
    if (this.session.asset !== a || this.session.layer !== source) return;
    this.session.change('Nhân bản layer', () => {
      const ids = new Set([source.id]); let size = 0; while (size !== ids.size) { size = ids.size; for (const l of a.layers) if (l.parent && ids.has(l.parent)) ids.add(l.id); }
      const map = new Map([...ids].map(id => [id, uid()])), celMap = new Map<string, string>(), copies = a.layers.filter(l => ids.has(l.id)).map(l => {
        const copy = structuredClone(l); copy.id = map.get(l.id)!; copy.name += ' (bản sao)'; if (copy.parent && map.has(copy.parent)) copy.parent = map.get(copy.parent);
        for (const [f, id] of Object.entries(copy.cels)) { if (!celMap.has(id)) { const n = uid(); a.cels[n] = { id: n, data: a.cels[id].data!.slice() }; celMap.set(id, n); } copy.cels[f] = celMap.get(id)!; } return copy;
      }); a.layers.push(...copies); this.session.layerId = map.get(source.id)!;
    });
  }
  deleteLayer(): void {
    this.beforeSelect();
    const a = this.session.asset; if (!a) return; this.session.change('Xóa layer/nhóm', () => {
      const ids = new Set([this.session.layerId]); let n = 0; while (n !== ids.size) { n = ids.size; for (const l of a.layers) if (l.parent && ids.has(l.parent)) ids.add(l.id); }
      if (a.layers.some(layer => ids.has(layer.id) && isLocked(a, layer))) throw new Error('Mở khóa layer hoặc nhóm trước khi xóa.');
      a.layers = a.layers.filter(l => !ids.has(l.id)); if (!a.layers.length) a.layers.push(newLayer()); collectCels(a);
    });
  }
  async addFrame(mode: 'blank' | 'copy' | 'linked'): Promise<void> {
    this.beforeSelect();
    const a = this.session.asset, frame = this.session.frameId; if (!a) return;
    const ids = this.selectedFrames.size ? [...this.selectedFrames] : [frame];
    await this.session.loadAll();
    if (this.session.asset !== a || this.session.frameId !== frame) return;
    this.session.change('Thêm/nhân bản frame', () => { for (const id of ids) this.session.frameId = duplicateFrame(a, id, mode); }); this.selectedFrames.clear();
  }
  deleteFrames(): void {
    this.beforeSelect();
    const a = this.session.asset;
    if (!a) return;
    const ids = this.selectedFrames.size ? [...this.selectedFrames] : [this.session.frameId];
    const idSet = new Set(ids);
    if (a.layers.some(layer => isLocked(a, layer) && ids.some(id => layer.cels[id]))) throw new Error('Frame có cel thuộc layer khóa.');
    assertAtlasMutationAllowed(this.session.doc!, a.id, { removedFrameIds: ids });
    this.session.change('Xóa frame', () => {
      deleteFrames(a, ids);
      if (this.session.doc?.studio?.artDirection?.references) {
        this.session.doc.studio.artDirection.references = this.session.doc.studio.artDirection.references.filter(
          r => !(r.assetId === a.id && idSet.has(r.frameId))
        );
      }
    });
    this.selectedFrames.clear();
  }
  async unlink(): Promise<void> { await this.session.loadAll(); const a = this.session.asset; if (!a) return; this.session.change('Tách liên kết cel', () => { for (const key of this.selectedCells.size ? this.selectedCells : [`${this.session.layerId}/${this.session.frameId}`]) { const [l, f] = key.split('/'); const layer = a.layers.find(k => k.id === l)!; if (isLocked(a, layer)) throw new Error('Layer đang khóa.'); unlinkCel(a, l, f); } }); }
  deleteCells(): void { const a = this.session.asset; if (!a) return; this.session.change('Xóa cel', () => { for (const key of this.selectedCells.size ? this.selectedCells : [`${this.session.layerId}/${this.session.frameId}`]) { const [l, f] = key.split('/'), layer = a.layers.find(k => k.id === l)!; if (isLocked(a, layer)) throw new Error('Layer đang khóa.'); delete layer.cels[f]; } collectCels(a); }); }
  async copyCells(cut = false): Promise<void> {
    const a = this.session.asset; if (!a) return; await this.session.loadAll();
    const cells = [...(this.selectedCells.size ? this.selectedCells : [`${this.session.layerId}/${this.session.frameId}`])].map(key => { const [l, f] = key.split('/'); return { x: a.frames.findIndex(k => k.id === f), y: a.layers.findIndex(k => k.id === l), c: celFor(a, l, f) }; });
    const x = Math.min(...cells.map(c => c.x)), y = Math.min(...cells.map(c => c.y));
    this.clipboard = { w: a.w, h: a.h, items: cells.map(c => ({ x: c.x - x, y: c.y - y, id: c.c?.id, data: c.c?.data?.slice(), blob: c.c?.blob })) };
    if (cut) this.deleteCells();
  }
  pasteCells(): void {
    const a = this.session.asset, clip = this.clipboard; if (!a || !clip) throw new Error('Chưa sao chép cel trong timeline.');
    if (a.w !== clip.w || a.h !== clip.h) throw new Error('Cel clipboard khác kích thước canvas.');
    this.session.change('Dán cel', () => {
      const x = a.frames.findIndex(f => f.id === this.session.frameId), y = a.layers.findIndex(l => l.id === this.session.layerId), copies = new Map<string, string>();
      for (const item of clip.items) {
        const layer = a.layers[y + item.y], frame = a.frames[x + item.x]; if (!layer || !frame || layer.type !== 'image' || isLocked(a, layer)) throw new Error('Vùng dán ngoài timeline hoặc layer bị khóa.');
        if (!item.id) { delete layer.cels[frame.id]; continue; }
        if (!copies.has(item.id)) { const id = uid(); a.cels[id] = { id, data: item.data?.slice(), blob: item.blob }; copies.set(item.id, id); }
        layer.cels[frame.id] = copies.get(item.id)!;
      }
      collectCels(a);
    });
  }
  reorderFrames(from: string, to: string): void { this.safe(() => { const a = this.session.asset!; this.session.change('Sắp xếp frame', () => {
    const events = a.metadata.events?.map(e => ({ frameId: a.frames[e.frame].id, name: e.name })); const moving = a.frames.filter(f => f.id === from || this.selectedFrames.has(from) && this.selectedFrames.has(f.id)); if (moving.some(f => f.id === to)) return;
    a.frames = a.frames.filter(f => !moving.includes(f)); const index = a.frames.findIndex(f => f.id === to); a.frames.splice(index, 0, ...moving);
    if (events) a.metadata.events = events.map(e => ({ frame: a.frames.findIndex(f => f.id === e.frameId), name: e.name }));
  }); }); }
  moveCells(from: string, to: string, copy: boolean): void { this.safe(() => {
    const a = this.session.asset!, [sl, sf] = from.split('/'), [dl, df] = to.split('/'), dx = a.frames.findIndex(f => f.id === df) - a.frames.findIndex(f => f.id === sf), dy = a.layers.findIndex(l => l.id === dl) - a.layers.findIndex(l => l.id === sl);
    const keys = this.selectedCells.has(from) ? [...this.selectedCells] : [from];
    this.session.change(copy ? 'Sao chép cel' : 'Di chuyển cel', () => {
      const items = keys.map(k => { const [l, f] = k.split('/'), source = a.layers.find(g => g.id === l)!, target = a.layers[a.layers.indexOf(source) + dy], frame = a.frames[a.frames.findIndex(g => g.id === f) + dx]; if (!target || !frame || target.type !== 'image' || isLocked(a, source) || isLocked(a, target)) throw new Error('Đích cel nằm ngoài timeline hoặc layer đang khóa.'); return { source, target, from: f, to: frame.id, cel: source.cels[f] }; });
      if (!copy) for (const item of items) delete item.source.cels[item.from];
      const mapped = new Map<string, string>();
      for (const item of items) { if (!item.cel) { delete item.target.cels[item.to]; continue; } let id = item.cel; if (copy) { if (!mapped.has(id)) { const n = uid(), c = a.cels[id]; a.cels[n] = { id: n, blob: c.blob, data: c.data?.slice() }; mapped.set(id, n); } id = mapped.get(id)!; } item.target.cels[item.to] = id; } collectCels(a);
    });
  }); }
}
