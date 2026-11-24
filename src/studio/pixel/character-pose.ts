import { Img } from '../../core/image.ts';
import { dataArray, dataName, dataNumber, dataObject } from '../quality/data.ts';

export const poseParts = ['head', 'torso', 'hips', 'near_arm', 'far_arm', 'near_leg', 'far_leg', 'prop'] as const;
export type PosePart = typeof poseParts[number];
const landmarkParts = {
  head: 'head', nearShoulder: 'torso', farShoulder: 'torso', torso: 'torso', hips: 'hips',
  nearElbow: 'near_arm', farElbow: 'far_arm', nearWrist: 'near_arm', farWrist: 'far_arm',
  nearKnee: 'near_leg', farKnee: 'far_leg', nearAnkle: 'near_leg', farAnkle: 'far_leg',
} as const;
export type PoseLandmark = keyof typeof landmarkParts;
type Point = { x: number; y: number };
type Region = Point & { w: number; h: number };
type Landmark = Point & { occludedBy?: PosePart };
export interface CharacterPoseSpec {
  version: 1;
  camera: 'front' | 'side' | 'three-quarter' | 'top-down';
  facing: 'left' | 'right' | 'front' | 'back';
  stylization: string;
  order: PosePart[];
  landmarks: Partial<Record<PoseLandmark, Landmark>>;
  bounds?: Partial<Record<PosePart, Region>>;
  support: Point & { part: 'near_leg' | 'far_leg' };
  grip?: Point & { wrist: 'nearWrist' | 'farWrist' };
  gaps?: Region[];
}
export interface CharacterShapeFinding {
  type: 'landmark' | 'ground-contact' | 'grip' | 'negative-space' | 'part-bounds';
  severity: 'major' | 'minor';
  region: Region;
  evidence: string;
  stage: 'shape';
  action: string;
  confidence: 'high' | 'medium';
}
export type PoseRasters = Partial<Record<PosePart, Uint32Array>>;
const oneOf = <T extends string>(value: unknown, choices: readonly T[], name: string): T => {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw Error('Giá trị không hợp lệ: ' + name);
  return value as T;
};
const present = (value: unknown, keys: readonly string[]) => keys.filter(key => value && Object.hasOwn(value,key));

