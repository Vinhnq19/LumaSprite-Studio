import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveTwoBone } from '../src/studio/quality/kinematics.ts';
const close = (a: number, b: number, eps = 1e-8) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
function lengths(r: ReturnType<typeof solveTwoBone>, a: number, b: number) {
  close(Math.hypot(r.mid.x - r.root.x, r.mid.y - r.root.y), a);
  close(Math.hypot(r.end.x - r.mid.x, r.end.y - r.mid.y), b);
}
test('two-bone IK bends a whole chain and reaches fractional targets with fixed segment lengths', () => {
  for (const bend of [1, -1] as const) {
    const r = solveTwoBone({ x: 1.25, y: 2.5 }, { x: 6.5, y: 5.5 }, 5, 4, bend);
    assert.equal(r.reachable, true); lengths(r, 5, 4); close(r.end.x, 6.5); close(r.end.y, 5.5);
    assert.ok(Math.sign(r.midAngle) === bend);
  }
});
test('both bends mirror while fully extended and inner/outer unreachable targets never stretch bones', () => {
  const a = solveTwoBone({ x: 0, y: 0 }, { x: 6, y: 0 }, 5, 5, 1), b = solveTwoBone({ x: 0, y: 0 }, { x: 6, y: 0 }, 5, 5, -1);
  close(a.mid.x, b.mid.x); close(a.mid.y, -b.mid.y);
  for (const [target, upper, lower, expectedX, reachable] of [[10, 5, 5, 10, true], [20, 5, 5, 10, false], [1, 7, 3, 4, false], [0, 3, 7, 4, false]] as const) {
    const r = solveTwoBone({ x: 0, y: 0 }, { x: target, y: 0 }, upper, lower, 1);
    lengths(r, upper, lower); close(r.end.x, expectedX); close(r.end.y, 0); assert.equal(r.reachable, reachable);
  }
});
test('coincident equal-length target is deterministic and results own every point', () => {
  const root = { x: 2, y: 3 }, target = { x: 2, y: 3 }, a = solveTwoBone(root, target, 5, 5, 1);
  lengths(a, 5, 5); close(a.end.x, 2); close(a.end.y, 3); close(a.mid.x, 7); close(a.mid.y, 3);
  root.x = 99; target.x = 99; assert.equal(a.root.x, 2); assert.equal(a.requestedTarget.x, 2);
  assert.ok(Number.isFinite(solveTwoBone({ x: 0, y: 0 }, { x: 1e-200, y: 0 }, 1e-200, 1e-200, 1).rootAngle));
});
test('malformed IK inputs fail without invoking getters or accepting NaN/coercion', () => {
  for (const length of [0, -1, NaN, Infinity, 8193, '4']) assert.throws(() => solveTwoBone({ x: 0, y: 0 }, { x: 1, y: 1 }, length as number, 5, 1));
  assert.throws(() => solveTwoBone({ x: 0, y: 0 }, { x: 1, y: 1 }, 5, 5, 0 as 1));
  let called = false; const bad = { get x() { called = true; return 0; }, y: 0 };
  assert.throws(() => solveTwoBone(bad, { x: 1, y: 1 }, 5, 5, 1)); assert.equal(called, false);
  for (const p of [{ x: NaN, y: 0 }, { x: 16385, y: 0 }, { x: 0, y: 0, z: 1 }]) assert.throws(() => solveTwoBone(p, { x: 1, y: 1 }, 5, 5, 1));
});
