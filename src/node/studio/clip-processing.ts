import {
  celFor,
  composite,
  newAsset,
  newLayer,
  uid,
  validateAsset,
  type PixelAsset,
} from '../../studio/pixel/model.ts';

import {
  estimateImageSourceLength,
  imageSource,
  motionStats,
  normalizePixels,
  type ProcessingStats,
} from '../../studio/pixel/processing.ts';
import {
  type ClipGenerationContext,
  type ClipGenerationSlot,
  validateClipGenerationContext,
  getSelectedSlots,
} from '../../studio/clip-generation.ts';

export interface RawValidationResult {
  rawFrames: Uint32Array[];
  baselineFrames: Uint32Array[];
  selectedSlots: ClipGenerationSlot[];
  warnings: string[];
}

export interface RecomposeClipOptions {
  raw: PixelAsset | PixelAsset[];
  baseline: PixelAsset;
  context: ClipGenerationContext;
  mask?: Uint32Array;
}

export interface RecomposeClipResult {
  asset: PixelAsset;
  outputFrames: Uint32Array[];
  baselineFrames: Uint32Array[];
  rawFrames: Uint32Array[];
  selectedSlots: ClipGenerationSlot[];
  warnings: string[];
  restoredPixels: number;
}

export interface ClipProcessingStats {
  changedColors: number;
  changedAlpha: number;
  changedPixels: number;
  outsideChanges: number;
  restoredPixels: number;
  beforeColors: number;
  afterColors: number;
  frames: { bounds?: { x: number; y: number; w: number; h: number; bottom: number }; bottomDrift: number; changed: number }[];
  warnings: string[];
}

export interface NormalizeClipOptions {
  raw: PixelAsset | PixelAsset[];
  baseline: PixelAsset;
  context: ClipGenerationContext;
  mask?: Uint32Array;
  threshold?: number;
}

export interface NormalizeClipResult {
  asset: PixelAsset;
  stats: ClipProcessingStats;
  normalizedFrames: Uint32Array[];
  warnings: string[];
}

export interface VerifyClipOptions {
  asset: PixelAsset;
  baseline: PixelAsset;
  context: ClipGenerationContext;
  mask?: Uint32Array;
  normalized?: boolean;
  threshold?: number;
  throwOnError?: boolean;
}

export interface VerifyClipResult {
  valid: boolean;
  errors: string[];
}

export interface ProcessClipOptions {
  raw: PixelAsset | PixelAsset[];
  baseline: PixelAsset;
  context: ClipGenerationContext;
  mask?: Uint32Array;
  operation?: 'recompose' | 'normalize' | 'protect';
  threshold?: number;
}

export interface ProcessClipResult {
  asset: PixelAsset;
  stats: ClipProcessingStats;
  warnings: string[];
  verification: VerifyClipResult;
}

export function extractAssetPalette(frames: Uint32Array[]): number[] {
  const colors = new Set<number>();
  let hasTransparent = false;
  for (const data of frames) {
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      if (p & 255) {
        colors.add(p);
      } else {
        hasTransparent = true;
      }
    }
  }
  const sortedOpaque = [...colors].filter(c => (c & 255) === 255).sort((a, b) => a - b);
  const semiAlpha = [...colors].filter(c => (c & 255) !== 255).sort((a, b) => a - b);
  return hasTransparent ? [0, ...sortedOpaque, ...semiAlpha] : [...sortedOpaque, ...semiAlpha];
}

export function rebuildClipSource(
  name: string,
  w: number,
  h: number,
  images: Uint32Array[],
  durations: number[],
  loop: boolean
): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new Error(`Tên không hợp lệ: "${String(name)}".`);
  }
  if (typeof loop !== 'boolean') {
    throw new Error(`loop phải là boolean, nhận: ${String(loop)}.`);
  }
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) {
    throw new Error(`Kích thước w, h không hợp lệ: ${w}×${h}.`);
  }
  if (!Array.isArray(images) || images.length < 1 || images.length > 24) {
    throw new Error(`Số lượng frame không hợp lệ: ${images?.length}.`);
  }
  if (!Array.isArray(durations) || durations.length !== images.length) {
    throw new Error(`Số lượng duration không khớp frame: ${durations?.length} vs ${images.length}.`);
  }
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    if (!Number.isInteger(d) || d < 1 || d > 60000) {
      throw new Error(`Duration frame ${i + 1} không hợp lệ: ${String(d)} ms (cần số nguyên 1..60000 ms).`);
    }
  }
  const totalPixels = images.length * w * h;
  if (totalPixels > 32_000_000) {
    throw new Error(`Tổng số pixel cel (${totalPixels}) vượt quá ngân sách 32 triệu.`);
  }

  // Preflight: Reject unsupported hidden RGB with alpha 0
  for (let i = 0; i < images.length; i++) {
    const data = images[i];
    if (!(data instanceof Uint32Array) || data.length !== w * h) {
      throw new Error(`Frame ${i + 1} không phải là Uint32Array đúng kích thước ${w * h}.`);
    }
    for (let p = 0; p < data.length; p++) {
      const val = data[p];
      if ((val & 255) === 0 && val !== 0) {
        throw new Error(
          `Dữ liệu frame ${i + 1} chứa RGB ẩn khi alpha = 0 (0x${val.toString(16)}); không thể biểu diễn chính xác trong mã nguồn.`
        );
      }
    }
  }

  // Preflight: Bounded RLE byte length before accumulating strings
  const estimatedBytes = estimateImageSourceLength(name, w, h, images, durations, loop, 1_900_000);
  if (estimatedBytes > 1_900_000) {
    throw new Error('Ảnh có quá nhiều dữ liệu để lưu mã dựng chính xác (giới hạn 2 MiB/file). Giảm kích thước hoặc độ phức tạp.');
  }

  const source = imageSource(name, w, h, images, durations, loop);
  const actualBytes = typeof Buffer !== 'undefined'
    ? Buffer.byteLength(source, 'utf8')
    : new TextEncoder().encode(source).length;
  if (actualBytes > 1_900_000) {
    throw new Error('Ảnh có quá nhiều dữ liệu để lưu mã dựng chính xác (giới hạn 2 MiB/file). Giảm kích thước hoặc độ phức tạp.');
  }

  return source;
}

