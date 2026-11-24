import { MAX_PIXEL_ROW_SIDE, MAX_RECIPE_PARTS, MAX_RECIPE_FRAMES, MAX_RECIPE_OPERATIONS, validateAssetRecipe, type AssetRecipe, type RecipeContext, type RecipeMaterial, type RecipePart, type RecipePaintOp, type RecipePixelEdit } from './recipe.ts';
import { dataObject as obj, dataArray as arr, dataId as id, dataUnique as unique, invalidData as fail } from './data.ts';
import type { QualityRole } from './run.ts';

export interface QualityDirector {
  version: 1; description: string; materials: RecipeMaterial[]; parts: Omit<RecipePart, 'paint'>[];
  allowedOperations: RecipePaintOp['kind'][];
  construction?: { partId: string; paint: RecipePaintOp[] }[];
}
export interface QualityBuilder { version: 1; description: string; recipe: AssetRecipe }
export interface QualityReview { version: 1; description: string; decision: 'keep' | 'patch'; recipe: AssetRecipe; patchedParts: string[]; patchedFrames: string[] }
const operations = ['rect', 'line', 'polygon', 'pixels', 'raster'] as const;
function description(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('Mô tả chất lượng', 'cần 1–4000 ký tự hợp lệ.');
  return value.trim();
}
const partStructure = (recipe: AssetRecipe) => recipe.parts.map(({ paint: _, ...p }) => p);
const header = (recipe: AssetRecipe) => ({ name: recipe.name, canvas: recipe.canvas, palette: recipe.palette, pivot: recipe.pivot, frames: recipe.frames.map(({ poses: _, pixelEdits: __, ...f }) => f), loop: recipe.loop });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validateQualityDirector(value: unknown, base: AssetRecipe, context: RecipeContext, locked: boolean): QualityDirector {
  const compact = locked && !!value && typeof value === 'object' && !Object.hasOwn(value, 'parts') && !Object.hasOwn(value, 'materials');
  const fields = compact ? ['version', 'description', 'allowedOperations'] : ['version', 'description', 'materials', 'parts', 'allowedOperations'];
  const p = obj(value, fields, 'Chỉ đạo chất lượng');
  if (p.version !== 1) fail('Chỉ đạo chất lượng', 'phiên bản không hợp lệ.');
  const parts = arr(compact ? partStructure(base) : p.parts, 1, 64, 'Bộ phận chỉ đạo').map(v => {
    const part = obj(v, ['id', 'name', 'parentId', 'pivot', 'origin', 'materialIds'], 'Bộ phận chỉ đạo');
    return { ...part, paint: [] };
  });
  const checked = validateAssetRecipe({ ...base, materials: compact ? base.materials : p.materials, parts, frames: base.frames.map(f => ({ ...f, poses: [] })) }, context);
  if (locked && (!equal(partStructure(checked), partStructure(base)) || !equal(checked.materials, base.materials))) fail('Chỉ đạo chất lượng', 'không được thay cấu trúc/vật liệu nguồn đã duyệt.');
  const allowedOperations = unique(arr(p.allowedOperations, 1, operations.length, 'Lệnh được phép').map(v => {
    if (!operations.includes(v as RecipePaintOp['kind'])) fail('Chỉ đạo chất lượng', 'lệnh vẽ không được hỗ trợ.');
    return v as RecipePaintOp['kind'];
  }), 'Lệnh được phép');
  return { version: 1, description: description(p.description), materials: checked.materials, parts: partStructure(checked), allowedOperations };
}
export function validateQualityBuilder(value: unknown, base: AssetRecipe, director: QualityDirector, context: RecipeContext): QualityBuilder {
  const p = obj(value, ['version', 'description', 'recipe'], 'Đề xuất chất lượng');
  if (p.version !== 1) fail('Đề xuất chất lượng', 'phiên bản không hợp lệ.');
  const recipe = validateAssetRecipe(p.recipe, context);
  const actual = header(recipe), expected = header(base);
  if (!equal(actual, expected)) {
    const labels = { name: 'tên', canvas: 'kích thước', palette: 'palette', pivot: 'pivot', frames: 'frame/timing', loop: 'loop' };
    const changed = (Object.keys(labels) as (keyof typeof labels)[]).filter(key => !equal(actual[key], expected[key]));
    fail('Đề xuất chất lượng', `${changed.map(key => labels[key]).join(', ')} khác cấu hình đã chốt.`);
  }
  if (!equal(partStructure(recipe), director.parts) || !equal(recipe.materials, director.materials)) fail('Đề xuất chất lượng', 'bộ phận/vật liệu không khớp chỉ đạo.');
  const restrictedPaint = (parts: RecipePart[]) => {
    const byPart = new Map<string, RecipePaintOp[]>();
    for (const part of parts) {
      const restricted = part.paint.filter(op => !director.allowedOperations.includes(op.kind));
      if (restricted.length) byPart.set(part.id, restricted);
    }
    return byPart;
  };
  const before = restrictedPaint(base.parts), after = restrictedPaint(recipe.parts);
  // Existing restricted paint can carry through, but only verbatim in the same part.
  if (before.size !== after.size || [...before].some(([id, paint]) => !equal(paint, after.get(id)))) {
    fail('Đề xuất chất lượng', 'dùng thao tác ngoài chỉ đạo: phải giữ nguyên lệnh ngoài phạm vi trong từng bộ phận.');
  }
  if (!director.allowedOperations.includes('pixels') && recipe.frames.some(f => !equal(f.pixelEdits, base.frames.find(b => b.id === f.id)?.pixelEdits))) fail('Đề xuất chất lượng', 'sửa điểm ảnh không được phép.');
  return { version: 1, description: description(p.description), recipe };
}
/**
 * Reviewer may replace paint on up to eight existing parts once, or replace per-frame pixel edits once;
 * no graph/frame/rig changes. Frame edits need the 'pixels' operation and are cross-checked by the builder.
 */
