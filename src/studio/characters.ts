import type { PixelDocument } from './pixel/model.ts';

export const CHARACTER_VERSION = 1 as const;
export const MAX_CHARACTER_PROFILES = 128;
export const MAX_CHARACTER_PARTS = 64;
export const MAX_CHARACTER_LANDMARKS = 64;
export const MAX_CHARACTER_LINKS = 128;
export const MAX_CHARACTER_ACTIONS = 32;
export const MAX_CHARACTER_PALETTE_SIZE = 4096;
export const MAX_CHARACTER_NAME_LENGTH = 100;

export const ACTION_TEMPLATES = ['idle', 'walk', 'run', 'jump', 'attack', 'custom'] as const;
export type ActionTemplate = (typeof ACTION_TEMPLATES)[number];

const RESERVED_CHARACTER_IDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'isPrototypeOf',
  'toString',
  'valueOf',
  'toLocaleString',
  'hasOwnProperty',
  'propertyIsEnumerable',
]);

const ALLOWED_PROFILE_KEYS = new Set([
  'version',
  'id',
  'name',
  'approved',
  'source',
  'parts',
  'landmarks',
  'links',
  'actions',
]);

const ALLOWED_SOURCE_KEYS = new Set([
  'assetId',
  'frameId',
  'captureRevision',
  'w',
  'h',
  'rgbaResourceId',
  'palette',
  'pivot',
]);

const ALLOWED_PART_KEYS = new Set(['name', 'maskResourceId']);
const ALLOWED_LANDMARK_KEYS = new Set(['name', 'x', 'y', 'partId']);
const ALLOWED_LINK_KEYS = new Set(['from', 'to']);
const ALLOWED_ACTION_KEYS = new Set(['name', 'template']);

export interface CharacterPivot {
  x: number;
  y: number;
}

export interface CharacterSource {
  assetId: string;
  frameId: string;
  captureRevision: number;
  w: number;
  h: number;
  rgbaResourceId: string;
  palette: number[];
  pivot: CharacterPivot;
}

export interface CharacterPart {
  name: string;
  maskResourceId: string;
}

export interface CharacterLandmark {
  name: string;
  x: number;
  y: number;
  partId?: string;
}

export interface CharacterLink {
  from: string;
  to: string;
}

export interface CharacterAction {
  name: string;
  template: ActionTemplate;
}

export interface CharacterProfile {
  version: 1;
  id: string;
  name: string;
  approved: boolean;
  source: CharacterSource;
  parts: Record<string, CharacterPart>;
  landmarks: Record<string, CharacterLandmark>;
  links: CharacterLink[];
  actions: Record<string, CharacterAction>;
}

export function isValidCharacterId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 80 &&
    /^[A-Za-z0-9_-]+$/.test(id) &&
    !RESERVED_CHARACTER_IDS.has(id)
  );
}

export function validateCharacterId(id: unknown, label = 'ID nhân vật'): string {
  if (typeof id !== 'string') throw new Error(`${label} phải là chuỗi ký tự.`);
  if (id.length < 1 || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`${label} không hợp lệ: "${id}". Chỉ cho phép 1-80 ký tự ASCII chữ, số, gạch dưới, gạch nối.`);
  }
  if (RESERVED_CHARACTER_IDS.has(id)) {
    throw new Error(`${label} không được dùng tên dự lưu: "${id}".`);
  }
  return id;
}

export function validateName(name: unknown, label = 'Tên'): string {
  if (typeof name !== 'string') throw new Error(`${label} phải là chuỗi ký tự.`);
  const trimmed = name.trim();
  if (trimmed.length < 1 || name.length > MAX_CHARACTER_NAME_LENGTH) {
    throw new Error(`${label} phải từ 1 đến ${MAX_CHARACTER_NAME_LENGTH} ký tự và không được để trống.`);
  }
  return trimmed;
}

