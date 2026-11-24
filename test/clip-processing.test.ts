import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClipGenerationContext,
  validateClipGenerationContext,
  getSelectedSlots,
  getSelectedSlotIds,
  type ClipGenerationContext,
} from '../src/studio/clip-generation.ts';
import {
  recomposeClipAsset,
  normalizeClipAsset,
  verifyClipAsset,
  processClipAsset,
  rebuildClipSource,
  extractAssetPalette,
} from '../src/node/studio/clip-processing.ts';
import {
  celFor,
  composite,
  newAsset,
  newDocument,
  wireParse,
  wireStringify,
  type PixelAsset,
} from '../src/studio/pixel/model.ts';
import {
  imageSource,
  estimateImageSourceLength,
} from '../src/studio/pixel/processing.ts';
import { renderDocument, type ExportResult } from '../src/node/studio/render.ts';

function createTestAsset(
  name: string,
  w: number,
  h: number,
  slotIds: string[],
  durations: number[],
  images: Uint32Array[],
  loop = false
): PixelAsset {
  const asset = newAsset(name, w, h);
  asset.palette = [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff, 0x000000ff, 0];
  asset.frames = slotIds.map((id, i) => ({ id, duration: durations[i] }));
  slotIds.forEach((id, i) => {
    celFor(asset, asset.layers[0].id, id, true)!.data = images[i].slice();
  });
  asset.tags = [
    {
      id: 'tag-1',
      name,
      from: slotIds[0],
      to: slotIds[slotIds.length - 1],
      direction: 'forward',
      loop,
    },
  ];
  return asset;
}

test('Clip generation context: schema contracts, validation, budget and clone immutability', () => {
  const contextInput = {
    projectId: 'proj-1',
    revision: 1,
    clipId: 'clip-walk',
    characterId: 'char-hero',
    name: 'Bước đi anh hùng',
    sourceAssetId: 'asset-base',
    sourceFrameId: 'frame-base',
    w: 8,
    h: 8,
    palette: [0xff0000ff, 0x00ff00ff, 0xffffffff, 0],
    pivot: { x: 4, y: 8 },
    mode: 'region' as const,
    loop: true,
    landmarks: {
      head: { name: 'Đầu', x: 4, y: 1 },
      hand: { name: 'Tay', x: 2, y: 4, partId: 'arm' },
    },
    links: [{ from: 'head', to: 'hand' }],
    parts: {
      arm: { name: 'Cánh tay' },
    },
    sourceMetadata: {
      pivot: { x: 0.5, y: 1 },
      hitbox: { x: 1, y: 1, w: 6, h: 7 },
      events: [{ frame: 0, name: 'chạm đất' }],
    },
    slots: [
      { id: 's0', duration: 100, selected: false, frozen: true, keyframe: true, pose: { head: { x: 4, y: 1 } } as Record<string, { x: number; y: number }> },
      { id: 's1', duration: 120, selected: true, frozen: false, keyframe: false, pose: { hand: { x: 3, y: 4 } } as Record<string, { x: number; y: number }> },
      { id: 's2', duration: 140, selected: true, frozen: false, keyframe: false, pose: {} },
    ],
  };

  const context = createClipGenerationContext(contextInput);
  assert.equal(context.version, 1);
  assert.equal(context.clipId, 'clip-walk');
  assert.equal(context.w, 8);
  assert.equal(context.h, 8);
  assert.deepEqual(getSelectedSlotIds(context), ['s1', 's2']);
  assert.equal(getSelectedSlots(context).length, 2);

  // Rejection checks
  assert.throws(() => createClipGenerationContext({ ...contextInput, w: 4097 } as any));
  assert.throws(() => createClipGenerationContext({ ...contextInput, slots: [{ id: 's0', duration: 100, selected: true, frozen: false, keyframe: false }] } as any));
  assert.throws(() => createClipGenerationContext({ ...contextInput, slots: new Array(25).fill(contextInput.slots[0]) } as any));
  assert.throws(() => createClipGenerationContext({ ...contextInput, palette: [0] } as any));
  assert.throws(() => createClipGenerationContext({ ...contextInput, palette: [0xffffffff, 0x12345600] } as any));
  assert.throws(() => createClipGenerationContext({ ...contextInput, palette: [0xffffff7f] } as any));
  assert.throws(() => createClipGenerationContext({ ...contextInput, pivot: { x: 10, y: 4 } } as any));
});