export function validateQualityReview(value: unknown, base: AssetRecipe, director: QualityDirector, candidate: AssetRecipe, context: RecipeContext, patchLimit = 8): QualityReview {
  const p = obj(value, ['version', 'description', 'decision', 'patches'], 'Kiểm tra mỹ thuật');
  if (p.version !== 1 || (p.decision !== 'keep' && p.decision !== 'patch')) fail('Kiểm tra mỹ thuật', 'phiên bản/quyết định không hợp lệ.');
  const patches = arr(p.patches, p.decision === 'keep' ? 0 : 1, p.decision === 'keep' ? 0 : patchLimit, 'Sửa có mục tiêu');
  const recipe = structuredClone(candidate), patchedParts: string[] = [], patchedFrames: string[] = [];
  for (const raw of patches) {
    if (raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'frameId')) {
      const patch = obj(raw, ['frameId', 'pixelEdits'], 'Sửa frame'), frameId = id(patch.frameId, 'ID frame sửa');
      const frame = recipe.frames.find(frame => frame.id === frameId);
      if (!frame || patchedFrames.includes(frameId)) fail('Kiểm tra mỹ thuật', 'frame không tồn tại hoặc bị sửa lặp.');
      if (!director.allowedOperations.includes('pixels')) fail('Kiểm tra mỹ thuật', 'sửa điểm ảnh ngoài chỉ đạo.');
      frame.pixelEdits = patch.pixelEdits as RecipePixelEdit[]; patchedFrames.push(frameId);
      continue;
    }
    const patch = obj(raw, ['partId', 'paint'], 'Sửa bộ phận'), partId = id(patch.partId, 'ID bộ phận sửa');
    const part = recipe.parts.find(part => part.id === partId);
    if (!part || patchedParts.includes(partId)) fail('Kiểm tra mỹ thuật', 'bộ phận không tồn tại hoặc bị sửa lặp.');
    part.paint = patch.paint as RecipePaintOp[]; patchedParts.push(partId);
  }
  const validated = validateQualityBuilder({ version: 1, description: p.description, recipe }, base, director, context);
  return { version: 1, description: validated.description, decision: p.decision, recipe: validated.recipe, patchedParts, patchedFrames };
}

