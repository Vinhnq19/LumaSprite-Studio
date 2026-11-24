import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Img } from '../../core/image.ts';
import { luma8, pack } from '../../core/color.ts';
import { dataObject } from '../../studio/quality/data.ts';
import { parseQualityJson } from '../../studio/quality/json.ts';
import { buildCharacterFinish, expandCharacterPaint, normalizeCharacterMarks, validateCharacterConstruction, validateCharacterReview } from './quality-character.ts';
import { characterJointNotes } from './quality-character-joints.ts';
import type { CharacterToneComparison } from './quality-ports.ts';
import { validateQualityDirector, validateQualityBuilder, validateQualityReview, type QualityDirector } from '../../studio/quality/protocol.ts';
import { PIXEL_ROW_SYMBOLS, type AssetRecipe, type RecipeContext } from '../../studio/quality/recipe.ts';
import type { CompiledMotion, MotionGeometry } from '../../studio/quality/motion-render.ts';
import type { QualityRole, QualityVariantSummary } from '../../studio/quality/run.ts';
import { createRecipeRenderer, type RecipeResources } from '../../studio/quality/renderer.ts';
import { celFor, newDocument } from '../../studio/pixel/model.ts';
import { createMap, getMap, MapStroke, registerTileset } from '../../studio/map-commands.ts';
import { assembleTerrain, terrainBoundaryContrast, terrainEdgeDifferences, type TileSize } from '../../studio/terrain.ts';
import { renderMapCells } from '../../studio/tilemap-render.ts';
import { prepareFrameRetouch, assertFrameRetouchPixels, type FrameRetouchConstraints } from '../../studio/quality/retouch.ts';
import { assertMotionApproval, verifyMotionCandidate, type MotionApproval, type MotionApprovalSnapshot } from './motion-approval.ts';
import { PixelStore } from './pixel-store.ts';
import { approvedQualityContext, qualityRevision } from './quality-source.ts';
import { qualityRgbaHash } from './quality-digest.ts';
import { createHash } from 'node:crypto';
import { renderQuality, type QualityInspection } from './quality-worker.ts';
import { readQualitySnapshot, writeQualitySnapshot, writeQualityVariant, readQualityVariant, qualityDirectory } from './quality-storage.ts';
import { safePath } from './store.ts';
import { encodePng } from '../png.ts';
import type { ExportResult } from './render.ts';
import { validateTemplateScope, type TemplateScope } from '../../studio/quality/template-scope.ts';
import { verifyTemplateCandidate } from './quality-template-guard.ts';
export type QualitySourceContext = { kind: 'free'; recipe: unknown; resources: RecipeResources; templateScope?: TemplateScope } | { kind: 'motion'; approval: MotionApproval; snapshot: MotionApprovalSnapshot };
export type QualityStageRequest = { mode: 'quality-stage'; root: string; snapshotId: string } & (
  { operation: 'prepare'; source: unknown } |
  { operation: 'validate'; snapshotSha256: string; role: QualityRole; output: string; director?: QualityDirector; candidateId?: string; candidateSha256?: string; terrainReview?: boolean; characterStudy?: boolean; characterFinishStudy?: boolean } |
  { operation: 'cli-context'; snapshotSha256: string; candidateId?: string; candidateSha256?: string } |
  { operation: 'asset' | 'frame'; snapshotSha256: string; candidateId: string; candidateSha256: string; revision: number; frameId?: string; currentContext?: unknown } |
  { operation: 'retouch' | 'retouch-info'; snapshotSha256: string; candidateId: string; candidateSha256: string; revision: number; frameId?: string; input?: unknown; currentContext?: unknown }
);
const json = (value: unknown): ExportResult => ({ data: Buffer.from(JSON.stringify(value)), mime: 'application/json', filename: 'quality-stage.json' });
function sourceContext(raw: unknown): { source: QualitySourceContext; base: AssetRecipe; resources: RecipeResources; context: RecipeContext; locked: boolean; templateScope?: TemplateScope } {
  if (!raw || typeof raw !== 'object') throw new Error('Thiếu ngữ cảnh chất lượng.');
  const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
  if (kind === 'project-approval') {
    const v = dataObject(raw, ['kind', 'root', 'projectId', 'revision', 'approvalId'], 'Nguồn dự án đã duyệt');
    const store = new PixelStore(v.root as string), doc = store.load(v.projectId as string); qualityRevision(doc, v.revision);
    const map = doc.studio?.quality?.approvals;
    const approval = map && Object.hasOwn(map, v.approvalId as string) ? map[v.approvalId as string] : undefined;
    if (!approval) throw new Error('Nguồn chưa được duyệt hoặc không thuộc dự án.');
    return sourceContext(approvedQualityContext(store, doc, approval));
  }
  let base: AssetRecipe, resources: RecipeResources, templateScope: TemplateScope | undefined;
  if (kind === 'free') {
    const fields = ['kind', 'recipe', 'resources'];
    if (Object.hasOwn(raw, 'templateScope')) fields.push('templateScope');
    const value = dataObject(raw, fields, 'Ngữ cảnh mẫu tĩnh');
    resources = value.resources as RecipeResources; base = createRecipeRenderer(value.recipe, resources).getRecipe();
    if (base.frames.length !== 1) throw new Error('Animation chế độ chất lượng cần rig/kế hoạch đã duyệt; tạo mới tự do chỉ dùng một frame.');
    if (value.templateScope !== undefined) templateScope = validateTemplateScope(value.templateScope, base);
  } else if (kind === 'motion') {
    const value = dataObject(raw, ['kind', 'approval', 'snapshot'], 'Ngữ cảnh chuyển động');
    assertMotionApproval(value.approval as MotionApproval, value.snapshot as MotionApprovalSnapshot);
    const snapshot = value.snapshot as MotionApprovalSnapshot; resources = snapshot.resources; base = createRecipeRenderer(snapshot.recipe, resources).getRecipe();
  } else throw new Error('Loại ngữ cảnh chất lượng không hỗ trợ.');
  // All frames must appear in native-resolution review sheets. Do not silently omit/downscale them.
  if (base.canvas.w * base.canvas.h * base.frames.length > 8_000_000) throw new Error('Bản xem review vượt 8 triệu pixel; chọn clip/canvas nhỏ hơn cho chế độ chất lượng.');
  return { source: raw as QualitySourceContext, base, resources, context: { sources: resources.sources.map(({ id, w, h }) => ({ id, w, h })), masks: resources.masks.map(({ id, w, h }) => ({ id, w, h })) }, locked: kind === 'motion', templateScope };
}
function drawMotionReview(img: Img, geometry: MotionGeometry, sockets: string[], bounds: { x: number; y: number; w: number; h: number }) {
  const mark = (x: number, y: number, rgba: number) => {
    if (x >= 0 && y >= 0 && x < bounds.w && y < bounds.h) img.set(bounds.x + x, bounds.y + y, rgba);
  };
  for (const socket of sockets) {
    const p = geometry.sockets[socket], x = Math.round(p.x), y = Math.round(p.y);
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) mark(x + dx, y + dy, 0x37daf3ff);
  }
  for (const { target } of geometry.contacts) if (target) {
    const x = Math.round(target.x), y = Math.round(target.y);
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) mark(x + dx, y + dy, 0x64ed83ff);
  }
  for (const { actual, phase } of geometry.contacts) {
    if (phase === 'stance') mark(Math.round(actual.x), Math.round(actual.y), 0xffc452ff);
  }
}
function staticValueGuide(image: Img): Img {
  const guide = new Img(image.w * 2 + 1, image.h);
  for (let y = 0; y < image.h; y++) for (let x = 0; x < image.w; x++) {
    const pixel = image.get(x, y), alpha = pixel & 255;
    if (!alpha) continue;
    const gray = luma8(pixel);
    guide.set(x, y, pack(255, 255, 255, alpha));
    guide.set(image.w + 1 + x, y, pack(gray, gray, gray, alpha));
  }
  return guide.scale(2);
}
function characterPartBounds(recipe: AssetRecipe, resources: RecipeResources, matches: (id: string) => boolean): ReturnType<Img['bounds']> {
  const [frame] = recipe.frames;
  if (recipe.frames.length !== 1 || frame.poses.length || frame.pixelEdits?.length) return;
  const parts = recipe.parts.filter(part => matches(part.id))
    .map(part => ({ ...part, parentId: null }));
  if (!parts.length || parts.length === recipe.parts.length) return;
  return createRecipeRenderer({ ...recipe, parts }, resources).renderFrame(frame.id).image.bounds();
}
function characterCropNotes(name: string, image: Img, x: number, y: number, palette: AssetRecipe['palette']): string {
  // Keep the review context to small visible regions at native scale.
  if (palette.length > PIXEL_ROW_SYMBOLS.length || image.w > 20 || image.h > 20) return '';
  const rows = Array.from({ length: image.h }, (_, dy) => Array.from({ length: image.w }, (_, dx) => {
    const pixel = image.data[dy * image.w + dx];
    return pixel ? PIXEL_ROW_SYMBOLS[palette.indexOf(pixel)] ?? '?' : '.';
  }).join(''));
  return `\n${name} (${x},${y}) ${image.w}×${image.h}, shown as palette indices in native rows. Dot here means transparent; this is the composite, so use the candidate recipe to identify the part to change.\n${rows.join('\n')}`;
}
function terrainMapGuide(tile: Img, tileSize: TileSize): Img {
  const rows = ['########', '########', '##..####', '##..####', '#####...', '#####...'];
  const atlas = assembleTerrain(tile.data, { tileSize, inset: tileSize === 16 ? 2 : 3, sampling: 'repeat' });
  const doc = newDocument('Terrain review', atlas.w, atlas.h);
  const [asset] = doc.assets, [frame] = asset.frames;
  celFor(asset, asset.layers[0].id, frame.id, true)!.data = atlas.data;
  const setId = registerTileset(doc, asset.id, frame.id, tileSize, 'Terrain review');
  const mapId = createMap(doc, setId, 'Terrain review', rows[0].length, rows.length);
  const stroke = new MapStroke(doc, mapId, getMap(doc, mapId).layers[0].id);
  for (const [y, row] of rows.entries()) {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') stroke.set(x, y, 1, true);
  }
  stroke.commit();
  return renderMapCells(doc, mapId);
}
function sheets(recipe: AssetRecipe, resources: RecipeResources, detailScale: number, terrainReview: boolean, motion: Pick<CompiledMotion, 'rig' | 'geometry'> | undefined, characterReview: boolean): { name: string; base64: string }[] {
  const renderer = createRecipeRenderer(recipe, resources), { w, h } = recipe.canvas;
  const cols = Math.max(1, Math.min(recipe.frames.length, Math.ceil(Math.sqrt(recipe.frames.length)), Math.floor(4097 / (w + 1))));
  const maxRows = Math.max(1, Math.floor(4097 / (h + 1))), capacity = cols * maxRows, count = Math.ceil(recipe.frames.length / capacity);
  if (count > 4) throw new Error('Cần hơn bốn bảng review ở kích thước gốc; giảm số frame hoặc canvas.');
  const sockets = [...new Set((motion?.rig.bindings ?? []).flatMap(binding => binding.socketId === null ? [] : [binding.socketId]))];
  const showMotion = motion !== undefined && Math.max(w, h) <= 128 && recipe.frames.length <= 16
    && (sockets.length > 0 || motion.geometry.some(frame => frame.contacts.some(contact => contact.target !== null)));
  const images: { name: string; base64: string }[] = [];
  for (let start = 0; start < recipe.frames.length; start += capacity) {
    const length = Math.min(capacity, recipe.frames.length - start), c = Math.min(cols, length), rows = Math.ceil(length / c);
    const image = new Img(c * w + c - 1, rows * h + rows - 1);
    for (let i = 0; i < length; i++) {
      const frame = renderer.renderFrame(recipe.frames[start + i].id).image, x0 = i % c * (w + 1), y0 = Math.floor(i / c) * (h + 1);
      for (let y = 0; y < h; y++) image.data.set(frame.data.subarray(y * w, (y + 1) * w), (y0 + y) * image.w + x0);
    }
    images.push({ name: `review-sheet-${images.length + 1}.png`, base64: encodePng(image).toString('base64') });
    if (detailScale > 1) images.push({ name: `review-detail-${detailScale}x.png`, base64: encodePng(image.scale(detailScale)).toString('base64') });
    if ((detailScale === 4 && !terrainReview) || characterReview) images.push({ name: 'review-shape-value.png', base64: encodePng(staticValueGuide(image)).toString('base64') });
    if (terrainReview && w === h && (w === 16 || w === 32) && image.w === w && image.h === h) {
      const repeat = new Img(w * 3, h * 3);
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) repeat.blit(image, col * w, row * h);
      images.push({ name: 'review-terrain-repeat.png', base64: encodePng(repeat.scale(2)).toString('base64') });
      images.push({ name: 'review-terrain-map.png', base64: encodePng(terrainMapGuide(image, w)).toString('base64') });
    }
    if (showMotion) {
      const guide = image.copy();
      for (let i = 0; i < length; i++) drawMotionReview(guide, motion.geometry[start + i], sockets, { x: i % c * (w + 1), y: Math.floor(i / c) * (h + 1), w, h });
      images.push({ name: 'review-motion-guide.png', base64: encodePng(guide).toString('base64') });
    }
  }
  return images;
}
export function qualityStage(request: QualityStageRequest): ExportResult {
  if (request.operation === 'prepare') {
    const c = sourceContext(request.source), renderer = createRecipeRenderer(c.base, c.resources), img = renderer.renderFrame(c.base.frames[0].id).image;
    const snapshotSha256 = writeQualitySnapshot(request.root, request.snapshotId, c.source);
    const metadataOnly = { ...c.base, parts: c.base.parts.map(p => ({ ...p, paint: [] })) };
    return json({ snapshotSha256, prepared: { snapshotId: request.snapshotId, base: metadataOnly, context: c.context, structureLocked: c.locked,
      sourceImages: img.data.some(c => c !== 0) ? [{ name: 'source.png', base64: encodePng(img).toString('base64') }] : [],
      ...(c.templateScope ? { templateScope: c.templateScope } : {}) } });
  }
  const c = sourceContext(readQualitySnapshot(request.root, request.snapshotId, request.snapshotSha256));
  if (request.operation === 'cli-context') {
    const files: { name: string; base64: string }[] = [];
    let total = 0;
    const add = (name: string, bytes: Uint8Array) => {
      total += bytes.length;
      if (total > 48 * 1024 * 1024) throw new Error('Ngữ cảnh CLI vượt 48 MiB; giảm nguồn/clip trước khi tạo.');
      files.push({ name, base64: Buffer.from(bytes).toString('base64') });
    };
    const addJson = (name: string, value: unknown) => add(name, Buffer.from(JSON.stringify(value)));
    addJson('source-recipe.json', c.base);
    const sources = c.resources.sources.map((s, i) => {
      const file = `resource-source-${i}.png`, image = new Img(s.w, s.h); image.data.set(s.pixels); add(file, encodePng(image));
      return { id: s.id, w: s.w, h: s.h, file };
    });
    const masks = c.resources.masks.map((m, i) => {
      const file = `resource-mask-${i}.png`, image = new Img(m.w, m.h); image.data.set(Uint32Array.from(m.data, v => v ? 0xffffffff : 0)); add(file, encodePng(image));
      return { id: m.id, w: m.w, h: m.h, file, meaning: 'white=allowed, transparent=excluded; dimensions match sourceRect, with mask(0,0) at its top-left' };
    });
    addJson('resource-index.json', { sources, masks, parts: c.base.parts.map(p => ({ id: p.id, origin: p.origin, raster: p.paint.filter(op => op.kind === 'raster') })) });
    if (c.templateScope) addJson('template-scope.json', c.templateScope);
    if (c.source.kind === 'motion') {
      const snapshot = c.source.snapshot, { w, h } = c.base.canvas;
      let movementMask: { file: string; w: number; h: number; meaning: string } | null = null;
      if (snapshot.movementMask !== null) {
        const image = new Img(w, h); image.data.set(Uint32Array.from(snapshot.movementMask, v => v ? 0xffffffff : 0));
        const file = 'movement-mask.png'; add(file, encodePng(image));
        movementMask = { file, w, h, meaning: 'white=allowed; transparent=locked; preserve exact source RGBA outside mask' };
      }
      const frozenFrames = snapshot.frozenFrames.map((f, i) => {
        const image = new Img(w, h); image.data.set(f.pixels);
        const file = `protected-frame-${i}.png`; add(file, encodePng(image));
        return { frameId: f.frameId, file };
      });
      addJson('approved-motion.json', { rig: snapshot.rig, plan: snapshot.plan, instruction: 'Approved only; preserve neutral recipe poses. MotionPlan controls animation, never replace this with guessed poses.', movementMask, frozenFrames });
    }
    if (request.candidateId) {
      if (!request.candidateSha256) throw new Error('Thiếu hash biến thể cho CLI.');
      const candidate = readQualityVariant(request.root, request.snapshotId, request.candidateId, request.candidateSha256) as { recipe: AssetRecipe };
      addJson('candidate-recipe.json', candidate.recipe);
    }
    return json({ files });
  }
  if (request.operation === 'asset' || request.operation === 'frame' || request.operation === 'retouch' || request.operation === 'retouch-info') {
    if (request.currentContext !== undefined) {
      const current = sourceContext(request.currentContext);
      if (c.source.kind !== current.source.kind) throw new Error('Loại nguồn đã thay đổi.');
      if (c.source.kind === 'motion' && current.source.kind === 'motion') assertMotionApproval(c.source.approval, current.source.snapshot);
      else {
        const hashes = (r: RecipeResources) => ({ sources: r.sources.map(s => ({ id: s.id, w: s.w, h: s.h, hash: qualityRgbaHash(s.pixels) })), masks: r.masks.map(m => ({ id: m.id, w: m.w, h: m.h, hash: createHash('sha256').update(m.data).digest('hex') })) });
        if (JSON.stringify(c.base) !== JSON.stringify(current.base) || JSON.stringify(hashes(c.resources)) !== JSON.stringify(hashes(current.resources))) throw new Error('Recipe/tài nguyên nguồn đã thay đổi.');
        if (JSON.stringify(c.templateScope) !== JSON.stringify(current.templateScope)) throw new Error('Phạm vi chỉnh từ mẫu đã thay đổi.');
      }
    }
    if (!Number.isSafeInteger(request.revision) || request.revision < 0) throw new Error('Revision không hợp lệ.');
    if (c.source.kind === 'motion' && request.revision !== c.source.snapshot.source.revision) throw new Error('Revision snapshot chuyển động không khớp.');
    const variant = readQualityVariant(request.root, request.snapshotId, request.candidateId, request.candidateSha256) as { recipe: AssetRecipe; retouch?: { version: 1; parentVariantId: string; constraints: FrameRetouchConstraints } };
    if (c.templateScope && (request.operation === 'retouch-info' || request.operation === 'retouch')) throw new Error('Đề xuất chỉnh từ mẫu dùng lệnh sửa theo layer.');
    if (variant.retouch !== undefined && variant.retouch.version !== 1) throw new Error('Phiên bản retouch không hỗ trợ.');
    if (request.operation === 'retouch-info') {
      const prepared = prepareFrameRetouch(variant.recipe, { patches: [], lockedFrames: [], region: null }, c.context, variant.retouch?.constraints);
      const frame = prepared.recipe.frames.find(f => f.id === request.frameId);
      if (!frame) throw new Error('Không tìm thấy frame cần chỉnh.');
      const { w, h } = prepared.recipe.canvas;
      let movementMask: string | null = null;
      if (c.source.kind === 'motion' && c.source.snapshot.movementMask !== null) {
        const image = new Img(w, h); image.data.set(Uint32Array.from(c.source.snapshot.movementMask, v => v ? 0xffffffff : 0));
        movementMask = encodePng(image).toString('base64');
      }
      return json({ revision: request.revision, w, h, palette: prepared.recipe.palette, frameId: request.frameId, pixelEdits: frame.pixelEdits ?? [],
        constraints: prepared.constraints, sourceLockedFrames: c.source.kind === 'motion' ? c.source.snapshot.frozenFrames.map(f => f.frameId) : [], movementMask });
    }
    if (request.operation === 'retouch') {
      const prepared = prepareFrameRetouch(variant.recipe, request.input, c.context, variant.retouch?.constraints);
      const controlledParent = c.source.kind === 'motion' ? verifyMotionCandidate(c.source.approval, c.source.snapshot, variant.recipe).recipe : variant.recipe;
      const controlled = c.source.kind === 'motion' ? verifyMotionCandidate(c.source.approval, c.source.snapshot, prepared.recipe).recipe : prepared.recipe;
      assertFrameRetouchPixels(createRecipeRenderer(controlledParent, c.resources), createRecipeRenderer(controlled, c.resources), prepared.constraints, prepared.frameIds);
      const inspected = renderQuality({ mode: 'quality-render', operation: 'inspect', revision: request.revision, recipe: controlled, resources: c.resources });
      const inspection = JSON.parse(Buffer.from(inspected.data).toString('utf8')) as QualityInspection;
      const id = randomUUID(), description = 'Chỉnh pixel cục bộ';
      const summary: QualityVariantSummary = { id, kind: 'edited', parentVariantId: request.candidateId, description, w: inspection.w, h: inspection.h, frames: inspection.frames.map(({ id, durationMs, rgbaSha256 }) => ({ id, durationMs, rgbaSha256 })), loop: inspection.loop };
      const recipeSha256 = writeQualityVariant(request.root, request.snapshotId, id, { recipe: prepared.recipe, controlledRecipe: controlled, description, inspection, retouch: { version: 1, parentVariantId: request.candidateId, constraints: prepared.constraints } });
      return json({ variant: summary, recipeSha256 });
    }
    if (c.source.kind === 'motion') {
      const checked = verifyMotionCandidate(c.source.approval, c.source.snapshot, variant.recipe);
      return renderQuality({ mode: 'quality-render', operation: request.operation === 'asset' ? 'asset' : 'frame', revision: request.revision, recipe: checked.recipe, resources: c.resources, ...(request.operation === 'frame' ? { frameId: request.frameId! } : {}) } as Parameters<typeof renderQuality>[0]);
    }
    const input = { mode: 'quality-render' as const, revision: request.revision, recipe: variant.recipe, resources: c.resources };
    return request.operation === 'asset' ? renderQuality({ ...input, operation: 'asset', ...(c.templateScope ? { preserveLayers: true } : {}) })
      : renderQuality({ ...input, operation: 'frame', frameId: request.frameId! });
  }
  if (request.operation !== 'validate') throw new Error('Thao tác stage chất lượng không hợp lệ.');
  // Keep failed/valid responses for review, not in SSE. Filename is assigned locally, never by AI.
  const responseBytes = Buffer.from(request.output);
  writeFileSync(safePath(qualityDirectory(request.root, request.snapshotId), `response-${randomUUID()}.json`), JSON.stringify({ receivedBytes: responseBytes.length, truncated: responseBytes.length > 2_000_000, body: responseBytes.subarray(0, 2_000_000).toString('utf8') }), { flag: 'wx' });
  let value: ReturnType<typeof parseQualityJson>;
  try { value = parseQualityJson(request.output); }
  catch (e) { return json({ technicalError: (e as Error).message }); }
  try {
    const characterStudy = request.characterStudy === true && !c.locked && !c.templateScope && !request.terrainReview
      && c.base.frames.length === 1 && !c.base.frames[0].poses.length && !c.base.frames[0].pixelEdits?.length
      && Math.max(c.base.canvas.w, c.base.canvas.h) <= 128 && c.base.parts.every(part => !part.paint.length);
    const finishStudy = characterStudy && request.characterFinishStudy === true && c.base.palette.length >= 4;
    if (request.role === 'director') {
      let toneComparison: CharacterToneComparison | undefined;
      const director = finishStudy ? validateCharacterConstruction(value, c.base, c.context, 'proposal', comparison => { toneComparison = comparison; })
        : validateQualityDirector(value, c.base, c.context, c.locked || !!c.templateScope);
      if (characterStudy && !director.allowedOperations.some(op => op !== 'raster')) throw new Error('Chỉ đạo nhân vật cần ít nhất một lệnh vẽ trực tiếp.');
      return json({ kind: 'director', director, ...(toneComparison ? { toneComparison } : {}) });
    }
    if (!request.director) throw new Error('Thiếu chỉ đạo đã chốt.');
    const director = finishStudy ? validateCharacterConstruction(request.director, c.base, c.context, 'approved')
      : validateQualityDirector(request.director, c.base, c.context, c.locked || !!c.templateScope);
    const characterBuilder = request.role === 'builder' && characterStudy;
    let candidate: { recipe: AssetRecipe; description: string };
    if (request.role === 'builder' && finishStudy) candidate = buildCharacterFinish(value, c.base, director, c.context);
    else if (request.role === 'builder' && c.templateScope) candidate = validateQualityReview(value, c.base, director, c.base, c.context, c.templateScope.partIds.length);
    else if (request.role === 'builder') {
      if (characterBuilder && !Object.hasOwn(value, 'recipe')) value = expandCharacterPaint(value, c.base, director);
      const normalized = characterBuilder ? normalizeCharacterMarks(value, c.base, director) : 0;
      candidate = c.locked && !Object.hasOwn(value, 'recipe')
        ? validateQualityReview(value, c.base, director, c.base, c.context, c.base.parts.length + c.base.frames.length)
        : validateQualityBuilder(value, c.base, director, c.context);
      if (normalized > 0) {
        const note = ` Studio đã chuyển ${normalized} polygon hai điểm thành nét pixel cùng tọa độ và màu.`;
        candidate.description = candidate.description.slice(0, 4000 - note.length).trimEnd() + note;
      }
    }
    else if (request.role === 'reviewer') {
      if (!request.candidateId || !request.candidateSha256) throw new Error('Thiếu bản dựng để review.');
      const original = readQualityVariant(request.root, request.snapshotId, request.candidateId, request.candidateSha256) as { recipe: AssetRecipe };
      candidate = finishStudy ? validateCharacterReview(value, c.base, director, original.recipe, c.context)
        : validateQualityReview(value, c.base, director, original.recipe, c.context);
    } else throw new Error('Vai chất lượng không hợp lệ.');
    if (c.templateScope) verifyTemplateCandidate(c.base, candidate.recipe, c.resources, c.templateScope);
    const motion = c.source.kind === 'motion' ? verifyMotionCandidate(c.source.approval, c.source.snapshot, candidate.recipe) : undefined;
    const controlled = motion?.recipe ?? candidate.recipe;
    const inspected = renderQuality({ mode: 'quality-render', operation: 'inspect', revision: c.source.kind === 'motion' ? c.source.snapshot.source.revision : 0, recipe: controlled, resources: c.resources });
    const inspection = JSON.parse(Buffer.from(inspected.data).toString('utf8')) as QualityInspection;
    const id = randomUUID(), variant: QualityVariantSummary = { id, kind: request.role === 'builder' ? 'builder' : 'reviewed', description: candidate.description, w: inspection.w, h: inspection.h, frames: inspection.frames.map(({ id, durationMs, rgbaSha256 }) => ({ id, durationMs, rgbaSha256 })), loop: inspection.loop };
    const { w, h } = controlled.canvas;
    const staticBuilder = request.role === 'builder' && !c.locked && controlled.frames.length === 1;
    const side = Math.max(w, h), detailScale = staticBuilder ? side <= 64 ? 4 : side <= 128 ? 2 : 1 : 1;
    const terrainReview = Boolean(request.terrainReview && staticBuilder && w === h && (w === 16 || w === 32));
    const images = sheets(controlled, c.resources, detailScale, terrainReview, request.role === 'builder' ? motion : undefined, characterBuilder);
    let reviewNotes: string | undefined;
    if (finishStudy && staticBuilder) {
      const nativeRenderer = createRecipeRenderer(controlled, c.resources);
      const full = inspection.frames[0].bounds;
      const head = characterPartBounds(controlled, c.resources, id => /(?:^|[-_])(?:head|face|helm(?:et)?|hair|cheek|eyes?)(?:[-_]|$)/i.test(id));
      if (full && head) {
        const legs = characterPartBounds(controlled, c.resources, id => /(?:^|[-_])(?:legs?|boots?|shins?|foot|feet)(?:[-_]|$)/i.test(id));
        const hips = characterPartBounds(controlled, c.resources, id => /(?:^|[-_])(?:hips?|pelvis|waist)(?:[-_]|$)/i.test(id));
        const bodyHeight = legs ? legs.y + legs.h - head.y : full.h;
        const ratio = bodyHeight > 0 ? (100 * head.h / bodyHeight).toFixed(1) + '%' : 'chưa xác định';
        const x = Math.max(0, head.x - 2), y = Math.max(0, head.y - 2);
        const right = Math.min(w, head.x + head.w + 2), bottom = Math.min(h, head.y + head.h + 2);
        const frame = nativeRenderer.renderFrame(controlled.frames[0].id).image;
        const crop = frame.sub(x, y, right - x, bottom - y);
        let detail = crop, detailName = 'review-head-4x.png';
        const heightLabel = legs ? 'đỉnh đầu đến đế' : 'hình tổng hợp (có thể gồm trang bị)';
        const landmarks = [hips && `Hông y=${hips.y}–${hips.y + hips.h - 1}.`, legs && `Chân y=${legs.y}–${legs.y + legs.h - 1}.`].filter(Boolean).join(' ');
        reviewNotes = `Đầu ${head.h} px trên ${heightLabel} ${bodyHeight} px (${ratio}). ${landmarks} Crop đầu 4× bắt đầu tại (x=${x}, y=${y}) trên canvas. Với người RPG đứng tự nhiên, kiểm tra tỷ lệ và điểm chịu lực ở ảnh toàn hình. Nếu đầu, hông hoặc chân lệch, ưu tiên vẽ lại cả mảng đó và nối khớp trước khi sửa các điểm sáng. Ở mặt mở, đặt mảng tối dưới vành, mắt đọc riêng, gom điểm sáng ở má thay vì phủ cùng sắc sáng toàn mặt.`;
        let cropNotes = characterCropNotes('Head crop', crop, x, y, controlled.palette);
        const handle = controlled.parts.find(part => /(?:^|[-_])(?:grip|hilt)(?:[-_]|$)/i.test(part.id));
        const handId = handle?.parentId ?? controlled.parts.find(part => /(?:^|[-_])(?:blade|sword|dagger|staff|axe)(?:[-_]|$)/i.test(part.id)
          && part.parentId && /(?:^|[-_])(?:hand|glove|gauntlet)(?:[-_]|$)/i.test(part.parentId))?.parentId;
        const grip = characterPartBounds(controlled, c.resources, id => handle
          ? id === handle.id || id === handId
          : handId ? id === handId : /(?:^|[-_])near[-_](?:hand|glove|gauntlet)(?:[-_]|$)/i.test(id));
        if (grip) {
          const gx = Math.max(0, grip.x - 3), gy = Math.max(0, grip.y - 3);
          const gr = Math.min(w, grip.x + grip.w + 3), gb = Math.min(h, grip.y + grip.h + 3);
          const gripCrop = frame.sub(gx, gy, gr - gx, gb - gy);
          detail = new Img(crop.w + 1 + gripCrop.w, Math.max(crop.h, gripCrop.h));
          detail.blit(crop, 0, 0);
          detail.blit(gripCrop, crop.w + 1, 0);
          detailName = 'review-head-grip-4x.png';
          reviewNotes += ` Trong ảnh chi tiết, đầu ở bên trái. Crop bàn tay/trang bị 4× bên phải bắt đầu tại (x=${gx}, y=${gy}). Đối chiếu cổ tay, mảng khớp tay và chuôi trên chính ảnh. Tay phải có một khối nhìn thấy chồng lên chuôi; giữ hướng cầm nhất quán và tách màu khớp tay khỏi kim loại của chắn tay ở 1×.`;
          cropNotes += characterCropNotes('Grip crop', gripCrop, gx, gy, controlled.palette);
        }
        reviewNotes += cropNotes;
        images.push({ name: detailName, base64: encodePng(detail.scale(4)).toString('base64') });
      }
      const joints = characterJointNotes(controlled, nativeRenderer);
      if (joints) reviewNotes = (reviewNotes ?? '') + joints;
    }
    if (terrainReview && (w === 16 || w === 32)) {
      const image = createRecipeRenderer(controlled, c.resources).renderFrame(controlled.frames[0].id).image;
      const { horizontal, vertical } = terrainEdgeDifferences(image.data, w);
      reviewNotes = `Kiểm tra RGBA của ô gốc ${w}×${h}. Mép trái/phải khác nhau ở ${horizontal.length} hàng y=${JSON.stringify(horizontal)}. Mép trên/dưới khác nhau ở ${vertical.length} cột x=${JSON.stringify(vertical)}. Tọa độ bắt đầu từ 0. Đây là các vị trí cần xem trong ảnh lặp. Hai pixel kề nhau có thể đổi màu tự nhiên khi một mảng đá hay khe ghép tiếp tục qua biên. Cặp mép cùng màu vẫn có thể tạo dải viền lặp. Kiểm tra hai hàng/cột phía trong mỗi mép cùng chỗ nối trên ảnh lặp và bản đồ; sửa khung ô, dải sáng/tối thẳng hoặc cụm đá kết thúc hàng loạt tại biên. Giữ các mảng vật liệu liên tục xuyên biên và sửa trong lượt hiện có.`;
      const contrast = terrainBoundaryContrast(image.data, w);
      if (contrast) {
        const { leftRight, topBottom } = contrast;
        reviewNotes += ` Chênh sáng trung bình giữa hai pixel kề (0–255, dải nối / trong ô): trái–phải ${leftRight.band.toFixed(1)} / ${leftRight.inside.toFixed(1)}, trên–dưới ${topBottom.band.toFixed(1)} / ${topBottom.inside.toFixed(1)}. Nếu dải nối nổi bật, xem ảnh lặp để tìm vệt dài gần mép trước khi sửa. Mức chênh chỉ gợi ý vị trí kiểm tra, không dùng để chấm chất lượng.`;
      }
    }
    const recipeSha256 = writeQualityVariant(request.root, request.snapshotId, id, { recipe: candidate.recipe, controlledRecipe: controlled, description: candidate.description, inspection });
    return json({ kind: 'variant', variant, images, recipeSha256, ...(reviewNotes ? { reviewNotes } : {}) });
  } catch (e) {
    // Artifact tampering/I/O errors are system failures, never another AI repair.
    if ((e as NodeJS.ErrnoException).code || /đã bị thay đổi|Thiếu bản dựng|Thiếu chỉ đạo/.test((e as Error).message)) throw e;
    return json({ technicalError: (e as Error).message });
  }
}
