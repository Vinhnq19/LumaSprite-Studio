import { Img } from './raster.ts';
import { composite, over, type PixelDocument } from './pixel/model.ts';
import { MapStroke, getMap } from './map-commands.ts';
import { type TerrainTileset } from './tilemaps.ts';

export function atlasImage(doc: PixelDocument, tileset: TerrainTileset): Img {
  const asset = doc.assets.find(a => a.id === tileset.assetId);
  if (!asset || !asset.frames.some(f => f.id === tileset.frameId) || asset.w !== tileset.tileSize * 8 || asset.h !== tileset.tileSize * 6) throw new Error('Liên kết atlas không còn hợp lệ.');
  for (const layer of asset.layers) {
    const ref = layer.cels[tileset.frameId];
    if (ref && !asset.cels[ref]?.data) throw new Error('Cần tải cel atlas trước khi dựng bản đồ.');
  }
  return composite(asset, tileset.frameId);
}

export function mapPixelSize(doc: PixelDocument, mapId: string): { w: number; h: number; tileSize: number } {
  const map = getMap(doc, mapId), set = doc.studio?.tilesets?.[map.layers[0].tilesetId];
  if (!set) throw new Error('Không tìm thấy tileset của bản đồ.');
  return { w: map.w * set.tileSize, h: map.h * set.tileSize, tileSize: set.tileSize };
}

export function preflightMapImage(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 16_777_216) throw new Error('PNG bản đồ giới hạn mỗi cạnh 4096 px và 16.777.216 pixel. Xuất JSON/ZIP để giữ bản đồ lớn.');
}

/** Shared export/viewport renderer. Only reads chunks intersecting this cell
 * rectangle. View overlays/grid/collision never enter exported RGBA. */
export function renderMapCells(doc: PixelDocument, mapId: string, rect?: { x: number; y: number; w: number; h: number }, images = new Map<string, Img>()): Img {
  const map = getMap(doc, mapId), size = mapPixelSize(doc, mapId).tileSize;
  const view = rect ?? { x: 0, y: 0, w: map.w, h: map.h };
  if (!Number.isSafeInteger(view.x) || !Number.isSafeInteger(view.y) || !Number.isInteger(view.w) || !Number.isInteger(view.h) || view.w < 1 || view.h < 1 || view.w > 256 || view.h > 256) throw new Error('Vùng dựng phải có vị trí nguyên ô và kích thước 1–256 ô.');
  preflightMapImage(view.w * size, view.h * size);
  const out = new Img(view.w * size, view.h * size);
  for (const layer of map.layers) {
    if (!layer.visible || !layer.opacity) continue;
    const set = doc.studio!.tilesets![layer.tilesetId];
    let atlas = images.get(set.id);
    if (!atlas) { atlas = atlasImage(doc, set); images.set(set.id, atlas); }
    const byId = new Map(set.tiles.map(t => [t.id, t]));
    const reader = new MapStroke(doc, mapId, layer.id, true);
    for (let y = 0; y < view.h; y++) for (let x = 0; x < view.w; x++) {
      const id = reader.get(view.x + x, view.y + y); if (!id) continue;
      const tile = byId.get(id); if (!tile) throw new Error('Bản đồ chứa ID ô không thuộc atlas.');
      for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
        const source = atlas.data[(tile.y + py) * atlas.w + tile.x + px];
        if (!(source & 255)) continue;
        const offset = (y * size + py) * out.w + x * size + px;
        out.data[offset] = layer.opacity === 255 && (source & 255) === 255 ? source : over(out.data[offset], source, layer.opacity);
      }
    }
    reader.cancel();
  }
  return out;
}
