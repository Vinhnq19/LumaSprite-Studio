import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  newDocument,
  celFor,
  validateDocument,
  type PixelDocument,
} from '../src/studio/pixel/model.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';
import {
  createCharacterProfile,
  approveCharacterProfile,
  recaptureCharacterProfile,
  addCharacterLandmark,
  removeCharacterProfile,
  removeCharacterLandmark,
  captureVisibleComposite,
} from '../src/studio/character-commands.ts';
import {
  CLIP_VERSION,
  MAX_CLIPS,
  MIN_CLIP_SLOTS,
  MAX_CLIP_SLOTS,
  MIN_SLOT_DURATION,
  MAX_SLOT_DURATION,
  validateClipId,
  validateSlotId,
  validateCharacterClip,
  validateClipMap,
  cloneCharacterClip,
  cloneClipMap,
  checkClipReadiness,
  type CharacterClip,
} from '../src/studio/clips.ts';
import { resolvePixelPivot } from '../src/studio/characters.ts';
import {
  ensureClipExtension,
  createClip,
  renameClip,
  removeClip,
  updateClipMetadata,
  setClipMovementMask,
  addClipSlot,
  duplicateClipSlot,
  removeClipSlot,
  reorderClipSlots,
  setSlotDuration,
  setClipDurations,
  setSlotSelection,
  setSlotFrozen,
  setSlotKeyframe,
  updateSlotPose,
  resetSlotPose,
  captureNativeFrameToSlot,
  applySlotBaseline,
} from '../src/studio/clip-commands.ts';

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'pxl-clip-unit-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

function createBaseFixture(): { doc: PixelDocument; heroId: string; assetId: string; frameId: string } {
  const doc = newDocument('Clip Model Test', 16, 16);
  const asset = doc.assets[0];
  const frameId = asset.frames[0].id;
  celFor(asset, asset.layers[0].id, frameId, true)!.data![0] = 0x112233ff;

  ensureClipExtension(doc);
  const profile = createCharacterProfile(doc, {
    id: 'hero',
    name: 'Hero',
    assetId: asset.id,
    frameId,
  });
  addCharacterLandmark(doc, profile.id, 'head', { name: 'Đầu', x: 8, y: 2 });
  addCharacterLandmark(doc, profile.id, 'root', { name: 'Gốc', x: 8, y: 14 });
  approveCharacterProfile(doc, profile.id);

  return { doc, heroId: profile.id, assetId: asset.id, frameId };
}

test('Clip model constants and ID validation', () => {
  assert.equal(CLIP_VERSION, 1);
  assert.equal(MAX_CLIPS, 16);
  assert.equal(MIN_CLIP_SLOTS, 2);
  assert.equal(MAX_CLIP_SLOTS, 24);
  assert.equal(MIN_SLOT_DURATION, 1);
  assert.equal(MAX_SLOT_DURATION, 60000);

  assert.equal(validateClipId('walk_run-01'), 'walk_run-01');
  assert.equal(validateSlotId('slot_1'), 'slot_1');

  assert.throws(() => validateClipId(''), /không hợp lệ/);
  assert.throws(() => validateClipId('a'.repeat(81)), /không hợp lệ/);
  assert.throws(() => validateClipId('bad name!'), /không hợp lệ/);
  assert.throws(() => validateClipId('constructor'), /dự lưu/);
  assert.throws(() => validateSlotId('__proto__'), /dự lưu/);
});

test('createClip: template creates 4 slots sharing profile master resource and landmark poses', () => {
  const { doc, heroId } = createBaseFixture();
  const masterRes = doc.studio!.characters![heroId].source.rgbaResourceId;

  const clip = createClip(doc, {
    name: 'Idle Clip',
    characterId: heroId,
    template: 'idle',
    mode: 'whole',
  });

  assert.equal(clip.version, 1);
  assert.equal(clip.characterId, heroId);
  assert.equal(clip.template, 'idle');
  assert.equal(clip.mode, 'whole');
  assert.equal(clip.loop, true);
  assert.equal(clip.facing, 'source');
  assert.equal(clip.movementMaskResourceId, undefined);
  assert.equal(clip.slots.length, 4);

  for (const slot of clip.slots) {
    assert.equal(slot.duration, 100);
    assert.equal(slot.selected, true);
    assert.equal(slot.frozen, false);
    assert.equal(slot.keyframe, false);
    assert.equal(slot.rgbaResourceId, masterRes);
    assert.deepEqual(slot.pose, { head: { x: 8, y: 2 }, root: { x: 8, y: 14 } });
  }

  // Master resource is NOT duplicated into 4 buffer clones
  const resCount = Object.keys(doc.studio!.resources!).length;
  assert.equal(resCount, 1);
});

