import {
  computeFrameDiff,
  computePixelDiff,
  computeSilhouette,
  readPixelRgba,
  type PixelDiffResult,
  type RgbaInspection,
} from '../../../src/studio/art-review/pixel-ops.ts';
import type {
  AlignmentConfig,
  BackgroundMode,
  LoadedAsset,
  Pivot,
  RegionNote,
  ReviewFrame,
  ReviewSlot,
  SilhouetteMode,
  ViewMode,
  ZoomLevel,
} from '../../../src/studio/art-review/types.ts';

export interface ViewerFrameSelection {
  asset?: LoadedAsset;
  frame?: ReviewFrame;
  prevFrame?: ReviewFrame;
  nextFrame?: ReviewFrame;
}

export interface HoverInspection {
  pane: ReviewSlot | 'single';
  x: number;
  y: number;
  a?: RgbaInspection | null;
  b?: RgbaInspection | null;
}

export interface ViewerState {
  viewMode: ViewMode;
  zoom: ZoomLevel;
  background: BackgroundMode;
  silhouetteMode: SilhouetteMode;
  showGrid: boolean;
  showPivot: boolean;
  onionSkin: boolean;
  onionOpacity: number;
  frameDiffOverlay: boolean;
  blinkIntervalMs: number;
  blinkActiveSlot: ReviewSlot;
  panX: number;
  panY: number;
}

interface DrawGeometry {
  drawX: number;
  drawY: number;
  spriteW: number;
  spriteH: number;
  zoom: ZoomLevel;
  pane: ReviewSlot | 'single';
  layoutAX?: number;
  layoutAY?: number;
  layoutBX?: number;
  layoutBY?: number;
}

function createOffscreenSprite(rgba: Uint32Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const bytes = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i++) {
    const p = rgba[i];
    bytes[i * 4] = (p >>> 24) & 255;
    bytes[i * 4 + 1] = (p >>> 16) & 255;
    bytes[i * 4 + 2] = (p >>> 8) & 255;
    bytes[i * 4 + 3] = p & 255;
  }
  ctx.putImageData(new ImageData(bytes, width, height), 0, 0);
  return canvas;
}

