import type { PixelStore } from './pixel-store.ts';
import type { Proposals } from './proposals.ts';
import { StudioError } from './store.ts';
import { composite, type PixelDocument, type PixelAsset } from '../../studio/pixel/model.ts';
import type { ProjectDocument, GenerationContext } from '../../studio/types.ts';
import { generationOptions, defaultGenerationOptions } from '../../studio/generation.ts';
import { validateArtDirection, defaultArtDirection, type ArtDirection } from '../../studio/art-direction.ts';
import { checkClipReadiness, validateClipId, type CharacterClip } from '../../studio/clips.ts';
import { encodePng } from '../png.ts';

export interface PreparedReferenceAsset {
  assetId: string;
  frameId: string;
  name: string;
  w: number;
  h: number;
  image: Buffer;
}

export interface PreparedSnapshot {
  projectId: string;
  revision: number;
  assetId: string;
  targetW: number;
  targetH: number;
  targetName: string;
  generation?: GenerationContext;
  artDirection: ArtDirection;
  contextDoc: ProjectDocument;
  preview?: Buffer;
  movementMask?: Buffer;
  guideImage?: Buffer;
  referenceAssets: PreparedReferenceAsset[];
  referenceVariantId?: string;
  isLegacyWithoutOptions?: boolean;
}

export interface ResolvedTargetSettings {
  effectiveStyle: 'game' | 'eight-bit' | 'flat-icon';
  effectivePaletteMode: 'auto16' | 'asset';
  effectivePalette: number[];
  artDirection: ArtDirection;
  options: import('../../studio/types.ts').GenerationOptions;
}

export function resolveTargetSettings(
  doc: PixelDocument,
  a: PixelAsset,
  optionsInput?: unknown,
  artDirectionInput?: unknown
): ResolvedTargetSettings {
  const savedArt: ArtDirection = doc.studio?.artDirection
    ? validateArtDirection(doc.studio.artDirection, doc)
    : { ...defaultArtDirection };
  let requestedArt: ArtDirection | undefined;
  if (artDirectionInput !== undefined) {
    try {
      requestedArt = validateArtDirection(artDirectionInput, doc);
    } catch (e) {
      throw new StudioError((e as Error).message);
    }
  }

  let options = { ...defaultGenerationOptions };
  let explicitOptionsStyle: 'game' | 'eight-bit' | 'flat-icon' | undefined;
  let explicitOptionsPaletteMode: 'auto16' | 'asset' | undefined;

  if (optionsInput !== undefined && typeof optionsInput === 'object' && optionsInput !== null) {
    const rawOpt = optionsInput as Record<string, unknown>;
    if (rawOpt.style !== undefined) explicitOptionsStyle = rawOpt.style as any;
    if (rawOpt.paletteMode !== undefined) explicitOptionsPaletteMode = rawOpt.paletteMode as any;
    try {
      options = generationOptions(optionsInput);
    } catch (e) {
      throw new StudioError((e as Error).message);
    }
  }

  const effectiveStyle = explicitOptionsStyle ?? requestedArt?.style ?? savedArt.style ?? 'game';
  const effectivePaletteMode = explicitOptionsPaletteMode ?? requestedArt?.paletteMode ?? savedArt.paletteMode ?? 'auto16';

  let effectivePalette: number[];
  if (effectivePaletteMode === 'asset') {
    if (requestedArt?.palette && requestedArt.palette.length > 0) {
      effectivePalette = [...requestedArt.palette];
    } else if (savedArt.palette && savedArt.palette.length > 0) {
      effectivePalette = [...savedArt.palette];
    } else {
      effectivePalette = [...a.palette];
    }
    if (!effectivePalette.some(c => (c & 255) > 0)) {
      throw new StudioError('Palette không có màu nhìn thấy. Thêm màu hoặc chọn AI tự chọn tối đa 16 màu.');
    }
  } else {
    effectivePalette = [...a.palette];
  }

  const artDirection: ArtDirection = {
    style: effectiveStyle,
    paletteMode: effectivePaletteMode,
    palette: effectivePalette,
    light: requestedArt?.light ?? savedArt.light ?? 'upper-left',
    detailLevel: requestedArt?.detailLevel ?? savedArt.detailLevel ?? 'medium',
    outline: requestedArt?.outline ?? savedArt.outline ?? 'dark',
    references: requestedArt?.references ?? savedArt.references ?? [],
  };

  options.style = effectiveStyle;
  options.paletteMode = effectivePaletteMode;

  return {
    effectiveStyle,
    effectivePaletteMode,
    effectivePalette,
    artDirection,
    options,
  };
}

