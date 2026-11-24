import { dataArray, dataId, dataNumber, dataObject } from '../../studio/quality/data.ts';
import { luma8 } from '../../core/color.ts';
import { assembleCharacter } from '../../studio/quality/character-assembly.ts';
import { MAX_CHARACTER_COMMAND_LENGTH, MAX_CHARACTER_TOUCHUP_COMMANDS, MAX_LARGE_CHARACTER_CLUSTER_SIDE, validateQualityBuilder, validateQualityDirector, validateQualityReview, type QualityBuilder, type QualityDirector, type QualityReview } from '../../studio/quality/protocol.ts';
import { MAX_PIXEL_ROW_SIDE, MAX_RECIPE_COORDINATES, MAX_RECIPE_OPERATIONS, PIXEL_ROW_SYMBOLS, type AssetRecipe, type RecipeContext, type RecipePaintOp, type RecipePoint } from '../../studio/quality/recipe.ts';
import { createRecipeRenderer, type RecipeRenderer } from '../../studio/quality/renderer.ts';
import type { CharacterToneChange, CharacterToneComparison } from './quality-ports.ts';

/** Expand only the art operations. The model cannot respecify canvas or pose metadata. */
export function expandCharacterPaint(value: Record<string, unknown>, base: AssetRecipe, director: QualityDirector): Record<string, unknown> {
  const proposal = dataObject(value, ['version', 'description', 'parts'], 'Bản vẽ nhân vật');
  const paint = new Map<string, unknown[]>();
  for (const raw of dataArray(proposal.parts, director.parts.length, director.parts.length, 'Bộ phận vẽ')) {
    const part = dataObject(raw, ['partId', 'paint'], 'Bộ phận vẽ');
    const id = dataId(part.partId, 'ID bộ phận vẽ');
    if (paint.has(id)) throw new Error(`Bộ phận vẽ ${id} xuất hiện hai lần.`);
    paint.set(id, dataArray(part.paint, 0, MAX_RECIPE_OPERATIONS, `Nét vẽ ${id}`));
  }
  const parts = director.parts.map(part => {
    const ops = paint.get(part.id);
    if (!ops) throw new Error(`Thiếu nét cho bộ phận đã chốt ${part.id}.`);
    return { ...part, paint: ops };
  });
  return { version: proposal.version, description: proposal.description, recipe: { ...base, materials: director.materials, parts } };
}

function axisMark(value: unknown, base: AssetRecipe): RecipePaintOp | undefined {
  try {
    const op = dataObject(value, ['kind', 'points', 'color'], 'Nét nhân vật');
    if (op.kind !== 'polygon' || !Array.isArray(op.points) || op.points.length !== 2) return;
    const [a, b] = op.points.map(value => {
      const point = dataObject(value, ['x', 'y'], 'Điểm nét');
      return {
        x: dataNumber(point.x, 0, base.canvas.w - 1, 'X', true),
        y: dataNumber(point.y, 0, base.canvas.h - 1, 'Y', true),
      };
    });
    if ((a.x !== b.x) === (a.y !== b.y)) return;
    const color = dataNumber(op.color, 0, base.palette.length - 1, 'Màu nét', true);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const dx = a.x === b.x ? 0 : 1, dy = a.y === b.y ? 0 : 1;
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + 1;
    return { kind: 'pixels', pixels: Array.from({ length }, (_, offset) => ({ x: x + dx * offset, y: y + dy * offset, color })) };
  } catch {
    return;
  }
}

/** Decode unambiguous two-point highlights in a fresh character proposal. Strict recipe validation still runs afterward. */
export function normalizeCharacterMarks(value: Record<string, unknown>, base: AssetRecipe, director: QualityDirector): number {
  if (!director.allowedOperations.includes('polygon') || !director.allowedOperations.includes('pixels')) return 0;
  const recipe = value.recipe as { parts?: { paint?: unknown[] }[] } | null | undefined;
  if (!Array.isArray(recipe?.parts)) return 0;
  let repaired = 0;
  for (const part of recipe.parts) {
    if (!Array.isArray(part?.paint)) continue;
    for (const [i, op] of part.paint.entries()) {
      const points = (op as { points?: unknown } | null)?.points;
      if (!Array.isArray(points) || points.length !== 2) continue;
      const mark = axisMark(op, base);
      if (!mark) continue;
      part.paint[i] = mark;
      repaired++;
    }
  }
  return repaired;
}

function constructionRecipe(raw: unknown, base: AssetRecipe, director: QualityDirector, context: RecipeContext): AssetRecipe {
  const expanded = expandCharacterPaint({ version: 1, description: director.description, parts: raw }, base, director);
  return validateQualityBuilder(expanded, base, director, context).recipe;
}

