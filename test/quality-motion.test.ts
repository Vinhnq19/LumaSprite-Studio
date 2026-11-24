import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMotionRig, validateMotionPlan } from '../src/studio/quality/motion.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { motionFixture } from './quality-motion-fixture.ts';

test('motion contracts are strict, normalized independent data; forward joint references are allowed', () => {
  const f = motionFixture(); f.rig.joints.reverse();
  const r = validateMotionRig(f.rig, f.recipe), p = validateMotionPlan(f.plan, r, f.recipe);
  f.rig.joints[0].rest.x = 0; f.plan.frames[0].root.dx = 99;
  assert.equal(r.joints[0].rest.x, 9); assert.equal(p.frames[0].root.dx, 0);
  const malformed = motionFixture(); (malformed.rig as any).approved = true;
  assert.throws(() => validateMotionRig(malformed.rig, malformed.recipe), /thuộc tính/);
});
test('rig rejects zero bones, cycles, extra roots, dangling joints/parts and invalid sockets', () => {
  const rejects = (edit: (f: ReturnType<typeof motionFixture>) => void) => { const f = motionFixture(); edit(f); assert.throws(() => validateMotionRig(f.rig, f.recipe)); };
  rejects(f => f.rig.joints[1].rest = { ...f.rig.joints[0].rest });
  rejects(f => f.rig.joints[1].parentId = 'wrist'); rejects(f => f.rig.joints[1].parentId = null);
  rejects(f => f.rig.joints[1].parentId = 'absent'); rejects(f => f.rig.bindings[0].jointId = 'absent');
  rejects(f => f.rig.bindings[3].socketId = 'absent'); rejects(f => f.rig.bindings[3].jointId = 'elbow');
  rejects(f => f.rig.sockets[0].rest.x = 10); rejects(f => f.rig.bindings.pop());
  rejects(f => f.rig.chains[0].midJointId = 'root'); rejects(f => f.rig.joints[0].id = '__proto__');
  rejects(f => f.rig.bindings[1].jointId = 'root');
  rejects(f => f.rig.chains.push({ ...f.rig.chains[0], id: 'phantom-copy' }));
});
test('source dimensions, pivot and hash, frame IDs/timing/loop and rotation limits cannot silently drift', () => {
  for (const edit of [(f: any) => f.rig.source.canvas.w = 32, (f: any) => f.rig.source.pivot.x = 7, (f: any) => f.rig.source.rgbaSha256 = '../file']) {
    const f = motionFixture(); edit(f); assert.throws(() => validateMotionRig(f.rig, f.recipe));
  }
  for (const edit of [(f: any) => f.plan.frames[0].id = 'changed', (f: any) => f.plan.frames[0].durationMs = 77, (f: any) => f.plan.loop = false,
    (f: any) => f.plan.frames[0].travel.dx = 1, (f: any) => f.plan.frames[0].order.reverse().pop(),
    (f: any) => f.plan.frames[0].rotations = [{ jointId: 'root', degrees: 181 }]]) {
    const f = motionFixture(); edit(f); assert.throws(() => validateMotionPlan(f.plan, f.rig, f.recipe));
  }
});
test('full shoulder/elbow/wrist chain carries the sword grip, retains bone lengths and renders exact native pixels', () => {
  const f = motionFixture(); f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const result = compileMotionRecipe(f.recipe, f.rig, f.plan), g = result.geometry[1];
  assert.deepEqual(g.joints.elbow, { x: 5, y: 6 }); assert.deepEqual(g.joints.wrist, { x: 7, y: 6 });
  assert.deepEqual(g.sockets.grip, g.joints.wrist); assert.ok(g.maxBoneError < 1e-8); assert.equal(g.maxAttachmentError, 0);
  const renderer = createRecipeRenderer(result.recipe), rest = renderer.renderFrame('rest').image, carried = renderer.renderFrame('carry').image;
  assert.equal(rest.get(9, 4), 0xeef7f8ff); assert.equal(carried.get(7, 6), 0xeef7f8ff); assert.equal(carried.get(8, 6), 0xeef7f8ff);
  assert.equal(carried.get(10, 4), 0); assert.equal(carried.get(3, 3), rest.get(3, 3));
});
test('part hierarchy and joint hierarchy may differ without double-transforming the child', () => {
  const f = motionFixture(); f.recipe.parts[3].parentId = 'body'; f.plan.frames[1].root = { dx: 1, dy: 1 };
  f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const r = compileMotionRecipe(f.recipe, f.rig, f.plan), image = createRecipeRenderer(r.recipe).renderFrame('carry').image;
  assert.equal(image.get(8, 7), 0xeef7f8ff); assert.deepEqual(r.geometry[1].joints.wrist, { x: 8, y: 7 });
});
test('approved occlusion order overrides neutral part order without inventing an independent motion pose', () => {
  const f = motionFixture();
  f.recipe.frames[1].poses = [{ partId: 'sword', dx: 0, dy: 0, rotation: 0, z: 3, visible: true }];
  f.plan.frames[1].order.reverse();
  const result = compileMotionRecipe(f.recipe, f.rig, f.plan);
  assert.equal(result.recipe.frames[1].poses.find(p => p.partId === 'sword')!.z, 0);
  assert.equal(result.recipe.frames[1].poses.find(p => p.partId === 'body')!.z, 3);
});
test('direct recipe poses cannot override approved motion and hidden ancestor still hides its attached sword', () => {
  const f = motionFixture(); f.recipe.frames[0].poses = [{ partId: 'body', dx: 1, dy: 0, rotation: 0, z: 0, visible: true }];
  assert.throws(() => compileMotionRecipe(f.recipe, f.rig, f.plan), /pose riêng/);
  f.recipe.frames[0].poses[0].dx = 0; f.recipe.frames[0].poses[0].visible = false;
  assert.ok(createRecipeRenderer(compileMotionRecipe(f.recipe, f.rig, f.plan).recipe).renderFrame('rest').image.data.every(c => c === 0));
});
test('declared leg stance is checked on the native grid and a drift above one pixel fails', () => {
  const f = motionFixture(); const chain = f.rig.chains[0]; chain.kind = 'leg';
  f.plan.frames[0].contacts = [{ chainId: 'arm', phase: 'stance', target: { x: 9, y: 4 } }];
  assert.equal(compileMotionRecipe(f.recipe, f.rig, f.plan).geometry[0].contacts[0].rasterError, 0);
  f.plan.frames[0].root.dx = 1; assert.equal(compileMotionRecipe(f.recipe, f.rig, f.plan).geometry[0].contacts[0].rasterError, 1);
  f.plan.frames[0].root.dx = 2; assert.throws(() => compileMotionRecipe(f.recipe, f.rig, f.plan), /lệch điểm chống/);
  f.plan.frames[0].root.dx = 0; f.plan.action = 'walk';
  assert.throws(() => validateMotionPlan(f.plan, f.rig, f.recipe), /hai chuỗi chân/);
});
test('walk requires two actual moving leg chains; duplicated limbs or sliding a rigid body cannot stand in for steps', () => {
  const f = motionFixture(); f.rig.chains[0].kind = 'leg';
  const ids = ['rearHip', 'rearKnee', 'rearAnkle'];
  ids.forEach((id, i) => {
    f.rig.joints.push({ id, parentId: i === 0 ? 'root' : ids[i - 1], rest: { x: 5 + 2 * i, y: 8 }, minRotation: -180, maxRotation: 180 });
    f.recipe.parts.push({ id, name: id, parentId: 'body', pivot: { x: 5 + 2 * i, y: 8 }, origin: 'derived', materialIds: [], paint: [{ kind: 'pixels', pixels: [{ x: 5 + 2 * i, y: 8, color: 0 }] }] });
    f.rig.bindings.push({ partId: id, jointId: id, socketId: null });
  });
  f.rig.chains.push({ id: 'rearLeg', kind: 'leg', rootJointId: ids[0], midJointId: ids[1], endJointId: ids[2], bend: -1, contactSocketId: null });
  for (const frame of f.plan.frames) frame.order = f.recipe.parts.map(p => p.id);
  f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 30 }, { jointId: 'elbow', degrees: -60 }, { jointId: 'rearHip', degrees: -30 }, { jointId: 'rearKnee', degrees: 60 }];
  const draft = compileMotionRecipe(f.recipe, f.rig, f.plan);
  f.plan.action = 'walk';
  f.plan.frames[0].contacts = [{ chainId: 'arm', phase: 'stance', target: { x: 9, y: 4 } }, { chainId: 'rearLeg', phase: 'swing', target: null }];
  f.plan.frames[1].contacts = [{ chainId: 'arm', phase: 'swing', target: null }, { chainId: 'rearLeg', phase: 'stance', target: draft.geometry[1].joints.rearAnkle }];
  assert.doesNotThrow(() => compileMotionRecipe(f.recipe, f.rig, f.plan));
  f.plan.frames[1].rotations = [];
  assert.throws(() => compileMotionRecipe(f.recipe, f.rig, f.plan), /chân .*không thay đổi/);
});
