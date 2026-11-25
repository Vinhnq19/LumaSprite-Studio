import { luma8 } from './raster.ts';

/** pxl mask order, deliberately independent of engine-specific atlas order. */
export const TERRAIN_BITS = Object.freeze({ N: 1, E: 2, S: 4, W: 8, NE: 16, SE: 32, SW: 64, NW: 128 });
export const ATLAS_COLUMNS = 8;
export const ATLAS_ROWS = 6;
export const SPARE_SLOT = 47;
export type TileSize = 16 | 32;
export function terrainEdgeDifferences(material: Uint32Array, size: TileSize): { horizontal: number[]; vertical: number[] } {
  if ((size !== 16 && size !== 32) || !(material instanceof Uint32Array) || material.length !== size * size) throw new Error('Vật liệu phải là ô RGBA 16 hoặc 32 px.');
  const horizontal: number[] = [], vertical: number[] = [];
  for (let i = 0; i < size; i++) {
    if (material[i * size] !== material[i * size + size - 1]) horizontal.push(i);
    if (material[i] !== material[(size - 1) * size + i]) vertical.push(i);
  }
  return { horizontal, vertical };
}

/** Average adjacent-pixel contrast in a repeated tile, including two steps on each side of the join. */
export function terrainBoundaryContrast(material: Uint32Array, size: TileSize) {
  if (material.length !== size * size || material.some(color => (color & 255) !== 255)) return undefined;
  const luma = Uint8Array.from(material, luma8);
  const measure = (index: (position: number, sample: number) => number) => {
    const line = Array.from({ length: size }, (_, position) => {
      let total = 0;
      for (let sample = 0; sample < size; sample++) {
        total += Math.abs(luma[index(position, sample)] - luma[index((position + 1) % size, sample)]);
      }
      return total;
    });
    const band = line[0] + line[1] + line[size - 3] + line[size - 2] + line[size - 1];
    const inside = line.slice(0, -1).reduce((sum, n) => sum + n, 0);
    return { band: band / (5 * size), inside: inside / ((size - 1) * size) };
  };
  return { leftRight: measure((x, y) => y * size + x), topBottom: measure((y, x) => y * size + x) };
}
export type QuadrantKind = 'outer' | 'horizontal' | 'vertical' | 'inner' | 'interior';

export function canonicalMask(mask: number): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 255) throw new Error('Mask địa hình phải là số nguyên 0–255.');
  let out = mask & 15;
  for (const [diagonal, pair] of [[16, 3], [32, 6], [64, 12], [128, 9]]) {
    if ((mask & pair) === pair && (mask & diagonal)) out |= diagonal;
  }
  return out;
}

export const CANONICAL_MASKS: readonly number[] = Object.freeze([...new Set(Array.from({ length: 256 }, (_, i) => canonicalMask(i)))].sort((a, b) => a - b));

export function terrainSlot(mask: number): number { return CANONICAL_MASKS.indexOf(canonicalMask(mask)); }

export function quadrantKind(horizontal: boolean, vertical: boolean, diagonal: boolean): QuadrantKind {
  if (!horizontal && !vertical) return 'outer';
  if (!horizontal) return 'vertical';
  if (!vertical) return 'horizontal';
  return diagonal ? 'interior' : 'inner';
}

export interface TerrainAssembly {
  tileSize: TileSize;
  /** Transparent edge inset, in native pixels. No smoothing or resampling. */
  inset: number;
  sampling: 'repeat' | 'mirror';
}

/** Build five NW quadrant shapes from one native square material. Each other
 * quadrant uses the same rules reflected geometrically, but texture sampling
 * stays in tile coordinates so the source is never silently rescaled. */
export function assembleTerrain(material: Uint32Array, options: TerrainAssembly): { w: number; h: number; data: Uint32Array; palette: number[] } {
  const { tileSize: size, inset, sampling } = options;
  if (size !== 16 && size !== 32) throw new Error('Ô địa hình chỉ hỗ trợ 16 hoặc 32 px.');
  if (!(material instanceof Uint32Array) || material.length !== size * size) throw new Error('Chọn vật liệu vuông có đúng kích thước ô; không tự co ảnh.');
  if (!Number.isInteger(inset) || inset < 1 || inset >= size / 2) throw new Error('Độ dày mép phải từ 1 đến nửa ô trừ 1 px.');
  if (sampling !== 'repeat' && sampling !== 'mirror') throw new Error('Cách lấy mẫu vật liệu không hợp lệ.');
  if (!material.some(c => c & 255)) throw new Error('Vật liệu đang rỗng. Vẽ hoặc áp dụng vật liệu trước khi dựng tileset.');
  const w = ATLAS_COLUMNS * size, h = ATLAS_ROWS * size, half = size / 2;
  const data = new Uint32Array(w * h);
  // NW, NE, SE, SW. h/v here mean the two adjacent cardinal neighbors.
  const quadrants = [[8, 1, 128], [2, 1, 16], [2, 4, 32], [8, 4, 64]];
  for (let slot = 0; slot <= SPARE_SLOT; slot++) {
    const mask = CANONICAL_MASKS[slot];
    const ox = slot % ATLAS_COLUMNS * size, oy = Math.floor(slot / ATLAS_COLUMNS) * size;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const right = x >= half, bottom = y >= half;
      const q = bottom ? (right ? 2 : 3) : (right ? 1 : 0);
      const u = right ? size - 1 - x : x, v = bottom ? size - 1 - y : y;
      const [horizontal, vertical, diagonal] = quadrants[q];
      const kind = mask === undefined ? 'interior' : quadrantKind(!!(mask & horizontal), !!(mask & vertical), !!(mask & diagonal));
      const keep = kind === 'interior' || (kind === 'outer' ? u >= inset && v >= inset
        : kind === 'vertical' ? u >= inset : kind === 'horizontal' ? v >= inset : u >= inset || v >= inset);
      if (!keep) continue;
      const sx = sampling === 'mirror' ? (right ? size - 1 - x : x) : x;
      const sy = sampling === 'mirror' ? (bottom ? size - 1 - y : y) : y;
      data[(oy + y) * w + ox + x] = material[sy * size + sx];
    }
  }
  return { w, h, data, palette: [...new Set(data)].filter(c => c & 255) };
}
