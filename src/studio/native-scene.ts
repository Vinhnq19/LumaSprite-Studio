import { validateResourceId, type StudioResource } from './resources.ts';
import type { PixelDocument } from './pixel/model.ts';
import { dataId, dataName, dataNumber, dataUnique } from './quality/data.ts';

export type NativeScenePackageFormat = 'e8-runtime' | 'e76r-b2';
export type NativeSceneApprovalStatus = 'UNREVIEWED' | 'APPROVED' | 'STALE';
export interface NativeScenePoint { x: number; y: number }
export interface NativeSceneBox { x: number; y: number; w: number; h: number }

export interface NativeSceneLayer {
  id: string;
  kind: 'building' | 'prop' | 'actor';
  at: NativeScenePoint;
  pivot: NativeScenePoint;
  order: number;
  textureResourceId?: string | null;
  texturePath?: string | null;
  bounds?: { left: number; top: number; w: number; h: number };
  visibleBefore?: number;
  visible?: number;
  hiddenBy?: Record<string, number>;
  alphaSha256?: string;
}

export interface NativeSceneInteractionAnchor {
  id: string;
  key: string;
  kind: string;
  at: NativeScenePoint;
  stand: NativeScenePoint | null;
  handle?: NativeScenePoint | null;
  linkedEntityId: string | null;
  label: string | null;
  runtimeInteraction?: string | null;
  sourceRevision: string;
}

export interface NativeSceneTilemap {
  version: 1;
  tileSize: number;
  columns: number;
  cellCount: number;
  width: number;
  height: number;
  origin: [number, number];
  sampling: 'nearest';
  ids: number[];
  atlasResourceId: string;
  cells?: Array<{ id: number; x: number; y: number; rgbaSha256: string }>;
  groundRgbaSha256?: string;
  sceneRgbaSha256?: string;
}

export interface NativeSceneEngineSnapshot {
  schemaVersion: 1;
  packageFormat: NativeScenePackageFormat;
  sceneKey: string;
  light: 'day' | 'night';
  sourceRevision: string;
  coordinateSystem: string;
  width: number;
  height: number;
  origin: [number, number];
  pixelsPerUnit: number;
  camera?: { width: number; height: number; sampling: 'nearest'; view?: string; pixelsPerUnit: number };
  styleRef?: { file: string; sha256: string } | null;
  profileRef?: { file: string; sha256: string } | null;
  intent?: { purpose?: string; brief?: string; role?: string } | null;
  tilemap: NativeSceneTilemap;
  foregroundResourceId: string;
  underlayCorrectionResourceId?: string | null;
  layers: NativeSceneLayer[];
  layerOrder: string[];
  walkableRows: number[][];
  collisionRows?: number[][];
  collisionBoxes: NativeSceneBox[];
  colliders: Array<{ id: string; kind: string; points: [number, number][] }>;
  spawn: NativeScenePoint;
  actors: Record<string, NativeScenePoint>;
  clearance: NativeScenePoint;
  propAnchors: Array<{ id: string; kind: string; at: NativeScenePoint; linkedLayerId: string | null }>;
  interactions: NativeSceneInteractionAnchor[];
  aperture?: {
    x: number;
    y: number;
    w: number;
    h: number;
    threshold: number;
    expected: number;
    original: NativeScenePoint;
    staging: NativeScenePoint;
    water: string[];
  } | null;
  probes?: Array<{ kind: string; collider: string; from: NativeScenePoint; to: NativeScenePoint }>;
  route?: NativeScenePoint[];
  provenance: {
    sourceSha256: string;
    lockedSceneSha256?: string;
    lockedTilemapSha256?: string;
    lockedFrameSha256?: string;
    expectedCompositeRgbaSha256?: string;
    fileHashes: Record<string, string>;
    importedAt: string;
    contractGaps: string[];
  };
}

export interface NativeSceneApproval {
  status: NativeSceneApprovalStatus;
  approvedRevision: number | null;
  approvedSourceRevision: string | null;
  reviewedAt: string | null;
  note: string;
}

