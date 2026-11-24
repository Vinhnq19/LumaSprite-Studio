import { test, expect, type Page } from '@playwright/test';
import { newAsset, celFor, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';

const origin = 'http://127.0.0.1:4329';
async function document(page: Page): Promise<any> {
  const id = await page.locator('#projects').inputValue();
  const r = await page.request.get(`/api/pixel/projects/${id}`);
  expect(r.ok()).toBeTruthy();
  return wireParse(await r.text());
}
async function create(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption('18');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#asset-info')).toContainText('18 × 18');
}
async function seed(page: Page, shape = false, withManifest = false): Promise<any> {
  await create(page, 'Kiểm chứng hồ sơ độc lập');
  const d = await document(page), a = d.assets[0], b = newAsset('Mẫu B xanh', 18, 18, 0x00ff00ff);
  a.name = 'Mẫu A đỏ'; a.palette = [0xff0000ff]; b.palette = [0x00ff00ff];
  const data = celFor(a, a.layers[0].id, a.frames[0].id, true)!.data!;
  if (shape) { data.fill(0); data[0] = data[1] = data[18] = 0xff0000ff; }
  else data.fill(0xff0000ff);
  d.assets.push(b);
  if (withManifest) a.provenance = { kind: 'generated', batch: { manifest: { version: 1,
    parts: [{ name: 'Đầu AI', box: { x: 0, y: 0, w: 2, h: 2 } }],
    landmarks: [{ name: 'Mắt AI', x: 1, y: 1 }],
  } } };
  const profile = (id: string, asset: any, resourceId: string) => ({
    version: 1, id, name: id === 'heroA' ? 'Nhân vật A đỏ' : 'Nhân vật B xanh', approved: true,
    source: { assetId: asset.id, frameId: asset.frames[0].id, captureRevision: 777,
      w: 18, h: 18, rgbaResourceId: resourceId, palette: [...asset.palette], pivot: { x: 9, y: 18 } },
    parts: {}, landmarks: { p: { name: 'Tay', x: 5, y: 5 }, q: { name: 'Chân', x: 12, y: 12 } },
    links: [], actions: {},
  });
  d.studio = { version: 1, resources: {
    masterA: { version: 1, kind: 'rgba', w: 18, h: 18, data: data.slice() },
    masterB: { version: 1, kind: 'rgba', w: 18, h: 18,
      data: celFor(b, b.layers[0].id, b.frames[0].id)!.data!.slice() },
  }, characters: { heroA: profile('heroA', a, 'masterA'), heroB: profile('heroB', b, 'masterB') } };
  const r = await page.request.put(`/api/pixel/projects/${d.id}`, {
    headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: d.revision, document: d }),
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#asset-info')).toContainText('Mẫu A đỏ');
  return document(page);
}
async function png(page: Page, d: any): Promise<Buffer> {
  const a = d.assets[0];
  const r = await page.request.post(`/api/pixel/projects/${d.id}/export`, {
    headers: { origin }, data: { revision: d.revision, format: 'png', assetId: a.id, frameId: a.frames[0].id },
  });
  expect(r.ok(), await r.text().catch(() => '')).toBeTruthy();
  return r.body();
}
async function point(page: Page): Promise<{ x: number; y: number }> {
  const p = (await document(page)).studio.characters.heroA.landmarks.p;
  return { x: p.x, y: p.y };
}

test('Character verification: viewing an empty editor never adds profile/resource fields to the next native save', async ({ page }) => {
  await create(page, 'Chỉ xem không sửa tài liệu');
  const before = await document(page);
  expect(before.studio?.characters).toBeUndefined();
  expect(before.studio?.resources).toBeUndefined();
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#character-dialog')).toBeVisible();
  await page.locator('#char-dialog-close').click();
  expect((await document(page)).revision).toBe(before.revision);
  await page.locator('#hex').fill('#ff0000ff'); await page.locator('#hex').press('Tab');
  await page.locator('#canvas').click({ position: { x: 4, y: 4 } });
  await expect.poll(async () => (await document(page)).revision).toBeGreaterThan(before.revision);
  const after = await document(page);
  expect(after.studio?.characters).toBeUndefined();
  expect(after.studio?.resources).toBeUndefined();
});

test('Character verification: obsolete profile load errors cannot replace the newer profile preview or notices', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await seed(page);
  let caught!: () => void, release!: () => void;
  const intercepted = new Promise<void>(resolve => { caught = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/resource?**', async route => {
    if (new URL(route.request().url()).searchParams.get('resource') !== 'masterA') { await route.continue(); return; }
    caught(); await gate;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'OBSOLETE_MASTER_A' }) });
  });
  try {
    await page.locator('#character-editor-open').click();
    await intercepted;
    await page.locator('.char-profile-item').filter({ hasText: 'Nhân vật B xanh' }).click();
    await expect(page.locator('#char-profile-name-display')).toHaveText('Nhân vật B xanh');
    await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
    const oldResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('resource') === 'masterA');
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#notice')).not.toContainText('OBSOLETE_MASTER_A');
    for (const id of ['grid', 'mask', 'points', 'pivot']) await page.locator(`#char-chk-${id}`).uncheck();
    await expect.poll(() => page.locator('#char-canvas').evaluate((node: HTMLCanvasElement) =>
      Array.from(node.getContext('2d')!.getImageData(1, 1, 1, 1).data))).toEqual([0, 255, 0, 255]);
    await expect(page.locator('#notice')).not.toContainText('OBSOLETE_MASTER_A');
    expect(errors).toEqual([]);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('Character verification: measured landmark drag is exactly one undo operation and leaves native PNG unchanged', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const initial = await seed(page), bytes = await png(page, initial);
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  await page.locator('.char-tab-btn[data-tab="landmarks"]').click();
  const canvas = page.locator('#char-canvas'), box = (await canvas.boundingBox())!, scale = box.width / 18;
  await page.mouse.move(box.x + 5.5 * scale, box.y + 5.5 * scale);
  await page.mouse.down(); await page.mouse.move(box.x + 7.5 * scale, box.y + 6.5 * scale, { steps: 3 }); await page.mouse.up();
  await expect.poll(() => point(page)).toEqual({ x: 7, y: 6 });
  await canvas.focus(); await page.keyboard.press('Control+z');
  await expect.poll(() => point(page)).toEqual({ x: 5, y: 5 });
  await canvas.focus(); await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => point(page)).toEqual({ x: 7, y: 6 });
  await page.mouse.move(box.x + 7.5 * scale, box.y + 6.5 * scale);
  await page.mouse.down(); await page.mouse.move(box.x + 9.5 * scale, box.y + 8.5 * scale);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('#character-dialog')).toBeVisible();
  expect(await point(page)).toEqual({ x: 7, y: 6 });
  await page.locator('#char-dialog-close').click();
  expect(await png(page, await document(page))).toEqual(bytes);
  await page.reload(); await expect(page.locator('#canvas')).toBeVisible();
  expect(await point(page)).toEqual({ x: 7, y: 6 });
  expect(errors).toEqual([]);
});

