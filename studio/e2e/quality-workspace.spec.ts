import { test, expect, type Page } from '@playwright/test';
import { lateTimer } from './playback-clock.ts';
import { newDocument, newLayer, celFor, wireStringify, wireParse } from '../../src/studio/pixel/model.ts';
import { createRecipeRenderer } from '../../src/studio/quality/renderer.ts';
import { motionFixture } from '../../test/quality-motion-fixture.ts';
import { compileMotionRecipe } from '../../src/studio/quality/motion-render.ts';
import { decodeTestPng } from '../../test/fixtures/image-assertions.ts';
import { readFile } from 'node:fs/promises';

async function create(page: Page, motion = false, size = 18, layered = false) {
  const f = motionFixture(), d = newDocument('Nguồn quality UI', motion ? 16 : size, motion ? 16 : size, 0x70c989ff), a = d.assets[0];
  if (motion) {
    a.palette = f.recipe.palette; a.metadata = { pivot: { x: 0.5, y: 1 } };
    celFor(a, a.layers[0].id, a.frames[0].id, true)!.data = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
    f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
    const moving = createRecipeRenderer(compileMotionRecipe(f.recipe, f.rig, f.plan).recipe).renderFrame('carry').image.data;
    const base = celFor(a, a.layers[0].id, a.frames[0].id, true)!.data!;
    d.studio = { version: 1, resources: { movement: { version: 1, kind: 'mask', w: 16, h: 16, data: Uint32Array.from(base, (c, i) => c !== moving[i] ? 1 : 0) } } };
  }
  if (layered) {
    const shield = newLayer('Khiên');
    a.layers.push(shield);
    celFor(a, shield.id, a.frames[0].id, true)!.data![0] = 0x51596eff;
    a.palette = [0x70c989ff, 0x51596eff];
  }
  const response = await page.request.post('/api/pixel/projects', { headers: { origin: 'http://127.0.0.1:4329', 'content-type': 'application/json' }, data: wireStringify({ name: d.name, document: d }) });
  expect(response.ok(), await response.text()).toBeTruthy(); const saved = wireParse(await response.text());
  await page.goto('/'); await page.locator('#projects').selectOption(saved.id); await expect(page.locator('#asset-info')).toContainText(`${a.w} × ${a.h}`);
  await page.locator('#quality-open').click(); await expect(page.locator('#quality-workspace')).toBeVisible();
  return { doc: saved, f };
}
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) console.log('QUALITY UI', await page.locator('#quality-error').textContent(), await page.locator('#quality-review-error').textContent(), await page.locator('#notice').textContent()); });

test('Quality UI: optional source-layer capture keeps the current frame and lists the saved layer count', async ({ page }) => {
  const { doc } = await create(page, false, 18, true);
  const parts = page.getByLabel('Giữ riêng các layer ảnh đang hiện');
  await expect(parts).toBeDisabled();
  await page.locator('#quality-source-ok').check();
  await expect(parts).not.toBeChecked();
  await parts.check();
  const saving = page.waitForResponse(response => response.url().endsWith('/quality/approvals') && response.request().method() === 'POST');
  await page.locator('#quality-approve').click();
  const response = await saving;
  expect(response.status(), await response.text()).toBe(201);
  const stock = wireParse(await response.text());
  expect(stock.approval.recipe.parts.map((part: { id: string }) => part.id)).toEqual(doc.assets[0].layers.map((layer: { id: string }) => layer.id));
  await expect(page.locator('#quality-source').locator('option:checked')).toContainText('2 layer');
  await expect(parts).not.toBeChecked();
  await expect.poll(() => page.locator('#quality-before').evaluate((c: HTMLCanvasElement) =>
    Array.from(c.getContext('2d')!.getImageData(0, 0, 1, 1).data))).toEqual([81, 89, 110, 255]);
});

