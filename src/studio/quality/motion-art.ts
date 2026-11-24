import { createRecipeRenderer, type RecipeResources } from './renderer.ts';
import type { CompiledMotion } from './motion-render.ts';
import type { AssetRecipe, RecipePart } from './recipe.ts';

function isPartVisibleInAnyFrame(partId: string, recipe: AssetRecipe): boolean {
  const partsById = new Map(recipe.parts.map(p => [p.id, p]));
  for (const frame of recipe.frames) {
    const posesByPart = new Map(frame.poses.map(p => [p.partId, p]));
    let visible = true;
    let curr: string | null = partId;
    while (curr !== null) {
      const pose = posesByPart.get(curr);
      if (pose !== undefined && !pose.visible) {
        visible = false;
        break;
      }
      curr = partsById.get(curr)?.parentId ?? null;
    }
    if (visible) return true;
  }
  return false;
}

function checkPartRestArt(
  part: RecipePart,
  recipe: AssetRecipe,
  resources: RecipeResources,
  cache: Map<string, boolean>,
): boolean {
  const cached = cache.get(part.id);
  if (cached !== undefined) return cached;

  if (part.paint.length === 0) {
    cache.set(part.id, false);
    return false;
  }

  const restRecipe: AssetRecipe = {
    ...recipe,
    parts: recipe.parts.map(p => ({ ...p, paint: p.id === part.id ? p.paint : [] })),
    frames: [{ id: recipe.frames[0].id, durationMs: recipe.frames[0].durationMs, poses: [] }],
  };

  const renderer = createRecipeRenderer(restRecipe, resources);
  const frame = renderer.renderFrame(restRecipe.frames[0].id);
  const hasArt = frame.image.data.some(c => (c & 255) !== 0);
  cache.set(part.id, hasArt);
  return hasArt;
}

/**
 * Checks actual RGBA and explicit visibility, not artistic quality. Inputs stay immutable.
 */
export function assertMotionArtwork(compiled: CompiledMotion, resources: RecipeResources): void {
  const { recipe, rig, plan } = compiled;
  const partsById = new Map(recipe.parts.map(p => [p.id, p]));
  const partArtCache = new Map<string, boolean>();

  // 1. Inspect limb art for all declared rig chains (arm and leg)
  for (const [chainIndex, chain] of rig.chains.entries()) {
    const chainJoints = [
      { jointId: chain.rootJointId, label: 'gốc' },
      { jointId: chain.midJointId, label: 'giữa' },
      { jointId: chain.endJointId, label: 'cuối' },
    ];
    const chainType = chain.kind === 'arm' ? 'tay' : 'chân';

    for (const { jointId, label } of chainJoints) {
      const boundBindings = rig.bindings.filter(b => b.jointId === jointId);
      const boundParts = boundBindings
        .map(b => partsById.get(b.partId))
        .filter((p): p is RecipePart => p !== undefined);

      if (boundParts.length === 0) {
        throw new Error(`Chuỗi ${chainType} ${chainIndex + 1}: khớp ${label} chưa gắn bộ phận hình ảnh.`);
      }

      const hasValidArt = boundParts.some(part => {
        if (!isPartVisibleInAnyFrame(part.id, recipe)) return false;
        return checkPartRestArt(part, recipe, resources, partArtCache);
      });

      if (!hasValidArt) {
        const boundNames = boundParts.map(p => p.name).join(', ');
        throw new Error(
          `Chuỗi ${chainType} ${chainIndex + 1}: khớp ${label} (${boundNames}) không có pixel RGBA ở tư thế nghỉ hoặc bị ẩn toàn clip. Vẽ bộ phận hoặc sửa gắn/hiển thị trước khi duyệt.`,
        );
      }
    }
  }

  // 2. Render all candidate frames and ensure nonempty
  const renderer = createRecipeRenderer(recipe, resources);
  let firstPixels: Uint32Array | undefined, hasDistinct = false;

  for (const [index, frame] of recipe.frames.entries()) {
    const rendered = renderer.renderFrame(frame.id);
    const pixels = rendered.image.data;
    const hasPixel = pixels.some(c => (c & 255) !== 0);
    if (!hasPixel) {
      throw new Error(`Frame ${index + 1} rỗng, không có điểm ảnh nào.`);
    }
    if (!firstPixels) firstPixels = pixels;
    else if (!hasDistinct && pixels.some((c, i) => c !== firstPixels![i])) hasDistinct = true;
  }

  // 3. For gait actions (walk / run), require at least 2 distinct native RGBA frames
  if (plan.action === 'walk' || plan.action === 'run') {
    if (!hasDistinct) {
      throw new Error(
        `Hành động ${plan.action} yêu cầu ít nhất 2 frame RGBA thực tế khác nhau; chuyển động khớp quá nhỏ không tạo ra thay đổi điểm ảnh trên canvas.`,
      );
    }
  }
}
