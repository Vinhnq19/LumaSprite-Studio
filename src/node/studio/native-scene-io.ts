import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  canonicalJson,
  collisionBoxesFromRows,
  computeWalkableRoute,
  defaultStudioState,
  effectiveNativeSceneState,
  fitsWalkable,
  type NativeSceneEngineSnapshot,
  type NativeSceneInteractionAnchor,
  type NativeSceneLayer,
  type NativeScenePoint,
  type NativeSceneRecord,
} from '../../studio/native-scene.ts';
import { compareRgbaExact, renderNativeScene, type NativeSceneBuffers, type NativeSceneRaster } from '../../studio/native-scene-render.ts';
import { Img } from '../../studio/raster.ts';
import type { PixelDocument } from '../../studio/pixel/model.ts';
import type { StudioResource } from '../../studio/resources.ts';
import { PixelStore } from './pixel-store.ts';
import { decodePng, encodePng } from './png.ts';
import type { ExportResult } from './render-result.ts';
import { safePath, StudioError } from './store.ts';
import { zipFiles } from './zip.ts';

export interface NativeSceneImportOptions {
  light?: 'day' | 'night';
  expectedRevision?: string;
  expectedHashes?: Record<string, string>;
  sceneId?: string;
  sceneName?: string;
}

export interface NativeSceneImportResult {
  record: NativeSceneRecord;
  resources: Record<string, StudioResource>;
  warnings: string[];
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function computeProtectedSha256(snapshot: NativeSceneEngineSnapshot): string {
  return sha256(canonicalJson(snapshot));
}

function rgbaBytesFromUint32(data: Uint32Array): Buffer {
  const out = Buffer.alloc(data.length * 4);
  for (let i = 0; i < data.length; i++) out.writeUInt32BE(data[i], i * 4);
  return out;
}

function cropRgbaBytes(raster: { w: number; h: number; rgbaBytes: Buffer }, x: number, y: number, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * raster.w + x) * 4;
    raster.rgbaBytes.copy(out, row * w * 4, start, start + w * 4);
  }
  return out;
}

function normalizeRelPath(raw: string, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new StudioError(`Đường dẫn ${label} trống hoặc không hợp lệ.`, 400, 'INVALID_REFERENCE');
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw) || raw.includes('\\')) {
    throw new StudioError(`Đường dẫn ${label} không an toàn: "${raw}".`, 400, 'BROKEN_REFERENCE');
  }
  const clean = posix.normalize(raw);
  if (clean === '..' || clean.startsWith('../') || clean.split('/').includes('..')) {
    throw new StudioError(`Đường dẫn ${label} cố thoát thư mục gói: "${raw}".`, 400, 'BROKEN_REFERENCE');
  }
  return clean;
}

function parseJsonSafe(buf: Buffer | undefined, name: string): any {
  if (!buf) throw new StudioError(`Thiếu file JSON bắt buộc: ${name}.`, 400, 'MISSING_FILE');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new StudioError(`JSON bị hỏng trong '${name}': ${(err as Error).message}`, 400, 'CORRUPTED_JSON');
  }
}

function resolvePackageFile(
  files: Record<string, Buffer>,
  ref: string,
  scenePrefix: string,
  label: string,
): { path: string; buffer: Buffer } {
  const rel = normalizeRelPath(ref, label);
  const candidates = rel.endsWith('.png') ? [rel] : [`${rel}.png`, rel];
  if (scenePrefix && rel.startsWith(scenePrefix)) {
    const stripped = rel.slice(scenePrefix.length);
    candidates.push(stripped.endsWith('.png') ? stripped : `${stripped}.png`, stripped);
  }
  for (const candidate of candidates) {
    if (Object.hasOwn(files, candidate)) return { path: candidate, buffer: files[candidate] };
  }
  throw new StudioError(`Tham chiếu file không tồn tại (${label}): "${ref}".`, 400, 'BROKEN_REFERENCE');
}

function decodePngSafe(buf: Buffer, label: string) {
  try {
    return decodePng(buf);
  } catch (err) {
    throw new StudioError(`Lỗi đọc PNG (${label}): ${(err as Error).message}`, 400, 'INVALID_PNG');
  }
}

function collectDirectoryFiles(sourceDir: string): Record<string, Buffer> {
  if (!existsSync(sourceDir)) throw new StudioError(`Thư mục scene không tồn tại: ${sourceDir}`, 404, 'SOURCE_NOT_FOUND');
  const st = statSync(sourceDir);
  if (!st.isDirectory()) throw new StudioError(`Đường dẫn nguồn phải là thư mục: ${sourceDir}`, 400, 'SOURCE_NOT_DIR');
  const out: Record<string, Buffer> = {};
  const walk = (relDir: string, depth: number) => {
    if (depth > 4) return;
    const absDir = relDir ? safePath(sourceDir, relDir) : sourceDir;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel, depth + 1);
      else if (entry.isFile() && /\.(json|png)$/i.test(entry.name)) {
        out[rel] = readFileSync(safePath(sourceDir, rel));
      }
    }
  };
  walk('', 0);
  return out;
}

function makeResourceId(sceneId: string, suffix: string): string {
  const tag = sha256(sceneId).slice(0, 8);
  const cleanSuffix = suffix.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `ns_${tag}_${cleanSuffix}`;
}

function parseWalkableSpans(walkable: unknown, width: number, height: number): number[][] {
  if (!Array.isArray(walkable) || walkable.length !== height) {
    throw new StudioError(`Dữ liệu walkable không khớp chiều cao scene (${height}).`, 400, 'INVALID_WALKABLE');
  }
  return walkable.map((entry, y) => {
    const spansRaw = Array.isArray(entry)
      ? entry.flat()
      : (entry && typeof entry === 'object' && Array.isArray((entry as { spans?: unknown }).spans))
        ? (entry as { spans: unknown[] }).spans
        : null;
    if (!spansRaw || spansRaw.length % 2 !== 0) {
      throw new StudioError(`Hàng walkable[${y}] sai định dạng RLE.`, 400, 'INVALID_WALKABLE');
    }
    let prevEnd = -1;
    return spansRaw.map((n, idx) => {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > width) {
        throw new StudioError(`Tọa độ walkable[${y}][${idx}] không hợp lệ.`, 400, 'INVALID_WALKABLE');
      }
      if (idx % 2 === 0 && n <= prevEnd) throw new StudioError(`walkable[${y}] chồng lấn span.`, 400, 'INVALID_WALKABLE');
      if (idx % 2 === 1) {
        const start = spansRaw[idx - 1] as number;
        if (n <= start) throw new StudioError(`walkable[${y}] span rỗng/ngược.`, 400, 'INVALID_WALKABLE');
        prevEnd = n;
      }
      return n;
    });
  });
}

