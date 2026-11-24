// Parent-owned acceptance: real worker data, no real providers or user projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { startRender, type WorkerRequest } from '../src/node/studio/runner.ts';
import type { ExportResult } from '../src/node/studio/render.ts';
import { composite, wireParse, validateAsset } from '../src/studio/pixel/model.ts';
import type { GenerationContext } from '../src/studio/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function setup(mode: 'region' | 'whole' = 'region') {
  const f = savedClipFixture(mode, true), events: any[] = [], requests: WorkerRequest[] = [];
  let hold: { operation: string; arrived: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  const run = async (_id: string, request: WorkerRequest) => {
    requests.push(request);
    const value = await startRender(request).promise;
    if (hold && ('operation' in request ? request.operation : request.mode) === hold.operation) {
      const current = hold; hold = undefined; current.arrived.resolve(); await current.release.promise;
    }
    return value;
  };
  const proposals = new Proposals(f.store, run, event => events.push(structuredClone(event)));
  return { f, events, requests, proposals, hold(operation: string) {
    const value = { operation, arrived: deferred<void>(), release: deferred<void>() }; hold = value; return value;
  }, close() { try { proposals.close(); } finally { f.close(); } } };
}
function generation(snapshot: any): GenerationContext {
  return {
    options: { style: 'game', view: 'description', paletteMode: 'asset', reference: true },
    assetId: snapshot.context.sourceAssetId, w: snapshot.context.w, h: snapshot.context.h,
    palette: [...snapshot.context.palette], operation: 'clip-regenerate',
    clip: { context: snapshot.context, helperFiles: snapshot.helperFiles,
      facing: snapshot.facing, template: snapshot.template, guideMetadata: snapshot.guideMetadata },
  } as GenerationContext;
}
async function prepare(h: ReturnType<typeof setup>) {
  return (h.proposals as any).clipReference(h.f.saved.id, h.f.saved.revision, h.f.clip.id, 'asset', h.f.source.palette);
}
function candidate(snapshot: any) {
  return { ...snapshot.contextDoc, files: { ...snapshot.contextDoc.files, 'art.px.js':
    `${snapshot.helperFiles.map((name: string) => `include(${JSON.stringify(name)});`).join('\n')}\n` +
    "anim('candidate',{w:4,h:3,loop:false},frame({ms:200},rect(0,0,4,3,'#ffffffff')))\n" } };
}
async function capture(h: ReturnType<typeof setup>, snapshot: any, jobId = 'job') {
  h.proposals.rememberReference(jobId, h.f.saved.id, snapshot.referenceId);
  return h.proposals.capture(h.f.saved.id, h.f.saved.revision, candidate(snapshot), generation(snapshot), jobId);
}
async function settledJob(h: ReturnType<typeof setup>, job: any) {
  const deadline = Date.now() + 10_000;
  while (job.status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.notEqual(job.status, 'running', job.message);
  return job;
}

test('Independent clip proposals: both scopes select full protected, real normalization and fresh apply IDs preserve exact frames/source', async () => {
  for (const mode of ['region', 'whole'] as const) {
    const h = setup(mode), { f, proposals } = h;
    try {
      const snapshot = await prepare(h), preview = await capture(h, snapshot);
      const raw = preview.variants.find(v => v.kind === 'raw')!, full = preview.variants.find(v => v.kind === 'protected')!;
      assert.equal(preview.selectedVariantId, full.id); assert.equal(raw.canApply, false);
      assert.equal(raw.assets[0].frames.length, 1); assert.equal(full.assets[0].frames.length, 4);
      await assert.rejects(() => proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision, raw.id));
      const stored = proposals.repo.assets(full.id)[0], before = JSON.stringify(stored);
      const first = await proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision);
      const second = await proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision, full.id);
      assert.notEqual(first.assets[0].id, f.clip.id); assert.notEqual(first.assets[0].id, second.assets[0].id);
      assert.equal(JSON.stringify(proposals.repo.assets(full.id)[0]), before, 'apply must not mutate verified storage');
      for (const asset of [first.assets[0], second.assets[0]]) {
        validateAsset(asset); assert.deepEqual(asset.frames.map(v => v.duration), f.durations);
        assert.deepEqual(asset.frames.map(v => v.id), f.clip.slots.map(v => v.id));
        assert.equal(asset.tags[0].loop, false); assert.deepEqual(asset.metadata, stored.metadata);
        for (let i = 0; i < 4; i++) {
          const pixels = composite(asset, asset.frames[i].id).data;
          const expected = f.images[i].slice();
          if (i === 2) for (let p = 0; p < expected.length; p++) if (mode === 'whole' || f.mask[p]) expected[p] = 0xffffffff;
          assert.deepEqual(pixels, expected);
        }
        const raster = await startRender({ mode: 'raster', document: { schemaVersion: 1, id: 'roundtrip', name: 'Source', revision: 1,
          entry: asset.source!.entry, files: asset.source!.files, pixels: {}, metadata: {} } }).promise as ExportResult;
        const rebuilt = wireParse(Buffer.from(raster.data).toString('utf8'))[0];
        assert.deepEqual(rebuilt.frames.map((v: any) => v.duration), f.durations);
        for (let i = 0; i < 4; i++) assert.deepEqual(composite(rebuilt, rebuilt.frames[i].id).data, composite(asset, asset.frames[i].id).data);
      }
      const job = await settledJob(h, proposals.startNormalize(f.saved.id, preview.proposalId, f.saved.revision, 128));
      assert.equal(job.status, 'ready', job.message);
      const result = await proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision, job.variantId);
      assert.equal(result.assets[0].frames.length, 4);
      assert.ok(h.requests.some(r => 'operation' in r && r.operation === 'clip-verify'));
      assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
    } finally { h.close(); }
  }
});

