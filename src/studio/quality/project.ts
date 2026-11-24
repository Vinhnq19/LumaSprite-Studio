import { dataObject as obj, dataArray as arr, dataId as id, dataNumber as num, invalidData as fail } from './data.ts';
import { validateAssetRecipe, type AssetRecipe } from './recipe.ts';
import { validateMotionRig, validateMotionPlan, type MotionRig, type MotionPlan } from './motion.ts';
import type { StudioResource } from '../resources.ts';
import { validateTemplateScope, type TemplateScope } from './template-scope.ts';

export interface QualityResourceBinding { id: string; resourceId: string }
/** Human-approved context. No authority is inferred from imported project IDs. */
export interface QualityProjectApproval {
  version: 1; id: string; projectId: string; revision: number; approvedAt: number; kind: 'static' | 'motion';
  source: { assetId: string; frameId: string; resourceId: string; rgbaSha256: string };
  recipe: AssetRecipe; rig: MotionRig | null; plan: MotionPlan | null;
  resources: { sources: QualityResourceBinding[]; masks: QualityResourceBinding[] };
  movementMaskResourceId: string | null;
  frozenFrames: { frameId: string; sourceFrameId: string; resourceId: string; rgbaSha256: string }[];
  templateScope?: TemplateScope;
}
export interface QualityProject { version: 1; approvals: Record<string, QualityProjectApproval> }
const hash = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('Hash chất lượng', 'không hợp lệ.'); return v as string; };

export function validateQualityProject(value: unknown, resources: Record<string, StudioResource> = {}): QualityProject {
  const v = obj(value, ['version', 'approvals'], 'Kho duyệt chất lượng'); if (v.version !== 1) fail('Kho duyệt chất lượng', 'phiên bản không hợp lệ.');
  const approvals = obj(v.approvals, Object.keys(v.approvals as object ?? {}), 'Danh sách duyệt');
  if (Object.keys(approvals).length > 20 || new TextEncoder().encode(JSON.stringify(v)).length > 5_000_000) fail('Kho duyệt chất lượng', 'tối đa 20 nguồn và 5 MB dữ liệu cấu trúc.');
  const out: QualityProject = { version: 1, approvals: {} };
  const resource = (key: unknown, kind: 'rgba' | 'mask') => {
    const keyId = id(key, 'Tài nguyên duyệt'), r = Object.hasOwn(resources, keyId) ? resources[keyId] : undefined;
    if (!r || r.kind !== kind) fail('Tài nguyên duyệt', 'thiếu hoặc sai loại.'); return { id: keyId, w: r!.w, h: r!.h };
  };
  for (const [key, raw] of Object.entries(approvals)) {
    const fields = ['version', 'id', 'projectId', 'revision', 'approvedAt', 'kind', 'source', 'recipe', 'rig', 'plan', 'resources', 'movementMaskResourceId', 'frozenFrames'];
    if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'templateScope')) fields.push('templateScope');
    id(key, 'ID duyệt'); const a = obj(raw, fields, 'Nguồn đã duyệt');
    if (a.version !== 1 || a.id !== key || !['static', 'motion'].includes(a.kind as string)) fail('Nguồn đã duyệt', 'ID/loại/phiên bản không hợp lệ.');
    const r = obj(a.resources, ['sources', 'masks'], 'Mapping nguồn duyệt');
    const bindings = (items: unknown, kind: 'rgba' | 'mask') => {
      const seen = new Set<string>();
      return arr(items, 0, 256, 'Mapping nguồn').map(raw => { const b = obj(raw, ['id', 'resourceId'], 'Mapping nguồn'); const name = id(b.id, 'ID mapping'); if (seen.has(name)) fail('Mapping nguồn', 'ID trùng.'); seen.add(name); return { id: name, resourceId: resource(b.resourceId, kind).id }; });
    };
    const mapped = { sources: bindings(r.sources, 'rgba'), masks: bindings(r.masks, 'mask') };
    const context = { sources: mapped.sources.map(b => ({ ...resource(b.resourceId, 'rgba'), id: b.id })), masks: mapped.masks.map(b => ({ ...resource(b.resourceId, 'mask'), id: b.id })) };
    const recipe = validateAssetRecipe(a.recipe, context), s = obj(a.source, ['assetId', 'frameId', 'resourceId', 'rgbaSha256'], 'Frame nguồn duyệt'), sr = resource(s.resourceId, 'rgba');
    if (sr.w !== recipe.canvas.w || sr.h !== recipe.canvas.h) fail('Frame nguồn duyệt', 'kích thước không khớp.');
    let rig: MotionRig | null = null, plan: MotionPlan | null = null;
    if (a.kind === 'motion') { rig = validateMotionRig(a.rig, recipe); plan = validateMotionPlan(a.plan, rig, recipe); }
    else if (a.rig !== null || a.plan !== null || recipe.frames.length !== 1 || a.movementMaskResourceId !== null) fail('Nguồn tĩnh', 'không tự suy ra rig hoặc animation.');
    const movementMaskResourceId = a.movementMaskResourceId === null ? null : resource(a.movementMaskResourceId, 'mask').id;
    if (movementMaskResourceId) { const m = resource(movementMaskResourceId, 'mask'); if (m.w !== recipe.canvas.w || m.h !== recipe.canvas.h) fail('Mask chuyển động', 'sai canvas.'); }
    const seen = new Set<string>();
    const frozenFrames = arr(a.frozenFrames, 0, recipe.frames.length, 'Frame khóa đã duyệt').map(raw => {
      const f = obj(raw, ['frameId', 'sourceFrameId', 'resourceId', 'rgbaSha256'], 'Frame khóa đã duyệt'), frameId = id(f.frameId, 'ID frame khóa'), r = resource(f.resourceId, 'rgba');
      if (seen.has(frameId) || !recipe.frames.some(k => k.id === frameId) || r.w !== recipe.canvas.w || r.h !== recipe.canvas.h || a.kind !== 'motion') fail('Frame khóa đã duyệt', 'ID/kích thước/loại không hợp lệ.'); seen.add(frameId);
      return { frameId, sourceFrameId: id(f.sourceFrameId, 'Frame nguồn khóa'), resourceId: r.id, rgbaSha256: hash(f.rgbaSha256) };
    });
    if (a.templateScope !== undefined && a.kind !== 'static') fail('Nguồn đã duyệt', 'phạm vi chỉnh từ mẫu cần nguồn tĩnh.');
    const templateScope = a.templateScope === undefined ? undefined : validateTemplateScope(a.templateScope, recipe);
    out.approvals[key] = { version: 1, id: key, projectId: id(a.projectId, 'Dự án duyệt'), revision: num(a.revision, 1, Number.MAX_SAFE_INTEGER, 'Revision duyệt', true), approvedAt: num(a.approvedAt, 0, Number.MAX_SAFE_INTEGER, 'Thời gian duyệt', true), kind: a.kind as 'static' | 'motion', source: { assetId: id(s.assetId, 'Asset nguồn'), frameId: id(s.frameId, 'Frame nguồn'), resourceId: sr.id, rgbaSha256: hash(s.rgbaSha256) }, recipe, rig, plan, resources: mapped, movementMaskResourceId, frozenFrames, ...(templateScope ? { templateScope } : {}) };
  }
  return out;
}
