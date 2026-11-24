import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AiManager, detectProviders } from '../src/node/studio/ai.ts';
import { ProjectStore } from '../src/node/studio/store.ts';
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from '../src/node/studio/deepseek-http.ts';
import type { GenerationContext } from '../src/studio/types.ts';
import type { CandidateExecutionOptions } from '../src/studio/batch-types.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
import { startRender } from '../src/node/studio/runner.ts';
import type { ExportResult } from '../src/node/studio/render.ts';
import { decodeTestPng } from './fixtures/image-assertions.ts';

const source = "sprite('proposal',{w:18,h:24},rect(2,3,12,19,'#70c989'))";
const valid = () => JSON.stringify({ description: 'Một lọ thuốc từ văn bản', files: [{ path: 'art.px.js', content: source }] });
function sse(output: string) {
  const bytes = Buffer.from([
    { model: DEEPSEEK_MODEL, choices: [{ delta: { content: output }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 23 } },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join('') + 'data: [DONE]\n\n');
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { c.enqueue(bytes.subarray(offset, offset + 7)); offset = Math.min(bytes.length, offset + 7); } } }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(reply: (n: number, payload: any) => Response | Promise<Response> = () => sse(valid())) {
  const root = mkdtempSync(join(tmpdir(), 'pxl-fast-http-test-')), store = new ProjectStore(root), doc = store.create('HTTP riêng', 'blank');
  const payloads: any[] = [], events: unknown[] = [], key = 'studio-key-test-separate-from-worker';
  const settings = { codex: join(root, 'absent-codex.exe'), timeout: 5000, deepseek: { apiKey: key,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, DEEPSEEK_BASE_URL + '/chat/completions'); assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer ' + key);
      const payload = JSON.parse(init!.body as string); assert.equal(payload.model, DEEPSEEK_MODEL); assert.equal(payload.tools, undefined);
      payloads.push(payload); return reply(payloads.length, payload);
    }) as typeof fetch } };
  const ai = new AiManager(store, e => events.push(structuredClone(e)), settings);
  return { ai, doc, store, settings, payloads, events, key, root, async close() { await ai.close(); rmSync(root, { recursive: true, force: true }); } };
}
const generation: GenerationContext = { assetId: 'asset', w: 18, h: 24, palette: [0x70c989ff], options: { style: 'game', view: 'front', paletteMode: 'asset', reference: false } };

test('DeepSeek status is configured-unverified without a fetch; text generation works without Codex and requires explicit apply', async () => {
  const x = fixture();
  try {
    const providers = await detectProviders(x.settings);
    assert.equal(providers.deepseek.available, true); assert.match(providers.deepseek.message, /cấu hình/i);
    assert.equal('antigravity' in providers, false); assert.equal(x.payloads.length, 0);
    const before = structuredClone(x.store.load(x.doc.id));
    const job = await x.ai.start(x.doc, 'deepseek', 'Tạo lọ thuốc', undefined, generation);
    const ready = await x.ai.waitFor(job.id);
    assert.equal(ready.status, 'ready', ready.message); assert.equal(x.payloads.length, 1); assert.equal(ready.cliExecutions, 1);
    assert.deepEqual([ready.build!.assets[0].w, ready.build!.assets[0].h], [18, 24]);
    assert.deepEqual(x.store.load(x.doc.id), before);
    assert.ok(!JSON.stringify(x.events).includes(x.key));
    const inline = JSON.parse(x.payloads[0].messages[1].content);
    assert.ok(inline.schema); assert.ok(!JSON.stringify(inline).includes(x.store.dir(x.doc.id)));
    assert.doesNotMatch(inline.prompt, /matching response-schema\.json|may view the copied preview\.png|Read first:/);
    const applied = x.ai.apply(ready.id, before.revision);
    assert.equal(applied.files['art.px.js'], source); assert.ok(applied.revision > before.revision);
  } finally { await x.close(); }
});

