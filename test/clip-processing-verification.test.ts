// Independent acceptance probes. No provider calls, user projects or persistent images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { clipProcessingFixture } from './clip-processing-fixture.ts';
import { createClipGenerationContext, validateClipGenerationContext, type ClipGenerationContext } from '../src/studio/clip-generation.ts';
import { recomposeClipAsset, normalizeClipAsset, verifyClipAsset, rebuildClipSource } from '../src/node/studio/clip-processing.ts';
import { celFor, composite, wireParse, wireStringify, type PixelAsset } from '../src/studio/pixel/model.ts';
import { imageSource, estimateImageSourceLength } from '../src/studio/pixel/processing.ts';
import { renderDocument, type ExportResult } from '../src/node/studio/render.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';

function fixture(mode: 'region' | 'whole' = 'region') {
  const f = clipProcessingFixture(mode), c = f.character;
  const context = createClipGenerationContext({
    projectId: f.document.id, revision: f.document.revision, clipId: f.clip.id, characterId: c.id,
    name: f.clip.name, sourceAssetId: f.source.id, sourceFrameId: f.source.frames[0].id,
    w: f.w, h: f.h, palette: [...f.source.palette], pivot: { ...c.source.pivot }, mode, loop: false,
    landmarks: structuredClone(c.landmarks), links: structuredClone(c.links),
    parts: Object.fromEntries(Object.entries(c.parts).map(([id, part]) => [id, { name: part.name }])),
    sourceMetadata: structuredClone(f.source.metadata),
    slots: f.clip.slots.map(({ id, duration, selected, frozen, keyframe, pose }) => ({ id, duration, selected, frozen, keyframe, pose: structuredClone(pose) })),
  });
  return { ...f, context, options: { raw: f.raw, baseline: f.baseline, context, ...(mode === 'region' ? { mask: f.mask } : {}) } };
}
function frames(asset: PixelAsset) { return asset.frames.map(f => composite(asset, f.id).data); }
function accepted(options: Parameters<typeof verifyClipAsset>[0]) {
  try { return verifyClipAsset({ ...options, throwOnError: false }).valid; } catch { return false; }
}
function roundtrip(asset: PixelAsset) {
  const result = renderDocument({ mode: 'raster', document: {
    schemaVersion: 1, id: 'roundtrip', name: 'Kiểm chứng mã', revision: 1,
    entry: asset.source!.entry, files: asset.source!.files, pixels: {}, metadata: { [asset.name]: asset.metadata },
  } }) as ExportResult;
  return (wireParse(Buffer.from(result.data).toString('utf8')) as PixelAsset[])[0];
}
function unzip(data: Uint8Array) {
  const bytes = Buffer.from(data), files: Record<string, Buffer> = {};
  for (let o = 0; o + 30 <= bytes.length && bytes.readUInt32LE(o) === 0x04034b50;) {
    assert.equal(bytes.readUInt16LE(o + 8), 0, 'test decoder expects stored ZIP entries');
    const length = bytes.readUInt32LE(o + 18), names = bytes.readUInt16LE(o + 26), extra = bytes.readUInt16LE(o + 28), start = o + 30 + names + extra;
    files[bytes.toString('utf8', o + 30, o + 30 + names)] = bytes.subarray(start, start + length); o = start + length;
  }
  return files;
}
function decodePng(data: Uint8Array) {
  const b = Buffer.from(data); let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let o = 8; o + 12 <= b.length;) {
    const length = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), value = b.subarray(o + 8, o + 8 + length);
    if (type === 'IHDR') { w = value.readUInt32BE(0); h = value.readUInt32BE(4); mode = value[9]; }
    if (type === 'PLTE') palette = Buffer.from(value);
    if (type === 'tRNS') alpha = Buffer.from(value);
    if (type === 'IDAT') chunks.push(value);
    o += length + 12;
  }
  assert.ok(mode === 3 || mode === 6);
  const raw = inflateSync(Buffer.concat(chunks)), pixels = new Uint32Array(w * h), stride = w * (mode === 3 ? 1 : 4) + 1;
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * stride], 0);
    for (let x = 0; x < w; x++) {
      const offset = y * stride + 1 + x * (mode === 3 ? 1 : 4), index = raw[offset];
      pixels[y * w + x] = mode === 3 ? ((palette[index * 3] << 24) | (palette[index * 3 + 1] << 16) | (palette[index * 3 + 2] << 8) | (alpha[index] ?? 255)) >>> 0 : raw.readUInt32BE(offset);
    }
  }
  return { w, h, pixels };
}