function panelPaint(base: AssetRecipe, vertices: RecipePoint[], fill: number, light: number, edge: number,
  isLit: (x: number, y: number) => boolean): RecipePaintOp {
  const { w, h } = base.canvas;
  if (w > 128 || h > 128) throw new Error('Mảng giáp chỉ hỗ trợ canvas tối đa 128×128.');
  for (const color of [fill, light, edge]) dataNumber(color, 0, base.palette.length - 1, 'Màu mảng giáp', true);
  const mask = createRecipeRenderer({
    ...base, palette: [0xffffffff], materials: [],
    parts: [{ id: 'panel', name: 'Panel', parentId: null, pivot: { x: 0, y: 0 }, origin: 'authored', materialIds: [], paint: [{ kind: 'polygon', points: vertices, color: 0 }] }],
    frames: [{ id: 'panel', durationMs: 100, poses: [] }],
  }).renderFrame('panel').image;
  const bounds = mask.bounds();
  if (!bounds) throw new Error('Mảng giáp cần ít nhất một ô có màu.');
  const useRows = w <= MAX_PIXEL_ROW_SIDE && h <= MAX_PIXEL_ROW_SIDE && base.palette.length <= PIXEL_ROW_SYMBOLS.length;
  const rows: string[] = [];
  const pixels: { x: number; y: number; color: number }[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    let row = '';
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (!mask.get(x, y)) { if (useRows) row += '.'; continue; }
      const onShadowEdge = !mask.get(x + 1, y) || !mask.get(x, y + 1);
      const color = onShadowEdge ? edge : isLit(x + 0.5, y + 0.5) ? light : fill;
      if (useRows) row += PIXEL_ROW_SYMBOLS[color];
      else pixels.push({ x, y, color });
    }
    if (useRows) rows.push(row);
  }
  return useRows ? { kind: 'pixels', x: bounds.x, y: bounds.y, rows } : { kind: 'pixels', pixels };
}

function decodeCommand(raw: unknown, base: AssetRecipe): RecipePaintOp {
  const invalid = () => new Error('Lệnh bố cục không hợp lệ. Dùng R, L, P, F, V hoặc X theo mẫu.');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CHARACTER_COMMAND_LENGTH || /[^A-Z0-9a-f.,/ -]/.test(raw)) throw invalid();
  const [kind, ...args] = raw.split(' ');
  const integer = (value: string) => {
    if (!/^\d{1,4}$/.test(value)) throw invalid();
    return Number(value);
  };
  const point = (value: string) => {
    const pair = value.split(',');
    if (pair.length !== 2) throw invalid();
    return { x: integer(pair[0]), y: integer(pair[1]) };
  };
  const color = (value: string) => value === '-' ? null : integer(value);
  if (kind === 'R' && args.length === 5) {
    const [x, y, w, h] = args.slice(0, 4).map(integer);
    return { kind: 'rect', x, y, w, h, color: color(args[4]) };
  }
  if (kind === 'L' && args.length === 5) {
    const [x0, y0, x1, y1] = args.slice(0, 4).map(integer);
    return { kind: 'line', x0, y0, x1, y1, color: color(args[4]) };
  }
  if (kind === 'P' && args.length >= 4 && args.length <= 129) {
    return { kind: 'polygon', points: args.slice(1).map(point), color: color(args[0]) };
  }
  if ((kind === 'F' || kind === 'V') && args.length >= 8 && args.length <= 133) {
    const [fill, light, edge] = args.slice(0, 3).map(integer);
    const [from, second, ...vertices] = args.slice(3).map(point);
    const { w, h } = base.canvas;
    if (from.x > w || second.x > w || from.y > h || second.y > h) throw invalid();
    if (kind === 'V') {
      if (!second.x || !second.y) throw invalid();
      return panelPaint(base, vertices, fill, light, edge, (x, y) =>
        ((x - from.x) / second.x) ** 2 + ((y - from.y) / second.y) ** 2 <= 1);
    }
    const dx = second.x - from.x, dy = second.y - from.y;
    if (!dx && !dy) throw new Error('Hai đầu đường chia mảng giáp phải khác nhau.');
    return panelPaint(base, vertices, fill, light, edge, (x, y) => dx * (y - from.y) < dy * (x - from.x));
  }
  if (kind === 'X' && args.length === 3 && /^[0-9a-f.]+(?:\/[0-9a-f.]+)*$/.test(args[2])) {
    const x = integer(args[0]), y = integer(args[1]), rows = args[2].split('/');
    const { w, h } = base.canvas;
    if (w <= MAX_PIXEL_ROW_SIDE && h <= MAX_PIXEL_ROW_SIDE) return { kind: 'pixels', x, y, rows };
    const side = MAX_LARGE_CHARACTER_CLUSTER_SIDE;
    if (base.palette.length > PIXEL_ROW_SYMBOLS.length || rows.length > side || y + rows.length > h
      || rows.some(row => row.length > side || x + row.length > w)) {
      throw new Error(`Cụm pixel canvas lớn cần nằm trong canvas, tối đa ${side}×${side} và dùng palette tối đa 16 màu.`);
    }
    const pixels = rows.flatMap((row, dy) => Array.from(row).flatMap((symbol, dx) => symbol === '.' ? []
      : [{ x: x + dx, y: y + dy, color: PIXEL_ROW_SYMBOLS.indexOf(symbol) }]));
    if (!pixels.length) throw new Error('Cụm pixel cần ít nhất một ô có màu.');
    return { kind: 'pixels', pixels };
  }
  throw invalid();
}

