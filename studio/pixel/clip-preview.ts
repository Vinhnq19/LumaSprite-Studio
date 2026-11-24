import type { VariantInfo, VariantPreview } from '../../src/studio/variants.ts';

export type ClipComparisonSuccess = {
  variantId: string;
  assetId: string;
  frameId: string;
  slotId: string;
  slotNumber: number;
};

export type ClipComparisonUnavailable = {
  unavailable: string;
};

export type ClipComparisonResult = ClipComparisonSuccess | ClipComparisonUnavailable;

export function isClipPreview(preview?: VariantPreview | null): boolean {
  return !!preview?.generation?.clip;
}

export function isClipVariant(variant?: VariantInfo | null): boolean {
  return !!variant?.clip;
}

/**
 * Resolves graphical comparison target for clip variants according to the exact M2c3a contract.
 *
 * Requirements:
 * - Requires clip generation and mapping.
 * - Validate indices and use stable IDs; no implicit asset0/frame0/clamping.
 * - slotNumber is one-based canonical fullN order.
 * - Reference selects baselineAssetId then same slot ID.
 * - Master uses masterAssetId and its sole frame explicitly.
 * - Raw selects kind raw, exactly one public asset, canonical selectedSlotIds index, and that actual frame ID.
 * - FullN uses frame ID, raw uses selected-slot order.
 * - Missing counterpart/mapping yields actionable Vietnamese unavailable text.
 * - A reference master is source-only, never a slot difference target.
 */
export function resolveClipComparison(
  preview: VariantPreview,
  selectedVariant: VariantInfo,
  assetIndex: number,
  frameIndex: number,
  against: 'raw' | 'reference' | 'master' | string,
): ClipComparisonResult {
  if (!preview.generation?.clip) {
    return { unavailable: 'Đề xuất này không thuộc đợt tạo clip.' };
  }
  const mapping = selectedVariant.clip;
  if (!mapping) {
    return { unavailable: 'Thiếu thông tin ánh xạ clip trong biến thể đã chọn.' };
  }

  if (assetIndex < 0 || assetIndex >= selectedVariant.assets.length) {
    return { unavailable: `Chỉ số asset ${assetIndex} vượt quá giới hạn (${selectedVariant.assets.length}).` };
  }
  const currentAsset = selectedVariant.assets[assetIndex];
  if (!currentAsset) {
    return { unavailable: 'Không tìm thấy asset đã chọn.' };
  }
  if (frameIndex < 0 || frameIndex >= currentAsset.frames.length) {
    return { unavailable: `Chỉ số frame ${frameIndex} vượt quá giới hạn (${currentAsset.frames.length}).` };
  }
  const currentFrame = currentAsset.frames[frameIndex];
  if (!currentFrame) {
    return { unavailable: 'Không tìm thấy frame đã chọn.' };
  }

  let slotId: string;
  if (selectedVariant.kind === 'raw') {
    if (frameIndex >= mapping.selectedSlotIds.length) {
      return { unavailable: 'Frame AI gốc vượt quá danh sách slot đã chọn.' };
    }
    slotId = mapping.selectedSlotIds[frameIndex];
  } else {
    slotId = currentFrame.id;
  }

  const slotIndex = mapping.slotIds.indexOf(slotId);
  if (slotIndex === -1) {
    return { unavailable: `Slot '${slotId}' không thuộc danh sách slot của clip.` };
  }
  const slotNumber = slotIndex + 1;

  if (against === 'raw') {
    const rawVariant = preview.variants.find(v => v.kind === 'raw');
    if (!rawVariant) {
      return { unavailable: 'Không tìm thấy biến thể AI gốc.' };
    }
    if (rawVariant.assets.length !== 1) {
      return { unavailable: 'Biến thể AI gốc phải có đúng 1 asset.' };
    }
    const rawAsset = rawVariant.assets[0];
    const rawKIndex = mapping.selectedSlotIds.indexOf(slotId);
    if (rawKIndex === -1) {
      return { unavailable: `Slot ${slotNumber} được giữ nguyên từ mẫu chuẩn, không có ảnh AI gốc đối ứng.` };
    }
    if (rawKIndex >= rawAsset.frames.length) {
      return { unavailable: `Biến thể AI gốc thiếu frame cho slot ${slotNumber}.` };
    }
    const rawFrame = rawAsset.frames[rawKIndex];
    return {
      variantId: rawVariant.id,
      assetId: rawAsset.id,
      frameId: rawFrame.id,
      slotId,
      slotNumber,
    };
  }

  if (against === 'reference') {
    const refVariant = preview.reference ?? preview.variants.find(v => v.kind === 'reference');
    if (!refVariant) {
      return { unavailable: 'Không tìm thấy biến thể mẫu chuẩn.' };
    }
    if (!mapping.baselineAssetId) {
      return { unavailable: 'Thiếu cấu hình baselineAssetId trong ánh xạ clip.' };
    }
    const baselineAsset = refVariant.assets.find(a => a.id === mapping.baselineAssetId);
    if (!baselineAsset) {
      return { unavailable: `Không tìm thấy asset baseline '${mapping.baselineAssetId}' trong mẫu chuẩn.` };
    }
    const baselineFrame = baselineAsset.frames.find(f => f.id === slotId);
    if (!baselineFrame) {
      return { unavailable: `Không tìm thấy slot '${slotId}' trong asset baseline.` };
    }
    return {
      variantId: refVariant.id,
      assetId: baselineAsset.id,
      frameId: baselineFrame.id,
      slotId,
      slotNumber,
    };
  }

  if (against === 'master') {
    const refVariant = preview.reference ?? preview.variants.find(v => v.kind === 'reference');
    if (!refVariant) {
      return { unavailable: 'Không tìm thấy biến thể mẫu chuẩn.' };
    }
    if (!mapping.masterAssetId) {
      return { unavailable: 'Thiếu cấu hình masterAssetId trong ánh xạ clip.' };
    }
    const masterAsset = refVariant.assets.find(a => a.id === mapping.masterAssetId);
    if (!masterAsset) {
      return { unavailable: `Không tìm thấy asset master '${mapping.masterAssetId}' trong mẫu chuẩn.` };
    }
    if (masterAsset.frames.length !== 1) {
      return { unavailable: 'Asset master phải có đúng 1 frame.' };
    }
    const masterFrame = masterAsset.frames[0];
    return {
      variantId: refVariant.id,
      assetId: masterAsset.id,
      frameId: masterFrame.id,
      slotId,
      slotNumber,
    };
  }

  return { unavailable: `Chế độ đối chiếu '${against}' không được hỗ trợ.` };
}
