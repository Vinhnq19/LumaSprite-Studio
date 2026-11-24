import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4399' }, version: { type: 'string', default: '1' } } });
const jobs = new Map(), receipts = new Map();
const capabilities = {
  name: 'LumaSprite External Mock Engine', versions: [Number(values.version)], assetTypes: ['character', 'prop', 'icon'],
  features: ['progress', 'previews', 'masks'], limits: { width: 128, height: 128, frames: 1 },
};
const sprites = {
  character: ['..111...', '.12221..', '.13431..', '..131.1.', '.1222221', '1122211.', '..1.1...', '.11.11..'],
  prop: ['11....11', '121..121', '.122221.', '..1221..', '...12...', '...12...', '...12...', '...11...'],
  icon: ['...11...', '..1221..', '.124321.', '12344321', '12342321', '.123321.', '..1221..', '...11...'],
};
const sha = data => createHash('sha256').update(data).digest('hex');
function respond(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function input(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 160000) throw Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const fixture = brief => /^\[fixture:([a-z-]+)\]/.exec(brief)?.[1];
function status(job) {
  const elapsed = Date.now() - job.start;
  let state = 'queued', completed = 0;
  if (job.canceled && job.scenario !== 'late') state = 'canceled';
  else if (elapsed >= 250 && job.scenario === 'failure') state = 'failed';
  else if (elapsed >= (job.scenario === 'slow' ? 2500 : 850) && job.scenario !== 'timeout') { state = 'ready'; completed = 2; }
  else if (elapsed >= 150) { state = 'running'; completed = 1; }
  return {
    id: job.scenario === 'invalid-job' ? '../foreign' : job.id, state, progress: { completed, total: 2 },
    ...(state === 'ready' && { finalVersionId: 'fixture-v1' }),
    ...(state === 'failed' && { message: 'Lỗi fixture xác định.' }),
  };
}
function result(job) {
  const { canvas: { w, h }, assetType, palette, region, frameDurationsMs: [durationMs] } = job.request;
  const colors = palette?.filter(ink => ink & 255) ?? [];
  const bitmap = sprites[assetType], rgba = region ? Buffer.from(region.rgba, 'base64') : Buffer.alloc(w * h * 4);
  if (region) {
    const mask = Buffer.from(region.editable, 'base64'), index = mask.indexOf(1);
    if (index >= 0 && colors.length) {
      const previous = rgba.readUInt32BE(index * 4);
      rgba.writeUInt32BE(colors.find(ink => ink !== previous) ?? previous, index * 4);
    }
  } else {
    const scale = Math.max(1, Math.floor(Math.min(w, h) / 12));
    const left = Math.floor((w - 8 * scale) / 2), top = Math.floor((h - 8 * scale) / 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cell = bitmap[Math.floor((y - top) / scale)]?.[Math.floor((x - left) / scale)];
      if (cell && cell !== '.') rgba.writeUInt32BE(colors[(Number(cell) - 1) % colors.length] ?? 0, (y * w + x) * 4);
    }
  }
  if (job.scenario === 'palette') rgba.writeUInt32BE(0xff00f1ff, 0);
  if (job.scenario === 'alpha') rgba.writeUInt32BE(0xff00f180, 0);
  if (job.scenario === 'protected') {
    const index = region ? Buffer.from(region.editable, 'base64').indexOf(0) : 0;
    if (index >= 0) rgba.writeUInt32BE(rgba.readUInt32BE(index * 4) === 0 ? colors[0] : 0, index * 4);
  }
  if (job.scenario === 'mutation' && ++job.downloads > 1) rgba.writeUInt32BE(colors[0] ?? 0, 0);
  return {
    version: 1, jobId: job.id, versionId: job.scenario === 'invalid-version' ? 'foreign-v2' : 'fixture-v1',
    name: `Mock ${assetType}`, w: job.scenario === 'canvas' ? w + 1 : w, h, loop: false,
    frames: [{ durationMs, rgba: rgba.toString('base64'), sha256: job.scenario === 'digest' ? '0'.repeat(64) : sha(rgba) }],
    ...(job.scenario === 'metadata' && { metadata: { pivot: { x: -99, y: 200 } } }),
  };
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? '').split('/');
    if (req.method === 'GET' && req.url === '/v1/capabilities') return respond(res, capabilities);
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      const request = await input(req), scenario = fixture(request.brief);
      const { w, h } = request.canvas;
      if (request.version !== 1 || !capabilities.assetTypes.includes(request.assetType) ||
          ![w, h].every(value => Number.isInteger(value) && value >= 1 && value <= 128) ||
          request.frameDurationsMs.length !== 1) return respond(res, { message: 'Unsupported request.' }, 400);
      const digest = sha(JSON.stringify(request)), previous = receipts.get(request.requestId);
      if (previous) return previous.digest === digest ? respond(res, status(previous.job)) : respond(res, { message: 'Request ID conflict.' }, 409);
      const job = { id: randomUUID(), start: Date.now(), scenario, request, downloads: 0, canceled: false };
      jobs.set(job.id, job); receipts.set(request.requestId, { digest, job });
      if (scenario === 'unconfirmed') { req.socket.destroy(); return; }
      return respond(res, status(job), 201);
    }
    const job = path[1] === 'v1' && path[2] === 'jobs' && jobs.get(path[3]);
    if (!job) return respond(res, { message: 'Unknown route or job.' }, 404);
    if (req.method === 'GET' && path.length === 4) return respond(res, status(job));
    if (req.method === 'POST' && path[4] === 'cancel' && path.length === 5) { job.canceled = true; return respond(res, status(job)); }
    if (req.method === 'GET' && path[4] === 'results' && path[5] === 'fixture-v1' && status(job).state === 'ready') {
      if (job.scenario === 'oversize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"payload":"');
        res.write('a'.repeat(2 * 1024 * 1024));
        return res.end('"}');
      }
      return respond(res, result(job));
    }
    return respond(res, { message: 'Result unavailable.' }, 404);
  } catch {
    if (!res.headersSent) respond(res, { message: 'Malformed mock request.' }, 400);
    else res.destroy();
  }
});
server.listen(Number(values.port), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