export function validatePivot(pivot: unknown, w: number, h: number): CharacterPivot {
  if (!pivot || typeof pivot !== 'object') {
    throw new Error('Pivot phải là đối tượng { x, y } hoặc mảng [x, y].');
  }
  if (Array.isArray(pivot)) {
    if (
      pivot.length !== 2 ||
      typeof pivot[0] !== 'number' ||
      typeof pivot[1] !== 'number' ||
      !Number.isFinite(pivot[0]) ||
      !Number.isFinite(pivot[1]) ||
      pivot[0] < 0 ||
      pivot[0] > w ||
      pivot[1] < 0 ||
      pivot[1] > h
    ) {
      throw new Error(`Pivot [x, y] phải là số hữu hạn trong phạm vi 0..${w} và 0..${h}.`);
    }
    return { x: pivot[0], y: pivot[1] };
  }
  const obj = pivot as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !keys.includes('x') || !keys.includes('y')) {
    throw new Error('Pivot chỉ được chứa thuộc tính x và y.');
  }
  const x = obj.x;
  const y = obj.y;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > w ||
    y < 0 ||
    y > h
  ) {
    throw new Error(`Tọa độ pivot {x: ${String(x)}, y: ${String(y)}} phải là số hữu hạn trong phạm vi 0..${w} và 0..${h}.`);
  }
  return { x, y };
}

export function resolvePixelPivot(
  metadataPivot: { x: number; y: number } | undefined,
  w: number,
  h: number
): CharacterPivot {
  if (
    metadataPivot &&
    typeof metadataPivot === 'object' &&
    typeof metadataPivot.x === 'number' &&
    typeof metadataPivot.y === 'number' &&
    Number.isFinite(metadataPivot.x) &&
    Number.isFinite(metadataPivot.y)
  ) {
    return {
      x: metadataPivot.x * w,
      y: metadataPivot.y * h,
    };
  }
  return {
    x: w / 2,
    y: h,
  };
}

export function validateCharacterSource(
  source: unknown,
  profileId: string,
  doc?: PixelDocument
): CharacterSource {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Nguồn nhân vật "${profileId}" phải là một đối tượng hợp lệ.`);
  }
  const s = source as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!ALLOWED_SOURCE_KEYS.has(k)) {
      throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong nguồn nhân vật "${profileId}".`);
    }
  }

  const assetId = validateCharacterId(s.assetId, `ID asset nguồn của nhân vật "${profileId}"`);
  if (typeof s.frameId !== 'string' || !s.frameId.trim() || s.frameId.length > 80) {
    throw new Error(`ID frame nguồn của nhân vật "${profileId}" không hợp lệ.`);
  }
  const frameId = s.frameId;

  const captureRevision = s.captureRevision;
  if (
    typeof captureRevision !== 'number' ||
    !Number.isInteger(captureRevision) ||
    captureRevision < 1
  ) {
    throw new Error(`Revision chụp của nhân vật "${profileId}" phải là số nguyên >= 1.`);
  }

  const w = s.w;
  const h = s.h;
  if (
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > 4096 ||
    h > 4096
  ) {
    throw new Error(`Kích thước nguồn nhân vật "${profileId}" (w, h) phải là số nguyên từ 1 đến 4096.`);
  }

  const rgbaResourceId = validateCharacterId(
    s.rgbaResourceId,
    `ID tài nguyên RGBA nguồn của nhân vật "${profileId}"`
  );

  if (!Array.isArray(s.palette) || s.palette.length > MAX_CHARACTER_PALETTE_SIZE) {
    throw new Error(`Palette nguồn của nhân vật "${profileId}" phải là mảng tối đa ${MAX_CHARACTER_PALETTE_SIZE} màu.`);
  }
  for (let i = 0; i < s.palette.length; i++) {
    const c = s.palette[i];
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 0xffffffff) {
      throw new Error(`Màu thứ ${i} trong palette nguồn của nhân vật "${profileId}" không phải số nguyên RGBA 32-bit hợp lệ.`);
    }
  }

  const pivot = validatePivot(s.pivot, w, h);

  if (doc) {
    const asset = doc.assets.find(a => a.id === assetId);
    if (!asset) {
      throw new Error(`Asset nguồn '${assetId}' của nhân vật '${profileId}' không tồn tại trong tài liệu.`);
    }
    const frame = asset.frames.find(f => f.id === frameId);
    if (!frame) {
      throw new Error(`Frame nguồn '${frameId}' của nhân vật '${profileId}' không tồn tại trong asset '${assetId}'.`);
    }
    if (asset.w !== w || asset.h !== h) {
      throw new Error(
        `Kích thước asset (${asset.w}x${asset.h}) không khớp kích thước nguồn nhân vật '${profileId}' (${w}x${h}).`
      );
    }
    if (doc.studio?.resources) {
      const res = doc.studio.resources[rgbaResourceId];
      if (!res) {
        throw new Error(`Tài nguyên RGBA nguồn '${rgbaResourceId}' của nhân vật '${profileId}' không tồn tại.`);
      }
      if (res.kind !== 'rgba') {
        throw new Error(
          `Tài nguyên RGBA nguồn '${rgbaResourceId}' của nhân vật '${profileId}' phải có loại 'rgba', phát hiện: '${res.kind}'.`
        );
      }
      if (res.w !== w || res.h !== h) {
        throw new Error(
          `Kích thước tài nguyên RGBA '${rgbaResourceId}' (${res.w}x${res.h}) không khớp kích thước nguồn (${w}x${h}).`
        );
      }
    }
  }

  return {
    assetId,
    frameId,
    captureRevision,
    w,
    h,
    rgbaResourceId,
    palette: [...s.palette],
    pivot,
  };
}

