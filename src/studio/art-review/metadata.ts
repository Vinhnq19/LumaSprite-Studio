import type { StripSliceRect } from './pixel-ops.ts';
import {
  ART_REVIEW_MANIFEST_KIND,
  type AnimationTag,
  type AssetFamily,
  type Pivot,
  type PlaybackDirection,
  type ReviewManifest,
  type TimingSource,
} from './types.ts';
import { parseRubricJson } from './rubrics.ts';

export interface ParsedAnimationMetadata {
  frames: StripSliceRect[];
  loop: boolean;
  direction: PlaybackDirection;
  pivot?: Pivot;
  tags: AnimationTag[];
  timingSource: Extract<TimingSource, 'metadata' | 'state-sheet'>;
  warnings: string[];
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function parsePivot(value: unknown): Pivot | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      return { x: Math.trunc(value[0]), y: Math.trunc(value[1]) };
    }
    throw new Error('Pivot mảng phải có dạng [x, y].');
  }
  const obj = asRecord(value, 'Pivot phải là object { x, y } hoặc [x, y].');
  if (typeof obj.x !== 'number' || typeof obj.y !== 'number' || !Number.isFinite(obj.x) || !Number.isFinite(obj.y)) {
    throw new Error('Pivot phải có tọa độ số x, y hợp lệ.');
  }
  return { x: Math.trunc(obj.x), y: Math.trunc(obj.y) };
}

function parseLoopFlag(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'repeat' || value === 'loop') return true;
  if (value === 'once' || value === 'one-shot') return false;
  return fallback;
}

function parseDuration(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 60000) {
    throw new Error(`${label} thiếu hoặc có duration không hợp lệ (cần 1–60000 ms, không tự gán 100 ms).`);
  }
  return Math.round(value);
}

function parseDirection(value: unknown): PlaybackDirection {
  if (value === undefined) return 'forward';
  if (value === 'forward' || value === 'reverse' || value === 'ping-pong') return value;
  if (value === 'pingpong') return 'ping-pong';
  throw new Error(`Hướng phát không hợp lệ: ${String(value)}.`);
}

function validateRectBounds(rect: StripSliceRect, sourceW: number, sourceH: number, index: number): void {
  if (
    !Number.isInteger(rect.x) ||
    !Number.isInteger(rect.y) ||
    !Number.isInteger(rect.w) ||
    !Number.isInteger(rect.h) ||
    rect.w < 1 ||
    rect.h < 1 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.w > sourceW ||
    rect.y + rect.h > sourceH
  ) {
    throw new Error(
      `Frame #${index + 1} (${rect.x},${rect.y} ${rect.w}×${rect.h}) vượt kích thước ảnh ${sourceW}×${sourceH}.`,
    );
  }
}

function parseTags(rawTags: unknown, frameCount: number): AnimationTag[] {
  if (!Array.isArray(rawTags)) return [];
  const tags: AnimationTag[] = [];
  for (const entry of rawTags) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== 'string' || !obj.name.trim()) continue;
    const from = typeof obj.from === 'number' && Number.isInteger(obj.from) ? obj.from : 0;
    const to = typeof obj.to === 'number' && Number.isInteger(obj.to) ? obj.to : frameCount - 1;
    if (from < 0 || to < 0 || from >= frameCount || to >= frameCount) continue;
    tags.push({
      name: obj.name.trim(),
      from: Math.min(from, to),
      to: Math.max(from, to),
      direction: parseDirection(obj.direction),
      loop: typeof obj.loop === 'boolean' ? obj.loop : true,
    });
  }
  return tags;
}

/**
 * Parse frame timing / strip / Studio / Aseprite metadata JSON.
 * Preserves exact real durations from JSON and never fabricates 100ms defaults when metadata is present.
 */
