import { test, expect, type Page } from '@playwright/test';
import { newDocument, celFor, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { createCharacterProfile, addCharacterLandmark, addCharacterLink, approveCharacterProfile } from '../../src/studio/character-commands.ts';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:4329';
async function captureLayout(page: Page, name: string) {
  const root = process.env.PXL_CLIP_LAYOUT_ROOT; if (!root) return;
  await expect.poll(() => page.locator('.clip-slot canvas').first().evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    return data.some((value, index) => index % 4 === 3 && value !== 0);
  })).toBe(true);
  await page.locator('#clip-dialog').screenshot({ path: join(root, name), animations: 'disabled' });
}
async function seed(page: Page, withSecond = false) {
  const doc = newDocument('Clip Editor độc lập', 18, 18), a = doc.assets[0];
  a.palette = [0xff0000ff, 0xffffffff, 0];
  const pixels = celFor(a, a.layers[0].id, a.frames[0].id, true)!.data!;
  for (let y = 3; y < 16; y++) for (let x = 2; x < 15; x++) pixels[y * 18 + x] = 0xff0000ff;
  pixels[5 * 18 + 5] = 0xffffffff;
  const profile = createCharacterProfile(doc, { id: 'hero', name: 'Nhân vật đỏ', assetId: a.id, frameId: a.frames[0].id });
  addCharacterLandmark(doc, profile.id, 'hand', { name: 'Tay', x: 5, y: 5 });
  addCharacterLandmark(doc, profile.id, 'foot', { name: 'Chân', x: 10, y: 15 });
  addCharacterLink(doc, profile.id, 'hand', 'foot'); approveCharacterProfile(doc, profile.id);
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' },
    data: wireStringify({ name: doc.name, document: doc }) });
  expect(response.ok(), await response.text()).toBeTruthy(); const saved = wireParse(await response.text());
  let second: any;
  if (withSecond) {
    const copy = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' },
      data: wireStringify({ name: 'Dự án B độc lập', sourceProjectId: saved.id, document: saved }) });
    expect(copy.ok(), await copy.text()).toBeTruthy(); second = wireParse(await copy.text());
  }
  await page.goto('/'); await expect(page.locator(`#projects option[value="${saved.id}"]`)).toHaveCount(1);
  await page.locator('#projects').selectOption(saved.id); await expect(page.locator('#canvas')).toBeVisible();
  return { saved, second, pixels: pixels.slice() };
}
async function savedDoc(page: Page, id: string) { return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`)).text()); }
async function createClip(page: Page, mode = 'whole') {
  await page.locator('#clip-editor-open').click(); await expect(page.locator('#clip-dialog')).toBeVisible();
  await page.locator('#clip-mode').selectOption(mode);
  await page.locator('#clip-new-name').fill('Bước đi');
  await page.locator('#clip-create-submit').click();
  await expect(page.locator('[data-clip-slot]')).toHaveCount(4);
  await expect(page.locator('#clip-name')).toHaveValue('Bước đi');
  await expect(page.locator('#clip-generate')).toBeEnabled();
}

test('Clip Editor: create → one-gesture pose/undo → timing/freeze/K1 → Codex guide → apply/reopen', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const { saved, pixels } = await seed(page); await createClip(page);
  await captureLayout(page, 'clip-wide.png');
  await page.locator('#clip-landmark').selectOption('hand');
  const canvas = page.locator('#clip-pose-canvas'), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 5.5 / 18 * box.width, box.y + 5.5 / 18 * box.height);
  await page.mouse.down(); await page.mouse.move(box.x + 7.5 / 18 * box.width, box.y + 6.5 / 18 * box.height, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('#clip-pose-x')).toHaveValue('7'); await expect(page.locator('#clip-pose-y')).toHaveValue('6');
  await page.locator('#clip-undo').click(); await expect(page.locator('#clip-pose-x')).toHaveValue('5');
  await page.locator('#clip-redo').click(); await expect(page.locator('#clip-pose-x')).toHaveValue('7');
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('Thay pixel nền'); await dialog.accept(); });
  await page.locator('#clip-slot-capture').click(); await expect(page.locator('#clip-slot-keyframe')).toBeChecked();
  await page.locator('#clip-slot-frozen').check(); await expect(page.locator('#clip-slot-selected')).toBeDisabled();
  for (const index of [1, 3]) { await page.locator('[data-clip-slot]').nth(index).click(); await page.locator('#clip-slot-selected').uncheck(); }
  await page.locator('[data-clip-slot]').nth(2).click();
  await page.locator('#clip-slot-duration').fill('180'); await page.locator('#clip-duration-save').click();
  await page.locator('#clip-slot-keyframe').check();
  await page.locator('#clip-loop').uncheck(); await page.locator('#clip-facing').selectOption('left');
  const originalSlot = await page.locator('[data-clip-slot].active').getAttribute('data-clip-slot');
  await page.locator('#clip-slot-prev').click();
  await expect(page.locator('[data-clip-slot]').nth(1)).toHaveAttribute('data-clip-slot', originalSlot!);
  await page.locator('#clip-slot-next').click();
  await expect(page.locator('[data-clip-slot]').nth(2)).toHaveAttribute('data-clip-slot', originalSlot!);
  await page.locator('#clip-slot-duplicate').click(); await expect(page.locator('[data-clip-slot]')).toHaveCount(5);
  await page.locator('#clip-slot-remove').click(); await expect(page.locator('[data-clip-slot]')).toHaveCount(4);
  await page.locator('#clip-slot-add').click(); await expect(page.locator('[data-clip-slot]')).toHaveCount(5);
  await page.locator('#clip-slot-remove').click(); await expect(page.locator('[data-clip-slot]')).toHaveCount(4);
  await page.locator(`[data-clip-slot="${originalSlot}"]`).click();
  await page.locator('#clip-provider').selectOption('deepseek');
  await expect(page.locator('#clip-provider-info')).toContainText('Chọn Codex');
  await expect(page.locator('#clip-generate')).toBeDisabled();
  expect(await (await page.request.get(`/api/pixel/projects/${saved.id}/generation-batches`)).json()).toEqual([]);
  await page.locator('#clip-provider').selectOption('codex'); await page.locator('#clip-motion').fill('Chớp mắt nhẹ, giữ thiết kế và pixel ngoài vùng.');
  const request = page.waitForRequest(r => r.method() === 'POST' && /\/generation-batches$/.test(r.url()));
  await page.locator('#clip-generate').click();
  const body = (await request).postDataJSON(); expect(body.clipGeneration.clipId).toBeTruthy(); expect(body.provider).toBe('codex');
  expect(body.generationOptions.paletteMode).toBe('asset');
  await expect(page.locator('#clip-dialog')).toBeHidden(); await expect(page.locator('#generation-workspace')).toBeVisible();
  await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 25000 });
  await expect(page.locator('#proposal-apply')).toBeEnabled(); await expect(page.locator('#proposal-asset-kind')).toHaveValue('character');
  const original = await savedDoc(page, saved.id), clip = original.studio.clips[body.clipGeneration.clipId];
  expect(clip.slots.filter((s: any) => s.selected)).toHaveLength(1); expect(clip.slots[0].frozen).toBe(true); expect(clip.slots[2].duration).toBe(180);
  await page.locator('#proposal-apply').click(); await expect(page.locator('#generation-workspace')).toBeHidden();
  const after = await savedDoc(page, saved.id), asset = after.assets.at(-1);
  expect(after.assets).toHaveLength(2); expect(asset.frames.map((f: any) => f.duration)).toEqual([100, 100, 180, 100]);
  expect(asset.tags[0].loop).toBe(false); expect(clip.facing).toBe('left');
  expect(asset.provenance.batch.config.clip.clipId).toBe(clip.id);
  expect(after.studio.clips[clip.id]).toEqual(clip);
  const png = await page.request.post(`/api/pixel/projects/${saved.id}/export`, { headers: { origin },
    data: { revision: after.revision, format: 'png', assetId: asset.id, frameId: asset.frames[2].id } });
  expect(png.ok()).toBeTruthy();
  const decoded = await page.evaluate(async (data: number[]) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const result = { w: image.width, h: image.height, pixels: Array.from(ctx.getImageData(0, 0, image.width, image.height).data) }; image.close(); return result;
  }, Array.from(await png.body()));
  expect(decoded).toEqual({ w: 18, h: 18, pixels: Array.from(pixels).flatMap(c => [c >>> 24, c >>> 16 & 255, c >>> 8 & 255, c & 255]) });
  await page.reload(); await expect(page.locator('#asset-info')).toContainText('18 × 18'); await page.locator('#clip-editor-open').click();
  await expect(page.locator('[data-clip-slot]')).toHaveCount(4); await page.locator('[data-clip-slot]').nth(2).click();
  await expect(page.locator('#clip-slot-duration')).toHaveValue('180'); expect(errors).toEqual([]);
});

test('Clip Editor: held AI request locks edits/Escape, reports error and preserves prompt for retry', async ({ page }) => {
  await seed(page); await createClip(page);
  await page.locator('#clip-motion').fill('Mô tả giữ nguyên khi gửi lỗi');
  let release!: () => void, seen!: () => void, intercepted = false;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => seen = r);
  await page.route('**/generation-batches', async route => {
    if (route.request().method() !== 'POST' || intercepted) { await route.continue(); return; }
    intercepted = true; seen(); await gate; await route.fulfill({ status: 503, json: { error: 'Lỗi CLI thử nghiệm có kiểm soát' } });
  });
  try {
    await page.locator('#clip-generate').click(); await started;
    await expect(page.locator('#clip-close')).toBeDisabled(); await expect(page.locator('#clip-slot-selected')).toBeDisabled();
    await expect(page.locator('#clip-name')).toBeDisabled();
    const canvas = page.locator('#clip-pose-canvas'), box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 5.5 / 18 * box.width, box.y + 5.5 / 18 * box.height); await page.mouse.down();
    await page.mouse.move(box.x + 7.5 / 18 * box.width, box.y + 6.5 / 18 * box.height); await page.mouse.up();
    await expect(page.locator('#clip-pose-x')).toHaveValue('5');
    await page.keyboard.press('Escape'); await expect(page.locator('#clip-dialog')).toBeVisible();
    release(); await expect(page.locator('#clip-status')).toContainText('Lỗi CLI thử nghiệm');
    await expect(page.locator('#clip-close')).toBeEnabled(); await expect(page.locator('#clip-generate')).toBeEnabled();
    await expect(page.locator('#clip-motion')).toHaveValue('Mô tả giữ nguyên khi gửi lỗi');
  } finally { release(); }
});

test('Clip Editor: sparse region is confirmed and stored separately from source pixels', async ({ page }) => {
  const { saved, pixels } = await seed(page);
  await page.locator('[data-tool="wand"]').click();
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + 5.5 / 18 * box.width, box.y + 5.5 / 18 * box.height);
  page.on('dialog', async dialog => { expect(dialog.message()).toContain('1 pixel'); await dialog.accept(); });
  await createClip(page, 'region');
  await expect.poll(async () => Object.values((await savedDoc(page, saved.id)).studio.clips ?? {}).length).toBe(1);
  const doc = await savedDoc(page, saved.id), clip = Object.values(doc.studio.clips)[0] as any;
  expect(clip.mode).toBe('region'); expect(clip.movementMaskResourceId).toBeTruthy();
  const res = await page.request.get(`/api/pixel/projects/${saved.id}/resource?revision=${doc.revision}&resource=${clip.movementMaskResourceId}`);
  const mask = wireParse(await res.text()).data;
  expect(Array.from(mask)).toEqual(Array.from({ length: 324 }, (_, i) => +(i === 5 * 18 + 5)));
  const a = doc.assets[0], cel = Object.values(a.cels)[0] as any;
  const source = wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}/cel?revision=${doc.revision}&asset=${a.id}&cel=${cel.id}`)).text()).data;
  expect(source).toEqual(pixels);
});