type Schema = Record<string, unknown>;
const objectSchema = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arraySchema = (items: Schema, maxItems: number): Schema => ({ type: 'array', items, maxItems });
const number: Schema = { type: 'number' }, integer: Schema = { type: 'integer' }, bool: Schema = { type: 'boolean' };
const identifier: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' }, text: Schema = { type: 'string', minLength: 1, maxLength: 100 };
const nullableId: Schema = { anyOf: [identifier, { type: 'null' }] }, color: Schema = { anyOf: [{ type: 'integer', minimum: 0, maximum: 255 }, { type: 'null' }] };
const point = objectSchema({ x: number, y: number }), rect = objectSchema({ x: integer, y: integer, w: integer, h: integer });
const paintSchemas: Record<RecipePaintOp['kind'], Schema> = {
  rect: objectSchema({ kind: { const: 'rect', type: 'string' }, x: integer, y: integer, w: integer, h: integer, color }),
  line: objectSchema({ kind: { const: 'line', type: 'string' }, x0: integer, y0: integer, x1: integer, y1: integer, color }),
  polygon: objectSchema({ kind: { const: 'polygon', type: 'string' }, points: arraySchema(point, 128), color }),
  pixels: objectSchema({ kind: { const: 'pixels', type: 'string' }, pixels: arraySchema(objectSchema({ x: integer, y: integer, color }), 8192) }),
  raster: objectSchema({ kind: { const: 'raster', type: 'string' }, sourceId: identifier, sourceRect: rect, x: integer, y: integer, maskId: nullableId }),
};
const pixelRows = objectSchema({ kind: { const: 'pixels', type: 'string' }, x: { type: 'integer', minimum: 0, maximum: MAX_PIXEL_ROW_SIDE - 1 }, y: { type: 'integer', minimum: 0, maximum: MAX_PIXEL_ROW_SIDE - 1 },
  rows: { ...arraySchema({ type: 'string', pattern: `^[.0-9a-f]{1,${MAX_PIXEL_ROW_SIDE}}$` }, MAX_PIXEL_ROW_SIDE), minItems: 1,
    description: 'Each 0–f symbol paints one palette index, and . leaves the prior pixel unchanged. Trailing dots may be omitted. The widest row and all rows must fit on the canvas.' } });
const paintAlternatives = operations.map(op => paintSchemas[op]);
const paint: Schema = { anyOf: paintAlternatives };
const part = { id: identifier, name: text, parentId: nullableId, pivot: point, origin: { type: 'string', enum: ['visible', 'authored', 'derived'] }, materialIds: arraySchema(identifier, 64) };
/** Static 0..255 bound only steers the provider; runtime palette-length validation stays authoritative. */
const paletteIndex: Schema = { type: 'integer', minimum: 0, maximum: 255, description: 'Zero-based palette index in 0..palette.length-1; never a raw RGBA color value such as 521413887.' };
const materials = arraySchema(objectSchema({ id: identifier, name: text, colors: arraySchema(paletteIndex, 256) }), 64);
const version: Schema = { type: 'integer', const: 1 }, desc: Schema = { type: 'string', minLength: 1, maxLength: 4000 };
const frameProps = { id: identifier, durationMs: integer, poses: arraySchema(objectSchema({ partId: identifier, dx: number, dy: number, rotation: number, z: integer, visible: bool }), 64) };
const pixelEdits = arraySchema(objectSchema({ x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, color }), 8192);
const recipeSchema = (blankStaticOperations?: readonly RecipePaintOp['kind'][], compactPixelRows = false): Schema => {
  const allowedPaint = blankStaticOperations ? { anyOf: [...blankStaticOperations.map(op => paintSchemas[op]), ...(compactPixelRows ? [pixelRows] : [])] } : paint;
  const frame = !blankStaticOperations || blankStaticOperations.includes('pixels')
    ? { anyOf: [objectSchema(frameProps), objectSchema({ ...frameProps, pixelEdits })] } : objectSchema(frameProps);
  return objectSchema({ version, name: text, canvas: objectSchema({ w: integer, h: integer }), palette: arraySchema(integer, 256), pivot: point, materials,
    parts: arraySchema(objectSchema({ ...part, paint: arraySchema(allowedPaint, 4096) }), 64),
    frames: arraySchema(frame, blankStaticOperations ? 1 : 600), loop: bool });
};