test('Quality UI: approve a layer and region, preview scoped edit and apply layered result', async ({ page }) => {
  const { doc } = await create(page, false, 18, true);
  await page.locator('#quality-close').click();
  await page.locator('[data-command="selection.all"]').click();
  await page.locator('#quality-open').click();
  await page.locator('#quality-source-ok').check();
  await page.locator('#quality-source-layers').check();
  await page.getByLabel('Khóa phạm vi chỉnh').check();
  await expect(page.locator('#quality-approve')).toBeDisabled();
  await page.getByLabel('Layer được sửa').selectOption({ label: 'Khiên' });
  await expect(page.locator('#quality-template-area')).toContainText('18×18');
  await page.locator('#quality-approve').click();
  await expect(page.locator('#quality-approved-scope')).toContainText('Khiên');
  await page.locator('#quality-prompt').fill('Đổi sắc độ khiên.');
  await page.locator('#quality-generate').click();
  await expect(page.locator('#quality-apply')).toBeEnabled({ timeout: 20000 });
  const saved = page.waitForResponse(response => response.url().endsWith('/apply') && response.request().method() === 'POST');
  await page.locator('#quality-apply').click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
  const result = wireParse(await response.text());
  const edited = result.document.assets.at(-1);
  expect(edited.id).not.toBe(doc.assets[0].id);
  expect(edited.layers.map((layer: { name: string }) => layer.name)).toContain('Khiên');
  expect(edited.layers.length).toBe(2);
});

test('Quality UI: approve source → three roles → native comparison → apply new asset → reopen and export', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); const { doc } = await create(page);
  await expect(page.locator('#quality-generate')).toBeDisabled();
  await page.locator('#quality-source-ok').check(); await page.locator('#quality-approve').click();
  await expect(page.locator('#quality-source')).not.toHaveValue('');
  await page.locator('#quality-prompt').fill('FIXTURE_QUALITY_REVIEW_PATCH Sửa một pixel có mục tiêu.'); await page.locator('#quality-generate').click();
  await expect(page.locator('#quality-apply')).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('#quality-calls li').nth(1)).toContainText('DeepSeek API · dựng đề xuất');
  await expect(page.locator('#quality-variant')).toHaveValue(await page.locator('#quality-variant option').filter({ hasText: 'Sau kiểm tra' }).getAttribute('value') ?? '');
  await expect.poll(() => page.locator('#quality-after').evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([18, 18]);
  expect(await page.locator('#quality-after').evaluate(c => getComputedStyle(c).imageRendering)).toBe('pixelated');
  const before = await page.locator('#quality-before').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data));
  const reviewed = before.slice(); reviewed.splice(0, 4, 255, 255, 255, 255);
  await expect.poll(() => page.locator('#quality-after').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data))).toEqual(reviewed);
  await page.locator('#quality-variant').selectOption({ label: 'Bản dựng' });
  await expect.poll(() => page.locator('#quality-after').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data))).toEqual(before);
  await page.locator('#quality-variant').selectOption({ label: 'Sau kiểm tra' });
  await expect.poll(() => page.locator('#quality-after').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data))).toEqual(reviewed);
  await page.locator('#quality-apply').click(); await expect(page.locator('#quality-status')).toContainText('Đã lưu asset mới');
  const saved = await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json(); expect(saved.assets).toHaveLength(2); expect(saved.studio.version).toBe(2);
  await page.locator('#quality-close').click(); await page.reload(); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  await page.locator(`#asset-list [data-asset-id="${saved.assets[1].id}"] .asset-name-btn`).click();
  await page.locator('[data-tool="pen"]').click(); await page.locator('#hex').fill('#ffffffff'); await page.locator('#hex').press('Tab');
  const box = (await page.locator('#canvas').boundingBox())!; await page.locator('#canvas').click({ position: { x: box.width / 18 + 2, y: 2 } });
  await expect.poll(async () => {
    const d = wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}`)).text()), a = d.assets[1], c = a.layers[0].cels[a.frames[0].id];
    return wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}/cel?asset=${a.id}&cel=${c}&revision=${d.revision}`)).text()).data?.[1];
  }).toBe(0xffffffff);
  await page.reload(); await expect(page.locator('#canvas')).toBeVisible(); await page.locator(`#asset-list [data-asset-id="${saved.assets[1].id}"] .asset-name-btn`).click();
  await page.locator('#quality-open').click(); await expect(page.locator('#quality-status')).toContainText('Chỉ còn lịch sử'); await expect(page.locator('#quality-apply')).toBeDisabled(); await page.locator('#quality-close').click();
  const download = page.waitForEvent('download'); await page.locator('[data-export="png"]').click(); const file = await download; expect(file.suggestedFilename()).toMatch(/\.png$/);
  const png = decodeTestPng(await readFile((await file.path())!)); expect([png.w, png.h]).toEqual([18, 18]); expect(png.data[0]).toBe(0xffffffff); expect(png.data[1]).toBe(0xffffffff); expect(png.data.slice(2).every(p => p === 0x70c989ff)).toBe(true); await file.delete();
  expect(errors).toEqual([]);
});

