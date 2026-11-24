import { isDeepStrictEqual } from 'node:util';
import type { AssetRecipe } from '../../studio/quality/recipe.ts';
import { createRecipeRenderer, type RecipeResources } from '../../studio/quality/renderer.ts';
import type { TemplateScope } from '../../studio/quality/template-scope.ts';

export function verifyTemplateCandidate(base: AssetRecipe, candidate: AssetRecipe, resources: RecipeResources, scope: TemplateScope): void {
  const partsWithoutPaint = (recipe: AssetRecipe) => ({ ...recipe, parts: recipe.parts.map(({ paint: _, ...part }) => part) });
  if (!isDeepStrictEqual(partsWithoutPaint(base), partsWithoutPaint(candidate))) throw new Error('Chỉnh từ mẫu phải giữ cấu trúc layer và dữ liệu frame.');
  const selected = new Set(scope.partIds);
  for (const [i, part] of base.parts.entries()) {
    if (!selected.has(part.id) && !isDeepStrictEqual(part.paint, candidate.parts[i].paint)) throw new Error('Đề xuất sửa layer chưa được chọn.');
  }
  const frameId = base.frames[0].id, { x, y, w, h } = scope.region, width = base.canvas.w;
  const outside = (i: number) => i % width < x || i % width >= x + w || Math.floor(i / width) < y || Math.floor(i / width) >= y + h;
  const before = createRecipeRenderer(base, resources), after = createRecipeRenderer(candidate, resources);
  const protectedPixels = new Uint8Array(width * base.canvas.h);
  // Static template layers are opaque or transparent and ordered bottom to top.
  for (const { id } of base.parts) {
    const previous = before.staticPartPixels(id), editable = selected.has(id);
    if (editable) {
      const updated = after.staticPartPixels(id);
      if (previous.some((color, i) => color !== updated[i] && outside(i))) throw new Error('Đề xuất sửa pixel layer ngoài vùng cho phép.');
    }
    previous.forEach((color, i) => { if (color & 255) protectedPixels[i] = editable ? 0 : 1; });
  }
  const original = before.renderFrame(frameId).image.data;
  const painted = after.renderFrame(frameId).image.data;
  if (original.some((color, i) => color !== painted[i] && outside(i))) throw new Error('Đề xuất sửa pixel ngoài vùng cho phép.');
  if (original.some((color, i) => protectedPixels[i] && color !== painted[i])) throw new Error('Đề xuất che hoặc đổi pixel của layer được bảo vệ.');
  if (!original.some((color, i) => color !== painted[i])) throw new Error('Đề xuất chưa thay đổi pixel nhìn thấy của mẫu.');
}