test('Independent clip processing: K1 nonfirst replacement preserves distinct fullN RGBA, identities, timing and source', () => {
  for (const mode of ['region', 'whole'] as const) {
    const f = fixture(mode), before = wireStringify(f.options);
    const result = recomposeClipAsset(f.options), output = result.asset;
    const expected = f.images.map((image, i) => i !== 2 ? image.slice() : Uint32Array.from(image, (p, j) => mode === 'whole' || f.mask[j] ? 0xffffffff : p));
    assert.deepEqual(frames(output), expected);
    assert.deepEqual(output.frames, f.context.slots.map(({ id, duration }) => ({ id, duration })));
    assert.equal(output.tags[0].loop, false);
    assert.deepEqual(output.metadata, f.source.metadata);
    assert.equal(accepted({ asset: output, baseline: f.baseline, context: f.context, mask: mode === 'region' ? f.mask : undefined }), true);
    const rebuilt = roundtrip(output);
    assert.deepEqual(frames(rebuilt), expected);
    assert.deepEqual(rebuilt.frames.map(x => x.duration), f.durations);
    assert.equal(rebuilt.tags[0].loop, false);
    assert.deepEqual(rebuilt.metadata, output.metadata);
    assert.equal(wireStringify(f.options), before, 'processing cannot mutate original inputs');
  }
});

test('Independent clip processing: verification rejects changed locked pixels, order, metadata, missing data and forged source', () => {
  const f = fixture(), result = recomposeClipAsset(f.options).asset;
  const mutations: [string, (asset: PixelAsset) => void][] = [
    ['frozen pixel', a => { celFor(a, a.layers[0].id, a.frames[0].id)!.data![0] = 0; }],
    ['unselected pixel', a => { celFor(a, a.layers[0].id, a.frames[1].id)!.data![1] = 0; }],
    ['outside-mask pixel', a => { celFor(a, a.layers[0].id, a.frames[2].id)!.data![2] = 0; }],
    ['duration', a => { a.frames[2].duration++; }],
    ['frame order', a => { [a.frames[1], a.frames[2]] = [a.frames[2], a.frames[1]]; }],
    ['pivot NaN', a => { a.metadata.pivot!.x = NaN; }],
    ['hitbox', a => { a.metadata.hitbox!.x++; }],
    ['event', a => { a.metadata.events![0].name = 'sai sự kiện'; }],
    ['missing selected cel', a => { delete a.cels[a.layers[0].cels[a.frames[2].id]]; }],
    ['source', a => { a.source!.files['art.px.js'] = "sprite('fake',{w:4,h:3},rect(0,0,1,1,'#ffffffff'))\n"; }],
    ['tag playback range', a => { a.tags[0].from = a.frames[2].id; }],
    ['reverse tag', a => { a.tags[0].direction = 'reverse'; }],
  ];
  const missed: string[] = [];
  for (const [name, mutate] of mutations) {
    const asset = structuredClone(result); mutate(asset);
    if (accepted({ asset, baseline: f.baseline, context: f.context, mask: f.mask })) missed.push(name);
  }
  assert.deepEqual(missed, [], 'every forged variant must fail before apply');
});

test('Independent clip processing: region permission and fully loaded baseline are mandatory during both processing and verification', () => {
  const f = fixture(), asset = recomposeClipAsset(f.options).asset;
  const badMasks: unknown[] = [undefined, [], new Uint32Array(1), new Uint32Array(12), new Uint32Array(12).fill(2)];
  const missed: string[] = [];
  for (const [i, mask] of badMasks.entries()) {
    assert.throws(() => recomposeClipAsset({ ...f.options, mask: mask as Uint32Array }));
    if (accepted({ asset, baseline: f.baseline, context: f.context, mask: mask as Uint32Array })) missed.push('mask ' + i);
  }
  const baseline = structuredClone(f.baseline);
  delete baseline.cels[baseline.layers[0].cels[baseline.frames[2].id]];
  assert.throws(() => recomposeClipAsset({ ...f.options, baseline }));
  if (accepted({ asset, baseline, context: f.context, mask: f.mask })) missed.push('missing baseline');
  assert.deepEqual(missed, [], 'verification must repeat preflight, not rely on earlier processing');
});

