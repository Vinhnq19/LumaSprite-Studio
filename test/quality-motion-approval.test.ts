import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { walkFixture } from './fixtures/quality-walk.ts';
import { createWalkPlan } from '../src/studio/quality/motion-walk.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { qualityRgbaHash } from '../src/node/studio/quality-digest.ts';
import { createMotionApproval, assertMotionApproval, verifyMotionCandidate, type MotionApprovalSnapshot } from '../src/node/studio/motion-approval.ts';
import { startRender } from '../src/node/studio/runner.ts';
import type { ExportResult } from '../src/node/studio/render.ts';
import { wireParse, composite, type PixelAsset } from '../src/studio/pixel/model.ts';
import { loadSource } from '../src/node/load.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { newDocument } from '../src/studio/pixel/model.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';
import { decodeQualityPng } from './quality-image-fixture.ts';

function snapshot(): MotionApprovalSnapshot {
  const f = motionFixture(), pixels = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
  f.rig.source.rgbaSha256 = qualityRgbaHash(pixels);
  f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const mask = new Uint8Array(256);
  for (let y = 3; y <= 9; y++) for (let x = 4; x <= 11; x++) mask[y * 16 + x] = 1;
  return { recipe: f.recipe, rig: f.rig, plan: f.plan, source: { projectId: 'project', assetId: 'source', frameId: 'source-frame', revision: 7, pixels },
    resources: { sources: [], masks: [] }, movementMask: mask, frozenFrames: [{ frameId: 'rest', pixels: pixels.slice() }] };
}

function walkingSnapshot(withLimbPixels = true): MotionApprovalSnapshot {
  const f = walkFixture(); if (!withLimbPixels) for (const part of f.recipe.parts) if (part.id !== 'root') part.paint = [];
  const pixels = createRecipeRenderer(f.recipe).renderFrame('f0').image.data; f.rig.source.rgbaSha256 = qualityRgbaHash(pixels);
  const motion = createWalkPlan(f, { legIds: ['a', 'b'], armIds: [], stridePx: 4, liftPx: 3, crouchPx: 2, armSwingDegrees: 0, rootMotion: false });
  return { ...motion, source: { projectId: 'p', assetId: 'a', frameId: 'f0', revision: 1, pixels }, resources: { sources: [], masks: [] }, movementMask: null, frozenFrames: [] };
}

test('actual limb art gates: source approval refuses a moving rig whose limbs have no pixels', () => {
  assert.throws(() => createMotionApproval(walkingSnapshot(false)));
});

