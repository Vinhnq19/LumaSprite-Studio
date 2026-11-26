import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENGINE_RESULTS = 'D:\\LumaSprite-Engine\\benchmarks\\results';
const HAS_ENGINE_ASSETS = existsSync(join(ENGINE_RESULTS, 'e54', 'packages', 'surveyor', 'walk', 'timing.json'));

async function openWorkbench(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#art-review-open').click();
  await expect(page.locator('#art-review-workbench')).toBeVisible();
  await page.locator('#arw-reset').click();
}

async function loadPng(page: Page, slot: 'baseline' | 'candidate', filePath: string, name: string) {
  const buffer = await readFile(filePath);
  await page.locator(`#arw-png-${slot}`).setInputFiles({
    name,
    mimeType: 'image/png',
    buffer,
  });
}

async function loadJson(page: Page, slot: 'baseline' | 'candidate', filePath: string, name: string) {
  const buffer = await readFile(filePath);
  await page.locator(`#arw-json-${slot}`).setInputFiles({
    name,
    mimeType: 'application/json',
    buffer,
  });
}

async function captureAcceptance(page: Page, fileName: string): Promise<void> {
  const dir = process.env.ARW_ACCEPTANCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, fileName) });
}

test.describe('Art Review Workbench — Real Locked Engine Assets Acceptance (READ-ONLY)', () => {
  test.skip(!HAS_ENGINE_ASSETS, 'Locked Engine benchmark assets not present on this host.');

  test('Real Character 64×64 (Surveyor R2 vs Courier Rev): 1x, Focus/Fit, Diff, Silhouette, Critical rationale & JSON reimport', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await openWorkbench(page);
    await page.locator('#arw-family').selectOption('character');

    await loadPng(page, 'baseline', join(ENGINE_RESULTS, 'e44', 'packages', 'r2', 'final.png'), 'surveyor-r2-64.png');
    await loadPng(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e44', 'packages', 'courier-rev', 'final.png'),
      'courier-rev-64.png',
    );

    await expect(page.locator('#arw-meta-baseline')).toContainText('64×64');
    await expect(page.locator('#arw-meta-candidate')).toContainText('64×64');

    // Native 1x mandatory inspection
    await expect(page.locator('#arw-canvas-a')).toHaveAttribute('data-zoom', '1');
    await expect(page.locator('#arw-zoom-indicator')).toHaveText('1× Native');
    await expect(page.locator('#arw-canvas-a')).toHaveCSS('image-rendering', 'pixelated');
    await captureAcceptance(page, '01-real-character-64x64-1x.png');

    // Focus / Fit integer zoom applies equal integer scale to both A and B
    await page.locator('#arw-zoom-fit').click();
    const fitZoomA = Number(await page.locator('#arw-canvas-a').getAttribute('data-zoom'));
    const fitZoomB = Number(await page.locator('#arw-canvas-b').getAttribute('data-zoom'));
    expect(fitZoomA).toBeGreaterThanOrEqual(4);
    expect(Number.isInteger(fitZoomA)).toBe(true);
    expect(fitZoomA).toBe(fitZoomB);
    await captureAcceptance(page, '02-real-character-64x64-focus-fit.png');

    // Inspect at 4x Pixel Diff and Silhouette + Alpha Channel
    await page.locator('[data-arw-zoom="4"]').click();
    await page.locator('[data-arw-mode="diff"]').click();
    await expect(page.locator('#arw-diff-readout')).toContainText('Diff:');
    const diffChanged = Number(await page.locator('#arw-canvas-single').getAttribute('data-diff-changed'));
    expect(diffChanged).toBeGreaterThan(100);

    await page.locator('[data-arw-mode="silhouette"]').click();
    await expect(page.locator('#arw-diff-readout')).toContainText('A alpha:');
    await page.locator('#arw-sil-mode').selectOption('alpha-channel');
    await expect(page.locator('#arw-diff-readout')).toContainText('B alpha:');

    // Score & flag critical defect -> selecting Candidate B requires rationale
    const silCard = page.locator('.arw-criterion-card[data-criterion-id="silhouette"]');
    await silCard.locator('select').first().selectOption('4');
    const poseCard = page.locator('.arw-criterion-card[data-criterion-id="pose"]');
    await poseCard.locator('select').first().selectOption('2');
    await poseCard.locator('select').nth(1).selectOption('critical');
    await page.locator('[data-arw-decision="candidate"]').click();
    await expect(page.locator('#arw-critical-override-box')).toBeVisible();

    // Blocking export without rationale
    await page.locator('#arw-export-json').click();
    await expect(page.locator('#arw-error')).toContainText('Lý do chọn khi còn lỗi Critical');

    await page
      .locator('#arw-critical-rationale')
      .fill('Chọn Courier Rev để đối chiếu silhouette tay cầm; còn lỗi Critical ở pose 3/4.');
    await page.locator('#arw-summary-note').fill('Real Engine E4.4 Surveyor R2 vs Courier Rev 64×64.');
    await captureAcceptance(page, '03-real-character-diff-silhouette-critical.png');

    const dlPromise = page.waitForEvent('download');
    await page.locator('#arw-export-json').click();
    const dl = await dlPromise;
    const exportedJsonText = await readFile((await dl.path())!, 'utf8');
    const exported = JSON.parse(exportedJsonText);
    expect(exported.decision).toBe('candidate');
    expect(exported.criticalOverrideRationale).toContain('silhouette tay cầm');
    expect(exported.baselineRef.sourceSha256).toHaveLength(64);
    expect(exported.candidateRef.sourceSha256).toHaveLength(64);

    // Reset and reimport Review JSON -> state restored cleanly
    await page.locator('#arw-reset').click();
    await expect(page.locator('#arw-summary-note')).toHaveValue('');
    await page.locator('#arw-review-import').setInputFiles({
      name: 'real-char-review.json',
      mimeType: 'application/json',
      buffer: Buffer.from(exportedJsonText, 'utf8'),
    });
    await expect(page.locator('#arw-summary-note')).toHaveValue('Real Engine E4.4 Surveyor R2 vs Courier Rev 64×64.');
    await expect(page.locator('#arw-critical-rationale')).toHaveValue(
      'Chọn Courier Rev để đối chiếu silhouette tay cầm; còn lỗi Critical ở pose 3/4.',
    );
    await expect(page.locator('[data-arw-decision="candidate"]')).toHaveClass(/active/);

    expect(errors).toEqual([]);
  });

  test('Real Animation W2 Walk (Surveyor 880ms vs Courier 960ms): real timing JSON, pivot alignment, sync & loop boundary', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await openWorkbench(page);
    await page.locator('#arw-family').selectOption('animation');

    await loadPng(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e54', 'packages', 'surveyor', 'walk', 'spritesheet.png'),
      'surveyor-w2-walk.png',
    );
    await loadJson(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e54', 'packages', 'surveyor', 'walk', 'timing.json'),
      'surveyor-timing.json',
    );

    await loadPng(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e54', 'packages', 'courier', 'walk', 'spritesheet.png'),
      'courier-walk.png',
    );
    await loadJson(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e54', 'packages', 'courier', 'walk', 'timing.json'),
      'courier-timing.json',
    );

    // Real Engine timings preserved (never 100ms default)
    await expect(page.locator('#arw-strip-a')).toContainText('#1 · 120ms');
    await expect(page.locator('#arw-strip-a')).toContainText('#2 · 115ms');
    await expect(page.locator('#arw-strip-a')).toContainText('#3 · 95ms');
    await expect(page.locator('#arw-strip-b')).toContainText('#1 · 125ms');
    await expect(page.locator('#arw-strip-b')).toContainText('#2 · 130ms');
    await expect(page.locator('#arw-strip-b')).toContainText('#3 · 110ms');

    // Different pivot (30,59) vs (32,58) triggers alignment warning automatically
    await expect(page.locator('#arw-alignment-bar')).toBeVisible();
    await expect(page.locator('#arw-mismatch-reasons')).toContainText('(30, 59)');
    await expect(page.locator('#arw-mismatch-reasons')).toContainText('(32, 58)');
    await page.locator('#arw-align-mode').selectOption('pivot');
    await page.locator('#arw-align-confirm').check();

    // Different total duration (880ms vs 960ms) triggers time-sync explanation
    await expect(page.locator('#arw-sync-note')).toContainText('880 ms');
    await expect(page.locator('#arw-sync-note')).toContainText('960 ms');
    await expect(page.locator('#arw-sync-note')).toContainText('không giả định frame index');

    await page.locator('[data-arw-zoom="4"]').click();
    await page.locator('#arw-anim-next').click();
    await page.locator('#arw-anim-onion').check();
    await page.locator('#arw-anim-boundary').check();
    await expect(page.locator('#arw-loop-boundary')).toBeVisible();
    await expect(page.locator('#arw-loop-boundary')).toContainText('f8 → f1');
    await captureAcceptance(page, '04-real-animation-w2-walk-sync.png');

    expect(errors).toEqual([]);
  });

  test('Real Environment 320×208 (C1 Courtyard Day vs R1 Signal Entrance Day): 1x, Fit, Stage Focus & responsive', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await openWorkbench(page);
    await page.locator('#arw-family').selectOption('environment');

    await loadPng(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e62', 'packages', 'c1-courtyard-day', 'scene.png'),
      'c1-courtyard-day.png',
    );
    await loadPng(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e63', 'packages', 'r1-signal-entrance-day', 'scene.png'),
      'r1-signal-entrance-day.png',
    );

    await expect(page.locator('#arw-meta-baseline')).toContainText('320×208');
    await expect(page.locator('#arw-meta-candidate')).toContainText('320×208');

    // Toggle Stage Focus to maximize space for 320x208 scenes
    await page.locator('#arw-stage-focus').click();
    await expect(page.locator('#art-review-workbench')).toHaveClass(/arw-stage-focused/);
    await page.locator('#arw-zoom-fit').click();
    const fitZoom = Number(await page.locator('#arw-canvas-a').getAttribute('data-zoom'));
    expect(fitZoom).toBeGreaterThanOrEqual(1);
    await captureAcceptance(page, '05-real-environment-320x208.png');

    // Restore header and check Pixel Diff
    await page.locator('#arw-stage-focus').click();
    await page.locator('[data-arw-mode="diff"]').click();
    await expect(page.locator('#arw-diff-readout')).toContainText('Diff:');

    // Desktop responsive check
    for (const [width, height] of [
      [1280, 720],
      [1366, 768],
      [1440, 960],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('#arw-export-json')).toBeVisible();
      await expect(page.locator('#arw-canvas-single')).toBeVisible();
    }

    expect(errors).toEqual([]);
  });

  test('Real UI Icon & VFX Strip E6.4: state sheet, one-shot VFX timing, and size mismatch guard', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await openWorkbench(page);
    await page.locator('#arw-family').selectOption('ui');

    await loadPng(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e64', 'packages', 'interaction-icon', 'spritesheet.png'),
      'interaction-icon.png',
    );
    await loadJson(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e64', 'packages', 'interaction-icon', 'states.json'),
      'interaction-states.json',
    );
    await loadPng(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e64', 'packages', 'inventory-barrel', 'frame-0.png'),
      'inventory-barrel.png',
    );

    await expect(page.locator('#arw-meta-baseline')).toContainText('16×16 · 2f (UI states)');
    await expect(page.locator('#arw-strip-a')).toContainText('#1 · normal');
    await expect(page.locator('#arw-strip-a')).toContainText('#2 · active');
    await expect(page.locator('#arw-alignment-bar')).toBeVisible();
    await expect(page.locator('#arw-mismatch-reasons')).toContainText('16×16');
    await expect(page.locator('#arw-mismatch-reasons')).toContainText('32×32');

    await page.locator('#arw-zoom-fit').click();
    const uiFitZoom = Number(await page.locator('#arw-canvas-a').getAttribute('data-zoom'));
    expect(uiFitZoom).toBeGreaterThanOrEqual(4);
    await page.locator('#arw-anim-next').click();
    await captureAcceptance(page, '06-real-ui-icon-e64-mismatch.png');

    // VFX E6.4 One-Shot Strips: signal-activation (48x48, 7f, 685ms, once) vs pickup-sparkle (32x32, 6f, 410ms, once)
    await page.locator('#arw-reset').click();
    await page.locator('#arw-family').selectOption('vfx');

    await loadPng(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e64', 'packages', 'signal-activation', 'spritesheet.png'),
      'signal-activation.png',
    );
    await loadJson(
      page,
      'baseline',
      join(ENGINE_RESULTS, 'e64', 'packages', 'signal-activation', 'timing.json'),
      'signal-timing.json',
    );

    await loadPng(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e64', 'packages', 'pickup-sparkle', 'spritesheet.png'),
      'pickup-sparkle.png',
    );
    await loadJson(
      page,
      'candidate',
      join(ENGINE_RESULTS, 'e64', 'packages', 'pickup-sparkle', 'timing.json'),
      'sparkle-timing.json',
    );

    // Real timings + loop: "once" honored
    await expect(page.locator('#arw-anim-loop')).not.toBeChecked();
    await expect(page.locator('#arw-strip-a')).toContainText('#1 · 115ms');
    await expect(page.locator('#arw-strip-a')).toContainText('#4 · 105ms');
    await expect(page.locator('#arw-strip-b')).toContainText('#1 · 55ms');
    await expect(page.locator('#arw-strip-b')).toContainText('#3 · 75ms');
    await expect(page.locator('#arw-sync-note')).toContainText('685 ms');
    await expect(page.locator('#arw-sync-note')).toContainText('410 ms');

    await page.locator('#arw-zoom-fit').click();
    await page.locator('#arw-anim-next').click();
    await page.locator('#arw-anim-next').click();
    await captureAcceptance(page, '07-real-vfx-e64-oneshot.png');

    if (process.env.ARW_ACCEPTANCE_DIR) {
      await writeFile(
        join(process.env.ARW_ACCEPTANCE_DIR, 'acceptance-metrics.json'),
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            uiFitZoom,
            vfxFitZoom: Number(await page.locator('#arw-canvas-a').getAttribute('data-zoom')),
            errors,
          },
          null,
          2,
        ),
      );
    }

    expect(errors).toEqual([]);
  });
});
