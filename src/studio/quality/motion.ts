import type { AssetRecipe, RecipePoint } from './recipe.ts';
import { dataObject as obj, dataArray as arr, dataNumber as num, dataId as id, dataBoolean as bool, dataUnique as unique, invalidData as fail } from './data.ts';

export interface MotionSource {
  projectId: string; assetId: string; frameId: string; revision: number; rgbaSha256: string;
  canvas: { w: number; h: number }; pivot: RecipePoint;
}
export interface MotionJoint { id: string; parentId: string | null; rest: RecipePoint; minRotation: number; maxRotation: number }
export interface MotionSocket { id: string; jointId: string; rest: RecipePoint }
export interface MotionPartBinding { partId: string; jointId: string; socketId: string | null }
export interface MotionChain {
  id: string; kind: 'arm' | 'leg'; rootJointId: string; midJointId: string; endJointId: string;
  bend: 1 | -1; contactSocketId: string | null;
}
export interface MotionRig { version: 1; id: string; source: MotionSource; joints: MotionJoint[]; sockets: MotionSocket[]; bindings: MotionPartBinding[]; chains: MotionChain[] }
export interface MotionContact { chainId: string; phase: 'stance' | 'swing'; target: RecipePoint | null; contactSocketId?: string | null }
export interface MotionFrame {
  id: string; durationMs: number; root: { dx: number; dy: number }; travel: { dx: number; dy: number };
  rotations: { jointId: string; degrees: number }[]; order: string[]; contacts: MotionContact[];
}
export interface MotionPlan { version: 1; id: string; rigId: string; action: 'idle' | 'walk' | 'run' | 'jump' | 'attack' | 'custom'; loop: boolean; rootMotion: boolean; frames: MotionFrame[] }
export const MAX_MOTION_JOINTS = 128;
export const MAX_MOTION_CHAINS = 32;
function point(value: unknown, path: string, w: number, h: number, lo = 0): RecipePoint {
  const p = obj(value, ['x', 'y'], path);
  return { x: num(p.x, lo, w, path), y: num(p.y, lo, h, path) };
}
function vector(value: unknown, path: string): { dx: number; dy: number } {
  const p = obj(value, ['dx', 'dy'], path);
  return { dx: num(p.dx, -8192, 8192, path), dy: num(p.dy, -8192, 8192, path) };
}
function samePoint(a: RecipePoint, b: RecipePoint): boolean { return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9; }

/** Missing override retains old chain semantics; explicit null selects the ankle joint. */
export function parseMotionContact(value: unknown, path = 'Pha chân'): MotionContact {
  const override = value !== null && typeof value === 'object' && Object.hasOwn(value, 'contactSocketId');
  const c = obj(value, ['chainId', 'phase', 'target', ...(override ? ['contactSocketId'] : [])], path);
  if (c.phase !== 'stance' && c.phase !== 'swing') fail(path, 'pha tiếp đất không hợp lệ.');
  if (c.phase === 'swing' && c.target !== null) fail(path, 'pha vung chân không có mục tiêu tiếp đất.');
  return { chainId: id(c.chainId, path), phase: c.phase,
    target: c.phase === 'stance' ? point(c.target, path, 16384, 16384, -16384) : null,
    ...(override ? { contactSocketId: c.contactSocketId === null ? null : id(c.contactSocketId, path) } : {}) };
}

