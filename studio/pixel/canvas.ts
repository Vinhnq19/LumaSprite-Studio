import { Session } from './session.ts';
import { celFor, composite, isLocked, over, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { brush, line, shape, region, rectangle, combineSelection, copySelection, transformClipboard, type Brush, type Point, type Clipboard } from '../../src/studio/pixel/tools.ts';
import { Img } from '../../src/core/image.ts';

export type Tool = 'pen' | 'erase' | 'fill' | 'pick' | 'line' | 'rect' | 'ellipse' | 'select' | 'wand' | 'move' | 'hand';
export class PixelCanvas {
  ready = true;
  tool: Tool = 'pen'; temporary?: Tool; color = 0x70c989ff; background = 0xffffffff;
  size = 1; round = false; mirrorX = false; mirrorY = false; perfect = true; filled = false;
  contiguous = true; tolerance = 0; sampleAll = false; zoom = 8; grid = true; cellGrid = 0;
  checker: readonly [string, string] = ['#929aa7', '#b8bec8'];
  onion = false; onionBefore = 1; onionAfter = 1; onionOpacity = .25; onionPreviousColor = '#ff6677'; onionNextColor = '#66bbff';
  selection?: Uint8Array; floating?: Clipboard; clipboard?: Clipboard; private cutFloating = false;
  private floatTarget?: { asset: string; layer: string; frame: string; mask?: Uint8Array };
  private gesture?: { pointerId: number; button: number; ink: number; start: Point; last: Point; before?: PixelDocument; data?: Uint32Array; tool: Tool; points: Point[]; scrollX: number; scrollY: number; mouseX: number; mouseY: number; float?: Clipboard; floatX?: number; floatY?: number; selection?: Uint8Array };
  private cursor?: Point; private raf = 0; private inputTime = 0; latencies: number[] = [];
  onerror: (e: unknown) => void = () => {}; onchange: () => void = () => {}; onpick: (c: number) => void = () => {}; oncursor: (p: Point) => void = () => {};
  beforeEdit: () => void = () => {};
  get hasGesture(): boolean { return !!this.gesture; }
  readonly canvas: HTMLCanvasElement; readonly stage: HTMLElement; readonly session: Session;
  constructor(canvas: HTMLCanvasElement, stage: HTMLElement, session: Session) {
    this.canvas = canvas; this.stage = stage; this.session = session;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('pointerdown', e => { try { this.down(e); } catch (e) { this.abort(); this.onerror(e); } });
    canvas.addEventListener('pointermove', e => { try { this.move(e); } catch (e) { this.abort(); this.onerror(e); } });
    canvas.addEventListener('pointerup', e => { try { this.up(e); } catch (e) { this.abort(); this.onerror(e); } });
    canvas.addEventListener('pointercancel', e => { if (this.gesture?.pointerId === e.pointerId) this.abort(); });
    canvas.addEventListener('lostpointercapture', e => { if (this.gesture?.pointerId === e.pointerId) this.abort(); });
    canvas.addEventListener('pointerleave', () => { this.cursor = undefined; this.draw(); });
    window.addEventListener('blur', () => { this.temporary = undefined; this.abort(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.temporary = undefined; this.abort(); } });
    stage.addEventListener('wheel', e => { if (e.ctrlKey || e.altKey) { e.preventDefault(); if (e.deltaY) this.setZoom(this.zoom * (e.deltaY < 0 ? 2 : .5), e.clientX, e.clientY); } }, { passive: false });
  }
  get currentTool(): Tool { return this.temporary ?? this.tool; }
  setTool(tool: Tool): void { if (this.gesture) this.abort(); if (this.floating) this.confirm(); this.temporary = undefined; this.tool = tool; this.onchange(); this.draw(); }
  private setSelection(mask?: Uint8Array): void { this.selection = mask?.some(Boolean) ? mask : undefined; this.onchange(); this.draw(); }
  private point(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect(), a = this.session.asset;
    return a && r.width && r.height ? { x: Math.floor((e.clientX - r.left) * a.w / r.width), y: Math.floor((e.clientY - r.top) * a.h / r.height) } : { x: 0, y: 0 };
  }
  private assertWritable(): void {
    const a = this.session.asset, l = this.session.layer;
    if (!a || !l || l.type !== 'image') throw new Error('Chọn một layer ảnh để vẽ.');
    if (isLocked(a, l)) throw new Error('Layer hoặc nhóm đang khóa.');
    const id = l.cels[this.session.frameId];
    if (id && !a.cels[id].data) throw new Error('Cel đang tải; thử lại khi tải xong.');
    if (id && a.layers.some(layer => layer !== l && Object.values(layer.cels).includes(id) && isLocked(a, layer))) {
      throw new Error('Cel liên kết với một layer đang khóa.');
    }
  }
  private writable(): Uint32Array {
    this.assertWritable();
    const c = celFor(this.session.asset!, this.session.layerId, this.session.frameId, true)!; if (!c.data) throw new Error('Cel đang tải; thử lại khi tải xong.');
    c.data = c.data.slice(); delete c.blob; return c.data;
  }
  private brushOptions(): Brush { return { size: this.size, round: this.round, mirrorX: this.mirrorX, mirrorY: this.mirrorY, mask: this.selection }; }
  private down(e: PointerEvent): void {
    if (!this.ready || this.session.framePending || this.gesture || !this.session.asset || e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    this.canvas.focus({ preventScroll: true }); const p = this.point(e), tool = e.button === 1 ? 'hand' : this.currentTool;
    if (tool !== 'hand' && tool !== 'pick') this.beforeEdit();
    if (this.floating && !['hand', 'pick', 'move'].includes(tool)) this.confirm();
    this.canvas.setPointerCapture(e.pointerId);
    this.session.hold();
    this.gesture = { pointerId: e.pointerId, button: e.button, ink: e.button === 2 ? this.background : this.color, start: p, last: p, tool, points: [], scrollX: this.stage.scrollLeft, scrollY: this.stage.scrollTop, mouseX: e.clientX, mouseY: e.clientY, selection: this.selection, float: this.floating };
    if (tool === 'hand') return;
    if (tool === 'pick') { this.pick(p); return; }
    if (tool === 'move') {
      if (!this.floating) {
        this.assertWritable();
        const c = celFor(this.session.asset, this.session.layerId, this.session.frameId);
        if (!c?.data) return;
        this.beginFloat(copySelection(c.data, this.session.asset.w, this.selection), true);
      }
      if (this.floating) { this.gesture.floatX = this.floating.x; this.gesture.floatY = this.floating.y; } return;
    }
    if (tool === 'wand') { const a = this.session.asset, sample = this.sampleAll ? composite(a, this.session.frameId).data : celFor(a, this.session.layerId, this.session.frameId)?.data ?? new Uint32Array(a.w * a.h); this.setSelection(combineSelection(this.selection, region(sample, a.w, a.h, p.x, p.y, this.tolerance, this.contiguous), e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace')); return; }
    if (tool === 'select') return;
    this.assertWritable();
    this.gesture.before = this.session.begin();
    const data = this.writable(); this.gesture.data = data.slice();
    if (tool === 'fill') {
      const a = this.session.asset, sample = this.sampleAll ? composite(a, this.session.frameId).data : data;
      const mask = region(sample, a.w, a.h, p.x, p.y, this.tolerance, this.contiguous);
      for (let i = 0; i < data.length; i++) if (mask[i] && (!this.selection || this.selection[i])) data[i] = e.button === 2 ? this.background : this.color;
    } else if (tool === 'pen' || tool === 'erase') this.stroke(p, p, tool === 'erase' ? 0 : this.gesture.ink);
    this.inputTime = performance.now(); this.draw();
  }
  private stroke(from: Point, to: Point, color: number): void {
    const a = this.session.asset!, c = celFor(a, this.session.layerId, this.session.frameId)!, g = this.gesture!, b = this.brushOptions();
    line(from, to, (x, y) => {
      const last = g.points.at(-1); if (last?.x === x && last.y === y) return;
      g.points.push({ x, y });
      if (this.perfect && this.size === 1 && g.points.length >= 3) {
        const [p, q, r] = g.points.slice(-3);
        if (Math.abs(p.x - r.x) === 1 && Math.abs(p.y - r.y) === 1 && (p.x === q.x && q.y === r.y || p.y === q.y && q.x === r.x)) {
          const restore = (xx: number, yy: number) => { const i = yy * a.w + xx; if (xx >= 0 && yy >= 0 && xx < a.w && yy < a.h && (!this.selection || this.selection[i])) c.data![i] = g.data![i]; };
          restore(q.x, q.y); if (b.mirrorX) restore(a.w - q.x - 1, q.y); if (b.mirrorY) restore(q.x, a.h - q.y - 1); if (b.mirrorX && b.mirrorY) restore(a.w - q.x - 1, a.h - q.y - 1); g.points.splice(-2, 1);
        }
      }
      brush(c.data!, a.w, a.h, x, y, color, b);
    });
  }
  private move(e: PointerEvent): void {
    const g = this.gesture;
    if (g && g.pointerId !== e.pointerId) return;
    if (g && !(e.buttons & [1, 4, 2][g.button])) { this.finish(); return; }
    this.moveTo(e);
  }
  private moveTo(e: PointerEvent): void {
    const p = this.point(e); this.cursor = p; this.oncursor(p); const g = this.gesture;
    if (!g) { this.draw(); return; }
    if (g.tool === 'hand') { this.stage.scrollLeft = g.scrollX - (e.clientX - g.mouseX); this.stage.scrollTop = g.scrollY - (e.clientY - g.mouseY); return; }
    if (g.tool === 'pick') { this.pick(p); return; }
    if (g.tool === 'move' && this.floating) { let dx = p.x - g.start.x, dy = p.y - g.start.y; if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } this.floating.x = g.floatX! + dx; this.floating.y = g.floatY! + dy; this.draw(); return; }
    if (g.tool === 'select') { const a = this.session.asset!; this.selection = rectangle(a.w, a.h, g.start, this.constrain(p, e.shiftKey)); this.draw(); return; }
    if (g.tool === 'pen' || g.tool === 'erase') this.stroke(g.last, p, g.tool === 'erase' ? 0 : g.ink);
    else if (['line', 'rect', 'ellipse'].includes(g.tool)) {
      const a = this.session.asset!, c = celFor(a, this.session.layerId, this.session.frameId)!; c.data = g.data!.slice();
      const to = this.constrain(p, e.shiftKey), options = this.brushOptions(), set = (x: number, y: number) => brush(c.data!, a.w, a.h, x, y, g.ink, options);
      if (g.tool === 'line') line(g.start, to, set); else shape(g.start, to, g.tool === 'ellipse', this.filled, set);
    }
    g.last = p; this.inputTime = performance.now(); this.draw();
  }
  private constrain(p: Point, shift: boolean): Point {
    const start = this.gesture!.start; if (!shift) return p; const dx = p.x - start.x, dy = p.y - start.y, n = Math.max(Math.abs(dx), Math.abs(dy));
    if (this.gesture!.tool === 'line') { const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4; return { x: start.x + Math.round(Math.cos(angle) * n), y: start.y + Math.round(Math.sin(angle) * n) }; }
    return { x: start.x + Math.sign(dx || 1) * n, y: start.y + Math.sign(dy || 1) * n };
  }
  private up(e: PointerEvent): void {
    const g = this.gesture; if (!g || g.pointerId !== e.pointerId) return;
    if (e.button !== g.button) { this.finish(); return; }
    if (g.tool === 'select') {
      const a = this.session.asset!, mask = rectangle(a.w, a.h, g.start, this.constrain(this.point(e), e.shiftKey));
      this.setSelection(combineSelection(g.selection, mask, e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace'));
    } else if (['line', 'rect', 'ellipse', 'move', 'hand', 'pen', 'erase'].includes(g.tool)) this.moveTo(e);
    this.finish();
  }
  private finish(): void {
    const g = this.gesture!;
    this.gesture = undefined;
    try { if (g.data) this.session.end(g.before, 'Nét vẽ'); }
    finally { if (this.canvas.hasPointerCapture(g.pointerId)) this.canvas.releasePointerCapture(g.pointerId); this.session.release(); }
    this.onchange(); this.draw();
  }
  abort(): void {
    const g = this.gesture; this.gesture = undefined;
    if (!g) { this.onchange(); this.draw(); return; }
    if (g.before) this.session.rollback(g.before);
    if (g?.tool === 'select') this.setSelection(g.selection);
    if (g.tool === 'move') {
      if (!g.float) this.clearFloat();
      else { g.float.x = g.floatX ?? g.float.x; g.float.y = g.floatY ?? g.float.y; }
    }
    if (g && this.canvas.hasPointerCapture(g.pointerId)) this.canvas.releasePointerCapture(g.pointerId);
    this.session.release(); this.onchange(); this.draw();
  }
  private pick(p: Point): void { const a = this.session.asset!; const c = composite(a, this.session.frameId).get(p.x, p.y); this.color = c; this.onpick(c); }
  copy(cut = false): void {
    if (cut) { this.beforeEdit(); this.confirm(); this.assertWritable(); }
    const a = this.session.asset; if (!a) return; const c = celFor(a, this.session.layerId, this.session.frameId);
    if (c && !c.data) throw new Error('Cel đang tải; thử lại khi tải xong.');
    this.clipboard = copySelection(c?.data ?? new Uint32Array(a.w * a.h), a.w, this.selection);
    if (cut) this.eraseSelection();
  }
  paste(): void { if (!this.clipboard) throw new Error('Chưa có pixel trong clipboard của app.'); this.beforeEdit(); this.confirm(); this.assertWritable(); this.beginFloat(structuredClone(this.clipboard), false); this.tool = 'move'; this.onchange(); }
  eraseSelection(): void { this.beforeEdit(); this.confirm(); this.session.change('Xóa vùng chọn', () => { const data = this.writable(); for (let i = 0; i < data.length; i++) if (!this.selection || this.selection[i]) data[i] = 0; }); }
  all(): void { if (this.gesture) this.abort(); if (this.session.asset) this.setSelection(new Uint8Array(this.session.asset.w * this.session.asset.h).fill(1)); }
  private beginFloat(clip: Clipboard | undefined, cut: boolean): void {
    if (!clip) return;
    this.floating = clip; this.cutFloating = cut;
    this.floatTarget = { asset: this.session.assetId, layer: this.session.layerId, frame: this.session.frameId, mask: this.selection };
    this.onchange(); this.draw();
  }
  private clearFloat(): void { this.floating = undefined; this.cutFloating = false; this.floatTarget = undefined; }
  cancel(): void { if (this.gesture) this.abort(); this.clearFloat(); this.setSelection(); }
  confirm(): void {
    if (this.gesture) this.abort();
    if (!this.floating) return; const f = this.floating, clear = this.cutFloating;
    const target = this.floatTarget!, { w, h } = this.session.asset!;
    if (target.asset !== this.session.assetId || target.layer !== this.session.layerId || target.frame !== this.session.frameId) throw new Error('Đích của vùng nổi đã đổi. Hủy vùng nổi để tiếp tục.');
    if (clear && f.data.some((ink, i) => {
      const x = f.x + i % f.w, y = f.y + Math.floor(i / f.w);
      return f.mask[i] && (ink & 255) && (x < 0 || y < 0 || x >= w || y >= h);
    })) throw new Error('Vùng nổi có pixel nằm ngoài canvas. Đưa vùng vào trong hoặc bấm Esc để hủy.');
    this.session.change('Dán/di chuyển vùng', () => {
      const a = this.session.asset!, data = this.writable();
      if (clear) for (let i = 0; i < data.length; i++) if (!target.mask || target.mask[i]) data[i] = 0;
      const mask = new Uint8Array(a.w * a.h);
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) { const dx = x + f.x, dy = y + f.y, i = y * f.w + x; if (f.mask[i] && dx >= 0 && dy >= 0 && dx < a.w && dy < a.h) { data[dy * a.w + dx] = f.data[i]; mask[dy * a.w + dx] = 1; } }
      this.setSelection(mask);
    }); this.clearFloat(); this.onchange(); this.draw();
  }
  transform(mode: 'x' | 'y' | 'rotate'): void {
    if (this.gesture) this.abort();
    this.beforeEdit(); this.assertWritable();
    if (!this.floating) {
      const a = this.session.asset!, c = celFor(a, this.session.layerId, this.session.frameId);
      if (c && !c.data) throw new Error('Cel đang tải; thử lại khi tải xong.');
      this.beginFloat(copySelection(c?.data ?? new Uint32Array(a.w * a.h), a.w, this.selection), true);
    }
    if (this.floating) this.floating = transformClipboard(this.floating, mode); this.draw();
  }
  nudge(x: number, y: number): void { if (this.floating) { this.floating.x += x; this.floating.y += y; this.draw(); } }
  reset(): void { this.cancel(); this.latencies = []; }
  setZoom(value: number, clientX?: number, clientY?: number): void {
    if (this.gesture || !this.session.asset || !Number.isFinite(value)) return;
    const r = this.canvas.getBoundingClientRect(), stage = this.stage.getBoundingClientRect();
    const x = clientX ?? stage.left + this.stage.clientWidth / 2, y = clientY ?? stage.top + this.stage.clientHeight / 2;
    const px = r.width ? (x - r.left) / r.width : .5, py = r.height ? (y - r.top) / r.height : .5;
    this.zoom = Math.max(.125, Math.min(64, value)); if (this.zoom >= 1) this.zoom = Math.round(this.zoom);
    try { if (this.session.doc) localStorage.setItem(`pxl.pixel.zoom.${this.session.doc.id}`, String(this.zoom)); } catch { /* View only. */ }
    this.present(); const next = this.canvas.getBoundingClientRect(); this.stage.scrollLeft += next.left + px * next.width - x; this.stage.scrollTop += next.top + py * next.height - y; this.onchange();
  }
  fit(restore = false): void {
    const a = this.session.asset; if (this.gesture || !a) return;
    const key = `pxl.pixel.zoom.${this.session.doc!.id}`;
    let saved = 0;
    try { if (restore) saved = Number(localStorage.getItem(key)); else localStorage.removeItem(key); } catch { /* View only. */ }
    const fit = Math.min((this.stage.clientWidth - 48) / a.w, (this.stage.clientHeight - 48) / a.h);
    this.zoom = saved >= .125 && saved <= 64 ? saved : fit >= 1 ? Math.min(64, Math.floor(fit)) : Math.max(.125, 2 ** Math.floor(Math.log2(fit)));
    this.draw(); this.onchange();
  }
  draw(): void { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); if (this.inputTime) { this.latencies.push(performance.now() - this.inputTime); if (this.latencies.length > 2000) this.latencies.shift(); this.inputTime = 0; } }); }
  present(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.render(); }
  private image(img: Img): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = img.w; c.height = img.h; const data = new Uint8ClampedArray(img.data.length * 4);
    for (let i = 0; i < img.data.length; i++) { const p = img.data[i]; data[i * 4] = p >>> 24; data[i * 4 + 1] = p >>> 16 & 255; data[i * 4 + 2] = p >>> 8 & 255; data[i * 4 + 3] = p & 255; }
    c.getContext('2d')!.putImageData(new ImageData(data, img.w, img.h), 0, 0); return c;
  }
  private render(): void {
    const a = this.session.asset, c = this.canvas; c.hidden = !a || !this.ready || this.session.framePending; if (c.hidden || !a) return;
    const width = Math.max(1, Math.round(a.w * this.zoom)), height = Math.max(1, Math.round(a.h * this.zoom)); if (c.width !== width) c.width = width; if (c.height !== height) c.height = height;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.fillStyle = this.checker[0]; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = this.checker[1]; const cell = Math.max(4, Math.round(this.zoom * 4)); for (let y = 0; y < height; y += cell) for (let x = 0; x < width; x += cell) if ((x / cell + y / cell) % 2 === 0) ctx.fillRect(x, y, cell, cell);
    if (this.onion) {
      const current = a.frames.findIndex(f => f.id === this.session.frameId);
      for (const dir of [-1, 1]) for (let n = 1; n <= (dir < 0 ? this.onionBefore : this.onionAfter); n++) {
        const f = a.frames[current + n * dir]; if (!f) continue;
        const ghost = this.image(composite(a, f.id)), gc = ghost.getContext('2d')!; gc.globalCompositeOperation = 'source-in'; gc.fillStyle = dir < 0 ? this.onionPreviousColor : this.onionNextColor; gc.fillRect(0, 0, a.w, a.h);
        ctx.globalAlpha = this.onionOpacity / n; ctx.drawImage(ghost, 0, 0, width, height); ctx.globalAlpha = 1;
      }
    }
    const img = composite(a, this.session.frameId);
    if (this.floating) {
      const f = this.floating;
      // Display a floating selection using a temporary cel, leaving the saved document untouched.
      const layer = this.session.layer, cel = layer && celFor(a, layer.id, this.session.frameId), previous = cel?.data;
      if (layer?.type === 'image') {
        const temp = previous?.slice() ?? new Uint32Array(a.w * a.h);
        if (this.cutFloating) for (let i = 0; i < temp.length; i++) if (!this.floatTarget?.mask || this.floatTarget.mask[i]) temp[i] = 0;
        for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (f.mask[y * f.w + x]) { const dx = x + f.x, dy = y + f.y; if (dx >= 0 && dy >= 0 && dx < a.w && dy < a.h) temp[dy * a.w + dx] = f.data[y * f.w + x]; }
        if (cel) { cel.data = temp; img.data.set(composite(a, this.session.frameId).data); cel.data = previous; }
        else for (let i = 0; i < temp.length; i++) img.data[i] = over(img.data[i], temp[i]);
      }
    }
    ctx.drawImage(this.image(img), 0, 0, width, height);
    if (this.grid && this.zoom >= 4 || this.cellGrid > 0) { ctx.lineWidth = 1; ctx.strokeStyle = '#00000055'; ctx.beginPath(); const step = this.cellGrid > 0 ? this.cellGrid : 1; for (let x = 0; x <= a.w; x += step) { ctx.moveTo(x * this.zoom + .5, 0); ctx.lineTo(x * this.zoom + .5, height); } for (let y = 0; y <= a.h; y += step) { ctx.moveTo(0, y * this.zoom + .5); ctx.lineTo(width, y * this.zoom + .5); } ctx.stroke(); }
    if (this.selection) { ctx.fillStyle = '#5acff333'; for (let i = 0; i < this.selection.length; i++) if (this.selection[i]) ctx.fillRect(i % a.w * this.zoom, Math.floor(i / a.w) * this.zoom, this.zoom, this.zoom); }
    if (this.floating) { const f = this.floating; ctx.strokeStyle = '#f0cc72'; ctx.setLineDash([4, 4]); ctx.strokeRect(f.x * this.zoom + .5, f.y * this.zoom + .5, f.w * this.zoom, f.h * this.zoom); ctx.setLineDash([]); }
    if (this.cursor && ['pen', 'erase', 'line', 'rect', 'ellipse'].includes(this.currentTool)) { const p = this.cursor; ctx.strokeStyle = 'white'; ctx.strokeRect((p.x - Math.floor(this.size / 2)) * this.zoom + .5, (p.y - Math.floor(this.size / 2)) * this.zoom + .5, this.size * this.zoom, this.size * this.zoom); }
    c.style.cursor = this.currentTool === 'hand' ? 'grab' : 'crosshair';
  }
}