export function validateCharacterParts(
  parts: unknown,
  source: CharacterSource,
  profileId: string,
  doc?: PixelDocument
): Record<string, CharacterPart> {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    throw new Error(`Danh sách bộ phận của nhân vật "${profileId}" phải là một đối tượng hợp lệ.`);
  }
  const entries = Object.entries(parts);
  if (entries.length > MAX_CHARACTER_PARTS) {
    throw new Error(
      `Số lượng bộ phận của nhân vật "${profileId}" vượt quá giới hạn tối đa ${MAX_CHARACTER_PARTS}: ${entries.length}.`
    );
  }

  const out: Record<string, CharacterPart> = {};
  for (const [partId, val] of entries) {
    validateCharacterId(partId, `ID bộ phận "${partId}"`);
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`Bộ phận "${partId}" của nhân vật "${profileId}" phải là đối tượng hợp lệ.`);
    }
    const p = val as Record<string, unknown>;
    for (const k of Object.keys(p)) {
      if (!ALLOWED_PART_KEYS.has(k)) {
        throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong bộ phận "${partId}" của nhân vật "${profileId}".`);
      }
    }
    const name = validateName(p.name, `Tên bộ phận "${partId}"`);
    const maskResourceId = validateCharacterId(p.maskResourceId, `ID tài nguyên mặt nạ của bộ phận "${partId}"`);

    if (doc?.studio?.resources) {
      const res = doc.studio.resources[maskResourceId];
      if (!res) {
        throw new Error(`Tài nguyên mặt nạ '${maskResourceId}' của bộ phận '${partId}' không tồn tại.`);
      }
      if (res.kind !== 'mask') {
        throw new Error(
          `Tài nguyên mặt nạ '${maskResourceId}' của bộ phận '${partId}' phải có loại 'mask', phát hiện: '${res.kind}'.`
        );
      }
      if (res.w !== source.w || res.h !== source.h) {
        throw new Error(
          `Kích thước tài nguyên mặt nạ '${maskResourceId}' (${res.w}x${res.h}) không khớp kích thước nguồn (${source.w}x${source.h}).`
        );
      }
    }

    out[partId] = { name, maskResourceId };
  }
  return out;
}

export function validateCharacterLandmarks(
  landmarks: unknown,
  parts: Record<string, CharacterPart>,
  source: CharacterSource,
  profileId: string
): Record<string, CharacterLandmark> {
  if (!landmarks || typeof landmarks !== 'object' || Array.isArray(landmarks)) {
    throw new Error(`Danh sách điểm mốc của nhân vật "${profileId}" phải là một đối tượng hợp lệ.`);
  }
  const entries = Object.entries(landmarks);
  if (entries.length > MAX_CHARACTER_LANDMARKS) {
    throw new Error(
      `Số lượng điểm mốc của nhân vật "${profileId}" vượt quá giới hạn tối đa ${MAX_CHARACTER_LANDMARKS}: ${entries.length}.`
    );
  }

  const out: Record<string, CharacterLandmark> = {};
  for (const [lmId, val] of entries) {
    validateCharacterId(lmId, `ID điểm mốc "${lmId}"`);
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`Điểm mốc "${lmId}" của nhân vật "${profileId}" phải là đối tượng hợp lệ.`);
    }
    const lm = val as Record<string, unknown>;
    for (const k of Object.keys(lm)) {
      if (!ALLOWED_LANDMARK_KEYS.has(k)) {
        throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong điểm mốc "${lmId}" của nhân vật "${profileId}".`);
      }
    }

    const name = validateName(lm.name, `Tên điểm mốc "${lmId}"`);
    const x = lm.x;
    const y = lm.y;
    if (
      typeof x !== 'number' ||
      !Number.isInteger(x) ||
      x < 0 ||
      x >= source.w
    ) {
      throw new Error(`Tọa độ x của điểm mốc "${lmId}" phải là số nguyên từ 0 đến ${source.w - 1}, phát hiện: ${String(x)}.`);
    }
    if (
      typeof y !== 'number' ||
      !Number.isInteger(y) ||
      y < 0 ||
      y >= source.h
    ) {
      throw new Error(`Tọa độ y của điểm mốc "${lmId}" phải là số nguyên từ 0 đến ${source.h - 1}, phát hiện: ${String(y)}.`);
    }

    const lmPartId = lm.partId;
    if (lmPartId !== undefined) {
      if (typeof lmPartId !== 'string' || !Object.hasOwn(parts, lmPartId)) {
        throw new Error(`Bộ phận liên kết '${String(lmPartId)}' của điểm mốc '${lmId}' không tồn tại trong danh sách bộ phận.`);
      }
    }

    out[lmId] = {
      name,
      x,
      y,
      ...(lmPartId ? { partId: lmPartId } : {}),
    };
  }
  return out;
}

