import {
  type PixelAsset,
  uid,
  wireParse,
} from '../../studio/pixel/model.ts';
import type {
  BuildSummary,
  GenerationReport,
  ProjectDocument,
} from '../../studio/types.ts';
import type {
  ClipGenerationContext,
} from '../../studio/clip-generation.ts';
import {
  getSelectedSlotIds,
  validateClipGenerationContext,
} from '../../studio/clip-generation.ts';
import type { VariantInfo } from '../../studio/variants.ts';
import { VariantStore } from './variant-store.ts';
import { StudioError } from './store.ts';
import { renderDocument, type ExportResult } from './render.ts';
import { inspectGeneration } from '../../studio/generation.ts';
import { hashContext, hashMask } from './clip-snapshot.ts';
import {
  type ClipProcessingStats,
  normalizeClipAsset,
  processClipAsset,
  validateRawReplacements,
  verifyClipAsset,
} from './clip-processing.ts';

export interface ClipCaptureRequest {
  root: string;
  context: ClipGenerationContext;
  referenceId: string;
  document?: ProjectDocument;
  rawVariantId?: string;
  revision?: number;
}

export interface ClipCaptureResult {
  raw?: VariantInfo;
  protected?: VariantInfo;
  quality: GenerationReport;
}

export interface ClipNormalizeRequest {
  root: string;
  context: ClipGenerationContext;
  referenceId: string;
  rawVariantId: string;
  alphaThreshold?: number;
  revision?: number;
}

export interface ClipNormalizeResult {
  info: VariantInfo;
  stats: ClipProcessingStats;
  quality: GenerationReport;
}

export interface ClipVerifyRequest {
  root: string;
  context: ClipGenerationContext;
  referenceId: string;
  variantId: string;
  revision?: number;
}

export interface ClipVerifyResult {
  valid: boolean;
  quality: GenerationReport;
}

function parseStrictMask(raw: number[] | undefined, expectedLength: number): Uint32Array | undefined {
  if (!raw) return undefined;
  if (raw.length !== expectedLength) {
    throw new StudioError(`Kích thước mask (${raw.length}) không khớp canvas (${expectedLength}).`, 400);
  }
  const mask = new Uint32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v !== 0 && v !== 1) {
      throw new StudioError(`Mask chứa giá trị không hợp lệ tại vị trí ${i}: ${v} (chỉ cho phép 0 hoặc 1).`, 400);
    }
    mask[i] = v;
  }
  return mask;
}

function clipMapping(context: ClipGenerationContext, reference: VariantInfo, referenceId: string) {
  return {
    clipId: context.clipId, characterId: context.characterId,
    sourceAssetId: context.sourceAssetId, sourceFrameId: context.sourceFrameId,
    projectId: context.projectId, revision: context.revision,
    slotIds: context.slots.map(slot => slot.id), selectedSlotIds: getSelectedSlotIds(context),
    baselineAssetId: reference.clip!.baselineAssetId, masterAssetId: reference.clip!.masterAssetId,
    contextDigest: reference.clip!.contextDigest, maskDigest: reference.clip!.maskDigest, referenceId,
  };
}

function checkedReference(repo: VariantStore, referenceId: string, context: ClipGenerationContext) {
  const info = repo.info(referenceId), mapping = info.clip;
  if (info.kind !== 'reference' || info.id !== referenceId || !mapping ||
      mapping.projectId !== context.projectId || mapping.clipId !== context.clipId ||
      mapping.characterId !== context.characterId || mapping.revision !== context.revision ||
      mapping.sourceAssetId !== context.sourceAssetId || mapping.sourceFrameId !== context.sourceFrameId ||
      mapping.contextDigest !== hashContext(context)) {
    throw new StudioError('Context không khớp với snapshot tham chiếu của dự án/clip.', 409);
  }
  const mask = parseStrictMask(repo.mask(referenceId), context.w * context.h);
  if (context.mode === 'region') {
    if (!mask || !mapping.maskDigest || mapping.maskDigest !== hashMask(mask)) {
      throw new StudioError('Mask vùng chuyển động đã thay đổi so với snapshot tham chiếu.', 409);
    }
  } else if (mask !== undefined || mapping.maskDigest !== undefined) {
    throw new StudioError('Snapshot toàn nhân vật (whole) không được chứa mask.', 409);
  }
  const assets = repo.assets(referenceId);
  const baseline = assets.find(asset => asset.id === mapping.baselineAssetId);
  const master = assets.find(asset => asset.id === mapping.masterAssetId);
  if (assets.length !== 2 || !baseline || !master || baseline === master || baseline.id !== context.clipId ||
      baseline.w !== context.w || baseline.h !== context.h || baseline.frames.length !== context.slots.length ||
      master.w !== context.w || master.h !== context.h || master.frames.length !== 1) {
    throw new StudioError('Baseline/master của snapshot không đúng danh tính hoặc kích thước clip.', 409);
  }
  return { info, baseline, mask };
}

