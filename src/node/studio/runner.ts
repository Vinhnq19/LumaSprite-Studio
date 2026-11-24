import { Worker } from 'node:worker_threads';
import type { BuildSummary, Picture } from '../../studio/types.ts';
import type { ExportResult, RenderRequest } from './render.ts';
import type { PixelExport } from './pixel-render.ts';
import type { ProcessingRequest } from './processing-worker.ts';
import type { TerrainRequest } from './terrain-worker.ts';
import type { ProductionRequest } from './production-worker.ts';
import type { QualityRenderRequest } from './quality-worker.ts';
import type { QualityStageRequest } from './quality-stage-worker.ts';
import type { QualitySourceRequest } from './quality-source-worker.ts';
import { StudioError } from './store.ts';
import type { StudioDiagnostic } from '../../studio/diagnostic.ts';
export type WorkerRequest = QualitySourceRequest | QualityStageRequest | QualityRenderRequest | TerrainRequest | ProductionRequest | RenderRequest | (PixelExport & { mode: 'pixel-export' }) | ProcessingRequest | {mode:'variant-frame';root:string;variantId:string;assetId:string;frameId:string;overlay?:string;referenceId?:string;compare?:{variantId:string;assetId:string;frameId:string}};

export interface RenderTask { promise: Promise<BuildSummary | Picture | ExportResult>; cancel: () => void }
export function startRender(request: WorkerRequest, timeout = 30_000): RenderTask {
  const workerFile = import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
  const worker = new Worker(new URL(workerFile, import.meta.url), { workerData: request, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  let settled = false, rejectTask: (reason: Error) => void, timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<BuildSummary | Picture | ExportResult>((resolve, reject) => {
    rejectTask = reject;
    const finish = (error?: Error, value?: BuildSummary | Picture | ExportResult) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const complete=()=>{if(error)reject(error);else resolve(value!);};
      // Settle only after termination so owners can safely remove temporary files.
      void worker.terminate().then(complete,complete);
    };
    const errorCode = request.mode === 'export' || request.mode === 'pixel-export' ? 'EXPORT_FAILED' : 'RENDER_FAILED';
    const describe = (error: Error, diagnostic: StudioDiagnostic = {code:errorCode,message:error.message}) => Object.assign(error, {diagnostic});
    timer = setTimeout(() => finish(describe(new Error('Dựng ảnh vượt thời gian cho phép. Kiểm tra vòng lặp hoặc giảm độ phức tạp.'))), timeout);
    worker.once('message', m => finish(m.ok ? undefined :
      Number.isInteger(m.status) && m.status >= 400 && m.status < 600
        ? new StudioError(m.error, m.status, m.diagnostic)
        : describe(new Error(m.error), m.diagnostic), m.value));
    worker.once('error', e => finish(describe(e)));
    worker.once('exit', code => { if (!settled) finish(describe(new Error(`Worker dừng trước khi có kết quả (${code}).`))); });
  });
  return { promise, cancel: () => { if (!settled) { settled = true; clearTimeout(timer);const error=new Error('Đã hủy dựng ảnh.');void worker.terminate().then(()=>rejectTask(error),()=>rejectTask(error)); } } };
}

/** Limit preview/build workers; queued requests are cancelable before allocating memory. */
export class RenderPool {
  private active = 0;
  private queue: { start: () => void; cancel: () => void }[] = [];
  private owned = new Set<RenderTask>();
  constructor(privateLimit = 2) { this.limit = privateLimit; }
  private limit: number;
  start(request: WorkerRequest, timeout?: number): RenderTask {
    let actual: RenderTask | undefined, ended = false, cancelQueued: () => void;
    const promise = new Promise<BuildSummary | Picture | ExportResult>((resolve, reject) => {
      const entry = { start: () => {
        if (ended) return; this.active++;
        actual = startRender(request, timeout);
        actual.promise.then(resolve, reject).finally(() => { ended = true; this.active--; this.owned.delete(task); this.pump(); });
      }, cancel: () => { ended = true; this.queue = this.queue.filter(e => e !== entry); reject(new Error('Đã hủy yêu cầu trong hàng đợi.')); } };
      cancelQueued = entry.cancel;
      this.queue.push(entry);
    });
    const task: RenderTask = { promise, cancel: () => { if (ended) return; if (actual) actual.cancel(); else { cancelQueued(); this.owned.delete(task); } } };
    this.owned.add(task); this.pump(); return task;
  }
  private pump(): void { while (this.active < this.limit && this.queue.length) this.queue.shift()!.start(); }
  close(): void { for (const task of this.owned) task.cancel(); this.owned.clear(); }
}
