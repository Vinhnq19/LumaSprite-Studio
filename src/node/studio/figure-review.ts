import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Img } from '../../core/image.ts';
import { composite, wireParse, wireStringify, type PixelAsset } from '../../studio/pixel/model.ts';
import { imageSource } from '../../studio/pixel/processing.ts';
import { figureDiagnostics, protectFigure, type FigureSample, type FigureStage, type FigurePlan } from '../../studio/pixel/figure-review.ts';
import { StudioError } from './store.ts';
import { encodePng } from '../png.ts';
import type { PreparedSnapshot } from './generation-prep.ts';
import { composePose, inspectCharacterPose, movePosePart, poseGuide, posePartName, validateCharacterPose, type PosePart, type PoseRasters } from '../../studio/pixel/character-pose.ts';
import { dataObject } from '../../studio/quality/data.ts';

type RecordInput = Pick<FigureSample,'revision'|'stage'|'parent'|'plan'|'approved'|'finishNotes'> & { mask?: number[]; submittedAt?: number };
function file(dir: string, id: string, suffix: string) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new StudioError('ID bản phác không hợp lệ.');
  return join(dir, 'figure-review', id + suffix);
}
function save(path: string, value: unknown) {
  const temp = path + '.' + randomUUID();
  writeFileSync(temp, wireStringify(value)); renameSync(temp, path);
}
export function figureHistory(dir: string) {
  const folder = join(dir,'figure-review');
  return existsSync(folder) ? readdirSync(folder).filter(n=>n.endsWith('.sample')).map(n=>n.slice(0,-7)) : [];
}
export function figureSample(dir: string, id: string): FigureSample {
  const path = file(dir,id,'.sample');
  if (!existsSync(path)) throw new StudioError('Bản phác chưa sẵn sàng.',404);
  return wireParse(readFileSync(path,'utf8'));
}
export function figureInput(dir: string,id: string): RecordInput | undefined {
  const path=file(dir,id,'.input');
  return existsSync(path) ? wireParse(readFileSync(path,'utf8')) : undefined;
}

function editedFigurePixels(source: Uint32Array, edits: unknown) {
  const pixels = source.slice();
  if (edits === undefined) return pixels;
  if (!Array.isArray(edits) || edits.length > pixels.length) throw new StudioError('Nét chỉnh không hợp lệ.');
  for (const edit of edits) {
    if (!Array.isArray(edit) || edit.length !== 2) throw new StudioError('Sai định dạng nét chỉnh.');
    const [index, color] = edit;
    if (!Number.isInteger(index) || index < 0 || index >= pixels.length ||
        !Number.isInteger(color) || color < 0 || color > 0xffffffff) throw new StudioError('Pixel chỉnh ngoài phạm vi.');
    pixels[index] = color;
  }
  return pixels;
}

export function reviseFigure(dir: string, id: string, revision: number, edits: unknown, note: unknown, move?: unknown) {
  const source = figureSample(dir, id);
  if (source.revision !== revision || source.stage !== 'shape') throw new StudioError('Cần bản phác ở revision hiện tại.', 409);
  if (move===undefined && (!Array.isArray(edits)||!edits.length)) throw new StudioError('Cần ít nhất một chỉnh sửa.');
  if (note !== undefined && (typeof note !== 'string' || note.length > 1000))
    throw new StudioError('Mô tả chỉnh sửa tối đa 1.000 ký tự.');
  const plan = { ...source.plan };
  if (typeof note === 'string' && note.trim()) plan.brief += '\nDesign notes for this sketch: ' + note.trim();
  if (plan.brief.length > 11500) throw new StudioError('Đề bài và mô tả chỉnh sửa quá dài.');
  const {w,h}=plan.generation;
  let parts: PoseRasters|undefined, pixels: Uint32Array;
  if (plan.poseSpec) {
    if (!source.shapeParts || source.errors.length || (Array.isArray(edits)&&edits.length))
      throw new StudioError('Bản phác có mốc cần lớp hợp lệ và thao tác dịch bộ phận.');
    try {
      const o=dataObject(move,['part','dx','dy'],'Dịch bộ phận'), part=o.part as PosePart;
      if(!plan.poseSpec.order.includes(part)||(!o.dx&&!o.dy)) throw Error('Chọn bộ phận và khoảng dịch khác 0.');
      parts={...source.shapeParts,[part]:movePosePart(source.shapeParts[part]!,w,h,o.dx as number,o.dy as number)};
      pixels=composePose(plan.poseSpec,parts,w*h);
    } catch(e) { throw new StudioError((e as Error).message); }
  } else {
    if(move!==undefined) throw new StudioError('Bản phác này chưa có lớp bộ phận.');
    pixels=editedFigurePixels(source.pixels,edits);
  }
  const revised = saveFigureRaster(dir, randomUUID(), { stage: 'shape', parent: id, revision, plan }, pixels, parts);
  save(file(dir, id, '.latest'), revised.id);
  return revised;
}