test('Independent clip proposals: differences use slot2 baseline, never fallback to raw/master frame0', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), p = await capture(h, snapshot);
    const raw = p.variants.find(v => v.kind === 'raw')!, full = p.variants.find(v => v.kind === 'protected')!, a = full.assets[0];
    const diff = await proposals.frame(f.saved.id, p.proposalId, full.id, a.id, a.frames[2].id, f.saved.revision, 'difference', 'reference');
    const expected = new Uint32Array(12);
    f.mask.forEach((v, i) => { if (v && f.images[2][i] !== 0xffffffff) expected[i] = 0xff55bbaa; });
    assert.deepEqual(diff.data, expected); assert.equal(diff.duration, 200);
    const rawDiff = await proposals.frame(f.saved.id, p.proposalId, raw.id, raw.assets[0].id, raw.assets[0].frames[0].id,
      f.saved.revision, 'difference', 'reference');
    assert.equal(rawDiff.count, f.images[2].filter(v => v !== 0xffffffff).length);
    await assert.rejects(() => proposals.frame(f.saved.id, p.proposalId, full.id, a.id, a.frames[0].id, f.saved.revision, 'difference', 'raw'));
    const master = snapshot.referenceInfo.assets.find((v: any) => v.id === snapshot.referenceInfo.clip.masterAssetId);
    await assert.rejects(() => proposals.frame(f.saved.id, p.proposalId, snapshot.referenceId, master.id, master.frames[0].id,
      f.saved.revision, 'difference', 'raw'));
    proposals.releaseProposal(f.saved.id, p.proposalId);
    assert.equal(proposals.repo.info(snapshot.referenceId).kind, 'reference', 'candidate release must retain shared reference');
    assert.ok((await capture(h, snapshot, 'job2')).proposalId);
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { h.close(); }
});

