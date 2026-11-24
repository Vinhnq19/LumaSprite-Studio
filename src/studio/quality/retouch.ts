import {
  invalidData as fail,
  dataObject as obj,
  dataArray as arr,
  dataNumber as num,
  dataId as id,
  dataUnique as unique,
} from './data.ts';
import { validateAssetRecipe, type AssetRecipe, type RecipeContext, type RecipeRect } from './recipe.ts';
import type { RecipeRenderer } from './renderer.ts';

export interface FrameRetouchConstraints { lockedFrames: string[]; region: RecipeRect | null }

const ROOT = 'Retouch frame';

/** Parse caller-provided constraints against a concrete recipe; never trust a cast. */
function parseConstraints(value: unknown, recipe: AssetRecipe, path: string): FrameRetouchConstraints {
  const c = obj(value, ['lockedFrames', 'region'], path);
  const { w, h } = recipe.canvas, known = new Set(recipe.frames.map(f => f.id));
  const lockedFrames = unique(
    arr(c.lockedFrames, 0, recipe.frames.length, `${path}.lockedFrames`).map((v, i) => id(v, `${path}.lockedFrames[${i}]`)),
    `${path}.lockedFrames`,
  );
  if (lockedFrames.some(f => !known.has(f))) fail(`${path}.lockedFrames`, 'frame khóa không tồn tại.');
  let region: RecipeRect | null = null;
  if (c.region !== null) {
    const raw = `${path}.region`, r = obj(c.region, ['x', 'y', 'w', 'h'], raw);
    region = {
      x: num(r.x, 0, w - 1, `${raw}.x`, true),
      y: num(r.y, 0, h - 1, `${raw}.y`, true),
      w: num(r.w, 1, w, `${raw}.w`, true),
      h: num(r.h, 1, h, `${raw}.h`, true),
    };
    if (region.x + region.w > w || region.y + region.h > h) fail(raw, 'vùng vượt canvas.');
  }
  return { lockedFrames, region };
}

export function prepareFrameRetouch(
  base: AssetRecipe,
  value: unknown,
  context: RecipeContext,
  inherited?: FrameRetouchConstraints,
): { recipe: AssetRecipe; constraints: FrameRetouchConstraints; frameIds: string[] } {
  const current = validateAssetRecipe(base, context);
  const root = obj(value, ['patches', 'lockedFrames', 'region'], ROOT);
  const frameIds = new Set(current.frames.map(f => f.id));
  const patches = arr(root.patches, 0, 8, `${ROOT}.patches`).map((v, i) => {
    const path = `${ROOT}.patches[${i}]`, p = obj(v, ['frameId', 'pixelEdits'], path), frameId = id(p.frameId, `${path}.frameId`);
    if (!frameIds.has(frameId)) fail(`${path}.frameId`, `không tìm thấy frame ${frameId}.`);
    return { frameId, pixelEdits: p.pixelEdits };
  });
  unique(patches.map(p => p.frameId), `${ROOT}.patches`);
  const requested = parseConstraints({ lockedFrames: root.lockedFrames, region: root.region }, current, ROOT);
  // Absent inheritance means no protection rather than an implicit widening of anything.
  const prior = inherited === undefined
    ? { lockedFrames: [] as string[], region: null as RecipeRect | null }
    : parseConstraints(inherited, current, 'Ràng buộc kế thừa');
  const locks = new Set([...prior.lockedFrames, ...requested.lockedFrames]);
  // Union in recipe frame order, so a child can only add locks, never drop them.
  const lockedFrames = current.frames.map(f => f.id).filter(f => locks.has(f));
  let region: RecipeRect | null;
  if (prior.region === null) region = requested.region === null ? null : { ...requested.region };
  else if (requested.region === null) region = { ...prior.region };
  else {
    const x = Math.max(prior.region.x, requested.region.x), y = Math.max(prior.region.y, requested.region.y);
    const right = Math.min(prior.region.x + prior.region.w, requested.region.x + requested.region.w);
    const bottom = Math.min(prior.region.y + prior.region.h, requested.region.y + requested.region.h);
    if (right <= x || bottom <= y) fail(`${ROOT}.region`, 'vùng yêu cầu không giao với vùng được bảo vệ.');
    region = { x, y, w: right - x, h: bottom - y };
  }
  // Replace only the patched frame's whole pixelEdits; parts, poses and timing stay untouched.
  const frames: unknown[] = current.frames.map(frame => {
    const patch = patches.find(p => p.frameId === frame.id);
    return patch === undefined ? frame : { ...frame, pixelEdits: patch.pixelEdits };
  });
  // Authoritative check: palette indices, coordinates, duplicates and the coordinate budget.
  const recipe = validateAssetRecipe({ ...current, frames }, context);
  return { recipe, constraints: { lockedFrames, region }, frameIds: patches.map(p => p.frameId) };
}

export function assertFrameRetouchPixels(
  parent: RecipeRenderer,
  candidate: RecipeRenderer,
  constraints: FrameRetouchConstraints,
  frameIds: readonly string[],
): void {
  const before = parent.getRecipe(), after = candidate.getRecipe();
  if (before.canvas.w !== after.canvas.w || before.canvas.h !== after.canvas.h) {
    fail('Retouch', 'canvas giữa hai phiên bản không khớp.');
  }
  const safe = parseConstraints(constraints, before, 'Ràng buộc retouch');
  const locked = new Set(safe.lockedFrames), region = safe.region;
  const inRegion = (x: number, y: number) =>
    region !== null && x >= region.x && y >= region.y && x < region.x + region.w && y < region.y + region.h;
  for (const frameId of frameIds) {
    const isLocked = locked.has(frameId);
    if (!isLocked && region === null) continue;
    const a = parent.renderFrame(frameId).image, b = candidate.renderFrame(frameId).image;
    if (a.w !== b.w || a.h !== b.h) fail(`Frame ${frameId}`, 'kích thước ảnh giữa hai phiên bản không khớp.');
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      if (!isLocked && inRegion(x, y)) continue;
      const i = y * a.w + x;
      // Packed RGBA equality: re-painting an identical color is an accepted no-op.
      if (a.data[i] === b.data[i]) continue;
      if (isLocked) fail(`Frame ${frameId}`, `pixel (${x}, ${y}) thuộc frame khóa đã bị thay đổi.`);
      fail(`Frame ${frameId}`, `pixel (${x}, ${y}) nằm ngoài vùng cho phép đã bị thay đổi.`);
    }
  }
}
