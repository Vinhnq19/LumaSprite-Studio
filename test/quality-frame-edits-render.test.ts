import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import type { AssetRecipe } from '../src/studio/quality/recipe.ts';

test('frame pixel edits render independently and do not mutate recipes or images', () => {
  const R = 0xff0000ff, B = 0x0000ffff;
  const recipe: AssetRecipe = {
    version: 1, name: 'Test', canvas: { w: 3, h: 3 }, palette: [R, B], pivot: { x: 1, y: 3 }, materials: [],
    parts: [{ id: 'body', name: 'Body', parentId: null, pivot: { x: 1, y: 1 }, origin: 'authored', materialIds: [], paint: [{ kind: 'rect', x: 1, y: 1, w: 1, h: 1, color: 0 }] }], loop: false,
    frames: [
      { id: 'f0', durationMs: 100, poses: [{ partId: 'body', dx: 1, dy: 0, rotation: 0, z: 0, visible: true }], pixelEdits: [{ x: 2, y: 1, color: null }, { x: 0, y: 0, color: 1 }] },
      { id: 'f1', durationMs: 137, poses: [] },
    ],
  };
  const original = structuredClone(recipe);
  const renderer = createRecipeRenderer(recipe);
  const frame0 = renderer.renderFrame('f0'), frame1 = renderer.renderFrame('f1');
  const copy = renderer.getRecipe();
  assert.deepEqual([frame0.image.w, frame0.image.h], [3, 3]);
  assert.deepEqual(copy.frames.map((f) => f.durationMs), [100, 137]);
  assert.equal(frame0.durationMs, 100);
  assert.equal(frame1.durationMs, 137);
  assert.equal(frame0.loop, false);
  assert.deepEqual(frame0.pivot, { x: 1, y: 3 });
  assert.deepEqual([...frame0.image.data], [B, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...frame1.image.data], [0, 0, 0, 0, R, 0, 0, 0, 0]);
  assert.deepEqual(recipe, original);
  recipe.frames[0].pixelEdits![1].color = 0;
  copy.frames[0].pixelEdits![1].color = 0;
  frame0.image.data.fill(0);
  assert.deepEqual([...renderer.renderFrame('f0').image.data], [B, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...renderer.renderFrame('f1').image.data], [0, 0, 0, 0, R, 0, 0, 0, 0]);
});
