import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Img } from '../../src/studio/raster.ts';
import { encodePng } from '../../src/node/studio/png.ts';
import { wireParse, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { decodeTestPng } from '../../test/fixtures/image-assertions.ts';

async function project(page: Page): Promise<PixelDocument> {
  const id = await page.locator('#projects').inputValue();
  return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`)).text());
}
async function create(page: Page, name: string, size = 32) {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption(String(size));
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  await page.locator('#actual').click();
  await expect(page.locator('#canvas')).toHaveCSS('width', `${size}px`);
}
const tool = (page: Page, id: string) => page.locator(`[data-tool="${id}"]`).click();
async function ink(page: Page, color: string) {
  await page.locator('#hex').fill(color);
  await page.locator('#hex').press('Tab');
}
async function point(page: Page, x: number, y: number) {
  const box = (await page.locator('#canvas').boundingBox())!;
  const width = Number((await page.locator('#asset-info').textContent())!.match(/(\d+) × /)![1]);
  return { x: box.x + (x + .5) * box.width / width, y: box.y + (y + .5) * box.width / width };
}
async function draw(page: Page, x: number, y: number, nextX = x, nextY = y) {
  const a = await point(page, x, y), b = await point(page, nextX, nextY);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  if (a.x !== b.x || a.y !== b.y) await page.mouse.move(b.x, b.y);
  await page.mouse.up();
}
async function save(page: Page) {
  await page.locator('header [data-command="file.save"]').click();
  await expect(page.locator('#save-status')).toContainText('Đã lưu');
}
async function png(page: Page): Promise<Uint32Array> {
  const downloaded = page.waitForEvent('download');
  await page.locator('[data-export="png"]').click();
  return decodeTestPng(await readFile((await (await downloaded).path())!)).data;
}
const red = 0xe45c54ff, blue = 0x536da0ff;

test('S2 · 32px icon tools, palette, floating selection and interrupted gesture history', async ({ page }) => {
  await create(page, 'S2 icon');
  await ink(page, '#e45c54ff');
  await draw(page, 2, 2, 8, 2);
  await tool(page, 'line'); await draw(page, 2, 3, 8, 3);
  await tool(page, 'rect'); await draw(page, 10, 9, 14, 13);
  await tool(page, 'ellipse'); await draw(page, 18, 9, 22, 13);
  await tool(page, 'pick'); await draw(page, 2, 2);
  await expect(page.locator('#hex')).toHaveValue('#e45c54ff');
  await ink(page, '#536da0ff');
  await page.locator('#palette-add').click();
  await tool(page, 'fill'); await draw(page, 12, 11);
  await tool(page, 'erase'); await draw(page, 8, 3);
  await tool(page, 'select'); await draw(page, 2, 2, 3, 2);
  await tool(page, 'move'); await draw(page, 2, 2, 5, 5);
  await expect(page.locator('#confirm-float')).toBeEnabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await tool(page, 'select'); await draw(page, 5, 5, 6, 5);
  await tool(page, 'move'); await draw(page, 5, 5, 0, 5);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
  await expect(page.locator('#notice')).toContainText('nằm ngoài canvas');
  await page.keyboard.press('Escape');
  await tool(page, 'pen');
  const first = await point(page, 0, 0), end = await point(page, 31, 0);
  await page.mouse.move(first.x, first.y); await page.mouse.down(); await page.mouse.move(end.x, end.y);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.locator('[data-command="layer.add"]').click();
  await draw(page, 24, 24);
  await save(page);
  const before = await png(page);
  expect([before[0], before[2 * 32 + 2], before[5 * 32 + 5], before[2 * 32 + 7], before[3 * 32 + 8], before[9 * 32 + 20], before[11 * 32 + 12], before[24 * 32 + 24]])
    .toEqual([0, 0, red, red, 0, red, blue, blue]);
  expect((await project(page)).assets[0].palette).toContain(blue);
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  expect(await png(page)).toEqual(before);
});

test('S2 · imported prop cut/paste, layer operations and history restore', async ({ page }) => {
  await create(page, 'S2 prop', 64);
  const prop = new Img(64, 64); prop.set(3, 4, red); prop.set(4, 4, blue);
  await page.locator('#png-input').setInputFiles({ name: 'Approved prop.png', mimeType: 'image/png', buffer: encodePng(prop) });
  await page.locator('#import-form').getByRole('button', { name: 'Nhập ảnh', exact: true }).click();
  await expect(page.locator('#asset-info')).toContainText('Approved prop');
  await save(page);
  const original = await png(page), starting = await project(page);
  await tool(page, 'select'); await draw(page, 3, 4);
  await page.keyboard.press('Control+x'); await page.keyboard.press('Control+v'); await page.keyboard.press('ArrowDown');
  await page.locator('[data-command="layer.add"]').click();
  await expect(page.locator('#confirm-float')).toBeDisabled();
  await page.locator('#layer-name').fill('Chi tiết'); await page.locator('#layer-name').press('Tab');
  await ink(page, '#536da0ff'); await tool(page, 'pen'); await draw(page, 12, 12);
  await page.locator('#layer-copy').click();
  await expect(page.locator('#edit-target')).toContainText('Chi tiết (bản sao)');
  await page.locator('#layer-down').click();
  await page.locator('#layer-up').click();
  await page.locator('#layer-merge').click();
  await save(page);
  const edited = await png(page);
  expect([edited[4 * 64 + 3], edited[4 * 64 + 4], edited[5 * 64 + 3], edited[12 * 64 + 12]]).toEqual([0, blue, red, blue]);
  await page.locator('#history').click();
  await page.locator('#history-list').getByRole('button', { name: new RegExp(`r${starting.revision} · Lưu thủ công`) }).click();
  await page.locator('#asset-list').getByRole('button', { name: 'Approved prop', exact: true }).click();
  expect(await png(page)).toEqual(original);
});

test('S2 · animation drawing freezes active frame and retains timing after undo/redo', async ({ page }) => {
  await create(page, 'S2 animation');
  await ink(page, '#e45c54ff'); await draw(page, 1, 1);
  await page.locator('[data-command="frame.add"]').click();
  await expect(page.locator('#edit-target')).toContainText('Frame 2/2');
  await page.locator('#duration').fill('720'); await page.locator('#duration').press('Tab');
  await ink(page, '#536da0ff');
  await page.locator('#play').click();
  await expect(page.locator('#play')).toContainText('Dừng');
  await expect(page.locator('#edit-target')).toContainText('Frame 2/2');
  const first = await point(page, 5, 2), last = await point(page, 16, 2);
  await page.mouse.move(first.x, first.y); await page.mouse.down();
  await expect(page.locator('#play')).toContainText('Phát');
  await page.mouse.move(last.x, last.y); await page.mouse.up();
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z');
  await save(page);
  expect((await project(page)).assets[0].frames.map(frame => frame.duration)).toEqual([100, 720]);
  expect((await png(page))[2 * 32 + 16]).toBe(blue);
  await page.locator('#timeline thead button').first().click();
  const firstFrame = await png(page);
  expect([firstFrame[33], firstFrame[2 * 32 + 16]]).toEqual([red, 0]);
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  expect((await project(page)).assets[0].frames.map(frame => frame.duration)).toEqual([100, 720]);
});

test('S2 · group lock and native selection preserve protected RGBA', async ({ page }) => {
  await create(page, 'S2 protected');
  await page.locator('#layer-group').click();
  await page.locator('[data-command="layer.add"]').click();
  await ink(page, '#e45c54ff'); await draw(page, 4, 4, 7, 4);
  await page.locator('#timeline tbody tr').filter({ hasText: /Nhóm/ }).getByTitle('Khóa/mở layer').click();
  await expect(page.locator('#edit-target')).toContainText('Khóa');
  const protectedPixels = await png(page);
  for (const id of ['pen', 'erase', 'fill', 'move']) {
    await tool(page, id); await draw(page, 4, 4, 7, 4);
    await expect(page.locator('#notice')).toContainText('khóa');
  }
  await page.locator('#layer-delete').click();
  await expect(page.locator('#notice')).toContainText('Mở khóa');
  expect(await png(page)).toEqual(protectedPixels);
  await page.locator('#timeline tbody tr').filter({ hasText: /Layer 1/ }).getByRole('button', { name: 'Layer 1', exact: true }).click();
  await tool(page, 'select'); await draw(page, 0, 0, 1, 1);
  await tool(page, 'fill'); await ink(page, '#536da0ff'); await draw(page, 0, 0);
  const edited = await png(page);
  expect([edited[0], edited[2], edited[4 * 32 + 4]]).toEqual([blue, 0, red]);
  const d = await project(page), a = d.assets[0], frame = a.frames[0].id;
  const locked = a.layers.find(layer => layer.parent)!;
  a.layers[0].cels[frame] = locked.cels[frame];
  const result = await page.request.put(`/api/pixel/projects/${d.id}`, {
    headers: { origin: new URL(page.url()).origin }, data: { revision: d.revision, document: d },
  });
  expect(result.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  const linked = await png(page);
  await tool(page, 'erase'); await draw(page, 4, 4, 7, 4);
  await expect(page.locator('#notice')).toContainText('Cel liên kết');
  expect(await png(page)).toEqual(linked);
});

test.describe('S2 workspace DPR 2', () => {
  test.use({ deviceScaleFactor: 2 });
  test('S2 · responsive inspector, cursor zoom, pan, draw and saved view', async ({ page }) => {
    await create(page, 'S2 viewport', 64);
    const revision = (await project(page)).revision;
    const stage = page.locator('#stage'), canvas = page.locator('#canvas');
    for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      const openWidth = (await stage.boundingBox())!.width;
      await page.locator('#inspector-toggle').click();
      await expect(page.locator('#properties')).toBeHidden();
      expect((await stage.boundingBox())!.width).toBeGreaterThan(openWidth);
      await page.locator('#inspector-toggle').click();
      await expect(page.locator('#properties')).toBeVisible();
      expect(await page.evaluate(() => document.body.scrollWidth)).toBe(width);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('#fit').click();
    await expect(canvas).toHaveCSS('image-rendering', 'pixelated');
    for (let i = 0; i < 2; i++) await page.locator('#zoom-in').click();
    const mid = await point(page, 32, 32);
    await page.mouse.move(mid.x, mid.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control');
    await expect.poll(async () => Math.abs((await point(page, 32, 32)).x - mid.x)).toBeLessThan(2);
    const scroll = await stage.evaluate(element => element.scrollLeft);
    await page.mouse.down({ button: 'middle' }); await page.mouse.move(mid.x - 30, mid.y); await page.mouse.up({ button: 'middle' });
    expect(await stage.evaluate(element => element.scrollLeft)).toBeGreaterThan(scroll);
    await page.locator('#grid').uncheck();
    expect((await project(page)).revision).toBe(revision);
    const zoom = await page.locator('#zoom-value').textContent();
    await page.locator('#ai-workspace-open').click();
    await page.locator('#ai-close').click();
    await expect(page.locator('#zoom-value')).toHaveText(zoom!);
    await page.reload();
    await expect(page.locator('#zoom-value')).toHaveText(zoom!);
    await page.locator('#actual').click(); await ink(page, '#e45c54ff'); await draw(page, 10, 13);
    expect((await png(page))[13 * 64 + 10]).toBe(red);
  });
});
