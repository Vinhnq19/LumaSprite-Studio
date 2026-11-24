import type { PixelDocument } from './pixel/model.ts';
import {
  type ActionTemplate,
  type CharacterProfile,
  ACTION_TEMPLATES,
  checkCharacterReadiness,
  validateCharacterId,
  validateName,
} from './characters.ts';
import { type StudioResource, validateResourceId } from './resources.ts';

export const CLIP_VERSION = 1 as const;
export const MAX_CLIPS = 16;
export const MIN_CLIP_SLOTS = 2;
export const MAX_CLIP_SLOTS = 24;
export const MIN_SLOT_DURATION = 1;
export const MAX_SLOT_DURATION = 60000;
export const MAX_CLIP_NAME_LENGTH = 100;

export const CLIP_FACINGS = ['source', 'left', 'right'] as const;
export type ClipFacing = (typeof CLIP_FACINGS)[number];

export const CLIP_MODES = ['region', 'whole'] as const;
export type ClipMode = (typeof CLIP_MODES)[number];

export interface ClipPosePoint {
  x: number;
  y: number;
}

export interface ClipSlot {
  id: string;
  duration: number;
  selected: boolean;
  frozen: boolean;
  keyframe: boolean;
  rgbaResourceId: string;
  pose: Record<string, ClipPosePoint>;
}

export interface CharacterClip {
  version: 1;
  id: string;
  name: string;
  characterId: string;
  template: ActionTemplate;
  loop: boolean;
  facing: ClipFacing;
  mode: ClipMode;
  movementMaskResourceId?: string;
  slots: ClipSlot[];
}

const RESERVED_CLIP_IDS = new Set([
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

const ALLOWED_CLIP_KEYS = new Set([
  'version',
  'id',
  'name',
  'characterId',
  'template',
  'loop',
  'facing',
  'mode',
  'movementMaskResourceId',
  'slots',
]);

const ALLOWED_SLOT_KEYS = new Set([
  'id',
  'duration',
  'selected',
  'frozen',
  'keyframe',
  'rgbaResourceId',
  'pose',
]);

const ALLOWED_POSE_KEYS = new Set(['x', 'y']);

export function isValidClipId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 80 &&
    /^[A-Za-z0-9_-]+$/.test(id) &&
    !RESERVED_CLIP_IDS.has(id)
  );
}

export function validateClipId(id: unknown, label = 'ID clip'): string {
  if (typeof id !== 'string') throw new Error(`${label} phải là chuỗi ký tự.`);
  if (id.length < 1 || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`${label} không hợp lệ: "${id}". Chỉ cho phép 1-80 ký tự ASCII chữ, số, gạch dưới, gạch nối.`);
  }
  if (RESERVED_CLIP_IDS.has(id)) {
    throw new Error(`${label} không được dùng tên dự lưu: "${id}".`);
  }
  return id;
}

export function isValidSlotId(id: unknown): id is string {
  return isValidClipId(id);
}

export function validateSlotId(id: unknown, label = 'ID slot'): string {
  return validateClipId(id, label);
}

export function validateMovementMaskBuffer(
  data: unknown,
  w: number,
  h: number,
  label = 'Mặt nạ di chuyển'
): Uint32Array {
  if (!(data instanceof Uint32Array)) {
    throw new Error(`${label} phải là Uint32Array.`);
  }
  const expectedLen = w * h;
  if (data.length !== expectedLen) {
    throw new Error(`${label} có kích thước (${data.length}) không khớp kích thước nguồn (${expectedLen}).`);
  }
  let hasOne = false;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== 0 && v !== 1) {
      throw new Error(`${label} chỉ cho phép giá trị 0 hoặc 1, phát hiện: ${v}.`);
    }
    if (v === 1) hasOne = true;
  }
  if (!hasOne) {
    throw new Error(`${label} không được rỗng (cần ít nhất một điểm ảnh được chọn).`);
  }
  return data;
}

