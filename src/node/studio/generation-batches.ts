import { randomUUID } from 'node:crypto';
import type { PixelStore } from './pixel-store.ts';
import type { Proposals } from './proposals.ts';
import { assertDeepSeekTextOnly, type AiManager } from './ai.ts';
import { isActiveAiProvider, type RecordedAiProvider } from '../../studio/ai-providers.ts';
import { StudioError } from './store.ts';
import { guidanceInfo } from './art-guidance.ts';
import { DEFAULT_BATCH_TIMEOUT, candidateDeadline } from '../../studio/ai-budget.ts';
import type { ArtGuidanceSnapshot } from '../../studio/batch-types.ts';
import type {
  CandidateStatus,
  BatchStatus,
  CompactCandidateInfo,
  CompactBatchInfo,
  CandidateExecutionOptions,
  ArtReferenceImage,
} from '../../studio/batch-types.ts';
import type { PreparedSnapshot } from './generation-prep.ts';
import type { VariantPreview } from '../../studio/variants.ts';
import type { AiProposal, BuildSummary, AiJob } from '../../studio/types.ts';
import type { DesignManifest } from '../../studio/design-manifest.ts';

export interface CandidateRecord {
  diagnostic?: AiJob['diagnostic'];
  metrics?: AiJob['metrics'];
  transport?: AiJob['transport'];
  model?: AiJob['model'];
  usage?: AiJob['usage'];
  id: string;
  index: number;
  status: CandidateStatus;
  message: string;
  attempt: number;
  repairs?: number;
  cliExecutions: number;
  started?: number;
  ended?: number;
  elapsedMs?: number;
  jobId?: string;
  proposalId?: string;
  proposal?: AiProposal;
  build?: BuildSummary;
  manifest?: DesignManifest;
  error?: string;
  quality?: {
    errors: string[];
    warnings: string[];
  };
}

export interface BatchRecord {
  limits: { candidateMs: number; batchMs: number };
  guidance: ArtGuidanceSnapshot;
  id: string;
  projectId: string;
  revision: number;
  provider: RecordedAiProvider;
  prompt: string;
  status: BatchStatus;
  started: number;
  ended?: number;
  elapsedMs?: number;
  candidates: CandidateRecord[];
  appliedCandidateId?: string;
  snapshot: PreparedSnapshot;
  cancelRequested?: boolean;
  cancelPromise?: Promise<void>;
  backgroundRun?: Promise<void>;
  activeStarted?: number;
  retryRun?: Promise<void>;
}

/**
 * Whitelist transport/model/usage for records, compact payloads and SSE: no request, path,
 * secret or arbitrary field crosses. Usage is rebuilt (never aliased); legacy junk drops out.
 */
function safeJobMetadata(source: {
  transport?: AiJob['transport'];
  model?: AiJob['model'];
  usage?: AiJob['usage'];
}): Pick<CompactCandidateInfo, 'transport' | 'model' | 'usage'> {
  const transport = source.transport === 'cli' || source.transport === 'http' ? source.transport : undefined;
  const model = typeof source.model === 'string' && /^[\x20-\x7e]{1,200}$/.test(source.model) ? source.model : undefined;
  const usage: NonNullable<AiJob['usage']> = {};
  let hasUsage = false;
  const sourceUsage = source.usage;
  if (sourceUsage && typeof sourceUsage === 'object' && !Array.isArray(sourceUsage)) {
    for (const key of ['input', 'output', 'cached'] as const) {
      const value = sourceUsage[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        usage[key] = value;
        hasUsage = true;
      }
    }
    if (typeof sourceUsage.unavailable === 'boolean') {
      usage.unavailable = sourceUsage.unavailable;
      hasUsage = true;
    }
  }
  return {
    ...(transport ? { transport } : {}),
    ...(model ? { model } : {}),
    ...(hasUsage ? { usage } : {}),
  };
}

