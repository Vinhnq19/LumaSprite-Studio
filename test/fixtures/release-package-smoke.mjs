import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, expect } from '@playwright/test';
import { decodeTestPng, unzipTestStored } from './image-assertions.ts';

const archive = resolve(process.argv[2]), oldProjects = resolve(process.argv[3]), evidence = resolve(process.argv[4]);
const temp = mkdtempSync(join(tmpdir(), 'LumaSprite thử gói '));
const children = new Set();
const screenshots = [];
const digest = data => createHash('sha256').update(data).digest('hex');
mkdirSync(evidence, { recursive: true });
let browser;
async function launch(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  child.once('close', () => children.delete(child));
  const output = createInterface({ input: child.stdout });
  let timer;
  try {
    const line = await Promise.race([
      once(output, 'line').then(([line]) => line),
      once(child, 'exit').then(([code]) => { throw Error(`Entrypoint stopped before listening (${code})`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Entrypoint did not start in 15s')), 15_000); }),
    ]);
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(line);
    assert.ok(match, line);
    return new URL(match[0]);
  } finally { clearTimeout(timer); output.close(); child.stdout.resume(); }
}
try {
  const extracted = spawnSync('tar.exe', ['-xf', archive], { cwd: temp, windowsHide: true, encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const moduleRoot = join(temp, 'node_modules', 'pxl-pixelart'), bin = join(moduleRoot, 'bin', 'pxl.js');
  const packageFile = JSON.parse(readFileSync(join(moduleRoot, 'package.json'), 'utf8'));
  const cli = spawnSync(process.execPath, [bin, 'list', join(moduleRoot, 'examples', 'basics.px.js')], { cwd: temp, encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /slime/);
  const projectRoot = join(temp, 'Dự án cũ và mới');
  cpSync(oldProjects, projectRoot, { recursive: true });
  const env = { ...process.env, PXL_AGENT_WRITE_TOKEN: '', PXL_DEEPSEEK_API_KEY: '', PXL_CODEX_CLI: join(temp, 'no-codex.exe') };
  const engine = await launch(join(moduleRoot, 'scripts', 'mock-external-engine.mjs'), ['--port', '0'], env);
  const studioEnv = { ...env, PXL_EXTERNAL_ENGINE_PORT: engine.port };
  const studio = await launch(bin, ['studio', '--root', projectRoot, '--port', '0'], studioEnv);
  const studioProcess = [...children].at(-1);
  const runAgent = (...args) => spawnSync(process.execPath, [bin, 'agent', ...args, '--port', studio.port], { cwd: temp, env, encoding: 'utf8', windowsHide: true });
  const discovery = runAgent('capabilities');
  assert.equal(discovery.status, 0, discovery.stderr);
  const capabilities = JSON.parse(discovery.stdout);
  assert.equal(capabilities.version, 1); assert.equal(capabilities.data.writeEnabled, false);
  const engineInfo = spawnSync(process.execPath, [bin, 'agent', 'call', '--port', studio.port], {
    cwd: temp, env, windowsHide: true, encoding: 'utf8', input: JSON.stringify({ version: 1, operation: 'engine.capabilities', input: {} }),
  });
  assert.equal(engineInfo.status, 0, engineInfo.stderr);
  assert.match(JSON.parse(engineInfo.stdout).data.name, /Mock Engine/);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const response = await page.goto(studio.href);
  assert.ok(response?.ok());
  await expect(page.locator('#projects')).toContainText('Pixel S2 RC');
  await page.locator('#projects').selectOption({ label: 'Pixel S2 RC' });
  await expect(page.locator('#asset-info')).toContainText('Sprite');
  await expect(page.locator('#canvas')).toBeVisible();
  const savedOld = await page.locator('#projects').inputValue();
  const legacy = await page.goto(new URL('legacy.html', studio).href);
  assert.ok(legacy?.ok());
  assert.match(await page.locator('body').innerText(), /Studio/i);
  const oldProjectsResp = await page.request.get(new URL('api/studio/projects', studio).href);
  const oldV1 = (await oldProjectsResp.json()).find(project => project.name === 'Legacy v1 RC');
  assert.ok(oldV1);
  const legacyRead = await page.request.get(new URL(`api/studio/projects/${oldV1.id}`, studio).href);
  assert.equal((await legacyRead.json()).schemaVersion, 1);

  await page.goto(studio.href);
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill('Nét vẽ từ gói RC');
  await page.locator('#size-preset').selectOption('32');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#project-title')).toHaveText('Nét vẽ từ gói RC');
  await expect(page.locator('#projects')).not.toHaveValue(savedOld);
  await expect(page.locator('#canvas')).toBeVisible();
  await page.locator('#actual').click();
  await expect(page.locator('#canvas')).toHaveCSS('width', '32px');
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await expect(page.locator('#canvas')).toHaveCSS('width', '128px');
  await page.locator('#hex').fill('#ab224bff'); await page.locator('#hex').press('Tab');
  await page.locator('[data-command="layer.add"]').click();
  await page.locator('[data-tool="pen"]').click();
  await page.locator('#canvas').click({ position: { x: 22, y: 14 } });
  await expect(page.locator('#cursor')).toHaveText('5, 3');
  await page.locator('[data-command="frame.add"]').click();
  await page.locator('#canvas').click({ position: { x: 42, y: 54 } });
  await page.locator('#timeline thead button').first().click();
  await page.locator('header [data-command="file.save"]').click();
  await expect(page.locator('#save-status')).toContainText('Đã lưu');
  const projectId = await page.locator('#projects').inputValue();
  assert.notEqual(projectId, savedOld);
  const zipRequest = await page.request.get(new URL(`api/pixel/projects/${projectId}/backup`, studio).href);
  assert.ok(zipRequest.ok());
  const zip = await zipRequest.body(), files = unzipTestStored(zip);
  const restoreDir = join(temp, 'Bản sao lưu'); mkdirSync(restoreDir);
  for (const [name, blob] of Object.entries(files)) {
    const path = resolve(restoreDir, name); assert.ok(path.startsWith(restoreDir + '\\'));
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, blob);
  }
  const exported = async () => {
    const download = page.waitForEvent('download');
    await page.locator('[data-export="png"]').click();
    return readFileSync(await (await download).path());
  };
  const painted = await exported(), image = decodeTestPng(painted);
  if (image.data[3 * 32 + 5] !== 0xab224bff) {
    const occupied = Array.from(image.data.entries()).filter(([, ink]) => ink).slice(0, 20);
    console.error('Artist fixture', { occupied, target: await page.locator('#edit-target').textContent(), notice: await page.locator('#notice').textContent() });
    await page.screenshot({ path: join(evidence, 'package-artist-diagnostic.png') });
  }
  assert.deepEqual([image.w, image.h, image.data[3 * 32 + 5]], [32, 32, 0xab224bff]);
  const editor = join(evidence, 'package-artist-workflow.png');
  await page.screenshot({ path: editor }); screenshots.push(editor);
  await page.locator('#project-import').setInputFiles(restoreDir);
  await expect.poll(() => page.locator('#projects').inputValue()).not.toBe(projectId);
  assert.deepEqual(decodeTestPng(await exported()).data, image.data);
  const restored = await page.locator('#projects').inputValue();
  await page.reload();
  await expect(page.locator('#projects')).toHaveValue(restored);
  assert.deepEqual(decodeTestPng(await exported()).data, image.data);

  await page.locator('#ai-open').click();
  await page.locator('#generation-source').selectOption('external');
  await expect(page.locator('#external-engine-connection')).toContainText('Mock Engine');
  await page.locator('#external-engine-brief').fill('Fixture gói RC – đạo cụ');
  await page.locator('#external-engine-submit').click();
  const candidate = page.locator('#external-engine-canvas');
  await expect(candidate).toBeVisible();
  const preview = await candidate.evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const rgba = new DataView(bytes.buffer);
    return Array.from({ length: bytes.length / 4 }, (_, i) => rgba.getUint32(i * 4));
  });
  await expect(page.locator('#external-engine-apply')).toBeDisabled();
  await page.locator('#external-engine-approved').check();
  await page.locator('#external-engine-apply').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();
  assert.deepEqual(Array.from(decodeTestPng(await exported()).data), preview);
  const stopped = once(studioProcess, 'close'); studioProcess.kill(); await stopped;
  await launch(bin, ['studio', '--root', projectRoot, '--port', studio.port], studioEnv);
  await page.reload();
  await expect(page.locator('#projects')).toHaveValue(restored);
  assert.deepEqual(decodeTestPng(await exported()).data, image.data);
  const result = {
    status: 'PASS', archive: digest(readFileSync(archive)), packageVersion: packageFile.version,
    node: process.version, chrome: await browser.version(), launch: 'packaged bin/pxl.js studio',
    legacySchema: 1, legacyPixelSchema: 2, artist: { projectId, restored, png: digest(painted), backup: digest(zip), restartExactRgba: true },
    agent: 'capabilities v1', engine: 'independent mock discovery, preview, explicit approval and exact PNG', screenshots, inference: 0,
  };
  writeFileSync(join(evidence, 'package-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  for (const child of children) if (child.exitCode === null) {
    const ended = once(child, 'close');
    child.kill();
    await ended;
  }
  if (dirname(temp) === resolve(tmpdir())) rmSync(temp, { recursive: true, force: true });
}