export function validatePosePoint(
  point: unknown,
  landmarkId: string,
  slotId: string,
  character?: CharacterProfile
): ClipPosePoint {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    throw new Error(`Điểm pose "${landmarkId}" trong slot "${slotId}" phải là đối tượng hợp lệ.`);
  }
  const obj = point as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_POSE_KEYS.has(k)) {
      throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong tọa độ điểm pose "${landmarkId}".`);
    }
  }

  const x = obj.x;
  const y = obj.y;
  if (typeof x !== 'number' || !Number.isInteger(x) || !Number.isFinite(x)) {
    throw new Error(`Tọa độ x của điểm pose "${landmarkId}" trong slot "${slotId}" phải là số nguyên.`);
  }
  if (typeof y !== 'number' || !Number.isInteger(y) || !Number.isFinite(y)) {
    throw new Error(`Tọa độ y của điểm pose "${landmarkId}" trong slot "${slotId}" phải là số nguyên.`);
  }

  if (character) {
    if (x < 0 || x >= character.source.w) {
      throw new Error(
        `Tọa độ x (${x}) của điểm pose "${landmarkId}" trong slot "${slotId}" vượt ngoài phạm vi nguồn (0..${character.source.w - 1}).`
      );
    }
    if (y < 0 || y >= character.source.h) {
      throw new Error(
        `Tọa độ y (${y}) của điểm pose "${landmarkId}" trong slot "${slotId}" vượt ngoài phạm vi nguồn (0..${character.source.h - 1}).`
      );
    }
  } else {
    if (x < 0 || y < 0) {
      throw new Error(`Tọa độ điểm pose "${landmarkId}" không được âm.`);
    }
  }

  return { x, y };
}

export function validateSlot(
  slot: unknown,
  index: number,
  clipId: string,
  character?: CharacterProfile,
  doc?: PixelDocument,
  fallbackResources?: Record<string, StudioResource>
): ClipSlot {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
    throw new Error(`Slot thứ ${index} trong clip "${clipId}" phải là đối tượng hợp lệ.`);
  }
  const s = slot as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!ALLOWED_SLOT_KEYS.has(k)) {
      throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong slot thứ ${index} của clip "${clipId}".`);
    }
  }

  const id = validateSlotId(s.id, `ID slot thứ ${index} trong clip "${clipId}"`);

  const duration = s.duration;
  if (
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < MIN_SLOT_DURATION ||
    duration > MAX_SLOT_DURATION
  ) {
    throw new Error(
      `Thời lượng slot "${id}" phải là số nguyên từ ${MIN_SLOT_DURATION} đến ${MAX_SLOT_DURATION} ms.`
    );
  }

  if (typeof s.selected !== 'boolean') {
    throw new Error(`Trạng thái 'selected' của slot "${id}" phải là boolean.`);
  }
  const selected = s.selected;

  if (typeof s.frozen !== 'boolean') {
    throw new Error(`Trạng thái 'frozen' của slot "${id}" phải là boolean.`);
  }
  const frozen = s.frozen;

  if (typeof s.keyframe !== 'boolean') {
    throw new Error(`Trạng thái 'keyframe' của slot "${id}" phải là boolean.`);
  }
  const keyframe = s.keyframe;

  if (frozen && selected) {
    throw new Error(`Slot "${id}" không thể vừa được đóng băng (frozen) vừa được chọn (selected).`);
  }

  const rgbaResourceId = validateResourceId(s.rgbaResourceId);

  const resources = doc?.studio?.resources ?? fallbackResources;
  if (resources) {
    const res = resources[rgbaResourceId];
    if (!res) {
      throw new Error(`Tài nguyên RGBA '${rgbaResourceId}' của slot '${id}' không tồn tại trong tài liệu.`);
    }
    if (res.kind !== 'rgba') {
      throw new Error(
        `Tài nguyên RGBA '${rgbaResourceId}' của slot '${id}' phải có loại 'rgba', phát hiện: '${res.kind}'.`
      );
    }
    if (character && (res.w !== character.source.w || res.h !== character.source.h)) {
      throw new Error(
        `Kích thước tài nguyên RGBA '${rgbaResourceId}' (${res.w}x${res.h}) không khớp kích thước nhân vật (${character.source.w}x${character.source.h}).`
      );
    }
  }

  if (!s.pose || typeof s.pose !== 'object' || Array.isArray(s.pose)) {
    throw new Error(`Pose của slot "${id}" phải là đối tượng hợp lệ.`);
  }
  const poseObj = s.pose as Record<string, unknown>;
  const pose: Record<string, ClipPosePoint> = {};

  for (const [lmId, pt] of Object.entries(poseObj)) {
    validateCharacterId(lmId, `ID điểm mốc trong pose của slot "${id}"`);
    if (character) {
      if (!Object.hasOwn(character.landmarks, lmId)) {
        throw new Error(
          `Điểm mốc '${lmId}' trong pose của slot '${id}' không tồn tại trong danh sách điểm mốc của nhân vật '${character.id}'.`
        );
      }
    }
    pose[lmId] = validatePosePoint(pt, lmId, id, character);
  }

  return {
    id,
    duration,
    selected,
    frozen,
    keyframe,
    rgbaResourceId,
    pose,
  };
}