test('Clip Editor: external save keeps Vietnamese inspector draft and blocks generation', async ({ page }) => {
  const { saved } = await seed(page); await createClip(page);
  await expect.poll(async () => Object.values((await savedDoc(page, saved.id)).studio.clips ?? {}).length).toBe(1);
  await page.locator('#clip-name').fill('Chuyển động tiếng Việt chưa lưu');
  await page.locator('#clip-name').press('Control+z'); await expect(page.locator('[data-clip-slot]')).toHaveCount(4);
  await page.locator('#clip-name').fill('Chuyển động tiếng Việt chưa lưu');
  await page.locator('#clip-name').dispatchEvent('compositionstart');
  const doc = await savedDoc(page, saved.id); doc.name = 'Sửa ngoài app';
  const response = await page.request.put(`/api/pixel/projects/${doc.id}`, { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: doc.revision, document: doc }) });
  expect(response.ok()).toBeTruthy();
  await expect(page.locator('#notice')).toContainText('tab khác/ngoài app');
  await expect(page.locator('#clip-name')).toHaveValue('Chuyển động tiếng Việt chưa lưu');
  await expect(page.locator('#clip-generate')).toBeDisabled(); await expect(page.locator('#clip-dialog')).toBeVisible();
  await page.locator('#clip-name').dispatchEvent('compositionend');
});

