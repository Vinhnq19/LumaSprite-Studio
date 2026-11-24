import { Img } from '../../core/image.ts';
import { PIXEL_ROW_SYMBOLS, validateAssetRecipe, type AssetRecipe, type RecipePaintOp } from './recipe.ts';
import { IDENTITY, multiply, point, localMatrix } from './affine.ts';

export interface RecipeSourcePixels { id: string; w: number; h: number; pixels: Uint32Array }
export interface RecipeMaskPixels { id: string; w: number; h: number; data: Uint8Array }
export interface RecipeResources { sources: readonly RecipeSourcePixels[]; masks: readonly RecipeMaskPixels[] }
export interface RecipeRenderedFrame {
  image: Img; frameId: string; durationMs: number; loop: boolean; pivot: { x: number; y: number };
}
export interface RecipeRenderer {
  getRecipe(): AssetRecipe;
  renderFrame(frameId: string): RecipeRenderedFrame;
  staticPartPixels(partId: string): Uint32Array;
}

export const MAX_RECIPE_RENDER_PIXELS = 32_000_000;
export const MAX_RECIPE_PAINT_WORK = 64_000_000;
import type { Matrix } from './affine.ts';
type Bounds = { x0: number; y0: number; x1: number; y1: number };
type PartRaster = { pixels: Uint32Array; bounds: Bounds | null };
function fail(message: string): never { throw new Error(`Dựng asset: ${message}`); }

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1) fail(`${label} phải là mảng đầy đủ, tối đa 4096 phần tử.`);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !('value' in d)) fail(`${label} có phần tử thưa hoặc getter.`);
  }
  return value;
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} không hợp lệ.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(k => typeof k !== 'string' || !keys.includes(k)) || keys.some(k => !descriptors[k] || !('value' in descriptors[k]))) fail(`${label} có thuộc tính thiếu hoặc không hỗ trợ.`);
  return value as Record<string, unknown>;
}

function work(op: RecipePaintOp): number {
  switch (op.kind) {
    case 'rect': return op.w * op.h;
    case 'raster': return op.sourceRect.w * op.sourceRect.h;
    case 'line': return Math.max(Math.abs(op.x1 - op.x0), Math.abs(op.y1 - op.y0)) + 1;
    case 'pixels': return 'rows' in op ? op.rows[0].length * op.rows.length : op.pixels.length;
    case 'polygon': {
      const xs = op.points.map(p => p.x), ys = op.points.map(p => p.y);
      const w = Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs));
      const h = Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys));
      return w * h + h * op.points.length;
    }
  }
}

