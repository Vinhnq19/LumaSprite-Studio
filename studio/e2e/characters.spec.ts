import { test, expect, type Page } from '@playwright/test';
import { wireParse } from '../../src/studio/pixel/model.ts';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log(
      'CHARACTER UI DIAGNOSTIC',
      await page.evaluate(() =>
        Object.fromEntries(
          ['notice', 'save-status', 'char-dialog-status', 'char-readiness-status', 'char-coords-info'].map((id) => [
            id,
            window.document.getElementById(id)?.textContent,
          ])
        )
      )
    );
  }
});

async function createProject(page: Page, name: string, size = 18): Promise<void> {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption(String(size));
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#asset-info')).toContainText(`${size} × ${size}`);
}

async function getDoc(page: Page): Promise<any> {
  const id = await page.locator('#projects').inputValue();
  return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`, { maxRetries: 2 })).text());
}

async function paintPixel(page: Page, x = 3, y = 3, colorHex = '#ff0000ff') {
  await page.locator('#hex').fill(colorHex);
  await page.locator('#hex').press('Tab');
  await page.locator('#canvas').click({ position: { x, y } });
}

test('Character Editor: viewing does NOT mutate document or add extensions', async ({ page }) => {
  await createProject(page, 'Xem thu vien', 18);
  const beforeDoc = await getDoc(page);
  expect(beforeDoc.studio?.characters).toBeUndefined();
  expect(beforeDoc.studio?.resources).toBeUndefined();

  // Open Character Editor dialog and close without creating
  await page.locator('#character-editor-open').click();
  const dialog = page.locator('#character-dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#char-dialog-close').click();
  await expect(dialog).toBeHidden();

  // Document must remain untouched
  const afterDoc = await getDoc(page);
  expect(afterDoc.revision).toBe(beforeDoc.revision);
  expect(afterDoc.studio?.characters).toBeUndefined();
  expect(afterDoc.studio?.resources).toBeUndefined();

  // Paint pixel normally
  await paintPixel(page, 2, 2, '#00ff00ff');
  const paintedDoc = await getDoc(page);
  expect(paintedDoc.studio?.characters).toBeUndefined();
});

test('Character Editor: 18x18 workflow -> create profile -> part mask -> drag landmark -> link -> approve -> reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 1. Create 18x18 project and paint
  await createProject(page, 'Nhân vật 18x18', 18);
  await paintPixel(page, 4, 4, '#ff0000ff');

  // Handle prompt for new character name
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') {
      await dialog.accept('Chiến binh');
    } else if (dialog.type() === 'confirm') {
      await dialog.accept();
    }
  });

  // 2. Open Character Editor from nav
  await page.locator('#character-editor-open').click();
  const dialog = page.locator('#character-dialog');
  await expect(dialog).toBeVisible();

  // 3. Create profile from current frame
  await page.locator('#char-create-profile-btn').click();
  await expect(page.locator('.char-profile-item')).toHaveCount(1);
  await expect(page.locator('#char-profile-name-display')).toHaveText('Chiến binh');
  await expect(page.locator('#char-profile-approval-badge')).toHaveText('Chưa duyệt');
  await expect(page.locator('#char-readiness-status')).toHaveText('Chưa duyệt');

  // 4. Verify selection guidance when no selection exists
  await page.locator('.char-tab-btn[data-tab="parts"]').click();
  await expect(page.locator('#char-add-part-btn')).toBeDisabled();
  await expect(page.locator('#char-selection-guidance')).toContainText('chọn vùng');

  // Close dialog to make an exact non-rectangular selection on main canvas
  await page.locator('#char-dialog-close').click();
  await expect(dialog).toBeHidden();

  // Select a region on canvas using Wand or Select tool
  await page.keyboard.press('m'); // Tool select
  const canvasBox = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.up();

  // Re-open character editor
  await page.locator('#character-editor-open').click();
  await expect(dialog).toBeVisible();
  await page.locator('.char-tab-btn[data-tab="parts"]').click();
  await expect(page.locator('#char-add-part-btn')).toBeEnabled();

  // Add part from selection
  await page.locator('#char-add-part-btn').click();
  await expect(page.locator('#char-parts-list .char-sub-item')).toHaveCount(1);

  // 5. Add landmarks & links
  await page.locator('.char-tab-btn[data-tab="landmarks"]').click();
  await page.locator('#char-new-lm-name').fill('dau');
  await page.locator('#char-new-lm-x').fill('9');
  await page.locator('#char-new-lm-y').fill('4');
  await page.locator('#char-add-landmark-form button[type="submit"]').click();

  await page.locator('#char-new-lm-name').fill('than');
  await page.locator('#char-new-lm-x').fill('9');
  await page.locator('#char-new-lm-y').fill('10');
  await page.locator('#char-add-landmark-form button[type="submit"]').click();
  await expect(page.locator('#char-landmarks-list .char-sub-item')).toHaveCount(2);

  // Link landmarks with explicit distinct endpoint selection
  await page.locator('.char-tab-btn[data-tab="links"]').click();
  const fromOptions = await page.locator('#char-link-from option').all();
  const toOptions = await page.locator('#char-link-to option').all();
  expect(fromOptions.length).toBeGreaterThanOrEqual(2);
  const fromVal = await fromOptions[0].getAttribute('value');
  const toVal = await toOptions[1].getAttribute('value');
  expect(fromVal).not.toBe(toVal);
  await page.locator('#char-link-from').selectOption(fromVal!);
  await page.locator('#char-link-to').selectOption(toVal!);
  await page.locator('#char-add-link-form button[type="submit"]').click();
  await expect(page.locator('#char-links-list .char-sub-item')).toHaveCount(1);

  // 6. Drag landmark on preview canvas with measured zoom and assert exact coordinates
  const previewCanvas = page.locator('#char-canvas');
  await expect(previewCanvas).toBeVisible();
  const box = (await previewCanvas.boundingBox())!;
  const canvasW = await previewCanvas.evaluate((c: HTMLCanvasElement) => c.width);
  const canvasH = await previewCanvas.evaluate((c: HTMLCanvasElement) => c.height);
  const zoomX = canvasW / 18;
  const zoomY = canvasH / 18;

  // Landmark 'dau' at (9, 4). Drag to (12, 6)
  const startX = box.x + (9 + 0.5) * zoomX;
  const startY = box.y + (4 + 0.5) * zoomY;
  const endX = box.x + (12 + 0.5) * zoomX;
  const endY = box.y + (6 + 0.5) * zoomY;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY);
  await page.mouse.up();

  // Verify saved landmark moved to (12, 6)
  const savedPoint = async () => {
    const d = await getDoc(page), char: any = Object.values(d.studio.characters)[0];
    const point: any = Object.values(char.landmarks).find((l: any) => l.name === 'dau');
    return point ? { x: point.x, y: point.y } : undefined;
  };
  await expect.poll(savedPoint).toEqual({ x: 12, y: 6 });

  // Single gesture undo -> returns to (9, 4)
  await previewCanvas.focus(); await page.keyboard.press('Control+z');
  await expect.poll(savedPoint).toEqual({ x: 9, y: 4 });

  // Redo -> returns to (12, 6)
  await previewCanvas.focus(); await page.keyboard.press('Control+Shift+z');
  await expect.poll(savedPoint).toEqual({ x: 12, y: 6 });

  // 7. Approve profile
  await page.locator('#char-approve-btn').click();
  await expect(page.locator('#char-profile-approval-badge')).toHaveText('Đã duyệt');
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');

  await expect.poll(async () => (Object.values((await getDoc(page)).studio.characters)[0] as any).approved).toBe(true);

  // 8. Close and reload, verify persistence
  await page.locator('#char-dialog-close').click();
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();

  const doc = await getDoc(page);
  expect(doc.studio?.characters).toBeDefined();
  const profiles = Object.values(doc.studio.characters) as any[];
  expect(profiles.length).toBe(1);
  expect(profiles[0].name).toBe('Chiến binh');
  expect(profiles[0].approved).toBe(true);
  expect(Object.keys(profiles[0].parts).length).toBe(1);
  expect(Object.keys(profiles[0].landmarks).length).toBe(2);
  expect(profiles[0].links.length).toBe(1);
  expect(errors).toEqual([]);
});

test('Character Editor: stale detection on pixel/palette change and explicit reapproval', async ({ page }) => {
  await createProject(page, 'Nhân vật Stale', 18);
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept('Anh hùng');
    else if (dialog.type() === 'confirm') await dialog.accept();
  });

  // Create and approve
  await page.locator('#character-editor-open').click();
  await page.locator('#char-create-profile-btn').click();
  await page.locator('#char-approve-btn').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  await page.locator('#char-dialog-close').click();

  // Modify pixel on main canvas
  await paintPixel(page, 7, 7, '#00ff00ff');

  // Re-open character editor -> should be stale
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#char-readiness-status')).toHaveText(/Cần duyệt lại/);

  // Explicit reapprove
  await page.locator('#char-approve-btn').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  await page.locator('#char-dialog-close').click();
});

test('Character Editor: wrong-frame guidance when selection is on different asset/frame', async ({ page }) => {
  await createProject(page, 'Asset Khac', 18);
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept('Nhan vat 1');
  });

  // 1. Create character on Asset 1
  await page.locator('#character-editor-open').click();
  await page.locator('#char-create-profile-btn').click();
  await page.locator('#char-dialog-close').click();

  // 2. Add second asset on canvas
  await page.locator('#new-asset').click();
  await page.locator('#new-name').fill('Sprite 2');
  await page.locator('#create-form button[type="submit"]').click();
  await expect(page.locator('#asset-info')).toContainText('Sprite 2');

  // Select on Sprite 2
  await page.keyboard.press('m');
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.up();

  // Open Character Editor -> guidance indicates mismatch with Sprite 1
  await page.locator('#character-editor-open').click();
  await page.locator('.char-tab-btn[data-tab="parts"]').click();
  await expect(page.locator('#char-add-part-btn')).toBeDisabled();
  await expect(page.locator('#char-selection-guidance')).toContainText(/thuộc asset khác hoặc frame khác/i);
});

test('Character Editor: responsive layout reachable at 1000x740', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 740 });
  await createProject(page, 'Responsive 1000x740', 18);

  await page.locator('#character-editor-open').click();
  const dialog = page.locator('#character-dialog');
  await expect(dialog).toBeVisible();

  // All key buttons are visible and not clipped
  await expect(page.locator('#char-dialog-close')).toBeVisible();
  await expect(page.locator('#char-create-profile-btn')).toBeVisible();
  await expect(page.locator('#char-zoom-fit')).toBeVisible();
  await expect(page.locator('.char-tab-btn[data-tab="parts"]')).toBeVisible();
});
