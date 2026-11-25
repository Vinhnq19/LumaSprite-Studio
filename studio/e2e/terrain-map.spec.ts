import { test, expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { newDocument, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { decodeTestPng, unzipTestStored } from '../../test/fixtures/image-assertions.ts';
import { mapFixture } from '../../test/tilemap-fixture.ts';
import { createMap, getMap, MapStroke, registerTileset } from '../../src/studio/map-commands.ts';

const origin = 'http://127.0.0.1:4329';
async function savedDoc(page: Page, id: string) { return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`, { maxRetries: 2 })).text()); }
async function seed(page: Page) {
  const response = await page.request.post('/api/pixel/projects', { headers: { origin }, data: { name: 'Bản đồ Chrome độc lập', w: 16, h: 16, background: 0x338844ff } });
  expect(response.ok(), await response.text()).toBeTruthy(); const d = wireParse(await response.text());
  await page.goto('/'); await page.locator('#projects').selectOption(d.id); await expect(page.locator('#asset-info')).toContainText('16 × 16'); return d;
}
async function atlas(page: Page, doc: any) {
  await page.locator('#terrain-editor-open').click(); await expect(page.locator('#terrain-dialog')).toBeVisible();
  await expect(page.locator('#terrain-size')).toHaveValue('16'); await page.locator('#terrain-name').fill('Cỏ rừng');
  await page.locator('#terrain-generate').click(); await expect(page.locator('#terrain-preview')).toBeVisible();
  if (process.env.PXL_TERRAIN_LAYOUT_ROOT) await page.locator('#terrain-dialog').screenshot({ path: join(process.env.PXL_TERRAIN_LAYOUT_ROOT, 'terrain.png'), animations: 'disabled' });
  expect((await savedDoc(page, doc.id)).revision).toBe(doc.revision);
  await expect(page.locator('#terrain-apply')).toBeEnabled(); await page.locator('#terrain-apply').click();
  await expect(page.locator('#terrain-dialog')).not.toBeVisible(); await expect(page.locator('#asset-info')).toContainText('128 × 96');
  return savedDoc(page, doc.id);
}
async function map(page: Page, name = 'Rừng nhỏ') {
  await page.locator('#map-editor-open').click(); await expect(page.locator('#map-dialog')).toBeVisible();
  await page.locator('#map-new-name').fill(name); await page.locator('#map-new-width').fill('40'); await page.locator('#map-new-height').fill('4');
  await page.locator('#map-create-submit').click(); await expect(page.locator('#map-canvas')).toHaveAttribute('data-ready', 'true'); await expect(page.locator('#map-name')).toHaveValue(name);
  await page.locator('#map-actual').click();
}
async function point(page: Page, x: number, y: number) {
  const c = page.locator('#map-canvas'), box = (await c.boundingBox())!, data = await c.evaluate((c: HTMLCanvasElement) => ({ zoom: Number(c.dataset.zoom), x: Number(c.dataset.cameraX), y: Number(c.dataset.cameraY), size: Number(c.dataset.tileSize) }));
  return { x: box.x + data.x + (x + .5) * data.zoom * data.size, y: box.y + data.y + (y + .5) * data.zoom * data.size };
}
async function draw(page: Page, x: number, y: number, ex = x, ey = y, end = true) {
  const a = await point(page, x, y), b = await point(page, ex, ey); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); if (end) await page.mouse.up();
}
async function pixel(page: Page, x: number, y: number) {
  return page.locator('#map-canvas').evaluate((c: HTMLCanvasElement, p) => { const z = Number(c.dataset.zoom) * Number(c.dataset.tileSize), x = Math.floor(Number(c.dataset.cameraX) + (p.x + .5) * z), y = Math.floor(Number(c.dataset.cameraY) + (p.y + .5) * z); return Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data); }, { x, y });
}
async function tile48(page: Page) {
  await page.locator('#map-tile-palette').scrollIntoViewIfNeeded();
  const palette = (await page.locator('#map-tile-palette').boundingBox())!; await page.mouse.click(palette.x + palette.width * 7.5 / 8, palette.y + palette.height * 5.5 / 6); await expect(page.locator('#map-tile-info')).toContainText('ID 48'); await page.locator('#map-autotile').uncheck();
}
async function save(page: Page, id: string) {
  await page.locator('#map-save').click(); await expect(page.locator('#save-status')).toContainText('Đã lưu'); return savedDoc(page, id);
}

test('Terrain + Map: native material -> preview -> new atlas -> cross-chunk stroke/undo -> save/reopen -> exact downloads', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const doc = await seed(page), applied = await atlas(page, doc); expect(applied.assets).toHaveLength(2);
  await map(page); await tile48(page); await draw(page, 31, 1, 32, 1);
  await expect.poll(() => pixel(page, 31, 1)).toEqual([51, 136, 68, 255]);
  if (process.env.PXL_TERRAIN_LAYOUT_ROOT) { await page.locator('.map-inspector').evaluate(e => e.scrollTop = 0); await page.locator('#map-dialog').screenshot({ path: join(process.env.PXL_TERRAIN_LAYOUT_ROOT, 'map-wide.png'), animations: 'disabled' }); }
  await page.locator('#map-undo').click(); await expect.poll(() => pixel(page, 31, 1)).toEqual([0, 0, 0, 0]);
  await page.locator('#map-redo').click(); await expect.poll(() => pixel(page, 32, 1)).toEqual([51, 136, 68, 255]);
  const saved = await save(page, doc.id), maps = Object.values(saved.studio.mapIndex) as any[]; expect(Object.keys(maps[0].layers[0].chunks)).toHaveLength(2);
  const downloadWait = page.waitForEvent('download'); await page.locator('[data-map-export=png]').click(); const download = await downloadWait, stream = (await download.createReadStream())!, buffers: Buffer[] = [];
  for await (const buffer of stream) buffers.push(buffer); const image = decodeTestPng(Buffer.concat(buffers)); expect(image.w).toBe(640); expect(image.h).toBe(64);
  const expected = new Uint32Array(640 * 64); for (let y = 16; y < 32; y++) expected.fill(0x338844ff, y * 640 + 31 * 16, y * 640 + 33 * 16); assert.deepEqual(image.data, expected);
  await page.locator('#map-close').click(); await page.reload(); await expect(page.locator('[data-map-id]')).toHaveCount(1); await page.locator('[data-map-id]').click(); await expect(page.locator('#map-canvas')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => pixel(page, 32, 1)).toEqual([51, 136, 68, 255]); expect(errors).toEqual([]);
});

test('Map: partial stroke repaint and erase match a full viewport repaint before commit', async ({ page }) => {
  const d = await seed(page); await atlas(page, d); await map(page); await tile48(page); await page.locator('#map-grid').uncheck();
  const canvas = page.locator('#map-canvas');
  await canvas.evaluate((element: HTMLCanvasElement) => {
    element.dataset.observedPartialPaints = '0';
    new MutationObserver(() => {
      if (element.dataset.paintKind === 'partial') {
        element.dataset.observedPartialPaints = String(Number(element.dataset.observedPartialPaints) + 1);
      }
    }).observe(element, { attributes: true, attributeFilter: ['data-paint-kind'] });
  });
  const partialPaints = async () => Number(await canvas.getAttribute('data-observed-partial-paints'));
  const hash = () => canvas.evaluate(async (c: HTMLCanvasElement) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data))).join(','));
  async function fullWithSameGrid() {
    for (const checked of [true, false]) {
      const before = await canvas.getAttribute('data-paint-sequence');
      await page.locator('#map-grid').evaluate((e: HTMLInputElement, value) => { e.checked = value; e.dispatchEvent(new Event('change')); }, checked);
      await expect(canvas).not.toHaveAttribute('data-paint-sequence', before!); await expect(canvas).toHaveAttribute('data-paint-kind', 'full');
    }
  }
  await fullWithSameGrid();
  for (const tool of ['pen', 'erase']) {
    await page.locator(`[data-map-tool=${tool}]`).click();
    const start = await point(page, 2, 1), end = await point(page, 5, 1);
    const expected = tool === 'pen' ? [51, 136, 68, 255] : [0, 0, 0, 0];
    await page.mouse.move(start.x, start.y);
    const beforeStart = await partialPaints();
    await page.mouse.down();
    await expect.poll(partialPaints).toBeGreaterThan(beforeStart);
    await expect.poll(() => pixel(page, 2, 1)).toEqual(expected);
    const beforeEnd = await partialPaints();
    await page.mouse.move(end.x, end.y);
    await expect.poll(partialPaints).toBeGreaterThan(beforeEnd);
    await expect.poll(() => pixel(page, 5, 1)).toEqual(expected);
    const incremental = await hash();
    await fullWithSameGrid(); expect(await hash()).toBe(incremental); await page.mouse.up();
    await expect(canvas).toHaveAttribute('data-paint-kind', 'full');
  }
});

test('Map: selection/copy/paste/layers/lock retain exact IDs and portable ZIP', async ({ page }) => {
  const d = await seed(page); await atlas(page, d); await map(page); await tile48(page); await draw(page, 31, 1, 32, 1);
  await expect.poll(() => pixel(page, 31, 1)).toEqual([51, 136, 68, 255]);
  await expect.poll(() => pixel(page, 32, 1)).toEqual([51, 136, 68, 255]);
  await page.locator('[data-map-tool=select]').click(); await draw(page, 31, 1, 32, 1); await page.locator('#map-copy').click();
  await expect(page.locator('#map-message')).toHaveText('Đã sao chép 2×1 ô.');
  await expect(page.locator('#map-paste')).toBeEnabled(); await page.locator('#map-layer-add').click(); await page.locator('#map-paste').click();
  await page.locator('#map-layer-locked').check(); await page.locator('[data-map-tool=pen]').click(); await draw(page, 1, 1);
  await expect(page.locator('#map-message')).toContainText('khóa');
  const saved = await save(page, d.id), m = Object.values(saved.studio.mapIndex)[0] as any; expect(m.layers).toHaveLength(2); expect(m.layers[1].locked).toBe(true);
  const response = await page.request.post(`/api/pixel/projects/${d.id}/terrain/map-export`, { headers: { origin }, data: { revision: saved.revision, mapId: m.id, format: 'zip' } }); expect(response.ok()).toBeTruthy();
  const zip = unzipTestStored(await response.body()), portable = JSON.parse(zip['map.json'].toString('utf8')); expect(portable.layers[1].chunks).toHaveLength(2); expect(portable.layers[1].chunks[0].tiles[63]).toBe(48); expect(portable.layers[1].chunks[1].tiles[32]).toBe(48);
  expect(JSON.stringify(portable)).not.toContain('blob');
});

test('Map: Escape and focus loss cancel gesture; viewport stays bounded while zoom/pan', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 740 }); const d = await seed(page); await atlas(page, d); await map(page); await tile48(page);
  if (process.env.PXL_TERRAIN_LAYOUT_ROOT) { await page.locator('.map-inspector').evaluate(e => e.scrollTop = 0); await page.locator('#map-dialog').screenshot({ path: join(process.env.PXL_TERRAIN_LAYOUT_ROOT, 'map-narrow.png'), animations: 'disabled' }); }
  await draw(page, 3, 1, 5, 1, false); await page.keyboard.press('Escape'); await page.mouse.up(); await expect.poll(() => pixel(page, 3, 1)).toEqual([0, 0, 0, 0]);
  await draw(page, 3, 1, 5, 1, false); await page.locator('#map-name').focus(); await page.mouse.up(); await expect.poll(() => pixel(page, 3, 1)).toEqual([0, 0, 0, 0]);
  const canvas = page.locator('#map-canvas'), box = (await canvas.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -150);
  await expect(canvas).toHaveAttribute('data-zoom', '2');
  const size = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height, bw: c.getBoundingClientRect().width, bh: c.getBoundingClientRect().height })); expect(size.w).toBeLessThanOrEqual(Math.ceil(size.bw)); expect(size.h).toBeLessThanOrEqual(Math.ceil(size.bh));
  await canvas.focus(); await page.keyboard.down('Space'); await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 130, box.y + 120); await page.mouse.up(); await page.keyboard.up('Space');
  await page.locator('#map-fit').click(); await page.locator('#map-actual').click(); await draw(page, 3, 1); await expect.poll(() => pixel(page, 3, 1)).toEqual([51, 136, 68, 255]);
});

test('Map: Vietnamese draft survives external revision and blocks writes/export', async ({ page }) => {
  const d = await seed(page); await atlas(page, d); await map(page); await save(page, d.id);
  await page.locator('#map-name').fill('Rừng tiếng Việt đang nhập'); await page.locator('#map-name').dispatchEvent('compositionstart');
  const saved = await savedDoc(page, d.id), next = structuredClone(saved); next.name = 'Tab khác';
  const response = await page.request.put(`/api/pixel/projects/${d.id}`, { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: saved.revision, document: next }) }); expect(response.ok()).toBeTruthy();
  await expect(page.locator('#map-message')).toContainText('xung đột'); await expect(page.locator('#map-name')).toHaveValue('Rừng tiếng Việt đang nhập'); await expect(page.locator('[data-map-export=png]')).toBeDisabled();
  await page.locator('#map-name').press('Control+z'); expect((await savedDoc(page, d.id)).name).toBe('Tab khác'); await page.locator('#map-name').dispatchEvent('compositionend');
});

test('Map: late chunk rejection from map A cannot replace map B or its status', async ({ page }) => {
  const fixture = mapFixture(40, 4), stroke = new MapStroke(fixture, 'forest', getMap(fixture, 'forest').layers[0].id); stroke.set(31, 1, 48, false); stroke.commit();
  createMap(fixture, 'ground', 'B trống', 40, 4, 'second');
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ name: 'Hai bản đồ', document: fixture }) }); expect(response.ok()).toBeTruthy(); const doc = wireParse(await response.text());
  const ref = getMap(doc, 'forest').layers[0].chunks['0,0'];
  let release!: () => void, observed!: () => void; const held = new Promise<void>(r => release = r), started = new Promise<void>(r => observed = r);
  await page.route('**/api/pixel/projects/*/resource?**', async route => { const url = new URL(route.request().url()); if (url.searchParams.get('resource') !== ref) return route.continue(); observed(); await held; await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Lỗi A về muộn' }) }); });
  await page.goto('/'); await page.locator('#projects').selectOption(doc.id); await expect(page.locator('#map-editor-open')).toBeEnabled(); await page.locator('#map-editor-open').click(); await started;
  await page.locator('#map-list').selectOption('second'); await expect(page.locator('#map-name')).toHaveValue('B trống'); await expect(page.locator('#map-canvas')).toHaveAttribute('data-ready', 'true');
  release(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#map-name')).toHaveValue('B trống'); await expect(page.locator('#map-message')).not.toContainText('Lỗi A'); await expect(page.locator('#map-message')).not.toContainText('đã đổi');
});

test('Terrain: wrong-size source is blocked; closing reviewed preview discards only local proposal', async ({ page }) => {
  const doc = await seed(page); await page.locator('#terrain-editor-open').click(); await page.locator('#terrain-size').selectOption('32'); await expect(page.locator('#terrain-generate')).toBeDisabled(); await expect(page.locator('#terrain-message')).toContainText('không tự thu nhỏ');
  await page.locator('#terrain-size').selectOption('16'); await page.locator('#terrain-generate').click(); await expect(page.locator('#terrain-preview')).toBeVisible();
  await page.locator('#terrain-close').click(); await expect(page.locator('#terrain-dialog')).not.toBeVisible(); const after = await savedDoc(page, doc.id); expect(after.revision).toBe(doc.revision); expect(after.assets).toHaveLength(1);
});

test('Map: autotile loads its offscreen neighbor halo before a boundary stroke', async ({ page }) => {
  const doc = newDocument('Autotile ở mép', 256, 192, 0x338844ff), a = doc.assets[0];
  registerTileset(doc, a.id, a.frames[0].id, 32, 'Cỏ mép', 'ground'); createMap(doc, 'ground', 'Kề mép', 64, 4, 'forest');
  const s = new MapStroke(doc, 'forest', getMap(doc, 'forest').layers[0].id); s.set(32, 1, 1, false); s.commit();
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ name: doc.name, document: doc }) }); expect(response.ok()).toBeTruthy(); const saved = wireParse(await response.text());
  const rightRef = getMap(saved, 'forest').layers[0].chunks['1,0']; let rightRequested = false;
  page.on('request', request => { const u = new URL(request.url()); if (u.pathname.endsWith('/resource') && u.searchParams.get('resource') === rightRef) rightRequested = true; });
  await page.goto('/'); await page.locator('#projects').selectOption(saved.id); await expect(page.locator('#map-editor-open')).toBeEnabled(); await page.locator('#map-editor-open').click();
  await expect(page.locator('#map-canvas')).toHaveAttribute('data-ready', 'true'); expect(rightRequested).toBe(false);
  await page.locator('[data-map-tool=hand]').click(); const c = page.locator('#map-canvas'), box = (await c.boundingBox())!, width = await c.evaluate(e => e.clientWidth), desired = width - 32 * 32;
  await page.mouse.move(box.x + box.width / 2, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + desired, box.y + 100, { steps: 4 }); await page.mouse.up();
  await expect.poll(() => c.getAttribute('data-camera-x')).toBe(String(desired)); await expect(c).toHaveAttribute('data-ready', 'true'); expect(rightRequested).toBe(true);
  await page.locator('[data-map-tool=pen]').click(); await draw(page, 31, 1); await expect(page.locator('#map-message')).not.toContainText('tải khối');
  const after = await save(page, saved.id), layer = getMap(after, 'forest').layers[0];
  const chunk = async (key: string) => wireParse(await (await page.request.get(`/api/pixel/projects/${saved.id}/resource?revision=${after.revision}&resource=${layer.chunks[key]}`)).text());
  expect((await chunk('0,0')).data[63]).toBe(3); expect((await chunk('1,0')).data[32]).toBe(9);
});

test('Terrain: unused registration unlinks/undoes; named map dependencies block unlink', async ({ page }) => {
  const doc = await seed(page); await atlas(page, doc); await page.locator('#terrain-editor-open').click();
  await expect(page.locator('#terrain-registered option')).toHaveCount(1); await expect(page.locator('#terrain-unlink')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#terrain-unlink').click(); await expect(page.locator('#terrain-registered option')).toHaveCount(0);
  await page.locator('#terrain-registration-undo').click(); await expect(page.locator('#terrain-registered option')).toHaveCount(1); await page.locator('#terrain-close').click();
  await map(page, 'Bản đồ đang dùng cỏ'); await save(page, doc.id); await page.locator('#map-close').click(); await page.locator('#terrain-editor-open').click();
  await expect(page.locator('#terrain-dependents')).toContainText('Bản đồ đang dùng cỏ'); await expect(page.locator('#terrain-unlink')).toBeDisabled();
});
