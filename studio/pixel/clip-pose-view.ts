import type { ClipPosePoint } from '../../src/studio/clips.ts';

export function drawClipRaster(canvas: HTMLCanvasElement, data: Uint32Array, w: number, h: number, zoom = 1): void {
  canvas.width = Math.max(1, Math.round(w * zoom)); canvas.height = Math.max(1, Math.round(h * zoom));
  const bytes = new Uint8ClampedArray(data.length * 4);
  data.forEach((p, i) => { bytes[i * 4] = p >>> 24; bytes[i * 4 + 1] = p >>> 16 & 255; bytes[i * 4 + 2] = p >>> 8 & 255; bytes[i * 4 + 3] = p & 255; });
  const image = document.createElement('canvas'); image.width = w; image.height = h;
  image.getContext('2d')!.putImageData(new ImageData(bytes, w, h), 0, 0);
  const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
}

export interface ClipPoseScene {
  w: number; h: number; pixels: Uint32Array;
  previous?: Uint32Array; next?: Uint32Array; mask?: Uint32Array;
  pivot: ClipPosePoint; points: Record<string, ClipPosePoint>;
  names: Record<string, string>; links: { from: string; to: string }[];
  locked: boolean; onion: boolean;
  onSelect: (id: string) => void;
  onCommit: (id: string, point: ClipPosePoint) => void;
  onGesture?: () => void;
}

export class ClipPoseView {
  readonly canvas: HTMLCanvasElement;
  private scene?: ClipPoseScene;
  private zoom = 8;
  private selected = '';
  private interactionLocked = false;
  private drag?: { scene: ClipPoseScene; id: string; pointer: number; start: ClipPosePoint; point: ClipPosePoint };
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', e => {
      const scene = this.scene; if (!scene || scene.locked || this.interactionLocked || e.button !== 0) return;
      const point = this.position(e), rect = canvas.getBoundingClientRect();
      const radius = Math.max(1, 10 * scene.w / Math.max(1, rect.width));
      const hit = Object.entries(scene.points).map(([id, p]) => ({ id, p, distance: Math.hypot(p.x - point.x, p.y - point.y) }))
        .filter(p => p.distance <= radius).sort((a, b) => a.distance - b.distance)[0];
      if (!hit) return;
      e.preventDefault(); canvas.focus({ preventScroll: true }); this.selected = hit.id;
      this.drag = { scene, id: hit.id, pointer: e.pointerId, start: { ...hit.p }, point: { ...hit.p } };
      canvas.setPointerCapture(e.pointerId); scene.onSelect(hit.id); scene.onGesture?.(); this.draw();
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.drag || e.pointerId !== this.drag.pointer) return;
      this.drag.point = this.position(e); this.draw();
    });
    canvas.addEventListener('pointerup', e => {
      const drag = this.drag; if (!drag || drag.pointer !== e.pointerId) return;
      this.drag = undefined; this.release(drag.pointer); this.draw();
      drag.scene.onGesture?.();
      if (this.scene === drag.scene && (drag.start.x !== drag.point.x || drag.start.y !== drag.point.y)) {
        drag.scene.onCommit(drag.id, { ...drag.point });
      }
    });
    canvas.addEventListener('pointercancel', () => this.cancel());
    canvas.addEventListener('lostpointercapture', () => { if (this.drag) this.cancel(); });
    window.addEventListener('blur', () => this.cancel());
  }
  get dragging(): boolean { return !!this.drag; }
  setInteractionLocked(value: boolean): void {
    if (this.interactionLocked === value) return;
    this.interactionLocked = value; if (value) this.cancel();
  }
  private release(id: number): void { if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id); }
  cancel(): boolean {
    const drag = this.drag; if (!drag) return false;
    this.drag = undefined; this.release(drag.pointer); this.draw(); drag.scene.onGesture?.(); return true;
  }
  reset(): void { this.cancel(); this.scene = undefined; this.canvas.width = this.canvas.height = 1; }
  show(scene: ClipPoseScene): void { this.cancel(); this.scene = scene; this.draw(); }
  select(id: string): void { this.selected = id; this.draw(); }
  setZoom(value: number): void { this.zoom = Math.max(1, Math.min(32, Math.round(value))); this.draw(); }
  fit(): void {
    const scene = this.scene, stage = this.canvas.parentElement;
    if (scene && stage) this.setZoom(Math.max(1, Math.min(16, Math.floor((stage.clientWidth - 24) / scene.w), Math.floor((stage.clientHeight - 24) / scene.h))));
  }
  private position(e: PointerEvent): ClipPosePoint {
    const scene = this.scene!, box = this.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(scene.w - 1, Math.floor((e.clientX - box.left) / box.width * scene.w))),
      y: Math.max(0, Math.min(scene.h - 1, Math.floor((e.clientY - box.top) / box.height * scene.h))) };
  }
  private draw(): void {
    const scene = this.scene; if (!scene) return;
    const { canvas } = this, z = Math.max(1, Math.min(this.zoom, Math.floor(4096 / Math.max(scene.w, scene.h))));
    drawClipRaster(canvas, scene.pixels, scene.w, scene.h, z);
    const ctx = canvas.getContext('2d')!;
    if (scene.onion) {
      for (const [data, color] of [[scene.previous, '#ff6677'], [scene.next, '#66bbff']] as const) {
        if (!data) continue;
        const image = document.createElement('canvas'); drawClipRaster(image, data, scene.w, scene.h, z);
        const ghost = image.getContext('2d')!; ghost.globalCompositeOperation = 'source-in'; ghost.fillStyle = color; ghost.fillRect(0, 0, image.width, image.height);
        ctx.globalAlpha = .22; ctx.drawImage(image, 0, 0);
      }
      ctx.globalAlpha = 1;
    }
    if (scene.mask) {
      ctx.fillStyle = '#70c98950';
      scene.mask.forEach((v, i) => { if (v) ctx.fillRect(i % scene.w * z, Math.floor(i / scene.w) * z, z, z); });
    }
    const points = { ...scene.points };
    if (this.drag) points[this.drag.id] = this.drag.point;
    ctx.lineWidth = 1; ctx.strokeStyle = '#00e5ff';
    for (const link of scene.links) {
      const from = points[link.from], to = points[link.to]; if (!from || !to) continue;
      ctx.beginPath(); ctx.moveTo((from.x + .5) * z, (from.y + .5) * z); ctx.lineTo((to.x + .5) * z, (to.y + .5) * z); ctx.stroke();
    }
    for (const [id, p] of Object.entries(points)) {
      ctx.fillStyle = id === this.selected ? '#fff68a' : '#00e5ff';
      const radius = Math.max(2, Math.min(5, z / 2));
      ctx.beginPath(); ctx.arc((p.x + .5) * z, (p.y + .5) * z, radius, 0, Math.PI * 2); ctx.fill();
    }
    const ground = Math.min(canvas.height - 1, scene.pivot.y * z);
    ctx.strokeStyle = '#ffd166'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, ground); ctx.lineTo(canvas.width, ground); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ffd166'; ctx.fillRect(Math.min(canvas.width - 1, scene.pivot.x * z) - 2, ground - 2, 5, 5);
  }
}