test('Quality UI: recorded provider labels keep Antigravity history distinct without changing stored calls', async ({ page }) => {
  const { doc } = await create(page);
  await page.locator('#quality-source-ok').check(); await page.locator('#quality-approve').click();
  await page.locator('#quality-prompt').fill('Giữ mẫu để kiểm tra nhãn lịch sử'); await page.locator('#quality-generate').click();
  await expect(page.locator('#quality-apply')).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('#quality-calls li').nth(1)).toContainText('DeepSeek API · dựng đề xuất');
  const base = `/api/pixel/projects/${doc.id}`, before = await (await page.request.get(base)).json();
  await page.route(`**${base}/quality-runs`, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch(), history = await response.json();
    for (const run of history) run.calls[1].provider = 'antigravity';
    await route.fulfill({ json: history });
  });
  await page.locator('#quality-refresh').click();
  await expect(page.locator('#quality-calls li').nth(1)).toContainText('Antigravity (lịch sử) · dựng đề xuất');
  await expect(page.locator('#quality-history-detail')).toContainText('Antigravity (lịch sử)');
  await expect(page.locator('#quality-call-select option').nth(1)).toContainText('Antigravity (lịch sử)');
  const actual = await (await page.request.get(`${base}/quality-runs`)).json();
  expect(actual[0].calls[1].provider).toBe('deepseek');
  expect((await (await page.request.get(base)).json()).revision).toBe(before.revision);
});

