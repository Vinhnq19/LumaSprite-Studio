import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {serveStudio} from '../src/node/studio/server.ts';
import {wireParse,wireStringify} from '../src/studio/pixel/model.ts';
import {composePose,exampleCharacterPose,inspectCharacterPose,movePosePart,poseGuide,validateCharacterPose,type PoseRasters} from '../src/studio/pixel/character-pose.ts';

test('PoseSpec accepts optional fields, alternate proportions, and native coordinates',()=>{
  for(const n of [32,64,128]) for(const prop of [true,false]){
    const spec=exampleCharacterPose(n,n,prop);
    assert.deepEqual(validateCharacterPose(spec,n,n),spec);
    assert.equal(Object.keys(spec.landmarks).length,n===32?7:13);
    assert.equal(Boolean(spec.grip),prop);
    assert.equal(poseGuide(spec,n,n).get(spec.support.x,spec.support.y),0x6ff2b7ff);
    assert.throws(()=>validateCharacterPose({...spec,version:2},n,n),/version 1/);
    assert.throws(()=>validateCharacterPose({...spec,order:[...spec.order,'head']},n,n));
    assert.throws(()=>validateCharacterPose({...spec,support:{...spec.support,x:n}},n,n));
  }
  const spec=exampleCharacterPose(32,32);
  const specWithShoulder={...spec,landmarks:{...spec.landmarks,nearShoulder:{x:12,y:13}}};
  assert.throws(()=>validateCharacterPose(specWithShoulder,32,32),/tối đa 7/);
  const occluded={...spec.landmarks,farWrist:{...spec.landmarks.farWrist,occludedBy:'torso'}};
  assert.equal(validateCharacterPose({...spec,landmarks:occluded},32,32).landmarks.farWrist?.occludedBy,'torso');
  occluded.farWrist.occludedBy='far_arm';
  assert.throws(()=>validateCharacterPose({...spec,landmarks:occluded},32,32),/Lớp che/);
});

test('geometry reports detached support, missed grip and closed gap without changing the raster',()=>{
  const size=32, spec=exampleCharacterPose(size,size);
  const parts:PoseRasters={};
  for(const part of spec.order)parts[part]=new Uint32Array(size*size);
  const sole=spec.support.y*size+spec.support.x;
  parts.near_leg![sole]=0xffffffff;
  const [gap]=spec.gaps!;
  for(let y=gap.y;y<gap.y+gap.h;y++) parts.torso!.fill(0xffffffff,y*size+gap.x,y*size+gap.x+gap.w);
  const pixels=composePose(spec,parts,size*size), before=pixels.slice();
  const findings=inspectCharacterPose(spec,parts,pixels,size,size);
  assert.ok(findings.some(f=>f.type==='ground-contact'&&f.evidence.includes('nối đế')));
  assert.ok(findings.some(f=>f.type==='grip'&&f.confidence==='high'));
  assert.ok(findings.some(f=>f.type==='negative-space'&&f.confidence==='medium'));
  assert.ok(findings.every(f=>f.stage==='shape'&&f.region.w>0&&f.region.h>0&&f.action));
  assert.deepEqual(pixels,before);
  assert.throws(()=>movePosePart(parts.near_leg!,size,size,0,size-1),/cắt hình/);
});

test('structured Studio preview rasterizes private parts, reopens history and locks approved alpha',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-pose-'));
  const app=await serveStudio(root,{port:0,uiDir:resolve('dist/studio'),providers:{codex:process.execPath,prefix:[resolve('studio/fake-cli.js')]}});
  const origin=app.url.slice(0,-1);
  const req=(path:string,body?:unknown)=>fetch(origin+'/api/pixel/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json'},body:body===undefined?undefined:wireStringify(body)});
  const read=async(r:Response)=>{const text=await r.text();assert.ok(r.ok,text);return wireParse(text);};
  try{
    const size=32, d=await read(await req('projects',{name:'Structured shape',w:size,h:size,background:0}));
    const p='projects/'+d.id, revision=d.revision, figure=p+'/figure-review';
    const spec=exampleCharacterPose(size,size);
    const args={revision,assetId:d.assets[0].id,prompt:'Character',provider:'codex',generationOptions:{paletteMode:'auto16'}};
    const generate=async(input:object)=>{
      let j=await read(await req(p+'/ai',{...args,...input}));
      const url=p+'/ai/'+j.id;
      const deadline=Date.now()+30000;
      while(['preparing','queued','running','validating'].includes(j.status)&&Date.now()<deadline){await wait(40);j=await read(await req(url));}
      assert.equal(j.status,'ready',j.message);
      assert.equal(j.cliExecutions,1);
      return url+'/preview';
    };
    const preview=async(input:object)=>read(await req(await generate(input),{revision}));
    assert.equal((await req(p+'/ai',{...args,poseSpec:spec})).status,400);
    assert.equal((await req(p+'/ai',{...args,figureStage:'shape',poseSpec:{...spec,version:2}})).status,400);
    const shape=await preview({figureStage:'shape',poseSpec:spec});
    assert.deepEqual(shape.plan.poseSpec,spec);
    assert.deepEqual(shape.errors,[]);
    assert.deepEqual(shape.pixels,composePose(spec,shape.shapeParts,size*size));
    const mismatch=await preview({figureStage:'shape',poseSpec:spec,prompt:'FIXTURE_POSE_MISMATCH'});
    assert.ok(mismatch.errors.some((e:string)=>e.includes('Raster proposal')));
    assert.equal((await req(p+'/ai',{...args,figureStage:'finish',parentId:mismatch.id})).status,422);
    const late=await generate({figureStage:'finish',parentId:shape.id});
    const move={part:'prop',dx:3,dy:0};
    const revised=await read(await req(figure+'/'+shape.id+'/revise',{revision,move}));
    assert.equal(revised.parent,shape.id);
    assert.notDeepEqual(revised.pixels,shape.pixels);
    assert.deepEqual(revised.shapeParts.near_arm,shape.shapeParts.near_arm);
    assert.deepEqual(revised.shapeParts.prop,movePosePart(shape.shapeParts.prop,size,size,3,0));
    assert.ok(revised.shapeFindings.some((f:{type:string})=>f.type==='grip'));
    assert.deepEqual((await read(await req(figure+'/'+shape.id))).pixels,shape.pixels);
    assert.equal((await req(late,{revision})).status,409);
    assert.equal((await req(figure+'/'+shape.id+'/revise',{revision:revision-1,move})).status,409);
    const finish=await preview({figureStage:'finish',parentId:revised.id});
    assert.deepEqual(finish.approved,revised.pixels);
    assert.deepEqual(finish.pixels.map((p:number)=>p&255),revised.pixels.map((p:number)=>p&255));
    const baseline=await preview({figureStage:'shape'});
    assert.equal(baseline.plan.poseSpec,undefined);
    assert.equal(baseline.shapeParts,undefined);
    assert.deepEqual((await read(await req(figure+'/'+baseline.id))).pixels,baseline.pixels);
  }finally{
    await app.close();
    rmSync(root,{recursive:true,force:true});
  }
});
