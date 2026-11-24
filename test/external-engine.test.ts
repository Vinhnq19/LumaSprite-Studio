import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { serveStudio } from '../src/node/studio/server.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { celFor, composite, newDocument, wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { decodeTestPng } from './fixtures/image-assertions.ts';
import { startExternalEngine } from './fixtures/external-engine.ts';

async function setup(t: TestContext, version = 1, externalEngineTimeoutMs = 6000) {
  const root = mkdtempSync(join(tmpdir(), 'pxl-engine-s3-'));
  const engine = await startExternalEngine(version);
  const options = { port: 0, externalEnginePort: engine.port, externalEngineTimeoutMs };
  let app = await serveStudio(root, options);
  t.after(async () => { await app.close(); await engine.stop(); rmSync(root, { recursive: true, force: true }); });
  const fixture = newDocument('S3 fixture', 32, 32);
  const asset = fixture.assets[0], frame = asset.frames[0], ink = 0x1c2434ff, alt = 0xf7ba5bff;
  asset.palette = [0, ink, alt];
  asset.layers[0].locked = true;
  const pixels = celFor(asset, asset.layers[0].id, frame.id, true)!.data!;
  pixels[0] = ink;
  pixels[5] = alt;
  const store = new PixelStore(root), d = store.create(fixture.name, 32, 32, 0, fixture);
  const project = `api/pixel/projects/${d.id}`, base = `${project}/external-engine`;
  async function request(path: string, value?: object, method = value ? 'POST' : 'GET') {
    return fetch(app.url + path, { method, ...(value && {
      headers: { origin: new URL(app.url).origin, 'Content-Type': 'application/json' }, body: wireStringify(value),
    }) });
  }
  async function read(path: string, value?: object, code = 200, method?: string) {
    const response = await request(path, value, method);
    const json = wireParse(await response.text());
    assert.equal(response.status, code, JSON.stringify(json));
    return json;
  }
  const makeInput = (brief = 'Cờ lê', source: unknown = null) => ({ revision: d.revision, assetType: 'prop', brief, w: 32, h: 32, source });
  const submit = (brief?: string, source?: unknown) => read(`${base}/jobs`, makeInput(brief, source), 201);
  async function ready(id: string) {
    const until = Date.now() + 6500;
    for (;;) {
      const job = await read(`${base}/${id}`);
      if (!['queued', 'running', 'submitting'].includes(job.state)) return job;
      assert.ok(Date.now() < until, 'Job did not settle');
      await delay(60);
    }
  }
  const mask = Array.from({ length: 32 * 32 }, (_, i) => Number(i === 0 || i === 2));
  const source = { assetId: asset.id, frameId: frame.id, mask };
  return { root, d, asset, project, base, source, pixels, ink, store, engine, makeInput, read, request, submit, ready,
    restart: async () => { await app.close(); app = await serveStudio(root, options); },
  };
}

test('S3 F07/F03/F08: negotiate, preview, explicit apply, reopen, exact PNG RGBA, rollback', async t => {
  const f = await setup(t);
  const { capabilities } = await f.read(f.base);
  assert.deepEqual(capabilities.versions, [1]);
  assert.deepEqual(capabilities.assetTypes, ['character', 'prop', 'icon']);
  const job = await f.submit();
  assert.equal(job.state, 'queued');
  await delay(160);
  assert.equal((await f.read(`${f.base}/${job.id}`)).progress.completed, 1);
  const ready = await f.ready(job.id), route = `${f.base}/${job.id}`;
  assert.equal(ready.state, 'ready');
  await f.read(`${route}/preview/foreign-version`, undefined, 409);
  await f.read(`${route}/apply`, { approved: true, revision: f.d.revision, version: ready.version, digest: 'a'.repeat(64) }, 409);
  const preview = await f.read(`${route}/preview/${ready.version}`);
  await f.read(`${route}/apply`, { approved: false, revision: f.d.revision, version: ready.version, digest: preview.digest }, 409);
  assert.equal((await f.read(f.project)).revision, f.d.revision);
  const approval = { approved: true, revision: f.d.revision, version: ready.version, digest: preview.digest };
  const saved = await f.read(`${route}/apply`, approval);
  assert.equal(saved.assets.length, 2);
  assert.equal(saved.revision, f.d.revision + 1);
  const next = saved.assets[1];
  const exported = await f.request(`${f.project}/export`, { revision: saved.revision, assetId: next.id, format: 'png' });
  assert.equal(exported.status, 200);
  const image = decodeTestPng(Buffer.from(await exported.arrayBuffer()));
  assert.equal(image.w, 32);
  assert.equal(image.h, 32);
  assert.equal(image.data[0], 0);
  assert.deepEqual(image.data, preview.rgba);
  await f.restart();
  const reopened = f.store.load(f.d.id, true);
  assert.deepEqual(composite(reopened.assets[1], next.frames[0].id).data, preview.rgba);
  await f.read(`${route}/apply`, approval, 409);
  const before = (await f.read(`${f.project}/history`)).find((entry: { label: string }) => entry.label === 'Trước khi áp dụng External Engine');
  const restored = await f.read(`${f.project}/history`, { revision: saved.revision, snapshot: before.id });
  assert.equal(restored.assets.length, 1);
  assert.equal(restored.revision, saved.revision + 1);
  assert.deepEqual(composite(f.store.load(f.d.id, true).assets[0], f.asset.frames[0].id).data, f.pixels);
});

