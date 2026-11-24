import type { AssetRecipe } from '../src/studio/quality/recipe.ts';
import type { MotionRig, MotionPlan } from '../src/studio/quality/motion.ts';
export function motionFixture(): { recipe: AssetRecipe; rig: MotionRig; plan: MotionPlan } {
  const recipe: AssetRecipe = { version: 1, name: 'Kiếm sĩ', canvas: { w: 16, h: 16 }, palette: [0x354557ff, 0xeef7f8ff], pivot: { x: 8, y: 16 }, materials: [],
    parts: [
      { id: 'body', name: 'Thân', parentId: null, pivot: { x: 4, y: 4 }, origin: 'visible', materialIds: [], paint: [{ kind: 'rect', x: 3, y: 3, w: 2, h: 5, color: 0 }] },
      { id: 'upper', name: 'Cánh tay', parentId: 'body', pivot: { x: 5, y: 4 }, origin: 'authored', materialIds: [], paint: [{ kind: 'line', x0: 5, y0: 4, x1: 6, y1: 4, color: 0 }] },
      { id: 'lower', name: 'Cẳng tay', parentId: 'upper', pivot: { x: 7, y: 4 }, origin: 'authored', materialIds: [], paint: [{ kind: 'line', x0: 7, y0: 4, x1: 8, y1: 4, color: 0 }] },
      { id: 'sword', name: 'Kiếm', parentId: 'lower', pivot: { x: 9, y: 4 }, origin: 'derived', materialIds: [], paint: [{ kind: 'line', x0: 9, y0: 4, x1: 10, y1: 4, color: 1 }] },
    ], frames: [{ id: 'rest', durationMs: 100, poses: [] }, { id: 'carry', durationMs: 120, poses: [] }], loop: true };
  const joint = (id: string, parentId: string | null, x: number, y: number) => ({ id, parentId, rest: { x, y }, minRotation: -180, maxRotation: 180 });
  const rig: MotionRig = { version: 1, id: 'rig', source: { projectId: 'project', assetId: 'source', frameId: 'source-frame', revision: 7, rgbaSha256: '0'.repeat(64), canvas: { w: 16, h: 16 }, pivot: { x: 8, y: 16 } },
    joints: [joint('root', null, 4, 4), joint('shoulder', 'root', 5, 4), joint('elbow', 'shoulder', 7, 4), joint('wrist', 'elbow', 9, 4)],
    sockets: [{ id: 'grip', jointId: 'wrist', rest: { x: 9, y: 4 } }],
    bindings: [{ partId: 'body', jointId: 'root', socketId: null }, { partId: 'upper', jointId: 'shoulder', socketId: null }, { partId: 'lower', jointId: 'elbow', socketId: null }, { partId: 'sword', jointId: 'wrist', socketId: 'grip' }],
    chains: [{ id: 'arm', kind: 'arm', rootJointId: 'shoulder', midJointId: 'elbow', endJointId: 'wrist', bend: 1, contactSocketId: null }] };
  const plan: MotionPlan = { version: 1, id: 'plan', rigId: 'rig', action: 'idle', loop: true, rootMotion: false, frames: recipe.frames.map(f => ({ id: f.id, durationMs: f.durationMs, root: { dx: 0, dy: 0 }, travel: { dx: 0, dy: 0 }, rotations: [], order: recipe.parts.map(p => p.id), contacts: [] })) };
  return { recipe, rig, plan };
}
