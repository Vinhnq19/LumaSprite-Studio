import { validateAssetRecipe, type AssetRecipe, type RecipePaintOp, type RecipePoint } from './recipe.ts';

function translatePaint(op: RecipePaintOp, dx: number, dy: number): RecipePaintOp {
  switch (op.kind) {
    case 'rect':
      return { ...op, x: op.x + dx, y: op.y + dy };
    case 'line':
      return { ...op, x0: op.x0 + dx, x1: op.x1 + dx, y0: op.y0 + dy, y1: op.y1 + dy };
    case 'polygon':
      return { ...op, points: op.points.map(({ x, y }) => ({ x: x + dx, y: y + dy })) };
    case 'pixels':
      return 'rows' in op
        ? { ...op, x: op.x + dx, y: op.y + dy }
        : { ...op, pixels: op.pixels.map(pixel => ({ ...pixel, x: pixel.x + dx, y: pixel.y + dy })) };
    default:
      throw new Error('Lắp bộ phận chỉ nhận nét vẽ trên lưới gốc.');
  }
}

function nativePoint({ x, y }: RecipePoint): RecipePoint {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error('Điểm gắn cần tọa độ pixel nguyên.');
  }
  return { x, y };
}

/** Compile editable, static parts. The drawing order stays independent of attachment order. */
export function assembleCharacter(recipe: AssetRecipe, attachments: ReadonlyMap<string, RecipePoint>): AssetRecipe {
  if (recipe.frames.length !== 1 || recipe.frames[0].poses.length || recipe.frames[0].pixelEdits?.length) {
    throw new Error('Lắp bộ phận cần một frame tĩnh.');
  }
  const byId = new Map(recipe.parts.map(part => [part.id, part]));
  if (byId.size !== recipe.parts.length || attachments.size !== byId.size) {
    throw new Error('Mỗi bộ phận cần đúng một điểm gắn.');
  }
  const offsets = new Map<string, RecipePoint>();
  const visiting = new Set<string>();
  function offsetFor(id: string): RecipePoint {
    const existing = offsets.get(id);
    if (existing) return existing;
    if (visiting.has(id)) throw new Error('Điểm gắn bộ phận tạo thành vòng.');
    const part = byId.get(id);
    const socket = attachments.get(id);
    if (!part || !socket) throw new Error(`Thiếu điểm gắn của bộ phận ${id}.`);
    visiting.add(id);
    const parent = part.parentId === null ? { x: 0, y: 0 } : offsetFor(part.parentId);
    const at = nativePoint(socket);
    const anchor = nativePoint(part.pivot);
    const offset = { x: parent.x + at.x - anchor.x, y: parent.y + at.y - anchor.y };
    visiting.delete(id);
    offsets.set(id, offset);
    return offset;
  }
  const parts = recipe.parts.map(part => {
    const { x: dx, y: dy } = offsetFor(part.id);
    const { x, y } = part.pivot;
    return {
      ...part,
      pivot: { x: x + dx, y: y + dy },
      paint: part.paint.map(op => translatePaint(op, dx, dy)),
    };
  });
  return validateAssetRecipe({ ...recipe, parts });
}
