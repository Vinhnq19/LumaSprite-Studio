import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMotionEdit,
  applyMotionEdits,
  type MotionEditCommand,
  type MotionEdit,
} from '../src/studio/quality/motion-edit.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';

test('frame edit refuses a swing target instead of silently clearing it', () => {
  const f = motionFixture(); f.rig.chains[0].kind = 'leg';
  const before = structuredClone(f), frame = structuredClone(f.plan.frames[0]);
  frame.contacts = [{ chainId: 'arm', phase: 'swing', target: { x: 8, y: 8 } }];
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.set', frame }]), /vung chân/);
  assert.deepEqual(f, before);
});

test('validateMotionEdit enforces strict root keys and validates recipe, rig, and plan', () => {
  const f = motionFixture();
  const valid = validateMotionEdit(f);
  assert.equal(valid.recipe.name, 'Kiếm sĩ');
  assert.equal(valid.rig.id, 'rig');
  assert.equal(valid.plan.id, 'plan');

  // Extra unsupported keys on root reject
  assert.throws(() => validateMotionEdit({ ...f, extra: true }), /thuộc tính/);
  assert.throws(() => validateMotionEdit({ ...f, approved: true }), /thuộc tính/);
  assert.throws(() => validateMotionEdit({ ...f, receipt: 'receipt-1' }), /thuộc tính/);
  // Missing root keys reject
  assert.throws(() => validateMotionEdit({ recipe: f.recipe, rig: f.rig }), /thuộc tính/);
  // Non-object or getter rejects
  assert.throws(() => validateMotionEdit(null), /object thuần/);
  const getterObj = Object.defineProperty({ recipe: f.recipe, rig: f.rig }, 'plan', {
    get() { return f.plan; },
    enumerable: true,
  });
  assert.throws(() => validateMotionEdit(getterObj), /thuộc tính thiếu hoặc không được hỗ trợ/);
});

test('invalid/cyclic/missing/duplicate IDs and NaN/getters/extra fields reject', () => {
  const f = motionFixture();

  // Invalid command type
  assert.throws(() => applyMotionEdits(f, [{ type: 'unknown.op' }]), /không được hỗ trợ/);

  // Extra unsupported fields in command reject
  assert.throws(() => applyMotionEdits(f, [{ type: 'joint.remove', id: 'wrist', extraField: 123 }]), /thuộc tính/);

  // Getters in command reject
  const getterCmd = Object.defineProperty({ type: 'joint.remove' }, 'id', {
    get() { return 'wrist'; },
    enumerable: true,
  });
  assert.throws(() => applyMotionEdits(f, [getterCmd]), /thuộc tính/);

  // NaN in numeric fields reject
  assert.throws(() => applyMotionEdits(f, [{
    type: 'joint.add',
    joint: { id: 'newJ', parentId: 'root', rest: { x: NaN, y: 4 }, minRotation: -90, maxRotation: 90 },
  }]), /số/);

  assert.throws(() => applyMotionEdits(f, [{
    type: 'frame.add',
    id: 'f_nan',
    afterId: null,
    copyFrom: null,
    durationMs: NaN,
  }]), /số/);

  // Invalid ID characters or reserved names reject
  assert.throws(() => applyMotionEdits(f, [{
    type: 'joint.add',
    joint: { id: '__proto__', parentId: 'root', rest: { x: 5, y: 5 }, minRotation: -90, maxRotation: 90 },
  }]), /ID không hợp lệ/);

  assert.throws(() => applyMotionEdits(f, [{
    type: 'joint.add',
    joint: { id: 'bad joint id with spaces', parentId: 'root', rest: { x: 5, y: 5 }, minRotation: -90, maxRotation: 90 },
  }]), /ID không hợp lệ/);

  // Duplicate joint ID rejects
  assert.throws(() => applyMotionEdits(f, [{
    type: 'joint.add',
    joint: { id: 'wrist', parentId: 'root', rest: { x: 5, y: 5 }, minRotation: -90, maxRotation: 90 },
  }]), /ID khớp wrist đã tồn tại/);

  // Missing IDs reject
  assert.throws(() => applyMotionEdits(f, [{ type: 'joint.update', joint: { id: 'nonexistent', parentId: 'root', rest: { x: 5, y: 5 }, minRotation: -90, maxRotation: 90 } }]), /Không tìm thấy/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'joint.remove', id: 'nonexistent' }]), /Không tìm thấy/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'socket.remove', id: 'nonexistent' }]), /Không tìm thấy/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'chain.remove', id: 'nonexistent' }]), /Không tìm thấy/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.remove', id: 'nonexistent' }]), /Không tìm thấy/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.add', id: 'rest', afterId: null, copyFrom: null, durationMs: 100 }]), /ID frame rest đã tồn tại/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.add', id: 'newF', afterId: 'nonexistent', copyFrom: null, durationMs: 100 }]), /Không tìm thấy afterId/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.add', id: 'newF', afterId: null, copyFrom: 'nonexistent', durationMs: 100 }]), /Không tìm thấy copyFrom/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.move', id: 'nonexistent', afterId: null }]), /Không tìm thấy/);
  assert.throws(() => applyMotionEdits(f, [{ type: 'frame.move', id: 'rest', afterId: 'nonexistent' }]), /Không tìm thấy/);

  // Cyclic joint hierarchy rejects
  assert.throws(() => applyMotionEdits(f, [{
    type: 'joint.update',
    joint: { id: 'root', parentId: 'wrist', rest: { x: 4, y: 4 }, minRotation: -180, maxRotation: 180 },
  }]), /chu trình khớp|khớp gốc/);

  // Batch bounding: 0 commands or >100 commands reject
  assert.throws(() => applyMotionEdits(f, []), /mảng từ 1 đến 100/);
  const oversized = Array.from({ length: 101 }, () => ({ type: 'plan.configure', loop: true }));
  assert.throws(() => applyMotionEdits(f, oversized), /mảng từ 1 đến 100/);
});

