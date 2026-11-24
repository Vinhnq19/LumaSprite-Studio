import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeQualityPng as decode } from './quality-image-fixture.ts';
import { startRender, RenderPool } from '../src/node/studio/runner.ts';
import type { QualityPreviewRequest, QualityInspection } from '../src/node/studio/quality-worker.ts';
import { renderQuality, qualityRgbaHash } from '../src/node/studio/quality-worker.ts';
import type { ExportResult } from '../src/node/studio/render.ts';
import type { AssetRecipe } from '../src/studio/quality/recipe.ts';
import { wireParse, composite, newDocument, type PixelAsset } from '../src/studio/pixel/model.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';
import { loadSource } from '../src/node/load.ts';

function request(operation: 'inspect' | 'asset' = 'inspect'): QualityPreviewRequest {
  const recipe: AssetRecipe = { version: 1, name: 'Kiếm thử', canvas: { w: 18, h: 18 }, pivot: { x: 9, y: 18 }, palette: [0x1d2534ff, 0xf1d3b4ff], materials: [],
    parts: [{ id: 'blade', name: 'Lưỡi', parentId: null, pivot: { x: 9, y: 9 }, origin: 'authored', materialIds: [], paint: [{ kind: 'rect', x: 7, y: 3, w: 2, h: 10, color: 1 }] }],
    frames: [{ id: 'rest', durationMs: 120, poses: [] }, { id: 'move', durationMs: 75, poses: [{ partId: 'blade', dx: 1, dy: 0, rotation: 0, z: 0, visible: true }] }], loop: false };
  return { mode: 'quality-render', revision: 7, recipe, resources: { sources: [], masks: [] }, operation };
}
function parse(result: unknown): any { return wireParse(Buffer.from((result as ExportResult).data).toString('utf8')); }
test('quality worker inspect, on-demand PNG, pixel asset and retained source share exact RGBA/timing/loop', async () => {
  const req = request(), info = parse(await startRender(req).promise) as QualityInspection;
  assert.equal(info.revision, 7); assert.deepEqual(info.frames.map(f => f.durationMs), [120, 75]); assert.equal(info.loop, false);
  const { asset, inspection } = parse(await startRender({ ...req, operation: 'asset' }).promise) as { asset: PixelAsset; inspection: QualityInspection };
  assert.deepEqual(inspection, info); assert.deepEqual(asset.metadata.pivot, { x: 0.5, y: 1 });
  assert.deepEqual(asset.palette, [0, 0xf1d3b4ff]);
  const source = loadSource(asset.source!.files['art.px.js']), legacyFrames = source.frames('quality-result');
  assert.equal(source.timeline('quality-result')!.once, true);
  const doc = newDocument('Test'); doc.revision = 7; doc.assets = [asset];
  for (let i = 0; i < 2; i++) {
    const png = await startRender({ ...req, operation: 'frame', frameId: info.frames[i].id }).promise as ExportResult;
    const decoded = decode(png.data), expected = composite(asset, asset.frames[i].id);
    assert.deepEqual([decoded.w, decoded.h], [18, 18]); assert.deepEqual(decoded.pixels, expected.data);
    assert.equal(qualityRgbaHash(expected.data), info.frames[i].rgbaSha256);
    assert.deepEqual(legacyFrames[i].img.data, expected.data); assert.equal(legacyFrames[i].ms, asset.frames[i].duration);
    assert.deepEqual(decode(exportPixel({ document: doc, assetId: asset.id, frameId: asset.frames[i].id, format: 'png' }).data).pixels, decoded.pixels);
  }
});
test('worker validates every frame before declaring ready, including a late clipping pose and an empty frame', async () => {
  const req = request(), recipe = req.recipe as AssetRecipe;
  recipe.frames[1].poses[0].dx = 20;
  await assert.rejects(startRender(req).promise, /bị cắt.*move/);
  recipe.frames[1].poses[0].dx = 0; recipe.frames[1].poses[0].visible = false;
  await assert.rejects(startRender(req).promise, /move rỗng/);
  assert.throws(() => renderQuality({ ...req, revision: NaN }), /Revision/);
});
test('worker timeout and cancel settle, free pool slot and do not poison the next request', async () => {
  const pool = new RenderPool(1), req = request();
  try {
    const timed = pool.start(req, 0), queued = pool.start(req); queued.cancel();
    await Promise.all([assert.rejects(timed.promise, /vượt thời gian/), assert.rejects(queued.promise, /hủy/)]);
    const active = pool.start(req); active.cancel(); await assert.rejects(active.promise, /hủy/);
    assert.equal(parse(await pool.start(req).promise).revision, 7);
  } finally { pool.close(); }
});
test('an expensive quality render runs off the main thread while the event loop remains responsive', async () => {
  const req = request(), r = req.recipe as AssetRecipe;
  r.canvas = { w: 512, h: 512 }; r.parts[0].paint = [{ kind: 'rect', x: 0, y: 0, w: 512, h: 512, color: 0 }];
  r.frames = Array.from({ length: 48 }, (_, i) => ({ id: `f${i}`, durationMs: 100, poses: [] }));
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try {
    const info = parse(await startRender(req).promise);
    assert.equal(info.frames.length, 48); assert.ok(ticks > 2, `event loop ticks=${ticks}`);
  } finally { clearInterval(timer); }
});