function decodeConstruction(raw: unknown, partCount: number, base: AssetRecipe) {
  let remaining = MAX_RECIPE_OPERATIONS, sparseCoordinates = 0;
  const attachments = new Map<string, RecipePoint>();
  const layers = dataArray(raw, partCount, partCount, 'Bộ phận bố cục').map(value => {
    const part = dataObject(value, ['partId', 'commands'], 'Bộ phận bố cục');
    const commands = dataArray(part.commands, 0, remaining, 'Lệnh bố cục');
    const partId = dataId(part.partId, 'ID bộ phận bố cục');
    remaining -= commands.length;
    const first = commands[0];
    const socket = typeof first === 'string' ? /^A (\d{1,4}),(\d{1,4})$/.exec(first) : null;
    if (socket) attachments.set(partId, {
      x: dataNumber(Number(socket[1]), 0, base.canvas.w, 'Điểm gắn X', true),
      y: dataNumber(Number(socket[2]), 0, base.canvas.h, 'Điểm gắn Y', true),
    });
    const paint = (socket ? commands.slice(1) : commands).map(command => {
      const op = decodeCommand(command, base);
      if (op.kind === 'pixels' && 'pixels' in op) {
        sparseCoordinates += op.pixels.length;
        if (sparseCoordinates > MAX_RECIPE_COORDINATES) throw new Error('Cụm pixel vượt giới hạn tọa độ.');
      }
      return op;
    });
    return { partId, paint };
  });
  return { layers, attachments };
}

/** Append local commands without making the reviewer reproduce the earlier paint. */
export function expandCharacterReviewTouchups(value: unknown, candidate: AssetRecipe): Record<string, unknown> {
  const review = dataObject(value, ['version', 'description', 'decision', 'patches'], 'Kiểm tra mỹ thuật');
  const patches = dataArray(review.patches, 0, 8, 'Sửa có mục tiêu').map(raw => {
    if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'touchups')) return raw;
    const patch = dataObject(raw, ['partId', 'touchups'], 'Chỉnh nét bộ phận');
    const partId = dataId(patch.partId, 'ID bộ phận sửa');
    const part = candidate.parts.find(part => part.id === partId);
    if (!part) throw new Error('Bộ phận không tồn tại.');
    const commands = dataArray(patch.touchups, 1, MAX_CHARACTER_TOUCHUP_COMMANDS, 'Lệnh chỉnh nét');
    return { partId, paint: [...part.paint, ...commands.map(command => decodeCommand(command, candidate))] };
  });
  return { ...review, patches };
}

function layersMeet(child: Uint32Array, parent: Uint32Array, width: number): boolean {
  return child.some((pixel, index) => {
    if (!pixel) return false;
    const x = index % width;
    return Boolean(parent[index] || parent[index - width] || parent[index + width]
      || (x > 0 && parent[index - 1]) || (x + 1 < width && parent[index + 1]));
  });
}

