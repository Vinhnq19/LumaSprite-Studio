import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wireParse, wireStringify, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { unzipTestStored } from '../../test/fixtures/image-assertions.ts';

const ENGINE_E8_ROOT = 'D:\\LumaSprite-Engine\\.cache\\e8-adapter-1';
const CAPTURE_DIR = process.env.E84_CAPTURE_DIR;

function hasFixtures() {
  return existsSync(join(ENGINE_E8_ROOT, 'bundle.json'));
}

test('E8.4 Studio Native Scene Adapter UI: import real B2 scenes, inspect overlays, edit, undo, reopen & export', async ({ page }) => {
  test.skip(!hasFixtures(), 'Locked Engine E8 runtime bundle not found');
  test.setTimeout(120000);

  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  if (CAPTURE_DIR) await mkdir(CAPTURE_DIR, { recursive: true });
  const capture = async (name: string) => {
    if (CAPTURE_DIR) await page.locator('#production-workspace').screenshot({ path: join(CAPTURE_DIR, name) });
  };

  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const createRes = await page.request.post('/api/pixel/projects', {
    headers: { origin, 'Content-Type': 'application/json' },
    data: wireStringify({ name: 'E8.4 Native Scene Workspace', w: 32, h: 32, background: 0 }),
  });
  expect(createRes.ok()).toBeTruthy();
  const created: PixelDocument = wireParse(await createRes.text());

  await page.reload();
  await page.locator('#projects').selectOption(created.id);
  await page.locator('#production-open').click();
  await expect(page.locator('#prod-status')).toHaveText('Sẵn sàng');

  await page.locator('#prod-tab-native-scene').click();
  await expect(page.locator('#prod-panel-native-scene')).toBeVisible();

  // 1. Import Mistfen Day (E8 runtime)
  const waitIdle = async () => {
    await expect(page.locator('#production-workspace')).toHaveAttribute('aria-busy', 'false');
  };
  await page.locator('#ns-source-dir').fill(join(ENGINE_E8_ROOT, 'mistfen-ferry-landing', 'day'));
  await page.locator('#ns-light').selectOption('day');
  await page.locator('#ns-import-btn').click();
  await waitIdle();
  await expect(page.locator('#prod-status')).toContainText('Đã import scene e8-mistfen-ferry-landing-day');
  await expect(page.locator('#ns-canvas')).toHaveAttribute('data-ready', 'e8-mistfen-ferry-landing-day');
  await expect(page.locator('#ns-canvas')).toBeVisible();
  await expect(page.locator('#ns-provenance')).toContainText('mistfen-ferry-landing (day)');
  await expect(page.locator('#ns-provenance')).toContainText('UNREVIEWED');

  await capture('01-mistfen-day-overview.png');

  // 2. Toggle Collision + Walkable + Interaction + Occlusion overlays
  await page.locator('#ns-ov-collision').check();
  await page.locator('#ns-ov-walkable').check();
  await page.locator('#ns-ov-occlusion').check();
  await capture('02-mistfen-day-overlays.png');

  // 3. Switch to Atlas Inspector and Tilemap Ground views
  await page.locator('#ns-view-mode').selectOption('atlas');
  await page.locator('#ns-ov-grid').check();
  await capture('03-mistfen-atlas.png');

  await page.locator('#ns-view-mode').selectOption('ground');
  await capture('04-mistfen-ground-tilemap.png');

  await page.locator('#ns-view-mode').selectOption('composite');
  await page.locator('#ns-ov-collision').uncheck();
  await page.locator('#ns-ov-walkable').uncheck();
  await page.locator('#ns-ov-occlusion').uncheck();
  await page.locator('#ns-ov-grid').uncheck();

  // 4. Import Floodgate Day and Canal Intake Day + Mistfen Night
  for (const [scene, light, shot] of [
    ['mistfen-ferry-landing', 'night', '05-mistfen-night.png'],
    ['floodgate-maintenance-yard', 'day', '06-floodgate-day.png'],
    ['canal-intake-service-platform', 'day', '07-canal-intake-day.png'],
  ] as const) {
    await page.locator('#ns-source-dir').fill(join(ENGINE_E8_ROOT, scene, light));
    await page.locator('#ns-light').selectOption(light);
    await page.locator('#ns-import-btn').click();
    await waitIdle();
    await expect(page.locator('#ns-provenance')).toContainText(`${scene} (${light})`);
    await expect(page.locator('#ns-canvas')).toHaveAttribute('data-ready', `e8-${scene}-${light}`);
    await page.locator('#ns-ov-collision').check();
    await page.locator('#ns-ov-walkable').check();
    await capture(shot);
    await page.locator('#ns-ov-collision').uncheck();
    await page.locator('#ns-ov-walkable').uncheck();
  }

  // 5. Switch back to Mistfen Day and perform controlled Studio edit + Undo/Redo + Persistence across reload
  await page.locator('#ns-scene-select').selectOption('e8-mistfen-ferry-landing-day');
  await expect(page.locator('#ns-provenance')).toContainText('mistfen-ferry-landing (day)');
  await expect(page.locator('#ns-canvas')).toHaveAttribute('data-ready', 'e8-mistfen-ferry-landing-day');
  await page.locator('#ns-zoom').selectOption('2');
  await capture('08-before-edit-mistfen.png');

  await page.locator('#ns-actor-select').selectOption('surveyor');
  const origX = Number(await page.locator('#ns-actor-x').inputValue());
  await page.locator('#ns-actor-x').fill(String(origX + 4));
  await page.locator('#ns-actor-apply').click();
  await waitIdle();
  await expect(page.locator('#prod-status')).toContainText('Chỉnh vị trí actor');

  // Edit interaction label override & toggle supply-barrel layer off
  await page.locator('#ns-int-label').fill('Kiểm tra bến phà (Studio)');
  await page.locator('#ns-int-apply').click();
  await waitIdle();
  await expect(page.locator('#ns-interaction-meta')).toContainText('Kiểm tra bến phà (Studio)');

  const barrelCb = page.locator('[data-layer-id="supply-barrel"] input[type="checkbox"]');
  await barrelCb.uncheck();
  await waitIdle();
  await expect(page.locator('#ns-provenance')).toContainText('Studio rev:');
  await capture('09-after-edit-mistfen.png');

  // Verify Undo & Redo work cleanly
  await page.locator('#prod-undo').click();
  await waitIdle();
  await expect(barrelCb).toBeChecked();
  await page.locator('#prod-redo').click();
  await waitIdle();
  await expect(barrelCb).not.toBeChecked();

  // Reload browser page and confirm Save/Reopen preserves everything
  await page.reload();
  await page.locator('#projects').selectOption(created.id);
  await page.locator('#production-open').click();
  await expect(page.locator('#prod-status')).toHaveText('Sẵn sàng');
  await page.locator('#prod-tab-native-scene').click();
  await page.locator('#ns-scene-select').selectOption('e8-mistfen-ferry-landing-day');
  await expect(page.locator('#ns-canvas')).toHaveAttribute('data-ready', 'e8-mistfen-ferry-landing-day');
  await page.locator('#ns-actor-select').selectOption('surveyor');
  await expect(page.locator('#ns-actor-x')).toHaveValue(String(origX + 4));
  await expect(page.locator('#ns-interaction-meta')).toContainText('Kiểm tra bến phà (Studio)');
  await expect(page.locator('[data-layer-id="supply-barrel"] input[type="checkbox"]')).not.toBeChecked();

  // 6. Export ZIP & verify contents
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#ns-export-btn').click(),
  ]);
  const dlPath = await download.path();
  expect(dlPath).toBeTruthy();
  const fs = await import('node:fs');
  const exportedFiles = unzipTestStored(fs.readFileSync(dlPath!));
  const expJson = JSON.parse(exportedFiles['mistfen-ferry-landing/day/scene.json'].toString('utf8'));
  expect(expJson.spawn.x).toBe(origX + 4);
  expect(exportedFiles['studio-scene-sidecar.json']).toBeTruthy();

  if (CAPTURE_DIR) {
    await writeFile(join(CAPTURE_DIR, 'meta.json'), JSON.stringify({ projectId: created.id, editedSpawn: expJson.spawn }, null, 2));
  }
  expect(errors).toEqual([]);
});
