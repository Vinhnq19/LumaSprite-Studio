import { invalidData as fail, dataObject as obj, dataArray as arr, dataNumber as num, dataId as id, dataName as name, dataBoolean as bool, dataUnique as unique } from './data.ts';
/** Controlled data format for quality rendering. No executable fields or external paths. */
export interface RecipePoint { x: number; y: number }
export interface RecipeRect extends RecipePoint { w: number; h: number }
export interface RecipeMaterial { id: string; name: string; colors: number[] }
export const PIXEL_ROW_SYMBOLS = '0123456789abcdef';
export const MAX_PIXEL_ROW_SIDE = 64;
export type RecipePaintOp =
  | ({ kind: 'rect'; color: number | null } & RecipeRect)
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number; color: number | null }
  | { kind: 'polygon'; points: RecipePoint[]; color: number | null }
  | { kind: 'pixels'; pixels: (RecipePoint & { color: number | null })[] }
  | { kind: 'pixels'; x: number; y: number; rows: string[] }
  | { kind: 'raster'; sourceId: string; sourceRect: RecipeRect; x: number; y: number; maskId: string | null };
export interface RecipePart {
  id: string; name: string; parentId: string | null; pivot: RecipePoint;
  origin: 'visible' | 'authored' | 'derived'; materialIds: string[]; paint: RecipePaintOp[];
}
export interface RecipePose { partId: string; dx: number; dy: number; rotation: number; z: number; visible: boolean }
export interface RecipePixelEdit { x: number; y: number; color: number | null }
export interface RecipeFrame { id: string; durationMs: number; poses: RecipePose[]; pixelEdits?: RecipePixelEdit[] }
export interface AssetRecipe {
  version: 1; name: string; canvas: { w: number; h: number }; palette: number[];
  pivot: RecipePoint; materials: RecipeMaterial[]; parts: RecipePart[]; frames: RecipeFrame[]; loop: boolean;
}
export interface RecipeDescriptor { id: string; w: number; h: number }
export interface RecipeContext { sources: readonly RecipeDescriptor[]; masks: readonly RecipeDescriptor[] }
export const MAX_RECIPE_DIMENSION = 4096;
export const MAX_RECIPE_PARTS = 64;
export const MAX_RECIPE_FRAMES = 600;
export const MAX_RECIPE_OPERATIONS = 4096;
export const MAX_RECIPE_COORDINATES = 262_144;
export const MAX_RECIPE_DECODED_PIXELS = 32_000_000;
function descriptors(value: unknown, path: string): Map<string, RecipeDescriptor> {
  const entries = arr(value, 0, 4096, path).map((v, i): RecipeDescriptor => {
    const p = `${path}[${i}]`, d = obj(v, ['id', 'w', 'h'], p);
    return { id: id(d.id, p), w: num(d.w, 1, MAX_RECIPE_DIMENSION, p, true), h: num(d.h, 1, MAX_RECIPE_DIMENSION, p, true) };
  });
  unique(entries.map(e => e.id), path);
  return new Map(entries.map(e => [e.id, e]));
}

