import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectStore, safePath } from '../src/node/studio/store.ts';
import { renderDocument } from '../src/node/studio/render.ts';
import { startRender, RenderPool } from '../src/node/studio/runner.ts';
import { AiManager } from '../src/node/studio/ai.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { Img } from '../src/core/image.ts';
import { packSheet, normalizeFrames } from '../src/core/render.ts';
import { loadSource } from '../src/node/load.ts';
import { encodeGif } from '../src/node/gif.ts';
import type { BuildSummary, Picture, PixelLayer } from '../src/studio/types.ts';
const temporary = () => mkdtempSync(join(tmpdir(), 'pxl-studio-test-'));
function data(p: Picture): number[] { const b = Buffer.from(p.rgba,'base64'); return Array.from(new Uint32Array(b.buffer, b.byteOffset, b.length/4)); }
const wait = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean, timeout=8000):Promise<void>{const start=Date.now();while(!fn()){if(Date.now()-start>timeout)throw Error('timed out');await wait(30)}}

test('Studio store: revisions, external edits, bounded history, restore and persistent pixel layers', () => {
  const root=temporary();try {
    const store=new ProjectStore(root), p=store.create('Dự án Việt','blank');
    const saved=store.save(p.id,p.revision,{files:{...p.files,'parts.px.js':'// preserved'}});
    assert.throws(()=>store.save(p.id,p.revision,{name:'stale'}),/thay đổi/);
    writeFileSync(join(store.dir(p.id),'art.px.js'),p.files[p.entry]+'\n// external');
    const external=store.load(p.id);assert.equal(external.revision,saved.revision+1);
    assert.throws(()=>store.save(p.id,saved.revision,{name:'stale'}),/thay đổi/);
    for(let i=0;i<24;i++)store.snapshot(external,`snapshot ${i}`);
    assert.equal(store.history(p.id).length,20);
    const layer:PixelLayer={enabled:true,layout:{w:32,h:32,durations:[]},frames:{'0':{'0':0xff00ffff}}};
    const withPixel=store.save(p.id,external.revision,{pixels:{canvas:layer}},'before pixel');
    assert.deepEqual(new ProjectStore(root).load(p.id).pixels.canvas,layer);
    const restored=store.restore(p.id,withPixel.revision,store.history(p.id)[0].id);assert.deepEqual(restored.pixels,{});
    assert.ok(readFileSync(join(store.dir(p.id),'parts.px.js'),'utf8').includes('preserved'));
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('Studio paths: traversal and external symlink sidecars are rejected', () => {
  const root=temporary(), outside=temporary();try {
    const store=new ProjectStore(root), p=store.create('safe');assert.throws(()=>safePath(root,'../escape'),/ngoài/);
    assert.throws(()=>store.save(p.id,p.revision,{files:{'../escape.js':'x'},entry:'../escape.js'}),/hợp lệ/);
    const dir=store.dir(p.id);rmSync(join(dir,'.pxl'),{recursive:true,force:true});
    symlinkSync(outside,join(dir,'.pxl'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>store.load(p.id),/symlink/);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
});
test('Studio pixels propagate through stamps; resizing/orphan conflicts block exports; no generated files persist', () => {
  const root=temporary();try {
    const store=new ProjectStore(root), p=store.create('composite','blank',{'art.px.js':"pal({r:'#ff0000'})\nsprite('tile',{w:2,h:2},rect(0,0,2,2,'r'))\nscene('map',{w:4,h:2},stamp('tile',2,0))\nsheet('atlas',['tile','map'])"});
    p.pixels.tile={enabled:true,layout:{w:2,h:2,durations:[]},frames:{'0':{'0':0x00ff00ff,'1':0}}};
    const result=renderDocument({document:p,mode:'frame',name:'map'}) as Picture;
    assert.equal(data(result)[2],0x00ff00ff);assert.equal(data(result)[3],0);
    const edited=renderDocument({document:p,mode:'frame',name:'tile'}) as Picture;assert.equal(data(edited)[0],0x00ff00ff);
    const trace=renderDocument({document:p,mode:'frame',name:'tile',trace:true}) as Picture;assert.ok(trace.trace!.length>0);assert.ok(trace.trace!.every(t=>t.rgba===''),'trace listing does not serialize all intermediate images');
    const step=renderDocument({document:p,mode:'frame',name:'tile',trace:true,traceStep:trace.trace!.length-1}) as Picture;assert.equal(step.trace!.filter(t=>t.rgba).length,1);
    p.files[p.entry]=p.files[p.entry].replace('w:2,h:2','w:3,h:2');
    assert.deepEqual((renderDocument({document:p,mode:'summary'}) as BuildSummary).conflicts,['tile']);
    assert.throws(()=>renderDocument({document:p,mode:'export',name:'map',format:'png'}),/xung đột/);
    assert.equal(readdirSync(store.dir(p.id)).includes('out'),false);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('Worker: infinite art is stopped; cancel rejects promptly without leaving a timer', async () => {
  const root=temporary();try {
    const p=new ProjectStore(root).create('loop','blank');p.files[p.entry]='while(true) {}';
    await assert.rejects(startRender({document:p,mode:'summary'},200).promise,/thời gian/);
    const task=startRender({document:p,mode:'summary'});task.cancel();await assert.rejects(task.promise,/hủy/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('Worker pool: queued cancellation and shutdown reject every owned task', async () => {
  const root=temporary(), pool=new RenderPool(1);try {
    const p=new ProjectStore(root).create('pool','blank');p.files[p.entry]='while(true){}';
    const running=pool.start({document:p,mode:'summary'},150), queued=pool.start({document:p,mode:'summary'});
    const queuedResult=assert.rejects(queued.promise,/hủy/);queued.cancel();await queuedResult;
    await assert.rejects(running.promise,/thời gian/);
    const a=pool.start({document:p,mode:'summary'}),b=pool.start({document:p,mode:'summary'});const all=Promise.all([assert.rejects(a.promise,/hủy/),assert.rejects(b.promise,/hủy/)]);pool.close();await all;
  }finally{pool.close();rmSync(root,{recursive:true,force:true})}
});
test('Export: extrusion preserves UV pixels, MaxRects has no overlaps, crop anchors and one-shot survive', () => {
  const a=new Img(3,2);a.fill(0xff0000ff);a.set(0,0,0x00ff00ff);
  const b=new Img(2,4);b.fill(0x0000ffff);
  const packed=packSheet([{name:'a',img:a},{name:'b',img:b}],undefined,1,{pack:'maxrects',extrude:1,maxSize:64});
  for(const f of packed.frames)for(let y=0;y<f.img.h;y++)for(let x=0;x<f.img.w;x++)assert.equal(packed.sheet.get(f.x+x,f.y+y),f.img.get(x,y));
  const f=packed.frames[0];assert.equal(packed.sheet.get(f.x-1,f.y-1),a.get(0,0));
  for(let i=0;i<packed.frames.length;i++)for(let j=i+1;j<packed.frames.length;j++){const a=packed.frames[i],b=packed.frames[j];assert.ok(a.x+a.img.w+1<=b.x-1||b.x+b.img.w+1<=a.x-1||a.y+a.img.h+1<=b.y-1||b.y+b.img.h+1<=a.y-1)}
  assert.throws(()=>packSheet([{name:'large',img:new Img(65,1)}],undefined,0,{maxSize:64}),/exceeds/);
  const p=loadSource("anim('walk',{w:8,h:4,crop:true,loop:false},frame(px(1,1,'7')),frame(px(6,2,'7')))");
  const fr=normalizeFrames(p.frames('walk'));assert.equal(fr[0].img.w,8);assert.equal(fr[1].img.get(6,2),0xfff1e8ff);assert.equal(fr[0].img.get(1,1),0xfff1e8ff);
  assert.ok(!encodeGif(fr,{loop:false}).includes(Buffer.from('NETSCAPE2.0')));
  assert.throws(()=>loadSource("anim('huge',{w:1,h:1,frames:601},px(0,0,'7'))").frames('huge'),/limit/);
});
test('AI adapters: CLI and HTTP, explicit apply, stale rejection, failure and cancel', async () => {
  const root=temporary();const store=new ProjectStore(root);const events:unknown[]=[];
  const manager=new AiManager(store,e=>events.push(e),{codex:process.execPath,deepseek:fastHttpFixture(root),prefix:[resolve('studio/fake-cli.js')],timeout:5000});
  try {
    for(const provider of ['codex','deepseek'] as const){const p=store.create(provider,'blank');const j=await manager.start(p,provider,'draw');await until(()=>!['running','validating'].includes(j.status));assert.equal(j.status,'ready',j.message);assert.equal(store.load(p.id).revision,p.revision);const saved=manager.apply(j.id,p.revision);assert.equal(saved.revision,p.revision+1);assert.equal(store.history(p.id)[0].label,`Trước khi áp dụng AI (${provider})`)}
    const p=store.create('stale','blank'), j=await manager.start(p,'codex','draw');await until(()=>j.status==='ready');store.save(p.id,p.revision,{name:'new'});assert.throws(()=>manager.apply(j.id,p.revision),/đổi/);
    const resizing=store.create('resize','blank');resizing.pixels.canvas={enabled:true,layout:{w:32,h:32,durations:[]},frames:{'0':{'0':0xff0000ff}}};const original=store.save(resizing.id,resizing.revision,{pixels:resizing.pixels});
    const resized=await manager.start(original,'codex','FIXTURE_RESIZE');await until(()=>!['running','validating'].includes(resized.status));assert.equal(resized.status,'ready',resized.message);assert.deepEqual(resized.build!.conflicts,['canvas']);
    const applied=manager.apply(resized.id,original.revision);assert.equal(applied.pixels.canvas.layout.w,32);assert.deepEqual((renderDocument({document:applied,mode:'summary'}) as BuildSummary).conflicts,['canvas']);
    const hanging=store.create('cancel','blank'), h=await manager.start(hanging,'deepseek','FIXTURE_HANG');await wait(350);await manager.cancel(h.id);assert.equal(h.status,'canceled');assert.equal(store.load(hanging.id).revision,hanging.revision);
    const failing=store.create('error','blank'), e=await manager.start(failing,'codex','FIXTURE_ERROR');await until(()=>e.status==='failed');assert.match(e.message,/quota denied/);
  } finally {await manager.close();rmSync(root,{recursive:true,force:true})}
});
test('Studio export: ZIP metadata/timing are preserved; unsafe names and outside includes cannot write', () => {
  const root=temporary(),outside=temporary();try {
    const p=new ProjectStore(root).create('metadata','animation');p.metadata.bounce={pivot:{x:.5,y:1},hitbox:{x:1,y:2,w:4,h:8},events:[{frame:2,name:'jump'}]};
    const result=renderDocument({document:p,mode:'export',format:'atlas'}) as {data:Uint8Array};
    const zip=Buffer.from(result.data), files=new Map<string,Buffer>();let offset=0;
    while(zip.readUInt32LE(offset)===0x04034b50){const size=zip.readUInt32LE(offset+18),nameSize=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28),start=offset+30+nameSize+extra;files.set(zip.toString('utf8',offset+30,offset+30+nameSize),zip.subarray(start,start+size));offset=start+size}
    const j=JSON.parse(files.get('atlas.json')!.toString());assert.equal(j.meta.pxl.assets.bounce.pivot.y,1);assert.equal(j.meta.pxl.assets.bounce.events[0].name,'jump');assert.equal(j.meta.pxl.animations[0].frames.length,8);
    p.metadata.bounce.events=[{frame:50,name:'bad'}];assert.throws(()=>renderDocument({document:p,mode:'export',format:'atlas'}),/frame không tồn tại/);
    p.metadata={};p.files[p.entry]="sprite('../unsafe',{w:1,h:1},px(0,0,'7'))";assert.throws(()=>renderDocument({document:p,mode:'export',format:'zip'}),/an toàn/);
    const file=join(outside,'private.px.js');writeFileSync(file,"sprite('private','7')");p.files[p.entry]=`include(${JSON.stringify(file)})`;assert.throws(()=>renderDocument({document:p,mode:'summary'}),/inside/);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
});
test('Studio HTTP: origin, revisions, lazy frame, exports ownership, responsiveness and reopen', async () => {
  const root=temporary(), app=await serveStudio(root,{port:0,renderTimeout:5000,uiDir:resolve('dist/studio')});
  const origin=app.url.slice(0,-1);const request=async(path:string,method='GET',value?:unknown)=>fetch(app.url+'api/studio'+path,{method,headers:method==='GET'?{}:{origin,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
  try {
    assert.equal((await fetch(app.url+'api/studio/projects',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
    const p=await(await request('/projects','POST',{name:'HTTP thử','template':'blank'})).json();
    const job=await(await request(`/projects/${p.id}/build`,'POST',{revision:p.revision})).json();let status:any;
    await until(()=>!!status,1000).catch(()=>{});
    for(let i=0;i<40;i++){status=await(await request(`/builds/${job.id}`)).json();if(status.status!=='running')break;await wait(50)}assert.equal(status.status,'ready',status.error);
    const frame=await(await request(`/projects/${p.id}/frame?revision=1&name=canvas&frame=0`)).json();assert.equal(frame.w,32);assert.equal(frame.trace,undefined);
    const out=join(app.store.dir(p.id),'exports');mkdirSync(out);writeFileSync(join(out,'mine.png'),'user image');
    const exported=await request(`/projects/${p.id}/export`,'POST',{revision:1,name:'canvas',format:'png'});assert.equal(exported.status,200);assert.equal((await exported.arrayBuffer()).byteLength>30,true);
    await request(`/projects/${p.id}/export`,'POST',{revision:1,name:'canvas',format:'zip'});assert.equal(readFileSync(join(out,'mine.png'),'utf8'),'user image');
    const modified=await(await request(`/projects/${p.id}`,'PUT',{revision:1,changes:{files:{'art.px.js':'while(true){}'}}})).json();
    await request(`/projects/${p.id}/build`,'POST',{revision:modified.revision});const start=Date.now();assert.equal((await request('/projects')).status,200);assert.ok(Date.now()-start<500,'API responds while art worker loops');
    assert.equal(new ProjectStore(root).load(p.id).revision,modified.revision);
    assert.equal((await request(`/projects/${p.id}/export`,'POST',{revision:1,name:'canvas',format:'png'})).status,409);
  }finally{await app.close();rmSync(root,{recursive:true,force:true})}
});
