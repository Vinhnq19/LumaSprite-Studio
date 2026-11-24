import type { AssetRecipe, RecipePaintOp } from '../../studio/quality/recipe.ts';
import { createRecipeRenderer } from '../../studio/quality/renderer.ts';
import { encodePng } from '../png.ts';
import type { QualityImage } from './quality-ports.ts';

const polygon = (color: number, ...xy: number[]): RecipePaintOp => ({
  kind: 'polygon', color,
  points: Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[2 * i], y: xy[2 * i + 1] })),
});
const line = (color: number, x0: number, y0: number, x1: number, y1: number): RecipePaintOp =>
  ({ kind: 'line', color, x0, y0, x1, y1 });

/** Native material swatches for the experimental character director, with no source art. */
export function characterMaterialGuide(side: 64 | 128 = 128): QualityImage {
  const compact = side === 64;
  const canvas = compact ? { w: 64, h: 24 } : { w: 88, h: 40 };
  const steel: RecipePaintOp[] = [
    polygon(0, 10,11, 17,6, 26,6, 33,10, 37,17, 36,24, 31,30, 23,34, 15,33, 9,28, 6,20, 7,15),
    polygon(1, 10,12, 17,7, 26,7, 32,10, 36,17, 35,24, 30,29, 23,33, 15,32, 10,28, 7,20, 8,15),
    polygon(2, 10,13, 17,8, 26,8, 31,11, 34,16, 33,21, 29,25, 22,28, 14,26, 10,23, 8,18),
    polygon(3, 11,13, 17,9, 24,9, 28,11, 29,15, 25,18, 18,20, 12,19, 9,16),
    polygon(4, 12,13, 17,10, 23,10, 24,11, 20,13, 15,15, 11,15),
    polygon(1, 24,26, 31,23, 34,20, 34,24, 29,29, 24,31, 19,30),
    line(2, 16,30, 22,32), line(3, 15,29, 19,30), line(1, 17,20, 23,19),
  ];
  const cloth: RecipePaintOp[] = [
    polygon(0, 54,8, 65,6, 75,8, 80,13, 78,19, 81,27, 83,34, 77,32, 72,34, 66,32, 61,35, 53,32, 51,27, 53,20, 50,14),
    polygon(5, 54,9, 65,7, 74,9, 79,13, 77,19, 80,27, 81,32, 77,31, 72,33, 66,31, 61,34, 54,32, 52,27, 54,20, 51,14),
    polygon(6, 55,10, 64,8, 72,9, 75,12, 72,17, 68,21, 69,27, 66,30, 61,33, 55,31, 54,27, 57,21, 56,16, 52,13),
    polygon(7, 55,10, 63,9, 68,10, 67,12, 62,13, 59,16, 58,21, 56,20, 56,15, 53,12),
    polygon(7, 58,24, 63,18, 67,17, 64,22, 62,25, 64,27, 61,30, 57,31, 57,28),
    polygon(5, 72,19, 75,17, 75,22, 78,28, 78,31, 73,31, 71,27, 70,24),
    line(6, 75,17, 77,14), line(6, 76,27, 78,29), line(7, 60,13, 64,11),
  ];
  const compactSteel = [
    polygon(0, 6,5, 12,3, 19,3, 24,6, 25,12, 22,17, 17,21, 11,20, 6,17, 4,11),
    polygon(1, 7,6, 12,4, 19,4, 23,6, 24,12, 21,17, 17,20, 11,19, 7,17, 5,11),
    polygon(2, 7,7, 12,5, 18,5, 22,7, 23,10, 20,14, 16,16, 10,16, 7,14, 6,11),
    polygon(3, 7,8, 12,6, 17,6, 19,8, 17,11, 13,12, 8,12, 6,10),
    polygon(4, 8,8, 12,7, 15,7, 14,8, 11,9, 8,10),
    polygon(2, 9,17, 14,18, 19,16, 21,15, 19,18, 16,19, 11,19),
  ];
  const compactCloth = [
    polygon(0, 38,4, 45,3, 49,6, 47,9, 46,13, 47,17, 51,21, 46,20, 42,22, 38,21, 35,17, 36,12, 35,8),
    polygon(5, 38,5, 45,4, 48,6, 46,9, 45,13, 46,17, 48,20, 45,19, 42,21, 38,20, 36,17, 37,12, 36,8),
    polygon(6, 39,5, 45,5, 45,7, 42,11, 41,14, 44,19, 41,20, 37,18, 38,12, 37,9),
    polygon(7, 38,7, 43,6, 42,8, 40,9, 38,12, 38,9),
    polygon(0, 49,7, 53,5, 57,6, 60,10, 59,15, 56,18, 52,17, 49,15, 48,11),
    polygon(1, 50,8, 53,6, 56,7, 59,10, 58,15, 56,17, 53,16, 50,15, 49,11),
    polygon(2, 50,9, 54,7, 57,8, 58,10, 56,13, 53,14, 50,13, 49,11),
    polygon(3, 51,9, 54,8, 56,9, 55,11, 52,12, 50,11),
  ];
  const guide: AssetRecipe = {
    version: 1, name: 'Curved steel and folded fabric', canvas,
    pivot: { x: canvas.w / 2, y: canvas.h - 1 },
    palette: [0x1d1a28ff, 0x42475bff, 0x65738cff, 0x9caec0ff, 0xd9e3e7ff, 0x3d1f2aff, 0x773b36ff, 0xb3644eff],
    materials: [], loop: false, frames: [{ id: 'still', durationMs: 100, poses: [] }],
    parts: [{ id: 'steel', name: 'Steel', paint: compact ? compactSteel : steel },
      { id: 'cloth', name: 'Cloth', paint: compact ? compactCloth : cloth }]
      .map(part => ({ ...part, origin: 'authored', parentId: null, pivot: { x: 0, y: 0 }, materialIds: [] })),
  };
  return { name: 'construction-materials.png', data: encodePng(createRecipeRenderer(guide).renderFrame('still').image.scale(compact ? 3 : 2)) };
}
