import { test, expect, type Page } from '@playwright/test';
import { wireParse } from '../../src/studio/pixel/model.ts';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log('LIBRARY UI DIAGNOSTIC', await page.evaluate(() =>
      Object.fromEntries(['notice', 'save-status', 'ai-status', 'ai-modal-error', 'proposal-errors', 'proposal-description'].map(
        id => [id, window.document.getElementById(id)?.textContent]
      ))
    ));
  }
});

async function create(page: Page, name: string, size = 18): Promise<void> {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption(String(size));
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#asset-info')).toContainText(`${size} × ${size}`);
}

async function document(page: Page): Promise<any> {
  const id = await page.locator('#projects').inputValue();
  return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`, { maxRetries: 2 })).text());
}

async function color(page: Page, value: string) {
  await page.locator('#hex').fill(value);
  await page.locator('#hex').press('Tab');
}

async function paint(page: Page, x = 3, y = 3) {
  await page.locator('#canvas').click({ position: { x, y } });
}

test('Asset Library UI: Classify character, version from nonfirst candidate, exact PNG export, reload grouping, delete v1 undo/redo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await create(page, 'Nhân vật RPG', 32);
  await color(page, '#ff0000ff');
  await paint(page);

  // Initial asset list shows Sprite under Đồ vật (unclassified v1) without implicit save
  const objectSection = page.locator('.asset-category-section[data-kind="object"]');
  await expect(objectSection.locator('.asset-category-title')).toHaveText('Đồ vật');
  await expect(objectSection.locator('.asset-row')).toHaveCount(1);
  await expect(objectSection.locator('.asset-version-badge')).toHaveText('v1');

  // Open AI workspace to create a new character
  await page.locator('#ai-open').click();
  await expect(page.locator('#generation-workspace')).toBeVisible();
  await page.locator('#ai-prompt').fill('Một hiệp sĩ dũng cảm');
  await page.locator('#ai-generate').click();

  // Wait for candidate 1 ready
  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });

  // Classify as character with explicit name
  await page.locator('#proposal-asset-kind').selectOption('character');
  await page.locator('#proposal-asset-name').fill('Hiệp sĩ');
  await expect(page.locator('#proposal-apply')).toHaveText('Áp dụng thành asset mới');

  // Apply candidate 1
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();

  // Document now has 2 assets
  await expect.poll(async () => (await document(page)).assets.length).toBe(2);
  const docAfterFirst = await document(page);
  const heroAsset = docAfterFirst.assets[1];
  expect(heroAsset.name).toBe('Hiệp sĩ');
  expect(docAfterFirst.studio?.library?.[heroAsset.id]?.kind).toBe('character');
  expect(docAfterFirst.studio?.library?.[heroAsset.id]?.version).toBe(1);

  // Asset panel reflects character group
  const charSection = page.locator('.asset-category-section[data-kind="character"]');
  await expect(charSection.locator('.asset-category-title')).toHaveText('Nhân vật');
  await expect(charSection.locator('.asset-row')).toHaveCount(1);
  await expect(charSection.locator('.asset-row .asset-name-btn')).toHaveText('Hiệp sĩ');
  await expect(charSection.locator('.asset-version-badge')).toHaveText('v1');

  // Open AI workspace again to create version 2 from candidate 2 (non-first candidate alt=2)
  await page.locator('#ai-open').click();
  await page.locator('#ai-prompt').fill('Hiệp sĩ nâng cấp áo giáp');
  await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.candidate-card[data-index="1"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await page.locator('.candidate-card[data-index="1"]').click();
  await expect(page.locator('.candidate-card[data-index="1"]')).toHaveClass(/selected/);
  await expect(page.locator('#proposal-description')).toContainText('alt=2');

  // Switch to version mode and target "Hiệp sĩ"
  await page.locator('#proposal-mode-version').check();
  await expect(page.locator('#proposal-version-target-row')).toBeVisible();
  await page.locator('#proposal-version-target').selectOption(heroAsset.id);

  // Assert category is locked to inherited kind 'character'
  await expect(page.locator('#proposal-asset-kind')).toHaveValue('character');
  await expect(page.locator('#proposal-asset-kind')).toBeDisabled();
  await expect(page.locator('#proposal-kind-hint')).toContainText('Kế thừa phân loại');
  await expect(page.locator('#proposal-apply')).toHaveText('Áp dụng thành phiên bản mới');

  await page.locator('#proposal-asset-name').fill('Hiệp sĩ Nâng Cấp');
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();

  // Document now has 3 assets
  await expect.poll(async () => (await document(page)).assets.length).toBe(3);
  const docAfterV2 = await document(page);
  const heroV2Asset = docAfterV2.assets[2];
  expect(heroV2Asset.name).toBe('Hiệp sĩ Nâng Cấp');
  expect(docAfterV2.studio?.library?.[heroV2Asset.id]?.kind).toBe('character');
  expect(docAfterV2.studio?.library?.[heroV2Asset.id]?.version).toBe(2);
  expect(docAfterV2.studio?.library?.[heroV2Asset.id]?.groupId).toBe(docAfterV2.studio?.library?.[heroAsset.id]?.groupId);

  // Original source asset (Hero v1) pixels remain 100% unchanged
  expect(heroAsset.name).toBe('Hiệp sĩ');

  // Asset panel shows grouped versions under character
  await expect(charSection.locator('.asset-group.has-versions')).toBeVisible();
  await expect(charSection.locator('.asset-row')).toHaveCount(2);

  // Both versions are independently selectable
  await charSection.getByRole('button', { name: 'Hiệp sĩ', exact: true }).click();
  await expect(page.locator('#asset-info')).toContainText('Hiệp sĩ');

  await charSection.getByRole('button', { name: 'Hiệp sĩ Nâng Cấp', exact: true }).click();
  await expect(page.locator('#asset-info')).toContainText('Hiệp sĩ Nâng Cấp');

  // Export selected asset to PNG
  const dl = page.waitForEvent('download');
  await page.locator('[data-export="png"]').click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('Hiệp sĩ Nâng Cấp.png');

  // Reload keeps version grouping
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  const charSectionAfterReload = page.locator('.asset-category-section[data-kind="character"]');
  await expect(charSectionAfterReload.locator('.asset-group.has-versions')).toBeVisible();
  await expect(charSectionAfterReload.locator('.asset-row')).toHaveCount(2);

  // Delete version 1
  await charSectionAfterReload.locator('.asset-row', { has: page.getByRole('button', { name: 'Hiệp sĩ', exact: true }) }).locator('.asset-delete').click();
  await expect.poll(async () => (await document(page)).assets.length).toBe(2);
  const docAfterDeleteV1 = await document(page);
  expect(docAfterDeleteV1.assets.some((a: any) => a.name === 'Hiệp sĩ')).toBe(false);
  expect(docAfterDeleteV1.assets.some((a: any) => a.name === 'Hiệp sĩ Nâng Cấp')).toBe(true);

  // Undo restores version 1 and its library index
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await document(page)).assets.length).toBe(3);
  const docAfterUndo = await document(page);
  expect(docAfterUndo.studio?.library?.[heroAsset.id]?.version).toBe(1);

  // Redo re-deletes version 1
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await document(page)).assets.length).toBe(2);

  expect(errors).toEqual([]);
});

test('Asset Library UI: In-flight apply gate hardening, held response, escape lock, and failed apply recovery', async ({ page }) => {
  await create(page, 'Khóa cổng apply', 32);

  await page.locator('#ai-open').click();
  await page.locator('#ai-prompt').fill('Sprite thử nghiệm cổng');
  await page.locator('#ai-generate').click();

  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });

  // Intercept and hold apply-proposal route
  let releaseApply!: () => void;
  const heldApply = new Promise<void>(resolve => { releaseApply = resolve; });
  let applyIntercepted = false;

  await page.route('**/apply-proposal', async route => {
    applyIntercepted = true;
    await heldApply;
    await route.continue();
  });

  // Click apply
  await page.locator('#proposal-apply').click();
  await expect.poll(() => applyIntercepted).toBe(true);

  // While apply is in-flight: all modal actions and buttons are disabled
  await expect(page.locator('#ai-generate')).toBeDisabled();
  await expect(page.locator('#ai-cancel')).toBeDisabled();
  await expect(page.locator('#proposal-apply')).toBeDisabled();
  await expect(page.locator('#ai-close')).toBeDisabled();

  // Escape does NOT dismiss modal during apply
  await page.keyboard.press('Escape');
  await expect(page.locator('#generation-workspace')).toBeVisible();

  // Releasing apply completes successfully
  releaseApply();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#generation-workspace')).toBeHidden();
  await expect.poll(async () => (await document(page)).assets.length).toBe(2);
});

test('Asset Library UI: Timeline frame deletion prunes saved references in same undo', async ({ page }) => {
  await create(page, 'Tham chiếu frame', 32);
  const doc0 = await document(page);
  const asset0 = doc0.assets[0];

  // Add a second frame to the asset
  await page.locator('#frame-copy').click();
  await expect.poll(async () => (await document(page)).assets[0].frames.length).toBe(2);

  const docWithFrames = await document(page);
  const frame2Id = docWithFrames.assets[0].frames[1].id;

  // Open AI workspace and configure art direction with reference to frame 2
  await page.locator('#ai-open').click();
  await page.locator('#ai-art-refs-panel summary').click();
  const refCheckbox = page.locator('#ai-art-refs-list input[type="checkbox"]').nth(1);
  await refCheckbox.check();
  await page.locator('#save-art-direction').click();
  await expect(page.locator('#art-direction-status')).toContainText('Đã lưu');
  await page.locator('#ai-close').click();

  // Verify reference is saved in document
  const docSavedRef = await document(page);
  expect(docSavedRef.studio?.artDirection?.references?.some((r: any) => r.frameId === frame2Id)).toBe(true);

  // Delete frame 2 in timeline
  const frame2Button = page.locator('#timeline th button', { hasText: '2 ·' });
  await frame2Button.click();
  await page.locator('#frame-delete').click();

  // Document frames is now 1, and reference to deleted frame is pruned
  await expect.poll(async () => (await document(page)).assets[0].frames.length).toBe(1);
  const docAfterFrameDelete = await document(page);
  expect(docAfterFrameDelete.studio?.artDirection?.references?.some((r: any) => r.frameId === frame2Id)).toBe(false);

  // Undo restores frame 2 AND restores the reference in same undo!
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await document(page)).assets[0].frames.length).toBe(2);
  const docAfterUndo = await document(page);
  expect(docAfterUndo.studio?.artDirection?.references?.some((r: any) => r.frameId === frame2Id)).toBe(true);
});
