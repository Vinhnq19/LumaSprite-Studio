import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { setTimeout as wait } from 'node:timers/promises';
import { Img } from '../src/core/image.ts';
import { loadSource } from '../src/node/load.ts';
import { newAsset,newDocument,celFor,composite,duplicateFrame,wireParse,wireStringify } from '../src/studio/pixel/model.ts';
import { normalizePixels,choosePalette,oklab,diagnostics,imageSource,processAsset } from '../src/studio/pixel/processing.ts';
import { defaultGenerationOptions } from '../src/studio/generation.ts';
import { generationBrief,buildAiPrompt } from '../src/node/studio/ai-prompt.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { renderDocument,type ExportResult } from '../src/node/studio/render.ts';
import type { GenerationContext } from '../src/studio/types.ts';
import { VariantStore } from '../src/node/studio/variant-store.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';

function unzip(data:Uint8Array):Record<string,Buffer>{const b=Buffer.from(data),files:Record<string,Buffer>={};let o=0;while(o+30<b.length&&b.readUInt32LE(o)===0x04034b50){const n=b.readUInt32LE(o+18),nl=b.readUInt16LE(o+26),el=b.readUInt16LE(o+28),start=o+30+nl+el;files[b.toString('utf8',o+30,o+30+nl)]=b.subarray(start,start+n);o=start+n;}return files;}
function png(data:Uint8Array):{w:number;h:number;data:Uint32Array}{const b=Buffer.from(data);let w=0,h=0,mode=0,palette=Buffer.alloc(0),alpha=Buffer.alloc(0);const chunks:Buffer[]=[];for(let o=8;o+12<=b.length;){const n=b.readUInt32BE(o),t=b.toString('ascii',o+4,o+8),d=b.subarray(o+8,o+8+n);if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);mode=d[9];}if(t==='PLTE')palette=Buffer.from(d);if(t==='tRNS')alpha=Buffer.from(d);if(t==='IDAT')chunks.push(d);o+=n+12;}const raw=inflateSync(Buffer.concat(chunks)),out=new Uint32Array(w*h),stride=w*(mode===3?1:4)+1;for(let y=0;y<h;y++){assert.equal(raw[y*stride],0);for(let x=0;x<w;x++){const j=y*stride+1+x*(mode===3?1:4),i=raw[j];out[y*w+x]=mode===3?((palette[i*3]<<24)|(palette[i*3+1]<<16)|(palette[i*3+2]<<8)|(alpha[i]??255))>>>0:raw.readUInt32BE(j);}}return{w,h,data:out};}

