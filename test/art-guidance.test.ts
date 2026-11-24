import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureArtGuidance, guidanceInfo, withArtGuidance } from '../src/node/studio/art-guidance.ts';
import type { GenerationContext, ProjectDocument } from '../src/studio/types.ts';
import { AiManager, type ProviderSettings } from '../src/node/studio/ai.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { ProjectStore } from '../src/node/studio/store.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
const generation: GenerationContext = { assetId:'test',w:32,h:32,palette:[0x70c989ff],options:{style:'game',view:'front',paletteMode:'asset',reference:false} };

test('AI generation: empty callback output is repaired once or fails before ready, CLI and HTTP adapters',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-empty-generation-'));
  const manager=new AiManager(new ProjectStore(root),()=>{},{codex:process.execPath,deepseek:fastHttpFixture(root),prefix:[resolve('studio/fake-cli.js')],timeout:8000});
  try{for(const provider of ['codex','deepseek']as const)for(const scenario of ['REPAIR','ALWAYS']){
    const doc:ProjectDocument={schemaVersion:1,id:provider+scenario,name:'fixture',revision:1,entry:'art.px.js',files:{'art.px.js':"sprite('canvas',{w:32,h:32},[])"},pixels:{},metadata:{}};
    const job=await manager.start(doc,provider,'FIXTURE_EMPTY_'+scenario,undefined,generation);const done=await manager.waitFor(job.id);
    assert.equal(done.status,scenario==='REPAIR'?'ready':'failed',done.message);assert.equal(done.cliExecutions,2);if(scenario==='ALWAYS')assert.match(done.message,/Ảnh rỗng/);
  }}finally{await manager.close();rmSync(root,{recursive:true,force:true});}
});

test('Art guidance: baseline is byte-identical; legacy source-only context remains baseline', () => {
  for(const g of [captureArtGuidance('baseline',generation),captureArtGuidance('skill-v1')]) {
    assert.equal(g.id,'baseline'); assert.equal(withArtGuidance('exact original prompt',g),'exact original prompt');
  }
  assert.throws(()=>captureArtGuidance('unsupported',generation),/PXL_ART_GUIDANCE/);
});

