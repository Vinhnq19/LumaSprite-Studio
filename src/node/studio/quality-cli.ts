import { existsSync, statSync, readdirSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, delimiter, dirname, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dataId } from '../../studio/quality/data.ts';
import { QUALITY_PROVIDERS, type QualityProvider } from '../../studio/quality/run.ts';
import { MAX_LARGE_CHARACTER_CLUSTER_SIDE, qualityCharacterConstructionSchema, qualityCharacterFinishSchema, qualityCharacterResponseSchema, qualityResponseSchema } from '../../studio/quality/protocol.ts';
import { MAX_PIXEL_ROW_SIDE, PIXEL_ROW_SYMBOLS, type AssetRecipe, type RecipePaintOp } from '../../studio/quality/recipe.ts';
import { startDeepSeekRequest, type DeepSeekSettings } from './deepseek-http.ts';
import { qualityDirectory, assertQualityRoot } from './quality-storage.ts';
import { safePath } from './store.ts';
import { startQualityProcess } from './quality-process.ts';
import type { QualityExecution, QualityOwnedTask, QualityCliResult } from './quality-ports.ts';

export interface QualityContextFile { name: string; data: Uint8Array }
export interface QualityCliSettings {
  /** Trusted server configuration/test wrappers, never populated from HTTP. Used by Codex only. */
  providers?: Partial<Record<QualityProvider, { executable: string; prefix?: string[] }>>;
  /** Server-only DeepSeek configuration; fetch/API key never come from a request. */
  deepseek?: DeepSeekSettings;
  motionReviewerEffort?: 'medium';
  characterConstructionEffort?: 'low' | 'medium';
}
interface CallState { snapshotId: string; directory: string; active?: QualityOwnedTask<unknown>; settled: boolean; canceled: boolean; diagnostic?: string }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
/** Identifiable lead of the bounded inline-JSON block in the Codex stdin prompt. */
export const INLINE_JSON_MARKER = 'Inline controlled JSON (no shell read needed)';

function completedCodexAnswer(stdout: string, directory: string): string | undefined {
  if (!stdout.endsWith('\n')) return undefined;
  let complete = false, message: string | undefined;
  try {
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === 'error' || event.type === 'turn.failed') return undefined;
      if (event.type === 'turn.started') { complete = false; message = undefined; }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        complete = false;
        message = event.item.text.trim();
      }
      if (event.type === 'turn.completed') complete = true;
    }
    if (!complete || !message) return undefined;
    const answerPath = safePath(directory, 'answer.json'), info = statSync(answerPath);
    if (!info.isFile() || info.size > 2_000_000) return undefined;
    const answer = readFileSync(answerPath, 'utf8').trim();
    if (answer !== message) return undefined;
    const value: unknown = JSON.parse(answer);
    return value && typeof value === 'object' && !Array.isArray(value) ? answer : undefined;
  } catch { return undefined; }
}

/**
 * Local-only HTTP ownership files, written inside the owned per-call directory.
 * The marker records that THIS process attempted the call (never that the request
 * reached the provider). The receipt records only that the local fetch/reader
 * drained; it never proves provider-side stop, billing or success. Primitive
 * fields only: no credential, prompt, payload, remote outcome or secret. The cold
 * journal reader re-validates this same shape before trusting either file.
 */
export const HTTP_MARKER_FILE = 'http-owner-marker.json';
export const HTTP_RECEIPT_FILE = 'http-settled-receipt.json';
export interface HttpOwnership { version: 1; transport: 'http'; callId: string; snapshotId: string; ownerPid: number }
/** Written before the local HTTP attempt: this process owns the call, not that it was sent. */
export interface HttpOwnerMarker extends HttpOwnership { kind: 'request-attempt' }
/** Written only after the local fetch/reader drained; never a remote stop/billing claim. */
export interface HttpSettledReceipt extends HttpOwnership { kind: 'local-settled'; outcome: 'success' | 'error' | 'canceled' }
export type HttpOwnershipKind = HttpOwnerMarker['kind'] | HttpSettledReceipt['kind'];
const ownershipId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
/** Shared shape check: a reader accepts only the exact marker/receipt fields the writer emits. */
export function isHttpOwnership(value: unknown, kind: HttpOwnershipKind): value is HttpOwnership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.transport !== 'http' || v.kind !== kind || !ownershipId(v.callId) || !ownershipId(v.snapshotId) || !Number.isInteger(v.ownerPid) || (v.ownerPid as number) < 1) return false;
  if (kind === 'request-attempt') return Object.keys(v).length === 6;
  return Object.keys(v).length === 7 && ['success', 'error', 'canceled'].includes(v.outcome as string);
}
/** Atomic temp-then-rename inside the validated owned per-call directory; never overwrite. */
function writeOwnership(root: string, name: string, value: HttpOwnership): void {
  const directory = qualityDirectory(root, value.callId), path = safePath(directory, name), tmp = safePath(directory, `${name}.${randomUUID()}.tmp`), text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 4096) throw Error('Chứng từ HTTP cục bộ vượt giới hạn.');
  writeFileSync(tmp, text, { flag: 'wx' });
  try { if (existsSync(path)) throw Error('Chứng từ HTTP cục bộ đã tồn tại; không ghi đè.'); renameSync(tmp, path); }
  catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Resolve without starting a discovery/login process outside the owned handle. Codex is the only CLI provider. */