function validatePlaybackTag(
  tags: unknown,
  firstFrameId: string | undefined,
  lastFrameId: string | undefined,
  expectedLoop: boolean,
  label: string
): string[] {
  const errs: string[] = [];
  if (!Array.isArray(tags) || tags.length === 0) {
    errs.push(`${label} thiếu animation tag.`);
    return errs;
  }
  const tag = tags[0];
  if (!tag || typeof tag !== 'object') {
    errs.push(`${label} tag không hợp lệ.`);
    return errs;
  }
  if (tag.from !== firstFrameId) {
    errs.push(`Tag playback range from của ${label} ("${tag.from}") không khớp frame đầu ("${firstFrameId}").`);
  }
  if (tag.to !== lastFrameId) {
    errs.push(`Tag playback range to của ${label} ("${tag.to}") không khớp frame cuối ("${lastFrameId}").`);
  }
  if (tag.direction !== 'forward') {
    errs.push(`Tag direction của ${label} phải là 'forward', nhận: "${tag.direction}".`);
  }
  if (tag.loop !== expectedLoop) {
    errs.push(`Chế độ loop của ${label} (${tag.loop}) không khớp context (${expectedLoop}).`);
  }
  return errs;
}

export function validateRawReplacements(
  rawInput: PixelAsset | PixelAsset[],
  baseline: PixelAsset,
  contextInput: ClipGenerationContext,
  mask?: Uint32Array
): RawValidationResult {
  const raw = Array.isArray(rawInput) ? rawInput[0] : rawInput;
  if (Array.isArray(rawInput) && rawInput.length !== 1) {
    throw new Error(`Cần đúng 1 asset thô (K frame), nhận ${rawInput.length}.`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Asset thô không hợp lệ.');
  }
  if (!baseline || typeof baseline !== 'object') {
    throw new Error('Asset baseline không hợp lệ.');
  }

  // Structural validation of native asset before compositing
  validateAsset(baseline);
  validateAsset(raw);

  const context = validateClipGenerationContext(contextInput);
  const width = context.w;
  const height = context.h;
  const slotCount = context.slots.length;

  if (raw.w !== width || raw.h !== height) {
    throw new Error(`Kích thước asset thô ${raw.w}×${raw.h} không khớp canvas ${width}×${height}.`);
  }
  if (baseline.w !== width || baseline.h !== height) {
    throw new Error(`Kích thước baseline ${baseline.w}×${baseline.h} không khớp canvas ${width}×${height}.`);
  }

  const totalPixels = slotCount * width * height;
  if (totalPixels > 32_000_000) {
    throw new Error('Asset vượt ngân sách 32 triệu pixel cel.');
  }

  // Baseline validation: exact slot count, IDs, durations, and loaded cels
  if (baseline.frames.length !== slotCount) {
    throw new Error(`Baseline cần đúng ${slotCount} frame, nhận ${baseline.frames.length}.`);
  }

  // Canonical playback tag on baseline
  const baseTagErrors = validatePlaybackTag(
    baseline.tags,
    baseline.frames[0]?.id,
    baseline.frames[baseline.frames.length - 1]?.id,
    context.loop,
    'baseline'
  );
  if (baseTagErrors.length > 0) {
    throw new Error(baseTagErrors.join('; '));
  }

  const baselineFrames: Uint32Array[] = [];
  for (let j = 0; j < slotCount; j++) {
    const slot = context.slots[j];
    const baseFrame = baseline.frames[j];
    if (baseFrame.id !== slot.id) {
      throw new Error(`Frame ${j + 1} của baseline có ID "${baseFrame.id}" không khớp slot ID "${slot.id}".`);
    }
    if (baseFrame.duration !== slot.duration) {
      throw new Error(`Frame "${slot.id}" của baseline có duration ${baseFrame.duration} ms không khớp slot duration ${slot.duration} ms.`);
    }

    // Inspect visible image layers and their cels BEFORE compositing
    const visibleImageLayers = baseline.layers.filter(l => l.visible && l.type === 'image');
    if (visibleImageLayers.length === 0) {
      throw new Error(`Baseline không có layer ảnh hiển thị nào cho frame "${slot.id}".`);
    }
    for (const l of visibleImageLayers) {
      const celId = l.cels[slot.id];
      const cel = celId ? baseline.cels[celId] : undefined;
      if (!cel || !cel.data || !(cel.data instanceof Uint32Array) || cel.data.length !== width * height) {
        throw new Error(`Baseline cel chưa tải hoặc thiếu dữ liệu pixel cho frame "${slot.id}".`);
      }
      for (let p = 0; p < cel.data.length; p++) {
        const val = cel.data[p];
        if ((val & 255) === 0 && val !== 0) {
          throw new Error(`Retained baseline chứa RGB ẩn khi alpha = 0 (0x${val.toString(16)}); không thể biểu diễn chính xác trong mã nguồn.`);
        }
      }
    }

    const comp = composite(baseline, slot.id);
    baselineFrames.push(comp.data.slice());
  }

  // Selected unlocked slots: K in [1..N]
  const selectedSlots = getSelectedSlots(context);
  const K = selectedSlots.length;
  if (K < 1) {
    throw new Error('Cần chọn ít nhất một slot chưa bị khóa để thay thế.');
  }

  if (raw.frames.length !== K) {
    throw new Error(`Cần đúng ${K} frame thô cho các slot đã chọn, nhận ${raw.frames.length}.`);
  }

  // Nonuniform durations check
  for (let i = 0; i < K; i++) {
    const slot = selectedSlots[i];
    const rawFrame = raw.frames[i];
    if (rawFrame.duration !== slot.duration) {
      throw new Error(
        `Frame thô ${i + 1} có duration ${rawFrame.duration} ms không khớp slot "${slot.id}" (${slot.duration} ms).`
      );
    }
  }

  // Loop check on baseline
  if (!baseline.tags || baseline.tags.length === 0 || baseline.tags[0].loop !== context.loop) {
    throw new Error(
      `Baseline thiếu playback tag hoặc chế độ loop/lặp (${baseline.tags?.[0]?.loop}) không khớp context (${context.loop}).`
    );
  }

  // Loop check on raw
  if (!raw.tags || raw.tags.length === 0) {
    throw new Error('Asset thô thiếu tag playback loop.');
  }
  if (raw.tags[0].loop !== context.loop) {
    throw new Error(`Chế độ loop/lặp của asset thô (${raw.tags[0].loop}) không khớp yêu cầu (${context.loop}).`);
  }

  // Mode and region mask check
  if (context.mode === 'region') {
    if (!mask || !(mask instanceof Uint32Array) || mask.length !== width * height) {
      throw new Error('Vùng chọn chuyển động cần là Uint32Array có độ dài đúng canvas w*h.');
    }
    let hasOne = false;
    for (let p = 0; p < mask.length; p++) {
      const m = mask[p];
      if (m !== 0 && m !== 1) {
        throw new Error('Vùng chọn chuyển động phải là mảng nhị phân (chỉ gồm 0 và 1).');
      }
      if (m === 1) {
        hasOne = true;
      }
    }
    if (!hasOne) {
      throw new Error('Vùng chọn chuyển động rỗng (không có pixel 1).');
    }
  } else if (context.mode === 'whole') {
    if (mask !== undefined) {
      throw new Error('Chế độ whole (toàn bộ) không cho phép truyền movement mask.');
    }
  }

  // Inspect raw visible cel buffers BEFORE compositing
  for (let i = 0; i < K; i++) {
    const rawVisibleLayers = raw.layers.filter(l => l.visible && l.type === 'image');
    if (rawVisibleLayers.length === 0) {
      throw new Error(`Asset thô không có layer ảnh hiển thị nào cho frame "${raw.frames[i].id}".`);
    }
    for (const l of rawVisibleLayers) {
      const celId = l.cels[raw.frames[i].id];
      const cel = celId ? raw.cels[celId] : undefined;
      if (!cel || !cel.data || !(cel.data instanceof Uint32Array) || cel.data.length !== width * height) {
        throw new Error(`Asset thô thiếu cel dữ liệu pixel cho frame "${raw.frames[i].id}".`);
      }
      for (let p = 0; p < cel.data.length; p++) {
        const val = cel.data[p];
        if ((val & 255) === 0 && val !== 0) {
          throw new Error(`Asset thô chứa RGB ẩn khi alpha = 0 (0x${val.toString(16)}); không thể biểu diễn chính xác.`);
        }
      }
    }
  }

  // Raw composite extraction
  const rawFrames: Uint32Array[] = [];
  let totalVisible = 0;
  const emptyFrames: number[] = [];
  let semiTransparentPixels = 0;
  const colors = new Set<number>();
  const outsidePalette = new Set<number>();
  const allowed = new Set(context.palette.filter(c => (c & 255) > 0));

  for (let i = 0; i < K; i++) {
    const comp = composite(raw, raw.frames[i].id);
    const data = comp.data.slice();
    let frameVisible = 0;

    for (let p = 0; p < data.length; p++) {
      const val = data[p];
      const alpha = val & 255;
      if (alpha === 0) continue;
      frameVisible++;
      colors.add(val);
      if (alpha < 255) {
        semiTransparentPixels++;
      }
      if (context.paletteMode === 'asset' && !allowed.has(val)) {
        outsidePalette.add(val);
      }
    }

    totalVisible += frameVisible;
    if (!frameVisible) {
      emptyFrames.push(i + 1);
    }
    rawFrames.push(data);
  }

  if (!totalVisible) {
    throw new Error('Ảnh rỗng: không có pixel nhìn thấy.');
  }

  // Collect specific warnings
  const warnings: string[] = [];
  if (outsidePalette.size) {
    warnings.push(`${outsidePalette.size} màu nằm ngoài palette đã chọn.`);
  }
  const colorLimit = context.paletteMode === 'auto16' ? 16 : allowed.size;
  if (colors.size > colorLimit) {
    warnings.push(`Ảnh có ${colors.size} màu nhìn thấy, vượt giới hạn ${colorLimit} màu.`);
  }
  if (semiTransparentPixels) {
    warnings.push(`${semiTransparentPixels} pixel bán trong suốt (tổng các frame).`);
  }
  if (emptyFrames.length) {
    warnings.push(`Frame rỗng: ${emptyFrames.join(', ')}.`);
  }

  // Motion stats
  const motion = motionStats(rawFrames, width);
  warnings.push(...motion.warnings);

  return {
    rawFrames,
    baselineFrames,
    selectedSlots,
    warnings,
  };
}

export function recomposeClipFrames(
  rawFrames: Uint32Array[],
  baselineFrames: Uint32Array[],
  context: ClipGenerationContext,
  mask?: Uint32Array
): { outputFrames: Uint32Array[]; restoredPixels: number } {
  const slotCount = context.slots.length;
  const width = context.w;
  const height = context.h;
  const canvasSize = width * height;

  const outputFrames: Uint32Array[] = [];
  let kIdx = 0;
  let restoredPixels = 0;

  for (let j = 0; j < slotCount; j++) {
    const slot = context.slots[j];
    if (slot.frozen || !slot.selected) {
      // Frozen or unselected: EXACT baseline RGBA of this slot
      outputFrames.push(baselineFrames[j].slice());
    } else {
      // Selected unlocked slot
      const rawData = rawFrames[kIdx++];
      if (context.mode === 'whole') {
        outputFrames.push(rawData.slice());
      } else {
        // Region mode: raw inside mask, THAT slot's baseline outside mask
        const frame = new Uint32Array(canvasSize);
        for (let p = 0; p < canvasSize; p++) {
          if (mask![p] === 1) {
            frame[p] = rawData[p];
          } else {
            frame[p] = baselineFrames[j][p];
            restoredPixels++;
          }
        }
        outputFrames.push(frame);
      }
    }
  }

  return { outputFrames, restoredPixels };
}

export function buildRecomposedAsset(
  context: ClipGenerationContext,
  outputFrames: Uint32Array[],
  options: {
    normalized?: boolean;
    threshold?: number;
    originalSource?: { files: Record<string, string>; entry: string };
  } = {}
): PixelAsset {
  const width = context.w;
  const height = context.h;
  const slotCount = context.slots.length;
  const durations = context.slots.map(s => s.duration);

  // Preflight source creation
  const sourceCode = rebuildClipSource(context.name, width, height, outputFrames, durations, context.loop);

  const asset = newAsset(context.name, width, height);
  asset.id = context.clipId;
  asset.frames = context.slots.map(s => ({ id: s.id, duration: s.duration }));

  const layer = newLayer('Clip');
  layer.cels = {};
  asset.layers = [layer];
  asset.cels = {};

  outputFrames.forEach((data, i) => {
    const celId = uid();
    asset.cels[celId] = { id: celId, data: data.slice() };
    layer.cels[asset.frames[i].id] = celId;
  });

  asset.tags = [
    {
      id: uid(),
      name: context.name,
      from: asset.frames[0].id,
      to: asset.frames[asset.frames.length - 1].id,
      direction: 'forward',
      loop: context.loop,
    },
  ];

  asset.palette = extractAssetPalette(outputFrames);

  // Normalized metadata pivot
  asset.metadata = {
    pivot: {
      x: context.pivot.x / width,
      y: context.pivot.y / height,
    },
  };

  if (context.sourceMetadata?.hitbox) {
    asset.metadata.hitbox = structuredClone(context.sourceMetadata.hitbox);
  }

  if (context.sourceMetadata?.events) {
    asset.metadata.events = context.sourceMetadata.events
      .filter(e => e.frame >= 0 && e.frame < slotCount)
      .map(e => structuredClone(e));
  }

  asset.source = {
    entry: 'art.px.js',
    files: {
      'art.px.js': sourceCode,
    },
  };

  asset.provenance = {
    kind: options.normalized ? 'normalized' : 'protected',
    originalSource: options.originalSource ? structuredClone(options.originalSource) : undefined,
    palette: options.normalized ? [...context.palette] : undefined,
    alphaThreshold: options.normalized ? options.threshold ?? 128 : undefined,
  };

  return asset;
}

export function recomposeClipAsset(options: RecomposeClipOptions): RecomposeClipResult {
  const { raw, baseline, context: rawContext, mask } = options;
  const context = validateClipGenerationContext(rawContext);
  const validated = validateRawReplacements(raw, baseline, context, mask);
  const { outputFrames, restoredPixels } = recomposeClipFrames(
    validated.rawFrames,
    validated.baselineFrames,
    context,
    mask
  );

  const rawAsset = Array.isArray(raw) ? raw[0] : raw;
  const asset = buildRecomposedAsset(context, outputFrames, {
    normalized: false,
    originalSource: rawAsset.source,
  });

  return {
    asset,
    outputFrames,
    baselineFrames: validated.baselineFrames,
    rawFrames: validated.rawFrames,
    selectedSlots: validated.selectedSlots,
    warnings: validated.warnings,
    restoredPixels,
  };
}

export function normalizeClipAsset(options: NormalizeClipOptions): NormalizeClipResult {
  const { raw, baseline, context: rawContext, mask, threshold = 128 } = options;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) {
    throw new Error('Ngưỡng alpha cần 1–255.');
  }

  const context = validateClipGenerationContext(rawContext);
  const recomposed = recomposeClipAsset({ raw, baseline, context, mask });
  const slotCount = context.slots.length;
  const canvasSize = context.w * context.h;

  const targetOpaque = context.palette.filter(c => (c & 255) === 255);
  if (targetOpaque.length === 0) {
    throw new Error('Palette đích không có màu đục. Chọn màu alpha 255 hoặc AI tự chọn ≤16 màu.');
  }
  const targetOpaqueSet = new Set(targetOpaque);

  // Preflight retained/locked pixels: Must fit target opaque palette and canonical alpha
  for (let j = 0; j < slotCount; j++) {
    const slot = context.slots[j];
    const isRetainedSlot = slot.frozen || !slot.selected;
    const baseData = recomposed.baselineFrames[j];

    for (let p = 0; p < canvasSize; p++) {
      const isLocked = isRetainedSlot || (context.mode === 'region' && mask![p] === 0);
      if (isLocked) {
        const pixel = baseData[p];
        const alpha = pixel & 255;
        if (alpha === 0) {
          if (pixel !== 0) {
            throw new Error(
              `Pixel bị khóa tại slot "${slot.id}" chứa RGB ẩn khi alpha = 0 (cần review bản sao chuẩn hóa - normalize-copy review requirement).`
            );
          }
        } else if (alpha === 255) {
          if (!targetOpaqueSet.has(pixel)) {
            throw new Error(
              `Pixel bị khóa tại slot "${slot.id}" có màu #${pixel.toString(16).padStart(8, '0')} nằm ngoài palette đích (cần review bản sao chuẩn hóa - normalize-copy review requirement).`
            );
          }
        } else {
          throw new Error(
            `Pixel bị khóa tại slot "${slot.id}" chứa alpha bán trong suốt (${alpha}) (cần review bản sao chuẩn hóa - normalize-copy review requirement).`
          );
        }
      }
    }
  }

  // Normalize only selected permitted pixels
  const normalizedFrames: Uint32Array[] = [];
  let changedColors = 0;
  let changedAlpha = 0;
  let changedPixels = 0;
  let outsideChanges = 0;
  const beforeColors = new Set<number>();
  const afterColors = new Set<number>();

  for (let j = 0; j < slotCount; j++) {
    const slot = context.slots[j];
    const origFrame = recomposed.outputFrames[j];

    if (slot.frozen || !slot.selected) {
      // Entire frame is retained, preserve exact word-for-word
      normalizedFrames.push(origFrame.slice());
    } else {
      // Selected slot: normalize permitted pixels
      const normFrame = origFrame.slice();
      const permittedIndices: number[] = [];
      for (let p = 0; p < canvasSize; p++) {
        if (context.mode === 'whole' || mask![p] === 1) {
          permittedIndices.push(p);
        }
      }

      const permittedData = new Uint32Array(permittedIndices.length);
      for (let idx = 0; idx < permittedIndices.length; idx++) {
        permittedData[idx] = origFrame[permittedIndices[idx]];
      }

      const normalizedSub = normalizePixels(permittedData, targetOpaque, threshold);
      for (let idx = 0; idx < permittedIndices.length; idx++) {
        normFrame[permittedIndices[idx]] = normalizedSub[idx];
      }
      normalizedFrames.push(normFrame);
    }
  }

  // Calculate statistics
  for (let j = 0; j < slotCount; j++) {
    const orig = recomposed.outputFrames[j];
    const norm = normalizedFrames[j];
    for (let p = 0; p < canvasSize; p++) {
      const b = orig[p];
      const a = norm[p];
      if (b & 255) beforeColors.add(b);
      if (a & 255) afterColors.add(a);
      if (a !== b) {
        changedPixels++;
        if ((a >>> 8) !== (b >>> 8)) changedColors++;
        if ((a & 255) !== (b & 255)) changedAlpha++;
      }
      if (context.slots[j].selected && !context.slots[j].frozen && context.mode === 'region' && mask![p] === 0) {
        if (norm[p] !== recomposed.baselineFrames[j][p]) outsideChanges++;
      }
      if ((context.slots[j].frozen || !context.slots[j].selected) && norm[p] !== recomposed.baselineFrames[j][p]) {
        outsideChanges++;
      }
    }
  }

  const rawAsset = Array.isArray(raw) ? raw[0] : raw;
  const asset = buildRecomposedAsset(context, normalizedFrames, {
    normalized: true,
    threshold,
    originalSource: rawAsset.source,
  });

  const motion = motionStats(normalizedFrames, context.w, recomposed.baselineFrames[0]);
  const warnings = [...recomposed.warnings, ...motion.warnings];

  const stats: ClipProcessingStats = {
    changedColors,
    changedAlpha,
    changedPixels,
    outsideChanges,
    restoredPixels: recomposed.restoredPixels,
    beforeColors: beforeColors.size,
    afterColors: afterColors.size,
    frames: motion.frames,
    warnings,
  };

  return {
    asset,
    stats,
    normalizedFrames,
    warnings,
  };
}