test('Independent clip processing: one fixed palette normalizes permitted alpha only and never recolors retained data', () => {
  const f = fixture(), context = structuredClone(f.context);
  context.palette = [0xffffffff, 0x000000ff, 0];
  const baseline = structuredClone(f.baseline);
  baseline.frames.forEach(frame => celFor(baseline, baseline.layers[0].id, frame.id)!.data!.fill(0x000000ff));
  const raw = structuredClone(f.raw), pixels = celFor(raw, raw.layers[0].id, raw.frames[0].id)!.data!;
  pixels.fill(0xffffffff); pixels[1] = 0xffffff7f; pixels[5] = 0xffffff80;
  const before = wireStringify({ raw, baseline, context });
  for (const threshold of [1, 128, 255]) {
    const r = normalizeClipAsset({ raw, baseline, context, mask: f.mask, threshold });
    const expected = baseline.frames.map((frame, index) => {
      const data = celFor(baseline, baseline.layers[0].id, frame.id)!.data!.slice();
      if (index === 2) { data[1] = threshold <= 127 ? 0xffffffff : 0; data[5] = threshold <= 128 ? 0xffffffff : 0; }
      return data;
    });
    assert.deepEqual(frames(r.asset), expected);
    assert.deepEqual(frames(roundtrip(r.asset)), expected);
    assert.equal(r.stats.outsideChanges, 0);
    assert.equal(accepted({ asset: r.asset, baseline, context, mask: f.mask, normalized: true, threshold }), true);
  }
  assert.equal(wireStringify({ raw, baseline, context }), before);
  assert.throws(() => normalizeClipAsset({ ...f.options, context }), /normalize|chuẩn hóa/i);
});

test('Independent clip processing: reject missing raw data, invalid timing and unsupported hidden RGB before it is composited away', () => {
  const f = fixture();
  const broken = structuredClone(f.raw); broken.frames[0].duration++;
  assert.throws(() => recomposeClipAsset({ ...f.options, raw: broken }));
  const missing = structuredClone(f.raw); delete missing.cels[missing.layers[0].cels[missing.frames[0].id]];
  assert.throws(() => recomposeClipAsset({ ...f.options, raw: missing }));
  const hidden = structuredClone(f.baseline);
  celFor(hidden, hidden.layers[0].id, hidden.frames[0].id)!.data![11] = 0x12345600;
  assert.throws(() => recomposeClipAsset({ ...f.options, baseline: hidden }), /RGB|alpha/i);
});

test('Independent clip processing: source byte preflight is conservative for ASCII and Unicode and refuses oversize RLE', () => {
  for (const name of ['hero', 'Bước đi tiếng Việt 👾']) for (const loop of [true, false]) {
    for (const images of [[new Uint32Array(12).fill(0xffffffff)], [new Uint32Array(12).fill(0xffffffff), new Uint32Array(12).fill(0x00ff00ff)]]) {
      const durations = images.map((_, i) => i ? 140 : 100), source = imageSource(name, 4, 3, images, durations, loop);
      assert.ok(estimateImageSourceLength(name, 4, 3, images, durations, loop) >= Buffer.byteLength(source), 'preflight must not underestimate UTF8 before string allocation');
    }
  }
  const dense = Uint32Array.from({ length: 256 * 256 }, (_, i) => (i & 1) ? 0xffffffff : 0x000000ff);
  assert.throws(() => rebuildClipSource('dense', 256, 256, [dense, dense], [100, 100], true), /dữ liệu|giới hạn|dung lượng/i);
});

