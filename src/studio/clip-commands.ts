import { validateDocument, type PixelDocument } from './pixel/model.ts';
import {
  type ActionTemplate,
  ACTION_TEMPLATES,
  checkCharacterReadiness,
  resolvePixelPivot,
  validateCharacterId,
  validateName,
} from './characters.ts';
import {
  type CharacterClip,
  type ClipFacing,
  type ClipMode,
  type ClipPosePoint,
  type ClipSlot,
  CLIP_FACINGS,
  CLIP_MODES,
  MAX_CLIPS,
  MAX_CLIP_SLOTS,
  MIN_CLIP_SLOTS,
  MIN_SLOT_DURATION,
  MAX_SLOT_DURATION,
  validateClipId,
  validateSlotId,
  validatePosePoint,
  validateMovementMaskBuffer,
} from './clips.ts';
import { validateResourceId } from './resources.ts';
import { captureVisibleComposite } from './character-commands.ts';

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function ensureClipExtension(doc: PixelDocument): void {
  if (!doc.studio) {
    doc.studio = { version: 1, resources: {}, characters: {}, clips: {} };
  } else {
    if (![1, 2].includes(doc.studio.version)) {
      throw new Error(`Phiên bản extension studio không hợp lệ: ${String(doc.studio.version)}`);
    }
    if (!doc.studio.resources) {
      doc.studio.resources = {};
    }
    if (!doc.studio.characters) {
      doc.studio.characters = {};
    }
    if (!doc.studio.clips) {
      doc.studio.clips = {};
    }
  }
}

function allocateDedicatedClipResourceId(
  doc: PixelDocument,
  clipId: string,
  kind: 'rgba' | 'mask',
  tag: string
): string {
  ensureClipExtension(doc);
  const cleanClipId = clipId.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '_');
  let id = '';
  do {
    const suffix = uuid().replace(/-/g, '').slice(0, 16);
    id = `clp_${cleanClipId}_${tag}_${suffix}`;
  } while (Object.hasOwn(doc.studio!.resources!, id));
  return id;
}

function isDedicatedClipResource(clipId: string, resourceId: string): boolean {
  const cleanClipId = clipId.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '_');
  return resourceId.startsWith(`clp_${cleanClipId}_`);
}

function countAllResourceReferences(doc: PixelDocument, resourceId: string): number {
  let count = 0;
  if (doc.studio?.characters) {
    for (const p of Object.values(doc.studio.characters)) {
      if (p.source.rgbaResourceId === resourceId) count++;
      for (const part of Object.values(p.parts)) {
        if (part.maskResourceId === resourceId) count++;
      }
    }
  }
  if (doc.studio?.clips) {
    for (const clip of Object.values(doc.studio.clips)) {
      if (clip.movementMaskResourceId === resourceId) count++;
      for (const slot of clip.slots) {
        if (slot.rgbaResourceId === resourceId) count++;
      }
    }
  }
  return count;
}

function pruneDedicatedClipResource(doc: PixelDocument, clipId: string, resourceId: string): void {
  if (!doc.studio?.resources) return;
  if (!isDedicatedClipResource(clipId, resourceId)) return;
  if (countAllResourceReferences(doc, resourceId) > 0) return;
  delete doc.studio.resources[resourceId];
}

function getClipOrThrow(doc: PixelDocument, clipId: string): CharacterClip {
  ensureClipExtension(doc);
  validateClipId(clipId, 'ID clip');
  if (!doc.studio?.clips || !Object.hasOwn(doc.studio.clips, clipId)) {
    throw new Error(`Không tìm thấy clip "${clipId}".`);
  }
  return doc.studio.clips[clipId];
}

function getSlotOrThrow(clip: CharacterClip, slotId: string): { slot: ClipSlot; index: number } {
  const index = clip.slots.findIndex(s => s.id === slotId);
  if (index === -1) {
    throw new Error(`Không tìm thấy slot "${slotId}" trong clip "${clip.id}".`);
  }
  return { slot: clip.slots[index], index };
}

export interface CreateClipOptions {
  id?: string;
  name: string;
  characterId: string;
  template?: ActionTemplate;
  slotCount?: number;
  slotDuration?: number;
  loop?: boolean;
  facing?: ClipFacing;
  mode?: ClipMode;
  movementMaskResourceId?: string;
  movementMaskSelection?: Uint32Array;
}

