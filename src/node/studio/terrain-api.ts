import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type PixelDocument, type PixelAsset, wireParse, wireStringify } from '../../studio/pixel/model.ts';
import { mapId, mapName } from '../../studio/tilemaps.ts';
import { registerTileset } from '../../studio/map-commands.ts';
import { applyLibraryVersion } from '../../studio/asset-library.ts';
import type { TerrainAssembly } from '../../studio/terrain.ts';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';
import { RenderPool, type RenderTask } from './runner.ts';
import type { ExportResult } from './render.ts';
import type { TerrainRequest } from './terrain-worker.ts';

interface TerrainJob { id: string; projectId: string; revision: number; status: 'running' | 'ready' | 'failed' | 'canceled' | 'applied'; started: number; ended?: number; error?: string; w?: number; h?: number; warnings?: string[]; options: TerrainAssembly }
interface TerrainResult { asset: PixelAsset; options: TerrainAssembly; png: string; warnings: string[] }
function inputObject(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new StudioError('Yêu cầu tileset phải là object.', 400);
  const v = value as Record<string, any>;
  if (Object.keys(v).some(k => !keys.includes(k))) throw new StudioError('Yêu cầu tileset chứa trường không hỗ trợ.', 400);
  return v;
}
function current(d: PixelDocument, value: unknown): void { if (value !== d.revision) throw new StudioError('Revision đã thay đổi; dựng lại trên bản mới.', 409); }
const send = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(wireStringify(value)); };
function download(res: ServerResponse, result: ExportResult): void {
  res.writeHead(200, { 'cache-control': 'no-store', 'content-type': result.mime, 'content-disposition': `attachment; filename="terrain.${result.filename.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(result.filename)}` }); res.end(Buffer.from(result.data));
}

