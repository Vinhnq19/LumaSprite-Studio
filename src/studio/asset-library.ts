import type { PixelDocument, PixelAsset } from './pixel/model.ts';
import { uid } from './pixel/model.ts';

export type LibraryKind = 'character' | 'object' | 'tileset';

export interface LibraryEntry {
  kind: LibraryKind;
  groupId: string;
  version: number;
}

export interface ApplyLibraryOptions {
  kind?: LibraryKind;
  name?: string;
  versionOf?: string;
}

export interface ResolvedAssetLibraryInfo {
  assetId: string;
  kind: LibraryKind;
  groupId: string;
  version: number;
  isExplicit: boolean;
}

export interface GroupedAssetVersion {
  asset: PixelAsset;
  version: number;
}

export interface GroupedAsset {
  groupId: string;
  kind: LibraryKind;
  versions: GroupedAssetVersion[];
}

export interface GroupedLibrary {
  characters: GroupedAsset[];
  objects: GroupedAsset[];
  tilesets: GroupedAsset[];
}

const idPattern = /^[\w-]{1,80}$/;
export const isSafeId = (s: unknown): s is string =>
  typeof s === 'string' && idPattern.test(s) && !['__proto__', 'prototype', 'constructor'].includes(s);

export function validateLibrary(value: unknown, doc?: PixelDocument): Record<string, LibraryEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thư viện asset phải là một object.');
  }
  const v = value as Record<string, unknown>;
  const out: Record<string, LibraryEntry> = {};
  const groupKinds = new Map<string, LibraryKind>();
  const groupVersions = new Map<string, Set<number>>();

  const docAssetIds = doc ? new Set(doc.assets.map(a => a.id)) : null;

  for (const [assetId, rawEntry] of Object.entries(v)) {
    if (!isSafeId(assetId)) {
      throw new Error(`ID asset '${assetId}' trong thư viện không hợp lệ.`);
    }
    if (docAssetIds && !docAssetIds.has(assetId)) {
      throw new Error(`Asset '${assetId}' trong thư viện không tồn tại trong tài liệu.`);
    }
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`Mục thư viện cho asset '${assetId}' phải là một object.`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const allowed = ['kind', 'groupId', 'version'];
    for (const k of Object.keys(entry)) {
      if (!allowed.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
        throw new Error(`Thuộc tính '${k}' trong mục thư viện không được hỗ trợ.`);
      }
    }

    if (typeof entry.kind !== 'string' || !['character', 'object', 'tileset'].includes(entry.kind)) {
      throw new Error(`Loại asset '${String(entry.kind)}' trong thư viện không hợp lệ (hỗ trợ: character, object, tileset).`);
    }
    const kind = entry.kind as LibraryKind;

    if (!isSafeId(entry.groupId)) {
      throw new Error(`Mã nhóm (groupId) '${String(entry.groupId)}' trong thư viện không hợp lệ.`);
    }
    const groupId = entry.groupId as string;

    if (!Number.isInteger(entry.version) || (entry.version as number) < 1 || (entry.version as number) > 1_000_000) {
      throw new Error(`Phiên bản '${String(entry.version)}' trong thư viện phải là số nguyên từ 1 đến 1.000.000.`);
    }
    const version = entry.version as number;

    const existingKind = groupKinds.get(groupId);
    if (existingKind && existingKind !== kind) {
      throw new Error(`Nhóm '${groupId}' có loại asset không đồng nhất (cả ${existingKind} và ${kind}).`);
    }
    groupKinds.set(groupId, kind);

    let versions = groupVersions.get(groupId);
    if (!versions) {
      versions = new Set<number>();
      groupVersions.set(groupId, versions);
    }
    if (versions.has(version)) {
      throw new Error(`Phiên bản ${version} đã tồn tại trong nhóm '${groupId}'.`);
    }
    versions.add(version);

    out[assetId] = { kind, groupId, version };
  }

  return out;
}

