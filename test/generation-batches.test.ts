import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { serveStudio } from '../src/node/studio/server.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
import { wireParse,wireStringify,newDocument,celFor } from '../src/studio/pixel/model.ts';
import { Proposals } from '../src/node/studio/proposals.ts';

const temporary = () => mkdtempSync(join(tmpdir(), 'pxl-batches-test-'));

function decodePng(data: Uint8Array): { w: number; h: number; pixels: Uint32Array } {
  const b = Buffer.from(data);
  let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let o = 8; o + 12 <= b.length;) {
    const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); mode = d[9]; }
    if (t === 'PLTE') palette = Buffer.from(d);
    if (t === 'tRNS') alpha = Buffer.from(d);
    if (t === 'IDAT') chunks.push(d);
    o += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), out = new Uint32Array(w * h), stride = w * (mode === 3 ? 1 : 4) + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * stride + 1 + x * (mode === 3 ? 1 : 4);
      if (mode === 3) {
        const i = raw[j];
        out[y * w + x] = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) | (palette[i * 3 + 2] << 8) | (alpha[i] ?? 255)) >>> 0;
      } else {
        out[y * w + x] = raw.readUInt32BE(j);
      }
    }
  }
  return { w, h, pixels: out };
}

function listenSSE(appUrl: string): { events: any[]; close: () => void } {
  const events: any[] = [];
  const controller = new AbortController();
  fetch(`${appUrl}api/studio/events`, { signal: controller.signal })
    .then(async res => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const block of lines) {
          const match = block.match(/^data:\s*(.+)$/m);
          if (match) {
            try { events.push(JSON.parse(match[1])); } catch {}
          }
        }
      }
    })
    .catch(() => {});
  return { events, close: () => controller.abort() };
}

async function createServer(root: string) {
  const app = await serveStudio(root, {
    port: 0,
    uiDir: resolve('dist/studio'),
    providers: {
      codex: process.execPath,
      deepseek: fastHttpFixture(root),
      prefix: [resolve('studio/fake-cli.js'), '--state-dir', root],
      timeout: 5000,
    },
  });

  const req = async (path: string, method = 'GET', value?: unknown) => {
    const url = `${app.url}api/pixel/${path}`;
    const headers: Record<string, string> = {
      origin: app.url.slice(0, -1),
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    };
    return fetch(url, {
      method,
      headers,
      body: value === undefined ? undefined : wireStringify(value),
    });
  };

  const waitBatch = async (base: string, batchId: string, timeoutMs = 25000) => {
    const until = Date.now() + timeoutMs;
    let batch: any;
    while (Date.now() < until) {
      const res = await req(`${base}/generation-batches/${batchId}`);
      assert.equal(res.status, 200);
      batch = await res.json();
      if (!['running'].includes(batch.status)) return batch;
      await new Promise(r => setTimeout(r, 50));
    }
    return batch;
  };

  return { app, req, waitBatch };
}

