import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { QualityRuntime } from '../src/node/studio/quality-runtime.ts';
import { QualityEngine } from '../src/node/studio/quality-engine.ts';
import { INLINE_JSON_MARKER, QualityCliTransport } from '../src/node/studio/quality-cli.ts';
import { createMotionApproval, type MotionApprovalSnapshot } from '../src/node/studio/motion-approval.ts';
import { qualityRgbaHash } from '../src/node/studio/quality-digest.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { composite, wireParse, type PixelAsset } from '../src/studio/pixel/model.ts';
import { loadSource } from '../src/node/load.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { decodeQualityPng } from './quality-image-fixture.ts';
import { qualityHttpFixture } from './fixtures/quality-http.ts';

function setup(scenario: string, whole = false, reviewerTimeout = 15000) {
  const root = mkdtempSync(join(tmpdir(), 'pxl-frame-cli-')), log = join(root, 'calls.jsonl');
  const f = motionFixture(), pixels = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
  f.rig.source.rgbaSha256 = qualityRgbaHash(pixels);
  f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const mask = new Uint8Array(256);
  for (let y = 3; y <= 9; y++) for (let x = 4; x <= 11; x++) mask[y * 16 + x] = 1;
  const snapshot: MotionApprovalSnapshot = { ...f, resources: { sources: [], masks: [] },
    source: { projectId: 'project', assetId: 'source', frameId: 'source-frame', revision: 7, pixels },
    movementMask: whole ? null : mask, frozenFrames: whole ? [] : [{ frameId: 'rest', pixels: pixels.slice() }] };
  const runtime = new QualityRuntime();
  const provider = { executable: process.execPath, prefix: [resolve('test/fixtures/quality-cli.cjs'), scenario, log] };
  const cli = new QualityCliTransport((s, c) => runtime.cliContext(s, c), { providers: { codex: provider }, deepseek: qualityHttpFixture(scenario, log),
    ...(scenario === 'frame-edits-pixels-only' ? { motionReviewerEffort: 'medium' } : {}) });
  let busy = false, snapshotId = '';
  const engine = new QualityEngine(runtime.ports({
    acquire() { assert.equal(busy, false); busy = true; return { release() { busy = false; }, check() { assert.equal(busy, true); } }; },
    assertCurrent(project, revision) { assert.equal(project, 'project'); assert.equal(revision, 7); },
    execute(r) { snapshotId = r.snapshotId; return cli.execute(r); },
  }), { limits: { director: 15000, builder: 15000, reviewer: reviewerTimeout, total: 60000 } });
  return { f, snapshot, runtime, engine, root, get snapshotId() { return snapshotId; },
    input: { projectId: 'project', revision: 7, prompt: 'Sửa nét khớp đúng frame, giữ phần đã khóa', style: 'RPG',
      context: { kind: 'motion', snapshot, approval: createMotionApproval(snapshot) } },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s)),
    async close() {
      await engine.close(); assert.equal(await cli.close(), true); runtime.close(true);
      assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a lingering Codex motion reviewer needs a complete event and matching answer before owned shutdown', { timeout: 60000 }, async () => {
  for (const suffix of ['linger', 'mismatch', 'nonzero']) {
    const x = setup(`reviewer-completed-${suffix}`, true, 6500);
    try {
      const run = await x.engine.wait(x.engine.start(x.input).id);
      assert.equal(run.cliCalls, 3);
      assert.equal(run.technicalRepairs, 0);
      if (suffix === 'linger') {
        assert.equal(run.status, 'ready', run.message);
        assert.deepEqual(run.calls.at(-1)?.usage, { input: 37, output: 23, cached: 11 });
      } else {
        assert.equal(run.status, 'failed');
        assert.match(run.message, suffix === 'mismatch' ? /vượt thời gian/ : /thoát mã 7/);
      }
    } finally { await x.close(); }
  }
});

