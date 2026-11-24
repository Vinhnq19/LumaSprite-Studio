import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { serveStudio } from '../src/node/studio/server.ts';
import { wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { protectFigure, figureDiagnostics } from '../src/studio/pixel/figure-review.ts';
import { decodeTestPng } from './fixtures/image-assertions.ts';
import { Img } from '../src/core/image.ts';
import { exampleCharacterPose } from '../src/studio/pixel/character-pose.ts';

test('mask restores exact source RGBA and alpha, isolated glints remain untouched',()=>{
  const src=Uint32Array.of(0,0xffffffff,0x11111180,0x111111ff);
  const changed=protectFigure(Uint32Array.of(0xffff00ff,0xaabbccff,0xaabbccff,0),src,[0,2,3]);
  assert.deepEqual([...changed],[0,0xffffffff,0xaabbcc80,0x111111ff]);
  const before=src.slice();
  assert.ok(figureDiagnostics(new Img(2,2,src)).some(w=>w.index===1));
  assert.deepEqual(src,before);
});

test('diagnostics locate an edge spike, a close color pair and translucent ink without repainting',()=>{
  const pixels=Uint32Array.of(0,0,0,0, 0,0x777777ff,0,0, 0,0x757575ff,0x777777ff,0x77777780);
  const before=pixels.slice();
  const warnings=figureDiagnostics(new Img(4,3,pixels));
  assert.ok(warnings.some(w=>w.index===5 && w.reason.includes('đường bao')));
  assert.ok(warnings.some(w=>w.index===10 && w.reason.includes('RGB')));
  assert.ok(warnings.some(w=>w.index===11 && w.reason.includes('bán trong suốt')));
  assert.deepEqual(pixels,before);
});

test('PoseSpec pilot source failures preserve location, do not retry and leave the existing revision intact', async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-pose-pilot-regression-'));
  const app=await serveStudio(root,{port:0,uiDir:resolve('dist/studio'),providers:{codex:process.execPath,prefix:[resolve('studio/fake-cli.js')]}});
  const origin=app.url.slice(0,-1);
  const req=(path:string,body?:unknown)=>fetch(origin+'/api/pixel/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json'},body:body===undefined?undefined:wireStringify(body)});
  const read=async(r:Response)=>{const text=await r.text();assert.ok(r.ok,text);return wireParse(text);};
  try{
    for(const [id,size,prop,message] of [
      ['64B-Y',64,false,'art.px.js:6:76: k is not defined'],
      ['128A-X',128,true,'art.px.js:8:76: i is not defined'],
    ] as const){
      const doc=await read(await req('projects',{name:id,w:size,h:size,background:0xffffffff}));
      const path='projects/'+doc.id;
      let job=await read(await req(path+'/ai',{
        revision:doc.revision,assetId:doc.assets[0].id,provider:'codex',
        figureStage:'shape',prompt:'FIXTURE_POSE_PILOT_'+id,
        poseSpec:exampleCharacterPose(size,size,prop),
        generationOptions:{paletteMode:'auto16',reference:false},
      }));
      const url=path+'/ai/'+job.id,deadline=Date.now()+30000;
      while(['preparing','queued','running','validating'].includes(job.status)&&Date.now()<deadline){await wait(40);job=await read(await req(url));}
      assert.equal(job.status,'failed',job.message);
      assert.equal(job.attempt,1);
      assert.equal(job.cliExecutions,1);
      assert.equal(job.message,message);
      const [, line, column, symbol] = message.match(/:(\d+):(\d+): (\w+) is not defined$/)!;
      assert.equal(job.diagnostic.code,'PXL_UNDECLARED_IDENTIFIER');
      assert.equal(job.diagnostic.identifier,symbol);
      assert.deepEqual(job.diagnostic.location,{file:'art.px.js',line:Number(line),column:Number(column)});
      assert.equal(job.diagnostic.evidence,'.pxl/ai-diagnostics/'+job.id+'.json');
      const evidence=JSON.parse(readFileSync(join(root,doc.id,job.diagnostic.evidence),'utf8'));
      assert.equal(JSON.parse(evidence.output).files[0].content,
        readFileSync(resolve('test/fixtures/pose-pilot',id+'.px.txt'),'utf8'));
      assert.equal(job.build,undefined);
      assert.equal(job.proposal,undefined);
      const refused=await req(url+'/preview',{revision:doc.revision});
      assert.equal(refused.status,400);
      assert.equal((await refused.json()).diagnostic.code,'PXL_UNDECLARED_IDENTIFIER');
      assert.deepEqual(await read(await req(path+'/figure-review')),[]);
      assert.deepEqual(await read(await req(path)),doc);
    }
    const doc=await read(await req('projects',{name:'Legacy PXL preflight',w:32,h:32}));
    const path='projects/'+doc.id;
    let legacy=await read(await req(path+'/ai',{
      revision:doc.revision,assetId:doc.assets[0].id,provider:'codex',prompt:'FIXTURE_UNDECLARED_PXL',
      generationOptions:{paletteMode:'auto16',reference:false},
    }));
    const deadline=Date.now()+30000;
    while(['running','validating'].includes(legacy.status)&&Date.now()<deadline){
      await wait(40);legacy=await read(await req(path+'/ai/'+legacy.id));
    }
    assert.equal(legacy.status,'failed');
    assert.equal(legacy.cliExecutions,1);
    assert.equal(legacy.diagnostic.code,'PXL_UNDECLARED_IDENTIFIER');
    for(const [body,code,status] of [
      [{revision:doc.revision-1,format:'png'},'STALE_REVISION',409],
      [{revision:doc.revision,format:'invalid'},'EXPORT_FAILED',400],
      [{revision:doc.revision,format:'png',assetId:'absent'},'ASSET_NOT_FOUND',400],
    ] as const){
      const response=await req(path+'/export',body);
      assert.equal(response.status,status);
      const error=await response.json();
      assert.equal(typeof error.error,'string');
      assert.equal(error.diagnostic.code,code);
    }
    assert.deepEqual(await read(await req(path)),doc);
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('shape review through HTTP: approval, edited snapshot, masked retouch budget, rollback and PNG',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-figure-'));
  const app=await serveStudio(root,{port:0,uiDir:resolve('dist/studio'),providers:{codex:process.execPath,prefix:[resolve('studio/fake-cli.js')]}});
  const origin=app.url.slice(0,-1);
  const req=(path:string,body?:unknown)=>fetch(origin+'/api/pixel/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json'},body:body===undefined?undefined:wireStringify(body)});
  const read=async(r:Response)=>{const txt=await r.text();assert.ok(r.ok,txt);return wireParse(txt);};
  try{
    const d=await read(await req('projects',{name:'P0',w:18,h:24,background:0}));
    const p='projects/'+d.id, revision=d.revision;
    const args={revision,assetId:d.assets[0].id,prompt:'Knight',provider:'codex',generationOptions:{paletteMode:'auto16'}};
    async function ready(figureStage:string,extra={}){
      let j=await read(await req(p+'/ai',{...args,figureStage,...extra}));
      const url=p+'/ai/'+j.id,deadline=Date.now()+30000;
      while(['running','validating'].includes(j.status)&&Date.now()<deadline){await wait(50);j=await read(await req(url));}
      assert.equal(j.status,'ready',j.message);assert.equal(j.attempt,1);
      return url;
    }
    const stage=async(figureStage:string,extra={})=>read(await req(await ready(figureStage,extra)+'/preview',{revision}));
    const pending=await read(await req(p+'/ai',{...args,prompt:'FIXTURE_HANG',figureStage:'shape'}));
    const cancelled=await read(await req(p+'/ai/'+pending.id+'/cancel',{}));
    assert.match(cancelled.status,/cancel/);
    assert.deepEqual(await read(await req(p+'/figure-review')),[]);
    const flat=await stage('shape');
    assert.equal((await req(p+'/figure-review/'+flat.id+'/select',{revision})).status,422);
    const outdated=await ready('finish',{parentId:flat.id});
    const erased=flat.pixels.findIndex((pixel:number)=>pixel&255);
    assert.ok(erased>=0);
    const revisionPath=p+'/figure-review/'+flat.id+'/revise';
    const savedSketch=await read(await req(revisionPath,{revision,edits:[[erased,0]],note:'Túi dụng cụ bên hông'}));
    assert.equal(savedSketch.parent,flat.id);
    assert.equal(savedSketch.pixels[erased],0);
    assert.match(savedSketch.plan.brief,/Túi dụng cụ/);
    assert.equal((await req(outdated+'/preview',{revision})).status,409);
    assert.equal((await req(revisionPath,{revision:revision-1,edits:[[erased,0]]})).status,409);
    const finish=await stage('finish',{parentId:flat.id,edits:[[erased,0]],finishNotes:'Matte cloth and limited metal glints.'});
    assert.equal((await req(outdated+'/preview',{revision})).status,409);
    assert.equal(finish.pixels[erased],0);assert.equal(finish.approved[erased],0);
    assert.equal(finish.finishNotes,'Matte cloth and limited metal glints.');
    assert.ok(finish.restored > 0);
    assert.ok(finish.warnings.some((warning: {reason:string})=>warning.reason.includes('khôi phục')));
    const repair=await stage('repair',{parentId:finish.id,mask:[1]});
    assert.deepEqual(repair.pixels.slice(2),finish.pixels.slice(2));
    assert.equal((await req(p+'/ai',{...args,figureStage:'repair',parentId:finish.id,mask:[1]})).status,409);
    // An edited transparent pixel carrying RGB cannot round-trip through the document compositor.
    const incompatible=await stage('finish',{parentId:flat.id,edits:[[0,0xabcdef00]]});
    assert.equal((await req(p+'/figure-review/'+incompatible.id+'/select',{revision})).status,422);
    const alt=await read(await req(p+'/figure-review/'+repair.id+'/select',{revision}));
    const chosen=await read(await req(p+'/figure-review/'+finish.id+'/select',{revision}));
    const saved=await read(await req(p+'/apply-proposal',{revision,proposalId:chosen.proposalId}));
    const img=await req(p+'/export',{revision:saved.revision,assetId:saved.assets.at(-1).id,format:'png'});
    assert.deepEqual(decodeTestPng(Buffer.from(await img.arrayBuffer())).data,finish.pixels);
    assert.equal((await req(p+'/apply-proposal',{revision:saved.revision,proposalId:alt.proposalId})).status,409);
    assert.deepEqual((await read(await req(p+'/figure-review/'+flat.id))).pixels,flat.pixels);
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
