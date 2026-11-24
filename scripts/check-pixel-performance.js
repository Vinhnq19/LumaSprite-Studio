import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serveStudio } from '../dist/node/studio/server.js';
import { newDocument, newLayer, uid, celFor, wireStringify } from '../dist/studio/pixel/model.js';
const root = mkdtempSync(join(tmpdir(), 'pxl-pixel-performance-'));
const app = await serveStudio(root, { port: 0 });
let browser;
try {
  const document = newDocument('Đo hiệu năng', 64, 64), a = document.assets[0];
  a.layers = Array.from({ length: 8 }, (_, i) => newLayer(`Layer ${i + 1}`));
  a.frames = Array.from({ length: 24 }, () => ({ id: uid(), duration: 100 }));
  for (let l = 0; l < 8; l++) for (let f = 0; f < 24; f++) { const data = celFor(a, a.layers[l].id, a.frames[f].id, true).data; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((x + y + f + l) % 13 === 0) data[y * 64 + x] = ((50 + l * 20) << 24 | (80 + f * 4) << 16 | 100 << 8 | 255) >>> 0; }
  const response = await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers: { origin: app.url.slice(0, -1), 'content-type': 'application/json' }, body: wireStringify({ name: document.name, document }) });
  if (!response.ok) throw new Error(await response.text()); const project = await response.json();
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.PXL_PERF_HEADLESS === '1', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  await page.addInitScript(() => {
    const state = window.pixelPerfFocus = { active: false, samples: [], violations: [] };
    for (const type of ['pointerdown', 'pointermove']) document.addEventListener(type, event => {
      if (!state.active || event.target?.id !== 'canvas' || !(event.buttons & 1)) return;
      state.samples.push({ focused: document.hasFocus(), visibility: document.visibilityState });
    }, true);
    window.addEventListener('blur', () => { if (state.active) state.violations.push('window blur'); });
    document.addEventListener('visibilitychange', () => { if (state.active && document.visibilityState !== 'visible') state.violations.push(document.visibilityState); });
  });
  await page.goto(app.url); await page.bringToFront(); await page.locator('#projects').selectOption(project.id); console.log('PERF selected project');
  if (process.env.PXL_PERF_HEADLESS !== '1') { const cdp = await page.context().newCDPSession(page); const { windowId } = await cdp.send('Browser.getWindowForTarget'); await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); await cdp.send('Page.bringToFront'); }
  try { await page.locator('#canvas').waitFor({ state: 'visible', timeout: 60000 }); } catch (e) { console.log('OPEN DIAGNOSTIC', await page.locator('#notice').textContent(), await page.locator('#save-status').textContent(), await page.evaluate(() => ({ ...window.pxlDiagnostics(), canvas: document.querySelector('#canvas').outerHTML, inert: document.querySelector('.workspace').inert }))); throw e; }
  await page.bringToFront(); console.log('PERF opened');
  try { await page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('Đã mở'), undefined, { timeout: 15000 }); }
  catch (error) { console.log('READY DIAGNOSTIC', await page.locator('#save-status').textContent(), await page.locator('#notice').textContent(), await page.evaluate(() => window.pxlDiagnostics())); throw error; }
  console.log('PERF ready');
  const init = await page.evaluate(() => window.pxlDiagnostics());
  await page.waitForTimeout(500);
  const box = await page.locator('#canvas').boundingBox();
  await page.locator('#canvas').focus(); await page.evaluate(() => { window.pixelPerfFocus.active = true; });
  const drawStroke = async (row) => {
    const y = box.y + row * box.height / 12;
    await page.mouse.move(box.x + 8, y); await page.mouse.down();
    try {
      for (let i = 0; i < 40; i++) await page.mouse.move(box.x + 8 + (box.width - 20) * i / 40, y + Math.sin(i / 4) * 15);
    } finally { await page.mouse.up(); }
    await page.waitForFunction(() => !window.pxlDiagnostics().pendingFrame);
  };
  for (let row = 4; row < 10; row++) await drawStroke(row);
  console.log('PERF idle strokes sampled');
  await page.waitForTimeout(650); const diagnostic = await page.evaluate(() => window.pxlDiagnostics()), samples = diagnostic.samples.sort((a, b) => a - b);

  const origin = app.url.slice(0, -1), headers = { origin, 'content-type': 'application/json' };
  const buildSource = `sprite('stress', {w:512,h:512}, c => {
    const end = Date.now() + 3300;
    while (Date.now() < end) c.rect(0,0,512,512,'#354557');
  });`;
  // Same Studio render pool, separate temporary project so an edit can autosave during its build.
  const studioRequest = async (path, body) => {
    const response = await fetch(`${app.url}api/studio/${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : undefined);
    if (!response.ok) throw new Error(`Studio ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  const background = await studioRequest('projects', { name: 'Tải dựng nền', template: 'blank', files: { 'art.px.js': buildSource }, entry: 'art.px.js' });
  const job = await studioRequest(`projects/${background.id}/build`, { revision: background.revision });
  const overlap = [], pingMs = [];
  const getBuild = () => studioRequest(`builds/${job.id}`);
  let build = await getBuild();
  for (const row of [2, 3, 10]) {
    if (build.status !== 'running') break;
    const count = await page.evaluate(() => window.pxlDiagnostics().samples.length);
    await drawStroke(row);
    const started = performance.now();
    build = await getBuild();
    if (build.status !== 'running') break;
    pingMs.push(performance.now() - started);
    // Both ends of the stroke observed the same build in running state.
    overlap.push(...await page.evaluate(from => window.pxlDiagnostics().samples.slice(from), count));
  }
  const deadline = performance.now() + 30000;
  while (build.status === 'running' && performance.now() < deadline) { await delay(100); build = await getBuild(); }
  if (build.status !== 'ready' || build.result?.errors?.length) throw new Error(`Background build ${build.status}: ${build.error ?? build.result?.errors?.join('; ') ?? ''}`);
  console.log('PERF worker overlap sampled');
  overlap.sort((a, b) => a - b);
  await page.waitForTimeout(650);
  const beforeExport = performance.now(); const exported = await fetch(app.url + `api/pixel/projects/${project.id}/export`, { method: 'POST', headers: { origin: app.url.slice(0, -1), 'content-type': 'application/json' }, body: JSON.stringify({ revision: (await (await fetch(app.url + `api/pixel/projects/${project.id}`)).json()).revision, format: 'png', assetId: a.id }) }); if (!exported.ok) throw new Error(await exported.text()); await exported.arrayBuffer(); const exportMs = performance.now() - beforeExport;
  const headless = process.env.PXL_PERF_HEADLESS === '1', focus = await page.evaluate(() => window.pixelPerfFocus);
  const result = { chrome: await browser.version(), headless, visibility: diagnostic.visibility, focused: diagnostic.focused, foregroundConfirmed: !headless && diagnostic.visibility === 'visible' && diagnostic.focused && focus.samples.length > 0 && focus.samples.every(s => s.focused && s.visibility === 'visible') && !focus.violations.length, focusInputSamples: focus.samples.length, focusViolations: focus.violations, errors, canvas: '64x64', layers: 8, frames: 24, samples: samples.length, drawingP95Ms: samples[Math.floor(samples.length * .95)] ?? null, drawingMedianMs: samples[Math.floor(samples.length * .5)] ?? null, pngExportMs: exportMs, method: 'Pointer handler to completed Canvas draw in requestAnimationFrame; excludes physical display scanout.', initialFocus: init.focused };
  result.backgroundBuild = { status: build.status, summaryMs: build.result.ms, source: 'bounded native 512×512 rectangle workload',
    samples: overlap.length, drawingP95Ms: overlap[Math.floor(overlap.length * .95)] ?? null, statusRequestMsDuringBuild: pingMs };
  result.samplesMs = { idle: samples, workerOverlap: overlap };
  if (process.env.PXL_PERF_REPORT) writeFileSync(process.env.PXL_PERF_REPORT + '.strokes.json', JSON.stringify(result, null, 2));
  const operations = { zoomMs: [], panMs: [], layerSwitchMs: [], frameSwitchMs: [] };
  const observe = async (list, action) => { const start = performance.now(); await action(); list.push(performance.now() - start); };
  await page.locator('#actual').click();
  const scale = () => page.locator('#zoom-value').textContent();
  for (let i = 0; i < 6; i++) {
    const before = await scale();
    await observe(operations.zoomMs, async () => {
      await page.locator(i % 2 ? '#zoom-out' : '#zoom-in').click();
      await page.waitForFunction(previous => document.querySelector('#zoom-value').textContent !== previous, before);
    });
    await observe(operations.layerSwitchMs, async () => {
      await page.locator('#timeline tbody tr').nth(i % 2 ? 0 : 1).locator('button.cel').first().click();
      await page.waitForFunction(() => !document.querySelector('#canvas').hidden && !window.pxlDiagnostics().pendingFrame);
    });
    await observe(operations.frameSwitchMs, async () => {
      await page.locator('#timeline thead button').nth(i + 1).click();
      await page.waitForFunction(() => !document.querySelector('#canvas').hidden && !window.pxlDiagnostics().pendingFrame);
    });
  }
  console.log('PERF zoom, layer and frame switching sampled');
  const playbackStarted = performance.now();
  let playbackLoads = 0;
  const countCel = request => { if (new URL(request.url()).pathname.endsWith('/cel')) playbackLoads++; };
  page.on('request', countCel);
  try {
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play').textContent.includes('Dừng'), undefined, { timeout: 60000 });
  } catch (error) {
    console.error('PLAYBACK DIAGNOSTIC', { celRequests: playbackLoads, notice: await page.locator('#notice').textContent(),
      state: await page.evaluate(() => window.pxlDiagnostics()) });
    throw error;
  } finally { page.off('request', countCel); }
  const playbackStartupMs = performance.now() - playbackStarted;
  console.log('PERF playback running', { playbackStartupMs, playbackLoads });
  const playback = await page.evaluate(async () => {
    const t = document.querySelector('#edit-target'), changes = [], obs = new MutationObserver(() => {
      const label = t.textContent;
      if (changes.at(-1)?.label !== label) changes.push({ label, timeMs: performance.now() });
    });
    obs.observe(t, { childList: true });
    await new Promise(resolve => setTimeout(resolve, 1250));
    obs.disconnect();
    return changes;
  });
  await page.locator('#play').click();
  for (let i = 0; i < 5; i++) await page.locator('#zoom-in').click();
  const stage = await page.locator('#stage').boundingBox();
  for (let i = 0; i < 6; i++) {
    const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2, direction = i % 2 ? 1 : -1;
    await observe(operations.panMs, async () => {
      const before = await page.locator('#stage').evaluate(el => [el.scrollLeft, el.scrollTop]);
      await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' });
      await page.mouse.move(x + 32 * direction, y + 24 * direction); await page.mouse.up({ button: 'middle' });
      await page.waitForFunction(([x, y]) => {
        const el = document.querySelector('#stage');
        return el.scrollLeft !== x || el.scrollTop !== y;
      }, before);
    });
  }
  result.operations = { method: 'Automation wall time including UI wait, reported separately from drawing latency.', ...operations, playbackStartupMs, playbackLoads, playback };
  if (!samples.length || !overlap.length || playback.length < 2 || errors.length) process.exitCode = 1;
  if (process.env.PXL_STUDIO_SCREENSHOT) await page.screenshot({ path: process.env.PXL_STUDIO_SCREENSHOT, fullPage: true });
  if (process.env.PXL_PERF_REPORT) writeFileSync(process.env.PXL_PERF_REPORT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); await app.close(); if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error('Unsafe temporary directory'); rmSync(root, { recursive: true, force: true });
}
