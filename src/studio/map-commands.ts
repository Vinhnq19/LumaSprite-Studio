import { validateDocument, uid, type PixelDocument } from './pixel/model.ts';
import { snapshot } from './pixel/history.ts';
import { MAX_MAP_LAYERS, MAX_MAPS, MAX_TILESETS, mapId, mapName, validateMapChunk, type TileMap, type MapLayer, type TerrainTileset, type TileCollision } from './tilemaps.ts';
import { ATLAS_COLUMNS, CANONICAL_MASKS, terrainSlot, type TileSize } from './terrain.ts';

/** Stage structure and copy-on-write buffers before publishing any mutation.
 * Session wraps this in its existing single-action history/autosave boundary. */
function edit<T>(doc: PixelDocument, action: (next: PixelDocument) => T): T {
  const next = snapshot(doc);
  next.studio ??= { version: 1 };
  next.studio.tilesets ??= {};
  next.studio.mapIndex ??= {};
  next.studio.resources ??= {};
  const result = action(next);
  validateDocument(next);
  doc.studio = next.studio;
  return result;
}
function own<T>(record: Record<string, T> | undefined, id: string, label: string): T {
  mapId(id);
  if (!record || !Object.hasOwn(record, id)) throw new Error(`Không tìm thấy ${label}.`);
  return record[id];
}
export function getMap(doc: PixelDocument, id: string): TileMap { return own(doc.studio?.mapIndex, id, 'bản đồ'); }
export function getMapLayer(map: TileMap, id: string): MapLayer {
  mapId(id); const layer = map.layers.find(l => l.id === id);
  if (!layer) throw new Error('Không tìm thấy layer bản đồ.'); return layer;
}
export function registerTileset(doc: PixelDocument, assetId: string, frameId: string, size: TileSize, name: string, id: string = uid()): string {
  return edit(doc, next => {
    mapId(id);
    if (Object.hasOwn(next.studio!.tilesets!, id)) throw new Error('ID tileset đã tồn tại.');
    if (Object.keys(next.studio!.tilesets!).length >= MAX_TILESETS) throw new Error(`Tối đa ${MAX_TILESETS} tileset.`);
    next.studio!.tilesets![id] = {
      version: 1, id, name: mapName(name), assetId, frameId, tileSize: size,
      tiles: Array.from({ length: 48 }, (_, slot) => ({ id: slot + 1, mask: CANONICAL_MASKS[slot] ?? null, x: slot % ATLAS_COLUMNS * size, y: Math.floor(slot / ATLAS_COLUMNS) * size, collision: slot === 47 ? 'empty' : 'solid' })),
    };
    return id;
  });
}
export function createMap(doc: PixelDocument, tilesetId: string, name: string, w = 64, h = 32, id: string = uid()): string {
  return edit(doc, next => {
    mapId(id); own(next.studio!.tilesets, tilesetId, 'tileset');
    if (Object.keys(next.studio!.mapIndex!).length >= MAX_MAPS) throw new Error(`Tối đa ${MAX_MAPS} bản đồ.`);
    if (Object.hasOwn(next.studio!.mapIndex!, id)) throw new Error('ID bản đồ đã tồn tại.');
    next.studio!.mapIndex![id] = { version: 1, id, name: mapName(name), w, h, layers: [{ id: uid(), name: 'Địa hình', visible: true, locked: false, opacity: 255, tilesetId, chunks: {} }] };
    return id;
  });
}
function referencedResources(doc: PixelDocument): Set<string> {
  const used = new Set<string>();
  for (const map of Object.values(doc.studio?.mapIndex ?? {})) for (const layer of map.layers) for (const ref of Object.values(layer.chunks)) used.add(ref);
  for (const p of Object.values(doc.studio?.characters ?? {})) { used.add(p.source.rgbaResourceId); for (const part of Object.values(p.parts)) used.add(part.maskResourceId); }
  for (const clip of Object.values(doc.studio?.clips ?? {})) { if (clip.movementMaskResourceId) used.add(clip.movementMaskResourceId); for (const slot of clip.slots) used.add(slot.rgbaResourceId); }
  return used;
}
function pruneChunks(doc: PixelDocument, ids: string[]): void {
  const used = referencedResources(doc);
  for (const id of ids) if (id.startsWith('mapchunk_') && !used.has(id) && doc.studio!.resources![id]?.kind === 'tile-index') delete doc.studio!.resources![id];
}
export function removeMap(doc: PixelDocument, mapId: string): void {
  edit(doc, next => { const map = getMap(next, mapId); delete next.studio!.mapIndex![map.id]; pruneChunks(next, map.layers.flatMap(l => Object.values(l.chunks))); });
}
export function renameMap(doc: PixelDocument, mapId: string, name: string): void { edit(doc, next => { getMap(next, mapId).name = mapName(name); }); }
export function mapResizeLoss(doc: PixelDocument, mapId: string, w: number, h: number): number {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 256 || h > 256) throw new Error('Kích thước bản đồ phải là số nguyên 1–256 ô.');
  const map = getMap(doc, mapId); let lost = 0;
  for (const layer of map.layers) {
    const reader = new MapStroke(doc, mapId, layer.id, true);
    for (const key of Object.keys(layer.chunks)) {
      const [cx, cy] = key.split(',').map(Number);
      for (let y = cy * 32; y < Math.min(map.h, cy * 32 + 32); y++) for (let x = cx * 32; x < Math.min(map.w, cx * 32 + 32); x++) {
        if ((x >= w || y >= h) && reader.get(x, y)) lost++;
      }
    }
    reader.cancel();
  }
  return lost;
}
export function resizeMap(doc: PixelDocument, mapId: string, w: number, h: number, discardOutside = false): void {
  const lost = mapResizeLoss(doc, mapId, w, h);
  if (lost && discardOutside !== true) throw new Error(`Đổi kích thước sẽ cắt ${lost} ô ở các layer. Xác nhận trước khi cắt.`);
  edit(doc, next => {
    const map = getMap(next, mapId), old = { w: map.w, h: map.h }, previous: string[] = [];
    for (const layer of map.layers) for (const [key, ref] of Object.entries(layer.chunks)) {
      const [cx, cy] = key.split(',').map(Number);
      if (cx * 32 >= w || cy * 32 >= h) { previous.push(ref); delete layer.chunks[key]; continue; }
      if ((cx + 1) * 32 <= w && (cy + 1) * 32 <= h) continue;
      const resource = next.studio!.resources![ref]; validateMapChunk(old, key, resource, next.studio!.tilesets![layer.tilesetId], true);
      const data = resource.data!.slice(); let changed = false;
      for (let i = 0; i < data.length; i++) if (data[i] && (cx * 32 + i % 32 >= w || cy * 32 + Math.floor(i / 32) >= h)) { data[i] = 0; changed = true; }
      if (changed) {
        previous.push(ref);
        if (!data.some(v => v !== 0)) delete layer.chunks[key];
        else { const id = `mapchunk_${uid()}`; next.studio!.resources![id] = { version: 1, kind: 'tile-index', w: 32, h: 32, data }; layer.chunks[key] = id; }
      }
    }
    map.w = w; map.h = h; pruneChunks(next, previous);
  });
}
export function addMapLayer(doc: PixelDocument, mapId: string, tilesetId: string, name: string): string {
  return edit(doc, next => {
    const map = getMap(next, mapId); own(next.studio!.tilesets, tilesetId, 'tileset');
    if (map.layers.length >= MAX_MAP_LAYERS) throw new Error(`Tối đa ${MAX_MAP_LAYERS} layer bản đồ.`);
    const id = uid(); map.layers.push({ id, name: mapName(name), visible: true, locked: false, opacity: 255, tilesetId, chunks: {} }); return id;
  });
}
export function updateMapLayer(doc: PixelDocument, mapId: string, layerId: string, patch: Partial<Pick<MapLayer, 'name' | 'visible' | 'locked' | 'opacity'>>): void {
  if (Object.keys(patch).some(k => !['name', 'visible', 'locked', 'opacity'].includes(k))) throw new Error('Thuộc tính layer không hỗ trợ.');
  edit(doc, next => { const layer = getMapLayer(getMap(next, mapId), layerId); Object.assign(layer, patch); });
}
export function reorderMapLayer(doc: PixelDocument, mapId: string, layerId: string, index: number): void {
  edit(doc, next => {
    const map = getMap(next, mapId), layer = getMapLayer(map, layerId);
    if (!Number.isInteger(index) || index < 0 || index >= map.layers.length) throw new Error('Vị trí layer không hợp lệ.');
    map.layers.splice(map.layers.indexOf(layer), 1); map.layers.splice(index, 0, layer);
  });
}
export function removeMapLayer(doc: PixelDocument, mapId: string, layerId: string): void {
  edit(doc, next => {
    const map = getMap(next, mapId), layer = getMapLayer(map, layerId);
    if (map.layers.length === 1) throw new Error('Giữ ít nhất một layer bản đồ.');
    map.layers.splice(map.layers.indexOf(layer), 1); pruneChunks(next, Object.values(layer.chunks));
  });
}
export function setTileCollision(doc: PixelDocument, tilesetId: string, tileId: number, collision: TileCollision): void {
  edit(doc, next => {
    const tile = own(next.studio!.tilesets, tilesetId, 'tileset').tiles.find(t => t.id === tileId);
    if (!tile) throw new Error('Không tìm thấy ô tileset.'); tile.collision = collision;
  });
}
/** Explicit, destructive unlink. A caller must present the affected maps first.
 * Tile IDs cannot be reinterpreted across materials: linked layers are cleared. */