export function createClip(doc: PixelDocument, options: CreateClipOptions): CharacterClip {
  ensureClipExtension(doc);
  const existingCount = Object.keys(doc.studio!.clips!).length;
  if (existingCount >= MAX_CLIPS) {
    throw new Error(`Số lượng clip vượt quá giới hạn tối đa ${MAX_CLIPS}.`);
  }

  if (options.mode === undefined) {
    throw new Error('Chế độ clip (mode) phải được chỉ định rõ ràng (\'region\' hoặc \'whole\').');
  }
  const mode = options.mode;
  if (!CLIP_MODES.includes(mode)) {
    throw new Error(`Chế độ không hợp lệ: "${String(mode)}". Hỗ trợ: ${CLIP_MODES.join(', ')}.`);
  }

  const characterId = validateCharacterId(options.characterId, 'ID nhân vật');
  const character = doc.studio!.characters?.[characterId];
  if (!character) {
    throw new Error(`Nhân vật '${characterId}' không tồn tại trong tài liệu.`);
  }
  if (!character.approved) {
    throw new Error(`Không thể tạo clip từ nhân vật chưa được phê duyệt '${characterId}'.`);
  }

  const masterRes = doc.studio!.resources?.[character.source.rgbaResourceId];
  if (!masterRes || !masterRes.data) {
    throw new Error(`Dữ liệu tài nguyên RGBA nguồn '${character.source.rgbaResourceId}' chưa được nạp (missing-master).`);
  }

  const asset = doc.assets.find(a => a.id === character.source.assetId);
  if (!asset) {
    throw new Error(`Asset nguồn '${character.source.assetId}' không tồn tại.`);
  }
  const frame = asset.frames.find(f => f.id === character.source.frameId);
  if (!frame) {
    throw new Error(`Frame nguồn '${character.source.frameId}' không tồn tại.`);
  }

  const currentComposite = captureVisibleComposite(asset, character.source.frameId);
  const currentPivot = resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h);
  const readiness = checkCharacterReadiness({
    profile: character,
    sourceResourceData: masterRes.data,
    currentComposite,
    currentWidth: asset.w,
    currentHeight: asset.h,
    currentPalette: asset.palette,
    currentPivot,
  });
  if (readiness.status !== 'ready') {
    throw new Error(
      `Nguồn nhân vật chưa sẵn sàng để tạo clip (${readiness.status}): ${readiness.reason ?? 'nguồn bị thay đổi hoặc thiếu dữ liệu'}`
    );
  }

  const id = options.id
    ? validateClipId(options.id, 'ID clip')
    : `clp_${uuid().replace(/-/g, '').slice(0, 16)}`;

  if (Object.hasOwn(doc.studio!.clips!, id)) {
    throw new Error(`Clip với ID "${id}" đã tồn tại.`);
  }

  const name = validateName(options.name, 'Tên clip');
  const template = options.template ?? 'idle';
  if (!ACTION_TEMPLATES.includes(template)) {
    throw new Error(`Template không hợp lệ: "${String(template)}". Hỗ trợ: ${ACTION_TEMPLATES.join(', ')}.`);
  }

  const slotCount = options.slotCount ?? 4;
  if (!Number.isInteger(slotCount) || slotCount < MIN_CLIP_SLOTS || slotCount > MAX_CLIP_SLOTS) {
    throw new Error(`Số lượng slot ban đầu phải là số nguyên từ ${MIN_CLIP_SLOTS} đến ${MAX_CLIP_SLOTS}.`);
  }

  const slotDuration = options.slotDuration ?? 100;
  if (!Number.isInteger(slotDuration) || slotDuration < MIN_SLOT_DURATION || slotDuration > MAX_SLOT_DURATION) {
    throw new Error(`Thời lượng slot phải là số nguyên từ ${MIN_SLOT_DURATION} đến ${MAX_SLOT_DURATION} ms.`);
  }

  const loop = options.loop ?? true;
  if (typeof loop !== 'boolean') {
    throw new Error('Thuộc tính loop phải là boolean.');
  }

  const facing = options.facing ?? 'source';
  if (!CLIP_FACINGS.includes(facing)) {
    throw new Error(`Hướng quay không hợp lệ: "${String(facing)}". Hỗ trợ: ${CLIP_FACINGS.join(', ')}.`);
  }

  let movementMaskResourceId: string | undefined;
  if (mode === 'region') {
    if (options.movementMaskSelection !== undefined) {
      const sel = options.movementMaskSelection;
      validateMovementMaskBuffer(sel, character.source.w, character.source.h, 'Mặt nạ di chuyển');
      const resId = allocateDedicatedClipResourceId(doc, id, 'mask', 'move');
      doc.studio!.resources![resId] = {
        version: 1,
        kind: 'mask',
        w: character.source.w,
        h: character.source.h,
        data: new Uint32Array(sel),
      };
      movementMaskResourceId = resId;
    } else if (options.movementMaskResourceId !== undefined) {
      const resId = validateResourceId(options.movementMaskResourceId);
      const res = doc.studio!.resources?.[resId];
      if (!res) {
        throw new Error(`Tài nguyên mặt nạ di chuyển '${resId}' không tồn tại.`);
      }
      if (res.kind !== 'mask') {
        throw new Error(`Tài nguyên mặt nạ di chuyển '${resId}' phải có loại 'mask', phát hiện: '${res.kind}'.`);
      }
      if (res.w !== character.source.w || res.h !== character.source.h) {
        throw new Error(
          `Kích thước mặt nạ di chuyển (${res.w}x${res.h}) không khớp kích thước nguồn nhân vật (${character.source.w}x${character.source.h}).`
        );
      }
      if (!res.data) {
        throw new Error(`Dữ liệu tài nguyên mặt nạ di chuyển '${resId}' chưa được nạp (unloaded).`);
      }
      validateMovementMaskBuffer(res.data, character.source.w, character.source.h, `Mặt nạ di chuyển '${resId}'`);
      movementMaskResourceId = resId;
    } else {
      throw new Error(`Clip ở chế độ vùng ('region') cần có mặt nạ di chuyển hợp lệ.`);
    }
  } else {
    if (options.movementMaskResourceId !== undefined || options.movementMaskSelection !== undefined) {
      throw new Error(`Clip ở chế độ toàn phần ('whole') không được chứa mặt nạ di chuyển.`);
    }
  }

  const masterResId = character.source.rgbaResourceId;
  const defaultPose: Record<string, ClipPosePoint> = {};
  for (const [lmId, lm] of Object.entries(character.landmarks)) {
    defaultPose[lmId] = { x: lm.x, y: lm.y };
  }

  const slots: ClipSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    const slotId = `slt_${uuid().replace(/-/g, '').slice(0, 12)}`;
    slots.push({
      id: slotId,
      duration: slotDuration,
      selected: true,
      frozen: false,
      keyframe: false,
      rgbaResourceId: masterResId,
      pose: structuredClone(defaultPose),
    });
  }

  const clip: CharacterClip = {
    version: 1,
    id,
    name,
    characterId,
    template,
    loop,
    facing,
    mode,
    ...(movementMaskResourceId ? { movementMaskResourceId } : {}),
    slots,
  };

  doc.studio!.clips![id] = clip;
  validateDocument(doc);
  return clip;
}

