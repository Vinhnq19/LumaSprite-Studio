import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { AiManager } from '../src/node/studio/ai.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { GenerationBatchManager, toCompactBatch, type BatchRecord, type CandidateRecord } from '../src/node/studio/generation-batches.ts';
import type { AiJob } from '../src/studio/types.ts';
import { prepareGenerationSnapshot, type PreparedSnapshot } from '../src/node/studio/generation-prep.ts';
import { startRender } from '../src/node/studio/runner.ts';
import { validateBatchProvenance, composite, type BatchProvenance, type PixelDocument } from '../src/studio/pixel/model.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
import { DEEPSEEK_MODEL } from '../src/node/studio/deepseek-http.ts';
import type { DeepSeekSettings } from '../src/node/studio/deepseek-http.ts';

async function setup(deepseek?: DeepSeekSettings) {
  const root = mkdtempSync(join(tmpdir(), 'pxl-batch-http-')), store = new PixelStore(root), doc = store.create('Batch HTTP', 18, 24);
  const events: unknown[] = [], variants = new Proposals(store, async (_id, request) => startRender(request).promise, () => {});
  const snapshot = await prepareGenerationSnapshot(store, variants, doc, undefined, undefined, undefined, true);
  const ai = new AiManager({ load: () => ({ ...snapshot.contextDoc, revision: store.load(doc.id).revision }), save: () => { throw Error('Explicit pixel apply only'); } },
    () => {}, { codex: join(root, 'absent.exe'), deepseek: deepseek ?? fastHttpFixture(root), timeout: 5000 });
  const manager = new GenerationBatchManager(store, variants, ai, e => events.push(structuredClone(e)));
  return { root, store, doc, snapshot, ai, variants, manager, events,
    calls: () => { try { return readFileSync(join(root, 'fixture-cli-calls.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)); } catch { return []; } },
    async close() { await manager.close(); await ai.close(); variants.close(); const real = realpathSync(root);
      assert.equal(dirname(real).toLowerCase(), realpathSync(tmpdir()).toLowerCase()); assert.ok(basename(real).startsWith('pxl-batch-http-')); rmSync(real, { recursive: true, force: true }); },
  };
}

test('DeepSeek batch preflight rejects retired/image contracts and stale revisions before allocating work, releasing preparation leases', async () => {
  const x = await setup();
  try {
    const cases: Partial<PreparedSnapshot>[] = [
      { preview: Buffer.alloc(0) }, { movementMask: Buffer.alloc(0) }, { guideImage: Buffer.alloc(0) },
      { referenceAssets: [{ assetId: x.snapshot.assetId, frameId: x.doc.assets[0].frames[0].id, name: 'ref', w: 18, h: 24, image: Buffer.alloc(0) }] },
      { artDirection: { ...x.snapshot.artDirection, references: [{ assetId: x.snapshot.assetId, frameId: x.doc.assets[0].frames[0].id }] } },
      { generation: { ...x.snapshot.generation!, options: { ...x.snapshot.generation!.options, reference: true } } },
      { generation: { ...x.snapshot.generation!, operation: 'region-edit' } },
      { generation: { ...x.snapshot.generation!, operation: 'clip-regenerate' } },
    ];
    for (const change of cases) {
      const lease = x.manager.acquireLease(x.doc.id);
      assert.throws(() => x.manager.createBatch(x.doc.id, 'deepseek', 'Unsupported context', { ...x.snapshot, ...change }, lease.release), /Codex/);
      assert.equal(x.manager.isProjectBusy(x.doc.id), false);
    }
    for (const provider of ['antigravity', 'deepseek'] as const) {
      const lease = x.manager.acquireLease(x.doc.id);
      const snapshot = provider === 'deepseek' ? { ...x.snapshot, revision: 0 } : x.snapshot;
      assert.throws(() => x.manager.createBatch(x.doc.id, provider, 'Rejected before work', snapshot, lease.release), provider === 'deepseek' ? /thay đổi/ : /Codex|DeepSeek/);
      assert.equal(x.manager.isProjectBusy(x.doc.id), false);
    }
    assert.equal(x.manager.batches.size, 0); assert.equal(x.ai.jobs.size, 0); assert.equal(x.events.length, 0); assert.equal(x.calls().length, 0);
  } finally { await x.close(); }
});

test('DeepSeek batch creates three sequential native candidates with captured HTTP metadata and exact variant pixels', async () => {
  const x = await setup();
  try {
    const before = structuredClone(x.store.load(x.doc.id)), lease = x.manager.acquireLease(x.doc.id);
    const batch = x.manager.createBatch(x.doc.id, 'deepseek', 'Three text candidates', x.snapshot, lease.release);
    await batch.backgroundRun;
    assert.equal(batch.status, 'ready', JSON.stringify(batch.candidates));
    const compact = toCompactBatch(batch); assert.equal(compact.provider, 'deepseek');
    assert.equal(x.calls().length, 3); assert.deepEqual(x.calls().map(c => c.alternative), [1, 2, 3]);
    for (const [i, c] of compact.candidates.entries()) {
      assert.equal(c.transport, 'http'); assert.equal(c.model, DEEPSEEK_MODEL); assert.deepEqual(c.usage, { input: 17, output: 23 });
      assert.equal(c.attempt, 1); assert.equal(c.repairs, 0); assert.equal(c.cliExecutions, 1); assert.deepEqual(c.dimensions, { w: 18, h: 24 });
      const preview = await x.manager.previewCandidate(x.doc.id, batch.id, c.id, x.doc.revision);
      const applied = await x.variants.forApply(x.doc.id, preview.proposalId, x.doc.revision);
      assert.equal(applied.assets.length, 1); const asset = applied.assets[0], image = composite(asset, asset.frames[0].id);
      assert.equal(image.w, 18); assert.equal(image.h, 24); assert.equal(image.get(9, 12), 0xffffffff);
      assert.equal(image.get(8, 11), [0x70c989ff, 0x3b82f6ff, 0xef4444ff][i]);
    }
    assert.deepEqual(x.store.load(x.doc.id), before, 'No automatic application or source edits');
    assert.doesNotMatch(JSON.stringify(x.events), /studio-http-fixture-never-real|Bearer /);
  } finally { await x.close(); }
});

test('DeepSeek failed HTTP candidate never auto-retries; explicit candidate retry retains metadata and independent successful candidates', async () => {
  const x = await setup();
  try {
    const batch = x.manager.createBatch(x.doc.id, 'deepseek', 'FIXTURE_SECOND_FAILS_RETRY', x.snapshot);
    await batch.backgroundRun; assert.equal(batch.status, 'partial'); assert.equal(x.calls().length, 3);
    assert.deepEqual(batch.candidates.map(c => c.status), ['ready', 'failed', 'ready']);
    const others = [batch.candidates[0].jobId, batch.candidates[2].jobId];
    await x.manager.retryCandidate(x.doc.id, batch.id, batch.candidates[1].id, x.doc.revision); await batch.retryRun;
    assert.equal(batch.status, 'ready', batch.candidates[1].message); assert.equal(x.calls().length, 4);
    assert.deepEqual([batch.candidates[0].jobId, batch.candidates[2].jobId], others);
    const compact = toCompactBatch(batch).candidates[1]; assert.equal(compact.transport, 'http'); assert.equal(compact.model, DEEPSEEK_MODEL);
    assert.deepEqual(compact.usage, { input: 17, output: 23 }); assert.equal(compact.cliExecutions, 2); assert.equal(compact.repairs, 0);
  } finally { await x.close(); }
});

test('Provider provenance opens historical Anti unchanged, persists safe DeepSeek metadata and rejects malformed metadata', async () => {
  const x = await setup();
  try {
    const legacy: BatchProvenance = { provider: 'antigravity', prompt: 'Old recorded prompt' };
    assert.deepEqual(validateBatchProvenance(structuredClone(legacy)), legacy);
    const next: PixelDocument = structuredClone(x.doc);
    const batch: BatchProvenance = { provider: 'deepseek', transport: 'http', model: DEEPSEEK_MODEL, usage: { input: 17, output: 23, cached: 0, unavailable: false } };
    next.assets[0].provenance = { kind: 'generated', batch };
    const saved = x.store.save(x.doc.id, x.doc.revision, next); const reopened = new PixelStore(x.root).load(x.doc.id);
    assert.deepEqual(reopened.assets[0].provenance?.batch, batch); assert.equal(reopened.revision, saved.revision);
    const before = readFileSync(join(x.store.dir(x.doc.id), 'pxl.project.json')); new PixelStore(x.root).load(x.doc.id);
    assert.deepEqual(readFileSync(join(x.store.dir(x.doc.id), 'pxl.project.json')), before, 'Opening preserves persisted history and revision');
    for (const invalid of [{ provider: 'DEEPSEEK' }, { transport: 'https' }, { model: 'x\nkey' }, { model: 'x'.repeat(201) },
      { usage: [] }, { usage: { input: -1 } }, { usage: { output: 1.5 } }, { usage: { cached: Number.MAX_SAFE_INTEGER + 1 } },
      { usage: { unavailable: 'yes' } }, { usage: { secret: 'forbidden' } }]) assert.throws(() => validateBatchProvenance(invalid));
  } finally { await x.close(); }
});

test('Unconfirmed HTTP batch cancellation holds the gate and can confirm the same task after its late drain', async () => {
  let release!: () => void, entered = false, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const x = await setup({ apiKey: 'batch-http-fake-only', fetch: (async () => { calls++; entered = true; await held; return new Response('late output is discarded'); }) as typeof fetch });
  try {
    const batch = x.manager.createBatch(x.doc.id, 'deepseek', 'Cancel uncooperative fetch', x.snapshot);
    const until = Date.now() + 1000; while (!entered && Date.now() < until) await new Promise(r => setTimeout(r, 5)); assert.ok(entered);
    const first = await x.manager.cancelBatch(x.doc.id, batch.id, x.doc.revision);
    assert.equal(first.status, 'unknown'); assert.equal(x.manager.isProjectBusy(x.doc.id), true); assert.equal(calls, 1);
    assert.throws(() => x.manager.acquireLease(x.doc.id), /đang có/);
    release(); await new Promise(r => setImmediate(r));
    const second = await x.manager.cancelBatch(x.doc.id, batch.id, x.doc.revision);
    assert.equal(second.status, 'canceled'); assert.equal(x.manager.isProjectBusy(x.doc.id), false); assert.equal(calls, 1);
    assert.ok(second.candidates.every(c => c.status === 'canceled')); assert.ok(batch.candidates.every(c => !c.proposal && !c.proposalId));
  } finally { release(); for (const job of x.ai.jobs.values()) if (job.status === 'unknown') await x.ai.cancel(job.id); await x.close(); }
});

test('Concurrent HTTP batch cancellations share one pending confirmation attempt and one uncooperative fetch', async () => {
  let release!: () => void, entered = false, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const x = await setup({ apiKey: 'batch-http-fake-only', fetch: (async () => { calls++; entered = true; await held; return new Response('late output is discarded'); }) as typeof fetch });
  try {
    const batch = x.manager.createBatch(x.doc.id, 'deepseek', 'Concurrent cancel of one uncooperative fetch', x.snapshot);
    const until = Date.now() + 1000; while (!entered && Date.now() < until) await new Promise(r => setTimeout(r, 5)); assert.ok(entered);
    // Both callers arrive while the same attempt is pending, so they must share it: one stop call,
    // one unconfirmed receipt, and the same gate.
    const [first, concurrent] = await Promise.all([
      x.manager.cancelBatch(x.doc.id, batch.id, x.doc.revision),
      x.manager.cancelBatch(x.doc.id, batch.id, x.doc.revision),
    ]);
    assert.equal(first.status, 'unknown'); assert.equal(concurrent.status, 'unknown');
    assert.equal(x.manager.isProjectBusy(x.doc.id), true); assert.equal(calls, 1);
    assert.throws(() => x.manager.acquireLease(x.doc.id), /đang có/);
    release(); await new Promise(r => setImmediate(r));
    // The settled attempt is not cached: this is a fresh recheck of the same owned job.
    const confirmed = await x.manager.cancelBatch(x.doc.id, batch.id, x.doc.revision);
    assert.equal(confirmed.status, 'canceled'); assert.equal(x.manager.isProjectBusy(x.doc.id), false); assert.equal(calls, 1);
    assert.ok(confirmed.candidates.every(c => c.status === 'canceled'));
    assert.ok(batch.candidates.every(c => !c.proposal && !c.proposalId));
  } finally { release(); for (const job of x.ai.jobs.values()) if (job.status === 'unknown') await x.ai.cancel(job.id); await x.close(); }
});

test('DeepSeek batch preflight releases the preparation lease exactly once when store.load throws on external malformed data', async () => {
  const x = await setup();
  const lease = x.manager.acquireLease(x.doc.id);
  let releases = 0;
  const countedRelease = () => { releases++; lease.release(); };
  try {
    const originalLoad = x.store.load;
    try {
      x.store.load = () => { throw Error('external malformed document'); };
      assert.throws(() => x.manager.createBatch(x.doc.id, 'deepseek', 'External malformed document', x.snapshot, countedRelease), /external malformed document/);
    } finally {
      x.store.load = originalLoad;
    }
    assert.equal(releases, 1);
    assert.equal(x.manager.isProjectBusy(x.doc.id), false);
    assert.equal(x.manager.batches.size, 0);
    assert.equal(x.events.length, 0);
    assert.equal(x.ai.jobs.size, 0);
    assert.equal(x.calls().length, 0);
  } finally { await x.close(); }
});

test('Compact batch candidates project only safe transport/model/usage metadata and never alias usage', async () => {
  const x = await setup();
  try {
    const guidance = x.ai.captureGuidance(x.snapshot.generation, 'Compact metadata projection');
    const usage = { input: 17, output: 23, cached: 0 };
    const safe: CandidateRecord = { id: 'cand-safe', index: 0, status: 'ready', message: 'ok', attempt: 1, repairs: 0, cliExecutions: 1,
      transport: 'http', model: DEEPSEEK_MODEL, usage };
    const control: CandidateRecord = { id: 'cand-control', index: 1, status: 'failed', message: 'x', attempt: 1, repairs: 0, cliExecutions: 1,
      model: 'model\u0000name', transport: 'http' };
    const nonAscii: CandidateRecord = { id: 'cand-nonascii', index: 2, status: 'failed', message: 'x', attempt: 1, repairs: 0, cliExecutions: 1,
      model: 'mô-hình', transport: 'cli' };
    const overlong: CandidateRecord = { id: 'cand-long', index: 3, status: 'failed', message: 'x', attempt: 1, repairs: 0, cliExecutions: 1,
      model: 'm'.repeat(201), transport: 'cli' };
    const junk = { id: 'cand-junk', index: 4, status: 'failed', message: 'x', attempt: 1, repairs: 0, cliExecutions: 1,
      transport: 'carrier-pigeon', model: 'model\tname', request: '/tmp/prompt.txt', apiKey: 'sk-never-expose',
      usage: { input: -1, output: 1.5, cached: Number.MAX_SAFE_INTEGER + 1, unavailable: true, secret: 'sk-never-expose', request: '/tmp/usage' } };
    const stale: CandidateRecord = { id: 'cand-old', index: 5, status: 'canceled', message: 'old', attempt: 0, cliExecutions: 0 };
    const running: CandidateRecord = { id: 'cand-running', index: 6, status: 'running', message: 'streaming', attempt: 0, repairs: 0, cliExecutions: 0, jobId: 'job-live' };
    const batch: BatchRecord = {
      limits: { candidateMs: 1000, batchMs: 2000 }, guidance, id: 'batch-meta', projectId: x.doc.id, revision: x.doc.revision,
      provider: 'deepseek', prompt: 'Compact metadata projection', status: 'failed', started: Date.now(),
      candidates: [safe, control, nonAscii, overlong, junk as unknown as CandidateRecord, stale, running], snapshot: x.snapshot,
    };
    const liveJob = { id: 'job-live', projectId: x.doc.id, provider: 'deepseek', revision: x.doc.revision, transport: 'cli',
      model: 'live-model-1', usage: { input: 5, output: 7, total: 12, request: '/tmp/live' }, status: 'running',
      started: Date.now(), message: 'streaming', attempt: 1, cliExecutions: 1, apiKey: 'sk-never-expose' } as unknown as AiJob;

    const compact = toCompactBatch(batch);
    const [safeInfo, controlInfo, nonAsciiInfo, longInfo, junkInfo, oldInfo, runningInfo] = compact.candidates;
    assert.equal(safeInfo.transport, 'http'); assert.equal(safeInfo.model, DEEPSEEK_MODEL);
    assert.deepEqual(safeInfo.usage, usage); assert.notEqual(safeInfo.usage, usage);
    safeInfo.usage!.input = 99; assert.equal(usage.input, 17, 'compact usage is copied, not aliased');
    assert.equal(controlInfo.transport, 'http'); assert.equal(controlInfo.model, undefined);
    assert.equal(nonAsciiInfo.transport, 'cli'); assert.equal(nonAsciiInfo.model, undefined);
    assert.equal(longInfo.transport, 'cli'); assert.equal(longInfo.model, undefined);
    assert.equal(junkInfo.transport, undefined); assert.equal(junkInfo.model, undefined);
    assert.deepEqual(junkInfo.usage, { unavailable: true });
    assert.equal(oldInfo.transport, undefined); assert.equal(oldInfo.model, undefined); assert.equal(oldInfo.usage, undefined);
    assert.equal(runningInfo.transport, undefined); assert.equal(runningInfo.usage, undefined);
    assert.doesNotMatch(JSON.stringify(compact), /sk-never-expose|\/tmp\/|carrier-pigeon|apiKey|"request"/);

    const live = toCompactBatch(batch, new Map([[liveJob.id, liveJob]])).candidates[6];
    assert.equal(live.transport, 'cli'); assert.equal(live.model, 'live-model-1');
    assert.deepEqual(live.usage, { input: 5, output: 7 }); assert.notEqual(live.usage, liveJob.usage);
    assert.doesNotMatch(JSON.stringify(live), /sk-never-expose|\/tmp\/live|"request"/);
  } finally { await x.close(); }
});

test('DeepSeek explicit retry that fails HTTP before any response clears stale transport/model/usage and never auto-retries', async () => {
  // Local two-event SSE plus [DONE]: content is intentionally not JSON so the one built-in
  // repair fires and every candidate fails after exactly two calls.
  const wire = (content: string) => [
    JSON.stringify({ model: DEEPSEEK_MODEL, choices: [{ delta: { content }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 23 } }),
    '[DONE]',
  ].map(event => `data: ${event}\n\n`).join('');
  let retrying = false, httpCalls = 0;
  const settings: DeepSeekSettings = { apiKey: 'batch-http-fake-only', fetch: (async () => {
    httpCalls++;
    if (retrying) return new Response('', { status: 429 });
    return new Response(wire('not JSON'), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch };
  const x = await setup(settings);
  try {
    const batch = x.manager.createBatch(x.doc.id, 'deepseek', 'Repair fails every candidate', x.snapshot);
    await batch.backgroundRun;
    assert.equal(httpCalls, 6, 'one repair call per candidate');
    assert.equal(batch.status, 'failed');
    assert.deepEqual(batch.candidates.map(c => c.status), ['failed', 'failed', 'failed']);
    for (const c of batch.candidates) {
      assert.equal(c.transport, 'http'); assert.equal(c.model, DEEPSEEK_MODEL);
      assert.deepEqual(c.usage, { input: 17, output: 23 });
    }
    // The candidate retried below really does hold previous successful HTTP metadata.
    const retried = batch.candidates[1], sourceJobId = retried.jobId!;
    const sourceJob = x.ai.jobs.get(sourceJobId);
    assert.equal(sourceJob?.transport, 'http'); assert.equal(sourceJob?.model, DEEPSEEK_MODEL);
    assert.deepEqual(sourceJob?.usage, { input: 17, output: 23 });
    const before = toCompactBatch(batch).candidates;
    assert.equal(before[1].model, DEEPSEEK_MODEL); assert.deepEqual(before[1].usage, { input: 17, output: 23 });
    const otherJobIds = [batch.candidates[0].jobId, batch.candidates[2].jobId];

    retrying = true;
    const mark = x.events.length;
    await x.manager.retryCandidate(x.doc.id, batch.id, retried.id, x.doc.revision);
    const admission = (x.events[mark] as { batch: { candidates: { status: string; model?: string; usage?: unknown }[] } }).batch.candidates[1];
    assert.equal(admission.status, 'running');
    assert.equal(admission.model, undefined, 'admission must not show the previous attempt model');
    assert.equal(admission.usage, undefined, 'admission must not show the previous attempt usage');
    await batch.retryRun;
    await new Promise(r => setImmediate(r));
    assert.equal(httpCalls, 7, 'exactly one retry call and no automatic retry');
    assert.equal(batch.status, 'failed');
    assert.match(retried.error ?? '', /HTTP 429/);
    assert.deepEqual([batch.candidates[0].jobId, batch.candidates[2].jobId], otherJobIds);
    for (const i of [0, 2]) {
      assert.equal(batch.candidates[i].status, 'failed');
      assert.equal(batch.candidates[i].model, before[i].model);
      assert.deepEqual(batch.candidates[i].usage, before[i].usage);
    }
    assert.equal(retried.status, 'failed');
    assert.equal(retried.transport, 'http', 'the retry did reach HTTP before failing');
    assert.equal(retried.model, undefined, 'no stale model survives the failed retry');
    assert.equal(retried.usage, undefined, 'no stale usage survives the failed retry');
    const compact = toCompactBatch(batch, x.ai.jobs).candidates[1];
    assert.equal(compact.status, 'failed'); assert.equal(compact.transport, 'http');
    assert.equal(compact.model, undefined); assert.equal(compact.usage, undefined);
    assert.doesNotMatch(JSON.stringify(compact), /"model"|"usage"/);
  } finally { await x.close(); }
});