export function unlinkTileset(doc: PixelDocument, tilesetId: string, replacementId?: string): void {
  edit(doc, next => {
    own(next.studio!.tilesets, tilesetId, 'tileset');
    if (replacementId === tilesetId) throw new Error('Chọn tileset thay thế khác.');
    if (replacementId) own(next.studio!.tilesets, replacementId, 'tileset thay thế');
    const refs: string[] = [];
    for (const map of Object.values(next.studio!.mapIndex!)) {
      const affected = map.layers.filter(l => l.tilesetId === tilesetId);
      if (!affected.length) continue;
      if (!replacementId) throw new Error(`Tileset còn được bản đồ “${map.name}” sử dụng. Chọn tileset thay thế hoặc xóa bản đồ trước.`);
      for (const layer of affected) { refs.push(...Object.values(layer.chunks)); layer.chunks = {}; layer.tilesetId = replacementId; }
    }
    delete next.studio!.tilesets![tilesetId]; pruneChunks(next, refs);
  });
}

function inMap(map: TileMap, x: number, y: number): boolean { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.w && y < map.h; }
function address(x: number, y: number): [string, number] { return [`${Math.floor(x / 32)},${Math.floor(y / 32)}`, y % 32 * 32 + x % 32]; }
export function readMapCell(doc: PixelDocument, map: TileMap, layer: MapLayer, x: number, y: number): number {
  if (!inMap(map, x, y)) return 0;
  const [key, offset] = address(x, y), ref = layer.chunks[key]; if (!ref) return 0;
  const resource = own(doc.studio?.resources, ref, 'khối bản đồ');
  validateMapChunk(map, key, resource, own(doc.studio?.tilesets, layer.tilesetId, 'tileset'), true);
  return resource.data![offset];
}