test('Clip recomposition: N4/K1 mixed timing, non-first selected slot and exact baseline preservation', () => {
  const w = 4, h = 4;
  const slotIds = ['slot_0', 'slot_1', 'slot_2', 'slot_3'];
  const durations = [80, 140, 200, 100];
  const images = slotIds.map((_, i) => new Uint32Array(w * h).fill((0x10101000 * (i + 1) + 0xff) >>> 0));

  const baseline = createTestAsset('Baseline', w, h, slotIds, durations, images, true);
  baseline.metadata = { pivot: { x: 0.5, y: 1 }, hitbox: { x: 0, y: 0, w: 4, h: 4 } };

  const rawPixels = new Uint32Array(w * h).fill(0xffffffff);
  const raw = createTestAsset('Raw', w, h, ['raw_0'], [200], [rawPixels], true);

  const mask = new Uint32Array(w * h);
  mask[0] = mask[1] = 1;

  const context = createClipGenerationContext({
    projectId: 'p1',
    revision: 1,
    clipId: 'c1',
    characterId: 'char1',
    name: 'Hoạt ảnh K1',
    sourceAssetId: 'a1',
    sourceFrameId: 'f1',
    w,
    h,
    palette: [0xffffffff, 0x101010ff, 0x202020ff, 0x303030ff, 0x404040ff, 0],
    pivot: { x: 2, y: 4 },
    mode: 'region',
    loop: true,
    slots: [
      { id: 'slot_0', duration: 80, selected: false, frozen: true, keyframe: true },
      { id: 'slot_1', duration: 140, selected: false, frozen: false, keyframe: false },
      { id: 'slot_2', duration: 200, selected: true, frozen: false, keyframe: false },
      { id: 'slot_3', duration: 100, selected: false, frozen: false, keyframe: false },
    ],
  });

  const beforeRaw = wireStringify(raw);
  const beforeBaseline = wireStringify(baseline);

  const result = recomposeClipAsset({ raw, baseline, context, mask });
  const output = result.asset;

  // Verify frames
  const f0 = composite(output, 'slot_0').data;
  const f1 = composite(output, 'slot_1').data;
  const f2 = composite(output, 'slot_2').data;
  const f3 = composite(output, 'slot_3').data;

  assert.deepEqual(f0, images[0]);
  assert.deepEqual(f1, images[1]);
  assert.deepEqual(f3, images[3]);

  // Frame 2: inside mask is white, outside mask is baseline frame 2
  assert.equal(f2[0], 0xffffffff);
  assert.equal(f2[1], 0xffffffff);
  assert.equal(f2[2], images[2][2]);
  assert.equal(f2[15], images[2][15]);

  assert.equal(wireStringify(raw), beforeRaw);
  assert.equal(wireStringify(baseline), beforeBaseline);

  const verified = verifyClipAsset({ asset: output, baseline, context, mask });
  assert.equal(verified.valid, true);
});