function checkExpectedHashes(fileHashes: Record<string, string>, expected?: Record<string, string>): void {
  if (!expected) return;
  for (const [path, exp] of Object.entries(expected)) {
    const actual = fileHashes[path];
    if (!actual || actual !== exp) {
      throw new StudioError(`STALE_HASH: Hash của '${path}' không khớp (${actual ?? 'missing'} != ${exp}).`, 409, 'STALE_HASH');
    }
  }
}

export function importNativeSceneFromDirectory(sourceDir: string, options: NativeSceneImportOptions = {}): NativeSceneImportResult {
  const files = collectDirectoryFiles(sourceDir);
  return importNativeSceneFromFiles(files, options);
}

export function importNativeSceneFromFiles(files: Record<string, Buffer>, options: NativeSceneImportOptions = {}): NativeSceneImportResult {
  const normalized: Record<string, Buffer> = {};
  const fileHashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    const clean = normalizeRelPath(k, 'package file');
    normalized[clean] = v;
    fileHashes[clean] = sha256(v);
  }
  checkExpectedHashes(fileHashes, options.expectedHashes);

  const rootSceneJson = Object.keys(normalized).find(k => k === 'scene.json' || /^[^/]+\/(day|night)\/scene\.json$/.test(k));
  if (rootSceneJson) {
    return importE8RuntimePackage(normalized, fileHashes, rootSceneJson, options);
  }

  const light: 'day' | 'night' = options.light ?? (Object.keys(normalized).some(k => k === 'scene-night.json') && !normalized['scene-day.json'] ? 'night' : 'day');
  if (normalized[`scene-${light}.json`]) {
    return importE76rB2Package(normalized, fileHashes, light, options);
  }
  throw new StudioError('Thư mục/gói không chứa scene.json (E8) hoặc scene-day.json/scene-night.json (E7.6R).', 400, 'UNKNOWN_PACKAGE_FORMAT');
}

