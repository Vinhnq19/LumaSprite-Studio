import { test, expect, type Page } from '@playwright/test';
import { celFor, newLayer, newDocument, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { walkFixture } from '../../test/fixtures/quality-walk.ts';
import { createRecipeRenderer } from '../../src/studio/quality/renderer.ts';
import { compileMotionRecipe } from '../../src/studio/quality/motion-render.ts';
import { decodeTestPng } from '../../test/fixtures/image-assertions.ts';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4329';
async function documentOf(page: Page, id: string) { return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`)).text()); }
async function create(page: Page, doc = newDocument('Thử dựng rig tiếng Việt', 18, 18, 0x70c989ff)) {
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ name: doc.name, document: doc }) });
  expect(response.ok(), await response.text()).toBeTruthy(); const saved = wireParse(await response.text());
  await page.goto('/'); await page.locator('#projects').selectOption(saved.id); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  await expect(page.locator('#rig-editor')).not.toBeVisible(); await page.locator('#rig-open').click();
  const sourceResponse = page.waitForResponse(r => r.url().endsWith('/rig-drafts') && r.request().method() === 'POST');
  await page.locator('#rig-btn-create-source').click(); expect((await sourceResponse).ok()).toBe(true);
  await expect(page.locator('#rig-part-select option')).toHaveCount(1, { timeout: 15000 }); await expect(page.locator('#rig-canvas')).toHaveAttribute('width', '18');
  await expect(page.locator('#rig-btn-review')).toBeEnabled();
  return { saved, created: await documentOf(page, saved.id) };
}
async function drag(page: Page, x0: number, y0: number, x1: number, y1: number, release = true) {
  const box = (await page.locator('#rig-canvas').boundingBox())!, scale = box.width / 18;
  await page.mouse.move(box.x + (x0 + .5) * scale, box.y + (y0 + .5) * scale); await page.mouse.down();
  await page.mouse.move(box.x + (x1 + .5) * scale, box.y + (y1 + .5) * scale, { steps: 4 }); if (release) await page.mouse.up();
}
async function waitSaved(page: Page) { await expect(page.locator('#save-status')).toContainText('Đã lưu'); }

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) console.log('RIG UI', await page.evaluate(() => ['rig-error', 'notice', 'quality-status', 'quality-error', 'quality-review-error'].map(id => document.getElementById(id)?.textContent)));
});

test('Rig UI: source copy → cut part → refresh → undo/redo → pose → explicit review → fixture quality → apply/reopen/exact PNG', async ({ page }) => {
  test.setTimeout(90000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const { saved, created } = await create(page), working = created.assets[1];
  await page.locator('#rig-chk-bones').uncheck();
  await drag(page, 10, 10, 14, 14); page.once('dialog', dialog => dialog.accept('Cánh tay thử'));
  await page.locator('#rig-btn-split-part').click(); await expect(page.locator('#rig-part-select option')).toHaveCount(2);
  await expect(page.locator('#rig-refresh-warning')).toBeVisible(); await expect(page.locator('#rig-btn-review')).toBeDisabled();
  await page.locator('#rig-btn-refresh-draft').click(); await expect(page.locator('#rig-refresh-warning')).not.toBeVisible();
  await page.locator('#rig-btn-undo').click(); await expect(page.locator('#rig-refresh-warning')).toBeVisible();
  await page.locator('#rig-btn-undo').click(); await expect(page.locator('#rig-part-select option')).toHaveCount(1);
  await page.locator('#rig-btn-redo').click(); await expect(page.locator('#rig-part-select option')).toHaveCount(2);
  await page.locator('#rig-btn-redo').click(); await expect(page.locator('#rig-refresh-warning')).not.toBeVisible();
  await page.locator('#rig-part-select').selectOption({ label: 'Cánh tay thử (visible)' });
  await page.locator('#rig-btn-add-joint').click(); await page.locator('#rig-canvas').click({ position: { x: 6 * 4 + 2, y: 6 * 4 + 2 } });
  await expect(page.locator('#rig-joint-select option')).toHaveCount(2);
  const joint = await page.locator('#rig-joint-select option').last().getAttribute('value');
  await page.locator('#rig-binding-joint').selectOption(joint!);
  await page.locator('#rig-btn-add-socket').click();
  const socket = await page.locator('#rig-binding-socket option').last().getAttribute('value');
  await page.locator('#rig-binding-socket').selectOption(socket!);
  await waitSaved(page); await drag(page, 6, 6, 7, 6); await waitSaved(page);
  let rigDoc = await documentOf(page, saved.id), rigDraft = rigDoc.studio.rigDrafts[Object.keys(rigDoc.studio.rigDrafts)[0]];
  expect(rigDraft.rig.sockets.find((s: any) => s.id === socket).rest).toEqual({ x: 13, y: 12 });
  await page.locator('#rig-btn-undo').click(); await waitSaved(page);
  rigDoc = await documentOf(page, saved.id); rigDraft = rigDoc.studio.rigDrafts[Object.keys(rigDoc.studio.rigDrafts)[0]];
  expect(rigDraft.rig.sockets.find((s: any) => s.id === socket).rest).toEqual({ x: 12, y: 12 });
  await page.locator('#rig-timeline-strip button').nth(1).click();
  await page.locator('#rig-frame-duration').fill('137'); await page.locator('#rig-frame-duration').press('Tab');
  await page.locator('#rig-joint-select').selectOption(joint!);
  await page.locator('#rig-frame-joint-rot').evaluate((e: HTMLInputElement) => { e.value = '30'; e.dispatchEvent(new Event('change')); });
  await page.locator('#rig-mode-pose').check(); await waitSaved(page); await expect(page.locator('#rig-btn-review')).toBeEnabled();
  await page.locator('#rig-btn-review').click(); await expect(page.locator('#quality-source-review')).toBeVisible();
  await expect(page.locator('#quality-review-info')).toContainText('2 frame'); await expect(page.locator('#quality-review-approve')).toBeDisabled();
  for (const id of ['source', 'parts', 'pose']) await page.locator(`#quality-review-${id}-ok`).check();
  const approvalResponse = page.waitForResponse(r => r.url().endsWith('/quality/approvals') && r.request().method() === 'POST');
  await page.locator('#quality-review-approve').click(); expect((await approvalResponse).ok()).toBe(true); await expect(page.locator('#quality-workspace')).toBeVisible({ timeout: 15000 });
  await page.locator('#quality-prompt').fill('Giữ rig đã duyệt, fixture không gọi AI thật.'); await page.locator('#quality-generate').click();
  await expect(page.locator('#quality-apply')).toBeEnabled({ timeout: 20000 }); await page.locator('#quality-apply').click();
  await expect(page.locator('#quality-status')).toContainText('Đã lưu asset mới'); await page.locator('#quality-close').click();
  const final = await documentOf(page, saved.id); expect(final.assets).toHaveLength(3); expect(final.assets[0]).toEqual(created.assets[0]);
  expect(final.assets[2].frames.map((f: any) => f.duration)).toEqual([100, 137]);
  expect(final.studio.rigDrafts[Object.keys(final.studio.rigDrafts)[0]].rig.source.assetId).toBe(working.id);
  await page.reload(); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  await page.locator(`#asset-list [data-asset-id="${final.assets[2].id}"] .asset-name-btn`).click();
  const download = page.waitForEvent('download'); await page.locator('[data-export="png"]').click(); const file = await download;
  const png = decodeTestPng(await readFile((await file.path())!)); expect([png.w, png.h]).toEqual([18, 18]); expect(png.data.every(p => p === 0x70c989ff)).toBe(true); await file.delete();
  expect(errors).toEqual([]);
});

