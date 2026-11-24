import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { validateQualityDirector, validateQualityBuilder, validateQualityReview, qualityResponseSchema, type QualityDirector } from '../src/studio/quality/protocol.ts';

const context = { sources: [], masks: [] };
function setup(allowedOperations: QualityDirector['allowedOperations'] = ['rect', 'line', 'pixels']) {
  const { recipe } = motionFixture();
  const director = validateQualityDirector({ version: 1, description: 'Giữ cấu trúc', materials: recipe.materials,
    parts: recipe.parts.map(({ paint: _, ...part }) => part), allowedOperations }, recipe, context, true);
  return { recipe, director };
}

test('mixed part/frame review replaces only named paint, retains legacy keep and does not mutate inputs', () => {
  const { recipe, director } = setup(), before = structuredClone(recipe), candidate = structuredClone(recipe);
  candidate.frames[1].pixelEdits = [{ x: 0, y: 0, color: 1 }];
  const candidateBefore = structuredClone(candidate);
  const built = validateQualityBuilder({ version: 1, description: 'Dựng', recipe: candidate }, recipe, director, context);
  const builtBefore = structuredClone(built);
  const reviewed = validateQualityReview({ version: 1, description: 'Sửa kiếm và khớp', decision: 'patch', patches: [
    { partId: 'sword', paint: [{ kind: 'line', x0: 9, y0: 4, x1: 10, y1: 4, color: 0 }] },
    { frameId: 'carry', pixelEdits: [{ x: 1, y: 1, color: 0 }] },
  ] }, recipe, director, built.recipe, context);
  assert.deepEqual(reviewed.patchedParts, ['sword']);
  assert.deepEqual(reviewed.patchedFrames, ['carry']);
  assert.deepEqual(reviewed.recipe.frames[1].pixelEdits, [{ x: 1, y: 1, color: 0 }]);
  assert.deepEqual(reviewed.recipe.frames.map(({ id, durationMs }) => ({ id, durationMs })), recipe.frames.map(({ id, durationMs }) => ({ id, durationMs })));
  assert.equal(Object.hasOwn(reviewed.recipe.frames[0], 'pixelEdits'), false);
  assert.deepEqual(recipe, before);
  assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual(built, builtBefore);
  const kept = validateQualityReview({ version: 1, description: 'Giữ', decision: 'keep', patches: [] }, recipe, director, built.recipe, context);
  assert.deepEqual(kept.recipe, built.recipe);
  assert.deepEqual(kept.patchedParts, []);
  assert.deepEqual(kept.patchedFrames, []);
  assert.notEqual(kept.recipe.frames[1].pixelEdits, built.recipe.frames[1].pixelEdits);
});

test('pixels permission is required for changing frame edits, including clearing a list, but not retaining approved edits', () => {
  const { recipe, director } = setup(['rect', 'line']), candidate = structuredClone(recipe);
  candidate.frames[1].pixelEdits = [{ x: 0, y: 0, color: 1 }];
  assert.throws(() => validateQualityBuilder({ version: 1, description: 'Sai', recipe: candidate }, recipe, director, context), /điểm ảnh/);
  assert.throws(() => validateQualityReview({ version: 1, description: 'Sai', decision: 'patch', patches: [
    { frameId: 'carry', pixelEdits: [] },
  ] }, recipe, director, recipe, context), /ngoài chỉ đạo/);
  const existing = structuredClone(candidate);
  assert.deepEqual(validateQualityBuilder({ version: 1, description: 'Giữ', recipe: candidate }, existing, director, context).recipe, existing);
  const cleared = structuredClone(candidate); cleared.frames[1].pixelEdits = [];
  assert.throws(() => validateQualityBuilder({ version: 1, description: 'Xóa', recipe: cleared }, existing, director, context), /điểm ảnh/);
});