test('Independent clip context: reject invalid budgets, unknown pixels and input schema; clone approved metadata', () => {
  const f = fixture(), original = wireStringify(f.context);
  const invalid: ((c: any) => void)[] = [
    c => { c.w = c.h = 4096; }, c => { c.slots[2].frozen = true; }, c => { c.slots[2].id = c.slots[1].id; },
    c => { c.slots[2].pose.foreign = { x: 1, y: 1 }; }, c => { c.palette = [0]; }, c => { c.palette = [0xffffff7f]; },
    c => { c.rgba = [1, 2, 3]; }, c => { c.sourceMetadata.events[0].frame = 9; },
    c => { c.parts = {}; }, c => { c.palette = [0xffffffff, 0x12345600]; },
    c => { c.palette = new Array(4097).fill(0xffffffff); },
    c => { c.slots[2].pose.head = { x: 1, y: 1, rgba: [1] }; },
  ];
  for (const mutate of invalid) { const bad: any = structuredClone(f.context); mutate(bad); assert.throws(() => validateClipGenerationContext(bad)); }
  const cloned: ClipGenerationContext = validateClipGenerationContext(f.context);
  cloned.slots[0].pose.head = { x: 2, y: 2 }; cloned.sourceMetadata!.events![0].name = 'khác';
  assert.equal(wireStringify(f.context), original);
});

test('Independent clip processing: reordered IDs and K2 replacements retain canonical unequal timing', () => {
  const f = fixture('whole'), context = structuredClone(f.context), baseline = structuredClone(f.baseline);
  const order = [3, 2, 0, 1];
  context.slots = order.map(i => ({ ...context.slots[i], selected: i === 3 || i === 1 }));
  baseline.frames = order.map(i => ({ ...baseline.frames[i] }));
  baseline.tags[0].from = baseline.frames[0].id; baseline.tags[0].to = baseline.frames.at(-1)!.id;
  const raw = structuredClone(f.raw), firstId = raw.frames[0].id;
  raw.frames = [{ id: firstId, duration: 100 }, { id: 'raw-second', duration: 140 }];
  const colors = [0xffffffff, 0x000000ff];
  raw.frames.forEach((frame, i) => { celFor(raw, raw.layers[0].id, frame.id, true)!.data!.fill(colors[i]); });
  raw.tags[0].from = firstId; raw.tags[0].to = raw.frames[1].id;
  const before = wireStringify({ raw, baseline, context }), output = recomposeClipAsset({ raw, baseline, context }).asset;
  const expected = order.map(i => i === 3 ? new Uint32Array(12).fill(colors[0]) : i === 1 ? new Uint32Array(12).fill(colors[1]) : f.images[i]);
  assert.deepEqual(frames(output), expected);
  assert.deepEqual(output.frames.map(f => f.duration), [100, 200, 80, 140]);
  assert.deepEqual(frames(roundtrip(output)), expected);
  assert.equal(wireStringify({ raw, baseline, context }), before);
});

test('Independent clip processing: verification preflights even an unconstrained selected frame and baseline playback', () => {
  const f = fixture('whole'), result = recomposeClipAsset(f.options).asset;
  const baseline = structuredClone(f.baseline);
  delete baseline.cels[baseline.layers[0].cels[baseline.frames[2].id]];
  assert.equal(accepted({ asset: result, baseline, context: f.context }), false, 'selected whole frame still requires loaded captured baseline');
  assert.throws(() => recomposeClipAsset({ ...f.options, mask: f.mask }), /mask|vùng|whole|toàn/i);
  const wrongLoop = structuredClone(f.baseline); wrongLoop.tags[0].loop = true;
  assert.throws(() => recomposeClipAsset({ ...f.options, baseline: wrongLoop }), /loop|lặp|playback|phát/i);
  const missingRawLoop = structuredClone(f.raw); missingRawLoop.tags = [];
  assert.throws(() => recomposeClipAsset({ ...f.options, raw: missingRawLoop }), /loop|lặp|playback|phát/i);
  const extraSource = structuredClone(result); extraSource.source!.files['unused.px.js'] = 'sprite("untrusted",{w:1,h:1})';
  assert.equal(accepted({ asset: extraSource, baseline: f.baseline, context: f.context }), false);
});

