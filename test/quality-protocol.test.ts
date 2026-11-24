import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQualityDirector, validateQualityBuilder, validateQualityReview, qualityResponseSchema } from '../src/studio/quality/protocol.ts';
import { buildCharacterFinish, expandCharacterReviewTouchups, validateCharacterConstruction, validateCharacterReview } from '../src/node/studio/quality-character.ts';
import { characterJointNotes } from '../src/node/studio/quality-character-joints.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import type { AssetRecipe } from '../src/studio/quality/recipe.ts';
import { motionFixture } from './quality-motion-fixture.ts';
const context = { sources: [], masks: [] };
function setup() {
  const { recipe } = motionFixture(); recipe.frames = recipe.frames.slice(0, 1);
  const raw = { version: 1, description: 'Cụm giáp và viền mảnh', materials: recipe.materials, parts: recipe.parts.map(({ paint: _, ...p }) => p), allowedOperations: ['line', 'rect', 'pixels'] };
  const director = validateQualityDirector(raw, recipe, context, true);
  return { recipe, raw, director };
}
test('director/builder agree on the frozen layout and review applies one focused patch without mutating original', () => {
  const f = setup(), builder = validateQualityBuilder({ version: 1, description: 'Bản dựng', recipe: f.recipe }, f.recipe, f.director, context);
  const review = validateQualityReview({ version: 1, description: 'Sửa ánh kim kiếm', decision: 'patch', patches: [{ partId: 'sword', paint: [{ kind: 'rect', x: 9, y: 4, w: 2, h: 1, color: 0 }] }] }, f.recipe, f.director, builder.recipe, context);
  assert.equal(review.recipe.parts[3].paint[0].kind, 'rect'); assert.equal(builder.recipe.parts[3].paint[0].kind, 'line');
  assert.deepEqual(review.patchedParts, ['sword']);
  assert.equal(validateQualityReview({ version: 1, description: 'Giữ nguyên', decision: 'keep', patches: [] }, f.recipe, f.director, builder.recipe, context).decision, 'keep');
});
test('director cannot claim approval/change locked topology or authorize arbitrary code', () => {
  const f = setup();
  for (const edit of [(v: any) => v.approved = true, (v: any) => v.parts[0].pivot.x++, (v: any) => v.allowedOperations = ['javascript'], (v: any) => v.parts[0].paint = []]) {
    const raw = structuredClone(f.raw); edit(raw); assert.throws(() => validateQualityDirector(raw, f.recipe, context, true));
  }
});
test('compact character touch-ups still enforce palette, operation and patch rules', () => {
  const { recipe, director } = setup(), part = recipe.parts[3];
  const make = (touchups: string[], partId = part.id) => ({
    version: 1, description: 'Sửa cụm cầm kiếm', decision: 'patch', patches: [{ partId, touchups }],
  });
  const check = (value: unknown, scope = director) =>
    validateQualityReview(expandCharacterReviewTouchups(value, recipe), recipe, scope, recipe, context);
  const valid = make(['X 9 4 1', 'R 9 5 1 1 -']);
  assert.deepEqual(check(valid).recipe.parts[3].paint.slice(0, part.paint.length), part.paint);
  assert.throws(() => validateQualityReview(valid, recipe, director, recipe, context));
  assert.throws(() => check(make(['X 9 4 f'])));
  assert.throws(() => check(make(['X 999 4 1'])));
  assert.throws(() => check(valid, { ...director, allowedOperations: ['line'] }), /ngoài chỉ đạo/);
  assert.throws(() => check(make(['X 9 4 1'], 'missing')));
  assert.throws(() => check({ ...valid, decision: 'keep' }));
  assert.throws(() => check({ ...valid, patches: [...valid.patches, ...valid.patches] }), /bị sửa lặp/);
});
test('construction attachments translate a nested wrist and weapon at native resolution in draw order', () => {
  const { recipe } = setup();
  const base: AssetRecipe = {
    ...recipe,
    canvas: { w: 32, h: 32 },
    palette: [0x271925ff, 0x637891ff, 0xb0c1d0ff],
    parts: recipe.parts.map(part => ({ ...part, materialIds: [], paint: [] })),
  };
  const draft = {
    version: 1, description: 'Giáp, tay và kiếm dựng theo khớp',
    materials: [{ id: 'steel', name: 'Thép', colors: [0, 1, 2] }],
    parts: [
      { id: 'blade', parentId: 'hand', pivot: { x: 1, y: 0 }, materialIds: [] },
      { id: 'chest', parentId: null, pivot: { x: 2, y: 2 }, materialIds: ['steel'] },
      { id: 'hand', parentId: 'chest', pivot: { x: 1, y: 1 }, materialIds: [] },
    ],
    allowedOperations: ['rect', 'line', 'pixels'],
    construction: [
      { partId: 'blade', commands: ['A 0,1', 'L 1 0 1 5 2'] },
      { partId: 'chest', commands: ['A 12,12', 'R 0 0 5 5 1', 'R 2 0 2 2 2'] },
      { partId: 'hand', commands: ['A 0,2', 'X 0 0 00/01'] },
    ],
  };
  const approve = (raw: typeof draft) => validateCharacterConstruction(raw, base, context, 'proposal');
  const director = approve(draft);
  assert.deepEqual(director.parts.map(({ id, pivot }) => [id, pivot]), [
    ['blade', { x: 9, y: 12 }], ['chest', { x: 12, y: 12 }], ['hand', { x: 10, y: 12 }],
  ]);
  const build = buildCharacterFinish({ finish: 'A' }, base, director, context);
  const image = createRecipeRenderer(build.recipe).renderFrame(base.frames[0].id).image;
  assert.equal(image.get(9, 17), base.palette[2]);
  assert.equal(image.get(9, 12), base.palette[0]);
  const missing = structuredClone(draft);
  missing.construction[0].commands.shift();
  assert.throws(() => approve(missing), /đúng một điểm gắn/);
  const clipped = structuredClone(draft);
  clipped.construction[1].commands[0] = 'A 32,32';
  assert.throws(() => approve(clipped), /0\.\.31/);
  const older = structuredClone(draft);
  older.construction.forEach(part => part.commands.shift());
  assert.deepEqual(approve(older).parts[0].pivot, draft.parts[0].pivot);
  assert.equal(draft.construction[0].commands[0], 'A 0,1');
});
test('character joint review reports visible same-material palette steps and ignores occlusion', () => {
  const { recipe } = setup();
  const chest = { id: 'chest', parentId: null, x: 4, y: 4, w: 7, h: 7, color: 0 };
  const shoulder = { id: 'near-arm', parentId: 'chest', x: 1, y: 5, w: 5, h: 3, color: 1 };
  const scarf = { id: 'scarf', parentId: 'chest', x: 3, y: 4, w: 5, h: 6, color: 1 };
  function makePart({ id, parentId, ...rect }: typeof shoulder | typeof chest): AssetRecipe['parts'][number] {
    return { id, name: id, parentId, pivot: { x: 4, y: 6 }, origin: 'authored', materialIds: ['steel'],
      paint: [{ kind: 'rect', ...rect }] };
  }
  const actual: AssetRecipe = {
    ...recipe, canvas: { w: 16, h: 16 }, palette: [0x1a1a25ff, 0x9babc4ff],
    materials: [{ id: 'steel', name: 'Thép', colors: [0, 1] }],
    parts: [makePart(chest), makePart(shoulder)],
  };
  const renderer = createRecipeRenderer(actual);
  const keep = renderer.renderFrame(actual.frames[0].id).image.data.slice();
  assert.match(characterJointNotes(actual, renderer), /near-arm ↔ chest.*6 ô chồng.*cùng vật liệu.*\(5,5\)\/\(6,5\)/);
  assert.deepEqual(renderer.renderFrame(actual.frames[0].id).image.data, keep);
  const covered = { ...actual, parts: [...actual.parts, makePart(scarf)] };
  assert.equal(characterJointNotes(covered, createRecipeRenderer(covered)), '');
  actual.parts[1].materialIds = [];
  assert.equal(characterJointNotes(actual, createRecipeRenderer(actual)), '');
});
test('character review flags a low-contrast visible limb and cloth boundary only', () => {
  const { recipe } = setup();
  const part = (id: string, x: number, w: number, color: number): AssetRecipe['parts'][number] => ({
    id, name: id, parentId: null, pivot: { x, y: 3 }, origin: 'authored', materialIds: [],
    paint: [{ kind: 'rect', x, y: 3, w, h: 9, color }],
  });
  const arm = part('far-forearm', 1, 4, 0);
  const cloak = part('cloak', 5, 4, 1);
  const candidate = { ...recipe, canvas: { w: 16, h: 16 }, palette: [0x28222dff, 0x3e2530ff, 0xb5c6d9ff],
    parts: [cloak, arm] };
  const scan = ({ parts }: { parts: AssetRecipe['parts'] }) => {
    const input = { ...candidate, parts };
    return characterJointNotes(input, createRecipeRenderer(input));
  };
  assert.match(scan(candidate), /far-forearm \/ cloak: 9\/9.*\(4,3\)\/\(5,3\)/);
  assert.equal(scan({ parts: [part('cloak', 5, 4, 2), arm] }), '');
  assert.equal(scan({ parts: [part('cloak', 6, 4, 1), arm] }), '', 'A transparent gap separates the shapes');
  assert.equal(scan({ parts: [cloak, arm, part('shield', 3, 4, 0)] }), '', 'The visible shield covers the boundary');
});
test('a static reviewer can shift a connected branch without breaking the landing point or changing its source', () => {
  const { recipe, director } = setup();
  const snapshot = structuredClone(recipe);
  const base: AssetRecipe = { ...recipe, parts: recipe.parts.map(part => ({ ...part, paint: [] })) };
  const make = (id: string, x: number, y: number) => ({ partId: id, shift: { x, y } });
  const input = { version: 1, description: 'Hạ nhẹ tay và chuôi', decision: 'patch', patches: [make('upper', 0, 1)] };
  const reviewed = validateCharacterReview(input, base, director, recipe, context);
  assert.deepEqual(reviewed.patchedParts, ['upper', 'lower', 'sword']);
  assert.deepEqual(reviewed.recipe.pivot, recipe.pivot);
  assert.deepEqual(reviewed.recipe.frames, recipe.frames);
  assert.deepEqual(reviewed.recipe.parts[0], recipe.parts[0]);
  assert.deepEqual(reviewed.recipe.parts.slice(1).map(part => part.pivot.y), [5, 5, 5]);
  assert.deepEqual(recipe, snapshot);
  const image = createRecipeRenderer(reviewed.recipe).renderFrame('rest').image;
  assert.equal(image.get(10, 4), 0);
  assert.equal(image.get(10, 5), recipe.palette[1]);
  const move = (patches: typeof input.patches) => validateCharacterReview({ ...input, patches }, base, director, recipe, context);
  assert.throws(() => move([make('upper', 1, 0)]), /mất chỗ ráp/);
  assert.throws(() => move([make('upper', 0, 1), make('lower', 0, 1)]), /vượt giới hạn/);
  assert.throws(() => move([make('body', 0, 1)]), /bộ phận cha/);
  assert.throws(() => move([make('upper', 0, 2)]), /-1\.\.1/);
  assert.throws(() => validateCharacterReview(input, recipe, director, recipe, context), /canvas trống/);
  assert.throws(() => validateQualityReview(input, base, director, recipe, context));
});
test('motion director inherits locked parts and materials from the trusted recipe', () => {
  const { recipe, raw, director } = setup();
  const { version, description, allowedOperations } = raw;
  const compact = { version, description, allowedOperations };
  assert.deepEqual(validateQualityDirector(compact, recipe, context, true), director);
  assert.throws(() => validateQualityDirector(compact, recipe, context, false));
  assert.throws(() => validateQualityDirector({ ...compact, materials: [] }, recipe, context, true));
  assert.throws(() => validateQualityDirector({ ...compact, allowedOperations: ['script'] }, recipe, context, true));
  assert.deepEqual(qualityResponseSchema('director', undefined, false, true).required, Object.keys(compact));
});
test('builder rejects UI overrides, graph changes and paint outside director scope', () => {
  const f = setup();
  for (const edit of [(v: any) => v.canvas.w++, (v: any) => v.palette.reverse(), (v: any) => v.pivot.x++, (v: any) => v.frames[0].durationMs++, (v: any) => v.parts[0].parentId = 'sword', (v: any) => v.parts[0].paint = [{ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], color: 0 }]]) {
    const recipe = structuredClone(f.recipe); edit(recipe); assert.throws(() => validateQualityBuilder({ version: 1, description: 'Sai', recipe }, f.recipe, f.director, context));
  }
});
test('builder identifies the exact immutable header fields without echoing names or changing the proposal', () => {
  const f = setup();
  for (const [edit, message] of [
    [(recipe: typeof f.recipe) => { recipe.name = 'private-new-name'; }, 'tên'],
    [(recipe: typeof f.recipe) => { recipe.frames[0].durationMs++; }, 'frame/timing'],
    [(recipe: typeof f.recipe) => { recipe.name = 'private-new-name'; recipe.loop = !recipe.loop; }, 'tên, loop'],
  ] as const) {
    const recipe = structuredClone(f.recipe); edit(recipe);
    const before = structuredClone(recipe);
    assert.throws(() => validateQualityBuilder({ version: 1, description: 'Sai', recipe }, f.recipe, f.director, context),
      { message: `Đề xuất chất lượng: ${message} khác cấu hình đã chốt.` });
    assert.deepEqual(recipe, before);
  }
});