export interface NativeSceneStudioState {
  revision: number;
  approval: NativeSceneApproval;
  styleProfileId: string | null;
  layerVisibility: Record<string, boolean>;
  layerOrderOverrides: Record<string, number>;
  actorOverrides: Record<string, { x: number; y: number; assetId?: string | null }>;
  propOverrides: Record<string, { x: number; y: number; assetId?: string | null; hidden?: boolean }>;
  interactionOverrides: Record<string, { label?: string | null; stand?: NativeScenePoint | null; linkedEntityId?: string | null; note?: string | null }>;
  sourceWarnings: string[];
  changeLog: Array<{ revision: number; at: string; summary: string }>;
}

export interface NativeSceneRecord {
  id: string;
  name: string;
  protectedSha256: string;
  engineSnapshot: NativeSceneEngineSnapshot;
  studioState: NativeSceneStudioState;
}

export const MAX_NATIVE_SCENES = 64;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: phải là object hợp lệ.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${path}: phải là plain object.`);
  return value as Record<string, unknown>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function defaultStudioState(layerIds: string[]): NativeSceneStudioState {
  const layerVisibility: Record<string, boolean> = {};
  for (const id of layerIds) layerVisibility[id] = true;
  return {
    revision: 1,
    approval: {
      status: 'UNREVIEWED',
      approvedRevision: null,
      approvedSourceRevision: null,
      reviewedAt: null,
      note: '',
    },
    styleProfileId: null,
    layerVisibility,
    layerOrderOverrides: {},
    actorOverrides: {},
    propOverrides: {},
    interactionOverrides: {},
    sourceWarnings: [],
    changeLog: [],
  };
}

export function fitsWalkable(snapshot: Pick<NativeSceneEngineSnapshot, 'width' | 'height' | 'clearance' | 'walkableRows'>, point: NativeScenePoint): boolean {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) return false;
  const { width, height, clearance, walkableRows } = snapshot;
  if (point.x < clearance.x || point.x >= width - clearance.x || point.y < clearance.y || point.y >= height - clearance.y) return false;
  const left = point.x - clearance.x, right = point.x + clearance.x;
  for (let y = point.y - clearance.y; y <= point.y + clearance.y; y++) {
    const spans = walkableRows[y];
    if (!spans) return false;
    let clear = false;
    for (let i = 0; i < spans.length; i += 2) {
      if (left >= spans[i] && right < spans[i + 1]) { clear = true; break; }
    }
    if (!clear) return false;
  }
  return true;
}

export function computeWalkableRoute(
  snapshot: Pick<NativeSceneEngineSnapshot, 'width' | 'height' | 'clearance' | 'walkableRows'>,
  from: NativeScenePoint,
  to: NativeScenePoint,
): NativeScenePoint[] | null {
  if (!fitsWalkable(snapshot, from) || !fitsWalkable(snapshot, to)) return null;
  const { width: w, height: h } = snapshot;
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  const prev = new Int32Array(w * h).fill(-1);
  prev[start] = start;
  const queue = [start];
  const dirs = [[1, 0], [0, -1], [0, 1], [-1, 0]] as const;
  for (let q = 0; q < queue.length && prev[goal] < 0; q++) {
    const cur = queue[q], x = cur % w, y = Math.floor(cur / w);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const next = ny * w + nx;
      if (prev[next] >= 0) continue;
      if (fitsWalkable(snapshot, { x: nx, y: ny })) {
        prev[next] = cur;
        queue.push(next);
      }
    }
  }
  if (prev[goal] < 0) return null;
  const route: NativeScenePoint[] = [];
  for (let cur = goal; ; cur = prev[cur]) {
    route.push({ x: cur % w, y: Math.floor(cur / w) });
    if (cur === start) break;
  }
  return route.reverse();
}

export function collisionBoxesFromRows(rows: number[][]): NativeSceneBox[] {
  const boxes: NativeSceneBox[] = [];
  let previous = new Map<string, NativeSceneBox>();
  for (let y = 0; y < rows.length; y++) {
    const spans = rows[y];
    const current = new Map<string, NativeSceneBox>();
    for (let i = 0; i < spans.length; i += 2) {
      const x = spans[i], end = spans[i + 1];
      const key = `${x},${end}`;
      const row = previous.get(key) ?? { x, y, w: end - x, h: 0 };
      if (!row.h) boxes.push(row);
      row.h++;
      current.set(key, row);
    }
    previous = current;
  }
  return boxes;
}

export function effectiveNativeSceneState(record: NativeSceneRecord) {
  const { engineSnapshot: snap, studioState: st } = record;
  const layers = snap.layers.map(layer => {
    const visible = st.layerVisibility[layer.id] ?? true;
    const order = st.layerOrderOverrides[layer.id] ?? layer.order;
    const actorOverride = layer.kind === 'actor' ? st.actorOverrides[layer.id] : undefined;
    const propOverride = layer.kind === 'prop' ? st.propOverrides[layer.id] : undefined;
    const at = actorOverride
      ? { x: actorOverride.x, y: actorOverride.y }
      : propOverride
        ? { x: propOverride.x, y: propOverride.y }
        : layer.at;
    return {
      ...layer,
      at,
      order,
      visible: propOverride?.hidden ? false : visible,
      overridden: !!(actorOverride || propOverride || st.layerOrderOverrides[layer.id] !== undefined || st.layerVisibility[layer.id] === false),
    };
  }).sort((a, b) => (a.at.y - b.at.y) || (a.order - b.order));

  const surveyorOverride = st.actorOverrides.surveyor;
  const spawn = surveyorOverride ? { x: surveyorOverride.x, y: surveyorOverride.y } : { ...snap.spawn };
  const actors: Record<string, NativeScenePoint> = { ...snap.actors };
  for (const [id, ov] of Object.entries(st.actorOverrides)) actors[id] = { x: ov.x, y: ov.y };

  const interactions = snap.interactions.map(item => {
    const ov = st.interactionOverrides[item.id] ?? st.interactionOverrides[item.key];
    return {
      ...item,
      label: ov?.label !== undefined ? ov.label : item.label,
      stand: ov?.stand !== undefined ? ov.stand : item.stand,
      linkedEntityId: ov?.linkedEntityId !== undefined ? ov.linkedEntityId : item.linkedEntityId,
      note: ov?.note ?? null,
      overridden: !!ov,
    };
  });

  return {
    spawn,
    actors,
    layers,
    interactions,
    foregroundVisible: st.layerVisibility.foreground ?? true,
  };
}

function point(value: unknown, w: number, h: number, path: string): NativeScenePoint {
  const o = plainObject(value, path);
  return {
    x: dataNumber(o.x, 0, w - 1, `${path}.x`, true),
    y: dataNumber(o.y, 0, h - 1, `${path}.y`, true),
  };
}

function validateSpanRows(rows: unknown, width: number, height: number, path: string): number[][] {
  if (!Array.isArray(rows) || rows.length !== height) throw new Error(`${path}: chiều dài phải bằng chiều cao scene (${height}).`);
  return rows.map((row, y) => {
    if (!Array.isArray(row) || row.length % 2 !== 0) throw new Error(`${path}[${y}]: phải là danh sách cặp [start, end].`);
    let prevEnd = -1;
    return row.map((val, idx) => {
      const n = dataNumber(val, 0, width, `${path}[${y}][${idx}]`, true);
      if (idx % 2 === 0) {
        if (n <= prevEnd || n >= width) throw new Error(`${path}[${y}]: span bắt đầu không hợp lệ (${n}).`);
      } else {
        const start = row[idx - 1] as number;
        if (n <= start || n > width) throw new Error(`${path}[${y}]: span kết thúc không hợp lệ (${n}).`);
        prevEnd = n;
      }
      return n;
    });
  });
}

function safeResourceRef(id: unknown, path: string, resources?: Record<string, StudioResource>): string {
  if (typeof id !== 'string') throw new Error(`${path}: thiếu ID tài nguyên.`);
  validateResourceId(id);
  if (resources && !Object.hasOwn(resources, id)) {
    throw new Error(`${path}: tài nguyên '${id}' không tồn tại trong dự án.`);
  }
  return id;
}

export function validateNativeSceneRecord(
  value: unknown,
  doc?: PixelDocument,
  resources = doc?.studio?.resources,
  profileIds?: Set<string>,
): NativeSceneRecord {
  const rec = plainObject(value, 'NativeSceneRecord');
  const id = dataId(rec.id, 'NativeScene.id');
  const name = dataName(rec.name, 'NativeScene.name');
  if (typeof rec.protectedSha256 !== 'string' || !SHA256_RE.test(rec.protectedSha256)) {
    throw new Error('NativeScene.protectedSha256 phải là chuỗi hex SHA-256 64 ký tự.');
  }
  const snapObj = plainObject(rec.engineSnapshot, 'engineSnapshot');
  if (snapObj.schemaVersion !== 1) throw new Error(`UNSUPPORTED_SCHEMA_VERSION: Chỉ hỗ trợ schemaVersion = 1 (nhận ${String(snapObj.schemaVersion)}).`);
  if (snapObj.packageFormat !== 'e8-runtime' && snapObj.packageFormat !== 'e76r-b2') {
    throw new Error('engineSnapshot.packageFormat phải là e8-runtime hoặc e76r-b2.');
  }
  const sceneKey = dataId(snapObj.sceneKey, 'engineSnapshot.sceneKey');
  const light = snapObj.light;
  if (light !== 'day' && light !== 'night') throw new Error('engineSnapshot.light phải là day hoặc night.');
  if (typeof snapObj.sourceRevision !== 'string' || !/^[A-Za-z0-9_.-]{4,80}$/.test(snapObj.sourceRevision)) {
    throw new Error('engineSnapshot.sourceRevision không hợp lệ.');
  }
  const width = dataNumber(snapObj.width, 16, 4096, 'engineSnapshot.width', true);
  const height = dataNumber(snapObj.height, 16, 4096, 'engineSnapshot.height', true);
  const pixelsPerUnit = dataNumber(snapObj.pixelsPerUnit, 1, 256, 'engineSnapshot.pixelsPerUnit', true);
  if (!Array.isArray(snapObj.origin) || snapObj.origin.length !== 2 || snapObj.origin.some(v => typeof v !== 'number' || !Number.isInteger(v))) {
    throw new Error('engineSnapshot.origin phải là [ox, oy] số nguyên.');
  }

  const tm = plainObject(snapObj.tilemap, 'engineSnapshot.tilemap');
  if (tm.version !== 1 || tm.sampling !== 'nearest') throw new Error('UNSUPPORTED_SCHEMA_VERSION: tilemap cần version=1 và sampling=nearest.');
  const tileSize = dataNumber(tm.tileSize, 8, 128, 'tilemap.tileSize', true);
  const columns = dataNumber(tm.columns, 1, 256, 'tilemap.columns', true);
  const cellCount = dataNumber(tm.cellCount, 1, 65536, 'tilemap.cellCount', true);
  if (tm.width !== width || tm.height !== height || width % tileSize !== 0 || height % tileSize !== 0) {
    throw new Error('Kích thước tilemap không khớp hoặc không chia hết cho tileSize.');
  }
  const expectedTiles = (width / tileSize) * (height / tileSize);
  if (!Array.isArray(tm.ids) || tm.ids.length !== expectedTiles) {
    throw new Error(`Số lượng tile ID (${Array.isArray(tm.ids) ? tm.ids.length : 0}) không khớp lưới ${expectedTiles}.`);
  }
  for (let i = 0; i < tm.ids.length; i++) {
    const tid = tm.ids[i];
    if (typeof tid !== 'number' || !Number.isInteger(tid) || tid < 0 || tid >= cellCount) {
      throw new Error(`Tile ID không hợp lệ tại vị trí ${i}: ${String(tid)} (cellCount=${cellCount}).`);
    }
  }
  const atlasResourceId = safeResourceRef(tm.atlasResourceId, 'tilemap.atlasResourceId', resources);
  const foregroundResourceId = safeResourceRef(snapObj.foregroundResourceId, 'engineSnapshot.foregroundResourceId', resources);
  const underlayCorrectionResourceId = snapObj.underlayCorrectionResourceId != null
    ? safeResourceRef(snapObj.underlayCorrectionResourceId, 'engineSnapshot.underlayCorrectionResourceId', resources)
    : null;

  const walkableRows = validateSpanRows(snapObj.walkableRows, width, height, 'engineSnapshot.walkableRows');
  const collisionRows = snapObj.collisionRows !== undefined
    ? validateSpanRows(snapObj.collisionRows, width, height, 'engineSnapshot.collisionRows')
    : undefined;
  if (!Array.isArray(snapObj.collisionBoxes)) throw new Error('engineSnapshot.collisionBoxes phải là mảng.');
  const collisionBoxes = snapObj.collisionBoxes.map((b, i) => {
    const box = plainObject(b, `collisionBoxes[${i}]`);
    const x = dataNumber(box.x, 0, width - 1, `collisionBoxes[${i}].x`, true);
    const y = dataNumber(box.y, 0, height - 1, `collisionBoxes[${i}].y`, true);
    const w = dataNumber(box.w, 1, width - x, `collisionBoxes[${i}].w`, true);
    const h = dataNumber(box.h, 1, height - y, `collisionBoxes[${i}].h`, true);
    return { x, y, w, h };
  });

  const clrObj = plainObject(snapObj.clearance, 'engineSnapshot.clearance');
  const clearance = {
    x: dataNumber(clrObj.x, 0, 128, 'clearance.x', true),
    y: dataNumber(clrObj.y, 0, 128, 'clearance.y', true),
  };
  const spawn = point(snapObj.spawn, width, height, 'engineSnapshot.spawn');
  if (!fitsWalkable({ width, height, clearance, walkableRows }, spawn)) {
    throw new Error(`Vị trí spawn (${spawn.x}, ${spawn.y}) không đi được hoặc thiếu clearance.`);
  }

  if (!Array.isArray(snapObj.layers)) throw new Error('engineSnapshot.layers phải là mảng.');
  let prevLayerY = -1;
  const layers: NativeSceneLayer[] = snapObj.layers.map((rawLayer, i) => {
    const l = plainObject(rawLayer, `layers[${i}]`);
    const lid = dataId(l.id, `layers[${i}].id`);
    if (l.kind !== 'building' && l.kind !== 'prop' && l.kind !== 'actor') {
      throw new Error(`layers[${i}].kind không hợp lệ: ${String(l.kind)}.`);
    }
    const at = plainObject(l.at, `layers[${i}].at`);
    const ax = dataNumber(at.x, 0, width, `layers[${i}].at.x`, true);
    const ay = dataNumber(at.y, 0, height, `layers[${i}].at.y`, true);
    const order = dataNumber(l.order, 0, 1024, `layers[${i}].order`, true);
    if (order !== i) throw new Error(`layers[${i}].order không liên tục (${order} != ${i}).`);
    if (ay < prevLayerY) throw new Error(`Thứ tự depth layer không đơn điệu tại ${lid}: y=${ay} < ${prevLayerY}.`);
    prevLayerY = ay;
    const pv = plainObject(l.pivot, `layers[${i}].pivot`);
    const textureResourceId = l.textureResourceId != null ? safeResourceRef(l.textureResourceId, `layers[${i}].textureResourceId`, resources) : null;
    if (snapObj.packageFormat === 'e8-runtime' && !textureResourceId) {
      throw new Error(`Layer E8 '${lid}' thiếu textureResourceId.`);
    }
    return {
      ...(l as unknown as NativeSceneLayer),
      id: lid,
      kind: l.kind,
      at: { x: ax, y: ay },
      pivot: { x: dataNumber(pv.x, -4096, 4096, `layers[${i}].pivot.x`, true), y: dataNumber(pv.y, -4096, 4096, `layers[${i}].pivot.y`, true) },
      order,
      textureResourceId,
    };
  });
  dataUnique(layers.map(l => l.id), 'engineSnapshot.layers');

  if (!Array.isArray(snapObj.interactions)) throw new Error('engineSnapshot.interactions phải là mảng.');
  const interactions: NativeSceneInteractionAnchor[] = snapObj.interactions.map((rawInt, i) => {
    const item = plainObject(rawInt, `interactions[${i}]`);
    const iid = dataId(item.id, `interactions[${i}].id`);
    const key = dataName(item.key, `interactions[${i}].key`);
    const kind = dataName(item.kind, `interactions[${i}].kind`);
    const at = point(item.at, width, height, `interactions[${i}].at`);
    const stand = item.stand === null ? null : point(item.stand, width, height, `interactions[${i}].stand`);
    if (stand && !fitsWalkable({ width, height, clearance, walkableRows }, stand)) {
      throw new Error(`Điểm đứng tương tác '${iid}' (${stand.x}, ${stand.y}) không đi được.`);
    }
    if (typeof item.sourceRevision !== 'string' || !item.sourceRevision.trim()) {
      throw new Error(`interactions[${i}].sourceRevision không hợp lệ.`);
    }
    return {
      ...(item as unknown as NativeSceneInteractionAnchor),
      id: iid,
      key,
      kind,
      at,
      stand,
    };
  });
  dataUnique(interactions.map(item => item.id), 'engineSnapshot.interactions');

  const prov = plainObject(snapObj.provenance, 'engineSnapshot.provenance');
  if (typeof prov.sourceSha256 !== 'string' || !SHA256_RE.test(prov.sourceSha256)) {
    throw new Error('provenance.sourceSha256 phải là hex SHA-256 64 ký tự.');
  }
  const fileHashesObj = plainObject(prov.fileHashes, 'provenance.fileHashes');
  for (const [k, h] of Object.entries(fileHashesObj)) {
    if (RESERVED_KEYS.has(k) || typeof h !== 'string' || !SHA256_RE.test(h)) {
      throw new Error(`provenance.fileHashes['${k}'] không hợp lệ.`);
    }
  }

  const snapForCheck: NativeSceneEngineSnapshot = {
    ...(snapObj as unknown as NativeSceneEngineSnapshot),
    schemaVersion: 1,
    sceneKey,
    light,
    width,
    height,
    pixelsPerUnit,
    tilemap: {
      ...(tm as unknown as NativeSceneTilemap),
      version: 1,
      tileSize,
      columns,
      cellCount,
      atlasResourceId,
    },
    foregroundResourceId,
    underlayCorrectionResourceId,
    layers,
    walkableRows,
    collisionRows,
    collisionBoxes,
    clearance,
    spawn,
    interactions,
  };

  const stObj = plainObject(rec.studioState, 'studioState');
  const revision = dataNumber(stObj.revision, 1, 1_000_000, 'studioState.revision', true);
  const appObj = plainObject(stObj.approval, 'studioState.approval');
  if (appObj.status !== 'UNREVIEWED' && appObj.status !== 'APPROVED' && appObj.status !== 'STALE') {
    throw new Error('studioState.approval.status không hợp lệ.');
  }
  const styleProfileId = stObj.styleProfileId === null || stObj.styleProfileId === undefined
    ? null
    : dataId(stObj.styleProfileId, 'studioState.styleProfileId');
  if (styleProfileId && profileIds && !profileIds.has(styleProfileId)) {
    throw new Error(`Style Profile '${styleProfileId}' không tồn tại.`);
  }

  const layerVisibilityObj = plainObject(stObj.layerVisibility ?? {}, 'studioState.layerVisibility');
  for (const [k, v] of Object.entries(layerVisibilityObj)) {
    if (RESERVED_KEYS.has(k) || typeof v !== 'boolean') throw new Error(`layerVisibility['${k}'] không hợp lệ.`);
  }
  const layerOrderObj = plainObject(stObj.layerOrderOverrides ?? {}, 'studioState.layerOrderOverrides');
  for (const [k, v] of Object.entries(layerOrderObj)) {
    if (RESERVED_KEYS.has(k)) throw new Error('Khóa layerOrderOverrides không hợp lệ.');
    dataNumber(v, 0, 1024, `layerOrderOverrides['${k}']`, true);
  }
  const actorOvObj = plainObject(stObj.actorOverrides ?? {}, 'studioState.actorOverrides');
  for (const [k, v] of Object.entries(actorOvObj)) {
    if (RESERVED_KEYS.has(k)) throw new Error('Khóa actorOverrides không hợp lệ.');
    const o = plainObject(v, `actorOverrides['${k}']`);
    const pt = point(o, width, height, `actorOverrides['${k}']`);
    if (k === 'surveyor' && !fitsWalkable({ width, height, clearance, walkableRows }, pt)) {
      throw new Error(`Vị trí override cho actor '${k}' (${pt.x}, ${pt.y}) nằm ngoài vùng đi được.`);
    }
    if (o.assetId !== undefined && o.assetId !== null) dataId(o.assetId, `actorOverrides['${k}'].assetId`);
  }
  const propOvObj = plainObject(stObj.propOverrides ?? {}, 'studioState.propOverrides');
  for (const [k, v] of Object.entries(propOvObj)) {
    if (RESERVED_KEYS.has(k)) throw new Error('Khóa propOverrides không hợp lệ.');
    const o = plainObject(v, `propOverrides['${k}']`);
    point(o, width, height, `propOverrides['${k}']`);
    if (o.assetId !== undefined && o.assetId !== null) dataId(o.assetId, `propOverrides['${k}'].assetId`);
    if (o.hidden !== undefined && typeof o.hidden !== 'boolean') throw new Error('propOverrides.hidden phải là boolean.');
  }
  const intOvObj = plainObject(stObj.interactionOverrides ?? {}, 'studioState.interactionOverrides');
  for (const [k, v] of Object.entries(intOvObj)) {
    if (RESERVED_KEYS.has(k)) throw new Error('Khóa interactionOverrides không hợp lệ.');
    const o = plainObject(v, `interactionOverrides['${k}']`);
    if (o.stand !== undefined && o.stand !== null) {
      const stand = point(o.stand, width, height, `interactionOverrides['${k}'].stand`);
      if (!fitsWalkable({ width, height, clearance, walkableRows }, stand)) {
        throw new Error(`Điểm đứng override cho interaction '${k}' (${stand.x}, ${stand.y}) nằm ngoài vùng đi được.`);
      }
    }
    if (o.label !== undefined && o.label !== null && (typeof o.label !== 'string' || o.label.length > 120)) {
      throw new Error(`interactionOverrides['${k}'].label tối đa 120 ký tự.`);
    }
    if (o.linkedEntityId !== undefined && o.linkedEntityId !== null) {
      dataId(o.linkedEntityId, `interactionOverrides['${k}'].linkedEntityId`);
    }
  }

  return {
    id,
    name,
    protectedSha256: rec.protectedSha256,
    engineSnapshot: snapForCheck,
    studioState: {
      revision,
      approval: {
        status: appObj.status,
        approvedRevision: appObj.approvedRevision === null ? null : dataNumber(appObj.approvedRevision, 1, 1_000_000, 'approval.approvedRevision', true),
        approvedSourceRevision: typeof appObj.approvedSourceRevision === 'string' ? appObj.approvedSourceRevision : null,
        reviewedAt: typeof appObj.reviewedAt === 'string' ? appObj.reviewedAt : null,
        note: typeof appObj.note === 'string' ? appObj.note : '',
      },
      styleProfileId,
      layerVisibility: layerVisibilityObj as Record<string, boolean>,
      layerOrderOverrides: layerOrderObj as Record<string, number>,
      actorOverrides: actorOvObj as NativeSceneStudioState['actorOverrides'],
      propOverrides: propOvObj as NativeSceneStudioState['propOverrides'],
      interactionOverrides: intOvObj as NativeSceneStudioState['interactionOverrides'],
      sourceWarnings: Array.isArray(stObj.sourceWarnings) ? stObj.sourceWarnings.filter((s): s is string => typeof s === 'string') : [],
      changeLog: Array.isArray(stObj.changeLog) ? (stObj.changeLog as NativeSceneStudioState['changeLog']) : [],
    },
  };
}
