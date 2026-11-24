import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QualityRuntime } from '../src/node/studio/quality-runtime.ts';
import { QualityEngine, QualityTechnicalError } from '../src/node/studio/quality-engine.ts';
import type { QualityStartInput, QualityExecution, QualityPrepared } from '../src/node/studio/quality-ports.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { buildCharacterFinish, validateCharacterConstruction } from '../src/node/studio/quality-character.ts';
import { createMotionApproval, type MotionApprovalSnapshot } from '../src/node/studio/motion-approval.ts';
import { qualityRgbaHash } from '../src/node/studio/quality-digest.ts';
import { wireParse, composite } from '../src/studio/pixel/model.ts';
import { decodeQualityPng } from './quality-image-fixture.ts';

function setup(motion = false) {
  const f = motionFixture(), resources = { sources: [], masks: [] };
  if (!motion) f.recipe.frames = f.recipe.frames.slice(0, 1);
  const pixels = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
  f.rig.source.rgbaSha256 = qualityRgbaHash(pixels);
  if (motion) f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
  const snapshot: MotionApprovalSnapshot = { ...f, source: { projectId: 'project', assetId: 'source', frameId: 'source-frame', revision: 7, pixels }, resources, movementMask: new Uint8Array(256).fill(1), frozenFrames: [{ frameId: 'rest', pixels: pixels.slice() }] };
  // Contract object uses exact keys; do not carry fixture convenience properties.
  const input: QualityStartInput = { projectId: 'project', revision: 7, prompt: 'Giữ giáp, làm nét kiếm rõ hơn', style: 'RPG', context: motion ? { kind: 'motion', snapshot, approval: createMotionApproval(snapshot) } : { kind: 'free', recipe: f.recipe, resources } };
  const director = { version: 1, description: 'Giữ cấu trúc nguồn', materials: f.recipe.materials, parts: f.recipe.parts.map(({ paint: _, ...p }) => p), allowedOperations: ['rect', 'line', 'pixels'] };
  const calls: QualityExecution[] = []; let busy = false;
  const external = { acquire() { if (busy) throw Error('busy'); busy = true; return { release() { busy = false; }, check() { assert.equal(busy, true); } }; }, assertCurrent() {},
    execute(request: QualityExecution) { calls.push(request); return { promise: Promise.resolve({ output: JSON.stringify(request.role === 'director' ? director : request.role === 'builder' ? { version: 1, description: 'Bản dựng', recipe: f.recipe } : { version: 1, description: 'Xem ảnh, giữ', decision: 'keep', patches: [] }) }), stop: async () => true }; } };
  return { ...f, input, snapshot, director, external, calls };
}
test('real workers run the three-role fixture, retain before/after, lazy PNG and exact source-backed asset in owned storage', async () => {
  const f = setup(), runtime = new QualityRuntime(), engine = new QualityEngine(runtime.ports(f.external));
  try {
    const ready = await engine.wait(engine.start(f.input).id); assert.equal(ready.status, 'ready', ready.message); assert.equal(ready.cliCalls, 3);
    assert.equal(ready.variants.length, 2);
    assert.ok(f.calls.every(call => call.reasoningEffort === undefined));
    const review = f.calls[2];
    assert.deepEqual(review.images.map(image => image.name), ['source.png', 'review-sheet-1.png', 'review-detail-4x.png', 'review-shape-value.png']);
    assert.match(f.calls[0].instruction, /vùng kính phía trên mặt chất lỏng/);
    assert.match(f.calls[1].instruction, /một vệt phản sáng hẹp từ vai theo mép trên trái/);
    assert.match(review.instruction, /kiểm tra ở 1× phần trên mặt chất lỏng/);
    assert.match(review.instruction, /sửa paint của phần chính trước/);
    assert.match(review.instruction, /đối chiếu luma của hai mảng/);
    const metadataPrefix = 'Cấu hình/nguồn: ';
    for (const call of f.calls) {
      const metadataLine = call.instruction.split('\n').find(line => line.startsWith(metadataPrefix));
      assert.ok(metadataLine);
      const palette = JSON.parse(metadataLine.slice(metadataPrefix.length)).palette;
      assert.deepEqual(palette.map((entry: { luma: number }) => entry.luma), [67, 245]);
    }
    const shape = decodeQualityPng(review.images[3].data);
    assert.deepEqual([shape.w, shape.h], [66, 32]);
    const snapshotId = f.calls[0].snapshotId, selected = ready.variants[1], png = await runtime.materialize(snapshotId, selected.id, 7, 'rest').promise;
    const expected = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const original = expected[y * 16 + x], left = shape.pixels[2 * y * shape.w + 2 * x], gray = shape.pixels[2 * y * shape.w + 34 + 2 * x];
      const alpha = original & 255;
      assert.equal(left, alpha ? (0xffffff00 | alpha) >>> 0 : 0);
      assert.equal(gray & 255, alpha);
      assert.equal(gray >>> 24, (gray >>> 16) & 255);
      assert.equal(gray >>> 24, (gray >>> 8) & 255);
      if (alpha) assert.equal(gray >>> 24, original === 0x354557ff ? 67 : 245);
    }
    assert.deepEqual(decodeQualityPng(png.data).pixels, expected);
    const assetResult = await runtime.materialize(snapshotId, selected.id, 7).promise, { asset } = wireParse(Buffer.from(assetResult.data).toString('utf8'));
    assert.deepEqual(composite(asset, asset.frames[0].id).data, expected); assert.deepEqual(asset.metadata.pivot, { x: 0.5, y: 1 });
    const before = runtime.candidateRecipe(snapshotId, ready.variants[0].id); assert.ok(before);
    assert.throws(() => runtime.materialize(snapshotId, selected.id, 8), /revision/);
    assert.throws(() => runtime.candidateRecipe(snapshotId, 'foreign-variant'), /không thuộc/);
    const savedResponses = readdirSync(join(runtime.root, snapshotId)).filter(s => s.startsWith('response-')); assert.equal(savedResponses.length, 3);
  } finally { await engine.close(); runtime.close(true); assert.equal(existsSync(runtime.root), false); }
});
test('native 128px static review checks outlines using a pixel-exact 2× attachment', async () => {
  const f = setup(), runtime = new QualityRuntime(), engine = new QualityEngine(runtime.ports(f.external));
  f.recipe.canvas = { w: 128, h: 128 };
  try {
    const ready = await engine.wait(engine.start(f.input).id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.cliCalls, 3);
    assert.match(f.calls[0].instruction, /Phân biệt viền ngoài với đường tiếp giáp vật liệu/);
    assert.match(f.calls[1].instruction, /viền ngoài mảnh tại chỗ bắt sáng/);
    const review = f.calls[2];
    assert.match(review.instruction, /review-detail-2x\.png/);
    assert.match(review.instruction, /viền dày nuốt mảng sáng/);
    assert.deepEqual(review.images.map(image => image.name), ['source.png', 'review-sheet-1.png', 'review-detail-2x.png']);
    const native = decodeQualityPng(review.images[1].data), detail = decodeQualityPng(review.images[2].data);
    assert.deepEqual([native.w, native.h, detail.w, detail.h], [128, 128, 256, 256]);
    assert.deepEqual(native.pixels, createRecipeRenderer(f.recipe).renderFrame('rest').image.data);
    assert.ok(detail.pixels.every((pixel, index) => {
      const y = Math.floor(index / detail.w / 2), x = Math.floor((index % detail.w) / 2);
      return pixel === native.pixels[y * native.w + x];
    }));
  } finally { await engine.close(); runtime.close(true); }
});

