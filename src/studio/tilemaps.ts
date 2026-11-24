import type { PixelDocument } from './pixel/model.ts';
import { validateResourceId, type StudioResource } from './resources.ts';
import { ATLAS_COLUMNS, ATLAS_ROWS, CANONICAL_MASKS, type TileSize } from './terrain.ts';

export const MAP_CHUNK_SIZE = 32;
export const MAX_MAPS = 32;
export const MAX_TILESETS = 32;
export const MAX_MAP_LAYERS = 16;
export type TileCollision = 'empty' | 'solid' | 'one-way';
export interface TerrainTile { id: number; mask: number | null; x: number; y: number; collision: TileCollision }
export interface TerrainTileset { version: 1; id: string; name: string; assetId: string; frameId: string; tileSize: TileSize; tiles: TerrainTile[] }
export interface MapLayer { id: string; name: string; visible: boolean; locked: boolean; opacity: number; tilesetId: string; chunks: Record<string, string> }
export interface TileMap { version: 1; id: string; name: string; w: number; h: number; layers: MapLayer[] }

function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Dữ liệu tileset/bản đồ phải là object thuần.');
  const out = value as Record<string, unknown>;
  if (keys) for (const key of Object.keys(out)) if (!keys.includes(key)) throw new Error(`Trường bản đồ/tileset không hỗ trợ: ${key}.`);
  return out;
}
export function mapId(value: unknown): string { return validateResourceId(value); }
export function mapName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('Tên phải có 1–100 ký tự.');
  return value.trim();
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Giá trị phải là số nguyên ${min}–${max}.`);
  return value;
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Cờ bản đồ phải là boolean.'); return value; }

export function validateTilesets(value: unknown, doc?: PixelDocument): Record<string, TerrainTileset> {
  const entries = object(value), out: Record<string, TerrainTileset> = {};
  if (Object.keys(entries).length > MAX_TILESETS) throw new Error(`Tối đa ${MAX_TILESETS} tileset.`);
  for (const [key, input] of Object.entries(entries)) {
    mapId(key);
    const v = object(input, ['version', 'id', 'name', 'assetId', 'frameId', 'tileSize', 'tiles']);
    if (v.version !== 1 || mapId(v.id) !== key) throw new Error('Phiên bản hoặc ID tileset không khớp.');
    const size = v.tileSize;
    if (size !== 16 && size !== 32) throw new Error('Tileset chỉ hỗ trợ ô 16 hoặc 32 px.');
    const assetId = mapId(v.assetId), frameId = mapId(v.frameId);
    if (doc) {
      const a = doc.assets.find(a => a.id === assetId);
      if (!a || a.w !== size * ATLAS_COLUMNS || a.h !== size * ATLAS_ROWS || !a.frames.some(f => f.id === frameId)) throw new Error('Atlas đang được tileset sử dụng phải giữ kích thước 8×6 ô và frame nguồn. Hãy gỡ hoặc chuyển liên kết trước.');
    }
    if (!Array.isArray(v.tiles) || v.tiles.length !== 48) throw new Error('Atlas phải có 47 ô chuẩn và một ô dự phòng.');
    const ids = new Set<number>();
    const tiles = v.tiles.map((input, slot) => {
      const t = object(input, ['id', 'mask', 'x', 'y', 'collision']);
      const id = integer(t.id, 1, 0xffffffff);
      if (ids.has(id)) throw new Error('ID ô bị trùng trong tileset.');
      ids.add(id);
      const expected = CANONICAL_MASKS[slot] ?? null;
      if (t.mask !== expected) throw new Error('Thứ tự mask tileset không đúng chuẩn pxl 47 ô.');
      if (t.x !== slot % ATLAS_COLUMNS * size || t.y !== Math.floor(slot / ATLAS_COLUMNS) * size) throw new Error('Vị trí ô không khớp lưới atlas.');
      if (!['empty', 'solid', 'one-way'].includes(t.collision as string)) throw new Error('Va chạm ô không hợp lệ.');
      return { id, mask: expected, x: t.x as number, y: t.y as number, collision: t.collision as TileCollision };
    });
    out[key] = { version: 1, id: key, name: mapName(v.name), assetId, frameId, tileSize: size, tiles };
  }
  return out;
}

export function chunkCoordinates(key: string, map: Pick<TileMap, 'w' | 'h'>): [number, number] {
  if (!/^(0|[1-9]\d*),(0|[1-9]\d*)$/.test(key)) throw new Error('Tọa độ khối phải có dạng x,y chuẩn, không có số âm hoặc số 0 dư.');
  const [x, y] = key.split(',').map(Number);
  if (x >= Math.ceil(map.w / MAP_CHUNK_SIZE) || y >= Math.ceil(map.h / MAP_CHUNK_SIZE)) throw new Error('Khối nằm ngoài bản đồ.');
  return [x, y];
}

/** Validate lazily loaded bytes as well as metadata. Missing bytes are only
 * acceptable while opening a document, never while reading/editing/exporting. */
export function validateMapChunk(map: Pick<TileMap, 'w' | 'h'>, key: string, resource: StudioResource, tileset: TerrainTileset, requireData = false): void {
  const [cx, cy] = chunkCoordinates(key, map);
  if (resource.kind !== 'tile-index' || resource.w !== 32 || resource.h !== 32) throw new Error('Khối bản đồ phải là tài nguyên tile-index 32×32.');
  if (!resource.data) { if (requireData) throw new Error('Cần tải khối bản đồ trước khi chỉnh sửa hoặc xuất.'); return; }
  if (!(resource.data instanceof Uint32Array) || resource.data.length !== 1024) throw new Error('Dữ liệu khối bản đồ phải có 1024 số Uint32.');
  const ids = new Set(tileset.tiles.map(t => t.id));
  for (let i = 0; i < 1024; i++) {
    const id = resource.data[i];
    if (id && (!ids.has(id) || cx * 32 + i % 32 >= map.w || cy * 32 + Math.floor(i / 32) >= map.h)) throw new Error('Khối chứa ID ô lạ hoặc dữ liệu ngoài mép bản đồ.');
  }
}

export function validateMapIndex(value: unknown, tilesets: Record<string, TerrainTileset> = {}, resources: Record<string, StudioResource> = {}): Record<string, TileMap> {
  const entries = object(value), out: Record<string, TileMap> = {};
  if (Object.keys(entries).length > MAX_MAPS) throw new Error(`Tối đa ${MAX_MAPS} bản đồ.`);
  for (const [id, input] of Object.entries(entries)) {
    mapId(id);
    const v = object(input, ['version', 'id', 'name', 'w', 'h', 'layers']);
    if (v.version !== 1 || mapId(v.id) !== id) throw new Error('Phiên bản hoặc ID bản đồ không khớp.');
    const w = integer(v.w, 1, 256), h = integer(v.h, 1, 256);
    if (!Array.isArray(v.layers) || !v.layers.length || v.layers.length > MAX_MAP_LAYERS) throw new Error(`Bản đồ cần 1–${MAX_MAP_LAYERS} layer.`);
    const seen = new Set<string>();
    const layers = v.layers.map(input => {
      const l = object(input, ['id', 'name', 'visible', 'locked', 'opacity', 'tilesetId', 'chunks']);
      const layerId = mapId(l.id), tilesetId = mapId(l.tilesetId);
      if (seen.has(layerId)) throw new Error('ID layer bản đồ bị trùng.'); seen.add(layerId);
      if (!Object.hasOwn(tilesets, tilesetId)) throw new Error('Tileset của layer bản đồ không tồn tại.');
      const chunks: Record<string, string> = {};
      for (const [key, ref] of Object.entries(object(l.chunks))) {
        const resourceId = mapId(ref);
        if (!Object.hasOwn(resources, resourceId)) throw new Error('Tài nguyên khối bản đồ không tồn tại.');
        validateMapChunk({ w, h }, key, resources[resourceId], tilesets[tilesetId]);
        chunks[key] = resourceId;
      }
      return { id: layerId, name: mapName(l.name), visible: flag(l.visible), locked: flag(l.locked), opacity: integer(l.opacity, 0, 255), tilesetId, chunks };
    });
    // Maps may use several materials, but their cell size must remain uniform.
    if (new Set(layers.map(l => tilesets[l.tilesetId].tileSize)).size > 1) throw new Error('Các layer trong một bản đồ phải dùng cùng kích thước ô.');
    out[id] = { version: 1, id, name: mapName(v.name), w, h, layers };
  }
  return out;
}

export function cloneTilesets(value: Record<string, TerrainTileset>): Record<string, TerrainTileset> { return validateTilesets(value); }
export function cloneMapIndex(value: Record<string, TileMap>): Record<string, TileMap> { return structuredClone(value); }

export function assertAtlasMutationAllowed(doc: PixelDocument, assetId: string, change: { w?: number; h?: number; removedFrameIds?: string[]; remove?: boolean }): void {
  for (const tileset of Object.values(doc.studio?.tilesets ?? {})) {
    if (tileset.assetId !== assetId) continue;
    if (change.remove || change.removedFrameIds?.includes(tileset.frameId) || (change.w !== undefined && change.w !== tileset.tileSize * 8) || (change.h !== undefined && change.h !== tileset.tileSize * 6)) {
      throw new Error(`Atlas đang được tileset “${tileset.name}” sử dụng. Gỡ hoặc chuyển liên kết trước khi xóa frame hay đổi kích thước.`);
    }
  }
}