test('Rig UI: one drag is one undo, blur rolls back; unsubmitted fields survive external conflict', async ({ page }) => {
  const { saved, created } = await create(page), id = Object.keys(created.studio.rigDrafts)[0], initial = created.studio.rigDrafts[id].rig.joints[0].rest;
  await drag(page, 9, 17, 8, 15); await waitSaved(page);
  await expect.poll(async () => (await documentOf(page, saved.id)).studio.rigDrafts[id].rig.joints[0].rest).not.toEqual(initial);
  await page.locator('#rig-btn-undo').click(); await waitSaved(page);
  expect((await documentOf(page, saved.id)).studio.rigDrafts[id].rig.joints[0].rest).toEqual(initial);
  await drag(page, 9, 17, 7, 14, false); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  await page.locator('#rig-btn-close').click(); await page.locator('#rig-open').click();
  expect((await documentOf(page, saved.id)).studio.rigDrafts[id].rig.joints[0].rest).toEqual(initial);
  await page.locator('#rig-frame-duration').fill('177');
  const doc = await documentOf(page, saved.id); doc.assets[0].name = 'Sửa ở tab khác';
  const changed = await page.request.put(`/api/pixel/projects/${saved.id}`, { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: doc.revision, document: doc }) }); expect(changed.ok()).toBe(true);
  await expect(page.locator('#rig-status-badge')).toContainText('Xung đột'); await expect(page.locator('#rig-btn-add-joint')).toBeDisabled();
  await expect(page.locator('#rig-frame-duration')).toHaveValue('177');
  const before = await documentOf(page, saved.id); await drag(page, 9, 17, 2, 2);
  expect((await documentOf(page, saved.id)).studio.rigDrafts).toEqual(before.studio.rigDrafts);
});