test('Quality UI: motion draft requires source/parts/pose approval, shows actual frames and applies with timing', async ({ page }) => {
  const { doc, f } = await create(page, true);
  await page.locator('#quality-motion').click(); await expect(page.locator('#quality-source-review')).toBeVisible();
  await expect(page.locator('#quality-review-approve')).toBeDisabled(); await page.locator('#quality-source-review details summary').click();
  const draft = { version: 1, recipe: f.recipe, rig: f.rig, plan: f.plan, resources: { sources: [], masks: [] }, movementMaskResourceId: 'movement', frozenFrames: [{ frameId: 'rest', sourceFrameId: doc.assets[0].frames[0].id }] };
  await page.locator('#quality-review-file').setInputFiles({ name: 'motion-source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(draft)) });
  await expect(page.locator('#quality-review-info')).toContainText('2 frame');
  await expect(page.locator('#quality-review-locked-view')).toBeVisible(); await expect(page.locator('#quality-review-part-info')).toContainText('Frame khóa: khớp RGBA');
  await page.locator('#quality-review-mask').check();
  await expect.poll(() => page.locator('#quality-review-source').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(10, 4, 1, 1).data))).not.toEqual([238, 247, 248, 255]);
  await page.locator('#quality-review-mask').uncheck();
  await page.locator('#quality-review-bones').uncheck(); await page.locator('#quality-review-frame').selectOption('carry');
  await expect.poll(() => page.locator('#quality-review-pose').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(7, 6, 1, 1).data))).toEqual([238, 247, 248, 255]);
  await page.locator('#quality-review-source-ok').check(); await page.locator('#quality-review-parts-ok').check(); await expect(page.locator('#quality-review-approve')).toBeDisabled(); await page.locator('#quality-review-pose-ok').check();
  await page.locator('#quality-review-approve').click(); await expect(page.locator('#quality-source-review')).not.toBeVisible(); await expect(page.locator('#quality-source')).not.toHaveValue('');
  await page.locator('#quality-prompt').fill('Giữ mẫu chuyển động đã duyệt.'); await page.locator('#quality-generate').click(); await expect(page.locator('#quality-apply')).toBeEnabled({ timeout: 20000 });
  await page.locator('#quality-frame').selectOption('carry'); await expect.poll(() => page.locator('#quality-after').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(7, 6, 1, 1).data))).toEqual([238, 247, 248, 255]);
  let allowRest = false, held = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const routePattern = '**/quality-runs/*/variants/*/frame?*';
  await page.route(routePattern, async route => { if (new URL(route.request().url()).searchParams.get('frame') === 'rest' && !allowRest) { held++; await gate; } await route.continue(); });
  try {
    await page.locator('#quality-variant').selectOption({ label: 'Bản dựng' }); await expect.poll(() => held).toBeGreaterThan(0);
    await page.locator('#quality-onion').check(); await page.locator('#quality-frame').selectOption('carry'); await expect.poll(() => held).toBeGreaterThan(1);
    allowRest = true; await page.locator('#quality-frame').selectOption('rest');
    await expect(page.locator('#quality-after-label')).toContainText('frame 1'); release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('#quality-after-label')).toContainText('frame 1');
    expect(await page.locator('#quality-after').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(10, 4, 1, 1).data))).toEqual([238, 247, 248, 255]);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  await page.locator('#quality-onion').uncheck(); await page.locator('#quality-variant').selectOption({ label: 'Sau kiểm tra' });
  await page.clock.install(); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('#quality-frame').selectOption('rest'); await page.locator('#quality-play').click();
  await expect(page.locator('#quality-play')).toHaveText('Dừng'); await lateTimer(page, 380);
  await expect(page.locator('#quality-frame')).toHaveValue('rest'); await page.locator('#quality-play').click(); await page.clock.resume();
  await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
  await expect(page.locator('#quality-retouch-lock')).toBeChecked();
  await page.locator('#quality-retouch-lock').click(); await expect(page.locator('#quality-retouch-error')).toContainText('khóa kế thừa');
  await expect(page.locator('#quality-retouch-lock')).toBeChecked();
  await page.locator('#quality-retouch-frame').selectOption('carry'); await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
  await page.locator('#quality-retouch-tool').selectOption('eraser'); await retouchClick(page, 3, 3);
  expect(await retouchPixel(page, 3, 3)).toEqual([53, 69, 87, 255]);
  await page.locator('#quality-retouch-tool').selectOption('pen'); await page.locator('#quality-retouch-palette [data-color-index="0"]').click(); await retouchClick(page, 7, 6);
  expect(await retouchPixel(page, 7, 6)).toEqual([53, 69, 87, 255]);
  await page.locator('#quality-retouch-save').click(); await expect(page.locator('#quality-retouch-dialog')).not.toBeVisible();
  await expect(page.locator('#quality-variant option:checked')).toContainText('Chỉnh pixel');
  await page.locator('#quality-apply').click(); const saved = await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json();
  await expect.poll(async () => (await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json()).assets.length).toBe(2);
  const final = await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json(); expect(final.assets[1].frames.map((f: { duration: number }) => f.duration)).toEqual([100, 120]); expect(final.assets[1].tags[0].loop).toBe(true);
  const moving = final.assets[1], cell = moving.layers[0].cels[moving.frames[1].id];
  const edited = wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}/cel?asset=${moving.id}&cel=${cell}&revision=${final.revision}`)).text());
  expect(edited.data[6 * 16 + 7]).toBe(0x354557ff); expect(edited.data[3 * 16 + 3]).toBe(0x354557ff);
});

test('Quality UI: source revision changed in another tab keeps prompt and blocks stale generation', async ({ page }) => {
  const { doc } = await create(page); await page.locator('#quality-source-ok').check(); await page.locator('#quality-approve').click(); await expect(page.locator('#quality-source')).not.toHaveValue('');
  await page.locator('#quality-prompt').fill('Giữ bản nháp tiếng Việt: sửa mũ.');
  const d = wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}`)).text()); d.assets[0].name = 'Tên từ tab khác';
  const r = await page.request.put(`/api/pixel/projects/${doc.id}`, { headers: { origin: 'http://127.0.0.1:4329', 'content-type': 'application/json' }, data: wireStringify({ revision: d.revision, document: d }) }); expect(r.ok(), await r.text()).toBeTruthy();
  await expect(page.locator('#quality-generate')).toBeDisabled(); await expect(page.locator('#quality-prompt')).toHaveValue('Giữ bản nháp tiếng Việt: sửa mũ.');
  expect(await (await page.request.get(`/api/pixel/projects/${doc.id}/quality-runs`)).json()).toEqual([]);
});

