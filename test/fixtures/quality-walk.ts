import type { MotionEdit } from '../../src/studio/quality/motion-edit.ts';

export function walkFixture(): MotionEdit {
  const joint = (id: string, parentId: string | null, x: number, y: number) => ({ id, parentId, rest: { x, y }, minRotation: -180, maxRotation: 180 });
  const joints = [joint('root', null, 32, 25)];
  for (const [id, x] of [['a', 28], ['b', 36]] as const) joints.push(joint('hip-' + id, 'root', x, 35), joint('knee-' + id, 'hip-' + id, x, 45), joint('ankle-' + id, 'knee-' + id, x, 55));
  const recipe: MotionEdit['recipe'] = { version: 1, name: 'Nhịp đi hình khối', canvas: { w: 64, h: 64 }, palette: [0xffffffff], pivot: { x: 32, y: 64 }, materials: [], loop: true,
    parts: joints.map(j => ({ id: j.id, name: j.id, parentId: null, pivot: j.rest, origin: 'authored', materialIds: [], paint: [{ kind: 'rect', x: j.rest.x - 1, y: j.rest.y - 1, w: 2, h: 2, color: 0 }] })),
    frames: Array.from({ length: 8 }, (_, i) => ({ id: 'f' + i, durationMs: 120, poses: [] })) };
  const rig: MotionEdit['rig'] = { version: 1, id: 'rig', source: { projectId: 'p', assetId: 'a', frameId: 'f0', revision: 1, rgbaSha256: '0'.repeat(64), canvas: recipe.canvas, pivot: recipe.pivot }, joints,
    bindings: joints.map(j => ({ partId: j.id, jointId: j.id, socketId: null })), sockets: [],
    chains: ['a', 'b'].map(id => ({ id, kind: 'leg', rootJointId: 'hip-' + id, midJointId: 'knee-' + id, endJointId: 'ankle-' + id, bend: 1, contactSocketId: null })) };
  const plan: MotionEdit['plan'] = { version: 1, id: 'plan', rigId: rig.id, action: 'custom', rootMotion: false, loop: true, frames: recipe.frames.map(f => ({ id: f.id, durationMs: f.durationMs, root: { dx: 0, dy: 0 }, travel: { dx: 0, dy: 0 }, rotations: [], order: recipe.parts.map(p => p.id), contacts: [] })) };
  return { recipe, rig, plan };
}