function importE8RuntimePackage(
  files: Record<string, Buffer>,
  fileHashes: Record<string, string>,
  sceneJsonPath: string,
  options: NativeSceneImportOptions,
): NativeSceneImportResult {
  const raw = parseJsonSafe(files[sceneJsonPath], sceneJsonPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StudioError('scene.json phải là object.', 400, 'CORRUPTED_JSON');
  if (raw.version !== 1) throw new StudioError(`UNSUPPORTED_SCHEMA_VERSION: Chỉ hỗ trợ schema version 1 (nhận ${String(raw.version)}).`, 400, 'UNSUPPORTED_SCHEMA_VERSION');

  const sceneKey = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const light = raw.light === 'night' ? 'night' : raw.light === 'day' ? 'day' : null;
  const sourceRevision = typeof raw.revision === 'string' ? raw.revision : '';
  if (!sceneKey || !light || !/^[A-Za-z0-9_.-]{4,80}$/.test(sourceRevision)) {
    throw new StudioError('Thiếu metadata provenance (id, light, revision) trong scene.json.', 400, 'MISSING_METADATA');
  }
  if (options.expectedRevision && sourceRevision !== options.expectedRevision) {
    throw new StudioError(`REVISION_MISMATCH: Dự kiến '${options.expectedRevision}', nhận '${sourceRevision}'.`, 409, 'REVISION_MISMATCH');
  }

  const dirPrefix = sceneJsonPath.includes('/') ? sceneJsonPath.slice(0, sceneJsonPath.lastIndexOf('/') + 1) : '';
  const canonicalScenePrefix = `${sceneKey}/${light}/`;

  const lockedSceneFile = files[`${dirPrefix}locked-scene.json`];
  const lockedMapFile = files[`${dirPrefix}locked-tilemap.json`];
  if (lockedSceneFile && raw.source?.lockedScene && fileHashes[`${dirPrefix}locked-scene.json`] !== raw.source.lockedScene) {
    throw new StudioError('STALE_HASH: locked-scene.json không khớp source.lockedScene.', 409, 'STALE_HASH');
  }
  if (lockedMapFile && raw.source?.lockedMap && fileHashes[`${dirPrefix}locked-tilemap.json`] !== raw.source.lockedMap) {
    throw new StudioError('STALE_HASH: locked-tilemap.json không khớp source.lockedMap.', 409, 'STALE_HASH');
  }
  const lockedScene = lockedSceneFile ? parseJsonSafe(lockedSceneFile, 'locked-scene.json') : null;
  const lockedMap = lockedMapFile ? parseJsonSafe(lockedMapFile, 'locked-tilemap.json') : null;

  const width = raw.width, height = raw.height, ppu = raw.pixelsPerUnit;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || !Number.isInteger(ppu) || ppu < 1) {
    throw new StudioError('Kích thước scene hoặc pixelsPerUnit không hợp lệ.', 400, 'INVALID_DIMENSIONS');
  }

  const tiles = raw.tiles;
  if (!tiles || !Number.isInteger(tiles.size) || !Number.isInteger(tiles.atlasColumns) || !Number.isInteger(tiles.cellCount) || !Array.isArray(tiles.ids)) {
    throw new StudioError('Thiếu dữ liệu tilemap (tiles.size / atlasColumns / cellCount / ids).', 400, 'MISSING_TILEMAP');
  }
  if (tiles.size < 8 || tiles.atlasColumns < 1 || tiles.cellCount < 1 || width % tiles.size !== 0 || height % tiles.size !== 0) {
    throw new StudioError('Cấu hình kích thước lưới tilemap không hợp lệ.', 400, 'INVALID_TILEMAP');
  }
  const expectedCount = (width / tiles.size) * (height / tiles.size);
  if (tiles.ids.length !== expectedCount) {
    throw new StudioError(`Số lượng tile ID (${tiles.ids.length}) không khớp (${expectedCount}).`, 400, 'INVALID_TILEMAP');
  }
  for (let i = 0; i < tiles.ids.length; i++) {
    const tid = tiles.ids[i];
    if (!Number.isInteger(tid) || tid < 0 || tid >= tiles.cellCount) {
      throw new StudioError(`MISSING_TILE_ID: Tile ID tại ô ${i} không hợp lệ (${String(tid)}, cellCount=${tiles.cellCount}).`, 400, 'MISSING_TILE_ID');
    }
  }

  const atlasRes = resolvePackageFile(files, `${dirPrefix ? '' : ''}${raw.atlas}`, canonicalScenePrefix, 'atlas');
  const atlasPng = decodePngSafe(atlasRes.buffer, atlasRes.path);
  if (atlasPng.w !== tiles.atlasColumns * tiles.size || atlasPng.h < Math.ceil(tiles.cellCount / tiles.atlasColumns) * tiles.size) {
    throw new StudioError(`Kích thước atlas PNG (${atlasPng.w}×${atlasPng.h}) không khớp thông số tilemap.`, 400, 'INVALID_ATLAS');
  }
  if (Array.isArray(lockedMap?.cells)) {
    for (const cell of lockedMap.cells) {
      const tileBytes = cropRgbaBytes(atlasPng, cell.x, cell.y, tiles.size, tiles.size);
      if (sha256(tileBytes) !== cell.rgbaSha256) {
        throw new StudioError(`STALE_HASH: Tile #${cell.id} trong atlas PNG không khớp locked-tilemap.json.`, 409, 'STALE_HASH');
      }
    }
  }

  const fgRes = resolvePackageFile(files, raw.foreground, canonicalScenePrefix, 'foreground');
  const fgPng = decodePngSafe(fgRes.buffer, fgRes.path);
  if (fgPng.w !== width || fgPng.h !== height) {
    throw new StudioError(`Kích thước foreground (${fgPng.w}×${fgPng.h}) không khớp scene (${width}×${height}).`, 400, 'INVALID_FOREGROUND');
  }

  let corrPng: ReturnType<typeof decodePngSafe> | undefined;
  if (raw.correction) {
    const corrRes = resolvePackageFile(files, raw.correction, canonicalScenePrefix, 'correction');
    corrPng = decodePngSafe(corrRes.buffer, corrRes.path);
    if (corrPng.w !== width || corrPng.h !== height) {
      throw new StudioError('Kích thước underlay correction không khớp scene.', 400, 'INVALID_CORRECTION');
    }
  }

  const walkableRows = parseWalkableSpans(raw.walkable, width, height);
  if (!Array.isArray(raw.collision)) throw new StudioError('Thiếu danh sách collision boxes.', 400, 'MISSING_COLLISION');
  const collisionBoxes = raw.collision.map((b: any, i: number) => {
    if (!b || !Number.isInteger(b.x) || !Number.isInteger(b.y) || !Number.isInteger(b.w) || !Number.isInteger(b.h)
      || b.x < 0 || b.y < 0 || b.w <= 0 || b.h <= 0 || b.x + b.w > width || b.y + b.h > height) {
      throw new StudioError(`Collision box[${i}] vượt biên hoặc sai định dạng.`, 400, 'INVALID_COLLISION');
    }
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  });

  const clearance = { x: raw.clearance?.x, y: raw.clearance?.y };
  const spawn = { x: raw.spawn?.x, y: raw.spawn?.y };
  if (!Number.isInteger(clearance.x) || !Number.isInteger(clearance.y) || clearance.x < 0 || clearance.y < 0) {
    throw new StudioError('Thiếu thông số clearance hợp lệ.', 400, 'INVALID_CLEARANCE');
  }
  if (!fitsWalkable({ width, height, clearance, walkableRows }, spawn)) {
    throw new StudioError(`Vị trí spawn (${spawn.x}, ${spawn.y}) không đi được hoặc thiếu clearance.`, 400, 'INVALID_SPAWN');
  }

  if (!Array.isArray(raw.layers) || !raw.layers.length) {
    throw new StudioError('Thiếu danh sách layer thực thể trong scene.json.', 400, 'INVALID_LAYER_METADATA');
  }

  const sceneId = options.sceneId ?? `e8-${sceneKey}-${light}`;
  const resources: Record<string, StudioResource> = {};
  const atlasResourceId = makeResourceId(sceneId, 'atlas');
  resources[atlasResourceId] = { version: 1, kind: 'rgba', w: atlasPng.w, h: atlasPng.h, data: atlasPng.data };
  const foregroundResourceId = makeResourceId(sceneId, 'fg');
  resources[foregroundResourceId] = { version: 1, kind: 'rgba', w: fgPng.w, h: fgPng.h, data: fgPng.data };
  let underlayCorrectionResourceId: string | null = null;
  if (corrPng) {
    underlayCorrectionResourceId = makeResourceId(sceneId, 'corr');
    resources[underlayCorrectionResourceId] = { version: 1, kind: 'rgba', w: corrPng.w, h: corrPng.h, data: corrPng.data };
  }

  const lockedEntities = new Map<string, any>(
    Array.isArray(lockedScene?.entities) ? lockedScene.entities.map((e: any) => [String(e.id), e]) : [],
  );
  const layerBuffers: Record<string, NativeSceneRaster> = {};
  const actors: Record<string, NativeScenePoint> = {};
  const propAnchors: NativeSceneEngineSnapshot['propAnchors'] = [];
  let prevY = -1;
  const layers: NativeSceneLayer[] = raw.layers.map((l: any, i: number) => {
    if (!l || typeof l.id !== 'string' || !['building', 'prop', 'actor'].includes(l.kind) || l.order !== i) {
      throw new StudioError(`INVALID_LAYER_METADATA: Layer[${i}] sai metadata hoặc thứ tự order.`, 400, 'INVALID_LAYER_METADATA');
    }
    if (!l.at || !Number.isInteger(l.at.x) || !Number.isInteger(l.at.y) || l.at.x < 0 || l.at.x > width || l.at.y < 0 || l.at.y > height) {
      throw new StudioError(`INVALID_LAYER_METADATA: Layer '${l.id}' có tọa độ at ngoài biên.`, 400, 'INVALID_LAYER_METADATA');
    }
    if (l.at.y < prevY) {
      throw new StudioError(`INVALID_LAYER_METADATA: Layer '${l.id}' vi phạm depth ordering (y=${l.at.y} < ${prevY}).`, 400, 'INVALID_LAYER_METADATA');
    }
    prevY = l.at.y;
    if (!l.pivot || !Number.isInteger(l.pivot.x) || !Number.isInteger(l.pivot.y)) {
      throw new StudioError(`INVALID_LAYER_METADATA: Layer '${l.id}' thiếu pivot.`, 400, 'INVALID_LAYER_METADATA');
    }
    const layerFile = resolvePackageFile(files, l.texture, canonicalScenePrefix, `layer:${l.id}`);
    const layerPng = decodePngSafe(layerFile.buffer, layerFile.path);
    const texResId = makeResourceId(sceneId, `l_${i}_${l.id}`);
    resources[texResId] = { version: 1, kind: 'rgba', w: layerPng.w, h: layerPng.h, data: layerPng.data };
    layerBuffers[texResId] = { w: layerPng.w, h: layerPng.h, data: layerPng.data };

    if (l.kind === 'actor') actors[l.id] = { x: l.at.x, y: l.at.y };
    if (l.kind === 'prop') propAnchors.push({ id: l.id, kind: l.kind, at: { x: l.at.x, y: l.at.y }, linkedLayerId: l.id });
    const le = lockedEntities.get(l.id);
    return {
      id: l.id,
      kind: l.kind,
      at: { x: l.at.x, y: l.at.y },
      pivot: { x: l.pivot.x, y: l.pivot.y },
      order: l.order,
      textureResourceId: texResId,
      texturePath: l.texture,
      ...(le && {
        bounds: { left: le.left, top: le.top, w: le.w, h: le.h },
        visibleBefore: le.visibleBefore,
        visible: le.visible,
        hiddenBy: le.hiddenBy,
        alphaSha256: le.alphaSha256,
      }),
    };
  });

  if (!actors.surveyor) {
    throw new StudioError('Thiếu layer nhân vật điều khiển (surveyor) trong scene.', 400, 'MISSING_ACTOR');
  }

  const interactions: NativeSceneInteractionAnchor[] = [];
  if (raw.landmark) {
    const lm = raw.landmark;
    if (!lm.kind || !lm.at || !Number.isInteger(lm.at.x) || !Number.isInteger(lm.at.y)
      || lm.at.x < 0 || lm.at.x >= width || lm.at.y < 0 || lm.at.y >= height) {
      throw new StudioError('INVALID_INTERACTION_ANCHOR: landmark.at ngoài biên hoặc thiếu.', 400, 'INVALID_INTERACTION_ANCHOR');
    }
    const stand = lm.stand && Number.isInteger(lm.stand.x) && Number.isInteger(lm.stand.y)
      ? { x: lm.stand.x, y: lm.stand.y }
      : null;
    if (!stand || !fitsWalkable({ width, height, clearance, walkableRows }, stand)) {
      throw new StudioError(`INVALID_INTERACTION_ANCHOR: landmark.stand (${stand?.x}, ${stand?.y}) không đi được.`, 400, 'INVALID_INTERACTION_ANCHOR');
    }
    interactions.push({
      id: 'primary-landmark',
      key: 'landmark',
      kind: String(lm.kind),
      at: { x: lm.at.x, y: lm.at.y },
      stand,
      linkedEntityId: null,
      label: null,
      sourceRevision,
    });
  } else {
    throw new StudioError('INVALID_INTERACTION_ANCHOR: Thiếu landmark tương tác trong E8 scene.json.', 400, 'INVALID_INTERACTION_ANCHOR');
  }

  const contractGaps: string[] = [
    'INTERACTION_LABEL_AND_LINKED_ENTITY_NOT_IN_ENGINE_V1: Engine E8 scene.json cung cấp kind/at/stand; label hiển thị nằm hard-coded trong Unity E8InteractionHud.cs và không có linkedEntityId trong JSON.',
  ];
  if (!lockedSceneFile) contractGaps.push('LOCKED_SCENE_SIDECAR_ABSENT: Không có locked-scene.json cạnh scene.json để bổ sung colliders/style/profile.');

  const snapshot: NativeSceneEngineSnapshot = {
    schemaVersion: 1,
    packageFormat: 'e8-runtime',
    sceneKey,
    light,
    sourceRevision,
    coordinateSystem: lockedScene?.coordinateSystem ?? 'top-left scene pixels; E8 runtime projection',
    width,
    height,
    origin: lockedMap?.origin ?? [0, 0],
    pixelsPerUnit: ppu,
    camera: lockedScene?.camera ?? { width, height, sampling: 'nearest', pixelsPerUnit: ppu },
    styleRef: lockedScene?.style ?? null,
    profileRef: lockedScene?.profile ?? null,
    intent: lockedScene?.intent ?? null,
    tilemap: {
      version: 1,
      tileSize: tiles.size,
      columns: tiles.atlasColumns,
      cellCount: tiles.cellCount,
      width,
      height,
      origin: lockedMap?.origin ?? [0, 0],
      sampling: 'nearest',
      ids: tiles.ids.slice(),
      atlasResourceId,
      ...(Array.isArray(lockedMap?.cells) && { cells: lockedMap.cells }),
      ...(typeof lockedMap?.groundRgbaSha256 === 'string' && { groundRgbaSha256: lockedMap.groundRgbaSha256 }),
      ...(typeof lockedMap?.sceneRgbaSha256 === 'string' && { sceneRgbaSha256: lockedMap.sceneRgbaSha256 }),
    },
    foregroundResourceId,
    underlayCorrectionResourceId,
    layers,
    layerOrder: layers.map(l => l.id),
    walkableRows,
    collisionRows: Array.isArray(lockedScene?.masks?.collision) ? parseWalkableSpans(lockedScene.masks.collision, width, height) : undefined,
    collisionBoxes,
    colliders: Array.isArray(lockedScene?.colliders) ? lockedScene.colliders : [],
    spawn,
    actors,
    clearance,
    propAnchors,
    interactions,
    aperture: raw.aperture ?? null,
    probes: Array.isArray(raw.probes) ? raw.probes : [],
    route: Array.isArray(raw.route) ? raw.route : [],
    provenance: {
      sourceSha256: typeof raw.source?.fixture === 'string' && /^[a-f0-9]{64}$/.test(raw.source.fixture)
        ? raw.source.fixture
        : fileHashes[sceneJsonPath],
      ...(typeof raw.source?.lockedScene === 'string' && { lockedSceneSha256: raw.source.lockedScene }),
      ...(typeof raw.source?.lockedMap === 'string' && { lockedTilemapSha256: raw.source.lockedMap }),
      ...(typeof raw.source?.lockedFrame === 'string' && { lockedFrameSha256: raw.source.lockedFrame }),
      ...(typeof raw.source?.rgba === 'string' && { expectedCompositeRgbaSha256: raw.source.rgba }),
      fileHashes,
      importedAt: new Date().toISOString(),
      contractGaps,
    },
  };

  const tempRecord: NativeSceneRecord = {
    id: sceneId,
    name: options.sceneName ?? `${sceneKey} (${light})`,
    protectedSha256: computeProtectedSha256(snapshot),
    engineSnapshot: snapshot,
    studioState: defaultStudioState(layers.map(l => l.id)),
  };

  const renderedComposite = renderNativeScene(tempRecord, {
    atlas: { w: atlasPng.w, h: atlasPng.h, data: atlasPng.data },
    foreground: { w: fgPng.w, h: fgPng.h, data: fgPng.data },
    ...(corrPng && { underlayCorrection: { w: corrPng.w, h: corrPng.h, data: corrPng.data } }),
    layers: layerBuffers,
  }, { mode: 'composite', applyOverrides: false });

  if (snapshot.provenance.expectedCompositeRgbaSha256) {
    const actualRgbaSha = sha256(rgbaBytesFromUint32(renderedComposite.data));
    if (actualRgbaSha !== snapshot.provenance.expectedCompositeRgbaSha256) {
      throw new StudioError(
        `STALE_HASH: Kết xuất RGBA (${actualRgbaSha.slice(0, 12)}) không khớp source.rgba (${snapshot.provenance.expectedCompositeRgbaSha256.slice(0, 12)}).`,
        409,
        'STALE_HASH',
      );
    }
  }

  return { record: tempRecord, resources, warnings: [] };
}

