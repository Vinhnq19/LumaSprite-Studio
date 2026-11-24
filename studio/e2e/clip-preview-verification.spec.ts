// Parent future browser acceptance; activate after exact clip comparison exists.
import { test, expect, type Page } from '@playwright/test';
import { clipProcessingFixture } from '../../test/clip-processing-fixture.ts';
import { wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { lateTimer } from './playback-clock.ts';

const origin = 'http://127.0.0.1:4329';
async function seed(page: Page, prompt = 'Clip preview fixture', waitReady = true) {
  const f = clipProcessingFixture('whole');
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' },
    data: wireStringify({ name: 'Clip preview independent', document: f.document }) });
  expect(response.ok(), await response.text()).toBeTruthy();
  const document = wireParse(await response.text());
  const start = await page.request.post(`/api/pixel/projects/${document.id}/generation-batches`, { headers: { origin },
    data: { revision: document.revision, provider: 'codex', prompt,
      generationOptions: { paletteMode: 'asset' }, clipGeneration: { clipId: f.clip.id } } });
  expect(start.status(), await start.text()).toBe(202); const batch = await start.json();
  await expect.poll(async () => {
    const current = await (await page.request.get(`/api/pixel/projects/${document.id}/generation-batches/${batch.id}`)).json();
    return waitReady ? current.status : current.candidates[0].status === 'ready' && current.candidates[1].status === 'running';
  }, { timeout: 25000 }).toBe(waitReady ? 'ready' : true);
  await page.goto('/');
  await expect(page.locator(`#projects option[value="${document.id}"]`)).toHaveCount(1);
  await page.locator('#projects').selectOption(document.id);
  await expect(page.locator('#canvas')).toBeVisible();
  await page.locator('#ai-open').click();
  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toHaveText('Sẵn sàng');
  await page.locator('.candidate-card[data-index="0"]').click();
  await expect(page.locator('#proposal')).toBeVisible();
  return { f, document, batch };
}
const bytes = (data: Uint32Array) => Array.from(data).flatMap(c => [c >>> 24, c >>> 16 & 255, c >>> 8 & 255, c & 255]);
async function raster(page: Page, id: string) {
  return page.locator(id).evaluate((canvas: HTMLCanvasElement) => ({ w: canvas.width, h: canvas.height,
    pixels: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data) }));
}