test('Quality UI: reject a motion draft whose pose modifies a frozen frame before human approval', async ({ page }) => {
  const { doc, f } = await create(page, true); await page.locator('#quality-motion').click(); await page.locator('#quality-source-review details summary').click();
  f.plan.frames[0].rotations = [{ jointId: 'shoulder', degrees: 90 }];
  const draft = { version: 1, recipe: f.recipe, rig: f.rig, plan: f.plan, resources: { sources: [], masks: [] }, movementMaskResourceId: null, frozenFrames: [{ frameId: 'rest', sourceFrameId: doc.assets[0].frames[0].id }] };
  await page.locator('#quality-review-file').setInputFiles({ name: 'invalid-motion.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(draft)) });
  await expect(page.locator('#quality-review-error')).toContainText('frame đã khóa'); await expect(page.locator('#quality-review-approve')).toBeDisabled();
  expect((await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json()).revision).toBe(doc.revision);
});

test('Quality UI: closing does not replay generation, reopen restores running task and cancel/delete preserve source', async ({ page }) => {
  const { doc } = await create(page);
  await page.locator('#quality-source-ok').check(); await page.locator('#quality-approve').click(); await expect(page.locator('#quality-source')).not.toHaveValue('');
  await page.locator('#quality-prompt').fill('FIXTURE_QUALITY_HANG'); await page.locator('#quality-generate').click(); await expect(page.locator('#quality-cancel')).toBeEnabled();
  await page.locator('#quality-close').click(); await page.locator('#quality-open').click(); await expect(page.locator('#quality-cancel')).toBeEnabled();
  await page.locator('#quality-cancel').click(); await expect(page.locator('#quality-cancel')).toBeDisabled(); await expect(page.locator('#quality-apply')).toBeDisabled();
  await page.locator('#quality-delete').click(); await expect(page.locator('#quality-history option')).toHaveCount(1);
  const saved = await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json(); expect(saved.assets).toHaveLength(1);
});

async function retouchSource(page: Page, size = 18) {
  const { doc } = await create(page, false, size); await page.locator('#quality-source-ok').check(); await page.locator('#quality-approve').click();
  await expect(page.locator('#quality-source')).not.toHaveValue('');
  await page.locator('#quality-prompt').fill('FIXTURE_QUALITY_REVIEW_PATCH Sửa nét thủ công sau review.');
  await page.locator('#quality-generate').click(); await expect(page.locator('#quality-apply')).toBeEnabled({ timeout: 20000 });
  return doc;
}
const retouchPixel = (page: Page, x: number, y: number) => page.locator('#quality-retouch-canvas').evaluate((c: HTMLCanvasElement, p) => Array.from(c.getContext('2d')!.getImageData(p.x, p.y, 1, 1).data), { x, y });

test('Quality retouch UI: focusing an overflowing80px canvas keeps the clicked pixel stable', async ({ page }) => {
  await retouchSource(page, 80); await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
  await page.locator('#quality-retouch-tool').selectOption('eraser');
  const canvas = page.locator('#quality-retouch-canvas');
  await canvas.evaluate((c: HTMLCanvasElement) => {
    const positions: number[] = []; c.dataset.focusTops = '[]';
    for (const type of ['pointerdown', 'focus']) c.addEventListener(type, () => { positions.push(c.getBoundingClientRect().top); c.dataset.focusTops = JSON.stringify(positions); }, true);
  });
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 160, y: box.height / 160 } });
  const tops = JSON.parse((await canvas.getAttribute('data-focus-tops'))!) as number[];
  expect(tops).toHaveLength(2); expect(tops[1]).toBe(tops[0]);
  const expected = Array(80 * 80).fill(0x70c989ff); expected[0] = 0;
  expect(await canvas.evaluate((c: HTMLCanvasElement) => { const b = c.getContext('2d')!.getImageData(0, 0, 80, 80).data; return Array.from({ length: 6400 }, (_, i) => ((b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3]) >>> 0); })).toEqual(expected);
});
async function retouchClick(page: Page, x: number, y: number) {
  const c = page.locator('#quality-retouch-canvas'), box = (await c.boundingBox())!;
  const [w, h] = await c.evaluate((c: HTMLCanvasElement) => [c.width, c.height]); await c.click({ position: { x: (x + .5) * box.width / w, y: (y + .5) * box.height / h } });
}