function checkedCandidate(info: VariantInfo, kind: 'raw' | 'protected' | 'normalized', context: ClipGenerationContext, reference: VariantInfo, referenceId: string): void {
  const expected = clipMapping(context, reference, referenceId), mapping = info.clip;
  if (info.kind !== kind || !mapping || Object.entries(expected).some(([key, value]) =>
    JSON.stringify(mapping[key as keyof typeof mapping]) !== JSON.stringify(value))) {
    throw new StudioError('Biến thể không khớp context/snapshot tham chiếu của dự án này.', 409);
  }
}

export function clipCapture(req: ClipCaptureRequest): ClipCaptureResult {
  const context = validateClipGenerationContext(req.context);
  if (req.revision !== undefined && context.revision !== req.revision) {
    throw new StudioError('Phiên bản dự án không khớp.', 409);
  }

  const repo = new VariantStore(req.root);
  const createdVariantIds: string[] = [];

  try {
    const { info: refInfo, baseline: baselineAsset, mask } = checkedReference(repo, req.referenceId, context);

    let rawAssets: PixelAsset[] = [];
    let summary: BuildSummary | undefined;
    const errors: string[] = [];

    if (req.document) {
      try {
        summary = renderDocument({ document: req.document, mode: 'summary' }) as BuildSummary;
        if (summary.errors && summary.errors.length > 0) {
          errors.push(...summary.errors);
        }
      } catch (err) {
        errors.push((err as Error).message);
      }

      if (errors.length === 0 && summary) {
        const publicNames = summary.assets.filter(a => !a.name.startsWith('_')).map(a => a.name);
        if (publicNames.length === 0) {
          errors.push('Không có asset công khai nào được xuất từ mã nguồn.');
        } else {
          try {
            const rasterRes = renderDocument({
              document: req.document,
              mode: 'raster',
              selected: publicNames,
            }) as ExportResult;
            const parsed = wireParse(Buffer.from(rasterRes.data).toString('utf8'));
            rawAssets = Array.isArray(parsed) ? parsed : (parsed.assets ?? []);
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
      }
    } else if (req.rawVariantId) {
      checkedCandidate(repo.info(req.rawVariantId), 'raw', context, refInfo, req.referenceId);
      rawAssets = repo.assets(req.rawVariantId);
    } else {
      throw new StudioError('Thiếu tài liệu candidate hoặc rawVariantId.', 400);
    }

    if (errors.length > 0 || rawAssets.length !== 1) {
      if (rawAssets.length === 0) {
        const report: GenerationReport = {
          assets: [],
          errors: errors.length ? errors : ['Không có asset nào được xuất từ mã nguồn candidate.'],
          warnings: [],
        };
        return {
          raw: undefined,
          protected: undefined,
          quality: report,
        };
      }

      // Preserve actual rendered raw assets (e.g. multiple public assets)
      const genReport = inspectGeneration(rawAssets, {
        options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
        assetId: rawAssets[0].id,
        w: context.w,
        h: context.h,
        palette: context.palette,
      });
      if (rawAssets.length !== 1) {
        genReport.errors.push(`Cần đúng 1 asset thô (K frame), nhận ${rawAssets.length}.`);
      }
      if (errors.length > 0) {
        genReport.errors.push(...errors);
      }

      const rawInfo = repo.put(rawAssets, {
        kind: 'raw',
        label: 'AI gốc',
        canApply: false,
        quality: genReport,
        clip: clipMapping(context, refInfo, req.referenceId),
      });
      createdVariantIds.push(rawInfo.id);

      return {
        raw: rawInfo,
        protected: undefined,
        quality: genReport,
      };
    }

    const rawAsset = rawAssets[0];

    // Important K1 raster workaround: attach observed loop from summary if single frame
    if (rawAsset.frames.length === 1 && (!rawAsset.tags || rawAsset.tags.length === 0)) {
      const observed = summary?.assets.find(asset => asset.name === rawAsset.name);
      if (!observed) throw new StudioError('Thiếu thông tin loop thực tế của frame đã dựng; không thể suy đoán.', 409);
      const observedLoop = observed.loop;
      rawAsset.tags = [
        {
          id: uid(),
          name: rawAsset.name,
          from: rawAsset.frames[0].id,
          to: rawAsset.frames[0].id,
          direction: 'forward',
          loop: observedLoop,
        },
      ];
    }

    const genReport = inspectGeneration([rawAsset], {
      options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
      assetId: rawAsset.id,
      w: context.w,
      h: context.h,
      palette: context.palette,
    });

    const validationErrors: string[] = [];
    try {
      validateRawReplacements(rawAsset, baselineAsset, context, mask);
    } catch (err) {
      validationErrors.push((err as Error).message);
    }

    if (validationErrors.length > 0) {
      genReport.errors.push(...validationErrors);
      const rawInfo = repo.put([rawAsset], {
        kind: 'raw',
        label: 'AI gốc',
        canApply: false,
        quality: genReport,
        clip: clipMapping(context, refInfo, req.referenceId),
      });
      createdVariantIds.push(rawInfo.id);
      return {
        raw: rawInfo,
        protected: undefined,
        quality: genReport,
      };
    }

    const processed = processClipAsset({
      raw: rawAsset,
      baseline: baselineAsset,
      context,
      mask,
      operation: 'recompose',
    });

    if (!processed.verification.valid) {
      genReport.errors.push(...processed.verification.errors);
      const rawInfo = repo.put([rawAsset], {
        kind: 'raw',
        label: 'AI gốc',
        canApply: false,
        quality: genReport,
        clip: clipMapping(context, refInfo, req.referenceId),
      });
      createdVariantIds.push(rawInfo.id);
      return {
        raw: rawInfo,
        protected: undefined,
        quality: genReport,
      };
    }

    const rawReport = structuredClone(genReport);
    rawReport.errors = [];
    rawReport.warnings = [...rawReport.warnings, ...processed.warnings];

    const rawInfo = repo.put([rawAsset], {
      kind: 'raw',
      label: 'AI gốc',
      canApply: false,
      quality: rawReport,
      clip: clipMapping(context, refInfo, req.referenceId),
    });
    createdVariantIds.push(rawInfo.id);

    const protectedReport = inspectGeneration([processed.asset], {
      options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
      assetId: processed.asset.id,
      w: context.w,
      h: context.h,
      palette: context.palette,
    });
    protectedReport.errors = [];
    protectedReport.warnings = [...protectedReport.warnings, ...processed.warnings];

    const protectedInfo = repo.put([processed.asset], {
      kind: 'protected',
      label: 'Đã bảo vệ',
      canApply: true,
      quality: protectedReport,
      stats: [processed.stats],
      clip: clipMapping(context, refInfo, req.referenceId),
    });
    createdVariantIds.push(protectedInfo.id);

    return {
      raw: rawInfo,
      protected: protectedInfo,
      quality: protectedReport,
    };
  } catch (err) {
    for (const id of createdVariantIds) {
      try {
        repo.remove(id);
      } catch {}
    }
    throw err;
  }
}

export function clipNormalize(req: ClipNormalizeRequest): ClipNormalizeResult {
  const context = validateClipGenerationContext(req.context);
  if (req.revision !== undefined && context.revision !== req.revision) {
    throw new StudioError('Phiên bản dự án không khớp.', 409);
  }

  if (
    req.alphaThreshold === undefined ||
    typeof req.alphaThreshold !== 'number' ||
    !Number.isInteger(req.alphaThreshold) ||
    req.alphaThreshold < 1 ||
    req.alphaThreshold > 255
  ) {
    throw new StudioError('alphaThreshold phải là số nguyên từ 1 đến 255.', 400);
  }

  const repo = new VariantStore(req.root);

  const { info: refInfo, baseline: baselineAsset, mask } = checkedReference(repo, req.referenceId, context);
  checkedCandidate(repo.info(req.rawVariantId), 'raw', context, refInfo, req.referenceId);
  const rawAssets = repo.assets(req.rawVariantId);
  if (rawAssets.length !== 1) throw new StudioError('Biến thể thô phải chứa đúng 1 asset.', 400);
  const rawAsset = rawAssets[0];

  const threshold = req.alphaThreshold;

  const normResult = normalizeClipAsset({
    raw: rawAsset,
    baseline: baselineAsset,
    context,
    mask,
    threshold,
  });

  const verification = verifyClipAsset({
    asset: normResult.asset,
    baseline: baselineAsset,
    context,
    mask,
    normalized: true,
    threshold,
    throwOnError: false,
  });

  if (!verification.valid) {
    throw new StudioError(`Biến thể chuẩn hóa không đạt kiểm tra: ${verification.errors.join('; ')}`, 422);
  }

  const report = inspectGeneration([normResult.asset], {
    options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
    assetId: normResult.asset.id,
    w: context.w,
    h: context.h,
    palette: context.palette,
  });
  report.errors = verification.errors;
  report.warnings = [...report.warnings, ...normResult.warnings];

  const normInfo = repo.put([normResult.asset], {
    kind: 'normalized',
    label: `Đã chuẩn hóa · alpha ${threshold}`,
    canApply: verification.valid,
    quality: report,
    stats: [normResult.stats],
    alphaThreshold: threshold,
    clip: clipMapping(context, refInfo, req.referenceId),
  });

  return {
    info: normInfo,
    stats: normResult.stats,
    quality: report,
  };
}

export function clipVerify(req: ClipVerifyRequest): ClipVerifyResult {
  const context = validateClipGenerationContext(req.context);
  if (req.revision !== undefined && context.revision !== req.revision) {
    return {
      valid: false,
      quality: { assets: [], errors: ['Phiên bản dự án không khớp.'], warnings: [] },
    };
  }

  const repo = new VariantStore(req.root);
  let info: VariantInfo;
  let candidateAssets: PixelAsset[];
  try {
    info = repo.info(req.variantId);
    candidateAssets = repo.assets(req.variantId);
  } catch (err) {
    return {
      valid: false,
      quality: { assets: [], errors: [(err as Error).message], warnings: [] },
    };
  }

  if (info.kind === 'reference' || info.kind === 'raw') {
    return {
      valid: false,
      quality: {
        assets: [],
        errors: [`Không thể áp dụng biến thể loại '${info.kind}'. Chỉ có thể áp dụng biến thể đã bảo vệ hoặc chuẩn hóa.`],
        warnings: [],
      },
    };
  }

  if (!candidateAssets || candidateAssets.length !== 1) {
    return {
      valid: false,
      quality: { assets: [], errors: [`Cần đúng 1 asset trong biến thể, nhận ${candidateAssets?.length ?? 0}.`], warnings: [] },
    };
  }
  const candidate = candidateAssets[0];

  let baseline: PixelAsset, mask: Uint32Array | undefined;
  try {
    const reference = checkedReference(repo, req.referenceId, context);
    checkedCandidate(info, info.kind === 'normalized' ? 'normalized' : 'protected', context, reference.info, req.referenceId);
    baseline = reference.baseline; mask = reference.mask;
  } catch (error) {
    return { valid: false, quality: { assets: [], errors: [(error as Error).message], warnings: [] } };
  }

  const verification = verifyClipAsset({
    asset: candidate,
    baseline,
    context,
    mask,
    normalized: info.kind === 'normalized',
    threshold: info.alphaThreshold,
    throwOnError: false,
  });

  const report = inspectGeneration([candidate], {
    options: { style: 'game', view: 'description', paletteMode: context.paletteMode, reference: false },
    assetId: candidate.id,
    w: context.w,
    h: context.h,
    palette: context.palette,
  });
  report.errors = verification.errors;

  return {
    valid: verification.valid,
    quality: report,
  };
}