/** A gesture owns private chunk buffers, never document buffers. Cancel is free;
 * commit publishes once and refuses a changed document/revision. */
export class MapStroke {
  private readonly owner;
  private readonly revision;
  private readonly chunks = new Map<string, Uint32Array>();
  private readonly loaded = new Map<string, Uint32Array>();
  readonly map: TileMap;
  readonly layer: MapLayer;
  readonly tileset: TerrainTileset;
  private readonly doc: PixelDocument;
  readonly mapId: string;
  readonly layerId: string;
  private readonly readOnly: boolean;
  private readonly tileIds: Set<number>;
  private readonly terrainIds: Set<number>;
  private readonly previewIds = new Map<string, string>();
  private dirty?: { x: number; y: number; w: number; h: number };
  private done = false;
  constructor(doc: PixelDocument, mapId: string, layerId: string, readOnly = false) {
    this.doc = doc; this.mapId = mapId; this.layerId = layerId; this.readOnly = readOnly;
    this.owner = doc.studio; this.revision = doc.revision;
    this.map = getMap(doc, mapId); this.layer = getMapLayer(this.map, layerId);
    if (this.layer.locked && !readOnly) throw new Error('Layer bản đồ đang khóa.');
    this.tileset = own(doc.studio?.tilesets, this.layer.tilesetId, 'tileset');
    this.tileIds = new Set(this.tileset.tiles.map(t => t.id));
    this.terrainIds = new Set(this.tileset.tiles.filter(t => t.mask !== null).map(t => t.id));
  }
  private check(): void {
    if (this.done || this.doc.studio !== this.owner || this.doc.revision !== this.revision) throw new Error('Bản đồ đã thay đổi. Hủy nét cũ và thử lại.');
    if (this.layer.locked && !this.readOnly) throw new Error('Layer bản đồ đang khóa.');
  }
  private buffer(key: string): Uint32Array {
    const changed = this.chunks.get(key); if (changed) return changed;
    const loaded = this.loaded.get(key); if (loaded) return loaded;
    const ref = this.layer.chunks[key];
    if (!ref) { const empty = new Uint32Array(1024); this.loaded.set(key, empty); return empty; }
    const r = own(this.doc.studio?.resources, ref, 'khối bản đồ'); validateMapChunk(this.map, key, r, this.tileset, true);
    this.loaded.set(key, r.data!); return r.data!;
  }
  get(x: number, y: number): number { this.check(); if (!inMap(this.map, x, y)) return 0; const [key, offset] = address(x, y); return this.buffer(key)[offset]; }
  private put(x: number, y: number, value: number): void {
    const [key, offset] = address(x, y); if (this.get(x, y) === value) return;
    if (!this.chunks.has(key)) this.chunks.set(key, this.buffer(key).slice());
    this.chunks.get(key)![offset] = value;
    const d = this.dirty;
    if (!d) this.dirty = { x, y, w: 1, h: 1 };
    else { const right = Math.max(d.x + d.w, x + 1), bottom = Math.max(d.y + d.h, y + 1); d.x = Math.min(d.x, x); d.y = Math.min(d.y, y); d.w = right - d.x; d.h = bottom - d.y; }
  }
  /** All changed cells since the last paint, including autotile neighbors. */
  takePaintRect(): { x: number; y: number; w: number; h: number } | undefined {
    this.check(); const rect = this.dirty; this.dirty = undefined; return rect;
  }
  private terrain(x: number, y: number): boolean { return this.terrainIds.has(this.get(x, y)); }
  set(x: number, y: number, value: number, autotile = true): void {
    this.check();
    if (this.readOnly) throw new Error('Không được sửa bằng bộ đọc bản đồ.');
    if (!inMap(this.map, x, y)) throw new Error('Ô vẽ nằm ngoài bản đồ.');
    if (!Number.isInteger(value) || value < 0 || (value !== 0 && !this.tileIds.has(value))) throw new Error('ID ô không thuộc tileset của layer.');
    this.put(x, y, value);
    if (!autotile) return;
    const neighbors = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8], [1, -1, 16], [1, 1, 32], [-1, 1, 64], [-1, -1, 128]];
    for (let sy = y - 1; sy <= y + 1; sy++) for (let sx = x - 1; sx <= x + 1; sx++) {
      if (!this.terrain(sx, sy)) continue;
      let mask = 0; for (const [dx, dy, bit] of neighbors) if (this.terrain(sx + dx, sy + dy)) mask |= bit;
      this.put(sx, sy, this.tileset.tiles[terrainSlot(mask)].id);
    }
  }
  fill(x: number, y: number, value: number, autotile = true): void {
    this.check(); if (!inMap(this.map, x, y)) throw new Error('Điểm tô nằm ngoài bản đồ.');
    const target = this.get(x, y); if (target === value) return;
    // Collect before painting: autotile changes must not change fill connectivity.
    const seen = new Uint8Array(this.map.w * this.map.h), queue = new Uint32Array(this.map.w * this.map.h), cells: number[] = [];
    let head = 0, tail = 1; queue[0] = y * this.map.w + x; seen[queue[0]] = 1;
    while (head < tail) {
      const at = queue[head++], cx = at % this.map.w, cy = Math.floor(at / this.map.w);
      if (this.get(cx, cy) !== target) continue; cells.push(at);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (!inMap(this.map, nx, ny)) continue; const next = ny * this.map.w + nx;
        if (!seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
    }
    for (const at of cells) this.set(at % this.map.w, Math.floor(at / this.map.w), value, autotile);
  }
  commit(): boolean {
    this.check();
    if (this.readOnly) throw new Error('Không được sửa bằng bộ đọc bản đồ.');
    const changed = [...this.chunks].filter(([key, data]) => data.some((v, i) => v !== this.loaded.get(key)![i]));
    if (!changed.length) { this.done = true; return false; }
    edit(this.doc, next => {
      const layer = getMapLayer(getMap(next, this.mapId), this.layerId), previous: string[] = [];
      for (const [key, data] of changed) {
        if (layer.chunks[key]) previous.push(layer.chunks[key]);
        if (!data.some(v => v !== 0)) { delete layer.chunks[key]; continue; }
        const id = `mapchunk_${uid()}`;
        next.studio!.resources![id] = { version: 1, kind: 'tile-index', w: 32, h: 32, data };
        layer.chunks[key] = id;
      }
      pruneChunks(next, previous);
    });
    this.done = true; return true;
  }
  cancel(): void { this.done = true; this.chunks.clear(); this.loaded.clear(); this.previewIds.clear(); this.dirty = undefined; }
  /** Read-only structure for live preview; staged buffers remain owned by this
   * gesture and are never written into the project's resource map. */
  preview(): PixelDocument {
    this.check();
    const resources = { ...this.doc.studio!.resources }, chunks = { ...this.layer.chunks };
    for (const [key, data] of this.chunks) {
      let ref = this.previewIds.get(key);
      if (!ref) {
        do { ref = `map_preview_${uid()}`; } while (Object.hasOwn(resources, ref));
        this.previewIds.set(key, ref);
      }
      resources[ref] = { version: 1, kind: 'tile-index', w: 32, h: 32, data }; chunks[key] = ref;
    }
    const map = { ...this.map, layers: this.map.layers.map(l => l === this.layer ? { ...l, chunks } : l) };
    return { ...this.doc, studio: { ...this.doc.studio!, resources, mapIndex: { ...this.doc.studio!.mapIndex, [this.mapId]: map } } };
  }
}

