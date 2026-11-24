import { validateMotionEdit, type MotionEdit } from './motion-edit.ts';
import { compileMotionRecipe, motionJointMatrices } from './motion-render.ts';
import { solveMotionTarget } from './motion-ik.ts';
import { dataArray, dataBoolean, dataId, dataNumber, dataObject, dataUnique } from './data.ts';
import { point } from './affine.ts';
import type { RecipeContext, RecipePoint } from './recipe.ts';

export interface WalkOptions {
  legIds: [string, string]; armIds: string[]; stridePx: number; liftPx: number; crouchPx: number;
  armSwingDegrees: number; rootMotion: boolean;
}

/** Explicit side-view +X walk draft. Keeps frame IDs/timing; never claims finished pixel animation. */
export function createWalkPlan(value: MotionEdit, options: WalkOptions, context?: RecipeContext): MotionEdit {
  let edit = validateMotionEdit(value, context);
  const raw = dataObject(options, ['legIds', 'armIds', 'stridePx', 'liftPx', 'crouchPx', 'armSwingDegrees', 'rootMotion'], 'Nhịp đi');
  const legs = dataUnique(dataArray(raw.legIds, 2, 2, 'Hai chân').map(v => dataId(v, 'Chuỗi chân')), 'Hai chân');
  const arms = dataUnique(dataArray(raw.armIds, 0, 2, 'Cánh tay').map(v => dataId(v, 'Chuỗi tay')), 'Cánh tay');
  const stride = dataNumber(raw.stridePx, .1, edit.recipe.canvas.w, 'Độ dài bước'), lift = dataNumber(raw.liftPx, 0, edit.recipe.canvas.h, 'Độ nhấc chân');
  const crouch = dataNumber(raw.crouchPx, 0, edit.recipe.canvas.h, 'Hạ hông'), swing = dataNumber(raw.armSwingDegrees, 0, 90, 'Biên độ tay');
  const rootMotion = dataBoolean(raw.rootMotion, 'Root motion');
  for (const [ids, kind] of [[legs, 'leg'], [arms, 'arm']] as const) {
    for (const id of ids) if (edit.rig.chains.find(c => c.id === id)?.kind !== kind) throw Error('Chọn đúng chuỗi tay/chân đã gắn bộ phận hình ảnh.');
  }
  if (edit.rig.chains.filter(c => c.kind === 'leg').length !== 2) throw Error('Nhịp đi này chỉ hỗ trợ rig hai chân.');
  if (edit.plan.frames.length < 4 || edit.plan.frames.length > 24) throw Error('Nhịp đi cần từ 4 đến 24 frame. Thêm frame trên timeline trước.');
  const total = edit.plan.frames.reduce((n, f) => n + f.durationMs, 0), restFrame = { ...edit.plan.frames[0], root: { dx: 0, dy: 0 }, travel: { dx: 0, dy: 0 }, rotations: [] };
  const rest = motionJointMatrices(edit.rig, restFrame);
  const feet = legs.map(id => {
    const chain = edit.rig.chains.find(c => c.id === id)!, joint = edit.rig.joints.find(j => j.id === chain.endJointId)!;
    const socket = edit.rig.sockets.find(s => s.id === chain.contactSocketId), p = socket?.rest ?? joint.rest;
    const [x, y] = point(rest.get(joint.id)!, p.x, p.y); return { x, y };
  });
  if (Math.abs(feet[0].y - feet[1].y) > 1) throw Error('Hai điểm tiếp đất ở tư thế nghỉ lệch trên 1 px. Chỉnh nguồn/rig trước khi tạo nhịp đi.');
  edit.recipe.loop = true; edit.plan.loop = true; edit.plan.rootMotion = rootMotion; edit.plan.action = 'custom';
  const targets: { frameId: string; chainId: string; target: RecipePoint }[] = [];
  let elapsed = 0;
  for (const frame of edit.plan.frames) {
    const phase = elapsed / total;
    frame.root = { dx: 0, dy: crouch + lift * .15 * Math.sin(phase * Math.PI * 2) ** 2 };
    frame.travel = { dx: rootMotion ? 2 * stride * phase : 0, dy: 0 };
    frame.rotations = []; frame.contacts = [];
    for (let i = 0; i < arms.length; i++) {
      const chain = edit.rig.chains.find(c => c.id === arms[i])!;
      frame.rotations.push({ jointId: chain.rootJointId, degrees: swing * Math.cos(phase * Math.PI * 2 + i * Math.PI) });
    }
    for (let i = 0; i < legs.length; i++) {
      const t = (phase + i * .5) % 1, stance = t < .5, step = stance ? t * 2 : (t - .5) * 2;
      const target = { x: feet[i].x + stride * (stance ? .5 - step : step - .5) + frame.travel.dx, y: feet[i].y - (stance ? 0 : lift * Math.sin(step * Math.PI)) };
      frame.contacts.push({ chainId: legs[i], phase: stance ? 'stance' : 'swing', target: stance ? target : null });
      targets.push({ frameId: frame.id, chainId: legs[i], target });
    }
    elapsed += frame.durationMs;
  }
  // All frame targets exist before solving, so each update still passes structural validation.
  for (const { frameId, chainId, target } of targets) edit = solveMotionTarget(edit, frameId, chainId, target, context);
  edit.plan.action = 'walk'; edit = validateMotionEdit(edit, context);
  compileMotionRecipe(edit.recipe, edit.rig, edit.plan, context);
  return edit;
}