test('invalid proposal JSON or source uses one technical repair; HTTP errors do not retry', async () => {
  for (const first of ['bad JSON', JSON.stringify({ description: 'invalid art', files: [{ path: 'art.px.js', content: 'throw Error("invalid")' }] }), 401, 429, 500]) {
    const x = fixture(n => typeof first === 'number' ? new Response('private provider body', { status: first }) : sse(n === 1 ? first : valid()));
    try {
      const job = await x.ai.start(x.doc, 'deepseek', 'Tạo sprite', undefined, generation), result = await x.ai.waitFor(job.id);
      assert.equal(result.status, typeof first === 'number' ? 'failed' : 'ready', result.message);
      assert.equal(x.payloads.length, typeof first === 'number' ? 1 : 2);
      assert.ok(!JSON.stringify(result).includes('private provider body'));
    } finally { await x.close(); }
  }
});

test('an empty HTTP stream reporting tokens fails fast generation once and preserves project revision and files', async () => {
  const x = fixture(() => sse(''));
  const before = structuredClone(x.store.load(x.doc.id));
  try {
    const job = await x.ai.start(x.doc, 'deepseek', 'Tạo sprite', undefined, generation);
    const result = await x.ai.waitFor(job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /DeepSeek API.*không trả nội dung.*usage đầu ra: 23/);
    assert.equal(x.payloads.length, 1);
    assert.equal(result.cliExecutions, 1);
    assert.equal(result.proposal, undefined);
    assert.deepEqual(x.store.load(x.doc.id), before);
    assert.ok(!JSON.stringify(x.events).includes(x.key));
  } finally { await x.close(); }
});

test('image-dependent fast requests and retired provider are rejected before any fetch', async () => {
  const x = fixture();
  try {
    const scenarios: { preview?: Uint8Array; mask?: Uint8Array; generation?: GenerationContext; options?: CandidateExecutionOptions }[] = [
      { preview: new Uint8Array([1]) }, { mask: new Uint8Array([1]) },
      { generation: { ...generation, options: { ...generation.options, reference: true } } },
      { generation: { ...generation, operation: 'region-edit' } },
      { options: { guideImage: { name: 'guide.png', data: new Uint8Array([1]) } } },
      { options: { referenceImages: [{ name: 'reference.png', data: new Uint8Array([1]) }] } },
      { options: { artDirection: { references: [{ assetId: 'source', frameId: 'frame' }] } } },
      { generation: { ...generation, options: { ...generation.options, animation: { frameId: 'frame', mode: 'whole', frames: 4, duration: 100, loop: true, anchor: { x: 9, y: 24 } } } } },
      { generation: { ...generation, animation: { frameId: 'frame', mode: 'whole', frames: 4, duration: 100, loop: true, anchor: { x: 9, y: 24 }, referenceFile: '_pxl_reference.px.js' } } },
      { preview: new Uint8Array() }, { mask: new Uint8Array() },
    ];
    for (const s of scenarios) await assert.rejects(x.ai.start(x.doc, 'deepseek', 'Tạo ảnh', s.preview, s.generation, s.mask, s.options), /Codex/);
    await assert.rejects(x.ai.start(x.doc, 'antigravity', 'Tạo ảnh'), /Antigravity|provider|hỗ trợ/i);
    assert.equal(x.payloads.length, 0); assert.equal(x.ai.jobs.size, 0);
  } finally { await x.close(); }
});

test('an expired candidate deadline never sends an HTTP request', async () => {
  const x = fixture();
  try {
    const job = await x.ai.start(x.doc, 'deepseek', 'Không gửi sau hạn', undefined, generation, undefined, { candidateIndex: 0, deadline: Date.now() - 1 });
    const result = await x.ai.waitFor(job.id);
    assert.ok(['failed', 'canceled'].includes(result.status), result.message);
    assert.equal(x.payloads.length, 0); assert.equal(result.cliExecutions, 0);
  } finally { await x.close(); }
});

test('unconfirmed HTTP cancellation stays busy, drops late output and can later confirm the same owned task', { timeout: 15000 }, async () => {
  let resolveFetch!: (value: Response) => void, entered!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; });
  const x = fixture(() => { entered(); return new Promise<Response>(r => { resolveFetch = r; }); });
  x.settings.timeout = 20000;
  try {
    const job = await x.ai.start(x.doc, 'deepseek', 'Tạo sprite', undefined, generation);
    await enteredPromise;
    const unknown = await x.ai.cancel(job.id);
    assert.equal(unknown.status, 'unknown');
    await assert.rejects(x.ai.start(x.doc, 'deepseek', 'Không tạo thêm khi chưa dừng'), /tác vụ AI|đang/);
    assert.equal(x.payloads.length, 1);
    resolveFetch(sse(valid()));
    const confirmed = await x.ai.cancel(job.id);
    assert.equal(confirmed.status, 'canceled'); assert.match(confirmed.message, /chưa xác nhận/i);
    assert.equal((await x.ai.waitFor(job.id)).proposal, undefined);
    assert.equal(x.payloads.length, 1); assert.equal(x.store.load(x.doc.id).revision, x.doc.revision);
  } finally { resolveFetch?.(sse(valid())); await x.close(); }
});

