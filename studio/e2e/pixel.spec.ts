import { test, expect, type Page } from '@playwright/test';
import { wireParse } from '../../src/studio/pixel/model.ts';
import { Img } from '../../src/core/image.ts';
import { encodePng } from '../../src/node/png.ts';

test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) console.log('PIXEL DIAGNOSTIC', await page.evaluate(() => Object.fromEntries(['notice','save-status','ai-status','proposal-errors','proposal-description'].map(id => [id, window.document.getElementById(id)?.textContent])))); });
async function create(page: Page, name: string, size = 18): Promise<void> {
  await page.goto('/'); await page.locator('#new-project').click(); await page.locator('#new-name').fill(name); await page.locator('#size-preset').selectOption(String(size)); await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click(); await expect(page.locator('#canvas')).toBeVisible(); await expect(page.locator('#asset-info')).toContainText(`${size} × ${size}`);
}
async function document(page: Page): Promise<any> { const id = await page.locator('#projects').inputValue(); return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`,{maxRetries:2})).text()); }
async function color(page: Page, value: string) { await page.locator('#hex').fill(value); await page.locator('#hex').press('Tab'); }
async function paint(page: Page, x = 3, y = 3) { await page.locator('#canvas').click({ position: { x, y } }); }
async function firstPixel(page: Page, layer = 0, frame = 0): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const d = await document(page), a = d.assets[0], id = a.layers[layer]?.cels[a.frames[frame].id]; if (!id) return 0;
    const response = await page.request.get(`/api/pixel/projects/${d.id}/cel?asset=${a.id}&cel=${id}&revision=${d.revision}`);
    if (response.status() === 409) continue;
    const text = await response.text(); if (!response.ok()) throw new Error(text);
    return wireParse(text).data[0];
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

test('Pixel: PNG/sheet import, graphical AI batch proposals both providers add only on Apply; zero code-editor controls on page', async ({ page }) => {
  await create(page, 'Nhập và AI'); const img = new Img(4, 2); img.data.fill(0xff0000ff); img.data[2] = 0x0000ffff;
  await page.locator('#png-input').setInputFiles({ name: 'Mèo.png', mimeType: 'image/png', buffer: encodePng(img) }); await page.locator('#import-sheet').check(); await page.locator('#import-width').fill('2'); await page.locator('#import-height').fill('2'); await page.locator('#import-form').getByRole('button', { name: 'Nhập ảnh', exact: true }).click(); await expect.poll(async () => (await document(page)).assets.length).toBe(2);

  // Assert NO CodeMirror editor or legacy code-panel in the main Studio editor
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('#code-panel')).toHaveCount(0);
  await expect(page.locator('#code-editor')).toHaveCount(0);

  // Open the graphical AI workspace
  await page.locator('#ai-open').click();
  await expect(page.locator('#generation-workspace')).toBeVisible();

  for (const provider of ['codex', 'deepseek']) {
    await page.locator('#provider').selectOption(provider);
    await page.locator('#ai-prompt').fill(`Create a small game sprite with ${provider}`);
    await page.locator('#ai-generate').click();

    // 3 candidate cards are present
    await expect(page.locator('.candidate-card')).toHaveCount(3);
    await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });

    // Choose non-first candidate (index 1) for codex
    if (provider === 'codex') {
      await expect(page.locator('.candidate-card[data-index="1"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
      await page.locator('.candidate-card[data-index="1"]').click();
      await expect(page.locator('.candidate-card[data-index="1"]')).toHaveClass(/selected/);
      await expect(page.locator('#proposal-description')).toContainText('alt=2');
    }

    // Verify document in store has NOT changed before explicit Apply
    expect((await document(page)).assets.length).toBe(provider === 'codex' ? 2 : 3);

    // Explicit Apply
    await expect(page.locator('#proposal-apply')).toBeEnabled();
    await page.locator('#proposal-apply').click();
    await expect.poll(async () => (await document(page)).assets.length).toBe(provider === 'codex' ? 3 : 4);
    await expect(page.locator('.workspace')).toHaveJSProperty('inert', false);

    if (provider === 'codex') {
      const d = await document(page);
      expect(d.assets[2].palette).toContain(0x3b82f6ff);
      await page.locator('#ai-open').click();
    }
  }
});

test('Pixel: DeepSeek text-only guard preserves ready proposals and explicit image options', async ({ page }) => {
  await create(page, 'DeepSeek capability', 32);
  await page.locator('#ai-open').click();
  await page.locator('#provider').selectOption('deepseek');
  await expect(page.locator('#provider-help')).toContainText('văn bản');
  let calls = 0;
  page.on('request', r => { if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) calls++; });
  await page.locator('#ai-prompt').fill('Create a tiny blue fantasy item');
  await page.locator('#ai-generate').click();
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#proposal')).toBeVisible();
  await expect(page.locator('#proposal-description')).toContainText('fixture alt=1;');
  await expect(page.locator('#proposal-apply')).toBeEnabled();
  const before = await document(page), description = await page.locator('#proposal-description').textContent();
  await page.locator('#ai-reference').check();
  await page.locator('#ai-generate').click();
  await expect(page.locator('#ai-modal-error')).toContainText('Hãy chọn Codex');
  await expect(page.locator('#provider')).toHaveValue('deepseek');
  await expect(page.locator('#ai-reference')).toBeChecked();
  await expect(page.locator('.candidate-card')).toHaveCount(3);
  await expect(page.locator('#proposal-description')).toHaveText(description!);
  await expect(page.locator('#proposal-apply')).toBeEnabled();
  expect(calls).toBe(1);
  const after = await document(page);
  expect(after.revision).toBe(before.revision); expect(after.assets).toHaveLength(1);
});

test('Pixel: changing provider clears checked status without automatic configuration or inference calls', async ({ page }) => {
  await create(page, 'Trạng thái provider'); await page.locator('#ai-open').click();
  let checks = 0, generations = 0;
  await page.route('**/api/studio/providers', route => {
    checks++; return route.fulfill({ json: { codex: { message: 'Đã kiểm tra Codex fixture' }, deepseek: { message: 'Đã cấu hình DeepSeek fixture; chưa gọi API' } } });
  });
  page.on('request', r => { if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) generations++; });
  await expect(page.locator('#provider-status')).toHaveText('Chưa kiểm tra cấu hình AI');
  await page.locator('#provider-check').click(); await expect(page.locator('#provider-status')).toHaveText('Đã kiểm tra Codex fixture');
  await page.locator('#provider').selectOption('deepseek');
  await expect(page.locator('#provider-status')).toHaveText('Chưa kiểm tra cấu hình AI');
  expect(checks).toBe(1); expect(generations).toBe(0);
  await page.locator('#provider-check').click(); await expect(page.locator('#provider-status')).toContainText('chưa gọi API');
  expect(checks).toBe(2); expect(generations).toBe(0);
});

test('Pixel: unknown cancellation offers explicit same-batch confirmation without another generation', async ({ page }) => {
  await create(page, 'Xác nhận hủy HTTP', 32);
  const before = await document(page), canceledIds: string[] = [];
  await page.route('**/generation-batches/*/cancel', async route => {
    canceledIds.push(route.request().url());
    if (canceledIds.length > 1) { await route.continue(); return; }
    const batch = await (await page.request.get(route.request().url().replace(/\/cancel$/, ''))).json();
    batch.status = 'unknown'; batch.candidates[0].status = 'unknown';
    await route.fulfill({ json: batch });
  });
  let generations = 0;
  page.on('request', r => { if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) generations++; });
  await page.locator('#ai-open').click(); await page.locator('#provider').selectOption('deepseek');
  await page.locator('#ai-prompt').fill('FIXTURE_HANG'); await page.locator('#ai-generate').click();
  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toContainText('Đang tạo');
  await page.locator('#ai-cancel').click();
  await expect(page.locator('#ai-cancel')).toHaveText('Kiểm tra lại việc hủy');
  await expect(page.locator('#ai-cancel')).toBeEnabled(); await expect(page.locator('#ai-generate')).toBeDisabled();
  await page.locator('#ai-cancel').click();
  await expect(page.locator('#ai-status')).toContainText('Đợt tạo đã hủy');
  await expect(page.locator('#ai-generate')).toBeEnabled();
  expect(canceledIds).toHaveLength(2); expect(canceledIds[0]).toBe(canceledIds[1]); expect(generations).toBe(1);
  expect((await document(page)).revision).toBe(before.revision);
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

test('Pixel: AI presets → warnings/native zoom → apply; blank/wrong-size proposals stay blocked', async ({ page }) => {
  await create(page, 'Chất lượng AI'); await page.locator('#ai-open').click();
  await expect(page.locator('#ai-reference')).not.toBeChecked();
  await page.locator('#ai-style').selectOption('eight-bit'); await page.locator('#ai-view').selectOption('top-down'); await page.locator('#ai-palette').selectOption('auto16');
  await page.locator('#ai-prompt').fill('FIXTURE_MANY_COLORS'); await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#proposal-description')).toContainText('calls=1; preview=false');
  await expect(page.locator('#proposal-settings')).toContainText('8-bit tối giản'); await expect(page.locator('#proposal-settings')).toContainText('Từ trên xuống');
  await expect(page.locator('#proposal-stats')).toContainText('18×18'); await expect(page.locator('#proposal-warnings')).toContainText('17 màu');
  await expect(page.locator('#proposal-apply')).toBeEnabled(); expect((await document(page)).assets.length).toBe(1);
  await page.locator('#proposal-zoom').selectOption('1'); expect((await page.locator('#after').boundingBox())!.width).toBe(18);
  await page.locator('#proposal-zoom').selectOption('4'); expect((await page.locator('#after').boundingBox())!.width).toBe(72);
  await expect(page.locator('#after')).toHaveCSS('image-rendering', 'pixelated');
  const applied = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/apply-proposal'));
  await page.locator('#proposal-apply').click(); expect((await applied).ok()).toBeTruthy(); await expect.poll(async () => (await document(page)).assets.length).toBe(2);
  await expect(page.locator('.workspace')).toHaveJSProperty('inert', false); expect((await document(page)).assets[1].palette.length).toBe(18); await expect(page.locator('#palette button')).toHaveCount(18);

  await page.locator('#ai-open').click();
  for (const [prompt, message] of [['FIXTURE_OUTLINE', 'Kích thước'], ['FIXTURE_EMPTY', 'Ảnh rỗng']]) {
    await page.locator('#ai-prompt').fill(prompt); await page.locator('#ai-generate').click();
    await expect(page.locator('.candidate-card .card-msg').first()).toContainText(message,{timeout:20000});
    await expect(page.locator('.candidate-retry:visible')).toHaveCount(3,{timeout:20000});await expect(page.locator('#proposal-apply')).toBeDisabled();
    for(const card of await page.locator('.candidate-card').all())await expect(card.locator('.card-calls')).toContainText('2 lần gọi CLI');
    expect((await document(page)).assets.length).toBe(2);
  }
  await page.locator('#ai-reference').check(); await page.locator('#ai-prompt').fill('FIXTURE_ALPHA'); await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 }); await expect(page.locator('#proposal-description')).toContainText('preview=true');
  await expect(page.locator('#proposal-warnings')).toContainText('bán trong suốt'); await expect(page.locator('#proposal-apply')).toBeEnabled();
});

test('Pixel: prompt library previews/customizes/undoes without AI calls and uses the current canvas', async ({ page }) => {
  await create(page, 'Mẫu prompt'); await page.locator('#ai-open').click();
  const sent: any[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) sent.push(r.postDataJSON()); });
  const initial = await document(page);
  await page.locator('#ai-prompt').fill('Mô tả đang viết dở'); await page.locator('#ai-style').selectOption('flat-icon'); await page.locator('#ai-view').selectOption('side'); await page.locator('#ai-palette').selectOption('auto16'); await page.locator('#ai-reference').check();
  await page.locator('#prompt-library-panel summary').click(); await expect(page.locator('#prompt-template option')).toHaveCount(11);
  await page.locator('#prompt-template').selectOption('hero'); await page.locator('#template-subject').fill('mèo xanh với khăn đỏ');
  await expect(page.locator('#template-preview')).toHaveValue(/mèo xanh với khăn đỏ/); await expect(page.locator('#template-preview')).toHaveValue(/18×18/);
  await expect(page.locator('#ai-prompt')).toHaveValue('Mô tả đang viết dở'); await expect(page.locator('#ai-style')).toHaveValue('flat-icon');
  await page.locator('#template-use').click(); await expect(page.locator('#ai-prompt')).toHaveValue(/mèo xanh với khăn đỏ/);
  await expect(page.locator('#ai-style')).toHaveValue('game'); await expect(page.locator('#ai-view')).toHaveValue('front'); await expect(page.locator('#ai-reference')).not.toBeChecked(); await expect(page.locator('#ai-palette')).toHaveValue('auto16');
  await page.locator('#template-undo').click(); await expect(page.locator('#ai-prompt')).toHaveValue('Mô tả đang viết dở'); await expect(page.locator('#ai-style')).toHaveValue('flat-icon'); await expect(page.locator('#ai-view')).toHaveValue('side'); await expect(page.locator('#ai-reference')).toBeChecked();
  await page.locator('#prompt-template').selectOption('idle'); await expect(page.locator('#template-preview')).toHaveValue(/4 frame/); await expect(page.locator('#template-preview')).toHaveValue(/100 ms/);
  await page.locator('#ai-reference').uncheck(); await page.locator('#prompt-template').selectOption('recolor'); await page.locator('#template-use').click(); await expect(page.locator('#ai-reference')).toBeChecked(); await expect(page.locator('#template-tip')).toContainText('không bảo đảm'); await page.locator('#template-undo').click(); await expect(page.locator('#ai-reference')).not.toBeChecked();
  expect(sent).toEqual([]); expect((await document(page)).revision).toBe(initial.revision);
  await page.locator('#ai-close').click();
  await page.locator('#canvas-resize').click(); await page.locator('#resize-width').fill('64'); await page.locator('#resize-height').fill('48'); await page.locator('#resize-form').getByRole('button', { name: 'Áp dụng', exact: true }).click();
  await page.locator('#ai-open').click();
  await page.locator('#prompt-template').selectOption('potion'); await expect(page.locator('#template-preview')).toHaveValue(/64×48/); await expect(page.locator('#template-context')).toContainText('Canvas đang dùng: 64×48');
  await page.locator('#template-use').click(); await expect(page.locator('#ai-prompt')).toHaveValue(/64×48/); expect(sent).toEqual([]);
  await page.locator('#ai-generate').click(); await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });
  expect(sent.length).toBe(1); expect(sent[0].prompt).toContain('bình hồi máu'); expect(sent[0].generationOptions).toEqual({ style: 'flat-icon', view: 'description', paletteMode: 'auto16', reference: false });
  await expect(page.locator('#proposal-stats')).toContainText('64×48'); expect((await document(page)).assets.length).toBe(1);
});

test('Pixel: palette normalization keeps the original, previews differences and applies only the selected variant', async ({ page }) => {
  await create(page, 'Chuẩn hóa palette'); await page.locator('#ai-open').click();
  let calls=0;page.on('request',r=>{if(r.method()==='POST'&&/\/generation-batches$/.test(r.url()))calls++;});
  await page.locator('#ai-palette').selectOption('auto16');await page.locator('#ai-prompt').fill('FIXTURE_MANY_COLORS');await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({timeout:20000});await expect(page.locator('#after')).toHaveJSProperty('width',18);
  const raw=await page.locator('#proposal-variant').inputValue();
  await page.locator('#proposal-normalize').click();await expect(page.locator('#processing-status')).toContainText('Đã chuẩn hóa',{timeout:20000});
  expect(await page.locator('#proposal-variant').inputValue()).not.toBe(raw);await expect(page.locator('#proposal-stats')).toContainText('Màu 17 → 16');
  await page.locator('#proposal-overlay').selectOption('difference');await expect(page.locator('#proposal-frame-status')).toContainText('đánh dấu');
  await page.locator('#proposal-variant').selectOption(raw);await expect(page.locator('#proposal-warnings')).toContainText('17 màu');
  await page.locator('#proposal-variant').selectOption({label:'Đã chuẩn hóa · alpha 128'});await page.locator('#proposal-overlay').selectOption('');
  await page.locator('#proposal-apply').click();await expect.poll(async()=>(await document(page)).assets.length).toBe(2);
  const d=await document(page);expect(d.assets[1].provenance.kind).toBe('normalized');expect(d.assets[1].palette.filter((p:number)=>p&255)).toHaveLength(16);expect(calls).toBe(1);
  await page.reload();await expect(page.locator('#canvas')).toBeVisible();expect((await document(page)).assets[1].provenance.alphaThreshold).toBe(128);
});

for(const mode of ['region','whole'] as const)test(`Pixel: ${mode} animation from selected frame → lazy preview → normalization → apply`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));let calls=0;page.on('request',r=>{if(r.method()==='POST'&&/\/generation-batches$/.test(r.url()))calls++;});
  await create(page,`Animation ${mode}`);await color(page,'#70c989ff');await paint(page);await expect.poll(()=>firstPixel(page)).toBe(0x70c989ff);
  await page.locator('#ai-open').click();await page.locator('#ai-palette').selectOption('auto16');
  await page.locator('#ai-animate').click();await expect(page.locator('#animation-create')).toBeDisabled();await expect(page.locator('#animation-region-status')).toContainText('Chưa chọn vùng');
  if(mode==='region'){
    await page.locator('#animation-close').click();await page.locator('#ai-close').click();await page.locator('[data-tool="select"]').click();const b=(await page.locator('#canvas').boundingBox())!,s=b.width/18;
    await page.mouse.move(b.x+9.2*s,b.y+9.2*s);await page.mouse.down();await page.mouse.move(b.x+9.6*s,b.y+9.6*s);await page.mouse.up();await page.locator('#ai-open').click();await page.locator('#ai-animate').click();
  }else await page.locator('#animation-mode').selectOption('whole');
  await expect(page.locator('#animation-create')).toBeEnabled();await page.locator('#animation-motion').fill(mode==='region'?'blink':'walk');await page.locator('#animation-duration').fill('120');await page.locator('#animation-loop').uncheck();
  await page.locator('#animation-create').click();await expect(page.locator('#animation-dialog')).not.toBeVisible();await expect(page.locator('#proposal')).toBeVisible({timeout:20000});
  await expect(page.locator('#proposal-description')).toContainText('calls=1');await expect(page.locator('#proposal-frame option')).toHaveCount(4);
  if(mode==='region'){
    const protectedId=await page.locator('#proposal-variant').inputValue();await expect(page.locator('#proposal-variant option:checked')).toHaveText('Đã khóa vùng');
    await page.locator('#proposal-variant').selectOption({label:'AI gốc · chỉ xem'});await expect(page.locator('#proposal-apply')).toBeDisabled();await page.locator('#proposal-variant').selectOption(protectedId);
    await page.locator('#proposal-overlay').selectOption('movement');await expect(page.locator('#proposal-frame-status')).toContainText('đánh dấu 1');
  }
  await page.locator('#proposal-frame').selectOption('1');await expect(page.locator('#proposal-frame-status')).toContainText('Frame 2/4 · 120 ms');
  await expect(page.locator('#proposal-after-label')).toContainText('frame 2');
  await page.locator('#proposal-onion').check();await page.locator('#proposal-anchor').check();await page.locator('#proposal-play').click();await expect(page.locator('#proposal-play')).toHaveText('▶ Phát preview',{timeout:10000});
  await page.locator('#proposal-normalize').click();await expect(page.locator('#processing-status')).toContainText('Đã chuẩn hóa',{timeout:20000});
  await page.locator('#proposal-apply').click();await expect.poll(async()=>(await document(page)).assets.length).toBe(2);const d=await document(page),a=d.assets[1];
  expect(a.frames.map((f:any)=>f.duration)).toEqual([120,120,120,120]);expect(a.tags[0].loop).toBe(false);expect(a.metadata.pivot).toEqual({x:.5,y:1});expect(calls).toBe(1);
  if(mode==='region'){const cel=a.cels[a.layers[0].cels[a.frames[2].id]],r=await page.request.get(`/api/pixel/projects/${d.id}/cel?asset=${a.id}&cel=${cel.id}&revision=${d.revision}`),pixels=wireParse(await r.text()).data;for(let i=0;i<324;i++)if(i!==9*18+9)expect(pixels[i]).toBe(i===0?0x70c989ff:0);}
  const download=page.waitForEvent('download');await page.locator('[data-export="png"]').click();expect((await download).suggestedFilename()).toMatch(/\.png$/);
  await page.reload();await expect(page.locator('#canvas')).toBeVisible();expect((await document(page)).assets[1].frames).toHaveLength(4);expect(errors).toEqual([]);
});

test('Pixel: partial retry and cancel handle honest batch status without auto-apply', async ({ page }) => {
  await create(page, 'Thử lại và Hủy');
  await page.locator('#ai-open').click();

  // 1. Partial failure on candidate 2 (altIndex 2)
  await page.locator('#ai-prompt').fill('FIXTURE_SECOND_FAILS_FAIL_ONCE warrior');
  await page.locator('#ai-generate').click();

  // Wait for candidate 2 to fail
  await expect(page.locator('.candidate-card[data-index="1"] .card-status')).toContainText('Thất bại', { timeout: 20000 });
  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toContainText('Sẵn sàng');
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toContainText('Sẵn sàng');
  await expect(page.locator('#ai-status')).toContainText('hoàn thành một phần');

  // Retry candidate 2
  await page.locator('.candidate-card[data-index="1"] .candidate-retry').click();
  await expect(page.locator('.candidate-card[data-index="1"] .card-status')).toContainText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('#ai-status')).toContainText('Hoàn thành 3 phương án');

  // 2. Cancellation on candidate 2 hang
  await page.locator('#ai-prompt').fill('FIXTURE_HANG_2 hanging batch');
  await page.locator('#ai-generate').click();

  await expect(page.locator('.candidate-card[data-index="1"] .card-status')).toContainText('Đang tạo…', { timeout: 20000 });
  const projectId = await page.locator('#projects').inputValue();
  const hangingBatch = async () => (await (await page.request.get(`/api/pixel/projects/${projectId}/generation-batches`)).json()).find((b: any) => b.prompt === 'FIXTURE_HANG_2 hanging batch');
  await expect.poll(async () => (await hangingBatch())?.candidates[1].cliExecutions).toBe(1);
  await page.locator('#ai-cancel').click();
  await expect(page.locator('#ai-status')).toContainText(/Đợt tạo đã (?:bị )?hủy/);
  const canceled = await hangingBatch(); expect(canceled.status).toBe('canceled');
  expect(canceled.candidates.map((c: any) => c.status)).toEqual(['ready', 'canceled', 'canceled']);
  expect(canceled.candidates.map((c: any) => c.cliExecutions)).toEqual([1, 1, 0]);
  await expect(page.locator('#proposal-apply')).toBeDisabled();
});

test('Pixel: save project art direction persists to document and undoes safely', async ({ page }) => {
  await create(page, 'Chỉ đạo nghệ thuật');
  await page.locator('#ai-open').click();

  await page.locator('#ai-style').selectOption('eight-bit');
  await page.locator('#ai-light').fill('top');
  await page.locator('#ai-detail-level').selectOption('high');
  await page.locator('#ai-outline').fill('colored');

  await page.locator('#save-art-direction').click();
  await expect(page.locator('#art-direction-status')).toContainText('Đã lưu phong cách');

  const d = await document(page);
  expect(d.studio.version).toBe(1);
  expect(d.studio.artDirection.style).toBe('eight-bit');
  expect(d.studio.artDirection.light).toBe('top');
  expect(d.studio.artDirection.detailLevel).toBe('high');
  expect(d.studio.artDirection.outline).toBe('colored');

  await page.locator('#ai-close').click();
  await page.keyboard.press('Control+z');

  await expect.poll(async () => (await document(page)).studio?.artDirection).toBeUndefined();
  const undone = await document(page);
  expect(undone.studio.version).toBe(1);
  expect(undone.studio.artDirection).toBeUndefined();

  await page.locator('#ai-open').click();
  await expect(page.locator('#ai-style')).toHaveValue('game');
  await page.locator('#ai-close').click();
});

test('Pixel: closing AI workspace stops preview, keeps canvas paintable; second asset uses its own dimensions', async ({ page }) => {
  await create(page, 'Đóng AI và vẽ');
  await page.locator('#ai-open').click();
  await expect(page.locator('#generation-workspace')).toBeVisible();

  // Close workspace and paint
  await page.locator('#ai-close').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();
  await color(page, '#ff0000ff');
  await paint(page);
  await expect.poll(() => firstPixel(page)).toBe(0xff0000ff);

  // Add a second asset with 32x32 dimensions
  await page.locator('#asset-add').click();
  await page.locator('#new-name').fill('Asset32');
  await page.locator('#size-preset').selectOption('32');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#asset-info')).toContainText('32 × 32');

  // Open AI workspace and verify captured dimensions match active asset
  await page.locator('#ai-open').click();
  await expect(page.locator('#ai-context-info')).toContainText('32×32');

  let sentBatch: any = null;
  page.on('request', r => {
    if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) {
      sentBatch = r.postDataJSON();
    }
  });

  await page.locator('#ai-prompt').fill('Thùng gỗ 32x32');
  await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });
  expect(sentBatch).not.toBeNull();
  const docCurrent = await document(page);
  const secondAsset = docCurrent.assets.find((a: any) => a.name === 'Asset32');
  expect(sentBatch.assetId).toBe(secondAsset.id);
  await expect(page.locator('#proposal-stats')).toContainText('32×32');
  await expect(page.locator('#after')).toHaveJSProperty('width', 32);
  await expect(page.locator('#after')).toHaveJSProperty('height', 32);
  await page.locator('#ai-close').click();
});

test('Pixel: standalone normalize-reference previews from current frame and applies', async ({ page }) => {
  await create(page, 'Chuẩn hóa mẫu độc lập');
  await color(page, '#70c989ff');
  await paint(page);
  await expect.poll(() => firstPixel(page)).toBe(0x70c989ff);

  await page.locator('#ai-open').click();
  await page.locator('#normalize-reference').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#proposal-description')).toContainText('Mẫu chuẩn từ frame hiện tại');
  await page.locator('#proposal-normalize').click();
  await expect(page.locator('#processing-status')).toContainText('Đã chuẩn hóa', { timeout: 20000 });
  await expect(page.locator('#proposal-apply')).toBeEnabled();

  await page.locator('#proposal-apply').click();
  await expect.poll(async () => (await document(page)).assets.length).toBe(2);
  const d = await document(page);
  expect(d.assets[1].provenance?.kind).toBe('normalized');
});

test('Pixel: delayed-preview selection race keeps latest selected candidate', async ({ page }) => {
  await create(page, 'Đua chọn preview');
  await page.locator('#ai-open').click();
  await page.locator('#ai-prompt').fill('FIXTURE_DELAY Đua chọn preview');
  await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });

  // Wait until candidates 1 and 2 are ready
  await expect(page.locator('.candidate-card[data-index="1"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 20000 });

  // Delay the second candidate response until after the third is fully displayed.
  // This exercises an actual out-of-order response, rather than just two quick clicks.
  const d0 = await document(page);
  const batches = await (await page.request.get(`/api/pixel/projects/${d0.id}/generation-batches`)).json();
  const secondId = batches.at(-1).candidates[1].id;
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let delayed = false;
  await page.route(`**/candidates/${secondId}/preview`, async route => {
    const response = await route.fetch();
    delayed = true;
    await held;
    await route.fulfill({ response });
  });
  await page.locator('.candidate-card[data-index="1"]').click();
  await expect.poll(() => delayed).toBe(true);
  await expect(page.locator('#proposal-apply')).toBeDisabled();
  await page.locator('.candidate-card[data-index="2"]').click();
  await expect(page.locator('.candidate-card[data-index="2"]')).toHaveClass(/selected/);
  await expect(page.locator('#proposal-description')).toContainText('alt=3', { timeout: 20000 });
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#proposal-description')).toContainText('alt=3');

  // Applying candidate 2 applies candidate 3 (red #ef4444)
  await page.locator('#proposal-apply').click();
  await expect.poll(async () => (await document(page)).assets.length).toBe(2);
  const d = await document(page);
  expect(d.assets[1].palette).toContain(0xef4444ff);
});

test('Pixel: reload restores ready batch proposals on workspace open', async ({ page }) => {
  await create(page, 'Khôi phục batch khi reload');
  await page.locator('#ai-open').click();
  await page.locator('#ai-prompt').fill('Sprite tái nạp');
  await page.locator('#ai-generate').click();
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toHaveText('Sẵn sàng');

  // Reload the page
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();

  // Re-open AI workspace and assert proposals are restored from server
  await page.locator('#ai-open').click();
  await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toHaveText('Sẵn sàng');
  await expect(page.locator('#proposal-apply')).toBeEnabled();
});