test('Rig UI: new authored layer uses normal pixel tools, retains source and requires fresh part snapshot after reopening', async ({ page }) => {
  const { saved, created } = await create(page);
  page.once('dialog', dialog => dialog.accept('Vẽ bù tiếng Việt')); await page.locator('#rig-btn-new-authored').click();
  await expect(page.locator('#rig-editor')).not.toBeVisible(); await page.locator('#hex').fill('#ffffffff'); await page.locator('#hex').press('Tab');
  await page.locator('#canvas').click({ position: { x: 2, y: 2 } }); await waitSaved(page);
  await page.locator('#rig-open').click(); await expect(page.locator('#rig-refresh-warning')).toBeVisible();
  await page.locator('#rig-btn-refresh-draft').click(); await expect(page.locator('#rig-refresh-warning')).not.toBeVisible();
  const final = await documentOf(page, saved.id); expect(final.assets[0]).toEqual(created.assets[0]);
  const draft = final.studio.rigDrafts[Object.keys(final.studio.rigDrafts)[0]];
  expect(draft.recipe.parts.some((p: any) => p.name === 'Vẽ bù tiếng Việt' && p.origin === 'authored')).toBe(true);
  await page.locator('#rig-btn-close').click(); await page.reload(); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  await page.locator(`#asset-list [data-asset-id="${final.assets[1].id}"] .asset-name-btn`).click();
  await page.locator('#rig-open').click(); await expect(page.locator('#rig-refresh-warning')).not.toBeVisible();
});

