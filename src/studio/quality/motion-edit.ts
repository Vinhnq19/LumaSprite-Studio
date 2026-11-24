import {
  invalidData as fail,
  dataObject as obj,
  dataArray as arr,
  dataNumber as num,
  dataId as id,
  dataBoolean as bool,
  dataUnique as unique,
} from './data.ts';
import {
  validateAssetRecipe,
  type AssetRecipe,
  type RecipeContext,
  type RecipePoint,
  type RecipeFrame,
} from './recipe.ts';
import {
  validateMotionRig,
  validateMotionPlan,
  parseMotionContact,
  type MotionRig,
  type MotionPlan,
  type MotionJoint,
  type MotionSocket,
  type MotionPartBinding,
  type MotionChain,
  type MotionFrame,
  type MotionContact,
} from './motion.ts';

export interface MotionEdit {
  recipe: AssetRecipe;
  rig: MotionRig;
  plan: MotionPlan;
}

export interface FrameAddPayload {
  id: string;
  afterId: string | null;
  copyFrom: string | null;
  durationMs: number;
}

export interface FrameMovePayload {
  id: string;
  afterId: string | null;
}

export interface PlanConfigurePayload {
  action?: MotionPlan['action'];
  loop?: boolean;
  rootMotion?: boolean;
}

export type MotionEditCommand =
  | { type: 'joint.add' | 'joint.update'; joint: MotionJoint }
  | { type: 'joint.remove' | 'socket.remove' | 'chain.remove' | 'frame.remove'; id: string }
  | { type: 'socket.set'; socket: MotionSocket }
  | { type: 'binding.set'; binding: MotionPartBinding }
  | { type: 'chain.set'; chain: MotionChain }
  | { type: 'frame.set'; frame: MotionFrame }
  | ({ type: 'frame.add' } & FrameAddPayload)
  | ({ type: 'frame.move' } & FrameMovePayload)
  | ({ type: 'plan.configure' } & PlanConfigurePayload);

function parsePoint(value: unknown, path: string, w: number, h: number, lo = 0): RecipePoint {
  const p = obj(value, ['x', 'y'], path);
  return {
    x: num(p.x, lo, w, `${path}.x`),
    y: num(p.y, lo, h, `${path}.y`),
  };
}

function parseVector(value: unknown, path: string): { dx: number; dy: number } {
  const p = obj(value, ['dx', 'dy'], path);
  return {
    dx: num(p.dx, -8192, 8192, `${path}.dx`),
    dy: num(p.dy, -8192, 8192, `${path}.dy`),
  };
}

function parseJoint(value: unknown, path: string, w: number, h: number): MotionJoint {
  const p = obj(value, ['id', 'parentId', 'rest', 'minRotation', 'maxRotation'], path);
  return {
    id: id(p.id, `${path}.id`),
    parentId: p.parentId === null ? null : id(p.parentId, `${path}.parentId`),
    rest: parsePoint(p.rest, `${path}.rest`, w, h),
    minRotation: num(p.minRotation, -180, 0, `${path}.minRotation`),
    maxRotation: num(p.maxRotation, 0, 180, `${path}.maxRotation`),
  };
}

function parseSocket(value: unknown, path: string, w: number, h: number): MotionSocket {
  const p = obj(value, ['id', 'jointId', 'rest'], path);
  return {
    id: id(p.id, `${path}.id`),
    jointId: id(p.jointId, `${path}.jointId`),
    rest: parsePoint(p.rest, `${path}.rest`, w, h),
  };
}

function parseBinding(value: unknown, path: string): MotionPartBinding {
  const p = obj(value, ['partId', 'jointId', 'socketId'], path);
  return {
    partId: id(p.partId, `${path}.partId`),
    jointId: id(p.jointId, `${path}.jointId`),
    socketId: p.socketId === null ? null : id(p.socketId, `${path}.socketId`),
  };
}

