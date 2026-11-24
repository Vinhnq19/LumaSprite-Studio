import { qualityRgbaHash } from './quality-digest.ts';
export { qualityRgbaHash } from './quality-digest.ts';
import { createRecipeRenderer, type RecipeResources } from '../../studio/quality/renderer.ts';
import { bounds, estimateImageSourceLength, imageSource } from '../../studio/pixel/processing.ts';
import { composite, newAsset, newLayer, uid, wireStringify, type PixelAsset } from '../../studio/pixel/model.ts';
import type { AssetRecipe } from '../../studio/quality/recipe.ts';
import { compileMotionRecipe } from '../../studio/quality/motion-render.ts';
import { dataObject } from '../../studio/quality/data.ts';
import { verifyMotionCandidate, type MotionApproval, type MotionApprovalSnapshot } from './motion-approval.ts';
import { encodePng } from '../png.ts';
import type { ExportResult } from './render.ts';

export type QualityPreviewRequest = {
  mode: 'quality-render'; revision: number; recipe: unknown; resources: RecipeResources;
  motion?: { rig: unknown; plan: unknown };
} & ({ operation: 'inspect' } | { operation: 'asset'; preserveLayers?: true } | { operation: 'frame' | 'geometry'; frameId: string });
export type QualityRenderRequest = QualityPreviewRequest | {
  mode: 'quality-render'; revision: number; recipe: unknown; operation: 'motion-verify' | 'motion-asset';
  approval: MotionApproval; snapshot: MotionApprovalSnapshot;
};
export interface QualityFrameInspection {
  id: string; durationMs: number; rgbaSha256: string; visiblePixels: number;
  bounds?: { x: number; y: number; w: number; h: number; bottom: number };
}
export interface QualityInspection {
  revision: number; name: string; w: number; h: number; loop: boolean; pivot: { x: number; y: number };
  palette: number[]; frames: QualityFrameInspection[];
  motion?: { rigId: string; planId: string; frames: { frameId: string; boneError: number; attachmentError: number; contactRasterError: number }[] };
}
const json = (value: unknown, filename: string): ExportResult => ({ data: Buffer.from(wireStringify(value)), mime: 'application/json', filename });
function assetFromFrames(recipe: AssetRecipe, images: Uint32Array[], palette: number[]): PixelAsset {
  const { w, h } = recipe.canvas, durations = recipe.frames.map(f => f.durationMs);
  if (estimateImageSourceLength('quality-result', w, h, images, durations, recipe.loop, 1_900_000) > 1_900_000) throw new Error('Nguồn dựng chính xác vượt giới hạn 2 MiB/file; giảm độ phức tạp trước khi áp dụng.');
  const source = imageSource('quality-result', w, h, images, durations, recipe.loop);
  if (Buffer.byteLength(source) > 1_900_000) throw new Error('Nguồn dựng chính xác vượt giới hạn 2 MiB/file.');
  const asset = newAsset(recipe.name, w, h), layer = newLayer('Kết quả chế độ chất lượng');
  asset.layers = [layer]; asset.frames = recipe.frames.map(f => ({ id: uid(), duration: f.durationMs })); asset.cels = {};
  images.forEach((data, index) => { const id = uid(); asset.cels[id] = { id, data }; layer.cels[asset.frames[index].id] = id; });
  asset.tags = [{ id: uid(), name: recipe.name, from: asset.frames[0].id, to: asset.frames.at(-1)!.id, direction: 'forward', loop: recipe.loop }];
  // Recipe/rig use pixel-space anchors. Existing project/export metadata uses normalized 0..1.
  asset.palette = palette; asset.metadata = { pivot: { x: recipe.pivot.x / w, y: recipe.pivot.y / h } };
  asset.source = { entry: 'art.px.js', files: { 'art.px.js': source } }; asset.provenance = { kind: 'generated' };
  return asset;
}
/** Runs inside the existing bounded render worker. Never writes preview/export files. */
export function renderQuality(request: QualityRenderRequest): ExportResult {
  if (!Number.isSafeInteger(request.revision) || request.revision < 0) throw new Error('Revision chế độ chất lượng không hợp lệ.');
  if ('snapshot' in request) {
    if (request.operation !== 'motion-verify' && request.operation !== 'motion-asset') throw new Error('Thao tác kiểm tra chuyển động không hợp lệ.');
    if (request.revision !== request.snapshot.source.revision || request.revision !== request.approval.revision) throw new Error('Revision nguồn/duyệt chuyển động không khớp.');
    const checked = verifyMotionCandidate(request.approval, request.snapshot, request.recipe);
    if (request.operation === 'motion-verify') return json({ revision: request.revision, frameHashes: checked.frameHashes }, 'motion-verification.json');
    return renderQuality({ mode: 'quality-render', revision: request.revision, operation: 'asset', recipe: checked.recipe, resources: request.snapshot.resources });
  }
  if (!['inspect', 'asset', 'frame', 'geometry'].includes(request.operation)) throw new Error('Thao tác dựng chất lượng không hợp lệ.');
  // Validate actual buffers/descriptors before reading their fields for motion context.
  let renderer = createRecipeRenderer(request.recipe, request.resources);
  const context = { sources: request.resources.sources.map(({ id, w, h }) => ({ id, w, h })), masks: request.resources.masks.map(({ id, w, h }) => ({ id, w, h })) };
  let motion: ReturnType<typeof compileMotionRecipe> | undefined;
  if (request.motion !== undefined) {
    const m = dataObject(request.motion, ['rig', 'plan'], 'Chuyển động');
    motion = compileMotionRecipe(renderer.getRecipe(), m.rig, m.plan, context);
    renderer = createRecipeRenderer(motion.recipe, request.resources);
  }
  const recipe = renderer.getRecipe();
  if (request.operation === 'geometry') {
    const geometry = motion?.geometry.find(g => g.frameId === request.frameId);
    if (!geometry) throw new Error('Không có hình học rig cho frame được chọn.');
    return json({ revision: request.revision, geometry }, 'motion-geometry.json');
  }
  if (request.operation === 'frame') {
    const frame = renderer.renderFrame(request.frameId);
    return { data: encodePng(frame.image), mime: 'image/png', filename: `${frame.frameId}.png` };
  }
  if (request.operation === 'asset' && recipe.canvas.w * recipe.canvas.h * recipe.frames.length > 32_000_000) throw new Error('Asset vượt ngân sách 32 triệu pixel cel.');
  const colors = new Set<number>(), images: Uint32Array[] = [], frames: QualityFrameInspection[] = [];
  for (const frame of recipe.frames) {
    const { image } = renderer.renderFrame(frame.id);
    let visiblePixels = 0;
    for (const color of image.data) { if (color) visiblePixels++; colors.add(color); }
    if (!visiblePixels) throw new Error(`Frame ${frame.id} rỗng; sửa đề xuất trước khi áp dụng.`);
    frames.push({ id: frame.id, durationMs: frame.durationMs, rgbaSha256: qualityRgbaHash(image.data), visiblePixels, bounds: bounds(image.data, image.w) });
    if (request.operation === 'asset') images.push(image.data);
  }
  const palette = [...colors].sort((a, b) => a - b);
  const inspection: QualityInspection = { revision: request.revision, name: recipe.name, ...recipe.canvas, loop: recipe.loop, pivot: recipe.pivot, palette, frames,
    ...(motion ? { motion: { rigId: motion.rig.id, planId: motion.plan.id, frames: motion.geometry.map(g => ({ frameId: g.frameId, boneError: g.maxBoneError, attachmentError: g.maxAttachmentError, contactRasterError: Math.max(0, ...g.contacts.map(c => c.rasterError)) })) } } : {}) };
  if (request.operation === 'inspect') return json(inspection, 'quality-inspection.json');
  const asset = assetFromFrames(recipe, images, palette);
  if (request.operation === 'asset' && request.preserveLayers) {
    const frame = asset.frames[0];
    asset.cels = {};
    asset.layers = recipe.parts.map(part => {
      const layer = newLayer(part.name), id = uid();
      asset.cels[id] = { id, data: renderer.staticPartPixels(part.id) };
      layer.cels[frame.id] = id;
      return layer;
    });
    asset.palette = recipe.palette;
    if (composite(asset, frame.id).data.some((color, i) => color !== images[0][i])) throw new Error('Layer bản chỉnh khác preview.');
  }
  return json({ inspection, asset }, 'quality-asset.json');
}