function createTintedGhost(rgba: Uint32Array, width: number, height: number, tintColor: string): HTMLCanvasElement {
  const canvas = createOffscreenSprite(rgba, width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = tintColor;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

export function renderFrameThumbnail(
  canvas: HTMLCanvasElement,
  rgba: Uint32Array,
  width: number,
  height: number,
): void {
  const targetW = canvas.width;
  const targetH = canvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, targetW, targetH);
  const scale = Math.min(targetW / width, targetH / height);
  const drawW = Math.max(1, Math.round(width * scale));
  const drawH = Math.max(1, Math.round(height * scale));
  const drawX = Math.floor((targetW - drawW) / 2);
  const drawY = Math.floor((targetH - drawH) / 2);
  ctx.drawImage(createOffscreenSprite(rgba, width, height), drawX, drawY, drawW, drawH);
}

/**
 * Pixel-perfect canvas viewer supporting synchronized pan/zoom, side-by-side,
 * toggle A/B, blink, pixel diff, silhouette/alpha, onion-skin, pivot, and RGBA readout.
 */
export class ComparisonViewer {
  readonly state: ViewerState = {
    viewMode: 'side-by-side',
    zoom: 1,
    background: 'checker',
    silhouetteMode: 'binary',
    showGrid: false,
    showPivot: true,
    onionSkin: false,
    onionOpacity: 0.3,
    frameDiffOverlay: false,
    blinkIntervalMs: 500,
    blinkActiveSlot: 'baseline',
    panX: 0,
    panY: 0,
  };

  private readonly hostDual: HTMLElement;
  private readonly hostSingle: HTMLElement;
  private readonly canvasA: HTMLCanvasElement;
  private readonly canvasB: HTMLCanvasElement;
  private readonly canvasSingle: HTMLCanvasElement;

  private baseline: ViewerFrameSelection = {};
  private candidate: ViewerFrameSelection = {};
  private alignment: AlignmentConfig = { mode: 'top-left', offsetX: 0, offsetY: 0, confirmed: false };
  private regionNotes: readonly RegionNote[] = [];
  private activeRegionNoteId?: string;
  private latestDiff?: PixelDiffResult;

  private geometryA?: DrawGeometry;
  private geometryB?: DrawGeometry;
  private geometrySingle?: DrawGeometry;

  private blinkTimer?: ReturnType<typeof setInterval>;
  private drag?: {
    canvas: HTMLCanvasElement;
    pointerId: number;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  };
  private lockedInspection?: HoverInspection;
  private observer: ResizeObserver;

  onHover: (info: HoverInspection | null, locked: boolean) => void = () => {};
  onPickPixel: (info: HoverInspection) => void = () => {};
  onStateChange: () => void = () => {};
  onDiffComputed: (diff?: PixelDiffResult) => void = () => {};

  constructor(options: {
    hostDual: HTMLElement;
    hostSingle: HTMLElement;
    canvasA: HTMLCanvasElement;
    canvasB: HTMLCanvasElement;
    canvasSingle: HTMLCanvasElement;
  }) {
    this.hostDual = options.hostDual;
    this.hostSingle = options.hostSingle;
    this.canvasA = options.canvasA;
    this.canvasB = options.canvasB;
    this.canvasSingle = options.canvasSingle;

    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(this.hostDual);
    this.observer.observe(this.hostSingle);

    for (const canvas of [this.canvasA, this.canvasB, this.canvasSingle]) {
      this.attachEvents(canvas);
    }
  }

  setInputs(input: {
    baseline: ViewerFrameSelection;
    candidate: ViewerFrameSelection;
    alignment: AlignmentConfig;
    regionNotes: readonly RegionNote[];
    activeRegionNoteId?: string;
  }): void {
    this.baseline = input.baseline;
    this.candidate = input.candidate;
    this.alignment = input.alignment;
    this.regionNotes = input.regionNotes;
    this.activeRegionNoteId = input.activeRegionNoteId;
    this.recomputeDiff();
    this.render();
  }

  setZoom(zoom: ZoomLevel): void {
    if (this.state.zoom === zoom) return;
    this.state.zoom = zoom;
    this.onStateChange();
    this.render();
  }

  stepZoom(delta: 1 | -1): void {
    const steps: readonly ZoomLevel[] = [1, 2, 4, 8];
    const index = steps.indexOf(this.state.zoom);
    const next = steps[Math.max(0, Math.min(steps.length - 1, index + delta))];
    this.setZoom(next);
  }

  resetPan(): void {
    this.state.panX = 0;
    this.state.panY = 0;
    this.render();
  }

  setViewMode(mode: ViewMode): void {
    this.state.viewMode = mode;
    if (mode === 'blink') {
      this.startBlink();
    } else {
      this.stopBlink();
    }
    this.recomputeDiff();
    this.onStateChange();
    this.render();
  }

  setBlinkInterval(ms: number): void {
    this.state.blinkIntervalMs = Math.max(120, Math.min(3000, Math.round(ms)));
    if (this.state.viewMode === 'blink') {
      this.startBlink();
    }
    this.onStateChange();
  }

  toggleBlinkSlot(): void {
    this.state.blinkActiveSlot = this.state.blinkActiveSlot === 'baseline' ? 'candidate' : 'baseline';
    this.onStateChange();
    this.render();
  }

  startBlink(): void {
    this.stopBlink();
    this.blinkTimer = setInterval(() => {
      this.toggleBlinkSlot();
    }, this.state.blinkIntervalMs);
  }

  stopBlink(): void {
    if (this.blinkTimer !== undefined) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = undefined;
    }
  }

  dispose(): void {
    this.stopBlink();
    this.observer.disconnect();
  }

  getLatestDiff(): PixelDiffResult | undefined {
    return this.latestDiff;
  }

  private recomputeDiff(): void {
    if (this.baseline.frame && this.candidate.frame) {
      this.latestDiff = computePixelDiff(
        {
          width: this.baseline.frame.width,
          height: this.baseline.frame.height,
          rgba: this.baseline.frame.rgba,
          pivot: this.baseline.frame.pivot ?? this.baseline.asset?.pivot,
        },
        {
          width: this.candidate.frame.width,
          height: this.candidate.frame.height,
          rgba: this.candidate.frame.rgba,
          pivot: this.candidate.frame.pivot ?? this.candidate.asset?.pivot,
        },
        this.alignment,
      );
    } else {
      this.latestDiff = undefined;
    }
    this.onDiffComputed(this.latestDiff);
  }

  private attachEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      'wheel',
      event => {
        event.preventDefault();
        if (event.deltaY !== 0) {
          this.stepZoom(event.deltaY < 0 ? 1 : -1);
        }
      },
      { passive: false },
    );

    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      this.drag = {
        canvas,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPanX: this.state.panX,
        startPanY: this.state.panY,
        moved: false,
      };
    });

    canvas.addEventListener('pointermove', event => {
      if (this.drag && this.drag.pointerId === event.pointerId && this.drag.canvas === canvas) {
        const dx = event.clientX - this.drag.startX;
        const dy = event.clientY - this.drag.startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          this.drag.moved = true;
        }
        this.state.panX = Math.round(this.drag.startPanX + dx);
        this.state.panY = Math.round(this.drag.startPanY + dy);
        this.render();
      }
      if (!this.lockedInspection) {
        this.onHover(this.inspectAt(canvas, event.clientX, event.clientY), false);
      }
    });

    const finishDrag = (event: PointerEvent) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const moved = this.drag.moved;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      this.drag = undefined;
      if (!moved && event.button === 0) {
        const hit = this.inspectAt(canvas, event.clientX, event.clientY);
        if (hit) {
          this.onPickPixel(hit);
          this.lockedInspection = this.lockedInspection && this.lockedInspection.x === hit.x && this.lockedInspection.y === hit.y ? undefined : hit;
          this.onHover(this.lockedInspection ?? hit, Boolean(this.lockedInspection));
        }
      }
    };

    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);
    canvas.addEventListener('pointerleave', () => {
      if (!this.lockedInspection) {
        this.onHover(null, false);
      }
    });
  }

  private geometryFor(canvas: HTMLCanvasElement): DrawGeometry | undefined {
    if (canvas === this.canvasA) return this.geometryA;
    if (canvas === this.canvasB) return this.geometryB;
    return this.geometrySingle;
  }

  private inspectAt(canvas: HTMLCanvasElement, clientX: number, clientY: number): HoverInspection | null {
    const geom = this.geometryFor(canvas);
    if (!geom) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const localX = ((clientX - rect.left) * canvas.width) / rect.width;
    const localY = ((clientY - rect.top) * canvas.height) / rect.height;
    const px = Math.floor((localX - geom.drawX) / geom.zoom);
    const py = Math.floor((localY - geom.drawY) / geom.zoom);
    if (px < 0 || py < 0 || px >= geom.spriteW || py >= geom.spriteH) return null;

    const frameA = this.baseline.frame;
    const frameB = this.candidate.frame;

    if (geom.pane === 'baseline') {
      return {
        pane: 'baseline',
        x: px,
        y: py,
        a: frameA ? readPixelRgba(frameA.rgba, frameA.width, frameA.height, px, py) : null,
        b: frameB ? readPixelRgba(frameB.rgba, frameB.width, frameB.height, px, py) : null,
      };
    }

    if (geom.pane === 'candidate') {
      return {
        pane: 'candidate',
        x: px,
        y: py,
        a: frameA ? readPixelRgba(frameA.rgba, frameA.width, frameA.height, px, py) : null,
        b: frameB ? readPixelRgba(frameB.rgba, frameB.width, frameB.height, px, py) : null,
      };
    }

    // Unified single canvas (diff / toggle / blink)
    if (geom.layoutAX !== undefined && geom.layoutAY !== undefined && geom.layoutBX !== undefined && geom.layoutBY !== undefined) {
      const ax = px - geom.layoutAX;
      const ay = py - geom.layoutAY;
      const bx = px - geom.layoutBX;
      const by = py - geom.layoutBY;
      return {
        pane: 'single',
        x: px,
        y: py,
        a: frameA ? readPixelRgba(frameA.rgba, frameA.width, frameA.height, ax, ay) : null,
        b: frameB ? readPixelRgba(frameB.rgba, frameB.width, frameB.height, bx, by) : null,
      };
    }

    return {
      pane: 'single',
      x: px,
      y: py,
      a: frameA ? readPixelRgba(frameA.rgba, frameA.width, frameA.height, px, py) : null,
      b: frameB ? readPixelRgba(frameB.rgba, frameB.width, frameB.height, px, py) : null,
    };
  }

  private sizeCanvasToHost(canvas: HTMLCanvasElement): { width: number; height: number } {
    const parent = canvas.parentElement!;
    const width = Math.max(240, Math.floor(parent.clientWidth));
    const height = Math.max(240, Math.floor(parent.clientHeight));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    return { width, height };
  }

  private paintBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.imageSmoothingEnabled = false;
    if (this.state.background === 'light') {
      ctx.fillStyle = '#eceae0';
      ctx.fillRect(0, 0, width, height);
      return;
    }
    if (this.state.background === 'dark') {
      ctx.fillStyle = '#12161e';
      ctx.fillRect(0, 0, width, height);
      return;
    }
    const cell = 8;
    ctx.fillStyle = '#536071';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#6c798a';
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        if (((x / cell + y / cell) & 1) === 0) {
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
  }

  private paintOverlays(
    ctx: CanvasRenderingContext2D,
    drawX: number,
    drawY: number,
    spriteW: number,
    spriteH: number,
    zoom: ZoomLevel,
    pivot: Pivot | undefined,
    slotFilter: ReviewSlot | 'diff',
    frameIndex: number,
  ): void {
    const scaledW = spriteW * zoom;
    const scaledH = spriteH * zoom;

    // Sprite boundary border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(drawX + 0.5, drawY + 0.5, scaledW - 1, scaledH - 1);

    // Pixel grid when zoom >= 4
    if (this.state.showGrid && zoom >= 4) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      for (let x = 0; x <= spriteW; x++) {
        const px = drawX + x * zoom + 0.5;
        ctx.moveTo(px, drawY);
        ctx.lineTo(px, drawY + scaledH);
      }
      for (let y = 0; y <= spriteH; y++) {
        const py = drawY + y * zoom + 0.5;
        ctx.moveTo(drawX, py);
        ctx.lineTo(drawX + scaledW, py);
      }
      ctx.stroke();
    }

    // Pivot crosshair overlay
    if (this.state.showPivot && pivot) {
      const cx = drawX + Math.round((pivot.x + 0.5) * zoom) + 0.5;
      const cy = drawY + Math.round((pivot.y + 0.5) * zoom) + 0.5;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy);
      ctx.lineTo(cx + 8, cy);
      ctx.moveTo(cx, cy - 8);
      ctx.lineTo(cx, cy + 8);
      ctx.stroke();
      ctx.strokeStyle = '#11161e';
      ctx.strokeRect(cx - 2.5, cy - 2.5, 5, 5);
    }

    // Region Note markers
    this.regionNotes.forEach((note, idx) => {
      if (note.slot !== slotFilter && slotFilter !== 'diff') return;
      if (note.frameIndex !== frameIndex && slotFilter !== 'diff') return;
      const rx = drawX + note.x * zoom;
      const ry = drawY + note.y * zoom;
      const rw = Math.max(zoom, note.width * zoom);
      const rh = Math.max(zoom, note.height * zoom);
      const active = note.id === this.activeRegionNoteId;
      ctx.strokeStyle = note.severity === 'critical' ? '#ff5c7a' : active ? '#92ddaa' : '#ffd166';
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
      ctx.fillStyle = note.severity === 'critical' ? '#ff5c7a' : '#233142';
      ctx.fillRect(rx, Math.max(0, ry - 14), 16, 13);
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.fillText(String(idx + 1), rx + 3, Math.max(10, ry - 4));
    });
  }

  private renderSlotPane(
    canvas: HTMLCanvasElement,
    selection: ViewerFrameSelection,
    slot: ReviewSlot,
    silhouette: boolean,
  ): DrawGeometry | undefined {
    const { width: canvasW, height: canvasH } = this.sizeCanvasToHost(canvas);
    const ctx = canvas.getContext('2d')!;
    this.paintBackground(ctx, canvasW, canvasH);

    const frame = selection.frame;
    if (!frame) {
      ctx.fillStyle = '#8fa0b5';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(slot === 'baseline' ? 'Chưa nạp A — Baseline' : 'Chưa nạp B — Candidate', canvasW / 2, canvasH / 2);
      ctx.textAlign = 'left';
      return undefined;
    }

    const zoom = this.state.zoom;
    const scaledW = frame.width * zoom;
    const scaledH = frame.height * zoom;
    const drawX = Math.floor((canvasW - scaledW) / 2 + this.state.panX);
    const drawY = Math.floor((canvasH - scaledH) / 2 + this.state.panY);

    if (silhouette) {
      const sil = computeSilhouette(frame.rgba, frame.width, frame.height, this.state.silhouetteMode);
      ctx.drawImage(createOffscreenSprite(sil.rgba, sil.width, sil.height), drawX, drawY, scaledW, scaledH);
    } else {
      if (this.state.onionSkin) {
        if (selection.prevFrame && selection.prevFrame !== frame) {
          ctx.globalAlpha = this.state.onionOpacity;
          ctx.drawImage(
            createTintedGhost(selection.prevFrame.rgba, selection.prevFrame.width, selection.prevFrame.height, '#ff6677'),
            drawX,
            drawY,
            selection.prevFrame.width * zoom,
            selection.prevFrame.height * zoom,
          );
        }
        if (selection.nextFrame && selection.nextFrame !== frame) {
          ctx.globalAlpha = this.state.onionOpacity;
          ctx.drawImage(
            createTintedGhost(selection.nextFrame.rgba, selection.nextFrame.width, selection.nextFrame.height, '#66bbff'),
            drawX,
            drawY,
            selection.nextFrame.width * zoom,
            selection.nextFrame.height * zoom,
          );
        }
        ctx.globalAlpha = 1;
      }

      ctx.drawImage(createOffscreenSprite(frame.rgba, frame.width, frame.height), drawX, drawY, scaledW, scaledH);

      if (this.state.frameDiffOverlay && selection.prevFrame) {
        const frameDiff = computeFrameDiff(selection.prevFrame, frame);
        ctx.globalAlpha = 0.72;
        ctx.drawImage(
          createOffscreenSprite(frameDiff.rgba, frameDiff.width, frameDiff.height),
          drawX,
          drawY,
          frameDiff.width * zoom,
          frameDiff.height * zoom,
        );
        ctx.globalAlpha = 1;
      }
    }

    const pivot = frame.pivot ?? selection.asset?.pivot;
    this.paintOverlays(ctx, drawX, drawY, frame.width, frame.height, zoom, pivot, slot, frame.index);

    canvas.dataset.zoom = String(zoom);
    canvas.dataset.viewMode = this.state.viewMode;
    canvas.dataset.frameIndex = String(frame.index);
    canvas.dataset.drawX = String(drawX);
    canvas.dataset.drawY = String(drawY);
    canvas.dataset.spriteW = String(frame.width);
    canvas.dataset.spriteH = String(frame.height);

    return { drawX, drawY, spriteW: frame.width, spriteH: frame.height, zoom, pane: slot };
  }

  private renderSinglePane(): DrawGeometry | undefined {
    const canvas = this.canvasSingle;
    const { width: canvasW, height: canvasH } = this.sizeCanvasToHost(canvas);
    const ctx = canvas.getContext('2d')!;
    this.paintBackground(ctx, canvasW, canvasH);

    const mode = this.state.viewMode;
    const zoom = this.state.zoom;

    if (mode === 'diff') {
      if (!this.baseline.frame || !this.candidate.frame || !this.latestDiff) {
        ctx.fillStyle = '#8fa0b5';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Cần nạp cả A (Baseline) và B (Candidate) để xem Pixel Diff.', canvasW / 2, canvasH / 2);
        ctx.textAlign = 'left';
        return undefined;
      }

      const diff = this.latestDiff;
      const scaledW = diff.width * zoom;
      const scaledH = diff.height * zoom;
      const drawX = Math.floor((canvasW - scaledW) / 2 + this.state.panX);
      const drawY = Math.floor((canvasH - scaledH) / 2 + this.state.panY);

      ctx.drawImage(createOffscreenSprite(diff.rgba, diff.width, diff.height), drawX, drawY, scaledW, scaledH);
      const pivot = this.baseline.frame.pivot ?? this.baseline.asset?.pivot;
      const adjustedPivot = pivot ? { x: pivot.x + diff.layout.aX, y: pivot.y + diff.layout.aY } : undefined;
      this.paintOverlays(ctx, drawX, drawY, diff.width, diff.height, zoom, adjustedPivot, 'diff', 0);

      canvas.dataset.zoom = String(zoom);
      canvas.dataset.viewMode = 'diff';
      canvas.dataset.diffChanged = String(diff.stats.changedPixels);
      canvas.dataset.drawX = String(drawX);
      canvas.dataset.drawY = String(drawY);
      canvas.dataset.spriteW = String(diff.width);
      canvas.dataset.spriteH = String(diff.height);

      return {
        drawX,
        drawY,
        spriteW: diff.width,
        spriteH: diff.height,
        zoom,
        pane: 'single',
        layoutAX: diff.layout.aX,
        layoutAY: diff.layout.aY,
        layoutBX: diff.layout.bX,
        layoutBY: diff.layout.bY,
      };
    }

    const activeSlot: ReviewSlot =
      mode === 'toggle-a' ? 'baseline' : mode === 'toggle-b' ? 'candidate' : this.state.blinkActiveSlot;
    const selection = activeSlot === 'baseline' ? this.baseline : this.candidate;
    const frame = selection.frame;
    canvas.dataset.blinkSlot = activeSlot;
    canvas.dataset.viewMode = mode;
    canvas.dataset.zoom = String(zoom);

    if (!frame) {
      ctx.fillStyle = '#8fa0b5';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        activeSlot === 'baseline' ? 'Chưa nạp A — Baseline' : 'Chưa nạp B — Candidate',
        canvasW / 2,
        canvasH / 2,
      );
      ctx.textAlign = 'left';
      return undefined;
    }

    const scaledW = frame.width * zoom;
    const scaledH = frame.height * zoom;
    const drawX = Math.floor((canvasW - scaledW) / 2 + this.state.panX);
    const drawY = Math.floor((canvasH - scaledH) / 2 + this.state.panY);

    ctx.drawImage(createOffscreenSprite(frame.rgba, frame.width, frame.height), drawX, drawY, scaledW, scaledH);
    const pivot = frame.pivot ?? selection.asset?.pivot;
    this.paintOverlays(ctx, drawX, drawY, frame.width, frame.height, zoom, pivot, activeSlot, frame.index);

    // Crisp corner slot indicator
    ctx.fillStyle = activeSlot === 'baseline' ? 'rgba(59, 130, 246, 0.85)' : 'rgba(128, 201, 155, 0.9)';
    ctx.fillRect(10, 10, 120, 22);
    ctx.fillStyle = activeSlot === 'baseline' ? '#ffffff' : '#10231b';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText(activeSlot === 'baseline' ? 'A · BASELINE' : 'B · CANDIDATE', 18, 25);

    canvas.dataset.frameIndex = String(frame.index);
    canvas.dataset.drawX = String(drawX);
    canvas.dataset.drawY = String(drawY);
    canvas.dataset.spriteW = String(frame.width);
    canvas.dataset.spriteH = String(frame.height);

    return { drawX, drawY, spriteW: frame.width, spriteH: frame.height, zoom, pane: 'single' };
  }

  render(): void {
    const dual = this.state.viewMode === 'side-by-side' || this.state.viewMode === 'silhouette';
    this.hostDual.hidden = !dual;
    this.hostSingle.hidden = dual;

    if (dual) {
      const sil = this.state.viewMode === 'silhouette';
      this.geometryA = this.renderSlotPane(this.canvasA, this.baseline, 'baseline', sil);
      this.geometryB = this.renderSlotPane(this.canvasB, this.candidate, 'candidate', sil);
      this.geometrySingle = undefined;
    } else {
      this.geometrySingle = this.renderSinglePane();
      this.geometryA = undefined;
      this.geometryB = undefined;
    }
  }
}