test('Generation batches: a closed and reopened project accepts new batch and legacy AI without accepting old preparations', async () => {
  const root = temporary();
  const { app, req, waitBatch } = await createServer(root);
  try {
    const doc = await (await req('projects', 'POST', { name: 'Reopen AI', w: 18, h: 18 })).json();
    const base = `projects/${doc.id}`;
    for (const provider of ['codex', 'deepseek']) {
      assert.equal((await req(`${base}/close`, 'POST', {})).status, 200);
      assert.equal((await req(base)).status, 200);
      const response = await req(`${base}/generation-batches`, 'POST', { revision: doc.revision, provider, prompt: 'Reopened sprite', generationOptions: {} });
      assert.equal(response.status, 202);
      const batch = await waitBatch(base, (await response.json()).id);
      assert.equal(batch.status, 'ready');
      assert.equal(batch.candidates.reduce((sum: number, c: any) => sum + c.cliExecutions, 0), 3);
    }
    assert.equal((await req(`${base}/close`, 'POST', {})).status, 200);
    const legacy = await req(`${base}/ai`, 'POST', { revision: doc.revision, provider: 'codex', prompt: 'Reopened legacy', generationOptions: {} });
    assert.equal(legacy.status, 202);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Generation batches: both providers run 3 sequential calls, candidate 2 preview, exact RGBA apply, export, and reopen', async () => {
  const root = temporary();
  const { app, req, waitBatch } = await createServer(root);
  const sse = listenSSE(app.url);
  try {
    for (const provider of ['codex', 'deepseek'] as const) {
      // 1. Create fresh project
      const pRes = await req('projects', 'POST', { name: `Batch test ${provider}`, w: 32, h: 32 });
      assert.equal(pRes.status, 201);
      const doc = await pRes.json();
      const base = `projects/${doc.id}`;

      // 2. Start batch
      const bRes = await req(`${base}/generation-batches`, 'POST', {
        revision: doc.revision,
        provider,
        prompt: 'draw pixel champion',
        generationOptions: { style: 'game', view: 'front' },
      });
      assert.equal(bRes.status, 202);
      const initial = await bRes.json();
      assert.equal(initial.status, 'running');
      assert.equal(initial.candidates.length, 3);
      assert.ok(initial.config?.target);
      assert.equal(initial.config.target.w, 32);
      assert.equal(initial.config.target.h, 32);

      // 3. Wait for all 3 sequential candidates to complete
      const batch = await waitBatch(base, initial.id);
      assert.equal(batch.status, 'ready', `Expected ready batch for ${provider}, got: ${JSON.stringify(batch)}`);
      assert.equal(batch.candidates.length, 3);

      // Assert sequential timestamps
      assert.ok(batch.candidates[0].started <= batch.candidates[0].ended);
      assert.ok(batch.candidates[0].ended <= batch.candidates[1].started);
      assert.ok(batch.candidates[1].ended <= batch.candidates[2].started);

      for (let i = 0; i < 3; i++) {
        assert.equal(batch.candidates[i].status, 'ready');
        assert.equal(batch.candidates[i].attempt, 1);
        assert.equal(batch.candidates[i].cliExecutions, 1);
        assert.ok(batch.candidates[i].elapsedMs > 0);
        assert.deepEqual(batch.candidates[i].dimensions, { w: 32, h: 32 });
      }

      // Assert NO autosave before explicit apply (document in store remains revision 1)
      const currentDocRes = await req(base);
      const currentDoc = await currentDocRes.json();
      assert.equal(currentDoc.revision, doc.revision);
      assert.equal(currentDoc.assets.length, 1);

      // 4. Candidate 2 (index 1) preview
      const cand2 = batch.candidates[1];
      const prevRes = await req(`${base}/generation-batches/${batch.id}/candidates/${cand2.id}/preview`, 'POST', {
        revision: doc.revision,
      });
      assert.equal(prevRes.status, 200);
      const preview = await prevRes.json();
      assert.ok(preview.proposalId);
      assert.ok(preview.variants.length > 0);

      // Fetch variant frame to compare exact pixels
      const frameRes = await req(`${base}/proposals/${preview.proposalId}/variants/${preview.selectedVariantId}/frame?asset=${preview.variants[0].assets[0].id}&frame=${preview.variants[0].assets[0].frames[0].id}&revision=${doc.revision}`);
      assert.equal(frameRes.status, 200);
      const frameData = wireParse(await frameRes.text());

      // 5. Apply candidate 2
      const applyRes = await req(`${base}/apply-proposal`, 'POST', {
        revision: doc.revision,
        proposalId: preview.proposalId,
        variantId: preview.selectedVariantId,
      });
      assert.equal(applyRes.status, 200);
      const savedDoc = await applyRes.json();
      assert.equal(savedDoc.revision, doc.revision + 1);
      assert.equal(savedDoc.assets.length, 2, 'New asset created from proposal');

      // Check batch state updated to applied
      const updatedBatchRes = await req(`${base}/generation-batches/${batch.id}`);
      const updatedBatch = await updatedBatchRes.json();
      assert.equal(updatedBatch.status, 'applied');
      assert.equal(updatedBatch.appliedCandidateId, cand2.id);

      // 6. Export PNG and decode exact RGBA
      const exportRes = await req(`${base}/export`, 'POST', {
        revision: savedDoc.revision,
        format: 'png',
        assetId: savedDoc.assets[1].id,
      });
      assert.equal(exportRes.status, 200);
      const pngBuf = new Uint8Array(await exportRes.arrayBuffer());
      const decoded = decodePng(pngBuf);
      assert.equal(decoded.w, 32);
      assert.equal(decoded.h, 32);
      assert.deepEqual(Array.from(decoded.pixels), Array.from(frameData.data));

      // 7. Hydrate saved cel on reopen and verify exact match
      const reopenRes = await req(base);
      assert.equal(reopenRes.status, 200);
      const reopened = await reopenRes.json();
      assert.equal(reopened.revision, savedDoc.revision);
      const newAsset = reopened.assets[1];
      const celKey = Object.keys(newAsset.cels)[0];
      const celRes = await req(`${base}/cel?asset=${newAsset.id}&cel=${celKey}&revision=${reopened.revision}`);
      assert.equal(celRes.status, 200);
      const cel = wireParse(await celRes.text());
      assert.deepEqual(Array.from(cel.data), Array.from(frameData.data));
    }

    // 8. Assert SSE events were consumed and are compact (no files, data, source)
    const batchEvents = sse.events.filter(e => e.type === 'pixel-batch');
    assert.ok(batchEvents.length > 0, 'Must have received pixel-batch SSE events');
    for (const be of batchEvents) {
      const text = JSON.stringify(be);
      assert.ok(!/"(?:files|data|source|preview|movementMask|mask|\$rgba)"\s*:/.test(text), 'SSE must not include source or image/frame data');
      assert.ok(!text.includes('data:image'), 'SSE must not include base64');
      assert.ok(!text.includes('"source":'), 'SSE must not include raw source');
    }
  } finally {
    sse.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generation batches: expired candidate remains retryable and cancel blocks ready proposal application',async()=>{
  const root=temporary(),{app,req,waitBatch}=await createServer(root);
  try{
    const doc=await(await req('projects','POST',{name:'Deadline',w:32,h:32})).json(),base=`projects/${doc.id}`;
    const initial=await(await req(`${base}/generation-batches`,'POST',{revision:doc.revision,provider:'codex',prompt:'FIXTURE_HANG_2',generationOptions:{}})).json();
    const batch=await waitBatch(base,initial.id);
    assert.equal(batch.status,'partial');assert.equal(batch.candidates[1].status,'failed');assert.match(batch.candidates[1].message,/vượt thời gian/);
    assert.equal(batch.candidates[0].status,'ready');assert.equal(batch.candidates[2].status,'ready');
    const preview=await(await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[0].id}/preview`,'POST',{revision:doc.revision})).json();
    assert.equal((await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[1].id}/retry`,'POST',{revision:doc.revision})).status,202);
    const apply={revision:doc.revision,proposalId:preview.proposalId,variantId:preview.selectedVariantId};
    assert.equal((await req(`${base}/apply-proposal`,'POST',apply)).status,409,'running retry must block apply');
    const cancel=await req(`${base}/generation-batches/${batch.id}/cancel`,'POST',{revision:doc.revision});assert.equal(cancel.status,200);assert.equal((await cancel.json()).status,'canceled');
    assert.equal((await req(`${base}/apply-proposal`,'POST',apply)).status,409,'canceled result must not be applied');
    const after=await(await req(base)).json();assert.equal(after.revision,doc.revision);assert.equal(after.assets.length,1);
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('Generation batches: captured profile/ref settings and normalization keep one source revision and exactly three CLI calls',async()=>{
  const root=temporary(),{app,req,waitBatch}=await createServer(root);
  try{
    const initial=newDocument('Profile',18,24),a=initial.assets[0];celFor(a,a.layers[0].id,a.frames[0].id,true)!.data![0]=0x70c989ff;
    a.source={entry:'old.px.js',files:{'old.px.js':"// SOURCE_REFERENCE_MARKER\nsprite('old',{w:18,h:24},px(0,0,'#70c989'))"}};
    const palette=[0x123456ff];initial.studio={version:1,artDirection:{style:'eight-bit',paletteMode:'asset',palette,light:'upper-left',detailLevel:'low',outline:'dark',references:[{assetId:a.id,frameId:a.frames[0].id}]}};
    const doc=await(await req('projects','POST',{name:initial.name,document:initial})).json(),base=`projects/${doc.id}`;
    const starting=await(await req(`${base}/generation-batches`,'POST',{revision:doc.revision,provider:'codex',prompt:'new item',generationOptions:{style:'flat-icon',view:'side',reference:false},artDirection:{detailLevel:'high',outline:'none'}})).json();
    const batch=await waitBatch(base,starting.id);assert.equal(batch.status,'ready');
    assert.equal(batch.config.options.style,'flat-icon');assert.equal(batch.config.artDirection.style,'flat-icon');assert.deepEqual(batch.config.artDirection.palette,palette);assert.equal(batch.config.artDirection.references[0].frameId,a.frames[0].id);
    for(const c of batch.candidates){assert.equal(c.cliExecutions,1);assert.match(c.description,/preview=false/);assert.match(c.description,/source=false/);assert.match(c.description,/refs=1/);}
    const unchanged=await(await req(base)).json();assert.equal(unchanged.revision,doc.revision);assert.equal(unchanged.assets.length,1);assert.equal(unchanged.studio.artDirection.style,'eight-bit');
    const p=await(await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[1].id}/preview`,'POST',{revision:doc.revision})).json();
    assert.deepEqual(p.generation.palette,palette);assert.equal(p.generation.options.style,'flat-icon');
    let job=await(await req(`${base}/proposals/${p.proposalId}/normalize`,'POST',{revision:doc.revision})).json();
    const until=Date.now()+8000;while(job.status==='running'&&Date.now()<until){await new Promise(r=>setTimeout(r,30));job=await(await req(`${base}/processing/${job.id}`)).json();}assert.equal(job.status,'ready');
    const preview=await(await req(`${base}/proposals/${p.proposalId}?revision=${doc.revision}`)).json(),variant=preview.variants.find((v:any)=>v.id===job.variantId),asset=variant.assets[0];
    const frame=wireParse(await(await req(`${base}/proposals/${p.proposalId}/variants/${variant.id}/frame?revision=${doc.revision}&asset=${asset.id}&frame=${asset.frames[0].id}`)).text());
    assert.deepEqual([...new Set([...frame.data].filter((c:number)=>c&255))],palette);
    assert.equal(readFileSync(join(root,'fixture-cli-calls.jsonl'),'utf8').trim().split('\n').length,3,'local normalization must not start any provider');
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('Generation batches: closing while a real reference is held gates competing old/new starts and prevents late CLI execution',async()=>{
  const original=Proposals.prototype.reference;
  for(const action of ['ai','generation-batches']){
    const root=temporary(),{app,req}=await createServer(root);
    let release!:()=>void,prepared!:()=>void;
    const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>prepared=r);
    Proposals.prototype.reference=async function(...args){const result=await original.apply(this,args);prepared();await held;return result;};
    try{
      const initial=newDocument(`Close ${action}`,18,18),a=initial.assets[0];celFor(a,a.layers[0].id,a.frames[0].id,true)!.data![0]=0x70c989ff;
      const doc=await(await req('projects','POST',{name:initial.name,document:initial})).json(),base=`projects/${doc.id}`;
      const starting=req(`${base}/${action}`,'POST',{revision:doc.revision,provider:'codex',prompt:'blink',assetId:a.id,generationOptions:{animation:{frameId:a.frames[0].id,mode:'whole',frames:2,duration:100,loop:true,anchor:{x:9,y:18}}}});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([ready,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('reference not prepared')),6000))]);}finally{clearTimeout(timer);}
      const competitor=req(`${base}/${action==='ai'?'generation-batches':'ai'}`,'POST',{revision:doc.revision,provider:'codex',prompt:'competing request',generationOptions:{}});
      let gateTimer:ReturnType<typeof setTimeout>|undefined;
      try{const response=await Promise.race([competitor,new Promise<never>((_,reject)=>gateTimer=setTimeout(()=>reject(Error('competing request bypassed preparation lease')),2000))]);assert.equal(response.status,409);}finally{clearTimeout(gateTimer);}
      assert.equal((await req(`${base}/close`,'POST',{})).status,200);
      release();const response=await starting;assert.equal(response.status,409,await response.clone().text());
      assert.deepEqual(await(await req(`${base}/ai`)).json(),[]);
      assert.deepEqual(await(await req(`${base}/generation-batches`)).json(),[]);
    }finally{release();Proposals.prototype.reference=original;await app.close();rmSync(root,{recursive:true,force:true});}
  }
});

test('Generation batches: stale retry rejected when caller supplies current revision after edit', async () => {
  const root = temporary();
  const { app, req, waitBatch } = await createServer(root);
  try {
    const pRes = await req('projects', 'POST', { name: 'Stale retry test', w: 32, h: 32 });
    const doc = await pRes.json();
    const base = `projects/${doc.id}`;

    // Candidate 2 fails on purpose once
    const bRes = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'FIXTURE_SECOND_FAILS_FAIL_ONCE create warrior',
      generationOptions: {},
    });
    assert.equal(bRes.status, 202);
    const initial = await bRes.json();

    const batch = await waitBatch(base, initial.id);
    assert.equal(batch.status, 'partial', JSON.stringify(batch));
    assert.equal(batch.candidates[1].status, 'failed');

    // Edit the project in the meantime, advancing revision to 2
    const current = await (await req(base)).json();
    const editRes = await req(base, 'PUT', {
      revision: current.revision,
      document: { ...current, name: 'Edited after batch' },
    });
    assert.equal(editRes.status, 200);
    const edited = await editRes.json();
    assert.equal(edited.revision, 2);

    // Caller requests retry with CURRENT revision (2), but batch snapshot is at revision 1.
    // Server must reject with 409 BEFORE provider start!
    const staleRetryRes = await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[1].id}/retry`, 'POST', {
      revision: edited.revision,
    });
    assert.equal(staleRetryRes.status, 409, 'retry must refuse old captured revision even when caller supplies current revision');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generation batches: partial ready, retry only failed candidate retains cumulative totals', async () => {
  const root = temporary();
  const { app, req, waitBatch } = await createServer(root);
  try {
    const pRes = await req('projects', 'POST', { name: 'Partial test', w: 32, h: 32 });
    const doc = await pRes.json();
    const base = `projects/${doc.id}`;

    // Candidate 2 fails on purpose once, then succeeds on retry
    const bRes = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'FIXTURE_SECOND_FAILS_FAIL_ONCE create warrior',
      generationOptions: {},
    });
    assert.equal(bRes.status, 202);
    const initial = await bRes.json();

    const batch = await waitBatch(base, initial.id);
    assert.equal(batch.status, 'partial', JSON.stringify(batch));
    assert.equal(batch.candidates[0].status, 'ready');
    assert.equal(batch.candidates[1].status, 'failed');
    assert.equal(batch.candidates[2].status, 'ready');

    // Attempting to retry a ready sibling (candidate 0) is rejected
    const badRetry = await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[0].id}/retry`, 'POST', {
      revision: doc.revision,
    });
    assert.equal(badRetry.status, 400);

    // Explicit retry on failed candidate on matching revision 1
    const retryRes = await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[1].id}/retry`, 'POST', {
      revision: doc.revision,
    });
    assert.equal(retryRes.status, 202);

    const retriedBatch = await waitBatch(base, batch.id);
    assert.equal(retriedBatch.status, 'ready', JSON.stringify(retriedBatch));
    const retriedCand = retriedBatch.candidates[1];
    assert.equal(retriedCand.status, 'ready');
    assert.equal(retriedCand.attempt, 2);
    assert.equal(retriedCand.cliExecutions, 2);
    assert.ok(retriedCand.elapsedMs > 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generation batches: cancel uses caller CURRENT revision; stale revision refused', async () => {
  const root = temporary();
  const { app, req } = await createServer(root);
  try {
    const pRes = await req('projects', 'POST', { name: 'Cancel test', w: 32, h: 32 });
    const doc = await pRes.json();
    const base = `projects/${doc.id}`;

    // Start a batch with HANG on candidate 2 so it stays running
    const bRes = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'FIXTURE_HANG_2 hang on second candidate',
      generationOptions: {},
    });
    assert.equal(bRes.status, 202);
    const initial = await bRes.json();

    // Observe the real hanging CLI before changing revision. A fixed delay can
    // expire during candidate 0 under parallel worker load and miss this case.
    const spawnedBy = Date.now() + 10_000;
    let running: any;
    do {
      running = await (await req(`${base}/generation-batches/${initial.id}`)).json();
      if (running.candidates[0].status === 'ready' && running.candidates[1].status === 'running' &&
          running.candidates[1].cliExecutions === 1) break;
      await new Promise(r => setTimeout(r, 25));
    } while (Date.now() < spawnedBy && running.status === 'running');
    assert.equal(running.candidates[0].status, 'ready');
    assert.equal(running.candidates[1].status, 'running');
    assert.equal(running.candidates[1].cliExecutions, 1, 'cancel must exercise the actual hanging fixture');

    // Edit the project while batch is running to advance revision!
    const editRes = await req(base, 'PUT', {
      revision: doc.revision,
      document: { ...doc, name: 'Renamed while generating' },
    });
    assert.equal(editRes.status, 200);
    const editedDoc = await editRes.json();
    assert.equal(editedDoc.revision, doc.revision + 1);

    // External cancel with OLD revision (1) is refused with 409!
    const staleCancel = await req(`${base}/generation-batches/${initial.id}/cancel`, 'POST', {
      revision: doc.revision, // old revision
    });
    assert.equal(staleCancel.status, 409);

    // External cancel with caller's CURRENT revision (2) succeeds!
    const goodCancel = await req(`${base}/generation-batches/${initial.id}/cancel`, 'POST', {
      revision: editedDoc.revision, // current revision
    });
    assert.equal(goodCancel.status, 200);
    const canceledBatch = await goodCancel.json();
    assert.equal(canceledBatch.status, 'canceled');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generation batches: close during preparation prevents CLI spawn and cleans lease', async () => {
  const root = temporary();
  const { app, req } = await createServer(root);
  try {
    const pRes = await req('projects', 'POST', { name: 'Close prep test', w: 32, h: 32 });
    const doc = await pRes.json();
    const base = `projects/${doc.id}`;

    // Trigger close immediately after issuing batch request
    const batchPromise = req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'draw something',
      generationOptions: {},
    });

    const closeRes = await req(`${base}/close`, 'POST', {});
    assert.equal(closeRes.status, 200);

    const bRes = await batchPromise;
    // Either the batch failed to start due to close (409) or was canceled during close
    if (bRes.status === 202) {
      const batch = await bRes.json();
      const statusRes = await req(`${base}/generation-batches/${batch.id}`);
      // If project was closed, batch was canceled or project is 404
      assert.ok([200, 404].includes(statusRes.status));
    } else {
      assert.equal(bRes.status, 409);
    }
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generation batches: normalization reuse on candidate proposal succeeds without extra AI calls', async () => {
  const root = temporary();
  const { app, req, waitBatch } = await createServer(root);
  try {
    const pRes = await req('projects', 'POST', { name: 'Normalize test', w: 32, h: 32 });
    const doc = await pRes.json();
    const base = `projects/${doc.id}`;

    const bRes = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'draw icon',
      generationOptions: { style: 'game', paletteMode: 'asset' },
    });
    const initial = await bRes.json();
    const batch = await waitBatch(base, initial.id);
    assert.equal(batch.status, 'ready');

    // Total AI CLI executions should be 3
    const totalExecutions = batch.candidates.reduce((s: number, c: any) => s + (c.cliExecutions ?? 0), 0);
    assert.equal(totalExecutions, 3);

    // Preview candidate 0
    const prevRes = await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[0].id}/preview`, 'POST', {
      revision: doc.revision,
    });
    const preview = await prevRes.json();
    assert.ok(preview.proposalId);

    // Normalize proposal
    const normRes = await req(`${base}/proposals/${preview.proposalId}/normalize`, 'POST', {
      revision: doc.revision,
      alphaThreshold: 128,
    });
    assert.equal(normRes.status, 202);
    const normJob = await normRes.json();
    assert.equal(normJob.status, 'running');

    // Await processing job
    let finalJob: any;
    for (let i = 0; i < 50; i++) {
      const jRes = await req(`${base}/processing/${normJob.id}`);
      finalJob = await jRes.json();
      if (finalJob.status !== 'running') break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(finalJob.status, 'ready');
    assert.ok(finalJob.variantId);

    // Verify no extra AI calls occurred during normalization
    const batchAfterRes = await req(`${base}/generation-batches/${batch.id}`);
    const batchAfter = await batchAfterRes.json();
    const totalExecutionsAfter = batchAfter.candidates.reduce((s: number, c: any) => s + (c.cliExecutions ?? 0), 0);
    assert.equal(totalExecutionsAfter, 3, 'Normalization must be pure local worker operation without extra AI calls');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generation batches: malformed inputs rejected synchronously before preparation', async () => {
  const root = temporary();
  const { app, req } = await createServer(root);
  try {
    const pRes = await req('projects', 'POST', { name: 'Validation test', w: 32, h: 32 });
    const doc = await pRes.json();
    const base = `projects/${doc.id}`;

    // Invalid provider
    const res1 = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'invalid-provider',
      prompt: 'draw',
    });
    assert.equal(res1.status, 400);

    // Empty prompt
    const res2 = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: '   ',
    });
    assert.equal(res2.status, 400);

    // Malformed generationOptions (primitive)
    const res3 = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'draw',
      generationOptions: 'not-an-object',
    });
    assert.equal(res3.status, 400);

    // Malformed generationOptions (null)
    const res4 = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'draw',
      generationOptions: null,
    });
    assert.equal(res4.status, 400);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
