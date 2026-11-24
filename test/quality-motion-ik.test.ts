import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { solveMotionTarget } from '../src/studio/quality/motion-ik.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';

test('IK: moves shoulder/elbow/wrist as one chain; preserves grip angle, exact lengths and other frames without mutating input', () => {
  const f = motionFixture(), before = structuredClone(f);
  f.plan.frames[1].rotations = [{ jointId: 'root', degrees: 10 }];
  const input = structuredClone(f), edited = solveMotionTarget(f, 'carry', 'arm', { x: 7, y: 6 });
  assert.deepEqual(f, input); assert.deepEqual(edited.plan.frames[0], before.plan.frames[0]);
  const compiled = compileMotionRecipe(edited.recipe, edited.rig, edited.plan), geometry = compiled.geometry[1];
  assert.ok(Math.hypot(geometry.joints.wrist.x - 7, geometry.joints.wrist.y - 6) < 1e-8);
  assert.ok(geometry.maxBoneError < 1e-8); assert.ok(geometry.maxAttachmentError < 1e-8);
  const grip = geometry.sockets.grip, wrist = geometry.joints.wrist;
  assert.deepEqual(grip, wrist);
  assert.ok(edited.plan.frames[1].rotations.find(r => r.jointId === 'shoulder')!.degrees !== 0);
  assert.ok(edited.plan.frames[1].rotations.find(r => r.jointId === 'elbow')!.degrees !== 0);
});

test('IK: sole offset and parent/root motion are accounted for; stance target updated, swing stays target-free', () => {
  const f = motionFixture(); f.rig.chains[0].kind = 'leg'; f.rig.chains[0].contactSocketId = 'grip';
  f.rig.sockets[0].rest.x = 10; f.recipe.parts[3].pivot.x = 10;
  f.plan.frames[1].root = { dx: 1, dy: 1 }; f.plan.frames[1].contacts = [{ chainId: 'arm', phase: 'stance', target: { x: 9, y: 7 } }];
  const edit = solveMotionTarget(f, 'carry', 'arm', { x: 9, y: 7 });
  const g = compileMotionRecipe(edit.recipe, edit.rig, edit.plan).geometry[1];
  assert.ok(g.contacts[0].distance < 1e-8); assert.equal(g.contacts[0].rasterError, 0);
  assert.ok(Math.abs(g.sockets.grip.x - 9) < 1e-8); assert.ok(Math.abs(g.sockets.grip.y - 7) < 1e-8);
  f.plan.frames[1].contacts[0] = { chainId: 'arm', phase: 'swing', target: null };
  assert.equal(solveMotionTarget(f, 'carry', 'arm', { x: 9, y: 7 }).plan.frames[1].contacts[0].target, null);
});

test('IK: unreachable targets, malformed IDs/data and limits fail atomically instead of stretching or silently clipping', () => {
  const f = motionFixture(), before = structuredClone(f);
  assert.throws(() => solveMotionTarget(f, 'carry', 'arm', { x: 99, y: 99 }), /ngoài tầm/);
  assert.throws(() => solveMotionTarget(f, 'absent', 'arm', { x: 7, y: 6 }), /Không tìm thấy/);
  assert.throws(() => solveMotionTarget(f, 'carry', 'arm', { x: NaN, y: 6 }));
  assert.throws(() => solveMotionTarget(f, 'carry', 'arm', { x: 7, y: 6, extra: true }));
  assert.deepEqual(f, before);
  f.rig.joints.find(j => j.id === 'elbow')!.maxRotation = 1;
  assert.throws(() => solveMotionTarget(f, 'carry', 'arm', { x: 7, y: 6 }), /giới hạn/);
});

test('IK: a fully folded positive-bend elbow uses +180 when -180 is outside its limits', () => {
  const f = motionFixture(); f.rig.joints.find(j => j.id === 'elbow')!.minRotation = 0;
  const edit = solveMotionTarget(f, 'carry', 'arm', { x: 5, y: 4 });
  assert.equal(edit.plan.frames[1].rotations.find(r => r.jointId === 'elbow')!.degrees, 180);
  const geometry = compileMotionRecipe(edit.recipe, edit.rig, edit.plan).geometry[1];
  assert.ok(Math.hypot(geometry.joints.wrist.x - 5, geometry.joints.wrist.y - 4) < 1e-8);
});