/** recipe must first pass validateAssetRecipe with its captured source descriptors. No approval is inferred here. */
export function validateMotionRig(value: unknown, recipe: AssetRecipe): MotionRig {
  const r = obj(value, ['version', 'id', 'source', 'joints', 'sockets', 'bindings', 'chains'], 'MotionRig');
  if (r.version !== 1) fail('MotionRig', 'chỉ hỗ trợ phiên bản 1.');
  const s = obj(r.source, ['projectId', 'assetId', 'frameId', 'revision', 'rgbaSha256', 'canvas', 'pivot'], 'Nguồn rig');
  const canvas = obj(s.canvas, ['w', 'h'], 'Canvas nguồn rig');
  const w = num(canvas.w, 1, 4096, 'Canvas nguồn rig', true), h = num(canvas.h, 1, 4096, 'Canvas nguồn rig', true);
  if (w !== recipe.canvas.w || h !== recipe.canvas.h) fail('MotionRig', 'canvas nguồn không khớp recipe.');
  const pivot = point(s.pivot, 'Pivot nguồn rig', w, h);
  if (!samePoint(pivot, recipe.pivot)) fail('MotionRig', 'pivot nguồn không khớp recipe.');
  if (typeof s.rgbaSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.rgbaSha256)) fail('Nguồn rig', 'cần SHA256 RGBA hợp lệ.');
  const source: MotionSource = { projectId: id(s.projectId, 'Dự án nguồn'), assetId: id(s.assetId, 'Asset nguồn'), frameId: id(s.frameId, 'Frame nguồn'), revision: num(s.revision, 0, Number.MAX_SAFE_INTEGER, 'Revision nguồn', true), rgbaSha256: s.rgbaSha256, canvas: { w, h }, pivot };
  const joints = arr(r.joints, 1, MAX_MOTION_JOINTS, 'Khớp').map((v): MotionJoint => {
    const p = obj(v, ['id', 'parentId', 'rest', 'minRotation', 'maxRotation'], 'Khớp');
    return { id: id(p.id, 'ID khớp'), parentId: p.parentId === null ? null : id(p.parentId, 'Cha khớp'), rest: point(p.rest, 'Vị trí khớp', w, h), minRotation: num(p.minRotation, -180, 0, 'Góc khớp tối thiểu'), maxRotation: num(p.maxRotation, 0, 180, 'Góc khớp tối đa') };
  });
  unique(joints.map(j => j.id), 'ID khớp');
  const byJoint = new Map(joints.map(j => [j.id, j]));
  if (joints.filter(j => j.parentId === null).length !== 1) fail('MotionRig', 'cần đúng một khớp gốc.');
  for (const joint of joints) {
    const visited = new Set([joint.id]); let current = joint;
    while (current.parentId !== null) {
      const parent = byJoint.get(current.parentId);
      if (!parent) fail('MotionRig', 'khớp cha không tồn tại.');
      if (visited.has(parent.id)) fail('MotionRig', 'chu trình khớp.');
      if (Math.hypot(current.rest.x - parent.rest.x, current.rest.y - parent.rest.y) < 1e-6) fail('MotionRig', 'chiều dài xương phải lớn hơn 0.');
      visited.add(parent.id); current = parent;
    }
  }
  const sockets = arr(r.sockets, 0, 128, 'Điểm gắn').map((v): MotionSocket => {
    const p = obj(v, ['id', 'jointId', 'rest'], 'Điểm gắn'), jointId = id(p.jointId, 'Khớp điểm gắn');
    if (!byJoint.has(jointId)) fail('MotionRig', 'điểm gắn tham chiếu khớp không tồn tại.');
    return { id: id(p.id, 'ID điểm gắn'), jointId, rest: point(p.rest, 'Vị trí điểm gắn', w, h) };
  });
  unique(sockets.map(s => s.id), 'ID điểm gắn');
  const bySocket = new Map(sockets.map(s => [s.id, s])), byPart = new Map(recipe.parts.map(p => [p.id, p]));
  const bindings = arr(r.bindings, recipe.parts.length, recipe.parts.length, 'Gắn bộ phận').map((v): MotionPartBinding => {
    const p = obj(v, ['partId', 'jointId', 'socketId'], 'Gắn bộ phận'), partId = id(p.partId, 'ID bộ phận'), jointId = id(p.jointId, 'ID khớp');
    if (!byPart.has(partId) || !byJoint.has(jointId)) fail('MotionRig', 'gắn bộ phận/khớp không tồn tại.');
    const socketId = p.socketId === null ? null : id(p.socketId, 'ID điểm gắn');
    if (socketId !== null) {
      const socket = bySocket.get(socketId);
      if (!socket || socket.jointId !== jointId || !samePoint(socket.rest, byPart.get(partId)!.pivot)) fail('MotionRig', 'điểm gắn không khớp khớp hoặc pivot bộ phận.');
    }
    return { partId, jointId, socketId };
  });
  unique(bindings.map(b => b.partId), 'Bộ phận gắn rig');
  const chains = arr(r.chains, 0, MAX_MOTION_CHAINS, 'Chuỗi chi').map((v): MotionChain => {
    const p = obj(v, ['id', 'kind', 'rootJointId', 'midJointId', 'endJointId', 'bend', 'contactSocketId'], 'Chuỗi chi');
    if (p.kind !== 'arm' && p.kind !== 'leg') fail('MotionRig', 'loại chuỗi chi không hợp lệ.');
    const rootJointId = id(p.rootJointId, 'Khớp gốc chi'), midJointId = id(p.midJointId, 'Khớp giữa chi'), endJointId = id(p.endJointId, 'Khớp cuối chi');
    if (!byJoint.has(rootJointId) || byJoint.get(midJointId)?.parentId !== rootJointId || byJoint.get(endJointId)?.parentId !== midJointId) fail('MotionRig', 'chuỗi chi phải nối liên tục gốc–giữa–cuối.');
    if (p.bend !== 1 && p.bend !== -1) fail('MotionRig', 'hướng gập phải là 1 hoặc -1.');
    const contactSocketId = p.contactSocketId === null ? null : id(p.contactSocketId, 'Điểm tiếp đất');
    if (contactSocketId !== null && (p.kind !== 'leg' || bySocket.get(contactSocketId)?.jointId !== endJointId)) fail('MotionRig', 'điểm tiếp đất phải gắn ở khớp cuối chân.');
    return { id: id(p.id, 'ID chuỗi chi'), kind: p.kind, rootJointId, midJointId, endJointId, bend: p.bend, contactSocketId };
  });
  unique(chains.map(c => c.id), 'ID chuỗi chi');
  unique(chains.flatMap(c => [c.midJointId, c.endJointId]), 'Khớp giữa/cuối của các chi');
  for (const chain of chains) {
    if ([chain.rootJointId, chain.midJointId, chain.endJointId].some(j => !bindings.some(b => b.jointId === j))) fail('MotionRig', 'mọi khớp trong chuỗi chi cần bộ phận hình ảnh được gắn, không dùng chi ảo.');
  }
  return { version: 1, id: id(r.id, 'ID rig'), source, joints, sockets, bindings, chains };
}

