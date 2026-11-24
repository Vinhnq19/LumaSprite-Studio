import { createHash } from 'node:crypto';
import { Img } from '../../core/image.ts';
import {
  celFor,
  composite,
  newAsset,
  newLayer,
  uid,
} from '../../studio/pixel/model.ts';
import {
  choosePalette,
} from '../../studio/pixel/processing.ts';
import {
  type ClipGenerationContext,
  type ClipGenerationMetadata,
  createClipGenerationContext,
  getSelectedSlots,
} from '../../studio/clip-generation.ts';
import { checkClipReadiness } from '../../studio/clips.ts';
import { resolvePixelPivot } from '../../studio/characters.ts';
import type { VariantInfo } from '../../studio/variants.ts';
import type { ProjectDocument } from '../../studio/types.ts';
import { PixelStore } from './pixel-store.ts';
import { VariantStore } from './variant-store.ts';
import { StudioError, validateFiles } from './store.ts';
import { encodePng } from '../png.ts';
import { extractAssetPalette, rebuildClipSource } from './clip-processing.ts';

export interface PrepareClipSnapshotOptions {
  projectRoot: string;
  projectId: string;
  revision: number;
  clipId: string;
  paletteMode?: 'asset' | 'auto16';
  targetPalette?: number[];
  storeRoot: string;
}

export interface ClipGuideSlotMetadata {
  id: string;
  order: number;
  duration: number;
  selected: boolean;
  frozen: boolean;
  keyframe: boolean;
  isEditedPose: boolean;
}

export interface ClipGuideMetadata {
  w: number;
  h: number;
  cols: number;
  rows: number;
  slots: ClipGuideSlotMetadata[];
}

export interface ClipSnapshotResult {
  context: ClipGenerationContext;
  referenceId: string;
  referenceInfo: VariantInfo;
  contextDoc: ProjectDocument;
  helperFiles: string[];
  preview: string;
  maskPreview?: string;
  guidePreview: string;
  guideMetadata: ClipGuideMetadata;
  facing: string;
  template: string;
  problems: string[];
}

export function hashContext(context: ClipGenerationContext): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