test('S3 rejects malformed IDs, canvas, palette, alpha, metadata, corrupt hash and oversize before apply', async t => {
  const f = await setup(t);
  await f.read(`${f.base}/invalid!`, undefined, 400);
  await f.read(`${f.base}/jobs`, { ...f.makeInput(), w: 129 }, 400);
  await f.read(`${f.base}/jobs`, { ...f.makeInput(), assetType: 'tilemap' }, 400);
  assert.equal((await f.submit('[fixture:invalid-job]')).state, 'failed');
  const fixtures = [
    ['invalid-version', /khớp job/], ['palette', /palette/], ['alpha', /alpha/], ['canvas', /Kích thước|SHA-256|Canvas/],
    ['metadata', /thuộc tính/], ['digest', /SHA-256/], ['oversize', /giới hạn/],
  ] as const;
  await Promise.all(fixtures.map(async ([scenario, pattern]) => {
    const job = await f.submit(`[fixture:${scenario}]`), ready = await f.ready(job.id);
    assert.equal(ready.state, 'ready');
    const error = await f.read(`${f.base}/${job.id}/preview/${ready.version}`, undefined, 502);
    assert.match(error.error, pattern);
    assert.equal((await f.read(`${f.base}/${job.id}`)).state, 'failed');
  }));
  assert.equal((await f.read(f.project)).revision, f.d.revision);
});

test('S3 preserves the source and exported RGBA outside selection, including a locked pixel inside selection', async t => {
  const f = await setup(t);
  const bad = await f.submit('[fixture:protected]', f.source);
  const good = await f.submit('Sửa vùng chọn', f.source);
  const badReady = await f.ready(bad.id);
  assert.match((await f.read(`${f.base}/${bad.id}/preview/${badReady.version}`, undefined, 502)).error, /\(0, 0\)/);
  const ready = await f.ready(good.id), route = `${f.base}/${good.id}`;
  const preview = await f.read(`${route}/preview/${ready.version}`);
  assert.equal(preview.rgba[2], f.ink);
  const saved = await f.read(`${route}/apply`, { approved: true, revision: f.d.revision, version: ready.version, digest: preview.digest });
  const response = await f.request(`${f.project}/export`, { revision: saved.revision, assetId: saved.assets[1].id, format: 'png' });
  assert.equal(response.status, 200);
  const exported = decodeTestPng(Buffer.from(await response.arrayBuffer())).data;
  assert.deepEqual(exported, preview.rgba);
  for (let i = 0; i < f.pixels.length; i++) if (i !== 2) assert.equal(exported[i], f.pixels[i], `Protected pixel ${i}`);
  assert.deepEqual(composite(f.store.load(f.d.id, true).assets[0], f.asset.frames[0].id).data, f.pixels);
});

test('S3 rejects a changed receipt, a rejected candidate and a stale revision', async t => {
  const f = await setup(t);
  const finalized = await Promise.all(['[fixture:mutation]', 'Reject', 'Stale'].map(async brief => {
    const job = await f.submit(brief), ready = await f.ready(job.id), path = `${f.base}/${ready.id}`;
    const preview = await f.read(`${path}/preview/${ready.version}`);
    return { path, data: { approved: true, revision: f.d.revision, version: ready.version, digest: preview.digest } };
  }));
  const [mutation, rejected, stale] = finalized;
  await f.read(`${mutation.path}/apply`, mutation.data, 502);
  await f.read(`${rejected.path}/reject`, {});
  await f.read(`${rejected.path}/apply`, rejected.data, 409);
  const next = f.store.load(f.d.id);
  f.store.save(next.id, next.revision, { ...next, name: 'Tab khác' });
  assert.equal((await f.read(`${stale.path}/apply`, stale.data, 409)).diagnostic.code, 'STALE_REVISION');
  assert.equal((await f.read(f.project)).assets.length, 1);
});

test('S3 recovers an unfinished job, ignores late completion and never replays an unconfirmed submit', async t => {
  const f = await setup(t);
  const slow = await f.submit('[fixture:slow]'), late = await f.submit('[fixture:late]');
  const unconfirmed = await f.submit('[fixture:unconfirmed]');
  assert.equal(unconfirmed.state, 'unknown');
  const route = `${f.base}/${late.id}`;
  assert.equal((await f.read(`${route}/cancel`, {})).state, 'canceled');
  await f.restart();
  const recovered = await f.read(`${f.base}/${slow.id}`);
  assert.ok(['queued', 'running'].includes(recovered.state));
  assert.equal((await f.ready(slow.id)).state, 'ready');
  assert.equal((await f.read(route)).state, 'canceled');
  await f.read(`${route}/preview/fixture-v1`, undefined, 409);
  assert.equal((await f.read(`${f.base}/${unconfirmed.id}`)).state, 'unknown');
  assert.equal((await f.read(`${f.base}/jobs`)).length, 3);
  assert.equal((await f.read(f.project)).revision, f.d.revision);
});

test('S3 handles engine failure, job timeout and engine offline', async t => {
  const f = await setup(t, 1, 700);
  const failed = await f.submit('[fixture:failure]'), timedOut = await f.submit('[fixture:timeout]');
  assert.equal((await f.ready(failed.id)).state, 'failed');
  assert.equal((await f.ready(timedOut.id)).state, 'timedout');
  await f.engine.stop();
  await f.read(f.base, undefined, 503);
  await f.read(`${f.base}/jobs`, f.makeInput(), 503);
  assert.equal((await f.read(`${f.base}/jobs`)).length, 2);
  assert.equal((await f.read(f.project)).revision, f.d.revision);
});

test('S3 refuses submission before contacting an incompatible engine', async t => {
  const f = await setup(t, 2);
  assert.deepEqual((await f.read(f.base)).capabilities.versions, [2]);
  await f.read(`${f.base}/jobs`, f.makeInput(), 400);
  assert.deepEqual(await f.read(`${f.base}/jobs`), []);
});