/** Compile one immutable snapshot. Frame buffers are created on demand, never cached here. */
export function createRecipeRenderer(value: unknown, resources: RecipeResources = { sources: [], masks: [] }): RecipeRenderer {
  const resourceObject = object(resources, ['sources', 'masks'], 'Nguồn dựng');
  const rawSources = list(resourceObject.sources, 'Nguồn ảnh').map((s, i) => object(s, ['id', 'w', 'h', 'pixels'], `Nguồn ảnh ${i + 1}`));
  const rawMasks = list(resourceObject.masks, 'Mask').map((m, i) => object(m, ['id', 'w', 'h', 'data'], `Mask ${i + 1}`));
  const context = {
    sources: rawSources.map(s => ({ id: s.id as string, w: s.w as number, h: s.h as number })),
    masks: rawMasks.map(m => ({ id: m.id as string, w: m.w as number, h: m.h as number })),
  };
  const recipe = validateAssetRecipe(value, context);
  const { w, h } = recipe.canvas;
  const area = w * h;
  const retainedPixels = area * (recipe.parts.length + 1) + [...context.sources, ...context.masks].reduce((n, d) => n + d.w * d.h, 0);
  if (retainedPixels > MAX_RECIPE_RENDER_PIXELS) fail('Nguồn, mask và các lớp vượt ngân sách 32 triệu pixel.');
  if (recipe.parts.reduce((n, p) => n + p.paint.reduce((a, op) => a + work(op), 0), 0) + recipe.frames.reduce((n, f) => n + (f.pixelEdits?.length ?? 0), 0) > MAX_RECIPE_PAINT_WORK) fail('Các lệnh vẽ vượt ngân sách xử lý; hãy giảm thao tác chồng lặp.');
  const sources = new Map<string, RecipeSourcePixels>();
  const masks = new Map<string, RecipeMaskPixels>();
  for (const s of rawSources) {
    if (!(s.pixels instanceof Uint32Array) || s.pixels.length !== (s.w as number) * (s.h as number)) fail(`Dữ liệu nguồn ${s.id} sai kích thước hoặc định dạng.`);
    sources.set(s.id as string, { id: s.id as string, w: s.w as number, h: s.h as number, pixels: s.pixels.slice() });
  }
  for (const m of rawMasks) {
    if (!(m.data instanceof Uint8Array) || m.data.length !== (m.w as number) * (m.h as number) || m.data.some(v => v !== 0 && v !== 1)) fail(`Dữ liệu mask ${m.id} phải gồm 0/1 đúng kích thước.`);
    masks.set(m.id as string, { id: m.id as string, w: m.w as number, h: m.h as number, data: m.data.slice() });
  }
  const palette = new Set(recipe.palette);
  const rasters: PartRaster[] = recipe.parts.map(part => {
    const pixels = new Uint32Array(area);
    const set = (x: number, y: number, index: number | null) => { pixels[y * w + x] = index === null ? 0 : recipe.palette[index]; };
    for (const op of part.paint) {
      switch (op.kind) {
        case 'rect':
          for (let y = op.y; y < op.y + op.h; y++) pixels.fill(op.color === null ? 0 : recipe.palette[op.color], y * w + op.x, y * w + op.x + op.w);
          break;
        case 'pixels':
          if ('rows' in op) {
            for (const [dy, row] of op.rows.entries()) for (let dx = 0; dx < row.length; dx++) {
              if (row[dx] !== '.') set(op.x + dx, op.y + dy, PIXEL_ROW_SYMBOLS.indexOf(row[dx]));
            }
          } else for (const p of op.pixels) set(p.x, p.y, p.color);
          break;
        case 'line': {
          let x = op.x0, y = op.y0;
          const dx = Math.abs(op.x1 - x), dy = -Math.abs(op.y1 - y), sx = x < op.x1 ? 1 : -1, sy = y < op.y1 ? 1 : -1;
          let error = dx + dy;
          for (;;) {
            set(x, y, op.color);
            if (x === op.x1 && y === op.y1) break;
            const e2 = 2 * error;
            if (e2 >= dy) { error += dy; x += sx; }
            if (e2 <= dx) { error += dx; y += sy; }
          }
          break;
        }
        case 'polygon': {
          // Pixel centers, even-odd fill. Horizontal edges excluded, lower endpoint excluded.
          const y0 = Math.max(0, Math.floor(Math.min(...op.points.map(p => p.y))));
          const y1 = Math.min(h, Math.ceil(Math.max(...op.points.map(p => p.y))));
          for (let y = y0; y < y1; y++) {
            const scan = y + 0.5, cuts: number[] = [];
            for (let i = 0, j = op.points.length - 1; i < op.points.length; j = i++) {
              const a = op.points[j], b = op.points[i];
              if ((a.y <= scan && b.y > scan) || (b.y <= scan && a.y > scan)) cuts.push(a.x + (scan - a.y) * (b.x - a.x) / (b.y - a.y));
            }
            cuts.sort((a, b) => a - b);
            for (let i = 0; i + 1 < cuts.length; i += 2) for (let x = Math.max(0, Math.ceil(cuts[i] - 0.5)); x < Math.min(w, Math.ceil(cuts[i + 1] - 0.5)); x++) set(x, y, op.color);
          }
          break;
        }
        case 'raster': {
          const source = sources.get(op.sourceId)!, mask = op.maskId === null ? undefined : masks.get(op.maskId)!;
          for (let y = 0; y < op.sourceRect.h; y++) for (let x = 0; x < op.sourceRect.w; x++) {
            if (mask && !mask.data[y * op.sourceRect.w + x]) continue;
            const color = source.pixels[(op.sourceRect.y + y) * source.w + op.sourceRect.x + x];
            if ((color & 255) === 0) continue; // stamp semantics: transparent source leaves previous part paint intact
            if ((color & 255) !== 255 || !palette.has(color)) fail(`Nguồn ${op.sourceId} có pixel ngoài palette hoặc alpha bán trong suốt.`);
            pixels[(op.y + y) * w + op.x + x] = color;
          }
          break;
        }
      }
    }
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pixels[y * w + x]) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
    }
    return { pixels, bounds: x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null };
  });
  // Source snapshots are no longer needed after compilation; do not retain another image cache.
  sources.clear(); masks.clear();
  const partIndex = new Map(recipe.parts.map((p, i) => [p.id, i]));
  const frames = new Map(recipe.frames.map(f => [f.id, f]));
  return {
    getRecipe: () => structuredClone(recipe),
    staticPartPixels(partId: string): Uint32Array {
      const index = partIndex.get(partId);
      if (index === undefined || recipe.frames.length !== 1 || recipe.frames[0].poses.length || recipe.frames[0].pixelEdits?.length) fail('Chỉ lấy pixel từng lớp của frame tĩnh không có pose hoặc lớp chỉnh frame.');
      return rasters[index].pixels.slice();
    },
    renderFrame(frameId: string): RecipeRenderedFrame {
      const frame = frames.get(frameId);
      if (!frame) fail(`Không tìm thấy frame ${frameId}.`);
      const poses = new Map(frame.poses.map(p => [p.partId, p]));
      const matrices: (Matrix | undefined)[] = [], visibility: boolean[] = [];
      const resolve = (i: number): Matrix => {
        if (matrices[i]) return matrices[i]!;
        const part = recipe.parts[i], pose = poses.get(part.id);
        const parentIndex = part.parentId === null ? undefined : partIndex.get(part.parentId)!;
        const parent = parentIndex === undefined ? IDENTITY : resolve(parentIndex);
        visibility[i] = (parentIndex === undefined || visibility[parentIndex]) && (pose?.visible ?? true);
        return matrices[i] = multiply(parent, localMatrix(part.pivot, pose));
      };
      recipe.parts.forEach((_, i) => resolve(i));
      const order = recipe.parts.map((p, i) => ({ i, z: poses.get(p.id)?.z ?? i })).sort((a, b) => a.z - b.z || a.i - b.i);
      const image = new Img(w, h);
      for (const { i } of order) {
        const raster = rasters[i];
        if (!visibility[i] || !raster.bounds) continue;
        const m = matrices[i]!, { x0, y0, x1, y1 } = raster.bounds;
        const corners = [point(m, x0, y0), point(m, x1, y0), point(m, x0, y1), point(m, x1, y1)];
        const left = Math.floor(Math.min(...corners.map(p => p[0])) + 1e-9), right = Math.ceil(Math.max(...corners.map(p => p[0])) - 1e-9);
        const top = Math.floor(Math.min(...corners.map(p => p[1])) + 1e-9), bottom = Math.ceil(Math.max(...corners.map(p => p[1])) - 1e-9);
        // Rigid inverse: sample once at each destination pixel center. No scaling or interpolation.
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          const tx = x + 0.5 - m[4], ty = y + 0.5 - m[5];
          const sx = Math.floor(m[0] * tx + m[1] * ty + 1e-9), sy = Math.floor(m[2] * tx + m[3] * ty + 1e-9);
          if (sx < x0 || sx >= x1 || sy < y0 || sy >= y1) continue;
          const color = raster.pixels[sy * w + sx];
          if (!color) continue;
          if (x < 0 || y < 0 || x >= w || y >= h) fail(`Bộ phận ${recipe.parts[i].id} bị cắt ở frame ${frame.id}; cần sửa pose hoặc canvas.`);
          image.data[y * w + x] = color;
        }
      }
      for (const edit of frame.pixelEdits ?? []) image.data[edit.y * w + edit.x] = edit.color === null ? 0 : recipe.palette[edit.color];
      return { image, frameId: frame.id, durationMs: frame.durationMs, loop: recipe.loop, pivot: { ...recipe.pivot } };
    },
  };
}
