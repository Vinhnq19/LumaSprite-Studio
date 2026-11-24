import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { newDocument, validateBatchProvenance, validateDocument, type BatchProvenance } from '../src/studio/pixel/model.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';

const roots: string[] = [];
const temporary = () => { const p = mkdtempSync(join(tmpdir(), 'pxl-prov-test-')); roots.push(p); return p; };
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only remove the directory this test created directly under the OS temp root.
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Provider provenance: historical Anti record keeps identity through JSON roundtrip', () => {
  const batch: BatchProvenance = { batchId: 'batch-legacy-1', candidateId: 'candidate-legacy-1', provider: 'antigravity', prompt: 'Sprite cũ' };
  assert.equal(validateBatchProvenance(batch), batch);
  const reparsed = JSON.parse(JSON.stringify(batch));
  assert.deepEqual(validateBatchProvenance(reparsed), batch);
  assert.deepEqual(reparsed, batch);
  assert.deepEqual(validateBatchProvenance({ provider: 'codex' }), { provider: 'codex' });
});

test('Provider provenance: DeepSeek accepts the optional transport, model and usage fields', () => {
  const batch: BatchProvenance = {
    batchId: 'batch-ds-1',
    provider: 'deepseek',
    transport: 'http',
    model: 'deepseek-chat',
    usage: { input: 120, output: 0, cached: 7, unavailable: false },
    prompt: 'Nhân vật',
  };
  assert.deepEqual(validateBatchProvenance(batch), batch);
  assert.deepEqual(validateBatchProvenance(JSON.parse(JSON.stringify(batch))), batch);
  assert.deepEqual(validateBatchProvenance({ provider: 'deepseek', transport: 'cli' }), { provider: 'deepseek', transport: 'cli' });
  assert.deepEqual(validateBatchProvenance({ provider: 'deepseek', usage: {} }), { provider: 'deepseek', usage: {} });
  assert.deepEqual(validateBatchProvenance({ batchId: 'batch-ds-2' }), { batchId: 'batch-ds-2' });
  const nullProto = Object.assign(Object.create(null) as Record<string, number>, { input: 1, output: 2 });
  const accepted = validateBatchProvenance({ usage: nullProto });
  assert.equal(accepted.usage, nullProto);
  assert.equal(accepted.usage?.input, 1);
  assert.equal(accepted.usage?.output, 2);
  const boundary = 'm'.repeat(200);
  assert.equal(validateBatchProvenance({ model: boundary }).model, boundary);
  assert.equal(validateBatchProvenance({ model: ' ' }).model, ' ');
  assert.equal(validateBatchProvenance({ model: '~ deepseek-chat/2026-01-01' }).model, '~ deepseek-chat/2026-01-01');
});

test('Provider provenance: provider must be an exact historical/active name without coercion', () => {
  assert.throws(() => validateBatchProvenance({ provider: 'DeepSeek' }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: 'CODEX' }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: 'ANTIGRAVITY' }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: ' deepseek' }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: 'deepseek-chat' }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: { name: 'deepseek' } }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: ['deepseek'] }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: null }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: 0 }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: true }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: '__proto__' }), /Provider/);
  assert.throws(() => validateBatchProvenance({ provider: 'constructor' }), /Provider/);
});

test('Provider provenance: transport, model and unknown keys are strictly validated', () => {
  assert.throws(() => validateBatchProvenance({ transport: 'stdio' }), /transport/);
  assert.throws(() => validateBatchProvenance({ transport: 'HTTP' }), /transport/);
  assert.throws(() => validateBatchProvenance({ transport: ['cli'] }), /transport/);
  assert.throws(() => validateBatchProvenance({ transport: { kind: 'cli' } }), /transport/);
  assert.throws(() => validateBatchProvenance({ transport: null }), /transport/);
  assert.throws(() => validateBatchProvenance({ model: '' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 'deepseek\u0000chat' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 'deepseek\nchat' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 'deepseek\tchat' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 'deepseek\u007fchat' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 'mô hình' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: '模型' }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 'm'.repeat(201) }), /model/);
  assert.throws(() => validateBatchProvenance({ model: 42 }), /model/);
  assert.throws(() => validateBatchProvenance({ model: { name: 'deepseek-chat' } }), /model/);
  assert.throws(() => validateBatchProvenance({ model: ['deepseek-chat'] }), /model/);
  assert.throws(() => validateBatchProvenance({ provider: 'deepseek', apiKey: 'secret' }), /apiKey/);
  assert.throws(() => validateBatchProvenance({ provider: 'deepseek', usage: { total: 1 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ provider: 'deepseek', usage: { input: 1, total: 1 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ provider: 'deepseek', usage: { input: 1, 'x-y': 2 } }), /usage/);
});

test('Provider provenance: usage requires a plain object of safe non-negative integers', () => {
  assert.throws(() => validateBatchProvenance({ usage: null }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: [1] }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: 'input=1' }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: 7 }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: Object.assign(new Date(), { input: 1 }) }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: new Map<string, number>([['input', 1]]) }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { input: '1' } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { output: null } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { cached: {} } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { input: -1 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { output: -0.0001 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { input: NaN } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { output: Infinity } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { cached: -Infinity } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { input: 1.5 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { output: Number.MAX_SAFE_INTEGER + 1 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { cached: Number.MAX_VALUE } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { unavailable: 'false' } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { unavailable: 0 } }), /usage/);
  assert.throws(() => validateBatchProvenance({ usage: { unavailable: null } }), /usage/);
  assert.deepEqual(
    validateBatchProvenance({ usage: { input: 0, output: Number.MAX_SAFE_INTEGER, cached: 0, unavailable: true } }),
    { usage: { input: 0, output: Number.MAX_SAFE_INTEGER, cached: 0, unavailable: true } },
  );
});

test('Pixel v2 store: DeepSeek provenance roundtrips without rewriting revision or manifest bytes', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const document = newDocument('Provenance', 4, 4);
  const batch: BatchProvenance = {
    batchId: 'batch-store-1',
    candidateId: 'candidate-store-1',
    provider: 'deepseek',
    transport: 'http',
    model: 'deepseek-chat',
    usage: { input: 10, output: 20, cached: 5, unavailable: false },
  };
  document.assets[0].provenance = { kind: 'generated', batch };
  const created = store.create('Provenance', 4, 4, 0, document);
  const projectDir = resolve(store.dir(created.id));
  // Cleanup must stay inside the temporary root this test owns.
  assert.equal(dirname(projectDir), resolve(root));
  const path = join(projectDir, 'pxl.project.json');

  const firstBytes = readFileSync(path);
  const first = store.load(created.id);
  assert.equal(first.revision, created.revision);
  assert.equal(first.schemaVersion, 2);
  validateDocument(first);
  assert.deepEqual(first.assets[0].provenance?.batch, batch);

  const secondBytes = readFileSync(path);
  const second = store.load(created.id);
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.assets[0].provenance?.batch, batch);
  assert.deepEqual(secondBytes, firstBytes);
});
