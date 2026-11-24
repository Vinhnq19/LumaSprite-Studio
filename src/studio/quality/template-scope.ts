import { dataArray, dataId, dataNumber, dataObject, dataUnique, invalidData } from './data.ts';
import type { AssetRecipe, RecipeRect } from './recipe.ts';

export interface TemplateScope { partIds: string[]; region: RecipeRect }

export function validateTemplateScope(value: unknown, recipe: AssetRecipe): TemplateScope {
  const label = 'Phạm vi chỉnh từ mẫu';
  const scope = dataObject(value, ['partIds', 'region'], label);
  if (recipe.frames.length !== 1 || recipe.frames[0].poses.length) invalidData(label, 'cần một frame tĩnh.');
  const partIds = dataUnique(dataArray(scope.partIds, 1, 8, label).map(id => dataId(id, label)), label);
  if (partIds.some(id => !recipe.parts.some(part => part.id === id))) invalidData(label, 'layer được chọn không có trong nguồn.');
  const r = dataObject(scope.region, ['x', 'y', 'w', 'h'], label), { w, h } = recipe.canvas;
  const x = dataNumber(r.x, 0, w - 1, label, true), y = dataNumber(r.y, 0, h - 1, label, true);
  return { partIds, region: { x, y, w: dataNumber(r.w, 1, w - x, label, true), h: dataNumber(r.h, 1, h - y, label, true) } };
}
