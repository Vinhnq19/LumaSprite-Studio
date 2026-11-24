import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { serveStudio } from '../src/node/studio/server.ts';
import { wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { DEEPSEEK_MODEL } from '../src/node/studio/deepseek-http.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
import { decodeTestPng } from './fixtures/image-assertions.ts';

test('DeepSeek pixel API explicitly applies candidate metadata and exports/reopens exactly the preview RGBA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-provider-apply-'));
  const app = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio'), providers: {
    codex: process.execPath, prefix: [resolve('studio/fake-cli.js'), '--state-dir', root], deepseek: fastHttpFixture(root), timeout: 5000,
  } });
  const req = (path: string, method = 'GET', value?: unknown) => fetch(new URL(path, app.url), {
    method, headers: { origin: app.url.replace(/\/$/, ''), ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    body: value === undefined ? undefined : wireStringify(value),
  });
  async function read(response: Response, expected = 200) {
    const text = await response.text(); assert.equal(response.status, expected, text); return wireParse(text);
  }
  const callCount = () => readFileSync(join(root, 'fixture-cli-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  try {
    const doc = await read(await req('/api/pixel/projects', 'POST', { name: 'Đối chiếu metadata và RGBA', w: 18, h: 24 }), 201);
    const base = `/api/pixel/projects/${doc.id}`;
    const initial = await read(await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision, provider: 'deepseek', prompt: 'A small blue game item', generationOptions: { paletteMode: 'auto16', reference: false },
    }), 202);
    let batch = initial;
    const until = Date.now() + 15000;
    while (batch.status === 'running' && Date.now() < until) {
      await new Promise(r => setTimeout(r, 20)); batch = await read(await req(`${base}/generation-batches/${initial.id}`));
    }
    assert.equal(batch.status, 'ready', JSON.stringify(batch)); assert.equal(callCount(), 3);
    assert.deepEqual(await read(await req(base)), doc, 'No automatic save or apply');
    const candidate = batch.candidates[1];
    assert.equal(candidate.transport, 'http'); assert.equal(candidate.model, DEEPSEEK_MODEL); assert.deepEqual(candidate.usage, { input: 17, output: 23 });
    const preview = await read(await req(`${base}/generation-batches/${batch.id}/candidates/${candidate.id}/preview`, 'POST', { revision: doc.revision }));
    const variant = preview.variants.find((v: any) => v.id === preview.selectedVariantId); assert.ok(variant);
    const art = variant.assets[0];
    const frame = await read(await req(`${base}/proposals/${preview.proposalId}/variants/${variant.id}/frame?asset=${art.id}&frame=${art.frames[0].id}&revision=${doc.revision}`));
    const saved = await read(await req(`${base}/apply-proposal`, 'POST', { revision: doc.revision, proposalId: preview.proposalId, variantId: variant.id }));
    assert.equal(saved.revision, doc.revision + 1); assert.equal(saved.assets.length, 2); assert.deepEqual(saved.assets[0], doc.assets[0]);
    const asset = saved.assets[1], provenance = asset.provenance.batch;
    assert.equal(provenance.batchId, batch.id); assert.equal(provenance.candidateId, candidate.id);
    assert.equal(provenance.provider, 'deepseek'); assert.equal(provenance.transport, 'http'); assert.equal(provenance.model, DEEPSEEK_MODEL);
    assert.deepEqual(provenance.usage, { input: 17, output: 23 });
    const exported = await req(`${base}/export`, 'POST', { revision: saved.revision, format: 'png', assetId: asset.id });
    assert.equal(exported.status, 200); const image = decodeTestPng(Buffer.from(await exported.arrayBuffer()));
    assert.equal(image.w, 18); assert.equal(image.h, 24); assert.deepEqual(image.data, frame.data);
    assert.equal(image.data[12 * 18 + 9], 0xffffffff); assert.equal(image.data[11 * 18 + 8], 0x3b82f6ff);
    const reopened = await read(await req(base)); assert.equal(reopened.revision, saved.revision);
    assert.deepEqual(reopened.assets[1].provenance.batch, provenance);
    const celId = Object.keys(reopened.assets[1].cels)[0];
    const cel = await read(await req(`${base}/cel?asset=${asset.id}&cel=${celId}&revision=${saved.revision}`)); assert.deepEqual(cel.data, frame.data);
    assert.equal((await req(`${base}/apply-proposal`, 'POST', { revision: doc.revision, proposalId: preview.proposalId, variantId: variant.id })).status, 409);
    assert.equal(callCount(), 3, 'Preview/apply/export/reopen must not add provider calls');
  } finally {
    await app.close(); const real = realpathSync(root);
    assert.equal(dirname(real).toLowerCase(), realpathSync(tmpdir()).toLowerCase()); assert.ok(basename(real).startsWith('pxl-provider-apply-'));
    rmSync(real, { recursive: true, force: true });
  }
});