test('Clip recomposition: N4/K2 reordered canonical IDs and variable timing', () => {
  const w = 4, h = 4;
  const slotIds = ['d_last', 'b_mid', 'a_first', 'c_third'];
  const durations = [100, 200, 150, 80];
  const images = slotIds.map((_, i) => new Uint32Array(w * h).fill((0x20202000 * (i + 1) + 0xff) >>> 0));

  const baseline = createTestAsset('Baseline', w, h, slotIds, durations, images, false);

  // K = 2 selected: 'b_mid' (duration 200) and 'c_third' (duration 80)
  const rawColor1 = 0xff0000ff;
  const rawColor2 = 0x00ff00ff;
  const raw1 = new Uint32Array(w * h).fill(rawColor1);
  const raw2 = new Uint32Array(w * h).fill(rawColor2);
  const raw = createTestAsset('RawK2', w, h, ['r1', 'r2'], [200, 80], [raw1, raw2], false);

  const context = createClipGenerationContext({
    projectId: 'p2',
    revision: 1,
    clipId: 'c2',
    characterId: 'char2',
    name: 'Hoạt ảnh K2',
    sourceAssetId: 'a2',
    sourceFrameId: 'f2',
    w,
    h,
    palette: [rawColor1, rawColor2, 0xffffffff, 0],
    pivot: { x: 2, y: 4 },
    mode: 'whole',
    loop: false,
    slots: [
      { id: 'd_last', duration: 100, selected: false, frozen: true, keyframe: false },
      { id: 'b_mid', duration: 200, selected: true, frozen: false, keyframe: false },
      { id: 'a_first', duration: 150, selected: false, frozen: false, keyframe: false },
      { id: 'c_third', duration: 80, selected: true, frozen: false, keyframe: false },
    ],
  });

  const res = recomposeClipAsset({ raw, baseline, context });
  assert.equal(res.asset.frames.length, 4);
  assert.deepEqual(res.asset.frames.map(f => f.id), slotIds);
  assert.deepEqual(res.asset.frames.map(f => f.duration), durations);

  const compD = composite(res.asset, 'd_last').data;
  const compB = composite(res.asset, 'b_mid').data;
  const compA = composite(res.asset, 'a_first').data;
  const compC = composite(res.asset, 'c_third').data;

  assert.deepEqual(compD, images[0]);
  assert.deepEqual(compA, images[2]);
  assert.deepEqual(compB, raw1);
  assert.deepEqual(compC, raw2);

  const verified = verifyClipAsset({ asset: res.asset, baseline, context });
  assert.equal(verified.valid, true);
});

test('Clip normalization: shared palette mapping, alpha thresholds and locked colors rejection', () => {
  const w = 2, h = 2;
  const slotIds = ['s0', 's1'];
  const durations = [100, 100];
  const b0 = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
  const b1 = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);

  const baseline = createTestAsset('Base', w, h, slotIds, durations, [b0, b1], true);

  // Raw replacement with semi-transparent pixels
  const r1 = new Uint32Array([0xffffff7f, 0xffffff80, 0x111111ff, 0]);
  const raw = createTestAsset('Raw', w, h, ['r1'], [100], [r1], true);

  const context = createClipGenerationContext({
    projectId: 'p3',
    revision: 1,
    clipId: 'c3',
    characterId: 'char3',
    name: 'Chuẩn hóa',
    sourceAssetId: 'a3',
    sourceFrameId: 'f3',
    w,
    h,
    palette: [0xffffffff, 0x000000ff, 0],
    pivot: { x: 1, y: 2 },
    mode: 'whole',
    loop: true,
    slots: [
      { id: 's0', duration: 100, selected: false, frozen: true, keyframe: true },
      { id: 's1', duration: 100, selected: true, frozen: false, keyframe: false },
    ],
  });

  const norm = normalizeClipAsset({ raw, baseline, context, threshold: 128 });
  const f1 = composite(norm.asset, 's1').data;
  assert.equal(f1[0], 0); // alpha 127 < 128 => 0
  assert.equal(f1[1], 0xffffffff); // alpha 128 >= 128 => closest opaque (0xffffffff)
  assert.equal(f1[2], 0x000000ff); // 0x111111ff => nearest opaque 0x000000ff
  assert.equal(f1[3], 0); // 0 => 0

  // Locked color outside palette throws
  const badBaseline = structuredClone(baseline);
  celFor(badBaseline, badBaseline.layers[0].id, 's0')!.data![0] = 0x123456ff;
  assert.throws(
    () => normalizeClipAsset({ raw, baseline: badBaseline, context, threshold: 128 }),
    /normalize|chuẩn hóa/i
  );
});

