import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecipeRenderer, type RecipeResources } from '../src/studio/quality/renderer.ts';
import type { AssetRecipe, RecipePart, RecipePaintOp } from '../src/studio/quality/recipe.ts';

const RED = 0xff0000ff, BLUE = 0x0000ffff;
function part(id: string, paint: RecipePaintOp[], parentId: string | null = null): RecipePart {
  return { id, name: id, parentId, pivot: { x: 2, y: 2 }, origin: 'authored', materialIds: [], paint };
}
function recipe(parts = [part('body', [{ kind: 'rect', x: 1, y: 1, w: 2, h: 2, color: 0 }])]): AssetRecipe {
  return { version: 1, name: 'Thử dựng', canvas: { w: 8, h: 8 }, palette: [RED, BLUE], pivot: { x: 4, y: 8 }, materials: [], parts,
    frames: [{ id: 'f1', durationMs: 120, poses: [] }], loop: true };
}
function colored(image: { w: number; data: Uint32Array }): [number, number, number][] {
  return [...image.data].flatMap((c, i) => c ? [[i % image.w, Math.floor(i / image.w), c] as [number, number, number]] : []);
}
test('native shape paint, clear within a part and frame metadata are exact', () => {
  const r = recipe([part('body', [
    { kind: 'rect', x: 1, y: 1, w: 2, h: 2, color: 0 },
    { kind: 'pixels', pixels: [{ x: 1, y: 1, color: null }, { x: 2, y: 2, color: 1 }] },
  ])]);
  const frame = createRecipeRenderer(r).renderFrame('f1');
  assert.deepEqual(colored(frame.image), [[2, 1, RED], [1, 2, RED], [2, 2, BLUE]]);
  assert.equal(frame.durationMs, 120); assert.equal(frame.loop, true); assert.deepEqual(frame.pivot, { x: 4, y: 8 });
});
test('compact rows pad omitted trailing dots without changing earlier paint', () => {
  const base: RecipePaintOp = { kind: 'rect', x: 2, y: 3, w: 2, h: 2, color: 0 };
  const rows: RecipePaintOp = { kind: 'pixels', x: 2, y: 3, rows: ['.1', '1'] };
  const r = recipe([part('body', [base, rows])]);
  const renderer = createRecipeRenderer(r);
  assert.deepEqual(renderer.getRecipe(), recipe([part('body', [base, { ...rows, rows: ['.1', '1.'] }])]));
  assert.deepEqual(rows.rows, ['.1', '1']);
  assert.deepEqual(colored(renderer.renderFrame('f1').image), [[2, 3, RED], [3, 3, BLUE], [2, 4, BLUE], [3, 4, RED]]);
  for (const bad of [
    { x: 7, y: 0, rows: ['01'] }, { x: 0, y: 7, rows: ['0', '1'] },
    { x: 7, y: 1, rows: ['1', '01'] }, { x: 1, y: 1, rows: ['g'] },
    { x: 1, y: 1, rows: ['1', ''] },
    { x: 1, y: 1, rows: ['2'] }, { x: 1, y: 1, rows: ['..'] },
  ]) assert.throws(() => createRecipeRenderer(recipe([part('body', [{ kind: 'pixels', ...bad }])])));
  assert.throws(() => createRecipeRenderer({ ...r, canvas: { w: 65, h: 8 } }), /canvas tối đa 64/);
  assert.throws(() => createRecipeRenderer({ ...r, palette: Array.from({ length: 17 }, (_, i) => (i << 8) | 255) }), /palette tối đa 16/);
});
test('pixel-center polygons match a rectangle, line ends are included without antialiasing', () => {
  const r = recipe([part('body', [
    { kind: 'polygon', points: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }], color: 0 },
    { kind: 'line', x0: 4, y0: 4, x1: 6, y1: 6, color: 1 },
  ])]);
  assert.deepEqual(colored(createRecipeRenderer(r).renderFrame('f1').image), [
    [1, 1, RED], [2, 1, RED], [1, 2, RED], [2, 2, RED], [4, 4, BLUE], [5, 5, BLUE], [6, 6, BLUE],
  ]);
});
test('quarter-turn parent transform carries a child in rest-canvas coordinates', () => {
  const r = recipe([part('child', [{ kind: 'pixels', pixels: [{ x: 3, y: 2, color: 1 }] }], 'parent'), part('parent', [])]);
  r.frames[0].poses = [{ partId: 'parent', dx: 2, dy: 1, rotation: 90, z: 0, visible: true }];
  assert.deepEqual(colored(createRecipeRenderer(r).renderFrame('f1').image), [[3, 4, BLUE]]);
});
test('hidden parent hides descendants and pose z uses stable part order for ties', () => {
  const paint: RecipePaintOp[] = [{ kind: 'pixels', pixels: [{ x: 2, y: 2, color: 0 }] }];
  const r = recipe([part('back', paint), part('front', [{ kind: 'pixels', pixels: [{ x: 2, y: 2, color: 1 }] }], 'back')]);
  assert.equal(createRecipeRenderer(r).renderFrame('f1').image.get(2, 2), BLUE);
  r.frames[0].poses = [{ partId: 'back', dx: 0, dy: 0, rotation: 0, z: 2, visible: true }];
  assert.equal(createRecipeRenderer(r).renderFrame('f1').image.get(2, 2), RED);
  r.frames[0].poses[0].visible = false;
  assert.equal(colored(createRecipeRenderer(r).renderFrame('f1').image).length, 0);
});
test('masked native raster uses sourceRect offsets; transparency stamps rather than clears', () => {
  const r = recipe([part('body', [{ kind: 'rect', x: 2, y: 2, w: 2, h: 2, color: 0 },
    { kind: 'raster', sourceId: 'source', sourceRect: { x: 1, y: 0, w: 2, h: 2 }, x: 2, y: 2, maskId: 'mask' }])]);
  const resources: RecipeResources = {
    sources: [{ id: 'source', w: 3, h: 2, pixels: new Uint32Array([0, BLUE, BLUE, 0, 0, BLUE]) }],
    masks: [{ id: 'mask', w: 2, h: 2, data: new Uint8Array([1, 0, 1, 1]) }],
  };
  assert.deepEqual(colored(createRecipeRenderer(r, resources).renderFrame('f1').image), [[2, 2, BLUE], [3, 2, RED], [2, 3, RED], [3, 3, BLUE]]);
});
test('input recipe, resources, returned metadata and frames cannot mutate future renders', () => {
  const r = recipe([part('body', [{ kind: 'raster', sourceId: 's', sourceRect: { x: 0, y: 0, w: 1, h: 1 }, x: 2, y: 2, maskId: null }])]);
  const pixels = new Uint32Array([RED]);
  const renderer = createRecipeRenderer(r, { sources: [{ id: 's', w: 1, h: 1, pixels }], masks: [] });
  pixels[0] = BLUE; r.palette[0] = BLUE; r.frames[0].durationMs = 999;
  renderer.getRecipe().parts[0].paint.length = 0;
  const a = renderer.renderFrame('f1'); a.image.data.fill(0); a.pivot.x = 0;
  const b = renderer.renderFrame('f1');
  assert.equal(b.image.get(2, 2), RED); assert.equal(b.durationMs, 120); assert.equal(b.pivot.x, 4);
});
test('transformed opaque clipping fails without silently cropping, empty off-canvas parts are harmless', () => {
  const r = recipe();
  r.frames[0].poses = [{ partId: 'body', dx: -2, dy: 0, rotation: 0, z: 0, visible: true }];
  assert.throws(() => createRecipeRenderer(r).renderFrame('f1'), /bị cắt/);
  r.parts[0].paint = [];
  assert.equal(colored(createRecipeRenderer(r).renderFrame('f1').image).length, 0);
});
test('raster rejects partial alpha, off-palette samples, invalid masks, buffers and unknown resource fields', () => {
  const r = recipe([part('body', [{ kind: 'raster', sourceId: 's', sourceRect: { x: 0, y: 0, w: 1, h: 1 }, x: 0, y: 0, maskId: null }])]);
  for (const color of [0xff000080, 0x00ff00ff]) assert.throws(() => createRecipeRenderer(r, { sources: [{ id: 's', w: 1, h: 1, pixels: new Uint32Array([color]) }], masks: [] }), /palette|alpha/);
  assert.throws(() => createRecipeRenderer(r, { sources: [{ id: 's', w: 1, h: 1, pixels: new Uint32Array(0) }], masks: [] }), /kích thước/);
  assert.throws(() => createRecipeRenderer(r, { sources: [{ id: 's', w: 1, h: 1, pixels: new Uint32Array([RED]) }], masks: [{ id: 'm', w: 1, h: 1, data: new Uint8Array([2]) }] }), /mask/);
  assert.throws(() => createRecipeRenderer(r, { sources: [], masks: [], path: 'x' } as unknown as RecipeResources), /thuộc tính/);
});
test('repeated full-canvas paint has an explicit work bound even when decoded layers fit', () => {
  const r = recipe(); r.canvas = { w: 1024, h: 1024 };
  r.parts[0].paint = Array.from({ length: 62 }, () => ({ kind: 'rect', x: 0, y: 0, w: 1024, h: 1024, color: 0 }));
  assert.throws(() => createRecipeRenderer(r), /ngân sách xử lý/);
});
test('lazy frame lookup preserves per-frame timing and never aliases another frame', () => {
  const r = recipe();
  r.frames.push({ id: 'f2', durationMs: 75, poses: [{ partId: 'body', dx: 1, dy: 0, rotation: 0, z: 0, visible: true }] });
  r.loop = false;
  const renderer = createRecipeRenderer(r), a = renderer.renderFrame('f1'), b = renderer.renderFrame('f2');
  assert.equal(a.image.get(1, 1), RED); assert.equal(b.image.get(1, 1), 0); assert.equal(b.image.get(3, 1), RED);
  assert.equal(b.durationMs, 75); assert.equal(b.loop, false);
  assert.throws(() => renderer.renderFrame('missing'), /Không tìm thấy/);
});