test('Rig UI: generate explicit biped walk, solve a whole leg, preserve contacts/timing, undo pose and reopen at 1000×740', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 740 });
  const f = walkFixture(), doc = newDocument('Nhịp đi UI', 64, 64), a = doc.assets[0];
  a.palette = f.recipe.palette; a.metadata.pivot = { x: .5, y: 1 }; a.layers = []; a.cels = {};
  for (const p of f.recipe.parts) {
    const layer = newLayer(p.name); layer.id = p.id; a.layers.push(layer);
    celFor(a, layer.id, a.frames[0].id, true)!.data = createRecipeRenderer({ ...f.recipe, parts: f.recipe.parts.map(part => ({ ...part, paint: part.id === p.id ? part.paint : [] })) }).renderFrame('f0').image.data;
  }
  f.rig.source = { ...f.rig.source, projectId: doc.id, assetId: a.id, frameId: a.frames[0].id };
  doc.studio = { version: 2, quality: { version: 1, approvals: {} }, resources: {}, rigDrafts: { draft: { version: 1, id: 'draft', name: 'Nhịp đi hình khối', origin: { assetId: a.id, frameId: a.frames[0].id }, ...f, resources: { sources: [], masks: [] }, movementMaskResourceId: null, frozenFrames: [] } } };
  const response = await page.request.post('/api/pixel/projects', { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ name: doc.name, document: doc }) });
  expect(response.ok(), await response.text()).toBe(true); const saved = wireParse(await response.text());
  await page.goto('/'); await page.locator('#projects').selectOption(saved.id); await page.locator('#rig-open').click();
  await expect(page.locator('#rig-btn-review')).toBeEnabled();
  for (const selector of ['#rig-editor .left-panel', '#rig-editor .right-panel']) {
    const layout = await page.locator(selector).evaluate(e => ({ width: e.clientWidth, scroll: e.scrollWidth, overflow: [...e.querySelectorAll<HTMLElement>('*')].filter(c => c.clientWidth > 0 && c.scrollWidth > c.clientWidth + 1).map(c => ({ id: c.id, tag: c.tagName, cls: c.className, width: c.clientWidth, scroll: c.scrollWidth, whiteSpace: getComputedStyle(c).whiteSpace, text: c.textContent?.slice(0, 60) })).slice(0, 20) }));
    expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1);
  }
  expect(await page.locator('#rig-part-pivot-x').evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThan(64);
  await page.getByText('Tạo nhịp đi ngang +X (thử nghiệm)', { exact: true }).click(); await page.locator('#rig-walk-create').click();
  await expect(page.locator('#rig-error')).toContainText('Xác nhận');
  await page.locator('#rig-walk-confirm').check(); await page.locator('#rig-walk-create').click();
  await expect(page.locator('#rig-walk-info')).toContainText('960 ms'); await waitSaved(page);
  let d = await documentOf(page, saved.id), draft = d.studio.rigDrafts.draft;
  expect(draft.plan.action).toBe('walk'); expect(draft.plan.frames.map((f: any) => f.durationMs)).toEqual(Array(8).fill(120));
  expect(compileMotionRecipe(draft.recipe, draft.rig, draft.plan).geometry.every(g => g.contacts.every(c => c.rasterError === 0))).toBe(true);
  const before = structuredClone(draft.plan);
  await page.locator('#rig-chain-select').selectOption('a');
  await page.locator('#rig-contact-target-x').evaluate((e: HTMLInputElement) => { e.value = '28'; });
  await page.locator('#rig-ik-solve').click(); await waitSaved(page);
  d = await documentOf(page, saved.id); draft = d.studio.rigDrafts.draft;
  expect(draft.plan).not.toEqual(before); expect(compileMotionRecipe(draft.recipe, draft.rig, draft.plan).geometry[0].contacts[0].rasterError).toBe(0);
  await page.locator('#rig-btn-undo').click(); await waitSaved(page);
  expect((await documentOf(page, saved.id)).studio.rigDrafts.draft.plan).toEqual(before);
  await page.locator('#rig-btn-close').click(); await page.reload(); await expect(page.locator('#asset-info')).toContainText('64 × 64');
  await page.locator('#rig-open').click(); await expect(page.locator('#rig-plan-action')).toHaveValue('walk');
  await expect(page.locator('#rig-timeline-strip button')).toHaveCount(8); await expect(page.locator('#rig-btn-review')).toBeEnabled();
});