export function validateCharacterClip(
  clip: unknown,
  expectedId?: string,
  doc?: PixelDocument,
  fallbackCharacters?: Record<string, CharacterProfile>,
  fallbackResources?: Record<string, StudioResource>
): CharacterClip {
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) {
    throw new Error('Clip nhân vật phải là một đối tượng hợp lệ.');
  }
  const c = clip as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!ALLOWED_CLIP_KEYS.has(k)) {
      throw new Error(`Thuộc tính "${k}" không được hỗ trợ trong clip.`);
    }
  }

  if (c.version !== CLIP_VERSION) {
    throw new Error(`Phiên bản clip không được hỗ trợ: ${String(c.version)}. Chỉ hỗ trợ phiên bản 1.`);
  }

  const id = validateClipId(c.id, 'ID clip');
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error(`ID clip "${id}" không khớp với khóa trong danh sách "${expectedId}".`);
  }

  const name = validateName(c.name, `Tên clip "${id}"`);
  const characterId = validateCharacterId(c.characterId, `ID nhân vật của clip "${id}"`);

  const characters = doc?.studio?.characters ?? fallbackCharacters;
  let character: CharacterProfile | undefined;
  if (characters) {
    character = characters[characterId];
    if (!character) {
      throw new Error(`Nhân vật '${characterId}' được tham chiếu bởi clip '${id}' không tồn tại.`);
    }
  }

  const template = c.template;
  if (typeof template !== 'string' || !ACTION_TEMPLATES.includes(template as ActionTemplate)) {
    throw new Error(
      `Template của clip "${id}" không hợp lệ: "${String(template)}". Hỗ trợ: ${ACTION_TEMPLATES.join(', ')}.`
    );
  }

  if (typeof c.loop !== 'boolean') {
    throw new Error(`Trạng thái lặp (loop) của clip "${id}" phải là boolean.`);
  }
  const loop = c.loop;

  const facing = c.facing;
  if (typeof facing !== 'string' || !CLIP_FACINGS.includes(facing as ClipFacing)) {
    throw new Error(
      `Hướng quay (facing) của clip "${id}" không hợp lệ: "${String(facing)}". Hỗ trợ: ${CLIP_FACINGS.join(', ')}.`
    );
  }

  const mode = c.mode;
  if (typeof mode !== 'string' || !CLIP_MODES.includes(mode as ClipMode)) {
    throw new Error(
      `Chế độ (mode) của clip "${id}" không hợp lệ: "${String(mode)}". Hỗ trợ: ${CLIP_MODES.join(', ')}.`
    );
  }

  let movementMaskResourceId: string | undefined;
  if (mode === 'region') {
    if (c.movementMaskResourceId === undefined || c.movementMaskResourceId === null) {
      throw new Error(`Clip ở chế độ vùng ('region') cần có tài nguyên mặt nạ di chuyển 'movementMaskResourceId'.`);
    }
    movementMaskResourceId = validateResourceId(c.movementMaskResourceId);
    const resources = doc?.studio?.resources ?? fallbackResources;
    if (resources) {
      const res = resources[movementMaskResourceId];
      if (!res) {
        throw new Error(`Tài nguyên mặt nạ '${movementMaskResourceId}' của clip '${id}' không tồn tại.`);
      }
      if (res.kind !== 'mask') {
        throw new Error(
          `Tài nguyên mặt nạ '${movementMaskResourceId}' của clip '${id}' phải có loại 'mask', phát hiện: '${res.kind}'.`
        );
      }
      if (character && (res.w !== character.source.w || res.h !== character.source.h)) {
        throw new Error(
          `Kích thước mặt nạ '${movementMaskResourceId}' (${res.w}x${res.h}) không khớp kích thước nguồn nhân vật '${character.id}' (${character.source.w}x${character.source.h}).`
        );
      }
    }
  } else {
    if (c.movementMaskResourceId !== undefined && c.movementMaskResourceId !== null) {
      throw new Error(`Clip ở chế độ toàn phần ('whole') không được chứa mặt nạ di chuyển.`);
    }
  }

  if (!Array.isArray(c.slots)) {
    throw new Error(`Danh sách slot của clip "${id}" phải là mảng.`);
  }
  if (c.slots.length < MIN_CLIP_SLOTS || c.slots.length > MAX_CLIP_SLOTS) {
    throw new Error(
      `Số lượng slot của clip "${id}" phải từ ${MIN_CLIP_SLOTS} đến ${MAX_CLIP_SLOTS}, phát hiện: ${c.slots.length}.`
    );
  }

  const seenSlotIds = new Set<string>();
  const slots: ClipSlot[] = [];

  for (let i = 0; i < c.slots.length; i++) {
    const validatedSlot = validateSlot(c.slots[i], i, id, character, doc, fallbackResources);
    if (seenSlotIds.has(validatedSlot.id)) {
      throw new Error(`ID slot bị trùng lặp trong clip "${id}": "${validatedSlot.id}".`);
    }
    seenSlotIds.add(validatedSlot.id);
    slots.push(validatedSlot);
  }

  return {
    version: 1,
    id,
    name,
    characterId,
    template: template as ActionTemplate,
    loop,
    facing: facing as ClipFacing,
    mode: mode as ClipMode,
    ...(movementMaskResourceId ? { movementMaskResourceId } : {}),
    slots,
  };
}