test('source is unchanged and caller input is strictly immutable', () => {
  const f = motionFixture();
  const originalSnapshot = JSON.stringify(f);

  const edited = applyMotionEdits(f, [
    { type: 'frame.add', id: 'frame3', afterId: 'carry', copyFrom: null, durationMs: 140 },
    { type: 'plan.configure', loop: false },
  ]);

  // Caller input is untouched
  assert.equal(JSON.stringify(f), originalSnapshot);

  // Rig source is identical
  assert.deepEqual(edited.rig.source, f.rig.source);
  assert.equal(edited.rig.source.rgbaSha256, '0'.repeat(64));
  assert.equal(edited.rig.source.revision, 7);

  // Recipe canvas, palette, materials, parts paint are protected
  assert.deepEqual(edited.recipe.canvas, f.recipe.canvas);
  assert.deepEqual(edited.recipe.palette, f.recipe.palette);
  assert.deepEqual(edited.recipe.materials, f.recipe.materials);
  assert.deepEqual(edited.recipe.parts, f.recipe.parts);
});

test('referenced joint or socket deletion refuses without implicit destructive cascade', () => {
  const f = motionFixture();

  // wrist is referenced by socket 'grip', binding 'sword', chain 'arm'
  assert.throws(() => applyMotionEdits(f, [{ type: 'joint.remove', id: 'wrist' }]), /MotionRig|MotionPlan/);

  // shoulder is referenced by elbow (child joint) and chain 'arm'
  assert.throws(() => applyMotionEdits(f, [{ type: 'joint.remove', id: 'shoulder' }]), /MotionRig|MotionPlan/);

  // grip socket is referenced by binding 'sword'
  assert.throws(() => applyMotionEdits(f, [{ type: 'socket.remove', id: 'grip' }]), /MotionRig|MotionPlan/);

  // If a joint is referenced in frame rotations, deleting it refuses
  const fWithRot = motionFixture();
  fWithRot.plan.frames[0].rotations = [{ jointId: 'elbow', degrees: 10 }];
  assert.throws(() => applyMotionEdits(fWithRot, [{ type: 'joint.remove', id: 'elbow' }]), /MotionRig|MotionPlan/);

  // Removing chain leg cleans up per-frame contacts automatically without leaving accidental orphan
  const fWithChain = motionFixture();
  fWithChain.rig.chains[0].kind = 'leg';
  fWithChain.plan.frames[0].contacts = [{ chainId: 'arm', phase: 'swing', target: null }];
  const withoutChain = applyMotionEdits(fWithChain, [{ type: 'chain.remove', id: 'arm' }]);
  assert.equal(withoutChain.rig.chains.length, 0);
  assert.equal(withoutChain.plan.frames[0].contacts.length, 0);
});