export function validateApplyLibraryOptions(options: unknown, doc?: PixelDocument): ApplyLibraryOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Tùy chọn library phải là một object.');
  }
  const opt = options as Record<string, unknown>;
  const allowed = ['kind', 'name', 'versionOf'];
  for (const k of Object.keys(opt)) {
    if (!allowed.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
      throw new Error(`Thuộc tính tùy chọn library '${k}' không được hỗ trợ.`);
    }
  }
  const out: ApplyLibraryOptions = {};
  if (opt.kind !== undefined) {
    if (typeof opt.kind !== 'string' || !['character', 'object', 'tileset'].includes(opt.kind)) {
      throw new Error('Loại asset trong tùy chọn library không hợp lệ (hỗ trợ: character, object, tileset).');
    }
    out.kind = opt.kind as LibraryKind;
  }
  if (opt.name !== undefined) {
    if (typeof opt.name !== 'string' || !opt.name.trim() || opt.name.trim().length > 100) {
      throw new Error('Tên asset trong tùy chọn library không hợp lệ (1–100 ký tự).');
    }
    out.name = opt.name.trim();
  }
  if (opt.versionOf !== undefined) {
    if (!isSafeId(opt.versionOf)) {
      throw new Error('ID asset gốc (versionOf) không hợp lệ.');
    }
    out.versionOf = opt.versionOf;
    if (doc) {
      const targetAsset = doc.assets.find(a => a.id === opt.versionOf);
      if (!targetAsset) {
        throw new Error(`Asset gốc '${opt.versionOf}' không tồn tại.`);
      }
      if (out.kind && doc.studio?.library?.[targetAsset.id]) {
        if (doc.studio.library[targetAsset.id].kind !== out.kind) {
          throw new Error('Loại asset không tương thích với nhóm phiên bản.');
        }
      }
    }
  }
  return out;
}

export function getAssetLibraryInfo(doc: PixelDocument, assetId: string): ResolvedAssetLibraryInfo {
  const entry = doc.studio?.library?.[assetId];
  if (entry) {
    return {
      assetId,
      kind: entry.kind,
      groupId: entry.groupId,
      version: entry.version,
      isExplicit: true,
    };
  }
  return {
    assetId,
    kind: 'object',
    groupId: `asset:${assetId}`,
    version: 1,
    isExplicit: false,
  };
}

export function groupDocumentAssets(doc: PixelDocument): GroupedLibrary {
  const groupsByKind: Record<LibraryKind, Map<string, GroupedAsset>> = {
    character: new Map(),
    object: new Map(),
    tileset: new Map(),
  };

  for (const asset of doc.assets) {
    const info = getAssetLibraryInfo(doc, asset.id);
    const kindMap = groupsByKind[info.kind];
    let group = kindMap.get(info.groupId);
    if (!group) {
      group = {
        groupId: info.groupId,
        kind: info.kind,
        versions: [],
      };
      kindMap.set(info.groupId, group);
    }
    group.versions.push({ asset, version: info.version });
  }

  for (const kindMap of Object.values(groupsByKind)) {
    for (const group of kindMap.values()) {
      group.versions.sort((a, b) => a.version - b.version);
    }
  }

  return {
    characters: Array.from(groupsByKind.character.values()),
    objects: Array.from(groupsByKind.object.values()),
    tilesets: Array.from(groupsByKind.tileset.values()),
  };
}

