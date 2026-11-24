import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { qualityRgbaHash } from '../src/node/studio/quality-digest.ts';
import { createMotionApproval, assertMotionApproval, verifyMotionCandidate, type MotionApprovalSnapshot } from '../src/node/studio/motion-approval.ts';
import type { AssetRecipe } from '../src/studio/quality/recipe.ts';

function snapshot(): MotionApprovalSnapshot {
  const f = motionFixture(), pixels = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
  f.rig.source.rgbaSha256 = qualityRgbaHash(pixels);
  f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const mask = new Uint8Array(256);
  for (let y = 3; y <= 9; y++) for (let x = 4; x <= 11; x++) mask[y * 16 + x] = 1;
  return { recipe: f.recipe, rig: f.rig, plan: f.plan, source: { projectId: 'project', assetId: 'source', frameId: 'source-frame', revision: 7, pixels },
    resources: { sources: [], masks: [] }, movementMask: mask, frozenFrames: [{ frameId: 'rest', pixels: pixels.slice() }] };
}

test('candidate pixelEdits repaint carry while the full expected RGBA and rest stay locked', () => {
  const s = snapshot(), before = structuredClone(s), receipt = createMotionApproval(s), baseline = verifyMotionCandidate(receipt, s, s.recipe);
  const renderer = createRecipeRenderer(baseline.recipe), rest = renderer.renderFrame('rest').image.data, carry = renderer.renderFrame('carry').image.data;
  const expectedCarry = carry.slice();
  expectedCarry[8 * 16 + 4] = 0xeef7f8ff;

  const candidate = structuredClone(s.recipe) as AssetRecipe;
  candidate.frames[1].pixelEdits = [{ x: 4, y: 8, color: 1 }];
  const verified = verifyMotionCandidate(receipt, s, candidate), rendered = createRecipeRenderer(verified.recipe);

  assert.deepEqual(rendered.renderFrame('carry').image.data, expectedCarry);
  assert.deepEqual(rendered.renderFrame('rest').image.data, rest);
  assert.deepEqual(s, before);
});

test('candidate pixelEdits outside the movement mask or on a frozen frame are rejected', () => {
  const s = snapshot(), receipt = createMotionApproval(s);

  const outside = structuredClone(s.recipe) as AssetRecipe;
  outside.frames[1].pixelEdits = [{ x: 0, y: 0, color: 0 }];
  assert.throws(() => verifyMotionCandidate(receipt, s, outside), /ngoài vùng/);

  const frozen = structuredClone(s.recipe) as AssetRecipe;
  frozen.frames[0].pixelEdits = [{ x: 4, y: 4, color: 1 }];
  assert.throws(() => verifyMotionCandidate(receipt, s, frozen), /frame khóa/);
});

test('a receipt still rejects changes to current snapshot recipe pixelEdits', () => {
  const s = snapshot(), receipt = createMotionApproval(s);
  (s.recipe as AssetRecipe).frames[1].pixelEdits = [{ x: 4, y: 8, color: 1 }];
  assert.throws(() => assertMotionApproval(receipt, s), /đã đổi/);
});