/** The blank-character builder sends only paint. Studio owns the approved part order and recipe header. */
function characterPaintLayers(allowed: readonly RecipePaintOp['kind'][], compactPixelRows: boolean): Schema {
  const choices = allowed.filter(op => op !== 'raster').map(op => op === 'polygon'
    ? objectSchema({ kind: { const: 'polygon', type: 'string' }, points: { ...arraySchema(point, 128), minItems: 3 }, color })
    : paintSchemas[op]);
  if (compactPixelRows && allowed.includes('pixels')) choices.push(pixelRows);
  return { ...arraySchema(objectSchema({ partId: identifier, paint: arraySchema({ anyOf: choices }, MAX_RECIPE_OPERATIONS) }), MAX_RECIPE_PARTS), minItems: 1 };
}
export function qualityCharacterResponseSchema(allowed: readonly RecipePaintOp['kind'][], compactPixelRows: boolean): Schema {
  return structuredClone(objectSchema({ version, description: desc, parts: characterPaintLayers(allowed, compactPixelRows) }));
}
export const MAX_CHARACTER_COMMAND_LENGTH = MAX_PIXEL_ROW_SIDE * (MAX_PIXEL_ROW_SIDE + 1) + 16;
export const MAX_LARGE_CHARACTER_CLUSTER_SIDE = 16;
export const MAX_CHARACTER_TOUCHUP_COMMANDS = 24;
const characterCommand = { type: 'string', minLength: 1, maxLength: MAX_CHARACTER_COMMAND_LENGTH };
export function qualityCharacterConstructionSchema(): Schema {
  const direct = ['rect', 'line', 'polygon', 'pixels'] as const;
  const constructionPart = objectSchema({ id: identifier, parentId: nullableId, pivot: point, materialIds: part.materialIds });
  return structuredClone(objectSchema({ version, description: desc, materials, parts: arraySchema(constructionPart, MAX_RECIPE_PARTS),
    allowedOperations: arraySchema({ type: 'string', enum: [...direct] }, direct.length),
    construction: arraySchema(objectSchema({ partId: identifier,
      commands: arraySchema(characterCommand, MAX_RECIPE_OPERATIONS),
    }), MAX_RECIPE_PARTS),
  }));
}
export function qualityCharacterFinishSchema(): Schema {
  return objectSchema({ finish: { type: 'string', enum: ['A', 'B', 'C'] } });
}

/** Runtime validation remains authoritative for cross-references, palette membership and budgets. */
export function qualityResponseSchema(role: QualityRole, blankStaticOperations?: readonly RecipePaintOp['kind'][], compactPixelRows = false, approvedMotion = false, characterTouchups = false): Schema {
  const schema = role === 'director'
    ? objectSchema({ version, description: desc, ...(approvedMotion ? {} : { materials, parts: arraySchema(objectSchema(part), 64) }), allowedOperations: arraySchema({ type: 'string', enum: [...operations] }, 5) })
    : role === 'builder' && !approvedMotion ? objectSchema({ version, description: desc, recipe: recipeSchema(blankStaticOperations, compactPixelRows && !!blankStaticOperations?.includes('pixels')) })
      : objectSchema({ version, description: desc, decision: { type: 'string', enum: ['keep', 'patch'] }, patches: arraySchema({ anyOf: [
        objectSchema({ partId: identifier, paint: arraySchema(compactPixelRows ? { anyOf: [...paintAlternatives, pixelRows] } : paint, 4096) }), objectSchema({ frameId: identifier, pixelEdits }),
        ...(role === 'reviewer' && characterTouchups ? [
          objectSchema({ partId: identifier, touchups: { ...arraySchema(characterCommand, MAX_CHARACTER_TOUCHUP_COMMANDS), minItems: 1 } }),
          objectSchema({ partId: identifier, shift: objectSchema({ x: integer, y: integer }) }),
        ] : []),
      ] }, role === 'builder' ? MAX_RECIPE_PARTS + MAX_RECIPE_FRAMES : 8) });
  return structuredClone(schema);
}
