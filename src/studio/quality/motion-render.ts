import { validateAssetRecipe, type AssetRecipe, type RecipeContext, type RecipePoint, type RecipePose } from './recipe.ts';
import { validateMotionRig, validateMotionPlan, type MotionRig, type MotionPlan, type MotionFrame } from './motion.ts';
import { IDENTITY, inverse, multiply, point, localMatrix, type Matrix } from './affine.ts';

export interface ContactGeometry { chainId: string; phase: 'stance' | 'swing'; actual: RecipePoint; target: RecipePoint | null; rasterError: number; distance: number }
export interface MotionGeometry {
  frameId: string; joints: Record<string, RecipePoint>; sockets: Record<string, RecipePoint>;
  contacts: ContactGeometry[]; maxBoneError: number; maxAttachmentError: number;
}
export interface CompiledMotion { recipe: AssetRecipe; rig: MotionRig; plan: MotionPlan; geometry: MotionGeometry[] }
function xy(m: Matrix, p: RecipePoint): RecipePoint { const [x, y] = point(m, p.x, p.y); return { x, y }; }

/** Input rig/frame must already pass their structural validators. */
export function motionJointMatrices(rig: MotionRig, frame: MotionFrame): Map<string, Matrix> {
  const joints = new Map(rig.joints.map(j => [j.id, j])), angles = new Map(frame.rotations.map(r => [r.jointId, r.degrees])), matrices = new Map<string, Matrix>();
  const translation: Matrix = [1, 0, 0, 1, frame.root.dx + frame.travel.dx, frame.root.dy + frame.travel.dy];
  const resolve = (id: string): Matrix => {
    const cached = matrices.get(id); if (cached) return cached;
    const joint = joints.get(id)!, parent = joint.parentId === null ? translation : resolve(joint.parentId);
    const matrix = multiply(parent, localMatrix(joint.rest, { dx: 0, dy: 0, rotation: angles.get(id) ?? 0 }));
    matrices.set(id, matrix); return matrix;
  };
  for (const joint of rig.joints) resolve(joint.id);
  return matrices;
}

