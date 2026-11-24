// Parent-owned worker integration acceptance. Never connects to the live Studio/provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { VariantStore } from '../src/node/studio/variant-store.ts';
import { startRender, type WorkerRequest } from '../src/node/studio/runner.ts';
import { renderDocument, type ExportResult } from '../src/node/studio/render.ts';
import { composite, wireParse, type PixelAsset } from '../src/studio/pixel/model.ts';
import { createGuideContactSheet, prepareClipSnapshot } from '../src/node/studio/clip-snapshot.ts';
import { createClipGenerationContext } from '../src/studio/clip-generation.ts';

async function work(root: string, values: Record<string, unknown>): Promise<any> {
  const result = await startRender({ mode: 'pixel-process', root, ...values } as WorkerRequest).promise as ExportResult;
  return wireParse(Buffer.from(result.data).toString('utf8'));
}
async function prepare(root: string, f: ReturnType<typeof savedClipFixture>) {
  return work(root, { operation: 'clip-prepare', projectRoot: f.root, projectId: f.saved.id,
    revision: f.saved.revision, clipId: f.clip.id, paletteMode: 'asset', targetPalette: f.source.palette });
}
function candidate(snapshot: any, body: string, loop = snapshot.context.loop, duration = 200) {
  const includes = snapshot.helperFiles.map((name: string) => `include(${JSON.stringify(name)});`).join('\n');
  return { ...snapshot.contextDoc, files: { ...snapshot.contextDoc.files,
    'art.px.js': `${includes}\nanim('candidate',{w:4,h:3,loop:${loop}},frame({ms:${duration}},${body}))\n` } };
}

test('Independent clip worker: actual thread captures exact saved nonfirst source, baseline, K1 seed and metadata without project writes', async () => {
  for (const mode of ['region', 'whole'] as const) {
    const f = savedClipFixture(mode, true), repo = new VariantStore();
    try {
      const result = await work(repo.root, { operation: 'clip-prepare', projectRoot: f.root, projectId: f.saved.id,
        revision: f.saved.revision, clipId: f.clip.id, paletteMode: 'asset', targetPalette: f.source.palette });
      assert.equal(result.context.projectId, f.saved.id); assert.equal(result.contextDoc.id, f.saved.id);
      assert.deepEqual(result.context.pivot, { x: 2, y: 3 });
      assert.deepEqual(result.context.sourceMetadata.pivot, { x: 0.5, y: 1 });
      assert.deepEqual(result.context.sourceMetadata.events, [{ frame: 0, name: 'từ frame 2' }]);
      assert.deepEqual(result.context.parts, { arm: { name: 'Tay áo' } });
      assert.equal(result.context.slots.length, 4);
      assert.deepEqual(result.context.slots.filter((s: any) => s.selected).map((s: any) => s.id), [f.clip.slots[2].id]);
      assert.deepEqual(result.problems, []);
      assert.ok(result.guideMetadata.w <= 1024 && result.guideMetadata.h <= 1024);
      const assets = repo.assets(result.referenceId), baseline = assets.find(a => a.id === result.referenceInfo.clip.baselineAssetId)!;
      const master = assets.find(a => a.id === result.referenceInfo.clip.masterAssetId)!;
      assert.equal(assets.length, 2); assert.ok(master && baseline);
      assert.deepEqual(baseline.frames.map(frame => frame.duration), f.durations);
      assert.deepEqual(baseline.frames.map(frame => composite(baseline, frame.id).data), f.images);
      const sourceImage = composite(f.source, f.character.source.frameId).data;
      assert.deepEqual(composite(master, master.frames[0].id).data, sourceImage);
      assert.notDeepEqual(sourceImage, f.images[2]);
      if (mode === 'region') assert.deepEqual(repo.mask(result.referenceId), [...f.mask]);
      else assert.equal(repo.mask(result.referenceId), undefined);
      const raster = renderDocument({ document: result.contextDoc, mode: 'generation-preview', generation: {
        options: { style: 'game', view: 'description', paletteMode: 'asset', reference: true },
        assetId: f.source.id, w: 4, h: 3, palette: f.source.palette,
      } }) as ExportResult;
      const output = wireParse(Buffer.from(raster.data).toString('utf8')).assets as PixelAsset[];
      assert.equal(output.length, 1, 'private helper assets are excluded');
      assert.equal(output[0].frames.length, 1); assert.equal(output[0].frames[0].duration, 200);
      assert.deepEqual(composite(output[0], output[0].frames[0].id).data, f.images[2], 'K1 seed uses slot baseline, not master or frame0');
      assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
      assert.ok(result.helperFiles.length >= 2 && result.helperFiles.every((name: string) => name.startsWith('_pxl_clip_')));
      assert.equal(JSON.stringify(result.context).includes('$rgba'), false);
    } finally { repo.close(); f.close(); }
  }
});

