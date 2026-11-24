import { randomUUID } from 'node:crypto';
import { celFor, composite, type PixelDocument, type PixelLayer } from '../../studio/pixel/model.ts';
import { validateRigDraft, type RigDraft } from '../../studio/quality/rig-draft.ts';
import { dataArray, dataId, dataNumber, dataObject, dataUnique } from '../../studio/quality/data.ts';
import { type RecipeMaterial, type RecipePart } from '../../studio/quality/recipe.ts';
import { type MotionFrame, type MotionPartBinding } from '../../studio/quality/motion.ts';
import { createRecipeRenderer } from '../../studio/quality/renderer.ts';
import { qualityRevision } from './quality-source.ts';
import { qualityRgbaHash } from './quality-digest.ts';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';
import type { StudioResource } from '../../studio/resources.ts';

/**
 * Refresh an editable non-approved rig draft from real pixel layers.
 * No persistence in helper; caller commits later with revision/shared lease.
 */
export function prepareRigDraftRefresh(
  store: PixelStore,
  rawDoc: PixelDocument,
  value: unknown,
): { document: PixelDocument; draft: RigDraft } {
  // 1. Strict input validation
  const input = dataObject(value, ['revision', 'draftId', 'parts'], 'Yêu cầu refresh nháp rig');
  qualityRevision(rawDoc, input.revision);
  const draftId = dataId(input.draftId, 'ID nháp rig');

  // Locate existing draft
  const existingDraft = rawDoc.studio?.rigDrafts?.[draftId];
  if (!existingDraft) throw new StudioError('Không tìm thấy nháp rig.', 404);

  if (existingDraft.recipe.frames.some(f => f.pixelEdits?.length)) {
    throw new StudioError('Nháp rig có nét chỉnh theo frame; giữ bản nháp và tạo bản sao nguồn để duyệt lại trước khi làm mới.', 422);
  }

  // Motion compiler owns recipe.frames poses; refuse if nonempty
  if (existingDraft.recipe.frames.some(f => f.poses && f.poses.length > 0)) {
    throw new StudioError('Nháp rig đã có pose trong frame; không thể refresh khi motion compiler đã chạy.', 422);
  }

  // Refuse if existing recipe has non-null parentId (destroying advanced hierarchy)
  if (existingDraft.recipe.parts.some(p => p.parentId !== null)) {
    throw new StudioError('Nháp rig có cấu trúc phân cấp bộ phận; không tự làm phẳng khi refresh.', 422);
  }

  // 2. Locate source asset and frame from existing draft
  const sourceRef = existingDraft.rig.source;
  const doc = structuredClone(rawDoc);
  const asset = doc.assets.find(a => a.id === sourceRef.assetId);
  const frame = asset?.frames.find(f => f.id === sourceRef.frameId);
  if (!asset || !frame) throw new StudioError('Không tìm thấy asset/frame nguồn rig.', 404);

  // Canvas dimension change requires new draft, no silent scale/translate
  if (asset.w !== sourceRef.canvas.w || asset.h !== sourceRef.canvas.h) {
    throw new StudioError('Kích thước canvas đã đổi; cần tạo nháp rig mới thay vì refresh.', 422);
  }
  const w = asset.w, h = asset.h;
  if (w * h > 8_000_000) {
    throw new StudioError('Nguồn rig vượt 8 triệu pixel; giảm canvas trên bản sao trước.', 422);
  }
  if (w * h * existingDraft.recipe.frames.length > 8_000_000) {
    throw new StudioError('Nguồn vượt giới hạn 8 triệu pixel review native; giảm clip/canvas trước khi duyệt.', 422);
  }

  // Check frozen frames: fail if referenced frozen source frames no longer exist
  for (const frozen of existingDraft.frozenFrames) {
    if (!asset.frames.some(f => f.id === frozen.sourceFrameId)) {
      throw new StudioError(`Frame nguồn khóa rig "${frozen.sourceFrameId}" không còn tồn tại trong asset.`, 404);
    }
  }

  // 3. Hydrate selected asset/frame only
  store.hydrate(doc, (a, f) => a.id === asset.id && f === frame.id);

  // 4. Traverse visible hierarchy in actual composite order, checking opacity 255
  const visibleImageLayers: PixelLayer[] = [];
  function traverse(parent?: string): void {
    for (const layer of asset!.layers) {
      const isDirectChild = parent === undefined ? (layer.parent === undefined || layer.parent === null) : layer.parent === parent;
      if (!isDirectChild) continue;
      if (!layer.visible) continue;
      if (layer.opacity !== 255) {
        throw new StudioError(`Layer "${layer.name}" có opacity ${layer.opacity} khác 255; không tự làm phẳng.`, 422);
      }
      if (layer.type === 'group') {
        traverse(layer.id);
      } else if (layer.type === 'image') {
        visibleImageLayers.push(layer);
      }
    }
  }
  traverse(undefined);

  if (visibleImageLayers.length === 0) {
    throw new StudioError('Cần ít nhất một layer ảnh nhìn thấy được.', 422);
  }
  if (visibleImageLayers.length > 64) {
    throw new StudioError('Vượt tối đa 64 bộ phận.', 422);
  }

  // 5. Validate input.parts
  const rawParts = dataArray(input.parts, 1, 64, 'Danh sách bộ phận');
  const parsedParts = rawParts.map((raw, i) => {
    const p = dataObject(raw, ['layerId', 'origin', 'pivot'], `Bộ phận[${i}]`);
    const layerId = dataId(p.layerId, `ID layer bộ phận[${i}]`);
    if (typeof p.origin !== 'string' || !['visible', 'authored', 'derived'].includes(p.origin)) {
      throw new StudioError(`Nguồn gốc bộ phận "${layerId}" không hợp lệ.`, 422);
    }
    const pivotObj = dataObject(p.pivot, ['x', 'y'], `Pivot bộ phận[${i}]`);
    const pivot = {
      x: dataNumber(pivotObj.x, 0, w, `Pivot x bộ phận[${i}]`),
      y: dataNumber(pivotObj.y, 0, h, `Pivot y bộ phận[${i}]`),
    };
    return { layerId, origin: p.origin as 'visible' | 'authored' | 'derived', pivot };
  });

  // Duplicate / missing / extra layer ID checks
  const inputLayerIds = parsedParts.map(p => p.layerId);
  dataUnique(inputLayerIds, 'ID layer bộ phận');
  const visibleMap = new Map(visibleImageLayers.map(l => [l.id, l]));
  for (const id of inputLayerIds) {
    if (!visibleMap.has(id)) {
      throw new StudioError(`Danh sách bộ phận chứa layer "${id}" không hợp lệ (không tồn tại, bị ẩn hoặc không phải layer ảnh).`, 422);
    }
  }
  if (parsedParts.length !== visibleImageLayers.length) {
    throw new StudioError('Danh sách bộ phận không khớp đầy đủ các layer ảnh hiển thị.', 422);
  }
  const inputByLayerId = new Map(parsedParts.map(p => [p.layerId, p]));

  // 6. Palette and pixel validation
  const palette = [...new Set(asset.palette.filter(c => (c & 255) === 255))];
  if (!palette.length || palette.length > 256) {
    throw new StudioError('Nguồn rig cần palette đục (1–256 màu). Chuẩn hóa bản sao trước; không tự đổi ảnh gốc.', 422);
  }

  const layerPixelsList: { layer: PixelLayer; pixels: Uint32Array }[] = [];
  for (const layer of visibleImageLayers) {
    const cel = celFor(asset, layer.id, frame.id);
    const pixels = cel?.data ? cel.data.slice() : new Uint32Array(w * h);
    if (pixels.length !== w * h) {
      throw new StudioError(`Kích thước cel của layer "${layer.name}" sai.`, 422);
    }
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i];
      if (c === 0) continue;
      if ((c & 255) !== 255 || !palette.includes(c)) {
        throw new StudioError('Nguồn rig cần palette đục và alpha 0/255. Chuẩn hóa bản sao trước; không tự đổi ảnh gốc.', 422);
      }
    }
    layerPixelsList.push({ layer, pixels });
  }

  const compositePixels = composite(asset, frame.id).data;
  for (let i = 0; i < compositePixels.length; i++) {
    const c = compositePixels[i];
    if (c === 0) continue;
    if ((c & 255) !== 255 || !palette.includes(c)) {
      throw new StudioError('Nguồn rig cần palette đục và alpha 0/255. Chuẩn hóa bản sao trước; không tự đổi ảnh gốc.', 422);
    }
  }

  // 7. Material remapping
  const oldPalette = existingDraft.recipe.palette;
  const materials: RecipeMaterial[] = existingDraft.recipe.materials.map(m => {
    const newColors: number[] = [];
    for (const oldIdx of m.colors) {
      const oldRgba = oldPalette[oldIdx];
      const newIdx = palette.indexOf(oldRgba);
      if (newIdx === -1) {
        throw new StudioError(`Màu vật liệu "${m.name}" (${oldRgba.toString(16)}) không còn trong palette mới; không thể ánh xạ tự động.`, 422);
      }
      newColors.push(newIdx);
    }
    return { id: m.id, name: m.name, colors: dataUnique(newColors, `Vật liệu ${m.name}`) };
  });

  // 8. Allocate fresh resources and build recipe parts
  const resources: Record<string, StudioResource> = { ...doc.studio?.resources };
  const sources: { id: string; resourceId: string }[] = [];
  const oldPartMap = new Map(existingDraft.recipe.parts.map(p => [p.id, p]));

  const recipeParts: RecipePart[] = layerPixelsList.map(({ layer, pixels }) => {
    const inputPart = inputByLayerId.get(layer.id)!;
    const oldPart = oldPartMap.get(layer.id);
    const materialIds = oldPart ? oldPart.materialIds.slice() : [];
    const resourceId = 'rigp_' + randomUUID();
    const mappingId = 'pixels_' + layer.id;
    resources[resourceId] = {
      version: 1,
      kind: 'rgba',
      w,
      h,
      data: pixels.slice(),
    };
    sources.push({ id: mappingId, resourceId });
    return {
      id: layer.id,
      name: layer.name,
      parentId: null,
      pivot: { x: inputPart.pivot.x, y: inputPart.pivot.y },
      origin: inputPart.origin,
      materialIds,
      paint: pixels.some(Boolean)
        ? [{ kind: 'raster', sourceId: mappingId, sourceRect: { x: 0, y: 0, w, h }, x: 0, y: 0, maskId: null }]
        : [],
    };
  });

  // 9. Recipe frames (poses empty)
  const recipeFrames = existingDraft.recipe.frames.map(f => ({
    id: f.id,
    durationMs: f.durationMs,
    poses: [],
  }));

  // 10. Pivot and Rig updates
  const metaPivot = asset.metadata?.pivot ?? { x: 0.5, y: 1 };
  const recipePivot = { x: metaPivot.x * w, y: metaPivot.y * h };

  const recipe: RigDraft['recipe'] = {
    version: 1,
    name: existingDraft.recipe.name,
    canvas: { w, h },
    palette,
    pivot: recipePivot,
    materials,
    parts: recipeParts,
    frames: recipeFrames,
    loop: existingDraft.recipe.loop,
  };

  // 11. Rig bindings
  const rootJoint = existingDraft.rig.joints.find(j => j.parentId === null);
  if (!rootJoint) throw new StudioError('Rig thiếu khớp gốc.', 422);

  const oldBindingMap = new Map(existingDraft.rig.bindings.map(b => [b.partId, b]));
  const bindings: MotionPartBinding[] = visibleImageLayers.map(layer => {
    const oldBinding = oldBindingMap.get(layer.id);
    if (oldBinding) {
      return { partId: layer.id, jointId: oldBinding.jointId, socketId: oldBinding.socketId };
    }
    return { partId: layer.id, jointId: rootJoint.id, socketId: null };
  });

  const rig: RigDraft['rig'] = {
    version: 1,
    id: existingDraft.rig.id,
    source: {
      projectId: doc.id,
      assetId: asset.id,
      frameId: frame.id,
      revision: rawDoc.revision + 1,
      rgbaSha256: qualityRgbaHash(compositePixels),
      canvas: { w, h },
      pivot: recipePivot,
    },
    joints: existingDraft.rig.joints.map(j => ({ ...j, rest: { ...j.rest } })),
    sockets: existingDraft.rig.sockets.map(s => ({ ...s, rest: { ...s.rest } })),
    bindings,
    chains: existingDraft.rig.chains.map(c => ({ ...c })),
  };

  // 12. Plan frames: retain surviving explicit IDs, append new parts in layer order
  const newPartIdSet = new Set(visibleImageLayers.map(l => l.id));
  const planFrames: MotionFrame[] = existingDraft.plan.frames.map(f => {
    const surviving = f.order.filter(id => newPartIdSet.has(id));
    const survivingSet = new Set(surviving);
    const appended = visibleImageLayers.map(l => l.id).filter(id => !survivingSet.has(id));
    return {
      id: f.id,
      durationMs: f.durationMs,
      root: { ...f.root },
      travel: { ...f.travel },
      rotations: f.rotations.map(r => ({ ...r })),
      order: [...surviving, ...appended],
      contacts: f.contacts.map(c => ({
        ...c,
        target: c.target ? { ...c.target } : null,
      })),
    };
  });

  const plan: RigDraft['plan'] = {
    version: 1,
    id: existingDraft.plan.id,
    rigId: existingDraft.plan.rigId,
    action: existingDraft.plan.action,
    loop: recipe.loop,
    rootMotion: existingDraft.plan.rootMotion,
    frames: planFrames,
  };

  // 13. Assemble draft and revalidate
  const draftCandidate: RigDraft = {
    version: 1,
    id: existingDraft.id,
    name: existingDraft.name,
    origin: structuredClone(existingDraft.origin),
    recipe,
    rig,
    plan,
    resources: {
      sources,
      masks: structuredClone(existingDraft.resources.masks),
    },
    movementMaskResourceId: existingDraft.movementMaskResourceId,
    frozenFrames: structuredClone(existingDraft.frozenFrames),
  };

  const validatedDraft = validateRigDraft(draftCandidate, resources);

  // 14. Controlled renderer: rest frame must match exact composite
  const rendererSources = validatedDraft.resources.sources.map(s => {
    const r = resources[s.resourceId];
    return { id: s.id, w: r.w, h: r.h, pixels: r.data! };
  });
  const rendererMasks = validatedDraft.resources.masks.map(m => {
    const r = resources[m.resourceId];
    if (!r || r.kind !== 'mask') throw new StudioError('Thiếu tài nguyên mask.', 422);
    const data = r.data ? Uint8Array.from(r.data) : Uint8Array.from(store.resourceStore(doc.id).read({ version: 1, kind: 'mask', w: r.w, h: r.h, blob: r.blob! }));
    return { id: m.id, w: r.w, h: r.h, data };
  });

  const renderer = createRecipeRenderer(validatedDraft.recipe, { sources: rendererSources, masks: rendererMasks });
  const rendered = renderer.renderFrame(validatedDraft.recipe.frames[0].id);
  for (let i = 0; i < rendered.image.data.length; i++) {
    if (rendered.image.data[i] !== compositePixels[i]) {
      throw new StudioError('Frame nghỉ của recipe không khớp composite nguồn.', 422);
    }
  }

  // 15. Update doc (without persistence, caller commits later)
  doc.studio = {
    ...doc.studio,
    version: 2,
    quality: doc.studio?.quality ?? { version: 1, approvals: {} },
    resources,
    rigDrafts: {
      ...doc.studio?.rigDrafts,
      [validatedDraft.id]: validatedDraft,
    },
  };

  return { document: doc, draft: validatedDraft };
}
