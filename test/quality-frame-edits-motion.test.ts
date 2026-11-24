import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { assertMotionArtwork } from '../src/studio/quality/motion-art.ts';
import { applyMotionEdits } from '../src/studio/quality/motion-edit.ts';

test('carry-frame pixel edits are cloned without changing baseline geometry', () => {
  const f = motionFixture();
  f.plan.frames[1].rotations = [
    { jointId: 'shoulder', degrees: 90 },
    { jointId: 'elbow', degrees: -90 },
  ];

  const baseline = compileMotionRecipe(f.recipe, f.rig, f.plan);
  const input = [{ x: 0, y: 0, color: 1 }];
  f.recipe.frames[1].pixelEdits = input;
  const before = structuredClone(f);

  const compiled = compileMotionRecipe(f.recipe, f.rig, f.plan);
  assert.ok(compiled.recipe.frames[1].pixelEdits);
  assert.deepEqual(compiled.recipe.frames[1].pixelEdits, input);
  assert.notStrictEqual(compiled.recipe.frames[1].pixelEdits, input);
  assert.notStrictEqual(compiled.recipe.frames[1].pixelEdits[0], input[0]);
  assert.deepEqual(compiled.geometry, baseline.geometry);
  assert.equal(Object.prototype.hasOwnProperty.call(compiled.recipe.frames[0], 'pixelEdits'), false);

  const carry = createRecipeRenderer(compiled.recipe).renderFrame('carry');
  assert.equal(carry.image.get(0, 0), f.recipe.palette[1]);
  assert.deepEqual(f, before);
});

test('transparent limb cannot be faked by global frame edits', () => {
  const f = motionFixture();
  f.recipe.parts[1].paint = [
    { kind: 'line', x0: 5, y0: 4, x1: 6, y1: 4, color: 0 },
    {
      kind: 'pixels',
      pixels: [
        { x: 5, y: 4, color: null },
        { x: 6, y: 4, color: null },
      ],
    },
  ];
  f.recipe.frames[0].pixelEdits = [{ x: 0, y: 0, color: 1 }];
  const before = structuredClone(f);

  const compiled = compileMotionRecipe(f.recipe, f.rig, f.plan);
  const full = createRecipeRenderer(compiled.recipe).renderFrame('rest');
  assert.equal(full.image.data.some((value: number) => value !== 0), true);
  assert.throws(
    () => assertMotionArtwork(compiled, { sources: [], masks: [] }),
    /không có pixel/,
  );
  assert.deepEqual(f, before);
});

test('copied frame edits and poses are deep-cloned and render identically', () => {
  const f = motionFixture();
  f.recipe.frames[1].pixelEdits = [{ x: 0, y: 0, color: 1 }];
  f.recipe.frames[1].poses = [
    { partId: 'upper', dx: 0, dy: 0, rotation: 0, z: 1, visible: false },
  ];
  const before = structuredClone(f);

  const edited = applyMotionEdits(f, [
    { type: 'frame.add', id: 'copy', afterId: 'carry', copyFrom: 'carry', durationMs: 143 },
  ]);
  const carried = edited.recipe.frames[1];
  const copy = edited.recipe.frames[2];
  assert.equal(carried.id, 'carry');
  assert.equal(copy.id, 'copy');
  assert.equal(copy.durationMs, 143);
  assert.ok(carried.pixelEdits);
  assert.ok(carried.poses);
  assert.ok(copy.pixelEdits);
  assert.ok(copy.poses);
  assert.deepEqual(copy.pixelEdits, carried.pixelEdits);
  assert.deepEqual(copy.poses, carried.poses);
  assert.notStrictEqual(copy.pixelEdits, carried.pixelEdits);
  assert.notStrictEqual(copy.pixelEdits[0], carried.pixelEdits[0]);
  assert.notStrictEqual(copy.poses, carried.poses);
  assert.notStrictEqual(copy.poses[0], carried.poses[0]);

  const compiled = compileMotionRecipe(edited.recipe, edited.rig, edited.plan);
  const renderer = createRecipeRenderer(compiled.recipe);
  const copiedImage = renderer.renderFrame('copy');
  const carriedImage = renderer.renderFrame('carry');
  assert.deepEqual(copiedImage.image.data, carriedImage.image.data);

  copy.pixelEdits[0].color = 2;
  copy.poses[0].visible = true;
  assert.equal(carried.pixelEdits[0].color, 1);
  assert.equal(carried.poses[0].visible, false);
  assert.deepEqual(f, before);
});

test('frame copies preserve optional pixel edits and blank frames do not inherit them', () => {
  for (const empty of [false, true]) {
    const f = motionFixture();
    if (empty) f.recipe.frames[1].pixelEdits = [];
    const before = structuredClone(f);

    const edited = applyMotionEdits(f, [
      { type: 'frame.add', id: 'copy', afterId: 'carry', copyFrom: 'carry', durationMs: 143 },
      { type: 'frame.add', id: 'blank', afterId: 'copy', copyFrom: null, durationMs: 143 },
    ]);
    const copy = edited.recipe.frames[2];
    const blank = edited.recipe.frames[3];
    assert.equal(copy.id, 'copy');
    assert.equal(blank.id, 'blank');
    assert.equal(Object.prototype.hasOwnProperty.call(copy, 'pixelEdits'), empty);
    if (empty) {
      assert.ok(copy.pixelEdits);
      assert.deepEqual(copy.pixelEdits, []);
      assert.notStrictEqual(copy.pixelEdits, f.recipe.frames[1].pixelEdits);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(blank, 'pixelEdits'), false);
    assert.deepEqual(blank.poses, []);
    assert.deepEqual(f, before);
  }
});
