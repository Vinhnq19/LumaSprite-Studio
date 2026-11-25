import { createHash } from 'node:crypto';
import { Img } from '../../studio/raster.ts';
import { encodePng } from './png.ts';
import { getAssetLibraryInfo } from '../../studio/asset-library.ts';
import { getMap } from '../../studio/map-commands.ts';
import { composite, playback, wireStringify, type PixelAsset, type PixelDocument } from '../../studio/pixel/model.ts';
import { productionKind, productionLimits, productionProfile, sameStamp, type ProductionCatalog, type ProductionScene, type ProductionStamp } from '../../studio/production.ts';
import { renderSceneFrame, sceneFrameIndices, type ScenePreview } from '../../studio/scene-preview.ts';
import { mapPixelSize, renderMapCells } from '../../studio/tilemap-render.ts';
import { PixelStore } from './pixel-store.ts';
import { exportPixel } from './pixel-render.ts';
import { terrainRequest } from './terrain-worker.ts';
import { zipFiles } from './zip.ts';
import { StudioError } from './store.ts';
import type { ExportResult } from './render-result.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));

export type ProductionRequest = { mode: 'production'; root: string; projectId: string; revision: number; rejectExternalEdits?: boolean } & (
  { operation: 'thumbnail'; assetId: string; sha256: string }
  | { operation: 'inspect'; assetId: string; collectionId?: string }
  | { operation: 'scene'; sceneId: string }
  | { operation: 'package'; collectionId: string; sceneId?: string }
);

function findAsset(doc: PixelDocument, id: string): PixelAsset {
  const asset = doc.assets.find(a => a.id === id);
  if (!asset) throw new StudioError('Asset không tồn tại.', 404);
  return asset;
}

function assetSha(asset: PixelAsset): string {
  // Work from the saved manifest. Loading a cel into memory leaves its content ID intact.
  return hash([asset.w, asset.h, asset.frames, asset.tags, asset.metadata, asset.palette, asset.layers.map(layer => [
    layer.id, layer.parent, layer.type, layer.visible, layer.opacity,
    Object.entries(layer.cels).sort(([a], [b]) => a.localeCompare(b)).map(([frame, id]) => [frame, asset.cels[id].blob]),
  ])]);
}

function versionOf(doc: PixelDocument, asset: PixelAsset): ProductionStamp {
  return { version: getAssetLibraryInfo(doc, asset.id).version, sha256: assetSha(asset) };
}

function mapSha(doc: PixelDocument, id: string, stamps?: Map<string, ProductionStamp>): string {
  const map = getMap(doc, id);
  const sets = [...new Set(map.layers.map(layer => layer.tilesetId))].map(setId => doc.studio!.tilesets![setId]);
  return hash([map, sets.map(set => [set, stamps?.get(set.assetId)?.sha256 ?? assetSha(findAsset(doc, set.assetId))]),
    map.layers.flatMap(layer => Object.keys(layer.chunks).sort().map(key => doc.studio?.resources?.[layer.chunks[key]]?.blob))]);
}

export function productionCatalog(doc: PixelDocument): ProductionCatalog {
  const settings = doc.studio?.production;
  const approvals = new Map(settings?.assets.map(entry => [entry.assetId, entry.approved]));
  const stamps = new Map(doc.assets.map(asset => [asset.id, versionOf(doc, asset)]));
  const placements = new Set(settings?.scenes.flatMap(scene => scene.placements.map(placement => placement.assetId)));
  return {
    revision: doc.revision,
    assets: Object.fromEntries(doc.assets.map(asset => {
      const approval = approvals.get(asset.id), stamp = stamps.get(asset.id)!;
      return [asset.id, { stamp, status: sameStamp(approval, stamp) ? 'approved' : approval ? 'stale' : 'draft', used: placements.has(asset.id) }];
    })),
    maps: Object.fromEntries(Object.keys(doc.studio?.mapIndex ?? {}).map(id => [id, mapSha(doc, id, stamps)])),
  };
}

function requireApproved(doc: PixelDocument, asset: PixelAsset, expected?: ProductionStamp): ProductionStamp {
  const current = versionOf(doc, asset), approved = doc.studio?.production?.assets.find(e => e.assetId === asset.id)?.approved;
  if (!sameStamp(current, approved) || (expected && !sameStamp(current, expected))) {
    throw new StudioError(`Nội dung “${asset.name}” đã đổi hoặc chưa được duyệt. Duyệt và chọn lại phiên bản.`, 409);
  }
  return current;
}

function findScene(doc: PixelDocument, id: string): ProductionScene {
  const scene = doc.studio?.production?.scenes.find(s => s.id === id);
  if (!scene) throw new StudioError('Cảnh không tồn tại.', 404);
  return scene;
}