test('frame patches reject unknown fields, missing/duplicate IDs, malformed pixels and a combined ninth patch', () => {
  const { recipe, director } = setup();
  const check = (patches: unknown[], decision = 'patch') => validateQualityReview({ version: 1, description: 'Kiểm tra', decision, patches }, recipe, director, recipe, context);
  for (const patches of [
    [{ pixelEdits: [] }],
    [{ frameId: 'missing', pixelEdits: [] }],
    [{ frameId: 'carry', pixelEdits: [] }, { frameId: 'carry', pixelEdits: [] }],
    [{ frameId: 'carry', partId: 'sword', pixelEdits: [] }],
    [{ frameId: 'carry', pixelEdits: [], poses: [] }],
    [{ frameId: 'carry', pixelEdits: [], durationMs: 10 }],
    [{ frameId: 'carry', pixelEdits: [{ x: 16, y: 0, color: 0 }] }],
    [{ frameId: 'carry', pixelEdits: [{ x: 0, y: 0, color: 2 }] }],
    [{ frameId: 'carry', pixelEdits: [{ x: 0, y: 0, color: 0 }, { x: 0, y: 0, color: 1 }] }],
  ]) assert.throws(() => check(patches));
  assert.throws(() => check([], 'patch'), /1 đến 8/);
  assert.throws(() => check([{ frameId: 'carry', pixelEdits: [] }], 'keep'), /0 đến 0/);
  assert.throws(() => check([
    { partId: 'sword', paint: [] },
    ...Array.from({ length: 8 }, () => ({ frameId: 'carry', pixelEdits: [] })),
  ]), /1 đến 8/);
  let accessed = false;
  const getter = Object.defineProperty({ frameId: 'carry' }, 'pixelEdits', { enumerable: true, get() { accessed = true; return []; } });
  assert.throws(() => check([getter]));
  assert.equal(accessed, false);
});

test('CLI schemas retain a strict legacy frame branch and strict frame/part patch branches with independent ownership', () => {
  const builder = qualityResponseSchema('builder') as any;
  const frames = builder.properties.recipe.properties.frames.items.anyOf;
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].required, ['id', 'durationMs', 'poses']);
  assert.deepEqual(frames[1].required, ['id', 'durationMs', 'poses', 'pixelEdits']);
  assert.equal(frames[1].properties.pixelEdits.maxItems, 8192);
  assert.deepEqual(frames[1].properties.pixelEdits.items.properties.x, { type: 'integer', minimum: 0 });
  const reviewer = qualityResponseSchema('reviewer') as any, patches = reviewer.properties.patches;
  assert.equal(patches.maxItems, 8);
  assert.deepEqual(patches.items.anyOf.map((p: any) => p.required), [['partId', 'paint'], ['frameId', 'pixelEdits']]);
  for (const branch of [...frames, ...patches.items.anyOf]) assert.equal(branch.additionalProperties, false);
  const original = JSON.stringify(qualityResponseSchema('builder'));
  frames[1].properties.pixelEdits.maxItems = 1;
  assert.equal(JSON.stringify(qualityResponseSchema('builder')), original);
});

test('locked motion builder can patch more frames than a single reviewer pass', () => {
  const { recipe, director } = setup();
  recipe.frames = Array.from({ length: 9 }, (_, index) => ({ id: `frame-${index}`, durationMs: 100, poses: [] }));
  const proposal = { version: 1, description: 'Sửa frame', decision: 'patch',
    patches: recipe.frames.map(frame => ({ frameId: frame.id, pixelEdits: [{ x: 0, y: 0, color: 1 }] })) };
  const patched = validateQualityReview(proposal, recipe, director, recipe, context, recipe.parts.length + recipe.frames.length);
  assert.equal(patched.patchedFrames.length, 9);
  assert.ok(recipe.frames.every(frame => !frame.pixelEdits));
  assert.throws(() => validateQualityReview(proposal, recipe, director, recipe, context), /1 đến 8/);
});
