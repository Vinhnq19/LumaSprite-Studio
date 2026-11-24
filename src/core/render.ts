// Derived views of built images: previews for eyes, ASCII for exact checks, sheet packing.
import { type Color, TRANSPARENT, darken, pack } from "./color.ts";
import { Img } from "./image.ts";
import type { Palette } from "./palette.ts";

const LIGHT = pack(0xe4, 0xe4, 0xe4), DARK = pack(0xc8, 0xc8, 0xc8);

/** Auto preview scale: longest side ~768px, clamped to 1..16. */
export function previewScale(img: Img, max = 768): number {
  return Math.max(1, Math.min(16, Math.floor(max / Math.max(img.w, img.h))));
}

/**
 * Upscaled preview: checkerboard behind transparency (one check per source pixel) and,
 * at scale >= 6, a pixel grid with every 8th line darker for reading coordinates.
 */
export function preview(img: Img, scale = previewScale(img)): Img {
  const s = scale;
  const o = new Img(img.w * s, img.h * s);
  for (let y = 0; y < o.h; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < o.w; x++) {
      const sx = Math.floor(x / s);
      let c: Color = img.data[sy * img.w + sx];
      if (c === TRANSPARENT || (c & 255) === 0) c = (sx + sy) % 2 === 0 ? LIGHT : DARK;
      if (s >= 6 && (x % s === 0 || y % s === 0)) {
        const major = (x % s === 0 && sx % 8 === 0) || (y % s === 0 && sy % 8 === 0);
        c = darken(c, major ? 0.45 : 0.18);
      }
      o.data[y * o.w + x] = c;
    }
  }
  return o;
}

/** Text dump with x/y rulers; colors shown as palette keys ("." transparent, "?" unknown). */
export function ascii(img: Img, pal: Palette): string {
  const rev = pal.reverse();
  const tens = "    " + Array.from({ length: img.w }, (_, x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " ")).join("");
  const ones = "    " + Array.from({ length: img.w }, (_, x) => String(x % 10)).join("");
  const lines = img.w > 10 ? [tens, ones] : [ones];
  for (let y = 0; y < img.h; y++) {
    let row = String(y).padStart(3) + " ";
    for (let x = 0; x < img.w; x++) {
      const c = img.data[y * img.w + x];
      row += c === TRANSPARENT ? "." : rev.get(c) ?? "?";
    }
    lines.push(row);
  }
  return lines.join("\n");
}

export interface SheetFrame {
  name: string;
  img: Img;
  x: number;
  y: number;
  /** Animation frames: duration in ms. */
  ms?: number;
}

/** A named run of animation frames in a sheet (Aseprite "frameTags"). */
export interface FrameTag {
  name: string;
  from: number;
  to: number;
  loop?: boolean;
}

export interface PackOptions { pack?: 'shelf' | 'maxrects'; extrude?: number; maxSize?: number }

/** Restore crop coordinates and pad all frames to one stable source canvas. */
export function normalizeFrames<T extends { img: Img }>(frames: T[]): T[] {
  if (!frames.length) return frames;
  const w = Math.max(...frames.map(f => f.img.trim?.w ?? f.img.w)), h = Math.max(...frames.map(f => f.img.trim?.h ?? f.img.h));
  return frames.map(f => { const image = new Img(w, h); image.blit(f.img, f.img.trim?.x ?? 0, f.img.trim?.y ?? 0); return { ...f, img: image }; });
}

/** Shelf packing: `cols` frames per row, `pad` px between them. */
export function packSheet(items: { name: string; img: Img; ms?: number }[], cols?: number, pad = 0, opts: PackOptions = {}): { sheet: Img; frames: SheetFrame[] } {
  if (!items.length) throw new Error("sheet is empty");
  const extrude = opts.extrude ?? 0, max = opts.maxSize ?? 65535;
  if (!Number.isInteger(pad) || pad < 0 || !Number.isInteger(extrude) || extrude < 0 || extrude > 8 || !Number.isInteger(max) || max < 1 || opts.maxSize !== undefined && max > 4096 || cols !== undefined && (!Number.isInteger(cols) || cols < 1)) throw new Error('invalid atlas padding, extrusion, columns or size (configured maximum 4096)');
  if (opts.pack === 'maxrects') return maxRects(items, pad, extrude, max);
  const perRow = cols ?? Math.ceil(Math.sqrt(items.length));
  const frames: SheetFrame[] = [];
  let x = 0, y = 0, rowH = 0, W = 0;
  items.forEach((it, i) => {
    if (i > 0 && i % perRow === 0) { x = 0; y += rowH + pad; rowH = 0; }
    frames.push({ ...it, x: x + extrude, y: y + extrude });
    W = Math.max(W, x + it.img.w + 2 * extrude);
    x += it.img.w + 2 * extrude + pad;
    rowH = Math.max(rowH, it.img.h + 2 * extrude);
  });
  if (W > max || y + rowH > max) throw new Error(`atlas exceeds ${max}px; use more rows or MaxRects packing`);
  const sheet = new Img(W, y + rowH);
  for (const f of frames) blitExtruded(sheet, f, extrude);
  return { sheet, frames };
}

