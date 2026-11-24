import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { prepareFrameRetouch, assertFrameRetouchPixels, type FrameRetouchConstraints } from '../src/studio/quality/retouch.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';

const context = { sources: [], masks: [] };
test('retouch replaces one frame, retains other edits, and clones recipe/input/inherited protection', () => {
  const { recipe } = motionFixture(); recipe.frames[0].pixelEdits = [{ x: 0, y: 0, color: 1 }];
  const inherited: FrameRetouchConstraints = { lockedFrames: ['rest'], region: { x: 1, y: 1, w: 5, h: 5 } };
  const input = { patches: [{ frameId: 'carry', pixelEdits: [{ x: 2, y: 2, color: 1 }] }], lockedFrames: [], region: { x: 2, y: 2, w: 5, h: 5 } };
  const before = structuredClone({ recipe, input, inherited });
  const result = prepareFrameRetouch(recipe, input, context, inherited);
  assert.deepEqual(result.frameIds, ['carry']);
  assert.deepEqual(result.constraints, { lockedFrames: ['rest'], region: { x: 2, y: 2, w: 4, h: 4 } });
  assert.deepEqual(result.recipe.frames[0], recipe.frames[0]);
  assert.deepEqual(result.recipe.frames[1].pixelEdits, [{ x: 2, y: 2, color: 1 }]);
  assert.deepEqual(result.recipe.parts, recipe.parts);
  assert.deepEqual(result.recipe.frames.map(f => [f.id, f.durationMs]), [['rest', 100], ['carry', 120]]);
  assert.deepEqual({ recipe, input, inherited }, before);
  result.constraints.lockedFrames.push('carry'); result.constraints.region!.x = 0;
  result.recipe.frames[0].pixelEdits![0].color = 0;
  assert.deepEqual({ recipe, input, inherited }, before);
});

test('empty patches capture constraints; null cannot widen inherited region or drop frame locks', () => {
  const { recipe } = motionFixture();
  const inherited: FrameRetouchConstraints = { lockedFrames: ['carry'], region: { x: 1, y: 1, w: 2, h: 2 } };
  const result = prepareFrameRetouch(recipe, { patches: [], lockedFrames: ['rest'], region: null }, context, inherited);
  assert.deepEqual(result.frameIds, []);
  assert.deepEqual(result.recipe, recipe);
  assert.deepEqual(result.constraints, { lockedFrames: ['rest', 'carry'], region: inherited.region });
  assert.notEqual(result.constraints.region, inherited.region);
  assert.throws(() => prepareFrameRetouch(recipe, { patches: [], lockedFrames: [], region: { x: 10, y: 10, w: 2, h: 2 } }, context, inherited));
});

test('retouch boundary rejects malformed patches, protection and accessors without mutating source', () => {
  const { recipe } = motionFixture(), before = structuredClone(recipe);
  const raw = { patches: [] as unknown[], lockedFrames: [] as string[], region: null as unknown };
  const invalid = [
    { ...raw, approved: true }, { ...raw, lockedFrames: ['missing'] }, { ...raw, lockedFrames: ['rest', 'rest'] },
    { ...raw, region: { x: 15, y: 0, w: 2, h: 1 } }, { ...raw, region: { x: 0.5, y: 0, w: 1, h: 1 } },
    { ...raw, patches: [{ frameId: 'missing', pixelEdits: [] }] },
    { ...raw, patches: [{ frameId: 'carry', pixelEdits: [], poses: [] }] },
    { ...raw, patches: [{ frameId: 'carry', pixelEdits: [] }, { frameId: 'carry', pixelEdits: [] }] },
    { ...raw, patches: [{ frameId: 'carry', pixelEdits: [{ x: 16, y: 0, color: 0 }] }] },
    { ...raw, patches: [{ frameId: 'carry', pixelEdits: [{ x: 0, y: 0, color: 2 }] }] },
    { ...raw, patches: [{ frameId: 'carry', pixelEdits: [{ x: 0, y: 0, color: 0 }, { x: 0, y: 0, color: 1 }] }] },
  ];
  for (const input of invalid) assert.throws(() => prepareFrameRetouch(recipe, input, context));
  assert.throws(() => prepareFrameRetouch(recipe, { ...raw, patches: Array.from({ length: 9 }, () => ({ frameId: 'carry', pixelEdits: [] })) }, context), /8/);
  assert.throws(() => prepareFrameRetouch(recipe, raw, context, { lockedFrames: ['missing'], region: null }));
  let accessed = false;
  const getter = Object.defineProperty({ ...raw }, 'patches', { get() { accessed = true; return []; } });
  assert.throws(() => prepareFrameRetouch(recipe, getter, context)); assert.equal(accessed, false);
  assert.deepEqual(recipe, before);
});

test('final RGBA enforces parent frame/region locks, including erasing, while allowing identical paint', () => {
  const { recipe } = motionFixture(), parent = createRecipeRenderer(recipe);
  const check = (x: number, y: number, color: number | null, constraints: FrameRetouchConstraints) => {
    const changed = prepareFrameRetouch(recipe, { patches: [{ frameId: 'carry', pixelEdits: [{ x, y, color }] }], ...constraints }, context);
    return () => assertFrameRetouchPixels(parent, createRecipeRenderer(changed.recipe), changed.constraints, changed.frameIds);
  };
  const region = { lockedFrames: [], region: { x: 1, y: 1, w: 3, h: 3 } };
  assert.doesNotThrow(check(2, 2, 1, region));
  assert.throws(check(0, 0, 1, region), /ngoài vùng/);
  assert.throws(check(3, 3, null, { lockedFrames: [], region: { x: 1, y: 1, w: 2, h: 2 } }), /ngoài vùng/);
  assert.throws(check(2, 2, 1, { lockedFrames: ['carry'], region: null }), /frame khóa/);
  assert.doesNotThrow(check(3, 3, 0, { lockedFrames: ['carry'], region: null }));
  assert.doesNotThrow(check(0, 0, null, region));
  assert.throws(() => assertFrameRetouchPixels(parent, createRecipeRenderer({ ...recipe, canvas: { w: 17, h: 16 } }), region, ['carry']), /canvas/i);
});
