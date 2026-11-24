import { channels } from '../../core/color.ts';
export interface Brush { size: number; round: boolean; mirrorX: boolean; mirrorY: boolean; mask?: Uint8Array }
export interface Point { x: number; y: number }
export function line(a: Point, b: Point, set: (x: number, y: number) => void): void {
  let x = a.x, y = a.y; const dx = Math.abs(b.x - x), sx = x < b.x ? 1 : -1, dy = -Math.abs(b.y - y), sy = y < b.y ? 1 : -1; let err = dx + dy;
  for (;;) { set(x, y); if (x === b.x && y === b.y) break; const e = err * 2; if (e >= dy) { err += dy; x += sx; } if (e <= dx) { err += dx; y += sy; } }
}
export function brush(data: Uint32Array, w: number, h: number, x: number, y: number, color: number, b: Brush): void {
  const start = -Math.floor(b.size / 2), set = (px: number, py: number) => { const i = py * w + px; if (px >= 0 && py >= 0 && px < w && py < h && (!b.mask || b.mask[i])) data[i] = color; };
  for (let yy = 0; yy < b.size; yy++) for (let xx = 0; xx < b.size; xx++) {
    if (b.round && Math.hypot(xx - (b.size - 1) / 2, yy - (b.size - 1) / 2) > b.size / 2) continue;
    const px = x + start + xx, py = y + start + yy; set(px, py);
    if (b.mirrorX) set(w - px - 1, py); if (b.mirrorY) set(px, h - py - 1); if (b.mirrorX && b.mirrorY) set(w - px - 1, h - py - 1);
  }
}
export function region(sample: Uint32Array, w: number, h: number, x: number, y: number, tolerance = 0, contiguous = true): Uint8Array {
  const mask = new Uint8Array(w * h); if (x < 0 || y < 0 || x >= w || y >= h) return mask;
  const target = channels(sample[y * w + x]), matches = (i: number) => channels(sample[i]).every((v, c) => Math.abs(v - target[c]) <= tolerance);
  if (!contiguous) { for (let i = 0; i < mask.length; i++) if (matches(i)) mask[i] = 1; return mask; }
  const seen = new Uint8Array(w * h), stack = [y * w + x]; seen[stack[0]] = 1;
  while (stack.length) { const i = stack.pop()!; if (!matches(i)) continue; mask[i] = 1; const px = i % w, py = Math.floor(i / w); for (const j of [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j]) { seen[j] = 1; stack.push(j); } }
  return mask;
}
export function rectangle(w: number, h: number, a: Point, b: Point): Uint8Array {
  const m = new Uint8Array(w * h); for (let y = Math.max(0, Math.min(a.y, b.y)); y <= Math.min(h - 1, Math.max(a.y, b.y)); y++) for (let x = Math.max(0, Math.min(a.x, b.x)); x <= Math.min(w - 1, Math.max(a.x, b.x)); x++) m[y * w + x] = 1; return m;
}
export function combineSelection(old: Uint8Array | undefined, next: Uint8Array, mode: 'replace' | 'add' | 'subtract'): Uint8Array {
  if (!old || mode === 'replace') return next;
  return next.map((v, i) => mode === 'add' ? +(!!v || !!old[i]) : +(!!old[i] && !v));
}
export function shape(a: Point, b: Point, ellipse: boolean, filled: boolean, set: (x: number, y: number) => void): void {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  if (!ellipse) { if (!filled) { line({ x: x0, y: y0 }, { x: x1, y: y0 }, set); line({ x: x0, y: y1 }, { x: x1, y: y1 }, set); line({ x: x0, y: y0 }, { x: x0, y: y1 }, set); line({ x: x1, y: y0 }, { x: x1, y: y1 }, set); } else for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y); return; }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
  const inside = (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x, y) && (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1))) set(x, y);
}
export interface Clipboard { w: number; h: number; data: Uint32Array; mask: Uint8Array; x: number; y: number }
export function selectionBounds(mask: Uint8Array, w: number): { x: number; y: number; w: number; h: number } | undefined {
  let x0 = w, y0 = mask.length / w, x1 = -1, y1 = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { const x = i % w, y = Math.floor(i / w); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
export function copySelection(data: Uint32Array, w: number, mask?: Uint8Array): Clipboard | undefined {
  const selected = mask ?? new Uint8Array(data.length).fill(1), b = selectionBounds(selected, w); if (!b) return;
  const out = new Uint32Array(b.w * b.h), m = new Uint8Array(out.length);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { const src = (y + b.y) * w + x + b.x, i = y * b.w + x; out[i] = data[src]; m[i] = selected[src]; }
  return { ...b, data: out, mask: m };
}
export function transformClipboard(c: Clipboard, mode: 'x' | 'y' | 'rotate'): Clipboard {
  const w = mode === 'rotate' ? c.h : c.w, h = mode === 'rotate' ? c.w : c.h, data = new Uint32Array(w * h), mask = new Uint8Array(data.length);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const nx = mode === 'x' ? c.w - x - 1 : mode === 'rotate' ? c.h - y - 1 : x, ny = mode === 'y' ? c.h - y - 1 : mode === 'rotate' ? x : y; data[ny * w + nx] = c.data[y * c.w + x]; mask[ny * w + nx] = c.mask[y * c.w + x]; }
  return { ...c, w, h, data, mask };
}