export function validateCharacterReview(value: unknown, base: AssetRecipe, director: QualityDirector,
  candidate: AssetRecipe, context: RecipeContext): QualityReview {
  const review = dataObject(value, ['version', 'description', 'decision', 'patches'], 'Kiểm tra mỹ thuật');
  const parts = new Map(candidate.parts.map(part => [part.id, part]));
  const max = Math.max(1, Math.floor(Math.max(candidate.canvas.w, candidate.canvas.h) / 16));
  const shifts = new Map<string, RecipePoint>();
  const paint = dataArray(review.patches, 0, 8, 'Sửa có mục tiêu').filter(raw => {
    if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'shift')) return true;
    const patch = dataObject(raw, ['partId', 'shift'], 'Dịch bộ phận');
    const id = dataId(patch.partId, 'ID bộ phận dịch');
    if (!parts.get(id)?.parentId || shifts.has(id)) throw new Error('Chỉ dịch một lần bộ phận còn nối với bộ phận cha.');
    const offset = dataObject(patch.shift, ['x', 'y'], 'Khoảng dịch bộ phận');
    const x = dataNumber(offset.x, -max, max, 'Dịch X', true), y = dataNumber(offset.y, -max, max, 'Dịch Y', true);
    if (!x && !y) throw new Error('Khoảng dịch bộ phận phải khác 0.');
    shifts.set(id, { x, y });
    return false;
  });
  if (!shifts.size) return validateQualityReview(expandCharacterReviewTouchups(value, candidate), base, director, candidate, context);
  if (review.decision !== 'patch') throw new Error('Dịch bộ phận yêu cầu quyết định patch.');
  if (base.parts.some(part => part.paint.length)) throw new Error('Chỉ dịch bộ phận trong bản nhân vật tạo từ canvas trống.');
  const attachments = new Map(candidate.parts.map(({ id, pivot }) => {
    const shift = shifts.get(id);
    return [id, shift ? { x: pivot.x + shift.x, y: pivot.y + shift.y } : pivot];
  }));
  const moved = assembleCharacter(candidate, attachments);
  const changed = moved.parts.filter(({ id, pivot }) => {
    const original = parts.get(id)!.pivot;
    const dx = Math.abs(pivot.x - original.x), dy = Math.abs(pivot.y - original.y);
    if (dx > max || dy > max) throw new Error('Tổng khoảng dịch theo nhánh vượt giới hạn.');
    return dx > 0 || dy > 0;
  });
  const allowed = { ...director, parts: moved.parts.map(({ paint: _, ...part }) => part) };
  const remaining = { ...review, patches: paint, decision: paint.length ? 'patch' : 'keep' };
  const result = validateQualityReview(expandCharacterReviewTouchups(remaining, moved), base, allowed, moved, context);
  const before = createRecipeRenderer(candidate), after = createRecipeRenderer(result.recipe);
  for (const id of shifts.keys()) {
    const parentId = parts.get(id)!.parentId!;
    const a = before.staticPartPixels(id), b = before.staticPartPixels(parentId);
    const c = after.staticPartPixels(id), d = after.staticPartPixels(parentId);
    if (layersMeet(a, b, candidate.canvas.w) && !layersMeet(c, d, candidate.canvas.w)) {
      throw new Error(`Dịch bộ phận ${id} làm mất chỗ ráp với ${parentId}.`);
    }
  }
  return { ...result, decision: 'patch', patchedParts: [...new Set([...changed.map(part => part.id), ...result.patchedParts])] };
}

function recolor(op: RecipePaintOp, from: number, to: number): RecipePaintOp {
  if (op.kind === 'raster') throw new Error('Bố cục nhân vật chỉ nhận nét trực tiếp.');
  if (op.kind === 'pixels') return 'rows' in op
    ? { ...op, rows: op.rows.map(row => row.replaceAll(PIXEL_ROW_SYMBOLS[from], PIXEL_ROW_SYMBOLS[to])) }
    : { ...op, pixels: op.pixels.map(pixel => pixel.color === from ? { ...pixel, color: to } : pixel) };
  return op.color === from ? { ...op, color: to } : op;
}

function applyFinish(recipe: AssetRecipe, finish: 'A' | 'B' | 'C', renderer?: RecipeRenderer): AssetRecipe {
  if (finish === 'C') return recipe;
  const native = renderer ?? createRecipeRenderer(recipe);
  const ramps = new Map(recipe.materials.map(material => [material.id,
    [...material.colors].sort((a, b) => luma8(recipe.palette[a]) - luma8(recipe.palette[b]) || a - b)]));
  const parts = recipe.parts.map(part => {
    const ramp = ramps.get(part.materialIds[0]);
    if (!ramp || ramp.length < (finish === 'A' ? 3 : 4)) return part;
    const i = finish === 'A' ? ramp.length - 1 : 2;
    const from = ramp[i], to = ramp[i - 1];
    const rgba = recipe.palette[from];
    // Keep key planes and the outline separate. Finishes are for small changes in value.
    if (luma8(rgba) - luma8(recipe.palette[to]) > 42) return part;
    let changed = 0, opaque = 0;
    for (const pixel of native.staticPartPixels(part.id)) {
      if (pixel) opaque++;
      if (pixel === rgba) changed++;
    }
    if (!changed || changed * 4 > opaque) return part;
    return { ...part, paint: part.paint.map(op => recolor(op, from, to)) };
  });
  return parts.some((part, index) => part !== recipe.parts[index]) ? { ...recipe, parts } : recipe;
}