test('createClip: requires approved character profile', () => {
  const { doc, heroId } = createBaseFixture();
  recaptureCharacterProfile(doc, heroId);
  assert.equal(doc.studio!.characters![heroId].approved, false);

  assert.throws(
    () => createClip(doc, { name: 'Walk', characterId: heroId, mode: 'whole' }),
    /chưa được phê duyệt/
  );
});

test('createClip: region mode requires valid nonempty movement mask', () => {
  const { doc, heroId } = createBaseFixture();

  // Region mode without mask throws
  assert.throws(
    () => createClip(doc, { name: 'Region Clip', characterId: heroId, mode: 'region' }),
    /cần có mặt nạ di chuyển/
  );

  // Region mode with empty mask throws
  const emptyMask = new Uint32Array(16 * 16);
  assert.throws(
    () => createClip(doc, {
      name: 'Region Clip',
      characterId: heroId,
      mode: 'region',
      movementMaskSelection: emptyMask,
    }),
    /không được rỗng/
  );

  // Region mode with valid selection succeeds
  const validMask = new Uint32Array(16 * 16);
  validMask[0] = 1;
  const clip = createClip(doc, {
    name: 'Region Clip',
    characterId: heroId,
    mode: 'region',
    movementMaskSelection: validMask,
  });

  assert.ok(clip.movementMaskResourceId);
  const maskRes = doc.studio!.resources![clip.movementMaskResourceId];
  assert.equal(maskRes.kind, 'mask');
  assert.equal(maskRes.w, 16);
  assert.equal(maskRes.h, 16);

  // Whole mode with movement mask throws
  assert.throws(
    () => createClip(doc, {
      name: 'Whole With Mask',
      characterId: heroId,
      mode: 'whole',
      movementMaskResourceId: clip.movementMaskResourceId,
    }),
    /không được chứa mặt nạ di chuyển/
  );
});

test('Slot management: add, duplicate, remove, reorder, and slot limits (2..24)', () => {
  const { doc, heroId } = createBaseFixture();
  const clip = createClip(doc, {
    name: 'Action Clip',
    characterId: heroId,
    mode: 'whole',
    slotCount: 2,
  });
  assert.equal(clip.slots.length, 2);

  // Duplicate slot creates fresh unique ID
  const dup = duplicateClipSlot(doc, clip.id, clip.slots[0].id);
  assert.equal(clip.slots.length, 3);
  assert.notEqual(dup.id, clip.slots[0].id);
  assert.equal(clip.slots[1].id, dup.id);
  assert.equal(dup.duration, clip.slots[0].duration);

  // Add slot
  const added = addClipSlot(doc, clip.id, { duration: 150 });
  assert.equal(clip.slots.length, 4);
  assert.equal(added.duration, 150);

  // Reorder slots
  const ids = clip.slots.map(s => s.id);
  const reversed = [...ids].reverse();
  reorderClipSlots(doc, clip.id, reversed);
  assert.deepEqual(clip.slots.map(s => s.id), reversed);

  // Cannot remove below 2 slots
  removeClipSlot(doc, clip.id, clip.slots[0].id);
  removeClipSlot(doc, clip.id, clip.slots[0].id);
  assert.equal(clip.slots.length, 2);
  assert.throws(() => removeClipSlot(doc, clip.id, clip.slots[0].id), /ít nhất 2 slot/);

  // Fill up to 24 slots
  while (clip.slots.length < 24) {
    addClipSlot(doc, clip.id);
  }
  assert.equal(clip.slots.length, 24);

  // Cannot add beyond 24 slots
  assert.throws(() => addClipSlot(doc, clip.id), /vượt quá giới hạn tối đa 24/);
  assert.throws(() => duplicateClipSlot(doc, clip.id, clip.slots[0].id), /vượt quá giới hạn tối đa 24/);
});