test('Clip comparison: retained slot has no raw counterpart; selected slot3 maps rawK0 and correct baseline', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const { f } = await seed(page);
  await expect(page.locator('#proposal-compare option[value="raw"]')).toHaveJSProperty('disabled', true);
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[0]) });
  await page.locator('#proposal-frame').selectOption('2');
  await expect(page.locator('#proposal-compare option[value="raw"]')).toHaveJSProperty('disabled', false);
  await page.locator('#proposal-compare').selectOption('raw');
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[2]) });
  await expect(page.locator('#proposal-before-label')).toContainText(/3/);
  await page.locator('#proposal-compare').selectOption('reference');
  await page.locator('#proposal-frame').selectOption('3');
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[3]) });
  await page.locator('#proposal-frame').selectOption('2');
  await page.locator('#proposal-compare').selectOption('raw');
  await page.locator('#proposal-play').click();
  await expect(page.locator('#proposal-compare')).toHaveValue('reference');
  await expect(page.locator('#proposal-play')).toHaveText('▶ Phát preview');
  await expect(page.locator('#proposal-compare option[value="raw"]')).toHaveJSProperty('disabled', true);
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[3]) });
  const options = await page.locator('#proposal-variant option').evaluateAll(elements => elements.map(o => ({
    id: (o as HTMLOptionElement).value, text: o.textContent ?? '',
  })));
  const raw = options.find(o => /AI gốc/.test(o.text))!;
  await page.locator('#proposal-variant').selectOption(raw.id);
  await expect(page.locator('#proposal-apply')).toBeDisabled();
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[2]) });
  await expect(page.locator('#proposal-after-label')).toContainText(/3/);
  await expect(page.locator('#ai-generate')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('Clip workspace retains running cancellation gate and allows explicit fresh sprite only after stop', async ({ page }) => {
  const { document, batch } = await seed(page, 'Clip fixture FIXTURE_HANG_2', false);
  try {
    await expect(page.locator('#mode-new-sprite')).toBeDisabled();
    await expect(page.locator('#ai-cancel')).toBeEnabled();
    await page.locator('#ai-cancel').click();
    await expect(page.locator('#ai-cancel')).toBeDisabled();
    await expect(page.locator('#mode-new-sprite')).toBeEnabled();
    await page.locator('#mode-new-sprite').click();
    await expect(page.locator('#proposal')).toBeHidden();
    await expect(page.locator('#ai-generate')).toBeEnabled();
  } finally {
    await page.request.post(`/api/pixel/projects/${document.id}/generation-batches/${batch.id}/cancel`, {
      headers: { origin }, data: { revision: document.revision },
    });
  }
});

for (const failed of [false, true]) test(`Clip workspace ignores an old held ${failed ? 'failed' : 'successful'} selection after explicit fresh sprite mode`, async ({ page }) => {
  const { batch } = await seed(page);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => seen = r);
  const pattern = `**/candidates/${batch.candidates[1].id}/preview`;
  await page.route(pattern, async route => {
    seen(); await gate;
    if (failed) await route.fulfill({ status: 409, json: { error: 'Obsolete held preview' } });
    else await route.continue();
  });
  const oldReply = page.waitForResponse(r => r.url().includes(`/candidates/${batch.candidates[1].id}/preview`));
  try {
    await page.locator('.candidate-card[data-index="1"]').click(); await started;
    await page.locator('#mode-new-sprite').click();
    await expect(page.locator('#proposal')).toBeHidden();
    await expect(page.locator('#ai-generate')).toBeEnabled();
    release(); await (await oldReply).finished();
    await expect(page.locator('#proposal')).toBeHidden();
    await expect(page.locator('#ai-generate')).toBeEnabled();
    await expect(page.locator('#ai-modal-error')).toBeHidden();
  } finally { release(); await page.unroute(pattern); }
});

test('Clip preview playback uses absolute clock boundaries and holds the last frame', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const { f } = await seed(page);
  // Default selection is the recomposed candidate; #before shows the baseline frame.
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[0]) });
  // Warm the frame cache through the real control so playback starts from rendered frames.
  for (const i of [0, 1, 2, 3]) {
    await page.locator('#proposal-frame').selectOption(String(i));
    await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[i]) });
    await expect.poll(() => raster(page, '#after')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[i]) });
  }
  await page.locator('#proposal-frame').selectOption('0');
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[0]) });
  // Install the fake clock only after fixtures and cache warm-up have completed.
  await page.clock.install();
  const paused = await page.evaluate(() => Date.now() + 1000);
  await page.clock.pauseAt(paused);
  await page.locator('#proposal-play').click();
  await expect(page.locator('#proposal-play')).toHaveText('■ Dừng preview');
  // Initial frame0 render comes from the warmed cache, not from an arbitrary timer.
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[0]) });
  await expect.poll(() => raster(page, '#after')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[0]) });
  await lateTimer(page, 250);
  // Durations 80/140/200/100 (non-loop): 330ms elapsed maps to frame2 from absolute boundaries,
  // while stepping one frame per callback would land on frame1.
  await expect(page.locator('#proposal-frame')).toHaveValue('2');
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[2]) });
  await expect.poll(() => raster(page, '#after')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[2]) });
  await expect(page.locator('#proposal-play')).toHaveText('■ Dừng preview');
  await page.clock.runFor(1000);
  await expect(page.locator('#proposal-play')).toHaveText('▶ Phát preview');
  await expect(page.locator('#proposal-frame')).toHaveValue('3');
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[3]) });
  await expect.poll(() => raster(page, '#after')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[3]) });
  // Non-loop playback keeps the final frame held after the timeline is exhausted.
  await page.clock.runFor(1000);
  await expect(page.locator('#proposal-play')).toHaveText('▶ Phát preview');
  await expect(page.locator('#proposal-frame')).toHaveValue('3');
  await expect.poll(() => raster(page, '#before')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[3]) });
  await expect.poll(() => raster(page, '#after')).toEqual({ w: 4, h: 3, pixels: bytes(f.images[3]) });
  expect(errors).toEqual([]);
});
