import {
  composite,
  validateDocument,
  type PixelDocument,
  type PixelAsset,
  type PixelLayer,
} from './pixel/model.ts';
import {
  type ActionTemplate,
  type CharacterAction,
  type CharacterLandmark,
  type CharacterLink,
  type CharacterPart,
  type CharacterPivot,
  type CharacterProfile,
  ACTION_TEMPLATES,
  MAX_CHARACTER_ACTIONS,
  MAX_CHARACTER_LANDMARKS,
  MAX_CHARACTER_LINKS,
  MAX_CHARACTER_PARTS,
  MAX_CHARACTER_PROFILES,
  validateCharacterId,
  validateName,
  validatePivot,
  resolvePixelPivot,
} from './characters.ts';

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function ensureCharacterExtension(doc: PixelDocument): void {
  if (!doc.studio) {
    doc.studio = { version: 1, resources: {}, characters: {} };
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
  }
}

function allocateDedicatedResourceId(
  doc: PixelDocument,
  profileId: string,
  kind: 'rgba' | 'mask',
  tag: string
): string {
  ensureCharacterExtension(doc);
  const cleanProfileId = profileId.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '_');
  let id = '';
  do {
    const suffix = uuid().replace(/-/g, '').slice(0, 16);
    id = `chr_${cleanProfileId}_${tag}_${suffix}`;
  } while (Object.hasOwn(doc.studio!.resources!, id));
  return id;
}

function isDedicatedProfileResource(profileId: string, resourceId: string): boolean {
  const cleanProfileId = profileId.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '_');
  return resourceId.startsWith(`chr_${cleanProfileId}_`);
}

function countCharacterResourceReferences(doc: PixelDocument, resourceId: string): number {
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

function pruneDedicatedResource(doc: PixelDocument, profileId: string, resourceId: string): void {
  if (!doc.studio?.resources) return;
  if (!isDedicatedProfileResource(profileId, resourceId)) return;
  if (countCharacterResourceReferences(doc, resourceId) > 0) return;
  delete doc.studio.resources[resourceId];
}

function isLayerEffectivelyVisible(asset: PixelAsset, layer: PixelLayer): boolean {
  let cur: PixelLayer | undefined = layer;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent ? asset.layers.find(l => l.id === cur!.parent) : undefined;
  }
  return true;
}

export function captureVisibleComposite(asset: PixelAsset, frameId: string): Uint32Array {
  for (const layer of asset.layers) {
    if (!isLayerEffectivelyVisible(asset, layer)) continue;
    if (layer.type !== 'image') continue;
    const celId = layer.cels[frameId];
    if (celId) {
      const cel = asset.cels[celId];
      if (!cel || !cel.data) {
        throw new Error(`Cel '${celId}' của layer '${layer.name ?? layer.id}' chưa nạp dữ liệu.`);
      }
    }
  }
  const img = composite(asset, frameId);
  return new Uint32Array(img.data);
}

function getCharacterProfileOrThrow(doc: PixelDocument, profileId: string): CharacterProfile {
  ensureCharacterExtension(doc);
  validateCharacterId(profileId, 'ID nhân vật');
  if (!Object.hasOwn(doc.studio!.characters!, profileId)) {
    throw new Error(`Không tìm thấy hồ sơ nhân vật "${profileId}".`);
  }
  return doc.studio!.characters![profileId];
}

export interface CreateCharacterProfileOptions {
  id?: string;
  name: string;
  assetId: string;
  frameId: string;
  pivot?: CharacterPivot | [number, number];
  palette?: number[];
}

