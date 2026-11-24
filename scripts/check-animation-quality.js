// Explicit live CLI evaluation; never runs in npm test and never uses user projects.
// --review keeps temporary images until Enter / REVIEW_DONE (10 minute safety cleanup).
import { mkdtempSync,rmSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { serveStudio } from '../dist/node/studio/server.js';
import { detectProviders } from '../dist/node/studio/ai.js';
import { renderDocument } from '../dist/node/studio/render.js';
import { newDocument,wireParse,wireStringify } from '../dist/studio/pixel/model.js';
import { defaultGenerationOptions } from '../dist/studio/generation.js';
import { Img } from '../dist/core/image.js';
import { glyph } from '../dist/core/font.js';
import { encodePng } from '../dist/node/png.js';

const provider=process.argv[2];if(!['codex','antigravity'].includes(provider))throw new Error('Usage: node scripts/check-animation-quality.js codex|antigravity [--review] (3 real AI calls)');
const root=mkdtempSync(join(tmpdir(),'pxl-animation-quality-')),results=[],pictures=[];let app;
const source="pal({o:'#302c2e',b:'#c88749',l:'#eab77a',s:'#925436',e:'#a5d56c'});sprite('Cat',{w:32,h:32},rect(7,15,16,10,'o'),rect(8,16,14,7,'b'),rect(8,16,12,2,'l'),rect(8,23,4,4,'o'),rect(17,23,4,4,'o'),rect(9,23,2,3,'b'),rect(18,23,2,3,'b'),rect(4,9,11,10,'o'),rect(5,10,9,7,'b'),rect(6,7,3,4,'o'),rect(11,7,3,4,'o'),rect(7,8,1,3,'l'),rect(12,8,1,3,'l'),rect(5,10,8,2,'l'),rect(7,13,2,2,'o'),px(7,13,'e'),rect(5,16,4,1,'s'),px(4,15,'o'),rect(22,15,4,4,'o'),rect(24,11,3,6,'o'),rect(25,8,3,5,'o'),rect(23,16,2,2,'b'),rect(25,12,1,5,'b'),rect(26,9,1,4,'l'))";
const cases=[
  {name:'BLINK',mode:'region',region:[6,12,4,4],prompt:'Animate this exact side-view cat blinking its visible green eye. Frame 1 open, frame 2 half closed, frame 3 closed, frame 4 open. Edit only the eye; keep the head, ears and body identical. The movement mask marks the eye area.'},
  {name:'TAIL',mode:'region',region:[22,6,9,17],prompt:'Animate this exact cat gently waving its raised tail left and right over four distinct poses. The white mask includes the old tail and room for the new positions. Erase old tail pixels before drawing the shifted tail. Do not alter body, legs, face or ears.'},
  {name:'WALK',mode:'whole',prompt:'Make a four-frame walk-in-place cycle for this exact side-view cat facing left. Alternate near/far legs with clear different poses. Keep head/body proportions, fur colors and ground-contact baseline y=26 stable. Erase the old leg silhouettes before drawing the new legs; no whole-frame translation.'},
];
const pause=()=>new Promise(r=>setTimeout(r,200));
function label(image,text,x,y){for(const ch of text){const g=glyph(ch);for(let yy=0;yy<g.length;yy++)for(let xx=0;xx<g[yy].length;xx++)if(g[yy][xx]==='#')image.set(x+xx,y+yy,0xe0e7efff);x+=g[0].length+1;}}
try{
  const providers=await detectProviders();if(!providers[provider].available)throw new Error(providers[provider].message);
  app=await serveStudio(join(root,'projects'),{port:0,providers:{[provider]:providers[provider].path,timeout:180000}});
  console.log(JSON.stringify({provider,executable:providers[provider].path,model:'CLI default, no override',directory:root}));
  async function api(path,method='GET',body){const r=await fetch(app.url+'api/pixel/'+path,{method,headers:{origin:app.url.slice(0,-1),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:wireStringify(body)}),text=await r.text();if(!r.ok)throw new Error(`${r.status}: ${text}`);return wireParse(text);}
  const raster=renderDocument({document:{schemaVersion:1,id:'seed',name:'Cat',revision:1,entry:'art.px.js',files:{'art.px.js':source},pixels:{},metadata:{}},mode:'raster'}),seed=wireParse(Buffer.from(raster.data).toString('utf8'))[0];seed.metadata.pivot={x:.5,y:27/32};
  for(const item of cases){
    const initial=newDocument(item.name,32,32);initial.assets=[structuredClone(seed)];const doc=await api('projects','POST',{name:initial.name,document:initial}),path=`projects/${doc.id}`,a=doc.assets[0];
    const mask=Array(1024).fill(0);if(item.region){const [x,y,w,h]=item.region;for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)mask[yy*32+xx]=1;}
    const started=performance.now(),job=await api(path+'/ai','POST',{revision:doc.revision,assetId:a.id,provider,prompt:item.prompt,generationOptions:{...defaultGenerationOptions,paletteMode:'auto16',animation:{frameId:a.frames[0].id,mode:item.mode,frames:4,duration:100,loop:true,anchor:{x:16,y:27},...(item.mode==='region'?{mask}:{})}}});
    let state=job;while(['running','validating','canceling'].includes(state.status)){await pause();state=await api(`${path}/ai/${job.id}`);}if(state.status!=='ready')throw new Error(`${item.name}: ${state.message}`);
    let p=await api(`${path}/ai/${job.id}/preview`,'POST',{revision:doc.revision,variants:true});const normalize=await api(`${path}/proposals/${p.proposalId}/normalize`,'POST',{revision:doc.revision,alphaThreshold:128});let local=normalize;
    while(local.status==='running'){await pause();local=await api(`${path}/processing/${local.id}`);}if(local.status!=='ready')throw new Error(local.message);
    p=await api(`${path}/proposals/${p.proposalId}?revision=${doc.revision}`);const selected=p.variants.find(v=>v.id===local.variantId);if(!selected.canApply)throw new Error(selected.quality.errors.join('; '));
    const frames=async v=>Promise.all(v.assets[0].frames.map(f=>api(`${path}/proposals/${p.proposalId}/variants/${v.id}/frame?revision=${doc.revision}&asset=${v.assets[0].id}&frame=${f.id}`)));
    const raw=await frames(p.variants[0]),processed=await frames(selected),reference=await api(`${path}/proposals/${p.proposalId}/variants/${p.reference.id}/frame?revision=${doc.revision}&asset=${p.reference.assets[0].id}&frame=${p.reference.assets[0].frames[0].id}`);
    let outside=0;if(item.mode==='region')for(const f of processed)f.data.forEach((c,i)=>{if(!mask[i]&&c!==reference.data[i])outside++;});if(outside)throw new Error('Protected pixels changed');
    await api(path+'/apply-proposal','POST',{revision:doc.revision,proposalId:p.proposalId,variantId:selected.id});
    const row={case:item.name,ms:Math.round(performance.now()-started),attempts:state.attempt,quality:selected.quality,stats:selected.stats,outsideChanges:outside};results.push(row);console.log(JSON.stringify(row));pictures.push({name:item.name,reference,raw,processed});await api(path+'/close','POST',{});
  }
  const sheet=new Img(710,pictures.length*238+24);sheet.data.fill(0x454b56ff);label(sheet,'LIVE ANIMATION - RAW / PROCESSED - 3X NEAREST',10,8);
  pictures.forEach((row,i)=>{const y=24+i*238;label(sheet,row.name+' REFERENCE',8,y);sheet.blit(new Img(32,32,row.reference.data).scale(3),8,y+16);for(const [kind,frames,yy]of [['RAW',row.raw,y],['PROCESSED',row.processed,y+118]]){label(sheet,kind,120,yy);frames.forEach((f,j)=>sheet.blit(new Img(f.w,f.h,f.data).scale(3),220+j*116,yy+16));}});
  const contactSheet=join(root,'animation.png');writeFileSync(contactSheet,encodePng(sheet));writeFileSync(join(root,'results.json'),JSON.stringify(results,null,2));
  if(process.argv.includes('--review')){console.log(JSON.stringify({contactSheet,review:'Inspect then Enter or REVIEW_DONE; cleanup after 10 minutes.'}));await new Promise(r=>{const finish=()=>{clearInterval(poll);clearTimeout(deadline);process.stdin.pause();r();},poll=setInterval(()=>{if(existsSync(join(root,'REVIEW_DONE')))finish();},250),deadline=setTimeout(finish,600000);process.stdin.once('data',finish);process.stdin.resume();});}
}catch(e){console.error(e.message);process.exitCode=1;}finally{await app?.close();if(resolve(dirname(root))!==resolve(tmpdir()))throw new Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({cleaned:true,cases:results.length}));}