test('Character verification: a wand part preserves a three-pixel L-shaped mask, not its rectangle', async ({ page }) => {
  await seed(page, true);
  page.on('dialog', async dialog => { await dialog.accept('Đầu có dấu tiếng Việt'); });
  await page.locator('[data-tool="wand"]').click();
  const canvas = page.locator('#canvas'), box = (await canvas.boundingBox())!, scale = box.width / 18;
  await canvas.click({ position: { x: scale / 2, y: scale / 2 } });
  await page.locator('#character-editor-open').click();
  await page.locator('.char-tab-btn[data-tab="parts"]').click();
  await expect(page.locator('#char-add-part-btn')).toBeEnabled();
  await page.locator('#char-add-part-btn').click();
  await expect.poll(async () => Object.keys((await document(page)).studio.characters.heroA.parts).length).toBe(1);
  const d = await document(page), part: any = Object.values(d.studio.characters.heroA.parts)[0];
  expect(part.name).toBe('Đầu có dấu tiếng Việt');
  const response = await page.request.get(`/api/pixel/projects/${d.id}/resource?revision=${d.revision}&resource=${part.maskResourceId}`);
  expect(response.ok()).toBeTruthy();
  const mask = wireParse(await response.text()).data as Uint32Array;
  expect(mask.length).toBe(324);
  expect(Array.from(mask).flatMap((v, i) => v ? [i] : [])).toEqual([0, 1, 18]);
  await page.locator('#char-dialog-close').click(); await page.reload();
  await expect(page.locator('#canvas')).toBeVisible(); await page.locator('#character-editor-open').click();
  for (const id of ['grid', 'points', 'pivot']) await page.locator(`#char-chk-${id}`).uncheck();
  await page.locator('#char-chk-mask').check();
  const previewPixel = () => page.locator('#char-canvas').evaluate((node: HTMLCanvasElement) => {
    const z = node.width / 18;
    return Array.from(node.getContext('2d')!.getImageData(Math.floor(z / 2), Math.floor(z / 2), 1, 1).data);
  });
  await expect.poll(async () => (await previewPixel())[2]).toBeGreaterThan(60);
  await page.locator('#char-chk-mask').uncheck();
  expect(await previewPixel()).toEqual([255, 0, 0, 255]);
});