test('Slot timing, selection, freeze, and keyframe state', () => {
  const { doc, heroId } = createBaseFixture();
  const clip = createClip(doc, { name: 'States', characterId: heroId, mode: 'whole', slotCount: 3 });

  // Duration edits: single and group
  setSlotDuration(doc, clip.id, clip.slots[0].id, 250);
  assert.equal(clip.slots[0].duration, 250);
  assert.throws(() => setSlotDuration(doc, clip.id, clip.slots[0].id, 0), /từ 1 đến 60000/);

  setClipDurations(doc, clip.id, 300, [clip.slots[1].id, clip.slots[2].id]);
  assert.equal(clip.slots[1].duration, 300);
  assert.equal(clip.slots[2].duration, 300);

  // Freezing clears selection
  assert.equal(clip.slots[0].selected, true);
  setSlotFrozen(doc, clip.id, clip.slots[0].id, true);
  assert.equal(clip.slots[0].frozen, true);
  assert.equal(clip.slots[0].selected, false);

  // Selecting a frozen slot throws
  assert.throws(
    () => setSlotSelection(doc, clip.id, clip.slots[0].id, true),
    /đóng băng/
  );

  // Unfreezing allows selection
  setSlotFrozen(doc, clip.id, clip.slots[0].id, false);
  assert.equal(clip.slots[0].frozen, false);
  setSlotSelection(doc, clip.id, clip.slots[0].id, true);
  assert.equal(clip.slots[0].selected, true);

  // Keyframe toggle
  setSlotKeyframe(doc, clip.id, clip.slots[0].id, true);
  assert.equal(clip.slots[0].keyframe, true);
});

test('Slot pose editing and reset', () => {
  const { doc, heroId } = createBaseFixture();
  const clip = createClip(doc, { name: 'Pose Clip', characterId: heroId, mode: 'whole' });

  // Update landmark position
  updateSlotPose(doc, clip.id, clip.slots[0].id, { head: { x: 10, y: 3 } });
  assert.deepEqual(clip.slots[0].pose.head, { x: 10, y: 3 });

  // Invalid coordinates: out of bounds or non-integer
  assert.throws(
    () => updateSlotPose(doc, clip.id, clip.slots[0].id, { head: { x: 16, y: 3 } }),
    /vượt ngoài phạm vi/
  );
  assert.throws(
    () => updateSlotPose(doc, clip.id, clip.slots[0].id, { head: { x: 5.5, y: 3 } }),
    /số nguyên/
  );
  assert.throws(
    () => updateSlotPose(doc, clip.id, clip.slots[0].id, { nonExistent: { x: 5, y: 3 } }),
    /không tồn tại/
  );

  // Reset pose back to profile landmarks
  resetSlotPose(doc, clip.id, clip.slots[0].id);
  assert.deepEqual(clip.slots[0].pose.head, { x: 8, y: 2 });
  assert.deepEqual(clip.slots[0].pose.root, { x: 8, y: 14 });
});

test('Native frame capture to slot: preserves exact RGBA and marks keyframe', () => {
  const { doc, heroId, assetId, frameId } = createBaseFixture();
  const clip = createClip(doc, { name: 'Capture Clip', characterId: heroId, mode: 'whole' });

  const slot = clip.slots[0];
  const oldMaster = slot.rgbaResourceId;
  assert.equal(slot.keyframe, false);

  captureNativeFrameToSlot(doc, clip.id, slot.id, assetId, frameId);

  assert.notEqual(slot.rgbaResourceId, oldMaster);
  assert.equal(slot.keyframe, true);

  const capturedRes = doc.studio!.resources![slot.rgbaResourceId];
  assert.equal(capturedRes.kind, 'rgba');
  assert.equal(capturedRes.w, 16);
  assert.equal(capturedRes.h, 16);
  assert.equal(capturedRes.data![0], 0x112233ff);
});

test('applySlotBaseline: updates slot RGBA resource', () => {
  const { doc, heroId } = createBaseFixture();
  const clip = createClip(doc, { name: 'Apply Baseline', characterId: heroId, mode: 'whole' });

  const pixels = new Uint32Array(16 * 16);
  pixels[5] = 0xaabbccff;

  applySlotBaseline(doc, clip.id, clip.slots[0].id, pixels);
  const newRes = doc.studio!.resources![clip.slots[0].rgbaResourceId];
  assert.equal(newRes.data![5], 0xaabbccff);
});

