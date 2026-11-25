import { test, expect, type Page } from '@playwright/test';
import { celFor, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { Img } from '../../src/studio/raster.ts';
import { encodePng } from '../../src/node/studio/png.ts';

test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) console.log('PIXEL DIAGNOSTIC', await page.evaluate(() => Object.fromEntries(['notice','save-status','ai-status','proposal-errors','proposal-description'].map(id => [id, window.document.getElementById(id)?.textContent])))); });
async function create(page: Page, name: string, size = 18): Promise<void> {
  await page.goto('/'); await page.locator('#new-project').click(); await page.locator('#new-name').fill(name); await page.locator('#size-preset').selectOption(String(size)); await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click(); await expect(page.locator('#canvas')).toBeVisible(); await expect(page.locator('#asset-info')).toContainText(`${size} × ${size}`);
}
async function document(page: Page): Promise<any> { const id = await page.locator('#projects').inputValue(); return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`,{maxRetries:2})).text()); }
async function color(page: Page, value: string) { await page.locator('#hex').fill(value); await page.locator('#hex').press('Tab'); }
async function paint(page: Page, x = 3, y = 3) { await page.locator('#canvas').click({ position: { x, y } }); }
async function firstPixel(page: Page, layer = 0, frame = 0, asset = 0, index = 0): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const d = await document(page), a = d.assets[asset], id = a.layers[layer]?.cels[a.frames[frame].id]; if (!id) return 0;
    const response = await page.request.get(`/api/pixel/projects/${d.id}/cel?asset=${a.id}&cel=${id}&revision=${d.revision}`);
    if (response.status() === 409) continue;
    const text = await response.text(); if (!response.ok()) throw new Error(text);
    return wireParse(text).data[index];
  }
  throw new Error('Không đọc được pixel trên một revision ổn định.');
}

test('Pixel: custom canvas → paint → layers/lock → undo → PNG → reopen', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await create(page, 'Mèo pixel'); await color(page, '#ff0000ff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
  await page.locator('[data-command="layer.add"]').click(); await color(page, '#0000ffff'); await paint(page); await expect.poll(() => firstPixel(page, 1)).toBe(0x0000ffff);
  const row = page.locator('#timeline tbody tr').first(); await row.getByTitle('Khóa/mở layer').click(); await color(page, '#00ff00ff'); await paint(page); await expect(page.locator('#notice')).toContainText('khóa'); expect(await firstPixel(page, 1)).toBe(0x0000ffff);
  await row.getByTitle('Khóa/mở layer').click(); await paint(page); await expect.poll(() => firstPixel(page, 1)).toBe(0x00ff00ff); await page.keyboard.press('Control+z'); await expect.poll(() => firstPixel(page, 1)).toBe(0x0000ffff);
  const dl = page.waitForEvent('download'); await page.locator('[data-export="png"]').click(); expect((await dl).suggestedFilename()).toBe('Sprite.png');
  await page.reload(); await expect(page.locator('#canvas')).toBeVisible(); expect(await firstPixel(page, 1)).toBe(0x0000ffff); expect(errors).toEqual([]);
});

test('Pixel: draggable splitters persist view sizes, clamp on resize and release capture on blur',async({page})=>{
  await create(page,'Kéo panel',64);await color(page,'#ff0000ff');await paint(page);await expect.poll(()=>firstPixel(page)).toBe(0xff0000ff);const revision=(await document(page)).revision;
  const h=page.locator('#timeline-splitter'),v=page.locator('#sidebar-splitter'),size=async(selector:string)=>(await page.locator(selector).boundingBox())!;
  const original=await size('#stage'),horizontal=await h.boundingBox();
  await page.mouse.move(horizontal!.x+horizontal!.width/2,horizontal!.y+4);await page.mouse.down();await page.mouse.move(horizontal!.x+horizontal!.width/2,horizontal!.y-96,{steps:8});await page.mouse.up();
  expect(Math.round((await size('#timeline')).height)).toBe(310);expect((await size('#stage')).height).toBeLessThan(original.height-90);
  const vertical=(await v.boundingBox())!;await page.mouse.move(vertical.x+4,vertical.y+60);await page.mouse.down();await page.mouse.move(vertical.x-96,vertical.y+60,{steps:8});await page.mouse.up();
  expect(Math.round((await size('.properties')).width)).toBe(460);expect((await document(page)).revision).toBe(revision);expect(await firstPixel(page)).toBe(0xff0000ff);
  await page.reload();await expect(page.locator('#canvas')).toBeVisible();expect(Math.round((await size('#timeline')).height)).toBe(310);expect(Math.round((await size('.properties')).width)).toBe(460);
  await h.focus();await page.keyboard.press('ArrowDown');expect(Math.round((await size('#timeline')).height)).toBe(300);
  await v.focus();await page.keyboard.press('ArrowRight');expect(Math.round((await size('.properties')).width)).toBe(450);
  await page.setViewportSize({width:1000,height:540});await expect.poll(async()=>Math.round((await size('#stage')).height)).toBeGreaterThanOrEqual(160);
  expect((await size('#timeline')).height).toBeLessThan(300);await page.setViewportSize({width:1440,height:960});
  await h.dblclick();await v.dblclick();expect(Math.round((await size('#timeline')).height)).toBe(210);expect(Math.round((await size('.properties')).width)).toBe(360);
  const b=(await h.boundingBox())!;await page.mouse.move(b.x+b.width/2,b.y+4);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y-25);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();await expect(page.locator('body')).not.toHaveAttribute('data-resizing');
  await page.locator('#actual').click();await color(page,'#0000ffff');await paint(page,.5,.5);await expect.poll(()=>firstPixel(page)).toBe(0x0000ffff);
});

test('Pixel: sidebar asset deletion targets its row, restores lazy animation with undo, and clears the last asset',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await create(page,'Xóa asset');await color(page,'#ff0000ff');await paint(page);await expect.poll(()=>firstPixel(page)).toBe(0xff0000ff);
  const first=(await document(page)).assets[0].id;await page.locator('#asset-add').click();await page.locator('#new-name').fill('Second');await page.locator('#create-form').getByRole('button',{name:'Tạo',exact:true}).click();await color(page,'#0000ffff');await paint(page);await page.locator('#frame-copy').click();
  await expect.poll(async()=>(await document(page)).assets[1]?.frames.length).toBe(2);await page.reload();await expect(page.locator('#canvas')).toBeVisible();await expect(page.locator('#asset-info')).toContainText('Sprite');
  await page.getByRole('button',{name:'Xóa asset Second',exact:true}).click();await expect.poll(async()=>(await document(page)).assets.length).toBe(1);await expect(page.locator('#asset-info')).toContainText('Sprite');expect(await firstPixel(page)).toBe(0xff0000ff);
  await page.keyboard.press('Control+z');await expect.poll(async()=>(await document(page)).assets.length).toBe(2);await page.locator('#asset-list').getByRole('button',{name:'Second',exact:true}).click();await expect(page.locator('#asset-info')).toContainText('2 frame');
  const d=await document(page),a=d.assets[1];for(const f of a.frames){const c=a.layers[0].cels[f.id],r=await page.request.get(`/api/pixel/projects/${d.id}/cel?asset=${a.id}&cel=${c}&revision=${d.revision}`,{maxRetries:2});expect(wireParse(await r.text()).data[0]).toBe(0x0000ffff);}
  await page.keyboard.press('Control+Shift+z');await expect.poll(async()=>(await document(page)).assets.length).toBe(1);
  await page.getByRole('button',{name:'Xóa asset Sprite',exact:true}).click();await expect.poll(async()=>(await document(page)).assets[0].id).not.toBe(first);expect(await firstPixel(page)).toBe(0);await expect(page.locator('#asset-status')).toContainText('canvas trống');
  await page.keyboard.press('Control+z');await expect.poll(async()=>(await document(page)).assets[0].id).toBe(first);expect(await firstPixel(page)).toBe(0xff0000ff);
  await page.keyboard.press('Control+y');await expect.poll(async()=>(await document(page)).assets[0].id).not.toBe(first);await page.reload();await expect(page.locator('#canvas')).toBeVisible();expect(await firstPixel(page)).toBe(0);expect(errors).toEqual([]);
});

test('Pixel: linked cel, unlink, timing/tag, onion, canvas resize and scale', async ({ page }) => {
  await create(page, 'Animation pixel', 64); await color(page, '#ff0000ff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
  await page.locator('#frame-link').click(); await expect.poll(async () => (await document(page)).assets[0].frames.length).toBe(2);
  await color(page, '#0000ffff'); await paint(page); await expect.poll(() => firstPixel(page, 0, 0)).toBe(0x0000ffff); expect(await firstPixel(page, 0, 1)).toBe(0x0000ffff);
  await page.locator('#cel-unlink').click(); await color(page, '#00ff00ff'); await paint(page); await expect.poll(() => firstPixel(page, 0, 1)).toBe(0x00ff00ff); expect(await firstPixel(page, 0, 0)).toBe(0x0000ffff);
  await page.locator('#duration').fill('170'); await page.locator('#duration').press('Tab'); await page.locator('#tag-edit').click(); await page.locator('#tag-name').fill('Đi bộ'); await page.locator('#tag-direction').selectOption('ping-pong'); await page.locator('#tag-loop').uncheck(); await page.locator('#tag-form').getByRole('button', { name: 'Lưu tag' }).click();
  await page.locator('#onion').check(); await page.locator('#canvas-resize').click(); await page.locator('#resize-width').fill('18'); await page.locator('#resize-height').fill('24'); await page.locator('[data-anchor="0,0"]').click(); await page.locator('#resize-form').getByRole('button', { name: 'Áp dụng', exact: true }).click(); await expect(page.locator('#asset-info')).toContainText('18 × 24');
  await page.locator('#image-scale').click(); await page.locator('#resize-width').fill('36'); await page.locator('#resize-height').fill('48'); await page.locator('#resize-form').getByRole('button', { name: 'Áp dụng', exact: true }).click(); await expect(page.locator('#asset-info')).toContainText('36 × 48');
  await expect.poll(async () => (await document(page)).assets[0].tags[0]?.name).toBe('Đi bộ'); const a = (await document(page)).assets[0]; expect(a.frames[1].duration).toBe(170); expect(a.layers[0].cels[a.frames[0].id]).not.toBe(a.layers[0].cels[a.frames[1].id]);
});

test('Pixel: shortcut settings, input contexts, temporary tool blur, floating paste and undo', async ({ page }) => {
  await create(page, 'Phím tắt'); await page.locator('#shortcuts').click(); await page.locator('[data-command-id="tool.pen"]').fill('e'); await page.locator('[data-command-id="tool.pen"]').press('Tab'); await expect(page.locator('#shortcut-errors')).toContainText('trùng'); await page.locator('[data-command-id="tool.pen"]').fill('b'); await page.locator('[data-command-id="tool.pen"]').press('Tab'); await page.locator('#shortcut-save').click();
  await page.locator('#canvas').focus(); await page.keyboard.press('e'); await expect(page.locator('[data-tool="erase"]')).toHaveClass(/active/); await page.keyboard.press('b'); await expect(page.locator('[data-tool="pen"]')).toHaveClass(/active/);
  await page.locator('#hex').focus(); await page.keyboard.press('e'); await expect(page.locator('[data-tool="pen"]')).toHaveClass(/active/); await color(page, '#ff0000ff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
  await page.keyboard.down('Alt'); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('Alt'); await color(page, '#0000ffff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0x0000ffff);
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await expect.poll(() => firstPixel(page)).toBe(0x0000ffff); await page.keyboard.press('Control+z'); await expect.poll(() => firstPixel(page)).toBe(0x0000ffff);
  await page.locator('#brush-size').fill('3'); await page.locator('#brush-size').press('Tab'); await page.reload(); await expect(page.locator('#canvas')).toBeVisible(); await page.locator('#canvas').focus(); await page.keyboard.press('e'); await page.keyboard.press('b'); await expect(page.locator('[data-tool="pen"]')).toHaveClass(/active/);
});

test('Pixel: stale tabs preserve a draft and Save copy retains all pixel data', async ({ page, context }) => {
  await create(page, 'Hai tab'); await color(page, '#ff0000ff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
  const second = await context.newPage(); await second.goto('/'); await expect(second.locator('#canvas')).toBeVisible();
  await page.locator('#hex').fill('#0000ffff'); await page.locator('#hex').press('Tab'); await paint(page); const old = await document(second);
  const response = await second.request.put(`/api/pixel/projects/${old.id}`, { headers: { origin: 'http://127.0.0.1:4329' }, data: { revision: old.revision, document: { ...old, name: 'External tab' } } }); expect(response.ok()).toBeTruthy();
  await expect(page.locator('#save-status')).toContainText('Xung đột'); await page.locator('#copy-project').click(); await expect(page.locator('#project-title')).toContainText('bản sao'); expect(await firstPixel(page)).toBe(0x0000ffff); await second.close();
});

test('Pixel: selecting a tool recovers drawing after the host swallows a temporary-tool keyup', async ({ page }) => {
  await create(page, 'Tool tạm bị kẹt'); await color(page, '#ff0000ff');
  await page.locator('#canvas').focus();
  await page.locator('#canvas').dispatchEvent('keydown', { key: ' ', code: 'Space', bubbles: true });
  await page.locator('[data-tool="erase"]').click(); await page.locator('[data-tool="pen"]').click();
  await paint(page); await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
  await page.locator('#canvas').dispatchEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true });
  await page.locator('[data-tool="line"]').click(); await page.locator('[data-tool="pen"]').click();
  await color(page, '#0000ffff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0x0000ffff);
  await color(page, '#ff0000ff'); await page.locator('#canvas').focus();
  await page.locator('#canvas').dispatchEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true });
  await paint(page); await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
});

test('Pixel: subtracting the entire selection does not leave an invisible mask blocking paint', async ({ page }) => {
  await create(page, 'Vùng chọn rỗng'); await page.locator('[data-tool="wand"]').click(); await paint(page);
  await page.keyboard.down('Alt'); await paint(page); await page.keyboard.up('Alt');
  await page.locator('[data-tool="pen"]').click(); await color(page, '#ff0000ff'); await paint(page);
  await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
});

test('Pixel: tool changes during a stroke release capture; a real selection remains visible and can be cleared', async ({ page }) => {
  await create(page, 'Đổi tool giữa nét'); await color(page, '#ff0000ff');
  const canvas = page.locator('#canvas'), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 3); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 10);
  await page.keyboard.press('e'); await page.mouse.up(); await page.keyboard.press('p'); await paint(page);
  await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);
  await page.locator('[data-tool="select"]').click(); await page.mouse.move(box.x + 3, box.y + 3); await page.mouse.down(); await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.up();
  await expect(page.locator('#deselect')).toBeVisible(); await expect(page.locator('#tool-hint')).toContainText('vùng chọn');
  await page.locator('#deselect').click(); await expect(page.locator('#deselect')).toBeHidden();
  await page.locator('[data-tool="pen"]').click(); await color(page, '#0000ffff'); await paint(page); await expect.poll(() => firstPixel(page)).toBe(0x0000ffff);
});

test('Pixel: default palette and view preferences persist without changing exported pixels', async ({ page }) => {
  await create(page, 'Màu và vùng vẽ');
  await expect(page.locator('#palette button')).toHaveCount(32);
  expect(Math.round((await page.locator('.properties').boundingBox())!.width)).toBe(360);
  await page.locator('#palette button').first().click(); await paint(page);
  await expect.poll(() => firstPixel(page)).toBe(0x10141fff);
  await color(page, '#123456ff'); await page.locator('#palette-add').click();
  await page.locator('#palette button').first().click(); await page.locator('#palette-delete').click();
  await page.locator('#palette-default').click();
  await expect(page.locator('#palette button')).toHaveCount(33);
  await expect.poll(async () => (await document(page)).assets[0].palette.includes(0x123456ff)).toBe(true);
  await page.locator('#appearance-panel summary').click();
  const revision = (await document(page)).revision;
  await page.locator('#workspace-color').fill('#667788');
  await page.locator('#checker-theme').selectOption('light');
  await page.locator('#sidebar-width').fill('440');
  await expect(page.locator('#stage')).toHaveCSS('background-color', 'rgb(102, 119, 136)');
  expect(Math.round((await page.locator('.properties').boundingBox())!.width)).toBe(440);
  const d = await document(page);
  const pngUrl = `/api/pixel/projects/${d.id}/export`;
  const request = { revision: d.revision, format: 'png', assetId: d.assets[0].id, frameId: d.assets[0].frames[0].id };
  const before = await page.request.post(pngUrl, { headers: { origin: 'http://127.0.0.1:4329' }, data: request }); expect(before.ok()).toBeTruthy();
  const bytes = await before.body();
  await page.reload(); await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#appearance-panel summary')).toBeVisible(); await page.locator('#appearance-panel summary').click();
  await expect(page.locator('#workspace-color')).toHaveValue('#667788'); await expect(page.locator('#checker-theme')).toHaveValue('light');
  expect(Math.round((await page.locator('.properties').boundingBox())!.width)).toBe(440);
  expect((await document(page)).revision).toBe(revision);
  await page.locator('#checker-theme').selectOption('dark');
  const after = await page.request.post(pngUrl, { headers: { origin: 'http://127.0.0.1:4329' }, data: request }); expect(after.ok()).toBeTruthy(); expect(await after.body()).toEqual(bytes);
  await expect(page.locator('#palette button')).toHaveCount(33);
  expect(await firstPixel(page)).toBe(0x10141fff);
  await page.locator('#appearance-reset').click(); await expect(page.locator('#sidebar-width')).toHaveValue('360');
  await page.setViewportSize({ width: 1000, height: 900 });
  expect((await page.locator('.properties').boundingBox())!.width).toBeGreaterThanOrEqual(320);
});

test('Pixel: PNG and sheet import keeps native pixels', async ({ page }) => {
  await create(page, 'Nhập sprite sheet'); const img = new Img(4, 2); img.data.fill(0xff0000ff); img.data[2] = 0x0000ffff; img.data[1] = 0x1c2d3e55;
  await page.locator('#png-input').setInputFiles({ name: 'Mèo.png', mimeType: 'image/png', buffer: encodePng(img) }); await page.locator('#import-sheet').check(); await page.locator('#import-width').fill('2'); await page.locator('#import-height').fill('2'); await page.locator('#import-form').getByRole('button', { name: 'Nhập ảnh', exact: true }).click(); await expect.poll(async () => (await document(page)).assets.length).toBe(2);
  await expect.poll(() => firstPixel(page, 0, 0, 1)).toBe(0xff0000ff);
  await expect.poll(() => firstPixel(page, 0, 1, 1)).toBe(0x0000ffff);
  await expect.poll(() => firstPixel(page, 0, 0, 1, 1)).toBe(0x1c2d3e55);
});

test('Pixel: restore old JSON draft and preserve new structured-clone draft pixels', async ({ page }) => {
  await create(page, 'Bản nháp tương thích');
  const saved = await document(page), asset = saved.assets[0];
  celFor(asset, asset.layers[0].id, asset.frames[0].id, true)!.data![0] = 0xa04020ff;
  const raw = wireStringify(saved);
  await page.evaluate(({ id, raw }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('pxl-pixel-drafts', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put(raw, id);
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), { id: saved.id, raw });
  await page.locator('#draft').click();
  await expect(page.locator('#save-status')).toContainText('Đã khôi phục bản nháp');
  await page.locator('header [data-command="file.save"]').click();
  await expect.poll(() => firstPixel(page)).toBe(0xa04020ff);
  await expect(page.locator('#save-status')).toContainText('Đã lưu');

  await page.route('**/api/pixel/projects/' + saved.id, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, json: { error: 'Fixture stale revision' } }) : route.continue());
  await color(page, '#360ac5ff');
  await paint(page);
  await expect.poll(() => page.evaluate(id => new Promise(resolve => {
    const open = indexedDB.open('pxl-pixel-drafts', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('drafts', 'readonly');
      const request = tx.objectStore('drafts').get(id);
      tx.oncomplete = () => {
        const asset = request.result?.assets?.[0];
        const cel = asset?.cels[asset.layers[0].cels[asset.frames[0].id]];
        resolve(cel?.data instanceof Uint32Array ? cel.data[0] : null);
        open.result.close();
      };
    };
  }), saved.id)).toBe(0x360ac5ff);
  await expect(page.locator('#save-status')).toContainText('Xung đột');
});
