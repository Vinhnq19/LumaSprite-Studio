import { createHash, randomUUID } from 'node:crypto';
import { dataObject as obj, dataArray as arr, dataId as id, dataNumber as num, invalidData as fail } from '../../studio/quality/data.ts';
import { createRecipeRenderer, type RecipeResources } from '../../studio/quality/renderer.ts';
import { validateAssetRecipe, type AssetRecipe } from '../../studio/quality/recipe.ts';
import { compileMotionRecipe, type CompiledMotion } from '../../studio/quality/motion-render.ts';
import { assertMotionArtwork } from '../../studio/quality/motion-art.ts';
import { qualityRgbaHash } from './quality-digest.ts';

export interface MotionApprovalSnapshot {
  recipe: unknown; rig: unknown; plan: unknown; resources: RecipeResources;
  source: { projectId: string; assetId: string; frameId: string; revision: number; pixels: Uint32Array };
  movementMask: Uint8Array | null;
  frozenFrames: { frameId: string; pixels: Uint32Array }[];
}
interface Fingerprints {
  projectId: string; revision: number; sourceAssetId: string; sourceFrameId: string;
  sourceSha256: string; recipeSha256: string; rigSha256: string; planSha256: string;
  resourcesSha256: string; maskSha256: string | null; frozenFramesSha256: string;
}
export interface MotionApproval extends Fingerprints { version: 1; id: string; approvedAt: number }
const keys = ['projectId', 'revision', 'sourceAssetId', 'sourceFrameId', 'sourceSha256', 'recipeSha256', 'rigSha256', 'planSha256', 'resourcesSha256', 'maskSha256', 'frozenFramesSha256'] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function checkPixels(value: unknown, length: number, palette: Set<number>): Uint32Array {
  if (!(value instanceof Uint32Array) || value.length !== length) fail('Snapshot chuyển động', 'RGBA sai định dạng hoặc kích thước.');
  for (const color of value) if (color !== 0 && ((color & 255) !== 255 || !palette.has(color))) fail('Snapshot chuyển động', 'RGBA phải khớp palette, alpha 0/255 và không có RGB ẩn.');
  return value;
}
function fingerprints(snapshot: MotionApprovalSnapshot): Fingerprints {
  obj(snapshot, ['recipe', 'rig', 'plan', 'resources', 'source', 'movementMask', 'frozenFrames'], 'Snapshot chuyển động');
  // Also validates every actual buffer/mask and all descriptor IDs, even unused sources.
  const renderer = createRecipeRenderer(snapshot.recipe, snapshot.resources), recipe = renderer.getRecipe();
  const context = { sources: snapshot.resources.sources.map(({ id, w, h }) => ({ id, w, h })), masks: snapshot.resources.masks.map(({ id, w, h }) => ({ id, w, h })) };
  const compiled = compileMotionRecipe(recipe, snapshot.rig, snapshot.plan, context), { rig, plan } = compiled;
  assertMotionArtwork(compiled, snapshot.resources);
  const source = obj(snapshot.source, ['projectId', 'assetId', 'frameId', 'revision', 'pixels'], 'Nguồn hiện tại');
  const area = recipe.canvas.w * recipe.canvas.h, palette = new Set(recipe.palette);
  const frozen = arr(snapshot.frozenFrames, 0, recipe.frames.length, 'Frame khóa');
  if (area * (frozen.length + 1) > 32_000_000) fail('Snapshot chuyển động', 'vượt ngân sách 32 triệu pixel.');
  const pixels = checkPixels(source.pixels, area, palette);
  const sourceSha256 = qualityRgbaHash(pixels);
  const projectId = id(source.projectId, 'Dự án nguồn'), sourceAssetId = id(source.assetId, 'Asset nguồn'), sourceFrameId = id(source.frameId, 'Frame nguồn');
  const revision = num(source.revision, 0, Number.MAX_SAFE_INTEGER, 'Revision nguồn', true);
  if (projectId !== rig.source.projectId || sourceAssetId !== rig.source.assetId || sourceFrameId !== rig.source.frameId || revision !== rig.source.revision || sourceSha256 !== rig.source.rgbaSha256) fail('Snapshot chuyển động', 'nguồn/rig/revision không khớp dữ liệu hiện tại.');
  const rest = renderer.renderFrame(recipe.frames[0].id).image.data;
  if (rest.some((c, i) => c !== pixels[i])) fail('Snapshot chuyển động', 'bộ phận ở tư thế nghỉ không ghép lại đúng nguồn đã duyệt.');
  const mask = snapshot.movementMask;
  if (mask !== null && (!(mask instanceof Uint8Array) || mask.length !== area || mask.some(n => n !== 0 && n !== 1) || !mask.some(n => n === 1))) fail('Snapshot chuyển động', 'vùng cho phép phải là mask 0/1 không rỗng, đúng canvas.');
  const used = new Set<string>();
  const frozenHashes = frozen.map(v => {
    const f = obj(v, ['frameId', 'pixels'], 'Frame khóa'), frameId = id(f.frameId, 'ID frame khóa');
    if (used.has(frameId) || !recipe.frames.some(f => f.id === frameId)) fail('Snapshot chuyển động', 'ID frame khóa trùng hoặc không tồn tại.');
    used.add(frameId);
    return { frameId, rgbaSha256: qualityRgbaHash(checkPixels(f.pixels, area, palette)) };
  }).sort((a, b) => a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0);
  const resourceHashes = {
    sources: snapshot.resources.sources.map(s => ({ id: s.id, w: s.w, h: s.h, hash: qualityRgbaHash(s.pixels) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    masks: snapshot.resources.masks.map(m => ({ id: m.id, w: m.w, h: m.h, hash: createHash('sha256').update(m.data).digest('hex') })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
  return { projectId, revision, sourceAssetId, sourceFrameId, sourceSha256, recipeSha256: digest(recipe), rigSha256: digest(rig), planSha256: digest(plan), resourcesSha256: digest(resourceHashes), maskSha256: mask === null ? null : createHash('sha256').update(mask).digest('hex'), frozenFramesSha256: digest(frozenHashes) };
}
/** Server-only: call after an explicit human approval action. Never accept a client/AI-created receipt as authority. */
export function createMotionApproval(snapshot: MotionApprovalSnapshot): MotionApproval {
  return { version: 1, id: randomUUID(), approvedAt: Date.now(), ...fingerprints(snapshot) };
}
/** approval must be loaded by the server from its own project-owned approval store. This is not a signature scheme. */
export function assertMotionApproval(approval: MotionApproval, current: MotionApprovalSnapshot): void {
  const value = obj(approval, ['version', 'id', 'approvedAt', ...keys], 'Duyệt chuyển động');
  if (value.version !== 1) fail('Duyệt chuyển động', 'phiên bản không hợp lệ.');
  id(value.id, 'ID duyệt chuyển động'); num(value.approvedAt, 1, Number.MAX_SAFE_INTEGER, 'Thời gian duyệt', true);
  const expected = fingerprints(current);
  for (const key of keys) if (value[key] !== expected[key]) fail('Duyệt chuyển động', 'nguồn, rig, kế hoạch, mask, frame khóa hoặc revision đã đổi; cần duyệt lại.');
}
export interface VerifiedMotionCandidate extends Pick<CompiledMotion, 'recipe' | 'rig' | 'geometry'> { frameHashes: { frameId: string; rgbaSha256: string }[] }
/** Verifies final rendered RGBA. Passing graph/IK tests alone cannot prove pixel protection. */
export function verifyMotionCandidate(approval: MotionApproval, current: MotionApprovalSnapshot, candidate: unknown): VerifiedMotionCandidate {
  assertMotionApproval(approval, current);
  const resources = current.resources, context = { sources: resources.sources.map(({ id, w, h }) => ({ id, w, h })), masks: resources.masks.map(({ id, w, h }) => ({ id, w, h })) };
  const baseline = validateAssetRecipe(current.recipe, context), proposed = validateAssetRecipe(candidate, context);
  // Poses come from the locked rig/plan and pixelEdits are gated per pixel by the frozen/mask checks below,
  // so both stay out of the closed-structure comparison; the approval fingerprint still covers the full recipe.
  const structure = (r: AssetRecipe) => ({ canvas: r.canvas, palette: r.palette, pivot: r.pivot, materials: r.materials, parts: r.parts.map(({ paint: _, ...p }) => p), frames: r.frames.map(({ poses: _poses, pixelEdits: _edits, ...f }) => f), loop: r.loop });
  if (digest(structure(baseline)) !== digest(structure(proposed))) fail('Đề xuất chuyển động', 'cấu trúc/timing/palette đã chốt bị thay đổi.');
  const compiled = compileMotionRecipe(proposed, current.rig, current.plan, context), renderer = createRecipeRenderer(compiled.recipe, resources);
  assertMotionArtwork(compiled, resources);
  const frozen = new Map(current.frozenFrames.map(f => [f.frameId, f.pixels])), mask = current.movementMask;
  const frameHashes = proposed.frames.map(frame => {
    const pixels = renderer.renderFrame(frame.id).image.data, locked = frozen.get(frame.id);
    if (!pixels.some(c => c !== 0)) fail('Đề xuất chuyển động', `frame ${frame.id} rỗng.`);
    for (let i = 0; i < pixels.length; i++) {
      if (locked && pixels[i] !== locked[i]) fail('Đề xuất chuyển động', `frame khóa ${frame.id} đã đổi pixel.`);
      if (mask && !mask[i] && pixels[i] !== current.source.pixels[i]) fail('Đề xuất chuyển động', `frame ${frame.id} sửa pixel ngoài vùng cho phép.`);
    }
    return { frameId: frame.id, rgbaSha256: qualityRgbaHash(pixels) };
  });
  return { recipe: compiled.recipe, rig: compiled.rig, geometry: compiled.geometry, frameHashes };
}