export function findQualityExecutable(provider: QualityProvider, configured?: string): string {
  if (provider !== 'codex') throw new Error(provider === 'deepseek'
    ? 'DeepSeek không dùng executable CLI; cấu hình PXL_DEEPSEEK_API_KEY trên máy chủ Studio.'
    : 'Antigravity đã ngừng nhận tác vụ chất lượng mới; không dùng CLI này nữa.');
  const name = configured ?? process.env.PXL_CODEX_CLI ?? 'codex';
  const candidates = isAbsolute(name) || /[\\/]/.test(name) ? [resolve(name)] : (process.env.PATH ?? '').split(delimiter).flatMap(p => process.platform === 'win32' && !/\.exe$/i.test(name) ? [join(p, name + '.exe')] : [join(p, name)]);
  if (configured === undefined && !process.env.PXL_CODEX_CLI && process.platform === 'win32') {
    const root = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'OpenAI/Codex/bin');
    if (existsSync(root)) candidates.push(...readdirSync(root).map(d => join(root, d, 'codex.exe')).filter(p => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs));
  }
  const found = candidates.find(p => existsSync(p) && statSync(p).isFile() && (process.platform !== 'win32' || /\.exe$/i.test(p)));
  if (!found) throw new Error(`Chưa tìm thấy executable codex; cấu hình PXL_CODEX_CLI bằng đường dẫn CLI${process.platform === 'win32' ? ' .exe' : ''}.`);
  return realpathSync(found);
}

const proposalRules = 'Only read the copied context and view its PNGs. Read-only file commands are allowed solely for the named context files if no file-reading tool exists. Do not edit files, execute source code/programs, search projects, invoke subagents, use connected tools or browse. Return one JSON object matching the provided schema.';
const materialIndices = 'materials[].colors is a list of zero-based palette indices, e.g. {"id":"body","name":"Body","colors":[1,2]} selects entries 1 and 2, never raw RGBA.';
const staticDirectorReference = `Plan one static asset. Return version 1 with a short description of the visual plan, materials, parts and allowedOperations. Choose only the parts and operations needed to execute the plan. Use the fixed canvas and palette from context. Part pivots use native canvas coordinates and materialIds reference the proposed materials. ${materialIndices} Do not include paint, frames or poses. ${proposalRules}`;
const motionDirectorReference = `Plan targeted refinements for the approved motion. View the attached artwork and use the fixed configuration in the instructions. Return version 1, a short visual plan in description, and the paint operations needed in allowedOperations. The server reuses the approved parts and materials. Omit parts, materials, rig, frames and poses. ${proposalRules}`;
const motionProtectionReference = 'In the approved motion, movementMask: null means there is no movement-mask image. Never look for a mask in that case. frozenFrames: [] means there are no frozen frames. For listed protections, use the attached PNGs when available and preserve all frozen frames and all pixels outside the allowed mask.';
const reference = `Controlled AssetRecipe v1 reference:
All paint coordinates refer to the shared rest canvas; part.pivot is in the same coordinates.
rect/line/polygon/pixels use integer positions and a palette INDEX; null clears pixels. palette entries are unsigned RGBA (0xRRGGBBAA).
${materialIndices}
raster uses an existing sourceId, sourceRect and integer destination x/y; maskId is an existing sourceRect-sized binary mask or null (local coordinates starting at 0,0).
resource-index.json maps each source/mask ID to its native PNG; source-recipe.json maps these to parts. Preserve visible detail using these raster operations, do not guess the source pixels.
Do not invent external file paths/IDs, JavaScript, new source resources or masks. Do not rescale images or extend the canvas for outlines.
Frames use existing IDs, durationMs and loop. For approved motion, retain neutral base poses and parts/material structure; approved-motion.json controls motion externally.
A frame may carry an optional pixelEdits array of {x, y, color}: x/y are native integer canvas coordinates applied after the motion render, color is a palette INDEX or null to clear that pixel. A frame patch always replaces the WHOLE current list for that frame, so retain every earlier unaffected edit; part.paint stays the shared rest artwork.
For a new static image, parts may be designed by director; use the fixed canvas/palette/header from source-recipe.json and frame poses for those parts.
Reviewer must view all attached native sheets (row-major, 1 transparent pixel gap) and source. Read candidate-recipe.json, then keep or replace part paint OR frame pixelEdits, once: part and frame patches combined at most eight. Frame pixelEdits are allowed only with the director 'pixels' permission.
For approved motion also read approved-motion.json and view the named movement-mask.png/protected-frame PNGs; outside the white mask and every frozen frame must keep its exact final RGBA. Those protection files are not resource-index source/mask IDs. Never override rig/pose/palette/timing and never add another art-review call.
${proposalRules}`;