export function createCharacterProfile(
  doc: PixelDocument,
  options: CreateCharacterProfileOptions
): CharacterProfile {
  ensureCharacterExtension(doc);
  const existingCount = Object.keys(doc.studio!.characters!).length;
  if (existingCount >= MAX_CHARACTER_PROFILES) {
    throw new Error(`Số lượng nhân vật vượt quá giới hạn tối đa ${MAX_CHARACTER_PROFILES}.`);
  }

  const id = options.id
    ? validateCharacterId(options.id, 'ID nhân vật')
    : `chr_${uuid().replace(/-/g, '').slice(0, 16)}`;

  if (Object.hasOwn(doc.studio!.characters!, id)) {
    throw new Error(`Hồ sơ nhân vật với ID "${id}" đã tồn tại.`);
  }

  const name = validateName(options.name, 'Tên nhân vật');
  const asset = doc.assets.find(a => a.id === options.assetId);
  if (!asset) {
    throw new Error(`Asset nguồn '${options.assetId}' không tồn tại trong tài liệu.`);
  }
  const frame = asset.frames.find(f => f.id === options.frameId);
  if (!frame) {
    throw new Error(`Frame nguồn '${options.frameId}' không tồn tại trong asset '${asset.id}'.`);
  }

  const capturedPixels = captureVisibleComposite(asset, options.frameId);
  const rgbaResourceId = allocateDedicatedResourceId(doc, id, 'rgba', 'src');
  doc.studio!.resources![rgbaResourceId] = {
    version: 1,
    kind: 'rgba',
    w: asset.w,
    h: asset.h,
    data: capturedPixels,
  };

  const pivot = options.pivot !== undefined
    ? validatePivot(options.pivot, asset.w, asset.h)
    : resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h);
  const palette = options.palette !== undefined ? [...options.palette] : [...asset.palette];

  const profile: CharacterProfile = {
    version: 1,
    id,
    name,
    approved: false,
    source: {
      assetId: options.assetId,
      frameId: options.frameId,
      captureRevision: doc.revision >= 1 ? doc.revision : 1,
      w: asset.w,
      h: asset.h,
      rgbaResourceId,
      palette,
      pivot,
    },
    parts: {},
    landmarks: {},
    links: [],
    actions: {},
  };

  doc.studio!.characters![id] = profile;
  validateDocument(doc);
  return profile;
}

export interface ApproveCharacterProfileOptions {
  pivot?: CharacterPivot | [number, number];
  palette?: number[];
}

export function approveCharacterProfile(
  doc: PixelDocument,
  profileId: string,
  options?: ApproveCharacterProfileOptions
): CharacterProfile {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  const asset = doc.assets.find(a => a.id === profile.source.assetId);
  if (!asset) {
    throw new Error(`Asset nguồn '${profile.source.assetId}' không tồn tại.`);
  }
  const frame = asset.frames.find(f => f.id === profile.source.frameId);
  if (!frame) {
    throw new Error(`Frame nguồn '${profile.source.frameId}' không tồn tại.`);
  }

  const capturedPixels = captureVisibleComposite(asset, profile.source.frameId);
  const oldResId = profile.source.rgbaResourceId;
  const newResId = allocateDedicatedResourceId(doc, profileId, 'rgba', 'src');

  doc.studio!.resources![newResId] = {
    version: 1,
    kind: 'rgba',
    w: asset.w,
    h: asset.h,
    data: capturedPixels,
  };

  profile.source.rgbaResourceId = newResId;
  profile.source.captureRevision = doc.revision >= 1 ? doc.revision : 1;
  profile.source.w = asset.w;
  profile.source.h = asset.h;
  profile.source.palette = options?.palette !== undefined
    ? [...options.palette]
    : [...asset.palette];
  profile.source.pivot = options?.pivot !== undefined
    ? validatePivot(options.pivot, asset.w, asset.h)
    : resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h);
  profile.approved = true;

  pruneDedicatedResource(doc, profileId, oldResId);
  validateDocument(doc);
  return profile;
}

export interface RecaptureCharacterProfileOptions {
  pivot?: CharacterPivot | [number, number];
  palette?: number[];
}

