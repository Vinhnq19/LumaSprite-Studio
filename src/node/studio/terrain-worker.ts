import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';
import { atlasImage, mapPixelSize, preflightMapImage, renderMapCells } from '../../studio/tilemap-render.ts';
import { assembleTerrain, terrainEdgeDifferences, TERRAIN_BITS, type TerrainAssembly } from '../../studio/terrain.ts';
import { mapId, mapName, validateMapChunk, type TerrainTileset } from '../../studio/tilemaps.ts';
import { getMap } from '../../studio/map-commands.ts';
import { newAsset, celFor, composite, wireStringify, type PixelDocument } from '../../studio/pixel/model.ts';
import { encodePng } from './png.ts';
import { zipFiles } from './zip.ts';
import type { ExportResult } from './render-result.ts';

export type TerrainRequest = { mode: 'terrain'; root: string; projectId: string; revision: number; rejectExternalEdits?: boolean } & (
  { operation: 'assemble'; assetId: string; frameId: string; name: string; options: TerrainAssembly }
  | { operation: 'tileset-export'; tilesetId: string }
  | { operation: 'map-export'; mapId: string; format: 'json' | 'zip' | 'png' }
);

function exactRevision(store: PixelStore, id: string, revision: number): PixelDocument {
  const doc = store.load(id);
  if (doc.revision !== revision) throw new StudioError('Revision đã thay đổi; dựng lại trên bản mới.', 409);
  return doc;
}
function hydratedAtlas(store: PixelStore, doc: PixelDocument, set: TerrainTileset): void {
  store.hydrate(doc, (a, f) => a.id === set.assetId && f === set.frameId);
}
export function tilesetJson(doc: PixelDocument, set: TerrainTileset, image = 'image.png'): object {
  return { version: 1, kind: 'pxl-tileset', revision: doc.revision, id: set.id, name: set.name, image,
    assetId: set.assetId, frameId: set.frameId, tileSize: set.tileSize, columns: 8, rows: 6,
    width: set.tileSize * 8, height: set.tileSize * 6, emptyTileId: 0, maskBits: TERRAIN_BITS,
    maskOrder: 'pxl-canonical-ascending', diagonalRule: 'both-adjacent-cardinals',
    tiles: set.tiles.map(t => ({ id: t.id, mask: t.mask, collision: t.collision, rect: { x: t.x, y: t.y, w: set.tileSize, h: set.tileSize } })),
    metadata: doc.assets.find(a => a.id === set.assetId)!.metadata };
}
export function portableMap(doc: PixelDocument, id: string): object {
  const map = getMap(doc, id);
  return { version: 1, kind: 'pxl-map', revision: doc.revision, id, name: map.name, width: map.w, height: map.h,
    tileSize: mapPixelSize(doc, id).tileSize, chunkSize: 32, emptyTileId: 0,
    tilesets: [...new Set(map.layers.map(l => l.tilesetId))].map(id => tilesetJson(doc, doc.studio!.tilesets![id], `tilesets/${id}/image.png`)),
    layers: map.layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked, opacity: layer.opacity, tilesetId: layer.tilesetId,
      chunks: Object.entries(layer.chunks).sort(([a], [b]) => { const [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number); return ay - by || ax - bx; }).map(([key, ref]) => {
        const resource = doc.studio!.resources![ref]; if (!resource.data) throw new Error('Cần tải dữ liệu khối trước khi xuất JSON.');
        validateMapChunk(map, key, resource, doc.studio!.tilesets![layer.tilesetId], true);
        const [x, y] = key.split(',').map(Number); return { x, y, width: 32, height: 32, tiles: Array.from(resource.data) };
      }) })),
  };
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const filename = (name: string) => name.replace(/[^\p{L}\p{N}_-]/gu, '_');