export function renameClip(doc: PixelDocument, clipId: string, name: string): CharacterClip {
  const clip = getClipOrThrow(doc, clipId);
  clip.name = validateName(name, 'Tên clip');
  validateDocument(doc);
  return clip;
}

export function removeClip(doc: PixelDocument, clipId: string): void {
  const clip = getClipOrThrow(doc, clipId);
  const resourcesToCheck = new Set<string>();
  if (clip.movementMaskResourceId) resourcesToCheck.add(clip.movementMaskResourceId);
  for (const s of clip.slots) resourcesToCheck.add(s.rgbaResourceId);

  delete doc.studio!.clips![clipId];

  for (const resId of resourcesToCheck) {
    pruneDedicatedClipResource(doc, clipId, resId);
  }
  validateDocument(doc);
}

export interface UpdateClipMetadataOptions {
  loop?: boolean;
  facing?: ClipFacing;
}

export function updateClipMetadata(
  doc: PixelDocument,
  clipId: string,
  updates: UpdateClipMetadataOptions
): CharacterClip {
  const clip = getClipOrThrow(doc, clipId);
  if (updates.loop !== undefined) {
    if (typeof updates.loop !== 'boolean') {
      throw new Error('Thuộc tính loop phải là boolean.');
    }
    clip.loop = updates.loop;
  }
  if (updates.facing !== undefined) {
    if (!CLIP_FACINGS.includes(updates.facing)) {
      throw new Error(`Hướng quay không hợp lệ: "${String(updates.facing)}". Hỗ trợ: ${CLIP_FACINGS.join(', ')}.`);
    }
    clip.facing = updates.facing;
  }
  validateDocument(doc);
  return clip;
}