export async function prepareGenerationSnapshot(
  store: PixelStore,
  variants: Proposals,
  doc: PixelDocument,
  assetId?: string,
  optionsInput?: unknown,
  artDirectionInput?: unknown,
  isBatch = false,
  regionEditInput?: unknown,
  clipGenerationInput?: unknown
): Promise<PreparedSnapshot> {
  const currentDoc = store.load(doc.id);
  if (currentDoc.revision !== doc.revision) {
    throw new StudioError('Dự án đã thay đổi trước khi chuẩn bị ngữ cảnh.', 409);
  }

  let clipId: string | undefined;
  if (clipGenerationInput !== undefined) {
    if (!clipGenerationInput || typeof clipGenerationInput !== 'object' || Array.isArray(clipGenerationInput)) {
      throw new StudioError('clipGeneration phải là một object.', 400);
    }
    const cg = clipGenerationInput as Record<string, unknown>;
    const keys = Object.keys(cg);
    if (keys.length !== 1 || keys[0] !== 'clipId') {
      throw new StudioError('clipGeneration chỉ được chứa thuộc tính clipId.', 400);
    }
    if (['__proto__', 'prototype', 'constructor'].includes(keys[0])) {
      throw new StudioError('clipGeneration chứa thuộc tính không được hỗ trợ.', 400);
    }
    if (!Object.hasOwn(cg, 'clipId')) {
      throw new StudioError('clipGeneration phải có thuộc tính clipId.', 400);
    }
    try {
      clipId = validateClipId(cg.clipId, 'clipId');
    } catch (e) {
      throw new StudioError((e as Error).message, 400);
    }
  }

  let clip: CharacterClip | undefined;
  let a: PixelAsset | undefined;

  if (clipId) {
    clip = (doc.studio?.clips && Object.hasOwn(doc.studio.clips, clipId)) ? doc.studio.clips[clipId] : undefined;
    if (!clip) {
      throw new StudioError(`Không tìm thấy clip '${clipId}'.`, 404);
    }
    const character = (doc.studio?.characters && Object.hasOwn(doc.studio.characters, clip.characterId)) ? doc.studio.characters[clip.characterId] : undefined;
    if (!character) {
      throw new StudioError(`Không tìm thấy nhân vật '${clip.characterId}'.`, 404);
    }
    const sourceAssetId = character.source?.assetId;
    a = doc.assets.find(item => item.id === sourceAssetId);
    if (!a) {
      throw new StudioError(`Không tìm thấy asset gốc '${sourceAssetId}'.`, 404);
    }
    if (assetId !== undefined && assetId !== sourceAssetId) {
      throw new StudioError('assetId không khớp với asset nguồn của clip.', 400);
    }
    const readiness = checkClipReadiness(clip, doc);
    if (!readiness.ready && readiness.status !== 'missing-data') {
      throw new StudioError(readiness.reason ?? 'Clip chưa sẵn sàng.', 400);
    }
  } else {
    a = doc.assets.find(item => item.id === assetId) ?? (assetId ? undefined : doc.assets[0]);
    if (!a) throw new StudioError('Không tìm thấy asset làm ngữ cảnh AI.', 404);
  }

  let artDirection: ArtDirection;
  let generation: GenerationContext | undefined;
  let isLegacyWithoutOptions = false;
  let resolved: ResolvedTargetSettings | undefined;

  if (isBatch) {
    resolved = resolveTargetSettings(doc, a, optionsInput, artDirectionInput);
    artDirection = resolved.artDirection;
    if (!clipId) {
      generation = { options: resolved.options, assetId: a.id, w: a.w, h: a.h, palette: resolved.effectivePalette };
    }
  } else {
    // Old /ai legacy path: do not apply new art profile implicitly to old path
    if (artDirectionInput !== undefined) {
      try {
        artDirection = validateArtDirection(artDirectionInput, doc);
      } catch (e) {
        throw new StudioError((e as Error).message);
      }
    } else {
      artDirection = { ...defaultArtDirection };
    }

    isLegacyWithoutOptions = optionsInput === undefined;
    if (!isLegacyWithoutOptions) {
      let options;
      try {
        options = generationOptions(optionsInput);
      } catch (e) {
        throw new StudioError((e as Error).message);
      }
      if (options.paletteMode === 'asset' && !a.palette.some(c => (c & 255) > 0)) {
        throw new StudioError('Palette không có màu nhìn thấy. Thêm màu hoặc chọn AI tự chọn tối đa 16 màu.', 400, 'INVALID_PALETTE');
      }
      generation = { options, assetId: a.id, w: a.w, h: a.h, palette: [...a.palette] };
    }
  }

  let contextDoc: ProjectDocument;
  let preview: Buffer | undefined;
  let movementMask: Buffer | undefined;
  let guideImage: Buffer | undefined;
  let referenceVariantId: string | undefined;

  try {
    if (clipId && clip && resolved) {
      if (regionEditInput !== undefined) {
        throw new StudioError('Không thể dùng đồng thời clipGeneration và regionEdit.', 400);
      }
      if (resolved.options.animation) {
        throw new StudioError('Không thể dùng đồng thời clipGeneration và generationOptions.animation.', 400);
      }

      const snap = await variants.clipReference(
        doc.id,
        doc.revision,
        clip.id,
        resolved.effectivePaletteMode,
        resolved.effectivePalette
      );
      referenceVariantId = snap.referenceId;

      if (snap.problems && snap.problems.length) {
        variants.discardReference(doc.id, referenceVariantId);
        referenceVariantId = undefined;
        throw new StudioError(`Mẫu chuẩn chưa khớp: ${snap.problems.join(' ')}`, 422);
      }

      if (store.load(doc.id).revision !== doc.revision) {
        throw new StudioError('Dự án đã thay đổi trong khi chuẩn bị ngữ cảnh.', 409);
      }

      artDirection.palette = [...snap.context.palette];
      const { animation: _ignored, ...baseOptions } = resolved.options;
      generation = {
        operation: 'clip-regenerate',
        clip: {
          context: snap.context,
          helperFiles: snap.helperFiles,
          facing: snap.facing,
          template: snap.template,
          guideMetadata: snap.guideMetadata,
        },
        options: {
          ...baseOptions,
          reference: true,
        },
        assetId: a.id,
        w: a.w,
        h: a.h,
        palette: [...snap.context.palette],
      };

      contextDoc = snap.contextDoc;
      preview = Buffer.from(snap.preview, 'base64');
      movementMask = snap.maskPreview ? Buffer.from(snap.maskPreview, 'base64') : undefined;
      guideImage = Buffer.from(snap.guidePreview, 'base64');
    } else if (regionEditInput !== undefined) {
      if (!regionEditInput || typeof regionEditInput !== 'object' || Array.isArray(regionEditInput)) {
        throw new StudioError('regionEdit phải là một object.', 400);
      }
      const rEdit = regionEditInput as Record<string, unknown>;
      const allowedKeys = ['frameId', 'mask', 'anchor'];
      for (const k of Object.keys(rEdit)) {
        if (!allowedKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
          throw new StudioError(`Thuộc tính regionEdit '${k}' không được hỗ trợ.`, 400);
        }
      }
      if (typeof rEdit.frameId !== 'string') {
        throw new StudioError('regionEdit.frameId phải là chuỗi.', 400);
      }
      const sourceFrame = a.frames.find(f => f.id === rEdit.frameId);
      if (!sourceFrame) {
        throw new StudioError('Frame mẫu không tồn tại.', 404);
      }
      if (!Array.isArray(rEdit.mask) || rEdit.mask.length !== a.w * a.h || rEdit.mask.some(v => v !== 0 && v !== 1) || !rEdit.mask.some(v => v === 1)) {
        throw new StudioError('Mask không khớp kích thước canvas hoặc không có vùng chọn.', 400);
      }
      let anchor: { x: number; y: number };
      if (rEdit.anchor !== undefined) {
        if (!rEdit.anchor || typeof rEdit.anchor !== 'object' || Array.isArray(rEdit.anchor)) {
          throw new StudioError('anchor trong regionEdit phải là object.', 400);
        }
        const anc = rEdit.anchor as Record<string, unknown>;
        for (const k of Object.keys(anc)) {
          if (!['x', 'y'].includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
            throw new StudioError(`Thuộc tính anchor '${k}' không được hỗ trợ.`, 400);
          }
        }
        if (typeof anc.x !== 'number' || !Number.isFinite(anc.x) || typeof anc.y !== 'number' || !Number.isFinite(anc.y)) {
          throw new StudioError('Tọa độ anchor phải là số hữu hạn.', 400);
        }
        if (anc.x < 0 || anc.x > a.w || anc.y < 0 || anc.y > a.h) {
          throw new StudioError('Điểm neo ngoài canvas.', 400);
        }
        anchor = { x: anc.x, y: anc.y };
      } else {
        anchor = a.metadata.pivot
          ? { x: a.metadata.pivot.x * a.w, y: a.metadata.pivot.y * a.h }
          : { x: a.w / 2, y: a.h };
      }
      if (generation?.options.animation) {
        throw new StudioError('Không thể dùng đồng thời animation và regionEdit.', 400);
      }

      const animConfig = {
        frameId: sourceFrame.id,
        mode: 'region' as const,
        frames: 1,
        duration: sourceFrame.duration,
        loop: true,
        anchor,
        mask: rEdit.mask as number[],
      };
      const full = store.hydrate(doc, (asset, f) => asset.id === a.id && f === sourceFrame.id).assets.find(k => k.id === a.id)!;
      const prepared = await variants.reference(doc.id, doc.revision, full, sourceFrame.id, generation!, animConfig);
      referenceVariantId = prepared.info.id;
      if (prepared.problems.length) {
        variants.discardReference(doc.id, referenceVariantId);
        referenceVariantId = undefined;
        throw new StudioError(`Mẫu chuẩn chưa khớp: ${prepared.problems.join(' ')} Dùng Chuẩn hóa mẫu thành bản sao trước.`, 422);
      }
      const { mask, ...configWithoutMask } = animConfig;
      const baseOptions = { ...generation!.options, reference: true };
      delete (baseOptions as any).animation;
      generation = {
        ...generation!,
        operation: 'region-edit',
        options: baseOptions,
        animation: { ...configWithoutMask, referenceFile: '_pxl_reference.px.js' },
        palette: generation!.options.paletteMode === 'auto16' ? prepared.palette : generation!.palette,
      };
      const entry = 'art.px.js';
      contextDoc = {
        schemaVersion: 1,
        id: doc.id,
        revision: doc.revision,
        name: doc.name,
        entry,
        files: {
          '_pxl_reference.px.js': prepared.source,
          [entry]: `include('_pxl_reference.px.js')\nanim('proposal',{w:${a.w},h:${a.h},base:'_pxl_reference',loop:true},frame({ms:${sourceFrame.duration}}))`,
        },
        pixels: {},
        metadata: {},
      };
      preview = Buffer.from(prepared.preview, 'base64');
      movementMask = prepared.maskPreview ? Buffer.from(prepared.maskPreview, 'base64') : undefined;
    } else if (generation?.options.animation) {
      const animation = generation.options.animation;
      if (!a.frames.some(f => f.id === animation.frameId)) {
        throw new StudioError('Frame mẫu không tồn tại.', 404);
      }
      const full = store.hydrate(doc, (asset, f) => asset.id === a.id && f === animation.frameId).assets.find(k => k.id === a.id)!;
      const prepared = await variants.reference(doc.id, doc.revision, full, animation.frameId, generation, animation);
      referenceVariantId = prepared.info.id;
      if ((animation.mode === 'region' || generation.options.paletteMode === 'auto16') && prepared.problems.length) {
        variants.discardReference(doc.id, referenceVariantId);
        referenceVariantId = undefined;
        throw new StudioError(`Mẫu chuẩn chưa khớp: ${prepared.problems.join(' ')} Dùng Chuẩn hóa mẫu thành bản sao trước.`, 422);
      }
      const { mask, ...config } = animation;
      const { animation: ignored, ...baseOptions } = generation.options;
      generation = {
        ...generation,
        options: { ...baseOptions, reference: true },
        animation: { ...config, referenceFile: '_pxl_reference.px.js' },
        palette: generation.options.paletteMode === 'auto16' ? prepared.palette : generation.palette,
      };
      const entry = 'art.px.js';
      contextDoc = {
        schemaVersion: 1,
        id: doc.id,
        revision: doc.revision,
        name: doc.name,
        entry,
        files: {
          '_pxl_reference.px.js': prepared.source,
          [entry]: `include('_pxl_reference.px.js')\nanim('proposal',{w:${a.w},h:${a.h},base:'_pxl_reference',loop:${animation.loop}},${Array.from({ length: animation.frames }, () => `frame({ms:${animation.duration}})`).join(',')})`,
        },
        pixels: {},
        metadata: {},
      };
      preview = Buffer.from(prepared.preview, 'base64');
      movementMask = prepared.maskPreview ? Buffer.from(prepared.maskPreview, 'base64') : undefined;
    } else if (generation) {
      const source = generation.options.reference ? a.source : undefined;
      contextDoc = {
        schemaVersion: 1,
        id: doc.id,
        revision: doc.revision,
        name: doc.name,
        files: source?.files ? structuredClone(source.files) : { 'art.px.js': `sprite('proposal',{w:${a.w},h:${a.h}})` },
        entry: source?.entry ?? 'art.px.js',
        pixels: {},
        metadata: {},
      };
      if (generation.options.reference) {
        const full = store.hydrate(doc, (asset, f) => asset.id === a.id && f === a.frames[0].id).assets.find(k => k.id === a.id)!;
        preview = Buffer.from(encodePng(composite(full, full.frames[0].id)));
      }
    } else {
      // Legacy single generation without options
      contextDoc = {
        schemaVersion: 1,
        id: doc.id,
        revision: doc.revision,
        name: doc.name,
        files: a.source?.files ? structuredClone(a.source.files) : { 'art.px.js': `sprite('proposal',{w:${a.w},h:${a.h}})` },
        entry: a.source?.entry ?? 'art.px.js',
        pixels: {},
        metadata: {},
      };
      const full = store.hydrate(doc, (asset, frame) => asset.id === a.id && frame === a.frames[0].id).assets.find(k => k.id === a.id)!;
      preview = Buffer.from(encodePng(composite(full, full.frames[0].id)));
    }

    // Snapshot up to 3 reference assets from art direction (only when explicit references exist)
    const referenceAssets: PreparedReferenceAsset[] = [];
    if (artDirection.references && artDirection.references.length > 0) {
      for (const ref of artDirection.references.slice(0, 3)) {
        const refAsset = doc.assets.find(item => item.id === ref.assetId);
        if (refAsset && refAsset.frames.some(f => f.id === ref.frameId)) {
          const hydrated = store.hydrate(doc, (item, f) => item.id === ref.assetId && f === ref.frameId).assets.find(item => item.id === ref.assetId)!;
          const png = Buffer.from(encodePng(composite(hydrated, ref.frameId)));
          referenceAssets.push({
            assetId: ref.assetId,
            frameId: ref.frameId,
            name: refAsset.name,
            w: refAsset.w,
            h: refAsset.h,
            image: png,
          });
        }
      }
    }

    // Ensure project did not change during preparation
    if (store.load(doc.id).revision !== doc.revision) {
      throw new StudioError('Dự án đã thay đổi trong khi chuẩn bị ngữ cảnh.', 409);
    }

    return {
      projectId: doc.id,
      revision: doc.revision,
      assetId: a.id,
      targetW: a.w,
      targetH: a.h,
      targetName: a.name,
      generation,
      artDirection,
      contextDoc,
      preview,
      movementMask,
      guideImage,
      referenceAssets,
      referenceVariantId,
      isLegacyWithoutOptions,
    };
  } catch (error) {
    if (referenceVariantId) {
      try {
        variants.discardReference(doc.id, referenceVariantId);
      } catch {}
    }
    throw error;
  }
}
