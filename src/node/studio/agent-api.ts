import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { agentInputBytes, agentOperations, agentResultBytes, agentVersion, type AgentCode, type AgentDiagnostic, type AgentOperation } from '../../studio/agent-contract.ts';
import { getAssetLibraryInfo } from '../../studio/asset-library.ts';
import { mapPixelSize } from '../../studio/tilemap-render.ts';
import { newAsset, celFor, playback, validateDocument, type PixelAsset, type PixelDocument } from '../../studio/pixel/model.ts';
import { emptyProduction, productionKind, productionLimits, sceneSourceIssues, type ProductionScene } from '../../studio/production.ts';
import { dataArray, dataBoolean, dataId, dataName, dataNumber, dataObject } from '../../studio/quality/data.ts';
import { ExternalEngineTransport } from './external-engine-transport.ts';
import { PixelStore } from './pixel-store.ts';
import { productionCatalog, productionPackagePlan } from './production-worker.ts';
import type { ExportResult } from './render-result.ts';
import type { RenderPool, RenderTask } from './runner.ts';
import { StudioError } from './store.ts';

const maxJobs = 16, jobTtlMs = 10 * 60_000;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
class AgentError extends Error {
  readonly status: number;
  readonly code: AgentCode;
  constructor(status: number, code: AgentCode, message: string) { super(message); this.status = status; this.code = code; }
}
const missing = (message: string) => new AgentError(404, 'NOT_FOUND', message);
const source = (message: string) => new AgentError(409, 'STALE_SOURCE', message);
const limit = (message: string) => new AgentError(413, 'LIMIT_EXCEEDED', message);
function diagnostic(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof StudioError) {
    if (error.diagnostic?.code === 'STALE_REVISION') return new AgentError(409, 'STALE_REVISION', error.message);
    if (error.diagnostic?.code === 'UNSUPPORTED_PRODUCTION_VERSION') return new AgentError(409, 'INCOMPATIBLE_PROJECT', error.message);
    if (error.status === 404) return missing(error.message);
    if (error.status === 413) return limit(error.message);
    if (error.status === 409) return source(error.message);
  }
  // Filesystem and unexpected worker errors can contain absolute paths.
  return new AgentError(500, 'OPERATION_FAILED', 'Studio không hoàn thành được thao tác.');
}
function validate<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof AgentError || error instanceof StudioError) throw error;
    throw new AgentError(400, 'INVALID_REQUEST', (error as Error).message);
  }
}
function assetOf(doc: PixelDocument, id: string): PixelAsset {
  const asset = doc.assets.find(a => a.id === id); if (!asset) throw missing('Asset không tồn tại.');
  return asset;
}
function sceneInfo(doc: PixelDocument, scene: ProductionScene, catalog: ReturnType<typeof productionCatalog>) {
  const size = mapPixelSize(doc, scene.mapId), issues = sceneSourceIssues(scene, catalog);
  const tracks = new Set<string>();
  let pixelFrames = size.w * size.h;
  for (const p of scene.placements) {
    const key = `${p.assetId}:${p.tagId ?? ''}`;
    if (tracks.has(key)) continue;
    tracks.add(key);
    const a = assetOf(doc, p.assetId);
    pixelFrames += a.w * a.h * (p.tagId && a.tags.some(t => t.id === p.tagId) ? playback(a, p.tagId).length : 1);
  }
  const withinLimits = size.w <= productionLimits.sceneSide && size.h <= productionLimits.sceneSide && pixelFrames <= productionLimits.scenePixels;
  return { ...scene, size, pixelFrames, withinLimits, stale: issues.length > 0, issues };
}

interface Job {
  id: string; projectId: string; revision: number; created: number; ended?: number;
  state: 'running' | 'ready' | 'failed' | 'canceled'; task: RenderTask;
  data?: Buffer; result?: { id: string; filename: string; mediaType: string; byteLength: number; sha256: string };
  diagnostic?: AgentDiagnostic;
}

export class StudioAgentApi {
  private readonly store: PixelStore;
  private readonly pool: RenderPool;
  private readonly engine?: ExternalEngineTransport;
  private readonly tokenHash?: Buffer;
  private readonly saved: (doc: PixelDocument) => void;
  private readonly jobs = new Map<string, Job>();
  private readonly rollbacks = new Map<string, { revision: number; snapshotId: string }>();