test('actual limb art gates: a candidate cannot erase a bound knee while retaining approved graph/timing', () => {
  const s = walkingSnapshot(), approval = createMotionApproval(s), candidate = structuredClone(s.recipe) as ReturnType<typeof walkFixture>['recipe'];
  candidate.parts.find(p => p.id === 'knee-a')!.paint = [];
  assert.throws(() => verifyMotionCandidate(approval, s, candidate));
});
test('approval captures normalized source/parts/rig/plan/mask/frame locks and actual final pixels pass', () => {
  const s = snapshot(), approved = createMotionApproval(s), verified = verifyMotionCandidate(approved, s, s.recipe);
  assert.equal(approved.revision, 7); assert.equal(verified.frameHashes.length, 2);
  const renderer = createRecipeRenderer(verified.recipe), rest = renderer.renderFrame('rest').image, carry = renderer.renderFrame('carry').image;
  assert.deepEqual(rest.data, s.source.pixels);
  for (let i = 0; i < 256; i++) if (!s.movementMask![i]) assert.equal(carry.data[i], s.source.pixels[i]);
  assert.equal(carry.get(7, 6), 0xeef7f8ff);
});
test('a changed revision, source, source identity, rig, pose, mask or locked-frame content invalidates the old receipt', () => {
  const edits: ((s: any) => void)[] = [s => s.source.revision++, s => s.source.pixels[0] = 0x354557ff, s => s.source.projectId = 'other',
    s => s.rig.joints[1].maxRotation = 179, s => s.plan.frames[1].rotations[0].degrees = 89,
    s => s.movementMask[0] = 1, s => s.frozenFrames[0].pixels[0] = 0x354557ff,
    s => s.recipe.palette.reverse(), s => s.recipe.pivot.x++, s => s.recipe.frames[1].durationMs++];
  for (const edit of edits) {
    const s = snapshot(), receipt = createMotionApproval(s); edit(s);
    assert.throws(() => assertMotionApproval(receipt, s));
  }
});
test('resource bytes including an unused motif are part of the approval, not just their ID', () => {
  const s = snapshot(); s.resources = { sources: [{ id: 'unused', w: 1, h: 1, pixels: new Uint32Array([0x354557ff]) }], masks: [] };
  const receipt = createMotionApproval(s); s.resources.sources[0].pixels[0] = 0xeef7f8ff;
  assert.throws(() => assertMotionApproval(receipt, s), /đã đổi/);
});
test('approval refuses fabricated source hashes, masks and parts that do not recompose the approved rest source', () => {
  const edits: ((s: any) => void)[] = [s => s.rig.source.rgbaSha256 = '1'.repeat(64), s => s.movementMask.fill(0), s => s.movementMask[0] = 2,
    s => s.frozenFrames.push(s.frozenFrames[0]), s => s.recipe.parts[0].paint[0].color = 1,
    s => s.source.pixels[0] = 0x35455780];
  for (const edit of edits) { const s = snapshot(); edit(s); assert.throws(() => createMotionApproval(s)); }
});
test('candidate cannot change frame locks, outside-mask pixels, timing, hierarchy or palette even if its rig math is valid', () => {
  const s = snapshot(), receipt = createMotionApproval(s);
  const outside = structuredClone(s.recipe) as any; outside.parts[0].paint.push({ kind: 'pixels', pixels: [{ x: 0, y: 0, color: 0 }] });
  assert.throws(() => verifyMotionCandidate(receipt, s, outside), /frame khóa|ngoài vùng/);
  const noFrozen = snapshot(); noFrozen.frozenFrames = []; const other = createMotionApproval(noFrozen);
  assert.throws(() => verifyMotionCandidate(other, noFrozen, outside), /ngoài vùng/);
  const within = structuredClone(s.recipe) as any; within.parts[3].paint[0].color = 0;
  assert.throws(() => verifyMotionCandidate(receipt, s, within), /frame khóa/);
  for (const edit of [(c: any) => c.frames[0].durationMs = 99, (c: any) => c.parts[2].parentId = null, (c: any) => c.palette.reverse()]) {
    const c = structuredClone(s.recipe); edit(c); assert.throws(() => verifyMotionCandidate(receipt, s, c), /cấu trúc/);
  }
});
test('whole-character scope permits local repaint when no frame is locked, while retaining source and fixed plan', () => {
  const s = snapshot(); s.movementMask = null; s.frozenFrames = [];
  const receipt = createMotionApproval(s), candidate = structuredClone(s.recipe) as any;
  candidate.parts[3].paint[0].color = 0;
  const verified = verifyMotionCandidate(receipt, s, candidate);
  assert.equal(createRecipeRenderer(verified.recipe).renderFrame('carry').image.get(7, 6), 0x354557ff);
  assert.equal((s.recipe as any).parts[3].paint[0].color, 1);
});
test('worker skeleton preview, pixel render, protected asset and baked source share the same controlled motion', async () => {
  const s = snapshot(), approval = createMotionApproval(s), motion = { rig: s.rig, plan: s.plan };
  const run = async (request: Parameters<typeof startRender>[0]) => wireParse(Buffer.from((await startRender(request).promise as ExportResult).data).toString('utf8'));
  const geometry = await run({ mode: 'quality-render', revision: 7, operation: 'geometry', recipe: s.recipe, resources: s.resources, motion, frameId: 'carry' });
  assert.deepEqual(geometry.geometry.joints.wrist, { x: 7, y: 6 });
  const inspect = await run({ mode: 'quality-render', revision: 7, operation: 'inspect', recipe: s.recipe, resources: s.resources, motion });
  assert.equal(inspect.motion.rigId, 'rig'); assert.equal(inspect.motion.frames[1].attachmentError, 0);
  const verified = await run({ mode: 'quality-render', revision: 7, operation: 'motion-verify', recipe: s.recipe, snapshot: s, approval });
  const result = await run({ mode: 'quality-render', revision: 7, operation: 'motion-asset', recipe: s.recipe, snapshot: s, approval });
  const asset = result.asset as PixelAsset, legacy = loadSource(asset.source!.files['art.px.js']).frames('quality-result');
  for (let i = 0; i < 2; i++) {
    const img = composite(asset, asset.frames[i].id);
    assert.equal(qualityRgbaHash(img.data), verified.frameHashes[i].rgbaSha256); assert.equal(qualityRgbaHash(img.data), inspect.frames[i].rgbaSha256);
    assert.deepEqual(legacy[i].img.data, img.data); assert.equal(legacy[i].ms, asset.frames[i].duration);
  }
  await assert.rejects(startRender({ mode: 'quality-render', revision: 8, operation: 'motion-asset', recipe: s.recipe, snapshot: s, approval }).promise, /Revision/);
});
test('protected motion survives a fresh store reopen and PNG/atlas retain exact pixels, UVs, timing, pivot and loop', async () => {
  const s = snapshot(), approval = createMotionApproval(s), root = mkdtempSync(join(tmpdir(), 'pxl-quality-motion-test-'));
  try {
    const response = await startRender({ mode: 'quality-render', revision: 7, operation: 'motion-asset', recipe: s.recipe, snapshot: s, approval }).promise as ExportResult;
    const { asset } = wireParse(Buffer.from(response.data).toString('utf8')) as { asset: PixelAsset };
    const expected = asset.frames.map(f => composite(asset, f.id).data.slice());
    const doc = newDocument('Chuyển động kiểm thử'); doc.assets = [asset];
    const store = new PixelStore(root), saved = store.create(doc.name, 16, 16, 0, doc);
    const opened = new PixelStore(root).load(saved.id, true), restored = opened.assets[0];
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(composite(restored, restored.frames[i].id).data, expected[i]);
      const png = decodeQualityPng(exportPixel({ document: opened, assetId: restored.id, frameId: restored.frames[i].id, format: 'png' }).data);
      assert.deepEqual(png.pixels, expected[i]);
      for (let j = 0; j < 256; j++) if (!s.movementMask![j]) assert.equal(png.pixels[j], s.source.pixels[j]);
    }
    for (const format of ['strip', 'atlas'] as const) {
      const zip = Buffer.from(exportPixel({ document: opened, assetId: restored.id, selected: [restored.id], format }).data), files = new Map<string, Buffer>();
      for (let offset = 0; offset + 30 < zip.length && zip.readUInt32LE(offset) === 0x04034b50;) {
        assert.equal(zip.readUInt16LE(offset + 8), 0);
        const size = zip.readUInt32LE(offset + 18), length = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28), start = offset + 30 + length + extra;
        files.set(zip.toString('utf8', offset + 30, offset + 30 + length), zip.subarray(start, start + size)); offset = start + size;
      }
      const atlas = decodeQualityPng(files.get('image.png')!), meta = JSON.parse(files.get('image.json')!.toString('utf8'));
      const entries = Object.values(meta.frames) as { frame: { x: number; y: number; w: number; h: number }; duration: number }[];
      entries.forEach((entry, i) => {
        const pixels = new Uint32Array(256), rect = entry.frame;
        assert.deepEqual([rect.w, rect.h], [16, 16]); assert.equal(entry.duration, restored.frames[i].duration);
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[y * 16 + x] = atlas.pixels[(rect.y + y) * atlas.w + rect.x + x];
        assert.deepEqual(pixels, expected[i], 'UV excludes atlas extrusion and keeps native RGBA');
      });
      assert.equal(meta.meta.frameTags[0].loop, true); assert.deepEqual(meta.meta.pxl.assets[restored.id].pivot, { x: 0.5, y: 1 });
      assert.equal(meta.meta.pxl.revision, opened.revision);
    }
  } finally {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
