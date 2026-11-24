import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { QualityCliTransport, findQualityExecutable, INLINE_JSON_MARKER } from '../src/node/studio/quality-cli.ts';
import { QualityRuntime } from '../src/node/studio/quality-runtime.ts';
import { QualityEngine } from '../src/node/studio/quality-engine.ts';
import type { QualityExecution, QualityStartInput } from '../src/node/studio/quality-ports.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { decodeQualityPng } from './quality-image-fixture.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { qualityHttpFixture } from './fixtures/quality-http.ts';

function setup(scenario: string, directorTimeout = 15000) {
  const work = mkdtempSync(join(tmpdir(), 'lumasprite-cli-test-')), log = join(work, 'calls.jsonl');
  const runtime = new QualityRuntime(), transport = new QualityCliTransport((s, c) => runtime.cliContext(s, c), {
    providers: { codex: { executable: process.execPath, prefix: [resolve('test/fixtures/quality-cli.cjs'), scenario, log] } },
    deepseek: qualityHttpFixture(scenario, log),
  });
  const f = motionFixture(); f.recipe.frames = f.recipe.frames.slice(0, 1); let busy = false;
  const reviewImages: QualityExecution['images'] = [];
  const input: QualityStartInput = { projectId: 'project', revision: 7, prompt: 'Giữ hình nguồn cho bài kiểm tra transport', style: 'RPG viền mảnh', context: { kind: 'free', recipe: f.recipe, resources: { sources: [], masks: [] } } };
  const engine = new QualityEngine(runtime.ports({ acquire() { assert.equal(busy, false); busy = true; return { release() { busy = false; }, check() { assert.equal(busy, true); } }; }, assertCurrent() {}, execute(r) {
    if (r.role === 'reviewer') reviewImages.push(...r.images);
    return transport.execute(r);
  } }), { limits: { director: directorTimeout, builder: 15000, reviewer: 15000, total: 60000 } });
  return { runtime, transport, engine, input, f, log, reviewImages,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [],
    async close() { await engine.close(); assert.equal(await transport.close(), true); runtime.close(true); rmSync(work, { recursive: true, force: true }); },
  };
}