test('frame add/duplicate/move/duration/remove retains recipe-plan alignment and transforms', () => {
  const f = motionFixture();

  // frame.add with copyFrom: null
  const addedEmpty = applyMotionEdits(f, [
    { type: 'frame.add', id: 'prep', afterId: null, copyFrom: null, durationMs: 80 },
  ]);
  assert.equal(addedEmpty.recipe.frames.length, 3);
  assert.equal(addedEmpty.plan.frames.length, 3);
  // Prepended at index 0 in both
  assert.equal(addedEmpty.recipe.frames[0].id, 'prep');
  assert.equal(addedEmpty.plan.frames[0].id, 'prep');
  assert.equal(addedEmpty.recipe.frames[0].durationMs, 80);
  assert.equal(addedEmpty.plan.frames[0].durationMs, 80);
  assert.deepEqual(addedEmpty.recipe.frames[0].poses, []);
  assert.deepEqual(addedEmpty.plan.frames[0].root, { dx: 0, dy: 0 });
  assert.deepEqual(addedEmpty.plan.frames[0].travel, { dx: 0, dy: 0 });
  assert.deepEqual(addedEmpty.plan.frames[0].rotations, []);
  assert.deepEqual(addedEmpty.plan.frames[0].order, f.recipe.parts.map(p => p.id));
  assert.deepEqual(addedEmpty.plan.frames[0].contacts, []);

  // frame.add with copyFrom: 'carry'
  const withCarryRot = motionFixture();
  withCarryRot.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 45 }];
  withCarryRot.plan.frames[1].root = { dx: 1, dy: -2 };
  const addedCopy = applyMotionEdits(withCarryRot, [
    { type: 'frame.add', id: 'carry2', afterId: 'carry', copyFrom: 'carry', durationMs: 150 },
  ]);
  assert.equal(addedCopy.recipe.frames.length, 3);
  assert.equal(addedCopy.plan.frames.length, 3);
  assert.equal(addedCopy.recipe.frames[2].id, 'carry2');
  assert.equal(addedCopy.plan.frames[2].id, 'carry2');
  assert.equal(addedCopy.recipe.frames[2].durationMs, 150);
  assert.equal(addedCopy.plan.frames[2].durationMs, 150);
  assert.deepEqual(addedCopy.plan.frames[2].rotations, [{ jointId: 'shoulder', degrees: 45 }]);
  assert.deepEqual(addedCopy.plan.frames[2].root, { dx: 1, dy: -2 });

  // frame.set updates matching recipe durationMs and plan frame data
  const frameSetResult = applyMotionEdits(f, [
    {
      type: 'frame.set',
      frame: {
        id: 'rest',
        durationMs: 250,
        root: { dx: 2, dy: 3 },
        travel: { dx: 0, dy: 0 },
        rotations: [{ jointId: 'elbow', degrees: -30 }],
        order: f.recipe.parts.map(p => p.id),
        contacts: [],
      },
    },
  ]);
  assert.equal(frameSetResult.recipe.frames[0].durationMs, 250);
  assert.equal(frameSetResult.plan.frames[0].durationMs, 250);
  assert.deepEqual(frameSetResult.plan.frames[0].root, { dx: 2, dy: 3 });
  assert.deepEqual(frameSetResult.plan.frames[0].rotations, [{ jointId: 'elbow', degrees: -30 }]);

  // frame.move maintains identical order, IDs, timing in both recipe and plan
  const moved = applyMotionEdits(f, [
    { type: 'frame.move', id: 'carry', afterId: null },
  ]);
  assert.deepEqual(moved.recipe.frames.map(f => f.id), ['carry', 'rest']);
  assert.deepEqual(moved.plan.frames.map(f => f.id), ['carry', 'rest']);
  assert.equal(moved.recipe.frames[0].durationMs, 120);
  assert.equal(moved.plan.frames[0].durationMs, 120);

  // frame.remove retaining >= 1
  const removed = applyMotionEdits(f, [{ type: 'frame.remove', id: 'carry' }]);
  assert.equal(removed.recipe.frames.length, 1);
  assert.equal(removed.plan.frames.length, 1);
  assert.equal(removed.recipe.frames[0].id, 'rest');
  // Attempt to remove last remaining frame must reject
  assert.throws(() => applyMotionEdits(removed, [{ type: 'frame.remove', id: 'rest' }]), /giữ ít nhất 1 frame/);
});

test('socket.set, binding.set, and chain.set support stable IDs and updates', () => {
  const f = motionFixture();

  // socket.set adds new socket and updates existing socket at stable ID
  const withSockets = applyMotionEdits(f, [
    { type: 'socket.set', socket: { id: 'grip', jointId: 'wrist', rest: { x: 9, y: 4 } } },
    { type: 'socket.set', socket: { id: 'sheath', jointId: 'root', rest: { x: 4, y: 4 } } },
  ]);
  assert.equal(withSockets.rig.sockets.length, 2);
  assert.equal(withSockets.rig.sockets[0].id, 'grip');
  assert.equal(withSockets.rig.sockets[1].id, 'sheath');

  // chain.set updates existing chain
  const withUpdatedChain = applyMotionEdits(f, [
    { type: 'chain.set', chain: { id: 'arm', kind: 'arm', rootJointId: 'shoulder', midJointId: 'elbow', endJointId: 'wrist', bend: -1, contactSocketId: null } },
  ]);
  assert.equal(withUpdatedChain.rig.chains[0].bend, -1);

  // binding.set updates existing binding in place
  const withUpdatedBinding = applyMotionEdits(f, [
    { type: 'binding.set', binding: { partId: 'sword', jointId: 'wrist', socketId: null } },
  ]);
  assert.equal(withUpdatedBinding.rig.bindings.find(b => b.partId === 'sword')!.socketId, null);
});