export function validateCharacterLinks(
  links: unknown,
  landmarks: Record<string, CharacterLandmark>,
  profileId: string
): CharacterLink[] {
  if (!Array.isArray(links)) {
    throw new Error(`Danh sách liên kết của nhân vật "${profileId}" phải là mảng.`);
  }
  if (links.length > MAX_CHARACTER_LINKS) {
    throw new Error(
      `Số lượng liên kết của nhân vật "${profileId}" vượt quá giới hạn tối đa ${MAX_CHARACTER_LINKS}: ${links.length}.`
    );
  }

  const out: CharacterLink[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (!l || typeof l !== 'object' || Array.isArray(l)) {
      throw new Error(`Liên kết thứ ${i} của nhân vật "${profileId}" phải là đối tượng hợp lệ.`);
    }
    for (const k of Object.keys(l)) {
      if (!ALLOWED_LINK_KEYS.has(k)) {
        throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong liên kết thứ ${i} của nhân vật "${profileId}".`);
      }
    }
    const from = l.from;
    const to = l.to;
    if (typeof from !== 'string' || !Object.hasOwn(landmarks, from)) {
      throw new Error(`Điểm mốc xuất phát '${String(from)}' trong liên kết thứ ${i} không tồn tại.`);
    }
    if (typeof to !== 'string' || !Object.hasOwn(landmarks, to)) {
      throw new Error(`Điểm mốc đích '${String(to)}' trong liên kết thứ ${i} không tồn tại.`);
    }
    if (from === to) {
      throw new Error(`Liên kết thứ ${i} không được nối một điểm mốc '${from}' với chính nó.`);
    }

    const pairKey = [from, to].sort().join(':');
    if (seenPairs.has(pairKey)) {
      throw new Error(`Liên kết trùng lặp giữa các điểm mốc: "${from}" và "${to}".`);
    }
    seenPairs.add(pairKey);

    out.push({ from, to });
  }
  return out;
}

export function validateCharacterActions(
  actions: unknown,
  profileId: string
): Record<string, CharacterAction> {
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new Error(`Danh sách hành động của nhân vật "${profileId}" phải là một đối tượng hợp lệ.`);
  }
  const entries = Object.entries(actions);
  if (entries.length > MAX_CHARACTER_ACTIONS) {
    throw new Error(
      `Số lượng hành động của nhân vật "${profileId}" vượt quá giới hạn tối đa ${MAX_CHARACTER_ACTIONS}: ${entries.length}.`
    );
  }

  const out: Record<string, CharacterAction> = {};
  for (const [actionId, val] of entries) {
    validateCharacterId(actionId, `ID hành động "${actionId}"`);
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`Hành động "${actionId}" của nhân vật "${profileId}" phải là đối tượng hợp lệ.`);
    }
    const a = val as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!ALLOWED_ACTION_KEYS.has(k)) {
        throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong hành động "${actionId}" của nhân vật "${profileId}".`);
      }
    }

    const name = validateName(a.name, `Tên hành động "${actionId}"`);
    const template = a.template;
    if (typeof template !== 'string' || !ACTION_TEMPLATES.includes(template as ActionTemplate)) {
      throw new Error(
        `Template hành động "${actionId}" không hợp lệ: "${String(template)}". Hỗ trợ: ${ACTION_TEMPLATES.join(', ')}.`
      );
    }

    out[actionId] = {
      name,
      template: template as ActionTemplate,
    };
  }
  return out;
}