test('mixed quality transport keeps Codex native-image context and sends DeepSeek inline JSON without PNG or local paths', { timeout: 60000 }, async () => {
  const x = setup('valid');
  try {
    const run = await x.engine.wait(x.engine.start(x.input).id); assert.equal(run.status, 'ready', run.message); assert.equal(run.cliCalls, 3);
    const calls = x.calls(); assert.deepEqual(calls.map(c => [c.role, c.codex]), [['director', true], ['builder', false], ['reviewer', true]]);
    assert.ok(calls[0].stdin.includes('resource-index.json')); assert.ok(calls[0].images.length >= 1); assert.ok(calls[2].images.length >= 2);
    assert.match(calls[0].stdin, /vật liệu chính vẫn đọc rõ ở 1×/);
    assert.match(calls[0].stdin, /Plan one static asset.*zero-based palette indices/);
    assert.doesNotMatch(calls[0].stdin, /Frame pixelEdits|candidate-recipe\.json/);
    assert.ok(!calls[0].images.map((path: string) => basename(path)).includes('review-detail-4x.png'));
    assert.match(calls[2].stdin, /mọi tọa độ patch vẫn theo canvas gốc/);
    assert.match(calls[2].stdin, /Omitted trailing dots leave earlier paint untouched/);
    assert.ok(calls[2].images.map((path: string) => basename(path)).includes('review-detail-4x.png'));
    const byImageName = new Map(x.reviewImages.map(image => [image.name, image.data]));
    const native = decodeQualityPng(byImageName.get('review-sheet-1.png')!);
    const enlarged = decodeQualityPng(byImageName.get('review-detail-4x.png')!);
    assert.deepEqual([enlarged.w, enlarged.h], [native.w * 4, native.h * 4]);
    for (let y = 0; y < enlarged.h; y++) {
      for (let x = 0; x < enlarged.w; x++) {
        assert.equal(enlarged.pixels[y * enlarged.w + x], native.pixels[Math.floor(y / 4) * native.w + Math.floor(x / 4)]);
      }
    }
    // Small static proposals also carry the same approved JSON metadata inline, so
    // the installed CLI needs no shell/file read for it in the read-only sandbox.
    // The owned copies stay on disk for fixtures, attachments and tamper checks.
    const inlineJson = (call: { role: string; stdin: string; flags: string[] }) => {
      const lines = call.stdin.split('\n'), at = lines.findIndex(line => line.startsWith(INLINE_JSON_MARKER));
      assert.ok(at >= 1, `${call.role} stdin must carry the identifiable inline marker`);
      const schemaPath = call.flags[call.flags.indexOf('--output-schema') + 1];
      assert.ok(!call.stdin.includes('Read first:') && !call.stdin.includes(schemaPath));
      assert.match(lines[at], /authoritative/); assert.match(lines[at], /do not run shell\/file reads/);
      const block = lines[at + 1], parsed = JSON.parse(block) as Record<string, any>, keys = Object.keys(parsed);
      assert.ok(keys.every(k => k.endsWith('.json')), 'the inline block holds JSON metadata only, never PNG/RGBA');
      assert.ok(!block.includes('iVBORw0KGgo') && !block.includes('data:image'), 'no PNG/base64 inside the inline block');
      assert.ok(Buffer.byteLength(block) <= 24 * 1024 && call.stdin.length <= 250000, 'the inline block stays bounded');
      return { schemaPath, keys, parsed };
    };
    const directorInline = inlineJson(calls[0]), reviewerInline = inlineJson(calls[2]);
    assert.deepEqual(directorInline.keys, ['source-recipe.json', 'resource-index.json']);
    assert.deepEqual(reviewerInline.keys, ['source-recipe.json', 'resource-index.json', 'candidate-recipe.json']);
    assert.deepEqual(directorInline.parsed['source-recipe.json'], x.f.recipe);
    assert.deepEqual(directorInline.parsed['resource-index.json'], calls[0].index);
    assert.equal(reviewerInline.parsed['candidate-recipe.json'].name, x.f.recipe.name);
    assert.ok(reviewerInline.parsed['candidate-recipe.json'].frames.length >= 1);
    assert.notEqual(directorInline.schemaPath, reviewerInline.schemaPath);
    assert.ok(!calls[0].flags.includes('--ignore-user-config')); assert.ok(!calls[0].flags.includes('--model'));
    assert.equal(calls[1].provider, 'deepseek'); assert.equal(calls[1].transport, 'http'); assert.deepEqual(calls[1].images, []);
    assert.deepEqual(calls[1].files['source-recipe.json'], x.f.recipe); assert.ok(calls[1].files['resource-index.json']);
    assert.ok(!calls[1].stdin.includes(x.transport.root)); assert.deepEqual(calls[1].flags, []);
    assert.deepEqual(run.calls[0].usage, { input: 37, output: 23, cached: 11 }); assert.deepEqual(run.calls[1].usage, { input: 19, output: 13 });
  } finally { await x.close(); }
});

test('invalid or whitespace-only builder JSON consumes one shared repair; fences do not cause a fourth call', { timeout: 60000 }, async () => {
  for (const scenario of ['repair', 'empty-json', 'fence']) {
    const x = setup(scenario);
    try {
      const run = await x.engine.wait(x.engine.start(x.input).id); assert.equal(run.status, 'ready', run.message);
      const repairs = scenario === 'fence' ? 0 : 1;
      assert.equal(run.technicalRepairs, repairs); assert.equal(x.calls().length, 3 + repairs);
      if (scenario === 'empty-json') {
        assert.match(x.calls()[2].stdin, /AI không trả nội dung JSON đề xuất/);
        assert.deepEqual(run.calls.map(call => [call.role, call.status]), [['director', 'succeeded'], ['builder', 'invalid'], ['builder', 'succeeded'], ['reviewer', 'succeeded']]);
      }
    } finally { await x.close(); }
  }
});