test('Independent clip guide: wide source thumbnails stay bounded and edited/keyframe pose is distinct from anatomy defaults', () => {
  const context = createClipGenerationContext({ projectId: 'project', revision: 1, clipId: 'wide', characterId: 'hero',
    name: 'Dáng rộng', sourceAssetId: 'asset', sourceFrameId: 'frame', w: 1024, h: 2,
    palette: [0xffffffff, 0], pivot: { x: 512, y: 2 }, mode: 'whole', loop: true,
    landmarks: { head: { name: 'Đầu', x: 2, y: 0 } }, slots: Array.from({ length: 4 }, (_, i) => ({
      id: 'slot' + i, duration: 100, selected: i === 2, frozen: i === 0, keyframe: i === 1,
      pose: { head: { x: i === 2 ? 3 : 2, y: 0 } },
    })),
  });
  const buffers = context.slots.map(slot => ({ id: slot.id, data: new Uint32Array(2048).fill(0xffffffff) }));
  const before = buffers.map(frame => frame.data.slice()), result = createGuideContactSheet(context, buffers);
  assert.ok(result.image.w <= 1024 && result.image.h <= 1024);
  assert.deepEqual(result.metadata.slots.map(slot => slot.isEditedPose), [false, true, true, false]);
  assert.deepEqual(buffers.map(frame => frame.data), before);
});

test('Independent clip worker: real K1 capture/normalize/verify retain fullN pixels, timing, region and immutable source', async () => {
  for (const mode of ['region', 'whole'] as const) for (const loop of [false, true]) {
    const f = savedClipFixture(mode), repo = new VariantStore();
    try {
      if (loop) {
        const d = f.store.load(f.saved.id); d.studio!.clips!.walk.loop = true;
        f.store.save(d.id, d.revision, d, 'Kiểm thử loop');
        f.saved = f.store.load(d.id); f.originalManifest = readFileSync(f.manifest);
      }
      const snapshot = await prepare(repo.root, f), sourceBefore = JSON.stringify(snapshot.contextDoc);
      const document = candidate(snapshot, "rect(1,0,1,1,'#ffffff7f'),rect(1,1,1,1,'#ffffff80')");
      const context = snapshot.context, request = { context, referenceId: snapshot.referenceId, revision: context.revision };
      const captured = await work(repo.root, { ...request, operation: 'clip-capture', document });
      assert.ok(captured.raw); assert.equal(captured.raw.canApply, false);
      assert.ok(captured.protected); assert.equal(captured.protected.canApply, true);
      assert.deepEqual(captured.quality.errors, []);
      const raw = repo.assets(captured.raw.id)[0];
      assert.equal(raw.frames.length, 1); assert.equal(raw.frames[0].duration, 200); assert.equal(raw.tags[0].loop, loop);
      const rawPixels = new Uint32Array(12); rawPixels[1] = 0xffffff7f; rawPixels[5] = 0xffffff80;
      assert.deepEqual(composite(raw, raw.frames[0].id).data, rawPixels);
      assert.equal(captured.raw.quality.assets[0].semiTransparentPixels, 2);
      const expected = f.images.map((image, i) => i !== 2 ? image : Uint32Array.from(image, (p, index) => mode === 'whole' || f.mask[index] ? rawPixels[index] : p));
      const full = repo.assets(captured.protected.id)[0];
      assert.deepEqual(full.frames.map(frame => frame.duration), f.durations);
      assert.deepEqual(full.frames.map(frame => composite(full, frame.id).data), expected);
      assert.equal((await work(repo.root, { ...request, operation: 'clip-verify', variantId: captured.protected.id })).valid, true);
      assert.equal((await work(repo.root, { ...request, operation: 'clip-verify', variantId: captured.raw.id })).valid, false);
      assert.equal((await work(repo.root, { ...request, operation: 'clip-verify', variantId: snapshot.referenceId })).valid, false);
      const normalized = await work(repo.root, { ...request, operation: 'clip-normalize', rawVariantId: captured.raw.id, alphaThreshold: 128 });
      assert.equal(normalized.info.kind, 'normalized'); assert.equal(normalized.info.canApply, true);
      const output = repo.assets(normalized.info.id)[0], normExpected = expected.map((image, i) => {
        const data = image.slice(); if (i === 2) { data[1] = 0; data[5] = 0xffffffff; } return data;
      });
      assert.deepEqual(output.frames.map(frame => composite(output, frame.id).data), normExpected);
      assert.equal(output.tags[0].loop, loop);
      assert.equal((await work(repo.root, { ...request, operation: 'clip-verify', variantId: normalized.info.id })).valid, true);
      assert.deepEqual(composite(repo.assets(captured.raw.id)[0], raw.frames[0].id).data, rawPixels);
      assert.deepEqual(readFileSync(f.manifest), f.originalManifest); assert.equal(JSON.stringify(snapshot.contextDoc), sourceBefore);
      for (const threshold of [0, 256, 1.5]) await assert.rejects(() => work(repo.root, { ...request, operation: 'clip-normalize', rawVariantId: captured.raw.id, alphaThreshold: threshold }), /alpha|ngưỡng|1.?255|1–255/i);
    } finally { repo.close(); f.close(); }
  }
});