function scenePreview(store: PixelStore, doc: PixelDocument, scene: ProductionScene): ScenePreview {
  if (mapSha(doc, scene.mapId) !== scene.mapSha256) throw new StudioError('Bản đồ hoặc atlas đã đổi. Xác nhận cập nhật bản đồ của cảnh.', 409);
  const { w, h, tileSize } = mapPixelSize(doc, scene.mapId);
  if (w > productionLimits.sceneSide || h > productionLimits.sceneSide) throw Error('Scene Preview hỗ trợ bản đồ đến 1024×1024 pixel.');
  const map = getMap(doc, scene.mapId), wanted = new Map<string, Set<string>>();
  const include = (asset: string, frame: string) => {
    if (!wanted.has(asset)) wanted.set(asset, new Set());
    wanted.get(asset)!.add(frame);
  };
  for (const layer of map.layers) {
    const set = doc.studio!.tilesets![layer.tilesetId];
    include(set.assetId, set.frameId);
    for (const resource of Object.values(layer.chunks)) doc.studio!.resources![resource] = store.resource(doc.id, resource);
  }
  const keys = new Map<string, number>(), sequences: { asset: PixelAsset; frames: PixelAsset['frames']; loop: boolean }[] = [];
  const sprites = scene.placements.map(placement => {
    const asset = findAsset(doc, placement.assetId);
    requireApproved(doc, asset, placement.stamp);
    const tag = asset.tags.find(t => t.id === placement.tagId);
    if (placement.tagId && !tag) throw new StudioError('Tag animation đã thay đổi. Chọn lại tag trên sprite.', 409);
    const key = `${asset.id}:${placement.tagId ?? ''}`;
    if (!keys.has(key)) {
      const frames = tag ? playback(asset, tag.id).map(entry => entry.frame) : [asset.frames[0]];
      keys.set(key, sequences.length);
      sequences.push({ asset, frames, loop: tag?.loop ?? false });
      frames.forEach(frame => include(asset.id, frame.id));
    }
    const pivot = asset.metadata.pivot ?? { x: 0, y: 0 };
    return { id: placement.id, assetId: asset.id, name: asset.name, x: placement.x, y: placement.y,
      pivot: { x: pivot.x * asset.w, y: pivot.y * asset.h }, track: keys.get(key)! };
  });
  const trackPixels = sequences.reduce((sum, item) => sum + item.asset.w * item.asset.h * item.frames.length, w * h);
  if (trackPixels > productionLimits.scenePixels) throw Error('Cảnh vượt ngân sách 2 triệu pixel preview.');
  store.hydrate(doc, (asset, frame) => wanted.get(asset.id)?.has(frame) ?? false);
  const tracks = sequences.map(({ asset, frames, loop }) => {
    const raster = new Map<string, Uint32Array>();
    return { w: asset.w, h: asset.h, loop, frames: frames.map(frame => {
      if (!raster.has(frame.id)) raster.set(frame.id, composite(asset, frame.id).data);
      return { id: frame.id, durationMs: frame.duration, rgba: raster.get(frame.id)! };
    }) };
  });
  return { width: w, height: h, tileSize, terrain: renderMapCells(doc, map.id).data, sprites, tracks };
}

export function productionPackagePlan(doc: PixelDocument, collectionId: string, sceneId?: string) {
  const collection = doc.studio?.production?.collections.find(c => c.id === collectionId);
  if (!collection) throw new StudioError('Collection không tồn tại.', 404);
  const scene = sceneId ? findScene(doc, sceneId) : undefined;
  const selected = new Set([...collection.assets, ...(scene?.placements.map(p => p.assetId) ?? [])]);
  const profiles = new Map<string, NonNullable<ReturnType<typeof productionProfile>>>();
  for (const id of selected) {
    const profile = productionProfile(doc, id, collectionId);
    if (!profile || profiles.has(profile.id)) continue;
    profiles.set(profile.id, profile);
    for (const ref of profile.direction.references ?? []) {
      const reference = findAsset(doc, ref.assetId);
      requireApproved(doc, reference);
      selected.add(reference.id);
    }
  }
  if (!selected.size) throw Error('Gói sản xuất cần ít nhất một asset.');
  if (selected.size > productionLimits.packageAssets) throw new StudioError('Gói sản xuất tối đa 64 asset.', 413);
  const assets = [...selected].map(id => findAsset(doc, id));
  if (new Set(assets.map(asset => asset.id.slice(0, 8))).size !== assets.length) throw Error('ID rút gọn của hai asset bị trùng trong atlas.');
  const size = assets.reduce((sum, asset) => sum + asset.w * asset.h * asset.frames.length, 0);
  if (size > productionLimits.packagePixels) throw new StudioError('Gói vượt ngân sách 8 triệu pixel frame.', 413);
  return { collection, scene, selected, profiles, assets, pixelFrames: size };
}

