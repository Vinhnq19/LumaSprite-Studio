import { Img } from './raster.ts';
import { over } from './pixel/model.ts';
import { effectiveNativeSceneState, type NativeSceneRecord } from './native-scene.ts';

export interface NativeSceneRaster {
  w: number;
  h: number;
  data: Uint32Array;
}

export interface NativeSceneBuffers {
  atlas: NativeSceneRaster;
  foreground: NativeSceneRaster;
  underlayCorrection?: NativeSceneRaster;
  layers: Record<string, NativeSceneRaster>;
}

export type NativeSceneRenderMode = 'composite' | 'ground' | 'foreground' | 'atlas';

function blitTile(dest: Img, atlas: NativeSceneRaster, srcX: number, srcY: number, dstX: number, dstY: number, size: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ink = atlas.data[(srcY + y) * atlas.w + (srcX + x)];
      dest.data[(dstY + y) * dest.w + (dstX + x)] = ink;
    }
  }
}

function alphaCompositeAt(dest: Img, src: NativeSceneRaster, left: number, top: number): void {
  for (let y = 0; y < src.h; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= dest.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = left + x;
      if (dx < 0 || dx >= dest.w) continue;
      const ink = src.data[y * src.w + x];
      const a = ink & 255;
      if (!a) continue;
      const idx = dy * dest.w + dx;
      dest.data[idx] = a === 255 ? ink : over(dest.data[idx], ink, 255);
    }
  }
}

/** Deterministic pixel-exact renderer for imported Engine scenes (no bilinear smoothing). */
export function renderNativeScene(
  record: NativeSceneRecord,
  buffers: NativeSceneBuffers,
  options: { mode?: NativeSceneRenderMode; applyOverrides?: boolean } = {},
): Img {
  const mode = options.mode ?? 'composite';
  const applyOverrides = options.applyOverrides ?? true;
  const snap = record.engineSnapshot;
  const { width, height, tilemap } = snap;

  if (mode === 'atlas') {
    const out = new Img(buffers.atlas.w, buffers.atlas.h);
    out.data.set(buffers.atlas.data);
    return out;
  }

  const out = new Img(width, height);
  if (mode === 'composite' || mode === 'ground') {
    const cols = tilemap.columns;
    const size = tilemap.tileSize;
    const gridCols = width / size;
    for (let i = 0; i < tilemap.ids.length; i++) {
      const tileId = tilemap.ids[i];
      const srcX = (tileId % cols) * size;
      const srcY = Math.floor(tileId / cols) * size;
      const dstX = (i % gridCols) * size;
      const dstY = Math.floor(i / gridCols) * size;
      blitTile(out, buffers.atlas, srcX, srcY, dstX, dstY, size);
    }
    if (buffers.underlayCorrection) {
      alphaCompositeAt(out, buffers.underlayCorrection, 0, 0);
    }
  }

  if (mode === 'ground') return out;

  const effective = applyOverrides ? effectiveNativeSceneState(record) : {
    layers: snap.layers.map(l => ({ ...l, visible: true })),
    foregroundVisible: true,
  };

  if (snap.packageFormat === 'e8-runtime') {
    const hasEntityBuffers = effective.layers.every(l => l.textureResourceId && buffers.layers[l.textureResourceId]);
    if (hasEntityBuffers) {
      for (const layer of effective.layers) {
        if (!layer.visible || !layer.textureResourceId) continue;
        const raster = buffers.layers[layer.textureResourceId];
        if (!raster) continue;
        alphaCompositeAt(out, raster, layer.at.x - layer.pivot.x, layer.at.y - layer.pivot.y);
      }
      return out;
    }
  }

  if (effective.foregroundVisible) {
    alphaCompositeAt(out, buffers.foreground, 0, 0);
  }
  return out;
}

export function compareRgbaExact(a: Uint32Array, b: Uint32Array): { equal: boolean; diffPixels: number; firstDiffIndex: number } {
  if (a.length !== b.length) return { equal: false, diffPixels: Math.max(a.length, b.length), firstDiffIndex: 0 };
  let diffPixels = 0;
  let firstDiffIndex = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (firstDiffIndex === -1) firstDiffIndex = i;
      diffPixels++;
    }
  }
  return { equal: diffPixels === 0, diffPixels, firstDiffIndex };
}