test('character worker compiles two-point axis marks with approved pixels and sends a native-size value guide', async () => {
  const f = setup(), runtime = new QualityRuntime(), engine = new QualityEngine(runtime.ports(f.external));
  f.input.prompt = 'Naturally proportioned fantasy traveler';
  f.recipe.canvas = { w: 128, h: 128 };
  const response = structuredClone(f.recipe), expected = structuredClone(f.recipe);
  response.parts[0].paint.push({ kind: 'polygon', points: [{ x: 10, y: 13 }, { x: 8, y: 13 }], color: 1 });
  expected.parts[0].paint.push({ kind: 'pixels', pixels: [8, 9, 10].map(x => ({ x, y: 13, color: 1 })) });
  for (const part of f.recipe.parts) part.paint = [];
  f.director.allowedOperations.push('polygon');
  const execute = f.external.execute;
  f.external.execute = request => {
    const task = execute(request);
    return request.role !== 'builder' ? task : {
      ...task, promise: Promise.resolve({ output: JSON.stringify({ version: 1, description: 'Bản dựng',
        parts: response.parts.map(part => ({ partId: part.id, paint: part.paint })).reverse() }) }),
    };
  };
  try {
    const ready = await engine.wait(engine.start(f.input).id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.cliCalls, 3);
    assert.equal(ready.technicalRepairs, 0);
    assert.match(ready.variants[0].description, /chuyển 1 polygon hai điểm/);
    const snapshotId = f.calls[0].snapshotId, png = await runtime.materialize(snapshotId, ready.variants[1].id, 7, 'rest').promise;
    const pixels = createRecipeRenderer(expected).renderFrame('rest').image.data;
    assert.deepEqual(decodeQualityPng(png.data).pixels, pixels);
    const rebuilt = runtime.candidateRecipe(snapshotId, ready.variants[0].id) as typeof expected;
    assert.deepEqual(rebuilt.parts.map(part => part.id), f.director.parts.map(part => part.id));
    assert.deepEqual(rebuilt.frames, expected.frames);
    const valueGuide = f.calls[2].images.find(image => image.name === 'review-shape-value.png');
    assert.ok(valueGuide);
    const guide = decodeQualityPng(valueGuide.data);
    assert.deepEqual([guide.w, guide.h], [514, 256]);
    assert.equal(response.parts[0].paint.at(-1)?.kind, 'polygon');
  } finally { await engine.close(); runtime.close(true); }
});

