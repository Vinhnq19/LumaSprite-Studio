import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, celFor, wireStringify } from '../src/studio/pixel/model.ts';
import { ensureCharacterExtension, createCharacterProfile, approveCharacterProfile, addCharacterLandmark, captureVisibleComposite } from '../src/studio/character-commands.ts';
import { checkClipReadiness } from '../src/studio/clips.ts';
import { resolvePixelPivot } from '../src/studio/characters.ts';
import { createClip, ensureClipExtension, setSlotFrozen, applySlotBaseline, captureNativeFrameToSlot,
  setClipDurations, updateSlotPose, addClipSlot } from '../src/studio/clip-commands.ts';
import { setClipMovementMask } from '../src/studio/clip-commands.ts';

function fixture() {
  const d = newDocument('Điều kiện tạo clip', 18, 18), a = d.assets[0];
  celFor(a, a.layers[0].id, a.frames[0].id, true)!.data![0] = 0xff0000ff;
  ensureCharacterExtension(d);
  createCharacterProfile(d, { id: 'hero', name: 'Mẫu chuẩn', assetId: a.id, frameId: a.frames[0].id });
  approveCharacterProfile(d, 'hero');
  addCharacterLandmark(d, 'hero', 'hand', { name: 'Tay', x: 5, y: 6 });
  ensureClipExtension(d);
  return d;
}

test('Character and clip tools preserve studio v2 quality and rig metadata, while unknown versions remain refused', () => {
  const d = newDocument('Sau khi duyệt chất lượng', 18, 18, 0xff0000ff), a = d.assets[0];
  d.studio = { version: 2, quality: { version: 1, approvals: {} }, rigDrafts: {} };
  createCharacterProfile(d, { id: 'v2hero', name: 'Nhân vật v2', assetId: a.id, frameId: a.frames[0].id });
  approveCharacterProfile(d, 'v2hero');
  const clip = createClip(d, { id: 'v2clip', name: 'Idle v2', characterId: 'v2hero', mode: 'whole' });
  assert.ok(clip.slots.length >= 2); assert.equal(d.studio.version, 2);
  assert.deepEqual(d.studio.quality!.approvals, {}); assert.deepEqual(d.studio.rigDrafts, {});
  const invalid = structuredClone(d); (invalid.studio as any).version = 99;
  assert.throws(() => ensureCharacterExtension(invalid), /Phiên bản/); assert.throws(() => ensureClipExtension(invalid), /Phiên bản/);
});

test('Clip command verification: omitted movement mode never silently grants whole-character permission', () => {
  const d = fixture(), before = wireStringify(d);
  assert.throws(() => createClip(d, { id: 'new', name: 'Cần chọn vùng', characterId: 'hero' }));
  assert.equal(wireStringify(d), before);
  const explicit = createClip(d, { id: 'whole', name: 'Sửa toàn thân có chọn rõ', characterId: 'hero', mode: 'whole' });
  assert.equal(explicit.mode, 'whole');
});

test('Clip command verification: frozen baselines require explicit unfreeze before capture or replacement', () => {
  const d = fixture(), clip = createClip(d, { id: 'whole', name: 'Đóng băng', characterId: 'hero', mode: 'whole' });
  const slot = clip.slots[0], a = d.assets[0]; setSlotFrozen(d, clip.id, slot.id, true);
  const before = wireStringify(d);
  assert.throws(() => applySlotBaseline(d, clip.id, slot.id, new Uint32Array(324)));
  assert.equal(wireStringify(d), before);
  assert.throws(() => captureNativeFrameToSlot(d, clip.id, slot.id, a.id, a.frames[0].id));
  assert.equal(wireStringify(d), before);
});

test('Clip command verification: invalid group IDs, pose patches and missing RGBA refs reject before any draft mutation', () => {
  const failures: string[] = [];
  for (const fault of ['duration', 'pose', 'resource']) {
    const d = fixture(), clip = createClip(d, { id: 'whole', name: 'Kiểm tra trước', characterId: 'hero', mode: 'whole' });
    const before = wireStringify(d);
    const call = () => {
      if (fault === 'duration') setClipDurations(d, clip.id, 123, [clip.slots[0].id, 'foreign']);
      if (fault === 'pose') updateSlotPose(d, clip.id, clip.slots[0].id, { hand: { x: 7, y: 8 }, foreign: { x: 1, y: 1 } });
      if (fault === 'resource') addClipSlot(d, clip.id, { rgbaResourceId: 'foreign' });
    };
    try { call(); failures.push(fault + ':accepted'); } catch {}
    if (wireStringify(d) !== before) failures.push(fault + ':mutated');
  }
  assert.deepEqual(failures, []);
});

