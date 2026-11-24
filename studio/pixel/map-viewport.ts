import type { Session } from './session.ts';
import { MapStroke, getMap, getMapLayer } from '../../src/studio/map-commands.ts';
import { mapPixelSize, renderMapCells } from '../../src/studio/tilemap-render.ts';
import type { Img } from '../../src/core/image.ts';
import type { PixelDocument } from '../../src/studio/pixel/model.ts';

export interface CellRect { x: number; y: number; w: number; h: number }
export type MapTool = 'pen' | 'erase' | 'fill' | 'select' | 'hand';
interface Options {
  session: Session; mapId: () => string; layerId: () => string; tool: () => MapTool;
  tileId: () => number; autotile: () => boolean;
  load: (rect: CellRect) => Promise<void>;
  fill: (x: number, y: number) => Promise<void>;
  error: (error: unknown) => void;
  status: (text: string) => void;
}
interface Gesture { pointer: number; doc: PixelDocument; version: number; start: { x: number; y: number }; last: { x: number; y: number }; stroke?: MapStroke; pan?: { x: number; y: number; cx: number; cy: number }; select?: boolean }
const zoomLevels = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 3, 4, 5, 6, 7, 8];
export class MapViewport {
  readonly canvas: HTMLCanvasElement;
  private stage: HTMLElement;
  private options: Options;
  private resize: ResizeObserver;
  private gesture?: Gesture;
  private frame = 0;
  private ticket = 0;
  private ready = false;
  private images = new Map<string, Img>();
  private stamp = '';
  private paintedView = '';
  private space = false;
  zoom = 2; camera = { x: 0, y: 0 }; grid = true; collision = false;
  selection?: CellRect;
  cursor = { x: 0, y: 0 };
  constructor(stage: HTMLElement, options: Options) {
    this.stage = stage; this.options = options;
    this.canvas = document.createElement('canvas'); this.canvas.id = 'map-canvas'; this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-label', 'Vùng vẽ bản đồ'); stage.append(this.canvas);
    this.resize = new ResizeObserver(() => this.draw()); this.resize.observe(stage);
    this.canvas.onpointerdown = e => this.down(e);
    this.canvas.onpointermove = e => this.move(e);
    this.canvas.onpointerup = e => this.up(e);
    this.canvas.onpointercancel = () => this.cancel(); this.canvas.onlostpointercapture = () => { if (this.gesture) this.cancel(); };
    this.canvas.oncontextmenu = e => e.preventDefault();
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault(); if (this.gesture) return;
      const point = this.point(e), index = zoomLevels.indexOf(this.zoom);
      const next = zoomLevels[Math.max(0, Math.min(zoomLevels.length - 1, index + (e.deltaY < 0 ? 1 : -1)))];
      this.camera.x = point.x - (point.x - this.camera.x) * next / this.zoom;
      this.camera.y = point.y - (point.y - this.camera.y) * next / this.zoom;
      this.zoom = next; this.saveView(); this.draw();
    }, { passive: false });
    this.canvas.onkeydown = e => { if (!e.isComposing && e.code === 'Space') { this.space = true; e.preventDefault(); e.stopPropagation(); } if (e.key === 'Escape') { this.cancel(); e.preventDefault(); e.stopPropagation(); } };
    this.canvas.onkeyup = e => { if (e.code === 'Space') { this.space = false; e.preventDefault(); e.stopPropagation(); } };
    this.canvas.onblur = () => { this.space = false; this.cancel(); };
    window.addEventListener('blur', () => { this.space = false; this.cancel(); });
  }
  get hasGesture(): boolean { return !!this.gesture; }
  private point(e: MouseEvent): { x: number; y: number } { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private cell(e: MouseEvent): { x: number; y: number } {
    const p = this.point(e), size = mapPixelSize(this.options.session.doc!, this.options.mapId()).tileSize * this.zoom;
    return { x: Math.floor((p.x - this.camera.x) / size), y: Math.floor((p.y - this.camera.y) / size) };
  }
  private inside(p: { x: number; y: number }): boolean { const m = getMap(this.options.session.doc!, this.options.mapId()); return p.x >= 0 && p.y >= 0 && p.x < m.w && p.y < m.h; }
  private valid(g: Gesture): boolean { return this.options.session.doc === g.doc && this.options.session.version === g.version && !this.options.session.conflict; }
  private down(e: PointerEvent): void {
    const session = this.options.session; if (!this.ready || !session.doc || this.gesture || ![0, 1, 2].includes(e.button)) return;
    try {
      this.canvas.focus({ preventScroll: true }); const tool = this.options.tool(), p = this.cell(e), screen = this.point(e);
      if (!this.inside(p) && tool !== 'hand' && e.button !== 1 && !this.space) return;
      const g: Gesture = { pointer: e.pointerId, doc: session.doc, version: session.version, start: p, last: p };
      if (tool === 'hand' || e.button === 1 || this.space) g.pan = { ...screen, cx: this.camera.x, cy: this.camera.y };
      else if (tool === 'select') { g.select = true; this.selection = { ...p, w: 1, h: 1 }; }
      else if (tool === 'fill') { void this.options.fill(p.x, p.y).catch(this.options.error); return; }
      else { g.stroke = new MapStroke(session.doc, this.options.mapId(), this.options.layerId()); session.hold(); g.stroke.set(p.x, p.y, tool === 'erase' || e.button === 2 ? 0 : this.options.tileId(), this.options.autotile()); }
      this.gesture = g; this.canvas.setPointerCapture(e.pointerId); e.preventDefault(); this.draw();
    } catch (error) { session.release(); this.options.error(error); }
  }
  private move(e: PointerEvent): void {
    if (!this.options.session.doc || !this.options.mapId()) return;
    const p = this.cell(e); this.cursor = p;
    const g = this.gesture; if (!g) return;
    if (!this.valid(g)) { this.cancel(); return; }
    try {
      if (g.pan) { const screen = this.point(e); this.camera = { x: g.pan.cx + screen.x - g.pan.x, y: g.pan.cy + screen.y - g.pan.y }; }
      else if (g.select && this.inside(p)) this.selection = { x: Math.min(p.x, g.start.x), y: Math.min(p.y, g.start.y), w: Math.abs(p.x - g.start.x) + 1, h: Math.abs(p.y - g.start.y) + 1 };
      else if (g.stroke && this.inside(p)) {
        const steps = Math.max(Math.abs(p.x - g.last.x), Math.abs(p.y - g.last.y), 1);
        for (let i = 1; i <= steps; i++) g.stroke.set(Math.round(g.last.x + (p.x - g.last.x) * i / steps), Math.round(g.last.y + (p.y - g.last.y) * i / steps), this.options.tool() === 'erase' || (e.buttons & 2) ? 0 : this.options.tileId(), this.options.autotile());
        g.last = p;
      }
      this.draw();
    } catch (error) { this.cancel(); this.options.error(error); }
  }
  private up(e: PointerEvent): void {
    const g = this.gesture; if (!g || g.pointer !== e.pointerId) return;
    this.gesture = undefined;
    if (g.pan && this.valid(g)) this.saveView();
    try { if (g.stroke) { if (!this.valid(g)) g.stroke.cancel(); else this.options.session.change('Vẽ ô bản đồ', () => g.stroke!.commit()); } }
    catch (error) { this.options.error(error); }
    finally { if (g.stroke) this.options.session.release(); if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId); this.draw(); }
  }
  cancel(): void {
    const g = this.gesture; this.gesture = undefined;
    if (g?.stroke) { g.stroke.cancel(); this.options.session.release(); }
    if (g?.select) this.selection = undefined;
    if (g && this.canvas.hasPointerCapture(g.pointer)) this.canvas.releasePointerCapture(g.pointer);
    if (g) this.draw();
  }
  private viewKey(): string {
    return `pxl:map-view:${this.options.session.doc?.id}:${this.options.mapId()}`;
  }
  private saveView(): void {
    try { localStorage.setItem(this.viewKey(), JSON.stringify({ zoom: this.zoom, ...this.camera })); } catch { /* Preferences are optional. */ }
  }
  restoreView(): void {
    this.selection = undefined;
    try {
      const saved = JSON.parse(localStorage.getItem(this.viewKey()) ?? 'null');
      if (saved && zoomLevels.includes(saved.zoom) && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        this.zoom = saved.zoom; this.camera = { x: saved.x, y: saved.y }; this.draw(); return;
      }
    } catch { /* The viewport can start with Fit. */ }
    this.fit(false, 1);
  }
  fit(persist = true, minimumZoom = zoomLevels[0]): void {
    const doc = this.options.session.doc; if (!doc || !this.options.mapId()) return;
    const dims = mapPixelSize(doc, this.options.mapId());
    const ratio = Math.min(this.stage.clientWidth / dims.w, this.stage.clientHeight / dims.h);
    this.zoom = Math.max(minimumZoom, zoomLevels.findLast(level => level <= ratio) ?? zoomLevels[0]);
    this.center(persist, this.zoom > ratio);
  }
  center(persist = true, topLeftIfClipped = false): void {
    const doc = this.options.session.doc; if (!doc || !this.options.mapId()) return;
    const dims = mapPixelSize(doc, this.options.mapId());
    const x = Math.floor((this.stage.clientWidth - dims.w * this.zoom) / 2), y = Math.floor((this.stage.clientHeight - dims.h * this.zoom) / 2);
    this.camera = topLeftIfClipped ? { x: Math.max(0, x), y: Math.max(0, y) } : { x, y };
    if (persist) this.saveView();
    this.draw();
  }
  actual(): void {
    this.zoom = 1; this.center(true, true);
  }
  reset(): void { this.ticket++; this.cancel(); cancelAnimationFrame(this.frame); this.frame = 0; this.ready = false; delete this.canvas.dataset.ready; this.images.clear(); this.stamp = ''; this.selection = undefined; this.canvas.width = this.canvas.height = 1; }
  draw(): void { if (this.frame) return; this.frame = requestAnimationFrame(() => { this.frame = 0; void this.render().catch(error => this.options.error(error)); }); }
  private async render(): Promise<void> {
    const s = this.options.session, doc = s.doc, id = this.options.mapId(); if (!doc || !id || !this.canvas.closest('dialog[open]')) return;
    const version = s.version, ticket = ++this.ticket, layerId = this.options.layerId(), map = getMap(doc, id), size = mapPixelSize(doc, id).tileSize * this.zoom;
    const currentOwner = () => s.doc === doc && s.version === version && ticket === this.ticket && id === this.options.mapId() && layerId === this.options.layerId() && !!this.canvas.closest('dialog[open]');
    this.canvas.dataset.zoom = String(this.zoom); this.canvas.dataset.cameraX = String(this.camera.x); this.canvas.dataset.cameraY = String(this.camera.y); this.canvas.dataset.tileSize = String(size / this.zoom);
    const w = Math.max(1, Math.min(4096, this.stage.clientWidth)), h = Math.max(1, Math.min(4096, this.stage.clientHeight));
    if (this.canvas.width !== w) this.canvas.width = w; if (this.canvas.height !== h) this.canvas.height = h;
    const ctx = this.canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    const x = Math.max(0, Math.floor(-this.camera.x / size)), y = Math.max(0, Math.floor(-this.camera.y / size));
    let rect = { x, y, w: Math.min(map.w, Math.ceil((w - this.camera.x) / size)) - x, h: Math.min(map.h, Math.ceil((h - this.camera.y) / size)) - y };
    const view = `${doc.id}:${version}:${doc.revision}:${id}:${layerId}:${w}:${h}:${size}:${this.camera.x}:${this.camera.y}:${this.grid}:${this.collision}:${JSON.stringify(this.selection)}`;
    const dirty = this.gesture?.stroke?.takePaintRect();
    const partial = !!this.gesture?.stroke && this.ready && this.paintedView === view;
    if (rect.w < 1 || rect.h < 1) { ctx.clearRect(0, 0, w, h); this.ready = true; this.canvas.dataset.ready = 'true'; this.paintedView = view; return; }
    if (partial) {
      if (!dirty) { this.canvas.dataset.paintKind = 'unchanged'; this.canvas.dataset.paintSequence = String(Number(this.canvas.dataset.paintSequence ?? 0) + 1); return; }
      const right = Math.min(rect.x + rect.w, dirty.x + dirty.w), bottom = Math.min(rect.y + rect.h, dirty.y + dirty.h);
      rect = { x: Math.max(rect.x, dirty.x), y: Math.max(rect.y, dirty.y), w: 0, h: 0 }; rect.w = right - rect.x; rect.h = bottom - rect.y;
      if (rect.w < 1 || rect.h < 1) { this.canvas.dataset.paintKind = 'outside'; this.canvas.dataset.paintSequence = String(Number(this.canvas.dataset.paintSequence ?? 0) + 1); return; }
    }
    if (!this.gesture?.stroke) {
      this.ready = false;
      this.canvas.dataset.ready = 'false';
      try { await this.options.load(rect); }
      catch (error) { if (currentOwner()) this.options.error(error); return; }
    }
    if (!currentOwner()) return;
    const stamp = `${doc.id}:${version}:${doc.revision}`;
    if (this.stamp !== stamp) { this.images.clear(); this.stamp = stamp; }
    const current = this.gesture?.stroke?.preview() ?? doc;
    const ox = Math.round(this.camera.x + rect.x * size), oy = Math.round(this.camera.y + rect.y * size);
    ctx.save();
    if (partial) { ctx.beginPath(); ctx.rect(ox, oy, rect.w * size, rect.h * size); ctx.clip(); ctx.clearRect(ox, oy, rect.w * size, rect.h * size); }
    else ctx.clearRect(0, 0, w, h);
    const tileSize = size / this.zoom, step = Math.floor(1024 / tileSize);
    const buffer = document.createElement('canvas');
    for (let dy = 0; dy < rect.h; dy += step) for (let dx = 0; dx < rect.w; dx += step) {
      const image = renderMapCells(current, id, { x: rect.x + dx, y: rect.y + dy, w: Math.min(step, rect.w - dx), h: Math.min(step, rect.h - dy) }, this.images);
      const pixels = new Uint8ClampedArray(image.data.length * 4);
      image.data.forEach((c, i) => { pixels[i * 4] = c >>> 24; pixels[i * 4 + 1] = c >>> 16 & 255; pixels[i * 4 + 2] = c >>> 8 & 255; pixels[i * 4 + 3] = c & 255; });
      buffer.width = image.w; buffer.height = image.h;
      buffer.getContext('2d')!.putImageData(new ImageData(pixels, image.w, image.h), 0, 0);
      ctx.drawImage(buffer, ox + dx * size, oy + dy * size, image.w * this.zoom, image.h * this.zoom);
    }
    buffer.width = buffer.height = 1;
    if (!partial) {
      ctx.strokeStyle = '#b3c4d6'; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(this.camera.x) - .5, Math.round(this.camera.y) - .5, map.w * size + 1, map.h * size + 1);
    }
    if (this.grid && size >= 8) {
      ctx.strokeStyle = '#a0b2ca44'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i <= rect.w; i++) { ctx.moveTo(ox + i * size + .5, oy); ctx.lineTo(ox + i * size + .5, oy + rect.h * size); }
      for (let i = 0; i <= rect.h; i++) { ctx.moveTo(ox, oy + i * size + .5); ctx.lineTo(ox + rect.w * size, oy + i * size + .5); } ctx.stroke();
    }
    if (this.collision) for (const layer of map.layers.filter(l => l.visible)) {
      const set = current.studio!.tilesets![layer.tilesetId], reader = new MapStroke(current, id, layer.id, true);
      for (let dy = 0; dy < rect.h; dy++) for (let dx = 0; dx < rect.w; dx++) {
        const tile = set.tiles.find(t => t.id === reader.get(rect.x + dx, rect.y + dy));
        if (tile && tile.collision !== 'empty') { ctx.fillStyle = tile.collision === 'solid' ? '#ff668844' : '#ffd166aa'; ctx.fillRect(ox + dx * size, oy + dy * size, size, tile.collision === 'solid' ? size : 3); }
      } reader.cancel();
    }
    if (this.selection) { const r = this.selection; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeRect(this.camera.x + r.x * size, this.camera.y + r.y * size, r.w * size, r.h * size); ctx.setLineDash([]); }
    ctx.restore(); this.paintedView = view; this.canvas.dataset.paintKind = partial ? 'partial' : 'full';
    this.ready = true; this.canvas.dataset.ready = 'true'; this.canvas.dataset.paintSequence = String(Number(this.canvas.dataset.paintSequence ?? 0) + 1); this.options.status(`${map.w}×${map.h} ô · ${this.zoom}× · ${Math.ceil(w / size)}×${Math.ceil(h / size)} ô đang xem`);
  }
}
