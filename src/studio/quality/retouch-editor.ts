import { PixelHistory, snapshot } from '../pixel/history.ts';
import { brush, line, type Point } from '../pixel/tools.ts';
import { dataId, dataNumber, dataObject, dataUnique } from './data.ts';
import type { RecipeRect, RecipePixelEdit } from './recipe.ts';
import type { FrameRetouchConstraints } from './retouch.ts';

interface Options {
  w: number; h: number; palette: readonly number[]; frameIds: readonly string[];
  constraints: FrameRetouchConstraints; sourceLockedFrames: readonly string[]; movementMask: Uint8Array | null;
}
interface State { frames: Record<string, Uint32Array>; lockedFrames: string[]; region: RecipeRect | null }
const integer = (n: unknown, min: number, max: number) => dataNumber(n, min, max, 'Chỉnh pixel', true);
const inside = (i: number, w: number, r: RecipeRect | null) => !r || i % w >= r.x && i % w < r.x + r.w && Math.floor(i / w) >= r.y && Math.floor(i / w) < r.y + r.h;

/** Native final pixels are immutable baselines; only a stroke's target buffer is copied. */
export class RetouchEditor {
  readonly w: number; readonly h: number; readonly palette: readonly number[];
  readonly history = new PixelHistory();
  readonly state: State;
  private frameIds: string[]; private inheritedLocks: Set<string>; private inheritedRegion: RecipeRect | null;
  private movementMask: Uint8Array | null; private baseline = new Map<string, Uint32Array>();
  private original = new Map<string, RecipePixelEdit[]>();
  private active?: { id: string; before: State; mask?: Uint8Array };
  constructor(o: Options) {
    this.w = integer(o.w, 1, 4096); this.h = integer(o.h, 1, 4096);
    if (this.w * this.h > 8_000_000) throw Error('Preview vượt 8 triệu pixel native.');
    integer(o.frameIds.length, 1, 600); this.frameIds = dataUnique(o.frameIds.map(id => dataId(id, 'Frame')), 'Frame');
    integer(o.palette.length, 1, 256); this.palette = dataUnique(o.palette.map(c => {
      integer(c, 0, 0xffffffff); if ((c & 255) !== 255) throw Error('Palette phải có alpha 255.'); return c;
    }), 'Palette');
    this.inheritedLocks = new Set([...o.constraints.lockedFrames, ...o.sourceLockedFrames].map(id => this.known(id)));
    this.inheritedRegion = this.rect(o.constraints.region);
    if (o.movementMask !== null && (!(o.movementMask instanceof Uint8Array) || o.movementMask.length !== this.w * this.h)) throw Error('Mask sai kích thước.');
    this.movementMask = o.movementMask?.slice() ?? null;
    this.state = { frames: {}, lockedFrames: this.frameIds.filter(id => this.inheritedLocks.has(id)), region: this.inheritedRegion && { ...this.inheritedRegion } };
  }
  private known(id: string): string { dataId(id, 'Frame'); if (!this.frameIds.includes(id)) throw Error('Frame không tồn tại.'); return id; }
  private rect(value: RecipeRect | null): RecipeRect | null {
    if (value === null) return null;
    const r = dataObject(value, ['x', 'y', 'w', 'h'], 'Vùng sửa');
    const next = { x: integer(r.x, 0, this.w - 1), y: integer(r.y, 0, this.h - 1), w: integer(r.w, 1, this.w), h: integer(r.h, 1, this.h) };
    if (next.x + next.w > this.w || next.y + next.h > this.h) throw Error('Vùng vượt canvas.'); return next;
  }
  loadFrame(id: string, pixels: Uint32Array, edits: readonly RecipePixelEdit[] = []): void {
    this.known(id); if (this.baseline.has(id)) return;
    if (!(pixels instanceof Uint32Array) || pixels.length !== this.w * this.h) throw Error('Frame sai kích thước.');
    if ((this.baseline.size + 1) * pixels.length > 8_000_000) throw Error('Preview vượt 8 triệu pixel native.');
    if (edits.length > 8192) throw Error('Frame vượt 8192 nét sửa.');
    const seen = new Set<number>(), copy = edits.map(e => {
      const p = dataObject(e, ['x', 'y', 'color'], 'Nét sửa'), x = integer(p.x, 0, this.w - 1), y = integer(p.y, 0, this.h - 1);
      const color = p.color === null ? null : integer(p.color, 0, this.palette.length - 1), i = y * this.w + x;
      if (seen.has(i)) throw Error('Nét sửa trùng tọa độ.'); seen.add(i); return { x, y, color };
    });
    if (pixels.some(c => c !== 0 && !this.palette.includes(c))) throw Error('Frame có màu ngoài palette.');
    const base = pixels.slice(); this.baseline.set(id, base); this.original.set(id, copy); this.state.frames[id] = base;
  }
  /** Trusted view for drawing only; callers must not mutate. */
  getPixels(id: string): Uint32Array { this.known(id); const p = this.state.frames[id]; if (!p) throw Error('Frame chưa tải.'); return p; }
  beginStroke(id: string): void {
    if (this.active) throw Error('Nét vẽ đang thực hiện.');
    const pixels = this.getPixels(id); if (this.state.lockedFrames.includes(id)) throw Error('Frame đã khóa.');
    if (!this.dirty(id) && this.frameIds.filter(f => this.dirty(f)).length >= 8) throw Error('Tối đa 8 frame sửa mỗi biến thể. Lưu biến thể trước khi sửa frame tiếp.');
    const before = snapshot(this.state), r = this.state.region;
    const mask = r || this.movementMask ? Uint8Array.from({ length: pixels.length }, (_, i) => +((!this.movementMask || !!this.movementMask[i]) && inside(i, this.w, r))) : undefined;
    this.active = { id, before, mask }; this.state.frames[id] = pixels.slice();
  }
  paint(from: Point, to: Point, colorIndex: number | null, size = 1): void {
    if (!this.active) throw Error('Bắt đầu nét trước khi vẽ.');
    for (const p of [from, to]) { integer(p.x, 0, this.w - 1); integer(p.y, 0, this.h - 1); }
    integer(size, 1, 64); const color = colorIndex === null ? 0 : this.palette[integer(colorIndex, 0, this.palette.length - 1)];
    const b = { size, round: false, mirrorX: false, mirrorY: false, mask: this.active.mask }, pixels = this.state.frames[this.active.id];
    line(from, to, (x, y) => brush(pixels, this.w, this.h, x, y, color, b));
  }
  endStroke(): boolean {
    if (!this.active) return false;
    try { this.patches(); } catch (error) { this.cancelStroke(); throw error; }
    const { before } = this.active; this.active = undefined; return this.history.commit(before, this.state, 'Sửa nét');
  }
  cancelStroke(): void { if (this.active) { const { id, before } = this.active; this.state.frames[id] = before.frames[id]; this.active = undefined; } }
  undo(redo = false): void { this.cancelStroke(); this.history.undo(this.state, redo); }
  private dirty(id: string): boolean { const base = this.baseline.get(id); return !!base && this.state.frames[id].some((p, i) => p !== base[i]); }
  setLocked(id: string, locked: boolean): void {
    this.cancelStroke(); this.known(id);
    if (!locked && this.inheritedLocks.has(id)) throw Error('Không thể bỏ khóa kế thừa.');
    if (locked && this.dirty(id)) throw Error('Lưu biến thể trước khi khóa frame đã chỉnh.');
    const before = snapshot(this.state), locks = new Set(this.state.lockedFrames);
    if (locked) locks.add(id); else locks.delete(id);
    this.state.lockedFrames = this.frameIds.filter(id => locks.has(id)); this.history.commit(before, this.state, 'Khóa frame');
  }
  setRegion(value: RecipeRect | null): void {
    this.cancelStroke(); let r = this.rect(value); const prior = this.inheritedRegion;
    if (prior && !r) r = { ...prior };
    else if (prior && r) {
      const x = Math.max(r.x, prior.x), y = Math.max(r.y, prior.y), w = Math.min(r.x + r.w, prior.x + prior.w) - x, h = Math.min(r.y + r.h, prior.y + prior.h) - y;
      if (w < 1 || h < 1) throw Error('Vùng không giao với vùng được bảo vệ.'); r = { x, y, w, h };
    }
    for (const [id, base] of this.baseline) if (this.state.frames[id].some((p, i) => p !== base[i] && !inside(i, this.w, r))) throw Error('Vùng mới loại bỏ nét đang sửa. Undo hoặc lưu biến thể trước.');
    const before = snapshot(this.state); this.state.region = r; this.history.commit(before, this.state, 'Đổi vùng sửa');
  }
  patches(): { frameId: string; pixelEdits: RecipePixelEdit[] }[] {
    const patches: { frameId: string; pixelEdits: RecipePixelEdit[] }[] = [];
    for (const id of this.frameIds) {
      if (!this.dirty(id)) continue;
      if (patches.length === 8) throw Error('Tối đa 8 frame sửa mỗi biến thể; nét hiện tại vẫn được giữ.');
      const map = new Map(this.original.get(id)!.map(p => [p.y * this.w + p.x, { ...p }])), base = this.baseline.get(id)!;
      this.state.frames[id].forEach((p, i) => {
        if (p === base[i]) return; const color = p === 0 ? null : this.palette.indexOf(p);
        if (color === -1) throw Error('Nét sửa có màu ngoài palette.'); map.set(i, { x: i % this.w, y: Math.floor(i / this.w), color });
      });
      if (map.size > 8192) throw Error('Frame vượt 8192 nét sửa; nét hiện tại vẫn được giữ.');
      patches.push({ frameId: id, pixelEdits: [...map].sort((a, b) => a[0] - b[0]).map(([, p]) => p) });
    }
    return patches;
  }
}
