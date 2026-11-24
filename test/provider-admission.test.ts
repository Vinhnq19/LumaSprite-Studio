import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { serveStudio } from '../src/node/studio/server.ts';
import { newDocument, wireParse, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pxl-provider-admission-'));
  const app = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio'), providers: {
    codex: process.execPath, prefix: [resolve('studio/fake-cli.js'), '--state-dir', root], deepseek: fastHttpFixture(root), timeout: 5000,
  } });
  const req = (path: string, method = 'GET', value?: unknown) => fetch(new URL(path, app.url), {
    method, headers: { origin: app.url.replace(/\/$/, ''), ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    body: value === undefined ? undefined : wireStringify(value),
  });
  const read = async (response: Response) => wireParse(await response.text());
  const calls = () => { const p = join(root, 'fixture-cli-calls.jsonl'); return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0; };
  async function create(document?: PixelDocument) {
    const response = await req('/api/pixel/projects', 'POST', document ? { name: document.name, document } : { name: 'Provider admission', w: 18, h: 24 });
    assert.equal(response.status, 201); return await read(response) as PixelDocument;
  }
  async function terminal(path: string) {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const response = await req(path); assert.equal(response.status, 200);
      const record = await read(response);
      if (!['running', 'validating', 'canceling'].includes(record.status)) return record;
      await new Promise(r => setTimeout(r, 20));
    }
    throw Error('Offline provider task exceeded the test deadline');
  }
  return { app, req, read, calls, create, terminal, root, async close() {
    await app.close(); const real = realpathSync(root);
    assert.equal(dirname(real).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
    assert.ok(basename(real).startsWith('pxl-provider-admission-')); rmSync(real, { recursive: true, force: true });
  } };
}

test('Pixel provider API rejects retired and image-dependent requests before allocating batches/jobs or calling providers', async () => {
  const x = await setup();
  try {
    const providers = await x.read(await x.req('/api/studio/providers'));
    assert.deepEqual(Object.keys(providers).sort(), ['codex', 'deepseek']); assert.equal(x.calls(), 0);
    assert.match(providers.deepseek.message, /cấu hình/); assert.doesNotMatch(JSON.stringify(providers), /studio-http-fixture-never-real|Bearer /);
    const doc = await x.create(), base = `/api/pixel/projects/${doc.id}`, frame = doc.assets[0].frames[0].id;
    for (const route of ['generation-batches', 'ai']) {
      const retired = await x.req(`${base}/${route}`, 'POST', { revision: doc.revision, provider: 'antigravity', prompt: 'No remap' });
      assert.equal(retired.status, 400); assert.match((await x.read(retired)).error, /Codex.*DeepSeek/);
      for (const extra of [
        { generationOptions: { reference: true } },
        { generationOptions: { animation: { frameId: frame, mode: 'whole', frames: 2, duration: 100, loop: true, anchor: { x: 9, y: 24 } } } },
        { regionEdit: {} }, { clipGeneration: {} },
        { artDirection: { references: [{ assetId: doc.assets[0].id, frameId: frame }] } },
      ]) {
        const response = await x.req(`${base}/${route}`, 'POST', { revision: doc.revision, provider: 'deepseek', prompt: 'Requires image', generationOptions: {}, ...extra });
        assert.equal(response.status, 400, JSON.stringify(extra)); assert.match((await x.read(response)).error, /Codex/);
      }
      assert.deepEqual(await x.read(await x.req(`${base}/${route}`)), []);
    }
    assert.equal(x.calls(), 0); assert.deepEqual(await x.read(await x.req(base)), doc);
    const admitted = await x.req(`${base}/generation-batches`, 'POST', { revision: doc.revision, provider: 'deepseek', prompt: 'Text after rejected inputs', generationOptions: {} });
    assert.equal(admitted.status, 202); const batch = await x.read(admitted);
    const done = await x.terminal(`${base}/generation-batches/${batch.id}`);
    assert.equal(done.status, 'ready', JSON.stringify(done)); assert.equal(x.calls(), 3);
    assert.deepEqual(done.candidates.map((c: any) => c.status), ['ready', 'ready', 'ready']);
    assert.deepEqual(await x.read(await x.req(base)), doc, 'Admission and preview never automatically apply');
  } finally { await x.close(); }
});

test('Pixel provider API respects inherited art references and permits an explicit request-only empty override', async () => {
  const x = await setup();
  try {
    const initial = newDocument('Inherited references', 18, 24), asset = initial.assets[0];
    const references = [{ assetId: asset.id, frameId: asset.frames[0].id }];
    initial.studio = { version: 1, artDirection: { references } };
    const doc = await x.create(initial), base = `/api/pixel/projects/${doc.id}`;
    const input = { revision: doc.revision, provider: 'deepseek', prompt: 'Create from text', generationOptions: { reference: false } };
    const rejected = await x.req(`${base}/generation-batches`, 'POST', input);
    assert.equal(rejected.status, 400); assert.match((await x.read(rejected)).error, /Codex/); assert.equal(x.calls(), 0);
    assert.deepEqual(await x.read(await x.req(`${base}/generation-batches`)), []);
    const response = await x.req(`${base}/generation-batches`, 'POST', { ...input, artDirection: { references: [] } });
    assert.equal(response.status, 202); const batch = await x.read(response);
    assert.equal((await x.terminal(`${base}/generation-batches/${batch.id}`)).status, 'ready'); assert.equal(x.calls(), 3);
    const reopened = await x.read(await x.req(base)); assert.equal(reopened.revision, doc.revision);
    assert.deepEqual(reopened.studio.artDirection.references, references); assert.deepEqual(reopened, doc);
  } finally { await x.close(); }
});

test('Legacy pixel AI requires Codex for implicit image context, while explicit text-only DeepSeek uses one call', async () => {
  const x = await setup();
  try {
    const doc = await x.create(), base = `/api/pixel/projects/${doc.id}`;
    const input = { revision: doc.revision, provider: 'deepseek', prompt: 'Fresh text sprite' };
    const rejected = await x.req(`${base}/ai`, 'POST', input);
    assert.equal(rejected.status, 400); assert.match((await x.read(rejected)).error, /Codex/); assert.equal(x.calls(), 0);
    assert.deepEqual(await x.read(await x.req(`${base}/ai`)), []);
    const response = await x.req(`${base}/ai`, 'POST', { ...input, generationOptions: {} });
    assert.equal(response.status, 202); const job = await x.read(response);
    assert.equal((await x.terminal(`${base}/ai/${job.id}`)).status, 'ready'); assert.equal(x.calls(), 1);
    assert.deepEqual(await x.read(await x.req(base)), doc);
  } finally { await x.close(); }
});
