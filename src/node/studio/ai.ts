import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AiJob, AiProposal, BuildSummary, ProjectDocument, GenerationContext } from '../../studio/types.ts';
import type { CandidateExecutionOptions } from '../../studio/batch-types.ts';
import { validateDesignManifest } from '../../studio/design-manifest.ts';
import { ProjectStore, safePath, StudioError, validateFiles } from './store.ts';
import { normalizeSourcePath, canonicalSourceKey } from './source-name.ts';
import { buildAiPrompt, buildBatchCandidatePrompt, batchResponseSchema } from './ai-prompt.ts';
import { startRender } from './runner.ts';
import { captureArtGuidance, guidanceInfo, withArtGuidance, type ArtGuidanceMode } from './art-guidance.ts';
import { candidateTimeoutMs, DEFAULT_CANDIDATE_TIMEOUT } from '../../studio/ai-budget.ts';
import { aiReference } from './ai-reference.ts';
import { isActiveAiProvider, type ActiveAiProvider, type RecordedAiProvider } from '../../studio/ai-providers.ts';
import { DEEPSEEK_MODEL, deepSeekConfigured, startDeepSeekRequest, type DeepSeekResult, type DeepSeekSettings } from './deepseek-http.ts';
import type { QualityOwnedTask } from './quality-ports.ts';
import { studioCliEnvironment } from './quality-process.ts';
import type { RenderTask } from './runner.ts';
import { diagnosticOf } from '../../studio/diagnostic.ts';

/** Transport selector shared by both prompt builders; HTTP is DeepSeek-only. */
type PromptTransport = 'cli' | 'http';
export interface ProviderStatus {
  available: boolean;
  path?: string;
  message: string;
  transport?: 'cli' | 'http';
  model?: string;
  /** Text-only vs image-capable, so callers can block image-dependent jobs locally. */
  capabilities?: { text: boolean; image: boolean };
}
export interface ProviderSettings { codex?: string; /** Deprecated and ignored: Antigravity is retired. Kept for caller compatibility. */ antigravity?: string; /** Trusted server-only DeepSeek HTTP config; never accepted from HTTP or echoed in responses. */ deepseek?: DeepSeekSettings; timeout?: number; artGuidance?: ArtGuidanceMode; /** Test/managed CLI wrapper arguments, never accepted from HTTP. */ prefix?: string[]; /** Trusted benchmark override for the animation reviewer. */ motionReviewerEffort?: 'medium'; /** Trusted benchmark opt-in for separate construction and finish. */ characterFinishStudy?: boolean;
  /** Trusted effort override for the experimental character director only. */ characterConstructionEffort?: 'low' | 'medium';
}
const schema = { type: 'object', properties: { description: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }, required: ['description', 'files'], additionalProperties: false };
function resolveTimeout(settingsTimeout?: number): number {
  if (typeof settingsTimeout === 'number') return settingsTimeout;
  if (process.env.PXL_AI_TIMEOUT) {
    const val = Number(process.env.PXL_AI_TIMEOUT);
    if (!Number.isNaN(val) && val > 0) return val < 1000 ? val * 1000 : val;
  }
  return 600_000;
}
function findExecutable(name: string): Promise<string | undefined> {
  if (existsSync(name)) return Promise.resolve(resolve(name));
  return new Promise(resolvePath => execFile(process.platform === 'win32' ? 'where.exe' : 'which', [name], { env: studioCliEnvironment(), windowsHide: true, timeout: 5000 }, (error, stdout) => resolvePath(error ? undefined : stdout.trim().split(/\r?\n/)[0])));
}
export async function detectProviders(settings: ProviderSettings = {}): Promise<Record<ActiveAiProvider, ProviderStatus>> {
  let codex = await findExecutable(settings.codex ?? process.env.PXL_CODEX_CLI ?? 'codex');
  if (!codex && !settings.codex && !process.env.PXL_CODEX_CLI && process.platform === 'win32') {
    const bundled = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'OpenAI/Codex/bin');
    if (existsSync(bundled)) codex = readdirSync(bundled).map(d => join(bundled, d, 'codex.exe')).filter(p => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }
  let message = 'Chưa tìm thấy Codex CLI. Cài hoặc cấu hình PXL_CODEX_CLI.';
  if (codex) message = await new Promise<string>(r => execFile(codex, [...settings.prefix ?? [], 'login', 'status'], { env: studioCliEnvironment(), windowsHide: true, timeout: 8000 }, (e, out, err) => r(e ? `Cần đăng nhập Codex: ${(out + err).slice(-400)}` : (out + err).includes('Logged in') ? 'Đã đăng nhập Codex.' : 'Tìm thấy CLI; trạng thái đăng nhập cần kiểm tra.')));
  // DeepSeek status is purely local: no fetch, no auth probe, no bridge credential access.
  const deepseekConfigured = deepSeekConfigured(settings.deepseek ?? {});
  return {
    codex: { available: !!codex && message.startsWith('Đã đăng nhập'), path: codex, message, transport: 'cli', capabilities: { text: true, image: true } },
    deepseek: {
      available: deepseekConfigured,
      message: deepseekConfigured
        ? `Đã cấu hình PXL_DEEPSEEK_API_KEY cho ${DEEPSEEK_MODEL} qua HTTP; chưa xác minh bằng yêu cầu mạng (chỉ kiểm tra khi chạy).`
        : 'Chưa cấu hình PXL_DEEPSEEK_API_KEY cho máy chủ Studio.',
      transport: 'http',
      model: DEEPSEEK_MODEL,
      capabilities: { text: true, image: false },
    },
  };
}
/**
 * DeepSeek HTTP is text-only: any image/reference/clip dependent request must be
 * rejected here, before a job, captured context or fetch exists. Never auto-map or drop refs.
 */
