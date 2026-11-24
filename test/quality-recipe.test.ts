import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAssetRecipe, type AssetRecipe, type RecipeContext } from '../src/studio/quality/recipe.ts';

function valid(): AssetRecipe {
  return { version: 1, name: ' Hiệp sĩ ', canvas: { w: 18, h: 24 }, palette: [0x152536ff, 0xf2d485ff], pivot: { x: 9, y: 24 },
    materials: [{ id: 'metal', name: ' Giáp ', colors: [0, 1] }],
    parts: [{ id: 'body', name: 'Thân', parentId: null, pivot: { x: 9, y: 12 }, origin: 'visible', materialIds: ['metal'],
      paint: [{ kind: 'rect', x: 3, y: 4, w: 4, h: 6, color: 0 }] }],
    frames: [{ id: 'idle', durationMs: 100, poses: [] }], loop: true };
}
const rejects = (edit: (r: any) => void, pattern?: RegExp) => { const r = valid(); edit(r); if (pattern) assert.throws(() => validateAssetRecipe(r), pattern); else assert.throws(() => validateAssetRecipe(r)); };

test('strict static/animation recipes preserve Unicode, normalize names and own all nested data', () => {
  const r = valid();
  r.parts.unshift({ id: 'child', name: 'Tay', parentId: 'body', pivot: { x: 4, y: 5 }, origin: 'authored', materialIds: [], paint: [] });
  r.frames.push({ id: 'step', durationMs: 75, poses: [{ partId: 'child', dx: 0.5, dy: -1.25, rotation: 15, z: -1, visible: true }] });
  const result = validateAssetRecipe(r);
  assert.equal(result.name, 'Hiệp sĩ'); assert.equal(result.materials[0].name, 'Giáp');
  r.parts[0].pivot.x = 0; r.materials[0].colors.push(0); r.frames[1].poses[0].dx = 99;
  assert.equal(result.parts[0].pivot.x, 4); assert.deepEqual(result.materials[0].colors, [0, 1]); assert.equal(result.frames[1].poses[0].dx, 0.5);
});
test('missing, extra and executable fields are rejected throughout the tree', () => {
  rejects(r => delete r.loop); rejects(r => r.version = 2); rejects(r => r.code = 'process.exit()');
  rejects(r => r.canvas.source = '../source.png'); rejects(r => r.pivot.z = 1);
  rejects(r => r.materials[0].extra = true); rejects(r => r.parts[0].paint[0].include = 'file');
  rejects(r => r.frames[0].poses = [{ partId: 'body', dx: 0, dy: 0, rotation: 0, z: 0, visible: true, run: 'x' }]);
  rejects(r => r.parts[0].paint = [{ kind: 'code', text: 'x' }]);
});
test('non-plain objects, symbol fields, accessors and sparse arrays cannot run through validation', () => {
  rejects(r => r.canvas = new Date());
  rejects(r => r.parts[0][Symbol('hidden')] = 1);
  rejects(r => r.palette = Array(1));
  rejects(r => r.frames[0].poses = Array(1));
  let called = false;
  const r = valid(); Object.defineProperty(r.canvas, 'w', { get() { called = true; return 18; } });
  assert.throws(() => validateAssetRecipe(r)); assert.equal(called, false);
  const other = valid(); Object.defineProperty(other.palette, '0', { get() { called = true; return 0x152536ff; } });
  assert.throws(() => validateAssetRecipe(other)); assert.equal(called, false);
});
test('IDs are stable, unique, bounded and reject prototype names', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'a/b', 'đầu', '', 'x'.repeat(81)]) rejects(r => r.parts[0].id = id, /ID/);
  rejects(r => r.frames.push(structuredClone(r.frames[0])), /trùng/);
  rejects(r => r.parts.push(structuredClone(r.parts[0])), /trùng/);
  rejects(r => r.materials.push(structuredClone(r.materials[0])), /trùng/);
});
test('parent graph allows forward refs, rejects dangling refs, self-parent and indirect cycles', () => {
  rejects(r => r.parts[0].parentId = 'missing', /không tồn tại/);
  rejects(r => r.parts[0].parentId = 'body', /chu trình/);
  rejects(r => { r.parts.push({ ...structuredClone(r.parts[0]), id: 'arm', parentId: 'body' }); r.parts[0].parentId = 'arm'; }, /chu trình/);
  rejects(r => r.parts[0].materialIds = ['missing'], /vật liệu/);
  rejects(r => r.parts[0].materialIds = ['metal', 'metal'], /trùng/);
});
test('dimensions, duration and numeric fields never coerce or accept NaN/Infinity', () => {
  for (const n of [0, -1, 4097, 1.5, Infinity, NaN, '18']) rejects(r => r.canvas.w = n);
  for (const n of [0, 60001, 1.5, '100']) rejects(r => r.frames[0].durationMs = n);
  for (const n of [NaN, Infinity, 8193, -8193, '1']) rejects(r => r.frames[0].poses = [{ partId: 'body', dx: n, dy: 0, rotation: 0, z: 0, visible: true }]);
  rejects(r => r.loop = 'true'); rejects(r => r.name = 'a\u0000b'); rejects(r => r.name = ' '.repeat(2));
});
test('palette and material colors are unique opaque uint32s and valid indices', () => {
  for (const c of [0, 0x12345680, -1, 0x100000000, 1.5, '0xffffffff']) rejects(r => r.palette[0] = c);
  rejects(r => r.palette = [0xffffffff, 0xffffffff], /trùng/);
  rejects(r => r.parts[0].paint[0].color = 2); rejects(r => r.parts[0].paint[0].color = -1);
  rejects(r => r.materials[0].colors = []); rejects(r => r.materials[0].colors = [0, 0]);
  const r = valid(); r.parts[0].paint = [{ kind: 'rect', x: 0, y: 0, w: 18, h: 24, color: null }];
  assert.equal(validateAssetRecipe(r).parts[0].paint[0].kind, 'rect');
});
test('geometric coordinates distinguish pixel centers from pixel corners', () => {
  rejects(r => r.parts[0].paint = [{ kind: 'line', x0: 18, y0: 0, x1: 2, y1: 2, color: 0 }]);
  rejects(r => r.parts[0].paint = [{ kind: 'pixels', pixels: [{ x: 0.5, y: 1, color: 0 }] }]);
  rejects(r => r.parts[0].paint = [{ kind: 'pixels', pixels: [{ x: 1, y: 1, color: 0 }, { x: 1, y: 1, color: 1 }] }], /trùng/);
  rejects(r => r.parts[0].paint = [{ kind: 'rect', x: 17, y: 0, w: 2, h: 1, color: 0 }]);
  rejects(r => r.parts[0].paint = [{ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 19, y: 0 }, { x: 0, y: 24 }], color: 0 }]);
  const r = valid(); r.parts[0].paint = [{ kind: 'polygon', points: [{ x: 0.25, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 24 }], color: 1 }];
  assert.doesNotThrow(() => validateAssetRecipe(r));
});
test('raster uses declared snapshot IDs only and validates source bounds, mask dimensions and context', () => {
  const r = valid(); r.parts[0].paint = [{ kind: 'raster', sourceId: 'source', sourceRect: { x: 1, y: 0, w: 2, h: 3 }, x: 2, y: 1, maskId: 'mask' }];
  const ctx: RecipeContext = { sources: [{ id: 'source', w: 4, h: 4 }], masks: [{ id: 'mask', w: 2, h: 3 }] };
  assert.doesNotThrow(() => validateAssetRecipe(r, ctx));
  assert.throws(() => validateAssetRecipe(r));
  assert.throws(() => validateAssetRecipe(r, { ...ctx, masks: [{ id: 'mask', w: 3, h: 3 }] }));
  assert.throws(() => validateAssetRecipe(r, { ...ctx, sources: [{ id: 'source', w: 2, h: 4 }] }));
  assert.throws(() => validateAssetRecipe(valid(), { sources: [{ id: 'unused', w: 0, h: 1 }], masks: [] }));
  assert.throws(() => validateAssetRecipe(valid(), { sources: [{ id: 'unused', w: 1, h: 1, path: '../secret' }], masks: [] } as any));
});
test('frame poses reference unique existing parts with strict bounds and visibility', () => {
  const pose = { partId: 'body', dx: 0, dy: 0, rotation: 0, z: 0, visible: true };
  rejects(r => r.frames[0].poses = [{ ...pose, partId: 'absent' }]);
  rejects(r => { r.parts.push({ ...structuredClone(r.parts[0]), id: 'other' }); r.frames[0].poses = [pose, pose]; }, /trùng/);
  for (const change of [{ z: 0.5 }, { z: 2049 }, { rotation: 361 }, { visible: 1 }]) rejects(r => r.frames[0].poses = [{ ...pose, ...change }]);
});
test('decoded memory, operation count and explicit coordinate budgets reject oversized valid-looking input', () => {
  rejects(r => { r.canvas = { w: 4096, h: 4096 }; }, /32 triệu/);
  rejects(r => r.frames = Array.from({ length: 601 }, (_, i) => ({ id: `f${i}`, durationMs: 100, poses: [] })));
  rejects(r => { const op = r.parts[0].paint[0]; r.parts[0].paint = Array.from({ length: 4096 }, () => op); r.parts.push({ ...structuredClone(r.parts[0]), id: 'extra', paint: [op] }); }, /thao tác/);
  rejects(r => { r.canvas = { w: 128, h: 128 }; const pixels = Array.from({ length: 8192 }, (_, i) => ({ x: i % 128, y: Math.floor(i / 128), color: 0 })); r.parts[0].paint = Array.from({ length: 33 }, () => ({ kind: 'pixels', pixels })); }, /tọa độ/);
});
