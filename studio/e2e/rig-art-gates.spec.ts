import { test, expect } from '@playwright/test';
import { celFor, newDocument, newLayer, wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { createRecipeRenderer } from '../../src/studio/quality/renderer.ts';
import { createWalkPlan } from '../../src/studio/quality/motion-walk.ts';
import { walkFixture } from '../../test/fixtures/quality-walk.ts';

for (const incomplete of [true, false]) test(`Rig artwork gate: ${incomplete ? 'empty limbs block review but allow bone preview and draft save' : 'real limb pixels allow review'}`, async ({ page }) => {
  const fixture = walkFixture();
  if (incomplete) for (const part of fixture.recipe.parts) if (part.id !== 'root') part.paint = [];
  const motion = createWalkPlan(fixture, { legIds: ['a', 'b'], armIds: [], stridePx: 4,
    liftPx: 3, crouchPx: 2, armSwingDegrees: 0, rootMotion: false });
  const doc = newDocument('Kiểm tra pixel chi', 64, 64), asset = doc.assets[0];
  asset.palette = motion.recipe.palette; asset.layers = []; asset.cels = {}; asset.metadata.pivot = { x: .5, y: 1 };
  for (const part of motion.recipe.parts) {
    const layer = newLayer(part.name); layer.id = part.id; asset.layers.push(layer);
    const isolated = { ...motion.recipe, parts: motion.recipe.parts.map(p => ({ ...p, paint: p.id === part.id ? p.paint : [] })) };
    celFor(asset, layer.id, asset.frames[0].id, true)!.data = createRecipeRenderer(isolated).renderFrame('f0').image.data;
  }
  motion.rig.source = { ...motion.rig.source, projectId: doc.id, assetId: asset.id, frameId: asset.frames[0].id };
  doc.studio = { version: 2, quality: { version: 1, approvals: {} }, resources: {}, rigDrafts: {
    draft: { version: 1, id: 'draft', name: 'Kiểm tra pixel chi', origin: { assetId: asset.id, frameId: asset.frames[0].id },
      ...motion, resources: { sources: [], masks: [] }, movementMaskResourceId: null, frozenFrames: [] },
  } };
  const response = await page.request.post('/api/pixel/projects', { headers: { origin: 'http://127.0.0.1:4329', 'content-type': 'application/json' },
    data: wireStringify({ name: doc.name, document: doc }) });
  expect(response.ok(), await response.text()).toBe(true); const saved = wireParse(await response.text());
  await page.goto('/'); await page.locator('#projects').selectOption(saved.id); await page.locator('#rig-open').click();
  await expect(page.locator('#rig-refresh-warning')).not.toBeVisible();
  if (incomplete) {
    await expect(page.locator('#rig-btn-review')).toBeDisabled();
    await expect(page.locator('#rig-pose-error-banner')).toContainText('không có pixel RGBA');
    await page.locator('#rig-mode-pose').check(); await page.locator('#rig-timeline-strip button').nth(1).click();
    await expect(page.locator('#rig-canvas')).toHaveAttribute('width', '64');
    await page.locator('#rig-frame-duration').fill('137'); await page.locator('#rig-frame-duration').press('Tab');
    await expect(page.locator('#save-status')).toContainText('Đã lưu');
    await page.reload(); await expect(page.locator('#asset-info')).toContainText('64 × 64'); await page.locator('#rig-open').click();
    await page.locator('#rig-timeline-strip button').nth(1).click();
    await expect(page.locator('#rig-frame-duration')).toHaveValue('137');
    await expect(page.locator('#rig-btn-review')).toBeDisabled();
  } else {
    await expect(page.locator('#rig-pose-error-banner')).not.toBeVisible();
    await expect(page.locator('#rig-btn-review')).toBeEnabled();
  }
});
