import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectStore } from '../src/node/studio/store.ts';
import { AiManager } from '../src/node/studio/ai.ts';
import type { CandidateExecutionOptions } from '../src/studio/batch-types.ts';
import type { ProjectDocument, BuildSummary } from '../src/studio/types.ts';
import { renderDocument } from '../src/node/studio/render.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';

const temporary = () => mkdtempSync(join(tmpdir(), 'pxl-batch-test-'));

function createTestDoc(id = 'proj-1'): ProjectDocument {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    name: 'Batch Test',
    entry: 'art.px.js',
    files: { 'art.px.js': "sprite('canvas',{w:32,h:32},rect(0,0,32,32,'#000000'))" },
    pixels: {},
    metadata: {},
  };
}

function createManager(root: string) {
  const store = new ProjectStore(root);
  const events: unknown[] = [];
  const manager = new AiManager(store, e => events.push(e), {
    codex: process.execPath,
    deepseek: fastHttpFixture(root),
    prefix: [resolve('studio/fake-cli.js')],
    timeout: 5000,
  });
  return { store, manager, events };
}

test('Batch runtime: Codex CLI and DeepSeek HTTP accept text-only single calls', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    for (const provider of ['codex', 'deepseek'] as const) {
      const doc = createTestDoc(`single-${provider}`);
      const initialExecutions = manager.cliExecutions;
      const opts: CandidateExecutionOptions = { candidateIndex: 0 };
      const job = await manager.start(doc, provider, 'draw pixel star', undefined, undefined, undefined, opts);
      const done = await manager.waitFor(job.id);
      assert.equal(done.status, 'ready', done.message);
      assert.equal(done.attempt, 1);
      assert.equal(done.cliExecutions, 1);
      assert.equal(manager.cliExecutions, initialExecutions + 1);
      assert.equal(done.candidateIndex, 0);
      assert.ok(done.proposal);
    }
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Batch runtime: invalid source one repair only', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    const doc = createTestDoc('repair-doc');
    const opts: CandidateExecutionOptions = { candidateIndex: 1 };
    const initialExecutions = manager.cliExecutions;
    const job = await manager.start(doc, 'codex', 'FIXTURE_SOURCE_REPAIR', undefined, undefined, undefined, opts);
    const done = await manager.waitFor(job.id);
    assert.equal(done.status, 'ready');
    assert.equal(done.attempt, 2);
    assert.equal(done.cliExecutions, 2);
    assert.equal(manager.cliExecutions, initialExecutions + 2);
    assert.ok(done.proposal);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Batch runtime: batch nullable manifest accepted, repaired, and rejected', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    // Case 1: Valid manifest accepted
    const doc1 = createTestDoc('manifest-valid');
    const job1 = await manager.start(doc1, 'codex', 'FIXTURE_MANIFEST_VALID', undefined, undefined, undefined, { candidateIndex: 0 });
    const done1 = await manager.waitFor(job1.id);
    assert.equal(done1.status, 'ready');
    assert.ok(done1.proposal?.manifest);
    assert.equal(done1.proposal.manifest.version, 1);
    assert.equal(done1.proposal.manifest.palette?.name, 'star-palette');
    assert.equal(done1.proposal.manifest.parts?.[0].name, 'core');
    assert.equal(done1.attempt, 1);

    // Case 2: Nullable manifest normalized safely
    const doc2 = createTestDoc('manifest-null');
    const job2 = await manager.start(doc2, 'deepseek', 'draw star without manifest', undefined, undefined, undefined, { candidateIndex: 1 });
    const done2 = await manager.waitFor(job2.id);
    assert.equal(done2.status, 'ready');
    assert.equal(done2.proposal?.manifest, undefined);

    // Case 3: Invalid manifest repaired
    const doc3 = createTestDoc('manifest-repair');
    const job3 = await manager.start(doc3, 'codex', 'FIXTURE_MANIFEST_REPAIR', undefined, undefined, undefined, { candidateIndex: 2 });
    const done3 = await manager.waitFor(job3.id);
    assert.equal(done3.status, 'ready');
    assert.equal(done3.attempt, 2);
    assert.equal(done3.cliExecutions, 2);
    assert.ok(done3.proposal?.manifest);
    assert.equal(done3.proposal.manifest.parts?.[0].name, 'repaired-core');

    // Case 4: Invalid manifest rejected after repair
    const doc4 = createTestDoc('manifest-invalid');
    const job4 = await manager.start(doc4, 'codex', 'FIXTURE_MANIFEST_INVALID', undefined, undefined, undefined, { candidateIndex: 0 });
    const done4 = await manager.waitFor(job4.id);
    assert.equal(done4.status, 'failed');
    assert.equal(done4.attempt, 2);
    assert.match(done4.message, /Manifest không hợp lệ/);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Batch runtime: Codex receives art-reference files; DeepSeek rejects them before a provider call', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    const pngDummy = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const refImages = [
      { name: 'art-ref-1.png', data: pngDummy },
      { name: 'art-ref-2.png', data: pngDummy },
    ];

    for (const provider of ['codex'] as const) {
      const doc = createTestDoc(`ref-${provider}`);
      const opts: CandidateExecutionOptions = {
        candidateIndex: 0,
        referenceImages: refImages,
      };
      const job = await manager.start(doc, provider, 'follow refs', undefined, undefined, undefined, opts);
      const done = await manager.waitFor(job.id);
      assert.equal(done.status, 'ready');
      assert.ok(done.proposal?.description.includes('refs=2'));
    }
    const before = manager.cliExecutions;
    await assert.rejects(manager.start(createTestDoc('ref-deepseek'), 'deepseek', 'follow refs', undefined, undefined, undefined, { candidateIndex: 0, referenceImages: refImages }), /Codex/);
    assert.equal(manager.cliExecutions, before);
    await assert.rejects(manager.start(createTestDoc('retired-anti'), 'antigravity', 'no remap'), /Antigravity|Codex/);
    assert.equal(manager.cliExecutions, before);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('AI validation: later-frame defects get one technical repair before Codex or DeepSeek report ready', async () => {
  const late = createTestDoc('prove-late-frame');
  late.files[late.entry] = "pal({g:'#70c989'});anim('late',{w:8,h:8,loop:false},frame({ms:80},px(1,1,'g')),frame({ms:140},px(2,1,'g')),frame({ms:200},px(3,1,'missing')))";
  const firstOnly = renderDocument({ document: late, mode: 'summary' }) as BuildSummary;
  assert.deepEqual(firstOnly.errors, [], 'Legacy fast summary really misses the later-frame defect');
  const allFrames = renderDocument({ document: late, mode: 'summary', validateFrames: true }) as BuildSummary;
  assert.match(allFrames.errors.join('\n'), /missing|unknown color/, 'AI validation executes the last frame with nonuniform timing');
  const root = temporary(), { manager } = createManager(root);
  try {
    for (const provider of ['codex', 'deepseek'] as const) {
      const job = await manager.start(createTestDoc(`late-repair-${provider}`), provider, 'FIXTURE_LATE_FRAME_REPAIR');
      const done = await manager.waitFor(job.id);
      assert.equal(done.status, 'ready', done.message); assert.equal(done.attempt, 2); assert.equal(done.cliExecutions, 2);
      assert.match(done.proposal!.files[0].content, /px\(2,1,'a'\)/); assert.deepEqual(done.build!.errors, []);
    }
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});

test('AI validation: persistent later-frame errors fail after two calls and expose no ready proposal', async () => {
  const root = temporary(), { manager } = createManager(root);
  try {
    for (const provider of ['codex', 'deepseek'] as const) {
      const job = await manager.start(createTestDoc(`late-invalid-${provider}`), provider, 'FIXTURE_LATE_FRAME_INVALID', undefined, undefined, undefined, { candidateIndex: 0 });
      const done = await manager.waitFor(job.id);
      assert.equal(done.status, 'failed'); assert.equal(done.attempt, 2); assert.equal(done.cliExecutions, 2);
      assert.match(done.message, /missing|unknown color/); assert.equal(done.proposal, undefined);
    }
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Batch runtime: cancellation blocks late result and concurrent cancel calls share promise', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    const doc = createTestDoc('cancel-hang');
    const job = await manager.start(doc, 'codex', 'FIXTURE_HANG', undefined, undefined, undefined, { candidateIndex: 0 });
    const spawnedBy = Date.now() + 4000;
    while (!job.cliExecutions && Date.now() < spawnedBy) await new Promise(r => setTimeout(r,20));
    assert.equal(job.cliExecutions,1,'cancel must exercise a real spawned fixture process');
    // Concurrent cancel calls
    const [c1, c2] = await Promise.all([
      manager.cancel(job.id, 'user requested cancel'),
      manager.cancel(job.id, 'user requested cancel'),
    ]);
    assert.equal(c1.status, 'canceled');
    assert.equal(c2.status, 'canceled');
    assert.equal(job.status, 'canceled');
    assert.equal(job.proposal, undefined);
    assert.equal((await manager.waitFor(job.id)).status,'canceled');

    // Wait to ensure no late completion changes status
    await new Promise(r => setTimeout(r, 200));
    assert.equal(job.status, 'canceled');
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Batch runtime: caller deadline and timeout shorten the candidate budget', async () => {
  const root=temporary(),{manager}=createManager(root);
  try {
    for (const options of [{candidateIndex:0,timeout:40},{candidateIndex:1,deadline:Date.now()+40}]) {
      const started=Date.now();
      const job=await manager.start(createTestDoc(`short-${options.candidateIndex}`),'codex','FIXTURE_HANG',undefined,undefined,undefined,options);
      const result=await manager.waitFor(job.id);
      assert.equal(result.status,'canceled');
      assert.match(result.message,/vượt thời gian/);
      assert.ok(Date.now()-started<3000,'caller deadline must not become a minimum 180 second budget');
      assert.equal(result.proposal,undefined);
    }
  } finally { await manager.close();rmSync(root,{recursive:true,force:true}); }
});

test('Batch runtime: unknown disposal holds project busy gate; regular disposal clears', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    const doc = createTestDoc('gate-doc');
    const job = await manager.start(doc, 'codex', 'draw something', undefined, undefined, undefined, { candidateIndex: 0 });
    await manager.waitFor(job.id);
    assert.equal(job.status, 'ready');

    // Simulate an unknown job for this project
    const unknownJob = { ...job, id: 'unknown-task-1', status: 'unknown' as const };
    manager.jobs.set(unknownJob.id, unknownJob);

    // disposeProject must retain unknown job
    manager.disposeProject(doc.id);
    assert.ok(manager.jobs.has(unknownJob.id), 'unknown job must be retained by disposeProject');
    assert.equal(manager.jobs.has(job.id), false, 'ready job was disposed');

    // Attempting to start another job on the project throws 409 because unknown job holds gate
    await assert.rejects(
      () => manager.start(doc, 'codex', 'blocked by unknown gate'),
      /đang có tác vụ AI/
    );

    // disposeJob also retains unknown job
    manager.disposeJob(unknownJob.id);
    assert.ok(manager.jobs.has(unknownJob.id), 'unknown job must be retained by disposeJob');
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Batch runtime: legacy calls unchanged', async () => {
  const root = temporary();
  const { manager } = createManager(root);
  try {
    const doc = createTestDoc('legacy-doc');
    const job = await manager.start(doc, 'codex', 'draw legacy');
    const done = await manager.waitFor(job.id);
    assert.equal(done.status, 'ready');
    assert.equal(done.candidateIndex, undefined);
    assert.equal(done.proposal?.manifest, undefined);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Batch runtime: unconfirmed shutdown is observable without awaiting an execution that may still be alive',async()=>{
  const root=temporary(),{manager}=createManager(root),doc=createTestDoc('unknown-observable');
  try{
    const job={id:'unknown-observable-job',projectId:doc.id,revision:1,provider:'codex' as const,status:'unknown' as const,started:Date.now(),message:'unconfirmed',attempt:1};
    manager.jobs.set(job.id,job);
    (manager as any).active.set(job.id,{cancel:true,settled:new Promise<void>(()=>{})});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{const result=await Promise.race([manager.waitFor(job.id),new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(Error('unknown status blocked awaiting unconfirmed execution')),500))]);assert.equal(result.status,'unknown');}finally{clearTimeout(timer);}
    manager.disposeProject(doc.id);assert.ok(manager.jobs.has(job.id));await assert.rejects(()=>manager.start(doc,'codex','must remain blocked'),/đang có tác vụ AI/);
  }finally{await manager.close();rmSync(root,{recursive:true,force:true});}
});