export function recaptureCharacterProfile(
  doc: PixelDocument,
  profileId: string,
  options?: RecaptureCharacterProfileOptions
): CharacterProfile {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  const asset = doc.assets.find(a => a.id === profile.source.assetId);
  if (!asset) {
    throw new Error(`Asset nguồn '${profile.source.assetId}' không tồn tại.`);
  }
  const frame = asset.frames.find(f => f.id === profile.source.frameId);
  if (!frame) {
    throw new Error(`Frame nguồn '${profile.source.frameId}' không tồn tại.`);
  }

  const capturedPixels = captureVisibleComposite(asset, profile.source.frameId);
  const oldResId = profile.source.rgbaResourceId;
  const newResId = allocateDedicatedResourceId(doc, profileId, 'rgba', 'src');

  doc.studio!.resources![newResId] = {
    version: 1,
    kind: 'rgba',
    w: asset.w,
    h: asset.h,
    data: capturedPixels,
  };

  profile.source.rgbaResourceId = newResId;
  profile.source.captureRevision = doc.revision >= 1 ? doc.revision : 1;
  profile.source.w = asset.w;
  profile.source.h = asset.h;
  profile.source.palette = options?.palette !== undefined
    ? [...options.palette]
    : [...asset.palette];
  profile.source.pivot = options?.pivot !== undefined
    ? validatePivot(options.pivot, asset.w, asset.h)
    : resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h);
  profile.approved = false;

  pruneDedicatedResource(doc, profileId, oldResId);
  validateDocument(doc);
  return profile;
}

export function renameCharacterProfile(
  doc: PixelDocument,
  profileId: string,
  name: string
): CharacterProfile {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  profile.name = validateName(name, 'Tên nhân vật');
  validateDocument(doc);
  return profile;
}

export function removeCharacterProfile(doc: PixelDocument, profileId: string): void {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  if (doc.studio?.clips) {
    for (const clip of Object.values(doc.studio.clips)) {
      if (clip.characterId === profileId) {
        throw new Error(`Không thể xóa nhân vật "${profileId}" vì đang được tham chiếu bởi clip "${clip.id}".`);
      }
    }
  }
  const resourcesToPrune: string[] = [profile.source.rgbaResourceId];
  for (const part of Object.values(profile.parts)) {
    resourcesToPrune.push(part.maskResourceId);
  }

  delete doc.studio!.characters![profileId];

  for (const resId of resourcesToPrune) {
    pruneDedicatedResource(doc, profileId, resId);
  }
  validateDocument(doc);
}

export interface AddCharacterPartOptions {
  name: string;
  selection: Uint32Array;
}

export function addCharacterPart(
  doc: PixelDocument,
  profileId: string,
  partId: string,
  options: AddCharacterPartOptions
): CharacterPart {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  validateCharacterId(partId, 'ID bộ phận');
  if (Object.hasOwn(profile.parts, partId)) {
    throw new Error(`Bộ phận "${partId}" đã tồn tại trong nhân vật "${profileId}".`);
  }
  if (Object.keys(profile.parts).length >= MAX_CHARACTER_PARTS) {
    throw new Error(`Số lượng bộ phận vượt quá giới hạn tối đa ${MAX_CHARACTER_PARTS}.`);
  }

  const name = validateName(options.name, 'Tên bộ phận');
  const selection = options.selection;
  if (!(selection instanceof Uint32Array)) {
    throw new Error('Dữ liệu mặt nạ bộ phận phải là Uint32Array.');
  }
  const expectedLength = profile.source.w * profile.source.h;
  if (selection.length !== expectedLength) {
    throw new Error(
      `Kích thước mặt nạ (${selection.length}) không khớp kích thước nguồn (${expectedLength}).`
    );
  }

  let hasSelectedPixel = false;
  for (let i = 0; i < selection.length; i++) {
    const v = selection[i];
    if (v !== 0 && v !== 1) {
      throw new Error(`Mặt nạ chỉ cho phép giá trị 0 hoặc 1, phát hiện: ${v} tại vị trí ${i}.`);
    }
    if (v === 1) hasSelectedPixel = true;
  }
  if (!hasSelectedPixel) {
    throw new Error('Mặt nạ bộ phận không được rỗng (cần ít nhất 1 điểm ảnh được chọn).');
  }

  const maskResourceId = allocateDedicatedResourceId(doc, profileId, 'mask', 'part');
  doc.studio!.resources![maskResourceId] = {
    version: 1,
    kind: 'mask',
    w: profile.source.w,
    h: profile.source.h,
    data: new Uint32Array(selection),
  };

  const part: CharacterPart = { name, maskResourceId };
  profile.parts[partId] = part;
  validateDocument(doc);
  return part;
}