test('Clip Editor: late rejected resource from a closed project cannot replace the next project view', async ({ page }) => {
  const { saved, second } = await seed(page, true);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => seen = r);
  const pattern = `**/api/pixel/projects/${saved.id}/resource?**`;
  await page.route(pattern, async route => { seen(); await gate; await route.fulfill({ status: 409, json: { error: 'Lỗi đọc cũ của dự án A' } }); });
  const oldReply = page.waitForResponse(r => r.url().includes(`/projects/${saved.id}/resource?`));
  try {
    await page.locator('#clip-editor-open').click(); await started;
    await page.locator('#clip-close').click();
    await page.locator('#projects').selectOption(second.id); await page.locator('#clip-editor-open').click();
    await expect(page.locator('#clip-create-submit')).toBeEnabled();
    release(); await (await oldReply).finished();
    await expect(page.locator('#clip-create-submit')).toBeEnabled();
    await expect(page.locator('#clip-status')).not.toContainText('dự án A');
    await expect(page.locator('#notice')).toBeHidden();
  } finally { release(); await page.unroute(pattern); }
});

test('Clip Editor: viewing never saves and region creation never grants implicit whole-canvas permission', async ({ page }) => {
  const { saved } = await seed(page);
  await page.locator('#clip-editor-open').click(); await expect(page.locator('#clip-create-submit')).toBeEnabled();
  await expect(page.locator('#clip-mask-info')).toContainText('Chọn vùng');
  await page.locator('#clip-create-submit').click(); await expect(page.locator('#clip-status')).toContainText('Chọn vùng');
  expect((await savedDoc(page, saved.id)).revision).toBe(saved.revision);
  expect((await savedDoc(page, saved.id)).studio.clips).toBeUndefined();
  await page.locator('#clip-close').click(); await expect(page.locator('#clip-dialog')).toBeHidden();
});