function blitExtruded(sheet: Img, f: SheetFrame, extrude: number): void {
  sheet.blit(f.img, f.x, f.y);
  for (let y = -extrude; y < f.img.h + extrude; y++) for (let x = -extrude; x < f.img.w + extrude; x++) {
    if (x >= 0 && x < f.img.w && y >= 0 && y < f.img.h) continue;
    sheet.set(f.x + x, f.y + y, f.img.get(Math.min(f.img.w - 1, Math.max(0, x)), Math.min(f.img.h - 1, Math.max(0, y))));
  }
}
interface Rect { x: number; y: number; w: number; h: number }
function maxRects(items: { name: string; img: Img; ms?: number }[], pad: number, extrude: number, max: number): { sheet: Img; frames: SheetFrame[] } {
  const ordered = items.map((item, index) => ({ ...item, index, w: item.img.w + 2 * extrude + pad, h: item.img.h + 2 * extrude + pad })).sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || a.index - b.index);
  const sizes = [...new Set([32, 64, 128, 256, 512, 1024, 2048, max].filter(n => n <= max))];
  const candidates = sizes.flatMap(w => sizes.map(h => ({ w, h }))).sort((a, b) => a.w * a.h - b.w * b.h || a.w + a.h - b.w - b.h);
  for (const bin of candidates) {
    let free: Rect[] = [{ x: 0, y: 0, w: bin.w + pad, h: bin.h + pad }]; const result = new Map<number, SheetFrame>(); let failed = false;
    for (const item of ordered) {
      const possible = free.filter(r => item.w <= r.w && item.h <= r.h).sort((a, b) => Math.min(a.w - item.w, a.h - item.h) - Math.min(b.w - item.w, b.h - item.h) || Math.max(a.w - item.w, a.h - item.h) - Math.max(b.w - item.w, b.h - item.h));
      if (!possible.length) { failed = true; break; }
      const used: Rect = { x: possible[0].x, y: possible[0].y, w: item.w, h: item.h }, split: Rect[] = [];
      for (const r of free) {
        if (used.x >= r.x + r.w || used.x + used.w <= r.x || used.y >= r.y + r.h || used.y + used.h <= r.y) { split.push(r); continue; }
        if (used.x > r.x) split.push({ x: r.x, y: r.y, w: used.x - r.x, h: r.h });
        if (used.x + used.w < r.x + r.w) split.push({ x: used.x + used.w, y: r.y, w: r.x + r.w - used.x - used.w, h: r.h });
        if (used.y > r.y) split.push({ x: r.x, y: r.y, w: r.w, h: used.y - r.y });
        if (used.y + used.h < r.y + r.h) split.push({ x: r.x, y: used.y + used.h, w: r.w, h: r.y + r.h - used.y - used.h });
      }
      free = split.filter((a, i) => !split.some((b, j) => i !== j && b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h && (b.w * b.h > a.w * a.h || j < i)));
      result.set(item.index, { name: item.name, img: item.img, ms: item.ms, x: used.x + extrude, y: used.y + extrude });
    }
    if (failed) continue;
    const frames = items.map((_, i) => result.get(i)!); const w = Math.max(...frames.map(f => f.x + f.img.w + extrude)), h = Math.max(...frames.map(f => f.y + f.img.h + extrude));
    if (w > max || h > max) continue;
    const sheet = new Img(w, h); for (const f of frames) blitExtruded(sheet, f, extrude); return { sheet, frames };
  }
  throw new Error(`assets do not fit a single ${max}x${max} atlas`);
}

/**
 * TexturePacker "hash" JSON (read by Phaser, Godot importers, etc.). Animation frames add a
 * `duration` (ms) and `meta.frameTags`, as Aseprite exports them.
 */
export function sheetJson(image: string, sheet: Img, frames: SheetFrame[], tags: FrameTag[] = [], assets: Record<string, unknown> = {}): string {
  const out: Record<string, unknown> = {};
  for (const f of frames) {
    const { w, h } = f.img;
    out[f.name] = {
      frame: { x: f.x, y: f.y, w, h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h }, sourceSize: { w, h },
      ...(f.ms !== undefined ? { duration: f.ms } : {}),
    };
  }
  const meta: Record<string, unknown> = { app: "pxl", image, format: "RGBA8888", size: { w: sheet.w, h: sheet.h }, scale: "1" };
  if (tags.length) meta.frameTags = tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: "forward" }));
  meta.pxl = { schemaVersion: 1, assets, animations: tags.map(t => ({ name: t.name, loop: t.loop !== false, frames: frames.slice(t.from, t.to + 1).map(f => ({ name: f.name, duration: f.ms })) })) };
  return JSON.stringify({ frames: out, meta }, null, 1) + "\n";
}
