import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiReference } from '../src/node/studio/ai-reference.ts';
import type { GenerationContext } from '../src/studio/types.ts';
import { renderDocument } from '../src/node/studio/render.ts';
const full=readFileSync('reference.md','utf8');
const generation:GenerationContext={assetId:'a',w:18,h:24,palette:[0x70c989ff],options:{style:'game',view:'front',paletteMode:'asset',reference:false}};
test('AI reference: fresh sprites and private-helper animation are compact; arbitrary editing/legacy retain full reference',()=>{
  assert.ok(aiReference(full,generation).length<full.length/3);
  for(const context of [undefined,{...generation,options:{...generation.options,reference:true}},{...generation,operation:'region-edit' as const}])assert.equal(aiReference(full,context),full);
  const animated=aiReference(full,{...generation,animation:{frameId:'f',mode:'whole',frames:4,duration:100,loop:true,anchor:{x:9,y:24},referenceFile:'base.px.js'}});assert.ok(animated.length<full.length/3);assert.match(animated,/APP-OWNED/);
});
test('AI reference: documented animation patches preserve shared base, nonuniform timing and one-shot',()=>{
  const result=renderDocument({mode:'summary',validateFrames:true,document:{schemaVersion:1,id:'t',name:'t',revision:1,entry:'art.px.js',files:{'base.px.js':"sprite('_owned',{w:18,h:24},rect(2,2,8,15,'#70c989'))",'art.px.js':"include('base.px.js');anim('proposal',{w:18,h:24,base:'_owned',loop:false},frame({ms:80}),frame({ms:140},rect(4,4,2,1,'_'),px(4,5,'#101522')))"},pixels:{},metadata:{}}});
  assert.ok('assets' in result);assert.deepEqual(result.errors,[]);const a=result.assets.find(a=>a.name==='proposal')!;assert.deepEqual(a.durations,[80,140]);assert.equal(a.loop,false);assert.equal(a.w,18);assert.equal(a.h,24);
});
test('AI reference: compact documented drawing surface renders exact rectangular native dimensions',()=>{
  const source="pal({k:'#101522',r:'#c35353',w:'#ffffff'})\nsprite('proposal',{w:18,h:24},clip([0,0,18,24],rect(3,5,12,17,'k'),box(4,6,10,15,'r'),ellipse(9,4,3,2,'w')),line(3,22,14,22,'r'),hline(5,3,8,'k'),vline(9,3,5,'w'),grid(8,10,'kw\\nwk'))";
  const result=renderDocument({mode:'summary',validateFrames:true,document:{schemaVersion:1,id:'t',name:'t',revision:1,entry:'art.px.js',files:{'art.px.js':source},pixels:{},metadata:{}}});
  assert.ok('assets' in result);assert.deepEqual(result.errors,[]);assert.equal(result.assets[0].w,18);assert.equal(result.assets[0].h,24);
});