test('Quality retouch UI: native pixel → undo/redo → region → local variant → apply/reopen/export without another CLI', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); const doc = await retouchSource(page);
  const revision = (await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json()).revision;
  await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-canvas')).toBeVisible();
  await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
  await page.locator('#quality-retouch-palette button[title="#ffffffff"]').click();
  await retouchClick(page, 2, 2); expect(await retouchPixel(page, 2, 2)).toEqual([255, 255, 255, 255]);
  await page.locator('#quality-retouch-undo').click(); expect(await retouchPixel(page, 2, 2)).toEqual([112, 201, 137, 255]);
  await page.locator('#quality-retouch-redo').click(); expect(await retouchPixel(page, 2, 2)).toEqual([255, 255, 255, 255]);
  for (const [key, value] of Object.entries({ x: 2, y: 2, w: 1, h: 1 })) await page.locator('#quality-retouch-region-' + key).fill(String(value));
  await page.locator('#quality-retouch-region-set').click();
  await retouchClick(page, 3, 2); expect(await retouchPixel(page, 3, 2)).toEqual([112, 201, 137, 255]);
  await page.locator('#quality-retouch-diff').check();
  expect(await retouchPixel(page, 2, 2)).toEqual([255, 255, 255, 255]);
  await page.locator('#quality-retouch-save').click(); await expect(page.locator('#quality-retouch-dialog')).not.toBeVisible();
  await expect(page.locator('#quality-variant option:checked')).toContainText('Chỉnh pixel');
  const runId = await page.locator('#quality-history').inputValue(), run = await (await page.request.get(`/api/pixel/projects/${doc.id}/quality-runs/${runId}`)).json();
  expect(run.cliCalls).toBe(3); expect(run.technicalRepairs).toBe(0); expect(run.variants.at(-1).kind).toBe('edited');
  const unchanged = await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json(); expect(unchanged.revision).toBe(revision); expect(unchanged.assets).toHaveLength(1);
  await page.locator('#quality-apply').click(); await expect(page.locator('#quality-status')).toContainText('Đã lưu asset mới');
  const applied = await (await page.request.get(`/api/pixel/projects/${doc.id}`)).json(); await page.locator('#quality-close').click(); await page.reload();
  await page.locator(`#asset-list [data-asset-id="${applied.assets[1].id}"] .asset-name-btn`).click();
  const pending = page.waitForEvent('download'); await page.locator('[data-export="png"]').click(); const download = await pending;
  const png = decodeTestPng(await readFile((await download.path())!)); await download.delete();
  expect([png.w, png.h, png.data[0], png.data[2 * 18 + 2], png.data[2 * 18 + 3]]).toEqual([18, 18, 0xffffffff, 0xffffffff, 0x70c989ff]);
  expect(errors).toEqual([]);
});