test('character mark conversion keeps disallowed or ambiguous polygons invalid', async () => {
  const f = setup(), runtime = new QualityRuntime(), ports = runtime.ports(f.external);
  const response = structuredClone(f.recipe);
  for (const part of f.recipe.parts) part.paint = [];
  f.director.allowedOperations.push('polygon');
  try {
    const prepared = await ports.prepare(f.input).promise;
    prepared.characterStudy = true;
    const directed = await ports.validate('director', JSON.stringify(f.director), prepared).promise;
    assert.equal(directed.kind, 'director');
    const submit = (director = directed.director) => ports.validate('builder',
      JSON.stringify({ version: 1, description: 'Bản dựng', recipe: response }), prepared, director).promise;
    response.parts[0].paint.push({ kind: 'polygon', points: [{ x: 8, y: 12 }, { x: 10, y: 13 }], color: 1 });
    await assert.rejects(submit(), /mảng từ 3 đến 128/);
    response.parts[0].paint[response.parts[0].paint.length - 1] =
      { kind: 'polygon', points: [{ x: 8, y: 13 }, { x: 10, y: 13 }], color: 1 };
    await assert.rejects(submit({ ...directed.director, allowedOperations: ['rect', 'polygon'] }), /mảng từ 3 đến 128/);
    const parts = response.parts.map(part => ({ partId: part.id, paint: part.paint }));
    const compact = (body: unknown) => ports.validate('builder', JSON.stringify(body), prepared, directed.director).promise;
    await assert.rejects(compact({ version: 1, description: 'Đổi canvas', parts, canvas: { w: 100, h: 100 } }), /thuộc tính thiếu hoặc không được hỗ trợ/);
    const duplicate = [parts[0], parts[0], ...parts.slice(2)];
    await assert.rejects(compact({ version: 1, description: 'Trùng bộ phận', parts: duplicate }), /xuất hiện hai lần/);
  } finally { runtime.close(true); }
});