test('an empty HTTP stream reporting tokens stops quality at builder without repair, reviewer or source changes', { timeout: 60000 }, async () => {
  const x = setup('empty-stream'), before = structuredClone(x.input.context);
  try {
    const run = await x.engine.wait(x.engine.start(x.input).id);
    assert.equal(run.status, 'failed');
    assert.match(run.message, /DeepSeek API.*không trả nội dung.*usage đầu ra: 13/);
    assert.equal(run.technicalRepairs, 0);
    assert.equal(run.cliCalls, 2);
    assert.deepEqual(run.calls.map(call => [call.role, call.status]), [['director', 'succeeded'], ['builder', 'failed']]);
    assert.deepEqual(x.calls().map(call => call.role), ['director', 'builder']);
    assert.equal(x.reviewImages.length, 0);
    assert.deepEqual(x.input.context, before);
  } finally { await x.close(); }
});

test('a new character uses its own art direction and validates a sealed reviewer answer even if the CLI lingers', { timeout: 25000 }, async () => {
  const x = setup('reviewer-completed-character');
  x.input.prompt = 'Forest knight, complete silhouette, readable equipment';
  for (const part of x.f.recipe.parts) part.paint = [];
  try {
    const run = await x.engine.wait(x.engine.start(x.input).id);
    assert.equal(run.status, 'ready', run.message);
    assert.equal(run.cliCalls, 3);
    const calls = x.calls();
    assert.match(calls[0].stdin, /đỉnh đầu, cằm, vai, eo, hông, gối, đế giày/);
    assert.match(calls[1].stdin, /cổ chồng vào vai/);
    assert.match(calls[2].stdin, /cổ–vai liền mạch/);
    assert.ok(calls[2].images.some((path: string) => basename(path) === 'review-shape-value.png'));
    assert.ok(calls.every(call => !/Với lọ kính|Với khiên/.test(call.stdin)));
    assert.ok(run.calls[2].elapsedMs! < 13000, 'CLI should close well before its budget');
    assert.equal(run.variants.length, 2);
  } finally { await x.close(); }
});

test('provider-reported quota failure and modified context stop the run without provider fallback or technical repair', { timeout: 60000 }, async () => {
  for (const scenario of ['quota', 'tamper']) {
    const x = setup(scenario);
    try {
      const run = await x.engine.wait(x.engine.start(x.input).id); assert.equal(run.status, 'failed'); assert.match(run.message, scenario === 'quota' ? /quota/ : /thay đổi bản sao/);
      assert.equal(run.technicalRepairs, 0); assert.equal(x.calls().length, 1);
    } finally { await x.close(); }
  }
});

test('nonzero CLI exit prefers the latest terminal event or final stderr root cause over earlier warnings', { timeout: 60000 }, async () => {
  for (const scenario of ['stderr-warnings-nonzero', 'stderr-only-nonzero']) {
    const x = setup(scenario);
    try {
      const run = await x.engine.wait(x.engine.start(x.input).id); assert.equal(run.status, 'failed');
      // The trailing newline in stderr must not leak into the compared message.
      assert.match(run.message, /fixture root cause/);
      assert.ok(run.message.length <= 2000, `bounded failure message, got ${run.message.length}`);
      if (scenario === 'stderr-warnings-nonzero') assert.doesNotMatch(run.message, /\[warn 0\]|\[warn \d\]/);
      // A stderr-only tail of 1800 chars may legitimately include later warnings,
      // but the oldest warning marker must have been dropped.
      else assert.doesNotMatch(run.message, /\[warn 0\]/);
      assert.equal(run.technicalRepairs, 0); assert.equal(x.calls().length, 1);
    } finally { await x.close(); }
  }
});

test('director timeout keeps only the last known Codex phase and confirms the child stopped', { timeout: 20000 }, async () => {
  const x = setup('director-progress-timeout', 6000);
  try {
    const run = await x.engine.wait(x.engine.start(x.input).id);
    assert.equal(run.status, 'failed');
    assert.match(run.message, /vượt thời gian.*đã phát sự kiện suy luận/);
    assert.doesNotMatch(JSON.stringify(run), /hidden-fixture/);
    assert.deepEqual(run.calls.map(call => [call.role, call.status]), [['director', 'failed']]);
    assert.equal(run.technicalRepairs, 0);
    assert.deepEqual(x.calls().map(call => call.role), ['director']);
  } finally { await x.close(); }
});

