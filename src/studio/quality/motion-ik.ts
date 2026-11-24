import { validateMotionEdit, type MotionEdit } from './motion-edit.ts';
import { motionJointMatrices } from './motion-render.ts';
import { solveTwoBone } from './kinematics.ts';
import { point, type Matrix } from './affine.ts';
import { dataId, dataNumber, dataObject } from './data.ts';
import type { RecipeContext, RecipePoint } from './recipe.ts';

const angle = (matrix: Matrix) => Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI;
const direction = (a: RecipePoint, b: RecipePoint) => Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
const wrap = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;

/** Move a whole limb, preserving bone lengths and the foot/hand's world orientation. */
export function solveMotionTarget(value: MotionEdit, frameId: string, chainId: string, targetValue: unknown, context?: RecipeContext): MotionEdit {
  const edit = validateMotionEdit(value, context), frame = edit.plan.frames.find(f => f.id === dataId(frameId, 'Frame IK'));
  const chain = edit.rig.chains.find(c => c.id === dataId(chainId, 'Chuỗi IK'));
  if (!frame || !chain) throw Error('Không tìm thấy frame hoặc chuỗi chi để đặt đích.');
  const raw = dataObject(targetValue, ['x', 'y'], 'Đích IK');
  const target = { x: dataNumber(raw.x, -16384, 16384, 'Đích IK x'), y: dataNumber(raw.y, -16384, 16384, 'Đích IK y') };
  const root = edit.rig.joints.find(j => j.id === chain.rootJointId)!, mid = edit.rig.joints.find(j => j.id === chain.midJointId)!, end = edit.rig.joints.find(j => j.id === chain.endJointId)!;
  const matrices = motionJointMatrices(edit.rig, frame), rootMatrix = matrices.get(root.id)!, endMatrix = matrices.get(end.id)!;
  const [x, y] = point(rootMatrix, root.rest.x, root.rest.y);
  const contact = frame.contacts.find(c => c.chainId === chain.id);
  const socketId = contact?.contactSocketId === undefined ? chain.contactSocketId : contact.contactSocketId;
  const socket = edit.rig.sockets.find(s => s.id === socketId);
  // Keep the current foot angle; convert a sole target to an ankle target before solving.
  const offset = socket ? { x: socket.rest.x - end.rest.x, y: socket.rest.y - end.rest.y } : { x: 0, y: 0 };
  const ankle = { x: target.x - endMatrix[0] * offset.x - endMatrix[2] * offset.y, y: target.y - endMatrix[1] * offset.x - endMatrix[3] * offset.y };
  const solved = solveTwoBone({ x, y }, ankle, Math.hypot(mid.rest.x - root.rest.x, mid.rest.y - root.rest.y), Math.hypot(end.rest.x - mid.rest.x, end.rest.y - mid.rest.y), chain.bend);
  if (!solved.reachable) throw Error('Đích nằm ngoài tầm chi. Đổi đích hoặc tư thế thân; không kéo giãn xương.');
  const parentAngle = root.parentId === null ? 0 : angle(matrices.get(root.parentId)!);
  const upper = wrap(solved.rootAngle - direction(root.rest, mid.rest) - parentAngle);
  const lower = wrap(solved.midAngle + direction(root.rest, mid.rest) - direction(mid.rest, end.rest));
  const wrist = wrap(angle(endMatrix) - parentAngle - upper - lower);
  for (const [jointId, degrees] of [[root.id, upper], [mid.id, lower], [end.id, wrist]] as const) {
    const joint = edit.rig.joints.find(j => j.id === jointId)!;
    const allowed = [degrees, degrees + 360, degrees - 360].find(n => n >= joint.minRotation - 1e-9 && n <= joint.maxRotation + 1e-9);
    if (allowed === undefined) throw Error('Đích đòi hỏi góc vượt giới hạn khớp. Đổi đích hoặc giới hạn trước.');
    const rotation = frame.rotations.find(r => r.jointId === jointId), bounded = Math.max(joint.minRotation, Math.min(joint.maxRotation, allowed));
    if (rotation) rotation.degrees = bounded; else frame.rotations.push({ jointId, degrees: bounded });
  }
  if (contact?.phase === 'stance') contact.target = target;
  return validateMotionEdit(edit, context);
}