export function prepareFigure(dir: string, body: any, snapshot: PreparedSnapshot) {
  const stage: FigureStage = body.figureStage;
  if (!['shape','finish','repair'].includes(stage) || !snapshot.generation || snapshot.generation.animation)
    throw new StudioError('Cần một nhân vật tĩnh.');
  const g=snapshot.generation;
  function direction(value: unknown, fallback: string) {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || value.length > 300) throw new StudioError('Mô tả dáng hoặc tỷ lệ quá dài.');
    return value.trim() || fallback;
  }
  const plan: FigurePlan={ brief:body.prompt, generation:g, art:snapshot.artDirection, grid:1, pose:direction(body.pose,'Theo brief'), proportions:direction(body.proportions,'Theo brief và tham chiếu'), projection:g.options.view };
  const record:RecordInput={stage,revision:snapshot.revision,plan,submittedAt:Date.now()};
  let instruction='';
  if(body.poseSpec!==undefined){
    if(stage!=='shape') throw new StudioError('Chỉ đặt mốc khi dựng phác.');
    try{plan.poseSpec=validateCharacterPose(body.poseSpec,g.w,g.h);}
    catch(e){throw new StudioError((e as Error).message);}
    const spec=plan.poseSpec;
    snapshot.guideImage=encodePng(poseGuide(spec,g.w,g.h).scale(4));
    const order=spec.order.map(p=>posePartName(p));
    instruction=[
      'STRUCTURED SHAPE: follow the native pixel targets below. clip-guide.png is a 4× guide (amber landmarks, green sole, pink grip). Do not paint the guide.',
      'Draw each named part as a separate private transparent sprite, at canvas size and absolute coordinates, using the locked palette. Paint opaque pixels only.',
      'Create exactly one public sprite with these stamps in this back-to-front order, and no other paint or transforms:',
      `sprite('proposal',{w:${g.w},h:${g.h}},${order.map(name=>`stamp('${name}',0,0)`).join(',')});`,
      'Aim for physical contact at the indicated support and grasp. Leave the planned gaps, preserve intended occlusion, and follow the stylization rather than a fixed human ratio.',
      JSON.stringify(spec),
    ].join('\n');
  }
  if(stage!=='shape'){
    const parent=figureSample(dir,body.parentId);
    if(parent.revision!==snapshot.revision || parent.plan.generation.assetId!==g.assetId || (stage==='finish'?parent.stage!=='shape':parent.stage!=='finish'))
      throw new StudioError('Bản cha hoặc revision không khớp.',409);
    if(stage==='repair' && existsSync(file(dir,parent.id,'.repair'))) throw new StudioError('Đã dùng lượt sửa cho bản này.',409);
    if (stage==='finish' && parent.plan.poseSpec && (parent.errors.length || !parent.shapeParts ||
        (body.edits!==undefined && (!Array.isArray(body.edits)||body.edits.length))))
      throw new StudioError('Cần lưu bản sửa dáng hợp lệ trước khi tô vật liệu.',422);
    const pixels=editedFigurePixels(parent.pixels, stage==='finish' ? body.edits : undefined);
    if(!pixels.some(p=>p&255)) throw new StudioError('Bản phác trống.');
    if (stage==='finish' && parent.plan.generation.options.paletteMode==='asset') {
      const allowed=new Set(parent.plan.generation.palette);
      if(pixels.some(p=>(p&255)!==0 && !allowed.has(p))) throw new StudioError('Chỉnh pixel ngoài palette trước khi duyệt.',422);
    }
    if(stage==='repair'){
      if(!Array.isArray(body.mask)||!body.mask.length||body.mask.length>pixels.length||body.mask.some((i:unknown)=>typeof i!=='number'||!Number.isInteger(i)||i<0||i>=pixels.length)) throw new StudioError('Chọn vùng sửa trước.');
      record.mask=body.mask;
    }
    record.parent=parent.id; record.approved=pixels; record.plan=parent.plan;
    if(stage==='finish' && body.finishNotes!==undefined){
      if(typeof body.finishNotes!=='string'||body.finishNotes.length>1800) throw new StudioError('Chỉ dẫn tô vật liệu tối đa 1.800 ký tự.');
      record.finishNotes=body.finishNotes.trim();
      if(record.finishNotes) instruction='Finishing notes for the approved design: '+record.finishNotes;
    }
    snapshot.generation=structuredClone(parent.plan.generation);
    snapshot.generation.options.reference=true;
    snapshot.artDirection=parent.plan.art;
    snapshot.contextDoc.files={ [snapshot.contextDoc.entry]:imageSource('proposal',g.w,g.h,[pixels],[100],true) };
    snapshot.preview=Buffer.from(encodePng(new Img(g.w,g.h,pixels)));
    if(stage==='repair') instruction='Requested correction: '+body.prompt;
    if(record.mask){
      const mask=new Uint32Array(pixels.length);
      for(const i of record.mask) mask[i]=0xffffffff;
      snapshot.movementMask=Buffer.from(encodePng(new Img(g.w,g.h,mask)));
    }
  }
  const prompt=[record.plan.brief];
  if(instruction) prompt.push(instruction);
  if(record.plan.pose!=='Theo brief') prompt.push('Pose: '+record.plan.pose);
  if(record.plan.proportions!=='Theo brief và tham chiếu') prompt.push('Proportions: '+record.plan.proportions);
  return {record,prompt:prompt.join('\n')};
}
export function rememberFigure(dir:string,id:string,record:RecordInput){
  mkdirSync(join(dir,'figure-review'),{recursive:true});
  save(file(dir,id,'.input'),record);
  if(record.stage==='finish' && record.parent) save(file(dir,record.parent,'.latest'),id);
  if(record.stage==='repair' && record.parent) save(file(dir,record.parent,'.repair'),id);
}
export function renderFigure(dir:string,id:string,record:RecordInput,assets:PixelAsset[]):FigureSample {
  const saved=file(dir,id,'.sample');
  if(existsSync(saved)) return figureSample(dir,id);
  if(record.stage==='finish' && record.parent){
    const latest=file(dir,record.parent,'.latest');
    if(existsSync(latest) && JSON.parse(readFileSync(latest,'utf8'))!==id)
      throw new StudioError('Bản duyệt đã thay đổi trong khi dựng.',409);
  }
  const g=record.plan.generation, a=assets[0];
  const spec=record.stage==='shape'?record.plan.poseSpec:undefined;
  if(spec){
    const linked=new Map(assets.map(asset=>[asset.name,asset]));
    const main=linked.get('proposal');
    if(!main||main.w!==g.w||main.h!==g.h||main.frames.length!==1) throw new StudioError('Thiếu sprite proposal đúng canvas.',422);
    const raw=composite(main,main.frames[0].id).data;
    const errors: string[]=[],parts: PoseRasters={};
    const palette=new Set(g.palette), layerColors=new Set<number>();
    if(assets.length!==spec.order.length+1) errors.push('Dựng đúng một proposal và các lớp bộ phận trong PoseSpec.');
    for(const part of spec.order){
      const layer=linked.get(posePartName(part));
      if(!layer||layer.w!==g.w||layer.h!==g.h||layer.frames.length!==1){
        errors.push('Thiếu lớp đúng canvas: '+part); continue;
      }
      const raster=composite(layer,layer.frames[0].id).data;
      if(raster.some(p=>(p&255)!==0&&(p&255)!==255)) errors.push('Lớp cần alpha 0/255: '+part);
      if(!raster.some(p=>p&255)) errors.push('Lớp bộ phận trống: '+part);
      for(const ink of raster) if(ink&255)layerColors.add(ink);
      if(g.options.paletteMode==='asset'&&raster.some(p=>(p&255)&&!palette.has(p)))
        errors.push('Lớp có màu ngoài palette khóa: '+part);
      parts[part]=raster;
    }
    if(g.options.paletteMode==='auto16'&&layerColors.size>16) errors.push('Tổng các lớp vượt ngân sách 16 màu.');
    if(!errors.length&&composePose(spec,parts,raw.length).some((p,i)=>p!==raw[i]))
      errors.push('Raster proposal khác phép ghép lớp theo PoseSpec.');
    return saveFigureRaster(dir,id,record,raw,errors.length?undefined:parts,errors);
  }
  if(assets.length!==1||a.w!==g.w||a.h!==g.h||a.frames.length!==1) throw new StudioError('Sai số asset, frame hoặc kích thước bản phác.',422);
  const raw=composite(a,a.frames[0].id).data;
  return saveFigureRaster(dir,id,record,raw);
}

