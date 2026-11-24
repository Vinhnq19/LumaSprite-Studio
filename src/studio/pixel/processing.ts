import { composite, newAsset, newLayer, uid, type PixelAsset } from './model.ts';
import { rgbaHex } from '../generation.ts';
import type { GenerationContext } from '../types.ts';
import type { Img } from '../../core/image.ts';

// OKLab matrices by Björn Ottosson, MIT/public domain:
// https://bottosson.github.io/posts/oklab/ (updated 2021-01-25).
export function oklab(color: number): [number, number, number] {
  const linear = (n: number) => { const s = n / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; };
  const r = linear(color >>> 24), g = linear(color >>> 16 & 255), b = linear(color >>> 8 & 255);
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b), m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b), s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .793617785*m - .0040720468*s, 1.9779984951*l - 2.428592205*m + .4505937099*s, .0259040371*l + .7827717662*m - .808675766*s];
}
type Sample = { color: number; count: number; lab: [number, number, number] };
const distance = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0);
export function choosePalette(images: Img[], limit = 16, threshold = 128): number[] {
  const histogram = new Map<number, number>();
  for (const image of images) for (const p of image.data) if ((p & 255) >= threshold) { const c = (p | 255) >>> 0; histogram.set(c, (histogram.get(c) ?? 0) + 1); }
  const samples = [...histogram].sort((a,b) => a[0]-b[0]).map(([color,count]) => ({ color,count,lab:oklab(color) }));
  if (samples.length <= limit) return samples.map(s => s.color);
  const span = (box: Sample[]) => [0,1,2].map(i => {let lo=Infinity,hi=-Infinity;for(const s of box){lo=Math.min(lo,s.lab[i]);hi=Math.max(hi,s.lab[i]);}return hi-lo;});
  const boxes = [samples];
  while (boxes.length < limit) {
    let index = -1, score = -1, axis = 0;
    boxes.forEach((box, i) => { if (box.length < 2) return; const spans = span(box), max = Math.max(...spans); if (max > score) { score = max; index = i; axis = spans.indexOf(max); } });
    if (index < 0) break;
    const box = boxes[index].sort((a,b) => a.lab[axis]-b.lab[axis] || a.color-b.color), half = box.reduce((s,c) => s+c.count,0)/2;
    let weight = 0, split = 1; for (let i = 0; i < box.length-1; i++) { weight += box[i].count; split = i+1; if (weight >= half) break; }
    boxes.splice(index,1,box.slice(0,split),box.slice(split));
  }
  return boxes.map(box => {
    const weight = box.reduce((s,c) => s+c.count,0), center = [0,1,2].map(i => box.reduce((s,c) => s+c.lab[i]*c.count,0)/weight);
    return box.reduce((best,s) => distance(s.lab,center) < distance(best.lab,center) || distance(s.lab,center) === distance(best.lab,center) && s.color < best.color ? s : best).color;
  }).sort((a,b) => a-b);
}
export function normalizePixels(data: Uint32Array, palette: number[], threshold = 128): Uint32Array {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) throw new Error('Ngưỡng alpha cần 1–255.');
  const target = [...new Set(palette.filter(c => (c & 255) === 255))];
  if (!target.length && data.some(p => (p & 255) >= threshold)) throw new Error('Palette đích không có màu đục. Chọn màu alpha 255 hoặc AI tự chọn ≤16 màu.');
  const labs = target.map(oklab), mapped = new Map<number, number>(), exact = new Set(target);
  return data.map(p => {
    if ((p & 255) < threshold) return 0;
    const c = (p | 255) >>> 0; if (exact.has(c)) return c;
    if (mapped.has(c)) return mapped.get(c)!;
    const lab = oklab(c); let best = 0, min = Infinity;
    labs.forEach((l,i) => { const d = distance(l,lab); if (d < min) { min = d; best = i; } });
    mapped.set(c,target[best]); return target[best];
  });
}
export interface Bounds { x: number; y: number; w: number; h: number; bottom: number }
export function bounds(data: Uint32Array, w: number): Bounds | undefined {
  let x0=w,y0=data.length/w,x1=-1,y1=-1;
  data.forEach((p,i) => { if (!(p & 255)) return; const x=i%w,y=Math.floor(i/w); x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); });
  return x1 < 0 ? undefined : { x:x0,y:y0,w:x1-x0+1,h:y1-y0+1,bottom:y1 };
}
export function diagnostics(data: Uint32Array, w: number): { singletons: number[]; checkerboards: number[]; bounds?: Bounds } {
  const singletons: number[] = [], checkerboards: number[] = [], h=data.length/w;
  for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=y*w+x,p=data[i]; if(!(p&255)) continue;
    if (![x>0?i-1:-1,x+1<w?i+1:-1,y>0?i-w:-1,y+1<h?i+w:-1].some(j=>j>=0 && data[j]===p)) singletons.push(i);
    if (x+1<w && y+1<h && (data[i+1]&255) && p!==data[i+1] && p===data[i+w+1] && data[i+1]===data[i+w]) checkerboards.push(i);
  }
  return { singletons,checkerboards,bounds:bounds(data,w) };
}
export function estimateImageSourceLength(
  name: string,
  w: number,
  h: number,
  images: Uint32Array[],
  durations: number[],
  loop: boolean,
  maxBytes?: number
): number {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !Array.isArray(images) || images.length === 0) {
    return 0;
  }
  if (images.length * w * h > 32_000_000) {
    return Infinity;
  }
  const nameBytes = typeof Buffer !== 'undefined'
    ? Buffer.byteLength(JSON.stringify(name), 'utf8')
    : new TextEncoder().encode(JSON.stringify(name)).length;

  const isSprite = images.length === 1 && durations[0] === 100 && loop;
  let len = isSprite
    ? 7 + nameBytes + 4 + String(w).length + 3 + String(h).length + 2 + 2
    : 5 + nameBytes + 4 + String(w).length + 3 + String(h).length + 6 + (loop ? 4 : 5) + 2 + 2;

  const limit = maxBytes ?? Infinity;
  if (len > limit) return len;

  for (let i = 0; i < images.length; i++) {
    const data = images[i];
    if (!isSprite) {
      len += 11 + String(durations[i] ?? 100).length + 2;
      len += 1;
      if (i < images.length - 1) len += 1;
    }
    let hasRow = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; ) {
        const p = data[y * w + x], start = x;
        while (x < w && data[y * w + x] === p) x++;
        if (p & 255) {
          if (hasRow) len += 1;
          hasRow = true;
          len += 22 + String(start).length + String(y).length + String(x - start).length;
          if (len > limit) return len;
        }
      }
    }
  }
  return len;
}
export function imageSource(name: string, w: number, h: number, images: Uint32Array[], durations: number[], loop: boolean): string {
  const draw = (data: Uint32Array) => {
    const rows: string[] = [];
    for(let y=0;y<h;y++) for(let x=0;x<w;) { const p=data[y*w+x], start=x; while(x<w && data[y*w+x]===p) x++; if(p&255) rows.push(`rect(${start},${y},${x-start},1,'${rgbaHex(p)}')`); }
    return rows.join(',');
  };
  const source = images.length===1&&durations[0]===100&&loop ? `sprite(${JSON.stringify(name)},{w:${w},h:${h}},${draw(images[0])})\n` : `anim(${JSON.stringify(name)},{w:${w},h:${h},loop:${loop}},${images.map((d,i)=>`frame({ms:${durations[i]}},${draw(d)})`).join(',')})\n`;
  if (source.length > 1_900_000) throw new Error('Ảnh có quá nhiều dữ liệu để lưu mã dựng chính xác (giới hạn 2 MiB/file). Giảm kích thước hoặc độ phức tạp.');
  return source;
}
export function flatAsset(source: PixelAsset, frames: Uint32Array[], name = source.name): PixelAsset {
  const a=newAsset(name,source.w,source.h), layer=newLayer('Ảnh kết quả');
  a.id=source.id; a.frames=source.frames.map(f=>({...f})); a.layers=[layer]; a.cels={}; a.tags=structuredClone(source.tags); a.metadata=structuredClone(source.metadata);
  frames.forEach((data,i)=>{const id=uid();a.cels[id]={id,data};layer.cels[a.frames[i].id]=id;});
  const colors=new Set<number>(); for(const data of frames) for(const p of data) if(colors.size<4096) colors.add(p&255?p:0); a.palette=[...colors];
  return a;
}
export interface AnimationReference { asset: PixelAsset; frameId: string; mask?: number[] }
export interface ProcessingStats { changedColors: number; changedAlpha: number; changedPixels: number; outsideChanges: number; beforeColors: number; afterColors: number; frames: { bounds?: Bounds; bottomDrift: number; changed: number }[]; warnings: string[] }
export function motionStats(frames:Uint32Array[],w:number,baseline=frames[0]):Pick<ProcessingStats,'frames'|'warnings'>{
  const anchorBounds=bounds(baseline,w),warnings:string[]=[];
  const values=frames.map((data,index)=>{const b=bounds(data,w),bottomDrift=b&&anchorBounds?b.bottom-anchorBounds.bottom:0,changed=data.reduce((n,p,i)=>n+ +(p!==baseline[i]),0);if(b&&anchorBounds&&(Math.abs(b.w-anchorBounds.w)/anchorBounds.w>.2||Math.abs(b.h-anchorBounds.h)/anchorBounds.h>.2))warnings.push(`Frame ${index+1}: bounding box đổi trên 20% (cần xem lại).`);if(Math.abs(bottomDrift)>1)warnings.push(`Frame ${index+1}: đáy hình lệch ${bottomDrift} px.`);return{bounds:b,bottomDrift,changed};});
  if(frames.length>1&&frames.every(data=>data.every((p,i)=>p===frames[0][i])))warnings.push('Tất cả frame giống nhau; chưa có chuyển động.');
  return{frames:values,warnings};
}
export function processAsset(source: PixelAsset, generation: GenerationContext, operation: 'normalize'|'protect', threshold = 128, reference?: AnimationReference): { asset: PixelAsset; stats: ProcessingStats } {
  const originals=source.frames.map(f=>composite(source,f.id)), baseline=reference?composite(reference.asset,reference.frameId):undefined;
  const before=new Set<number>(),after=new Set<number>(); let changedColors=0,changedAlpha=0,changedPixels=0,outsideChanges=0;
  const palette=generation.options.paletteMode==='asset'?generation.palette:baseline?choosePalette([baseline],16,threshold):choosePalette(originals,16,threshold);
  const frames=originals.map(image=>{
    let data=operation==='normalize'?normalizePixels(image.data,palette,threshold):image.data.slice();
    if (baseline && generation.animation?.mode==='region') {
      if(!reference?.mask || reference.mask.length!==data.length || image.w!==baseline.w || image.h!==baseline.h) throw new Error('Vùng khóa không khớp canvas.');
      data=data.map((p,i)=>reference.mask![i]?p:baseline.data[i]);
    }
    data.forEach((p,i)=>{const old=image.data[i];if(old&255)before.add(old);if(p&255)after.add(p);if(p!==old){changedPixels++;if((p>>>8)!==(old>>>8))changedColors++;if((p&255)!==(old&255))changedAlpha++;}if(baseline && reference?.mask && !reference.mask[i] && p!==baseline.data[i])outsideChanges++;});
    return data;
  });
  const asset=flatAsset(source,frames),motion=motionStats(frames,source.w,baseline?.data);
  if(generation.animation) asset.metadata.pivot={x:generation.animation.anchor.x/asset.w,y:generation.animation.anchor.y/asset.h};
  asset.source={entry:'art.px.js',files:{'art.px.js':imageSource(asset.name,asset.w,asset.h,frames,asset.frames.map(f=>f.duration),asset.tags[0]?.loop??true)}};
  asset.provenance={
    kind:operation==='normalize'?'normalized':'protected',
    originalSource:source.provenance?.originalSource??source.source,
    batch:source.provenance?.batch,
    palette:operation==='normalize'?palette:undefined,
    alphaThreshold:operation==='normalize'?threshold:undefined,
    reference:generation.animation?{assetId:generation.assetId,frameId:generation.animation.frameId,revision:0,mode:generation.animation.mode,anchor:generation.animation.anchor}:undefined
  };
  return {asset,stats:{changedColors,changedAlpha,changedPixels,outsideChanges,beforeColors:before.size,afterColors:after.size,...motion}};
}