export function toCompactBatch(batch: BatchRecord, jobs?: ReadonlyMap<string,AiJob>): CompactBatchInfo {
  return {
    limits: { ...batch.limits },
    guidance: guidanceInfo(batch.guidance),
    id: batch.id,
    projectId: batch.projectId,
    revision: batch.revision,
    provider: batch.provider,
    status: batch.status,
    started: batch.started,
    ended: batch.ended,
    elapsedMs: (batch.elapsedMs ?? 0) + (batch.activeStarted === undefined ? 0 : Math.max(0,Date.now()-batch.activeStarted)),
    prompt: batch.prompt,
    candidates: batch.candidates.map(c => {const running=c.status==='running'&&c.jobId?jobs?.get(c.jobId):undefined;const art=c.build?.assets.find(a=>!a.name.startsWith('_'));return({
      id: c.id,
      index: c.index,
      status: c.status,
      message: c.message,
      diagnostic: c.diagnostic,
      metrics: running?.metrics ?? c.metrics,
      ...safeJobMetadata(running ?? c),
      description:c.proposal?.description.slice(0,2000),
      attempt: c.attempt+(running?.attempt??0),
      repairs: (c.repairs??0)+Math.max(0,(running?.attempt??0)-1),
      cliExecutions: c.cliExecutions+(running?.cliExecutions??0),
      dimensions: art
        ? { w: art.w, h: art.h }
        : (c.status === 'ready' ? { w: batch.snapshot.targetW, h: batch.snapshot.targetH } : undefined),
      started: c.started,
      ended: c.ended,
      elapsedMs: (c.elapsedMs??0)+(c.status==='running'&&c.started?Math.max(0,Date.now()-c.started):0),
      proposalId: c.proposalId,
      error: c.error,
      quality: c.quality,
      hasManifest: Boolean(c.manifest),
    });}),
    appliedCandidateId: batch.appliedCandidateId,
    config: {
      target: {
        w: batch.snapshot.targetW,
        h: batch.snapshot.targetH,
        name: batch.snapshot.targetName,
        assetId: batch.snapshot.assetId,
      },
      ...(batch.snapshot.generation?.operation === 'region-edit' && batch.snapshot.generation.animation ? {
        operation: 'region-edit' as const,
        regionEdit: {
          frameId: batch.snapshot.generation.animation.frameId,
          duration: batch.snapshot.generation.animation.duration,
          anchor: {
            x: batch.snapshot.generation.animation.anchor.x,
            y: batch.snapshot.generation.animation.anchor.y,
          },
        },
      } : {}),
      ...(batch.snapshot.generation?.operation === 'clip-regenerate' && batch.snapshot.generation.clip ? {
        operation: 'clip-regenerate' as const,
        clip: batch.snapshot.generation.clip.context,
      } : {}),
      options: batch.snapshot.generation?.options ? {
        style: batch.snapshot.generation.options.style,
        view: batch.snapshot.generation.options.view,
        paletteMode: batch.snapshot.generation.options.paletteMode,
        reference: batch.snapshot.generation.options.reference,
      } : undefined,
      artDirection: {
        style: batch.snapshot.artDirection.style ?? 'game',
        paletteMode: batch.snapshot.artDirection.paletteMode ?? 'auto16',
        palette: batch.snapshot.artDirection.palette,
        light: batch.snapshot.artDirection.light ?? 'upper-left',
        detailLevel: batch.snapshot.artDirection.detailLevel ?? 'medium',
        outline: batch.snapshot.artDirection.outline ?? 'dark',
        references: (batch.snapshot.artDirection.references ?? []).map(r => {
          const found = batch.snapshot.referenceAssets.find(a => a.assetId === r.assetId && a.frameId === r.frameId);
          return {
            assetId: r.assetId,
            frameId: r.frameId,
            name: found?.name,
          };
        }),
      },
    },
  };
}

export class GenerationBatchManager {
  readonly batches = new Map<string, BatchRecord>();
  private activeLeases = new Set<string>();
  private projectEpochs = new Map<string, number>();
  private closedProjects = new Set<string>();
  private isServerClosed = false;
  private previewPromises = new Map<string, Promise<VariantPreview>>();
  private store: PixelStore;
  private variants: Proposals;
  private ai: AiManager;
  private emit: (event: unknown) => void;

  constructor(
    store: PixelStore,
    variants: Proposals,
    ai: AiManager,
    emit: (event: unknown) => void
  ) {
    this.store = store;
    this.variants = variants;
    this.ai = ai;
    this.emit = emit;
  }

  isProjectBusy(projectId: string): boolean {
    if (this.activeLeases.has(projectId)) return true;
    if ([...this.busyGuards].some(guard => guard(projectId))) return true;
    for (const batch of this.batches.values()) {
      if (batch.projectId === projectId && (batch.status === 'running' || batch.status === 'unknown')) {
        return true;
      }
    }
    for (const job of this.ai.jobs.values()) {
      if (job.projectId === projectId && ['running', 'validating', 'canceling', 'unknown'].includes(job.status)) {
        return true;
      }
    }
    return false;
  }
  private busyGuards = new Set<(projectId: string) => boolean>();
  /** Other owned pipelines share the gate, including unresolved jobs after restart. */
  addBusyGuard(guard: (projectId: string) => boolean): () => void { this.busyGuards.add(guard); return () => this.busyGuards.delete(guard); }