function importE76rB2Package(
  files: Record<string, Buffer>,
  fileHashes: Record<string, string>,
  light: 'day' | 'night',
  options: NativeSceneImportOptions,
): NativeSceneImportResult {
  const sceneFileName = `scene-${light}.json`;
  const tilemapFileName = `tilemap-${light}.json`;
  const raw = parseJsonSafe(files[sceneFileName], sceneFileName);
  const tm = parseJsonSafe(files[tilemapFileName], tilemapFileName);
  if (raw.version !== 1 || tm.version !== 1) {
    throw new StudioError(`UNSUPPORTED_SCHEMA_VERSION: Chỉ hỗ trợ E7.6R schema version 1.`, 400, 'UNSUPPORTED_SCHEMA_VERSION');
  }
  if (!Array.isArray(raw.size) || raw.size.length !== 2 || !Array.isArray(tm.size) || tm.size[0] !== raw.size[0] || tm.size[1] !== raw.size[1]) {
    throw new StudioError('Kích thước scene và tilemap không khớp.', 400, 'INVALID_DIMENSIONS');
  }
  const [width, height] = raw.size as [number, number];
  const ppu = Number(raw.camera?.pixelsPerUnit ?? 32);
  const sourceRevision = typeof raw.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sourceSha256) ? raw.sourceSha256 : '';
  if (!sourceRevision) throw new StudioError('E7.6R scene thiếu sourceSha256.', 400, 'MISSING_METADATA');
  if (options.expectedRevision && sourceRevision !== options.expectedRevision) {
    throw new StudioError(`REVISION_MISMATCH: Dự kiến '${options.expectedRevision}', nhận '${sourceRevision}'.`, 409, 'REVISION_MISMATCH');
  }

  const flatIds: number[] = Array.isArray(tm.ids) ? (Array.isArray(tm.ids[0]) ? tm.ids.flat() : tm.ids) : [];
  if (!Number.isInteger(tm.tileSize) || !Number.isInteger(tm.columns) || !Array.isArray(tm.cells) || !Array.isArray(tm.origin) || tm.sampling !== 'nearest') {
    throw new StudioError('Tilemap E7.6R thiếu metadata hoặc sai định dạng.', 400, 'INVALID_TILEMAP');
  }
  if (flatIds.length !== (width / tm.tileSize) * (height / tm.tileSize)) {
    throw new StudioError('Kích thước lưới tilemap E7.6R không khớp.', 400, 'INVALID_TILEMAP');
  }
  for (const tid of flatIds) {
    if (!Number.isInteger(tid) || tid < 0 || tid >= tm.cells.length) {
      throw new StudioError(`MISSING_TILE_ID: Tile ID ${String(tid)} vượt phạm vi cells (${tm.cells.length}).`, 400, 'MISSING_TILE_ID');
    }
  }

  const atlasRes = resolvePackageFile(files, tm.atlas, '', 'tilemap.atlas');
  const atlasPng = decodePngSafe(atlasRes.buffer, atlasRes.path);
  const fgRes = resolvePackageFile(files, tm.foreground, '', 'tilemap.foreground');
  const fgPng = decodePngSafe(fgRes.buffer, fgRes.path);
  if (fgPng.w !== width || fgPng.h !== height) throw new StudioError('Kích thước foreground không khớp scene.', 400, 'INVALID_FOREGROUND');

  for (const cell of tm.cells) {
    const tileBytes = cropRgbaBytes(atlasPng, cell.x, cell.y, tm.tileSize, tm.tileSize);
    if (sha256(tileBytes) !== cell.rgbaSha256) {
      throw new StudioError(`STALE_HASH: Tile #${cell.id} trong ${atlasRes.path} không khớp rgbaSha256.`, 409, 'STALE_HASH');
    }
  }

  const walkableRows = parseWalkableSpans(raw.masks?.walkable, width, height);
  const collisionRows = parseWalkableSpans(raw.masks?.collision, width, height);
  const collisionBoxes = collisionBoxesFromRows(collisionRows);
  const clearance = {
    x: Number(raw.connection?.projectedBodyHalfWidth ?? 9),
    y: Number(raw.connection?.footprintHalfHeight ?? 2),
  };
  const spawnArr = raw.anchors?.spawn?.surveyor;
  const spawn = { x: spawnArr?.[0], y: spawnArr?.[1] };
  if (!fitsWalkable({ width, height, clearance, walkableRows }, spawn)) {
    throw new StudioError(`Vị trí spawn (${spawn.x}, ${spawn.y}) không hợp lệ.`, 400, 'INVALID_SPAWN');
  }

  const purposeSlug = typeof raw.intent?.purpose === 'string' && /^[a-z0-9-]+$/i.test(raw.intent.purpose)
    ? raw.intent.purpose.toLowerCase()
    : 'scene';
  const sceneKey = typeof options.sceneId === 'string' && options.sceneId.trim()
    ? options.sceneId.replace(/^e76r-/, '').replace(/-(day|night)$/, '')
    : `e76r-${purposeSlug}-${sourceRevision.slice(0, 8)}`;
  const sceneId = options.sceneId ?? `e76r-${sceneKey}-${light}`;

  const atlasResourceId = makeResourceId(sceneId, 'atlas');
  const foregroundResourceId = makeResourceId(sceneId, 'fg');
  const resources: Record<string, StudioResource> = {
    [atlasResourceId]: { version: 1, kind: 'rgba', w: atlasPng.w, h: atlasPng.h, data: atlasPng.data },
    [foregroundResourceId]: { version: 1, kind: 'rgba', w: fgPng.w, h: fgPng.h, data: fgPng.data },
  };

  let prevY = -1;
  const layers: NativeSceneLayer[] = (raw.entities ?? []).map((e: any, i: number) => {
    if (!e || typeof e.id !== 'string' || !['building', 'prop', 'actor'].includes(e.kind) || !Array.isArray(e.at)) {
      throw new StudioError(`INVALID_LAYER_METADATA: Entity[${i}] không hợp lệ.`, 400, 'INVALID_LAYER_METADATA');
    }
    if (e.at[1] < prevY) throw new StudioError(`INVALID_LAYER_METADATA: Entity '${e.id}' không đúng thứ tự y.`, 400, 'INVALID_LAYER_METADATA');
    prevY = e.at[1];
    return {
      id: e.id,
      kind: e.kind,
      at: { x: e.at[0], y: e.at[1] },
      pivot: { x: e.at[0] - e.left, y: e.at[1] - e.top },
      order: i,
      textureResourceId: null,
      texturePath: tm.foreground,
      bounds: { left: e.left, top: e.top, w: e.w, h: e.h },
      visibleBefore: e.visibleBefore,
      visible: e.visible,
      hiddenBy: e.hiddenBy,
      alphaSha256: e.alphaSha256,
    };
  });

  const actors: Record<string, NativeScenePoint> = {};
  for (const [k, pt] of Object.entries(raw.anchors?.spawn ?? {})) {
    if (Array.isArray(pt) && pt.length === 2) actors[k] = { x: pt[0], y: pt[1] };
  }
  const propAnchors: NativeSceneEngineSnapshot['propAnchors'] = (raw.anchors?.mooring ?? []).map((pt: number[], i: number) => ({
    id: `mooring-${i + 1}`,
    kind: 'mooring',
    at: { x: pt[0], y: pt[1] },
    linkedLayerId: layers.find(l => l.at.x === pt[0] && l.at.y === pt[1])?.id ?? null,
  }));
  const interactions: NativeSceneInteractionAnchor[] = [];
  for (const [key, lm] of Object.entries(raw.landmarks ?? {})) {
    if (!lm || typeof lm !== 'object') continue;
    const item = lm as { kind?: unknown; at?: unknown; stand?: unknown; handle?: unknown; runtimeInteraction?: unknown };
    const atArr = item.at as number[];
    const standArr = item.stand as number[] | null | undefined;
    const at = { x: atArr?.[0], y: atArr?.[1] };
    const stand = standArr ? { x: standArr[0], y: standArr[1] } : null;
    if (!Number.isInteger(at.x) || !Number.isInteger(at.y) || at.x < 0 || at.x >= width || at.y < 0 || at.y >= height) {
      throw new StudioError(`INVALID_INTERACTION_ANCHOR: landmarks.${key}.at ngoài biên.`, 400, 'INVALID_INTERACTION_ANCHOR');
    }
    if (stand && !fitsWalkable({ width, height, clearance, walkableRows }, stand)) {
      throw new StudioError(`INVALID_INTERACTION_ANCHOR: landmarks.${key}.stand (${stand.x}, ${stand.y}) không đi được.`, 400, 'INVALID_INTERACTION_ANCHOR');
    }
    interactions.push({
      id: `landmark-${key}`,
      key,
      kind: String(item.kind ?? key),
      at,
      stand,
      handle: Array.isArray(item.handle) ? { x: item.handle[0], y: item.handle[1] } : null,
      linkedEntityId: null,
      label: null,
      runtimeInteraction: typeof item.runtimeInteraction === 'string' ? item.runtimeInteraction : null,
      sourceRevision,
    });
  }

  const snapshot: NativeSceneEngineSnapshot = {
    schemaVersion: 1,
    packageFormat: 'e76r-b2',
    sceneKey,
    light,
    sourceRevision,
    coordinateSystem: raw.coordinateSystem ?? 'top-left scene pixels',
    width,
    height,
    origin: [tm.origin[0], tm.origin[1]],
    pixelsPerUnit: ppu,
    camera: raw.camera,
    styleRef: raw.style ?? null,
    profileRef: raw.profile ?? null,
    intent: raw.intent ?? null,
    tilemap: {
      version: 1,
      tileSize: tm.tileSize,
      columns: tm.columns,
      cellCount: tm.cells.length,
      width,
      height,
      origin: [tm.origin[0], tm.origin[1]],
      sampling: 'nearest',
      ids: flatIds,
      atlasResourceId,
      cells: tm.cells,
      groundRgbaSha256: tm.groundRgbaSha256,
      sceneRgbaSha256: tm.sceneRgbaSha256,
    },
    foregroundResourceId,
    underlayCorrectionResourceId: null,
    layers,
    layerOrder: raw.layerOrder ?? layers.map(l => l.id),
    walkableRows,
    collisionRows,
    collisionBoxes,
    colliders: raw.colliders ?? [],
    spawn,
    actors,
    clearance,
    propAnchors,
    interactions,
    aperture: null,
    probes: [],
    route: [],
    provenance: {
      sourceSha256: sourceRevision,
      expectedCompositeRgbaSha256: tm.sceneRgbaSha256,
      fileHashes,
      importedAt: new Date().toISOString(),
      contractGaps: [
        'PER_ENTITY_LAYER_TEXTURES_NOT_IN_E76R: Gói E7.6R B2 gộp foreground thành một ảnh foreground-<light>.png nên không tách được từng entity texture như gói E8 runtime.',
        'INTERACTION_LABEL_AND_LINKED_ENTITY_NOT_IN_ENGINE_V1: Engine JSON cung cấp landmarks kind/at/stand nhưng không có label hay linkedEntityId.',
      ],
    },
  };

  const record: NativeSceneRecord = {
    id: sceneId,
    name: options.sceneName ?? `${sceneKey} E7.6R (${light})`,
    protectedSha256: computeProtectedSha256(snapshot),
    engineSnapshot: snapshot,
    studioState: defaultStudioState(['foreground', ...layers.map(l => l.id)]),
  };

  const buffers: NativeSceneBuffers = {
    atlas: { w: atlasPng.w, h: atlasPng.h, data: atlasPng.data },
    foreground: { w: fgPng.w, h: fgPng.h, data: fgPng.data },
    layers: {},
  };
  const ground = renderNativeScene(record, buffers, { mode: 'ground', applyOverrides: false });
  if (tm.groundRgbaSha256 && sha256(rgbaBytesFromUint32(ground.data)) !== tm.groundRgbaSha256) {
    throw new StudioError('STALE_HASH: Ảnh tilemap ground không khớp groundRgbaSha256.', 409, 'STALE_HASH');
  }
  const comp = renderNativeScene(record, buffers, { mode: 'composite', applyOverrides: false });
  if (tm.sceneRgbaSha256 && sha256(rgbaBytesFromUint32(comp.data)) !== tm.sceneRgbaSha256) {
    throw new StudioError('STALE_HASH: Ảnh scene tổng hợp không khớp sceneRgbaSha256.', 409, 'STALE_HASH');
  }
  return { record, resources, warnings: [] };
}

