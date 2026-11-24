import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RenderPool } from './runner.ts';
import type { ExportResult } from './render.ts';
import type { QualityStageRequest } from './quality-stage-worker.ts';
import { readQualityVariant, qualityDirectory, assertQualityRoot } from './quality-storage.ts';
import { QualityTechnicalError } from './quality-engine.ts';
import type { QualityPorts, QualityOwnedTask, QualityPrepared, QualityValidated, QualityImage } from './quality-ports.ts';
import type { QualityVariantSummary } from '../../studio/quality/run.ts';
import { dataId } from '../../studio/quality/data.ts';
import { isTerrainPrompt } from './art-guidance.ts';

interface Stored { projectId: string; revision: number; digest: string; variants: Map<string, string> }
function decodeImages(raw: { name: string; base64: string }[]): QualityImage[] {
  if (!Array.isArray(raw) || raw.length > 4) throw new Error('Danh sách ảnh worker không hợp lệ.');
  let bytes = 0;
  return raw.map(i => { const data = Buffer.from(i.base64, 'base64'); bytes += data.length;
    if (!/^[A-Za-z0-9_-]{1,80}\.png$/.test(i.name) || data.length < 8 || data.length > 32 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error('Ảnh worker vượt giới hạn.');
    return { name: i.name, data: new Uint8Array(data) }; });
}
/** Owned temporary artifacts on disk. Only small descriptor/digest maps are kept in memory. */
export class QualityRuntime {
  readonly root: string;
  private pool: RenderPool;
  private ownsPool: boolean;
  private stored = new Map<string, Stored>();
  private tasks = new Map<string, Set<QualityOwnedTask<unknown>>>();
  private closed = false;
  constructor(pool?: RenderPool) { this.root = realpathSync(mkdtempSync(join(tmpdir(), 'lumasprite-quality-'))); this.pool = pool ?? new RenderPool(); this.ownsPool = !pool; }
  private work(request: QualityStageRequest): QualityOwnedTask<ExportResult> {
    if (this.closed) throw new Error('Kho chất lượng đã đóng.');
    const actual = this.pool.start(request);
    let set = this.tasks.get(request.snapshotId); if (!set) this.tasks.set(request.snapshotId, set = new Set());
    const task: QualityOwnedTask<ExportResult> = {
      promise: actual.promise.then(value => value as ExportResult).finally(() => { set!.delete(task); if (!set!.size) this.tasks.delete(request.snapshotId); }),
      stop: async () => { actual.cancel(); try { await task.promise; } catch { /* RenderTask settles after worker termination. */ } return true; },
    };
    set.add(task); return task;
  }
  ports(external: Pick<QualityPorts, 'acquire' | 'assertCurrent' | 'execute'>): QualityPorts {
    return { acquire: id => external.acquire(id), assertCurrent: (id, revision) => external.assertCurrent(id, revision), execute: request => external.execute(request),
      prepare: input => {
        const id = randomUUID(), record: Stored = { projectId: input.projectId, revision: input.revision, digest: '', variants: new Map() }; this.stored.set(id, record);
        let actual: QualityOwnedTask<ExportResult>;
        try { actual = this.work({ mode: 'quality-stage', root: this.root, snapshotId: id, operation: 'prepare', source: input.context }); }
        catch (e) { this.stored.delete(id); throw e; }
        return { promise: actual.promise.then(result => {
          const value = JSON.parse(Buffer.from(result.data).toString('utf8'));
          if (!/^[a-f0-9]{64}$/.test(value.snapshotSha256) || value.prepared.snapshotId !== id) throw new Error('Worker trả snapshot sai định danh.');
          record.digest = value.snapshotSha256;
          const prepared = { ...value.prepared, sourceImages: decodeImages(value.prepared.sourceImages) } as QualityPrepared;
          const { w, h } = prepared.base.canvas;
          prepared.terrainReview = !prepared.structureLocked && !prepared.templateScope && prepared.base.frames.length === 1
            && w === h && (w === 16 || w === 32) && isTerrainPrompt(input.prompt + '\n' + input.style);
          return prepared;
        }).catch(error => { this.drop(id); throw error; }), stop: deadline => actual.stop(deadline) };
      },
      validate: (role, output, prepared, director, candidateId) => {
        const record = this.record(prepared.snapshotId);
        const candidateSha256 = candidateId === undefined ? undefined : record.variants.get(candidateId);
        if (candidateId && !candidateSha256) throw new Error('Biến thể không thuộc snapshot này.');
        const task = this.work({ mode: 'quality-stage', root: this.root, snapshotId: prepared.snapshotId, operation: 'validate', snapshotSha256: record.digest, role, output, director, candidateId, candidateSha256, terrainReview: prepared.terrainReview, characterStudy: prepared.characterStudy, characterFinishStudy: prepared.characterFinishStudy });
        return { promise: task.promise.then(result => {
          const value = JSON.parse(Buffer.from(result.data).toString('utf8'));
          if (value.technicalError) throw new QualityTechnicalError(String(value.technicalError));
          if (value.kind === 'director') return { kind: 'director', director: value.director, toneComparison: value.toneComparison } as QualityValidated;
          if (value.kind !== 'variant' || !/^[a-f0-9]{64}$/.test(value.recipeSha256)) throw new Error('Metadata biến thể từ worker không hợp lệ.');
          dataId(value.variant.id, 'Biến thể worker'); record.variants.set(value.variant.id, value.recipeSha256);
          if (value.reviewNotes !== undefined && (typeof value.reviewNotes !== 'string' || value.reviewNotes.length > 4096)) throw new Error('Chẩn đoán review từ worker không hợp lệ.');
          return { kind: 'variant', variant: value.variant as QualityVariantSummary, images: decodeImages(value.images), ...(value.reviewNotes ? { reviewNotes: value.reviewNotes } : {}) } as QualityValidated;
        }), stop: deadline => task.stop(deadline) };
      },
      drain: async (id, deadline) => {
        return this.drain(id, deadline);
      },
      drop: id => this.drop(id),
    };
  }
  private record(id: string): Stored { const r = this.stored.get(id); if (!r) throw new Error('Snapshot chất lượng không thuộc kho hoặc đã đóng.'); return r; }
  async drain(id: string, deadline: number): Promise<boolean> {
    const tasks = [...this.tasks.get(id) ?? []], stopped = await Promise.all(tasks.map(t => t.stop(deadline)));
    return stopped.every(Boolean) && !this.tasks.get(id)?.size;
  }
  candidateRecipe(snapshotId: string, variantId: string): unknown {
    const r = this.record(snapshotId), digest = r.variants.get(variantId); if (!digest) throw new Error('Biến thể không thuộc snapshot này.');
    return (readQualityVariant(this.root, snapshotId, variantId, digest) as { recipe: unknown }).recipe;
  }
  cliContext(snapshotId: string, variantId?: string): QualityOwnedTask<{ name: string; data: Uint8Array }[]> {
    const record = this.record(snapshotId), digest = variantId ? record.variants.get(variantId) : undefined;
    if (variantId && !digest) throw new Error('Biến thể không thuộc snapshot này.');
    const task = this.work({ mode: 'quality-stage', root: this.root, snapshotId, operation: 'cli-context', snapshotSha256: record.digest, candidateId: variantId, candidateSha256: digest });
    return { promise: task.promise.then(result => {
      const value = JSON.parse(Buffer.from(result.data).toString('utf8')); let total = 0;
      if (!Array.isArray(value.files) || value.files.length > 8200) throw new Error('Ngữ cảnh worker không hợp lệ.');
      return value.files.map((f: { name: string; base64: string }) => {
        if (!/^[a-z0-9-]{1,80}\.(json|png)$/.test(f.name) || typeof f.base64 !== 'string') throw new Error('File ngữ cảnh worker không hợp lệ.');
        const data = Buffer.from(f.base64, 'base64'); total += data.length;
        if (total > 48 * 1024 * 1024) throw new Error('Ngữ cảnh CLI vượt 48 MiB.');
        return { name: f.name, data: new Uint8Array(data) };
      });
    }), stop: deadline => task.stop(deadline) };
  }
  materialize(snapshotId: string, variantId: string, revision: number, frameId?: string, currentContext?: unknown): QualityOwnedTask<ExportResult> {
    const r = this.record(snapshotId), digest = r.variants.get(variantId);
    if (revision !== r.revision || !digest) throw new Error('Biến thể/revision không khớp snapshot.');
    return this.work({ mode: 'quality-stage', root: this.root, snapshotId, operation: frameId === undefined ? 'asset' : 'frame', revision, frameId, candidateId: variantId, candidateSha256: digest, snapshotSha256: r.digest, ...(currentContext === undefined ? {} : { currentContext }) });
  }
  retouchInfo(snapshotId: string, variantId: string, revision: number, frameId: string, currentContext?: unknown): QualityOwnedTask<unknown> {
    const r = this.record(snapshotId), digest = r.variants.get(variantId);
    if (revision !== r.revision || !digest) throw new Error('Biến thể/revision không khớp snapshot.');
    const task = this.work({ mode: 'quality-stage', root: this.root, snapshotId, operation: 'retouch-info', snapshotSha256: r.digest, revision, frameId, candidateId: variantId, candidateSha256: digest, ...(currentContext === undefined ? {} : { currentContext }) });
    return { promise: task.promise.then(result => JSON.parse(Buffer.from(result.data).toString('utf8')) as unknown), stop: deadline => task.stop(deadline) };
  }
  retouch(snapshotId: string, variantId: string, revision: number, input: unknown, currentContext?: unknown): QualityOwnedTask<QualityVariantSummary> {
    const r = this.record(snapshotId), digest = r.variants.get(variantId);
    if (revision !== r.revision || !digest) throw new Error('Biến thể/revision không khớp snapshot.');
    if (r.variants.size >= 20) throw new Error('Snapshot đã đạt giới hạn 20 biến thể.');
    const task = this.work({ mode: 'quality-stage', root: this.root, snapshotId, operation: 'retouch', snapshotSha256: r.digest, revision, candidateId: variantId, candidateSha256: digest, input, ...(currentContext === undefined ? {} : { currentContext }) });
    return { promise: task.promise.then(result => {
      const value = JSON.parse(Buffer.from(result.data).toString('utf8'));
      if (!/^[a-f0-9]{64}$/.test(value.recipeSha256) || value.variant?.kind !== 'edited' || value.variant.parentVariantId !== variantId) throw new Error('Metadata biến thể từ worker không hợp lệ.');
      dataId(value.variant.id, 'Biến thể worker');
      if (this.stored.get(snapshotId) !== r || this.closed) throw new Error('Snapshot chất lượng đã đóng hoặc bị thay thế.');
      r.variants.set(value.variant.id, value.recipeSha256);
      return value.variant as QualityVariantSummary;
    }), stop: deadline => task.stop(deadline) };
  }
  drop(id: string): void {
    if (!this.stored.has(id)) return;
    if (this.tasks.get(id)?.size) throw new Error('Không dọn snapshot khi worker còn chạy.');
    const path = qualityDirectory(this.root, id); rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); this.stored.delete(id);
  }
  /** Caller must first stop its engine/CLI handles; unknown jobs keep this store intact. */
  close(confirmedIdle: boolean): void {
    if (this.closed) return;
    if (!confirmedIdle || this.tasks.size) throw new Error('Chưa xác nhận các writer đã dừng; giữ kho chất lượng.');
    if (this.ownsPool) this.pool.close();
    for (const id of [...this.stored.keys()]) this.drop(id);
    assertQualityRoot(this.root);
    if (resolve(dirname(this.root)) !== realpathSync(tmpdir()) || !this.root.split(/[\\/]/).at(-1)!.startsWith('lumasprite-quality-')) throw new Error('Từ chối dọn ngoài thư mục tạm sở hữu.');
    rmSync(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); this.closed = true;
  }
}
