import { isValidCharacterId, validateName } from './characters.ts';
import { isValidClipId, isValidSlotId } from './clips.ts';

export const CLIP_GENERATION_CONTEXT_VERSION = 1 as const;
export const MIN_CLIP_GENERATION_SLOTS = 2;
export const MAX_CLIP_GENERATION_SLOTS = 24;
export const MIN_SLOT_DURATION = 1;
export const MAX_SLOT_DURATION = 60000;
export const MAX_CLIP_PIXEL_BUDGET = 32_000_000;
export const MAX_CLIP_DIMENSION = 4096;
export const MAX_CLIP_LANDMARKS = 64;
export const MAX_CLIP_LINKS = 128;
export const MAX_CLIP_PARTS = 64;

export const CLIP_GENERATION_PALETTE_MODES = ['asset', 'auto16'] as const;
export type ClipGenerationPaletteMode = (typeof CLIP_GENERATION_PALETTE_MODES)[number];

export const CLIP_GENERATION_MODES = ['region', 'whole'] as const;
export type ClipGenerationMode = (typeof CLIP_GENERATION_MODES)[number];

export interface ClipGenerationLandmark {
  name: string;
  x: number;
  y: number;
  partId?: string;
}

export interface ClipGenerationLink {
  from: string;
  to: string;
}

export interface ClipGenerationPart {
  name: string;
}

export interface ClipGenerationSlot {
  id: string;
  duration: number;
  selected: boolean;
  frozen: boolean;
  keyframe: boolean;
  pose: Record<string, { x: number; y: number }>;
}

export interface ClipGenerationMetadata {
  pivot?: { x: number; y: number };
  hitbox?: { x: number; y: number; w: number; h: number };
  events?: { frame: number; name: string }[];
}

export interface ClipGenerationContext {
  version: 1;
  projectId: string;
  revision: number;
  clipId: string;
  characterId: string;
  name: string;
  sourceAssetId: string;
  sourceFrameId: string;
  w: number;
  h: number;
  paletteMode: ClipGenerationPaletteMode;
  palette: number[];
  pivot: { x: number; y: number }; // In exact pixel coordinates (not normalized)
  mode: ClipGenerationMode;
  loop: boolean;
  landmarks: Record<string, ClipGenerationLandmark>;
  links: ClipGenerationLink[];
  parts: Record<string, ClipGenerationPart>;
  sourceMetadata?: ClipGenerationMetadata;
  slots: ClipGenerationSlot[];
}

export interface CreateClipGenerationContextInput {
  projectId: string;
  revision: number;
  clipId: string;
  characterId: string;
  name: string;
  sourceAssetId: string;
  sourceFrameId: string;
  w: number;
  h: number;
  paletteMode?: ClipGenerationPaletteMode;
  palette: number[];
  pivot: { x: number; y: number };
  mode: ClipGenerationMode;
  loop: boolean;
  landmarks?: Record<string, ClipGenerationLandmark>;
  links?: ClipGenerationLink[];
  parts?: Record<string, ClipGenerationPart | string>;
  sourceMetadata?: ClipGenerationMetadata;
  slots: {
    id: string;
    duration: number;
    selected: boolean;
    frozen: boolean;
    keyframe: boolean;
    pose?: Record<string, { x: number; y: number }>;
  }[];
}