function parseChain(value: unknown, path: string): MotionChain {
  const p = obj(value, ['id', 'kind', 'rootJointId', 'midJointId', 'endJointId', 'bend', 'contactSocketId'], path);
  if (p.kind !== 'arm' && p.kind !== 'leg') fail(`${path}.kind`, 'loại chuỗi chi không hợp lệ.');
  if (p.bend !== 1 && p.bend !== -1) fail(`${path}.bend`, 'hướng gập phải là 1 hoặc -1.');
  return {
    id: id(p.id, `${path}.id`),
    kind: p.kind,
    rootJointId: id(p.rootJointId, `${path}.rootJointId`),
    midJointId: id(p.midJointId, `${path}.midJointId`),
    endJointId: id(p.endJointId, `${path}.endJointId`),
    bend: p.bend,
    contactSocketId: p.contactSocketId === null ? null : id(p.contactSocketId, `${path}.contactSocketId`),
  };
}

function parseFrame(value: unknown, path: string): MotionFrame {
  const p = obj(value, ['id', 'durationMs', 'root', 'travel', 'rotations', 'order', 'contacts'], path);
  const rotations = arr(p.rotations, 0, 128, `${path}.rotations`).map((v, i) => {
    const r = obj(v, ['jointId', 'degrees'], `${path}.rotations[${i}]`);
    return {
      jointId: id(r.jointId, `${path}.rotations[${i}].jointId`),
      degrees: num(r.degrees, -360, 360, `${path}.rotations[${i}].degrees`),
    };
  });
  unique(rotations.map(r => r.jointId), `${path}.rotations`);
  const order = arr(p.order, 0, 64, `${path}.order`).map((v, i) => id(v, `${path}.order[${i}]`));
  unique(order, `${path}.order`);
  const contacts = arr(p.contacts, 0, 32, `${path}.contacts`).map((v, i): MotionContact => parseMotionContact(v, `${path}.contacts[${i}]`));
  unique(contacts.map(c => c.chainId), `${path}.contacts`);
  return {
    id: id(p.id, `${path}.id`),
    durationMs: num(p.durationMs, 1, 60000, `${path}.durationMs`, true),
    root: parseVector(p.root, `${path}.root`),
    travel: parseVector(p.travel, `${path}.travel`),
    rotations,
    order,
    contacts,
  };
}

function parseFrameAdd(value: unknown, path: string): FrameAddPayload {
  const p = obj(value, ['id', 'afterId', 'copyFrom', 'durationMs'], path);
  return {
    id: id(p.id, `${path}.id`),
    afterId: p.afterId === null ? null : id(p.afterId, `${path}.afterId`),
    copyFrom: p.copyFrom === null ? null : id(p.copyFrom, `${path}.copyFrom`),
    durationMs: num(p.durationMs, 1, 60000, `${path}.durationMs`, true),
  };
}

function parseFrameMove(value: unknown, path: string): FrameMovePayload {
  const p = obj(value, ['id', 'afterId'], path);
  return {
    id: id(p.id, `${path}.id`),
    afterId: p.afterId === null ? null : id(p.afterId, `${path}.afterId`),
  };
}

const ALLOWED_CONFIG_KEYS = new Set(['action', 'loop', 'rootMotion']);

function parsePlanConfigure(value: unknown, path: string): PlanConfigurePayload {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, 'phải là object thuần.');
  }
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length === 0) fail(path, 'cần ít nhất một thuộc tính cấu hình.');
  for (const k of own) {
    if (typeof k !== 'string' || !ALLOWED_CONFIG_KEYS.has(k) || !descriptors[k] || !('value' in descriptors[k])) {
      fail(path, 'thuộc tính không được hỗ trợ hoặc có getter.');
    }
  }
  const rec = value as Record<string, unknown>;
  const res: PlanConfigurePayload = {};
  if ('action' in rec) {
    if (!['idle', 'walk', 'run', 'jump', 'attack', 'custom'].includes(rec.action as string)) {
      fail(`${path}.action`, 'hành động không hợp lệ.');
    }
    res.action = rec.action as MotionPlan['action'];
  }
  if ('loop' in rec) {
    res.loop = bool(rec.loop, `${path}.loop`);
  }
  if ('rootMotion' in rec) {
    res.rootMotion = bool(rec.rootMotion, `${path}.rootMotion`);
  }
  return res;
}