test('character construction offers restrained finishes and preserves broad planes, ink and the original', () => {
  const f = setup();
  const base = { ...f.recipe, palette: [0x1f1424ff, 0x707d8fff, 0x8893a1ff, 0x9ba7b1ff],
    materials: [], parts: f.recipe.parts.map(part => ({ ...part, paint: [] })) };
  const materials = [{ id: 'steel', name: 'Thép', colors: [0, 1, 2, 3] }];
  const direction = { ...f.director, materials,
    allowedOperations: ['rect', 'line', 'polygon', 'pixels'],
    parts: f.director.parts.map((part, index) => ({ ...part, materialIds: index ? [] : ['steel'] })),
    construction: f.director.parts.map((part, index) => ({ partId: part.id,
      commands: index ? [] : [0, 1, 2, 3].map(color => `R ${color + 2} 4 1 2 ${color}`),
    })),
  };
  const resources = { sources: [], masks: [] };
  const director = validateCharacterConstruction(direction, base, resources, 'proposal');
  assert.deepEqual(validateCharacterConstruction(director, base, resources, 'approved'), director);
  assert.throws(() => validateCharacterConstruction(director, base, resources, 'proposal'), /thuộc tính thiếu hoặc không được hỗ trợ/);
  const render = (choice: 'A' | 'B' | 'C', design = director) =>
    createRecipeRenderer(buildCharacterFinish({ finish: choice }, base, design, resources).recipe).renderFrame('rest').image.data;
  const a = render('A'), b = render('B'), c = render('C');
  assert.ok(a.every((color, index) => Boolean(color) === Boolean(b[index])));
  assert.deepEqual([...a.slice(4 * 16 + 2, 4 * 16 + 6)], [base.palette[0], base.palette[1], base.palette[2], base.palette[2]]);
  assert.deepEqual([...b.slice(4 * 16 + 2, 4 * 16 + 6)], [base.palette[0], base.palette[1], base.palette[1], base.palette[3]]);
  assert.deepEqual([...c.slice(4 * 16 + 2, 4 * 16 + 6)], base.palette);
  assert.throws(() => buildCharacterFinish({ finish: 'A', width: 18 }, base, director, resources), /thuộc tính thiếu hoặc không được hỗ trợ/);
  const withCommands = (commands: string[], allowedOperations = direction.allowedOperations) => ({
    ...direction, allowedOperations, construction: direction.construction.map((part, index) => index ? part : { ...part, commands }),
  });
  const broad = validateCharacterConstruction(withCommands([...direction.construction[0].commands, 'R 2 8 8 6 2']), base, resources, 'proposal');
  assert.deepEqual(render('B', broad), render('C', broad));
  assert.notDeepEqual(render('A', broad), render('C', broad));
  assert.throws(() => validateCharacterConstruction(withCommands(['R 0 0 1 1 -']), base, resources, 'proposal'), /không có pixel nhìn thấy/);
  const marks = ['L 0 3 3 3 1', 'P 2 9,9 12,9 10,12', 'X 8 8 .1/012', 'R 8 8 1 1 -'];
  const parsed = validateCharacterConstruction(withCommands([...direction.construction[0].commands, ...marks]), base, resources, 'proposal');
  assert.deepEqual(parsed.construction?.[0].paint.slice(-4), [
    { kind: 'line', x0: 0, y0: 3, x1: 3, y1: 3, color: 1 },
    { kind: 'polygon', color: 2, points: [{ x: 9, y: 9 }, { x: 12, y: 9 }, { x: 10, y: 12 }] },
    { kind: 'pixels', x: 8, y: 8, rows: ['.1.', '012'] },
    { kind: 'rect', x: 8, y: 8, w: 1, h: 1, color: null },
  ]);
  for (const malformed of ['P 1 0,0 1,1', 'R 0 0 1 1 2\n', 'L 0 1 5.4 1 2', 'X 8 8 .1//01']) {
    assert.throws(() => validateCharacterConstruction(withCommands([malformed]), base, resources, 'proposal'), /Lệnh bố cục không hợp lệ/);
  }
  assert.throws(() => validateCharacterConstruction(withCommands(['X 15 0 01']), base, resources, 'proposal'), /nằm trong canvas/);
  assert.throws(() => validateCharacterConstruction(withCommands(['L 0 0 0 1 4']), base, resources, 'proposal'), /0\.\.3/);
  assert.throws(() => validateCharacterConstruction(withCommands([marks[0]], ['rect']), base, resources, 'proposal'), /ngoài chỉ đạo/);
  const facet = 'F 1 3 0 6,7 10,7 6,5 10,5 10,9 6,9';
  const panel = validateCharacterConstruction(withCommands([...direction.construction[0].commands, facet]), base, resources, 'proposal');
  assert.deepEqual(panel.construction?.[0].paint.at(-1), { kind: 'pixels', x: 6, y: 5, rows: ['3330', '3330', '1110', '0000'] });
  assert.deepEqual(validateCharacterConstruction(panel, base, resources, 'approved'), panel);
  assert.throws(() => validateCharacterConstruction(withCommands([facet], ['rect']), base, resources, 'proposal'), /ngoài chỉ đạo/);
  assert.throws(() => validateCharacterConstruction(withCommands([facet.replace('10,7', '6,7')]), base, resources, 'proposal'), /hai đầu|Hai đầu/);
  assert.throws(() => validateCharacterConstruction(withCommands([facet.replace('1 3 0', '1 4 0')]), base, resources, 'proposal'), /0\.\.3/);
  assert.throws(() => validateCharacterConstruction(withCommands([facet.replace('10,9', '17,9')]), base, resources, 'proposal'), /0\.\.16/);
  const volume = 'V 1 3 0 7,6 2,1 6,5 10,5 10,9 6,9';
  const rounded = validateCharacterConstruction(withCommands([...direction.construction[0].commands, volume]), base, resources, 'proposal');
  assert.deepEqual(rounded.construction?.[0].paint.at(-1), { kind: 'pixels', x: 6, y: 5, rows: ['3330', '3330', '1110', '0000'] });
  const inset = volume.replace('7,6 2,1', '7,6 1,1');
  assert.deepEqual(validateCharacterConstruction(withCommands([inset]), base, resources, 'proposal').construction?.[0].paint.at(-1),
    { kind: 'pixels', x: 6, y: 5, rows: ['3310', '3310', '1110', '0000'] });
  for (const invalid of [volume.replace('2,1', '0,1'), volume.replace('7,6', '17,6'), volume.replace('2,1', '2,17')]) {
    assert.throws(() => validateCharacterConstruction(withCommands([invalid]), base, resources, 'proposal'), /Lệnh bố cục không hợp lệ/);
  }
  assert.throws(() => validateCharacterConstruction(withCommands([volume], ['rect']), base, resources, 'proposal'), /ngoài chỉ đạo/);
  const large = { ...base, canvas: { w: 128, h: 128 } };
  const largeCommands = (extra: string) => withCommands([...direction.construction[0].commands, extra]);
  const dense = validateCharacterConstruction(largeCommands(facet), large, resources, 'proposal').construction?.[0].paint.at(-1);
  assert.ok(dense?.kind === 'pixels' && 'pixels' in dense);
  assert.equal(dense.pixels.length, 16);
  assert.deepEqual(dense.pixels[0], { x: 6, y: 5, color: 3 });
  const nativeVolume = validateCharacterConstruction(largeCommands(inset), large, resources, 'proposal').construction?.[0].paint.at(-1);
  assert.ok(nativeVolume?.kind === 'pixels' && 'pixels' in nativeVolume);
  assert.deepEqual(nativeVolume.pixels.slice(0, 4), [3, 3, 1, 0].map((color, offset) => ({ x: 6 + offset, y: 5, color })));
  const detailed = validateCharacterConstruction(largeCommands('X 93 70 .1/02'), large, resources, 'proposal');
  assert.deepEqual(detailed.construction?.[0].paint.at(-1), { kind: 'pixels', pixels: [
    { x: 94, y: 70, color: 1 }, { x: 93, y: 71, color: 0 }, { x: 94, y: 71, color: 2 },
  ] });
  const added = buildCharacterFinish({ finish: 'A' }, large, detailed, resources).recipe;
  assert.equal(createRecipeRenderer(added).renderFrame('rest').image.data[71 * 128 + 93], base.palette[0]);
  for (const invalid of ['X 127 70 .1', 'X 0 0 ' + '1'.repeat(17), 'X 0 127 1/1']) {
    assert.throws(() => validateCharacterConstruction(largeCommands(invalid), large, resources, 'proposal'), /Cụm pixel canvas lớn/);
  }
  assert.throws(() => validateCharacterConstruction(largeCommands('X 0 0 ..'), large, resources, 'proposal'), /ít nhất một ô có màu/);
  assert.throws(() => validateCharacterConstruction(largeCommands('X 0 0 f'), large, resources, 'proposal'), /0\.\.3/);
});
test('tile material review checks exact 3×3 repeat and a native autotiled map', async () => {
  const f = setup(), runtime = new QualityRuntime(), engine = new QualityEngine(runtime.ports(f.external));
  f.input.prompt = 'Dựng một ô vật liệu đá 16×16';
  f.recipe.parts[0].paint.unshift({ kind: 'rect', x: 0, y: 0, w: 16, h: 16, color: 0 });
  f.recipe.parts[0].paint.push(
    { kind: 'rect', x: 0, y: 4, w: 1, h: 1, color: 1 },
    { kind: 'rect', x: 6, y: 0, w: 1, h: 1, color: 1 },
  );
  try {
    const ready = await engine.wait(engine.start(f.input).id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.deepEqual(f.calls[0].images.map(image => image.name), ['source.png']);
    for (const call of f.calls.slice(0, 2)) {
      assert.match(call.instruction, /phiến đá bất quy tắc/);
      assert.match(call.instruction, /lòng hang do bố cục autotile tạo/);
      assert.match(call.instruction, /cụm cỏ ở độ cao so le/);
      assert.doesNotMatch(call.instruction, /silhouette/);
    }
    const review = f.calls[2];
    assert.match(review.instruction, /giao điểm bốn ô/);
    assert.equal(f.calls[1].reasoningEffort, 'low');
    assert.equal(ready.calls[1].reasoningEffort, 'low');
    assert.equal(f.calls[0].reasoningEffort, undefined);
    assert.equal(review.reasoningEffort, undefined);
    assert.match(review.instruction, /phân biệt khoảng trống từ bố cục/);
    assert.match(review.instruction, /dải cỏ rộng hết ô lặp thành vạch/);
    assert.match(review.instruction, /Giữ đường cỏ thẳng nếu người dùng yêu cầu/);
    assert.doesNotMatch(review.instruction, /"luma"/);
    assert.deepEqual(review.images.map(image => image.name), ['source.png', 'review-sheet-1.png', 'review-detail-4x.png', 'review-terrain-repeat.png', 'review-terrain-map.png']);
    const native = decodeQualityPng(review.images[1].data);
    const horizontal: number[] = [], vertical: number[] = [];
    for (let i = 0; i < native.w; i++) {
      if (native.pixels[i * native.w] !== native.pixels[(i + 1) * native.w - 1]) horizontal.push(i);
      if (native.pixels[i] !== native.pixels[(native.h - 1) * native.w + i]) vertical.push(i);
    }
    assert.ok(horizontal.includes(4) && vertical.includes(6));
    assert.ok(review.instruction.includes(`Mép trái/phải khác nhau ở ${horizontal.length} hàng y=${JSON.stringify(horizontal)}`));
    assert.ok(review.instruction.includes(`Mép trên/dưới khác nhau ở ${vertical.length} cột x=${JSON.stringify(vertical)}`));
    assert.match(review.instruction, /dải nối \/ trong ô.*trái–phải [\d.]+ \/ [\d.]+, trên–dưới [\d.]+ \/ [\d.]+/);
    assert.ok(f.calls.slice(0, 2).every(call => !call.instruction.includes('Chẩn đoán worker')));
    const repeat = decodeQualityPng(review.images[3].data);
    assert.deepEqual([repeat.w, repeat.h], [96, 96]);
    for (let y = 0; y < repeat.h; y++) {
      for (let x = 0; x < repeat.w; x++) {
        const source = (Math.floor(y / 2) % native.h) * native.w + (Math.floor(x / 2) % native.w);
        assert.equal(repeat.pixels[y * repeat.w + x], native.pixels[source]);
      }
    }
    const map = decodeQualityPng(review.images[4].data), size = native.w;
    assert.deepEqual([map.w, map.h], [8 * size, 6 * size]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      assert.equal(map.pixels[(size + y) * map.w + 6 * size + x], native.pixels[y * size + x], 'Interior tile keeps RGBA');
      assert.equal(map.pixels[(2 * size + y) * map.w + 2 * size + x], 0, 'Layout leaves the opening clear');
    }
    assert.ok(map.pixels.every((pixel, index) => pixel === 0 || pixel === native.pixels[Math.floor(index / map.w) % size * size + index % size]));
  } finally { await engine.close(); runtime.close(true); }
});
test('motion source/mask/locked frame round-trip keeps original review RGBA and attaches a separate rig guide', async () => {
  const f = setup(true), runtime = new QualityRuntime(), engine = new QualityEngine(runtime.ports(f.external));
  try {
    const result = await engine.wait(engine.start(f.input).id); assert.equal(result.status, 'ready', result.message);
    assert.deepEqual(f.calls[2].images.map(image => image.name), ['source.png', 'review-sheet-1.png', 'review-motion-guide.png']);
    assert.match(f.calls[2].instruction, /chuyển tiếp cuối–đầu/);
    const review = decodeQualityPng(f.calls[2].images[1].data); assert.deepEqual([review.w, review.h], [33, 16]);
    const guide = decodeQualityPng(f.calls[2].images[2].data);
    assert.deepEqual([guide.w, guide.h], [33, 16]);
    for (const [x, y] of [[9, 4], [24, 6]]) {
      assert.equal(guide.pixels[y * guide.w + x], 0x37daf3ff);
      assert.equal(review.pixels[y * review.w + x], 0xeef7f8ff);
    }
    assert.ok(!guide.pixels.some((color, index) => index % guide.w === 16 && color !== 0));
    const snapshotId = f.calls[0].snapshotId, assetData = await runtime.materialize(snapshotId, result.selectedVariantId!, 7).promise;
    const { asset } = wireParse(Buffer.from(assetData.data).toString('utf8'));
    assert.deepEqual(composite(asset, asset.frames[0].id).data, f.snapshot.source.pixels);
    assert.equal(composite(asset, asset.frames[1].id).get(7, 6), 0xeef7f8ff);
    const manifest = readFileSync(join(runtime.root, snapshotId, 'snapshot.json'), 'utf8'); assert.ok(manifest.includes('$qualityArray')); assert.ok(!manifest.includes('"pixels":['));
    assert.ok(readdirSync(join(runtime.root, snapshotId)).some(n => n.endsWith('.bin.z')));
  } finally { await engine.close(); runtime.close(true); }
});
test('external changes to snapshot JSON, binary blobs or a candidate invalidate worker reads without another AI call', async () => {
  for (const what of ['snapshot', 'blob', 'variant'] as const) {
    const f = setup(true), runtime = new QualityRuntime(), ports = runtime.ports(f.external); let prepared: QualityPrepared | undefined;
    try {
      prepared = await ports.prepare(f.input).promise;
      const dir = join(runtime.root, prepared.snapshotId);
      const directed = await ports.validate('director', JSON.stringify(f.director), prepared).promise; assert.equal(directed.kind, 'director');
      if (directed.kind !== 'director') throw Error('fixture');
      const built = await ports.validate('builder', JSON.stringify({ version: 1, description: 'Bản dựng', recipe: f.recipe }), prepared, directed.director).promise; assert.equal(built.kind, 'variant');
      if (built.kind !== 'variant') throw Error('fixture');
      const path = what === 'snapshot' ? join(dir, 'snapshot.json') : what === 'variant' ? join(dir, `variant-${built.variant.id}.json`) : join(dir, readdirSync(dir).find(n => n.endsWith('.bin.z'))!);
      writeFileSync(path, what === 'snapshot' || what === 'variant' ? '{}' : Buffer.from('corrupted'));
      await assert.rejects(runtime.materialize(prepared.snapshotId, built.variant.id, 7).promise);
      assert.equal(f.calls.length, 0);
    } finally { if (prepared) ports.drop(prepared.snapshotId); runtime.close(true); }
  }
});
test('invalid output is repairable data; unsupported/unapproved contexts fail before any CLI and leave no orphan snapshots', async () => {
  const f = setup(), runtime = new QualityRuntime(), ports = runtime.ports(f.external);
  try {
    const prepared = await ports.prepare(f.input).promise;
    await assert.rejects(ports.validate('director', 'bad JSON', prepared).promise, QualityTechnicalError);
    const invalid = setup(true); delete (invalid.input.context as any).approval;
    await assert.rejects(ports.prepare(invalid.input).promise);
    const freeAnimation = setup(true); freeAnimation.input.context = { kind: 'free', recipe: freeAnimation.recipe, resources: { sources: [], masks: [] } };
    await assert.rejects(ports.prepare(freeAnimation.input).promise, /rig|duyệt/);
    assert.equal(f.calls.length, 0); assert.equal(readdirSync(runtime.root).length, 1);
    ports.drop(prepared.snapshotId);
  } finally { runtime.close(true); }
});