export function validateCharacterPose(value: unknown, w: number, h: number): CharacterPoseSpec {
  if (Math.min(w,h)<32 || Math.max(w,h)>128) throw Error('Mốc dáng hỗ trợ canvas 32–128 px.');
  const raw = dataObject(value, ['version','camera','facing','stylization','order','landmarks','support',
    ...present(value,['bounds','grip','gaps'])], 'PoseSpec');
  if (raw.version !== 1) throw Error('PoseSpec cần version 1.');
  const point = (p: Record<string, unknown>): Point => ({
    x: dataNumber(p.x, 0, w - 1, 'X của mốc', true), y: dataNumber(p.y, 0, h - 1, 'Y của mốc', true),
  });
  const region = (r: unknown): Region => {
    const o = dataObject(r, ['x','y','w','h'], 'Vùng dáng');
    const p = point(o);
    return { ...p, w: dataNumber(o.w, 1, w-p.x, 'Rộng', true), h: dataNumber(o.h, 1, h-p.y, 'Cao', true) };
  };
  const order = dataArray(raw.order, 3, poseParts.length, 'Thứ tự bộ phận')
    .map(p => oneOf(p, poseParts, 'bộ phận'));
  if (new Set(order).size !== order.length || !order.includes('head') || !order.includes('torso'))
    throw Error('Thứ tự cần đầu, thân và các bộ phận khác nhau.');
  const landmarks: CharacterPoseSpec['landmarks'] = {};
  const source = dataObject(raw.landmarks, present(raw.landmarks,Object.keys(landmarkParts)), 'Mốc dáng');
  if (Math.max(w,h)<=32 && Object.keys(source).length>7) throw Error('Ở 32 px giữ tối đa 7 mốc chính.');
  for (const name of Object.keys(source) as PoseLandmark[]) {
    const o = dataObject(source[name], ['x','y',...present(source[name],['occludedBy'])], 'Mốc '+name);
    const part = landmarkParts[name];
    if (!order.includes(part)) throw Error('Thiếu bộ phận của mốc '+name);
    const occludedBy = o.occludedBy === undefined ? undefined : oneOf(o.occludedBy, order, 'lớp che');
    if (occludedBy && order.indexOf(occludedBy)<=order.indexOf(part)) throw Error('Lớp che phải nằm trước bộ phận bị che.');
    landmarks[name] = { ...point(o), ...(occludedBy ? {occludedBy} : {}) };
  }
  if (!landmarks.head || !landmarks.torso) throw Error('Cần mốc đầu và giữa thân.');
  const contact = dataObject(raw.support, ['x','y','part'], 'Chân trụ');
  const supportPart = oneOf(contact.part, ['near_leg','far_leg'] as const, 'chân trụ');
  if (!order.includes(supportPart)) throw Error('Thiếu lớp chân trụ.');
  let grip: CharacterPoseSpec['grip'];
  if (raw.grip !== undefined) {
    const o = dataObject(raw.grip, ['x','y','wrist'], 'Tay nắm đạo cụ');
    const wrist = oneOf(o.wrist, ['nearWrist','farWrist'] as const, 'tay nắm');
    if (!landmarks[wrist] || !order.includes('prop')) throw Error('Điểm nắm cần đạo cụ và mốc cổ tay.');
    grip = { ...point(o), wrist };
  }
  const bounds: CharacterPoseSpec['bounds'] = {};
  if(raw.bounds!==undefined) for(const [part, value] of Object.entries(dataObject(raw.bounds, present(raw.bounds,order), 'Vùng bộ phận')))
    bounds[part as PosePart] = region(value);
  const gaps = raw.gaps === undefined ? undefined : dataArray(raw.gaps, 0, 6, 'Khoảng âm').map(region);
  return {
    version:1, camera:oneOf(raw.camera,['front','side','three-quarter','top-down'],'góc nhìn'),
    facing:oneOf(raw.facing,['left','right','front','back'],'hướng mặt'),
    stylization:dataName(raw.stylization, 'Tỷ lệ và phong cách'),
    order,landmarks,support:{...point(contact),part:supportPart},
    ...(Object.keys(bounds).length ? {bounds} : {}), ...(grip ? {grip} : {}), ...(gaps ? {gaps} : {}),
  };
}

export function posePartName(part: PosePart) { return '_pose_' + part; }

/** Editable examples in proportional canvas coordinates, not generation defaults. */
export function exampleCharacterPose(w: number, h: number, withProp = true): CharacterPoseSpec {
  const point=(x:number,y:number): Point=>({x:Math.round(x*(w-1)),y:Math.round(y*(h-1))});
  const region=(left:number,top:number,right:number,bottom:number):Region=>{
    const a=point(left,top), b=point(right,bottom);
    return {...a,w:b.x-a.x+1,h:b.y-a.y+1};
  };
  const landmarks: CharacterPoseSpec['landmarks'] = withProp ? {
    head:point(.52,.24),torso:point(.49,.42),hips:point(.47,.61),
    nearWrist:point(.66,.49),farWrist:point(.33,.49),nearAnkle:point(.58,.83),farAnkle:point(.34,.79),
  } : {
    head:point(.46,.24),torso:point(.49,.43),hips:point(.51,.61),
    nearWrist:point(.54,.53),farWrist:point(.30,.57),nearAnkle:point(.52,.84),farAnkle:point(.66,.81),
  };
  if(Math.max(w,h)>32) Object.assign(landmarks,withProp ? {
    nearShoulder:point(.54,.37),farShoulder:point(.41,.37),nearElbow:point(.59,.46),farElbow:point(.37,.43),
    nearKnee:point(.54,.71),farKnee:point(.37,.69),
  } : {
    nearShoulder:point(.50,.37),farShoulder:point(.43,.38),nearElbow:point(.61,.47),farElbow:point(.34,.47),
    nearKnee:point(.53,.72),farKnee:point(.64,.71),
  });
  return validateCharacterPose({
    version:1,camera:'three-quarter',facing:withProp?'right':'left',
    stylization:withProp?'Compact adventure-game proportions':'Rounded upper body and a relaxed stance',
    order:['far_arm','far_leg','near_leg','hips','torso','head',...(withProp?['prop']:[]),'near_arm'],
    landmarks,
    support:{...point(withProp?.60:.53,.88),part:'near_leg'},
    ...(withProp?{ grip:{...point(.67,.49),wrist:'nearWrist'},bounds:{prop:region(.61,.33,.85,.78)} }:{}),
    gaps:withProp?[region(.44,.74,.49,.81),region(.64,.55,.68,.62)]:[region(.57,.77,.59,.83),region(.33,.50,.36,.56)],
  },w,h);
}