interface NormalizedCommand {
  type: string;
  joint?: MotionJoint;
  socket?: MotionSocket;
  binding?: MotionPartBinding;
  chain?: MotionChain;
  frame?: MotionFrame;
  frameAdd?: FrameAddPayload;
  frameMove?: FrameMovePayload;
  planConfig?: PlanConfigurePayload;
  id?: string;
}

function parseCommand(raw: unknown, path: string, w: number, h: number): NormalizedCommand {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(path, 'phải là object thuần.');
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'type');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') fail(path, 'thiếu loại lệnh hợp lệ.');
  const type = descriptor.value;
  switch (type) {
    case 'joint.add': case 'joint.update': {
      const c = obj(raw, ['type', 'joint'], path); return { type, joint: parseJoint(c.joint, path, w, h) };
    }
    case 'socket.set': {
      const c = obj(raw, ['type', 'socket'], path); return { type, socket: parseSocket(c.socket, path, w, h) };
    }
    case 'binding.set': {
      const c = obj(raw, ['type', 'binding'], path); return { type, binding: parseBinding(c.binding, path) };
    }
    case 'chain.set': {
      const c = obj(raw, ['type', 'chain'], path); return { type, chain: parseChain(c.chain, path) };
    }
    case 'frame.set': {
      const c = obj(raw, ['type', 'frame'], path); return { type, frame: parseFrame(c.frame, path) };
    }
    case 'frame.add': {
      const c = obj(raw, ['type', 'id', 'afterId', 'copyFrom', 'durationMs'], path);
      return { type, frameAdd: parseFrameAdd({ id: c.id, afterId: c.afterId, copyFrom: c.copyFrom, durationMs: c.durationMs }, path) };
    }
    case 'frame.move': {
      const c = obj(raw, ['type', 'id', 'afterId'], path); return { type, frameMove: parseFrameMove({ id: c.id, afterId: c.afterId }, path) };
    }
    case 'joint.remove': case 'socket.remove': case 'chain.remove': case 'frame.remove': {
      const c = obj(raw, ['type', 'id'], path); return { type, id: id(c.id, path) };
    }
    case 'plan.configure': {
      const keys = Reflect.ownKeys(raw).filter(k => k !== 'type');
      if (!keys.length || keys.some(k => typeof k !== 'string' || !ALLOWED_CONFIG_KEYS.has(k))) fail(path, 'thuộc tính cấu hình không được hỗ trợ.');
      const c = obj(raw, ['type', ...keys as string[]], path);
      return { type, planConfig: parsePlanConfigure(Object.fromEntries(keys.map(k => [k, c[k as string]])), path) };
    }
    default: return fail(path, `loại lệnh ${type} không được hỗ trợ.`);
  }
}

function moveItem<T extends { id: string }>(items: T[], targetId: string, afterId: string | null): T[] {
  if (targetId === afterId) return [...items];
  const itemIndex = items.findIndex(f => f.id === targetId);
  if (itemIndex === -1) fail('Frame', `không tìm thấy frame ${targetId}.`);
  const item = items[itemIndex];
  const without = items.filter((_, i) => i !== itemIndex);
  if (afterId === null) {
    return [item, ...without];
  }
  const afterIndex = without.findIndex(f => f.id === afterId);
  if (afterIndex === -1) fail('Frame', `không tìm thấy afterId ${afterId}.`);
  return [...without.slice(0, afterIndex + 1), item, ...without.slice(afterIndex + 1)];
}

