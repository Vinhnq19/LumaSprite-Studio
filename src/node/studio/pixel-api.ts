import type { IncomingMessage, ServerResponse } from 'node:http';
import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { playback, wireParse, wireStringify, type PixelDocument } from '../../studio/pixel/model.ts';
import { dataId } from '../../studio/quality/data.ts';
import { validateResourceId, validateResourceRef } from '../../studio/resources.ts';
import { ExternalEngineApi } from './external-engine-api.ts';
import { NativeSceneApi } from './native-scene-api.ts';
import { PixelStore } from './pixel-store.ts';
import { productionCatalog, type ProductionRequest } from './production-worker.ts';
import type { ExportResult } from './render-result.ts';
import type { RenderPool, RenderTask, WorkerRequest } from './runner.ts';
import { StudioError } from './store.ts';
import { TerrainApi } from './terrain-api.ts';
import { zipFiles } from './zip.ts';

export function pixelApi(root: string, pool: RenderPool, emit: (event: unknown) => void, externalEnginePort?: number, externalEngineTimeoutMs?: number) {
  const store = new PixelStore(root);
  const watched = new Map<string, number>();
  const tasks = new Map<string, Set<RenderTask>>();
  const externalEngine = new ExternalEngineApi(store, externalEnginePort, externalEngineTimeoutMs);
  const nativeScenes = new NativeSceneApi(store);
  const terrain = new TerrainApi(store, pool, emit);

  async function run(id: string, request: WorkerRequest): Promise<ExportResult> {
    const task = pool.start(request);
    const pending = tasks.get(id) ?? new Set<RenderTask>();
    tasks.set(id, pending);
    pending.add(task);
    try { return await task.promise; }
    finally {
      pending.delete(task);
      if (!pending.size && tasks.get(id) === pending) tasks.delete(id);
    }
  }

  const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(wireStringify(data)); };
  function observe(d: PixelDocument) {
    const path = join(store.dir(d.id), 'pxl.project.json'); const existed = watched.has(path); watched.set(path, d.revision);
    if (existed) return;
    watchFile(path, { interval: 500, persistent: false }, () => {
      try { const next = store.load(d.id); if (next.revision !== watched.get(path)) { watched.set(path, next.revision); emit({ type: 'pixel-external', projectId: d.id, revision: next.revision }); } }
      catch (e) { emit({ type: 'pixel-error', projectId: d.id, message: (e as Error).message }); }
    });
  }
  function revision(d: PixelDocument, value: unknown) { if (value !== d.revision) throw new StudioError('Revision đã thay đổi; giữ bản nháp và tải lại hoặc lưu bản sao.', 409, 'STALE_REVISION'); }
  async function route(req: IncomingMessage, res: ServerResponse, url: URL, b: () => Promise<any>): Promise<boolean> {
    if (!url.pathname.startsWith('/api/pixel/')) return false;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[2] === 'projects' && !parts[3]) {
      if (req.method === 'GET') json(res, store.list());
      else if (req.method === 'POST') {
        const input = wireParse(JSON.stringify(await b()));
        if (input.backup) { const saved = store.importBackup(input.name, input.backup.document, input.backup.blobs, input.backup.history, input.backup.resourceBlobs); observe(saved); json(res, saved, 201); return true; }
        if (input.document && input.sourceProjectId) {
          const copied = store.copy(input.name, input.document, input.sourceProjectId);
          observe(copied);
          json(res, copied, 201);
          return true;
        }
        const d = store.create(input.name, input.w, input.h, input.background, input.document); observe(d); json(res, store.load(d.id), 201);
      }
      else throw new StudioError('Method không được phép.', 405);
      return true;
    }
    if (parts[2] !== 'projects' || !parts[3]) throw new StudioError('Không tìm thấy API pixel.', 404);
    const id = parts[3], action = parts[4];
    // A lazy cel read verifies its requested blob in store.cel; rescanning every asset here stalls playback.
    const celRead = action === 'cel' && req.method === 'GET';
    const d = store.load(id, false, action !== 'history' && !celRead); observe(d);
    if (action === 'external-engine') {
      const result = await externalEngine.route(d, req.method ?? '', parts.slice(5), b);
      if (result.saved) {
        observe(result.saved);
        emit({ type: 'pixel-saved', projectId: id, revision: result.saved.revision });
      }
      json(res, result.value, result.status);
      return true;
    }
    if (action === 'production') {
      if (req.method !== 'GET' || parts.length > 5) throw new StudioError('Route Production không hợp lệ.', 405);
      const operation = url.searchParams.get('operation');
      if (operation !== 'thumbnail') revision(d, Number(url.searchParams.get('revision')));
      if (operation === 'catalog') { json(res, productionCatalog(d)); return true; }
      const param = (name: string) => dataId(url.searchParams.get(name), name);
      const base = { mode: 'production' as const, root, projectId: id, revision: d.revision };
      let request: ProductionRequest;
      if (operation === 'thumbnail') {
        const sha256 = url.searchParams.get('sha256');
        if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new StudioError('Hash thumbnail không hợp lệ.');
        request = { ...base, operation, assetId: param('assetId'), sha256 };
      }
      else if (operation === 'inspect') request = { ...base, operation, assetId: param('assetId'), ...(url.searchParams.has('collectionId') && { collectionId: param('collectionId') }) };
      else if (operation === 'scene') request = { ...base, operation, sceneId: param('sceneId') };
      else if (operation === 'package') request = { ...base, operation, collectionId: param('collectionId'), ...(url.searchParams.has('sceneId') && { sceneId: param('sceneId') }) };
      else throw new StudioError('Thao tác Production không hợp lệ.', 400);
      const out = await run(id, request) as ExportResult;
      if (operation !== 'thumbnail') revision(store.load(id), d.revision);
      res.writeHead(200, { 'content-type': out.mime, 'cache-control': operation === 'thumbnail' ? 'private, max-age=600' : 'no-store',
        ...(operation === 'package' && { 'content-disposition': 'attachment; filename="production.zip"' }) });
      res.end(Buffer.from(out.data));
      return true;
    }
    if (action === 'native-scenes') {
      if (await nativeScenes.route(req, res, url, parts, d, b, observe, emit)) return true;
    }
    if (await terrain.route(req, res, parts, d, b)) return true;
    if (!action) {
      if (req.method === 'GET') json(res, d);
      else if (req.method === 'PUT') { const input = wireParse(JSON.stringify(await b())); const saved = store.save(id, input.revision, input.document, input.snapshot ? 'Trước khi lưu thủ công' : undefined); if (input.snapshot) store.snapshot(saved, 'Lưu thủ công'); observe(saved); emit({ type: 'pixel-saved', projectId: id, revision: saved.revision }); json(res, saved); }
      else throw new StudioError('Method không được phép.', 405);
      return true;
    }
    if (action === 'cel' && req.method === 'GET') {
      if (url.searchParams.has('blob')) {
        revision(d, Number(url.searchParams.get('revision')));
        const ref = { version: 1 as const, kind: 'rgba' as const, w: Number(url.searchParams.get('w')), h: Number(url.searchParams.get('h')), blob: url.searchParams.get('blob')! };
        validateResourceRef(ref);
        const celId = url.searchParams.get('cel') ?? '', assetId = url.searchParams.get('asset') ?? '';
        if (!/^[\w-]{1,80}$/.test(celId) || !/^[\w-]{1,80}$/.test(assetId)) throw new StudioError('ID cel/asset không hợp lệ.');
        // Undo can reference an older owned blob before its manifest is saved.
        json(res, { id: celId, blob: ref.blob, data: store.cel(id, ref.blob, ref.w * ref.h) }); return true;
      }
      revision(d, Number(url.searchParams.get('revision'))); const asset = d.assets.find(a => a.id === url.searchParams.get('asset')), c = asset?.cels[url.searchParams.get('cel') ?? ''];
      if (!asset || !c) throw new StudioError('Không tìm thấy cel.', 404);
      json(res, { ...c, data: store.cel(id, c.blob!, asset.w * asset.h) }); return true;
    }
    if (action === 'resource' && req.method === 'GET') {
      revision(d, Number(url.searchParams.get('revision')));
      const resId = url.searchParams.get('resource') ?? '';
      try {
        validateResourceId(resId);
      } catch (err) {
        throw new StudioError((err as Error).message, 400);
      }
      if (url.searchParams.has('blob')) {
        const ref = { version: 1 as const, kind: url.searchParams.get('kind'), w: Number(url.searchParams.get('w')), h: Number(url.searchParams.get('h')), blob: url.searchParams.get('blob') };
        validateResourceRef(ref);
        // The store confines this digest to this project's owned resource folder.
        const data = store.resourceStore(id).read(ref);
        json(res, { ...ref, data }); return true;
      }
      if (!d.studio?.resources || !Object.hasOwn(d.studio.resources, resId)) {
        throw new StudioError('Không tìm thấy tài nguyên.', 404);
      }
      const item = store.resource(id, resId);
      revision(store.load(id, false, false), d.revision);
      json(res, item);
      return true;
    }
    if (action === 'history') {
      if (req.method === 'GET') json(res, store.history(id));
      else if (req.method === 'POST') { const input = await b(); const saved = store.restore(id, input.revision, input.snapshot); observe(saved); emit({ type: 'pixel-saved', projectId: id, revision: saved.revision }); json(res, saved); }
      else throw new StudioError('Method không được phép.', 405);
      return true;
    }
    if (action === 'backup' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="pixel-project.zip"' }); res.end(zipFiles(store.backupFiles(id))); return true; }
    if (action === 'export' && req.method === 'POST') {
      const input = await b(); revision(d, input.revision); if (!['png', 'gif', 'strip', 'atlas', 'zip'].includes(input.format)) throw new StudioError('Định dạng không hợp lệ.', 400, 'EXPORT_FAILED');
      const selected = d.assets.find(a => a.id === input.assetId) ?? d.assets[0];
      if (!selected) throw new StudioError('Dự án chưa có asset để xuất.');
      const sequence = new Set(playback(selected, input.tagId).map(s => s.frame.id));
      store.hydrate(d, (a, frame) => ['atlas', 'zip'].includes(input.format) ? !input.selected?.length || input.selected.includes(a.id) : a.id === selected.id && (input.format === 'png' ? frame === (input.frameId ?? a.frames[0].id) : sequence.has(frame)));
      const result = await run(id, { mode: 'pixel-export', document: d, assetId: input.assetId, frameId: input.frameId, tagId: input.tagId, format: input.format, selected: input.selected }) as ExportResult; revision(store.load(id), d.revision);
      res.writeHead(200, { 'content-type': result.mime, 'content-disposition': `attachment; filename="asset.${result.filename.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(result.filename)}` }); res.end(Buffer.from(result.data)); return true;
    }
    if (action === 'close' && req.method === 'POST') {
      await b();
      const path = join(store.dir(id), 'pxl.project.json');
      unwatchFile(path);
      watched.delete(path);
      await terrain.closeProject(id);
      const pending = [...tasks.get(id) ?? []];
      for (const task of pending) task.cancel();
      await Promise.allSettled(pending.map(task => task.promise));
      store.releaseResources(id);
      json(res, { ok: true });
      return true;
    }
    throw new StudioError('Không tìm thấy thao tác pixel.', 404);
  }

  return {
    route,
    agentSaved: (doc: PixelDocument) => {
      observe(doc);
      emit({ type: 'pixel-saved', projectId: doc.id, revision: doc.revision });
    },
    close: async () => {
      for (const path of watched.keys()) unwatchFile(path);
      watched.clear();
      await terrain.close();
      const pending = [...tasks.values()].flatMap(set => [...set]);
      for (const task of pending) task.cancel();
      await Promise.allSettled(pending.map(task => task.promise));
      store.releaseResources();
    },
  };
}