export function poseGuide(spec: CharacterPoseSpec, w: number, h: number) {
  const img=new Img(w,h);
  const line=(a:Point|undefined,b:Point|undefined,ink:number)=>{
    if(!a||!b)return;
    const count=Math.max(1,Math.abs(b.x-a.x),Math.abs(b.y-a.y));
    for(let i=0;i<=count;i++)img.set(Math.round(a.x+(b.x-a.x)*i/count),Math.round(a.y+(b.y-a.y)*i/count),ink);
  };
  const m=spec.landmarks, bone=0x6e81aeff;
  line(m.head,m.torso,bone);
  line(m.torso,m.hips,bone);
  for(const side of ['near','far'] as const){
    const shoulder=m[`${side}Shoulder`]??m.torso, elbow=m[`${side}Elbow`], wrist=m[`${side}Wrist`];
    const knee=m[`${side}Knee`], ankle=m[`${side}Ankle`];
    line(m.torso,shoulder,bone);line(shoulder,elbow??wrist,bone);line(elbow,wrist,bone);
    line(m.hips,knee??ankle,bone);line(knee,ankle,bone);
  }
  line(spec.support.part==='near_leg'?m.nearAnkle:m.farAnkle,spec.support,bone);
  for(const p of Object.values(m))img.set(p.x,p.y,0xffd588ff);
  img.set(spec.support.x,spec.support.y,0x6ff2b7ff);
  if(spec.grip)img.set(spec.grip.x,spec.grip.y,0xff78a0ff);
  return img;
}

export function composePose(spec: CharacterPoseSpec, parts: PoseRasters, length: number) {
  const pixels = new Uint32Array(length);
  for (const part of spec.order) {
    const layer = parts[part];
    if (!layer || layer.length !== length) throw Error('Thiếu lớp dáng ' + part);
    for(let i=0;i<length;i++) if(layer[i]&255) pixels[i]=layer[i];
  }
  return pixels;
}

export function movePosePart(source: Uint32Array, w: number, h: number, dx: number, dy: number) {
  dataNumber(dx, 1-w, w-1, 'Dịch X', true);
  dataNumber(dy, 1-h, h-1, 'Dịch Y', true);
  const result = new Uint32Array(source.length);
  for(let i=0;i<source.length;i++){
    if(!(source[i]&255)) continue;
    const x=i%w+dx, y=Math.floor(i/w)+dy;
    if(x<0||x>=w||y<0||y>=h) throw Error('Dịch bộ phận sẽ cắt hình ở mép canvas.');
    result[y*w+x]=source[i];
  }
  return result;
}

