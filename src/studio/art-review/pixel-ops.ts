import { channels, luma8, toHex } from '../raster.ts';
import type {
  AlignmentConfig,
  DiffStats,
  Pivot,
  ReviewFrame,
  SilhouetteMode,
} from './types.ts';

export interface RgbaInspection {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
  packed: number;
  hex: string;
}

export interface CompatibilityReport {
  sameSize: boolean;
  samePivot: boolean;
  requiresAlignment: boolean;
  reasons: string[];
}

export interface AlignedLayout {
  width: number;
  height: number;
  aX: number;
  aY: number;
  bX: number;
  bY: number;
  dx: number;
  dy: number;
}

export interface PixelDiffResult {
  width: number;
  height: number;
  rgba: Uint32Array;
  layout: AlignedLayout;
  stats: DiffStats;
}

export interface SilhouetteResult {
  width: number;
  height: number;
  rgba: Uint32Array;
  opaquePixels: number;
  semiTransparentPixels: number;
  transparentPixels: number;
}

export interface StripSliceRect {
  x: number;
  y: number;
  w: number;
  h: number;
  durationMs: number;
  label?: string;
  pivot?: Pivot;
}

/** Read straight-alpha RGBA channels from packed 0xRRGGBBAA raster data without mutation. */
export function readPixelRgba(
  rgba: Uint32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): RgbaInspection | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    return null;
  }
  const packed = rgba[y * width + x] >>> 0;
  const [r, g, b, a] = channels(packed);
  return {
    x,
    y,
    r,
    g,
    b,
    a,
    packed,
    hex: toHex(packed),
  };
}

function samePivotValue(a?: Pivot, b?: Pivot): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.trunc(a.x) === Math.trunc(b.x) && Math.trunc(a.y) === Math.trunc(b.y);
}

/** Detect size or pivot differences that must be aligned before interpreting a pixel diff. */
export function checkCompatibility(
  a: { width: number; height: number; pivot?: Pivot },
  b: { width: number; height: number; pivot?: Pivot },
): CompatibilityReport {
  const sameSize = a.width === b.width && a.height === b.height;
  const samePivot = samePivotValue(a.pivot, b.pivot);
  const reasons: string[] = [];
  if (!sameSize) {
    reasons.push(`Kích thước khác nhau: A là ${a.width}×${a.height}, B là ${b.width}×${b.height} (không tự co giãn).`);
  }
  if (!samePivot) {
    const aText = a.pivot ? `(${a.pivot.x}, ${a.pivot.y})` : 'chưa đặt';
    const bText = b.pivot ? `(${b.pivot.x}, ${b.pivot.y})` : 'chưa đặt';
    reasons.push(`Pivot khác nhau: A ${aText}, B ${bText}.`);
  }
  return {
    sameSize,
    samePivot,
    requiresAlignment: !sameSize || !samePivot,
    reasons,
  };
}

/** Compute non-negative integer placement for A and B inside a union pixel canvas without scaling. */
export function computeAlignedLayout(
  a: { width: number; height: number; pivot?: Pivot },
  b: { width: number; height: number; pivot?: Pivot },
  alignment: AlignmentConfig,
): AlignedLayout {
  let dx = 0;
  let dy = 0;
  switch (alignment.mode) {
    case 'top-left':
      dx = 0;
      dy = 0;
      break;
    case 'center':
      dx = Math.floor((a.width - b.width) / 2);
      dy = Math.floor((a.height - b.height) / 2);
      break;
    case 'bottom-center':
      dx = Math.floor((a.width - b.width) / 2);
      dy = a.height - b.height;
      break;
    case 'pivot':
      dx = Math.trunc((a.pivot?.x ?? 0) - (b.pivot?.x ?? 0));
      dy = Math.trunc((a.pivot?.y ?? 0) - (b.pivot?.y ?? 0));
      break;
    case 'manual':
      dx = Number.isFinite(alignment.offsetX) ? Math.trunc(alignment.offsetX) : 0;
      dy = Number.isFinite(alignment.offsetY) ? Math.trunc(alignment.offsetY) : 0;
      break;
  }

  const minX = Math.min(0, dx);
  const minY = Math.min(0, dy);
  const maxX = Math.max(a.width, dx + b.width);
  const maxY = Math.max(a.height, dy + b.height);

  const aX = -minX;
  const aY = -minY;
  const bX = dx - minX;
  const bY = dy - minY;

  return {
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    aX,
    aY,
    bX,
    bY,
    dx,
    dy,
  };
}