test('Quality retouch UI: blur rolls back only the active stroke; close/reopen and a save error preserve draft pixels', async ({ page }) => {
  await retouchSource(page); await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
  await page.locator('#quality-retouch-palette button[title="#ffffffff"]').click(); await retouchClick(page, 1, 1);
  const box = (await page.locator('#quality-retouch-canvas').boundingBox())!;
  await page.mouse.move(box.x + 3.5 * box.width / 18, box.y + 3.5 * box.height / 18); await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  expect(await retouchPixel(page, 3, 3)).toEqual([112, 201, 137, 255]); expect(await retouchPixel(page, 1, 1)).toEqual([255, 255, 255, 255]);
  await page.locator('#quality-retouch-close').click(); await expect(page.locator('#quality-retouch-dialog')).not.toBeVisible();
  await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-restore')).toBeVisible(); await page.locator('#quality-retouch-restore').click();
  await expect.poll(() => retouchPixel(page, 1, 1)).toEqual([255, 255, 255, 255]);
  const route = '**/quality-runs/*/variants/*/retouch';
  await page.route(route, async r => { if (r.request().method() === 'POST') await r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture conflict giữ bản nháp' }) }); else await r.continue(); });
  await page.locator('#quality-retouch-save').click(); await expect(page.locator('#quality-retouch-error')).toContainText('Fixture conflict');
  expect(await retouchPixel(page, 1, 1)).toEqual([255, 255, 255, 255]);
  await page.locator('#quality-retouch-diff').check();
  const pending = page.waitForEvent('download'); await page.locator('#quality-retouch-download').click(); const download = await pending;
  const png = await page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    try {
      const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      return { w: c.width, h: c.height, data: Array.from({ length: c.width * c.height }, (_, i) => ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0) };
    } finally { bitmap.close(); }
  }, (await readFile((await download.path())!)).toString('base64')); await download.delete();
  const expected = Array(18 * 18).fill(0x70c989ff); expected[0] = expected[19] = 0xffffffff;
  expect([png.w, png.h]).toEqual([18, 18]); expect(png.data).toEqual(expected);
  await page.locator('#quality-retouch-close').click(); await page.unroute(route); await page.locator('#quality-retouch-open').click();
  await expect(page.locator('#quality-retouch-restore')).toBeVisible(); await page.locator('#quality-retouch-restore').click();
  await expect.poll(() => retouchPixel(page, 1, 1)).toEqual([255, 255, 255, 255]); await page.locator('#quality-retouch-close').click();
});

test('Quality retouch UI: close during frame loading rejects late data and reopening has a clean active view', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await retouchSource(page);
  let release!: () => void, seen = 0; const held = new Promise<void>(resolve => { release = resolve; });
  const pattern = '**/quality-runs/*/variants/*/retouch?*';
  await page.route(pattern, async route => { seen++; await held; try { await route.continue(); } catch {} });
  try {
    await page.locator('#quality-retouch-open').click(); await expect.poll(() => seen).toBeGreaterThan(0);
    await page.locator('#quality-retouch-close').click(); await expect(page.locator('#quality-retouch-dialog')).not.toBeVisible();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
    expect(await page.locator('#quality-retouch-dialog').count()).toBe(1); expect(await retouchPixel(page, 2, 2)).toEqual([112, 201, 137, 255]);
    await page.locator('#quality-retouch-close').click(); expect(errors).toEqual([]);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('Quality retouch UI: shared custom shortcuts work, while input focus and IME keep their own keys', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pxl.pixel.shortcuts', JSON.stringify({ 'tool.pen': ['b'], 'tool.erase': ['q'], 'edit.undo': ['Ctrl+Alt+z'] })));
  await retouchSource(page); await page.locator('#quality-retouch-open').click(); await expect(page.locator('#quality-retouch-tool')).toBeEnabled();
  await page.locator('#quality-retouch-canvas').focus(); await page.keyboard.press('q'); await expect(page.locator('#quality-retouch-tool')).toHaveValue('eraser');
  await page.keyboard.press('b'); await expect(page.locator('#quality-retouch-tool')).toHaveValue('pen');
  await page.keyboard.press(']'); await expect(page.locator('#quality-retouch-size')).toHaveValue('2'); await page.keyboard.press('['); await expect(page.locator('#quality-retouch-size')).toHaveValue('1');
  await page.locator('#quality-retouch-palette button[title="#ffffffff"]').click(); await retouchClick(page, 2, 2);
  await page.locator('#quality-retouch-canvas').press('Control+Alt+z'); expect(await retouchPixel(page, 2, 2)).toEqual([112, 201, 137, 255]);
  await page.locator('#quality-retouch-size').focus(); await page.keyboard.press('q'); await expect(page.locator('#quality-retouch-tool')).toHaveValue('pen');
  await page.locator('#quality-retouch-canvas').dispatchEvent('keydown', { key: 'q', isComposing: true }); await expect(page.locator('#quality-retouch-tool')).toHaveValue('pen');
  await page.locator('#quality-retouch-close').click();
});
