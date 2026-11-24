import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';
import { composite, newDocument, type PixelAsset } from '../../studio/pixel/model.ts';
import type { VariantInfo, VariantFrame } from '../../studio/variants.ts';
import { deflateSync, inflateSync } from 'node:zlib';

/** Immutable compressed variants on disk; only requested composite frames are cached. */
export class VariantStore {
  readonly root: string; readonly store: PixelStore;
  private owned: boolean; private cache = new Map<string,VariantFrame>(); private cacheBytes=0;
  constructor(root?: string) { this.owned=!root; this.root=root??mkdtempSync(join(tmpdir(),'pxl-variants-')); mkdirSync(this.root,{recursive:true}); this.store=new PixelStore(this.root); }
  put(assets: PixelAsset[], info: Omit<VariantInfo,'id'|'assets'>): VariantInfo {
    const doc=newDocument('Đề xuất'); doc.assets=assets;
    const d=this.store.create(doc.name,32,32,0,doc);
    const metadata: VariantInfo={...info,id:d.id,assets:d.assets.map(({id,name,w,h,frames,tags,metadata,palette})=>({id,name,w,h,frames,tags,metadata,palette}))};
    writeFileSync(join(this.store.dir(d.id),'variant.json'),JSON.stringify(metadata)); return metadata;
  }
  info(id: string): VariantInfo { return JSON.parse(readFileSync(join(this.store.dir(id),'variant.json'),'utf8')); }
  assets(id: string): PixelAsset[] { return this.store.load(id,true).assets; }
  frame(id: string, assetId: string, frameId: string): VariantFrame {
    const key=`${id}:${assetId}:${frameId}`, cached=this.cache.get(key); if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached;}
    const d=this.store.load(id),a=d.assets.find(a=>a.id===assetId),f=a?.frames.find(f=>f.id===frameId);if(!a||!f)throw new StudioError('Frame đề xuất không tồn tại.',404);
    this.store.hydrate(d,(asset,frame)=>asset.id===a.id&&frame===frameId);
    const img=composite(a,frameId),value={w:img.w,h:img.h,data:img.data,duration:f.duration};
    while(this.cacheBytes+value.data.byteLength>128*1024*1024&&this.cache.size){const first=this.cache.keys().next().value!,old=this.cache.get(first)!;this.cacheBytes-=old.data.byteLength;this.cache.delete(first);}
    if(value.data.byteLength<=128*1024*1024){this.cache.set(key,value);this.cacheBytes+=value.data.byteLength;} return value;
  }
  mask(id: string, value?: number[]): number[] | undefined {
    const path=join(this.store.dir(id),'mask.z'); if(value)writeFileSync(path,deflateSync(JSON.stringify(value)));
    return existsSync(path)?JSON.parse(inflateSync(readFileSync(path)).toString('utf8')):undefined;
  }
  remove(id: string): void { const path=this.store.dir(id);for(const [key,value]of this.cache)if(key.startsWith(id+':')){this.cacheBytes-=value.data.byteLength;this.cache.delete(key);}rmSync(path,{recursive:true,force:true,maxRetries:3,retryDelay:20}); }
  close(): void { this.cache.clear();this.cacheBytes=0;if(this.owned){if(resolve(dirname(this.root))!==resolve(tmpdir())||!this.root.split(/[\\/]/).at(-1)!.startsWith('pxl-variants-'))throw new Error('Unexpected variant directory');rmSync(this.root,{recursive:true,force:true,maxRetries:3,retryDelay:20});} }
}