export interface MapClipboard { version: 1; projectId: string; tilesetId: string; w: number; h: number; data: Uint32Array }
export function copyMapRect(doc: PixelDocument, mapId: string, layerId: string, x: number, y: number, w: number, h: number): MapClipboard {
  const map = getMap(doc, mapId), layer = getMapLayer(map, layerId);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !inMap(map, x, y) || !inMap(map, x + w - 1, y + h - 1)) throw new Error('Vùng chọn nằm ngoài bản đồ.');
  const data = new Uint32Array(w * h);
  // One stroke reader validates each loaded chunk once.
  const stroke = new MapStroke(doc, mapId, layerId, true);
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) data[dy * w + dx] = stroke.get(x + dx, y + dy);
  stroke.cancel(); return { version: 1, projectId: doc.id, tilesetId: layer.tilesetId, w, h, data };
}
export function pasteMapRect(doc: PixelDocument, mapId: string, layerId: string, x: number, y: number, clipboard: MapClipboard): boolean {
  const map = getMap(doc, mapId), layer = getMapLayer(map, layerId);
  if (clipboard.version !== 1 || clipboard.projectId !== doc.id || clipboard.tilesetId !== layer.tilesetId) throw new Error('Vùng sao chép phải cùng dự án và tileset; không tự đổi ID ô.');
  if (!Number.isInteger(clipboard.w) || !Number.isInteger(clipboard.h) || clipboard.w < 1 || clipboard.h < 1 || !(clipboard.data instanceof Uint32Array) || clipboard.data.length !== clipboard.w * clipboard.h || !inMap(map, x, y) || !inMap(map, x + clipboard.w - 1, y + clipboard.h - 1)) throw new Error('Vùng dán không hợp lệ hoặc vượt mép bản đồ.');
  const stroke = new MapStroke(doc, mapId, layerId);
  for (let dy = 0; dy < clipboard.h; dy++) for (let dx = 0; dx < clipboard.w; dx++) stroke.set(x + dx, y + dy, clipboard.data[dy * clipboard.w + dx], false);
  return stroke.commit();
}