test('Independent clip worker: wrong K1 timing/loop preserves real blocked raw and cannot gain protected variant', async () => {
  const f = savedClipFixture('whole'), repo = new VariantStore();
  try {
    const snapshot = await prepare(repo.root, f), context = snapshot.context;
    const request = { context, referenceId: snapshot.referenceId, revision: context.revision };
    for (const document of [candidate(snapshot, "rect(0,0,4,3,'#ffffffff')", true), candidate(snapshot, "rect(0,0,4,3,'#ffffffff')", false, 100)]) {
      const result = await work(repo.root, { ...request, operation: 'clip-capture', document });
      assert.ok(result.raw); assert.equal(result.raw.canApply, false); assert.equal(result.protected, undefined);
      assert.ok(result.quality.errors.length);
      const raw = repo.assets(result.raw.id)[0];
      assert.deepEqual(composite(raw, raw.frames[0].id).data, new Uint32Array(12).fill(0xffffffff));
    }
    const multi = candidate(snapshot, "rect(0,0,4,3,'#ffffffff')");
    multi.files['art.px.js'] += "sprite('second',{w:4,h:3},rect(0,0,1,1,'#ff0000ff'))\n";
    const result = await work(repo.root, { ...request, operation: 'clip-capture', document: multi });
    assert.ok(result.quality.errors.length); assert.equal(result.protected, undefined);
    assert.ok(result.raw); assert.equal(repo.assets(result.raw.id).length, 2, 'retain actual public output rather than dummy image');
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { repo.close(); f.close(); }
});

test('Independent clip worker: rejects stale/invalid snapshots, forged context and reference substitution without orphan variants', async () => {
  const f = savedClipFixture(), other = savedClipFixture(), repo = new VariantStore();
  try {
    const input = { operation: 'clip-prepare', projectRoot: f.root, projectId: f.saved.id, revision: f.saved.revision, clipId: f.clip.id, paletteMode: 'asset' };
    for (const targetPalette of [[0xffffff7f, 0xffffffff], [0x12345600, 0xffffffff], [0xffffffff], [0]]) {
      await assert.rejects(() => work(repo.root, { ...input, targetPalette }));
      assert.deepEqual(readdirSync(repo.root), [], 'failed prepare must not retain a reference');
    }
    await assert.rejects(() => work(repo.root, { ...input, revision: 99, targetPalette: f.source.palette }));
    assert.deepEqual(readdirSync(repo.root), []);
    const first = await prepare(repo.root, f), second = await prepare(repo.root, other), original = readdirSync(repo.root).sort();
    const document = candidate(first, "rect(0,0,4,3,'#ffffffff')"), request = { context: first.context, referenceId: first.referenceId, revision: first.context.revision };
    const forgeries = [
      (c: any) => { c.projectId = other.saved.id; },
      (c: any) => { c.slots[0].frozen = false; },
      (c: any) => { c.slots[2].pose.head.x = 2; },
      (c: any) => { c.pivot.x = 1; },
      (c: any) => { c.palette.reverse(); },
      (c: any) => { c.loop = true; },
      (c: any) => { c.clipId = 'another'; },
    ];
    for (const mutate of forgeries) {
      const forged = structuredClone(first.context); mutate(forged);
      await assert.rejects(() => work(repo.root, { ...request, context: forged, operation: 'clip-capture', document }));
    }
    await assert.rejects(() => work(repo.root, { ...request, referenceId: second.referenceId, operation: 'clip-capture', document }));
    await assert.rejects(() => work(repo.root, { ...request, revision: 99, operation: 'clip-capture', document }));
    assert.deepEqual(readdirSync(repo.root).sort(), original, 'bad snapshot cannot create a raw/protected output');
    const otherOutput = await work(repo.root, { operation: 'clip-capture', context: second.context, referenceId: second.referenceId,
      revision: second.context.revision, document: candidate(second, "rect(0,0,4,3,'#ffffffff')") });
    await assert.rejects(() => work(repo.root, { ...request, operation: 'clip-normalize', rawVariantId: otherOutput.raw.id, alphaThreshold: 128 }), /context|dự án|snapshot|tham chiếu|khớp/i);
    const captured = await work(repo.root, { ...request, operation: 'clip-capture', document });
    const expanded = [...f.mask]; expanded[0] = 1; repo.mask(first.referenceId, expanded);
    await assert.rejects(() => work(repo.root, { ...request, operation: 'clip-normalize', rawVariantId: captured.raw.id, alphaThreshold: 128 }), /mask|mặt nạ|vùng|snapshot|digest/i);
    const mask = [...f.mask]; mask[0] = 0.5; repo.mask(first.referenceId, mask);
    let rejected = false;
    try { const result = await work(repo.root, { ...request, operation: 'clip-verify', variantId: captured.protected.id }); rejected = result.valid === false; } catch { rejected = true; }
    assert.equal(rejected, true, 'fractional mask must not silently coerce into permission bytes');
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
    assert.deepEqual(readFileSync(other.manifest), other.originalManifest);
  } finally { repo.close(); f.close(); other.close(); }
});

test('Independent clip worker: auto16 remains fixed to approved master palette and reports raw deviations before local normalization', async () => {
  const f = savedClipFixture(), repo = new VariantStore();
  try {
    const snapshot = await work(repo.root, { operation: 'clip-prepare', projectRoot: f.root, projectId: f.saved.id,
      revision: f.saved.revision, clipId: f.clip.id, paletteMode: 'auto16' });
    const context = snapshot.context, request = { context, referenceId: snapshot.referenceId, revision: context.revision };
    assert.ok(context.palette.filter((p: number) => p & 255).length <= 16);
    assert.ok(!context.palette.includes(0xff00ffff));
    const output = await work(repo.root, { ...request, operation: 'clip-capture', document: candidate(snapshot, "rect(1,0,1,1,'#ff00ffff')") });
    assert.ok(output.protected); assert.deepEqual(output.quality.errors, []);
    assert.equal(output.raw.quality.assets[0].outsidePaletteColors, 1);
    assert.ok(output.raw.quality.warnings.length);
    const normalized = await work(repo.root, { ...request, operation: 'clip-normalize', rawVariantId: output.raw.id, alphaThreshold: 128 });
    const asset = repo.assets(normalized.info.id)[0];
    assert.ok(asset.palette.every(pixel => pixel === 0 || context.palette.includes(pixel)));
    assert.ok(normalized.stats.changedColors >= 1);
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { repo.close(); f.close(); }
});

test('Independent clip snapshot: late mask I/O and revision changes remove only newly owned reference', () => {
  for (const failure of ['mask', 'revision'] as const) {
    const f = savedClipFixture(), repo = new VariantStore(), originalMask = VariantStore.prototype.mask, originalPut = VariantStore.prototype.put;
    try {
      if (failure === 'mask') VariantStore.prototype.mask = function(id, value) {
        if (value !== undefined) throw new Error('Injected mask write failure');
        return originalMask.call(this, id);
      };
      else VariantStore.prototype.put = function(...args) {
        const info = originalPut.apply(this, args), document = f.store.load(f.saved.id);
        document.name = 'Thay đổi bên ngoài'; f.store.save(document.id, document.revision, document, 'External test edit');
        return info;
      };
      assert.throws(() => prepareClipSnapshot({ projectRoot: f.root, projectId: f.saved.id, revision: f.saved.revision,
        clipId: f.clip.id, paletteMode: 'asset', targetPalette: f.source.palette, storeRoot: repo.root }));
      assert.deepEqual(readdirSync(repo.root), [], 'late failure must not leak reference after put');
      if (failure === 'mask') assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
      else { const current = f.store.load(f.saved.id); assert.equal(current.name, 'Thay đổi bên ngoài'); assert.equal(current.revision, 2); }
    } finally { VariantStore.prototype.mask = originalMask; VariantStore.prototype.put = originalPut; repo.close(); f.close(); }
  }
});
