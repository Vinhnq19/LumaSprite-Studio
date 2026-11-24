import { randomUUID } from 'node:crypto';
import { composite, isLocked, type PixelDocument } from '../../studio/pixel/model.ts';
import { dataId, dataObject, dataArray } from '../../studio/quality/data.ts';
import { validateAssetRecipe, type AssetRecipe } from '../../studio/quality/recipe.ts';
import { validateQualityProject, type QualityProjectApproval, type QualityResourceBinding } from '../../studio/quality/project.ts';
import { createRecipeRenderer, type RecipeResources } from '../../studio/quality/renderer.ts';
import type { StudioResource } from '../../studio/resources.ts';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';
import { qualityRgbaHash } from './quality-digest.ts';
import { createMotionApproval, verifyMotionCandidate, type MotionApprovalSnapshot } from './motion-approval.ts';
import type { QualitySourceContext } from './quality-stage-worker.ts';
import { staticSourceLayers } from './quality-source-layers.ts';
import { validateTemplateScope } from '../../studio/quality/template-scope.ts';

export function qualityInput(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(k => !keys.includes(k))) throw new StudioError('Yêu cầu chất lượng chứa trường không hỗ trợ.');
  return value as Record<string, any>;
}
export function qualityRevision(doc: PixelDocument, revision: unknown): void {
  if (revision !== doc.revision) throw new StudioError('Revision đã thay đổi; duyệt/tạo lại trên bản mới.', 409);
}
function data(store: PixelStore, doc: PixelDocument, key: string, kind: 'rgba' | 'mask'): StudioResource & { data: Uint32Array } {
  dataId(key, 'Tài nguyên chất lượng'); const r = doc.studio?.resources?.[key];
  if (!r || r.kind !== kind) throw new StudioError('Thiếu tài nguyên đúng loại cho nguồn đã duyệt.', 409);
  return { ...r, data: r.data?.slice() ?? store.resourceStore(doc.id).read({ version: 1, kind, w: r.w, h: r.h, blob: r.blob! }) };
}
function actualFrame(store: PixelStore, doc: PixelDocument, assetId: string, frameId: string): Uint32Array {
  const asset = doc.assets.find(a => a.id === assetId);
  if (!asset || !asset.frames.some(f => f.id === frameId)) throw new StudioError('Asset/frame nguồn không còn tồn tại.', 409);
  store.hydrate(doc, (a, f) => a.id === assetId && f === frameId);
  return composite(asset, frameId).data;
}
function sources(store: PixelStore, doc: PixelDocument, a: QualityProjectApproval): RecipeResources {
  return {
    sources: a.resources.sources.map(b => { const r = data(store, doc, b.resourceId, 'rgba'); return { id: b.id, w: r.w, h: r.h, pixels: r.data }; }),
    masks: a.resources.masks.map(b => { const r = data(store, doc, b.resourceId, 'mask'); return { id: b.id, w: r.w, h: r.h, data: Uint8Array.from(r.data) }; }),
  };
}
/** Build authority only from a saved, server-owned approval and the current project. */
export function approvedQualityContext(store: PixelStore, doc: PixelDocument, a: QualityProjectApproval): QualitySourceContext {
  if (a.projectId !== doc.id) throw new StudioError('Nguồn sao chép/nhập chưa được duyệt trong dự án này.', 409);
  qualityRevision(doc, a.revision);
  const asset = doc.assets.find(k => k.id === a.source.assetId), source = data(store, doc, a.source.resourceId, 'rgba');
  const pixels = actualFrame(store, doc, a.source.assetId, a.source.frameId);
  if (!asset || asset.w !== a.recipe.canvas.w || asset.h !== a.recipe.canvas.h || qualityRgbaHash(pixels) !== a.source.rgbaSha256 || qualityRgbaHash(source.data) !== a.source.rgbaSha256) throw new StudioError('Pixel nguồn đã đổi; duyệt lại trước khi tạo hoặc áp dụng.', 409);
  const resources = sources(store, doc, a);
  if (a.kind === 'static') return { kind: 'free', recipe: a.recipe, resources, ...(a.templateScope ? { templateScope: a.templateScope } : {}) };
  const snapshot: MotionApprovalSnapshot = { recipe: a.recipe, rig: a.rig, plan: a.plan, resources,
    source: { projectId: doc.id, assetId: a.source.assetId, frameId: a.source.frameId, revision: doc.revision, pixels },
    movementMask: a.movementMaskResourceId === null ? null : Uint8Array.from(data(store, doc, a.movementMaskResourceId, 'mask').data),
    frozenFrames: a.frozenFrames.map(f => {
      const saved = data(store, doc, f.resourceId, 'rgba'), now = actualFrame(store, doc, a.source.assetId, f.sourceFrameId);
      if (qualityRgbaHash(saved.data) !== f.rgbaSha256 || qualityRgbaHash(now) !== f.rgbaSha256) throw new StudioError('Frame khóa đã đổi; duyệt lại chuyển động.', 409);
      return { frameId: f.frameId, pixels: saved.data };
    }),
  };
  // This recreates a local verifier receipt from the durable HUMAN action. It
  // does not approve a client/AI receipt or infer an approved rig from landmarks.
  return { kind: 'motion', snapshot, approval: createMotionApproval(snapshot) };
}

