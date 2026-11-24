// Explicit foreground repository benchmark. No AI and no user project writes.
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serveStudio } from '../dist/node/studio/server.js';
import { newDocument, celFor, wireStringify } from '../dist/studio/pixel/model.js';
import { assembleTerrain } from '../dist/studio/terrain.js';
import { registerTileset, createMap, MapStroke, getMap } from '../dist/studio/map-commands.js';

const root = mkdtempSync(join(tmpdir(), 'pxl-map-performance-'));
let app, browser;
const headless = process.env.PXL_PERF_HEADLESS === '1';
const percentile = (data, q) => { const sorted = [...data].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null; };
try {
  const doc = newDocument('Đo bản đồ 128×64', 256, 192), asset = doc.assets[0];
  const material = Uint32Array.from({ length: 1024 }, (_, i) => i % 17 === 0 ? 0x77bb55ff : 0x338844ff);
  const atlas = assembleTerrain(material, { tileSize: 32, inset: 2, sampling: 'mirror' });
  celFor(asset, asset.layers[0].id, asset.frames[0].id, true).data = atlas.data;
  registerTileset(doc, asset.id, asset.frames[0].id, 32, 'Cỏ', 'ground');
  createMap(doc, 'ground', 'Đo bản đồ', 128, 64, 'benchmark');
  const stroke = new MapStroke(doc, 'benchmark', getMap(doc, 'benchmark').layers[0].id);
  stroke.fill(0, 0, 1, true); for (let y = 4; y < 64; y += 12) for (let x = 4; x < 128; x += 16) stroke.set(x, y, 0, true); stroke.commit();
  app = await serveStudio(join(root, 'projects'), { port: 0 });
  const origin = app.url.slice(0, -1), headers = { origin, 'content-type': 'application/json' };
  const response = await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers, body: wireStringify({ name: doc.name, document: doc }) });
  if (!response.ok) throw new Error(await response.text()); const saved = await response.json();
  browser = await chromium.launch({ channel: 'chrome', headless, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => {
    const state = window.mapPerf = { samples: [], focus: [], gaps: [], phase: 'setup', pending: 0, last: 0 };
    for (const type of ['pointerdown', 'pointermove']) document.addEventListener(type, e => { if (e.target?.id === 'map-canvas' && (e.buttons & 1) && !state.pending) state.pending = performance.now(); }, true);
    new MutationObserver(records => {
      if (state.pending && records.some(r => r.target.id === 'map-canvas' && r.attributeName === 'data-paint-sequence')) {
        const now = performance.now();
        state.samples.push({ ms: now - state.pending, completedAt: performance.timeOrigin + now, phase: state.phase, kind: records.find(r => r.target.id === 'map-canvas').target.dataset.paintKind ?? 'full' }); state.focus.push({ focused: document.hasFocus(), visibility: document.visibilityState }); state.pending = 0;
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-paint-sequence'] });
    const frame = now => { if (state.last && state.phase !== 'setup') state.gaps.push({ ms: now - state.last, phase: state.phase }); state.last = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.url); await page.bringToFront(); await page.locator('#projects').selectOption(saved.id);
  await page.locator('#map-editor-open').click(); await page.locator('#map-canvas[data-ready=true]').waitFor();
  const instrumented = await page.locator('#map-canvas').evaluate(c => c.dataset.paintSequence !== undefined);
  if (!instrumented) throw new Error('Build lacks map paint-sequence measurement marker; rebuild verified source before measuring.');
  await page.bringToFront(); await page.locator('#map-canvas').focus();
  const initial = await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
  const box = await page.locator('#map-canvas').boundingBox(); await page.evaluate(() => { window.mapPerf.phase = 'drawing'; });
  for (let row = 0; row < 6; row++) {
    await page.mouse.move(box.x + 20, box.y + 30 + row * 45); await page.mouse.down();
    for (let step = 0; step < 40; step++) await page.mouse.move(box.x + 20 + (box.width - 45) * step / 40, box.y + 30 + row * 45 + Math.sin(step / 5) * 10);
    await page.mouse.up();
  }
  await page.evaluate(() => { window.mapPerf.phase = 'save'; });
  const saveResponse = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/pixel/projects/${saved.id}`));
  const saveStarted = performance.now(); await page.locator('#map-save').click(); const savedResponse = await saveResponse;
  if (!savedResponse.ok()) throw new Error(await savedResponse.text()); const savedAfter = await savedResponse.json(), saveMs = performance.now() - saveStarted;
  await page.locator('#map-canvas').focus(); await page.evaluate(() => { window.mapPerf.phase = 'export'; });
  const exportStarted = performance.now();
  const exportTask = fetch(app.url + `api/pixel/projects/${saved.id}/terrain/map-export`, { method: 'POST', headers, body: JSON.stringify({ revision: savedAfter.revision, mapId: 'benchmark', format: 'png' }) }).then(async response => {
    const data = await response.arrayBuffer();
    return { status: response.status, finished: performance.now(), bytes: data.byteLength };
  });
  const ping = async () => {
    const started = performance.now();
    const response = await fetch(app.url + 'api/pixel/projects');
    if (!response.ok) throw new Error(`Server health check returned HTTP ${response.status}`);
    await response.arrayBuffer();
    const finished = performance.now();
    return { finished, ms: finished - started };
  };
  const firstPing = ping();
  const drawDuringExport = async () => {
    const pings = [];
    await page.mouse.move(box.x + 20, box.y + 350); await page.mouse.down();
    try {
      for (let step = 0; step < 30; step++) {
        await page.mouse.move(box.x + 20 + step * (box.width - 45) / 30, box.y + 350);
        if (step % 10 === 0) pings.push(await ping());
      }
      return pings;
    } finally { await page.mouse.up(); }
  };
  const [exported, initialPing, laterPings] = await Promise.all([exportTask, firstPing, drawDuringExport()]);
  const pings = [initialPing, ...laterPings];
  const state = await page.evaluate(() => ({ ...window.mapPerf, focused: document.hasFocus(), visibility: document.visibilityState }));
  const samples = state.samples.filter(s => ['drawing', 'export'].includes(s.phase)).map(s => s.ms);
  const changed = state.samples.filter(s => ['drawing', 'export'].includes(s.phase) && !['unchanged', 'outside'].includes(s.kind)).map(s => s.ms);
  const exportOverlap = state.samples.filter(s => s.phase === 'export' && s.completedAt - s.ms >= performance.timeOrigin + exportStarted
    && s.completedAt <= performance.timeOrigin + exported.finished).map(s => s.ms);
  const confirmed = !headless && initial.focused && initial.visibility === 'visible' && state.focus.length > 0 && state.focus.every(s => s.focused && s.visibility === 'visible') && state.focused;
  const result = { chrome: await browser.version(), headless, foregroundConfirmed: confirmed, visibility: state.visibility, focused: state.focused, map: '128x64', tileSize: 32, samples: samples.length,
    drawingP95Ms: percentile(samples, .95), drawingMedianMs: percentile(samples, .5), targetMs: 16.7,
    changedSamples: changed.length, changedDrawingP95Ms: percentile(changed, .95), paintKinds: Object.fromEntries(['full', 'partial', 'unchanged', 'outside'].map(kind => [kind, state.samples.filter(s => s.kind === kind).length])),
    pngExportMs: exported.finished - exportStarted, pngExportStatus: exported.status, pngExportBytes: exported.bytes,
    exportOverlapDrawingSamples: exportOverlap.length, exportOverlapDrawingP95Ms: percentile(exportOverlap, .95),
    serverPingDuringExportMs: pings.filter(p => p.finished <= exported.finished).map(p => p.ms),
    serverPingAfterExportMs: pings.filter(p => p.finished > exported.finished).map(p => p.ms), manualSaveMs: saveMs,
    saveRafGapP95Ms: percentile(state.gaps.filter(s => s.phase === 'save').map(s => s.ms), .95), errors,
    method: 'Capture pointer input to completed shared RGBA viewport render marker; includes observer scheduling, excludes physical display scanout. Frame-gap sample counts are reported separately.',
    saveGapSamples: state.gaps.filter(s => s.phase === 'save').length,
    rawSamples: state.samples, rawFrameGaps: state.gaps };
  if (process.env.PXL_PERF_REPORT) writeFileSync(process.env.PXL_PERF_REPORT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!samples.length || errors.length || exported.status !== 200) process.exitCode = 1;
} finally {
  await browser?.close(); await app?.close();
  if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'pxl-map-performance-'))) throw new Error('Unsafe map benchmark cleanup');
  rmSync(root, { recursive: true, force: true });
}