export interface SetClipMovementMaskOptions {
  resourceId?: string;
  selection?: Uint32Array;
}

export function setClipMovementMask(
  doc: PixelDocument,
  clipId: string,
  options: SetClipMovementMaskOptions
): CharacterClip {
  const clip = getClipOrThrow(doc, clipId);
  if (clip.mode !== 'region') {
    throw new Error(`Không thể đặt mặt nạ di chuyển cho clip ở chế độ '${clip.mode}'.`);
  }
  const character = doc.studio!.characters?.[clip.characterId];
  if (!character) {
    throw new Error(`Nhân vật '${clip.characterId}' không tồn tại.`);
  }

  const oldResId = clip.movementMaskResourceId;
  let newResId: string;

  if (options.selection !== undefined) {
    const sel = options.selection;
    validateMovementMaskBuffer(sel, character.source.w, character.source.h, 'Mặt nạ di chuyển');

    newResId = allocateDedicatedClipResourceId(doc, clipId, 'mask', 'move');
    doc.studio!.resources![newResId] = {
      version: 1,
      kind: 'mask',
      w: character.source.w,
      h: character.source.h,
      data: new Uint32Array(sel),
    };
  } else if (options.resourceId !== undefined) {
    newResId = validateResourceId(options.resourceId);
    const res = doc.studio!.resources?.[newResId];
    if (!res) {
      throw new Error(`Tài nguyên mặt nạ di chuyển '${newResId}' không tồn tại.`);
    }
    if (res.kind !== 'mask') {
      throw new Error(`Tài nguyên mặt nạ di chuyển '${newResId}' phải có loại 'mask', phát hiện: '${res.kind}'.`);
    }
    if (res.w !== character.source.w || res.h !== character.source.h) {
      throw new Error(
        `Kích thước mặt nạ di chuyển (${res.w}x${res.h}) không khớp kích thước nguồn nhân vật (${character.source.w}x${character.source.h}).`
      );
    }
    if (!res.data) {
      throw new Error(`Dữ liệu tài nguyên mặt nạ di chuyển '${newResId}' chưa được nạp (unloaded).`);
    }
    validateMovementMaskBuffer(res.data, character.source.w, character.source.h, `Mặt nạ di chuyển '${newResId}'`);
  } else {
    throw new Error('Cần cung cấp resourceId hoặc selection để cập nhật mặt nạ di chuyển.');
  }

  clip.movementMaskResourceId = newResId;
  if (oldResId && oldResId !== newResId) {
    pruneDedicatedClipResource(doc, clipId, oldResId);
  }
  validateDocument(doc);
  return clip;
}

export interface AddClipSlotOptions {
  slotId?: string;
  index?: number;
  duration?: number;
  rgbaResourceId?: string;
  pose?: Record<string, { x: number; y: number }>;
}