test('Clip Editor: 1000px controls remain reachable; Esc cancels a drag without consuming undo', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 740 });
  await seed(page); await createClip(page); await page.locator('#clip-landmark').selectOption('hand');
  await captureLayout(page, 'clip-narrow.png');
  const canvas = page.locator('#clip-pose-canvas'), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 5.5 / 18 * box.width, box.y + 5.5 / 18 * box.height);
  await page.mouse.down(); await page.mouse.move(box.x + 7.5 / 18 * box.width, box.y + 6.5 / 18 * box.height);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('#clip-dialog')).toBeVisible(); await expect(page.locator('#clip-pose-x')).toHaveValue('5');
  await expect(page.locator('#clip-generate')).toBeEnabled();
  await page.locator('#clip-undo').click(); await expect(page.locator('[data-clip-slot]')).toHaveCount(0);
  await page.locator('#clip-redo').click(); await expect(page.locator('[data-clip-slot]')).toHaveCount(4);
  const bounds = (await page.locator('#clip-dialog').boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(1000);
  await page.locator('#clip-zoom').selectOption('32');
  const stage = page.locator('#clip-stage'), stageBox = (await stage.boundingBox())!, zoomed = (await canvas.boundingBox())!;
  expect(zoomed.y).toBeGreaterThanOrEqual(stageBox.y);
  await stage.hover(); await page.mouse.wheel(0, 250);
  await expect.poll(() => stage.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
});

test('Clip Editor: invalid inspector action preserves its text and commits no partial clip changes', async ({ page }) => {
  const { saved } = await seed(page); await createClip(page);
  await expect.poll(async () => Object.values((await savedDoc(page, saved.id)).studio.clips ?? {}).length).toBe(1);
  const before = await savedDoc(page, saved.id);
  await page.locator('#clip-name').fill('Tên mới chưa hợp lệ cùng pose');
  await page.locator('#clip-pose-x').fill('99'); await page.locator('#clip-pose-save').click();
  await expect(page.locator('#clip-pose-x')).toHaveValue('99'); await expect(page.locator('#clip-name')).toHaveValue('Tên mới chưa hợp lệ cùng pose');
  await expect(page.locator('#clip-generate')).toBeDisabled();
  const after = await savedDoc(page, saved.id); expect(after.studio.clips).toEqual(before.studio.clips);
  await page.locator('#clip-discard').click(); await expect(page.locator('#clip-pose-x')).toHaveValue('5');
  await expect(page.locator('#clip-generate')).toBeEnabled();
});