test('Clip command verification: approved flag alone cannot create a clip from changed or missing source pixels', () => {
  for (const fault of ['pixels', 'palette', 'pivot', 'missing-master', 'missing-cel']) {
    const d = fixture(), a = d.assets[0], c = celFor(a, a.layers[0].id, a.frames[0].id)!;
    if (fault === 'pixels') { c.data = c.data!.slice(); c.data[0] = 0x00ff00ff; }
    if (fault === 'palette') a.palette = [0xff0000ff];
    if (fault === 'pivot') a.metadata.pivot = { x: 0.25, y: 0.5 };
    if (fault === 'missing-master') delete d.studio!.resources![d.studio!.characters!.hero.source.rgbaResourceId].data;
    if (fault === 'missing-cel') delete c.data;
    const before = wireStringify(d);
    assert.throws(() => createClip(d, { id: 'new', name: 'Mẫu cần kiểm tra lại', characterId: 'hero', mode: 'whole' }), fault);
    assert.equal(wireStringify(d), before, fault + ' must fail before mutating the document');
  }
});

test('Clip command verification: readiness needs complete source evidence and a loaded exact binary movement mask', () => {
  const d = fixture(), a = d.assets[0], clip = createClip(d, { name: 'Trạng thái sẵn sàng', characterId: 'hero', mode: 'whole' });
  const p = d.studio!.characters!.hero, master = d.studio!.resources![p.source.rgbaResourceId];
  const source = { sourceResourceData: master.data!, currentComposite: captureVisibleComposite(a, a.frames[0].id),
    currentWidth: a.w, currentHeight: a.h, currentPalette: a.palette, currentPivot: resolvePixelPivot(a.metadata.pivot, a.w, a.h) };
  assert.equal(checkClipReadiness(clip, d, source).ready, true);
  const lazy = structuredClone(d); delete lazy.studio!.resources![p.source.rgbaResourceId].data;
  lazy.studio!.resources![p.source.rgbaResourceId].blob = '1'.repeat(64);
  assert.equal(checkClipReadiness(clip, lazy).ready, false, 'A blob reference is not actual source evidence');
  clip.mode = 'region'; clip.movementMaskResourceId = 'move';
  const failures: string[] = [];
  for (const fault of ['unloaded', 'short', 'nonbinary', 'empty', 'dimensions', 'untyped']) {
    const mask = new Uint32Array(324); mask[0] = 1;
    d.studio!.resources!.move = { version: 1, kind: 'mask', w: 18, h: 18, data: mask };
    if (fault === 'unloaded') { delete d.studio!.resources!.move.data; d.studio!.resources!.move.blob = '2'.repeat(64); }
    if (fault === 'short') d.studio!.resources!.move.data = Uint32Array.of(1);
    if (fault === 'nonbinary') d.studio!.resources!.move.data![1] = 2;
    if (fault === 'empty') d.studio!.resources!.move.data!.fill(0);
    if (fault === 'dimensions') { d.studio!.resources!.move.w = 9; d.studio!.resources!.move.h = 36; }
    if (fault === 'untyped') d.studio!.resources!.move.data = Array.from(mask) as any;
    if (checkClipReadiness(clip, d, source).ready) failures.push(fault);
  }
  assert.deepEqual(failures, []);
});

test('Clip command verification: referenced masks require loaded nonempty binary pixels on create and replacement', () => {
  const failures: string[] = [];
  for (const fault of ['empty', 'unloaded', 'short', 'nonbinary']) {
    const d = fixture(), valid = new Uint32Array(324); valid[0] = 1;
    const clip = createClip(d, { name: 'Mặt nạ hợp lệ', characterId: 'hero', mode: 'region', movementMaskSelection: valid });
    d.studio!.resources!.bad = { version: 1, kind: 'mask', w: 18, h: 18, data: new Uint32Array(324) };
    if (fault === 'unloaded') { delete d.studio!.resources!.bad.data; d.studio!.resources!.bad.blob = '3'.repeat(64); }
    if (fault === 'short') d.studio!.resources!.bad.data = Uint32Array.of(1);
    if (fault === 'nonbinary') { d.studio!.resources!.bad.data![0] = 1; d.studio!.resources!.bad.data![1] = 2; }
    for (const action of ['create', 'replace']) {
      const doc = structuredClone(d), before = wireStringify(doc);
      try {
        if (action === 'create') createClip(doc, { name: 'Không chấp nhận mask rỗng', characterId: 'hero', mode: 'region', movementMaskResourceId: 'bad' });
        else setClipMovementMask(doc, clip.id, { resourceId: 'bad' });
        failures.push(fault + ':' + action + ':accepted');
      } catch {}
      if (wireStringify(doc) !== before) failures.push(fault + ':' + action + ':mutated');
    }
  }
  assert.deepEqual(failures, []);
});