test('pixel rows require the same director permission as explicit pixels and are carried into review', () => {
  const { recipe, raw } = setup();
  const candidate = structuredClone(recipe), part = candidate.parts[0];
  part.paint.push({ kind: 'pixels', x: 0, y: 0, rows: ['.0', '11'] });
  const allowed = validateQualityDirector(raw, recipe, context, true);
  const denied = validateQualityDirector({ ...raw, allowedOperations: ['line', 'rect'] }, recipe, context, true);
  const proposal = { version: 1, description: 'Dựng hàng pixel', recipe: candidate };
  const built = validateQualityBuilder(proposal, recipe, allowed, context);
  assert.deepEqual(built.recipe, candidate);
  assert.throws(() => validateQualityBuilder(proposal, recipe, denied, context), /ngoài chỉ đạo/);
  const patch = { version: 1, description: 'Vá một hàng', decision: 'patch', patches: [{ partId: part.id, paint: part.paint }] };
  assert.deepEqual(validateQualityReview(patch, recipe, allowed, built.recipe, context).recipe, candidate);
  assert.throws(() => validateQualityReview(patch, recipe, denied, recipe, context), /ngoài chỉ đạo/);
});
test('builder and reviewer preserve restricted source paint and reject any change to it', () => {
  const { recipe, raw } = setup();
  const sword = recipe.parts[3];
  sword.paint.push({ kind: 'line', x0: 9, y0: 5, x1: 10, y1: 5, color: 1 });
  const director = validateQualityDirector({ ...raw, allowedOperations: ['pixels'] }, recipe, context, true);
  const build = (candidate: typeof recipe) => validateQualityBuilder({ version: 1, description: 'Dựng', recipe: candidate }, recipe, director, context);
  const candidate = structuredClone(recipe);
  candidate.parts[3].paint.push({ kind: 'pixels', pixels: [{ x: 9, y: 4, color: 0 }] });
  assert.deepEqual(build(candidate).recipe, candidate);
  const review = (decision: 'keep' | 'patch', patches: unknown[]) =>
    validateQualityReview({ version: 1, description: 'Kiểm tra', decision, patches }, recipe, director, candidate, context);
  assert.deepEqual(review('keep', []).recipe, candidate);
  assert.throws(() => review('patch', [{ partId: sword.id, paint: [] }]), /ngoài chỉ đạo/);
  for (const edit of [
    (paint: typeof sword.paint) => paint.push(paint[0]),
    (paint: typeof sword.paint) => {
      const line = paint[0];
      assert.equal(line.kind, 'line');
      if (line.kind === 'line') line.color = 0;
    },
    (paint: typeof sword.paint) => paint.splice(0, paint.length),
    (paint: typeof sword.paint) => paint.reverse(),
  ]) {
    const changed = structuredClone(recipe);
    edit(changed.parts[3].paint);
    assert.throws(() => build(changed), /ngoài chỉ đạo/);
  }
});