/** Resolve the entire chain with floats. Only the controlled image renderer quantizes pixels. */
export function compileMotionRecipe(value: unknown, rigValue: unknown, planValue: unknown, context?: RecipeContext): CompiledMotion {
  const recipe = validateAssetRecipe(value, context), rig = validateMotionRig(rigValue, recipe), plan = validateMotionPlan(planValue, rig, recipe);
  const byJoint = new Map(rig.joints.map(j => [j.id, j])), byPart = new Map(recipe.parts.map(p => [p.id, p]));
  const bindings = new Map(rig.bindings.map(b => [b.partId, b])), bySocket = new Map(rig.sockets.map(s => [s.id, s]));
  const geometry: MotionGeometry[] = [];
  const frames = plan.frames.map((frame, index) => {
    const oldPoses = new Map(recipe.frames[index].poses.map(p => [p.partId, p]));
    for (const pose of oldPoses.values()) {
      if (pose.dx !== 0 || pose.dy !== 0 || pose.rotation !== 0 || pose.z !== recipe.parts.findIndex(p => p.id === pose.partId)) throw new Error('Recipe có pose riêng ngoài kế hoạch chuyển động đã chốt.');
    }
    const jointMatrices = motionJointMatrices(rig, frame), jointMatrix = (id: string) => jointMatrices.get(id)!;
    const jointPoints = Object.fromEntries(rig.joints.map(j => [j.id, xy(jointMatrix(j.id), j.rest)]));
    const socketPoints = Object.fromEntries(rig.sockets.map(s => [s.id, xy(jointMatrix(s.jointId), s.rest)]));
    let maxBoneError = 0;
    for (const joint of rig.joints) if (joint.parentId !== null) {
      const parent = byJoint.get(joint.parentId)!, a = jointPoints[joint.id], b = jointPoints[parent.id];
      maxBoneError = Math.max(maxBoneError, Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(joint.rest.x - parent.rest.x, joint.rest.y - parent.rest.y)));
    }
    const target = (partId: string) => jointMatrix(bindings.get(partId)!.jointId);
    let maxAttachmentError = 0;
    const poses = recipe.parts.map((part): RecipePose => {
      const world = target(part.id), parent = part.parentId === null ? IDENTITY : target(part.parentId);
      const relative = multiply(inverse(parent), world), movedPivot = xy(relative, part.pivot);
      return { partId: part.id, dx: movedPivot.x - part.pivot.x, dy: movedPivot.y - part.pivot.y, rotation: Math.atan2(relative[1], relative[0]) * 180 / Math.PI, z: frame.order.indexOf(part.id), visible: oldPoses.get(part.id)?.visible ?? true };
    });
    // Check the decomposed poses the renderer will actually consume, not just target matrices.
    const byPose = new Map(poses.map(p => [p.partId, p])), actualMatrices = new Map<string, Matrix>();
    const actualMatrix = (partId: string): Matrix => {
      const cached = actualMatrices.get(partId); if (cached) return cached;
      const part = byPart.get(partId)!, parent = part.parentId === null ? IDENTITY : actualMatrix(part.parentId);
      const matrix = multiply(parent, localMatrix(part.pivot, byPose.get(partId)!));
      actualMatrices.set(partId, matrix); return matrix;
    };
    for (const binding of rig.bindings) {
      const restPoint = binding.socketId === null ? byJoint.get(binding.jointId)!.rest : bySocket.get(binding.socketId)!.rest;
      const expected = binding.socketId === null ? jointPoints[binding.jointId] : socketPoints[binding.socketId];
      const actual = xy(actualMatrix(binding.partId), restPoint);
      maxAttachmentError = Math.max(maxAttachmentError, Math.hypot(actual.x - expected.x, actual.y - expected.y));
    }
    const contacts = frame.contacts.map((contact): ContactGeometry => {
      const chain = rig.chains.find(c => c.id === contact.chainId)!;
      const socketId = contact.contactSocketId === undefined ? chain.contactSocketId : contact.contactSocketId;
      const actual = socketId === null ? jointPoints[chain.endJointId] : socketPoints[bySocket.get(socketId)!.id];
      const target = contact.target;
      const rasterError = target === null ? 0 : Math.max(Math.abs(Math.round(actual.x) - Math.round(target.x)), Math.abs(Math.round(actual.y) - Math.round(target.y)));
      if (contact.phase === 'stance' && rasterError > 1) throw new Error(`Frame ${frame.id}: chân ${chain.id} lệch điểm chống ${rasterError} pixel.`);
      return { chainId: chain.id, phase: contact.phase, actual: { ...actual }, target: target === null ? null : { ...target }, rasterError, distance: target === null ? 0 : Math.hypot(actual.x - target.x, actual.y - target.y) };
    });
    if (maxBoneError > 1e-6 || maxAttachmentError > 1e-6) throw new Error(`Frame ${frame.id}: ràng buộc chiều dài xương hoặc điểm gắn bị sai.`);
    geometry.push({ frameId: frame.id, joints: jointPoints, sockets: socketPoints, contacts, maxBoneError, maxAttachmentError });
    return { ...recipe.frames[index], id: frame.id, durationMs: frame.durationMs, poses };
  });
  if (plan.action === 'walk' || plan.action === 'run') {
    for (const chain of rig.chains.filter(c => c.kind === 'leg')) {
      const vectors = geometry.map(g => {
        const root = g.joints[chain.rootJointId], mid = g.joints[chain.midJointId], end = g.joints[chain.endJointId];
        return [mid.x - root.x, mid.y - root.y, end.x - root.x, end.y - root.y];
      });
      if (vectors.every(v => v.every((n, i) => Math.abs(n - vectors[0][i]) < 1e-6))) throw new Error(`Chuỗi chân ${chain.id} không thay đổi tư thế; dịch cả nhân vật không được tính là walk/run.`);
    }
  }
  // Revalidate generated deltas as well as the input. Never expand/crop to hide an impossible pose.
  const controlled = validateAssetRecipe({ ...recipe, frames }, context);
  // Every recipe part is bound explicitly; old landmarks and unbound raster layers have no auto-rig path.
  if (bindings.size !== byPart.size) throw new Error('Thiếu bộ phận trong rig.');
  return { recipe: controlled, rig, plan, geometry };
}