export function assertDeepSeekTextOnly(preview?: Uint8Array, generation?: GenerationContext, movementMask?: Uint8Array, options?: CandidateExecutionOptions): void {
  // Presence, not payload size: even an empty supplied buffer means an image/mask contract
  // this transport cannot honour, so it must be rejected rather than silently dropped.
  const needsImages = preview !== undefined || movementMask !== undefined || options?.guideImage !== undefined ||
    Boolean(options?.referenceImages?.length);
  const needsReferences = Boolean(options?.artDirection?.references?.length);
  const needsCapture = Boolean(generation?.options.reference) || generation?.options.animation !== undefined ||
    generation?.animation !== undefined || generation?.operation === 'region-edit' ||
    generation?.operation === 'clip-regenerate' || Boolean(generation?.clip);
  if (needsImages || needsReferences || needsCapture) {
    throw new StudioError('DeepSeek API chỉ nhận yêu cầu văn bản thuần (không ảnh tham chiếu, mask, clip hay vùng chỉnh sửa). Tác vụ này cần Codex.');
  }
}
/** Minimal inline HTTP context: no absolute paths, no pixels and no file-reading instructions. */
function deepSeekContext(job: AiJob): Record<string, unknown> {
  const g = job.generation;
  const context: Record<string, unknown> = { transport: 'http', source: 'inline captured source', files: 'inline captured source' };
  if (g) {
    context.generation = {
      assetId: g.assetId, w: g.w, h: g.h, palette: g.palette, options: g.options,
      ...(typeof job.candidateIndex === 'number' ? { candidateIndex: job.candidateIndex } : {}),
    };
    if (g.clip) context.clip = { name: g.clip.context.name, w: g.clip.context.w, h: g.clip.context.h, slots: g.clip.context.slots.length, helperFiles: g.clip.helperFiles.length };
  }
  return context;
}
interface Running { child?: ChildProcess; render?: RenderTask; /** Owned local HTTP handle; retained until its local I/O is drained. */ http?: QualityOwnedTask<DeepSeekResult>; cancel: boolean; timer?: ReturnType<typeof setTimeout>; work?: string; deadline?: number; settled?: Promise<void> }
export class AiManager {
  jobs = new Map<string, AiJob>();
  cliExecutions = 0;
  private active = new Map<string, Running>();
  private inputs = new Map<string, ProjectDocument>();
  private completions = new Map<string, { promise: Promise<AiJob>; resolve: (job: AiJob) => void }>();
  private cancelPromises = new Map<string, Promise<AiJob>>();
  private store: Pick<ProjectStore, 'load' | 'save'> & Partial<Pick<ProjectStore, 'dir'>>;
  private emit: (event: unknown) => void;
  private settings: ProviderSettings;
  constructor(store: AiManager['store'], emit: (event: unknown) => void, settings: ProviderSettings = {}) { this.store = store; this.emit = emit; this.settings = settings; }
  get(id: string): AiJob { const j = this.jobs.get(id); if (!j) throw new StudioError('Không tìm thấy tác vụ AI.', 404); return j; }
  private changed(job: AiJob): void { this.emit({ type: 'ai', job }); }
  captureGuidance(generation?: GenerationContext, prompt = '') {
    return captureArtGuidance(this.settings.artGuidance ?? process.env.PXL_ART_GUIDANCE ?? 'baseline', generation, prompt);
  }
  candidateBudgetMs(): number { return candidateTimeoutMs(resolveTimeout(this.settings.timeout)); }
  async start(doc: ProjectDocument, provider: RecordedAiProvider, prompt: string, preview?: Uint8Array, generation?: GenerationContext, movementMask?: Uint8Array, options?: CandidateExecutionOptions): Promise<AiJob> {
    // Recorded/history values may arrive from persistence, so validate at runtime: only active providers start new work.
    if (!isActiveAiProvider(provider)) throw new StudioError(provider === 'antigravity' ? 'Antigravity đã ngừng hỗ trợ. Chọn Codex hoặc DeepSeek API.' : 'Chọn Codex hoặc DeepSeek API và nhập yêu cầu 1–12.000 ký tự.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw new StudioError('Chọn CLI và nhập yêu cầu 1–12.000 ký tự.');
    if (provider === 'deepseek') assertDeepSeekTextOnly(preview, generation, movementMask, options);
    if ([...this.jobs.values()].some(j => j.projectId === doc.id && ['running', 'validating', 'canceling', 'unknown'].includes(j.status))) throw new StudioError('Dự án đang có tác vụ AI. Hãy hủy hoặc chờ tác vụ hiện tại.', 409);
    const snapshot = structuredClone(doc);
    const frozenPreview = preview ? new Uint8Array(preview) : undefined;
    const frozenMask = movementMask ? new Uint8Array(movementMask) : undefined;
    const frozenGeneration = generation ? structuredClone(generation) : undefined;
    const frozenArtDirection = options?.artDirection ? structuredClone(options.artDirection) : undefined;
    const frozenGuideImage = options?.guideImage ? { name: 'clip-guide.png', data: new Uint8Array(options.guideImage.data) } : undefined;
    const frozenRefImages = options?.referenceImages
      ? options.referenceImages.slice(0, 3).map((r, i) => ({ name: `art-ref-${i + 1}.png`, data: new Uint8Array(r.data) }))
      : undefined;
    const frozenOptions: CandidateExecutionOptions = {
      singleAttempt: options?.singleAttempt,
      figureStage: options?.figureStage,
      artGuidance: structuredClone(options?.artGuidance ?? this.captureGuidance(frozenGeneration, prompt)),
      candidateIndex: options?.candidateIndex,
      artDirection: frozenArtDirection,
      referenceImages: frozenRefImages,
      guideImage: frozenGuideImage,
      timeout: options?.timeout,
      deadline: options?.deadline,
    };
    const job: AiJob = {
      id: randomUUID(),
      projectId: doc.id,
      revision: doc.revision,
      provider,
      transport: provider === 'deepseek' ? 'http' : 'cli',
      status: 'running',
      started: Date.now(),
      message: 'Đang chuẩn bị ngữ cảnh…',
      attempt: 0,
      cliExecutions: 0,
      guidance: guidanceInfo(frozenOptions.artGuidance!),
      ...(typeof frozenOptions.candidateIndex === 'number' ? { candidateIndex: frozenOptions.candidateIndex } : {}),
      ...(frozenGeneration ? { generation: frozenGeneration } : {}),
    };
    this.inputs.set(job.id, snapshot);
    this.jobs.set(job.id, job); const state: Running = { cancel: false }; this.active.set(job.id, state); this.changed(job);
    let resolveCompletion!: (j: AiJob) => void;
    const completionPromise = new Promise<AiJob>(r => { resolveCompletion = r; });
    this.completions.set(job.id, { promise: completionPromise, resolve: resolveCompletion });
    while (this.jobs.size > 100) { const previous = [...this.jobs.values()].find(j => !this.active.has(j.id) && !['ready', 'unknown'].includes(j.status)); if (!previous) break; this.jobs.delete(previous.id); this.inputs.delete(previous.id); this.completions.delete(previous.id); }
    state.settled = this.run(job, state, snapshot, prompt, frozenPreview, frozenMask, frozenOptions)
      .catch(e => {
        if (!state.cancel) {
          job.status = 'failed';
          job.message = (e as Error).message;
          job.diagnostic = diagnosticOf(e);
          this.changed(job);
        }
      })
      .finally(() => {
        const comp = this.completions.get(job.id);
        if (comp) comp.resolve(job);
      });
    return job;
  }
  private async run(job: AiJob, state: Running, doc: ProjectDocument, prompt: string, preview?: Uint8Array, movementMask?: Uint8Array, options?: CandidateExecutionOptions): Promise<void> {
    const work = mkdtempSync(join(tmpdir(), 'pxl-studio-ai-')); state.work = work;
    const artDirection = options?.artDirection;
    const referenceImages = options?.referenceImages;
    const guideImage = options?.guideImage;
    const isBatch = typeof options?.candidateIndex === 'number' || Boolean(artDirection) || Boolean(referenceImages?.length) || Boolean(guideImage);
    const requestedBudget = options?.timeout ?? DEFAULT_CANDIDATE_TIMEOUT;
    // Every candidate job, including a legacy DeepSeek source-only call, is bounded by the same candidate budget.
    const timeout = (job.provider === 'deepseek' || isBatch || job.generation)
      ? candidateTimeoutMs(resolveTimeout(this.settings.timeout), requestedBudget)
      : resolveTimeout(this.settings.timeout);
    const deadline = typeof options?.deadline === 'number' && Number.isFinite(options.deadline) ? options.deadline : Infinity;
    state.deadline = Math.min(job.started + timeout, deadline);
    state.timer = setTimeout(() => { void this.cancel(job.id, 'Đã hủy vì tác vụ AI vượt thời gian cho phép.'); }, Math.max(1, state.deadline - Date.now()));
    try {
      let executable: string | undefined;
      // DeepSeek HTTP never requires Codex CLI discovery, login or a render step.
      if (job.provider === 'codex') {
        const providers = await detectProviders(this.settings);
        executable = providers.codex.path;
        if (!executable || !providers.codex.available) throw new Error(providers.codex.message);
      }
      if (state.cancel) return;
      const schemaPath = join(work, 'response-schema.json');
      const reference = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'reference.md');
      let context = existsSync(reference) ? readFileSync(reference, 'utf8') : 'Use pxl DSL globals pal, sprite, scene, anim, frame, grid, rect, stamp and sheet.';
      context = aiReference(context, job.generation);
      job.metrics = { budgetMs: timeout, referenceChars: context.length, promptChars: 0 };
      const refFiles: string[] = [];
      if (job.provider === 'codex') {
        for (const [path, text] of Object.entries(doc.files)) { const file = safePath(work, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
        writeFileSync(schemaPath, JSON.stringify(isBatch ? batchResponseSchema : schema));
        // src/node/studio and dist/node/studio have the same depth from the package root.
        if (preview) writeFileSync(join(work, 'preview.png'), preview);
        else if (!job.generation || job.generation.options.reference) {
          const task = startRender({ document: doc, mode: 'export', format: 'png' }); state.render = task;
          try { const image = await task.promise as { data: Uint8Array }; writeFileSync(join(work, 'preview.png'), image.data); } catch { /* A source-only legacy context may not have an image yet. */ }
          state.render = undefined;
        }
        if (movementMask) writeFileSync(join(work, 'movement-mask.png'), movementMask);
        if (guideImage) writeFileSync(join(work, 'clip-guide.png'), guideImage.data);
        if (referenceImages && referenceImages.length > 0) {
          for (let i = 0; i < referenceImages.length; i++) {
            const ref = referenceImages[i];
            const fileName = `art-ref-${i + 1}.png`;
            writeFileSync(join(work, fileName), ref.data);
            refFiles.push(fileName);
          }
        }
      }
      if (state.cancel) return;

      const ownedHelpers = new Set<string>();
      if (job.generation?.animation?.referenceFile) {
        try {
          ownedHelpers.add(canonicalSourceKey(job.generation.animation.referenceFile));
        } catch {}
      }
      if (job.generation?.clip?.helperFiles) {
        for (const h of job.generation.clip.helperFiles) {
          try {
            ownedHelpers.add(canonicalSourceKey(h));
          } catch {}
        }
      }

      const existingCanonical = new Map<string, string>();
      for (const existingPath of Object.keys(doc.files)) {
        try {
          existingCanonical.set(canonicalSourceKey(existingPath), existingPath);
        } catch {}
      }

      let repair = '';
      for (let attempt = 0; attempt < 2 && !state.cancel; attempt++) {
        const transport: PromptTransport = job.provider === 'deepseek' ? 'http' : 'cli';
        job.attempt = attempt + 1; job.status = 'running';
        job.message = attempt ? 'Đang sửa lỗi dựng thử (lượt cuối)…' : job.provider === 'deepseek' ? 'DeepSeek API đang tạo đề xuất…' : 'CLI đang tạo đề xuất…';
        this.changed(job);
        const baseInstruction = isBatch
          ? buildBatchCandidatePrompt(doc, prompt, context, job.candidateIndex ?? 0, artDirection, refFiles, repair, job.generation, transport, options?.figureStage)
          : buildAiPrompt(doc, prompt, context, repair, job.generation, transport);
        const instruction = withArtGuidance(baseInstruction, options!.artGuidance!);
        job.metrics.promptChars = instruction.length;
        const output = job.provider === 'deepseek'
          ? await this.executeDeepSeek(job, state, instruction, isBatch ? batchResponseSchema : schema)
          : await this.execute(executable!, job, state, work, schemaPath, instruction, refFiles);
        if (state.cancel) return;
        try {
          if (!output.trim()) throw new StudioError('AI không trả nội dung JSON đề xuất.', 400, 'INVALID_ASSET_PAYLOAD');
          let proposal: AiProposal;
          try { proposal = JSON.parse(output.trim()); }
          catch (e) { throw new StudioError((e as Error).message, 400, 'INVALID_ASSET_PAYLOAD'); }
          if (!proposal || typeof proposal.description !== 'string' || !Array.isArray(proposal.files) || !proposal.files.length || proposal.files.length > 100) throw new StudioError('CLI chưa trả JSON đề xuất hợp lệ.', 400, 'INVALID_ASSET_PAYLOAD');
          const replacements: Record<string, string> = {};
          const returnedKeys = new Map<string, string>();
          for (const f of proposal.files) {
            if (typeof f.path !== 'string' || typeof f.content !== 'string') throw new Error('File đề xuất không hợp lệ.');
            if (Buffer.byteLength(f.content) > 2_000_000) throw new Error(`File đề xuất vượt quá 2MB: ${f.path}`);
            let normPath: string;
            let canonKey: string;
            try {
              normPath = normalizeSourcePath(f.path);
              canonKey = canonicalSourceKey(f.path);
            } catch {
              throw new Error(`Đường dẫn file đề xuất không hợp lệ: ${f.path}`);
            }
            if (f.path !== normPath) {
              throw new Error(`Đường dẫn đề xuất không chuẩn hóa: ${f.path}`);
            }
            if (ownedHelpers.has(canonKey)) {
              throw new Error('Không được thay thế nguồn tham chiếu nội bộ. Chỉ trả mã animation mới.');
            }
            if (returnedKeys.has(canonKey)) {
              throw new Error(`File đề xuất chứa alias trùng lặp: ${f.path}`);
            }
            returnedKeys.set(canonKey, f.path);
            if (existingCanonical.has(canonKey)) {
              const existingPath = existingCanonical.get(canonKey)!;
              if (f.path !== existingPath) {
                throw new Error(`Đường dẫn đề xuất không khớp với file nguồn hiện có: ${f.path}`);
              }
            }
            replacements[f.path] = f.content;
          }
          if (Object.keys(replacements).length > 100) throw new Error('Tối đa 100 file nguồn.');
          const candidate = { ...doc, files: { ...doc.files, ...replacements } }; validateFiles(candidate.files, candidate.entry);
          job.status = 'validating'; job.message = 'Đang dựng thử; dự án thật chưa thay đổi.'; this.changed(job);
          const task = startRender({ document: candidate, mode: 'summary', validateFrames: true, validateSource: true, generation: job.generation }); state.render = task;
          const summary = await task.promise as BuildSummary; state.render = undefined;
          if (state.cancel) return;
          if (summary.errors.length) throw new StudioError(summary.errors.join('\n'), 400, 'RENDER_FAILED');

          if (isBatch) {
            if (proposal.manifest !== undefined && proposal.manifest !== null) {
              const canvasW = job.generation?.w ?? summary.assets[0]?.w;
              const canvasH = job.generation?.h ?? summary.assets[0]?.h;
              const mv = validateDesignManifest(proposal.manifest, canvasW, canvasH);
              if (!mv.valid) throw new Error(`Manifest không hợp lệ:\n${mv.errors.join('\n')}`);
              proposal.manifest = mv.manifest;
            } else {
              proposal.manifest = undefined;
            }
          } else {
            delete proposal.manifest;
          }

          job.proposal = proposal; job.build = summary; job.status = 'ready'; job.message = summary.conflicts.length ? `Đã dựng thử. Đề xuất cần chuyển lớp pixel sau khi áp dụng: ${summary.conflicts.join(', ')}.` : 'Đã dựng thử. Xem ảnh và thay đổi trước khi Áp dụng.'; this.changed(job); return;
        } catch (e) {
          if (state.cancel) return;
          if (e instanceof StudioError && e.diagnostic?.code.startsWith('PXL_')) {
            if (this.store.dir) {
              try {
                const root = this.store.dir(job.projectId);
                const evidence = '.pxl/ai-diagnostics/' + job.id + '.json';
                const path = safePath(root, evidence);
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, JSON.stringify({ revision: job.revision, diagnostic: e.diagnostic, output }), { flag: 'wx' });
                e.diagnostic.evidence = evidence;
              } catch {
                // Preserve the source diagnostic if the filesystem cannot store evidence.
              }
            }
            throw e;
          }
          if (attempt || options?.singleAttempt) throw e;
          let sanitizedOutput = output;
          try {
            const parsed = JSON.parse(output.trim());
            if (parsed && Array.isArray(parsed.files)) {
              const safeFiles = parsed.files.map((fileObj: any) => {
                if (fileObj && typeof fileObj.path === 'string') {
                  try {
                    if (ownedHelpers.has(canonicalSourceKey(fileObj.path))) {
                      return { path: fileObj.path, content: '[omitted owned helper content]' };
                    }
                  } catch {}
                }
                return fileObj;
              });
              sanitizedOutput = JSON.stringify({ ...parsed, files: safeFiles });
            }
          } catch {}
          repair = `Your previous response failed validation:\n${(e as Error).message}\nPrevious output:\n${sanitizedOutput.slice(0, 12000)}\nReturn corrected complete JSON once.`;
        }
      }
    } finally {
      clearTimeout(state.timer);
      // Only a still-owned HTTP handle keeps work/active across an unconfirmed or draining stop;
      // a confirmed stop and every local-render cancellation release immediately.
      const retainOwned = job.provider === 'deepseek' && Boolean(state.http) && ['unknown', 'canceling'].includes(job.status);
      if (!retainOwned) {
        this.active.delete(job.id);
        // Cancellation waits for local process-tree shutdown before this cleanup.
        if (job.status !== 'unknown' && (!state.child || state.child.exitCode !== null)) {
          try { rmSync(work, { recursive: true, force: true }); } catch {}
        }
      }
    }
  }
  /** Exactly one owned HTTP call per attempt; transport failures never enter proposal validation repair. */
  private async executeDeepSeek(job: AiJob, state: Running, prompt: string, schemaValue: unknown): Promise<string> {
    if (prompt.length > 250_000) throw new Error('Ngữ cảnh AI vượt 250.000 ký tự. Tách dự án thành phần nhỏ hơn trước khi tạo đề xuất.');
    // Remaining budget is measured before the request exists: an expired deadline must send nothing.
    const remaining = Math.floor((state.deadline ?? Date.now() + this.candidateBudgetMs()) - Date.now());
    if (state.cancel) throw new Error('Đã hủy tác vụ DeepSeek.');
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Đã hết thời gian cho phép trước khi gửi yêu cầu DeepSeek.');
    const task = startDeepSeekRequest({
      prompt,
      schema: schemaValue,
      context: deepSeekContext(job),
      budgetMs: Math.max(1, Math.min(remaining, DEFAULT_CANDIDATE_TIMEOUT)),
    }, this.settings.deepseek ?? {});
    state.http = task;
    // Legacy counter/name: one provider call, no SDK, retries, model or account fallback.
    this.cliExecutions++; job.cliExecutions = (job.cliExecutions ?? 0) + 1; this.changed(job);
    try {
      const result = await task.promise;
      if (state.cancel) throw new Error('Đã hủy tác vụ DeepSeek.');
      job.transport = result.transport;
      job.usage = { ...result.usage };
      // Optional safe metadata only: bounded, printable model name; absent on old results.
      if (typeof result.model === 'string' && result.model.length > 0 && result.model.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(result.model)) job.model = result.model;
      this.changed(job);
      return result.output;
    } finally {
      // The local HTTP handle is drained once its promise settles. Keep it owned while a
      // cancellation is still unconfirmed so a later explicit cancel rechecks the same handle.
      if (!state.cancel && state.http === task) state.http = undefined;
    }
  }
  private execute(executable: string, job: AiJob, state: Running, work: string, schemaPath: string, prompt: string, refFiles: string[] = []): Promise<string> {
    if (prompt.length > 250_000) throw new Error('Ngữ cảnh AI vượt 250.000 ký tự. Tách dự án thành phần nhỏ hơn trước khi tạo đề xuất.');
    const result = join(work, 'answer.json');
    const allImageFiles = ['preview.png', 'movement-mask.png', 'clip-guide.png', ...refFiles].filter(file => existsSync(join(work, file)));
    const args = ['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--output-schema', schemaPath, '--output-last-message', result, ...allImageFiles.flatMap(file => ['--image', join(work, file)]), '-'];
    return new Promise((resolveOutput, reject) => {
      // Codex consumes its prompt on stdin.
      const child = spawn(executable, [...this.settings.prefix ?? [], ...args], { cwd: work, env: studioCliEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); state.child = child;
      child.once('spawn', () => { this.cliExecutions++; job.cliExecutions = (job.cliExecutions ?? 0) + 1; this.changed(job); });
      let out = '', err = '', tooLarge = false;
      child.stdout!.on('data', chunk => { out += chunk.toString(); if (out.length > 8_000_000) { tooLarge = true; void this.cancel(job.id); } });
      child.stderr!.on('data', chunk => { err = (err + chunk.toString()).slice(-12000); });
      child.once('error', e => { reject(new Error(`Không chạy được CLI: ${e.message}`)); });
      child.once('close', code => {
        state.child = undefined;
        if (state.cancel) { reject(new Error(tooLarge ? 'CLI trả dữ liệu quá lớn.' : 'Đã hủy tác vụ.')); return; }
        if (code !== 0) { reject(new Error(`CLI thoát với mã ${code}: ${err || out.slice(-1000)}`)); return; }
        try {
          const failures = out.split(/\r?\n/).filter(Boolean).flatMap(line => { try { const e = JSON.parse(line); return ['error', 'turn.failed'].includes(e.type) ? [line] : []; } catch { return []; } });
          if (failures.length) throw new Error(failures.join('\n'));
          resolveOutput(readFileSync(result, 'utf8'));
        } catch (e) { reject(new Error(`Kết quả CLI không hợp lệ: ${(e as Error).message}`)); }
      });
      child.stdin!.end(prompt);
    });
  }
  async cancel(id: string, reason?: string): Promise<AiJob> {
    const existing = this.cancelPromises.get(id);
    if (existing) return existing;
    const job = this.get(id), state = this.active.get(id);
    if (!state) return job;
    if (job.status === 'unknown') {
      // Only an owned HTTP handle can be rechecked; a CLI `unknown` keeps its original receipt.
      if (!state.http) return job;
    } else if (!['running', 'validating', 'canceling'].includes(job.status)) return job;
    const cancelPromise = (async () => {
      state.cancel = true; clearTimeout(state.timer); job.status = 'canceling'; this.changed(job);
      const http = state.http;
      if (http) {
        // Bounded absolute deadline for the local drain; a later cancel may recheck the same handle.
        let confirmed = false;
        try { confirmed = await http.stop(Date.now() + 5000); } catch { confirmed = false; }
        if (confirmed) {
          // Drain the local run before the terminal state so `canceling` keeps same-project starts blocked.
          await Promise.resolve(state.settled).then(() => undefined, () => undefined);
          job.status = 'canceled';
          job.message = `${reason ? `${reason} ` : ''}Đã dừng nhận kết quả DeepSeek cục bộ; chưa xác nhận nhà cung cấp đã ngừng xử lý/tính phí. Mọi kết quả về muộn bị bỏ qua.`;
          job.diagnostic = { code: 'JOB_CANCELED', message: job.message };
          this.changed(job);
          this.releaseOwned(job, state);
        } else {
          // Unconfirmed stop (including a throwing stop): keep unknown with the owned handle intact.
          job.status = 'unknown';
          job.message = 'Chưa xác nhận yêu cầu DeepSeek đã dừng cục bộ; nhà cung cấp có thể vẫn đang xử lý/tính phí. Hãy hủy lại để kiểm tra cùng yêu cầu.';
          this.changed(job);
        }
        const httpCompletion = this.completions.get(id);
        if (httpCompletion) httpCompletion.resolve(job);
        return job;
      }
      if (state.render) {
        state.render.cancel();
        try { await state.render.promise; } catch { /* ignore expected cancellation */ }
        state.render = undefined;
      }
      const child = state.child;
      let confirmed = true;
      if (child && child.exitCode === null) {
        const exitPromise = new Promise<boolean>(r => {
          const closed = () => { clearTimeout(timer); r(true); };
          const timer = setTimeout(() => { child.off('close', closed); r(state.child !== child); }, 3000);
          child.once('close', closed);
        });
        if (process.platform === 'win32') {
          await new Promise<void>(r => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env: studioCliEnvironment(), windowsHide: true, timeout: 5000 }, () => r()));
          const exited = await exitPromise;
          confirmed = exited || state.child !== child;
        } else {
          try {
            child.kill('SIGKILL');
            const exited = await exitPromise;
            confirmed = exited || state.child !== child;
          } catch {
            confirmed = false;
          }
        }
      }
      job.status = confirmed ? 'canceled' : 'unknown';
      job.message = confirmed ? reason ?? 'Đã dừng tiến trình cục bộ; mọi kết quả về muộn bị bỏ qua.' : 'Chưa xác nhận CLI đã dừng. Kiểm tra tiến trình trước khi chạy tiếp.';
      if (confirmed) job.diagnostic = { code: 'JOB_CANCELED', message: job.message };
      this.changed(job);
      if (confirmed) await state.settled;
      const comp = this.completions.get(id);
      if (comp) comp.resolve(job);
      return job;
    })();
    this.cancelPromises.set(id, cancelPromise);
    void cancelPromise.catch(() => undefined).finally(() => { if (this.cancelPromises.get(id) === cancelPromise) this.cancelPromises.delete(id); });
    return cancelPromise;
  }
  /** Release owned work/active state exactly once, after a confirmed local stop. */
  private releaseOwned(job: AiJob, state: Running): void {
    this.active.delete(job.id);
    const work = state.work;
    if (work) { try { rmSync(work, { recursive: true, force: true }); } catch {} }
  }
  async waitFor(id: string): Promise<AiJob> {
    const job = this.get(id);
    const state = this.active.get(id);
    if (['running', 'validating', 'canceling'].includes(job.status)) await this.completions.get(id)?.promise;
    const cancellation = this.cancelPromises.get(id);
    if (cancellation) await cancellation;
    if (job.status !== 'unknown') await state?.settled;
    return job;
  }
  awaitCompletion(id: string): Promise<AiJob> { return this.waitFor(id); }
  disposeProject(projectId: string): void {
    for (const [id, job] of this.jobs.entries()) {
      if (job.projectId === projectId && !this.active.has(id) && !['running', 'validating', 'canceling', 'unknown'].includes(job.status)) {
        this.jobs.delete(id);
        this.inputs.delete(id);
        this.completions.delete(id);
        this.cancelPromises.delete(id);
      }
    }
  }
  disposeJob(id: string): void {
    const job = this.jobs.get(id);
    if (job && !this.active.has(id) && !['running', 'validating', 'canceling', 'unknown'].includes(job.status)) {
      this.jobs.delete(id);
      this.inputs.delete(id);
      this.completions.delete(id);
      this.cancelPromises.delete(id);
    }
  }
  apply(id: string, revision: number): ProjectDocument {
    const job = this.get(id);
    if (job.status !== 'ready' || !job.proposal) throw new StudioError('Đề xuất chưa sẵn sàng.');
    const doc = this.store.load(job.projectId);
    if (doc.revision !== job.revision || revision !== job.revision) throw new StudioError('Dự án đã đổi sau khi tạo đề xuất. Hãy tạo đề xuất mới.', 409, 'STALE_REVISION');
    const files = { ...doc.files }; for (const f of job.proposal.files) files[f.path] = f.content;
    const saved = this.store.save(doc.id, revision, { files }, `Trước khi áp dụng AI (${job.provider})`);
    job.status = 'applied'; job.message = 'Đã áp dụng, có thể phục hồi trong Lịch sử.'; this.changed(job); return saved;
  }
  candidate(id: string): ProjectDocument {
    const job = this.get(id); if (!job.proposal || job.status !== 'ready') throw new StudioError('Đề xuất chưa sẵn sàng.', 400, job.diagnostic);
    const doc = this.store.load(job.projectId); if (doc.revision !== job.revision) throw new StudioError('Đề xuất đã cũ.', 409, 'STALE_REVISION');
    const input = this.inputs.get(id) ?? doc;
    const files = { ...input.files }; for (const f of job.proposal.files) files[f.path] = f.content;
    return { ...input, files };
  }
  async close(): Promise<void> {
    await Promise.all([...this.active.keys()].map(id => this.cancel(id)));
    for (const id of [...this.jobs.keys()]) {
      const job = this.jobs.get(id)!;
      // An unconfirmed active HTTP job keeps its owned job/inputs/completion state.
      if (this.active.has(id) && job.provider === 'deepseek' && job.status === 'unknown') continue;
      this.jobs.delete(id);
      this.inputs.delete(id);
      this.completions.delete(id);
      this.cancelPromises.delete(id);
    }
  }
}