function compareTone(original: Uint32Array, a: Uint32Array, b: Uint32Array): CharacterToneComparison {
  let visiblePixels = 0, originalLight = 0;
  const results: [CharacterToneChange, CharacterToneChange] = [
    { changedPixels: 0, strongDifferences: 0, meanLuma: 0 }, { changedPixels: 0, strongDifferences: 0, meanLuma: 0 },
  ];
  const variants = [a, b];
  for (let i = 0; i < original.length; i++) {
    const alpha = original[i] & 255;
    if (alpha !== (a[i] & 255) || alpha !== (b[i] & 255)) throw new Error('Phối màu không được đổi alpha.');
    if (!alpha) continue;
    const originalLuma = luma8(original[i]);
    visiblePixels++;
    originalLight += originalLuma;
    for (const [j, pixels] of variants.entries()) {
      const tone = results[j], luma = luma8(pixels[i]);
      tone.meanLuma += luma;
      if (pixels[i] !== original[i]) tone.changedPixels++;
      if (Math.abs(luma - originalLuma) >= 32) tone.strongDifferences++;
    }
  }
  const mean = (sum: number) => Math.round(sum / Math.max(1, visiblePixels));
  const [first, second] = results.map(tone => ({ ...tone, meanLuma: mean(tone.meanLuma) }));
  return { visiblePixels, originalMeanLuma: mean(originalLight), A: first, B: second };
}

export function validateCharacterConstruction(value: unknown, base: AssetRecipe, context: RecipeContext, stage: 'proposal' | 'approved',
  collectTone?: (value: CharacterToneComparison) => void): QualityDirector {
  const raw = dataObject(value, ['version', 'description', 'materials', 'parts', 'allowedOperations', 'construction'], 'Bố cục nhân vật');
  const { construction, ...direction } = raw;
  if (stage === 'proposal') {
    direction.parts = dataArray(direction.parts, 1, 64, 'Bộ phận bố cục').map(raw => {
      // Stored responses using the earlier full form remain valid.
      if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'name')) return raw;
      const part = dataObject(raw, ['id', 'parentId', 'pivot', 'materialIds'], 'Bộ phận bố cục');
      const id = dataId(part.id, 'ID bộ phận bố cục');
      return { ...part, name: id.replace(/[-_]+/g, ' ').trim() || id, origin: 'authored' };
    });
  }
  let director = validateQualityDirector(direction, base, context, false);
  if (director.allowedOperations.includes('raster')) throw new Error('Bố cục nhân vật chỉ nhận lệnh vẽ trực tiếp.');
  const decoded = stage === 'proposal' ? decodeConstruction(construction, director.parts.length, base) : null;
  let recipe = constructionRecipe(decoded ? decoded.layers : construction, base, director, context);
  if (decoded?.attachments.size) {
    recipe = assembleCharacter(recipe, decoded.attachments);
    director = { ...director, parts: recipe.parts.map(({ paint: _, ...part }) => part) };
  }
  if (stage === 'proposal') {
    const frameId = recipe.frames[0].id;
    const native = createRecipeRenderer(recipe);
    const original = native.renderFrame(frameId).image.data;
    if (!original.some(Boolean)) throw new Error('Bố cục nhân vật không có pixel nhìn thấy.');
    if (collectTone) {
      const render = (finish: 'A' | 'B') => createRecipeRenderer(applyFinish(recipe, finish, native)).renderFrame(frameId).image.data;
      collectTone(compareTone(original, render('A'), render('B')));
    }
  }
  return { ...director, construction: recipe.parts.map(({ id, paint }) => ({ partId: id, paint })) };
}

export function buildCharacterFinish(value: unknown, base: AssetRecipe, director: QualityDirector, context: RecipeContext): QualityBuilder {
  const { finish } = dataObject(value, ['finish'], 'Lựa chọn phối');
  if (finish !== 'A' && finish !== 'B' && finish !== 'C') throw new Error('Lựa chọn phối chỉ nhận A, B hoặc C.');
  const construction = constructionRecipe(director.construction, base, director, context);
  const recipe = applyFinish(construction, finish);
  const descriptions = { A: 'Phối A: dịu điểm sáng nhỏ.', B: 'Phối B: gom sắc độ tối ở mảng nhỏ.', C: 'Phối C: giữ cấu trúc sáng tối ban đầu.' };
  return validateQualityBuilder({ version: 1, description: descriptions[recipe === construction ? 'C' : finish], recipe }, base, director, context);
}