export interface UpdateCharacterPartOptions {
  name?: string;
  selection?: Uint32Array;
}

export function updateCharacterPart(
  doc: PixelDocument,
  profileId: string,
  partId: string,
  options: UpdateCharacterPartOptions
): CharacterPart {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  const part = profile.parts[partId];
  if (!part) {
    throw new Error(`Bộ phận "${partId}" không tồn tại trong nhân vật "${profileId}".`);
  }

  if (options.name !== undefined) {
    part.name = validateName(options.name, 'Tên bộ phận');
  }

  if (options.selection !== undefined) {
    const selection = options.selection;
    if (!(selection instanceof Uint32Array)) {
      throw new Error('Dữ liệu mặt nạ bộ phận phải là Uint32Array.');
    }
    const expectedLength = profile.source.w * profile.source.h;
    if (selection.length !== expectedLength) {
      throw new Error(
        `Kích thước mặt nạ (${selection.length}) không khớp kích thước nguồn (${expectedLength}).`
      );
    }
    let hasSelectedPixel = false;
    for (let i = 0; i < selection.length; i++) {
      const v = selection[i];
      if (v !== 0 && v !== 1) {
        throw new Error(`Mặt nạ chỉ cho phép giá trị 0 hoặc 1, phát hiện: ${v} tại vị trí ${i}.`);
      }
      if (v === 1) hasSelectedPixel = true;
    }
    if (!hasSelectedPixel) {
      throw new Error('Mặt nạ bộ phận không được rỗng (cần ít nhất 1 điểm ảnh được chọn).');
    }

    const oldResId = part.maskResourceId;
    const newResId = allocateDedicatedResourceId(doc, profileId, 'mask', 'part');
    doc.studio!.resources![newResId] = {
      version: 1,
      kind: 'mask',
      w: profile.source.w,
      h: profile.source.h,
      data: new Uint32Array(selection),
    };

    part.maskResourceId = newResId;
    pruneDedicatedResource(doc, profileId, oldResId);
  }

  validateDocument(doc);
  return part;
}

export function removeCharacterPart(
  doc: PixelDocument,
  profileId: string,
  partId: string
): void {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  const part = profile.parts[partId];
  if (!part) {
    throw new Error(`Bộ phận "${partId}" không tồn tại trong nhân vật "${profileId}".`);
  }
  const oldResId = part.maskResourceId;
  delete profile.parts[partId];

  for (const lm of Object.values(profile.landmarks)) {
    if (lm.partId === partId) {
      delete lm.partId;
    }
  }

  pruneDedicatedResource(doc, profileId, oldResId);
  validateDocument(doc);
}

export interface AddCharacterLandmarkOptions {
  name: string;
  x: number;
  y: number;
  partId?: string;
}