test('three text candidates render distinct native assets with HTTP metadata, then explicit apply invalidates older proposals', async () => {
  const x = fixture(), http = fastHttpFixture(x.root);
  x.settings.deepseek.apiKey = http.apiKey!; x.settings.deepseek.fetch = http.fetch!;
  try {
    const ids: string[] = [], colors: number[] = [];
    for (let candidateIndex = 0; candidateIndex < 3; candidateIndex++) {
      const job = await x.ai.start(x.doc, 'deepseek', 'Tạo vật phẩm khác nhau', undefined,
        { ...generation, options: { ...generation.options, paletteMode: 'auto16' } }, undefined, { candidateIndex });
      const result = await x.ai.waitFor(job.id);
      assert.equal(result.status, 'ready', result.message); ids.push(job.id);
      assert.equal(result.transport, 'http'); assert.equal(result.model, DEEPSEEK_MODEL);
      assert.deepEqual(result.usage, { input: 17, output: 23 }); assert.equal(result.cliExecutions, 1);
      assert.deepEqual([result.build!.assets[0].w, result.build!.assets[0].h], [18, 24]);
      const exported = await startRender({ document: x.ai.candidate(job.id), mode: 'export', name: 'canvas', format: 'png' }).promise as ExportResult;
      const png = decodeTestPng(Buffer.from(exported.data));
      assert.deepEqual([png.w, png.h], [18, 24]);
      assert.equal(png.data[0], 0); assert.equal(png.data[12 * 18 + 9], 0xffffffff);
      colors.push(png.data[11 * 18 + 8]);
    }
    assert.deepEqual(colors, [0x70c989ff, 0x3b82f6ff, 0xef4444ff]);
    const calls = readFileSync(join(x.root, 'fixture-cli-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(c => [c.alternative, c.call, c.transport]), [[1, 1, 'http'], [2, 1, 'http'], [3, 1, 'http']]);
    assert.equal(x.store.load(x.doc.id).revision, x.doc.revision);
    x.ai.apply(ids[0], x.doc.revision);
    assert.throws(() => x.ai.candidate(ids[2]), /cũ/);
    assert.ok(!JSON.stringify(x.events).includes(http.apiKey!));
  } finally { await x.close(); }
});

test('cancel after HTTP completion drains the active render before releasing the project', { timeout: 12000 }, async () => {
  const x = fixture(n => sse(n === 1 ? JSON.stringify({ description: 'slow local build', files: [{ path: 'art.px.js', content: 'while(true) {}' }] }) : valid()));
  x.settings.timeout = 8000; let id: string | undefined;
  try {
    const job = await x.ai.start(x.doc, 'deepseek', 'Dựng thử chậm', undefined, generation); id = job.id;
    const deadline = performance.now() + 3000;
    while (job.status !== 'validating' && performance.now() < deadline) await new Promise(r => setTimeout(r, 5));
    assert.equal(job.status, 'validating', job.message);
    const active = (x.ai as any).active.get(job.id);
    assert.ok(active?.render, 'a real local render must be pending'); assert.equal(active.http, undefined, 'completed HTTP is no longer the active operation');
    const started = performance.now();
    const result = await x.ai.cancel(job.id);
    assert.equal(result.status, 'canceled'); assert.ok(performance.now() - started < 2500, 'cancel must terminate the renderer instead of waiting for its timeout');
    assert.equal((x.ai as any).active.has(job.id), false); assert.equal(result.proposal, undefined);
    const next = await x.ai.start(x.doc, 'deepseek', 'Thử sau khi đã dừng', undefined, generation);
    assert.equal((await x.ai.waitFor(next.id)).status, 'ready'); assert.equal(x.payloads.length, 2);
  } finally { if (id) (x.ai as any).active.get(id)?.render?.cancel(); await x.close(); }
});
