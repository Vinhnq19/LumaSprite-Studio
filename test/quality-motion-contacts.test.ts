import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { validateMotionPlan } from '../src/studio/quality/motion.ts';
import { applyMotionEdits } from '../src/studio/quality/motion-edit.ts';
import { solveMotionTarget } from '../src/studio/quality/motion-ik.ts';

function fixture() {
  const f = motionFixture(); f.rig.chains[0].kind = 'leg'; f.rig.chains[0].contactSocketId = 'toe';
  f.rig.sockets.push({ id: 'heel', jointId: 'wrist', rest: { x: 8, y: 5 } }, { id: 'toe', jointId: 'wrist', rest: { x: 10, y: 5 } },
    { id: 'other', jointId: 'root', rest: { x: 4, y: 4 } });
  f.plan.frames[0].contacts = [{ chainId: 'arm', phase: 'stance', target: { x: 10, y: 5 } }];
  f.plan.frames[1].contacts = [{ chainId: 'arm', phase: 'stance', target: { x: 8, y: 5 }, contactSocketId: 'heel' }];
  return f;
}

test('Contact sockets: legacy chain default, per-frame heel and explicit ankle resolve to their actual points', () => {
  const f = fixture(), before = structuredClone(f);
  const c = compileMotionRecipe(f.recipe, f.rig, f.plan);
  assert.deepEqual(c.geometry.map(g => g.contacts[0].actual), [{ x: 10, y: 5 }, { x: 8, y: 5 }]);
  assert.ok(c.geometry.every(g => g.contacts[0].rasterError === 0));
  assert.equal(Object.hasOwn(c.plan.frames[0].contacts[0], 'contactSocketId'), false);
  const frame = structuredClone(f.plan.frames[1]); frame.contacts[0] = { chainId: 'arm', phase: 'stance', target: { x: 9, y: 4 }, contactSocketId: null };
  const edited = applyMotionEdits(f, [{ type: 'frame.set', frame }]);
  assert.equal(edited.plan.frames[1].contacts[0].contactSocketId, null);
  assert.deepEqual(compileMotionRecipe(edited.recipe, edited.rig, edited.plan).geometry[1].contacts[0].actual, { x: 9, y: 4 });
  assert.deepEqual(f, before);
});

test('Contact sockets: frame command roundtrip and IK preserve selected heel instead of using the chain toe', () => {
  const f = fixture(), edited = applyMotionEdits(f, [{ type: 'frame.set', frame: structuredClone(f.plan.frames[1]) }]);
  assert.equal(edited.plan.frames[1].contacts[0].contactSocketId, 'heel');
  const solved = solveMotionTarget(edited, 'carry', 'arm', { x: 7, y: 7 });
  const geometry = compileMotionRecipe(solved.recipe, solved.rig, solved.plan).geometry[1];
  assert.ok(geometry.contacts[0].distance < 1e-8); assert.equal(geometry.contacts[0].rasterError, 0);
  assert.ok(Math.hypot(geometry.sockets.heel.x - 7, geometry.sockets.heel.y - 7) < 1e-8);
  assert.equal(solved.plan.frames[1].contacts[0].contactSocketId, 'heel');
});

test('Contact sockets: invalid, foreign, undefined and getter overrides fail atomically at plan and command boundaries', () => {
  for (const value of ['missing', 'other', undefined, 12]) {
    const f = fixture(), before = structuredClone(f), frame = structuredClone(f.plan.frames[1]);
    Object.assign(frame.contacts[0], { contactSocketId: value });
    const plan = structuredClone(f.plan); plan.frames[1] = frame;
    assert.throws(() => validateMotionPlan(plan, f.rig, f.recipe));
    assert.throws(() => applyMotionEdits(f, [{ type: 'frame.set', frame }]));
    assert.deepEqual(f, before);
  }
  const f = fixture(); Object.defineProperty(f.plan.frames[1].contacts[0], 'contactSocketId', { get() { throw Error('Getter must not run'); }, enumerable: true });
  assert.throws(() => validateMotionPlan(f.plan, f.rig, f.recipe), e => e instanceof Error && !e.message.includes('Getter must not run'));
});

const frameAddCopyModes = [
  { mode: 'heel', name: 'string heel override', target: { x: 8, y: 5 } },
  { mode: 'null', name: 'explicit null ankle override', target: { x: 9, y: 4 } },
  { mode: 'absent', name: 'legacy absent override', target: { x: 10, y: 5 } },
] as const;

for (const example of frameAddCopyModes) {
  test(`Contact sockets: frame.add copyFrom carries the ${example.name} without sharing contact state`, () => {
    const f = fixture();
    const sourceIndex = f.plan.frames.findIndex(frame => frame.id === 'carry');
    assert.notEqual(sourceIndex, -1);
    const sourceFrame = f.plan.frames[sourceIndex];
    assert.equal(sourceFrame.contacts.length, 1);
    const sourceContact = sourceFrame.contacts[0];
    sourceContact.target = { ...example.target };
    if (example.mode === 'heel') sourceContact.contactSocketId = 'heel';
    else if (example.mode === 'null') sourceContact.contactSocketId = null;
    else delete sourceContact.contactSocketId;
    const before = structuredClone(f);

    const edited = applyMotionEdits(f, [{
      type: 'frame.add',
      id: 'copy',
      afterId: 'carry',
      copyFrom: 'carry',
      durationMs: 143,
    }]);
    const copyIndex = edited.plan.frames.findIndex(frame => frame.id === 'copy');
    assert.equal(copyIndex, sourceIndex + 1);
    const copiedFrame = edited.plan.frames[copyIndex];
    const copiedContact = copiedFrame.contacts[0];

    assert.equal(Object.hasOwn(copiedContact, 'contactSocketId'), example.mode !== 'absent');
    if (example.mode === 'heel') assert.equal(copiedContact.contactSocketId, 'heel');
    else if (example.mode === 'null') assert.equal(copiedContact.contactSocketId, null);
    else {
      assert.equal(Object.hasOwn(copiedContact, 'contactSocketId'), false);
      assert.equal(copiedContact.contactSocketId, undefined);
    }
    assert.deepEqual(copiedFrame.contacts, sourceFrame.contacts);

    const geometry = compileMotionRecipe(edited.recipe, edited.rig, edited.plan).geometry;
    assert.deepEqual(geometry[copyIndex].contacts[0].actual, example.target);
    assert.equal(geometry[copyIndex].contacts[0].rasterError, 0);
    assert.equal(copiedFrame.durationMs, 143);
    assert.deepEqual(f, before);

    assert.ok(copiedContact.target);
    assert.notStrictEqual(copiedContact.target, edited.plan.frames[sourceIndex].contacts[0].target);
    copiedContact.target.x += 1;
    assert.deepEqual(edited.plan.frames[sourceIndex].contacts[0].target, example.target);
    assert.deepEqual(f, before);
  });
}
