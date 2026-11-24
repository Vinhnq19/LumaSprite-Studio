import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyLibraryVersion } from '../../studio/asset-library.ts';
import { materializeEngineResultV1, negotiateEngineV1, type EngineAssetType, type EngineJobV1, type EngineRequestV1 } from '../../studio/engine-adapter.ts';
import { celFor, composite, isLocked, wireParse, wireStringify, type PixelDocument } from '../../studio/pixel/model.ts';
import { dataId, dataNumber, dataObject } from '../../studio/quality/data.ts';
import { ExternalEngineTransport, externalDigest } from './external-engine-transport.ts';
import type { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';

type State = EngineJobV1['state'] | 'submitting' | 'timedout' | 'rejected' | 'applied';
interface Receipt { version: string; digest: string }
interface Job {
  id: string; revision: number; origin: string; deadline: number; state: State; request: EngineRequestV1;
  engine?: EngineJobV1; problem?: string; preview?: Receipt;
  protection?: { mask: number[]; pixels: Uint32Array };
}
const active = (state: State) => ['submitting', 'queued', 'running', 'canceling'].includes(state);
const invalid = (e: unknown, status: number) => e instanceof StudioError ? e : new StudioError((e as Error).message, status);
const stale = () => new StudioError('Revision đã thay đổi. Tạo job trên revision mới để tiếp tục.', 409, 'STALE_REVISION');

export class ExternalEngineApi {
  private readonly transport?: ExternalEngineTransport;
  private readonly submitting = new Set<string>();
  private readonly store: PixelStore;
  private readonly jobTimeoutMs: number;
  constructor(store: PixelStore, port?: number, jobTimeoutMs = 30000) {
    this.store = store;
    this.jobTimeoutMs = jobTimeoutMs;
    if (port !== undefined) this.transport = new ExternalEngineTransport(port);
  }

  private path(project: string, job = ''): string {
    return join(this.store.dir(project), '.pxl', 'external-engine', job ? `${job}.json` : '');
  }

  private write(project: string, job: Job): void {
    const path = this.path(project, job.id), temp = `${path}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, wireStringify(job));
    renameSync(temp, path);
  }

  private read(project: string, id: string): Job {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new StudioError('ID job Studio không hợp lệ.', 400);
    const path = this.path(project, id);
    if (!existsSync(path)) throw new StudioError('Không tìm thấy job Studio.', 404);
    return wireParse(readFileSync(path, 'utf8'));
  }

  private show(job: Job) {
    return {
      id: job.id, state: job.state, revision: job.revision, progress: job.engine?.progress,
      version: job.engine?.state === 'ready' ? job.engine.finalVersionId : undefined, problem: job.problem,
    };
  }

  private adapter(job?: Job): ExternalEngineTransport {
    if (!this.transport || (job && this.transport.origin !== job.origin)) throw new StudioError('Chưa cấu hình External Engine cho job này.', 503);
    return this.transport;
  }

  private update(project: string, job: Job, state: State, problem?: string): Job {
    job.state = state;
    job.problem = problem;
    this.write(project, job);
    return job;
  }

  private async status(project: string, job: Job): Promise<Job> {
    if (!active(job.state) || this.submitting.has(job.id)) return job;
    if (!job.engine) return this.update(project, job, 'unknown', 'Studio dừng trước khi lưu ID engine. Có thể tạo job mới thủ công.');
    if (Date.now() >= job.deadline) return this.update(project, job, 'timedout', 'Job đã quá thời hạn.');
    try {
      const engine = await this.adapter(job).status(job.engine.id);
      const current = this.read(project, job.id);
      if (!active(current.state)) return current;
      if (Date.now() >= current.deadline) return this.update(project, current, 'timedout', 'Job đã quá thời hạn.');
      if (active(engine.state) && engine.progress!.completed < (current.engine?.progress?.completed ?? 0)) return current;
      current.engine = engine;
      return this.update(project, current, engine.state, engine.diagnostics?.[0]?.message);
    } catch (error) {
      const current = this.read(project, job.id);
      if (!active(current.state)) return current;
      const failure = invalid(error, 502);
      return this.update(project, current, failure.status === 504 ? 'timedout' : failure.status === 503 ? 'unknown' : 'failed', failure.message);
    }
  }

  private async submit(d: PixelDocument, body: unknown) {
    const input = dataObject(body, ['revision', 'assetType', 'brief', 'w', 'h', 'source'], 'Yêu cầu Studio');
    if (input.revision !== d.revision) throw stale();
    if (typeof input.brief !== 'string' || !input.brief.trim() || input.brief.length > 2000) throw Error('Brief phải có 1–2.000 ký tự.');
    const w = dataNumber(input.w, 1, 4096, 'Rộng', true), h = dataNumber(input.h, 1, 4096, 'Cao', true);
    const id = randomUUID(), adapter = this.adapter();
    const caps = await adapter.capabilities().catch(error => { throw invalid(error, 502); });
    if (this.store.load(d.id).revision !== d.revision) throw stale();
    const request: EngineRequestV1 = {
      version: 1, requestId: id, assetType: input.assetType as EngineAssetType, brief: input.brief.trim(),
      canvas: { w, h }, frameDurationsMs: [100], loop: false, alpha: 'binary', requiredFeatures: ['previews', 'progress'],
    };
    if (input.source !== null) request.requiredFeatures = ['previews', 'progress', 'masks'];
    negotiateEngineV1(caps, request);
    let protection: Job['protection'];
    if (input.source !== null) {
      const source = dataObject(input.source, ['assetId', 'frameId', 'mask'], 'Nguồn bảo vệ');
      const assetId = dataId(source.assetId, 'ID asset nguồn'), frameId = dataId(source.frameId, 'ID frame nguồn');
      const asset = d.assets.find(value => value.id === assetId);
      if (!asset || asset.w !== w || asset.h !== h || !asset.frames.some(frame => frame.id === frameId)) throw Error('Frame nguồn không khớp canvas.');
      if (!Array.isArray(source.mask) || source.mask.length !== w * h || !source.mask.every(value => value === 0 || value === 1) || !source.mask.includes(1)) throw Error('Mask chỉnh sửa không hợp lệ.');
      const frame = structuredClone(asset), mask: number[] = source.mask.slice();
      for (const layer of frame.layers) {
        const cel = celFor(frame, layer.id, frameId);
        if (cel?.blob) cel.data = this.store.cel(d.id, cel.blob, w * h);
        if (cel?.data && isLocked(frame, layer)) for (let i = 0; i < mask.length; i++) if (cel.data[i] & 255) mask[i] = 0;
      }
      if (!mask.includes(1)) throw Error('Vùng chọn không còn pixel chỉnh sửa được.');
      protection = { mask, pixels: composite(frame, frameId).data };
      request.palette = asset.palette.slice();
      const rgba = Buffer.alloc(w * h * 4);
      protection.pixels.forEach((ink, i) => rgba.writeUInt32BE(ink, i * 4));
      request.region = { rgba: rgba.toString('base64'), editable: Buffer.from(mask).toString('base64') };
    } else {
      request.palette = [0, 0x1c2434ff, 0x536da0ff, 0xf7ba5bff, 0xeaf1f7ff];
    }
    const job: Job = { id, revision: d.revision, origin: adapter.origin, deadline: Date.now() + this.jobTimeoutMs, state: 'submitting', request, protection };
    this.write(d.id, job);
    this.submitting.add(id);
    try {
      job.engine = await adapter.submit(request);
      const current = this.read(d.id, id);
      if (current.state === 'canceled') {
        await adapter.cancel(job.engine.id).catch(() => {});
        return this.show(current);
      }
      return this.show(this.update(d.id, job, Date.now() >= job.deadline ? 'timedout' : job.engine.state, job.engine.diagnostics?.[0]?.message));
    } catch (error) {
      const current = this.read(d.id, id);
      if (current.state === 'canceled') return this.show(current);
      const failure = invalid(error, 502);
      return this.show(this.update(d.id, current, failure.status === 504 ? 'timedout' : failure.status === 503 ? 'unknown' : 'failed', failure.message));
    } finally {
      this.submitting.delete(id);
    }
  }

  private async preview(project: string, job: Job, version: string) {
    if (job.state !== 'ready' || job.engine?.state !== 'ready' || version !== job.engine.finalVersionId) throw new StudioError('Job hoặc phiên bản chưa được chọn để duyệt.', 409);
    if (this.store.load(project).revision !== job.revision) throw stale();
    let asset;
    let receipt: Receipt;
    try {
      const raw = await this.adapter(job).result(job.engine.id, version);
      asset = materializeEngineResultV1(raw, job.request, job.engine.id, version);
      const protection = job.protection;
      if (protection) {
        const pixels = celFor(asset, asset.layers[0].id, asset.frames[0].id)!.data!;
        const changed = pixels.findIndex((ink, i) => !protection.mask[i] && ink !== protection.pixels[i]);
        if (changed >= 0) throw Error(`Pixel được bảo vệ đã đổi tại (${changed % asset.w}, ${Math.floor(changed / asset.w)}).`);
      }
      receipt = { version, digest: externalDigest(wireStringify(raw)) };
    } catch (error) {
      const current = this.read(project, job.id);
      if (current.state === 'ready') this.update(project, current, 'failed', (error as Error).message);
      throw invalid(error, 502);
    }
    const current = this.read(project, job.id);
    if (current.state !== 'ready') throw new StudioError('Job đã bị đóng.', 409);
    if (this.store.load(project).revision !== current.revision) throw stale();
    if (current.preview && current.preview.digest !== receipt.digest) {
      this.update(project, current, 'failed', 'Engine đổi nội dung phiên bản đã xem.');
      throw new StudioError('Engine đổi nội dung phiên bản đã xem.', 502);
    }
    return { current, asset, receipt };
  }

  async route(
    project: PixelDocument, method: string, parts: string[], body: () => Promise<unknown>,
  ): Promise<{ value: unknown; status?: number; saved?: PixelDocument }> {
    const [id, action, version, extra] = parts;
    if (extra) throw new StudioError('Không tìm thấy API engine.', 404);
    if (!id && method === 'GET') return { value: await this.adapter().discover().catch(error => { throw invalid(error, 502); }) };
    if (id === 'jobs' && !action) {
      if (method === 'POST') {
        try { return { value: await this.submit(project, await body()), status: 201 }; }
        catch (error) { throw invalid(error, 400); }
      }
      if (method === 'GET') {
        const path = this.path(project.id);
        const files = existsSync(path) ? readdirSync(path).filter(file => /^[0-9a-f-]{36}\.json$/.test(file)) : [];
        const recent = files.map(file => ({ id: file.slice(0, -5), time: statSync(join(path, file)).mtimeMs }))
          .sort((a, b) => b.time - a.time).slice(0, 20);
        return { value: recent.map(({ id }) => this.show(this.read(project.id, id))) };
      }
    }
    const job = this.read(project.id, id ?? '');
    if (!action && method === 'GET') return { value: this.show(await this.status(project.id, job)) };
    if (action === 'preview' && version && method === 'GET') {
      const { current, receipt, asset } = await this.preview(project.id, job, version);
      current.preview = receipt;
      this.write(project.id, current);
      return { value: { ...receipt, w: asset.w, h: asset.h, rgba: celFor(asset, asset.layers[0].id, asset.frames[0].id)!.data } };
    }
    if (method === 'POST' && !version && action === 'cancel' && (active(job.state) || job.state === 'unknown' || job.state === 'timedout')) {
      this.update(project.id, job, 'canceled');
      if (job.engine) await Promise.resolve().then(() => this.adapter(job).cancel(job.engine!.id)).catch(() => {});
      return { value: this.show(job) };
    }
    if (method === 'POST' && !version && action === 'reject' && job.state === 'ready') return { value: this.show(this.update(project.id, job, 'rejected')) };
    if (method === 'POST' && !version && action === 'apply') {
      const raw = await body();
      let input;
      try { input = dataObject(raw, ['approved', 'revision', 'version', 'digest'], 'Phê duyệt'); }
      catch (error) { throw invalid(error, 400); }
      const latest = this.read(project.id, id);
      if (input.revision !== latest.revision || input.revision !== this.store.load(project.id).revision) throw stale();
      if (input.approved !== true || !latest.preview || latest.preview.version !== input.version || latest.preview.digest !== input.digest) {
        throw new StudioError('Cần duyệt đúng bản preview đã xem.', 409);
      }
      const { current, asset } = await this.preview(project.id, latest, latest.preview.version);
      const d = this.store.load(project.id);
      if (d.revision !== current.revision) throw stale();
      const kind = current.request.assetType === 'character' ? 'character' : 'object';
      const next = applyLibraryVersion(d, asset, { kind });
      const saved = this.store.save(d.id, d.revision, next, 'Trước khi áp dụng External Engine');
      this.update(project.id, current, 'applied');
      return { value: saved, saved };
    }
    throw new StudioError('Thao tác không hợp lệ cho job External Engine.', 409);
  }
}