test('source raster and binary mask maps reach CLI context with exact native pixels and candidate copies', { timeout: 20000 }, async () => {
  const f = motionFixture(); f.recipe.frames = f.recipe.frames.slice(0, 1);
  const source = new Uint32Array(256); source[17] = f.recipe.palette[0]; const mask = new Uint8Array(256); mask[17] = 1;
  f.recipe.parts[0].paint = [{ kind: 'raster', sourceId: 'sheet', sourceRect: { x: 0, y: 0, w: 16, h: 16 }, x: 0, y: 0, maskId: 'selected' }];
  const runtime = new QualityRuntime(), ports = runtime.ports({ acquire: () => ({ release() {}, check() {} }), assertCurrent() {}, execute: () => { throw Error('no CLI'); } });
  try {
    const prepared = await ports.prepare({ projectId: 'project', revision: 7, prompt: 'test', style: 'RPG', context: { kind: 'free', recipe: f.recipe, resources: { sources: [{ id: 'sheet', w: 16, h: 16, pixels: source }], masks: [{ id: 'selected', w: 16, h: 16, data: mask }] } } }).promise;
    const files = await runtime.cliContext(prepared.snapshotId).promise, byName = new Map(files.map(f => [f.name, f.data]));
    assert.deepEqual(decodeQualityPng(byName.get('resource-source-0.png')!).pixels, source);
    const maskPng = decodeQualityPng(byName.get('resource-mask-0.png')!); assert.equal(maskPng.pixels[17], 0xffffffff); assert.equal(maskPng.pixels[18], 0);
    const index = JSON.parse(Buffer.from(byName.get('resource-index.json')!).toString('utf8')); assert.equal(index.parts[0].raster[0].maskId, 'selected');
    const copied = JSON.parse(Buffer.from(byName.get('source-recipe.json')!).toString('utf8')); assert.deepEqual(createRecipeRenderer(copied, { sources: [{ id: 'sheet', w: 16, h: 16, pixels: source }], masks: [{ id: 'selected', w: 16, h: 16, data: mask }] }).renderFrame(copied.frames[0].id).image.data, createRecipeRenderer(f.recipe, { sources: [{ id: 'sheet', w: 16, h: 16, pixels: source }], masks: [{ id: 'selected', w: 16, h: 16, data: mask }] }).renderFrame(f.recipe.frames[0].id).image.data);
  } finally { runtime.close(true); }
});

test('transport rejects wrong role/provider, duplicate/outside context names and unavailable executable before spawning a CLI', async () => {
  assert.throws(() => findQualityExecutable('antigravity', join(tmpdir(), 'no-such-lumasprite-cli.exe')), /Antigravity|antigravity|CLI|hỗ trợ/);
  assert.throws(() => findQualityExecutable('deepseek', process.execPath), /DeepSeek|deepseek|CLI|hỗ trợ/);
  const cli = new QualityCliTransport(() => ({ promise: Promise.resolve([{ name: '../escape.json', data: new Uint8Array() }]), stop: async () => true }), { providers: { codex: { executable: process.execPath } } });
  const request: QualityExecution = { role: 'director', provider: 'codex', callId: 'call', snapshotId: 'snapshot', deadline: Date.now() + 5000, budgetMs: 5000, instruction: 'test', images: [] };
  try {
    assert.throws(() => cli.execute({ ...request, provider: 'antigravity' }), /không khớp/);
    await assert.rejects(cli.execute(request).promise, /ngữ cảnh CLI/); assert.throws(() => cli.execute(request), /đã tồn tại/);
  } finally { assert.equal(await cli.close(), true); }
});