export function addClipSlot(
  doc: PixelDocument,
  clipId: string,
  options?: AddClipSlotOptions
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  if (clip.slots.length >= MAX_CLIP_SLOTS) {
    throw new Error(`Số lượng slot vượt quá giới hạn tối đa ${MAX_CLIP_SLOTS}.`);
  }

  const character = doc.studio!.characters?.[clip.characterId];
  if (!character) {
    throw new Error(`Nhân vật '${clip.characterId}' không tồn tại.`);
  }

  const slotId = options?.slotId
    ? validateSlotId(options.slotId, 'ID slot')
    : `slt_${uuid().replace(/-/g, '').slice(0, 12)}`;

  if (clip.slots.some(s => s.id === slotId)) {
    throw new Error(`Slot với ID "${slotId}" đã tồn tại trong clip "${clipId}".`);
  }

  const duration = options?.duration ?? 100;
  if (!Number.isInteger(duration) || duration < MIN_SLOT_DURATION || duration > MAX_SLOT_DURATION) {
    throw new Error(`Thời lượng slot phải là số nguyên từ ${MIN_SLOT_DURATION} đến ${MAX_SLOT_DURATION} ms.`);
  }

  const rgbaResourceId = options?.rgbaResourceId ?? character.source.rgbaResourceId;
  validateResourceId(rgbaResourceId);

  if (doc.studio?.resources) {
    const res = doc.studio.resources[rgbaResourceId];
    if (!res) {
      throw new Error(`Tài nguyên RGBA '${rgbaResourceId}' không tồn tại trong tài liệu.`);
    }
    if (res.kind !== 'rgba') {
      throw new Error(`Tài nguyên RGBA '${rgbaResourceId}' phải có loại 'rgba', phát hiện: '${res.kind}'.`);
    }
    if (res.w !== character.source.w || res.h !== character.source.h) {
      throw new Error(
        `Kích thước tài nguyên RGBA '${rgbaResourceId}' (${res.w}x${res.h}) không khớp kích thước nguồn nhân vật (${character.source.w}x${character.source.h}).`
      );
    }
  }

  const defaultPose: Record<string, ClipPosePoint> = {};
  for (const [lmId, lm] of Object.entries(character.landmarks)) {
    defaultPose[lmId] = { x: lm.x, y: lm.y };
  }

  const pose: Record<string, ClipPosePoint> = {};
  if (options?.pose) {
    for (const [lmId, pt] of Object.entries(options.pose)) {
      pose[lmId] = validatePosePoint(pt, lmId, slotId, character);
    }
  } else {
    Object.assign(pose, structuredClone(defaultPose));
  }

  const newSlot: ClipSlot = {
    id: slotId,
    duration,
    selected: true,
    frozen: false,
    keyframe: false,
    rgbaResourceId,
    pose,
  };

  const insertIndex = options?.index !== undefined ? options.index : clip.slots.length;
  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > clip.slots.length) {
    throw new Error(`Vị trí chèn slot không hợp lệ: ${insertIndex}.`);
  }

  clip.slots.splice(insertIndex, 0, newSlot);
  validateDocument(doc);
  return newSlot;
}

export function duplicateClipSlot(
  doc: PixelDocument,
  clipId: string,
  slotId: string
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  if (clip.slots.length >= MAX_CLIP_SLOTS) {
    throw new Error(`Số lượng slot vượt quá giới hạn tối đa ${MAX_CLIP_SLOTS}.`);
  }

  const { slot: sourceSlot, index } = getSlotOrThrow(clip, slotId);
  const newId = `slt_${uuid().replace(/-/g, '').slice(0, 12)}`;

  const newSlot: ClipSlot = {
    id: newId,
    duration: sourceSlot.duration,
    selected: sourceSlot.selected,
    frozen: sourceSlot.frozen,
    keyframe: sourceSlot.keyframe,
    rgbaResourceId: sourceSlot.rgbaResourceId,
    pose: structuredClone(sourceSlot.pose),
  };

  clip.slots.splice(index + 1, 0, newSlot);
  validateDocument(doc);
  return newSlot;
}

export function removeClipSlot(
  doc: PixelDocument,
  clipId: string,
  slotId: string
): void {
  const clip = getClipOrThrow(doc, clipId);
  if (clip.slots.length <= MIN_CLIP_SLOTS) {
    throw new Error(`Clip phải có ít nhất ${MIN_CLIP_SLOTS} slot.`);
  }

  const { slot, index } = getSlotOrThrow(clip, slotId);
  const oldResId = slot.rgbaResourceId;

  clip.slots.splice(index, 1);
  pruneDedicatedClipResource(doc, clipId, oldResId);
  validateDocument(doc);
}