  constructor(store: PixelStore, pool: RenderPool, saved: (doc: PixelDocument) => void, enginePort?: number, token?: string) {
    this.store = store; this.pool = pool; this.saved = saved;
    if (enginePort !== undefined) this.engine = new ExternalEngineTransport(enginePort);
    if (token && /^[\x21-\x7e]{32,256}$/.test(token)) this.tokenHash = hash(`Bearer ${token}`);
  }

  async handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    let operation: AgentOperation | null = null, projectId: string | null = null, revision: number | null = null;
    const requestId = randomUUID();
    const send = (http: number, payload: unknown) => {
      res.writeHead(http, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ version: agentVersion, requestId, operation, projectId, revision, ...payload as object }));
    };
    try {
      if (req.method !== 'POST') throw new AgentError(405, 'INVALID_REQUEST', 'Dùng POST với JSON Agent v1.');
      if (req.headers.origin !== origin && req.headers.origin !== origin.replace('127.0.0.1', 'localhost')) {
        throw new AgentError(403, 'PERMISSION_DENIED', 'Origin bị từ chối.');
      }
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AgentError(415, 'INVALID_REQUEST', 'Cần Content-Type application/json.');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > agentInputBytes) { req.resume(); throw limit('JSON Agent tối đa 1 MiB.'); }
        chunks.push(chunk);
      }
      let body: Record<string, unknown> | null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AgentError(400, 'INVALID_REQUEST', 'JSON Agent không hợp lệ.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentError(400, 'INVALID_REQUEST', 'Request phải là object JSON.');
      if (body.version !== agentVersion) throw new AgentError(400, 'UNSUPPORTED_VERSION', 'Agent hỗ trợ version 1.');
      if (typeof body.operation !== 'string' || !Object.hasOwn(agentOperations, body.operation)) throw new AgentError(404, 'UNKNOWN_OPERATION', 'Operation không được hỗ trợ.');
      operation = body.operation as AgentOperation;
      const spec = agentOperations[operation];
      const global = ['capabilities', 'projects.list', 'project.create', 'engine.capabilities', 'engine.submit'].includes(operation);
      const needsRevision = spec.access === 'mutation' || operation === 'package.start';
      validate(() => {
        dataObject(body, ['version', 'operation', 'input', ...global ? [] : ['projectId'], ...needsRevision ? ['expectedRevision'] : []], 'Request');
        projectId = global ? null : dataId(body.projectId, 'Project ID');
        if (needsRevision) dataNumber(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'Expected revision', true);
      });
      if (spec.access === 'external-cost') throw new AgentError(403, 'APPROVAL_REQUIRED', 'Dùng luồng duyệt và ngân sách riêng trong Studio.');
      if (spec.access === 'mutation' && (!this.tokenHash || !timingSafeEqual(this.tokenHash, hash(req.headers.authorization ?? '')))) {
        throw new AgentError(403, 'PERMISSION_DENIED', 'Quyền ghi Agent chưa được cấp.');
      }
      const input = validate(() => dataObject(body.input, [...spec.fields], 'Input'));
      const doc = projectId ? this.store.load(projectId) : undefined;
      revision = doc?.revision ?? null;
      if (needsRevision && body.expectedRevision !== (doc?.revision ?? 0)) {
        throw new AgentError(409, 'STALE_REVISION', 'Revision đã đổi. Đọc lại dự án trước khi quyết định gửi yêu cầu khác.');
      }
      const data = await this.execute(operation, input, requestId, doc);
      if (data && 'project' in data && data.project) { projectId = data.project.id; revision = data.project.revision; }
      send(200, { status: 'ok', diagnostics: [], data, provenance: { source: 'lumasprite-studio', access: spec.access } });
    } catch (error) {
      const fault = diagnostic(error), detail = { code: fault.code, message: fault.message };
      send(fault.status, { status: 'error', diagnostics: [detail], error: detail });
    }
  }

  private async execute(operation: AgentOperation, input: Record<string, unknown>, requestId: string, doc?: PixelDocument) {
    const key = (field: string) => validate(() => dataId(input[field], field));
    const optional = (field: string) => input[field] === null ? null : key(field);
    const name = () => validate(() => dataName(input.name, 'Tên'));
    if (operation === 'capabilities') return { operations: agentOperations, writeEnabled: !!this.tokenHash, engineConfigured: !!this.engine,
      externalCostEnabled: false, limits: { ...productionLimits, inputBytes: agentInputBytes, resultBytes: agentResultBytes, maxJobs, jobTtlMs } };
    if (operation === 'engine.capabilities') {
      if (!this.engine) throw new AgentError(503, 'ENGINE_UNAVAILABLE', 'Chưa cấu hình External Engine.');
      try { return await this.engine.discover(); }
      catch { throw new AgentError(503, 'ENGINE_UNAVAILABLE', 'Không đọc được capabilities từ External Engine.'); }
    }
    if (operation === 'projects.list') return { projects: this.store.list() };
    if (operation === 'project.create' || operation === 'asset.create') {
      const width = validate(() => dataNumber(input.width, 1, 4096, 'Width', true)), height = validate(() => dataNumber(input.height, 1, 4096, 'Height', true));
      const title = name();
      if (operation === 'project.create') {
        const created = this.store.create(title, width, height);
        this.saved(created);
        return { project: { id: created.id, revision: created.revision }, assetId: created.assets[0].id,
          receipt: { id: requestId, previousRevision: 0, snapshotId: null } };
      }
      if (doc!.assets.length >= 100) throw limit('Dự án tối đa 100 asset.');
      let rgba: Uint32Array | undefined;
      if (input.rgba !== null) {
        rgba = Uint32Array.from(validate(() => dataArray(input.rgba, width * height, width * height, 'RGBA')
          .map((value, i) => dataNumber(value, 0, 0xffffffff, `RGBA[${i}]`, true))));
      }
      const asset = newAsset(title, width, height);
      if (rgba) celFor(asset, asset.layers[0].id, asset.frames[0].id, true)!.data = rgba;
      doc!.assets.push(asset);
      return this.commit(doc!, requestId, operation, asset.id);
    }
    const d = doc!;
    const settings = d.studio?.production ?? emptyProduction();
    const collectionOf = () => {
      const id = key('collectionId'), collection = settings.collections.find(c => c.id === id);
      if (!collection) throw missing('Collection không tồn tại.');
      return collection;
    };
    switch (operation) {
      case 'project.get': return { project: { id: d.id, name: d.name, revision: d.revision, schemaVersion: d.schemaVersion,
        productionVersion: d.studio?.production?.version ?? null, counts: { assets: d.assets.length, collections: settings.collections.length, scenes: settings.scenes.length } } };
      case 'assets.list': {
        const catalog = productionCatalog(d);
        return { assets: d.assets.map(a => ({ id: a.id, name: a.name, width: a.w, height: a.h, frameCount: a.frames.length,
          familyId: getAssetLibraryInfo(d, a.id).groupId, kind: productionKind(d, a.id),
          profileId: settings.assets.find(row => row.assetId === a.id)?.profileId ?? null, ...catalog.assets[a.id],
          provenance: a.provenance ? { kind: a.provenance.kind, provider: a.provenance.batch?.provider ?? null } : null })) };
      }
      case 'collections.list': return { collections: settings.collections };
      case 'profiles.list': return { profiles: settings.profiles };
      case 'history.list': return { history: this.store.history(d.id) };
      case 'animations.list': return { animations: d.assets.map(a => ({ assetId: a.id, frames: a.frames, tags: a.tags,
        playback: a.tags.map(t => ({ tagId: t.id, frames: playback(a, t.id).map(({ frame }) => frame.id) })) })) };
      case 'tilemaps.list': return { tilemaps: Object.values(d.studio?.mapIndex ?? {}).map(m => ({ id: m.id, name: m.name, cells: { w: m.w, h: m.h },
        size: mapPixelSize(d, m.id), layers: m.layers.map(({ id, name, tilesetId, visible, locked }) => ({ id, name, tilesetId, visible, locked })) })) };
      case 'scenes.list': {
        const catalog = productionCatalog(d);
        return { scenes: settings.scenes.map(scene => sceneInfo(d, scene, catalog)) };
      }
      case 'style.check': {
        const assetId = assetOf(d, key('assetId')).id, collectionId = optional('collectionId');
        if (collectionId) collectionOf();
        const task = this.pool.start({ mode: 'production', operation: 'inspect', root: this.store.root, projectId: d.id, revision: d.revision,
          rejectExternalEdits: true, assetId, collectionId: collectionId ?? undefined });
        const result = await task.promise as ExportResult;
        return { technical: JSON.parse(Buffer.from(result.data).toString('utf8')), artisticStatus: 'unreviewed' };
      }
      case 'package.plan':
      case 'package.start': {
        const collectionId = collectionOf().id, sceneId = optional('sceneId') ?? undefined;
        const plan = validate(() => productionPackagePlan(d, collectionId, sceneId));
        const scene = plan.scene && sceneInfo(d, plan.scene, productionCatalog(d));
        if (operation === 'package.plan') return { collectionId, assetIds: plan.assets.map(a => a.id), pixelFrames: plan.pixelFrames,
          scene: scene ?? null, eligible: !scene || (scene.withinLimits && !scene.stale), format: 'zip', validation: 'preflight' };
        if (scene?.stale) throw source('Cảnh có nguồn đã đổi. Đọc scenes.list để xác định nguồn cần xác nhận lại.');
        if (scene && !scene.withinLimits) throw limit('Cảnh vượt giới hạn preview.');
        return { job: this.startPackage(d, collectionId, sceneId) };
      }
      case 'jobs.status':
      case 'jobs.cancel':
      case 'jobs.result': {
        this.pruneJobs();
        const job = this.jobs.get(key('jobId'));
        if (!job || job.projectId !== d.id) throw missing('Job không tồn tại hoặc đã hết hạn.');
        if (operation === 'jobs.cancel' && job.state === 'running') {
          job.state = 'canceled'; job.ended = Date.now(); job.task.cancel();
        }
        if (operation !== 'jobs.result') return { job: this.showJob(job) };
        if (job.state !== 'ready' || !job.data) throw new AgentError(409, 'NOT_READY', 'Job chưa có kết quả.');
        if (job.revision !== d.revision) throw new AgentError(409, 'STALE_REVISION', 'Gói thuộc revision cũ. Kiểm tra dự án trước khi xuất lại.');
        return { job: this.showJob(job), result: { ...job.result, encoding: 'base64', content: job.data.toString('base64') } };
      }
      case 'asset.rename': {
        const a = assetOf(d, key('assetId')); a.name = name();
        return this.commit(d, requestId, operation, a.id);
      }
      case 'collection.membership':
      case 'collection.selectVersion': {
        const collection = collectionOf(), id = assetOf(d, key('assetId')).id;
        if (operation === 'collection.membership') {
          const include = validate(() => dataBoolean(input.include, 'Include'));
          collection.assets = include ? [...new Set([...collection.assets, id])] : collection.assets.filter(entry => entry !== id);
        } else {
          const replacement = assetOf(d, key('replacementId'));
          if (!collection.assets.includes(id) || getAssetLibraryInfo(d, replacement.id).groupId !== getAssetLibraryInfo(d, id).groupId) {
            throw new AgentError(400, 'INVALID_REQUEST', 'Chọn thành viên hiện tại và bản thay thế cùng family.');
          }
          if (productionCatalog(d).assets[replacement.id].status !== 'approved') throw source('Phiên bản thay thế chưa được duyệt hoặc đã đổi.');
          collection.assets = [...new Set(collection.assets.map(a => a === id ? replacement.id : a))];
        }
        return this.commit(d, requestId, operation, collection.id);
      }
      case 'asset.assignProfile': {
        const id = assetOf(d, key('assetId')).id, profileId = optional('profileId');
        if (profileId && !settings.profiles.some(p => p.id === profileId)) throw missing('Profile không tồn tại.');
        d.studio ??= { version: 1 }; d.studio.production ??= settings;
        const entry = settings.assets.find(a => a.assetId === id);
        if (entry) entry.profileId = profileId;
        else settings.assets.push({ assetId: id, kind: productionKind(d, id), profileId, approved: null });
        return this.commit(d, requestId, operation, id);
      }
      case 'scene.place': {
        const sceneId = key('sceneId'), scene = settings.scenes.find(s => s.id === sceneId);
        if (!scene) throw missing('Cảnh không tồn tại.');
        const a = assetOf(d, key('assetId')), tagId = optional('tagId'), placementId = optional('placementId');
        const catalog = productionCatalog(d), entry = catalog.assets[a.id];
        if (entry.status !== 'approved' || catalog.maps[scene.mapId] !== scene.mapSha256) throw source('Asset hoặc map cần xác nhận trong Studio.');
        if (tagId && !a.tags.some(t => t.id === tagId)) throw missing('Tag không tồn tại.');
        const id = placementId ?? randomUUID(), index = scene.placements.findIndex(p => p.id === id);
        if (placementId && index < 0) throw missing('Placement không tồn tại.');
        if (index < 0 && scene.placements.length >= productionLimits.scenePlacements) throw limit('Cảnh đã đạt giới hạn placement.');
        const x = validate(() => dataNumber(input.x, -4096, 8192, 'X', true)), y = validate(() => dataNumber(input.y, -4096, 8192, 'Y', true));
        const row = { id, assetId: a.id, tagId, stamp: entry.stamp, x, y };
        if (index < 0) scene.placements.push(row); else scene.placements[index] = row;
        return this.commit(d, requestId, operation, id);
      }
      case 'project.rollback': {
        const raw = input.snapshotId, undo = this.rollbacks.get(d.id);
        if (!undo || raw !== undo.snapshotId || undo.revision !== d.revision) {
          throw new AgentError(409, 'NOT_READY', 'Chỉ hoàn tác mutation Agent mới nhất trong phiên Studio hiện tại.');
        }
        const restored = this.store.restore(d.id, d.revision, undo.snapshotId);
        this.rollbacks.delete(d.id); this.saved(restored);
        return { project: { id: restored.id, revision: restored.revision },
          receipt: { id: requestId, previousRevision: d.revision, snapshotId: null, restoredSnapshotId: undo.snapshotId } };
      }
      default: throw new AgentError(404, 'UNKNOWN_OPERATION', 'Operation không được hỗ trợ.');
    }
  }

  private commit(doc: PixelDocument, requestId: string, operation: AgentOperation, targetId: string) {
    const label = `Agent v1 ${operation} ${requestId}`, previous = doc.revision;
    validate(() => validateDocument(doc));
    const saved = this.store.save(doc.id, previous, doc, label);
    const snapshotId = this.store.history(doc.id).find(entry => entry.label === label)?.id ?? null;
    if (snapshotId) {
      this.rollbacks.delete(doc.id); this.rollbacks.set(doc.id, { revision: saved.revision, snapshotId });
      if (this.rollbacks.size > 100) this.rollbacks.delete(this.rollbacks.keys().next().value!);
    }
    this.saved(saved);
    return { project: { id: saved.id, revision: saved.revision }, targetId,
      receipt: { id: requestId, previousRevision: previous, snapshotId } };
  }

  private showJob(job: Job) {
    return { id: job.id, projectId: job.projectId, revision: job.revision, state: job.state,
      result: job.result ?? null, diagnostics: job.diagnostic ? [job.diagnostic] : [],
      elapsedMs: (job.ended ?? Date.now()) - job.created };
  }
  private pruneJobs(): void {
    for (const [id, job] of this.jobs) if (job.ended && Date.now() - job.ended > jobTtlMs) this.jobs.delete(id);
  }
  private startPackage(doc: PixelDocument, collectionId: string, sceneId?: string) {
    this.pruneJobs();
    if (this.jobs.size >= maxJobs) throw limit('Hàng job Agent đã đầy. Chờ kết quả hết hạn.');
    const task = this.pool.start({ mode: 'production', operation: 'package', root: this.store.root, projectId: doc.id,
      revision: doc.revision, collectionId, sceneId, rejectExternalEdits: true });
    const job: Job = { id: randomUUID(), projectId: doc.id, revision: doc.revision, created: Date.now(), state: 'running', task };
    this.jobs.set(job.id, job);
    void task.promise.then(value => {
      if (job.state !== 'running') return;
      const r = value as ExportResult;
      if (r.data.byteLength + [...this.jobs.values()].reduce((sum, j) => sum + (j.data?.length ?? 0), 0) > agentResultBytes) {
        throw limit('Kết quả ZIP vượt ngân sách bộ nhớ job Agent.');
      }
      if (this.store.load(doc.id).revision !== doc.revision) throw new AgentError(409, 'STALE_REVISION', 'Dự án đã đổi trong lúc xuất.');
      job.data = Buffer.from(r.data);
      job.result = { id: job.id, filename: r.filename, mediaType: r.mime, byteLength: job.data.length, sha256: hash(job.data).toString('hex') };
      job.state = 'ready';
    }).catch(error => {
      if (job.state !== 'running') return;
      const fault = diagnostic(error);
      job.state = 'failed'; job.diagnostic = { code: fault.code, message: fault.message };
    }).finally(() => { job.ended ??= Date.now(); });
    return this.showJob(job);
  }
}