test('Character verification: current source failures are visible and never display the previous master', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await seed(page);
  await page.route('**/resource?**', async route => {
    if (new URL(route.request().url()).searchParams.get('resource') !== 'masterB') { await route.continue(); return; }
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'CURRENT_MASTER_B_FAILED' }) });
  });
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  for (const id of ['grid', 'mask', 'points', 'pivot']) await page.locator(`#char-chk-${id}`).uncheck();
  await page.locator('.char-profile-item').filter({ hasText: 'Nhân vật B xanh' }).click();
  await expect(page.locator('#notice')).toContainText('CURRENT_MASTER_B_FAILED');
  await expect(page.locator('#char-dialog-status')).toContainText('CURRENT_MASTER_B_FAILED');
  await expect(page.locator('#char-readiness-status')).not.toHaveText('Sẵn sàng');
  const pixel = await page.locator('#char-canvas').evaluate((node: HTMLCanvasElement) =>
    Array.from(node.getContext('2d')!.getImageData(1, 1, 1, 1).data));
  expect(pixel).not.toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('Character verification: actual batch manifest suggestions become an unapproved undoable draft', async ({ page }) => {
  await seed(page, false, true);
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  await expect(page.locator('#char-manifest-tab-btn')).toBeVisible();
  await page.locator('#char-manifest-tab-btn').click();
  await page.locator('#char-import-manifest-btn').click();
  await expect.poll(async () => (await document(page)).studio.characters.heroA.approved).toBe(false);
  const imported = (await document(page)).studio.characters.heroA;
  expect(Object.values(imported.parts).map((p: any) => p.name)).toEqual(['Đầu AI']);
  expect(Object.values(imported.landmarks).some((p: any) => p.name === 'Mắt AI')).toBe(true);
  await page.locator('#char-canvas').focus(); await page.keyboard.press('Control+z');
  await expect.poll(async () => (await document(page)).studio.characters.heroA.approved).toBe(true);
  expect((await document(page)).studio.characters.heroA.parts).toEqual({});
});

test('Character verification: selected landmark fields and intentional click placement edit one point without painting', async ({ page }) => {
  const d = await seed(page), bytes = await png(page, d);
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  await page.locator('.char-tab-btn[data-tab="landmarks"]').click();
  await page.locator('#char-landmarks-list .char-sub-item').filter({ hasText: 'Tay' }).click();
  await page.locator('#char-edit-lm-name').fill('Tay trái tiếng Việt');
  await page.locator('#char-edit-lm-x').fill('6');
  await page.locator('#char-edit-lm-y').fill('7');
  await page.locator('#char-edit-landmark-form button[type="submit"]').click();
  await expect.poll(() => point(page)).toEqual({ x: 6, y: 7 });
  expect((await document(page)).studio.characters.heroA.landmarks.p.name).toBe('Tay trái tiếng Việt');
  await page.locator('#char-place-lm-btn').click();
  const canvas = page.locator('#char-canvas'), box = (await canvas.boundingBox())!, scale = box.width / 18;
  await canvas.click({ position: { x: 3.5 * scale, y: 4.5 * scale } });
  await expect.poll(() => point(page)).toEqual({ x: 3, y: 4 });
  await canvas.focus(); await page.keyboard.press('Control+z');
  await expect.poll(() => point(page)).toEqual({ x: 6, y: 7 });
  expect((await document(page)).studio.characters.heroA.landmarks.p.name).toBe('Tay trái tiếng Việt');
  expect(await png(page, await document(page))).toEqual(bytes);
});

test('Character verification: an external revision preserves unsubmitted Vietnamese landmark fields', async ({ page }) => {
  await seed(page);
  await page.locator('#character-editor-open').click();
  await expect(page.locator('#char-readiness-status')).toHaveText('Sẵn sàng');
  await page.locator('.char-tab-btn[data-tab="landmarks"]').click();
  await page.locator('#char-landmarks-list .char-sub-item').filter({ hasText: 'Tay' }).click();
  await page.locator('#char-edit-lm-name').fill('Tay trái chưa lưu tiếng Việt');
  const d = await document(page); d.assets[0].palette.push(0x112233ff);
  const response = await page.request.put(`/api/pixel/projects/${d.id}`, {
    headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: d.revision, document: d }),
  });
  expect(response.ok()).toBeTruthy();
  await expect(page.locator('#save-status')).toContainText('Xung đột');
  await expect(page.locator('#character-dialog')).toBeVisible();
  await expect(page.locator('#char-edit-lm-name')).toHaveValue('Tay trái chưa lưu tiếng Việt');
  expect((await document(page)).studio.characters.heroA.landmarks.p.name).toBe('Tay');
});