test('checkClipReadiness preflight with source evidence', () => {
  const { doc, heroId, assetId, frameId } = createBaseFixture();
  const clip = createClip(doc, { name: 'Preflight', characterId: heroId, mode: 'whole' });
  const asset = doc.assets[0];
  const master = doc.studio!.resources![doc.studio!.characters![heroId].source.rgbaResourceId];

  const evidence = {
    sourceResourceData: master.data!,
    currentComposite: captureVisibleComposite(asset, frameId),
    currentWidth: asset.w,
    currentHeight: asset.h,
    currentPalette: asset.palette,
    currentPivot: resolvePixelPivot(asset.metadata.pivot, asset.w, asset.h),
  };

  // Ready with complete evidence
  let r = checkClipReadiness(clip, doc, evidence);
  assert.equal(r.ready, true);
  assert.equal(r.selectedUnlockedCount, 4);

  // All frozen -> not ready to start, but saveable draft
  for (const s of clip.slots) {
    setSlotFrozen(doc, clip.id, s.id, true);
  }
  r = checkClipReadiness(clip, doc, evidence);
  assert.equal(r.ready, false);
  assert.match(r.reason!, /Cần ít nhất một slot/);
  // Valid document allows saving draft
  validateDocument(doc);

  // Unfreeze one -> ready
  setSlotFrozen(doc, clip.id, clip.slots[0].id, false);
  setSlotSelection(doc, clip.id, clip.slots[0].id, true);
  r = checkClipReadiness(clip, doc, evidence);
  assert.equal(r.ready, true);
  assert.equal(r.selectedUnlockedCount, 1);

  // Stale evidence -> not ready
  const staleEvidence = { ...evidence, currentComposite: new Uint32Array(16 * 16) };
  r = checkClipReadiness(clip, doc, staleEvidence);
  assert.equal(r.ready, false);
  assert.equal(r.status, 'stale');

  // Unapprove character -> not ready
  recaptureCharacterProfile(doc, heroId);
  r = checkClipReadiness(clip, doc, evidence);
  assert.equal(r.ready, false);
  assert.match(r.reason!, /chưa được phê duyệt/);
  // Document remains valid draft!
  validateDocument(doc);
});

test('Dependency guards: block deleting referenced profile or landmark', () => {
  const { doc, heroId } = createBaseFixture();
  createClip(doc, { name: 'Guarded Clip', characterId: heroId, mode: 'whole' });

  // Block removing character profile
  assert.throws(
    () => removeCharacterProfile(doc, heroId),
    /đang được tham chiếu bởi clip/
  );

  // Block removing landmark referenced in pose
  assert.throws(
    () => removeCharacterLandmark(doc, heroId, 'head'),
    /đang được tham chiếu trong pose của clip/
  );
});

test('PixelHistory: undo and redo with clip pure commands', () => {
  const { doc, heroId } = createBaseFixture();
  const history = new PixelHistory();

  // Commit clip creation
  const beforeCreate = snapshot(doc);
  const clip = createClip(doc, { name: 'History Clip', characterId: heroId, mode: 'whole' });
  history.commit(beforeCreate, doc, 'Tạo clip');
  assert.ok(doc.studio?.clips?.[clip.id]);

  // Rename clip
  const beforeRename = snapshot(doc);
  renameClip(doc, clip.id, 'Renamed Clip');
  history.commit(beforeRename, doc, 'Đổi tên clip');
  assert.equal(clip.name, 'Renamed Clip');

  // Undo rename
  history.undo(doc);
  assert.equal(doc.studio?.clips?.[clip.id].name, 'History Clip');

  // Redo rename
  history.undo(doc, true);
  assert.equal(doc.studio?.clips?.[clip.id].name, 'Renamed Clip');

  // Add slot with history
  const beforeAdd = snapshot(doc);
  const added = addClipSlot(doc, clip.id, { duration: 180 });
  history.commit(beforeAdd, doc, 'Thêm slot');
  assert.equal(doc.studio?.clips?.[clip.id].slots.length, 5);

  // Undo slot addition
  history.undo(doc);
  assert.equal(doc.studio?.clips?.[clip.id].slots.length, 4);

  // Redo slot addition
  history.undo(doc, true);
  assert.equal(doc.studio?.clips?.[clip.id].slots.length, 5);
});

test('cloneCharacterClip and cloneClipMap', () => {
  const { doc, heroId } = createBaseFixture();
  const clip = createClip(doc, { name: 'Clone Me', characterId: heroId, mode: 'whole' });
  const cloned = cloneCharacterClip(clip);

  assert.deepEqual(cloned, clip);
  assert.notEqual(cloned, clip);
  assert.notEqual(cloned.slots, clip.slots);
  assert.notEqual(cloned.slots[0].pose, clip.slots[0].pose);

  const map = { [clip.id]: clip };
  const clonedMap = cloneClipMap(map);
  assert.deepEqual(clonedMap, map);
  assert.notEqual(clonedMap, map);
});