test('HTTP transport keeps context owned until local fetch drains and discards a late result after cancellation', async () => {
  const f = motionFixture(); f.recipe.frames = f.recipe.frames.slice(0, 1);
  const files = [
    { name: 'source-recipe.json', data: Buffer.from(JSON.stringify(f.recipe)) },
    { name: 'resource-index.json', data: Buffer.from(JSON.stringify({ sources: [], masks: [], parts: [] })) },
  ];
  let resolveFetch!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const transport = new QualityCliTransport(() => ({ promise: Promise.resolve(files), stop: async () => true }), {
    deepseek: { apiKey: 'fixture-http-cancel-never-real-458921', fetch: (() => { entered(); return new Promise<Response>(r => { resolveFetch = r; }); }) as typeof fetch },
  });
  const root = transport.root;
  const task = transport.execute({ role: 'builder', provider: 'deepseek', callId: 'http-cancel', snapshotId: 'snapshot', deadline: Date.now() + 5000, budgetMs: 5000, instruction: 'test', images: [] });
  try {
    await started;
    assert.equal(await task.stop(Date.now() + 15), false);
    assert.equal(await transport.close(), false); assert.ok(existsSync(root));
    assert.throws(() => transport.dropSnapshot('snapshot'), /chưa xác nhận dừng/);
    resolveFetch(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await assert.rejects(task.promise, /hủy|muộn/);
    assert.match(task.diagnostic!(), /nhà cung cấp/);
    assert.equal(await transport.close(), true); assert.equal(existsSync(root), false);
  } finally {
    resolveFetch?.(new Response('')); await task.promise.catch(() => {}); if (existsSync(root)) await transport.close();
  }
});

test('HTTP builder offers pixel rows only for a small blank static source with pixel permission', async () => {
  for (const source of ['blank', 'blank-pixels', 'large', 'painted', 'motion'] as const) {
    const blank = source !== 'painted' && source !== 'motion';
    const allowPixels = source === 'blank-pixels' || source === 'large';
    const { recipe } = motionFixture();
    if (source !== 'painted') for (const part of recipe.parts) part.paint = [];
    if (source === 'large') recipe.canvas.w = 128;
    recipe.frames = recipe.frames.slice(0, 1);
    const files = [
      { name: 'source-recipe.json', data: Buffer.from(JSON.stringify(recipe)) },
      { name: 'resource-index.json', data: Buffer.from('{}') },
    ];
    if (source === 'motion') files.push({ name: 'approved-motion.json', data: Buffer.from('{}') });
    let payload: { prompt: string; schema: any } | undefined;
    let reasoningEffort: unknown;
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      reasoningEffort = body.reasoning_effort;
      payload = JSON.parse(body.messages[1].content);
      const event = JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] });
      return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const transport = new QualityCliTransport(() => ({ promise: Promise.resolve(files), stop: async () => true }),
      { deepseek: { apiKey: 'fixture-schema-key', fetch: fetcher } });
    try {
      const director: QualityExecution['director'] = { version: 1, description: 'Tạo mẫu', materials: [],
        parts: recipe.parts.map(({ paint: _, ...part }) => part), allowedOperations: allowPixels ? ['rect', 'line', 'polygon', 'pixels'] : ['rect', 'line', 'polygon'] };
      await transport.execute({ role: 'builder', provider: 'deepseek', callId: 'builder-schema', snapshotId: 'snapshot',
        deadline: Date.now() + 5000, budgetMs: 5000, instruction: 'Tạo mẫu', director, images: [], ...(source === 'blank-pixels' ? { reasoningEffort: 'low' as const } : {}) }).promise;
      assert.ok(payload);
      assert.equal(reasoningEffort, source === 'blank-pixels' ? 'low' : undefined);
      assert.match(payload.prompt, /one compact JSON object/);
      if (source === 'motion') {
        assert.match(payload.prompt, /Unlisted parts and frames carry through unchanged/);
        assert.deepEqual(payload.schema.required, ['version', 'description', 'decision', 'patches']);
        assert.equal(payload.schema.properties.patches.maxItems, 664);
        assert.equal(payload.schema.properties.recipe, undefined);
        continue;
      }
      const props = payload.schema.properties.recipe.properties;
      const operations = props.parts.items.properties.paint.items.anyOf;
      const kinds = operations.filter((op: any) => !op.properties.rows).map((op: any) => op.properties.kind.const);
      assert.deepEqual(kinds, blank ? director.allowedOperations : ['rect', 'line', 'polygon', 'pixels', 'raster']);
      assert.equal(operations.some((op: any) => op.properties.rows), source === 'blank-pixels');
      assert.equal(payload.prompt.includes('Omitted trailing dots leave earlier paint untouched'), source === 'blank-pixels');
      assert.equal(props.frames.maxItems, blank ? 1 : 600);
      assert.equal(JSON.stringify(props.frames).includes('pixelEdits'), !blank || allowPixels);
    } finally { assert.equal(await transport.close(), true); }
  }
});
