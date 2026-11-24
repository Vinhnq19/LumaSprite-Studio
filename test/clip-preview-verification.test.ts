// Parent future acceptance; activate only after graphical clip mapping is implemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VariantInfo, VariantPreview } from '../src/studio/variants.ts';
import { createClipGenerationContext } from '../src/studio/clip-generation.ts';
import { resolveClipComparison } from '../studio/pixel/clip-preview.ts';

function fixture() {
  const asset = (id: string, frames: string[]) => ({ id, name: id, w: 4, h: 3,
    frames: frames.map((id, i) => ({ id, duration: [80, 140, 200, 100][i] })),
    tags: [], metadata: {}, palette: [0, 0xff0000ff] });
  const mapping = { clipId: 'walk', characterId: 'hero', sourceAssetId: 'source', sourceFrameId: 'source-2',
    projectId: 'project', revision: 3, slotIds: ['slot-a', 'slot-b', 'slot-c', 'slot-d'],
    selectedSlotIds: ['slot-c'], baselineAssetId: 'baseline', masterAssetId: 'master' };
  const raw: VariantInfo = { id: 'raw', kind: 'raw', label: 'AI gốc', canApply: false, clip: mapping,
    assets: [asset('proposal', ['replacement'])] };
  const full: VariantInfo = { id: 'full', kind: 'protected', label: 'Đã ghép', canApply: true, clip: mapping,
    assets: [asset('walk', mapping.slotIds)] };
  // Master first deliberately: the baseline must be found by ID, not array position.
  const reference: VariantInfo = { id: 'reference', kind: 'reference', label: 'Mẫu', canApply: false, clip: mapping,
    assets: [asset('master', ['source-2']), asset('baseline', mapping.slotIds)] };
  const context = createClipGenerationContext({ projectId: 'project', revision: 3, clipId: 'walk', characterId: 'hero',
    name: 'Walk', sourceAssetId: 'source', sourceFrameId: 'source-2', w: 4, h: 3, paletteMode: 'asset',
    palette: [0, 0xff0000ff], pivot: { x: 2, y: 3 }, mode: 'whole', loop: false,
    slots: mapping.slotIds.map((id, i) => ({ id, duration: [80, 140, 200, 100][i], selected: i === 2,
      frozen: i === 0, keyframe: i === 1 })) });
  const preview: VariantPreview = { proposalId: 'p', variants: [full, raw], selectedVariantId: full.id, reference,
    generation: { operation: 'clip-regenerate', assetId: 'source', w: 4, h: 3, palette: context.palette,
      options: { style: 'game', view: 'side', paletteMode: 'asset', reference: true },
      clip: { context, helperFiles: [], facing: 'source', template: 'walk', guideMetadata: { w: 16, h: 3, cols: 4, rows: 1,
        slots: context.slots.map((s, order) => ({ ...s, order, isEditedPose: false })) } } } };
  return { preview, raw, full, reference };
}

test('Clip graphical comparison maps fullN selected slot3 to rawK first frame even when raw is not variants[0]', () => {
  const { preview, full } = fixture();
  assert.deepEqual(resolveClipComparison(preview, full, 0, 2, 'raw'), {
    variantId: 'raw', assetId: 'proposal', frameId: 'replacement', slotId: 'slot-c', slotNumber: 3,
  });
});
test('Clip graphical comparison refuses a raw counterpart for retained and out-of-range frames', () => {
  const { preview, full } = fixture();
  for (const index of [0, 1, 3, 4, -1]) {
    const result = resolveClipComparison(preview, full, 0, index, 'raw');
    assert.ok('unavailable' in result && result.unavailable.length > 0);
    assert.equal('frameId' in result, false);
  }
});
test('Clip graphical comparison finds actual baseline asset and stable slot, also from rawK', () => {
  const { preview, full, raw } = fixture();
  assert.deepEqual(resolveClipComparison(preview, full, 0, 3, 'reference'), {
    variantId: 'reference', assetId: 'baseline', frameId: 'slot-d', slotId: 'slot-d', slotNumber: 4,
  });
  assert.deepEqual(resolveClipComparison(preview, raw, 0, 0, 'reference'), {
    variantId: 'reference', assetId: 'baseline', frameId: 'slot-c', slotId: 'slot-c', slotNumber: 3,
  });
});
test('Clip graphical comparison follows frame ID after fullN frame reorder and supports explicit master', () => {
  const { preview, full } = fixture(); full.assets[0].frames.reverse();
  assert.deepEqual(resolveClipComparison(preview, full, 0, 1, 'raw'), {
    variantId: 'raw', assetId: 'proposal', frameId: 'replacement', slotId: 'slot-c', slotNumber: 3,
  });
  assert.deepEqual(resolveClipComparison(preview, full, 0, 1, 'master'), {
    variantId: 'reference', assetId: 'master', frameId: 'source-2', slotId: 'slot-c', slotNumber: 3,
  });
});
test('Clip graphical comparison never falls back to another asset/frame when a mapping is incomplete', () => {
  for (const mutate of [
    (p: VariantPreview) => { p.reference!.assets.pop(); },
    (p: VariantPreview) => { p.reference!.assets[1].frames.splice(2, 1); },
    (p: VariantPreview) => { p.variants[0].clip = undefined; },
  ]) {
    const { preview, full } = fixture(); mutate(preview);
    const result = resolveClipComparison(preview, full, 0, 2, 'reference');
    assert.ok('unavailable' in result && result.unavailable.length > 0);
  }
  const { preview, full } = fixture();
  assert.ok('unavailable' in resolveClipComparison(preview, full, 4, 0, 'reference'));
});

test('Clip graphical master comparison requires one unambiguous source frame', () => {
  const { preview, full, reference } = fixture();
  reference.assets[0].frames.push({ id: 'unexpected-master-2', duration: 100 });
  assert.ok('unavailable' in resolveClipComparison(preview, full, 0, 2, 'master'));
});