export function loadNativeSceneBuffers(store: PixelStore, doc: PixelDocument, record: NativeSceneRecord): NativeSceneBuffers {
  const resStore = store.resourceStore(doc.id);
  const readRes = (id: string): NativeSceneRaster => {
    const meta = doc.studio?.resources?.[id];
    if (!meta || !meta.blob) throw new StudioError(`Thiếu resource '${id}' cho scene '${record.id}'.`, 404, 'BROKEN_REFERENCE');
    const data = resStore.read({ version: 1, kind: meta.kind, w: meta.w, h: meta.h, blob: meta.blob });
    return { w: meta.w, h: meta.h, data };
  };
  const snap = record.engineSnapshot;
  const layers: Record<string, NativeSceneRaster> = {};
  for (const layer of snap.layers) {
    if (layer.textureResourceId) layers[layer.textureResourceId] = readRes(layer.textureResourceId);
  }
  return {
    atlas: readRes(snap.tilemap.atlasResourceId),
    foreground: readRes(snap.foregroundResourceId),
    ...(snap.underlayCorrectionResourceId && { underlayCorrection: readRes(snap.underlayCorrectionResourceId) }),
    layers,
  };
}

/** Validate an exported E8 scene object using the exact checks enforced by Unity E8Contract.cs (E8SceneData.Validate). */
export function validateUnityE8SceneData(scene: any, expectedRevision = scene?.revision): void {
  const check = (ok: unknown, label: string) => { if (!ok) throw new StudioError(`Unity E8SceneData check failed: ${label}`, 409, 'UNITY_CONTRACT_INVALID'); };
  check(scene && scene.version === 1, 'version');
  check(typeof scene.revision === 'string' && scene.revision === expectedRevision, 'revision');
  check(typeof scene.id === 'string' && scene.id.length > 0 && (scene.light === 'day' || scene.light === 'night'), 'id/light');
  check(scene.width === 320 && scene.height === 208 && scene.pixelsPerUnit === 32, 'dimensions/ppu');
  check(scene.tiles && scene.tiles.size === 16 && scene.tiles.atlasColumns === 16 && scene.tiles.cellCount > 0, 'tile metadata');
  check(Array.isArray(scene.tiles.ids) && scene.tiles.ids.length === (scene.width / scene.tiles.size) * (scene.height / scene.tiles.size), 'tile grid size');
  for (const tile of scene.tiles.ids) check(Number.isInteger(tile) && tile >= 0 && tile < scene.tiles.cellCount, 'atlas id');
  check(Array.isArray(scene.walkable) && scene.walkable.length === scene.height && scene.clearance?.x === 9 && scene.clearance?.y === 2, 'walkable shape');
  const fits = (pt: NativeScenePoint) => fitsWalkable({
    width: scene.width,
    height: scene.height,
    clearance: scene.clearance,
    walkableRows: scene.walkable.map((r: { spans: number[] }) => r.spans),
  }, pt);
  for (let y = 0; y < scene.height; y++) {
    const spans = scene.walkable[y].spans;
    check(Array.isArray(spans) && spans.length % 2 === 0, 'walkable span pairs');
    let end = -1;
    for (let i = 0; i < spans.length; i += 2) {
      check(spans[i] >= 0 && spans[i] > end && spans[i + 1] > spans[i] && spans[i + 1] <= scene.width, 'walkable run');
      end = spans[i + 1];
    }
  }
  for (const c of scene.collision ?? []) {
    check(c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x + c.w <= scene.width && c.y + c.h <= scene.height, 'collider bounds');
  }
  check(fits(scene.spawn) && fits(scene.landmark.stand), 'spawn and stand walkable');
  check(Array.isArray(scene.route) && scene.route.length > 1, 'route length');
  check(scene.route[0].x === scene.spawn.x && scene.route[0].y === scene.spawn.y, 'route start');
  const last = scene.route[scene.route.length - 1];
  check(last.x === scene.landmark.stand.x && last.y === scene.landmark.stand.y, 'route end');
  for (let i = 0; i < scene.layers.length; i++) {
    const l = scene.layers[i];
    check(l.order === i && l.at.y >= 0 && l.at.y <= scene.height && (i === 0 || scene.layers[i - 1].at.y <= l.at.y), 'layer ordering');
  }
}