function packageProduction(store: PixelStore, doc: PixelDocument, collectionId: string, sceneId?: string, rejectExternalEdits?: boolean): ExportResult {
  const { collection, scene, selected, profiles, assets } = productionPackagePlan(doc, collectionId, sceneId);
  const preview = scene && scenePreview(store, doc, scene);
  store.hydrate(doc, asset => selected.has(asset.id));
  const request = { document: doc, selected: [...selected] };
  const files: { path: string; data: Buffer }[] = [{ path: 'assets/atlas.zip', data: Buffer.from(exportPixel({ ...request, format: 'atlas' }).data) }];
  const manifest = assets.map(asset => {
    const folder = `assets/${asset.id}`, png = `${folder}/sprite.png`, strip = `${folder}/strip.zip`;
    files.push({ path: png, data: Buffer.from(exportPixel({ ...request, assetId: asset.id, format: 'png' }).data) },
      { path: strip, data: Buffer.from(exportPixel({ ...request, assetId: asset.id, format: 'strip' }).data) });
    const info = getAssetLibraryInfo(doc, asset.id), stamp = versionOf(doc, asset);
    const entry = doc.studio?.production?.assets.find(value => value.assetId === asset.id);
    return { id: asset.id, name: asset.name, groupId: info.groupId, ...stamp, approved: sameStamp(stamp, entry?.approved),
      kind: productionKind(doc, asset.id), profileId: productionProfile(doc, asset.id, collectionId)?.id ?? null, png, strip };
  });
  if (scene && preview) {
    const map = terrainRequest({ mode: 'terrain', operation: 'map-export', root: store.root, projectId: doc.id, revision: doc.revision, mapId: scene.mapId, format: 'zip', rejectExternalEdits });
    files.push({ path: 'map/map.zip', data: Buffer.from(map.data) },
      { path: 'scene/preview.png', data: encodePng(renderSceneFrame(preview, sceneFrameIndices(preview, 0))) });
  }
  files.push({ path: 'production.json', data: bytes({ version: 1, revision: doc.revision, collection, profiles: [...profiles.values()], assets: manifest,
    atlas: 'assets/atlas.zip', scene: scene ? { ...scene, terrain: 'map/map.zip', image: 'scene/preview.png' } : null }) });
  return { data: zipFiles(files), mime: 'application/zip', filename: 'production.zip' };
}

export function productionRequest(request: ProductionRequest): ExportResult {
  const store = new PixelStore(request.root, request.rejectExternalEdits), doc = store.load(request.projectId);
  if (request.operation === 'thumbnail') {
    const asset = findAsset(doc, request.assetId), first = asset.frames[0].id;
    if (assetSha(asset) !== request.sha256) throw new StudioError('Thumbnail đã đổi.', 409, 'STALE_REVISION');
    store.hydrate(doc, (a, frame) => a.id === asset.id && frame === first);
    const source = composite(asset, first), scale = Math.max(1, Math.ceil(Math.max(source.w, source.h) / 64));
    const dest = new Img(Math.ceil(source.w / scale), Math.ceil(source.h / scale));
    for (let y = 0; y < dest.h; y++) for (let x = 0; x < dest.w; x++) dest.set(x, y, source.get(x * scale, y * scale));
    return { data: encodePng(dest), mime: 'image/png', filename: 'thumb.png' };
  }
  if (doc.revision !== request.revision) throw new StudioError('Revision đã thay đổi.', 409, 'STALE_REVISION');
  let result: ExportResult;
  if (request.operation === 'package') result = packageProduction(store, doc, request.collectionId, request.sceneId, request.rejectExternalEdits);
  else if (request.operation === 'scene') result = { data: Buffer.from(wireStringify(scenePreview(store, doc, findScene(doc, request.sceneId)))),
    mime: 'application/json', filename: 'scene.json' };
  else {
    const asset = findAsset(doc, request.assetId);
    const profile = productionProfile(doc, asset.id, request.collectionId), palette = new Set(profile?.direction.palette);
    let outside = 0;
    if (profile?.lockPalette) {
      if (asset.w * asset.h * asset.frames.length > 8_000_000) throw Error('Kiểm style vượt ngân sách 8 triệu pixel frame.');
      store.hydrate(doc, a => a.id === asset.id);
      for (const frame of asset.frames) {
        for (const ink of composite(asset, frame.id).data) if ((ink & 255) && !palette.has(ink)) outside++;
      }
    }
    const staleReferences = (profile?.direction.references ?? []).filter(ref => {
      const found = findAsset(doc, ref.assetId);
      const approved = doc.studio?.production?.assets.find(entry => entry.assetId === found.id)?.approved;
      return !sameStamp(versionOf(doc, found), approved);
    });
    result = { data: bytes({ profileId: profile?.id ?? null, outside, staleReferences }), mime: 'application/json', filename: 'inspect.json' };
  }
  if (store.load(doc.id).revision !== doc.revision) throw new StudioError('Revision đã thay đổi.', 409, 'STALE_REVISION');
  return result;
}