test('Codex receives exact mask/locked PNGs, HTTP receives JSON metadata; final frame edits survive PNG and baked source', { timeout: 60000 }, async () => {
  const x = setup('frame-edits');
  try {
    const before = structuredClone(x.input.context);
    const ready = await x.engine.wait(x.engine.start(x.input).id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.cliCalls, 3); assert.equal(ready.technicalRepairs, 0);
    const calls = x.calls(); assert.deepEqual(calls.map(c => [c.role, c.codex]), [['director', true], ['builder', false], ['reviewer', true]]);
    const files = new Map((await x.runtime.cliContext(x.snapshotId).promise).map(f => [f.name, f.data]));
    const motion = JSON.parse(Buffer.from(files.get('approved-motion.json')!).toString('utf8'));
    assert.deepEqual(motion.rig, x.f.rig); assert.deepEqual(motion.plan, x.f.plan);
    assert.deepEqual([motion.movementMask.w, motion.movementMask.h], [16, 16]);
    assert.deepEqual(motion.frozenFrames, [{ frameId: 'rest', file: 'protected-frame-0.png' }]);
    const maskBytes = files.get(motion.movementMask.file)!;
    const maskPng = decodeQualityPng(maskBytes);
    assert.deepEqual([maskPng.w, maskPng.h], [16, 16]);
    assert.deepEqual(maskPng.pixels, Uint32Array.from(x.snapshot.movementMask!, v => v ? 0xffffffff : 0));
    const frozenBytes = files.get(motion.frozenFrames[0].file)!;
    const frozenPng = decodeQualityPng(frozenBytes);
    assert.deepEqual([frozenPng.w, frozenPng.h], [16, 16]);
    assert.deepEqual(frozenPng.pixels, x.snapshot.source.pixels);
    const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    for (const call of calls) {
      if (call.transport === 'http') {
        assert.deepEqual(call.files['approved-motion.json'], motion);
        assert.deepEqual(call.images, []);
        assert.ok(Object.keys(call.files).every(name => name.endsWith('.json')));
        assert.match(call.stdin, /pixelEdits/);
        continue;
      }
      assert.deepEqual(call.protection.motion, motion);
      assert.equal(call.protection.maskHash, hash(maskBytes));
      assert.deepEqual(call.protection.frozenHashes, [{ frameId: 'rest', hash: hash(frozenBytes) }]);
      assert.match(call.codex ? call.stdin : call.print, /pixelEdits/);
    }
    const reviewer = calls.find(call => call.role === 'reviewer');
    const reviewerImages = reviewer.images.map((path: string) => basename(path));
    assert.ok(reviewerImages.includes('movement-mask.png'));
    assert.ok(reviewerImages.includes('protected-frame-0.png'));
    const lines = reviewer.stdin.split('\n');
    const inlineAt = lines.findIndex((line: string) => line.startsWith(INLINE_JSON_MARKER));
    assert.ok(inlineAt >= 0 && !reviewer.stdin.includes('Read first:'));
    const context = JSON.parse(lines[inlineAt + 1]);
    assert.deepEqual(context['approved-motion.json'], { movementMask: motion.movementMask, frozenFrames: motion.frozenFrames });
    assert.deepEqual(context['resource-index.json'], reviewer.index);
    assert.equal(context['source-recipe.json'], undefined);
    assert.ok(context['candidate-recipe.json'].frames.every((frame: { poses?: unknown }) => frame.poses === undefined));
    assert.deepEqual(context['candidate-recipe.json'].frames.map(({ id, durationMs }: { id: string; durationMs: number }) => [id, durationMs]),
      motion.plan.frames.map(({ id, durationMs }: { id: string; durationMs: number }) => [id, durationMs]));
    assert.deepEqual(context['candidate-recipe.json'].parts[0].paint, x.f.recipe.parts[0].paint);
    assert.deepEqual(context['candidate-recipe.json'].frames[1].pixelEdits, [{ x: 4, y: 8, color: 1 }]);
    const baseline = createRecipeRenderer(compileMotionRecipe(x.f.recipe, x.f.rig, x.f.plan).recipe);
    const expectedCarry = baseline.renderFrame('carry').image.data.slice(); expectedCarry[8 * 16 + 5] = 0xeef7f8ff;
    const expectedBuilder = baseline.renderFrame('carry').image.data.slice(); expectedBuilder[8 * 16 + 4] = 0xeef7f8ff;
    const builderPng = await x.runtime.materialize(x.snapshotId, ready.variants[0].id, 7, 'carry').promise;
    assert.deepEqual(decodeQualityPng(builderPng.data).pixels, expectedBuilder);
    const png = await x.runtime.materialize(x.snapshotId, ready.selectedVariantId!, 7, 'carry').promise;
    assert.deepEqual(decodeQualityPng(png.data).pixels, expectedCarry);
    const result = await x.runtime.materialize(x.snapshotId, ready.selectedVariantId!, 7).promise;
    const { asset } = wireParse(Buffer.from(result.data).toString('utf8')) as { asset: PixelAsset };
    const baked = loadSource(asset.source!.files['art.px.js']).frames('quality-result');
    const expected = [x.snapshot.source.pixels, expectedCarry];
    asset.frames.forEach((frame, i) => {
      assert.deepEqual(composite(asset, frame.id).data, expected[i]);
      assert.deepEqual(baked[i].img.data, expected[i]);
      assert.equal(baked[i].ms, [100, 120][i]);
    });
    assert.deepEqual(asset.frames.map(f => f.duration), [100, 120]);
    assert.equal(asset.tags[0].loop, true);
    assert.deepEqual(asset.metadata.pivot, { x: 0.5, y: 1 });
    assert.throws(() => x.runtime.materialize(x.snapshotId, ready.selectedVariantId!, 8), /revision/);
    assert.deepEqual(x.input.context, before);
  } finally { await x.close(); }
});