export function validateMotionEdit(value: unknown, context: RecipeContext = { sources: [], masks: [] }): MotionEdit {
  const root = obj(value, ['recipe', 'rig', 'plan'], 'MotionEdit');
  const recipe = validateAssetRecipe(root.recipe, context);
  const rig = validateMotionRig(root.rig, recipe);
  const plan = validateMotionPlan(root.plan, rig, recipe);
  return { recipe, rig, plan };
}

export function applyMotionEdits(value: unknown, commands: unknown, context: RecipeContext = { sources: [], masks: [] }): MotionEdit {
  const initial = validateMotionEdit(value, context);
  const cmdRawList = arr(commands, 1, 100, 'Lệnh motion-edit');
  const { w, h } = initial.recipe.canvas;
  const parsedCommands = cmdRawList.map((c, i) => parseCommand(c, `Lệnh[${i}]`, w, h));

  const working: MotionEdit = structuredClone(initial);

  for (let i = 0; i < parsedCommands.length; i++) {
    const cmd = parsedCommands[i];
    const path = `Lệnh[${i}]`;
    switch (cmd.type) {
      case 'joint.add': {
        const joint = cmd.joint!;
        if (working.rig.joints.some(j => j.id === joint.id)) {
          fail(path, `ID khớp ${joint.id} đã tồn tại.`);
        }
        working.rig.joints.push(joint);
        break;
      }
      case 'joint.update': {
        const joint = cmd.joint!;
        const idx = working.rig.joints.findIndex(j => j.id === joint.id);
        if (idx === -1) {
          fail(path, `Không tìm thấy khớp ${joint.id}.`);
        }
        working.rig.joints[idx] = joint;
        break;
      }
      case 'joint.remove': {
        const targetId = cmd.id!;
        const idx = working.rig.joints.findIndex(j => j.id === targetId);
        if (idx === -1) {
          fail(path, `Không tìm thấy khớp ${targetId}.`);
        }
        working.rig.joints.splice(idx, 1);
        break;
      }
      case 'socket.set': {
        const socket = cmd.socket!;
        const idx = working.rig.sockets.findIndex(s => s.id === socket.id);
        if (idx !== -1) {
          working.rig.sockets[idx] = socket;
        } else {
          working.rig.sockets.push(socket);
        }
        break;
      }
      case 'socket.remove': {
        const targetId = cmd.id!;
        const idx = working.rig.sockets.findIndex(s => s.id === targetId);
        if (idx === -1) {
          fail(path, `Không tìm thấy điểm gắn ${targetId}.`);
        }
        working.rig.sockets.splice(idx, 1);
        break;
      }
      case 'binding.set': {
        const binding = cmd.binding!;
        const idx = working.rig.bindings.findIndex(b => b.partId === binding.partId);
        if (idx !== -1) {
          working.rig.bindings[idx] = binding;
        } else {
          working.rig.bindings.push(binding);
        }
        break;
      }
      case 'chain.set': {
        const chain = cmd.chain!;
        const idx = working.rig.chains.findIndex(c => c.id === chain.id);
        if (idx !== -1) {
          working.rig.chains[idx] = chain;
        } else {
          working.rig.chains.push(chain);
        }
        break;
      }
      case 'chain.remove': {
        const targetId = cmd.id!;
        const idx = working.rig.chains.findIndex(c => c.id === targetId);
        if (idx === -1) {
          fail(path, `Không tìm thấy chuỗi chi ${targetId}.`);
        }
        working.rig.chains.splice(idx, 1);
        for (const frame of working.plan.frames) {
          frame.contacts = frame.contacts.filter(c => c.chainId !== targetId);
        }
        break;
      }
      case 'frame.set': {
        const frame = cmd.frame!;
        const planIdx = working.plan.frames.findIndex(f => f.id === frame.id);
        const recipeIdx = working.recipe.frames.findIndex(f => f.id === frame.id);
        if (planIdx === -1 || recipeIdx === -1) {
          fail(path, `Không tìm thấy frame ${frame.id}.`);
        }
        working.plan.frames[planIdx] = frame;
        working.recipe.frames[recipeIdx].durationMs = frame.durationMs;
        break;
      }
      case 'frame.add': {
        const add = cmd.frameAdd!;
        if (working.plan.frames.some(f => f.id === add.id) || working.recipe.frames.some(f => f.id === add.id)) {
          fail(path, `ID frame ${add.id} đã tồn tại.`);
        }
        if (add.afterId !== null && !working.plan.frames.some(f => f.id === add.afterId)) {
          fail(path, `Không tìm thấy afterId ${add.afterId}.`);
        }
        if (add.copyFrom !== null && !working.plan.frames.some(f => f.id === add.copyFrom)) {
          fail(path, `Không tìm thấy copyFrom ${add.copyFrom}.`);
        }
        const newRecipeFrame: RecipeFrame = add.copyFrom === null
          ? {
              id: add.id,
              durationMs: add.durationMs,
              poses: [],
            }
          : {
              ...structuredClone(working.recipe.frames.find(f => f.id === add.copyFrom)!),
              id: add.id,
              durationMs: add.durationMs,
            };
        let newPlanFrame: MotionFrame;
        if (add.copyFrom !== null) {
          const src = working.plan.frames.find(f => f.id === add.copyFrom)!;
          newPlanFrame = {
            id: add.id,
            durationMs: add.durationMs,
            root: { ...src.root },
            travel: { ...src.travel },
            rotations: src.rotations.map(r => ({ ...r })),
            order: [...src.order],
            contacts: src.contacts.map(c => ({
              ...c,
              target: c.target ? { ...c.target } : null,
            })),
          };
        } else {
          newPlanFrame = {
            id: add.id,
            durationMs: add.durationMs,
            root: { dx: 0, dy: 0 },
            travel: { dx: 0, dy: 0 },
            rotations: [],
            order: working.recipe.parts.map(p => p.id),
            contacts: [],
          };
        }
        const insertIdx = add.afterId === null ? 0 : working.plan.frames.findIndex(f => f.id === add.afterId) + 1;
        working.recipe.frames.splice(insertIdx, 0, newRecipeFrame);
        working.plan.frames.splice(insertIdx, 0, newPlanFrame);
        break;
      }
      case 'frame.remove': {
        const targetId = cmd.id!;
        if (working.recipe.frames.length <= 1) {
          fail(path, 'Cần giữ ít nhất 1 frame.');
        }
        const planIdx = working.plan.frames.findIndex(f => f.id === targetId);
        const recipeIdx = working.recipe.frames.findIndex(f => f.id === targetId);
        if (planIdx === -1 || recipeIdx === -1) {
          fail(path, `Không tìm thấy frame ${targetId}.`);
        }
        working.recipe.frames.splice(recipeIdx, 1);
        working.plan.frames.splice(planIdx, 1);
        break;
      }
      case 'frame.move': {
        const move = cmd.frameMove!;
        if (!working.plan.frames.some(f => f.id === move.id)) {
          fail(path, `Không tìm thấy frame ${move.id}.`);
        }
        if (move.afterId !== null && !working.plan.frames.some(f => f.id === move.afterId)) {
          fail(path, `Không tìm thấy afterId ${move.afterId}.`);
        }
        working.recipe.frames = moveItem(working.recipe.frames, move.id, move.afterId);
        working.plan.frames = moveItem(working.plan.frames, move.id, move.afterId);
        break;
      }
      case 'plan.configure': {
        const config = cmd.planConfig!;
        if (config.action !== undefined) {
          working.plan.action = config.action;
        }
        if (config.loop !== undefined) {
          working.plan.loop = config.loop;
          working.recipe.loop = config.loop;
        }
        if (config.rootMotion !== undefined) {
          working.plan.rootMotion = config.rootMotion;
        }
        break;
      }
    }
  }

  return validateMotionEdit(working, context);
}