function saveFigureRaster(dir: string, id: string, record: RecordInput, raw: Uint32Array, parts?: PoseRasters, errors: string[] = []) {
  const g=record.plan.generation;
  const pixels=record.approved?protectFigure(raw,record.approved,record.mask):raw;
  const warnings=figureDiagnostics(new Img(g.w,g.h,pixels));
  let restored=0;
  if(record.approved){
    for(let index=0;index<pixels.length;index++){
      if(raw[index]===pixels[index]) continue;
      if(restored<8) warnings.push({index,reason:'Studio đã khôi phục pixel để giữ đường bao hoặc vùng khóa.'});
      restored++;
    }
  }
  const colors=new Set(pixels.filter(p=>p&255)), allowed=new Set(g.palette);
  if(!colors.size) errors.push('Ảnh trống.');
  if(g.options.paletteMode==='asset' && [...colors].some(c=>!allowed.has(c))) errors.push('Có màu ngoài palette khóa.');
  if(g.options.paletteMode==='auto16' && colors.size>16) errors.push('Vượt ngân sách 16 màu đã chọn.');
  const shape=parts&&record.plan.poseSpec?
    {shapeParts:parts,shapeFindings:inspectCharacterPose(record.plan.poseSpec,parts,pixels,g.w,g.h)}:{};
  const sample:FigureSample={...record,...shape,id,pixels,errors,previewAt:Date.now(),warnings,...(record.approved?{restored}:{})};
  save(file(dir,id,'.sample'),sample);return sample;
}
