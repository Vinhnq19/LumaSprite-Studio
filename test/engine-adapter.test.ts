import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { materializeEngineResultV1, negotiateEngineV1, type EngineAdapterV1, type EngineCapabilities, type EngineJobV1, type EngineRequestV1, type EngineResultV1 } from '../src/studio/engine-adapter.ts';
import { composite } from '../src/studio/pixel/model.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';
import { decodeTestPng } from './fixtures/image-assertions.ts';

const request: EngineRequestV1 = {
  version: 1, requestId: 'fixture-request', assetType: 'prop', brief: 'Cọc đo',
  canvas: { w: 2, h: 2 }, frameDurationsMs: [100], loop: false, alpha: 'binary',
  palette: [0, 0x406d8bff],
};
const capabilities: EngineCapabilities = {
  versions: [1, 2], assetTypes: ['prop'], features: ['previews'], limits: { width: 64, height: 64, frames: 1 },
};
const version: EngineResultV1 = {
  version: 1, jobId: 'job', versionId: 'flat', name: 'Cọc đo', w: 2, h: 2, loop: false,
  frames: [{ durationMs: 100, rgba: Uint32Array.of(0, 0x406d8bff, 0x406d8bff, 0) }],
};

test('engine negotiation rejects unsupported versions, references, asset types and canvas limits', () => {
  assert.equal(negotiateEngineV1(capabilities, request), 1);
  assert.throws(() => negotiateEngineV1({ ...capabilities, versions: [2] }, request), /Phiên bản/);
  assert.throws(() => negotiateEngineV1(capabilities, { ...request, assetType: 'vfx' }), /loại asset/);
  assert.throws(() => negotiateEngineV1(capabilities, { ...request, canvas: { w: 65, h: 2 } }), /Chiều rộng/);
  assert.throws(() => negotiateEngineV1(capabilities, { ...request, references: [{ id: 'ref', sha256: 'a'.repeat(64), w: 2, h: 2 }] }), /references/);
});

test('engine output is bound to the chosen job/version and rejects shape, alpha, palette and executable extras', () => {
  const read = (value: unknown) => materializeEngineResultV1(value, request, 'job', 'flat');
  assert.throws(() => read({ ...version, jobId: 'unrelated' }), /khớp job/);
  assert.throws(() => read({ ...version, versionId: 'elsewhere' }), /khớp job/);
  assert.throws(() => read({ ...version, w: 3 }), /Canvas/);
  assert.throws(() => read({ ...version, source: 'sprite()' }), /thuộc tính/);
  for (const [rgba, match] of [
    [Uint32Array.of(0), /dữ liệu RGBA/],
    [Uint32Array.of(0, 0xff000080, 0, 0), /alpha/],
    [Uint32Array.of(0, 0xff0000ff, 0, 0), /palette/],
    [Uint32Array.of(0, 0xaabbcc00, 0, 0), /trong suốt/],
  ] as const) assert.throws(() => read({ ...version, frames: [{ durationMs: 100, rgba }] }), match);
  assert.throws(() => read({ ...version, frames: [{ ...version.frames[0], durationMs: 75 }] }), /Thời lượng/);
});

test('local adapter fixture leaves the project untouched until approval and uses Studio save, rollback and export', async () => {
  let job: EngineJobV1 = { id: 'job', state: 'queued' };
  const mock: EngineAdapterV1 = {
    async capabilities() { return capabilities; },
    async submit(input) { negotiateEngineV1(capabilities, input); return { ...job }; },
    async status(id) {
      assert.equal(id, job.id);
      if (job.state === 'queued') job = { id, state: 'ready', finalVersionId: 'flat', previews: [{ id: 'flat', label: 'Phác' }] };
      return { ...job };
    },
    async cancel(id) { assert.equal(id, job.id); return job = { id, state: 'canceled' }; },
    async result(id, versionId) {
      if (id !== job.id || job.state !== 'ready' || versionId !== job.finalVersionId) throw Error('Không có preview hợp lệ.');
      return structuredClone(version);
    },
  };
  const root = mkdtempSync(join(tmpdir(), 'pxl-engine-s0-'));
  try {
    const store = new PixelStore(root);
    const created = store.create('S0 fixture', 2, 2, 0xffffffff);
    const doc = store.load(created.id, true);
    const original = composite(doc.assets[0], doc.assets[0].frames[0].id).data;
    assert.deepEqual(original, Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff));
    assert.equal(negotiateEngineV1(await mock.capabilities(), request), 1);
    const submitted = await mock.submit(request);
    assert.equal(submitted.state, 'queued');
    const ready = await mock.status(submitted.id);
    assert.equal(ready.state, 'ready');
    const candidate = materializeEngineResultV1(await mock.result(ready.id, ready.finalVersionId), request, ready.id, ready.finalVersionId);
    assert.equal(store.load(doc.id).revision, doc.revision);
    assert.equal(store.load(doc.id).assets.length, 1);
    store.save(doc.id, doc.revision, { ...doc, assets: [...doc.assets, candidate] }, 'Duyệt fixture');
    const saved = store.load(doc.id, true);
    assert.deepEqual(decodeTestPng(Buffer.from(exportPixel({ document: saved, assetId: candidate.id, format: 'png' }).data)).data, version.frames[0].rgba);
    assert.deepEqual(composite(saved.assets[0], doc.assets[0].frames[0].id).data, original);
    assert.throws(() => store.save(doc.id, doc.revision, { ...doc, assets: [...doc.assets, candidate] }), /đã đổi/);
    const before = store.history(doc.id).find(h => h.revision === doc.revision)!;
    const restored = store.restore(doc.id, saved.revision, before.id);
    assert.equal(restored.assets.length, 1);
    assert.ok(restored.revision > saved.revision);
    assert.deepEqual(composite(store.load(doc.id, true).assets[0], doc.assets[0].frames[0].id).data, original);
    job = { id: 'job', state: 'queued' };
    assert.equal((await mock.cancel(job.id)).state, 'canceled');
    assert.equal((await mock.status(job.id)).state, 'canceled');
    await assert.rejects(mock.result(job.id, 'flat'), /Không có preview/);
    assert.equal(store.load(doc.id).revision, restored.revision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
