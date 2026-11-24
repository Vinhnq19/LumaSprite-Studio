import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QualityRuntime } from '../src/node/studio/quality-runtime.ts';
import { createMotionApproval, type MotionApprovalSnapshot } from '../src/node/studio/motion-approval.ts';
import { qualityRgbaHash } from '../src/node/studio/quality-digest.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { decodeQualityPng } from './quality-image-fixture.ts';
import { wireParse, composite, type PixelAsset } from '../src/studio/pixel/model.ts';
import { loadSource } from '../src/node/load.ts';

async function base(runtime: QualityRuntime) {
  const f = motionFixture(), pixels = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
  f.rig.source.rgbaSha256 = qualityRgbaHash(pixels);
  f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const mask = new Uint8Array(256);
  for (let y = 3; y <= 9; y++) for (let x = 4; x <= 11; x++) mask[y * 16 + x] = 1;
  const snapshot: MotionApprovalSnapshot = { ...f, resources: { sources: [], masks: [] },
    source: { projectId: 'project', assetId: 'source', frameId: 'source-frame', revision: 7, pixels },
    movementMask: mask, frozenFrames: [{ frameId: 'rest', pixels: pixels.slice() }] };
  const ports = runtime.ports({ acquire: () => ({ release() {}, check() {} }), assertCurrent() {}, execute() { throw Error('Local retouch must not execute a CLI'); } });
  const prepared = await ports.prepare({ projectId: 'project', revision: 7, prompt: 'test', style: 'RPG',
    context: { kind: 'motion', snapshot, approval: createMotionApproval(snapshot) } }).promise;
  const director = { version: 1, description: 'Giữ nguồn', materials: f.recipe.materials,
    parts: f.recipe.parts.map(({ paint: _, ...p }) => p), allowedOperations: ['rect', 'line', 'pixels'] };
  const directed = await ports.validate('director', JSON.stringify(director), prepared).promise;
  assert.equal(directed.kind, 'director'); if (directed.kind !== 'director') throw Error('Fixture director');
  const built = await ports.validate('builder', JSON.stringify({ version: 1, description: 'Nguồn', recipe: f.recipe }), prepared, directed.director).promise;
  assert.equal(built.kind, 'variant'); if (built.kind !== 'variant') throw Error('Fixture builder');
  return { f, snapshot, prepared, parent: built.variant };
}
const stroke = (x: number, color: number | null = 1) => ({ patches: [{ frameId: 'carry', pixelEdits: [{ x, y: 8, color }] }], lockedFrames: [] as string[], region: null });

test('local worker retouch keeps parent/protection immutable and materializes exact final PNG and baked asset', async () => {
  const runtime = new QualityRuntime();
  try {
    const x = await base(runtime), id = x.prepared.snapshotId;
    const parentBefore = runtime.candidateRecipe(id, x.parent.id);
    const edited = await runtime.retouch(id, x.parent.id, 7, { ...stroke(5), lockedFrames: ['rest'], region: { x: 4, y: 7, w: 4, h: 3 } }).promise;
    assert.equal(edited.kind, 'edited'); assert.equal(edited.parentVariantId, x.parent.id);
    assert.deepEqual(edited.frames.map(f => [f.id, f.durationMs]), [['rest', 100], ['carry', 120]]);
    const info = await runtime.retouchInfo(id, edited.id, 7, 'carry').promise as any;
    assert.deepEqual(info.pixelEdits, [{ x: 5, y: 8, color: 1 }]);
    assert.deepEqual(info.constraints, { lockedFrames: ['rest'], region: { x: 4, y: 7, w: 4, h: 3 } });
    assert.deepEqual(info.sourceLockedFrames, ['rest']);
    assert.deepEqual(decodeQualityPng(Buffer.from(info.movementMask, 'base64')).pixels, Uint32Array.from(x.snapshot.movementMask!, n => n ? 0xffffffff : 0));
    const baseline = createRecipeRenderer(compileMotionRecipe(x.f.recipe, x.f.rig, x.f.plan).recipe).renderFrame('carry').image.data;
    const expected = baseline.slice(); expected[8 * 16 + 5] = x.f.recipe.palette[1];
    assert.deepEqual(decodeQualityPng((await runtime.materialize(id, edited.id, 7, 'carry').promise).data).pixels, expected);
    assert.deepEqual(decodeQualityPng((await runtime.materialize(id, x.parent.id, 7, 'carry').promise).data).pixels, baseline);
    assert.deepEqual(runtime.candidateRecipe(id, x.parent.id), parentBefore);
    const { asset } = wireParse(Buffer.from((await runtime.materialize(id, edited.id, 7).promise).data).toString('utf8')) as { asset: PixelAsset };
    assert.deepEqual(composite(asset, asset.frames[0].id).data, x.snapshot.source.pixels);
    assert.deepEqual(composite(asset, asset.frames[1].id).data, expected);
    assert.deepEqual(loadSource(asset.source!.files['art.px.js']).frames('quality-result')[1].img.data, expected);
    info.pixelEdits[0].x = 0; info.constraints.lockedFrames.length = 0;
    const fresh = await runtime.retouchInfo(id, edited.id, 7, 'carry').promise as any;
    assert.equal(fresh.pixelEdits[0].x, 5); assert.deepEqual(fresh.constraints.lockedFrames, ['rest']);
  } finally { runtime.close(true); }
});

test('descendants cannot widen parent region or drop locks; source approval remains independent of local constraints', async () => {
  const runtime = new QualityRuntime();
  try {
    const x = await base(runtime), id = x.prepared.snapshotId;
    const local = await runtime.retouch(id, x.parent.id, 7, { ...stroke(5), region: { x: 4, y: 7, w: 4, h: 3 } }).promise;
    await assert.rejects(runtime.retouch(id, local.id, 7, stroke(8)).promise, /ngoài vùng/);
    await assert.rejects(runtime.retouch(id, x.parent.id, 7, { patches: [{ frameId: 'rest', pixelEdits: [{ x: 4, y: 4, color: 1 }] }], lockedFrames: [], region: null }).promise, /frame khóa/);
    const locked = await runtime.retouch(id, local.id, 7, { patches: [], lockedFrames: ['carry'], region: null }).promise;
    await assert.rejects(runtime.retouch(id, locked.id, 7, stroke(6)).promise, /frame khóa/);
    const info = await runtime.retouchInfo(id, locked.id, 7, 'carry').promise as any;
    assert.deepEqual(info.constraints, { lockedFrames: ['carry'], region: { x: 4, y: 7, w: 4, h: 3 } });
    assert.throws(() => runtime.retouch(id, local.id, 8, stroke(6)), /revision/i);
    assert.throws(() => runtime.retouch(id, 'foreign', 7, stroke(6)), /khớp|thuộc/);
    assert.throws(() => runtime.retouchInfo(id, local.id, 8, 'carry'), /revision/i);
    await assert.rejects(runtime.retouchInfo(id, local.id, 7, 'missing').promise);
  } finally { runtime.close(true); }
});

test('an immediately cancelled retouch worker stops without changing or deleting its parent', async () => {
  const runtime = new QualityRuntime();
  try {
    const x = await base(runtime), id = x.prepared.snapshotId, before = runtime.candidateRecipe(id, x.parent.id);
    const task = runtime.retouch(id, x.parent.id, 7, stroke(5));
    const rejected = assert.rejects(task.promise);
    assert.equal(await task.stop(Date.now() + 5000), true); await rejected;
    assert.equal(await runtime.drain(id, Date.now() + 5000), true);
    assert.deepEqual(runtime.candidateRecipe(id, x.parent.id), before);
  } finally { runtime.close(true); }
});
