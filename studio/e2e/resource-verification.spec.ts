import { test, expect, type Page } from '@playwright/test';
import { wireParse, wireStringify } from '../../src/studio/pixel/model.ts';

async function document(page: Page): Promise<any> {
  const id = await page.locator('#projects').inputValue();
  return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`)).text());
}

test('Resource verification: native paint, reload and project copy preserve lazy masks and source pixels', async ({ page }) => {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill('Tài nguyên nhân vật');
  await page.locator('#size-preset').selectOption('18');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  const original = await document(page);
  const source = new Uint32Array([0xff0000ff, 0x00ff00ff, 0x0000ffff, 0]);
  original.studio = { version: 1, resources: {
    body: { version: 1, kind: 'mask', w: 2, h: 2, data: Uint32Array.from([0, 1, 1, 0]) },
    reference: { version: 1, kind: 'rgba', w: 2, h: 2, data: source },
  } };
  const saved = await page.request.put(`/api/pixel/projects/${original.id}`, { headers: { origin: 'http://127.0.0.1:4329', 'content-type': 'application/json' }, data: wireStringify({ revision: original.revision, document: original }) });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  const loaded = await document(page);
  expect(loaded.studio.resources.body.data).toBeUndefined();
  expect(loaded.studio.resources.reference.data).toBeUndefined();
  await page.locator('#hex').fill('#ff0000ff');
  await page.locator('#hex').press('Tab');
  await page.locator('#canvas').click({ position: { x: 3, y: 3 } });
  await expect.poll(async () => (await document(page)).revision).toBeGreaterThan(loaded.revision);
  const painted = await document(page);
  expect(painted.assets[0].w).toBe(18);
  expect(painted.assets[0].h).toBe(18);
  expect(painted.studio.resources).toEqual(loaded.studio.resources);
  const route = `/api/pixel/projects/${painted.id}/resource?revision=${painted.revision}&resource=reference`;
  const resource = await page.request.get(route);
  expect(resource.ok()).toBeTruthy();
  expect(Array.from(wireParse(await resource.text()).data)).toEqual(Array.from(source));
  const stale = await page.request.get(`/api/pixel/projects/${painted.id}/resource?revision=${loaded.revision}&resource=reference`);
  expect(stale.status()).toBe(409);
  const copied = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/pixel/projects'));
  await page.locator('#copy-project').click();
  const copy = wireParse(await (await copied).text());
  expect(copy.id).not.toBe(painted.id);
  await expect(page.locator('#projects')).toHaveValue(copy.id);
  expect(copy.studio.resources).toEqual(painted.studio.resources);
  const copiedResource = await page.request.get(`/api/pixel/projects/${copy.id}/resource?revision=${copy.revision}&resource=reference`);
  expect(copiedResource.ok()).toBeTruthy();
  expect(Array.from(wireParse(await copiedResource.text()).data)).toEqual(Array.from(source));
});

test('Resource verification: asset-version selector follows the selected apply mode', async ({ page }) => {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill('Chế độ áp dụng');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  await page.locator('#ai-open').click();
  await page.locator('#ai-prompt').fill('Một vật phẩm kiểm tra chế độ áp dụng');
  await page.locator('#ai-generate').click();
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#proposal-apply')).toBeEnabled();
  await expect(page.locator('#proposal-mode-new')).toBeChecked();
  await expect(page.locator('#proposal-version-target-row')).toBeHidden();
  await page.locator('#proposal-mode-version').check();
  await expect(page.locator('#proposal-version-target-row')).toBeVisible();
  await page.locator('#proposal-mode-new').check();
  await expect(page.locator('#proposal-version-target-row')).toBeHidden();
});
