import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateFrame, celFor, composite, newAsset, newLayer, validateDocument, newDocument } from '../src/studio/pixel/model.ts';
import { splitRigPart, addRigLayer } from '../src/studio/quality/rig-parts.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { validateRigDraft } from '../src/studio/quality/rig-draft.ts';

test('Rig part split preserves composite and linked frames, detaches only selected cel and keeps source immutable', () => {
  const a = newAsset('Nguồn', 18, 18, 0x70c989ff), layer = a.layers[0], frame = a.frames[0];
  duplicateFrame(a, frame.id, 'linked'); const other = a.frames[1].id, pixels = composite(a, frame.id).data, before = structuredClone(a);
  const mask = new Uint8Array(324); mask[2 * 18 + 3] = 1; mask[3 * 18 + 3] = 1;
  const split = splitRigPart(a, frame.id, layer.id, mask, 'Cánh tay');
  assert.deepEqual(a, before); assert.equal(split.asset.layers.length, 2); assert.deepEqual(composite(split.asset, frame.id).data, pixels);
  assert.deepEqual(composite(split.asset, other).data, pixels); assert.equal(celFor(split.asset, layer.id, frame.id)!.data![39], 0);
  assert.equal(celFor(split.asset, split.layer.id, frame.id)!.data![39], 0x70c989ff);
  assert.equal(celFor(split.asset, split.layer.id, other), undefined); assert.notEqual(split.asset.layers[0].cels[frame.id], split.asset.layers[0].cels[other]);
  assert.deepEqual(split.pivot, { x: 3, y: 3 }); const d = newDocument('Split'); d.assets = [split.asset]; validateDocument(d);
});
test('Rig part split refuses empty/bad masks, locked/hidden or translucent source layers without mutation', () => {
  const a = newAsset('Nguồn', 18, 18, 0x70c989ff), layer = a.layers[0], frame = a.frames[0], mask = new Uint8Array(324).fill(1);
  assert.throws(() => splitRigPart(a, frame.id, layer.id, new Uint8Array(324), 'Tay'), /Chọn vùng/);
  const bad = mask.slice(); bad[0] = 2; assert.throws(() => splitRigPart(a, frame.id, layer.id, bad, 'Tay'), /hợp lệ/);
  layer.locked = true; assert.throws(() => splitRigPart(a, frame.id, layer.id, mask, 'Tay'), /khóa/); layer.locked = false;
  layer.opacity = 128; assert.throws(() => splitRigPart(a, frame.id, layer.id, mask, 'Tay'), /độ đục/); layer.opacity = 255;
  layer.visible = false; assert.throws(() => splitRigPart(a, frame.id, layer.id, mask, 'Tay'), /đang hiện/);
  assert.equal(a.layers.length, 1); assert.equal(celFor(a, layer.id, frame.id)!.data![0], 0x70c989ff);
});
test('Rig layer placeholders preserve source identity and poses, but do not approve a new part', () => {
  const f = motionFixture(), draft = validateRigDraft({ version: 1, id: 'draft', name: 'Rig', origin: { assetId: 'original', frameId: 'original-frame' }, ...f, resources: { sources: [], masks: [] }, movementMaskResourceId: null, frozenFrames: [] });
  const before = structuredClone(draft), layer = newLayer('Vẽ bù'); const next = addRigLayer(draft, layer, { x: 5, y: 5 }, 'authored');
  assert.deepEqual(draft, before); assert.deepEqual(next.rig.source, before.rig.source); assert.deepEqual(next.recipe.parts.at(-1)!.paint, []);
  assert.equal(next.rig.bindings.at(-1)!.jointId, 'root'); assert.equal(next.recipe.parts.at(-1)!.origin, 'authored');
  assert.ok(next.plan.frames.every(f => f.order.at(-1) === layer.id)); validateRigDraft(next);
});