export function validateCharacterProfile(
  profile: unknown,
  expectedId?: string,
  doc?: PixelDocument
): CharacterProfile {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Hồ sơ nhân vật phải là một đối tượng hợp lệ.');
  }
  const p = profile as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!ALLOWED_PROFILE_KEYS.has(k)) {
      throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong hồ sơ nhân vật.`);
    }
  }

  if (p.version !== CHARACTER_VERSION) {
    throw new Error(`Phiên bản hồ sơ nhân vật không được hỗ trợ: ${String(p.version)}. Chỉ hỗ trợ phiên bản 1.`);
  }

  const id = validateCharacterId(p.id, 'ID nhân vật');
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error(`ID nhân vật "${id}" không khớp với khóa trong danh sách "${expectedId}".`);
  }

  const name = validateName(p.name, `Tên nhân vật "${id}"`);
  if (typeof p.approved !== 'boolean') {
    throw new Error(`Trạng thái phê duyệt của nhân vật "${id}" phải là boolean.`);
  }
  const approved = p.approved;

  const source = validateCharacterSource(p.source, id, doc);
  const parts = validateCharacterParts(p.parts, source, id, doc);
  const landmarks = validateCharacterLandmarks(p.landmarks, parts, source, id);
  const links = validateCharacterLinks(p.links, landmarks, id);
  const actions = validateCharacterActions(p.actions, id);

  return {
    version: 1,
    id,
    name,
    approved,
    source,
    parts,
    landmarks,
    links,
    actions,
  };
}

export function validateCharacterMap(
  map: unknown,
  doc?: PixelDocument
): Record<string, CharacterProfile> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('Danh sách nhân vật phải là một đối tượng hợp lệ.');
  }
  const entries = Object.entries(map);
  if (entries.length > MAX_CHARACTER_PROFILES) {
    throw new Error(`Số lượng nhân vật vượt quá giới hạn ${MAX_CHARACTER_PROFILES}: ${entries.length}.`);
  }

  const out: Record<string, CharacterProfile> = {};
  for (const [id, prof] of entries) {
    validateCharacterId(id, 'ID nhân vật trong danh sách');
    out[id] = validateCharacterProfile(prof, id, doc);
  }
  return out;
}

export function cloneCharacterProfile(profile: CharacterProfile): CharacterProfile {
  return {
    version: 1,
    id: profile.id,
    name: profile.name,
    approved: profile.approved,
    source: {
      assetId: profile.source.assetId,
      frameId: profile.source.frameId,
      captureRevision: profile.source.captureRevision,
      w: profile.source.w,
      h: profile.source.h,
      rgbaResourceId: profile.source.rgbaResourceId,
      palette: [...profile.source.palette],
      pivot: { x: profile.source.pivot.x, y: profile.source.pivot.y },
    },
    parts: structuredClone(profile.parts),
    landmarks: structuredClone(profile.landmarks),
    links: profile.links.map(l => ({ from: l.from, to: l.to })),
    actions: structuredClone(profile.actions),
  };
}

export function cloneCharacterMap(
  map: Record<string, CharacterProfile>
): Record<string, CharacterProfile> {
  const out: Record<string, CharacterProfile> = {};
  for (const [id, prof] of Object.entries(map)) {
    out[id] = cloneCharacterProfile(prof);
  }
  return out;
}

export type CharacterReadinessStatus = 'unapproved' | 'stale' | 'ready' | 'missing-data' | 'error';

export interface CharacterReadiness {
  status: CharacterReadinessStatus;
  reason?: string;
  differences?: {
    unapproved?: boolean;
    dimensionsChanged?: boolean;
    pixelsChanged?: boolean;
    paletteChanged?: boolean;
    pivotChanged?: boolean;
    missingSourceResource?: boolean;
    missingCurrentComposite?: boolean;
  };
}

export interface CheckCharacterReadinessOptions {
  profile: CharacterProfile;
  sourceResourceData?: Uint32Array | null;
  currentComposite?: Uint32Array | null;
  currentWidth?: number;
  currentHeight?: number;
  currentPalette?: number[];
  currentPivot?: CharacterPivot | [number, number];
}

export function checkCharacterReadiness(options: CheckCharacterReadinessOptions): CharacterReadiness {
  const {
    profile,
    sourceResourceData,
    currentComposite,
    currentWidth,
    currentHeight,
    currentPalette,
    currentPivot,
  } = options;

  if (!profile.approved) {
    return {
      status: 'unapproved',
      reason: 'Nhân vật chưa được phê duyệt.',
      differences: { unapproved: true },
    };
  }

  if (!sourceResourceData) {
    return {
      status: 'missing-data',
      reason: 'Thiếu dữ liệu tài nguyên RGBA nguồn đã phê duyệt.',
      differences: { missingSourceResource: true },
    };
  }

  if (!currentComposite) {
    return {
      status: 'missing-data',
      reason: 'Thiếu dữ liệu composite điểm ảnh hiện tại.',
      differences: { missingCurrentComposite: true },
    };
  }

  if (!(sourceResourceData instanceof Uint32Array) || !(currentComposite instanceof Uint32Array)) {
    return {
      status: 'error',
      reason: 'Dữ liệu điểm ảnh phải là mảng Uint32Array.',
    };
  }

  const expectedLen = profile.source.w * profile.source.h;
  if (sourceResourceData.length !== expectedLen || currentComposite.length !== expectedLen) {
    return {
      status: 'stale',
      reason: `Kích thước bộ đệm điểm ảnh (${sourceResourceData.length} / ${currentComposite.length}) không khớp kích thước nguồn (${expectedLen}).`,
      differences: { dimensionsChanged: true, pixelsChanged: true },
    };
  }

  if (currentWidth !== undefined && currentWidth !== profile.source.w) {
    return {
      status: 'stale',
      reason: `Kích thước nguồn đã thay đổi (${profile.source.w} -> ${currentWidth}).`,
      differences: { dimensionsChanged: true },
    };
  }

  if (currentHeight !== undefined && currentHeight !== profile.source.h) {
    return {
      status: 'stale',
      reason: `Kích thước nguồn đã thay đổi (${profile.source.h} -> ${currentHeight}).`,
      differences: { dimensionsChanged: true },
    };
  }

  for (let i = 0; i < sourceResourceData.length; i++) {
    if (sourceResourceData[i] !== currentComposite[i]) {
      return {
        status: 'stale',
        reason: 'Điểm ảnh composite hiện tại đã thay đổi so với bản nguồn đã phê duyệt.',
        differences: { pixelsChanged: true },
      };
    }
  }

  if (currentPalette !== undefined) {
    if (!Array.isArray(currentPalette)) {
      return {
        status: 'error',
        reason: 'Palette hiện tại phải là mảng.',
      };
    }
    if (currentPalette.length !== profile.source.palette.length) {
      return {
        status: 'stale',
        reason: 'Palette hiện tại đã thay đổi số lượng màu so với bản nguồn đã phê duyệt.',
        differences: { paletteChanged: true },
      };
    }
    for (let i = 0; i < currentPalette.length; i++) {
      if (currentPalette[i] !== profile.source.palette[i]) {
        return {
          status: 'stale',
          reason: 'Palette hiện tại đã thay đổi giá trị màu hoặc thứ tự so với bản nguồn đã phê duyệt.',
          differences: { paletteChanged: true },
        };
      }
    }
  }

  if (currentPivot !== undefined) {
    const curP = Array.isArray(currentPivot) ? { x: currentPivot[0], y: currentPivot[1] } : currentPivot;
    if (curP.x !== profile.source.pivot.x || curP.y !== profile.source.pivot.y) {
      return {
        status: 'stale',
        reason: `Pivot hiện tại (${curP.x}, ${curP.y}) đã thay đổi so với bản nguồn (${profile.source.pivot.x}, ${profile.source.pivot.y}).`,
        differences: { pivotChanged: true },
      };
    }
  }

  if (
    currentWidth === undefined ||
    currentHeight === undefined ||
    currentPalette === undefined ||
    currentPivot === undefined
  ) {
    return {
      status: 'missing-data',
      reason: 'Cần đầy đủ thông tin metadata hiện tại (chiều rộng, chiều cao, palette, pivot) để xác nhận trạng thái sẵn sàng.',
    };
  }

  return {
    status: 'ready',
    reason: 'Bản nguồn đã phê duyệt khớp hoàn toàn với trạng thái hiện tại.',
    differences: {},
  };
}
