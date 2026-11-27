import { validateArtDirection, type ArtDirection } from './art-direction.ts';
import { getAssetLibraryInfo } from './asset-library.ts';
import { MAX_NATIVE_SCENES, validateNativeSceneRecord, type NativeSceneRecord } from './native-scene.ts';
import { dataArray, dataBoolean, dataId, dataName, dataNumber, dataObject, dataUnique } from './quality/data.ts';
import type { PixelDocument } from './pixel/model.ts';

export const productionKinds = ['character', 'prop', 'item', 'tileset', 'animation', 'ui', 'vfx'] as const;
export type ProductionKind = typeof productionKinds[number];
export interface ProductionStamp { version: number; sha256: string }
export interface ProductionAsset { assetId: string; kind: ProductionKind; profileId: string | null; approved: ProductionStamp | null }
export interface StyleProfile { id: string; name: string; direction: ArtDirection; view: string; pixelScale: number; lockPalette: boolean }
export interface AssetCollection { id: string; name: string; profileId: string | null; assets: string[] }
export interface ScenePlacement { id: string; assetId: string; tagId: string | null; x: number; y: number; stamp: ProductionStamp }
export interface ProductionScene { id: string; name: string; mapId: string; mapSha256: string; placements: ScenePlacement[] }
export interface Production {
  version: 1;
  assets: ProductionAsset[];
  profiles: StyleProfile[];
  collections: AssetCollection[];
  scenes: ProductionScene[];
  nativeScenes?: NativeSceneRecord[];
}
export const emptyProduction = (): Production => ({ version: 1, assets: [], profiles: [], collections: [], scenes: [] });
export const productionLimits = { scenePlacements: 32, sceneSide: 1024, scenePixels: 2_000_000, packageAssets: 64, packagePixels: 8_000_000 } as const;
export interface ProductionCatalog {
  revision: number;
  assets: Record<string, { stamp: ProductionStamp; status: 'draft' | 'approved' | 'stale'; used: boolean }>;
  maps: Record<string, string>;
}
export type SceneSourceIssue = { kind: 'map'; mapId: string; expected: string; current: string | null }
  | { kind: 'asset'; placementId: string; assetId: string; expected: ProductionStamp; current: ProductionStamp | null; status: 'draft' | 'approved' | 'stale' | 'missing' };
export function sceneSourceIssues(scene: ProductionScene, catalog: ProductionCatalog): SceneSourceIssue[] {
  const issues: SceneSourceIssue[] = [], map = catalog.maps[scene.mapId];
  if (map !== scene.mapSha256) issues.push({ kind: 'map', mapId: scene.mapId, expected: scene.mapSha256, current: map ?? null });
  for (const placement of scene.placements) {
    const entry = catalog.assets[placement.assetId];
    if (entry?.status !== 'approved' || !sameStamp(entry.stamp, placement.stamp)) issues.push({
      kind: 'asset', placementId: placement.id, assetId: placement.assetId, expected: placement.stamp, current: entry?.stamp ?? null, status: entry?.status ?? 'missing',
    });
  }
  return issues;
}

export function productionKind(doc: PixelDocument, assetId: string): ProductionKind {
  const explicit = doc.studio?.production?.assets.find(entry => entry.assetId === assetId)?.kind;
  if (explicit) return explicit;
  if (Object.values(doc.studio?.tilesets ?? {}).some(set => set.assetId === assetId)) return 'tileset';
  const kind = getAssetLibraryInfo(doc, assetId).kind;
  return kind === 'object' ? 'prop' : kind;
}

export function productionProfile(doc: PixelDocument, assetId: string, collectionId?: string): StyleProfile | undefined {
  const data = doc.studio?.production, collection = data?.collections.find(c => c.id === collectionId && c.assets.includes(assetId));
  const id = data?.assets.find(entry => entry.assetId === assetId)?.profileId ?? collection?.profileId;
  return data?.profiles.find(profile => profile.id === id);
}

export function sameStamp(a: ProductionStamp | null | undefined, b: ProductionStamp | null | undefined): boolean {
  return !!a && !!b && a.version === b.version && a.sha256 === b.sha256;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw Error('Hash nội dung không hợp lệ.');
  return value;
}

function stamp(value: unknown): ProductionStamp {
  const v = dataObject(value, ['version', 'sha256'], 'Phiên bản sản xuất');
  return { version: dataNumber(v.version, 1, 1_000_000, 'Phiên bản', true), sha256: digest(v.sha256) };
}