/** Inline-only instructions for the HTTP provider: no local paths, no file/PNG access. */
const httpReference = `Controlled AssetRecipe v1 reference (inline read-only context):
The controlled context arrives parsed inside this request. No local path, file command, image-viewing tool or project search exists for this request; never attempt them.
"source-recipe.json" in the context files supplies the fixed header: keep name, canvas, palette order, pivot, frame IDs/durationMs and loop exactly. The header excludes poses and pixelEdits.
parts/materials follow the validated director proposal exactly; the source part/material structure stays locked only when the director was validated for approved motion (structureLocked). Keep the source structure exactly in that case; otherwise the director designs the parts.
"resource-index.json" maps each controlled source/mask ID to its native PNG kept on the server. Use only the listed IDs, sourceRect and maskId in raster operations; never request, decode or invent PNG data, base64 or raw RGBA.
Palette entries are unsigned RGBA (0xRRGGBBAA); every color field is a palette INDEX or null to clear that pixel, never a raw color value.
materials[].colors lists the same zero-based palette indices used by paint, e.g. {"id":"body","name":"Body","colors":[1,2]} for palette entries 1 and 2; it is not the top-level palette, so never copy a raw RGBA entry such as 521413887 into it.
Neutral base poses are required only for approved motion. For static/free assets, frame poses belong to the recipe; the director defines parts/materials/allowed paint operations and has no poses field.
When present, "approved-motion.json" is protection metadata, not editable art: keep the approved rig, timing and protected pixels. movementMask is {file, w, h, meaning} or null, and frozenFrames entries are {frameId, file}; both name server-side PNGs held back from this request. They are never resource/mask IDs: do not use those filenames as sourceId/maskId, request the files or paths, or infer their pixels. The server validates the final RGBA outside the white mask and on every frozen frame.
Frame pixelEdits ({x, y, color} in native canvas coordinates, applied after the motion render) are allowed only with the director 'pixels' permission; a frame patch replaces the WHOLE list, so retain every earlier unaffected edit.
Return one compact JSON object matching the supplied schema. Omit indentation, line breaks between fields, Markdown and prose outside the object. Do not edit projects, execute code, add dependencies, or reveal credentials.`;
const pixelRowReference = 'For deliberate pixel clusters, use {"kind":"pixels","x":4,"y":3,"rows":[".001","01121",".121"]}. Omitted trailing dots leave earlier paint untouched, just as explicit dots do. Each 0–f symbol selects an existing zero-based palette index. The widest row and all rows must fit inside the canvas.';
function compactReviewPixels(op: RecipePaintOp) {
  if (op.kind !== 'pixels' || !('pixels' in op)) return op;
  const runs: [number, number, number, number | null][] = [];
  for (const { x, y, color } of [...op.pixels].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const previous = runs.at(-1);
    if (previous && previous[1] === y && previous[0] + previous[2] === x && previous[3] === color) previous[2]++;
    else runs.push([x, y, 1, color]);
  }
  return { kind: 'pixel-runs', runs };
}
function inlineCharacterReview(candidate: AssetRecipe): string {
  const { canvas, palette, materials, parts } = candidate;
  const layers = parts.map(({ id, parentId, pivot, materialIds, paint }) => ({ id, parentId, pivot, materialIds, paint }));
  const full = JSON.stringify({ canvas, palette, materials, parts: layers.map(part => ({ ...part, paint: part.paint.map(compactReviewPixels) })) });
  if (Buffer.byteLength(full) <= 24 * 1024) return full;
  return JSON.stringify({ canvas, palette, materials: materials.map(({ id, colors }) => ({ id, colors })),
    paintOmitted: true, parts: layers.map(({ id, parentId, pivot, materialIds }) => ({ id, parentId, pivot, materialIds })) });
}
const motionBuilderReference = 'For approved motion, return only {version, description, decision, patches}. Use "keep" and [] when the source needs no changes, or "patch" with only the changes requested. Replace a part paint list by partId or frame pixelEdits by frameId. Unlisted parts and frames carry through unchanged. Omit the full recipe, poses and rig.';
const characterBuilderReference = 'Paint the character described by the director. Return {version:1, description, parts:[{partId, paint}]}; list each approved part ID exactly once. Studio owns the canvas, palette, frame, pivot, materials and back-to-front layer order. Omit the recipe and all poses. Use shared native pixel coordinates and existing palette indices. Use polygons with three or more points, or line/pixels for a narrow stroke when allowed. Prefer large connected shapes with a few deliberate highlights. Return compact JSON only.';
const materialPanelReference = 'F base light edge x0,y0 x1,y1 x2,y2 x3,y3 x4,y4 ... lights one side of a directed line, e.g. above a left-to-right horizontal line. V base light edge cx,cy rx,ry x2,y2 x3,y3 x4,y4 ... lights one solid ellipse inside the polygon, e.g. on a rounded cheek or calf. After the first two pairs, at least three points define the panel. Both commands require pixels permission and place a one-pixel shadow along the bottom and right.';
const characterConstructionReference = `Construct one static character on its native pixel grid. No tools. Return JSON only.
List about 10–14 parts from back to front, with {id,parentId,pivot,materialIds}. Use short descriptive IDs, lowercase with hyphens. Keep each pivot in native coordinates.
For each part give {partId,commands}. Commands paint in order within that part:
Start each list with "A x,y": place the part's pivot at (x,y) in its parent's drawing coordinates, or canvas coordinates for roots. Paint in the part's own coordinates. To keep a canvas-aligned drawing, use A equal to that part's pivot. Mark actual neck, hip, wrist and weapon grip locations; put the two mating points inside both painted shapes. Studio resolves these attachments before compositing.
"R x y w h color", "L x0 y0 x1 y1 color", "P color x1,y1 x2,y2 x3,y3 ..." (at least three points).
${materialPanelReference} First establish the silhouette of the face, hands and weight-bearing legs. Use one F or V with a few accents for suitable armor planes.
Use about 40–55 commands total. Spend them on a coherent silhouette, attached joints and large light/shadow masses. Leave decorative marks and local face/grip refinements for the image review. Use integers and zero-based palette indices; color "-" erases in that layer. Include the corresponding rect/line/polygon/pixels values in allowedOperations. ${materialIndices}`;
const constructionRowReference = 'Optional pixel clusters: "X 4 3 .001/01121/.121" draws short rows at (4,3). 0–f selects palette index; dot leaves the previous pixel. Rows must fit the canvas.';