export function parseAnimationMetadata(
  text: string,
  sourceWidth: number,
  sourceHeight: number,
): ParsedAnimationMetadata {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON metadata không hợp lệ: ${(err as Error).message}`);
  }

  const warnings: string[] = [];

  // Format A: Bare array of durations [80, 120, 80] or [{ duration | durationMs }]
  if (Array.isArray(raw)) {
    if (!raw.length) throw new Error('Danh sách frame timing trong JSON rỗng.');
    if (sourceWidth % raw.length !== 0) {
      throw new Error(
        `JSON chỉ chứa ${raw.length} timing nhưng chiều rộng ảnh (${sourceWidth}px) không chia hết cho ${raw.length}. Hãy khai báo frameWidth hoặc rect.`,
      );
    }
    const frameW = sourceWidth / raw.length;
    const frames: StripSliceRect[] = raw.map((item, idx) => {
      const durationMs =
        typeof item === 'number'
          ? parseDuration(item, `Frame #${idx + 1}`)
          : parseDuration(
              asRecord(item, `Frame #${idx + 1} không hợp lệ.`).durationMs ??
                (item as Record<string, unknown>).duration,
              `Frame #${idx + 1}`,
            );
      const label =
        typeof item === 'object' && item && typeof (item as Record<string, unknown>).label === 'string'
          ? ((item as Record<string, unknown>).label as string)
          : undefined;
      const rect: StripSliceRect = { x: idx * frameW, y: 0, w: frameW, h: sourceHeight, durationMs, label };
      validateRectBounds(rect, sourceWidth, sourceHeight, idx);
      return rect;
    });
    return { frames, loop: true, direction: 'forward', tags: [], timingSource: 'metadata', warnings };
  }

  const root = asRecord(raw, 'Metadata animation phải là JSON object hoặc mảng timing.');
  let rootPivot = parsePivot(root.pivot);
  let loop = parseLoopFlag(root.loop, true);
  let direction = parseDirection(root.direction);
  let tags: AnimationTag[] = [];

  // Extract Studio / Aseprite meta if present
  const meta = root.meta && typeof root.meta === 'object' ? (root.meta as Record<string, unknown>) : undefined;
  if (meta?.pxl && typeof meta.pxl === 'object') {
    const pxl = meta.pxl as Record<string, unknown>;
    if (!rootPivot && pxl.assets && typeof pxl.assets === 'object') {
      const firstAsset = Object.values(pxl.assets as Record<string, unknown>)[0];
      if (firstAsset && typeof firstAsset === 'object') {
        rootPivot = parsePivot((firstAsset as Record<string, unknown>).pivot);
      }
    }
  }

  // Format B: { durations: number[], frameWidth?, frameHeight?, loop?, direction?, pivot? }
  if (Array.isArray(root.durations)) {
    if (!root.durations.length) throw new Error('Mảng durations rỗng.');
    const count = root.durations.length;
    const fw =
      typeof root.frameWidth === 'number'
        ? root.frameWidth
        : sourceWidth % count === 0
          ? sourceWidth / count
          : 0;
    const fh = typeof root.frameHeight === 'number' ? root.frameHeight : sourceHeight;
    if (!Number.isInteger(fw) || fw < 1 || !Number.isInteger(fh) || fh < 1) {
      throw new Error('Không suy ra được kích thước frame hợp lệ từ durations và ảnh nguồn.');
    }
    const cols = Math.floor(sourceWidth / fw);
    if (cols < 1) throw new Error('frameWidth lớn hơn chiều rộng ảnh nguồn.');
    const frames: StripSliceRect[] = root.durations.map((dur, idx) => {
      const durationMs = parseDuration(dur, `durations[${idx}]`);
      const rect: StripSliceRect = {
        x: (idx % cols) * fw,
        y: Math.floor(idx / cols) * fh,
        w: fw,
        h: fh,
        durationMs,
        pivot: rootPivot,
      };
      validateRectBounds(rect, sourceWidth, sourceHeight, idx);
      return rect;
    });
    tags = parseTags(root.tags ?? meta?.frameTags, frames.length);
    if (tags.length) {
      loop = tags[0].loop;
      direction = tags[0].direction;
    }
    return { frames, loop, direction, pivot: rootPivot, tags, timingSource: 'metadata', warnings };
  }

  // Format B2: Engine UI state sheet ({ states: [{ id, rect: { x, y, w, h } }] })
  if (Array.isArray(root.states)) {
    if (!root.states.length) throw new Error('Danh sách "states" trong UI metadata rỗng.');
    const frames: StripSliceRect[] = root.states.map((entry, idx) => {
      const state = asRecord(entry, `states[${idx}] phải là object.`);
      const rectObj = asRecord(
        state.rect ?? state.frame,
        `states[${idx}] thiếu trường "rect" ({x,y,w,h}).`,
      );
      const rect: StripSliceRect = {
        x: Number(rectObj.x),
        y: Number(rectObj.y),
        w: Number(rectObj.w),
        h: Number(rectObj.h),
        durationMs: 1000,
        label: typeof state.id === 'string' && state.id.trim() ? state.id.trim() : `state-${idx + 1}`,
        pivot: parsePivot(state.pivot) ?? rootPivot,
      };
      validateRectBounds(rect, sourceWidth, sourceHeight, idx);
      return rect;
    });
    warnings.push('UI state sheet (tĩnh theo trạng thái — không phải animation timing).');
    return {
      frames,
      loop: false,
      direction: 'forward',
      pivot: rootPivot ?? frames[0]?.pivot,
      tags: [],
      timingSource: 'state-sheet',
      warnings,
    };
  }

  // Format C: Studio / Aseprite / Engine frames object map or frames array
  const rawFrames = root.frames;
  if (!rawFrames) {
    throw new Error('JSON metadata thiếu trường "frames", "durations" hoặc "states".');
  }

  const entries: { key?: string; obj: Record<string, unknown> }[] = Array.isArray(rawFrames)
    ? rawFrames.map((item, idx) => ({ obj: asRecord(item, `frames[${idx}] phải là object.`) }))
    : Object.entries(asRecord(rawFrames, 'Trường "frames" phải là array hoặc object map.')).map(([key, item]) => ({
        key,
        obj: asRecord(item, `frames["${key}"] phải là object.`),
      }));

  if (!entries.length) {
    throw new Error('Metadata không chứa frame nào.');
  }

  const explicitW = typeof root.frameWidth === 'number' ? root.frameWidth : undefined;
  const explicitH = typeof root.frameHeight === 'number' ? root.frameHeight : undefined;
  const inferredStripW =
    explicitW ?? (sourceWidth % entries.length === 0 ? sourceWidth / entries.length : undefined);
  const inferredStripH = explicitH ?? sourceHeight;

  const frames: StripSliceRect[] = entries.map((entry, idx) => {
    const obj = entry.obj;
    const durationMs = parseDuration(obj.durationMs ?? obj.duration, `Frame #${idx + 1}`);
    const framePivot = parsePivot(obj.pivot) ?? rootPivot;
    const label =
      typeof obj.label === 'string'
        ? obj.label
        : typeof obj.phase === 'string'
          ? obj.phase
          : typeof obj.id === 'string'
            ? obj.id
            : entry.key;

    let x: number;
    let y: number;
    let w: number;
    let h: number;

    const box =
      obj.frame && typeof obj.frame === 'object' && !Array.isArray(obj.frame)
        ? (obj.frame as Record<string, unknown>)
        : obj.rect && typeof obj.rect === 'object' && !Array.isArray(obj.rect)
          ? (obj.rect as Record<string, unknown>)
          : undefined;

    if (box) {
      x = Number(box.x);
      y = Number(box.y);
      w = Number(box.w);
      h = Number(box.h);
    } else if (
      typeof obj.x === 'number' &&
      typeof obj.y === 'number' &&
      typeof obj.w === 'number' &&
      typeof obj.h === 'number'
    ) {
      x = obj.x;
      y = obj.y;
      w = obj.w;
      h = obj.h;
    } else if (inferredStripW && Number.isInteger(inferredStripW) && Number.isInteger(inferredStripH)) {
      const cols = Math.floor(sourceWidth / inferredStripW);
      x = (idx % cols) * inferredStripW;
      y = Math.floor(idx / cols) * inferredStripH;
      w = inferredStripW;
      h = inferredStripH;
    } else {
      throw new Error(
        `Frame #${idx + 1} thiếu tọa độ (frame: {x,y,w,h}) và không chia đều được strip ngang.`,
      );
    }

    const rect: StripSliceRect = { x, y, w, h, durationMs, label, pivot: framePivot };
    validateRectBounds(rect, sourceWidth, sourceHeight, idx);
    return rect;
  });

  tags = parseTags(root.tags ?? meta?.frameTags, frames.length);
  if (root.loop === undefined && tags.length) {
    loop = tags[0].loop;
  }
  if (root.direction === undefined && tags.length) {
    direction = tags[0].direction;
  }

  return {
    frames,
    loop,
    direction,
    pivot: rootPivot ?? frames[0]?.pivot,
    tags,
    timingSource: 'metadata',
    warnings,
  };
}