test('Rig UI: closing/reopening while a source resource loads ignores the old dialog continuation', async ({ page }) => {
  const { saved } = await create(page); await page.locator('#rig-btn-close').click(); await page.reload(); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  let release!: () => void, held = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/resource?*', async route => { held++; await gate; await route.continue(); });
  try {
    await page.locator('#rig-open').click(); await expect.poll(() => held).toBeGreaterThan(0);
    await page.locator('#rig-btn-close').click(); await page.locator('#rig-open').click();
    release(); await expect(page.locator('#rig-btn-review')).toBeEnabled(); await expect(page.locator('#rig-error')).not.toBeVisible();
    expect((await documentOf(page, saved.id)).assets).toHaveLength(2);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('Rig UI: creating a source preserves preceding paint undo, redo and save across the v2 extension upgrade', async ({ page }) => {
  const response = await page.request.post('/api/pixel/projects', { headers: { origin }, data: { name: 'Hoàn tác trước rig', w: 18, h: 18, background: 0x70c989ff } });
  expect(response.ok()).toBe(true); const doc = wireParse(await response.text());
  await page.goto('/'); await page.locator('#projects').selectOption(doc.id); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  await page.locator('#hex').fill('#ffffffff'); await page.locator('#hex').press('Tab'); await page.locator('#canvas').click({ position: { x: 2, y: 2 } }); await waitSaved(page);
  await page.locator('#rig-open').click(); await page.locator('#rig-btn-create-source').click(); await expect(page.locator('#rig-btn-review')).toBeEnabled({ timeout: 15000 });
  await page.locator('#rig-btn-close').click();
  await page.locator('[data-command="edit.undo"]').click(); await waitSaved(page); expect((await documentOf(page, doc.id)).assets).toHaveLength(1);
  await page.locator('[data-command="edit.undo"]').click(); await waitSaved(page);
  let d = await documentOf(page, doc.id), a = d.assets[0], cel = a.layers[0].cels[a.frames[0].id];
  expect(d.studio.version).toBe(2); expect(d.studio.rigDrafts).toEqual({});
  expect(wireParse(await (await page.request.get(`/api/pixel/projects/${d.id}/cel?asset=${a.id}&cel=${cel}&revision=${d.revision}`)).text()).data[0]).toBe(0x70c989ff);
  await page.locator('[data-command="edit.redo"]').click(); await waitSaved(page);
  await page.locator('[data-command="edit.redo"]').click(); await waitSaved(page);
  d = await documentOf(page, doc.id); expect(d.assets).toHaveLength(2); expect(Object.keys(d.studio.rigDrafts)).toHaveLength(1);
});

test('Rig UI: changing a frozen pose or a pixel outside the movement mask blocks source review; undo restores the gate', async ({ page }) => {
  const doc = newDocument('Nguồn khóa', 18, 18), a = doc.assets[0], pixels = celFor(a, a.layers[0].id, a.frames[0].id, true)!.data!;
  for (let y = 7; y < 10; y++) for (let x = 7; x < 10; x++) pixels[y * 18 + x] = 0x70c989ff;
  const { saved, created } = await create(page, doc), draftId = Object.keys(created.studio.rigDrafts)[0], draft = created.studio.rigDrafts[draftId];
  await page.locator('#rig-btn-close').click();
  draft.frozenFrames = [{ frameId: draft.plan.frames[1].id, sourceFrameId: created.assets[1].frames[0].id }];
  draft.movementMaskResourceId = 'movement'; const mask = new Uint32Array(324); mask[0] = 1;
  created.studio.resources.movement = { version: 1, kind: 'mask', w: 18, h: 18, data: mask };
  const changed = await page.request.put(`/api/pixel/projects/${saved.id}`, { headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: created.revision, document: created }) }); expect(changed.ok(), await changed.text()).toBe(true);
  await page.reload(); await expect(page.locator('#asset-info')).toContainText('18 × 18'); await page.locator('#rig-open').click(); await expect(page.locator('#rig-btn-review')).toBeEnabled();
  await page.locator('#rig-timeline-strip button').nth(1).click(); await page.locator('#rig-frame-root-dx').fill('1'); await page.locator('#rig-frame-root-dx').press('Tab');
  await expect(page.locator('#rig-pose-error-banner')).toContainText('frame đã khóa'); await expect(page.locator('#rig-btn-review')).toBeDisabled();
  await page.locator('#rig-btn-undo').click(); await expect(page.locator('#rig-btn-review')).toBeEnabled();
  await page.locator('#rig-timeline-strip button').nth(0).click(); await page.locator('#rig-frame-root-dx').fill('1'); await page.locator('#rig-frame-root-dx').press('Tab');
  await expect(page.locator('#rig-pose-error-banner')).toContainText('ngoài vùng'); await expect(page.locator('#rig-btn-review')).toBeDisabled();
});
