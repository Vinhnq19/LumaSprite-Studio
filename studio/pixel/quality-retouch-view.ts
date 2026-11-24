import { RetouchEditor } from '../../src/studio/quality/retouch-editor.ts';
import type { Point } from '../../src/studio/pixel/tools.ts';
import { drawClipRaster } from './clip-pose-view.ts';
import { Commands, shortcut, type Bindings } from '../../src/studio/pixel/commands.ts';

/** Presentation only: edits and history belong to RetouchEditor. */
export class QualityRetouchView {
  readonly root = document.createElement('div'); readonly canvas: HTMLCanvasElement;
  private frame = ''; private busy = false; private color = 0;
  private drag?: { pointer: number; last: Point };
  private reference?: Uint32Array; private previous?: Uint32Array; private mask?: Uint8Array;
  private model: RetouchEditor; private onChange: () => void; private onError: (e: unknown) => void;
  private commands = new Commands();
  constructor(model: RetouchEditor, onChange: () => void, onError: (e: unknown) => void) {
    this.model = model; this.onChange = onChange; this.onError = onError;
    this.root.className = 'quality-retouch-view';
    this.root.innerHTML = `<div class="row wrap"><label>Công cụ<select id="quality-retouch-tool"><option value="pen">Bút</option><option value="eraser">Tẩy</option></select></label><label>Cỡ<input id="quality-retouch-size" type="number" min="1" max="64" value="1"></label><label>Phóng<select id="quality-retouch-zoom"><option>1</option><option>2</option><option>4</option><option selected>8</option><option>12</option></select></label><button id="quality-retouch-undo" type="button">Undo</button><button id="quality-retouch-redo" type="button">Redo</button><label><input id="quality-retouch-lock" type="checkbox">Khóa frame tốt</label></div>
<div id="quality-retouch-palette" class="row wrap" aria-label="Palette đề xuất"></div>
<div class="row wrap"><label>X<input id="quality-retouch-region-x" type="number" min="0" value="0"></label><label>Y<input id="quality-retouch-region-y" type="number" min="0" value="0"></label><label>Rộng<input id="quality-retouch-region-w" type="number" min="1"></label><label>Cao<input id="quality-retouch-region-h" type="number" min="1"></label><button id="quality-retouch-region-set" type="button">Giới hạn vùng sửa</button><button id="quality-retouch-region-reset" type="button">Vùng kế thừa</button></div>
<p id="quality-retouch-region-info" class="hint"></p><div class="row wrap"><label><input id="quality-retouch-onion" type="checkbox">Onion frame trước</label><label><input id="quality-retouch-diff" type="checkbox">Khác biệt với bản trước sửa</label><label><input id="quality-retouch-mask" type="checkbox" checked>Hiện vùng khóa</label></div>
<div class="compare"><figure><figcaption>Trước sửa · biến thể gốc</figcaption><div class="proposal-image"><canvas id="quality-retouch-before"></canvas></div></figure><figure><figcaption>Đang sửa · lớp kiểm tra không xuất vào ảnh</figcaption><div class="proposal-image"><div class="retouch-stack"><canvas id="quality-retouch-previous"></canvas><canvas id="quality-retouch-canvas" tabindex="0" aria-label="Vẽ sửa pixel đề xuất"></canvas><canvas id="quality-retouch-overlay"></canvas></div></div></figure></div>`;
    this.canvas = this.el<HTMLCanvasElement>('canvas'); this.canvas.style.touchAction = 'none';
    this.model.palette.forEach((p, i) => {
      const button = document.createElement('button'), hex = '#' + p.toString(16).padStart(8, '0');
      button.type = 'button'; button.dataset.colorIndex = String(i); button.title = hex; button.setAttribute('aria-label', hex); button.style.background = hex;
      button.onclick = () => { if (!this.busy) { this.color = i; this.palette(); } }; this.el('palette').append(button);
    });
    for (const [id, title, keys, run] of [
      ['edit.undo', 'Undo', ['Ctrl+z'], () => this.change(() => this.model.undo())],
      ['edit.redo', 'Redo', ['Ctrl+Shift+z', 'Ctrl+y'], () => this.change(() => this.model.undo(true))],
      ['tool.pen', 'Bút', ['p'], () => { this.el<HTMLSelectElement>('tool').value = 'pen'; }],
      ['tool.erase', 'Tẩy', ['e'], () => { this.el<HTMLSelectElement>('tool').value = 'eraser'; }],
      ['brush.smaller', 'Giảm cỡ bút', ['['], () => { this.el<HTMLInputElement>('size').value = String(Math.max(1, Math.min(64, (this.number('size') || 1) - 1))); }],
      ['brush.larger', 'Tăng cỡ bút', [']'], () => { this.el<HTMLInputElement>('size').value = String(Math.max(1, Math.min(64, (this.number('size') || 1) + 1))); }],
    ] as [string, string, string[], () => void][]) this.commands.add({ id, title, keys, run, enabled: () => !this.busy && !!this.frame });
    try { const saved = JSON.parse(localStorage.getItem('pxl.pixel.shortcuts') ?? '{}') as Bindings; this.commands.configure(Object.fromEntries(Object.entries(saved).filter(([id]) => this.commands.items.has(id)))); }
    catch { this.commands.configure({}); }
    this.el<HTMLButtonElement>('undo').onclick = () => this.commands.execute('edit.undo');
    this.el<HTMLButtonElement>('redo').onclick = () => this.commands.execute('edit.redo');
    this.el<HTMLInputElement>('lock').onchange = () => this.change(() => this.model.setLocked(this.frame, this.el<HTMLInputElement>('lock').checked));
    this.el<HTMLButtonElement>('region-set').onclick = () => this.change(() => this.model.setRegion({ x: this.number('region-x'), y: this.number('region-y'), w: this.number('region-w'), h: this.number('region-h') }));
    this.el<HTMLButtonElement>('region-reset').onclick = () => this.change(() => this.model.setRegion(null));
    for (const id of ['zoom', 'onion', 'diff', 'mask']) this.el(id).addEventListener('change', () => this.draw());
    this.canvas.addEventListener('pointerdown', e => {
      if (this.busy || !this.frame || e.button !== 0 || this.drag) return;
      e.preventDefault(); this.canvas.focus({ preventScroll: true });
      try { this.model.beginStroke(this.frame); this.drag = { pointer: e.pointerId, last: this.point(e) }; this.canvas.setPointerCapture(e.pointerId); this.paint(this.drag.last); }
      catch (error) { this.cancel(); this.onError(error); }
    });
    this.canvas.addEventListener('pointermove', e => { if (this.drag?.pointer === e.pointerId) { try { this.paint(this.point(e)); } catch (error) { this.cancel(); this.onError(error); } } });
    this.canvas.addEventListener('pointerup', e => {
      if (this.drag?.pointer !== e.pointerId) return;
      const pointer = this.drag.pointer; this.drag = undefined; this.release(pointer);
      try { if (this.model.endStroke()) this.onChange(); this.draw(); } catch (error) { this.model.cancelStroke(); this.onError(error); }
    });
    this.canvas.addEventListener('pointercancel', () => this.cancel());
    this.canvas.addEventListener('lostpointercapture', () => this.cancel()); window.addEventListener('blur', this.blur);
    this.root.addEventListener('keydown', e => {
      if (this.busy || e.isComposing || e.keyCode === 229 || (e.target as HTMLElement).closest('input,textarea,select,[contenteditable],.cm-editor')) return;
      const key = shortcut(e), id = Object.keys(this.commands.bindings).find(id => this.commands.bindings[id].includes(key));
      if (id) { e.preventDefault(); e.stopPropagation(); this.commands.execute(id); }
    });
    this.render();
  }
  private el<T extends HTMLElement = HTMLElement>(name: string): T { return this.root.querySelector('#quality-retouch-' + name)! as T; }
  private number(name: string): number { const value = this.el<HTMLInputElement | HTMLSelectElement>(name).value; return value === '' ? NaN : Number(value); }
  private blur = () => this.cancel();
  private release(id: number): void { if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id); }
  private cancel(): void { if (!this.drag) return; const id = this.drag.pointer; this.drag = undefined; this.model.cancelStroke(); this.release(id); this.draw(); }
  private change(action: () => void): void {
    if (this.busy || !this.frame) return; this.cancel();
    try { action(); this.onChange(); } catch (error) { this.onError(error); } finally { this.render(); }
  }
  private point(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(this.model.w - 1, Math.floor((e.clientX - r.left) * this.model.w / r.width))), y: Math.max(0, Math.min(this.model.h - 1, Math.floor((e.clientY - r.top) * this.model.h / r.height))) };
  }
  private paint(to: Point): void {
    this.model.paint(this.drag!.last, to, this.el<HTMLSelectElement>('tool').value === 'eraser' ? null : this.color, this.number('size')); this.drag!.last = to; this.draw();
  }
  private palette(): void { this.root.querySelectorAll<HTMLButtonElement>('[data-color-index]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.colorIndex) === this.color))); }
  setFrame(id: string): void { this.cancel(); this.model.getPixels(id); this.frame = id; this.render(); }
  setReference(before: Uint32Array, previous?: Uint32Array, mask?: Uint8Array): void { this.reference = before; this.previous = previous; this.mask = mask; this.draw(); }
  setBusy(value: boolean): void { if (value === this.busy) return; if (value) this.cancel(); this.busy = value; this.render(); }
  render(): void {
    this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(e => { e.disabled = this.busy || !this.frame; });
    this.el<HTMLInputElement>('lock').checked = this.model.state.lockedFrames.includes(this.frame);
    const r = this.model.state.region ?? { x: 0, y: 0, w: this.model.w, h: this.model.h };
    for (const key of ['x', 'y', 'w', 'h'] as const) this.el<HTMLInputElement>('region-' + key).value = String(r[key]);
    this.el('region-info').textContent = `Vùng ${r.x},${r.y} · ${r.w}×${r.h}. Chỉ thu hẹp vùng đã duyệt; frame khóa không nhận nét. Một nét kéo = một Undo.`;
    this.palette(); this.draw();
  }
  private draw(): void {
    if (!this.frame) return; const { w, h } = this.model, pixels = this.model.getPixels(this.frame), zoom = this.number('zoom');
    drawClipRaster(this.canvas, pixels, w, h);
    if (this.reference) drawClipRaster(this.el<HTMLCanvasElement>('before'), this.reference, w, h);
    const prev = this.el<HTMLCanvasElement>('previous'); prev.width = w; prev.height = h;
    if (this.previous && this.el<HTMLInputElement>('onion').checked) { drawClipRaster(prev, this.previous, w, h); prev.style.opacity = '.25'; }
    const overlay = this.el<HTMLCanvasElement>('overlay'); overlay.width = w; overlay.height = h; const ctx = overlay.getContext('2d')!;
    const r = this.model.state.region, diff = this.el<HTMLInputElement>('diff').checked, mask = this.el<HTMLInputElement>('mask').checked, locked = this.model.state.lockedFrames.includes(this.frame);
    for (let i = 0; i < pixels.length; i++) {
      const x = i % w, y = Math.floor(i / w), outside = locked || (this.mask && !this.mask[i]) || (r && (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h));
      if (diff && this.reference && pixels[i] !== this.reference[i]) ctx.fillStyle = '#ff50a0b0';
      else if (mask && outside) ctx.fillStyle = '#ef645b50'; else continue;
      ctx.fillRect(x, y, 1, 1);
    }
    this.root.querySelectorAll('canvas').forEach(c => { c.style.width = w * zoom + 'px'; c.style.height = h * zoom + 'px'; c.style.imageRendering = 'pixelated'; });
  }
  dispose(): void { this.cancel(); window.removeEventListener('blur', this.blur); }
}