  isClosed(projectId: string, epoch?: number): boolean {
    if (this.isServerClosed) return true;
    if (this.closedProjects.has(projectId)) return true;
    if (epoch !== undefined && this.projectEpochs.get(projectId) !== epoch) return true;
    return false;
  }

  acquireLease(projectId: string): { release: () => void; epoch: number } {
    if (this.isServerClosed || this.isClosed(projectId)) {
      throw new StudioError('Dự án đã đóng.', 409);
    }
    if (this.isProjectBusy(projectId)) {
      throw new StudioError('Dự án đang có tác vụ AI. Hãy hủy hoặc chờ tác vụ hiện tại.', 409);
    }
    const epoch = (this.projectEpochs.get(projectId) ?? 0) + 1;
    this.projectEpochs.set(projectId, epoch);
    this.closedProjects.delete(projectId);
    this.activeLeases.add(projectId);
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.activeLeases.delete(projectId);
        }
      },
      epoch,
    };
  }

  checkLeaseValid(projectId: string, epoch: number): void {
    if (this.isServerClosed || this.closedProjects.has(projectId) || this.projectEpochs.get(projectId) !== epoch) {
      throw new StudioError('Dự án đã đóng hoặc tác vụ bị hủy.', 409);
    }
  }

  private emitBatchEvent(batch: BatchRecord): void {
    const compact = toCompactBatch(batch,this.ai.jobs);
    this.emit({ type: 'pixel-batch', event: { type: 'batch', batch: compact }, batch: compact });
  }

  getBatch(projectId: string, batchId: string): BatchRecord {
    const batch = this.batches.get(batchId);
    if (!batch || batch.projectId !== projectId) {
      throw new StudioError('Không tìm thấy đợt tạo AI.', 404);
    }
    return batch;
  }

  list(projectId: string): CompactBatchInfo[] {
    return [...this.batches.values()]
      .filter(b => b.projectId === projectId)
      .map(batch=>toCompactBatch(batch,this.ai.jobs));
  }

  getCompact(projectId: string, batchId: string): CompactBatchInfo {
    return toCompactBatch(this.getBatch(projectId, batchId),this.ai.jobs);
  }

  onJobUpdate(job:AiJob):void{for(const batch of this.batches.values())if(batch.status==='running'&&batch.projectId===job.projectId&&batch.candidates.some(c=>c.status==='running'&&c.jobId===job.id))this.emitBatchEvent(batch);}
  private stopClock(batch:BatchRecord):void{const now=Date.now();if(batch.activeStarted!==undefined){batch.elapsedMs=(batch.elapsedMs??0)+Math.max(0,now-batch.activeStarted);batch.activeStarted=undefined;}batch.ended=now;}
  private finish(batch:BatchRecord):void{const ready=batch.candidates.filter(c=>c.status==='ready').length;batch.status=batch.candidates.some(c=>c.status==='unknown')?'unknown':batch.cancelRequested||this.isClosed(batch.projectId)?'canceled':ready===3?'ready':ready?'partial':'failed';this.stopClock(batch);this.emitBatchEvent(batch);}
  private failedRun(batch:BatchRecord,error:unknown):void{for(const c of batch.candidates)if(['pending','running'].includes(c.status)){c.status='failed';c.message=c.error=(error as Error).message;}this.finish(batch);}

  disposeBatch(batch: BatchRecord): void {
    if (batch.status === 'unknown') return;
    for (const c of batch.candidates) {
      if (c.jobId) {
        this.ai.disposeJob(c.jobId);
        this.variants.references.delete(c.jobId);
      }
      if (c.proposalId) {
        this.variants.releaseProposal(batch.projectId, c.proposalId);
      }
    }
    if (batch.snapshot.referenceVariantId) {
      try {
        this.variants.discardReference(batch.projectId, batch.snapshot.referenceVariantId);
      } catch {}
    }
    this.batches.delete(batch.id);
  }

  createBatch(
    projectId: string,
    provider: RecordedAiProvider,
    prompt: string,
    snapshot: PreparedSnapshot,
    releasePrepLease?: () => void
  ): BatchRecord {
    // One rejection path releases the supplied preparation lease exactly once, including
    // store.load throwing on malformed/deleted external data and preflight option construction.
    try {
      if (this.isClosed(projectId)) {
        throw new StudioError('Dự án đã đóng.', 409);
      }
      // Recorded/history values may arrive from persistence: only active providers allocate a batch.
      // Never remap a retired provider; the caller must choose again.
      if (!isActiveAiProvider(provider)) {
        throw new StudioError(provider === 'antigravity' ? 'Antigravity đã ngừng hỗ trợ. Chọn Codex hoặc DeepSeek API.' : 'Chọn Codex hoặc DeepSeek API và nhập yêu cầu 1–12.000 ký tự.');
      }
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) {
        throw new StudioError('Chọn Codex hoặc DeepSeek API và nhập yêu cầu 1–12.000 ký tự.');
      }
      if (this.store.load(projectId).revision !== snapshot.revision) {
        throw new StudioError('Dự án đã thay đổi trước khi tạo đợt AI.', 409);
      }
      // Text-only transport preflight: reject before any batch id, record, event, lease-held work or provider call.
      if (provider === 'deepseek') {
        const preflightOptions: CandidateExecutionOptions = {
          artDirection: snapshot.artDirection,
          referenceImages: snapshot.referenceAssets.slice(0, 3).map((r, idx) => ({
            name: r.name && r.name.endsWith('.png') ? r.name : `art-ref-${idx + 1}.png`,
            data: new Uint8Array(r.image),
          })),
          guideImage: snapshot.guideImage !== undefined
            ? { name: 'clip-guide.png', data: new Uint8Array(snapshot.guideImage) }
            : undefined,
        };
        assertDeepSeekTextOnly(snapshot.preview, snapshot.generation, snapshot.movementMask, preflightOptions);
      }
    } catch (error) {
      if (releasePrepLease) releasePrepLease();
      throw error;
    }

    const batchId = randomUUID();
    const candidates: CandidateRecord[] = [0, 1, 2].map(index => ({
      id: randomUUID(),
      index,
      status: 'pending',
      message: 'Đang xếp hàng…',
      attempt: 0,
      repairs: 0,
      cliExecutions: 0,
    }));

    const batch: BatchRecord = {
      limits: { candidateMs: this.ai.candidateBudgetMs(), batchMs: DEFAULT_BATCH_TIMEOUT },
      guidance: this.ai.captureGuidance(snapshot.generation, prompt),
      id: batchId,
      projectId,
      revision: snapshot.revision,
      provider,
      prompt,
      status: 'running',
      started: Date.now(),
      candidates,
      snapshot,
      activeStarted: Date.now(),
      elapsedMs: 0,
    };

    // Bound retained batches to at most 20, evicting only terminal non-unknown batches
    while (this.batches.size >= 20) {
      const evictable = [...this.batches.values()].find(
        b => ['ready', 'partial', 'failed', 'canceled', 'applied'].includes(b.status) && b.status !== 'unknown'
      );
      if (!evictable) {
        if (releasePrepLease) releasePrepLease();
        throw new StudioError('Đã đạt giới hạn 20 đợt AI đang chạy/chưa xác nhận dừng.',429);
      }
      this.disposeBatch(evictable);
    }

    this.batches.set(batch.id, batch);

    if (releasePrepLease) {
      releasePrepLease();
    }

    this.emitBatchEvent(batch);
    batch.snapshot=structuredClone(snapshot);
    batch.backgroundRun = this.runBatch(batch).catch(error=>this.failedRun(batch,error));

    return batch;
  }

  private async runBatch(batch: BatchRecord): Promise<void> {
    const batchDeadline = batch.started + batch.limits.batchMs;

    for (let i = 0; i < 3; i++) {
      if (batch.cancelRequested || this.isClosed(batch.projectId)) {
        for (let k = i; k < 3; k++) {
          if (batch.candidates[k].status === 'pending') {
            batch.candidates[k].status = 'canceled';
            batch.candidates[k].message = 'Đã hủy theo đợt tạo.';
          }
        }
        break;
      }

      // Stale revision check before spawning candidate:
      const currentDoc = this.store.load(batch.projectId);
      if (currentDoc.revision !== batch.revision) {
        for (let k = i; k < 3; k++) {
          if (batch.candidates[k].status === 'pending') {
            batch.candidates[k].status = 'failed';
            batch.candidates[k].message = 'Dự án đã thay đổi trong khi tạo đề xuất.';
            batch.candidates[k].error = 'Dự án đã thay đổi.';
          }
        }
        break;
      }

      // Check if previous candidate left an unknown shutdown gate:
      if (batch.candidates.some(c => c.status === 'unknown') || batch.status === 'unknown') {
        for (let k = i; k < 3; k++) {
          if (batch.candidates[k].status === 'pending') {
            batch.candidates[k].status = 'unknown';
            batch.candidates[k].message = 'Chưa xác nhận tiến trình trước đã dừng.';
          }
        }
        break;
      }

      const now = Date.now();
      if (now >= batchDeadline) {
        for (let k = i; k < 3; k++) {
          if (batch.candidates[k].status === 'pending') {
            batch.candidates[k].status = 'failed';
            batch.candidates[k].message = `Hết thời gian tối đa của đợt tạo (${batch.limits.batchMs / 1000}s).`;
            batch.candidates[k].error = batch.candidates[k].message;
          }
        }
        break;
      }

      const cand = batch.candidates[i];
      cand.status = 'running';
      cand.started = Date.now();
      cand.message = `CLI đang tạo đề xuất ${i + 1}/3…`;
      this.emitBatchEvent(batch);

      const candDeadline = candidateDeadline(Date.now(), batchDeadline, batch.limits.candidateMs);
      const candTimeout = Math.max(1, candDeadline - Date.now());

      const refImages: ArtReferenceImage[] = batch.snapshot.referenceAssets.slice(0, 3).map((r, idx) => ({
        name: r.name && r.name.endsWith('.png') ? r.name : `art-ref-${idx + 1}.png`,
        data: new Uint8Array(r.image),
      }));

      const options: CandidateExecutionOptions = {
        artGuidance: batch.guidance,
        candidateIndex: i,
        artDirection: batch.snapshot.artDirection,
        referenceImages: refImages,
        guideImage: batch.snapshot.guideImage ? {
          name: 'clip-guide.png',
          data: new Uint8Array(batch.snapshot.guideImage),
        } : undefined,
        timeout: candTimeout,
        deadline: candDeadline,
      };

      try {
        const job = await this.ai.start(
          batch.snapshot.contextDoc,
          batch.provider,
          batch.prompt,
          batch.snapshot.preview ? new Uint8Array(batch.snapshot.preview) : undefined,
          batch.snapshot.generation,
          batch.snapshot.movementMask ? new Uint8Array(batch.snapshot.movementMask) : undefined,
          options
        );
        cand.jobId = job.id;
        if(batch.cancelRequested||this.isClosed(batch.projectId))await this.ai.cancel(job.id);
        if (batch.snapshot.referenceVariantId) {
          this.variants.rememberReference(job.id, batch.projectId, batch.snapshot.referenceVariantId);
        }

        const finishedJob = await this.ai.awaitCompletion(job.id);
        cand.metrics = finishedJob.metrics ? { ...finishedJob.metrics } : undefined;
        // Replace all three fields: a failed retry without any HTTP response must not keep the
        // previous attempt's model/usage/transport as if it were current.
        const finishedMeta = safeJobMetadata(finishedJob);
        cand.transport = finishedMeta.transport;
        cand.model = finishedMeta.model;
        cand.usage = finishedMeta.usage;
        cand.ended = Date.now();
        cand.elapsedMs = cand.ended - cand.started;
        cand.attempt = finishedJob.attempt;
        cand.repairs = finishedJob.attempt > 1 ? finishedJob.attempt - 1 : 0;
        cand.cliExecutions = finishedJob.cliExecutions ?? 0;
        cand.status = finishedJob.status==='canceled'&&!batch.cancelRequested&&!this.isClosed(batch.projectId)?'failed':finishedJob.status as CandidateStatus;
        cand.message = finishedJob.message;
        cand.diagnostic = finishedJob.diagnostic;

        if (finishedJob.status === 'ready') {
          cand.proposal = finishedJob.proposal;
          cand.build = finishedJob.build;
          cand.manifest = finishedJob.proposal?.manifest;
          if (finishedJob.build) {
            cand.quality = { errors: finishedJob.build.errors, warnings: [] };
          }
        } else if (cand.status === 'failed') {
          cand.error = finishedJob.message;
          cand.quality = { errors: [finishedJob.message], warnings: [] };
        }
      } catch (err) {
        cand.ended = Date.now();
        cand.elapsedMs = cand.ended - cand.started;
        cand.status = 'failed';
        cand.message = (err as Error).message;
        cand.error = (err as Error).message;
        cand.quality = { errors: [(err as Error).message], warnings: [] };
      }

      this.emitBatchEvent(batch);
    }

    this.finish(batch);
  }

  async cancelBatch(projectId: string, batchId: string, rev: number): Promise<CompactBatchInfo> {
    const batch = this.getBatch(projectId, batchId);
    // External cancel validates caller's CURRENT revision:
    const currentDoc = this.store.load(projectId);
    if (rev !== currentDoc.revision) {
      throw new StudioError('Revision đã thay đổi; giữ bản nháp và tải lại hoặc lưu bản sao.', 409);
    }

    await this.internalCancel(batch);
    return toCompactBatch(batch,this.ai.jobs);
  }

  private async internalCancel(batch: BatchRecord): Promise<void> {
    if (!['running', 'unknown'].includes(batch.status)) return;
    // Concurrent callers share one attempt; the attempt handle is dropped once it settles so a
    // later confirmation is a fresh recheck of the same owned job instead of a cached receipt.
    const pendingAttempt = batch.cancelPromise;
    if (pendingAttempt) {
      await pendingAttempt;
      return;
    }
    batch.cancelRequested = true;
    const attempt = this.cancelAttempt(batch);
    batch.cancelPromise = attempt;
    try {
      await attempt;
    } finally {
      if (batch.cancelPromise === attempt) batch.cancelPromise = undefined;
    }
  }

  /**
   * One cancellation attempt per owned job: a candidate that already reached `unknown` is rechecked
   * through `AiManager.cancel` on the SAME owned HTTP handle (no new provider request, no guessed
   * process kill). Its real terminal/unconfirmed state is copied back, so an unconfirmed stop keeps
   * the batch `unknown` gate, and a confirmed stop releases the active job.
   */
  private async cancelAttempt(batch: BatchRecord): Promise<void> {
    for (const cand of batch.candidates) {
      if (!cand.jobId || !['running', 'unknown'].includes(cand.status)) continue;
      const job = await this.ai.cancel(cand.jobId);
      if (job.status === 'canceled' || job.status === 'unknown') {
        cand.status = job.status === 'canceled' ? 'canceled' : 'unknown';
        cand.message = job.message;
      }
    }
    // A placeholder `unknown` (no owned job of its own) may only clear once every owned job is
    // confirmed stopped; pending candidates were never started, so they are always canceled.
    const ownedUnknown = batch.candidates.some(c => Boolean(c.jobId) && c.status === 'unknown');
    for (const c of batch.candidates) {
      if (c.status === 'pending' || (c.status === 'unknown' && !c.jobId && !ownedUnknown)) {
        c.status = 'canceled';
        c.message = 'Đã hủy theo đợt tạo.';
      }
    }
    await Promise.all([batch.backgroundRun,batch.retryRun].filter(Boolean));
    this.finish(batch);
  }

  async retryCandidate(
    projectId: string,
    batchId: string,
    candidateId: string,
    rev: number
  ): Promise<CompactBatchInfo> {
    const batch = this.getBatch(projectId, batchId);
    const currentDoc = this.store.load(projectId);
    // Enforce caller == current == batch.revision
    if (rev !== batch.revision || currentDoc.revision !== batch.revision || rev !== currentDoc.revision) {
      throw new StudioError('Revision đã thay đổi; giữ bản nháp và tải lại hoặc lưu bản sao.', 409);
    }

    if (batch.status === 'applied') {
      throw new StudioError('Đợt tạo đã được áp dụng, không thể thử lại.', 409);
    }
    if (batch.status === 'canceled') {
      throw new StudioError('Đợt tạo đã bị hủy, không thể thử lại.', 409);
    }
    if (batch.status === 'unknown') {
      throw new StudioError('Đợt tạo chưa xác nhận trạng thái dừng.', 409);
    }

    const cand = batch.candidates.find(c => c.id === candidateId);
    if (!cand) {
      throw new StudioError('Không tìm thấy ứng viên.', 404);
    }

    if (cand.status !== 'failed') {
      throw new StudioError('Chỉ có thể thử lại ứng viên thất bại.', 400);
    }

    // Acquire lease for retry
    const { release: releasePrep, epoch } = this.acquireLease(projectId);

    if(cand.jobId){this.ai.disposeJob(cand.jobId);this.variants.references.delete(cand.jobId);cand.jobId=undefined;}
    // Drop the previous attempt's metadata at admission: the retry now emits `running` without a
    // new job, so no stale transport/model/usage may be shown as the current attempt.
    cand.transport = undefined;
    cand.model = undefined;
    cand.usage = undefined;
    cand.diagnostic = undefined;
    batch.cancelRequested = false;
    batch.cancelPromise = undefined;
    cand.status = 'running';
    cand.message = `Đang thử lại ứng viên ${cand.index + 1}…`;
    cand.ended = undefined;
    batch.status = 'running';
    batch.ended = undefined;
    batch.activeStarted=Date.now();
    this.emitBatchEvent(batch);

    // Track retry execution
    const retryPromise = this.runCandidateRetry(batch, cand, releasePrep, epoch).catch(error=>{releasePrep();this.failedRun(batch,error);});
    batch.retryRun = retryPromise;

    return toCompactBatch(batch);
  }

  private async runCandidateRetry(
    batch: BatchRecord,
    cand: CandidateRecord,
    releasePrep: () => void,
    epoch: number
  ): Promise<void> {
    // Direct pre-spawn check:
    if (this.store.load(batch.projectId).revision !== batch.revision || this.isClosed(batch.projectId, epoch)) {
      releasePrep();
      cand.status = 'failed';
      cand.message = 'Dự án đã thay đổi hoặc đóng trước khi thử lại.';
      cand.error = 'Dự án đã thay đổi hoặc đóng.';
      this.finish(batch);
      return;
    }

    const retryActiveStart = Date.now();
    cand.started = retryActiveStart;
    cand.ended = undefined;
    const timeout = batch.limits.candidateMs;

    const refImages: ArtReferenceImage[] = batch.snapshot.referenceAssets.slice(0, 3).map((r, idx) => ({
      name: r.name && r.name.endsWith('.png') ? r.name : `art-ref-${idx + 1}.png`,
      data: new Uint8Array(r.image),
    }));

    const options: CandidateExecutionOptions = {
      artGuidance: batch.guidance,
      candidateIndex: cand.index,
      artDirection: batch.snapshot.artDirection,
      referenceImages: refImages,
      guideImage: batch.snapshot.guideImage ? {
        name: 'clip-guide.png',
        data: new Uint8Array(batch.snapshot.guideImage),
      } : undefined,
      timeout,
      deadline: Date.now() + timeout,
    };

    try {
      const job = await this.ai.start(
        batch.snapshot.contextDoc,
        batch.provider,
        batch.prompt,
        batch.snapshot.preview ? new Uint8Array(batch.snapshot.preview) : undefined,
        batch.snapshot.generation,
        batch.snapshot.movementMask ? new Uint8Array(batch.snapshot.movementMask) : undefined,
        options
      );
      cand.jobId = job.id;
      if(batch.cancelRequested||this.isClosed(batch.projectId,epoch))await this.ai.cancel(job.id);
      if (batch.snapshot.referenceVariantId) {
        this.variants.rememberReference(job.id, batch.projectId, batch.snapshot.referenceVariantId);
      }

      releasePrep();

      const finishedJob = await this.ai.awaitCompletion(job.id);
      cand.metrics = finishedJob.metrics ? { ...finishedJob.metrics } : undefined;
      // Same replacement rule as the initial run: absent metadata must clear the record.
      const finishedMeta = safeJobMetadata(finishedJob);
      cand.transport = finishedMeta.transport;
      cand.model = finishedMeta.model;
      cand.usage = finishedMeta.usage;
      cand.diagnostic = finishedJob.diagnostic;
      const activeDuration = Date.now() - retryActiveStart;
      cand.ended = Date.now();
      cand.elapsedMs = (cand.elapsedMs ?? 0) + activeDuration;
      cand.attempt += finishedJob.attempt;
      cand.repairs = (cand.repairs ?? 0) + (finishedJob.attempt > 1 ? finishedJob.attempt - 1 : 0);
      cand.cliExecutions += finishedJob.cliExecutions ?? 0;
      cand.status = finishedJob.status==='canceled'&&!batch.cancelRequested&&!this.isClosed(batch.projectId)?'failed':finishedJob.status as CandidateStatus;
      cand.message = finishedJob.message;

      if (finishedJob.status === 'ready') {
        cand.proposal = finishedJob.proposal;
        cand.build = finishedJob.build;
        cand.manifest = finishedJob.proposal?.manifest;
        cand.error = undefined;
        if (finishedJob.build) {
          cand.quality = { errors: finishedJob.build.errors, warnings: [] };
        }
      } else if (cand.status === 'failed') {
        cand.error = finishedJob.message;
        cand.quality = { errors: [finishedJob.message], warnings: [] };
      }
    } catch (err) {
      releasePrep();
      const activeDuration = Date.now() - retryActiveStart;
      cand.ended = Date.now();
      cand.elapsedMs = (cand.elapsedMs ?? 0) + activeDuration;
      cand.status = 'failed';
      cand.message = (err as Error).message;
      cand.error = (err as Error).message;
      cand.quality = { errors: [(err as Error).message], warnings: [] };
    }

    this.finish(batch);
  }

  async previewCandidate(
    projectId: string,
    batchId: string,
    candidateId: string,
    rev: number
  ): Promise<VariantPreview> {
    const batch = this.getBatch(projectId, batchId);
    if (rev !== batch.revision || this.store.load(projectId).revision !== rev) {
      throw new StudioError('Revision đã thay đổi; giữ bản nháp và tải lại hoặc lưu bản sao.', 409);
    }

    const cand = batch.candidates.find(c => c.id === candidateId);
    if (!cand) {
      throw new StudioError('Không tìm thấy ứng viên.', 404);
    }

    if (cand.status !== 'ready') {
      throw new StudioError('Ứng viên chưa sẵn sàng.', 400);
    }

    if (cand.proposalId && this.variants.records.has(cand.proposalId)) {
      return this.variants.describe(projectId, cand.proposalId, rev);
    }

    // Deduplicate concurrent capture calls for the same candidate
    let capturePromise = this.previewPromises.get(candidateId);
    if (!capturePromise) {
      capturePromise = (async () => {
        const candidateDoc = this.ai.candidate(cand.jobId!);
        const preview = await this.variants.capture(
          projectId,
          rev,
          candidateDoc,
          batch.snapshot.generation,
          cand.jobId
        );

        // Recheck revision and batch state after async capture!
        if (this.store.load(projectId).revision !== rev) {
          this.variants.releaseProposal(projectId, preview.proposalId);
          throw new StudioError('Dự án đã thay đổi trong khi tạo bản xem trước.', 409);
        }
        if (batch.status === 'canceled' || batch.status === 'unknown') {
          this.variants.releaseProposal(projectId, preview.proposalId);
          throw new StudioError('Đợt tạo đã bị hủy.', 409);
        }

        cand.proposalId = preview.proposalId;
        return preview;
      })();

      this.previewPromises.set(candidateId, capturePromise);
      const cleanup = () => {
        if (this.previewPromises.get(candidateId) === capturePromise) {
          this.previewPromises.delete(candidateId);
        }
      };
      capturePromise.then(cleanup, cleanup);
    }

    return await capturePromise;
  }

  findBatchByProposalId(proposalId: string): { batch: BatchRecord; candidate: CandidateRecord } | undefined {
    for (const batch of this.batches.values()) {
      for (const cand of batch.candidates) {
        if (cand.proposalId === proposalId) {
          return { batch, candidate: cand };
        }
      }
    }
    return undefined;
  }

  onProposalApplied(proposalId: string, newRevision: number): void {
    const found = this.findBatchByProposalId(proposalId);
    if (found) {
      const { batch, candidate } = found;
      batch.status = 'applied';
      batch.appliedCandidateId = candidate.id;
      this.emitBatchEvent(batch);
    }
  }

  async closeProject(projectId: string): Promise<void> {
    this.closedProjects.add(projectId);
    this.projectEpochs.set(projectId, (this.projectEpochs.get(projectId) ?? 0) + 1);

    // Cancel all running batches on this project
    for (const batch of this.batches.values()) {
      if (batch.projectId === projectId && batch.status === 'running') {
        await this.internalCancel(batch);
      }
    }

    // Await tracked backgroundRun and retryRun executions
    for (const batch of this.batches.values()) {
      if (batch.projectId === projectId) {
        if (batch.backgroundRun) {
          try { await batch.backgroundRun; } catch {}
        }
        if (batch.retryRun) {
          try { await batch.retryRun; } catch {}
        }
      }
    }

    // Clean up terminal batches (retaining unknown so busy gate is preserved)
    for (const [id, batch] of this.batches.entries()) {
      if (batch.projectId === projectId && batch.status !== 'unknown') {
        this.disposeBatch(batch);
      }
    }
  }

  finishCloseProject(projectId: string): void {
    // Closing invalidates old preparation epochs; it must not permanently disable
    // AI when the same document is opened again. Busy/unknown gates still apply.
    if (!this.isServerClosed) this.closedProjects.delete(projectId);
  }

  async close(): Promise<void> {
    this.isServerClosed = true;
    for (const projectId of [...this.batches.values()].map(b => b.projectId).concat([...this.activeLeases])) {
      this.closedProjects.add(projectId);
      this.projectEpochs.set(projectId, (this.projectEpochs.get(projectId) ?? 0) + 1);
    }

    for (const batch of this.batches.values()) {
      if (batch.status === 'running') {
        try {
          await this.internalCancel(batch);
        } catch {}
      }
    }

    for (const batch of this.batches.values()) {
      if (batch.backgroundRun) {
        try { await batch.backgroundRun; } catch {}
      }
      if (batch.retryRun) {
        try { await batch.retryRun; } catch {}
      }
    }

    for (const [id, batch] of this.batches.entries()) {
      if (batch.status !== 'unknown') {
        this.disposeBatch(batch);
      }
    }
  }
}