/** Compute an exact pixel diff across the aligned union canvas without scaling or modifying sources. */
export function computePixelDiff(
  a: { width: number; height: number; rgba: Uint32Array; pivot?: Pivot },
  b: { width: number; height: number; rgba: Uint32Array; pivot?: Pivot },
  alignment: AlignmentConfig,
): PixelDiffResult {
  const layout = computeAlignedLayout(a, b, alignment);
  const out = new Uint32Array(layout.width * layout.height);

  let overlapPixels = 0;
  let changedPixels = 0;
  let identicalOverlapPixels = 0;
  let rgbDiffPixels = 0;
  let alphaDiffPixels = 0;
  let onlyAPixels = 0;
  let onlyBPixels = 0;
  let maxChannelDelta = 0;

  for (let uy = 0; uy < layout.height; uy++) {
    const ay = uy - layout.aY;
    const by = uy - layout.bY;
    const inAY = ay >= 0 && ay < a.height;
    const inBY = by >= 0 && by < b.height;

    for (let ux = 0; ux < layout.width; ux++) {
      const ax = ux - layout.aX;
      const bx = ux - layout.bX;
      const inA = inAY && ax >= 0 && ax < a.width;
      const inB = inBY && bx >= 0 && bx < b.width;
      const outIdx = uy * layout.width + ux;

      if (inA && inB) {
        overlapPixels++;
        const pa = a.rgba[ay * a.width + ax] >>> 0;
        const pb = b.rgba[by * b.width + bx] >>> 0;

        if (pa === pb) {
          identicalOverlapPixels++;
          const aa = pa & 255;
          if (aa > 0) {
            const g = luma8(pa);
            out[outIdx] = ((g << 24) | (g << 16) | (g << 8) | 0x44) >>> 0;
          } else {
            out[outIdx] = 0;
          }
          continue;
        }

        changedPixels++;
        const [ra, ga, ba, aa] = channels(pa);
        const [rb, gb, bb, ab] = channels(pb);
        const delta = Math.max(
          Math.abs(ra - rb),
          Math.abs(ga - gb),
          Math.abs(ba - bb),
          Math.abs(aa - ab),
        );
        if (delta > maxChannelDelta) maxChannelDelta = delta;

        const sameRgb = ra === rb && ga === gb && ba === bb;
        if (sameRgb) {
          alphaDiffPixels++;
          out[outIdx] = 0x00e5ffff;
        } else {
          rgbDiffPixels++;
          out[outIdx] = 0xff2e93ff;
        }
      } else if (inA) {
        const pa = a.rgba[ay * a.width + ax] >>> 0;
        const aa = pa & 255;
        if (aa > 0) {
          onlyAPixels++;
          changedPixels++;
          if (aa > maxChannelDelta) maxChannelDelta = aa;
          out[outIdx] = 0xffb020d8;
        } else {
          out[outIdx] = 0xffb02044;
        }
      } else if (inB) {
        const pb = b.rgba[by * b.width + bx] >>> 0;
        const ab = pb & 255;
        if (ab > 0) {
          onlyBPixels++;
          changedPixels++;
          if (ab > maxChannelDelta) maxChannelDelta = ab;
          out[outIdx] = 0x38d9a9d8;
        } else {
          out[outIdx] = 0x38d9a944;
        }
      }
    }
  }

  return {
    width: layout.width,
    height: layout.height,
    rgba: out,
    layout,
    stats: {
      totalUnionPixels: layout.width * layout.height,
      overlapPixels,
      changedPixels,
      identicalOverlapPixels,
      rgbDiffPixels,
      alphaDiffPixels,
      onlyAPixels,
      onlyBPixels,
      maxChannelDelta,
    },
  };
}