const VALID_FAMILIES: ReadonlySet<string> = new Set([
  'character',
  'prop',
  'terrain',
  'environment',
  'animation',
  'ui',
  'vfx',
]);

function parseManifestSlot(
  raw: unknown,
  slotLabel: string,
): { name?: string; fileName: string; metadataFileName?: string; pivot?: Pivot } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asRecord(raw, `Manifest slot "${slotLabel}" phải là object.`);
  if (typeof obj.fileName !== 'string' || !obj.fileName.trim()) {
    throw new Error(`Manifest slot "${slotLabel}" thiếu trường "fileName".`);
  }
  return {
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined,
    fileName: obj.fileName.trim(),
    metadataFileName:
      typeof obj.metadataFileName === 'string' && obj.metadataFileName.trim()
        ? obj.metadataFileName.trim()
        : undefined,
    pivot: parsePivot(obj.pivot),
  };
}

/** Parse a minimal standalone review manifest JSON without talking to any Engine server. */
export function parseReviewManifest(text: string): ReviewManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON manifest không hợp lệ: ${(err as Error).message}`);
  }
  const obj = asRecord(raw, 'Manifest phải là JSON object.');
  if (obj.kind !== undefined && obj.kind !== ART_REVIEW_MANIFEST_KIND) {
    throw new Error(`Manifest kind không được hỗ trợ: ${String(obj.kind)}.`);
  }
  let assetFamily: AssetFamily | undefined;
  if (obj.assetFamily !== undefined) {
    if (typeof obj.assetFamily !== 'string' || !VALID_FAMILIES.has(obj.assetFamily)) {
      throw new Error(`Manifest assetFamily không hợp lệ: ${String(obj.assetFamily)}.`);
    }
    assetFamily = obj.assetFamily as AssetFamily;
  }

  const baseline = parseManifestSlot(obj.baseline, 'baseline');
  const candidate = parseManifestSlot(obj.candidate, 'candidate');
  if (!baseline && !candidate && !obj.rubric) {
    throw new Error('Manifest cần ít nhất baseline, candidate hoặc rubric.');
  }

  return {
    kind: ART_REVIEW_MANIFEST_KIND,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    assetFamily,
    baseline,
    candidate,
    rubric: obj.rubric !== undefined ? parseRubricJson(JSON.stringify(obj.rubric)) : undefined,
  };
}