const RESERVED_NAMES = new Set([
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

const ALLOWED_CONTEXT_KEYS = new Set([
  'version',
  'projectId',
  'revision',
  'clipId',
  'characterId',
  'name',
  'sourceAssetId',
  'sourceFrameId',
  'w',
  'h',
  'paletteMode',
  'palette',
  'pivot',
  'mode',
  'loop',
  'landmarks',
  'links',
  'parts',
  'sourceMetadata',
  'slots',
]);

const ALLOWED_SLOT_KEYS = new Set([
  'id',
  'duration',
  'selected',
  'frozen',
  'keyframe',
  'pose',
]);

const ALLOWED_LANDMARK_KEYS = new Set(['name', 'x', 'y', 'partId']);
const ALLOWED_LINK_KEYS = new Set(['from', 'to']);
const ALLOWED_METADATA_KEYS = new Set(['pivot', 'hitbox', 'events']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkNoResourceOrPathLeaks(str: string, field: string): void {
  if (/[/\\:\x00-\x1f]/.test(str)) {
    throw new Error(`Trường "${field}" không được chứa ký tự đường dẫn hoặc ký tự điều khiển: "${str}".`);
  }
  if (/\.(png|jpe?g|gif|webp|js|ts|json|bin|dat|zip)$/i.test(str)) {
    throw new Error(`Trường "${field}" không được chứa phần mở rộng file: "${str}".`);
  }
}

function validateIdString(id: unknown, field: string): string {
  if (typeof id !== 'string' || id.length < 1 || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id) || RESERVED_NAMES.has(id)) {
    throw new Error(`Định danh ${field} không hợp lệ: "${String(id)}".`);
  }
  checkNoResourceOrPathLeaks(id, field);
  return id;
}

export function validateClipGenerationContext(input: unknown): ClipGenerationContext {
  if (!isPlainObject(input)) {
    throw new Error('ClipGenerationContext phải là một plain object.');
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_CONTEXT_KEYS.has(key)) {
      throw new Error(`Khóa không hỗ trợ trong ClipGenerationContext: "${key}".`);
    }
  }

  if (input.version !== CLIP_GENERATION_CONTEXT_VERSION) {
    throw new Error(`ClipGenerationContext yêu cầu version ${CLIP_GENERATION_CONTEXT_VERSION}, nhận: ${String(input.version)}.`);
  }

  const projectId = validateIdString(input.projectId, 'projectId');
  const clipId = validateIdString(input.clipId, 'clipId');
  if (!isValidClipId(clipId)) {
    throw new Error(`clipId không hợp lệ: "${clipId}".`);
  }

  const characterId = validateIdString(input.characterId, 'characterId');
  if (!isValidCharacterId(characterId)) {
    throw new Error(`characterId không hợp lệ: "${characterId}".`);
  }

  const name = validateName(input.name, 'Tên clip');
  checkNoResourceOrPathLeaks(name, 'name');

  const sourceAssetId = validateIdString(input.sourceAssetId, 'sourceAssetId');
  const sourceFrameId = validateIdString(input.sourceFrameId, 'sourceFrameId');

  const revision = input.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) {
    throw new Error(`Revision cần là số nguyên dương: ${String(revision)}.`);
  }

  const w = input.w;
  const h = input.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) < 1 || (h as number) < 1 || (w as number) > MAX_CLIP_DIMENSION || (h as number) > MAX_CLIP_DIMENSION) {
    throw new Error(`Kích thước w, h phải là số nguyên từ 1 đến ${MAX_CLIP_DIMENSION} px.`);
  }
  const width = w as number;
  const height = h as number;

  const mode = input.mode;
  if (mode !== 'region' && mode !== 'whole') {
    throw new Error(`Chế độ clip phải là 'region' hoặc 'whole', nhận: "${String(mode)}".`);
  }

  const loop = input.loop;
  if (typeof loop !== 'boolean') {
    throw new Error(`loop phải là boolean, nhận: ${String(loop)}.`);
  }

  const paletteMode = input.paletteMode;
  if (paletteMode !== 'asset' && paletteMode !== 'auto16') {
    throw new Error(`paletteMode phải là 'asset' hoặc 'auto16', nhận: "${String(paletteMode)}".`);
  }

  if (!Array.isArray(input.palette) || input.palette.length === 0) {
    throw new Error('palette cần là mảng số màu không rỗng.');
  }
  if (input.palette.length > 4096) {
    throw new Error('palette không được vượt quá 4096 màu.');
  }

  for (const c of input.palette) {
    if (!Number.isInteger(c) || c < 0 || c > 0xffffffff) {
      throw new Error(`Màu không hợp lệ trong palette: ${String(c)}.`);
    }
    const alpha = c & 255;
    if (alpha === 0 && c !== 0) {
      throw new Error(`Palette đích không được chứa RGB ẩn khi alpha = 0 (0x${c.toString(16)}).`);
    }
    if (alpha !== 0 && alpha !== 255) {
      throw new Error(`Palette đích chỉ hỗ trợ màu đục (alpha 255) và trong suốt chuẩn (0), nhận màu với alpha ${alpha}: 0x${c.toString(16)}.`);
    }
  }

  const opaqueColors = input.palette.filter(c => (c & 255) === 255);
  if (opaqueColors.length === 0) {
    throw new Error('Palette đích phải chứa ít nhất một màu đục (alpha 255).');
  }

  if (paletteMode === 'auto16') {
    const uniqueOpaque = new Set(opaqueColors);
    if (uniqueOpaque.size > 16) {
      throw new Error(`auto16 chỉ cho phép tối đa 16 màu nhìn thấy, nhận: ${uniqueOpaque.size}.`);
    }
  }

  const palette = [...input.palette];

  // Pivot validation (PIXELS)
  if (!isPlainObject(input.pivot)) {
    throw new Error('pivot cần là một object { x, y } theo tọa độ pixel.');
  }
  const px = input.pivot.x;
  const py = input.pivot.y;
  if (!Number.isFinite(px) || !Number.isFinite(py) || (px as number) < 0 || (px as number) > width || (py as number) < 0 || (py as number) > height) {
    throw new Error(`pivot pixel (${String(px)}, ${String(py)}) phải nằm trong giới hạn canvas [0..${width}, 0..${height}].`);
  }
  const pivot = { x: px as number, y: py as number };

  // Landmarks validation
  const landmarks: Record<string, ClipGenerationLandmark> = {};
  if (input.landmarks !== undefined) {
    if (!isPlainObject(input.landmarks)) {
      throw new Error('landmarks phải là một object mapping ID sang thông tin landmark.');
    }
    const landmarkEntries = Object.entries(input.landmarks);
    if (landmarkEntries.length > MAX_CLIP_LANDMARKS) {
      throw new Error(`Tối đa ${MAX_CLIP_LANDMARKS} landmark.`);
    }
    for (const [id, lm] of landmarkEntries) {
      validateIdString(id, `landmark id "${id}"`);
      if (!isPlainObject(lm)) {
        throw new Error(`Landmark "${id}" không hợp lệ.`);
      }
      for (const k of Object.keys(lm)) {
        if (!ALLOWED_LANDMARK_KEYS.has(k)) {
          throw new Error(`Khóa không hỗ trợ trong landmark "${id}": "${k}".`);
        }
      }
      const lmName = validateName(lm.name, `Landmark "${id}" name`);
      checkNoResourceOrPathLeaks(lmName, `landmark "${id}" name`);
      const lx = lm.x;
      const ly = lm.y;
      if (!Number.isInteger(lx) || !Number.isInteger(ly) || (lx as number) < 0 || (lx as number) >= width || (ly as number) < 0 || (ly as number) >= height) {
        throw new Error(`Tọa độ landmark "${id}" (${String(lx)}, ${String(ly)}) phải là số nguyên trong canvas [0..${width - 1}, 0..${height - 1}].`);
      }
      let partId: string | undefined;
      if (lm.partId !== undefined) {
        partId = validateIdString(lm.partId, `landmark "${id}" partId`);
      }
      landmarks[id] = { name: lmName, x: lx as number, y: ly as number, ...(partId ? { partId } : {}) };
    }
  }

  // Links validation
  const links: ClipGenerationLink[] = [];
  if (input.links !== undefined) {
    if (!Array.isArray(input.links)) {
      throw new Error('links phải là mảng.');
    }
    if (input.links.length > MAX_CLIP_LINKS) {
      throw new Error(`Tối đa ${MAX_CLIP_LINKS} link.`);
    }
    for (const link of input.links) {
      if (!isPlainObject(link)) {
        throw new Error('link không hợp lệ.');
      }
      for (const k of Object.keys(link)) {
        if (!ALLOWED_LINK_KEYS.has(k)) {
          throw new Error(`Khóa không hỗ trợ trong link: "${k}".`);
        }
      }
      const from = validateIdString(link.from, 'link from');
      const to = validateIdString(link.to, 'link to');
      if (!landmarks[from]) {
        throw new Error(`Link "from" tham chiếu landmark không tồn tại: "${from}".`);
      }
      if (!landmarks[to]) {
        throw new Error(`Link "to" tham chiếu landmark không tồn tại: "${to}".`);
      }
      links.push({ from, to });
    }
  }

  // Parts validation (visual guidance names only, strictly NO resource refs)
  const parts: Record<string, ClipGenerationPart> = {};
  if (input.parts !== undefined) {
    if (!isPlainObject(input.parts)) {
      throw new Error('parts phải là object.');
    }
    const partEntries = Object.entries(input.parts);
    if (partEntries.length > MAX_CLIP_PARTS) {
      throw new Error(`Tối đa ${MAX_CLIP_PARTS} part.`);
    }
    for (const [id, pt] of partEntries) {
      validateIdString(id, `part id "${id}"`);
      if (typeof pt === 'string') {
        const pName = validateName(pt, `Part "${id}" name`);
        checkNoResourceOrPathLeaks(pName, `part "${id}" name`);
        parts[id] = { name: pName };
      } else if (isPlainObject(pt)) {
        if (Object.keys(pt).some(k => k !== 'name')) {
          throw new Error(`Part "${id}" chỉ hỗ trợ trường "name" để hướng dẫn thị giác (không hỗ trợ resource ref).`);
        }
        const pName = validateName(pt.name, `Part "${id}" name`);
        checkNoResourceOrPathLeaks(pName, `part "${id}" name`);
        parts[id] = { name: pName };
      } else {
        throw new Error(`Part "${id}" không hợp lệ.`);
      }
    }
  }

  // Check landmark partId resolves to known part
  for (const [lmId, lm] of Object.entries(landmarks)) {
    if (lm.partId && !parts[lm.partId]) {
      throw new Error(`Landmark "${lmId}" tham chiếu partId không tồn tại: "${lm.partId}".`);
    }
  }

  // Slots validation
  if (!Array.isArray(input.slots)) {
    throw new Error('slots phải là mảng.');
  }
  const slotCount = input.slots.length;
  if (slotCount < MIN_CLIP_GENERATION_SLOTS || slotCount > MAX_CLIP_GENERATION_SLOTS) {
    throw new Error(`Số lượng slot phải từ ${MIN_CLIP_GENERATION_SLOTS} đến ${MAX_CLIP_GENERATION_SLOTS}, nhận: ${slotCount}.`);
  }

  const totalPixels = slotCount * width * height;
  if (totalPixels > MAX_CLIP_PIXEL_BUDGET) {
    throw new Error(`Tổng số pixel cel (${totalPixels}) vượt quá ngân sách ${MAX_CLIP_PIXEL_BUDGET}.`);
  }

  const seenSlotIds = new Set<string>();
  const slots: ClipGenerationSlot[] = [];
  let selectedUnlockedCount = 0;

  for (let i = 0; i < slotCount; i++) {
    const s = input.slots[i];
    if (!isPlainObject(s)) {
      throw new Error(`Slot thứ ${i + 1} không hợp lệ.`);
    }
    for (const k of Object.keys(s)) {
      if (!ALLOWED_SLOT_KEYS.has(k)) {
        throw new Error(`Khóa không hỗ trợ trong slot thứ ${i + 1}: "${k}".`);
      }
    }

    const slotId = validateIdString(s.id, `slot id "${String(s.id)}"`);
    if (!isValidSlotId(slotId)) {
      throw new Error(`slotId không hợp lệ: "${slotId}".`);
    }
    if (seenSlotIds.has(slotId)) {
      throw new Error(`Trùng lặp slotId: "${slotId}".`);
    }
    seenSlotIds.add(slotId);

    const duration = s.duration;
    if (!Number.isInteger(duration) || (duration as number) < MIN_SLOT_DURATION || (duration as number) > MAX_SLOT_DURATION) {
      throw new Error(`duration của slot "${slotId}" phải là số nguyên từ ${MIN_SLOT_DURATION} đến ${MAX_SLOT_DURATION} ms.`);
    }

    if (typeof s.selected !== 'boolean') {
      throw new Error(`selected của slot "${slotId}" phải là boolean.`);
    }
    if (typeof s.frozen !== 'boolean') {
      throw new Error(`frozen của slot "${slotId}" phải là boolean.`);
    }
    if (typeof s.keyframe !== 'boolean') {
      throw new Error(`keyframe của slot "${slotId}" phải là boolean.`);
    }

    // Mutually exclusive: cannot be both frozen and selected
    if (s.frozen && s.selected) {
      throw new Error(`Slot "${slotId}" không thể vừa bị khóa (frozen) vừa được chọn (selected).`);
    }

    if (s.selected && !s.frozen) {
      selectedUnlockedCount++;
    }

    const pose: Record<string, { x: number; y: number }> = {};
    if (s.pose !== undefined) {
      if (!isPlainObject(s.pose)) {
        throw new Error(`pose của slot "${slotId}" phải là object.`);
      }
      for (const [key, pt] of Object.entries(s.pose)) {
        if (!landmarks[key]) {
          throw new Error(`Pose key "${key}" trong slot "${slotId}" không thuộc danh sách landmark đã duyệt.`);
        }
        if (!isPlainObject(pt)) {
          throw new Error(`Điểm pose "${key}" trong slot "${slotId}" không hợp lệ.`);
        }
        for (const k of Object.keys(pt)) {
          if (k !== 'x' && k !== 'y') {
            throw new Error(`Điểm pose "${key}" trong slot "${slotId}" chỉ hỗ trợ trường x và y.`);
          }
        }
        const px = pt.x;
        const py = pt.y;
        if (!Number.isInteger(px) || !Number.isInteger(py) || (px as number) < 0 || (px as number) >= width || (py as number) < 0 || (py as number) >= height) {
          throw new Error(`Tọa độ pose "${key}" trong slot "${slotId}" (${String(px)}, ${String(py)}) phải là số nguyên trong canvas [0..${width - 1}, 0..${height - 1}].`);
        }
        pose[key] = { x: px as number, y: py as number };
      }
    }

    slots.push({
      id: slotId,
      duration: duration as number,
      selected: s.selected,
      frozen: s.frozen,
      keyframe: s.keyframe,
      pose,
    });
  }

  if (selectedUnlockedCount < 1) {
    throw new Error('Cần chọn ít nhất một slot chưa bị khóa để tạo ảnh.');
  }

  // Source metadata validation (optional, bounded, no raw RGBA / code / paths)
  let sourceMetadata: ClipGenerationMetadata | undefined;
  if (input.sourceMetadata !== undefined) {
    if (!isPlainObject(input.sourceMetadata)) {
      throw new Error('sourceMetadata phải là một object.');
    }
    for (const k of Object.keys(input.sourceMetadata)) {
      if (!ALLOWED_METADATA_KEYS.has(k)) {
        throw new Error(`Khóa không hỗ trợ trong sourceMetadata: "${k}".`);
      }
    }
    sourceMetadata = {};
    if (input.sourceMetadata.pivot !== undefined) {
      if (!isPlainObject(input.sourceMetadata.pivot) || ![input.sourceMetadata.pivot.x, input.sourceMetadata.pivot.y].every(n => Number.isFinite(n) && (n as number) >= 0 && (n as number) <= 1)) {
        throw new Error('sourceMetadata.pivot x/y cần nằm trong khoảng 0–1.');
      }
      sourceMetadata.pivot = { x: input.sourceMetadata.pivot.x as number, y: input.sourceMetadata.pivot.y as number };
    }
    if (input.sourceMetadata.hitbox !== undefined) {
      const hb = input.sourceMetadata.hitbox;
      if (!isPlainObject(hb) || ![hb.x, hb.y, hb.w, hb.h].every(Number.isFinite) || (hb.w as number) <= 0 || (hb.h as number) <= 0) {
        throw new Error('sourceMetadata.hitbox cần x/y/w/h hữu hạn và w/h > 0.');
      }
      sourceMetadata.hitbox = { x: hb.x as number, y: hb.y as number, w: hb.w as number, h: hb.h as number };
    }
    if (input.sourceMetadata.events !== undefined) {
      if (!Array.isArray(input.sourceMetadata.events) || input.sourceMetadata.events.length > 600) {
        throw new Error('sourceMetadata.events phải là mảng tối đa 600 phần tử.');
      }
      sourceMetadata.events = input.sourceMetadata.events.map((e, idx) => {
        if (!isPlainObject(e) || !Number.isInteger(e.frame) || (e.frame as number) < 0 || (e.frame as number) >= slotCount || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 128) {
          throw new Error(`sourceMetadata.events[${idx}] cần frame hợp lệ trong [0..${slotCount - 1}] và tên không rỗng.`);
        }
        checkNoResourceOrPathLeaks(e.name, `events[${idx}] name`);
        return { frame: e.frame as number, name: e.name.trim() };
      });
    }
  }

  return {
    version: CLIP_GENERATION_CONTEXT_VERSION,
    projectId,
    revision: revision as number,
    clipId,
    characterId,
    name,
    sourceAssetId,
    sourceFrameId,
    w: width,
    h: height,
    paletteMode,
    palette,
    pivot,
    mode,
    loop,
    landmarks,
    links,
    parts,
    ...(sourceMetadata ? { sourceMetadata } : {}),
    slots,
  };
}