export function applyLibraryVersion(
  doc: PixelDocument,
  newAsset: PixelAsset,
  options: unknown
): PixelDocument {
  const validated = validateApplyLibraryOptions(options, doc);

  if (doc.assets.some(a => a.id === newAsset.id)) {
    throw new Error(`ID asset '${newAsset.id}' đã tồn tại trong tài liệu.`);
  }

  const appliedAsset: PixelAsset = validated.name ? { ...newAsset, name: validated.name } : { ...newAsset };

  const studio: import('./art-direction.ts').StudioExtension = doc.studio ? { ...doc.studio } : { version: 1 };
  const library: Record<string, LibraryEntry> = { ...(studio.library ?? {}) };

  if (validated.versionOf) {
    const sourceAsset = doc.assets.find(a => a.id === validated.versionOf)!;
    const sourceEntry = library[sourceAsset.id];
    if (sourceEntry) {
      if (validated.kind && validated.kind !== sourceEntry.kind) {
        throw new Error(`Loại asset '${validated.kind}' không tương thích với nhóm '${sourceEntry.kind}'.`);
      }
      const groupVersions = Object.values(library)
        .filter(e => e.groupId === sourceEntry.groupId)
        .map(e => e.version);
      const nextVersion = Math.max(...groupVersions, 1) + 1;
      if (nextVersion > 1_000_000) {
        throw new Error('Nhóm phiên bản đã đạt giới hạn tối đa 1.000.000 phiên bản.');
      }
      library[appliedAsset.id] = {
        kind: sourceEntry.kind,
        groupId: sourceEntry.groupId,
        version: nextVersion,
      };
    } else {
      const groupId = uid();
      const kind = validated.kind ?? 'object';
      library[sourceAsset.id] = {
        kind,
        groupId,
        version: 1,
      };
      library[appliedAsset.id] = {
        kind,
        groupId,
        version: 2,
      };
    }
  } else {
    const groupId = uid();
    const kind = validated.kind ?? 'object';
    library[appliedAsset.id] = {
      kind,
      groupId,
      version: 1,
    };
  }

  studio.library = library;
  const assets = [...doc.assets, appliedAsset];
  const nextDoc: PixelDocument = { ...doc, studio, assets };
  validateLibrary(library, nextDoc);
  return nextDoc;
}

export function removeAssetLibraryAndReferences(
  doc: PixelDocument,
  deletedAssetIds: string[] | Set<string>
): PixelDocument {
  if (!doc.studio) return doc;
  const idSet = deletedAssetIds instanceof Set ? deletedAssetIds : new Set(deletedAssetIds);
  if (!idSet.size) return doc;
  for (const tileset of Object.values(doc.studio.tilesets ?? {})) {
    if (idSet.has(tileset.assetId)) throw new Error(`Atlas đang được tileset “${tileset.name}” sử dụng. Gỡ hoặc chuyển liên kết trước khi xóa.`);
  }

  const studio: import('./art-direction.ts').StudioExtension = { ...doc.studio };
  let modified = false;
  if (studio.production) {
    if (studio.production.scenes.some(scene => scene.placements.some(p => idSet.has(p.assetId))) ||
        studio.production.profiles.some(profile => profile.direction.references?.some(ref => idSet.has(ref.assetId)))) {
      throw Error('Asset đang được cảnh hoặc Style Profile sử dụng. Gỡ tham chiếu trước khi xóa.');
    }
    studio.production = {
      ...studio.production,
      assets: studio.production.assets.filter(entry => !idSet.has(entry.assetId)),
      collections: studio.production.collections.map(collection => ({ ...collection, assets: collection.assets.filter(id => !idSet.has(id)) })),
    };
    modified = true;
  }

  if (studio.library) {
    const nextLib: Record<string, LibraryEntry> = {};
    let libChanged = false;
    for (const [k, v] of Object.entries(studio.library)) {
      if (idSet.has(k)) {
        libChanged = true;
      } else {
        nextLib[k] = v;
      }
    }
    if (libChanged) {
      studio.library = nextLib;
      modified = true;
    }
  }

  if (studio.artDirection?.references) {
    const nextRefs = studio.artDirection.references.filter(r => !idSet.has(r.assetId));
    if (nextRefs.length !== studio.artDirection.references.length) {
      studio.artDirection = {
        ...studio.artDirection,
        references: nextRefs,
      };
      modified = true;
    }
  }

  if (!modified) return doc;
  return { ...doc, studio };
}
