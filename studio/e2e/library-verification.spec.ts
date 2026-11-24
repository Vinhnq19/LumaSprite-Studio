import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { wireParse } from '../../src/studio/pixel/model.ts';

async function readDoc(page: Page): Promise<any> {
  const id = await page.locator('#projects').inputValue();
  return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`)).text());
}
async function create(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption('32');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
}
async function generate(page: Page): Promise<void> {
  await page.locator('#ai-open').click();
  await page.locator('#provider').selectOption('codex');
  await page.locator('#ai-prompt').fill('Một nhân vật mới để kiểm tra phiên bản');
  await page.locator('#ai-generate').click();
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#proposal-apply')).toBeEnabled();
}
async function cel(page: Page, doc: any, asset = doc.assets[0]): Promise<number[]> {
  const id = asset.layers[0].cels[asset.frames[0].id];
  const r = await page.request.get(`/api/pixel/projects/${doc.id}/cel?revision=${doc.revision}&asset=${asset.id}&cel=${id}`);
  expect(r.ok()).toBeTruthy();
  return Array.from(wireParse(await r.text()).data);
}

test('Library verification: normalized nonfirst preview equals decoded PNG of a new version; manual source stays exact', async ({ page }) => {
  await create(page, 'So pixel phiên bản');
  await page.locator('#hex').fill('#ff0000ff');
  await page.locator('#hex').press('Tab');
  await page.locator('#canvas').click({ position: { x: 3, y: 3 } });
  await expect.poll(async () => {
    const d = await readDoc(page), a = d.assets[0];
    return a.layers[0].cels[a.frames[0].id] ? (await cel(page, d))[0] : 0;
  }).toBe(0xff0000ff);
  const original = await readDoc(page), originalPixels = await cel(page, original);
  await generate(page);
  await page.locator('.candidate-card[data-index="1"]').click();
  await expect(page.locator('#proposal-description')).toContainText('alt=2');
  await page.locator('#proposal-normalize').click();
  await expect(page.locator('#proposal-after-label')).toContainText(/chuẩn hóa/i);
  const expected = await page.locator('#after').evaluate((canvas: HTMLCanvasElement) => ({
    w: canvas.width, h: canvas.height,
    rgba: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data),
  }));
  const batches = await (await page.request.get(`/api/pixel/projects/${original.id}/generation-batches`)).json();
  expect(batches.at(-1).candidates.reduce((n: number, c: any) => n + c.cliExecutions, 0)).toBe(3);
  await page.locator('#proposal-mode-version').check();
  await page.locator('#proposal-version-target').selectOption(original.assets[0].id);
  await page.locator('#proposal-asset-kind').selectOption('character');
  await page.locator('#proposal-asset-name').fill('Bản chuẩn hóa');
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();
  const saved = await readDoc(page), added = saved.assets[1];
  expect(saved.studio.library[added.id].version).toBe(2);
  expect(saved.studio.library[added.id].groupId).toBe(saved.studio.library[original.assets[0].id].groupId);
  expect(added.provenance.kind).toBe('normalized');
  expect(await cel(page, saved, saved.assets[0])).toEqual(originalPixels);
  const downloading = page.waitForEvent('download');
  await page.locator('[data-export="png"]').click();
  const download = await downloading, path = await download.path();
  expect(path).toBeTruthy();
  const decoded = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
    return { w: canvas.width, h: canvas.height, rgba: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, Array.from(await readFile(path!)));
  expect(decoded).toEqual(expected);
});

test('Library verification: invalid target and failed apply recover; committed SSE cannot unlock a held apply response', async ({ page }) => {
  await create(page, 'Phục hồi áp dụng');
  const initial = await readDoc(page), source = initial.assets[0];
  const classified = await page.request.put(`/api/pixel/projects/${initial.id}`, {
    headers: { origin: 'http://127.0.0.1:4329' },
    data: { revision: initial.revision, document: { ...initial, studio: { version: 1, library: { [source.id]: { kind: 'character', groupId: 'test-character', version: 1 } } } } },
  });
  expect(classified.ok()).toBeTruthy();
  await page.reload(); await expect(page.locator('#canvas')).toBeVisible();
  let starts = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/generation-batches')) starts++; });
  await generate(page);
  await page.locator('#proposal-mode-version').check();
  await page.locator('#proposal-version-target').selectOption(source.id);
  await page.locator('#proposal-asset-name').fill('Bản nháp đang giữ');
  await expect(page.locator('#proposal-asset-kind')).toBeDisabled();
  await page.locator('#proposal-version-target').evaluate((select: HTMLSelectElement) => { select.value = ''; });
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#ai-modal-error')).toContainText('không tồn tại');
  await expect(page.locator('#ai-close')).toBeEnabled();
  await page.locator('#proposal-version-target').selectOption(source.id);
  await page.route('**/apply-proposal', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Lỗi áp dụng giả lập' }) }));
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#ai-modal-error')).toContainText('Lỗi áp dụng giả lập');
  await expect(page.locator('#proposal')).toBeVisible();
  await expect(page.locator('#proposal-asset-name')).toHaveValue('Bản nháp đang giữ');
  await expect(page.locator('#proposal-asset-kind')).toBeDisabled();
  await expect(page.locator('#proposal-apply')).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
  let release!: () => void, committed = false;
  const held = new Promise<void>(r => { release = r; });
  await page.route('**/apply-proposal', async route => {
    // Send to the server FIRST: pixel-saved and batch-applied SSE happen while
    // the UI is still awaiting this response, which is the actual race.
    const response = await route.fetch();
    committed = response.ok();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.locator('#proposal-apply').click();
    await expect.poll(() => committed).toBe(true);
    for (const id of ['ai-generate', 'ai-cancel', 'ai-close', 'proposal-apply']) await expect(page.locator(`#${id}`)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('#generation-workspace')).toBeVisible();
    await page.locator('#ai-generate').dispatchEvent('click');
    expect(starts).toBe(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(page.locator('#generation-workspace')).toBeHidden();
  const saved = await readDoc(page);
  expect(saved.assets).toHaveLength(2);
  expect(saved.studio.library[saved.assets[1].id].version).toBe(2);
  expect(saved.assets[1].name).toBe('Bản nháp đang giữ');
});
