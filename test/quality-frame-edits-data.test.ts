import test from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { validateAssetRecipe } from '../src/studio/quality/recipe.ts';

function recipe(): ReturnType<typeof motionFixture>['recipe'] {
  return structuredClone(motionFixture().recipe);
}

test('legacy frame data validates without adding pixelEdits', () => {
  const input = recipe();
  const result = validateAssetRecipe(input);
  assert.deepEqual(result, input);
  assert.equal(Object.hasOwn(input.frames[0], 'pixelEdits'), false);
  assert.equal(Object.hasOwn(result.frames[0], 'pixelEdits'), false);
});

test('frame pixel edits round-trip palette indices, null colors, and empty arrays without aliasing', () => {
  const input = recipe();
  input.frames[0].pixelEdits = [
    { x: 1, y: 2, color: 1 },
    { x: 3, y: 4, color: null },
  ];
  const result = validateAssetRecipe(input);
  assert.deepEqual(result, input);
  assert.notEqual(result.frames[0], input.frames[0]);
  assert.notEqual(result.frames[0].pixelEdits, input.frames[0].pixelEdits);
  assert.notEqual(result.frames[0].pixelEdits?.[0], input.frames[0].pixelEdits?.[0]);
  result.frames[0].pixelEdits![0].x = 7;
  assert.equal(input.frames[0].pixelEdits[0].x, 1);

  const emptyInput = recipe();
  emptyInput.frames[1].pixelEdits = [];
  const emptyResult = validateAssetRecipe(emptyInput);
  assert.deepEqual(emptyResult, emptyInput);
  assert.equal(Object.hasOwn(emptyResult.frames[1], 'pixelEdits'), true);
  assert.notEqual(emptyResult.frames[1].pixelEdits, emptyInput.frames[1].pixelEdits);
});

test('frame pixelEdits rejects an undefined own value', () => {
  const input = recipe();
  Object.defineProperty(input.frames[0], 'pixelEdits', {
    value: undefined,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.throws(() => validateAssetRecipe(input));
});

test('frame pixelEdits rejects getters without invoking them', () => {
  const input = recipe();
  let getterCalls = 0;
  Object.defineProperty(input.frames[0], 'pixelEdits', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls++;
      return [];
    },
  });
  assert.throws(() => validateAssetRecipe(input));
  assert.equal(getterCalls, 0);
});

test('frame pixelEdits rejects unknown fields and sparse arrays', () => {
  const unknown = recipe();
  Object.assign(unknown.frames[0], { extra: true });
  assert.throws(() => validateAssetRecipe(unknown));

  const sparse = recipe();
  sparse.frames[0].pixelEdits = new Array(1);
  assert.throws(() => validateAssetRecipe(sparse));
});

test('frame pixelEdits rejects duplicate coordinates', () => {
  const input = recipe();
  input.frames[0].pixelEdits = [
    { x: 2, y: 3, color: 0 },
    { x: 2, y: 3, color: null },
  ];
  assert.throws(() => validateAssetRecipe(input));
});

test('frame pixelEdits rejects invalid coordinates, colors, and edit fields', () => {
  const offCanvas = recipe();
  offCanvas.frames[0].pixelEdits = [{ x: 16, y: 0, color: 0 }];
  assert.throws(() => validateAssetRecipe(offCanvas));

  const fractional = recipe();
  fractional.frames[0].pixelEdits = [{ x: 1.5, y: 0, color: 0 }];
  assert.throws(() => validateAssetRecipe(fractional));

  const badPaletteIndex = recipe();
  badPaletteIndex.frames[0].pixelEdits = [{ x: 0, y: 0, color: 2 }];
  assert.throws(() => validateAssetRecipe(badPaletteIndex));

  const extraEditKey = recipe();
  extraEditKey.frames[0].pixelEdits = [{ x: 0, y: 0, color: 0, extra: true } as never];
  assert.throws(() => validateAssetRecipe(extraEditKey));
});

test('frame pixelEdits rejects more than 8192 edits in one frame', () => {
  const input = recipe();
  input.frames[0].pixelEdits = Array.from({ length: 8193 }, (_, i) => ({
    x: i % 16,
    y: 0,
    color: 0,
  }));
  assert.throws(() => validateAssetRecipe(input), /8192/);
});

test('frame pixelEdits enforces the shared total coordinate budget without aliasing', () => {
  const input = recipe();
  const points = Array.from({ length: 4096 }, (_, i) => ({
    x: i % 64,
    y: Math.floor(i / 64),
    color: 0,
  }));
  const part = input.parts[0];
  input.canvas = { w: 64, h: 64 };
  input.pivot = { x: 0, y: 0 };
  input.parts = [{ ...part, parentId: null, pivot: { x: 0, y: 0 }, paint: [] }];
  input.frames = Array.from({ length: 64 }, (_, i) => ({
    id: `f${i}`,
    durationMs: 100,
    poses: [],
    pixelEdits: points,
  }));

  const result = validateAssetRecipe(input);
  assert.notEqual(result.frames[0].pixelEdits, points);
  assert.notEqual(result.frames[1].pixelEdits, points);
  assert.notEqual(result.frames[0].pixelEdits, result.frames[1].pixelEdits);

  input.frames.push({
    id: 'f64',
    durationMs: 100,
    poses: [],
    pixelEdits: points,
  });
  assert.throws(() => validateAssetRecipe(input), /giới hạn tọa độ/);
});
