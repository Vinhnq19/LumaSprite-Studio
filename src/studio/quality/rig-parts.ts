import { celFor, collectCels, isLocked, newLayer, uid, type PixelAsset, type PixelLayer } from '../pixel/model.ts';
import { snapshot } from '../pixel/history.ts';
import { selectionBounds } from '../pixel/tools.ts';
import { dataName } from './data.ts';
import type { RigDraft } from './rig-draft.ts';

/** Cut only this cel; linked frames and the original asset keep their buffers. */
export function splitRigPart(source: PixelAsset, frameId: string, layerId: string, mask: Uint8Array, name: string): { asset: PixelAsset; layer: PixelLayer; pivot: { x: number; y: number } } {
  const layer = source.layers.find(l => l.id === layerId), cel = layer && celFor(source, layerId, frameId);
  if (!layer || layer.type !== 'image' || !cel?.data || isLocked(source, layer)) throw Error('Chọn layer ảnh đã tải và không khóa trước khi tách.');
  let ancestor: PixelLayer | undefined = layer;
  while (ancestor) { if (!ancestor.visible || ancestor.opacity !== 255) throw Error('Tách bộ phận cần layer/nhóm đang hiện, độ đục255.'); ancestor = source.layers.find(l => l.id === ancestor!.parent); }
  if (!(mask instanceof Uint8Array) || mask.length !== source.w * source.h || mask.some(v => v !== 0 && v !== 1) || !mask.some(Boolean)) throw Error('Chọn vùng pixel hợp lệ trước khi tách.');
  if (!mask.some((v, i) => !!v && !!(cel.data![i] & 255))) throw Error('Vùng chọn không có pixel trên layer này.');
  const title = dataName(name, 'Tên bộ phận'), asset = snapshot(source), target = asset.layers.find(l => l.id === layerId)!;
  const part = newLayer(title, 'image', target.parent), pixels = new Uint32Array(cel.data.length), remaining = cel.data.slice();
  mask.forEach((v, i) => { if (v) { pixels[i] = remaining[i]; remaining[i] = 0; } });
  const detached = uid(); asset.cels[detached] = { id: detached, data: remaining }; target.cels[frameId] = detached;
  asset.layers.splice(asset.layers.indexOf(target) + 1, 0, part);
  celFor(asset, part.id, frameId, true)!.data = pixels; collectCels(asset);
  const bounds = selectionBounds(mask, source.w)!;
  return { asset, layer: part, pivot: { x: bounds.x + Math.floor(bounds.w / 2), y: bounds.y + Math.floor(bounds.h / 2) } };
}

/** A new layer is an editable placeholder until the user explicitly refreshes its pixels. */
export function addRigLayer(draft: RigDraft, layer: PixelLayer, pivot: { x: number; y: number }, origin: 'visible' | 'authored' | 'derived'): RigDraft {
  if (draft.recipe.parts.some(p => p.id === layer.id)) throw Error('Layer đã có trong nháp rig.');
  const next = structuredClone(draft), root = next.rig.joints.find(j => j.parentId === null)!;
  next.recipe.parts.push({ id: layer.id, name: layer.name, parentId: null, pivot, origin, materialIds: [], paint: [] });
  next.rig.bindings.push({ partId: layer.id, jointId: root.id, socketId: null });
  next.plan.frames.forEach(f => f.order.push(layer.id)); return next;
}
