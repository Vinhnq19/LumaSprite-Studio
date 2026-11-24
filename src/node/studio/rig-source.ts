import { randomUUID } from 'node:crypto';
import { celFor, composite, newAsset, type PixelDocument } from '../../studio/pixel/model.ts';
import { validateRigDraft, MAX_RIG_DRAFTS, type RigDraft } from '../../studio/quality/rig-draft.ts';
import { dataId, dataName } from '../../studio/quality/data.ts';
import { qualityInput, qualityRevision } from './quality-source.ts';
import { qualityRgbaHash } from './quality-digest.ts';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';

/** Capture visible pixels into an editable copy, with no human/AI approval. */
export function prepareRigDraftSource(store: PixelStore, rawDoc: PixelDocument, value: unknown): { document: PixelDocument; draft: RigDraft } {
  const input = qualityInput(value, ['revision', 'assetId', 'frameId', 'name']); qualityRevision(rawDoc, input.revision);
  dataId(input.assetId, 'Asset nguồn rig'); dataId(input.frameId, 'Frame nguồn rig');
  const doc = structuredClone(rawDoc), source = doc.assets.find(a => a.id === input.assetId), frame = source?.frames.find(f => f.id === input.frameId);
  if (!source || !frame) throw new StudioError('Không tìm thấy asset/frame nguồn rig.', 404);
  if (Object.keys(doc.studio?.rigDrafts ?? {}).length >= MAX_RIG_DRAFTS) throw new StudioError('Đã có20 nháp rig. Xóa nháp cũ trước khi thêm.');
  if (source.w * source.h > 8_000_000) throw new StudioError('Nguồn rig vượt8 triệu pixel; giảm canvas trên bản sao trước.', 422);
  store.hydrate(doc, (a, f) => a.id === source.id && f === frame.id);
  const pixels = composite(source, frame.id).data, palette = [...new Set(source.palette.filter(c => (c & 255) === 255))];
  if (!palette.length || pixels.some(c => c !== 0 && ((c & 255) !== 255 || !palette.includes(c)))) throw new StudioError('Nguồn rig cần palette đục và alpha0/255. Chuẩn hóa bản sao trước; không tự đổi ảnh gốc.', 422);
  const name = input.name === undefined ? source.name.slice(0, 78) + ' · Nguồn rig' : dataName(input.name, 'Tên nguồn rig');
  const asset = newAsset(name, source.w, source.h), layer = asset.layers[0], rest = asset.frames[0];
  rest.duration = frame.duration; layer.name = 'Nguồn nhìn thấy'; asset.palette = palette;
  celFor(asset, layer.id, rest.id, true)!.data = pixels.slice();
  asset.metadata = structuredClone(source.metadata); asset.metadata.pivot ??= { x: .5, y: 1 };
  if (asset.metadata.events) asset.metadata.events = asset.metadata.events.filter(e => e.frame === source.frames.indexOf(frame)).map(e => ({ ...e, frame: 0 }));
  const w = asset.w, h = asset.h, pivot = { x: asset.metadata.pivot.x * w, y: asset.metadata.pivot.y * h };
  const resourceId = 'rig_' + randomUUID(), resourceName = 'pixels_' + layer.id, root = 'root_' + randomUUID(), rigId = randomUUID(), draftId = randomUUID(), second = randomUUID();
  const resources = { ...doc.studio?.resources, [resourceId]: { version: 1 as const, kind: 'rgba' as const, w, h, data: pixels.slice() } };
  const recipe: RigDraft['recipe'] = { version: 1, name, canvas: { w, h }, palette, pivot, materials: [], parts: [{ id: layer.id, name: layer.name, parentId: null, pivot, origin: 'visible', materialIds: [], paint: pixels.some(Boolean) ? [{ kind: 'raster', sourceId: resourceName, sourceRect: { x: 0, y: 0, w, h }, x: 0, y: 0, maskId: null }] : [] }], frames: [{ id: rest.id, durationMs: rest.duration, poses: [] }, { id: second, durationMs: rest.duration, poses: [] }], loop: true };
  const rig: RigDraft['rig'] = { version: 1, id: rigId, source: { projectId: doc.id, assetId: asset.id, frameId: rest.id, revision: doc.revision + 1, rgbaSha256: qualityRgbaHash(pixels), canvas: { w, h }, pivot }, joints: [{ id: root, parentId: null, rest: pivot, minRotation: -180, maxRotation: 180 }], sockets: [], bindings: [{ partId: layer.id, jointId: root, socketId: null }], chains: [] };
  const plan: RigDraft['plan'] = { version: 1, id: randomUUID(), rigId, action: 'custom', loop: true, rootMotion: false, frames: recipe.frames.map(f => ({ id: f.id, durationMs: f.durationMs, root: { dx: 0, dy: 0 }, travel: { dx: 0, dy: 0 }, rotations: [], order: [layer.id], contacts: [] })) };
  const draft = validateRigDraft({ version: 1, id: draftId, name, origin: { assetId: source.id, frameId: frame.id }, recipe, rig, plan, resources: { sources: [{ id: resourceName, resourceId }], masks: [] }, movementMaskResourceId: null, frozenFrames: [] }, resources);
  doc.assets.push(asset);
  doc.studio = { ...doc.studio, version: 2, quality: doc.studio?.quality ?? { version: 1, approvals: {} }, resources, rigDrafts: { ...doc.studio?.rigDrafts, [draft.id]: draft } };
  return { document: doc, draft };
}