const context=(w=18,h=18):GenerationContext=>({options:{...defaultGenerationOptions},assetId:'base',w,h,palette:[0,0x70c989ff,0xffffffff]});
test('Pixel processing: OKLab endpoints, deterministic palette mapping, alpha boundary and transparent/duplicate colors',()=>{
  assert.ok(Math.abs(oklab(0xffffffff)[0]-1)<1e-6);assert.deepEqual(oklab(0),[0,0,0]);
  const data=Uint32Array.from([0xffffff00,0xffffff7f,0xffffff80,0x70c989ff,0xffffffff]);
  assert.deepEqual([...normalizePixels(data,[0,0xffffff80,0xffffffff,0xffffffff])],[0,0,0xffffffff,0xffffffff,0xffffffff]);
  assert.deepEqual([...normalizePixels(data,[0x70c989ff,0xffffffff])],[0,0,0xffffffff,0x70c989ff,0xffffffff]);
  assert.throws(()=>normalizePixels(data,[0,0x12345680]),/không có màu đục/);assert.throws(()=>normalizePixels(data,[0xffffffff],0),/1–255/);
  assert.deepEqual([...normalizePixels(data,[0xffffffff],255)],[0,0,0,0xffffffff,0xffffffff]);
});
test('Pixel processing: median-cut uses a single deterministic observed palette across all frames',()=>{
  const a=new Img(20,1),b=new Img(20,1);for(let i=0;i<20;i++){a.data[i]=((i*11<<24)|0x3344ff)>>>0;b.data[i]=((i*9<<16)|0x554400ff)>>>0;}
  const palette=choosePalette([a,b],16),actual=new Set([...a.data,...b.data]);assert.equal(palette.length,16);assert.ok(palette.every(p=>actual.has(p)));assert.deepEqual(palette,choosePalette([a,b],16));
  for(const image of [a,b])assert.ok([...normalizePixels(image.data,palette)].every(p=>palette.includes(p)));
});
test('Pixel processing: region composition, metadata, exact baked source and diagnostic overlays preserve pixels',()=>{
  const base=newAsset('Base',18,18),f=base.frames[0].id;celFor(base,base.layers[0].id,f,true)!.data![1]=0x70c989ff;
  const a=newAsset('Wave',18,18),d=celFor(a,a.layers[0].id,a.frames[0].id,true)!.data!;d[0]=0x12345680;d[1]=0xffffffff;duplicateFrame(a,a.frames[0].id,'copy');a.frames[0].duration=100;a.frames[1].duration=100;
  a.tags=[{id:crypto.randomUUID(),name:'Wave',from:a.frames[0].id,to:a.frames[1].id,direction:'forward',loop:false}];
  const mask=Array(324).fill(0);mask[0]=1;const g=context();g.animation={frameId:f,mode:'region',frames:2,duration:100,loop:false,anchor:{x:9,y:18},referenceFile:'_pxl_reference.px.js'};
  const {asset,stats}=processAsset(a,g,'normalize',128,{asset:base,frameId:f,mask});
  for(const frame of asset.frames){const img=composite(asset,frame.id);assert.equal(img.data[1],0x70c989ff);assert.ok(g.palette.includes(img.data[0]));}
  assert.equal(stats.outsideChanges,0);assert.deepEqual(asset.metadata.pivot,{x:.5,y:1});
  const built=loadSource(asset.source!.files[asset.source!.entry]);assert.deepEqual(built.frames('Wave').map(f=>[...f.img.data]),asset.frames.map(f=>[...composite(asset,f.id).data]));
  assert.equal(built.timeline('Wave')!.once,true);const isolated=diagnostics(Uint32Array.from([0xffffffff,0,0,0]),2);assert.deepEqual(isolated.singletons,[0]);
  const checker=Uint32Array.from([0xffffffff,0x70c989ff,0x70c989ff,0xffffffff]);assert.deepEqual(diagnostics(checker,2).checkerboards,[0]);assert.deepEqual([...checker],[0xffffffff,0x70c989ff,0x70c989ff,0xffffffff]);
  const single=loadSource(imageSource('Single',2,2,[checker],[170],false));assert.equal(single.frames('Single')[0].ms,170);assert.equal(single.timeline('Single')!.once,true);
  const normal=processAsset(a,context(),'normalize').asset,document=newDocument('No reference');document.assets=[normal];assert.equal(Buffer.from(exportPixel({document,format:'gif'}).data).includes(Buffer.from('NETSCAPE2.0')),false);
});
test('Animation prompt: exact pixel seed is omitted while immutable base/frames/timing remain explicit',()=>{
  const g=context();g.animation={frameId:'f',mode:'region',frames:4,duration:100,loop:true,anchor:{x:9,y:18},referenceFile:'_pxl_reference.px.js'};
  const doc={schemaVersion:1 as const,id:'p',revision:1,name:'P',entry:'art.px.js',files:{'art.px.js':'','_pxl_reference.px.js':'SECRET_PIXEL_ARRAY'},pixels:{},metadata:{}};
  const p=buildAiPrompt(doc,'blink','reference','',g);assert.ok(!p.includes('SECRET_PIXEL_ARRAY'));assert.match(p,/Return exactly 4 frames, each 100 ms/);assert.match(generationBrief(g),/restores all pixels outside/);
});

test('Variant storage: immutable compressed data loads only requested frames and cleans owned temporary artifacts',()=>{
  const repo=new VariantStore(),root=repo.root,a=newAsset('Cache',18,18);celFor(a,a.layers[0].id,a.frames[0].id,true)!.data![0]=0x70c989ff;duplicateFrame(a,a.frames[0].id,'copy');
  try{const info=repo.put([a],{kind:'raw',label:'Original',canApply:true});assert.equal((info.assets[0] as any).cels,undefined);repo.mask(info.id,Array(324).fill(1));assert.equal(repo.mask(info.id)!.length,324);assert.equal(repo.frame(info.id,a.id,a.frames[1].id).data[0],0x70c989ff);assert.equal(repo.assets(info.id)[0].cels[a.layers[0].cels[a.frames[0].id]].data![0],0x70c989ff);repo.remove(info.id);assert.throws(()=>repo.info(info.id));}finally{repo.close();assert.equal(existsSync(root),false);}
});