export function inspectCharacterPose(spec: CharacterPoseSpec, parts: PoseRasters, pixels: Uint32Array, w: number, h: number) {
  const findings: CharacterShapeFinding[]=[];
  const radius = Math.max(1, Math.round(Math.max(w,h)/40));
  const around = (p: Point, r = radius): Region => {
    const x=Math.max(0,p.x-r),y=Math.max(0,p.y-r);
    return {x,y,w:Math.min(w,p.x+r+1)-x,h:Math.min(h,p.y+r+1)-y};
  };
  const indices = function*(r:Region) {
    for(let y=r.y;y<r.y+r.h;y++) for(let x=r.x;x<r.x+r.w;x++) yield y*w+x;
  };
  const occupied = (part: PosePart, i: number) => Boolean((parts[part]?.[i] ?? 0)&255);
  const neighbors = (i:number) => [
    i%w>0?i-1:-1, i%w<w-1?i+1:-1, i-w, i+w,
  ];
  const add = (type: CharacterShapeFinding['type'], region: Region, evidence: string, action: string, medium = false) =>
    findings.push({type,region,evidence,action,stage:'shape',severity:medium?'minor':'major',confidence:medium?'medium':'high'});
  for(const name of Object.keys(spec.landmarks) as PoseLandmark[]){
    const p=spec.landmarks[name]!, part=landmarkParts[name], r=around(p);
    const touches=[...indices(r)].some(i=>occupied(part,i));
    if(!touches) add('landmark',r,'Không thấy lớp '+part+' quanh '+name+'.','Xem lại vị trí mốc hoặc dịch bộ phận.');
    else if(p.occludedBy && ![...indices(r)].some(i=>occupied(part,i)&&occupied(p.occludedBy!,i)))
      add('landmark',r,'Lớp che đã khai báo không chồng lên bộ phận quanh '+name+'.','Xem lại thứ tự che khuất hoặc vị trí mốc.',true);
  }
  const foot = spec.support, contact=around(foot);
  const sole=[...indices(contact)].filter(i=>occupied(foot.part,i)&&!occupied(foot.part,i+w));
  if(!sole.length) add('ground-contact',contact,'Không thấy mép dưới lớp chân trụ gần mốc chạm đất.','So mốc đế với chân trụ hoặc dịch chân.');
  else {
    const visited=new Set(sole), queue=[...sole];
    let connects=false;
    for(let n=0;n<queue.length&&!connects;n++){
      const i=queue[n], adjacent=neighbors(i);
      connects=[i,...adjacent].some(p=>occupied('hips',p)||occupied('torso',p));
      for(const p of adjacent) if(occupied(foot.part,p)&&!visited.has(p)){
        visited.add(p);queue.push(p);
      }
    }
    if(!connects) add('ground-contact',contact,'Không tìm thấy đường pixel nối đế trụ với hông hoặc thân.','Kiểm tra chỗ nối và các đoạn chỉ chạm chéo.',true);
  }
  if(spec.grip){
    const grip=spec.grip, r=around(grip), hand=landmarkParts[grip.wrist];
    const meet=[...indices(r)].some(i=>occupied(hand,i) && [i,...neighbors(i)].some(p=>occupied('prop',p)));
    if(!meet) add('grip',r,'Tay và đạo cụ không chạm nhau quanh điểm nắm.','Dịch đạo cụ hoặc tay vào mốc nắm.');
  }
  for(const r of spec.gaps ?? []) {
    const clear=[...indices(r)].filter(i=>!(pixels[i]&255)).length;
    if(clear===0) add('negative-space',r,'Khoảng âm dự kiến bị lấp hết.','Xem lại hướng chồng lớp hoặc dịch bộ phận.',true);
  }
  for(const part of spec.order){
    const r=spec.bounds?.[part];
    if(!r) continue;
    const actual=new Img(w,h,parts[part]).bounds();
    if(actual&&(actual.x<r.x-radius||actual.y<r.y-radius||actual.x+actual.w>r.x+r.w+radius||actual.y+actual.h>r.y+r.h+radius))
      add('part-bounds',r,'Lớp '+part+' vượt vùng dự kiến.','Đối chiếu với phối cảnh và độ lớn dự định.',true);
  }
  return findings;
}