test('Independent clip processing: fixed asset identity, exact anchor, baseline playback and public source input bounds', () => {
  const f = fixture('whole'), result = recomposeClipAsset(f.options).asset, missed: string[] = [];
  for (const [label, mutate] of [
    ['asset name', (a: PixelAsset) => { a.name = 'changed'; }],
    ['asset identity', (a: PixelAsset) => { a.id = 'foreign'; }],
    ['small anchor shift', (a: PixelAsset) => { a.metadata.pivot!.x += 0.000001; }],
  ] as const) {
    const asset = structuredClone(result); mutate(asset);
    if (accepted({ asset, baseline: f.baseline, context: f.context })) missed.push(label);
  }
  const baseline = structuredClone(f.baseline); baseline.tags[0].loop = true;
  if (accepted({ asset: result, baseline, context: f.context })) missed.push('baseline playback');
  for (const durations of [[0, 100], [100, NaN], [100, 60001]]) {
    try { rebuildClipSource('bounded', 4, 3, f.images.slice(0, 2), durations, true); missed.push('source duration ' + durations); } catch {}
  }
  assert.deepEqual(missed, []);
});

test('Independent clip processing: chosen fullN output exports exact PNG/atlas/strip pixels and preserved game metadata', () => {
  const f = fixture(), asset = recomposeClipAsset(f.options).asset;
  const document = structuredClone(f.document); document.assets = [asset]; delete document.studio;
  const expected = f.images.map((image, i) => i !== 2 ? image : Uint32Array.from(image, (p, index) => f.mask[index] ? 0xffffffff : p));
  asset.frames.forEach((frame, i) => {
    const png = decodePng(exportPixel({ document, assetId: asset.id, frameId: frame.id, format: 'png' }).data);
    assert.equal(png.w, 4); assert.equal(png.h, 3); assert.deepEqual(png.pixels, expected[i]);
  });
  for (const format of ['strip', 'atlas'] as const) {
    const files = unzip(exportPixel({ document, assetId: asset.id, format }).data);
    const png = decodePng(files['image.png']), metadata = JSON.parse(files['image.json'].toString('utf8'));
    const entries: any[] = Object.values(metadata.frames);
    assert.equal(entries.length, 4);
    entries.forEach((entry, index) => {
      const rect = entry.frame, pixels = new Uint32Array(12);
      assert.equal(rect.w, 4); assert.equal(rect.h, 3); assert.equal(entry.duration, f.durations[index]);
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) pixels[y * 4 + x] = png.pixels[(rect.y + y) * png.w + rect.x + x];
      assert.deepEqual(pixels, expected[index], 'atlas UV excludes extrusion and retains exact RGBA');
    });
    assert.equal(metadata.meta.frameTags[0].loop, false);
    assert.deepEqual(metadata.meta.pxl.assets[asset.id].pivot, f.source.metadata.pivot);
    assert.deepEqual(metadata.meta.pxl.assets[asset.id].hitbox, f.source.metadata.hitbox);
    assert.deepEqual(metadata.meta.pxl.assets[asset.id].events, f.source.metadata.events);
    assert.deepEqual(metadata.meta.pxl.assets[asset.id].frames, asset.frames);
    assert.equal(metadata.meta.pxl.revision, document.revision);
    if (format === 'strip') assert.deepEqual(metadata.meta.pxl.playback, asset.frames.map(frame => ({ frameId: frame.id, duration: frame.duration })));
  }
});

test('Independent clip processing: structural failures return before composite allocation and whole scope rejects masks on verify', () => {
  const f = fixture('whole'), output = recomposeClipAsset(f.options).asset;
  const invalid: any = structuredClone(output); invalid.frames = null;
  let result: ReturnType<typeof verifyClipAsset> | undefined;
  assert.doesNotThrow(() => { result = verifyClipAsset({ asset: invalid, baseline: f.baseline, context: f.context, throwOnError: false }); });
  assert.equal(result!.valid, false);
  assert.equal(accepted({ asset: output, baseline: f.baseline, context: f.context, mask: f.mask }), false);
});