test('Art guidance: task routing, stable digest and snapshots survive changed resource files', () => {
  const root=mkdtempSync(join(tmpdir(),'pxl-guidance-'));
  try {
    for(const name of ['core','sprite','animation','terrain'])writeFileSync(join(root,name+'.md'),name+' unique content');
    const first=captureArtGuidance('skill-v1',generation,'',root);
    assert.equal(first.topic,'sprite');assert.equal(first.hash,captureArtGuidance('skill-v1',generation,'',root).hash);
    const animation=captureArtGuidance('skill-v1',{...generation,animation:{frameId:'f',mode:'whole',frames:4,duration:100,loop:true,anchor:{x:16,y:32},referenceFile:'base.px.js'}},'terrain',root);
    assert.equal(animation.topic,'animation');assert.ok(!animation.text.includes('sprite unique content'));
    const terrain=captureArtGuidance('skill-v1',generation,'seamless terrain',root);assert.equal(terrain.topic,'terrain');
    writeFileSync(join(root,'sprite.md'),'new changed content');
    assert.notEqual(first.hash,captureArtGuidance('skill-v1',generation,'',root).hash);
    assert.ok(withArtGuidance('user constraints',first).includes('sprite unique content'));
    assert.ok(!JSON.stringify(guidanceInfo(first)).includes('unique content'));
    writeFileSync(join(root,'core.md'),'');assert.throws(()=>captureArtGuidance('skill-v1',generation,'',root),/rỗng/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Art guidance: real adapters consume the captured craft once; code repair does not change guidance', async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-guidance-adapters-'));
  const settings:ProviderSettings={codex:process.execPath,deepseek:fastHttpFixture(root),prefix:[resolve('studio/fake-cli.js'),'--state-dir',root],timeout:8000,artGuidance:'skill-v1'};
  const manager=new AiManager(new ProjectStore(root),()=>{},settings);
  try {
    const captured=manager.captureGuidance(generation,'test sprite');
    settings.artGuidance='baseline'; // A later server config change must not alter the supplied snapshot.
    for(const provider of ['codex','deepseek'] as const){
      const doc:ProjectDocument={schemaVersion:1,id:provider,name:'fixture',revision:1,entry:'art.px.js',files:{'art.px.js':"sprite('canvas',{w:32,h:32},px(1,1,'#70c989'))"},pixels:{},metadata:{}};
      const job=await manager.start(doc,provider,'FIXTURE_SOURCE_REPAIR',undefined,generation,undefined,{candidateIndex:0,artGuidance:captured});
      const done=await manager.waitFor(job.id);assert.equal(done.status,'ready',done.message);assert.equal(done.cliExecutions,2);
      assert.deepEqual(done.guidance,guidanceInfo(captured));assert.ok(!JSON.stringify(done.guidance).includes('text'));
    }
    const calls=readFileSync(join(root,'fixture-cli-calls.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
    assert.equal(calls.length,4);assert.ok(calls.every(c=>c.guidanceId==='skill-v1'&&c.guidanceTopic==='sprite'));
    assert.equal(new Set(calls.map(c=>c.guidanceDigest)).size,1,'same captured text across repair and both adapters');
  }finally{await manager.close();rmSync(root,{recursive:true,force:true});}
});

test('Art guidance: batch alternatives and explicit retry retain one snapshot after server setting changes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-guidance-batch-')),previous=process.env.PXL_ART_GUIDANCE;
  const app=await serveStudio(root,{port:0,providers:{codex:process.execPath,antigravity:process.execPath,prefix:[resolve('studio/fake-cli.js'),'--state-dir',root],timeout:8000}});
  const request=async(path:string,body?:unknown)=>{const response=await fetch(app.url+'api/pixel/'+path,{method:body?'POST':'GET',headers:{origin:app.url.slice(0,-1),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(response.ok,await response.clone().text());return response.json();};
  const settle=async(path:string)=>{for(let n=0;n<200;n++){const batch=await request(path);if(batch.status!=='running')return batch;await new Promise(r=>setTimeout(r,50));}throw Error('fixture batch timeout');};
  try{
    const doc=await request('projects',{name:'Guidance fixture',w:32,h:32}),base=`projects/${doc.id}`;
    process.env.PXL_ART_GUIDANCE='skill-v1';
    const first=await request(base+'/generation-batches',{revision:doc.revision,provider:'codex',prompt:'FIXTURE_SECOND_FAILS_RETRY',assetId:doc.assets[0].id,generationOptions:{}});
    assert.equal(first.guidance.id,'skill-v1');assert.ok(!JSON.stringify(first).includes('Core Pixel Art Principles'));
    process.env.PXL_ART_GUIDANCE='baseline';
    const path=base+'/generation-batches/'+first.id,partial=await settle(path);assert.equal(partial.status,'partial');
    await request(path+'/candidates/'+partial.candidates[1].id+'/retry',{revision:doc.revision});
    const ready=await settle(path);assert.equal(ready.status,'ready');assert.deepEqual(ready.guidance,first.guidance);
    const calls=readFileSync(join(root,'fixture-cli-calls.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
    assert.equal(calls.length,4);assert.ok(calls.every(c=>c.guidanceId==='skill-v1'));assert.equal(new Set(calls.map(c=>c.guidanceDigest)).size,1);
    assert.equal((await request(base)).revision,doc.revision,'creating/retrying never applies');
  }finally{if(previous===undefined)delete process.env.PXL_ART_GUIDANCE;else process.env.PXL_ART_GUIDANCE=previous;await app.close();rmSync(root,{recursive:true,force:true});}
});