export function reorderClipSlots(
  doc: PixelDocument,
  clipId: string,
  slotIds: string[]
): CharacterClip {
  const clip = getClipOrThrow(doc, clipId);
  if (!Array.isArray(slotIds) || slotIds.length !== clip.slots.length) {
    throw new Error(`Danh sách ID slot để sắp xếp lại phải có đúng ${clip.slots.length} phần tử.`);
  }

  const currentMap = new Map(clip.slots.map(s => [s.id, s]));
  const seen = new Set<string>();
  const reordered: ClipSlot[] = [];

  for (const id of slotIds) {
    if (seen.has(id)) {
      throw new Error(`ID slot bị trùng lặp trong thứ tự sắp xếp: "${id}".`);
    }
    seen.add(id);
    const slot = currentMap.get(id);
    if (!slot) {
      throw new Error(`Slot "${id}" không tồn tại trong clip "${clipId}".`);
    }
    reordered.push(slot);
  }

  clip.slots = reordered;
  validateDocument(doc);
  return clip;
}

export function setSlotDuration(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  duration: number
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  if (!Number.isInteger(duration) || duration < MIN_SLOT_DURATION || duration > MAX_SLOT_DURATION) {
    throw new Error(`Thời lượng slot phải là số nguyên từ ${MIN_SLOT_DURATION} đến ${MAX_SLOT_DURATION} ms.`);
  }
  const { slot } = getSlotOrThrow(clip, slotId);
  slot.duration = duration;
  validateDocument(doc);
  return slot;
}

export function setClipDurations(
  doc: PixelDocument,
  clipId: string,
  duration: number,
  slotIds?: string[]
): CharacterClip {
  const clip = getClipOrThrow(doc, clipId);
  if (!Number.isInteger(duration) || duration < MIN_SLOT_DURATION || duration > MAX_SLOT_DURATION) {
    throw new Error(`Thời lượng slot phải là số nguyên từ ${MIN_SLOT_DURATION} đến ${MAX_SLOT_DURATION} ms.`);
  }

  if (slotIds !== undefined) {
    if (!Array.isArray(slotIds)) {
      throw new Error('Danh sách ID slot phải là mảng.');
    }
    for (const id of slotIds) {
      if (!clip.slots.some(s => s.id === id)) {
        throw new Error(`Không tìm thấy slot "${id}" trong clip "${clipId}".`);
      }
    }
  }

  const targetSet = slotIds ? new Set(slotIds) : null;
  for (const slot of clip.slots) {
    if (!targetSet || targetSet.has(slot.id)) {
      slot.duration = duration;
    }
  }

  validateDocument(doc);
  return clip;
}

export function setSlotSelection(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  selected: boolean
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  if (typeof selected !== 'boolean') {
    throw new Error(`Trạng thái 'selected' phải là boolean.`);
  }
  const { slot } = getSlotOrThrow(clip, slotId);
  if (selected && slot.frozen) {
    throw new Error(`Slot "${slotId}" đang bị đóng băng (frozen) không thể được chọn. Cần mở khóa trước.`);
  }
  slot.selected = selected;
  validateDocument(doc);
  return slot;
}

export function setSlotFrozen(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  frozen: boolean
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  if (typeof frozen !== 'boolean') {
    throw new Error(`Trạng thái 'frozen' phải là boolean.`);
  }
  const { slot } = getSlotOrThrow(clip, slotId);
  slot.frozen = frozen;
  if (frozen) {
    slot.selected = false;
  }
  validateDocument(doc);
  return slot;
}

export function setSlotKeyframe(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  keyframe: boolean
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  if (typeof keyframe !== 'boolean') {
    throw new Error(`Trạng thái 'keyframe' phải là boolean.`);
  }
  const { slot } = getSlotOrThrow(clip, slotId);
  slot.keyframe = keyframe;
  validateDocument(doc);
  return slot;
}

export function updateSlotPose(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  posePatch: Record<string, { x: number; y: number }>
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  const character = doc.studio!.characters?.[clip.characterId];
  if (!character) {
    throw new Error(`Nhân vật '${clip.characterId}' không tồn tại.`);
  }

  const { slot } = getSlotOrThrow(clip, slotId);

  const validatedPatch: Record<string, ClipPosePoint> = {};
  for (const [lmId, pt] of Object.entries(posePatch)) {
    if (!Object.hasOwn(character.landmarks, lmId)) {
      throw new Error(`Điểm mốc '${lmId}' không tồn tại trong danh sách điểm mốc của nhân vật '${character.id}'.`);
    }
    validatedPatch[lmId] = validatePosePoint(pt, lmId, slotId, character);
  }

  Object.assign(slot.pose, validatedPatch);
  validateDocument(doc);
  return slot;
}