export function addCharacterLandmark(
  doc: PixelDocument,
  profileId: string,
  landmarkId: string,
  options: AddCharacterLandmarkOptions
): CharacterLandmark {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  validateCharacterId(landmarkId, 'ID điểm mốc');
  if (Object.hasOwn(profile.landmarks, landmarkId)) {
    throw new Error(`Điểm mốc "${landmarkId}" đã tồn tại trong nhân vật "${profileId}".`);
  }
  if (Object.keys(profile.landmarks).length >= MAX_CHARACTER_LANDMARKS) {
    throw new Error(`Số lượng điểm mốc vượt quá giới hạn tối đa ${MAX_CHARACTER_LANDMARKS}.`);
  }

  const name = validateName(options.name, 'Tên điểm mốc');
  const x = options.x;
  const y = options.y;
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= profile.source.w) {
    throw new Error(`Tọa độ x của điểm mốc phải là số nguyên từ 0 đến ${profile.source.w - 1}.`);
  }
  if (typeof y !== 'number' || !Number.isInteger(y) || y < 0 || y >= profile.source.h) {
    throw new Error(`Tọa độ y của điểm mốc phải là số nguyên từ 0 đến ${profile.source.h - 1}.`);
  }

  if (options.partId !== undefined) {
    if (!Object.hasOwn(profile.parts, options.partId)) {
      throw new Error(`Bộ phận liên kết "${options.partId}" không tồn tại trong nhân vật.`);
    }
  }

  const lm: CharacterLandmark = {
    name,
    x,
    y,
    ...(options.partId ? { partId: options.partId } : {}),
  };
  profile.landmarks[landmarkId] = lm;
  validateDocument(doc);
  return lm;
}

export interface UpdateCharacterLandmarkOptions {
  name?: string;
  x?: number;
  y?: number;
  partId?: string | null;
}

export function updateCharacterLandmark(
  doc: PixelDocument,
  profileId: string,
  landmarkId: string,
  options: UpdateCharacterLandmarkOptions
): CharacterLandmark {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  const lm = profile.landmarks[landmarkId];
  if (!lm) {
    throw new Error(`Điểm mốc "${landmarkId}" không tồn tại trong nhân vật "${profileId}".`);
  }

  if (options.name !== undefined) {
    lm.name = validateName(options.name, 'Tên điểm mốc');
  }
  if (options.x !== undefined) {
    const x = options.x;
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= profile.source.w) {
      throw new Error(`Tọa độ x của điểm mốc phải là số nguyên từ 0 đến ${profile.source.w - 1}.`);
    }
    lm.x = x;
  }
  if (options.y !== undefined) {
    const y = options.y;
    if (typeof y !== 'number' || !Number.isInteger(y) || y < 0 || y >= profile.source.h) {
      throw new Error(`Tọa độ y của điểm mốc phải là số nguyên từ 0 đến ${profile.source.h - 1}.`);
    }
    lm.y = y;
  }
  if (options.partId !== undefined) {
    if (options.partId === null || options.partId === '') {
      delete lm.partId;
    } else {
      if (!Object.hasOwn(profile.parts, options.partId)) {
        throw new Error(`Bộ phận liên kết "${options.partId}" không tồn tại trong nhân vật.`);
      }
      lm.partId = options.partId;
    }
  }

  validateDocument(doc);
  return lm;
}

export function removeCharacterLandmark(
  doc: PixelDocument,
  profileId: string,
  landmarkId: string
): void {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  if (!profile.landmarks[landmarkId]) {
    throw new Error(`Điểm mốc "${landmarkId}" không tồn tại trong nhân vật "${profileId}".`);
  }
  if (doc.studio?.clips) {
    for (const clip of Object.values(doc.studio.clips)) {
      if (clip.characterId === profileId) {
        for (const slot of clip.slots) {
          if (slot.pose && Object.hasOwn(slot.pose, landmarkId)) {
            throw new Error(
              `Không thể xóa điểm mốc "${landmarkId}" vì đang được tham chiếu trong pose của clip "${clip.id}".`
            );
          }
        }
      }
    }
  }
  delete profile.landmarks[landmarkId];
  profile.links = profile.links.filter(l => l.from !== landmarkId && l.to !== landmarkId);
  validateDocument(doc);
}

