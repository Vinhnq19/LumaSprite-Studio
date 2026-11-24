import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StudioError } from './store.ts';
import type { VariantStore } from './variant-store.ts';
import type { VariantInfo } from '../../studio/variants.ts';
import type { ClipGenerationContext } from '../../studio/clip-generation.ts';
import { hashContext } from './clip-snapshot.ts';
import { uid, type PixelAsset } from '../../studio/pixel/model.ts';

export interface ClipDifferenceTarget {
  variantId: string;
  assetId: string;
  frameId: string;
}

export function validateClipReference(
  owned: Set<string> | undefined,
  repo: VariantStore,
  referenceId: string,
  context: ClipGenerationContext,
  projectId: string
): VariantInfo {
  if (!owned?.has(referenceId) || !existsSync(join(repo.store.dir(referenceId), 'variant.json'))) {
    throw new StudioError('Mẫu tham chiếu không thuộc dự án hoặc đã bị giải phóng.', 403);
  }
  const info = repo.info(referenceId);
  if (!info.clip) {
    throw new StudioError('Mẫu tham chiếu không chứa thông tin clip.', 400);
  }
  if (info.clip.projectId && info.clip.projectId !== projectId) {
    throw new StudioError('Mẫu tham chiếu không thuộc dự án.', 403);
  }
  if (info.clip.contextDigest !== hashContext(context)) {
    throw new StudioError('Mẫu tham chiếu không khớp với ngữ cảnh clip.', 409);
  }
  return info;
}

export function resolveClipDifferenceComparison(params: {
  info: VariantInfo;
  reference?: VariantInfo;
  variants: VariantInfo[];
  assetId: string;
  frameId: string;
  against: string;
}): ClipDifferenceTarget {
  const clipMap = params.info.clip ?? params.reference?.clip;
  if (!clipMap) {
    throw new StudioError('Thiếu dữ liệu clip mapping để so sánh.', 400);
  }

  // Master asset check
  if (clipMap.masterAssetId) {
    if (params.assetId === clipMap.masterAssetId || params.against === 'master') {
      throw new StudioError('Không hỗ trợ so sánh khác biệt với ảnh master.', 400);
    }
  }

  // Resolve target variant
  let targetVariant: VariantInfo | undefined;
  if (params.against === 'reference') {
    targetVariant = params.reference;
    if (!targetVariant) {
      throw new StudioError('Mẫu tham chiếu không tồn tại.', 404);
    }
  } else if (params.against === 'raw') {
    targetVariant = params.variants.find(v => v.kind === 'raw') ?? params.variants[0];
    if (!targetVariant) {
      throw new StudioError('Không tìm thấy biến thể AI gốc để so sánh.', 404);
    }
  } else {
    targetVariant = params.variants.find(v => v.id === params.against) ?? params.variants.find(v => v.kind === params.against);
    if (!targetVariant) {
      throw new StudioError(`Biến thể so sánh "${params.against}" không tồn tại.`, 404);
    }
  }

  if (clipMap.masterAssetId && targetVariant.id === clipMap.masterAssetId) {
    throw new StudioError('Không hỗ trợ so sánh khác biệt với ảnh master.', 400);
  }

  if (targetVariant.kind === 'reference') {
    const baselineAssetId = clipMap.baselineAssetId;
    if (!baselineAssetId) {
      throw new StudioError('Thiếu baselineAssetId trong clip mapping.', 400);
    }
    const targetAsset = targetVariant.assets.find(a => a.id === baselineAssetId);
    if (!targetAsset) {
      throw new StudioError(`Không tìm thấy baseline asset "${baselineAssetId}" trong mẫu tham chiếu.`, 400);
    }

    if (params.info.kind === 'raw') {
      const currentAsset = params.info.assets.find(a => a.id === params.assetId);
      if (!currentAsset) throw new StudioError(`Asset "${params.assetId}" không tồn tại trong biến thể.`, 404);
      const kIndex = currentAsset.frames.findIndex(f => f.id === params.frameId);
      if (kIndex === -1) throw new StudioError('Frame raw không tồn tại.', 404);
      const slotId = clipMap.selectedSlotIds[kIndex];
      if (!slotId) throw new StudioError('Không xác định được slot của frame raw.', 400);
      const targetFrame = targetAsset.frames.find(f => f.id === slotId);
      if (!targetFrame) throw new StudioError('Không tìm thấy slot tương ứng trong baseline.', 400);
      return { variantId: targetVariant.id, assetId: targetAsset.id, frameId: targetFrame.id };
    } else {
      const targetFrame = targetAsset.frames.find(f => f.id === params.frameId);
      if (!targetFrame) throw new StudioError('Không tìm thấy slot tương ứng trong baseline.', 400);
      return { variantId: targetVariant.id, assetId: targetAsset.id, frameId: targetFrame.id };
    }
  }

  if (targetVariant.kind === 'raw') {
    const targetAsset = targetVariant.assets[0];
    if (!targetAsset) throw new StudioError('Biến thể raw không có asset.', 400);

    if (params.info.kind === 'raw') {
      return { variantId: targetVariant.id, assetId: targetAsset.id, frameId: params.frameId };
    } else {
      const selectedIndex = clipMap.selectedSlotIds.indexOf(params.frameId);
      if (selectedIndex === -1) {
        throw new StudioError('Slot không được chọn trong lượt tạo; không có ảnh AI thô để so sánh.', 400);
      }
      const targetFrame = targetAsset.frames[selectedIndex];
      if (!targetFrame) throw new StudioError('Không tìm thấy frame raw tương ứng.', 400);
      return { variantId: targetVariant.id, assetId: targetAsset.id, frameId: targetFrame.id };
    }
  }

  // targetVariant is protected or normalized (full N)
  const targetAsset = targetVariant.assets[0];
  if (!targetAsset) throw new StudioError('Biến thể không có asset.', 400);

  if (params.info.kind === 'raw') {
    const currentAsset = params.info.assets.find(a => a.id === params.assetId);
    if (!currentAsset) throw new StudioError(`Asset "${params.assetId}" không tồn tại trong biến thể.`, 404);
    const kIndex = currentAsset.frames.findIndex(f => f.id === params.frameId);
    if (kIndex === -1) throw new StudioError('Frame raw không tồn tại.', 404);
    const slotId = clipMap.selectedSlotIds[kIndex];
    if (!slotId) throw new StudioError('Không xác định được slot của frame raw.', 400);
    const targetFrame = targetAsset.frames.find(f => f.id === slotId);
    if (!targetFrame) throw new StudioError('Không tìm thấy slot tương ứng.', 400);
    return { variantId: targetVariant.id, assetId: targetAsset.id, frameId: targetFrame.id };
  } else {
    const targetFrame = targetAsset.frames.find(f => f.id === params.frameId);
    if (!targetFrame) throw new StudioError('Không tìm thấy slot tương ứng.', 400);
    return { variantId: targetVariant.id, assetId: targetAsset.id, frameId: targetFrame.id };
  }
}

export function cloneForClipApply(assets: PixelAsset[]): PixelAsset[] {
  return assets.map(asset => {
    const cloned = structuredClone(asset);
    cloned.id = uid();
    return cloned;
  });
}