test('Clip verification: tampering frozen pixel, timing, pivot, slot ID or source fails', () => {
  const w = 2, h = 2;
  const slotIds = ['s0', 's1'];
  const durations = [100, 100];
  const b0 = new Uint32Array([0xffffffff, 0, 0, 0]);
  const b1 = new Uint32Array([0, 0xffffffff, 0, 0]);
  const baseline = createTestAsset('Base', w, h, slotIds, durations, [b0, b1], true);
  const raw = createTestAsset('Raw', w, h, ['r1'], [100], [new Uint32Array(4).fill(0xffffffff)], true);

  const context = createClipGenerationContext({
    projectId: 'p4',
    revision: 1,
    clipId: 'c4',
    characterId: 'char4',
    name: 'Tamper',
    sourceAssetId: 'a4',
    sourceFrameId: 'f4',
    w,
    h,
    palette: [0xffffffff, 0],
    pivot: { x: 1, y: 2 },
    mode: 'whole',
    loop: true,
    slots: [
      { id: 's0', duration: 100, selected: false, frozen: true, keyframe: true },
      { id: 's1', duration: 100, selected: true, frozen: false, keyframe: false },
    ],
  });

  const recomposed = recomposeClipAsset({ raw, baseline, context }).asset;

  // Tamper frozen pixel
  const t1 = structuredClone(recomposed);
  celFor(t1, t1.layers[0].id, 's0')!.data![0] = 0;
  assert.equal(verifyClipAsset({ asset: t1, baseline, context, throwOnError: false }).valid, false);

  // Tamper duration
  const t2 = structuredClone(recomposed);
  t2.frames[0].duration = 99;
  assert.equal(verifyClipAsset({ asset: t2, baseline, context, throwOnError: false }).valid, false);

  // Tamper pivot
  const t3 = structuredClone(recomposed);
  t3.metadata.pivot = { x: 0.9, y: 0.9 };
  assert.equal(verifyClipAsset({ asset: t3, baseline, context, throwOnError: false }).valid, false);

  // Tamper source
  const t4 = structuredClone(recomposed);
  t4.source!.files['art.px.js'] = "sprite('fake',{w:2,h:2},rect(0,0,1,1,'#00000000'))\n";
  assert.equal(verifyClipAsset({ asset: t4, baseline, context, throwOnError: false }).valid, false);
});

test('Clip source: roundtrip through actual renderDocument produces exact RGBA, timing and loop', () => {
  const w = 4, h = 3;
  const slotIds = ['s0', 's1'];
  const durations = [120, 160];
  const b0 = new Uint32Array(w * h); b0[0] = 0xff0000ff; b0[5] = 0x00ff00ff;
  const b1 = new Uint32Array(w * h); b1[2] = 0x0000ffff; b1[7] = 0xffffffff;

  const baseline = createTestAsset('SourceRoundtrip', w, h, slotIds, durations, [b0, b1], false);
  const rawPixels = new Uint32Array(w * h); rawPixels[1] = 0xffffffff;
  const raw = createTestAsset('Raw', w, h, ['r1'], [160], [rawPixels], false);

  const context = createClipGenerationContext({
    projectId: 'p5',
    revision: 1,
    clipId: 'c5',
    characterId: 'char5',
    name: 'RoundtripClip',
    sourceAssetId: 'a5',
    sourceFrameId: 'f5',
    w,
    h,
    palette: [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff, 0],
    pivot: { x: 2, y: 3 },
    mode: 'whole',
    loop: false,
    slots: [
      { id: 's0', duration: 120, selected: false, frozen: true, keyframe: true },
      { id: 's1', duration: 160, selected: true, frozen: false, keyframe: false },
    ],
  });

  const res = recomposeClipAsset({ raw, baseline, context });
  const rendered = renderDocument({
    mode: 'raster',
    document: {
      schemaVersion: 1,
      id: 'doc-rt',
      name: 'Doc RT',
      revision: 1,
      entry: res.asset.source!.entry,
      files: res.asset.source!.files,
      pixels: {},
      metadata: { [res.asset.name]: res.asset.metadata },
    },
  }) as ExportResult;

  const parsedList = wireParse(Buffer.from(rendered.data).toString('utf8')) as PixelAsset[];
  const parsed = parsedList[0];
  assert.deepEqual(composite(parsed, parsed.frames[0].id).data, composite(res.asset, 's0').data);
  assert.deepEqual(composite(parsed, parsed.frames[1].id).data, composite(res.asset, 's1').data);
  assert.deepEqual(parsed.frames.map((f: { duration: number }) => f.duration), durations);
  assert.equal(parsed.tags[0].loop, false);
});
