import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ProjectStore } from '../dist/node/studio/store.js';
import { AiManager } from '../dist/node/studio/ai.js';
import { startRender } from '../dist/node/studio/runner.js';
import { wireParse, composite } from '../dist/studio/pixel/model.js';
import { deepSeekConfigured } from '../dist/node/studio/deepseek-http.js';
const provider = process.argv[2];
if (!['codex', 'deepseek'].includes(provider)) { console.error('Usage: node scripts/smoke-studio-ai.js codex|deepseek (calls the real CLI/API)'); process.exit(2); }
// Local key check only: never prints the key and never sends a request.
if (provider === 'deepseek' && !deepSeekConfigured()) { console.error('DeepSeek smoke cần PXL_DEEPSEEK_API_KEY trong môi trường; chưa gửi yêu cầu nào.'); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), 'pxl-studio-live-smoke-')), store = new ProjectStore(root);
// Smoke-only budget: 240s for the provider call leaves 60s for local render and cleanup inside the approved five-minute maximum.
const ai = new AiManager(store, event => { if (event.job) console.log(JSON.stringify({ status: event.job.status, message: event.job.message })); }, { timeout: 240000 });
try {
  const p = store.create('Live CLI smoke', 'blank');
  const job = await ai.start(p, provider, "Keep the canvas sprite name, 32x32 dimensions, palette and sheet unchanged. Paint exactly one green pixel #70c989ff at (16,16); every other pixel must stay fully transparent. Return the complete art.px.js source in the required JSON. Do not use tools or change files.");
  while (['running', 'validating', 'canceling'].includes(job.status)) await new Promise(r => setTimeout(r, 500));
  if (job.status !== 'ready') throw new Error(job.message);
  if (store.load(p.id).revision !== p.revision) throw new Error('AI wrote the real project before Apply');
  const saved = ai.apply(job.id, p.revision);
  // Render saved source in the worker before checking pixels.
  const rendered = await startRender({ mode: 'raster', document: store.load(saved.id), name: 'canvas' }).promise;
  const raster = wireParse(Buffer.from(rendered.data).toString('utf8'));
  if (!Array.isArray(raster) || raster.length !== 1 || raster[0].name !== 'canvas' || raster[0].w !== 32 || raster[0].h !== 32 || raster[0].frames.length !== 1) throw new Error('Saved canvas raster is not exactly one 32x32 asset with one frame.');
  const data = composite(raster[0], raster[0].frames[0].id).data;
  for (let i = 0; i < data.length; i++) if (data[i] !== (i === 528 ? 0x70c989ff : 0)) throw new Error('Saved canvas pixel mismatch at index ' + i);
  // Summary only: transport/model/counters, never proposal content.
  console.log(JSON.stringify({ provider, status: 'passed', exactPixels: true, transport: job.transport, ...(job.model ? { model: job.model } : {}), calls: job.cliExecutions, ...(job.usage ? { usage: job.usage } : {}), revision: saved.revision, historyEntries: store.history(p.id).length, assets: job.build.assets.length }));
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  await ai.close();
  if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error('Refusing cleanup outside temporary directory');
  rmSync(root, { recursive: true, force: true });
}