/** Real provider I/O. The quality engine owns retry policy and validates output. */
export class QualityCliTransport {
  readonly root: string;
  private records = new Map<string, CallState>();
  private closed = false;
  private context: (snapshotId: string, candidateId?: string) => QualityOwnedTask<QualityContextFile[]>;
  private settings: QualityCliSettings;
  constructor(context: (snapshotId: string, candidateId?: string) => QualityOwnedTask<QualityContextFile[]>, settings: QualityCliSettings = {}) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'lumasprite-quality-cli-'))); this.context = context;
    // Never structuredClone the trusted fetch seam; clone only plain provider paths.
    this.settings = { ...(settings.providers ? { providers: structuredClone(settings.providers) } : {}), ...(settings.deepseek ? { deepseek: { ...settings.deepseek } } : {}),
      motionReviewerEffort: settings.motionReviewerEffort, characterConstructionEffort: settings.characterConstructionEffort };
  }
  execute(raw: QualityExecution): QualityOwnedTask<QualityCliResult> {
    if (this.closed) throw Error('Transport CLI đã đóng.');
    const request = structuredClone(raw); dataId(request.callId, 'Lượt CLI'); dataId(request.snapshotId, 'Snapshot CLI');
    if (QUALITY_PROVIDERS[request.role] !== request.provider || !['director', 'builder', 'reviewer'].includes(request.role)) throw Error('Vai/provider chất lượng không khớp.');
    if (typeof request.instruction !== 'string' || request.instruction.length > 250000 || !Number.isFinite(request.budgetMs) || request.budgetMs <= 0 || request.budgetMs > 300000) throw Error('Yêu cầu CLI vượt ngân sách.');
    if (this.records.has(request.callId)) throw Error('ID lượt gọi CLI đã tồn tại; không chạy lại tác vụ cũ.');
    if (this.records.size >= 80) throw Error('Kho lịch sử CLI đầy; đóng các lượt cũ trước khi tạo tiếp.');
    const directory = qualityDirectory(this.root, request.callId); mkdirSync(directory);
    const state: CallState = { snapshotId: request.snapshotId, directory, settled: false, canceled: false }; this.records.set(request.callId, state);
    const started = performance.now();
    const promise = (async (): Promise<QualityCliResult> => {
      try {
        // Only Codex resolves an executable. DeepSeek is an HTTP API and is never a CLI.
        const config = request.provider === 'codex' ? this.settings.providers?.codex : undefined;
        const executable = request.provider === 'codex' ? findQualityExecutable('codex', config?.executable) : '';
        const copy = this.context(request.snapshotId, request.candidateId); state.active = copy;
        const files = await copy.promise; state.active = undefined;
        if (state.canceled) throw Error('Đã hủy trước khi chạy tác vụ chất lượng.');
        let bytes = 0; const saved = new Map<string, string>();
        const save = (file: QualityContextFile) => {
          if (!/^[A-Za-z0-9_-]{1,80}\.(png|json)$/.test(file.name) || !(file.data instanceof Uint8Array) || saved.has(file.name)) throw Error('File ngữ cảnh CLI không hợp lệ/trùng tên.');
          bytes += file.data.length; if (bytes > 80 * 1024 * 1024) throw Error('Ngữ cảnh và ảnh CLI vượt 80 MiB.');
          qualityDirectory(this.root, request.callId); writeFileSync(safePath(directory, file.name), file.data, { flag: 'wx' }); saved.set(file.name, digest(file.data));
        };
        if (!Array.isArray(files) || files.length > 8200 || !Array.isArray(request.images) || request.images.length > 8) throw Error('Ngữ cảnh CLI không hợp lệ.');
        files.forEach(save);
        // Only Codex receives image attachments; HTTP keeps every PNG server-side.
        if (request.provider === 'codex') request.images.forEach(save);
        if (!saved.has('source-recipe.json') || !saved.has('resource-index.json') || (request.role === 'reviewer' && !saved.has('candidate-recipe.json'))) throw Error('Thiếu nguồn hoặc bản dựng để kiểm tra.');
        const jsonFiles = files.filter(f => f.name.endsWith('.json'));
        const templateEdit = saved.has('template-scope.json');
        const templateReference = 'Edit the approved static template strictly within template-scope.json. Preserve other layers, canvas, frame and palette; use only native coordinates. Return JSON only.';
        const verifyCopies = () => { for (const [name, hash] of saved) if (digest(readFileSync(safePath(directory, name))) !== hash) throw Error('CLI đã thay đổi bản sao ngữ cảnh; bỏ đề xuất.'); };
        const pixelRowsAllowed = (source: AssetRecipe) => request.director?.allowedOperations.includes('pixels') === true
          && source?.frames?.length === 1 && source.canvas.w <= MAX_PIXEL_ROW_SIDE && source.canvas.h <= MAX_PIXEL_ROW_SIDE
          && source.palette.length <= PIXEL_ROW_SYMBOLS.length;

        if (request.provider === 'deepseek') {
          // Inline JSON only: exact controlled names/content, never PNG/base64/RGBA or absolute paths.
          let context: { files: Record<string, unknown> };
          try { context = { files: Object.fromEntries(jsonFiles.map(f => [f.name, JSON.parse(Buffer.from(f.data).toString('utf8')) as unknown])) }; }
          catch { throw Error('Ngữ cảnh JSON gửi DeepSeek không đọc được.'); }
          const source = context.files['source-recipe.json'] as AssetRecipe;
          const motionBuilder = saved.has('approved-motion.json');
          // Existing operations in a painted source can be preserved even if the director forbids adding them.
          const blankStaticOperations = !motionBuilder && source?.frames?.length === 1
            && Array.isArray(source.parts) && source.parts.every(part => Array.isArray(part.paint) && part.paint.length === 0)
            ? request.director?.allowedOperations : undefined;
          const compactPixelRows = !!blankStaticOperations && pixelRowsAllowed(source);
          const finishChoice = request.characterFinishStep === 'choice';
          const characterBuilder = request.staticCharacterBuilder === true && blankStaticOperations !== undefined;
          const prompt = finishChoice ? request.instruction : `${templateEdit ? templateReference : characterBuilder ? characterBuilderReference : httpReference}\n${motionBuilder ? motionBuilderReference + '\n' : ''}${compactPixelRows ? pixelRowReference + '\n' : ''}${request.instruction}`;
          const schema = finishChoice ? qualityCharacterFinishSchema() : characterBuilder
            ? qualityCharacterResponseSchema(blankStaticOperations, compactPixelRows)
            : qualityResponseSchema(request.role, blankStaticOperations, compactPixelRows, motionBuilder || templateEdit);
          if (prompt.length > 250000) throw Error('Ngữ cảnh DeepSeek vượt 250.000 ký tự; giảm bộ phận hoặc số frame.');
          writeFileSync(join(directory, 'request.md'), prompt, { flag: 'wx' });
          writeFileSync(join(directory, 'response-schema.json'), JSON.stringify(schema), { flag: 'wx' });
          const remaining = Math.floor(request.budgetMs - (performance.now() - started));
          if (state.canceled || remaining <= 0) throw Error('Hết thời gian trước khi gửi DeepSeek API.');
          const ownership: HttpOwnership = { version: 1, transport: 'http', callId: request.callId, snapshotId: request.snapshotId, ownerPid: process.pid };
          // Marker first: it records only that this process is about to hand a
          // request to fetch. It never claims the request reached the provider.
          writeOwnership(this.root, HTTP_MARKER_FILE, { ...ownership, kind: 'request-attempt' } as HttpOwnerMarker);
          // A synchronous start failure leaves the marker without a receipt, which
          // stays conservative for a live owner and terminal for a dead one.
          const task = startDeepSeekRequest({ prompt, schema, ...(finishChoice ? { finishChoice: true } : { context }),
            budgetMs: finishChoice ? Math.min(remaining, 55000) : remaining,
            ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) }, this.settings.deepseek ?? {}); state.active = task;
          let outcome: HttpSettledReceipt['outcome'] = 'error';
          try {
            const result = await task.promise;
            if (state.canceled) { outcome = 'canceled'; throw Error('Đã hủy DeepSeek; bỏ kết quả về muộn.'); }
            verifyCopies();
            // Safe metadata only: never the API key, settings or provider payloads.
            writeFileSync(join(directory, 'call-result.json'), JSON.stringify({ role: request.role, provider: request.provider, transport: result.transport, ...(result.model ? { model: result.model } : {}), usage: result.usage, streamStats: result.streamStats, elapsedMs: performance.now() - started }), { flag: 'wx' });
            outcome = 'success';
            return { output: result.output, usage: result.usage, ...(result.model ? { model: result.model } : {}), transport: result.transport };
          } catch (e) {
            if (state.canceled) outcome = 'canceled';
            throw e;
          } finally {
            // Keep the HTTP diagnostic: no server-side receipt that the provider stopped billing.
            state.diagnostic = task.diagnostic?.() ?? state.diagnostic ?? ''; state.active = undefined;
            // The DeepSeek task resolves only after its local fetch/reader drained,
            // so this bounded local receipt is accurate for success, provider error
            // or a late canceled result. It never asserts remote stop or billing.
            writeOwnership(this.root, HTTP_RECEIPT_FILE, { ...ownership, kind: 'local-settled', outcome } as HttpSettledReceipt);
          }
        }

        const approvedMotion = saved.has('approved-motion.json');
        const motionReviewer = request.role === 'reviewer' && approvedMotion;
        const reviewerSource = request.role === 'reviewer' && !approvedMotion
          ? JSON.parse(Buffer.from(jsonFiles.find(f => f.name === 'source-recipe.json')!.data).toString('utf8')) as AssetRecipe : undefined;
        const reviewRows = !!reviewerSource && pixelRowsAllowed(reviewerSource);
        const motionDirector = request.role === 'director' && approvedMotion;
        const characterConstruction = request.role === 'director' && request.characterFinishStep === 'construction';
        const constructionRows = characterConstruction ? (() => {
          const source = JSON.parse(Buffer.from(jsonFiles.find(f => f.name === 'source-recipe.json')!.data).toString('utf8')) as AssetRecipe;
          if (source.palette.length > PIXEL_ROW_SYMBOLS.length) return '';
          const large = source.canvas.w > MAX_PIXEL_ROW_SIDE || source.canvas.h > MAX_PIXEL_ROW_SIDE;
          return '\n' + constructionRowReference + (large ? ` Use at most ${MAX_LARGE_CHARACTER_CLUSTER_SIDE}×${MAX_LARGE_CHARACTER_CLUSTER_SIDE} pixels per X command; reserve it for a face, joint or contour.` : '');
        })() : '';
        const reviewerOperations = motionReviewer
          ? `Editable paint kinds: ${request.director?.allowedOperations.join(', ') || 'none'}. A part patch replaces its entire paint list. Copy every operation of a kind outside this list exactly, in the same part and order. If only specific frames need cleanup and pixels is allowed, prefer frameId/pixelEdits patches and retain unaffected edits. If a needed change would alter a restricted operation, keep the candidate and describe that limitation.`
          : '';
        const characterTouchups = request.role === 'reviewer' && request.characterFinishStep === 'touchups';
        const touchupRows = characterTouchups && reviewerSource && reviewerSource.palette.length <= PIXEL_ROW_SYMBOLS.length
          ? constructionRowReference + (reviewRows ? '' : ` Use at most ${MAX_LARGE_CHARACTER_CLUSTER_SIDE}×${MAX_LARGE_CHARACTER_CLUSTER_SIDE} pixels per X command.`) : '';
        const codexReference = characterConstruction ? characterConstructionReference + constructionRows
          : characterTouchups ? `Review the attached native sprite and detail images. The inline candidate lists layers from back to front. Use the attached images and native coordinates to choose local improvements. Use only inline data, not shell or file reads. ${materialIndices}
An input pixel-runs entry stores [x,y,length,colour] per horizontal span, with zero-based palette indices or null. This is a read-only abbreviation; never return pixel-runs as a patch. If paintOmitted is true, use the requested local edits, named layers and attached images.
A {partId,shift:{x,y}} patch moves the part and every descendant with native integer offsets. Only shift a part with a parent and keep it visibly joined. The limit on each axis, including ancestor shifts, is floor(max(canvas.w,canvas.h)/16) with a minimum of 1. Preserve attached equipment. All shifts occur before any paint patches.
A {partId,touchups} patch appends commands to that part's current paint. Do not repeat earlier operations. Use native canvas coordinates after shifts and approved paint kinds. R x y width height color draws a rectangle; R x y width height - clears only that part. L x0 y0 x1 y1 color draws a line; P color x1,y1 x2,y2 x3,y3 paints a polygon. ${materialPanelReference} ${touchupRows} Use {partId,paint} for a full replacement. Do not change the canvas, layer hierarchy, palette, animation frames or any source. Return one JSON object matching the schema.`
          : templateEdit ? templateReference
          : reviewRows ? `${reference}\n${pixelRowReference}`
          : request.role === 'director' ? motionDirector ? motionDirectorReference : staticDirectorReference
          : motionReviewer ? `${reference}\n${motionProtectionReference}\n${reviewerOperations}` : reference;
        const contextFiles = jsonFiles.map(f => f.name), readFirst = contextFiles.map(f => JSON.stringify(join(directory, f))).join(', ');
        const filePrompt = `${codexReference}\n${motionDirector ? 'Read these context files only if needed:' : 'Read first:'} ${readFirst}\n${request.instruction}`;
        // A Windows package-identity error can stop the CLI from reading owned copies.
        // Motion reviewers judge the rendered PNGs. Keep paint, existing edits and
        // protections inline, while leaving the immutable rig and poses in the owned files.
        const inlineFiles = motionReviewer ? jsonFiles.filter(file => file.name !== 'source-recipe.json') : jsonFiles;
        let prompt = filePrompt;
        if (characterConstruction) {
          prompt = `${codexReference}\n${request.instruction}`;
        } else if (characterTouchups) {
          const file = jsonFiles.find(f => f.name === 'candidate-recipe.json')!;
          const inline = inlineCharacterReview(JSON.parse(Buffer.from(file.data).toString('utf8')) as AssetRecipe);
          if (Buffer.byteLength(inline) > 24 * 1024) throw Error('Thông tin layer nhân vật vượt 24 KiB.');
          prompt = `${codexReference}\n${INLINE_JSON_MARKER}: authoritative native candidate layer data.\n${inline}\n${request.instruction}`;
        } else if (motionReviewer) {
          const data = Object.fromEntries(inlineFiles.map(f => [f.name, JSON.parse(Buffer.from(f.data).toString('utf8'))]));
          const { movementMask, frozenFrames } = data['approved-motion.json'];
          data['approved-motion.json'] = { movementMask, frozenFrames };
          const candidate: AssetRecipe = data['candidate-recipe.json'];
          data['candidate-recipe.json'] = { ...candidate, frames: candidate.frames.map(({ id, durationMs, pixelEdits }) => ({ id, durationMs, pixelEdits })) };
          const inline = JSON.stringify(data);
          const inlinePrompt = `${codexReference}\n${INLINE_JSON_MARKER}: use the JSON below and the attached native PNGs. Rig and poses are locked by Studio and omitted here. Judge motion from the rendered frames and guide. Do not read files to reconstruct the rig or poses.\n${inline}\n${request.instruction}`;
          if (inlinePrompt.length <= 250000) prompt = inlinePrompt;
        } else if (!approvedMotion && inlineFiles.reduce((total, f) => total + f.data.length, 0) <= 24 * 1024) {
          let inline: string | undefined;
          try { inline = JSON.stringify(Object.fromEntries(inlineFiles.map(f => [f.name, JSON.parse(Buffer.from(f.data).toString('utf8')) as unknown]))); } catch { inline = undefined; }
          const inlinePrompt = inline === undefined ? undefined : `${codexReference}\n${INLINE_JSON_MARKER}: the JSON objects on the next line are the authoritative context. Use them directly and do not run shell/file reads for them. View any attached native PNGs.\n${inline}\n${request.instruction}`;
          if (inlinePrompt !== undefined && inlinePrompt.length <= 250000) prompt = inlinePrompt;
        }
        const schemaPath = join(directory, 'response-schema.json'), answerPath = join(directory, 'answer.json');
        const schema = JSON.stringify(characterConstruction ? qualityCharacterConstructionSchema() : qualityResponseSchema(request.role, undefined, reviewRows, motionDirector || templateEdit, characterTouchups));
        writeFileSync(schemaPath, schema, { flag: 'wx' }); writeFileSync(join(directory, 'request.md'), prompt, { flag: 'wx' });
        const toolOverrides: string[] = [];
        if (characterConstruction) {
          // This role works from the inline prompt and image, so connector startup uses its budget for no benefit.
          toolOverrides.push('--disable', 'plugins', '--disable', 'apps');
          const listBudget = Math.floor(Math.min(5000, request.budgetMs - (performance.now() - started)));
          if (listBudget <= 0 || state.canceled) throw Error('CLI hết thời gian trước khi kiểm công cụ dựng hình.');
          const preflightDir = join(directory, 'connector-preflight');
          mkdirSync(preflightDir);
          const listing = startQualityProcess({ executable, args: [...config?.prefix ?? [], 'mcp', 'list', ...toolOverrides, '--json'],
            cwd: preflightDir, budgetMs: listBudget, input: '' });
          state.active = listing;
          try {
            const listed = await listing.promise;
            if (listed.code !== 0) throw Error('CLI không đọc được danh sách công cụ.');
            const servers = JSON.parse(listed.stdout) as { name: string; enabled: boolean }[];
            if (!Array.isArray(servers) || servers.length > 100) throw Error('Danh sách công cụ không hợp lệ.');
            for (const { name, enabled } of servers) {
              if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name) || typeof enabled !== 'boolean') throw Error('Tên công cụ không hợp lệ.');
              if (enabled) toolOverrides.push('-c', `mcp_servers.${name}.enabled=false`);
            }
          } catch {
            // Do not surface config listing output: it may include credentials.
            throw Error('Không kiểm được cấu hình công cụ cho lượt dựng hình Codex.');
          } finally {
            state.active = undefined;
          }
        }
        const remaining = Math.floor(request.budgetMs - (performance.now() - started));
        if (state.canceled || remaining <= 0) throw Error('CLI hết thời gian trước khi khởi chạy.');
        // Do not ignore user config or select a different Codex model. Both image
        // attachments and read-only file context are passed to the installed CLI.
        const protectionImages = motionReviewer ? files.filter(f => f.name === 'movement-mask.png' || /^protected-frame-\d+\.png$/.test(f.name)).slice(0, 8 - request.images.length) : [];
        const constructionEffort = this.settings.characterConstructionEffort === 'low' ? 'low' : 'medium';
        const reasoning = characterConstruction ? constructionEffort
          : motionReviewer && this.settings.motionReviewerEffort === 'medium' ? 'medium' : undefined;
        const effort = reasoning ? ['-c', `model_reasoning_effort="${reasoning}"`] : [];
        const args = ['exec', ...effort, ...toolOverrides, '--json', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--output-schema', schemaPath, '--output-last-message', answerPath, ...[...request.images, ...protectionImages].flatMap(f => ['--image', join(directory, f.name)]), '-'];
        let sealedAnswer: string | undefined;
        const task = startQualityProcess({ executable, args: [...config?.prefix ?? [], ...args], cwd: directory, budgetMs: remaining, input: prompt,
          ...(request.role === 'reviewer' && (motionReviewer || request.staticCharacterReview) ? { completedOutput: (stdout: string) => {
            sealedAnswer = completedCodexAnswer(stdout, directory);
            return sealedAnswer !== undefined;
          } } : {}) });
        state.active = task;
        const result = await task.promise; state.active = undefined;
        writeFileSync(join(directory, 'stdout.log'), result.stdout, { flag: 'wx' }); writeFileSync(join(directory, 'stderr.log'), result.stderr, { flag: 'wx' });
        if (state.canceled) throw Error('Đã hủy CLI; bỏ kết quả về muộn.');
        // Existing auto permissions remain unchanged. Even if a provider edits
        // the copied context, it cannot silently alter what this call reviewed.
        verifyCopies();
        let output: string, terminal = '', usage: QualityCliResult['usage'] = { unavailable: true };
        for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
          let event: any; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'error' || event.type === 'turn.failed') {
            terminal = line;
            if (result.code === 0) throw Error(`Codex: ${line.slice(0, 3000)}`);
          }
          if (event.type === 'turn.completed' && event.usage) {
            const counters: Record<string, number> = {};
            for (const [to, from] of [['input', 'input_tokens'], ['output', 'output_tokens'], ['cached', 'cached_input_tokens']]) {
              const n = event.usage[from]; if (typeof n === 'number' && Number.isFinite(n) && n >= 0) counters[to] = n;
            }
            if (Object.keys(counters).length) usage = counters;
          }
        }
        // Nonzero exit after the stdout scan: prefer the latest terminal error
        // event, then stderr, then stdout. Trimmed so a trailing newline in the
        // provider stream does not make the reported suffix differ from its text.
        if (result.code !== 0) throw Error(`CLI ${request.provider} thoát mã ${result.code}: ${(terminal || result.stderr || result.stdout).trim().slice(-1800)}`);
        if (existsSync(answerPath) && statSync(answerPath).size > 2_000_000) throw Error('Đề xuất CLI vượt 2 MB.');
        output = existsSync(answerPath) ? readFileSync(safePath(directory, 'answer.json'), 'utf8') : '';
        if (result.completedStop && (sealedAnswer !== output.trim() || completedCodexAnswer(result.stdout, directory) !== sealedAnswer)) {
          throw Error('Phản hồi Codex thay đổi trước khi tiến trình dừng; bỏ đề xuất.');
        }
        writeFileSync(join(directory, 'call-result.json'), JSON.stringify({ role: request.role, provider: request.provider, transport: 'cli', usage, elapsedMs: performance.now() - started }), { flag: 'wx' });
        return { output, usage, transport: 'cli' };
      } finally {
        // An unresolved process/HTTP handle keeps this promise pending. A settled
        // worker/process/request promise confirmed local idleness, including errors.
        state.settled = true;
      }
    })();
    void promise.catch(() => {});
    return { promise, diagnostic: () => state.active?.diagnostic?.() ?? state.diagnostic ?? '', stop: async deadline => {
      state.canceled = true;
      if (state.settled) return true;
      const active = state.active;
      if (!active) return false;
      const stopped = await active.stop(deadline);
      if (stopped) { try { await promise; } catch {} }
      return stopped && state.settled;
    } };
  }
  dropSnapshot(snapshotId: string): void {
    for (const [id, state] of this.records) if (state.snapshotId === snapshotId) {
      if (!state.settled) throw Error('Không dọn ngữ cảnh khi CLI chưa xác nhận dừng.');
      const dir = qualityDirectory(this.root, id); rmSync(dir, { recursive: true, force: true }); this.records.delete(id);
    }
  }
  async close(): Promise<boolean> {
    this.closed = true;
    // Engine must be closed first, so it cannot start another stage while draining.
    if ([...this.records.values()].some(s => !s.settled)) return false;
    assertQualityRoot(this.root);
    if (resolve(dirname(this.root)) !== realpathSync(tmpdir()) || !this.root.split(/[\\/]/).at(-1)!.startsWith('lumasprite-quality-cli-')) throw Error('Không dọn ngoài kho CLI sở hữu.');
    rmSync(this.root, { recursive: true, force: true }); return true;
  }
}