test('Processing HTTP: local variants, Codex animation, protected apply/export/reopen and stale rejection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-processing-test-'));const app=await serveStudio(root,{port:0,uiDir:resolve('dist/studio'),providers:{codex:process.execPath,antigravity:process.execPath,prefix:[resolve('studio/fake-cli.js')],timeout:8000}});const origin=app.url.slice(0,-1);
  const request=(path:string,method='GET',body?:unknown)=>fetch(app.url+'api/pixel/'+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:wireStringify(body)});
  const data=async(response:Response)=>{const text=await response.text();assert.ok(response.ok,text);return wireParse(text);};
  try{
    const initial=newDocument('Processing',18,18),a=initial.assets[0];celFor(a,a.layers[0].id,a.frames[0].id,true)!.data![0]=0x70c989ff;
    let doc=await data(await request('projects','POST',{name:initial.name,document:initial}));const path=`projects/${doc.id}`;
    const animation={frameId:a.frames[0].id,mode:'region',frames:4,duration:100,loop:false,anchor:{x:9,y:18},mask:Array(324).fill(0)};animation.mask[9*18+9]=1;
    async function start(provider:string,prompt='blink',anim:any=animation){const job=await data(await request(path+'/ai','POST',{revision:doc.revision,assetId:a.id,provider,prompt,generationOptions:{...defaultGenerationOptions,animation:anim}}));let current=job;for(let i=0;i<300&&['running','validating'].includes(current.status);i++){await wait(30);current=await data(await request(`${path}/ai/${job.id}`));}assert.equal(current.status,'ready',current.message);return current;}
    async function frame(p:any,v:any,index=0){const asset=v.assets[0];return data(await request(`${path}/proposals/${p.proposalId}/variants/${v.id}/frame?revision=${doc.revision}&asset=${asset.id}&frame=${asset.frames[index].id}`));}
    for(const provider of ['codex']){
      const job=await start(provider);assert.equal(job.attempt,1);assert.equal(job.generation.options.animation,undefined);
      const p=await data(await request(`${path}/ai/${job.id}/preview`,'POST',{revision:doc.revision,variants:true}));assert.equal(p.variants.length,2);assert.equal(p.variants[0].assets[0].cels,undefined);
      const raw=p.variants[0],protectedVariant=p.variants[1];assert.equal(raw.canApply,false);assert.equal((await frame(p,raw)).data[0],0x123456ff);
      assert.equal((await frame(p,protectedVariant)).data[0],0x70c989ff);
      assert.equal((await request(path+'/apply-proposal','POST',{revision:doc.revision,proposalId:p.proposalId,variantId:raw.id})).status,422);
      const local=await data(await request(`${path}/proposals/${p.proposalId}/normalize`,'POST',{revision:doc.revision,alphaThreshold:128}));let localJob=local;
      for(let i=0;i<300&&localJob.status==='running';i++){await wait(30);localJob=await data(await request(`${path}/processing/${local.id}`));}assert.equal(localJob.status,'ready',localJob.message);
      const fresh=await data(await request(`${path}/proposals/${p.proposalId}?revision=${doc.revision}`)),normalized=fresh.variants.find((v:any)=>v.id===localJob.variantId);assert.ok(normalized.canApply);
      const pixels=(await frame(p,normalized,1)).data;for(let i=0;i<324;i++)if(!animation.mask[i])assert.equal(pixels[i],i===0?0x70c989ff:0);
      assert.match((await data(await request(`${path}/ai/${job.id}`))).proposal.description,/calls=1/);
      const beforeCount=doc.assets.length;doc=await data(await request(path+'/apply-proposal','POST',{revision:doc.revision,proposalId:p.proposalId,variantId:normalized.id}));assert.equal(doc.assets.length,beforeCount+1);
      const saved=doc.assets.at(-1);assert.equal(saved.frames.length,4);assert.equal(saved.provenance.kind,'normalized');assert.deepEqual(saved.metadata.pivot,{x:.5,y:1});assert.equal(saved.tags[0].loop,false);
      const rebuilt=renderDocument({document:{schemaVersion:1,id:'p',revision:1,name:'P',...saved.source,pixels:{},metadata:{}},mode:'raster'}) as ExportResult;const rebuiltAssets=wireParse(Buffer.from(rebuilt.data).toString('utf8'));assert.deepEqual(composite(rebuiltAssets[0],rebuiltAssets[0].frames[1].id).data,pixels);
      const reopened=await data(await request(path));assert.equal(reopened.assets.at(-1).provenance.kind,'normalized');
      const exported=await request(path+'/export','POST',{revision:doc.revision,assetId:saved.id,frameId:saved.frames[1].id,format:'png'});assert.equal(exported.status,200);assert.deepEqual(png(new Uint8Array(await exported.arrayBuffer())).data,pixels);
      const atlas=unzip(new Uint8Array(await(await request(path+'/export','POST',{revision:doc.revision,assetId:saved.id,selected:[saved.id],format:'atlas'})).arrayBuffer())),image=png(atlas['image.png']),metadata=JSON.parse(atlas['image.json'].toString()),entries=Object.values(metadata.frames) as any[];
      const rect=entries[1].frame;for(let y=0;y<18;y++)for(let x=0;x<18;x++)assert.equal(image.data[(rect.y+y)*image.w+rect.x+x],pixels[y*18+x]);assert.equal(metadata.meta.frameTags[0].loop,false);assert.equal(metadata.meta.pxl.revision,doc.revision);
      const strip=unzip(new Uint8Array(await(await request(path+'/export','POST',{revision:doc.revision,assetId:saved.id,format:'strip'})).arrayBuffer())),json=JSON.parse(strip['image.json'].toString());assert.equal(json.meta.frameTags[0].loop,false);assert.deepEqual(json.meta.pxl.playback.map((f:any)=>f.duration),[100,100,100,100]);
      const gif=Buffer.from(await(await request(path+'/export','POST',{revision:doc.revision,assetId:saved.id,format:'gif'})).arrayBuffer());assert.equal(gif.includes(Buffer.from('NETSCAPE2.0')),false);
    }
    const bad=await start('codex','FIXTURE_WRONG_FRAMES'),badPreview=await data(await request(`${path}/ai/${bad.id}/preview`,'POST',{revision:doc.revision,variants:true}));assert.equal(badPreview.variants[0].canApply,false);assert.ok(badPreview.variants[0].quality.errors.some((e:string)=>e.includes('4 frame')));
    const immutable=await start('codex','FIXTURE_IMMUTABLE');assert.equal(immutable.attempt,2);
    const full=await start('codex','walk',{...animation,mode:'whole',mask:undefined}),p=await data(await request(`${path}/ai/${full.id}/preview`,'POST',{revision:doc.revision,variants:true}));assert.equal(p.variants[0].canApply,true);
    doc=await data(await request(path,'PUT',{revision:doc.revision,document:{...doc,name:'Outside change'}}));
    assert.equal((await request(path+'/apply-proposal','POST',{revision:doc.revision,proposalId:p.proposalId,variantId:p.variants[0].id})).status,409);
    assert.equal((await request(`${path}/proposals/${p.proposalId}/normalize`,'POST',{revision:doc.revision,alphaThreshold:128})).status,409);
    assert.equal((await request(path+'/ai','POST',{revision:doc.revision,assetId:a.id,provider:'codex',prompt:'blink',generationOptions:{...defaultGenerationOptions,animation:{...animation,mask:[]}}})).status,400);
    const cel=doc.assets[0].cels[doc.assets[0].layers[0].cels[a.frames[0].id]];cel.data=Uint32Array.from({length:324},(_,i)=>i===0?0x70c98980:0);doc=await data(await request(path,'PUT',{revision:doc.revision,document:doc}));
    for(const mode of ['region','whole'])assert.equal((await request(path+'/ai','POST',{revision:doc.revision,assetId:a.id,provider:'codex',prompt:'blink',generationOptions:{...defaultGenerationOptions,paletteMode:'auto16',animation:{...animation,mode}}})).status,422);
    const reference=await data(await request(path+'/reference-proposal','POST',{revision:doc.revision,assetId:a.id,frameId:a.frames[0].id,generationOptions:{...defaultGenerationOptions,paletteMode:'auto16'}}));assert.equal(reference.variants[0].quality.assets[0].semiTransparentPixels,1);assert.equal(reference.variants[0].kind,'reference');
    await request(path+'/close','POST',{});assert.equal((await request(`${path}/proposals/${reference.proposalId}?revision=${doc.revision}`)).status,409);
  }finally{await app.close();assert.equal(resolve(dirname(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});}
});
