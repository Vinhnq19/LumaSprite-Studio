import { dataObject as obj, dataArray as arr, dataId as id, dataName as name, invalidData as fail } from './data.ts';
import { validateAssetRecipe, type AssetRecipe, type RecipeContext } from './recipe.ts';
import { validateMotionRig, validateMotionPlan, type MotionRig, type MotionPlan } from './motion.ts';
import type { QualityResourceBinding } from './project.ts';
import type { StudioResource } from '../resources.ts';

/** Editable source/rig data. Possessing or saving a draft grants no approval. */
export interface RigDraft {
  version: 1; id: string; name: string;
  origin: { assetId: string; frameId: string };
  recipe: AssetRecipe; rig: MotionRig; plan: MotionPlan;
  resources: { sources: QualityResourceBinding[]; masks: QualityResourceBinding[] };
  movementMaskResourceId: string | null;
  frozenFrames: { frameId: string; sourceFrameId: string }[];
}
export const MAX_RIG_DRAFTS = 20;
export function rigDraftContext(draft: Pick<RigDraft, 'resources'>, resources: Record<string, StudioResource>): RecipeContext {
  const descriptors = (bindings: QualityResourceBinding[], kind: 'rgba' | 'mask') => bindings.map(b => {
    const r = Object.hasOwn(resources, b.resourceId) ? resources[b.resourceId] : undefined;
    if (!r || r.kind !== kind) fail('Nguồn rig', 'thiếu tài nguyên đúng loại.');
    return { id: b.id, w: r.w, h: r.h };
  });
  return { sources: descriptors(draft.resources.sources, 'rgba'), masks: descriptors(draft.resources.masks, 'mask') };
}
/** Resources have already passed validateResourceMap at the document boundary. */
export function validateRigDraft(value: unknown, resources: Record<string, StudioResource> = {}): RigDraft {
  const v = obj(value, ['version', 'id', 'name', 'origin', 'recipe', 'rig', 'plan', 'resources', 'movementMaskResourceId', 'frozenFrames'], 'Nháp rig');
  if (v.version !== 1) fail('Nháp rig', 'phiên bản không hợp lệ.');
  const o = obj(v.origin, ['assetId', 'frameId'], 'Nguồn ban đầu của rig');
  const r = obj(v.resources, ['sources', 'masks'], 'Mapping nháp rig');
  const bindings = (raw: unknown): QualityResourceBinding[] => {
    const seen = new Set<string>();
    return arr(raw, 0, 256, 'Mapping nháp rig').map(raw => {
      const b = obj(raw, ['id', 'resourceId'], 'Mapping nháp rig'), key = id(b.id, 'ID mapping rig');
      if (seen.has(key)) fail('Mapping nháp rig', 'ID trùng.'); seen.add(key);
      return { id: key, resourceId: id(b.resourceId, 'Tài nguyên rig') };
    });
  };
  const mapped = { sources: bindings(r.sources), masks: bindings(r.masks) }, context = rigDraftContext({ resources: mapped }, resources);
  const recipe = validateAssetRecipe(v.recipe, context), rig = validateMotionRig(v.rig, recipe), plan = validateMotionPlan(v.plan, rig, recipe);
  const movementMaskResourceId = v.movementMaskResourceId === null ? null : id(v.movementMaskResourceId, 'Vùng chuyển động rig');
  if (movementMaskResourceId) {
    const mask = Object.hasOwn(resources, movementMaskResourceId) ? resources[movementMaskResourceId] : undefined;
    if (!mask || mask.kind !== 'mask' || mask.w !== recipe.canvas.w || mask.h !== recipe.canvas.h) fail('Vùng chuyển động rig', 'thiếu mask đúng canvas.');
  }
  const seen = new Set<string>(), frozenFrames = arr(v.frozenFrames, 0, recipe.frames.length, 'Frame khóa của rig').map(raw => {
    const f = obj(raw, ['frameId', 'sourceFrameId'], 'Frame khóa của rig'), frameId = id(f.frameId, 'ID frame khóa rig');
    if (seen.has(frameId) || !recipe.frames.some(f => f.id === frameId)) fail('Frame khóa của rig', 'trùng hoặc không có trong clip.'); seen.add(frameId);
    return { frameId, sourceFrameId: id(f.sourceFrameId, 'Frame nguồn khóa rig') };
  });
  // Source assets may later change or disappear; keep the draft and require refresh/review.
  return { version: 1, id: id(v.id, 'ID nháp rig'), name: name(v.name, 'Tên nháp rig'), origin: { assetId: id(o.assetId, 'Asset gốc rig'), frameId: id(o.frameId, 'Frame gốc rig') }, recipe, rig, plan, resources: mapped, movementMaskResourceId, frozenFrames };
}
export function validateRigDraftMap(value: unknown, resources: Record<string, StudioResource> = {}): Record<string, RigDraft> {
  const entries = obj(value, Object.keys(value as object ?? {}), 'Kho nháp rig');
  if (Object.keys(entries).length > MAX_RIG_DRAFTS) fail('Kho nháp rig', 'tối đa20 bản nháp.');
  const out: Record<string, RigDraft> = {};
  for (const [key, raw] of Object.entries(entries)) {
    id(key, 'ID nháp rig'); const draft = validateRigDraft(raw, resources);
    if (draft.id !== key) fail('Kho nháp rig', 'ID không khớp.'); out[key] = draft;
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > 5_000_000) fail('Kho nháp rig', 'vượt5MB dữ liệu cấu trúc.');
  return out;
}