export function hashMask(mask: number[] | Uint32Array | undefined): string | undefined {
  if (!mask) return undefined;
  const bytes = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    if (v !== 0 && v !== 1) {
      throw new StudioError(`Mask chứa giá trị không hợp lệ tại vị trí ${i}: ${v} (chỉ cho phép 0 hoặc 1).`, 400);
    }
    bytes[i] = v;
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function drawLine(
  img: Img,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;

  while (true) {
    if (cx >= 0 && cx < img.w && cy >= 0 && cy < img.h) {
      img.data[cy * img.w + cx] = color;
    }
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

export function createGuideContactSheet(
  context: ClipGenerationContext,
  baselineFrames: { id: string; data: Uint32Array }[]
): { image: Img; metadata: ClipGuideMetadata } {
  const N = context.slots.length;
  const w = context.w;
  const h = context.h;

  const cols = Math.min(N, 6);
  const rows = Math.ceil(N / cols);
  const pad = 2;

  // Compute bounded thumbnail geometry BEFORE allocating, max 1024 each
  const availW = Math.max(1, Math.floor((1024 - (cols + 1) * pad) / cols));
  const availH = Math.max(1, Math.floor((1024 - (rows + 1) * pad) / rows));

  let thumbW: number;
  let thumbH: number;

  if (w <= availW && h <= availH) {
    let scale = 1;
    while ((scale + 1) * w <= availW && (scale + 1) * h <= availH && scale < 4 && (w <= 32 || h <= 32)) {
      scale++;
    }
    thumbW = w * scale;
    thumbH = h * scale;
  } else {
    const scale = Math.min(availW / w, availH / h);
    thumbW = Math.max(1, Math.floor(w * scale));
    thumbH = Math.max(1, Math.floor(h * scale));
  }

  const totalW = cols * thumbW + (cols + 1) * pad;
  const totalH = rows * thumbH + (rows + 1) * pad;

  const guideImg = new Img(totalW, totalH);
  guideImg.data.fill(0x1a1a24ff);

  const slotMetadata: ClipGuideSlotMetadata[] = [];

  for (let idx = 0; idx < N; idx++) {
    const slot = context.slots[idx];
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    const destX = pad + col * (thumbW + pad);
    const destY = pad + row * (thumbH + pad);

    const baseData = baselineFrames.find(b => b.id === slot.id)?.data;
    if (baseData) {
      for (let ty = 0; ty < thumbH; ty++) {
        const py = Math.min(h - 1, Math.floor((ty * h) / thumbH));
        for (let tx = 0; tx < thumbW; tx++) {
          const px = Math.min(w - 1, Math.floor((tx * w) / thumbW));
          const pixel = baseData[py * w + px];
          const gx = destX + tx;
          const gy = destY + ty;
          if (gx < totalW && gy < totalH) {
            if (slot.frozen) {
              guideImg.data[gy * totalW + gx] = pixel & 255 ? (pixel & 0xccccccff) : 0x14141cff;
            } else {
              guideImg.data[gy * totalW + gx] = pixel & 255 ? pixel : 0x222230ff;
            }
          }
        }
      }
    }

    let isEditedPose = slot.keyframe;
    if (!isEditedPose && slot.pose) {
      for (const [lmName, pt] of Object.entries(slot.pose)) {
        const canonical = context.landmarks[lmName];
        if (canonical && (Math.round(canonical.x) !== Math.round(pt.x) || Math.round(canonical.y) !== Math.round(pt.y))) {
          isEditedPose = true;
          break;
        }
      }
    }

    slotMetadata.push({
      id: slot.id,
      order: idx,
      duration: slot.duration,
      selected: slot.selected,
      frozen: slot.frozen,
      keyframe: slot.keyframe,
      isEditedPose,
    });

    const scaleX = thumbW / w;
    const scaleY = thumbH / h;

    // Draw links
    const linkColor = slot.frozen ? 0x6688aaff : isEditedPose ? 0x00ffffff : 0xffaa00ff;
    if (context.links && slot.pose) {
      for (const link of context.links) {
        const p1 = slot.pose[link.from] ?? (context.landmarks[link.from] ? { x: context.landmarks[link.from].x, y: context.landmarks[link.from].y } : undefined);
        const p2 = slot.pose[link.to] ?? (context.landmarks[link.to] ? { x: context.landmarks[link.to].x, y: context.landmarks[link.to].y } : undefined);
        if (p1 && p2) {
          drawLine(
            guideImg,
            Math.round(destX + p1.x * scaleX),
            Math.round(destY + p1.y * scaleY),
            Math.round(destX + p2.x * scaleX),
            Math.round(destY + p2.y * scaleY),
            linkColor
          );
        }
      }
    }

    // Draw landmarks
    const landmarkColor = isEditedPose ? 0x33ff66ff : 0xffcc00ff;
    if (slot.pose) {
      for (const pt of Object.values(slot.pose)) {
        const cx = Math.round(destX + pt.x * scaleX);
        const cy = Math.round(destY + pt.y * scaleY);
        if (cx >= 0 && cx < totalW && cy >= 0 && cy < totalH) {
          guideImg.data[cy * totalW + cx] = landmarkColor;
        }
      }
    }
  }

  return {
    image: guideImg,
    metadata: {
      w: totalW,
      h: totalH,
      cols,
      rows,
      slots: slotMetadata,
    },
  };
}

export function prepareClipSnapshot(options: PrepareClipSnapshotOptions): ClipSnapshotResult {
  if (!options.storeRoot || typeof options.storeRoot !== 'string') {
    throw new StudioError('Thiếu storeRoot của VariantStore.', 400);
  }

  const store = new PixelStore(options.projectRoot);
  const doc = store.load(options.projectId, false, true);

  if (doc.revision !== options.revision) {
    throw new StudioError(
      `Phiên bản dự án không khớp: yêu cầu revision ${options.revision}, hiện tại ${doc.revision}.`,
      409
    );
  }

  const clips = doc.studio?.clips;
  const clip = clips?.[options.clipId];
  if (!clip) {
    throw new StudioError(`Không tìm thấy clip "${options.clipId}".`, 404);
  }

  const characters = doc.studio?.characters;
  const character = characters?.[clip.characterId];
  if (!character) {
    throw new StudioError(`Không tìm thấy nhân vật "${clip.characterId}".`, 404);
  }
  if (!character.approved) {
    throw new StudioError(`Nhân vật "${clip.characterId}" chưa được phê duyệt.`, 400);
  }

  const sourceAsset = doc.assets.find(a => a.id === character.source.assetId);
  if (!sourceAsset) {
    throw new StudioError(`Không tìm thấy asset nguồn "${character.source.assetId}".`, 404);
  }
  const sourceFrame = sourceAsset.frames.find(f => f.id === character.source.frameId);
  if (!sourceFrame) {
    throw new StudioError(`Không tìm thấy frame nguồn "${character.source.frameId}".`, 404);
  }

  // Preflight 32M pixels BEFORE loading baseline buffers
  if (clip.slots.length * character.source.w * character.source.h > 32_000_000) {
    throw new StudioError('Animation vượt ngân sách 32 triệu pixel cel.', 400);
  }

  // Hydrate only source frame
  store.hydrate(doc, (a, f) => a.id === character.source.assetId && f === character.source.frameId);
  const currentComposite = composite(sourceAsset, character.source.frameId).data;

  // Hydrate master resource and mask
  const masterRes = store.resource(options.projectId, character.source.rgbaResourceId);
  if (!masterRes || masterRes.kind !== 'rgba') {
    throw new StudioError('Tài nguyên master RGBA không hợp lệ hoặc thiếu dữ liệu.', 400);
  }
  if (masterRes.w !== character.source.w || masterRes.h !== character.source.h) {
    throw new StudioError('Kích thước tài nguyên master RGBA không khớp kích thước nguồn.', 400);
  }

  let movementMaskData: Uint32Array | undefined;
  if (clip.mode === 'region') {
    if (!clip.movementMaskResourceId) {
      throw new StudioError('Clip chế độ region thiếu movementMaskResourceId.', 400);
    }
    const maskRes = store.resource(options.projectId, clip.movementMaskResourceId);
    if (!maskRes || maskRes.kind !== 'mask') {
      throw new StudioError('Tài nguyên mặt nạ di chuyển không hợp lệ hoặc thiếu dữ liệu.', 400);
    }
    if (maskRes.w !== character.source.w || maskRes.h !== character.source.h) {
      throw new StudioError('Kích thước mặt nạ di chuyển không khớp kích thước nguồn.', 400);
    }
    movementMaskData = maskRes.data;
  }

  const currentPivot = resolvePixelPivot(sourceAsset.metadata?.pivot, sourceAsset.w, sourceAsset.h);
  const readiness = checkClipReadiness(clip, doc, {
    sourceResourceData: masterRes.data,
    currentComposite,
    currentWidth: sourceAsset.w,
    currentHeight: sourceAsset.h,
    currentPalette: sourceAsset.palette,
    currentPivot,
    movementMaskData,
  });

  if (!readiness.ready) {
    throw new StudioError(`Clip chưa sẵn sàng (${readiness.status}): ${readiness.reason ?? ''}`, 400);
  }

  if (clip.slots.length < 2 || clip.slots.length > 24) {
    throw new StudioError(`Số lượng slot cần từ 2 đến 24, nhận: ${clip.slots.length}.`, 400);
  }

  const baselineFrames: { id: string; duration: number; data: Uint32Array }[] = [];
  for (let i = 0; i < clip.slots.length; i++) {
    const slot = clip.slots[i];
    const slotRes = store.resource(options.projectId, slot.rgbaResourceId);
    if (!slotRes || slotRes.kind !== 'rgba' || slotRes.w !== character.source.w || slotRes.h !== character.source.h) {
      throw new StudioError(`Tài nguyên baseline cho slot "${slot.id}" không hợp lệ.`, 400);
    }
    if (!(slotRes.data instanceof Uint32Array) || slotRes.data.length !== character.source.w * character.source.h) {
      throw new StudioError(`Dữ liệu baseline cho slot "${slot.id}" không đúng kích thước.`, 400);
    }
    baselineFrames.push({ id: slot.id, duration: slot.duration, data: slotRes.data.slice() });
  }

  // Strict palette mode and target palette validation
  const paletteMode = options.paletteMode ?? 'asset';
  if (paletteMode !== 'asset' && paletteMode !== 'auto16') {
    throw new StudioError(`paletteMode không hợp lệ: "${String(paletteMode)}".`, 400);
  }

  let targetPalette: number[];
  if (paletteMode === 'auto16') {
    const mImg = new Img(character.source.w, character.source.h);
    mImg.data.set(masterRes.data);
    targetPalette = choosePalette([mImg], 16);
  } else {
    const sourceColors = options.targetPalette ?? character.source.palette;
    if (!Array.isArray(sourceColors) || sourceColors.length === 0) {
      throw new StudioError('targetPalette cần là mảng màu không rỗng.', 400);
    }
    for (const c of sourceColors) {
      if (!Number.isInteger(c) || c < 0 || c > 0xffffffff) {
        throw new StudioError(`Màu không hợp lệ trong targetPalette: ${String(c)}.`, 400);
      }
      const alpha = c & 255;
      if (alpha === 0 && c !== 0) {
        throw new StudioError(`Palette đích không được chứa RGB ẩn khi alpha = 0 (0x${c.toString(16)}).`, 400);
      }
      if (alpha !== 0 && alpha !== 255) {
        throw new StudioError(`Palette đích chỉ hỗ trợ màu đục (alpha 255) và trong suốt chuẩn (0), nhận: 0x${c.toString(16)}.`, 400);
      }
    }
    targetPalette = [...new Set(sourceColors.filter(c => (c & 255) === 255))];
    if (targetPalette.length === 0) {
      throw new StudioError('Palette đích phải chứa ít nhất một màu đục (alpha 255).', 400);
    }
  }

  const problems: string[] = [];
  if (targetPalette.length === 0) {
    problems.push('Palette không có màu đục.');
  }
  if (masterRes.data.some(p => (p & 255) > 0 && (p & 255) < 255)) {
    problems.push('Mẫu có pixel bán trong suốt.');
  }
  if (masterRes.data.some(p => (p & 255) === 255 && !targetPalette.includes(p))) {
    problems.push('Mẫu có màu ngoài palette đích.');
  }
  for (const bf of baselineFrames) {
    if (bf.data.some(p => (p & 255) > 0 && (p & 255) < 255)) {
      problems.push(`Baseline slot "${bf.id}" có pixel bán trong suốt.`);
    }
  }
  const lockedOrUnselectedSlots = clip.slots.filter(s => s.frozen || !s.selected);
  for (const ls of lockedOrUnselectedSlots) {
    const bf = baselineFrames.find(b => b.id === ls.id);
    if (bf && bf.data.some(p => (p & 255) === 255 && !targetPalette.includes(p))) {
      problems.push(`Baseline giữ lại của slot "${ls.id}" có màu ngoài palette đích.`);
    }
  }
  if (clip.mode === 'region' && movementMaskData) {
    for (const selSlot of clip.slots.filter(s => s.selected && !s.frozen)) {
      const bf = baselineFrames.find(b => b.id === selSlot.id);
      if (bf) {
        for (let p = 0; p < bf.data.length; p++) {
          if (movementMaskData[p] === 0) {
            const pixel = bf.data[p];
            if ((pixel & 255) === 255 && !targetPalette.includes(pixel)) {
              problems.push(`Baseline ngoài vùng cho phép của slot "${selSlot.id}" có màu ngoài palette đích.`);
              break;
            }
          }
        }
      }
    }
  }

  // Master mismatch / locked baseline / outside-region mismatch must block with explicit normalized-copy review
  if (problems.length > 0) {
    throw new StudioError(
      `Không thể chuẩn bị clip do xung đột palette/pixel (cần tạo bản sao chuẩn hóa): ${problems.join('; ')}`,
      422
    );
  }

  // Explicit metadata mapping
  const sourceFrameIndex = sourceAsset.frames.findIndex(f => f.id === character.source.frameId);
  const sourceEvents = sourceAsset.metadata?.events?.filter(e => e.frame === sourceFrameIndex).map(e => ({ frame: 0, name: e.name })) ?? [];

  const sourceMetadata: ClipGenerationMetadata = {
    pivot: sourceAsset.metadata?.pivot
      ? structuredClone(sourceAsset.metadata.pivot)
      : { x: character.source.pivot.x / character.source.w, y: character.source.pivot.y / character.source.h },
    ...(sourceAsset.metadata?.hitbox ? { hitbox: structuredClone(sourceAsset.metadata.hitbox) } : {}),
    events: sourceEvents,
  };

  // Map parts name-only to prevent leaking maskResourceId
  const nameOnlyParts = Object.fromEntries(
    Object.entries(character.parts ?? {}).map(([k, p]) => [k, { name: p.name }])
  );

  const context = createClipGenerationContext({
    projectId: options.projectId,
    revision: options.revision,
    clipId: clip.id,
    characterId: character.id,
    name: clip.name,
    sourceAssetId: character.source.assetId,
    sourceFrameId: character.source.frameId,
    w: character.source.w,
    h: character.source.h,
    paletteMode,
    palette: targetPalette.includes(0) ? targetPalette : [0, ...targetPalette],
    pivot: { x: character.source.pivot.x, y: character.source.pivot.y },
    mode: clip.mode,
    loop: clip.loop,
    landmarks: structuredClone(character.landmarks ?? {}),
    links: structuredClone(character.links ?? []),
    parts: nameOnlyParts,
    sourceMetadata,
    slots: clip.slots.map(s => ({
      id: s.id,
      duration: s.duration,
      selected: s.selected,
      frozen: s.frozen,
      keyframe: s.keyframe,
      pose: structuredClone(s.pose ?? {}),
    })),
  });

  // Prepare full N flat baseline asset
  const baselineAsset = newAsset(context.name, context.w, context.h);
  baselineAsset.id = context.clipId;
  baselineAsset.frames = context.slots.map(s => ({ id: s.id, duration: s.duration }));
  const baseLayer = newLayer('Baseline');
  baseLayer.cels = {};
  baselineAsset.layers = [baseLayer];
  baselineAsset.cels = {};
  baselineFrames.forEach((bf, idx) => {
    const celId = uid();
    baselineAsset.cels[celId] = { id: celId, data: bf.data.slice() };
    baseLayer.cels[bf.id] = celId;
  });
  baselineAsset.tags = [
    {
      id: uid(),
      name: context.name,
      from: baselineAsset.frames[0].id,
      to: baselineAsset.frames[baselineAsset.frames.length - 1].id,
      direction: 'forward',
      loop: context.loop,
    },
  ];
  baselineAsset.palette = extractAssetPalette(baselineFrames.map(b => b.data));
  baselineAsset.metadata = {
    pivot: { x: context.pivot.x / context.w, y: context.pivot.y / context.h },
    ...(sourceMetadata.hitbox ? { hitbox: structuredClone(sourceMetadata.hitbox) } : {}),
    events: structuredClone(sourceMetadata.events ?? []),
  };
  baselineAsset.source = {
    entry: 'art.px.js',
    files: {
      'art.px.js': rebuildClipSource(
        context.name,
        context.w,
        context.h,
        baselineFrames.map(b => b.data),
        context.slots.map(s => s.duration),
        context.loop
      ),
    },
  };

  // Separate approved master asset
  const masterAsset = newAsset('_pxl_clip_master', context.w, context.h);
  masterAsset.frames[0].duration = 100;
  celFor(masterAsset, masterAsset.layers[0].id, masterAsset.frames[0].id, true)!.data = masterRes.data.slice();
  masterAsset.palette = extractAssetPalette([masterRes.data]);
  masterAsset.source = {
    entry: 'art.px.js',
    files: {
      'art.px.js': rebuildClipSource('_pxl_clip_master', context.w, context.h, [masterRes.data], [100], true),
    },
  };

  const selectedSlots = getSelectedSlots(context);

  // Build contextDoc and helper source
  const files: Record<string, string> = {};
  const helperFiles: string[] = ['_pxl_clip_master.px.js'];
  files['_pxl_clip_master.px.js'] = rebuildClipSource('_pxl_clip_master', context.w, context.h, [masterRes.data], [100], true);

  selectedSlots.forEach((slot, k) => {
    const helperName = `_pxl_clip_slot_${k}.px.js`;
    helperFiles.push(helperName);
    const slotData = baselineFrames.find(b => b.id === slot.id)!.data;
    files[helperName] = rebuildClipSource(`_pxl_clip_slot_${k}`, context.w, context.h, [slotData], [100], true);
  });

  const includeStatements = helperFiles.map(h => `include("${h}");`).join('\n');
  const animFrames = selectedSlots.map((s, k) =>
    `  frame({ ms: ${s.duration} }, rect(0, 0, ${context.w}, ${context.h}, '_'), stamp("_pxl_clip_slot_${k}", 0, 0))`
  ).join(',\n');

  const mainSource = `${includeStatements}\nanim(${JSON.stringify(context.name)}, { w: ${context.w}, h: ${context.h}, base: "_pxl_clip_master", loop: ${context.loop} },\n${animFrames}\n);\n`;
  files['art.px.js'] = mainSource;

  validateFiles(files, 'art.px.js');

  const contextDoc: ProjectDocument = {
    schemaVersion: 1,
    id: options.projectId,
    revision: context.revision,
    name: context.name,
    entry: 'art.px.js',
    files,
    pixels: {},
    metadata: {
      [context.name]: {
        events: structuredClone(sourceMetadata.events ?? []),
        hitbox: structuredClone(sourceMetadata.hitbox),
      },
    },
  };

  // Previews
  const previewImg = new Img(context.w, context.h);
  previewImg.data.set(masterRes.data);
  const preview = Buffer.from(encodePng(previewImg)).toString('base64');

  let maskPreview: string | undefined;
  if (movementMaskData) {
    const maskImg = new Img(context.w, context.h);
    movementMaskData.forEach((v, i) => {
      maskImg.data[i] = v ? 0xffffffff : 0x000000ff;
    });
    maskPreview = Buffer.from(encodePng(maskImg)).toString('base64');
  }

  const { image: guideImg, metadata: guideMetadata } = createGuideContactSheet(context, baselineFrames);
  const guidePreview = Buffer.from(encodePng(guideImg)).toString('base64');

  let maskDigest: string | undefined;
  if (clip.mode === 'region' && movementMaskData) {
    maskDigest = hashMask(movementMaskData);
  }

  // Persist reference variant with rollback protection
  const variantRepo = new VariantStore(options.storeRoot);
  let referenceInfo: VariantInfo | undefined;
  try {
    referenceInfo = variantRepo.put([baselineAsset, masterAsset], {
      kind: 'reference',
      label: 'Clip mẫu & master',
      canApply: false,
      clip: {
        clipId: context.clipId,
        characterId: context.characterId,
        sourceAssetId: context.sourceAssetId,
        sourceFrameId: context.sourceFrameId,
        revision: context.revision,
        projectId: context.projectId,
        slotIds: context.slots.map(s => s.id),
        selectedSlotIds: selectedSlots.map(s => s.id),
        baselineAssetId: baselineAsset.id,
        masterAssetId: masterAsset.id,
        contextDigest: hashContext(context),
        maskDigest,
      },
    });

    if (clip.mode === 'region' && movementMaskData) {
      variantRepo.mask(referenceInfo.id, Array.from(movementMaskData));
    }

    const freshDoc = store.load(options.projectId, false, true);
    if (freshDoc.revision !== options.revision) {
      throw new StudioError(
        `Phiên bản dự án không khớp sau khi chuẩn bị: yêu cầu revision ${options.revision}, hiện tại ${freshDoc.revision}.`,
        409
      );
    }
  } catch (err) {
    if (referenceInfo?.id) {
      try {
        variantRepo.remove(referenceInfo.id);
      } catch {
        // ignore secondary removal error
      }
    }
    throw err;
  }

  return {
    context,
    referenceId: referenceInfo.id,
    referenceInfo,
    contextDoc,
    helperFiles,
    preview,
    maskPreview,
    guidePreview,
    guideMetadata,
    facing: clip.facing,
    template: clip.template,
    problems,
  };
}