export function validateClipMap(
  map: unknown,
  doc?: PixelDocument,
  fallbackCharacters?: Record<string, CharacterProfile>,
  fallbackResources?: Record<string, StudioResource>
): Record<string, CharacterClip> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('Danh sách clip phải là một đối tượng hợp lệ.');
  }
  const entries = Object.entries(map);
  if (entries.length > MAX_CLIPS) {
    throw new Error(`Số lượng clip vượt quá giới hạn tối đa ${MAX_CLIPS}: ${entries.length}.`);
  }

  const out: Record<string, CharacterClip> = {};
  for (const [id, clip] of entries) {
    validateClipId(id, 'ID clip trong danh sách');
    out[id] = validateCharacterClip(clip, id, doc, fallbackCharacters, fallbackResources);
  }
  return out;
}

export function cloneClipSlot(slot: ClipSlot): ClipSlot {
  return {
    id: slot.id,
    duration: slot.duration,
    selected: slot.selected,
    frozen: slot.frozen,
    keyframe: slot.keyframe,
    rgbaResourceId: slot.rgbaResourceId,
    pose: Object.fromEntries(
      Object.entries(slot.pose).map(([k, pt]) => [k, { x: pt.x, y: pt.y }])
    ),
  };
}

export function cloneCharacterClip(clip: CharacterClip): CharacterClip {
  return {
    version: 1,
    id: clip.id,
    name: clip.name,
    characterId: clip.characterId,
    template: clip.template,
    loop: clip.loop,
    facing: clip.facing,
    mode: clip.mode,
    ...(clip.movementMaskResourceId ? { movementMaskResourceId: clip.movementMaskResourceId } : {}),
    slots: clip.slots.map(cloneClipSlot),
  };
}

export function cloneClipMap(
  map: Record<string, CharacterClip>
): Record<string, CharacterClip> {
  const out: Record<string, CharacterClip> = {};
  for (const [id, clip] of Object.entries(map)) {
    out[id] = cloneCharacterClip(clip);
  }
  return out;
}

export interface CheckClipReadinessOptions {
  sourceResourceData?: Uint32Array | null;
  currentComposite?: Uint32Array | null;
  currentWidth?: number;
  currentHeight?: number;
  currentPalette?: number[];
  currentPivot?: { x: number; y: number } | [number, number];
  movementMaskData?: Uint32Array | null;
}

