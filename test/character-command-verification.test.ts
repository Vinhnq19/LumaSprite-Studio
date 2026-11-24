import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, composite } from '../src/studio/pixel/model.ts';
import { createCharacterProfile, approveCharacterProfile, recaptureCharacterProfile } from '../src/studio/character-commands.ts';
import { checkCharacterReadiness } from '../src/studio/characters.ts';

test('Character command verification: source pivot converts native normalized metadata to pixels and defaults to bottom center', () => {
  const d = newDocument('Điểm neo', 18, 18), a = d.assets[0]; a.metadata.pivot = { x: .25, y: .75 };
  const p = createCharacterProfile(d, { name: 'Có neo', assetId: a.id, frameId: a.frames[0].id });
  assert.deepEqual(p.source.pivot, { x: 4.5, y: 13.5 });
  const blank = newDocument('Neo mặc định', 18, 18), b = blank.assets[0];
  const bottom = createCharacterProfile(blank, { name: 'Mặc định', assetId: b.id, frameId: b.frames[0].id });
  assert.deepEqual(bottom.source.pivot, { x: 9, y: 18 });
});

test('Character command verification: explicit reapproval and recapture refresh current palette and pivot without editing the native asset', () => {
  const d = newDocument('Duyệt lại', 18, 18), a = d.assets[0]; a.metadata.pivot = { x: .25, y: .75 };
  const p = createCharacterProfile(d, { name: 'Nguồn', assetId: a.id, frameId: a.frames[0].id, pivot: { x: 4.5, y: 13.5 } });
  a.palette = [0x445566ff]; a.metadata.pivot = { x: .5, y: 1 };
  const original = structuredClone(a); approveCharacterProfile(d, p.id);
  assert.deepEqual(p.source.palette, a.palette); assert.deepEqual(p.source.pivot, { x: 9, y: 18 }); assert.deepEqual(a, original);
  a.palette = [0xaabbccff]; a.metadata.pivot = { x: .25, y: .5 };
  recaptureCharacterProfile(d, p.id);
  assert.deepEqual(p.source.palette, a.palette); assert.deepEqual(p.source.pivot, { x: 4.5, y: 9 }); assert.equal(p.approved, false);
});

test('Character command verification: ready requires complete current metadata and full-size pixel arrays', () => {
  const d = newDocument('Đối chiếu', 18, 18), a = d.assets[0];
  const p = createCharacterProfile(d, { name: 'Nguồn', assetId: a.id, frameId: a.frames[0].id }); approveCharacterProfile(d, p.id);
  const complete = { profile: p, sourceResourceData: d.studio!.resources![p.source.rgbaResourceId].data!, currentComposite: composite(a, a.frames[0].id).data, currentWidth: 18, currentHeight: 18, currentPalette: [...p.source.palette], currentPivot: { ...p.source.pivot } };
  assert.equal(checkCharacterReadiness(complete).status, 'ready');
  for (const key of ['currentWidth', 'currentHeight', 'currentPalette', 'currentPivot']) {
    const incomplete: any = { ...complete }; delete incomplete[key];
    assert.notEqual(checkCharacterReadiness(incomplete).status, 'ready', `${key} is required to prove readiness`);
  }
  assert.notEqual(checkCharacterReadiness({ ...complete, sourceResourceData: new Uint32Array(2), currentComposite: new Uint32Array(2) }).status, 'ready');
});