/** Fixed bone lengths come from the rig; frame data contains rotations, never arbitrary joint positions. */
export function validateMotionPlan(value: unknown, rig: MotionRig, recipe: AssetRecipe): MotionPlan {
  const p = obj(value, ['version', 'id', 'rigId', 'action', 'loop', 'rootMotion', 'frames'], 'MotionPlan');
  if (p.version !== 1 || p.rigId !== rig.id) fail('MotionPlan', 'phiên bản hoặc ID rig không khớp.');
  if (!['idle', 'walk', 'run', 'jump', 'attack', 'custom'].includes(p.action as string)) fail('MotionPlan', 'hành động không hợp lệ.');
  if (bool(p.loop, 'Loop') !== recipe.loop) fail('MotionPlan', 'loop không khớp recipe.');
  const rootMotion = bool(p.rootMotion, 'Root motion'), byJoint = new Map(rig.joints.map(j => [j.id, j])), byChain = new Map(rig.chains.map(c => [c.id, c]));
  const partIds = new Set(recipe.parts.map(p => p.id)), legs = rig.chains.filter(c => c.kind === 'leg');
  const gait = p.action === 'walk' || p.action === 'run';
  if (gait && legs.length < 2) fail('MotionPlan', 'walk/run cần ít nhất hai chuỗi chân và pha tiếp đất.');
  if (gait && recipe.frames.length < 2) fail('MotionPlan', 'walk/run cần ít nhất hai frame.');
  const frames = arr(p.frames, recipe.frames.length, recipe.frames.length, 'Frame chuyển động').map((v, i): MotionFrame => {
    const f = obj(v, ['id', 'durationMs', 'root', 'travel', 'rotations', 'order', 'contacts'], 'Frame chuyển động');
    if (f.id !== recipe.frames[i].id || f.durationMs !== recipe.frames[i].durationMs) fail('MotionPlan', 'ID/thứ tự/timing frame không khớp recipe.');
    const root = vector(f.root, 'Độ nhún thân'), travel = vector(f.travel, 'Root motion');
    if (!rootMotion && (travel.dx !== 0 || travel.dy !== 0)) fail('MotionPlan', 'root motion đang tắt; travel phải bằng 0.');
    const rotations = arr(f.rotations, 0, rig.joints.length, 'Góc frame').map(v => {
      const r = obj(v, ['jointId', 'degrees'], 'Góc khớp'), jointId = id(r.jointId, 'ID khớp'), joint = byJoint.get(jointId);
      if (!joint) fail('MotionPlan', 'góc tham chiếu khớp không tồn tại.');
      return { jointId, degrees: num(r.degrees, joint.minRotation, joint.maxRotation, 'Góc khớp') };
    });
    unique(rotations.map(r => r.jointId), 'Góc khớp frame');
    const order = unique(arr(f.order, partIds.size, partIds.size, 'Thứ tự che khuất').map(v => id(v, 'Bộ phận che khuất')), 'Thứ tự che khuất');
    if (order.some(id => !partIds.has(id))) fail('MotionPlan', 'thứ tự che khuất có bộ phận không tồn tại.');
    const contacts = arr(f.contacts, 0, rig.chains.length, 'Pha chân').map((v): MotionContact => {
      const c = parseMotionContact(v), chain = byChain.get(c.chainId);
      if (chain?.kind !== 'leg') fail('MotionPlan', 'tiếp đất phải tham chiếu chuỗi chân.');
      if (c.contactSocketId !== undefined && c.contactSocketId !== null && !rig.sockets.some(s => s.id === c.contactSocketId && s.jointId === chain.endJointId)) fail('MotionPlan', 'socket tiếp đất ở frame phải thuộc khớp cuối đúng chân.');
      return c;
    });
    unique(contacts.map(c => c.chainId), 'Pha chân');
    if (gait && (contacts.length !== legs.length || legs.some(l => !contacts.some(c => c.chainId === l.id)))) fail('MotionPlan', 'thiếu pha chân của walk/run.');
    if (p.action === 'walk' && !contacts.some(c => c.phase === 'stance')) fail('MotionPlan', 'walk cần ít nhất một chân chống mỗi frame.');
    return { id: f.id as string, durationMs: f.durationMs as number, root, travel, rotations, order, contacts };
  });
  return { version: 1, id: id(p.id, 'ID kế hoạch chuyển động'), rigId: rig.id, action: p.action as MotionPlan['action'], loop: recipe.loop, rootMotion, frames };
}