export function terrainRequest(r: TerrainRequest): ExportResult {
  const store = new PixelStore(r.root, r.rejectExternalEdits), doc = exactRevision(store, r.projectId, r.revision);
  let result: ExportResult;
  if (r.operation === 'assemble') {
    mapId(r.assetId); mapId(r.frameId);
    const name = mapName(r.name), source = doc.assets.find(a => a.id === r.assetId);
    if (!source || !source.frames.some(f => f.id === r.frameId)) throw new Error('Frame vật liệu không tồn tại.');
    if (source.w !== r.options.tileSize || source.h !== r.options.tileSize) throw new Error('Vật liệu phải có đúng kích thước ô 16×16 hoặc 32×32; không tự resize.');
    store.hydrate(doc, (a, f) => a.id === source.id && f === r.frameId);
    const atlas = assembleTerrain(composite(source, r.frameId).data, r.options), asset = newAsset(name, atlas.w, atlas.h);
    asset.palette = atlas.palette;
    celFor(asset, asset.layers[0].id, asset.frames[0].id, true)!.data = atlas.data;
    const size = r.options.tileSize;
    const sample = composite(source, r.frameId).data;
    const differences = terrainEdgeDifferences(sample, size);
    const horizontal = differences.horizontal.length, vertical = differences.vertical.length;
    const warnings = r.options.sampling === 'repeat' && (horizontal || vertical) ? [`Mép vật liệu khác nhau: ${horizontal} pixel trái/phải, ${vertical} pixel trên/dưới. Kiểm tra đường nối trong preview; app không tự sửa.`] : [];
    result = { data: Buffer.from(wireStringify({ asset, options: r.options, sourceAssetId: source.id, sourceFrameId: r.frameId, warnings,
      png: encodePng(composite(asset, asset.frames[0].id)).toString('base64') })), mime: 'application/json', filename: 'terrain-proposal.json' };
  } else if (r.operation === 'tileset-export') {
    mapId(r.tilesetId); const set = doc.studio?.tilesets?.[r.tilesetId]; if (!set) throw new Error('Tileset không tồn tại.');
    hydratedAtlas(store, doc, set);
    result = { data: zipFiles([{ path: 'image.png', data: encodePng(atlasImage(doc, set)) }, { path: 'tileset.json', data: json(tilesetJson(doc, set)) }]), mime: 'application/zip', filename: `${filename(set.name)}-tileset.zip` };
  } else {
    mapId(r.mapId); const map = getMap(doc, r.mapId), dims = mapPixelSize(doc, map.id);
    if (!['json', 'zip', 'png'].includes(r.format)) throw new Error('Định dạng xuất bản đồ không hợp lệ.');
    if (r.format === 'png') preflightMapImage(dims.w, dims.h); // BEFORE decoding/allocating any image.
    for (const layer of map.layers) for (const ref of Object.values(layer.chunks)) {
      if (!doc.studio!.resources![ref].data) doc.studio!.resources![ref] = store.resource(doc.id, ref);
    }
    if (r.format === 'json') result = { data: json(portableMap(doc, map.id)), mime: 'application/json', filename: `${filename(map.name)}.json` };
    else {
      const sets = [...new Set(map.layers.map(l => l.tilesetId))].map(id => doc.studio!.tilesets![id]);
      for (const set of sets) hydratedAtlas(store, doc, set);
      if (r.format === 'png') result = { data: encodePng(renderMapCells(doc, map.id)), mime: 'image/png', filename: `${filename(map.name)}.png` };
      else result = { data: zipFiles([{ path: 'map.json', data: json(portableMap(doc, map.id)) }, ...sets.flatMap(set => [
        { path: `tilesets/${set.id}/image.png`, data: encodePng(atlasImage(doc, set)) },
        { path: `tilesets/${set.id}/tileset.json`, data: json(tilesetJson(doc, set)) },
      ])]), mime: 'application/zip', filename: `${filename(map.name)}-map.zip` };
    }
  }
  exactRevision(store, r.projectId, r.revision);
  return result;
}