export function validateProduction(value: unknown, doc?: PixelDocument, maps = doc?.studio?.mapIndex): Production {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw Error('Production: phải là object thuần.');
  }
  const rawObj = value as Record<string, unknown>;
  const allowedKeys = new Set(['version', 'assets', 'profiles', 'collections', 'scenes', 'nativeScenes']);
  const requiredKeys = ['version', 'assets', 'profiles', 'collections', 'scenes'] as const;
  for (const key of Reflect.ownKeys(rawObj)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) throw Error('Production: thuộc tính không được hỗ trợ.');
  }
  for (const req of requiredKeys) {
    if (!Object.hasOwn(rawObj, req)) throw Error(`Production: thiếu thuộc tính ${req}.`);
  }
  const coreInput = { version: rawObj.version, assets: rawObj.assets, profiles: rawObj.profiles, collections: rawObj.collections, scenes: rawObj.scenes };
  const input = dataObject(coreInput, ['version', 'assets', 'profiles', 'collections', 'scenes'], 'Production');
  if (input.version !== 1) throw Error('Phiên bản Production không được hỗ trợ.');
  const ids = doc && new Set(doc.assets.map(asset => asset.id));
  const assetId = (raw: unknown) => {
    const id = dataId(raw, 'ID asset');
    if (ids && !ids.has(id)) throw Error('Asset còn được Production Workspace tham chiếu hoặc không tồn tại.');
    return id;
  };
  const profiles = dataArray(input.profiles, 0, 32, 'Style Profiles').map(raw => {
    const v = dataObject(raw, ['id', 'name', 'direction', 'view', 'pixelScale', 'lockPalette'], 'Style Profile');
    const direction = validateArtDirection(v.direction, doc), lockPalette = dataBoolean(v.lockPalette, 'Khóa palette');
    if (lockPalette && !direction.palette?.some(ink => ink & 255)) throw Error('Palette khóa cần ít nhất một màu nhìn thấy.');
    return { id: dataId(v.id, 'ID profile'), name: dataName(v.name, 'Tên profile'), direction, lockPalette,
      view: dataName(v.view, 'Hướng nhìn'), pixelScale: dataNumber(v.pixelScale, 1, 16, 'Pixel scale', true) };
  });
  const profileIds = new Set(dataUnique(profiles.map(p => p.id), 'Style Profiles'));
  const profileId = (raw: unknown) => {
    if (raw === null) return null;
    const id = dataId(raw, 'ID profile');
    if (!profileIds.has(id)) throw Error('Profile đang được tham chiếu hoặc không tồn tại.');
    return id;
  };
  const assets = dataArray(input.assets, 0, 1000, 'Danh mục asset').map(raw => {
    const v = dataObject(raw, ['assetId', 'kind', 'profileId', 'approved'], 'Asset sản xuất');
    if (!productionKinds.includes(v.kind as ProductionKind)) throw Error('Loại asset sản xuất không hợp lệ.');
    return { assetId: assetId(v.assetId), kind: v.kind as ProductionKind, profileId: profileId(v.profileId), approved: v.approved === null ? null : stamp(v.approved) };
  });
  const collections = dataArray(input.collections, 0, 64, 'Collections').map(raw => {
    const v = dataObject(raw, ['id', 'name', 'profileId', 'assets'], 'Collection');
    return { id: dataId(v.id, 'ID collection'), name: dataName(v.name, 'Tên collection'), profileId: profileId(v.profileId),
      assets: dataUnique(dataArray(v.assets, 0, 256, 'Thành viên collection').map(assetId), 'Thành viên collection') };
  });
  const scenes = dataArray(input.scenes, 0, 32, 'Scenes').map(raw => {
    const v = dataObject(raw, ['id', 'name', 'mapId', 'mapSha256', 'placements'], 'Cảnh game');
    const mapId = dataId(v.mapId, 'ID map');
    if (doc && !(maps && Object.hasOwn(maps, mapId))) throw Error('Bản đồ còn được cảnh tham chiếu hoặc không tồn tại.');
    const placements = dataArray(v.placements, 0, productionLimits.scenePlacements, 'Bố trí cảnh').map(rawPlacement => {
      const p = dataObject(rawPlacement, ['id', 'assetId', 'tagId', 'x', 'y', 'stamp'], 'Sprite trong cảnh');
      return { id: dataId(p.id, 'ID bố trí'), assetId: assetId(p.assetId), stamp: stamp(p.stamp),
        tagId: p.tagId === null ? null : dataId(p.tagId, 'ID tag'), x: dataNumber(p.x, -4096, 8192, 'X', true), y: dataNumber(p.y, -4096, 8192, 'Y', true) };
    });
    dataUnique(placements.map(p => p.id), 'Bố trí cảnh');
    return { id: dataId(v.id, 'ID cảnh'), name: dataName(v.name, 'Tên cảnh'), mapId, mapSha256: digest(v.mapSha256), placements };
  });
  dataUnique(assets.map(a => a.assetId), 'Danh mục asset');
  dataUnique(collections.map(c => c.id), 'Collections');
  dataUnique(scenes.map(s => s.id), 'Scenes');
  const nativeScenes = rawObj.nativeScenes !== undefined
    ? dataArray(rawObj.nativeScenes, 0, MAX_NATIVE_SCENES, 'Native Scenes').map(entry =>
        validateNativeSceneRecord(entry, doc, doc?.studio?.resources, profileIds))
    : undefined;
  if (nativeScenes) dataUnique(nativeScenes.map(ns => ns.id), 'Native Scenes');
  return { version: 1, assets, profiles, collections, scenes, ...(nativeScenes !== undefined && { nativeScenes }) };
}