export function validateAssetRecipe(value: unknown, context: RecipeContext = { sources: [], masks: [] }): AssetRecipe {
  const c = obj(context, ['sources', 'masks'], 'Ngữ cảnh');
  const sources = descriptors(c.sources, 'Nguồn'), masks = descriptors(c.masks, 'Mask');
  const root = obj(value, ['version', 'name', 'canvas', 'palette', 'pivot', 'materials', 'parts', 'frames', 'loop'], 'AssetRecipe');
  if (root.version !== 1) fail('AssetRecipe.version', 'chỉ hỗ trợ phiên bản 1.');
  const canvas = obj(root.canvas, ['w', 'h'], 'Canvas');
  const w = num(canvas.w, 1, MAX_RECIPE_DIMENSION, 'Chiều rộng', true), h = num(canvas.h, 1, MAX_RECIPE_DIMENSION, 'Chiều cao', true);
  const palette = unique(arr(root.palette, 1, 256, 'Palette').map((v, i) => {
    const color = num(v, 0, 0xffffffff, `Palette[${i}]`, true);
    if ((color & 255) !== 255) fail('Palette', 'màu phải đục alpha 255; dùng null để xóa.');
    return color;
  }), 'Palette');
  const color = (v: unknown, path: string): number | null => v === null ? null : num(v, 0, palette.length - 1, path, true);
  const point = (v: unknown, path: string, centers = false): RecipePoint => {
    const p = obj(v, ['x', 'y'], path);
    return { x: num(p.x, 0, centers ? w - 1 : w, path, centers), y: num(p.y, 0, centers ? h - 1 : h, path, centers) };
  };
  const rect = (v: unknown, path: string, bw = w, bh = h): RecipeRect => {
    const p = obj(v, ['x', 'y', 'w', 'h'], path);
    const r = { x: num(p.x, 0, bw - 1, path, true), y: num(p.y, 0, bh - 1, path, true), w: num(p.w, 1, bw, path, true), h: num(p.h, 1, bh, path, true) };
    if (r.x + r.w > bw || r.y + r.h > bh) fail(path, 'hình chữ nhật vượt kích thước.');
    return r;
  };
  const materials = arr(root.materials, 0, 64, 'Vật liệu').map((v, i): RecipeMaterial => {
    const path = `Vật liệu[${i}]`, m = obj(v, ['id', 'name', 'colors'], path);
    return { id: id(m.id, path), name: name(m.name, path), colors: unique(arr(m.colors, 1, 256, path).map(v => num(v, 0, palette.length - 1, path, true)), path) };
  });
  const materialIds = new Set(unique(materials.map(m => m.id), 'ID vật liệu'));
  let operations = 0, coordinates = 0;
  const paint = (v: unknown, path: string): RecipePaintOp => {
    if (++operations > MAX_RECIPE_OPERATIONS) fail(path, 'vượt giới hạn thao tác.');
    if (!v || typeof v !== 'object') fail(path, 'lệnh vẽ không hợp lệ.');
    const kindDescriptor = Object.getOwnPropertyDescriptor(v, 'kind');
    if (!kindDescriptor || !('value' in kindDescriptor)) fail(path, 'thiếu loại lệnh vẽ.');
    switch (kindDescriptor.value) {
      case 'rect': {
        const p = obj(v, ['kind', 'x', 'y', 'w', 'h', 'color'], path);
        return { kind: 'rect', ...rect({ x: p.x, y: p.y, w: p.w, h: p.h }, path), color: color(p.color, path) };
      }
      case 'line': {
        const p = obj(v, ['kind', 'x0', 'y0', 'x1', 'y1', 'color'], path);
        return { kind: 'line', x0: num(p.x0, 0, w - 1, path, true), y0: num(p.y0, 0, h - 1, path, true), x1: num(p.x1, 0, w - 1, path, true), y1: num(p.y1, 0, h - 1, path, true), color: color(p.color, path) };
      }
      case 'polygon': {
        const p = obj(v, ['kind', 'points', 'color'], path), points = arr(p.points, 3, 128, path).map(v => point(v, path));
        coordinates += points.length;
        if (coordinates > MAX_RECIPE_COORDINATES) fail(path, 'vượt giới hạn tọa độ.');
        return { kind: 'polygon', points, color: color(p.color, path) };
      }
      case 'pixels': {
        if (Object.hasOwn(v, 'rows')) {
          if (w > MAX_PIXEL_ROW_SIDE || h > MAX_PIXEL_ROW_SIDE || palette.length > PIXEL_ROW_SYMBOLS.length) fail(path, 'hàng pixel chỉ dùng với canvas tối đa 64×64 và palette tối đa 16 màu.');
          const p = obj(v, ['kind', 'x', 'y', 'rows'], path);
          const x = num(p.x, 0, w - 1, path, true), y = num(p.y, 0, h - 1, path, true);
          let width = 0, painted = false;
          const rows = arr(p.rows, 1, h - y, path).map(row => {
            if (typeof row !== 'string' || row.length < 1 || row.length > w - x) fail(path, 'hàng pixel cần ít nhất một ký hiệu và phải nằm trong canvas.');
            width = Math.max(width, row.length);
            for (const symbol of row) {
              if (symbol === '.') continue;
              const index = PIXEL_ROW_SYMBOLS.indexOf(symbol);
              if (index < 0 || index >= palette.length) fail(path, 'ký hiệu hàng pixel phải là dấu chấm hoặc chỉ số palette 0–f hiện có.');
              painted = true;
            }
            return row;
          });
          if (!painted) fail(path, 'hàng pixel cần ít nhất một ô có màu.');
          coordinates += width * rows.length;
          if (coordinates > MAX_RECIPE_COORDINATES) fail(path, 'vượt giới hạn tọa độ.');
          return { kind: 'pixels', x, y, rows: rows.map(row => row.padEnd(width, '.')) };
        }
        const p = obj(v, ['kind', 'pixels'], path);
        const pixels = arr(p.pixels, 1, 8192, path).map(v => {
          const pixel = obj(v, ['x', 'y', 'color'], path);
          return { x: num(pixel.x, 0, w - 1, path, true), y: num(pixel.y, 0, h - 1, path, true), color: color(pixel.color, path) };
        });
        unique(pixels.map(p => p.y * w + p.x), path); coordinates += pixels.length;
        if (coordinates > MAX_RECIPE_COORDINATES) fail(path, 'vượt giới hạn tọa độ.');
        return { kind: 'pixels', pixels };
      }
      case 'raster': {
        const p = obj(v, ['kind', 'sourceId', 'sourceRect', 'x', 'y', 'maskId'], path), sourceId = id(p.sourceId, path);
        const source = sources.get(sourceId);
        if (!source) fail(path, 'nguồn raster không tồn tại.');
        const sourceRect = rect(p.sourceRect, path, source.w, source.h);
        const destination = rect({ x: p.x, y: p.y, w: sourceRect.w, h: sourceRect.h }, path);
        const maskId = p.maskId === null ? null : id(p.maskId, path);
        if (maskId !== null) {
          const mask = masks.get(maskId);
          if (!mask || mask.w !== sourceRect.w || mask.h !== sourceRect.h) fail(path, 'mask thiếu hoặc không khớp vùng nguồn.');
        }
        return { kind: 'raster', sourceId, sourceRect, x: destination.x, y: destination.y, maskId };
      }
      default: return fail(path, 'loại lệnh không được hỗ trợ.');
    }
  };
  const parts = arr(root.parts, 1, MAX_RECIPE_PARTS, 'Bộ phận').map((v, i): RecipePart => {
    const path = `Bộ phận[${i}]`, p = obj(v, ['id', 'name', 'parentId', 'pivot', 'origin', 'materialIds', 'paint'], path);
    if (!['visible', 'authored', 'derived'].includes(p.origin as string)) fail(path, 'nguồn gốc bộ phận không hợp lệ.');
    const refs = unique(arr(p.materialIds, 0, 64, path).map(v => id(v, path)), path);
    if (refs.some(ref => !materialIds.has(ref))) fail(path, 'tham chiếu vật liệu không tồn tại.');
    return { id: id(p.id, path), name: name(p.name, path), parentId: p.parentId === null ? null : id(p.parentId, path), pivot: point(p.pivot, path), origin: p.origin as RecipePart['origin'], materialIds: refs, paint: arr(p.paint, 0, MAX_RECIPE_OPERATIONS, path).map(v => paint(v, path)) };
  });
  if (coordinates > MAX_RECIPE_COORDINATES) fail('AssetRecipe', 'vượt giới hạn tọa độ.');
  if (w * h * (parts.length + 1) > MAX_RECIPE_DECODED_PIXELS) fail('AssetRecipe', 'vượt ngân sách 32 triệu pixel giải nén.');
  const partIds = new Set(unique(parts.map(p => p.id), 'ID bộ phận')), byId = new Map(parts.map(p => [p.id, p]));
  for (const part of parts) {
    const visited = new Set([part.id]);
    let parentId = part.parentId;
    while (parentId !== null) {
      if (!partIds.has(parentId)) fail(part.id, 'bộ phận cha không tồn tại.');
      if (visited.has(parentId)) fail(part.id, 'chu trình bộ phận cha.');
      visited.add(parentId); parentId = byId.get(parentId)!.parentId;
    }
  }
  const frames = arr(root.frames, 1, MAX_RECIPE_FRAMES, 'Frame').map((v, i): RecipeFrame => {
    const path = `Frame[${i}]`;
    const hasPixelEdits = !!v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'pixelEdits');
    const f = obj(v, hasPixelEdits ? ['id', 'durationMs', 'poses', 'pixelEdits'] : ['id', 'durationMs', 'poses'], path);
    const poses = arr(f.poses, 0, parts.length, path).map((v): RecipePose => {
      const p = obj(v, ['partId', 'dx', 'dy', 'rotation', 'z', 'visible'], path), partId = id(p.partId, path);
      if (!partIds.has(partId)) fail(path, 'pose tham chiếu bộ phận không tồn tại.');
      return { partId, dx: num(p.dx, -8192, 8192, path), dy: num(p.dy, -8192, 8192, path), rotation: num(p.rotation, -360, 360, path), z: num(p.z, -2048, 2048, path, true), visible: bool(p.visible, path) };
    });
    unique(poses.map(p => p.partId), path);
    const frame: RecipeFrame = { id: id(f.id, path), durationMs: num(f.durationMs, 1, 60000, path, true), poses };
    if (hasPixelEdits) {
      const rawEdits = arr(f.pixelEdits, 0, 8192, path);
      if (coordinates + rawEdits.length > MAX_RECIPE_COORDINATES) fail(path, 'vượt giới hạn tọa độ.');
      const pixelEdits = rawEdits.map((v): RecipePixelEdit => {
        const edit = obj(v, ['x', 'y', 'color'], path);
        return { x: num(edit.x, 0, w - 1, path, true), y: num(edit.y, 0, h - 1, path, true), color: color(edit.color, path) };
      });
      unique(pixelEdits.map(edit => edit.y * w + edit.x), path);
      coordinates += pixelEdits.length;
      frame.pixelEdits = pixelEdits;
    }
    return frame;
  });
  unique(frames.map(f => f.id), 'ID frame');
  if (coordinates > MAX_RECIPE_COORDINATES) fail('AssetRecipe', 'vượt giới hạn tọa độ.');
  return { version: 1, name: name(root.name, 'Tên asset'), canvas: { w, h }, palette, pivot: point(root.pivot, 'Điểm neo'), materials, parts, frames, loop: bool(root.loop, 'Loop') };
}
