import type { PixelAsset } from '../../studio/pixel/model.ts';
import { composite, newAsset, celFor, wireParse, wireStringify, uid } from '../../studio/pixel/model.ts';
import type { GenerationContext, ProjectDocument, AnimationOptions } from '../../studio/types.ts';
import { inspectGeneration } from '../../studio/generation.ts';
import { choosePalette, imageSource, processAsset, diagnostics, bounds, motionStats } from '../../studio/pixel/processing.ts';
import { VariantStore } from './variant-store.ts';
import { renderDocument, type ExportResult } from './render.ts';
import { encodePng } from '../png.ts';
import { Img } from '../../core/image.ts';
import type { ClipGenerationContext } from '../../studio/clip-generation.ts';
import { prepareClipSnapshot } from './clip-snapshot.ts';
import { clipCapture, clipNormalize, clipVerify } from './clip-worker.ts';

export interface ProcessingRequest {
  mode: 'pixel-process';
  root: string;
  operation:
    | 'capture'
    | 'normalize'
    | 'protect'
    | 'reference'
    | 'load'
    | 'verify'
    | 'clip-prepare'
    | 'clip-capture'
    | 'clip-normalize'
    | 'clip-verify';
  document?: ProjectDocument;
  generation?: GenerationContext;
  variantId?: string;
  referenceId?: string;
  source?: PixelAsset;
  frameId?: string;
  animation?: AnimationOptions;
  revision?: number;
  alphaThreshold?: number;