test('whole-character CLI context has explicit null mask and no phantom protection PNGs', { timeout: 60000 }, async () => {
  const x = setup('frame-edits-pixels-only', true);
  try {
    const ready = await x.engine.wait(x.engine.start(x.input).id);
    assert.equal(ready.status, 'ready', ready.message); assert.equal(ready.cliCalls, 3);
    const files = new Map((await x.runtime.cliContext(x.snapshotId).promise).map(f => [f.name, f.data]));
    assert.equal(files.has('movement-mask.png'), false);
    assert.equal([...files.keys()].some(name => name.startsWith('protected-frame-')), false);
    const motion = JSON.parse(Buffer.from(files.get('approved-motion.json')!).toString('utf8'));
    assert.equal(motion.movementMask, null); assert.deepEqual(motion.frozenFrames, []);
    for (const call of x.calls()) {
      if (call.transport === 'http') {
        assert.equal(call.files['approved-motion.json'].movementMask, null);
        assert.deepEqual(call.files['approved-motion.json'].frozenFrames, []);
        continue;
      }
      assert.equal(call.protection.maskHash, null); assert.deepEqual(call.protection.frozenHashes, []);
    }
    const reviewer = x.calls().find(call => call.role === 'reviewer');
    const lines = reviewer.stdin.split('\n');
    assert.deepEqual(reviewer.flags.slice(1, 3), ['-c', 'model_reasoning_effort="medium"']);
    assert.ok(!x.calls().find(call => call.role === 'director').flags.includes('-c'));
    const inlineAt = lines.findIndex((line: string) => line.startsWith(INLINE_JSON_MARKER));
    assert.ok(inlineAt >= 0 && !reviewer.stdin.includes('Read first:'));
    assert.match(reviewer.stdin, /movementMask: null means there is no movement-mask image/);
    assert.match(reviewer.stdin, /Editable paint kinds: pixels\. A part patch replaces its entire paint list\. Copy every operation of a kind outside this list exactly, in the same part and order\./);
    assert.match(reviewer.stdin, /prefer frameId\/pixelEdits patches and retain unaffected edits/);
    assert.deepEqual(JSON.parse(lines[inlineAt + 1])['approved-motion.json'], { movementMask: null, frozenFrames: [] });
    assert.ok(reviewer.images.every((file: string) => !/movement-mask|protected-frame/.test(file)));
    const png = await x.runtime.materialize(x.snapshotId, ready.selectedVariantId!, 7, 'carry').promise;
    assert.equal(decodeQualityPng(png.data).pixels[8 * 16 + 5], 0xeef7f8ff);
  } finally { await x.close(); }
});

test('frame patch violations stop after the shared one technical repair for either protected region', { timeout: 60000 }, async () => {
  for (const scenario of ['frame-edits-outside', 'frame-edits-frozen']) {
    const x = setup(scenario);
    try {
      const result = await x.engine.wait(x.engine.start(x.input).id);
      assert.equal(result.status, 'failed', result.message);
      assert.match(result.message, scenario.endsWith('outside') ? /ngoài vùng/ : /frame khóa/);
      assert.equal(result.technicalRepairs, 1); assert.equal(result.cliCalls, 4);
      assert.deepEqual(x.calls().map(c => c.role), ['director', 'builder', 'reviewer', 'reviewer']);
    } finally { await x.close(); }
  }
});