export function addCharacterLink(
  doc: PixelDocument,
  profileId: string,
  from: string,
  to: string
): CharacterLink {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  if (from === to) {
    throw new Error('Không thể tạo liên kết giữa một điểm mốc với chính nó.');
  }
  if (!Object.hasOwn(profile.landmarks, from)) {
    throw new Error(`Điểm mốc xuất phát '${from}' không tồn tại.`);
  }
  if (!Object.hasOwn(profile.landmarks, to)) {
    throw new Error(`Điểm mốc đích '${to}' không tồn tại.`);
  }

  const exists = profile.links.some(
    l => (l.from === from && l.to === to) || (l.from === to && l.to === from)
  );
  if (exists) {
    throw new Error(`Liên kết giữa '${from}' và '${to}' đã tồn tại.`);
  }

  if (profile.links.length >= MAX_CHARACTER_LINKS) {
    throw new Error(`Số lượng liên kết vượt quá giới hạn tối đa ${MAX_CHARACTER_LINKS}.`);
  }

  const link: CharacterLink = { from, to };
  profile.links.push(link);
  validateDocument(doc);
  return link;
}

export function removeCharacterLink(
  doc: PixelDocument,
  profileId: string,
  from: string,
  to: string
): void {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  profile.links = profile.links.filter(
    l => !((l.from === from && l.to === to) || (l.from === to && l.to === from))
  );
  validateDocument(doc);
}

export interface AddCharacterActionOptions {
  name: string;
  template: ActionTemplate;
}

export function addCharacterAction(
  doc: PixelDocument,
  profileId: string,
  actionId: string,
  action: AddCharacterActionOptions
): CharacterAction {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  validateCharacterId(actionId, 'ID hành động');
  if (Object.hasOwn(profile.actions, actionId)) {
    throw new Error(`Hành động "${actionId}" đã tồn tại trong nhân vật "${profileId}".`);
  }
  if (Object.keys(profile.actions).length >= MAX_CHARACTER_ACTIONS) {
    throw new Error(`Số lượng hành động vượt quá giới hạn tối đa ${MAX_CHARACTER_ACTIONS}.`);
  }

  const name = validateName(action.name, 'Tên hành động');
  if (!ACTION_TEMPLATES.includes(action.template)) {
    throw new Error(
      `Template hành động không hợp lệ: "${String(action.template)}". Hỗ trợ: ${ACTION_TEMPLATES.join(', ')}.`
    );
  }

  const act: CharacterAction = { name, template: action.template };
  profile.actions[actionId] = act;
  validateDocument(doc);
  return act;
}

export interface UpdateCharacterActionOptions {
  name?: string;
  template?: ActionTemplate;
}

export function updateCharacterAction(
  doc: PixelDocument,
  profileId: string,
  actionId: string,
  action: UpdateCharacterActionOptions
): CharacterAction {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  const act = profile.actions[actionId];
  if (!act) {
    throw new Error(`Hành động "${actionId}" không tồn tại trong nhân vật "${profileId}".`);
  }

  if (action.name !== undefined) {
    act.name = validateName(action.name, 'Tên hành động');
  }
  if (action.template !== undefined) {
    if (!ACTION_TEMPLATES.includes(action.template)) {
      throw new Error(
        `Template hành động không hợp lệ: "${String(action.template)}". Hỗ trợ: ${ACTION_TEMPLATES.join(', ')}.`
      );
    }
    act.template = action.template;
  }

  validateDocument(doc);
  return act;
}

export function removeCharacterAction(
  doc: PixelDocument,
  profileId: string,
  actionId: string
): void {
  const profile = getCharacterProfileOrThrow(doc, profileId);
  if (!profile.actions[actionId]) {
    throw new Error(`Hành động "${actionId}" không tồn tại trong nhân vật "${profileId}".`);
  }
  delete profile.actions[actionId];
  validateDocument(doc);
}