test('loop and rootMotion invariants with plan.configure', () => {
  const f = motionFixture();

  // loop synchronizes between recipe and plan
  const unlooped = applyMotionEdits(f, [{ type: 'plan.configure', loop: false }]);
  assert.equal(unlooped.plan.loop, false);
  assert.equal(unlooped.recipe.loop, false);

  // rootMotion=false rejects nonzero travel unless batch explicitly fixes frames
  const fTravel = motionFixture();
  fTravel.plan.rootMotion = true;
  fTravel.plan.frames[0].travel = { dx: 5, dy: 0 };
  const validTravel = validateMotionEdit(fTravel);

  // Reconfiguring rootMotion: false without fixing frame travel fails
  assert.throws(() => applyMotionEdits(validTravel, [{ type: 'plan.configure', rootMotion: false }]), /root motion đang tắt; travel phải bằng 0/);

  // Batch that fixes travel together with rootMotion: false succeeds
  const batchFixed = applyMotionEdits(validTravel, [
    { type: 'plan.configure', rootMotion: false },
    {
      type: 'frame.set',
      frame: {
        id: 'rest',
        durationMs: 100,
        root: { dx: 0, dy: 0 },
        travel: { dx: 0, dy: 0 },
        rotations: [],
        order: validTravel.recipe.parts.map(p => p.id),
        contacts: [],
      },
    },
  ]);
  assert.equal(batchFixed.plan.rootMotion, false);
  assert.equal(batchFixed.plan.frames[0].travel.dx, 0);
});

test('batch atomic failed update leaves caller untouched', () => {
  const f = motionFixture();
  const initialSnap = JSON.stringify(f);

  // Batch with 3 commands where the last one fails (e.g. deleting referenced joint)
  assert.throws(() => {
    applyMotionEdits(f, [
      { type: 'plan.configure', loop: false },
      { type: 'frame.add', id: 'frameX', afterId: null, copyFrom: null, durationMs: 90 },
      { type: 'joint.remove', id: 'wrist' },
    ]);
  });

  // f must be untouched
  assert.equal(JSON.stringify(f), initialSnap);
});

test('undo/redo using EXISTING PixelHistory over returned MotionEdit works', () => {
  const f = motionFixture();
  const history = new PixelHistory();

  const state1: MotionEdit = snapshot(validateMotionEdit(f));
  const state2: MotionEdit = applyMotionEdits(state1, [
    { type: 'frame.add', id: 'f_extra', afterId: 'carry', copyFrom: null, durationMs: 150 },
    { type: 'plan.configure', loop: false },
  ]);

  const target = snapshot(state1);
  history.commit(target, state2, 'Add extra frame and unloop');

  // Undo restores state1
  history.undo(target);
  assert.deepEqual(target, state1);
  assert.doesNotThrow(() => validateMotionEdit(target));

  // Redo restores state2
  history.undo(target, true);
  assert.deepEqual(target, state2);
  assert.doesNotThrow(() => validateMotionEdit(target));
});

test('controlled renderer still works after valid angle/frame edits on motionFixture', () => {
  const f = motionFixture();

  // Edit arm angles on frame carry: shoulder 90 deg, elbow -90 deg
  const edited = applyMotionEdits(f, [
    {
      type: 'frame.set',
      frame: {
        id: 'carry',
        durationMs: 120,
        root: { dx: 0, dy: 0 },
        travel: { dx: 0, dy: 0 },
        rotations: [
          { jointId: 'shoulder', degrees: 90 },
          { jointId: 'elbow', degrees: -90 },
        ],
        order: f.recipe.parts.map(p => p.id),
        contacts: [],
      },
    },
  ]);

  // Verify compiled motion and renderer
  const compiled = compileMotionRecipe(edited.recipe, edited.rig, edited.plan);
  const g = compiled.geometry[1];
  assert.deepEqual(g.joints.elbow, { x: 5, y: 6 });
  assert.deepEqual(g.joints.wrist, { x: 7, y: 6 });
  assert.deepEqual(g.sockets.grip, g.joints.wrist);
  assert.ok(g.maxBoneError < 1e-8);
  assert.equal(g.maxAttachmentError, 0);

  const renderer = createRecipeRenderer(compiled.recipe);
  const rest = renderer.renderFrame('rest').image;
  const carried = renderer.renderFrame('carry').image;
  assert.equal(rest.get(9, 4), 0xeef7f8ff);
  assert.equal(carried.get(7, 6), 0xeef7f8ff);
  assert.equal(carried.get(8, 6), 0xeef7f8ff);
  assert.equal(carried.get(10, 4), 0);
  assert.equal(carried.get(3, 3), rest.get(3, 3));
});
