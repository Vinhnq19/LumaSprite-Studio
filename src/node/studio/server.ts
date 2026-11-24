import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, watchFile, unwatchFile } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { BuildSummary, ProjectDocument } from '../../studio/types.ts';
import { ProjectStore, safePath, StudioError } from './store.ts';
import { validatePixels } from './render.ts';
import { RenderPool, type RenderTask } from './runner.ts';
import { AiManager, detectProviders, type ProviderSettings } from './ai.ts';
import { zipFiles } from './zip.ts';
import type { ExportResult } from './render.ts';
import { pixelApi } from './pixel-api.ts';
import { diagnosticOf } from '../../studio/diagnostic.ts';
import { agentPath } from '../../studio/agent-contract.ts';
import { StudioAgentApi } from './agent-api.ts';
import { PixelStore } from './pixel-store.ts';

export interface StudioOptions { port?: number; uiDir?: string; providers?: ProviderSettings; renderTimeout?: number; externalEnginePort?: number; externalEngineTimeoutMs?: number; agentWriteToken?: string }
interface BuildJob { id: string; projectId: string; revision: number; status: string; result?: BuildSummary; error?: string }
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  const maxBytes = /^\/api\/pixel\/projects\/[^/]+\/external-engine(?:\/|$)/.test(req.url ?? '') ? 1024 * 1024 :
    req.url?.startsWith('/api/pixel/') ? 192_000_000 : 12_000_000;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new StudioError('Yêu cầu vượt giới hạn kích thước.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new StudioError('JSON không hợp lệ.'); }
}
export async function serveStudio(root: string, options: StudioOptions = {}): Promise<{ url: string; close: () => Promise<void>; store: ProjectStore }> {
  const store = new ProjectStore(resolve(root)), clients = new Set<ServerResponse>();
  const pool = new RenderPool(2);
  const builds = new Map<string, BuildJob>(), running = new Map<string, RenderTask>(), cache = new Map<string, { value: any; bytes: number }>();
  const logs: { time: string; message: string }[] = []; const watched = new Map<string, string>();
  let cacheBytes = 0, closing = false, ownOrigin = '';
  const observedRevision = new Map<string, number>();
  const uiDir = options.uiDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/studio');
  if (!existsSync(join(uiDir, 'index.html'))) throw new StudioError('Giao diện Studio chưa được build. Chạy npm run build trước khi mở app.');
  const emit = (event: any) => { const data = `data: ${JSON.stringify(event)}\n\n`; for (const c of clients) c.write(data); };
  const log = (message: string) => { const record = { time: new Date().toISOString(), message }; logs.push(record); if (logs.length > 100) logs.shift(); emit({ type: 'log', ...record }); };
  const ai = new AiManager(store, emit, options.providers);
  const externalPort = options.externalEnginePort ?? (process.env.PXL_EXTERNAL_ENGINE_PORT ? Number(process.env.PXL_EXTERNAL_ENGINE_PORT) : undefined);
  const pixel = pixelApi(store.root, store, pool, emit, options.providers, externalPort, options.externalEngineTimeoutMs);
  const agent = new StudioAgentApi(new PixelStore(store.root, true), pool, pixel.agentSaved, externalPort, options.agentWriteToken ?? process.env.PXL_AGENT_WRITE_TOKEN);
  const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const invalidate = (id: string) => {
    for (const [key, value] of cache) if (key.startsWith(id + ':')) { cacheBytes -= value.bytes; cache.delete(key); }
    for (const [key, task] of running) if (key.startsWith(id + ':')) { task.cancel(); running.delete(key); }
    for (const job of builds.values()) if (job.projectId === id && job.status === 'running') { running.get(job.id)?.cancel(); job.status = 'canceled'; }
  };
  const putCache = (key: string, value: any) => {
    const bytes = JSON.stringify(value).length * 2;
    if (bytes > 64 * 1024 * 1024) return;
    const previous = cache.get(key); if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
    while ((cacheBytes + bytes > 128 * 1024 * 1024 || cache.size >= 64) && cache.size) { const first = cache.keys().next().value!; cacheBytes -= cache.get(first)!.bytes; cache.delete(first); }
    cache.set(key, { value, bytes }); cacheBytes += bytes;
  };
  function observe(doc: ProjectDocument): void {
    observedRevision.set(doc.id, doc.revision);
    const names = [...Object.keys(doc.files), '.pxl/pixels.json', '.pxl/metadata.json', 'pxl.project.json', '.', ...Object.keys(doc.files).map(n => dirname(n))];
    const currentPaths = new Set(names.map(name => safePath(store.dir(doc.id), name)));
    for (const [path, id] of watched) if (id === doc.id && !currentPaths.has(path)) { unwatchFile(path); watched.delete(path); }
    for (const name of names) {
      const path = safePath(store.dir(doc.id), name); if (watched.has(path)) continue; watched.set(path, doc.id);
      watchFile(path, { interval: 500, persistent: false }, () => {
        if (closing) return;
        try { const next = store.load(doc.id); if (next.revision !== observedRevision.get(doc.id)) { observedRevision.set(doc.id, next.revision); invalidate(doc.id); emit({ type: 'external', projectId: doc.id, revision: next.revision }); } }
        catch (e) { log(`File thay đổi: ${(e as Error).message}`); }
      });
    }
  }
  const load = (id: string) => { const doc = store.load(id); observe(doc); return doc; };
  const checkRevision = (doc: ProjectDocument, revision: unknown) => { if (!Number.isInteger(revision) || doc.revision !== revision) throw new StudioError('Revision đã thay đổi. Tải lại dự án.', 409, 'STALE_REVISION'); };
  async function render(doc: ProjectDocument, request: Parameters<RenderPool['start']>[0]): Promise<any> {
    const task = pool.start(request, options.renderTimeout), key = `${doc.id}:${randomUUID()}`; running.set(key, task);
    try { const value = await task.promise; if (store.load(doc.id).revision !== doc.revision) throw new StudioError('Kết quả dựng đã cũ; dự án vừa thay đổi.', 409); return value; }
    finally { running.delete(key); }
  }
  function persistExport(doc: ProjectDocument, output: ExportResult): void {
    const dir = safePath(store.dir(doc.id), 'exports'); mkdirSync(dir, { recursive: true });
    const manifestPath = safePath(store.dir(doc.id), 'exports/.pxl-exports.json');
    let previous: { path: string; hash: string }[] = [];
    try { previous = JSON.parse(readFileSync(manifestPath, 'utf8')).files; } catch { /* First export. */ }
    const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
    for (const file of previous) {
      const path = safePath(dir, file.path);
      if (existsSync(path) && digest(readFileSync(path)) === file.hash) rmSync(path);
    }
    let path = output.filename;
    if (existsSync(safePath(dir, path))) path = `${Date.now()}-${path}`;
    writeFileSync(safePath(dir, path), output.data);
    writeFileSync(manifestPath, JSON.stringify({ revision: doc.revision, files: [{ path, hash: digest(output.data) }] }, null, 2));
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new StudioError('Host không được phép.', 403);
      if (url.pathname === agentPath) { await agent.handle(req, res, ownOrigin); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin !== ownOrigin && origin !== ownOrigin.replace('127.0.0.1', 'localhost')) throw new StudioError('Origin không được phép.', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new StudioError('Yêu cầu cần application/json.', 415);
      }
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (await pixel.route(req, res, url, () => body(req))) return;
      if (url.pathname === '/api/studio/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('data: {"type":"connected"}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (url.pathname === '/api/studio/providers') return json(res, await detectProviders(options.providers));
      if (url.pathname === '/api/studio/logs') return json(res, logs);
      if (url.pathname === '/api/studio/projects') {
        if (req.method === 'GET') return json(res, store.list());
        const b = await body(req); const doc = b.importPath ? store.importFolder(b.importPath, b.name, b.entry ?? 'art.px.js') : store.create(b.name, b.template, b.files, b.entry);
        observe(doc); log(`Tạo dự án ${doc.name}`); return json(res, doc, 201);
      }
      if (segments[0] === 'api' && segments[1] === 'studio' && segments[2] === 'builds') {
        const job = builds.get(segments[3]); if (!job) throw new StudioError('Không tìm thấy bản dựng.', 404); return json(res, job);
      }
      if (segments[0] === 'api' && segments[1] === 'studio' && segments[2] === 'ai') {
        const job = ai.get(segments[3]); const action = segments[4];
        if (!action) return json(res, job);
        if (action === 'cancel' && req.method === 'POST') { await body(req); return json(res, await ai.cancel(job.id)); }
        if (action === 'apply' && req.method === 'POST') { const b = await body(req); const doc = ai.apply(job.id, b.revision); invalidate(doc.id); observe(doc); log(`Áp dụng AI ${job.provider}: ${doc.name}`); return json(res, doc); }
        if (action === 'frame') {
          const doc = ai.candidate(job.id); return json(res, await render(doc, { document: doc, mode: 'frame', name: url.searchParams.get('name') ?? undefined, frame: Number(url.searchParams.get('frame') ?? 0) }));
        }
        throw new StudioError('Thao tác AI không hợp lệ.', 404);
      }
      if (segments[0] === 'api' && segments[1] === 'studio' && segments[2] === 'projects' && segments[3]) {
        const id = segments[3], action = segments[4], doc = load(id);
        if (!action) {
          if (req.method === 'GET') return json(res, doc);
          if (req.method !== 'PUT') throw new StudioError('Method không được phép.', 405);
          const b = await body(req); validatePixels({ ...doc, pixels: b.changes?.pixels ?? doc.pixels });
          const allowed = ['files', 'pixels', 'metadata', 'name', 'entry'];
          if (!b.changes || Object.keys(b.changes).some(k => !allowed.includes(k))) throw new StudioError('Thay đổi không hợp lệ.');
          const saved = store.save(id, b.revision, b.changes); if (b.snapshot) store.snapshot(saved, 'Lưu thủ công'); invalidate(id); observe(saved); emit({ type: 'saved', projectId: id, revision: saved.revision }); return json(res, saved);
        }
        if (action === 'history') {
          if (req.method === 'GET') return json(res, store.history(id));
          const b = await body(req); const saved = store.restore(id, b.revision, b.snapshot); invalidate(id); return json(res, saved);
        }
        if (action === 'build' && req.method === 'POST') {
          const b = await body(req); checkRevision(doc, b.revision);
          for (const previous of builds.values()) if (previous.projectId === id && previous.status === 'running') { running.get(previous.id)?.cancel(); previous.status = 'canceled'; }
          const job: BuildJob = { id: randomUUID(), projectId: id, revision: doc.revision, status: 'running' }; builds.set(job.id, job);
          const task = pool.start({ document: doc, mode: 'summary' }, options.renderTimeout); running.set(job.id, task);
          void task.promise.then(value => {
            if (job.status !== 'running') return;
            if (store.load(id).revision !== job.revision) { job.status = 'canceled'; return; }
            job.status = 'ready'; job.result = value as BuildSummary; putCache(`${id}:${doc.revision}:summary`, value); emit({ type: 'build', job });
          }).catch(e => { if (job.status === 'running') { job.status = 'failed'; job.error = (e as Error).message; emit({ type: 'build', job }); } }).finally(() => running.delete(job.id));
          while (builds.size > 100) { const old = [...builds.values()].find(j => j.status !== 'running'); if (!old) break; builds.delete(old.id); }
          return json(res, job, 202);
        }
        if (action === 'frame' || action === 'atlas') {
          const revision = Number(url.searchParams.get('revision')); checkRevision(doc, revision);
          const name = url.searchParams.get('name') ?? undefined, frame = Number(url.searchParams.get('frame') ?? 0), trace = url.searchParams.get('trace') === '1';
          if (!Number.isInteger(frame) || frame < 0 || frame > 599) throw new StudioError('Frame không hợp lệ.');
          const sheet = url.searchParams.get('sheet') ?? undefined;
          const traceStep = url.searchParams.has('traceStep') ? Number(url.searchParams.get('traceStep')) : undefined;
          if (traceStep !== undefined && (!Number.isInteger(traceStep) || traceStep < 0 || traceStep > 4001)) throw new StudioError('Bước vẽ không hợp lệ.');
          const key = `${id}:${revision}:${action}:${name}:${frame}:${trace}:${sheet}:${traceStep}`;
          const cached = cache.get(key); if (cached) { cache.delete(key); cache.set(key, cached); return json(res, cached.value); }
          const value = await render(doc, { document: doc, mode: action, name, frame, trace, sheet, traceStep }); putCache(key, value); return json(res, value);
        }
        if (action === 'export' && req.method === 'POST') {
          const b = await body(req); checkRevision(doc, b.revision);
          if (!['png', 'gif', 'strip', 'atlas', 'zip'].includes(b.format)) throw new StudioError('Định dạng xuất không hợp lệ.');
          const output = await render(doc, { document: doc, mode: 'export', name: b.name, frame: b.frame, format: b.format, selected: b.selected, sheet: b.sheet }) as ExportResult;
          persistExport(doc, output); log(`Xuất ${output.filename}: ${doc.name} (r${doc.revision})`);
          res.writeHead(200, { 'content-type': output.mime, 'content-disposition': `attachment; filename="asset.${extname(output.filename).slice(1)}"; filename*=UTF-8''${encodeURIComponent(output.filename)}`, 'cache-control': 'no-store' }); res.end(Buffer.from(output.data)); return;
        }
        if (action === 'backup') {
          const manifest = { schemaVersion: 1, id: doc.id, name: doc.name, entry: doc.entry, revision: doc.revision };
          const files = Object.entries(doc.files).map(([path, source]) => ({ path, data: Buffer.from(source) }));
          files.push({ path: 'pxl.project.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { path: '.pxl/pixels.json', data: Buffer.from(JSON.stringify(doc.pixels)) }, { path: '.pxl/metadata.json', data: Buffer.from(JSON.stringify(doc.metadata)) });
          for (const h of store.history(id)) files.push({ path: `.pxl/history/${h.id}`, data: readFileSync(safePath(store.dir(id), `.pxl/history/${h.id}`)) });
          res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="project-${id}.zip"` }); res.end(zipFiles(files)); return;
        }
        if (action === 'ai') {
          if (req.method === 'GET') return json(res, [...ai.jobs.values()].filter(j => j.projectId === id));
          if (req.method === 'POST') { const b = await body(req); checkRevision(doc, b.revision); return json(res, await ai.start(doc, b.provider, b.prompt), 202); }
        }
        if (action === 'close' && req.method === 'POST') {
          await body(req); invalidate(id);
          for (const [key, task] of running) if (key.startsWith(id + ':')) { task.cancel(); running.delete(key); }
          for (const j of builds.values()) if (j.projectId === id && j.status === 'running') { running.get(j.id)?.cancel(); j.status = 'canceled'; }
          for (const [path, projectId] of watched) if (projectId === id) { unwatchFile(path); watched.delete(path); }
          return json(res, { ok: true });
        }
        throw new StudioError('Không tìm thấy API.', 404);
      }
      if (url.pathname.startsWith('/api/')) throw new StudioError('Không tìm thấy API.', 404);
      const path = safePath(uiDir, decodeURIComponent(url.pathname === '/' ? 'index.html' : '.' + url.pathname));
      if (!existsSync(path)) throw new StudioError('Giao diện chưa được build. Chạy npm run build.', 404);
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(readFileSync(path));
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const error = (e as Error).message;
      json(res, { error, diagnostic: diagnosticOf(e) }, e instanceof StudioError ? e.status : 400);
    }
  });
  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000); ping.unref();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(options.port ?? 4321, '127.0.0.1', ok); });
  const address = server.address() as { port: number }; ownOrigin = `http://127.0.0.1:${address.port}`;
  return { url: ownOrigin + '/', store, close: async () => {
    closing = true; clearInterval(ping); for (const path of watched.keys()) unwatchFile(path); watched.clear();
    for (const task of running.values()) task.cancel(); running.clear(); pool.close(); await ai.close(); await pixel.close();
    for (const c of clients) c.end(); clients.clear(); cache.clear(); cacheBytes = 0;
    await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); });
  } };
}