export type ClipReadinessStatus =
  | 'ready'
  | 'unapproved'
  | 'stale'
  | 'missing-data'
  | 'no-selection'
  | 'invalid-mask'
  | 'error';

export interface ClipReadiness {
  ready: boolean;
  status: ClipReadinessStatus;
  reason?: string;
  selectedUnlockedCount: number;
}

export function checkClipReadiness(
  clip: CharacterClip,
  doc?: PixelDocument,
  options?: CheckClipReadinessOptions
): ClipReadiness {
  const character = doc?.studio?.characters?.[clip.characterId];
  if (!character) {
    return {
      ready: false,
      status: 'error',
      reason: `Nhân vật '${clip.characterId}' không tồn tại.`,
      selectedUnlockedCount: 0,
    };
  }
  if (!character.approved) {
    return {
      ready: false,
      status: 'unapproved',
      reason: `Nhân vật '${clip.characterId}' chưa được phê duyệt.`,
      selectedUnlockedCount: 0,
    };
  }

  const selectedUnlocked = clip.slots.filter(s => s.selected && !s.frozen);
  if (selectedUnlocked.length === 0) {
    return {
      ready: false,
      status: 'no-selection',
      reason: 'Cần ít nhất một slot được chọn và không bị khóa (unlocked) để bắt đầu tạo thế/hoạt cảnh.',
      selectedUnlockedCount: 0,
    };
  }

  if (clip.mode === 'region') {
    if (!clip.movementMaskResourceId) {
      return {
        ready: false,
        status: 'invalid-mask',
        reason: 'Clip vùng thiếu mặt nạ di chuyển.',
        selectedUnlockedCount: selectedUnlocked.length,
      };
    }
    const maskRes = doc?.studio?.resources?.[clip.movementMaskResourceId];
    if (!maskRes || maskRes.kind !== 'mask') {
      return {
        ready: false,
        status: 'invalid-mask',
        reason: 'Tài nguyên mặt nạ di chuyển không hợp lệ.',
        selectedUnlockedCount: selectedUnlocked.length,
      };
    }
    if (maskRes.w !== character.source.w || maskRes.h !== character.source.h) {
      return {
        ready: false,
        status: 'invalid-mask',
        reason: `Kích thước mặt nạ di chuyển (${maskRes.w}x${maskRes.h}) không khớp kích thước nguồn (${character.source.w}x${character.source.h}).`,
        selectedUnlockedCount: selectedUnlocked.length,
      };
    }
    const maskData = options?.movementMaskData ?? maskRes.data;
    if (!maskData) {
      return {
        ready: false,
        status: 'missing-data',
        reason: 'Thiếu dữ liệu mặt nạ di chuyển (chưa nạp từ blob).',
        selectedUnlockedCount: selectedUnlocked.length,
      };
    }
    if (!(maskData instanceof Uint32Array)) {
      return {
        ready: false,
        status: 'invalid-mask',
        reason: 'Dữ liệu mặt nạ di chuyển phải là Uint32Array.',
        selectedUnlockedCount: selectedUnlocked.length,
      };
    }
    try {
      validateMovementMaskBuffer(maskData, character.source.w, character.source.h);
    } catch (err) {
      return {
        ready: false,
        status: 'invalid-mask',
        reason: (err as Error).message,
        selectedUnlockedCount: selectedUnlocked.length,
      };
    }
  }

  // Source evidence is required for execution readiness
  const sourceRes = doc?.studio?.resources?.[character.source.rgbaResourceId];
  const sourceResourceData = options?.sourceResourceData ?? sourceRes?.data;
  const currentComposite = options?.currentComposite;

  const charReadiness = checkCharacterReadiness({
    profile: character,
    sourceResourceData,
    currentComposite,
    currentWidth: options?.currentWidth,
    currentHeight: options?.currentHeight,
    currentPalette: options?.currentPalette,
    currentPivot: options?.currentPivot,
  });

  if (charReadiness.status !== 'ready') {
    return {
      ready: false,
      status: charReadiness.status,
      reason: charReadiness.reason,
      selectedUnlockedCount: selectedUnlocked.length,
    };
  }

  return {
    ready: true,
    status: 'ready',
    selectedUnlockedCount: selectedUnlocked.length,
  };
}
