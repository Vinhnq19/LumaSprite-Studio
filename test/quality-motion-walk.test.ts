import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalkPlan, type WalkOptions } from '../src/studio/quality/motion-walk.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { walkFixture } from './fixtures/quality-walk.ts';


const options: WalkOptions = { legIds: ['a', 'b'], armIds: [], stridePx: 4, liftPx: 3, crouchPx: 2, armSwingDegrees: 15, rootMotion: false };

test('Walk: alternating stance/swing, float two-bone limbs, stable IDs/timing and planted soles; deterministic and no input mutation', () => {
  const f = walkFixture(), before = structuredClone(f), result = createWalkPlan(f, options);
  assert.deepEqual(f, before); assert.deepEqual(createWalkPlan(f, options), result);
  assert.equal(result.plan.action, 'walk'); assert.ok(result.plan.frames.every(f => f.travel.dx === 0));
  assert.deepEqual(result.recipe.frames, f.recipe.frames);
  const compiled = compileMotionRecipe(result.recipe, result.rig, result.plan);
  for (const g of compiled.geometry) {
    assert.equal(g.contacts.filter(c => c.phase === 'stance').length, 1);
    assert.ok(g.contacts.every(c => c.rasterError === 0 && c.distance < 1e-8));
    assert.ok(g.maxBoneError < 1e-8); assert.ok(g.maxAttachmentError < 1e-8);
  }
  assert.notDeepEqual(compiled.geometry[0].joints['knee-a'], compiled.geometry[2].joints['knee-a']);
  assert.deepEqual(result.plan.frames.map(f => f.durationMs), Array(8).fill(120));
});

test('Walk: root motion follows step speed; stance target remains fixed in world, irregular durations retain phase timing', () => {
  const f = walkFixture(); f.recipe.frames[1].durationMs = f.plan.frames[1].durationMs = 200;
  const edit = createWalkPlan(f, { ...options, rootMotion: true });
  const contacts = edit.plan.frames.slice(0, 4).map(f => f.contacts.find(c => c.chainId === 'a')!);
  assert.ok(contacts.every(c => c.phase === 'stance'));
  assert.ok(contacts.every(c => Math.abs(c.target!.x - contacts[0].target!.x) < 1e-8));
  assert.equal(edit.plan.frames[1].durationMs, 200);
  assert.ok(Math.abs(edit.plan.frames[1].travel.dx - 2 * options.stridePx * 120 / 1040) < 1e-8);
});

test('Walk: refuses wrong chains, short clips, missing rest ground, unreachable targets and joint limits; never labels rigid sliding as walk', () => {
  const f = walkFixture(), before = structuredClone(f);
  assert.throws(() => createWalkPlan(f, { ...options, legIds: ['a', 'a'] }));
  assert.throws(() => createWalkPlan(f, { ...options, legIds: ['a', 'missing'] }));
  assert.throws(() => createWalkPlan(f, { ...options, crouchPx: 0, liftPx: 0, stridePx: 20 }), /ngoài tầm/);
  assert.deepEqual(f, before);
  const short = walkFixture(); short.recipe.frames.splice(2); short.plan.frames.splice(2);
  assert.throws(() => createWalkPlan(short, options), /4 đến 24/);
  f.rig.joints.find(j => j.id === 'knee-a')!.maxRotation = 1;
  assert.throws(() => createWalkPlan(f, options), /giới hạn/);
});