export function createClipGenerationContext(input: CreateClipGenerationContextInput): ClipGenerationContext {
  const rawContext = {
    version: CLIP_GENERATION_CONTEXT_VERSION,
    projectId: input.projectId,
    revision: input.revision,
    clipId: input.clipId,
    characterId: input.characterId,
    name: input.name,
    sourceAssetId: input.sourceAssetId,
    sourceFrameId: input.sourceFrameId,
    w: input.w,
    h: input.h,
    paletteMode: input.paletteMode ?? 'asset',
    palette: input.palette,
    pivot: input.pivot,
    mode: input.mode,
    loop: input.loop,
    landmarks: input.landmarks ?? {},
    links: input.links ?? [],
    parts: input.parts ?? {},
    ...(input.sourceMetadata ? { sourceMetadata: input.sourceMetadata } : {}),
    slots: input.slots.map(s => ({
      id: s.id,
      duration: s.duration,
      selected: s.selected,
      frozen: s.frozen,
      keyframe: s.keyframe,
      pose: s.pose ?? {},
    })),
  };
  return validateClipGenerationContext(rawContext);
}

export function getSelectedSlots(context: ClipGenerationContext): ClipGenerationSlot[] {
  return context.slots.filter(s => s.selected && !s.frozen);
}

export function getSelectedSlotIds(context: ClipGenerationContext): string[] {
  return getSelectedSlots(context).map(s => s.id);
}