export class TerrainApi {
  private store: PixelStore;
  private pool: RenderPool;
  private emit: (event: unknown) => void;
  private jobs = new Map<string, TerrainJob>();
  private tasks = new Map<string, RenderTask>();
  private results = new Map<string, { result: TerrainResult; bytes: number }>();
  private bytes = 0;
  private epochs = new Map<string, number>();
  private exports = new Map<string, Set<RenderTask>>();
  constructor(store: PixelStore, pool: RenderPool, emit: (event: unknown) => void) { this.store = store; this.pool = pool; this.emit = emit; }
  private publish(job: TerrainJob): void { this.emit({ type: 'pixel-terrain', job: structuredClone(job) }); }
  private job(id: string, project: string): TerrainJob {
    mapId(id); const job = this.jobs.get(id); if (!job || job.projectId !== project) throw new StudioError('Tác vụ tileset không tồn tại.', 404); return job;
  }
  private drop(id: string): void { const cached = this.results.get(id); if (cached) { this.bytes -= cached.bytes; this.results.delete(id); } }
  private cache(id: string, result: TerrainResult): void {
    const bytes = wireStringify(result).length * 2;
    if (bytes > 32 * 1024 * 1024) throw new Error('Đề xuất tileset vượt bộ nhớ preview 32 MiB.');
    while ((this.bytes + bytes > 32 * 1024 * 1024 || this.results.size >= 20) && this.results.size) this.drop(this.results.keys().next().value!);
    this.results.set(id, { result, bytes }); this.bytes += bytes;
  }
  private start(doc: PixelDocument, input: unknown): TerrainJob {
    const v = inputObject(input, ['revision', 'assetId', 'frameId', 'name', 'tileSize', 'inset', 'sampling']); current(doc, v.revision);
    mapId(v.assetId); mapId(v.frameId); mapName(v.name);
    if (![16, 32].includes(v.tileSize) || !Number.isInteger(v.inset) || v.inset < 1 || v.inset >= v.tileSize / 2 || !['repeat', 'mirror'].includes(v.sampling)) throw new StudioError('Kích thước ô, mép hoặc cách lấy mẫu không hợp lệ.', 400);
    const source = doc.assets.find(a => a.id === v.assetId);
    if (!source || !source.frames.some(f => f.id === v.frameId) || source.w !== v.tileSize || source.h !== v.tileSize) throw new StudioError('Chọn đúng frame vật liệu vuông 16×16 hoặc 32×32; app không tự resize.', 400);
    if ([...this.jobs.values()].some(j => j.projectId === doc.id && j.status === 'running')) throw new StudioError('Dự án đang dựng một tileset. Hủy hoặc chờ tác vụ đó.', 409);
    if (this.tasks.size >= 2) throw new StudioError('Đang dựng hai tileset; thử lại khi hoàn tất.', 409);
    while (this.jobs.size >= 40) { const old = [...this.jobs.values()].find(j => j.status !== 'running'); if (!old) break; this.drop(old.id); this.jobs.delete(old.id); }
    const job: TerrainJob = { id: randomUUID(), projectId: doc.id, revision: doc.revision, status: 'running', started: Date.now(), options: { tileSize: v.tileSize, inset: v.inset, sampling: v.sampling } };
    const epoch = this.epochs.get(doc.id) ?? 0;
    const task = this.pool.start({ mode: 'terrain', root: this.store.root, projectId: doc.id, revision: doc.revision, operation: 'assemble', assetId: v.assetId, frameId: v.frameId, name: v.name, options: job.options });
    this.jobs.set(job.id, job); this.tasks.set(job.id, task); this.publish(job);
    void task.promise.then(value => {
      if (job.status !== 'running' || (this.epochs.get(doc.id) ?? 0) !== epoch) return;
      current(this.store.load(doc.id), job.revision);
      const result: TerrainResult = wireParse(Buffer.from((value as ExportResult).data).toString('utf8'));
      this.cache(job.id, result); job.status = 'ready'; job.w = result.asset.w; job.h = result.asset.h; job.warnings = result.warnings;
    }).catch(error => {
      if (job.status === 'running' && (this.epochs.get(doc.id) ?? 0) === epoch) { job.status = 'failed'; job.error = (error as Error).message; }
    }).then(() => {
      this.tasks.delete(job.id);
      if (this.jobs.get(job.id) === job) { job.ended = Date.now(); this.publish(job); }
    });
    return job;
  }
  async route(req: IncomingMessage, res: ServerResponse, parts: string[], doc: PixelDocument, body: () => Promise<any>): Promise<boolean> {
    if (parts[4] !== 'terrain') return false;
    const action = parts[5];
    if (action === 'proposal' && req.method === 'POST') { send(res, this.start(doc, await body()), 202); return true; }
    if (action === 'jobs' && parts[6]) {
      const job = this.job(parts[6], doc.id), command = parts[7];
      if (!command && req.method === 'GET') { send(res, job); return true; }
      if (command === 'cancel' && req.method === 'POST') {
        const v = inputObject(await body(), ['revision']); current(doc, v.revision);
        if (job.status === 'running' || job.status === 'ready') { job.status = 'canceled'; job.ended = Date.now(); this.tasks.get(job.id)?.cancel(); }
        this.drop(job.id); this.publish(job); send(res, job); return true;
      }
      if (command === 'preview' && req.method === 'GET') {
        const url = new URL(req.url!, 'http://localhost'); current(doc, Number(url.searchParams.get('revision'))); current(doc, job.revision);
        const cached = this.results.get(job.id); if (job.status !== 'ready' || !cached) throw new StudioError('Preview đã hết hạn; dựng lại tileset.', 409);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(Buffer.from(cached.result.png, 'base64')); return true;
      }
      if (command === 'apply' && req.method === 'POST') {
        const v = inputObject(await body(), ['revision']); current(doc, v.revision); current(doc, job.revision);
        const cached = this.results.get(job.id); if (job.status !== 'ready' || !cached) throw new StudioError('Đề xuất đã hết hạn hoặc chưa sẵn sàng.', 409);
        const asset = structuredClone(cached.result.asset); asset.id = randomUUID();
        const next = applyLibraryVersion(doc, asset, { kind: 'tileset' });
        const tilesetId = registerTileset(next, asset.id, asset.frames[0].id, job.options.tileSize, asset.name);
        const saved = this.store.save(doc.id, doc.revision, next, 'Trước khi áp dụng tileset');
        this.drop(job.id); job.status = 'applied'; this.publish(job);
        this.emit({ type: 'pixel-saved', projectId: doc.id, revision: saved.revision }); send(res, { document: saved, assetId: asset.id, tilesetId }); return true;
      }
    }
    if ((action === 'tileset-export' || action === 'map-export') && req.method === 'POST') {
      const v = inputObject(await body(), action === 'map-export' ? ['revision', 'mapId', 'format'] : ['revision', 'tilesetId']); current(doc, v.revision);
      if (action === 'map-export') { mapId(v.mapId); if (!['json', 'zip', 'png'].includes(v.format)) throw new StudioError('Định dạng bản đồ không hợp lệ.', 400); }
      else mapId(v.tilesetId);
      const request: TerrainRequest = { mode: 'terrain', root: this.store.root, projectId: doc.id, revision: doc.revision, ...(action === 'map-export' ? { operation: 'map-export' as const, mapId: v.mapId, format: v.format } : { operation: 'tileset-export' as const, tilesetId: v.tilesetId }) };
      const epoch = this.epochs.get(doc.id) ?? 0, task = this.pool.start(request);
      let set = this.exports.get(doc.id); if (!set) this.exports.set(doc.id, set = new Set()); set.add(task);
      try {
        const result = await task.promise as ExportResult;
        if ((this.epochs.get(doc.id) ?? 0) !== epoch) throw new StudioError('Dự án đã đóng.', 409);
        current(this.store.load(doc.id), doc.revision); download(res, result);
      } finally { set.delete(task); if (!set.size) this.exports.delete(doc.id); }
      return true;
    }
    throw new StudioError('Thao tác tileset không tồn tại.', 404);
  }
  async closeProject(id: string): Promise<void> {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const pending: RenderTask[] = [...this.exports.get(id) ?? []];
    for (const [key, job] of this.jobs) if (job.projectId === id) { const task = this.tasks.get(key); if (task) pending.push(task); this.drop(key); this.jobs.delete(key); }
    for (const task of pending) task.cancel(); await Promise.allSettled(pending.map(t => t.promise));
    this.exports.delete(id);
  }
  async close(): Promise<void> {
    for (const id of new Set([...this.jobs.values()].map(j => j.projectId).concat([...this.exports.keys()]))) await this.closeProject(id);
    this.epochs.clear();
  }
}