/** Caller owns the shared lease across capture, worker validation and manifest save. */
export function prepareQualityApproval(store: PixelStore, rawDoc: PixelDocument, value: unknown): { document: PixelDocument; approval: QualityProjectApproval; context: QualitySourceContext } {
  const input = qualityInput(value, ['revision', 'assetId', 'frameId', 'kind', 'sourceApproved', 'preserveLayers', 'templateScope', 'poseApproved', 'partsApproved', 'recipe', 'rig', 'plan', 'resources', 'movementMaskResourceId', 'frozenFrames']);
  qualityRevision(rawDoc, input.revision); dataId(input.assetId, 'Asset nguồn'); dataId(input.frameId, 'Frame nguồn');
  if (input.sourceApproved !== true || !['static', 'motion'].includes(input.kind)) throw new StudioError('Cần duyệt rõ nguồn và chọn loại tĩnh/chuyển động.');
  if (input.preserveLayers !== undefined && (typeof input.preserveLayers !== 'boolean' || input.kind !== 'static')) throw new StudioError('Tùy chọn giữ layer chỉ áp dụng khi duyệt nguồn tĩnh.');
  if (input.templateScope !== undefined && (input.kind !== 'static' || input.preserveLayers !== true)) throw new StudioError('Chỉnh từ mẫu cần nguồn tĩnh giữ layer.');
  if (input.kind === 'motion' && (input.poseApproved !== true || input.partsApproved !== true)) throw new StudioError('Duyệt pose và bộ phận/vẽ bù trước khi tạo chuyển động.');
  if (input.kind === 'static' && ['recipe', 'rig', 'plan', 'resources', 'movementMaskResourceId', 'frozenFrames', 'poseApproved', 'partsApproved'].some(k => input[k] !== undefined)) throw new StudioError('Nguồn tĩnh không nhận rig/pose hoặc dữ liệu vẽ do client tự thay.');
  const doc = structuredClone(rawDoc), asset = doc.assets.find(a => a.id === input.assetId), frame = asset?.frames.find(f => f.id === input.frameId);
  if (!asset || !frame) throw new StudioError('Chọn asset/frame nguồn hợp lệ.', 404);
  const pixels = actualFrame(store, doc, asset.id, frame.id), palette = [...new Set(asset.palette.filter(c => (c & 255) === 255))];
  const invalidAlpha = pixels.some(c => c !== 0 && (c & 255) !== 255);
  if (invalidAlpha || !palette.length || palette.length > 256 || pixels.some(c => c !== 0 && !palette.includes(c))) {
    throw new StudioError('Nguồn phải khớp palette đục và alpha 0/255. Chuẩn hóa thành bản sao rồi duyệt; app không tự đổi màu nguồn.', 422,
      invalidAlpha ? 'INVALID_ALPHA' : 'INVALID_PALETTE');
  }
  const revision = doc.revision + 1, approvalId = randomUUID(), w = asset.w, h = asset.h, pivot = asset.metadata.pivot ? { x: asset.metadata.pivot.x * w, y: asset.metadata.pivot.y * h } : { x: w / 2, y: h };
  const resources: Record<string, StudioResource> = { ...doc.studio?.resources };
  const capture = (p: Uint32Array): string => { const key = 'q_' + randomUUID(); resources[key] = { version: 1, kind: 'rgba', w, h, data: p.slice() }; return key; };
  const sourceResourceId = capture(pixels);
  let recipe: AssetRecipe, rig: QualityProjectApproval['rig'] = null, plan: QualityProjectApproval['plan'] = null;
  let mapped: QualityProjectApproval['resources'], frozenFrames: QualityProjectApproval['frozenFrames'] = [], movementMaskResourceId: string | null = null;
  if (input.kind === 'static') {
    const hasArtwork = pixels.some(Boolean);
    mapped = { sources: hasArtwork ? [{ id: 'approved-source', resourceId: sourceResourceId }] : [], masks: [] };
    recipe = { version: 1, name: asset.name, canvas: { w, h }, palette, pivot, materials: [], parts: [{ id: 'body', name: 'Nguồn đã duyệt', parentId: null, pivot, origin: hasArtwork ? 'visible' : 'authored', materialIds: [], paint: hasArtwork ? [{ kind: 'raster', sourceId: 'approved-source', sourceRect: { x: 0, y: 0, w, h }, x: 0, y: 0, maskId: null }] : [] }], frames: [{ id: frame.id, durationMs: frame.duration, poses: [] }], loop: false };
    if (input.preserveLayers) {
      const layers = staticSourceLayers(asset, frame.id, palette);
      mapped.sources = layers.map(layer => ({ id: layer.partId, resourceId: capture(layer.pixels) }));
      recipe.parts = layers.map(layer => ({
        id: layer.partId, name: layer.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || 'Layer ảnh',
        parentId: null, pivot, origin: 'visible', materialIds: [],
        paint: [{ kind: 'raster', sourceId: layer.partId, sourceRect: { x: 0, y: 0, w, h }, x: 0, y: 0, maskId: null }],
      }));
      const reconstructed = createRecipeRenderer(recipe, {
        sources: layers.map(layer => ({ id: layer.partId, w, h, pixels: layer.pixels })), masks: [],
      }).renderFrame(frame.id).image.data;
      if (reconstructed.some((color, i) => color !== pixels[i])) throw new StudioError('Các layer dựng lại khác ảnh nguồn. Nguồn chưa được lưu.', 422);
    }
  } else {
    const m = dataObject(input.resources, ['sources', 'masks'], 'Mapping bộ phận'); mapped = structuredClone(m) as QualityProjectApproval['resources'];
    dataArray(mapped.sources, 0, 256, 'Mapping nguồn'); dataArray(mapped.masks, 0, 256, 'Mapping mask');
    const descriptors = (bindings: QualityResourceBinding[], kind: 'rgba' | 'mask') => bindings.map(b => { const r = data(store, doc, b.resourceId, kind); return { id: b.id, w: r.w, h: r.h }; });
    recipe = validateAssetRecipe(input.recipe, { sources: descriptors(mapped.sources, 'rgba'), masks: descriptors(mapped.masks, 'mask') });
    if (JSON.stringify(recipe.canvas) !== JSON.stringify({ w, h }) || JSON.stringify(recipe.palette) !== JSON.stringify(palette) || JSON.stringify(recipe.pivot) !== JSON.stringify(pivot)) throw new StudioError('Canvas/palette/điểm neo bộ phận khác nguồn đã chọn.', 422);
    rig = structuredClone(input.rig); plan = structuredClone(input.plan);
    if (!rig || !plan) throw new StudioError('Thiếu rig/kế hoạch chuyển động đã xem.');
    rig.source = { projectId: doc.id, assetId: asset.id, frameId: frame.id, revision, rgbaSha256: qualityRgbaHash(pixels), canvas: { w, h }, pivot };
    movementMaskResourceId = input.movementMaskResourceId ?? null;
    dataArray(input.frozenFrames ?? [], 0, recipe.frames.length, 'Danh sách frame khóa');
    if (w * h * ((input.frozenFrames?.length ?? 0) + 1) > 32_000_000) throw new StudioError('Nguồn và frame khóa vượt ngân sách 32 triệu pixel.', 422);
    frozenFrames = (input.frozenFrames ?? []).map((raw: unknown) => { const f = dataObject(raw, ['frameId', 'sourceFrameId'], 'Frame khóa'); const sourceFrameId = dataId(f.sourceFrameId, 'Frame nguồn khóa'), p = actualFrame(store, doc, asset.id, sourceFrameId); return { frameId: dataId(f.frameId, 'Frame đích khóa'), sourceFrameId, resourceId: capture(p), rgbaSha256: qualityRgbaHash(p) }; });
  }
  if (w * h * recipe.frames.length > 8_000_000) throw new StudioError('Nguồn vượt giới hạn 8 triệu pixel review native; giảm clip/canvas trước khi duyệt.', 422);
  const templateScope = input.templateScope === undefined ? undefined : validateTemplateScope(input.templateScope, recipe);
  if (templateScope && asset.layers.some(layer => templateScope.partIds.includes(layer.id) && isLocked(asset, layer))) throw new StudioError('Mở khóa layer cần sửa trước khi duyệt phạm vi.', 422);
  const approval: QualityProjectApproval = { version: 1, id: approvalId, projectId: doc.id, revision, approvedAt: Date.now(), kind: input.kind, source: { assetId: asset.id, frameId: frame.id, resourceId: sourceResourceId, rgbaSha256: qualityRgbaHash(pixels) }, recipe, rig, plan, resources: mapped, movementMaskResourceId, frozenFrames, ...(templateScope ? { templateScope } : {}) };
  const approvals = { ...doc.studio?.quality?.approvals };
  if (Object.keys(approvals).length >= 20) throw new StudioError('Đã giữ 20 nguồn duyệt. Xóa nguồn duyệt cũ trước khi thêm.');
  approvals[approvalId] = approval; doc.studio = { ...doc.studio, version: 2, resources, quality: { version: 1, approvals } };
  const validated = validateQualityProject(doc.studio.quality, resources); doc.studio.quality = validated;
  // Validate against the revision the manifest WILL have, not the pre-save one.
  const future = { ...doc, revision }, accepted = validated.approvals[approvalId], context = approvedQualityContext(store, future, accepted);
  if (context.kind === 'motion') verifyMotionCandidate(context.approval, context.snapshot, context.snapshot.recipe);
  return { document: doc, approval: accepted, context };
}
