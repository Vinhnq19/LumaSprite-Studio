import { celFor, type PixelAsset, type PixelLayer } from '../../studio/pixel/model.ts';
import { MAX_RECIPE_PARTS } from '../../studio/quality/recipe.ts';
import { MAX_RECIPE_RENDER_PIXELS } from '../../studio/quality/renderer.ts';
import { StudioError } from './store.ts';

/** Collect only the visible image cels, in the same bottom-to-top order as composite(). */
export function staticSourceLayers(asset: PixelAsset, frameId: string, palette: readonly number[]) {
  const allowed = new Set(palette);
  const byParent = new Map<string | undefined, PixelLayer[]>();
  for (const layer of asset.layers) {
    const children = byParent.get(layer.parent);
    if (children) children.push(layer);
    else byParent.set(layer.parent, [layer]);
  }
  const result: { partId: string; name: string; pixels: Uint32Array }[] = [];
  const collect = (parent?: string, opaque = true) => {
    for (const layer of byParent.get(parent) ?? []) {
      if (!layer.visible || layer.opacity === 0) continue;
      const fullOpacity = opaque && layer.opacity === 255;
      if (layer.type === 'group') {
        collect(layer.id, fullOpacity);
        continue;
      }
      const pixels = celFor(asset, layer.id, frameId)?.data;
      if (!pixels?.some(color => (color & 255) !== 0)) continue;
      if (!fullOpacity || pixels.some(color => (color & 255) !== 0 && !allowed.has(color))) {
        throw new StudioError('Giữ layer yêu cầu lớp hiện có độ đục 100% và khớp palette đã chọn.', 422);
      }
      result.push({ partId: layer.id, name: layer.name, pixels });
    }
  };
  collect();
  if (!result.length) throw new StudioError('Chọn frame có ít nhất một layer ảnh đang hiện để giữ lớp.', 422);
  if (result.length > MAX_RECIPE_PARTS || asset.w * asset.h * (result.length * 2 + 1) > MAX_RECIPE_RENDER_PIXELS) {
    throw new StudioError('Nguồn giữ layer vượt giới hạn bộ phận hoặc bộ nhớ dựng.', 422);
  }
  return result;
}