/** Compute exact frame-to-frame difference between two frames (e.g. consecutive or loop boundary). */
export function computeFrameDiff(prev: ReviewFrame, curr: ReviewFrame): PixelDiffResult {
  return computePixelDiff(
    { width: prev.width, height: prev.height, rgba: prev.rgba, pivot: prev.pivot },
    { width: curr.width, height: curr.height, rgba: curr.rgba, pivot: curr.pivot },
    { mode: 'top-left', offsetX: 0, offsetY: 0, confirmed: true },
  );
}

/** Generate exact alpha silhouette or grayscale alpha-channel inspection image. */
export function computeSilhouette(
  rgba: Uint32Array,
  width: number,
  height: number,
  mode: SilhouetteMode,
  fillPacked = 0xf2f6faff,
): SilhouetteResult {
  const out = new Uint32Array(width * height);
  let opaquePixels = 0;
  let semiTransparentPixels = 0;
  let transparentPixels = 0;
  const fill = fillPacked >>> 0;

  for (let i = 0; i < out.length; i++) {
    const a = rgba[i] & 255;
    if (a === 0) {
      transparentPixels++;
      out[i] = 0;
    } else {
      if (a === 255) opaquePixels++;
      else semiTransparentPixels++;
      out[i] = mode === 'binary' ? fill : ((a << 24) | (a << 16) | (a << 8) | 0xff) >>> 0;
    }
  }

  return {
    width,
    height,
    rgba: out,
    opaquePixels,
    semiTransparentPixels,
    transparentPixels,
  };
}

/** Slice exact pixel regions from a sprite strip without altering source pixel buffers. */
export function sliceSpriteStrip(
  sourceRgba: Uint32Array,
  sourceW: number,
  sourceH: number,
  rects: readonly StripSliceRect[],
): ReviewFrame[] {
  if (!rects.length) {
    throw new Error('Cần ít nhất 1 frame để cắt sprite strip.');
  }
  if (sourceRgba.length !== sourceW * sourceH) {
    throw new Error('Kích thước buffer nguồn không khớp chiều rộng × chiều cao.');
  }

  return rects.map((rect, index) => {
    if (
      !Number.isInteger(rect.x) ||
      !Number.isInteger(rect.y) ||
      !Number.isInteger(rect.w) ||
      !Number.isInteger(rect.h) ||
      rect.w < 1 ||
      rect.h < 1 ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.w > sourceW ||
      rect.y + rect.h > sourceH
    ) {
      throw new Error(
        `Frame #${index + 1} (${rect.x},${rect.y} ${rect.w}×${rect.h}) nằm ngoài ảnh nguồn ${sourceW}×${sourceH}.`,
      );
    }
    if (!Number.isFinite(rect.durationMs) || rect.durationMs < 1 || rect.durationMs > 60000) {
      throw new Error(`Thời lượng frame #${index + 1} không hợp lệ (${rect.durationMs} ms).`);
    }

    const rgba = new Uint32Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) {
      const srcRow = (rect.y + y) * sourceW + rect.x;
      rgba.set(sourceRgba.subarray(srcRow, srcRow + rect.w), y * rect.w);
    }

    return {
      index,
      width: rect.w,
      height: rect.h,
      rgba,
      durationMs: Math.round(rect.durationMs),
      label: rect.label,
      pivot: rect.pivot ? { x: Math.trunc(rect.pivot.x), y: Math.trunc(rect.pivot.y) } : undefined,
    };
  });
}
