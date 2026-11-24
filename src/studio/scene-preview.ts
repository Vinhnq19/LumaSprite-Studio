import { Img } from '../core/image.ts';
import { over } from './pixel/model.ts';
import { sampleMotionPlayback } from './quality/playback.ts';

export interface ScenePreview {
  width: number;
  height: number;
  tileSize: number;
  terrain: Uint32Array;
  sprites: {
    id: string; assetId: string; name: string; x: number; y: number; pivot: { x: number; y: number };
    track: number;
  }[];
  tracks: { w: number; h: number; loop: boolean; frames: { id: string; durationMs: number; rgba: Uint32Array }[] }[];
}

export function sceneFrameIndices(preview: ScenePreview, elapsed: number): number[] {
  return preview.tracks.map(track => sampleMotionPlayback(track.frames, elapsed, track.loop).index);
}

/** Compose in native pixels. The map is below the ordered sprite placements. */
export function renderSceneFrame(preview: ScenePreview, frames: readonly number[]): Img {
  const out = new Img(preview.width, preview.height, preview.terrain.slice());
  for (const sprite of preview.sprites) {
    const track = preview.tracks[sprite.track], frame = track.frames[frames[sprite.track]], rgba = frame.rgba;
    const left = Math.round(sprite.x - sprite.pivot.x), top = Math.round(sprite.y - sprite.pivot.y);
    const fromX = Math.max(0, -left), toX = Math.min(track.w, preview.width - left);
    for (let y = Math.max(0, -top); y < Math.min(track.h, preview.height - top); y++) {
      for (let x = fromX; x < toX; x++) {
        const ink = rgba[y * track.w + x], alpha = ink & 255;
        if (!alpha) continue;
        const offset = (top + y) * preview.width + left + x;
        out.data[offset] = alpha === 255 ? ink : over(out.data[offset], ink);
      }
    }
  }
  return out;
}