export function resetSlotPose(
  doc: PixelDocument,
  clipId: string,
  slotId: string
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  const character = doc.studio!.characters?.[clip.characterId];
  if (!character) {
    throw new Error(`Nhân vật '${clip.characterId}' không tồn tại.`);
  }

  const { slot } = getSlotOrThrow(clip, slotId);
  slot.pose = {};
  for (const [lmId, lm] of Object.entries(character.landmarks)) {
    slot.pose[lmId] = { x: lm.x, y: lm.y };
  }

  validateDocument(doc);
  return slot;
}

export function captureNativeFrameToSlot(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  assetId: string,
  frameId: string
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  const character = doc.studio!.characters?.[clip.characterId];
  if (!character) {
    throw new Error(`Nhân vật '${clip.characterId}' không tồn tại.`);
  }

  const { slot } = getSlotOrThrow(clip, slotId);
  if (slot.frozen) {
    throw new Error(`Slot "${slotId}" đang bị đóng băng (frozen). Cần mở khóa trước khi chụp frame.`);
  }
  const asset = doc.assets.find(a => a.id === assetId);
  if (!asset) {
    throw new Error(`Asset '${assetId}' không tồn tại trong tài liệu.`);
  }
  const frame = asset.frames.find(f => f.id === frameId);
  if (!frame) {
    throw new Error(`Frame '${frameId}' không tồn tại trong asset '${assetId}'.`);
  }
  if (asset.w !== character.source.w || asset.h !== character.source.h) {
    throw new Error(
      `Kích thước asset (${asset.w}x${asset.h}) không khớp kích thước nguồn nhân vật (${character.source.w}x${character.source.h}).`
    );
  }

  const capturedPixels = captureVisibleComposite(asset, frameId);
  const oldResId = slot.rgbaResourceId;
  const newResId = allocateDedicatedClipResourceId(doc, clipId, 'rgba', 'cap');

  doc.studio!.resources![newResId] = {
    version: 1,
    kind: 'rgba',
    w: asset.w,
    h: asset.h,
    data: capturedPixels,
  };

  slot.rgbaResourceId = newResId;
  slot.keyframe = true;

  pruneDedicatedClipResource(doc, clipId, oldResId);
  validateDocument(doc);
  return slot;
}

export function applySlotBaseline(
  doc: PixelDocument,
  clipId: string,
  slotId: string,
  rgbaPixels: Uint32Array
): ClipSlot {
  const clip = getClipOrThrow(doc, clipId);
  const character = doc.studio!.characters?.[clip.characterId];
  if (!character) {
    throw new Error(`Nhân vật '${clip.characterId}' không tồn tại.`);
  }

  const { slot } = getSlotOrThrow(clip, slotId);
  if (slot.frozen) {
    throw new Error(`Slot "${slotId}" đang bị đóng băng (frozen). Cần mở khóa trước khi áp dụng baseline.`);
  }
  if (!(rgbaPixels instanceof Uint32Array)) {
    throw new Error('Dữ liệu điểm ảnh phải là Uint32Array.');
  }
  const expectedLen = character.source.w * character.source.h;
  if (rgbaPixels.length !== expectedLen) {
    throw new Error(
      `Kích thước bộ đệm điểm ảnh (${rgbaPixels.length}) không khớp kích thước nguồn (${expectedLen}).`
    );
  }

  const oldResId = slot.rgbaResourceId;
  const newResId = allocateDedicatedClipResourceId(doc, clipId, 'rgba', 'base');

  doc.studio!.resources![newResId] = {
    version: 1,
    kind: 'rgba',
    w: character.source.w,
    h: character.source.h,
    data: new Uint32Array(rgbaPixels),
  };

  slot.rgbaResourceId = newResId;

  pruneDedicatedClipResource(doc, clipId, oldResId);
  validateDocument(doc);
  return slot;
}