test('Independent clip proposals: project close during real prepare/capture removes late output and never recreates proposals', async () => {
  for (const operation of ['clip-prepare', 'clip-capture']) {
    const h = setup(), { f, proposals } = h;
    try {
      let snapshot: any;
      if (operation === 'clip-capture') snapshot = await prepare(h);
      const hold = h.hold(operation), pending = operation === 'clip-prepare' ? prepare(h) : capture(h, snapshot);
      const rejected = assert.rejects(() => pending);
      await hold.arrived.promise; proposals.closeProject(f.saved.id); hold.release.resolve(); await rejected;
      assert.equal(proposals.records.size, 0); assert.equal(proposals.references.size, 0);
      assert.deepEqual(readdirSync(proposals.repo.root), [], 'closed project cannot retain late reference/raw/full');
      assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
    } finally { h.close(); }
  }
});

test('Independent clip proposals: stale revision between verified asset load and apply rejects without project writes', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), p = await capture(h, snapshot), hold = h.hold('load');
    const pending = proposals.forApply(f.saved.id, p.proposalId, f.saved.revision, p.selectedVariantId);
    const rejected = assert.rejects(() => pending);
    await hold.arrived.promise;
    const document = f.store.load(f.saved.id); document.name = 'External edit during apply';
    f.store.save(document.id, document.revision, document, 'External test edit');
    const afterExternal = readFileSync(f.manifest); hold.release.resolve(); await rejected;
    assert.equal(f.store.load(f.saved.id).revision, 2); assert.deepEqual(readFileSync(f.manifest), afterExternal);
  } finally { h.close(); }
});

test('Independent clip proposals: late local normalization after close has no ready emission or orphan variant', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), p = await capture(h, snapshot), hold = h.hold('clip-normalize');
    const job = proposals.startNormalize(f.saved.id, p.proposalId, f.saved.revision, 128);
    await hold.arrived.promise; proposals.closeProject(f.saved.id); hold.release.resolve();
    const until = Date.now() + 5000;
    while (readdirSync(proposals.repo.root).length && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal(job.status, 'canceled');
    assert.equal(h.events.some(e => e.type === 'pixel-processing' && e.job.id === job.id && e.job.status === 'ready'), false);
    assert.deepEqual(readdirSync(proposals.repo.root), []);
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { h.close(); }
});

test('Independent clip proposals: foreign reference registration is rejected and returned descriptors cannot mutate stored ownership', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h);
    proposals.rememberReference('foreign-job', 'another-project', snapshot.referenceId);
    const before = readdirSync(proposals.repo.root).sort();
    await assert.rejects(() => proposals.capture(f.saved.id, f.saved.revision, candidate(snapshot), generation(snapshot), 'foreign-job'));
    assert.deepEqual(readdirSync(proposals.repo.root).sort(), before);
    const p = await capture(h, snapshot), full = p.variants.find(v => v.kind === 'protected')!;
    const storedPalette = [...proposals.repo.assets(full.id)[0].palette];
    p.generation!.clip!.context.slots[0].frozen = false;
    p.generation!.clip!.context.palette.reverse();
    full.canApply = false; full.clip!.contextDigest = 'mutated preview only';
    const result = await proposals.forApply(f.saved.id, p.proposalId, f.saved.revision);
    assert.deepEqual(result.assets[0].palette, storedPalette);
    assert.equal(proposals.repo.info(snapshot.referenceId).kind, 'reference');
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { h.close(); }
});

test('Independent clip proposals: project close permits a fresh reopen, instance close rejects late preparation without resurrection', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const first = await prepare(h);
    proposals.closeProject(f.saved.id);
    const reopened = await prepare(h);
    assert.notEqual(reopened.referenceId, first.referenceId);
    assert.ok((await capture(h, reopened)).proposalId, 'switch away and back must not permanently disable AI');
    proposals.closeProject(f.saved.id);
    const hold = h.hold('clip-prepare'), pending = prepare(h), rejected = assert.rejects(() => pending);
    await hold.arrived.promise; proposals.close(); hold.release.resolve(); await rejected;
    await assert.rejects(() => prepare(h), /đóng|hết hạn|closed|disposed/i);
  } finally { h.close(); }
});