test('review cannot replace a frame, alter graph/pose fields, patch missing/duplicate parts or smuggle malformed paint', () => {
  const f = setup();
  for (const raw of [
    { version: 1, description: 'Sai', decision: 'keep', patches: [{ partId: 'sword', paint: [] }] },
    { version: 1, description: 'Sai', decision: 'patch', patches: [] },
    { version: 1, description: 'Sai', decision: 'patch', patches: [{ partId: 'missing', paint: [] }] },
    { version: 1, description: 'Sai', decision: 'patch', patches: [{ partId: 'sword', paint: [] }, { partId: 'sword', paint: [] }] },
    { version: 1, description: 'Sai', decision: 'patch', patches: [{ partId: 'sword', paint: [], frameId: 'rest' }] },
    { version: 1, description: 'Sai', decision: 'patch', patches: [{ partId: 'sword', paint: [{ kind: 'rect', x: 99, y: 0, w: 1, h: 1, color: 0 }] }] },
  ]) assert.throws(() => validateQualityReview(raw, f.recipe, f.director, f.recipe, context));
});
test('schemas are independently owned strict object trees for all three roles', () => {
  for (const role of ['director', 'builder', 'reviewer'] as const) {
    const schema = qualityResponseSchema(role); assert.equal(schema.additionalProperties, false); assert.ok(schema.required);
    const original = JSON.stringify(schema); (schema.properties as any).version.const = 99;
    assert.equal(JSON.stringify(qualityResponseSchema(role)), original);
  }
});
