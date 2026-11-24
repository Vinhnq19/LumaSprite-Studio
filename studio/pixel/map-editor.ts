import { api, type Session } from './session.ts';
import { MapViewport, type CellRect, type MapTool } from './map-viewport.ts';
import { createMap, getMap, getMapLayer, addMapLayer, updateMapLayer, removeMapLayer, reorderMapLayer, removeMap, renameMap, mapResizeLoss, resizeMap, MapStroke, copyMapRect, pasteMapRect, setTileCollision, unlinkTileset, type MapClipboard } from '../../src/studio/map-commands.ts';
import { atlasImage } from '../../src/studio/tilemap-render.ts';
import type { PixelDocument } from '../../src/studio/pixel/model.ts';
import type { TileCollision } from '../../src/studio/tilemaps.ts';

interface Options { session: Session; prepare: () => Promise<void>; error: (error: unknown) => void }
const option = (value: string, label: string) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; };
export class MapEditorController {
  readonly dialog: HTMLDialogElement;
  private options: Options;
  private viewport: MapViewport;
  private mapId = '';
  private layerId = '';
  private projectId = '';
  private tool: MapTool = 'pen';
  private tileId = 1;
  private busy = false;
  private draft = false;
  private ticket = 0;
  private clipboard?: MapClipboard;
  constructor(options: Options) {
    this.options = options;
    this.dialog = document.createElement('dialog'); this.dialog.id = 'map-dialog'; this.dialog.className = 'large-workspace map-dialog'; this.dialog.setAttribute('aria-labelledby', 'map-title');
    this.dialog.innerHTML = `<div class="workspace-header"><h2 id="map-title">Bản đồ platformer</h2><button id="map-close">Đóng (Esc)</button></div><p id="map-message" role="status" class="hint"></p>
<div class="map-editor-body"><aside class="map-inspector"><label>Bản đồ<select id="map-list"></select></label>
<details id="map-create-details" open><summary>+ Tạo bản đồ</summary><form id="map-create"><label>Tên<input id="map-new-name" value="Bản đồ mới" maxlength="100" required></label><label>Tileset<select id="map-new-tileset"></select></label><div class="row"><label>Rộng (ô)<input id="map-new-width" type="number" min="1" max="256" value="64" required></label><label>Cao (ô)<input id="map-new-height" type="number" min="1" max="256" value="32" required></label></div><button id="map-create-submit" type="submit" class="primary">Tạo bản đồ</button></form></details>
<section id="map-properties"><label>Tên bản đồ<input id="map-name" maxlength="100"></label><button id="map-rename">Lưu tên</button><div class="row"><label>Rộng<input id="map-width" type="number" min="1" max="256"></label><label>Cao<input id="map-height" type="number" min="1" max="256"></label></div><button id="map-resize">Đổi kích thước…</button><button id="map-delete">Xóa bản đồ…</button>
<h3>Layer</h3><label>Layer hiện tại<select id="map-layer"></select></label><label>Tileset cho layer mới<select id="map-layer-tileset"></select></label><div class="row wrap"><button id="map-layer-add">+ Layer</button><button id="map-layer-delete">Xóa layer</button><button id="map-layer-up">↑</button><button id="map-layer-down">↓</button></div><label>Tên layer<input id="map-layer-name" maxlength="100"></label><button id="map-layer-rename">Lưu tên layer</button><div class="row wrap"><label><input id="map-layer-visible" type="checkbox">Hiện</label><label><input id="map-layer-locked" type="checkbox">Khóa</label></div><label>Độ đục<input id="map-layer-opacity" type="range" min="0" max="255" value="255"></label>
<h3>Ô tileset</h3><canvas id="map-tile-palette" aria-label="Chọn ô tileset" width="256" height="192"></canvas><p id="map-tile-info" class="hint"></p><label>Va chạm ô<select id="map-tile-collision"><option value="empty">Trống</option><option value="solid">Đặc</option><option value="one-way">Một chiều</option></select></label><button id="map-unlink-tileset">Gỡ / thay tileset…</button><small>Gỡ atlas đang dùng cần chọn vật liệu thay thế; các ô cũ sẽ được xóa sau khi xác nhận. Undo khôi phục cả liên kết và ô.</small></section></aside>
<main class="map-main"><div id="map-tools" class="row wrap">${([['pen', 'Bút'], ['erase', 'Tẩy'], ['fill', 'Tô vùng'], ['select', 'Chọn vùng'], ['hand', 'Kéo']] as const).map(([tool, name]) => `<button type="button" data-map-tool="${tool}">${name}</button>`).join('')}<label><input id="map-autotile" type="checkbox" checked>Autotile</label><label><input id="map-grid" type="checkbox" checked>Lưới</label><label><input id="map-collision" type="checkbox">Xem va chạm</label><button id="map-fit">Vừa khung</button><button id="map-actual">1×</button><button id="map-undo">Hoàn tác</button><button id="map-redo">Làm lại</button></div>
<div id="map-stage" class="map-stage"></div><p id="map-view-info" class="hint"></p><div class="row wrap"><button id="map-copy">Sao chép vùng</button><button id="map-cut">Cắt vùng</button><button id="map-paste">Dán tại vùng chọn / con trỏ</button><button id="map-clear-selection">Bỏ chọn</button><button id="map-delete-selection">Xóa vùng</button><button id="map-save">Lưu</button></div><div class="row wrap"><button data-map-export="json">Tải JSON</button><button data-map-export="zip">Tải ZIP + atlas</button><button data-map-export="png">Tải PNG</button><button id="map-tileset-export">Tải tileset PNG/JSON</button></div><small>0 là ô trống. Ô thứ 48 là trang trí thủ công. Giữ Space / chuột giữa để kéo; lăn chuột zoom quanh con trỏ. PNG tối đa 4096 px mỗi cạnh.</small></main></div>`;
    document.body.append(this.dialog);
    this.viewport = new MapViewport(this.el('map-stage'), { session: options.session, mapId: () => this.mapId, layerId: () => this.layerId, tool: () => this.tool, tileId: () => this.tileId, autotile: () => this.input('map-autotile').checked,
      load: r => this.load(r), fill: (x, y) => this.action(async () => { await this.load(undefined, true); this.change('Tô vùng bản đồ', () => { const s = new MapStroke(this.doc!, this.mapId, this.layerId); s.fill(x, y, this.tileId, this.input('map-autotile').checked); s.commit(); }); }),
      error: e => this.error(e), status: text => this.el('map-view-info').textContent = text });
    this.bind();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.dialog.querySelector<T>(`#${id}`)!; }
  private input(id: string): HTMLInputElement { return this.el<HTMLInputElement>(id); }
  private select(id: string): HTMLSelectElement { return this.el<HTMLSelectElement>(id); }
  private get doc(): PixelDocument | undefined { return this.options.session.doc; }
  get hasGesture(): boolean { return this.busy || this.draft || this.viewport.hasGesture; }
  private error(e: unknown): void { this.el('map-message').textContent = (e as Error).message; this.options.error(e); }
  private change(label: string, fn: () => void): void { if (this.options.session.conflict) throw new Error('Dự án có xung đột; tải lại hoặc lưu bản sao trước khi sửa bản đồ.'); this.options.session.change(label, fn); this.draft = false; this.update(); }
  private async action(fn: () => void | Promise<void>): Promise<void> {
    if (this.busy || this.viewport.hasGesture) return;
    const doc = this.doc, ticket = this.ticket; this.busy = true; this.gate();
    const version = this.options.session.version;
    try { await fn(); }
    catch (e) { if (this.doc?.id === doc?.id && this.options.session.version === version && this.ticket === ticket) this.error(e); }
    finally { if (this.ticket === ticket) { this.busy = false; this.gate(); } }
  }
  private bind(): void {
    const bind = (id: string, fn: () => void | Promise<void>) => this.el(id).onclick = () => { void this.action(fn); };
    this.el('map-close').onclick = () => { if (!this.busy) this.close(); };
    this.dialog.oncancel = e => { e.preventDefault(); if (this.viewport.hasGesture) this.viewport.cancel(); else if (!this.busy) this.close(); };
    this.dialog.addEventListener('input', e => { if ((e.target as HTMLInputElement).matches('input[type=text],input:not([type]),input[type=number]')) this.draft = true; });
    this.select('map-list').onchange = () => { this.viewport.cancel(); this.ticket++; this.busy = false; this.mapId = this.select('map-list').value; this.layerId = ''; this.draft = false; this.update(); if (this.mapId) this.viewport.restoreView(); };
    this.el<HTMLFormElement>('map-create').onsubmit = e => { e.preventDefault(); void this.action(() => { const doc = this.doc; if (!doc) return; this.change('Tạo bản đồ', () => { this.mapId = createMap(doc, this.select('map-new-tileset').value, this.input('map-new-name').value, Number(this.input('map-new-width').value), Number(this.input('map-new-height').value)); this.layerId = ''; }); this.el<HTMLDetailsElement>('map-create-details').open = false; this.viewport.fit(); }); };
    bind('map-rename', () => this.change('Đổi tên bản đồ', () => renameMap(this.doc!, this.mapId, this.input('map-name').value)));
    bind('map-resize', async () => { await this.load(undefined, true, true); const w = Number(this.input('map-width').value), h = Number(this.input('map-height').value), loss = mapResizeLoss(this.doc!, this.mapId, w, h); if (loss && !confirm(`Cắt ${loss} ô nằm ngoài kích thước ${w}×${h}? Undo có thể khôi phục.`)) return; this.change('Đổi kích thước bản đồ', () => resizeMap(this.doc!, this.mapId, w, h, true)); this.viewport.selection = undefined; this.viewport.draw(); });
    bind('map-delete', () => { if (confirm('Xóa bản đồ này? Undo có thể khôi phục.')) { this.change('Xóa bản đồ', () => removeMap(this.doc!, this.mapId)); this.mapId = ''; this.layerId = ''; this.update(); } });
    this.select('map-layer').onchange = () => { this.viewport.cancel(); this.ticket++; this.busy = false; this.layerId = this.select('map-layer').value; this.draft = false; this.update(); };
    bind('map-layer-add', () => this.change('Thêm layer bản đồ', () => { this.layerId = addMapLayer(this.doc!, this.mapId, this.select('map-layer-tileset').value, 'Layer mới'); }));
    bind('map-layer-delete', () => { if (confirm('Xóa layer cùng các ô? Undo có thể khôi phục.')) this.change('Xóa layer bản đồ', () => removeMapLayer(this.doc!, this.mapId, this.layerId)); });
    for (const [id, delta] of [['map-layer-up', 1], ['map-layer-down', -1]] as const) bind(id, () => this.change('Sắp xếp layer bản đồ', () => { const m = getMap(this.doc!, this.mapId), at = m.layers.findIndex(l => l.id === this.layerId); reorderMapLayer(this.doc!, this.mapId, this.layerId, at + delta); }));
    bind('map-layer-rename', () => this.change('Đổi tên layer bản đồ', () => updateMapLayer(this.doc!, this.mapId, this.layerId, { name: this.input('map-layer-name').value })));
    for (const [id, field] of [['map-layer-visible', 'visible'], ['map-layer-locked', 'locked']] as const) this.input(id).onchange = () => { void this.action(() => this.change('Thuộc tính layer bản đồ', () => updateMapLayer(this.doc!, this.mapId, this.layerId, { [field]: this.input(id).checked }))); };
    this.input('map-layer-opacity').onchange = () => { void this.action(() => this.change('Độ đục layer bản đồ', () => updateMapLayer(this.doc!, this.mapId, this.layerId, { opacity: Number(this.input('map-layer-opacity').value) }))); };
    this.select('map-tile-collision').onchange = () => { void this.action(() => this.change('Va chạm ô tileset', () => setTileCollision(this.doc!, this.tilesetId(), this.tileId, this.select('map-tile-collision').value as TileCollision))); };
    this.el('map-unlink-tileset').onclick = () => { void this.action(() => { const id = this.tilesetId(), replacement = this.select('map-layer-tileset').value; if (!replacement || replacement === id) throw new Error('Chọn tileset khác ở “Tileset cho layer mới” để thay thế.'); if (confirm('Thay tileset trên mọi bản đồ đang dùng và xóa các ô cũ? Undo khôi phục được cả hai.')) this.change('Thay liên kết tileset', () => unlinkTileset(this.doc!, id, replacement)); }); };
    for (const b of this.dialog.querySelectorAll<HTMLButtonElement>('[data-map-tool]')) b.onclick = () => { this.viewport.cancel(); this.tool = b.dataset.mapTool as MapTool; this.gate(); };
    this.input('map-grid').onchange = () => { this.viewport.grid = this.input('map-grid').checked; this.viewport.draw(); };
    this.input('map-collision').onchange = () => { this.viewport.collision = this.input('map-collision').checked; this.viewport.draw(); };
    this.el('map-fit').insertAdjacentHTML('afterend', '<button id="map-center" type="button">Căn giữa</button>');
    bind('map-fit', () => this.viewport.fit()); bind('map-center', () => this.viewport.center()); bind('map-actual', () => this.viewport.actual());
    bind('map-undo', () => this.options.session.undo()); bind('map-redo', () => this.options.session.undo(true)); bind('map-save', () => this.options.session.flush(true));
    bind('map-copy', () => this.copy(false)); bind('map-cut', () => this.copy(true)); bind('map-delete-selection', () => this.eraseSelection());
    bind('map-paste', async () => { if (!this.clipboard) throw new Error('Chưa sao chép vùng bản đồ.'); await this.load(undefined, true); const point = this.viewport.selection ?? this.viewport.cursor; this.change('Dán vùng bản đồ', () => pasteMapRect(this.doc!, this.mapId, this.layerId, point.x, point.y, this.clipboard!)); });
    bind('map-clear-selection', () => { this.viewport.selection = undefined; this.viewport.draw(); });
    for (const b of this.dialog.querySelectorAll<HTMLButtonElement>('[data-map-export]')) b.onclick = () => { void this.action(() => this.download('map-export', { mapId: this.mapId, format: b.dataset.mapExport })); };
    bind('map-tileset-export', () => this.download('tileset-export', { tilesetId: this.tilesetId() }));
    this.el<HTMLCanvasElement>('map-tile-palette').onclick = e => { const c = e.currentTarget as HTMLCanvasElement, rect = c.getBoundingClientRect(), slot = Math.floor((e.clientY - rect.top) / rect.height * 6) * 8 + Math.floor((e.clientX - rect.left) / rect.width * 8); const set = this.doc?.studio?.tilesets?.[this.tilesetId()]; if (set?.tiles[slot]) { this.tileId = set.tiles[slot].id; this.update(); } };
    this.dialog.addEventListener('keydown', e => {
      if (e.isComposing || (e.target as HTMLElement).closest('input,select,textarea,[contenteditable=true]')) return;
      const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      const id = ctrl ? key === 'z' ? (e.shiftKey ? 'map-redo' : 'map-undo') : ({ y: 'map-redo', c: 'map-copy', x: 'map-cut', v: 'map-paste', s: 'map-save', d: 'map-clear-selection' } as Record<string, string>)[key] : key === 'delete' ? 'map-delete-selection' : undefined;
      if (id) { e.preventDefault(); e.stopPropagation(); this.el<HTMLButtonElement>(id).click(); }
      else if (!ctrl && !e.altKey) { const tool = ({ p: 'pen', e: 'erase', g: 'fill', m: 'select', h: 'hand' } as Record<string, MapTool>)[key]; if (tool) { e.preventDefault(); e.stopPropagation(); this.viewport.cancel(); this.tool = tool; this.gate(); } }
    });
  }
  private tilesetId(): string { return this.doc && this.mapId ? getMapLayer(getMap(this.doc, this.mapId), this.layerId).tilesetId : ''; }
  private async copy(cut: boolean): Promise<void> {
    const r = this.viewport.selection; if (!r) throw new Error('Dùng công cụ Chọn vùng trước.'); await this.load(r);
    this.clipboard = copyMapRect(this.doc!, this.mapId, this.layerId, r.x, r.y, r.w, r.h); if (cut) await this.eraseSelection();
    this.el('map-message').textContent = `Đã sao chép ${r.w}×${r.h} ô.`;
  }
  private async eraseSelection(): Promise<void> {
    const r = this.viewport.selection; if (!r) throw new Error('Chưa chọn vùng.'); await this.load(r);
    this.change('Xóa vùng bản đồ', () => { const s = new MapStroke(this.doc!, this.mapId, this.layerId); for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s.set(x, y, 0, this.input('map-autotile').checked); s.commit(); });
  }
  private async load(rect?: CellRect, all = false, allLayers = false, atlasesOnly = false): Promise<void> {
    const session = this.options.session, doc = this.doc, version = session.version, ticket = this.ticket, id = this.mapId;
    if (!doc || !id) return;
    const map = getMap(doc, id), layers = map.layers.filter(l => allLayers || l.visible || l.id === this.layerId);
    // Autotile rewrites adjacent cells and samples their own neighbors. Keep
    // two cells loaded beyond the viewport/selection, even before it is enabled.
    const area = rect && { x: Math.max(0, rect.x - 2), y: Math.max(0, rect.y - 2), right: Math.min(map.w, rect.x + rect.w + 2), bottom: Math.min(map.h, rect.y + rect.h + 2) };
    const check = () => { if (session.doc !== doc || session.version !== version || this.ticket !== ticket || this.mapId !== id || !this.dialog.open) throw new Error('Bản đồ đã đổi; bỏ thao tác cũ.'); };
    for (const setId of new Set(layers.map(l => l.tilesetId))) {
      const set = doc.studio!.tilesets![setId], asset = doc.assets.find(a => a.id === set.assetId)!; await session.loadFrame(set.frameId, asset); check();
    }
    if (atlasesOnly) return;
    for (const layer of layers) for (const [key, ref] of Object.entries(layer.chunks)) {
      const [x, y] = key.split(',').map(Number);
      if (!all && area && (x * 32 >= area.right || y * 32 >= area.bottom || (x + 1) * 32 <= area.x || (y + 1) * 32 <= area.y)) continue;
      if (all && !allLayers && layer.id !== this.layerId) continue;
      if (!doc.studio!.resources![ref].data) await session.loadResource(ref); check();
      if (!doc.studio!.resources![ref].data) throw new Error('Không tải được khối bản đồ.');
    }
  }
  async open(id?: string): Promise<void> {
    const doc = this.doc; if (!doc) throw new Error('Mở dự án trước.'); await this.options.prepare(); if (this.doc !== doc) return;
    this.projectId = doc.id; this.mapId = id ?? this.mapId; this.dialog.showModal(); this.update(); if (this.mapId) this.viewport.restoreView();
  }
  close(): void { this.viewport.reset(); this.ticket++; this.draft = false; this.dialog.close(); }
  reset(): void { this.close(); this.mapId = this.layerId = this.projectId = ''; this.clipboard = undefined; this.busy = false; }
  update(): void {
    if (!this.dialog.open) return; const doc = this.doc;
    if (!doc || doc.id !== this.projectId) { this.reset(); return; }
    const maps = Object.values(doc.studio?.mapIndex ?? {}), sets = Object.values(doc.studio?.tilesets ?? {});
    if (!maps.some(m => m.id === this.mapId)) { this.mapId = maps[0]?.id ?? ''; this.layerId = ''; }
    this.select('map-list').replaceChildren(...maps.map(m => option(m.id, m.name))); this.select('map-list').value = this.mapId;
    for (const id of ['map-new-tileset', 'map-layer-tileset']) { const select = this.select(id), old = select.value; select.replaceChildren(...sets.map(s => option(s.id, `${s.name} · ${s.tileSize}px`))); if (sets.some(s => s.id === old)) select.value = old; }
    this.el('map-properties').hidden = !this.mapId;
    if (!this.mapId) { this.viewport.reset(); this.el('map-message').textContent = sets.length ? 'Tạo bản đồ để bắt đầu.' : 'Chưa có tileset. Tạo và áp dụng atlas ở “Tileset từ vật liệu” trước.'; this.gate(); return; }
    const map = getMap(doc, this.mapId); if (!map.layers.some(l => l.id === this.layerId)) this.layerId = map.layers[0].id;
    if (['Tạo bản đồ để bắt đầu.', 'Chưa có tileset. Tạo và áp dụng atlas ở “Tileset từ vật liệu” trước.'].includes(this.el('map-message').textContent ?? '')) this.el('map-message').textContent = '';
    const layer = getMapLayer(map, this.layerId), set = doc.studio!.tilesets![layer.tilesetId];
    this.select('map-layer').replaceChildren(...[...map.layers].reverse().map(l => option(l.id, `${l.locked ? '🔒 ' : ''}${l.name}`))); this.select('map-layer').value = this.layerId;
    for (const [id, value] of [['map-name', map.name], ['map-width', map.w], ['map-height', map.h], ['map-layer-name', layer.name]] as const) if (!this.draft) this.input(id).value = String(value);
    this.input('map-layer-visible').checked = layer.visible; this.input('map-layer-locked').checked = layer.locked; this.input('map-layer-opacity').value = String(layer.opacity);
    if (!set.tiles.some(t => t.id === this.tileId)) this.tileId = set.tiles[0].id;
    const tile = set.tiles.find(t => t.id === this.tileId)!; this.select('map-tile-collision').value = tile.collision;
    this.el('map-tile-info').textContent = `ID ${tile.id} · ${tile.mask === null ? 'Ô dự phòng / trang trí' : `Mask ${tile.mask}`} · ${set.name}`;
    this.gate(); this.viewport.draw(); void this.palette();
  }
  private async palette(): Promise<void> {
    const doc = this.doc, ticket = this.ticket, layerId = this.layerId, version = this.options.session.version;
    try {
      await this.load(undefined, false, false, true);
      if (this.doc !== doc || ticket !== this.ticket || version !== this.options.session.version || layerId !== this.layerId || !this.dialog.open) return;
      const set = doc!.studio!.tilesets![this.tilesetId()], image = atlasImage(doc!, set), c = this.el<HTMLCanvasElement>('map-tile-palette'), ctx = c.getContext('2d')!, bytes = new Uint8ClampedArray(image.data.length * 4);
      image.data.forEach((p, i) => { bytes[i * 4] = p >>> 24; bytes[i * 4 + 1] = p >>> 16 & 255; bytes[i * 4 + 2] = p >>> 8 & 255; bytes[i * 4 + 3] = p & 255; });
      const temp = document.createElement('canvas'); temp.width = image.w; temp.height = image.h; temp.getContext('2d')!.putImageData(new ImageData(bytes, image.w, image.h), 0, 0);
      ctx.clearRect(0, 0, c.width, c.height); ctx.imageSmoothingEnabled = false; ctx.drawImage(temp, 0, 0, c.width, c.height); temp.width = temp.height = 1;
      const tile = set.tiles.find(t => t.id === this.tileId)!; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(tile.x / set.tileSize * 32 + 1, tile.y / set.tileSize * 32 + 1, 30, 30);
    } catch (e) { if (this.doc === doc && this.ticket === ticket && this.options.session.version === version && this.dialog.open) this.error(e); }
  }
  gate(): void {
    const conflict = this.options.session.conflict, disabled = this.busy || conflict;
    for (const b of this.dialog.querySelectorAll<HTMLButtonElement>('button')) b.disabled = disabled || (!this.mapId && !['map-close', 'map-create-submit'].includes(b.id));
    this.el<HTMLButtonElement>('map-close').disabled = this.busy;
    this.el<HTMLButtonElement>('map-create-submit').disabled = disabled || !Object.keys(this.doc?.studio?.tilesets ?? {}).length;
    if (this.mapId && this.doc) {
      const map = getMap(this.doc, this.mapId), layer = getMapLayer(map, this.layerId), index = map.layers.indexOf(layer);
      this.el<HTMLButtonElement>('map-layer-up').disabled = disabled || index === map.layers.length - 1;
      this.el<HTMLButtonElement>('map-layer-down').disabled = disabled || index === 0;
      this.el<HTMLButtonElement>('map-layer-delete').disabled = disabled || map.layers.length === 1;
    }
    this.el<HTMLButtonElement>('map-paste').disabled ||= !this.clipboard;
    for (const b of this.dialog.querySelectorAll<HTMLButtonElement>('[data-map-tool]')) b.classList.toggle('active', b.dataset.mapTool === this.tool);
    this.el('map-stage').style.pointerEvents = disabled ? 'none' : '';
    for (const field of this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) field.disabled = this.busy;
    this.el('map-tile-palette').style.pointerEvents = disabled ? 'none' : '';
    if (conflict) this.el('map-message').textContent = 'Dự án có xung đột do thay đổi ở tab khác. Bản nháp được giữ; tải lại hoặc lưu bản sao trước khi sửa.';
  }
  private async download(action: string, value: object): Promise<void> {
    const doc = this.doc, version = this.options.session.version; if (!doc) return; await this.options.session.flush();
    if (this.doc !== doc || this.options.session.version !== version || this.options.session.conflict) throw new Error('Dự án đã đổi; thử xuất lại.');
    const response = await fetch(`/api/pixel/projects/${doc.id}/terrain/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: doc.revision, ...value }) });
    if (!response.ok) { const e = await response.json(); throw new Error(e.error); }
    const blob = await response.blob(); if (this.doc !== doc || this.options.session.version !== version || !this.dialog.open) return;
    const name = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1];
    const link = document.createElement('a'), url = URL.createObjectURL(blob); link.href = url; link.download = name ? decodeURIComponent(name) : `map.${action === 'tileset-export' ? 'zip' : (value as any).format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