function toImg(r: NativeSceneRaster): Img {
  const img = new Img(r.w, r.h);
  img.data.set(r.data);
  return img;
}

export function exportNativeScenePackage(
  store: PixelStore,
  doc: PixelDocument,
  sceneId: string,
  options: { requireApproved?: boolean } = {},
): ExportResult {
  const record = doc.studio?.production?.nativeScenes?.find(s => s.id === sceneId);
  if (!record) throw new StudioError(`Native scene '${sceneId}' không tồn tại.`, 404);
  if (options.requireApproved && record.studioState.approval.status !== 'APPROVED') {
    throw new StudioError('UNAPPROVED_SCENE: Scene chưa được duyệt; không thể áp dụng vào production.', 409, 'UNAPPROVED_SCENE');
  }

  const snap = record.engineSnapshot;
  const effective = effectiveNativeSceneState(record);
  const buffers = loadNativeSceneBuffers(store, doc, record);
  const renderedComposite = renderNativeScene(record, buffers, { mode: 'composite', applyOverrides: true });
  const renderedFg = renderNativeScene(record, buffers, { mode: 'foreground', applyOverrides: true });

  const files: { path: string; data: Buffer }[] = [];
  const runtimeContractChanges: string[] = [];

  if (snap.packageFormat === 'e8-runtime') {
    const prefix = `${snap.sceneKey}/${snap.light}`;
    const route = computeWalkableRoute(snap, effective.spawn, effective.interactions[0]?.stand ?? snap.spawn) ?? snap.route ?? [];
    if (route.length < 2) {
      throw new StudioError('Không tìm được đường đi walkable từ spawn đến điểm tương tác sau khi chỉnh sửa.', 409, 'ROUTE_BLOCKED');
    }
    const primaryInteraction = effective.interactions[0];
    const exportedLayers = effective.layers
      .filter(l => l.visible)
      .map((l, idx) => ({
        id: l.id,
        kind: l.kind,
        at: { x: l.at.x, y: l.at.y },
        pivot: { x: l.pivot.x, y: l.pivot.y },
        order: idx,
        texture: l.texturePath ?? `${prefix}/layer-${l.id}`,
      }));

    if (primaryInteraction?.label && !snap.interactions[0]?.label) {
      runtimeContractChanges.push('RUNTIME_CONTRACT_CHANGE_REQUIRED: Unity E8Contract.cs hiện chưa đọc trường interaction label/linkedEntityId từ scene.json (đang hardcode ở E8InteractionHud.cs); giá trị Studio override được bảo toàn trong studio-scene-sidecar.json để chờ E8.5.');
    }

    const e8SceneJson = {
      version: 1,
      revision: snap.sourceRevision,
      id: snap.sceneKey,
      light: snap.light,
      width: snap.width,
      height: snap.height,
      pixelsPerUnit: snap.pixelsPerUnit,
      tiles: {
        size: snap.tilemap.tileSize,
        atlasColumns: snap.tilemap.columns,
        cellCount: snap.tilemap.cellCount,
        ids: snap.tilemap.ids,
      },
      correction: `${prefix}/underlay-correction`,
      foreground: `${prefix}/foreground`,
      atlas: `${prefix}/atlas`,
      spawn: effective.spawn,
      clearance: snap.clearance,
      collision: snap.collisionBoxes,
      walkable: snap.walkableRows.map(spans => ({ spans })),
      layers: exportedLayers,
      probes: snap.probes ?? [],
      route,
      landmark: {
        kind: primaryInteraction.kind,
        at: primaryInteraction.at,
        stand: primaryInteraction.stand ?? effective.spawn,
      },
      aperture: snap.aperture ?? null,
      source: {
        fixture: snap.provenance.sourceSha256,
        ...(snap.provenance.lockedSceneSha256 && { lockedScene: snap.provenance.lockedSceneSha256 }),
        ...(snap.provenance.lockedTilemapSha256 && { lockedMap: snap.provenance.lockedTilemapSha256 }),
        ...(snap.provenance.lockedFrameSha256 && { lockedFrame: snap.provenance.lockedFrameSha256 }),
        rgba: sha256(rgbaBytesFromUint32(renderedComposite.data)),
      },
    };
    validateUnityE8SceneData(e8SceneJson, snap.sourceRevision);

    files.push(
      { path: `${prefix}/scene.json`, data: Buffer.from(JSON.stringify(e8SceneJson, null, 2)) },
      { path: `${prefix}/atlas.png`, data: encodePng(toImg(buffers.atlas)) },
      { path: `${prefix}/foreground.png`, data: encodePng(renderedFg) },
    );
    if (buffers.underlayCorrection) {
      files.push({ path: `${prefix}/underlay-correction.png`, data: encodePng(toImg(buffers.underlayCorrection)) });
    }
    for (const layer of exportedLayers) {
      const orig = snap.layers.find(l => l.id === layer.id);
      const raster = orig?.textureResourceId ? buffers.layers[orig.textureResourceId] : undefined;
      if (raster) {
        files.push({ path: `${layer.texture}.png`, data: encodePng(toImg(raster)) });
      }
    }
  } else {
    runtimeContractChanges.push('E76R_ADAPTER_NOTE: Gói E7.6R dùng định dạng scene-<light>.json + tilemap-<light>.json; để nạp thẳng vào E8Build.cs cần chạy E8 adapter để tách layer-*.png và tạo underlay-correction.png.');
    const prefix = `${snap.sceneKey}/${snap.light}`;
    const gridCols = snap.width / snap.tilemap.tileSize;
    const rows2d: number[][] = [];
    for (let y = 0; y < snap.tilemap.ids.length; y += gridCols) rows2d.push(snap.tilemap.ids.slice(y, y + gridCols));
    files.push(
      {
        path: `${prefix}/scene-${snap.light}.json`,
        data: Buffer.from(JSON.stringify({
          version: 1,
          coordinateSystem: snap.coordinateSystem,
          size: [snap.width, snap.height],
          sourceSha256: snap.provenance.sourceSha256,
          camera: snap.camera,
          style: snap.styleRef,
          profile: snap.profileRef,
          intent: snap.intent,
          anchors: { spawn: effective.actors },
          layerOrder: effective.layers.map(l => l.id),
          colliders: snap.colliders,
          masks: {
            walkable: snap.walkableRows.map(r => { const pairs = []; for (let i = 0; i < r.length; i += 2) pairs.push([r[i], r[i + 1]]); return pairs; }),
            collision: (snap.collisionRows ?? []).map(r => { const pairs = []; for (let i = 0; i < r.length; i += 2) pairs.push([r[i], r[i + 1]]); return pairs; }),
          },
          landmarks: Object.fromEntries(effective.interactions.map(it => [it.key, {
            kind: it.kind,
            at: [it.at.x, it.at.y],
            stand: it.stand ? [it.stand.x, it.stand.y] : null,
            label: it.label,
            linkedEntityId: it.linkedEntityId,
          }])),
        }, null, 2)),
      },
      {
        path: `${prefix}/tilemap-${snap.light}.json`,
        data: Buffer.from(JSON.stringify({
          version: 1,
          size: [snap.width, snap.height],
          origin: snap.origin,
          tileSize: snap.tilemap.tileSize,
          columns: snap.tilemap.columns,
          atlas: `atlas-${snap.light}.png`,
          foreground: `foreground-${snap.light}.png`,
          sampling: snap.tilemap.sampling,
          ids: rows2d,
          cells: snap.tilemap.cells ?? [],
          groundRgbaSha256: snap.tilemap.groundRgbaSha256,
          sceneRgbaSha256: sha256(rgbaBytesFromUint32(renderedComposite.data)),
        }, null, 2)),
      },
      { path: `${prefix}/atlas-${snap.light}.png`, data: encodePng(toImg(buffers.atlas)) },
      { path: `${prefix}/foreground-${snap.light}.png`, data: encodePng(renderedFg) },
    );
  }

  const sidecar = {
    schemaVersion: 1,
    studioProjectId: doc.id,
    studioDocumentRevision: doc.revision,
    nativeSceneRecord: record,
    unityCompatibility: {
      directE8ImportCompatible: snap.packageFormat === 'e8-runtime',
      runtimeContractChangeRequired: runtimeContractChanges,
    },
  };
  files.push({ path: 'studio-scene-sidecar.json', data: Buffer.from(JSON.stringify(sidecar, null, 2)) });

  const fileHashesOut = Object.fromEntries(files.map(f => [f.path, sha256(f.data)]));
  const manifest = {
    version: 1,
    sceneId: record.id,
    sceneKey: snap.sceneKey,
    light: snap.light,
    packageFormat: snap.packageFormat,
    sourceRevision: snap.sourceRevision,
    protectedSha256: record.protectedSha256,
    studioRevision: record.studioState.revision,
    approval: record.studioState.approval,
    exportedRgbaExactMatchEngineSource: snap.provenance.expectedCompositeRgbaSha256
      ? compareRgbaExact(renderedComposite.data, renderNativeScene(record, buffers, { mode: 'composite', applyOverrides: false }).data).equal
      : null,
    fileHashes: fileHashesOut,
  };
  files.push({ path: 'export-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

  return {
    data: zipFiles(files),
    mime: 'application/zip',
    filename: `${record.id}-e84-export.zip`,
  };
}