export function verifyClipAsset(options: VerifyClipOptions): VerifyClipResult {
  const { asset, baseline, context: rawContext, mask, normalized = false, throwOnError = true } = options;
  const context = validateClipGenerationContext(rawContext);
  const width = context.w;
  const height = context.h;
  const slotCount = context.slots.length;
  const canvasSize = width * height;
  const errors: string[] = [];
  const failed = (): VerifyClipResult => {
    if (throwOnError) throw new Error(`Xác minh asset clip thất bại: ${errors.join('; ')}`);
    return { valid: false, errors };
  };

  // Structural validation of native asset before inspection
  try {
    validateAsset(asset);
  } catch (err) {
    errors.push(`Cấu trúc asset không hợp lệ: ${(err as Error).message}`);
  }
  try {
    validateAsset(baseline);
  } catch (err) {
    errors.push(`Cấu trúc baseline không hợp lệ: ${(err as Error).message}`);
  }
  // A rejected structure cannot safely be traversed or composited.
  if (errors.length) return failed();

  // 1. Exact asset identity & name
  if (asset.id !== context.clipId) {
    errors.push(`Định danh asset "${asset.id}" không khớp context clipId "${context.clipId}".`);
  }
  if (asset.name !== context.name) {
    errors.push(`Tên asset "${asset.name}" không khớp context name "${context.name}".`);
  }

  // 2. Fixed dimensions
  if (asset.w !== width || asset.h !== height) {
    errors.push(`Kích thước asset ${asset.w}×${asset.h} không khớp context ${width}×${height}.`);
  }
  if (baseline.w !== width || baseline.h !== height) {
    errors.push(`Kích thước baseline ${baseline.w}×${baseline.h} không khớp context ${width}×${height}.`);
  }

  // 3. Slot count
  if (asset.frames.length !== slotCount) {
    errors.push(`Số lượng frame ${asset.frames.length} không khớp số slot ${slotCount}.`);
  }
  if (baseline.frames.length !== slotCount) {
    errors.push(`Số lượng frame baseline ${baseline.frames.length} không khớp số slot ${slotCount}.`);
  }

  // 4. Slot IDs, order, durations
  for (let j = 0; j < Math.min(asset.frames.length, slotCount); j++) {
    const slot = context.slots[j];
    const frame = asset.frames[j];
    if (frame.id !== slot.id) {
      errors.push(`Frame thứ ${j + 1} ID "${frame.id}" không khớp slot ID "${slot.id}".`);
    }
    if (frame.duration !== slot.duration) {
      errors.push(`Frame "${slot.id}" duration ${frame.duration} ms không khớp slot duration ${slot.duration} ms.`);
    }
    if (baseline.frames[j] && baseline.frames[j].id !== slot.id) {
      errors.push(`Frame baseline thứ ${j + 1} ID "${baseline.frames[j].id}" không khớp slot ID "${slot.id}".`);
    }
    if (baseline.frames[j] && baseline.frames[j].duration !== slot.duration) {
      errors.push(`Frame baseline "${slot.id}" duration ${baseline.frames[j].duration} ms không khớp slot duration ${slot.duration} ms.`);
    }
  }

  // 5. Strict loaded cels & hidden RGB inspection on BOTH baseline and asset
  for (let j = 0; j < slotCount; j++) {
    const slot = context.slots[j];

    // Baseline visible cel check
    const baseVisibleLayers = baseline.layers.filter(l => l.visible && l.type === 'image');
    if (baseVisibleLayers.length === 0) {
      errors.push(`Baseline thiếu layer hiển thị cho frame "${slot.id}".`);
    } else {
      for (const l of baseVisibleLayers) {
        const celId = l.cels[slot.id];
        const cel = celId ? baseline.cels[celId] : undefined;
        if (!cel || !cel.data || !(cel.data instanceof Uint32Array) || cel.data.length !== canvasSize) {
          errors.push(`Baseline thiếu dữ liệu cel cho frame "${slot.id}".`);
        } else {
          for (let p = 0; p < cel.data.length; p++) {
            const val = cel.data[p];
            if ((val & 255) === 0 && val !== 0) {
              errors.push(`Baseline chứa RGB ẩn khi alpha = 0 (0x${val.toString(16)}).`);
              break;
            }
          }
        }
      }
    }

    // Asset visible cel check
    const assetVisibleLayers = asset.layers.filter(l => l.visible && l.type === 'image');
    if (assetVisibleLayers.length === 0) {
      errors.push(`Asset thiếu layer hiển thị cho frame "${slot.id}".`);
    } else {
      for (const l of assetVisibleLayers) {
        const celId = l.cels[slot.id];
        const cel = celId ? asset.cels[celId] : undefined;
        if (!cel || !cel.data || !(cel.data instanceof Uint32Array) || cel.data.length !== canvasSize) {
          errors.push(`Asset thiếu dữ liệu cel cho frame "${slot.id}".`);
        } else {
          for (let p = 0; p < cel.data.length; p++) {
            const val = cel.data[p];
            if ((val & 255) === 0 && val !== 0) {
              errors.push(`Asset chứa RGB ẩn khi alpha = 0 (0x${val.toString(16)}).`);
              break;
            }
          }
        }
      }
    }
  }

  // 6. Complete canonical playback tag range, direction, loop on BOTH asset and baseline
  errors.push(
    ...validatePlaybackTag(
      asset.tags,
      asset.frames[0]?.id,
      asset.frames[asset.frames.length - 1]?.id,
      context.loop,
      'asset'
    )
  );
  errors.push(
    ...validatePlaybackTag(
      baseline.tags,
      baseline.frames[0]?.id,
      baseline.frames[baseline.frames.length - 1]?.id,
      context.loop,
      'baseline'
    )
  );

  // 7. Normalized pivot (finite numbers, exact equality)
  const expectedPivotX = context.pivot.x / width;
  const expectedPivotY = context.pivot.y / height;
  if (!asset.metadata?.pivot || !Number.isFinite(asset.metadata.pivot.x) || !Number.isFinite(asset.metadata.pivot.y)) {
    errors.push('Thiếu metadata pivot hoặc pivot không phải số hữu hạn (NaN).');
  } else if (
    asset.metadata.pivot.x !== expectedPivotX ||
    asset.metadata.pivot.y !== expectedPivotY
  ) {
    errors.push(
      `Pivot (${asset.metadata.pivot.x}, ${asset.metadata.pivot.y}) không khớp pivot kỳ vọng (${expectedPivotX}, ${expectedPivotY}).`
    );
  }

  // 8. Source metadata preservation (hitbox, events, absence when relevant)
  if (context.sourceMetadata?.hitbox) {
    const hb = asset.metadata?.hitbox;
    const exp = context.sourceMetadata.hitbox;
    if (
      !hb ||
      !Number.isFinite(hb.x) ||
      !Number.isFinite(hb.y) ||
      !Number.isFinite(hb.w) ||
      !Number.isFinite(hb.h) ||
      hb.x !== exp.x ||
      hb.y !== exp.y ||
      hb.w !== exp.w ||
      hb.h !== exp.h
    ) {
      errors.push('Hitbox metadata không khớp hitbox đã lưu.');
    }
  } else if (asset.metadata?.hitbox !== undefined) {
    errors.push('Hitbox metadata xuất hiện không mong muốn.');
  }

  if (context.sourceMetadata?.events && context.sourceMetadata.events.length > 0) {
    const ev = asset.metadata?.events;
    const exp = context.sourceMetadata.events;
    if (!Array.isArray(ev) || ev.length !== exp.length) {
      errors.push('Events metadata không khớp số lượng.');
    } else {
      for (let idx = 0; idx < exp.length; idx++) {
        if (ev[idx].frame !== exp[idx].frame || ev[idx].name !== exp[idx].name) {
          errors.push(`Event metadata tại vị trí ${idx} không khớp.`);
          break;
        }
      }
    }
  } else if (asset.metadata?.events !== undefined && asset.metadata.events.length > 0) {
    errors.push('Events metadata xuất hiện không mong muốn.');
  }

  // 8. Strict mask validation in region mode
  let maskValid = true;
  if (context.mode === 'region') {
    if (!mask || !(mask instanceof Uint32Array) || mask.length !== canvasSize) {
      errors.push('Vùng chọn chuyển động mask không hợp lệ hoặc sai độ dài.');
      maskValid = false;
    } else {
      let hasOne = false;
      let isBinary = true;
      for (let p = 0; p < mask.length; p++) {
        const m = mask[p];
        if (m !== 0 && m !== 1) {
          isBinary = false;
        }
        if (m === 1) {
          hasOne = true;
        }
      }
      if (!isBinary) {
        errors.push('Mask chứa giá trị không nhị phân.');
        maskValid = false;
      }
      if (!hasOne) {
        errors.push('Mask rỗng (không có pixel 1).');
        maskValid = false;
      }
    }
  } else if (mask !== undefined) {
    errors.push('Chế độ toàn nhân vật (whole) không được nhận mask vùng chuyển động.');
  }

  // Reject identity, geometry, metadata and permission faults before pixel allocation.
  if (errors.length) return failed();

  // 9. Exact RGBA for frozen / unselected / outside-mask
  if (asset.frames.length === slotCount && baseline.frames.length === slotCount) {
    for (let j = 0; j < slotCount; j++) {
      const slot = context.slots[j];
      const assetComp = composite(asset, slot.id).data;
      const baseComp = composite(baseline, slot.id).data;

      if (slot.frozen || !slot.selected) {
        for (let p = 0; p < canvasSize; p++) {
          if (assetComp[p] !== baseComp[p]) {
            errors.push(
              `Pixel tại (${p % width}, ${Math.floor(p / width)}) trong slot bị khóa/không chọn "${slot.id}" bị thay đổi (kỳ vọng 0x${baseComp[p].toString(16)}, nhận 0x${assetComp[p].toString(16)}).`
            );
            break;
          }
        }
      } else if (context.mode === 'region' && maskValid && mask) {
        for (let p = 0; p < canvasSize; p++) {
          if (mask[p] === 0 && assetComp[p] !== baseComp[p]) {
            errors.push(
              `Pixel ngoài vùng chuyển động tại (${p % width}, ${Math.floor(p / width)}) trong slot "${slot.id}" bị thay đổi (kỳ vọng 0x${baseComp[p].toString(16)}, nhận 0x${assetComp[p].toString(16)}).`
            );
            break;
          }
        }
      }
    }
  }

  // 10. Normalized palette + alpha verification
  if (normalized) {
    const targetOpaqueSet = new Set(context.palette.filter(c => (c & 255) === 255));
    for (let j = 0; j < Math.min(asset.frames.length, slotCount); j++) {
      const slot = context.slots[j];
      const data = composite(asset, slot.id).data;
      for (let p = 0; p < canvasSize; p++) {
        const val = data[p];
        const alpha = val & 255;
        if (alpha === 0) {
          if (val !== 0) {
            errors.push(`Pixel tại (${p % width}, ${Math.floor(p / width)}) frame "${slot.id}" chứa RGB ẩn khi alpha = 0 (0x${val.toString(16)}).`);
            break;
          }
        } else if (alpha === 255) {
          if (!targetOpaqueSet.has(val)) {
            errors.push(`Pixel tại (${p % width}, ${Math.floor(p / width)}) frame "${slot.id}" chứa màu 0x${val.toString(16)} không thuộc palette chuẩn.`);
            break;
          }
        } else {
          errors.push(`Pixel tại (${p % width}, ${Math.floor(p / width)}) frame "${slot.id}" chứa alpha bán trong suốt (${alpha}).`);
          break;
        }
      }
    }
  }

  // 11. Canonical deterministic source verification
  if (!asset.source || asset.source.entry !== 'art.px.js' || !asset.source.files) {
    errors.push('Asset thiếu mã nguồn art.px.js hợp lệ.');
  } else {
    const fileKeys = Object.keys(asset.source.files);
    if (fileKeys.length !== 1 || fileKeys[0] !== 'art.px.js') {
      errors.push('Mã nguồn asset phải chứa chính xác một file art.px.js.');
    } else {
      const sourceStr = asset.source.files['art.px.js'];
      const byteLen = typeof Buffer !== 'undefined'
        ? Buffer.byteLength(sourceStr, 'utf8')
        : new TextEncoder().encode(sourceStr).length;
      if (byteLen > 1_900_000) {
        errors.push('Mã nguồn asset vượt quá giới hạn dung lượng file 1.9MB.');
      }

      if (asset.frames.length === slotCount) {
        try {
          const finalFrames = asset.frames.map(f => composite(asset, f.id).data);
          const expectedSource = rebuildClipSource(
            context.name,
            width,
            height,
            finalFrames,
            asset.frames.map(f => f.duration),
            context.loop
          );
          if (sourceStr !== expectedSource) {
            errors.push('Mã nguồn art.px.js không khớp mã nguồn chuẩn được tạo lại từ dữ liệu pixel.');
          }
        } catch (err) {
          errors.push(`Không thể tạo mã nguồn chuẩn để xác minh: ${(err as Error).message}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return failed();
  }

  return { valid: true, errors: [] };
}

export function processClipAsset(options: ProcessClipOptions): ProcessClipResult {
  const { raw, baseline, context, mask, operation = 'recompose', threshold = 128 } = options;

  let asset: PixelAsset;
  let stats: ClipProcessingStats;
  let warnings: string[];

  if (operation === 'normalize') {
    const norm = normalizeClipAsset({ raw, baseline, context, mask, threshold });
    asset = norm.asset;
    stats = norm.stats;
    warnings = norm.warnings;
  } else {
    const rec = recomposeClipAsset({ raw, baseline, context, mask });
    asset = rec.asset;
    warnings = rec.warnings;
    const motion = motionStats(rec.outputFrames, context.w, rec.baselineFrames[0]);
    stats = {
      changedColors: 0,
      changedAlpha: 0,
      changedPixels: 0,
      outsideChanges: 0,
      restoredPixels: rec.restoredPixels,
      beforeColors: asset.palette.length,
      afterColors: asset.palette.length,
      frames: motion.frames,
      warnings: [...warnings, ...motion.warnings],
    };
  }

  const verification = verifyClipAsset({
    asset,
    baseline,
    context,
    mask,
    normalized: operation === 'normalize',
    threshold,
    throwOnError: true,
  });

  return {
    asset,
    stats,
    warnings,
    verification,
  };
}
