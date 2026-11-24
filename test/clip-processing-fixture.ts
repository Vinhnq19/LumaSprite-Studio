// Independent inputs/expected arrays for worker-ready clip processing verification.
import { newDocument, newAsset, celFor, type PixelAsset } from '../src/studio/pixel/model.ts';
import { ensureCharacterExtension, createCharacterProfile, approveCharacterProfile, addCharacterPart,
  addCharacterLandmark, addCharacterLink } from '../src/studio/character-commands.ts';
import { ensureClipExtension, createClip, applySlotBaseline, setSlotDuration, setSlotSelection,
  setSlotFrozen, setSlotKeyframe } from '../src/studio/clip-commands.ts';

export const clipTestPalette = [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff, 0x000000ff, 0];
export function clipProcessingFixture(mode: 'region' | 'whole' = 'region') {
  const w = 4, h = 3, document = newDocument('Clip kiểm chứng', w, h), a = document.assets[0];
  a.name = 'Mẫu chuẩn'; a.palette = [...clipTestPalette];
  a.metadata = { pivot: { x: 0.5, y: 1 }, hitbox: { x: 0, y: 1, w: 4, h: 2 }, events: [{ frame: 0, name: 'bắt đầu' }] };
  const sourcePixels = celFor(a, a.layers[0].id, a.frames[0].id, true)!.data!;
  sourcePixels[0] = 0xff0000ff; sourcePixels[3] = 0x0000ffff; sourcePixels[6] = 0x00ff00ff;
  ensureCharacterExtension(document);
  const character = createCharacterProfile(document, { id: 'hero', name: 'Nhân vật', assetId: a.id, frameId: a.frames[0].id });
  const mask = new Uint32Array(w * h); mask[1] = mask[5] = 1;
  addCharacterPart(document, character.id, 'arm', { name: 'Tay áo', selection: mask });
  addCharacterLandmark(document, character.id, 'head', { name: 'Đầu', x: 1, y: 0 });
  addCharacterLandmark(document, character.id, 'hand', { name: 'Tay', x: 3, y: 1, partId: 'arm' });
  addCharacterLink(document, character.id, 'head', 'hand');
  approveCharacterProfile(document, character.id);
  ensureClipExtension(document);
  const clip = createClip(document, { id: 'walk', name: 'Bước đi tiếng Việt', characterId: character.id,
    template: 'walk', mode, loop: false, slotCount: 4,
    ...(mode === 'region' ? { movementMaskSelection: mask } : {}),
  });
  const images = Array.from({ length: 4 }, (_, index) => {
    const pixels = new Uint32Array(w * h);
    pixels[index] = 0xff0000ff; pixels[index + 3] = 0x0000ffff; pixels[index + 6] = 0x00ff00ff;
    return pixels;
  });
  const durations = [80, 140, 200, 100];
  clip.slots.forEach((slot, i) => {
    applySlotBaseline(document, clip.id, slot.id, images[i]);
    setSlotDuration(document, clip.id, slot.id, durations[i]);
    setSlotSelection(document, clip.id, slot.id, i === 2);
  });
  setSlotFrozen(document, clip.id, clip.slots[0].id, true);
  setSlotKeyframe(document, clip.id, clip.slots[1].id, true);
  const baseline = flatPixelAsset('Khung gốc', w, h, clip.slots.map(s => s.id), durations, images, false);
  baseline.metadata = structuredClone(a.metadata);
  const rawPixels = new Uint32Array(w * h).fill(0xffffffff);
  const raw = flatPixelAsset('AI một frame', w, h, ['raw-untrusted-frame'], [200], [rawPixels], false);
  return { document, source: a, character, clip, w, h, images, durations, mask, baseline, raw, rawPixels };
}

export function flatPixelAsset(name: string, w: number, h: number, ids: string[], durations: number[], images: Uint32Array[], loop: boolean): PixelAsset {
  const asset = newAsset(name, w, h);
  asset.palette = [...clipTestPalette];
  asset.frames = ids.map((id, i) => ({ id, duration: durations[i] }));
  ids.forEach((id, i) => { celFor(asset, asset.layers[0].id, id, true)!.data = images[i].slice(); });
  asset.tags = [{ id: 'test-playback', name: 'Phát clip', from: ids[0], to: ids.at(-1)!, direction: 'forward', loop }];
  return asset;
}
