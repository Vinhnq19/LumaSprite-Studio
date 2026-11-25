import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentPath } from '../../studio/agent-contract.ts';
import { diagnosticOf } from '../../studio/diagnostic.ts';
import { StudioAgentApi } from './agent-api.ts';
import { pixelApi } from './pixel-api.ts';
import { PixelStore } from './pixel-store.ts';
import { RenderPool } from './runner.ts';
import { safePath, StudioError } from './store.ts';

export interface StudioOptions {
  port?: number;
  uiDir?: string;
  externalEnginePort?: number;
  externalEngineTimeoutMs?: number;
  agentWriteToken?: string;
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  const maxBytes = /^\/api\/pixel\/projects\/[^/]+\/external-engine(?:\/|$)/.test(req.url ?? '') ? 1024 * 1024 :
    req.url?.startsWith('/api/pixel/') ? 192_000_000 : 12_000_000;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new StudioError('Yêu cầu vượt giới hạn kích thước.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new StudioError('JSON không hợp lệ.'); }
}

export async function serveStudio(projectRoot: string, options: StudioOptions = {}) {
  const root = resolve(projectRoot);
  mkdirSync(root, { recursive: true });
  const clients = new Set<ServerResponse>();
  const pool = new RenderPool(2);
  let ownOrigin = '';
  const uiDir = options.uiDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/studio');
  if (!existsSync(resolve(uiDir, 'index.html'))) throw new StudioError('Giao diện Studio chưa được build. Chạy npm run build trước khi mở app.');
  const emit = (event: unknown) => {
    for (const client of clients) client.write('data: ' + JSON.stringify(event) + '\n\n');
  };
  const externalPort = options.externalEnginePort ?? (process.env.LUMASPRITE_ENGINE_PORT ? Number(process.env.LUMASPRITE_ENGINE_PORT)
    : process.env.PXL_EXTERNAL_ENGINE_PORT ? Number(process.env.PXL_EXTERNAL_ENGINE_PORT) : undefined);
  const pixel = pixelApi(root, pool, emit, externalPort, options.externalEngineTimeoutMs);
  const store = new PixelStore(root, true);
  const agent = new StudioAgentApi(store, pool, pixel.agentSaved, externalPort,
    options.agentWriteToken ?? process.env.LUMASPRITE_AGENT_WRITE_TOKEN ?? process.env.PXL_AGENT_WRITE_TOKEN);
  function json(res: ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
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
      if (await pixel.route(req, res, url, () => body(req))) return;
      if (url.pathname === '/api/studio/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('data: {"type":"connected"}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
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
    clearInterval(ping);
    for (const client of clients) client.end();
    clients.clear();
    pool.close();
    await pixel.close();
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  } };
}