test('Independent clip proposals: stale local normalization reaches a terminal job state and releases its output', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), p = await capture(h, snapshot), hold = h.hold('clip-normalize');
    const before = readdirSync(proposals.repo.root).sort();
    const job = proposals.startNormalize(f.saved.id, p.proposalId, f.saved.revision, 128);
    await hold.arrived.promise;
    const document = f.store.load(f.saved.id); document.name = 'External edit during normalize';
    f.store.save(document.id, document.revision, document, 'External test edit');
    const after = readFileSync(f.manifest); hold.release.resolve();
    await settledJob(h, job);
    assert.ok(job.status === 'failed' || job.status === 'canceled', job.message);
    assert.deepEqual(readdirSync(proposals.repo.root).sort(), before);
    assert.deepEqual(readFileSync(f.manifest), after);
  } finally { h.close(); }
});

test('Independent clip proposals: post-worker source read error cleans the newly prepared reference', async () => {
  const h = setup(), { f, proposals } = h;
  const originalLoad = f.store.load;
  try {
    const hold = h.hold('clip-prepare'), pending = prepare(h), rejected = assert.rejects(() => pending, /Injected/);
    await hold.arrived.promise;
    f.store.load = () => { throw new Error('Injected post-worker source load failure'); };
    hold.release.resolve(); await rejected; f.store.load = originalLoad;
    assert.deepEqual(readdirSync(proposals.repo.root), [], 'post-worker load failure must roll back only new reference');
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { f.store.load = originalLoad; h.close(); }
});

test('Independent clip proposals: a released reference during lazy frame load cannot return or cache its late image', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), p = await capture(h, snapshot), full = p.variants.find(v => v.kind === 'protected')!;
    const hold = h.hold('variant-frame');
    const pending = proposals.frame(f.saved.id, p.proposalId, full.id, full.assets[0].id, full.assets[0].frames[2].id, f.saved.revision);
    const rejected = assert.rejects(() => pending);
    await hold.arrived.promise; proposals.discardReference(f.saved.id, snapshot.referenceId); hold.release.resolve(); await rejected;
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { h.close(); }
});

test('Independent clip proposals: generation descriptor is captured before awaiting a worker', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), settings = generation(snapshot), originalPalette = [...snapshot.context.palette], hold = h.hold('clip-capture');
    proposals.rememberReference('immutable-job', f.saved.id, snapshot.referenceId);
    const pending = proposals.capture(f.saved.id, f.saved.revision, candidate(snapshot), settings, 'immutable-job');
    await hold.arrived.promise;
    settings.clip!.context.loop = true; settings.clip!.context.palette.reverse();
    hold.release.resolve(); const preview = await pending;
    assert.equal(preview.generation!.clip!.context.loop, false);
    assert.deepEqual(preview.generation!.clip!.context.palette, originalPalette);
    assert.ok((await proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision)).assets.length);
  } finally { h.close(); }
});

test('Independent clip proposals: instance disposal fences a preparation before its first reference is owned', async () => {
  const h = setup(), { proposals } = h;
  try {
    const hold = h.hold('clip-prepare'), pending = prepare(h), rejected = assert.rejects(() => pending);
    await hold.arrived.promise; proposals.close(); hold.release.resolve(); await rejected;
    assert.equal(proposals.records.size, 0); assert.equal(proposals.references.size, 0);
    assert.equal(existsSync(proposals.repo.root), false, 'a disposed instance must not recreate its temporary root');
  } finally { h.close(); }
});

test('Independent clip proposals: disposal during verified asset load cannot start another worker or recreate the repository', async () => {
  const h = setup(), { f, proposals } = h;
  try {
    const snapshot = await prepare(h), preview = await capture(h, snapshot), hold = h.hold('load');
    const pending = proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision), rejected = assert.rejects(() => pending);
    await hold.arrived.promise;
    proposals.close(); const count = h.requests.length;
    hold.release.resolve(); await rejected;
    assert.equal(h.requests.length, count, 'disposed apply must not schedule a new clip-prepare worker');
    assert.equal(existsSync(proposals.repo.root), false, 'late apply cannot resurrect a closed repository');
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { h.close(); }
});