  projectRoot?: string;
  projectId?: string;
  clipId?: string;
  paletteMode?: 'asset' | 'auto16';
  targetPalette?: number[];
  context?: ClipGenerationContext;
  rawVariantId?: string;
}
export function variantFrame(r:{root:string;variantId:string;assetId:string;frameId:string;overlay?:string;referenceId?:string;compare?:{variantId:string;assetId:string;frameId:string}}):ExportResult{
  const repo=new VariantStore(r.root),image=repo.frame(r.variantId,r.assetId,r.frameId);let value:any={...image,bounds:bounds(image.data,image.w)};
  if(r.overlay){const data=new Uint32Array(image.data.length);let count=0;
    if(r.overlay==='singletons'||r.overlay==='checkerboards'){const d=diagnostics(image.data,image.w);const points=r.overlay==='singletons'?d.singletons:d.checkerboards;for(const i of points){data[i]=0xff6688cc;if(r.overlay==='checkerboards')for(const j of [i+1,i+image.w,i+image.w+1])data[j]=0xffbd66aa;}count=points.length;}
    else if(r.overlay==='movement'){if(!r.referenceId)throw new Error('Không có vùng khóa.');const mask=repo.mask(r.referenceId);if(!mask||mask.length!==data.length)throw new Error('Không có mask cùng kích thước.');mask.forEach((v,i)=>{if(v){data[i]=0x55cfff66;count++;}});}
    else if(r.overlay==='difference'){if(!r.compare)throw new Error('Không có ảnh đối chiếu.');const other=repo.frame(r.compare.variantId,r.compare.assetId,r.compare.frameId);if(other.w!==image.w||other.h!==image.h)throw new Error('Không thể so khác biệt giữa hai kích thước.');image.data.forEach((p,i)=>{if(p!==other.data[i]){data[i]=0xff55bbaa;count++;}});}
    else throw new Error('Overlay không hỗ trợ.');value={w:image.w,h:image.h,data,duration:image.duration,count};
  }
  return{data:Buffer.from(wireStringify(value)),mime:'application/json',filename:'frame.json'};
}
export function processRequest(r: ProcessingRequest): ExportResult {
  const repo=new VariantStore(r.root); let value: unknown;
  if(r.operation==='clip-prepare') {
    value = prepareClipSnapshot({
      projectRoot: r.projectRoot!,
      projectId: r.projectId!,
      revision: r.revision!,
      clipId: r.clipId!,
      paletteMode: r.paletteMode,
      targetPalette: r.targetPalette,
      storeRoot: r.root,
    });
  } else if(r.operation==='clip-capture') {
    value = clipCapture({
      root: r.root,
      context: r.context!,
      referenceId: r.referenceId!,
      document: r.document,
      rawVariantId: r.rawVariantId,
      revision: r.revision,
    });
  } else if(r.operation==='clip-normalize') {
    value = clipNormalize({
      root: r.root,
      context: r.context!,
      referenceId: r.referenceId!,
      rawVariantId: r.rawVariantId!,
      alphaThreshold: r.alphaThreshold,
      revision: r.revision,
    });
  } else if(r.operation==='clip-verify') {
    value = clipVerify({
      root: r.root,
      context: r.context!,
      referenceId: r.referenceId!,
      variantId: r.variantId!,
      revision: r.revision,
    });
  } else if(r.operation==='reference') {
    const source=r.source!,f=source.frames.find(f=>f.id===r.frameId);if(!f)throw new Error('Frame mẫu không tồn tại.');
    const image=composite(source,f.id);if(!image.data.some(p=>p&255))throw new Error('Frame mẫu rỗng. Vẽ nhân vật trước khi tạo animation.');
    const a=newAsset((source.name+' (mẫu)').slice(0,100),source.w,source.h);a.frames[0].duration=f.duration;celFor(a,a.layers[0].id,a.frames[0].id,true)!.data=image.data.slice();a.metadata=structuredClone(source.metadata);a.metadata.events=source.metadata.events?.filter(e=>e.frame===source.frames.indexOf(f)).map(e=>({...e,frame:0}));
    a.palette=[...new Set(image.data)].slice(0,4096);a.source={entry:'art.px.js',files:{'art.px.js':imageSource(a.name,a.w,a.h,[image.data],[f.duration],true)}};
    a.provenance={
      kind:'reference',
      originalSource:source.provenance?.originalSource??source.source,
      batch:source.provenance?.batch,
    };
    const g=r.generation!,palette=g.options.paletteMode==='asset'?[...new Set(g.palette.filter(p=>(p&255)===255))]:choosePalette([image],16);
    const problems: string[]=[];if(!palette.length)problems.push('Palette không có màu đục.');if(image.data.some(p=>(p&255)>0&&(p&255)<255))problems.push('Mẫu có pixel bán trong suốt.');if(image.data.some(p=>(p&255)>0&&!palette.includes(p)))problems.push('Mẫu có màu ngoài palette đích.');
    const anim=r.animation;
    if(anim){if(image.w*image.h*anim.frames>32_000_000)throw new Error('Animation vượt ngân sách 32 triệu pixel cel.');if(anim.anchor.x<0||anim.anchor.x>image.w||anim.anchor.y<0||anim.anchor.y>image.h)throw new Error('Điểm neo ngoài canvas.');if(anim.mask&&anim.mask.length!==image.data.length)throw new Error('Mask không khớp kích thước canvas.');if(anim.mode==='region'&&(!anim.mask||!anim.mask.some(Boolean)))throw new Error('Chọn vùng chuyển động trên canvas trước khi tạo animation.');}
    const info=repo.put([a],{kind:'reference',label:'Mẫu chuẩn',canApply:true,quality:inspectGeneration([a],{...g,animation:undefined})});
    let maskPreview:string|undefined;
    if(anim?.mode==='region'){repo.mask(info.id,anim.mask);const maskImage=new Img(a.w,a.h);anim.mask!.forEach((v,i)=>{maskImage.data[i]=v?0xffffffff:0x000000ff;});maskPreview=Buffer.from(encodePng(maskImage)).toString('base64');}
    value={info,palette,problems,source:imageSource('_pxl_reference',a.w,a.h,[image.data],[f.duration],true),preview:Buffer.from(encodePng(image)).toString('base64'),maskPreview};
  } else if(r.operation==='capture') {
    const result=renderDocument({document:r.document!,mode:r.generation?'generation-preview':'raster',generation:r.generation}) as ExportResult;
    const p=wireParse(Buffer.from(result.data).toString('utf8')),assets: PixelAsset[]=Array.isArray(p)?p:p.assets;
    const base=r.referenceId?repo.assets(r.referenceId)[0]:undefined,baseline=base?composite(base,base.frames[0].id).data:undefined;
    if(r.generation?.operation==='region-edit'){
      for(const a of assets){
        const g=r.generation,anim=g.animation!;
        a.metadata={
          ...structuredClone(base?.metadata??{}),
          pivot:{x:anim.anchor.x/a.w,y:anim.anchor.y/a.h},
        };
        a.provenance={kind:'generated',originalSource:a.source,reference:{assetId:g.assetId,frameId:anim.frameId,revision:r.document!.revision,mode:anim.mode,anchor:anim.anchor}};
      }
    } else if(r.generation?.animation){
      for(const a of assets)a.metadata.pivot={x:r.generation.animation.anchor.x/a.w,y:r.generation.animation.anchor.y/a.h};
      for(const a of assets){const g=r.generation,anim=g.animation!;a.metadata={...structuredClone(base?.metadata??{}),...a.metadata};a.provenance={kind:'generated',originalSource:a.source,reference:{assetId:g.assetId,frameId:anim.frameId,revision:r.document!.revision,mode:anim.mode,anchor:anim.anchor}};}
    } else if(r.generation)for(const a of assets)a.provenance={kind:'generated',originalSource:a.source};
    const stats=r.generation?.animation?assets.map(a=>{const frames=a.frames.map(f=>composite(a,f.id).data),motion=motionStats(frames,a.w,baseline);let outsideChanges=0;const mask=r.referenceId?repo.mask(r.referenceId):undefined;if(mask&&baseline)for(const data of frames)data.forEach((p,i)=>{if(!mask[i]&&p!==baseline[i])outsideChanges++;});const n=new Set<number>();for(const data of frames)for(const p of data)if(p&255)n.add(p);return{...motion,changedColors:0,changedAlpha:0,changedPixels:0,outsideChanges,beforeColors:n.size,afterColors:n.size};}):undefined;
    if(p.quality&&stats)p.quality.warnings.push(...stats.flatMap(s=>s.warnings));
    value=repo.put(assets,{kind:'raw',label:'AI gốc',canApply:r.generation?.animation?.mode!=='region'&&!p.quality?.errors.length,quality:p.quality,stats});
  } else if(r.operation==='load') value=repo.assets(r.variantId!);
  else {
    const assets=repo.assets(r.variantId!),generation=r.generation!;
    const reference=r.referenceId?repo.assets(r.referenceId)[0]:undefined,mask=r.referenceId?repo.mask(r.referenceId):undefined;
    if(r.operation==='verify') {
      const quality=inspectGeneration(assets,generation);let outsideChanges=0;
      if(generation.animation?.mode==='region') {
        if(!reference||!mask)throw new Error('Mẫu/vùng khóa đã hết hạn.');const base=composite(reference,reference.frames[0].id).data;
        for(const a of assets)for(const f of a.frames){const data=composite(a,f.id).data;if(data.length!==base.length)throw new Error('Canvas vùng khóa không khớp.');data.forEach((p,i)=>{if(!mask[i]&&p!==base[i])outsideChanges++;});}
      }
      if(outsideChanges)quality.errors.push(`${outsideChanges} pixel thay đổi ngoài vùng cho phép.`);
      value={quality,outsideChanges};
    } else {
      const results=assets.map(a=>processAsset(a,generation,r.operation==='normalize'?'normalize':'protect',r.alphaThreshold??128,reference?{asset:reference,frameId:reference.frames[0].id,mask}:undefined));
      for(const {asset}of results)if(asset.provenance?.reference)asset.provenance.reference.revision=r.revision!;
      const processed=results.map(p=>p.asset),quality=inspectGeneration(processed,generation);quality.warnings.push(...results.flatMap(p=>p.stats.warnings));
      value=repo.put(processed,{kind:r.operation==='normalize'?'normalized':'protected',label:r.operation==='normalize'?`Đã chuẩn hóa · alpha ${r.alphaThreshold??128}`:'Đã khóa vùng',canApply:!quality.errors.length,quality,stats:results.map(p=>p.stats),alphaThreshold:r.operation==='normalize'?r.alphaThreshold??128:undefined});
    }
  }
  return{data:Buffer.from(wireStringify(value)),mime:'application/json',filename:'processing.json'};
}
