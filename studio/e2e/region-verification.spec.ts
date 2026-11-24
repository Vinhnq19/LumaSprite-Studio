// Independent UI acceptance: actual held requests and the selected raster.
import { test, expect, type Page } from '@playwright/test';
import { newDocument, celFor, duplicateFrame, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';

const origin = 'http://127.0.0.1:4329';
async function seed(page: Page, name: string, drawn = false) {
  const document = newDocument(name, 18, 18), a = document.assets[0];
  a.palette = [0x70c989ff, 0xffffffff];
  if (drawn) {
    const frameId = duplicateFrame(a, a.frames[0].id, 'blank');
    a.frames[1].duration = 137;
    a.metadata = { pivot: { x: .23, y: .91 }, hitbox: { x: 1, y: 2, w: 10, h: 12 }, events: [{ frame: 1, name: 'edit' }] };
    const data = celFor(a, a.layers[0].id, frameId, true)!.data!;
    data[0] = 0x70c989ff;
    for (const i of [9 * 18 + 9, 9 * 18 + 10, 10 * 18 + 9]) data[i] = 0xffffffff;
  }
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ name, document }) });
  expect(response.ok()).toBeTruthy();
  return wireParse(await response.text());
}
async function open(page: Page, id: string) {
  await expect(page.locator(`#projects option[value="${id}"]`)).toHaveCount(1);
  await page.locator('#projects').selectOption(id);
  await expect(page.locator('#canvas')).toBeVisible();
}
async function selectL(page: Page, document: any) {
  const frameId = document.assets[0].frames[1].id;
  await page.locator(`#timeline button.cel[data-frame="${frameId}"]`).click();
  await expect(page.locator('#duration')).toHaveValue('137');
  await expect.poll(() => page.locator('#canvas').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(Math.floor(c.width * 9.5 / 18), Math.floor(c.height * 9.5 / 18), 1, 1).data))).toEqual([255, 255, 255, 255]);
  await page.locator('[data-tool="wand"]').click();
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + 9.5 * box.width / 18, box.y + 9.5 * box.height / 18);
}
async function region(page: Page) {
  await page.locator('#ai-open').click();
  await page.locator('#ai-region-edit').click();
  await expect(page.locator('#region-status')).toContainText('3 pixel');
  await expect(page.locator('#region-source')).toContainText('137 ms');
}
async function ready(page: Page) {
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#proposal-apply')).toBeEnabled();
}
async function doc(page: Page, id: string) { return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`, { maxRetries: 2 })).text()); }

test('Region verification: sparse real wand mask and normalized PNG exactly match selected proposal; source/calls stay exact', async ({ page }) => {
  const original = await seed(page, 'Independent sparse region', true);
  await page.goto('/'); await open(page, original.id); await selectL(page, original); await region(page);
  const posted = page.waitForRequest(r => r.method() === 'POST' && /\/generation-batches$/.test(r.url()));
  await page.locator('#region-prompt').fill('Change white emblem only');
  await page.locator('#region-submit').click();
  const body = (await posted).postDataJSON(), expectedMask = Array.from({ length: 324 }, (_, i) => +[9 * 18 + 9, 9 * 18 + 10, 10 * 18 + 9].includes(i));
  expect(body.regionEdit.mask).toEqual(expectedMask); expect(body.regionEdit.frameId).toBe(original.assets[0].frames[1].id);
  await expect(page.locator('#region-dialog')).toBeHidden(); await ready(page);
  await page.locator('.candidate-card[data-index="1"]').click();
  await expect(page.locator('#proposal-description')).toContainText('alt=2');
  await page.locator('#proposal-normalize').click();
  await expect(page.locator('#proposal-after-label')).toContainText(/chuẩn hóa/i);
  const expected = await page.locator('#after').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data));
  expect(expected.length).toBe(18 * 18 * 4);
  const batches = await (await page.request.get(`/api/pixel/projects/${original.id}/generation-batches`)).json();
  expect(batches).toHaveLength(1); expect(batches[0].candidates.reduce((n: number, c: any) => n + c.cliExecutions, 0)).toBe(3);
  await page.locator('#proposal-mode-version').check();
  await page.locator('#proposal-asset-kind').selectOption('character');
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();
  const saved = await doc(page, original.id), source = saved.assets[0];
  expect(source.frames).toEqual(original.assets[0].frames); expect(source.metadata).toEqual(original.assets[0].metadata);
  const cel = Object.values(source.cels)[0] as any;
  const sourcePixels = wireParse(await (await page.request.get(`/api/pixel/projects/${saved.id}/cel?revision=${saved.revision}&asset=${source.id}&cel=${cel.id}`)).text()).data;
  const sourceExpected = new Uint32Array(324); sourceExpected[0] = 0x70c989ff;
  for (const i of [9 * 18 + 9, 9 * 18 + 10, 10 * 18 + 9]) sourceExpected[i] = 0xffffffff;
  expect(Array.from(sourcePixels)).toEqual(Array.from(sourceExpected));
  const downloadEvent = page.waitForEvent('download'); await page.locator('[data-export="png"]').first().click();
  const stream = await (await downloadEvent).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const actual = await page.evaluate(async (data: number[]) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const c = canvas.getContext('2d')!; c.drawImage(image, 0, 0); const rgba = Array.from(c.getImageData(0, 0, image.width, image.height).data); image.close(); return { w: canvas.width, h: canvas.height, rgba };
  }, Array.from(Buffer.concat(chunks)));
  expect(actual).toEqual({ w: 18, h: 18, rgba: expected });
});

test('Region verification: held POST locks duplicate/Escape, reports failure and retries without extra generation', async ({ page }) => {
  const original = await seed(page, 'Independent held region', true);
  await page.goto('/'); await open(page, original.id); await selectL(page, original); await region(page);
  let release!: () => void, seen!: () => void, intercepted = false;
  const held = new Promise<void>(r => release = r), started = new Promise<void>(r => seen = r);
  await page.route('**/generation-batches', async route => {
    if (route.request().method() !== 'POST' || intercepted) return route.continue();
    intercepted = true; seen(); await held; await route.fulfill({ status: 400, json: { error: 'Fixture held request failure' } });
  });
  try {
  await page.locator('#region-submit').click(); await started;
  await expect(page.locator('#region-submit')).toBeDisabled(); await expect(page.locator('#region-close')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#region-dialog')).toBeVisible();
  const duplicate = page.waitForRequest(r => r.method() === 'POST' && /\/generation-batches$/.test(r.url()), { timeout: 300 }).then(() => true, () => false);
  await page.locator('#region-form').evaluate((form: HTMLFormElement) => form.requestSubmit()); expect(await duplicate).toBe(false);
  release(); await expect(page.locator('#region-error')).toContainText('Fixture held request failure');
  await expect(page.locator('#region-submit')).toBeEnabled(); await expect(page.locator('#region-close')).toBeEnabled();
  await page.locator('#region-submit').click(); await expect(page.locator('#region-dialog')).toBeHidden(); await ready(page);
  const batches = await (await page.request.get(`/api/pixel/projects/${original.id}/generation-batches`)).json();
  expect(batches).toHaveLength(1); expect(batches[0].candidates.reduce((n: number, c: any) => n + c.cliExecutions, 0)).toBe(3);
  } finally { release(); }
});

test('Region verification: old project start response cannot unlock or show errors in a newer pending project', async ({ page }) => {
  const a = await seed(page, 'Independent request A'), b = await seed(page, 'Independent request B');
  await page.goto('/'); await open(page, a.id);
  let releaseA!: () => void, releaseB!: () => void, seenA!: () => void, seenB!: () => void;
  const heldA = new Promise<void>(r => releaseA = r), heldB = new Promise<void>(r => releaseB = r);
  const requestA = new Promise<void>(r => seenA = r), requestB = new Promise<void>(r => seenB = r);
  await page.route('**/generation-batches', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    if (route.request().url().includes(a.id)) { seenA(); await heldA; await route.fulfill({ status: 400, json: { error: 'Old project A error must stay hidden' } }); }
    else { seenB(); await heldB; await route.continue(); }
  });
  try {
  await page.locator('#ai-open').click(); await page.locator('#ai-prompt').fill('Proposal for A');
  await page.locator('#ai-generate').click(); await requestA;
  await page.locator('#ai-close').click(); await open(page, b.id);
  await page.locator('#ai-open').click(); await page.locator('#ai-prompt').fill('Proposal for B');
  await page.locator('#ai-generate').click(); await requestB;
  const oldResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(a.id) && /\/generation-batches$/.test(r.url()));
  releaseA(); await (await oldResponse).finished();
  // Wait for the old request's response and handler/finally, while B is still held.
  await expect(page.locator('#ai-modal-error')).not.toContainText('Old project A');
  await expect(page.locator('#ai-generate')).toBeDisabled(); await expect(page.locator('#ai-region-edit')).toBeDisabled();
  await expect(page.locator('#ai-modal-error')).not.toContainText('Old project A');
  releaseB(); await ready(page);
  await expect(page.locator('#ai-modal-error')).not.toContainText('Old project A');
  const empty = await (await page.request.get(`/api/pixel/projects/${a.id}/generation-batches`)).json(); expect(empty).toEqual([]);
  } finally { releaseA(); releaseB(); }
});

test('Region verification: delayed previous candidate frame cannot overwrite the selected candidate or report a stale error', async ({ page }) => {
  const original = await seed(page, 'Independent delayed candidate', true);
  let firstProtected: string | undefined, heldFrame = false, release!: () => void, seen!: () => void;
  const held = new Promise<void>(r => release = r), waiting = new Promise<void>(r => seen = r);
  await page.route('**/candidates/*/preview', async route => {
    const response = await route.fetch(), p = await response.json();
    firstProtected ??= p.variants?.find((v: any) => v.kind === 'protected')?.id;
    await route.fulfill({ response });
  });
  await page.route('**/variants/*/frame*', async route => {
    const response = await route.fetch();
    if (!heldFrame && firstProtected && route.request().url().includes(`/variants/${firstProtected}/`)) {
      heldFrame = true; seen(); await held;
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto('/'); await open(page, original.id); await selectL(page, original); await region(page);
    await page.locator('#region-submit').click(); await waiting;
    await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
    await page.locator('.candidate-card[data-index="2"]').click();
    await expect(page.locator('#proposal-description')).toContainText('alt=3');
    const oldResponse = page.waitForResponse(r => r.url().includes(`/variants/${firstProtected}/`) && r.url().includes('/frame?'));
    release(); await (await oldResponse).finished();
    await expect(page.locator('#proposal-description')).toContainText('alt=3');
    await expect(page.locator('#ai-modal-error')).toBeHidden(); await expect(page.locator('#proposal-apply')).toBeEnabled();
  } finally { release(); }
});

test('Region verification: 1000px layout keeps preview, new-version controls and apply reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 740 });
  const original = await seed(page, 'Independent narrow layout', true);
  await page.goto('/'); await open(page, original.id); await selectL(page, original); await region(page);
  const rect = await page.locator('#region-dialog').boundingBox();
  expect(rect).toBeTruthy(); expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(1000);
  await page.locator('#region-submit').click(); await ready(page);
  await page.locator('#proposal-mode-version').check();
  await page.locator('#proposal-asset-name').fill('Vùng chọn · phiên bản mới');
  await expect(page.locator('#proposal-version-target')).toHaveValue(original.assets[0].id);
  await page.locator('#proposal-apply').click(); await expect(page.locator('#generation-workspace')).toBeHidden();
  const saved = await doc(page, original.id); expect(saved.assets[1].name).toBe('Vùng chọn · phiên bản mới');
});
