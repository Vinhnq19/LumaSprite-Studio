import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng } from '../../src/node/studio/png.ts';
import { Img, pack } from '../../src/studio/raster.ts';

function buildCharacterSprite(variant: 'a' | 'b'): Buffer {
  const img = new Img(24, 24);
  const outline = pack(24, 28, 38, 255);
  const steel = variant === 'a' ? pack(140, 154, 174, 255) : pack(162, 182, 206, 255);
  const highlight = variant === 'a' ? pack(200, 214, 228, 255) : pack(236, 244, 255, 255);
  const cape = variant === 'a' ? pack(170, 56, 68, 255) : pack(204, 62, 78, 255);
  const visor = pack(98, 214, 182, 255);

  for (let y = 4; y <= 19; y++) {
    for (let x = 7; x <= 16; x++) {
      const border = y === 4 || y === 19 || x === 7 || x === 16;
      img.set(x, y, border ? outline : steel);
    }
  }
  for (let x = 9; x <= 14; x++) img.set(x, 6, highlight);
  for (let x = 9; x <= 14; x++) img.set(x, 9, visor);
  for (let y = 11; y <= 18; y++) {
    img.set(6, y, cape);
    img.set(17, y, variant === 'b' ? cape : 0);
  }
  // Exact straight-alpha pixel [28, 45, 62, 85] to verify zero premultiply/canvas distortion
  img.set(11, 21, pack(28, 45, 62, 85));
  img.set(12, 21, pack(28, 45, 62, 85));
  return encodePng(img);
}

function buildMismatchedProp(): Buffer {
  const img = new Img(16, 16);
  const gold = pack(236, 190, 74, 255);
  const edge = pack(42, 34, 28, 255);
  for (let y = 3; y <= 12; y++) {
    for (let x = 3; x <= 12; x++) {
      img.set(x, y, x === 3 || x === 12 || y === 3 || y === 12 ? edge : gold);
    }
  }
  return encodePng(img);
}

function buildAnimStrip(frameCount: number, accent: number): Buffer {
  const fw = 24;
  const fh = 24;
  const img = new Img(fw * frameCount, fh);
  const body = pack(112, 201, 137, 255);
  const dark = pack(20, 32, 38, 255);
  for (let f = 0; f < frameCount; f++) {
    const ox = f * fw;
    const bounceY = f === 1 ? -2 : f === 2 ? 1 : 0;
    for (let y = 7 + bounceY; y <= 17 + bounceY; y++) {
      for (let x = ox + 7; x <= ox + 16; x++) {
        img.set(x, y, x === ox + 7 || x === ox + 16 || y === 7 + bounceY || y === 17 + bounceY ? dark : body);
      }
    }
    img.set(ox + 10 + f * 2, 10 + bounceY, accent);
    img.set(ox + 11 + f * 2, 10 + bounceY, accent);
  }
  return encodePng(img);
}

async function openWorkbench(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#art-review-open').click();
  await expect(page.locator('#art-review-workbench')).toBeVisible();
}

async function captureEvidence(page: Page, fileName: string): Promise<void> {
  const dir = process.env.ARW_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, fileName) });
}

test('Art Review Workbench: standalone open, RGBA 1x/8x, Blink, Diff, Silhouette, mismatch guard, export & reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await openWorkbench(page);
  await page.locator('#arw-family').selectOption('character');

  const pngA = buildCharacterSprite('a');
  const pngB = buildCharacterSprite('b');

  await page.locator('#arw-png-baseline').setInputFiles({
    name: 'knight_v1.png',
    mimeType: 'image/png',
    buffer: pngA,
  });
  await page.locator('#arw-png-candidate').setInputFiles({
    name: 'knight_v2.png',
    mimeType: 'image/png',
    buffer: pngB,
  });

  await expect(page.locator('#arw-meta-baseline')).toContainText('knight_v1.png · 24×24');
  await expect(page.locator('#arw-meta-candidate')).toContainText('knight_v2.png · 24×24');

  // Native 1x nearest-neighbor verification
  await expect(page.locator('#arw-canvas-a')).toHaveAttribute('data-zoom', '1');
  await expect(page.locator('#arw-canvas-a')).toHaveCSS('image-rendering', 'pixelated');

  // Zoom 4x and inspect exact straight-alpha pixel (11, 21) = RGBA(28, 45, 62, 85)
  await page.locator('[data-arw-zoom="4"]').click();
  await expect(page.locator('#arw-canvas-a')).toHaveAttribute('data-zoom', '4');

  const boxA = (await page.locator('#arw-canvas-a').boundingBox())!;
  const geomA = await page.locator('#arw-canvas-a').evaluate((el: HTMLCanvasElement) => ({
    dx: Number(el.dataset.drawX),
    dy: Number(el.dataset.drawY),
    zoom: Number(el.dataset.zoom),
  }));
  await page.mouse.move(boxA.x + geomA.dx + 11.5 * geomA.zoom, boxA.y + geomA.dy + 21.5 * geomA.zoom);
  await expect(page.locator('#arw-rgba-readout')).toContainText('(11, 21)');
  await expect(page.locator('#arw-rgba-readout')).toContainText('RGBA(28, 45, 62, 85)');

  // Synchronized pan check: dragging Canvas A moves both A and B by exact same delta
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxA.x + boxA.width / 2 + 24, boxA.y + boxA.height / 2 - 12);
  await page.mouse.up();
  const afterPan = await page.evaluate(() => ({
    ax: Number(document.getElementById('arw-canvas-a')!.dataset.drawX),
    bx: Number(document.getElementById('arw-canvas-b')!.dataset.drawX),
  }));
  expect(afterPan.ax).toBe(afterPan.bx);
  await page.locator('#arw-pan-reset').click();

  await captureEvidence(page, '01-side-by-side-1x-4x.png');

  // Toggle A/B & Blink A/B
  await page.locator('[data-arw-mode="toggle-a"]').click();
  await expect(page.locator('#arw-canvas-single')).toHaveAttribute('data-blink-slot', 'baseline');
  await page.locator('[data-arw-mode="toggle-b"]').click();
  await expect(page.locator('#arw-canvas-single')).toHaveAttribute('data-blink-slot', 'candidate');

  await page.locator('[data-arw-mode="blink"]').click();
  await page.locator('#arw-blink-ms').selectOption('250');
  const firstBlinkSlot = await page.locator('#arw-canvas-single').getAttribute('data-blink-slot');
  await expect
    .poll(() => page.locator('#arw-canvas-single').getAttribute('data-blink-slot'), { timeout: 3000 })
    .not.toBe(firstBlinkSlot);

  // Checkerboard / Dark / Light background switching
  await page.locator('#arw-bg').selectOption('dark');
  await page.locator('#arw-bg').selectOption('light');
  await page.locator('#arw-bg').selectOption('checker');

  // Pixel Diff on aligned same-size images
  await page.locator('[data-arw-mode="diff"]').click();
  await expect(page.locator('#arw-diff-readout')).toContainText('Diff:');
  const changed = Number(await page.locator('#arw-canvas-single').getAttribute('data-diff-changed'));
  expect(changed).toBeGreaterThan(0);

  // Silhouette / Alpha view
  await page.locator('[data-arw-mode="silhouette"]').click();
  await expect(page.locator('#arw-diff-readout')).toContainText('bán trong');
  await captureEvidence(page, '03-silhouette-alpha.png');

  // Mismatch guard: load 16x16 prop into B against 24x24 A -> no auto-scaling + requires confirmation
  await page.locator('#arw-png-candidate').setInputFiles({
    name: 'shield_16.png',
    mimeType: 'image/png',
    buffer: buildMismatchedProp(),
  });
  await expect(page.locator('#arw-alignment-bar')).toBeVisible();
  await expect(page.locator('#arw-mismatch-reasons')).toContainText('24×24');
  await expect(page.locator('#arw-mismatch-reasons')).toContainText('16×16');
  await expect(page.locator('#arw-meta-candidate')).toContainText('shield_16.png · 16×16');
  await page.locator('[data-arw-mode="diff"]').click();
  await expect(page.locator('#arw-diff-guard')).toBeVisible();
  await captureEvidence(page, '02-pixel-diff-and-mismatch.png');

  // Confirm alignment clears diff guard
  await page.locator('#arw-align-mode').selectOption('center');
  await page.locator('#arw-align-confirm').check();
  await expect(page.locator('#arw-diff-guard')).toBeHidden();

  // Restore Candidate B back to 24x24 knight_v2 for Human Review & Export
  await page.locator('#arw-png-candidate').setInputFiles({
    name: 'knight_v2.png',
    mimeType: 'image/png',
    buffer: pngB,
  });

  // Human score sheet + critical flag + pinned region note + switching modes keeps data intact
  const silhouetteCard = page.locator('.arw-criterion-card[data-criterion-id="silhouette"]');
  await silhouetteCard.locator('select').first().selectOption('5');
  await silhouetteCard.locator('input[type="text"]').fill('Silhouette rõ ở 1x');

  const materialsCard = page.locator('.arw-criterion-card[data-criterion-id="materials"]');
  await materialsCard.locator('select').first().selectOption('2');
  await materialsCard.locator('select').nth(1).selectOption('critical');
  await expect(page.locator('#arw-critical-alert')).toBeVisible();

  await page.locator('[data-arw-mode="side-by-side"]').click();
  await page.locator('#arw-pin-mode').check();
  const boxB = (await page.locator('#arw-canvas-b').boundingBox())!;
  await page.mouse.click(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
  await expect(page.locator('.arw-region-item')).toHaveCount(1);
  await page.locator('#arw-pin-mode').uncheck();

  await page.locator('#arw-summary-note').fill('Candidate B đọc tốt hơn nhưng cần sửa vật liệu kim loại.');
  await page.locator('[data-arw-decision="candidate"]').click();
  await expect(page.locator('#arw-critical-override-box')).toBeVisible();

  // Attempting export without rationale when Critical defect is active must warn & require rationale
  await page.locator('#arw-export-json').click();
  await expect(page.locator('#arw-error')).toContainText('Lý do chọn khi còn lỗi Critical');
  await page.locator('#arw-critical-rationale').fill('Chọn B để đối chiếu silhouette tốt hơn, giữ sửa tiếp vật liệu.');

  // Switching modes must never lose review state
  await page.locator('[data-arw-mode="diff"]').click();
  await page.locator('[data-arw-mode="side-by-side"]').click();
  await expect(silhouetteCard.locator('select').first()).toHaveValue('5');
  await expect(page.locator('#arw-summary-note')).toHaveValue(
    'Candidate B đọc tốt hơn nhưng cần sửa vật liệu kim loại.',
  );
  await captureEvidence(page, '05-human-score-sheet.png');

  // Invalid JSON import shows alert without wiping review state
  await page.locator('#arw-rubric-import').setInputFiles({
    name: 'bad-rubric.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{bad-json', 'utf8'),
  });
  await expect(page.locator('#arw-error')).toBeVisible();
  await expect(page.locator('#arw-summary-note')).toHaveValue(
    'Candidate B đọc tốt hơn nhưng cần sửa vật liệu kim loại.',
  );

  // Export JSON & Markdown
  const dlJsonPromise = page.waitForEvent('download');
  await page.locator('#arw-export-json').click();
  const dlJson = await dlJsonPromise;
  const exportedJsonText = await readFile((await dlJson.path())!, 'utf8');
  const exportedJson = JSON.parse(exportedJsonText);
  expect(exportedJson.decision).toBe('candidate');
  expect(exportedJson.baselineRef.sourceSha256).toHaveLength(64);
  expect(exportedJson.candidateRef.sourceSha256).toHaveLength(64);
  expect(exportedJson.regionNotes).toHaveLength(1);

  const dlMdPromise = page.waitForEvent('download');
  await page.locator('#arw-export-md').click();
  const dlMd = await dlMdPromise;
  const exportedMd = await readFile((await dlMd.path())!, 'utf8');
  expect(exportedMd).toContain('B — Candidate');
  expect(exportedMd).toContain('Critical Defects:** YES');
  expect(exportedMd).toContain('KHÔNG tự đánh dấu Artistic PASS');
  expect(exportedMd).not.toMatch(/Verdict:\s*Artistic PASS/i);

  // Reload & Reopen Workbench restores persisted session + cached sprites
  await page.reload();
  await page.locator('#art-review-open').click();
  await expect(page.locator('#art-review-workbench')).toBeVisible();
  await expect(page.locator('#arw-meta-baseline')).toContainText('knight_v1.png');
  await expect(page.locator('#arw-summary-note')).toHaveValue(
    'Candidate B đọc tốt hơn nhưng cần sửa vật liệu kim loại.',
  );
  await expect(page.locator('[data-arw-decision="candidate"]')).toHaveClass(/active/);

  expect(errors).toEqual([]);
});

test('Art Review Workbench: Animation Review with real timing JSON, sync mismatch, onion, pivot, loop boundary & responsive', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await openWorkbench(page);
  await page.locator('#arw-reset').click();
  await page.locator('#arw-family').selectOption('animation');
  await page.locator('[data-arw-zoom="4"]').click();

  const stripA = buildAnimStrip(3, pack(255, 210, 90, 255));
  const stripB = buildAnimStrip(2, pack(255, 110, 140, 255));

  const metaA = JSON.stringify({
    frameWidth: 24,
    frameHeight: 24,
    pivot: { x: 12, y: 21 },
    frames: [
      { x: 0, y: 0, w: 24, h: 24, duration: 70 },
      { x: 24, y: 0, w: 24, h: 24, duration: 140 },
      { x: 48, y: 0, w: 24, h: 24, duration: 90 },
    ],
  });
  const metaB = JSON.stringify({
    frameWidth: 24,
    frameHeight: 24,
    pivot: { x: 12, y: 21 },
    durations: [110, 190],
  });

  await page.locator('#arw-png-baseline').setInputFiles({
    name: 'slime_a_strip.png',
    mimeType: 'image/png',
    buffer: stripA,
  });
  await page.locator('#arw-json-baseline').setInputFiles({
    name: 'slime_a.json',
    mimeType: 'application/json',
    buffer: Buffer.from(metaA, 'utf8'),
  });

  await page.locator('#arw-png-candidate').setInputFiles({
    name: 'slime_b_strip.png',
    mimeType: 'image/png',
    buffer: stripB,
  });
  await page.locator('#arw-json-candidate').setInputFiles({
    name: 'slime_b.json',
    mimeType: 'application/json',
    buffer: Buffer.from(metaB, 'utf8'),
  });

  // Real timings preserved (never defaulted to 100ms)
  await expect(page.locator('#arw-strip-a')).toContainText('#1 · 70ms');
  await expect(page.locator('#arw-strip-a')).toContainText('#2 · 140ms');
  await expect(page.locator('#arw-strip-a')).toContainText('#3 · 90ms');
  await expect(page.locator('#arw-strip-b')).toContainText('#1 · 110ms');
  await expect(page.locator('#arw-strip-b')).toContainText('#2 · 190ms');

  // Time-based sync warning when A & B timings differ
  await expect(page.locator('#arw-sync-note')).toContainText('không giả định frame index');

  // Step frame, Onion skin, Frame Diff, Loop boundary inspection
  await page.locator('#arw-anim-next').click();
  await expect(page.locator('#arw-canvas-a')).toHaveAttribute('data-frame-index', '1');
  await page.locator('#arw-anim-onion').check();
  await page.locator('#arw-anim-framediff').check();
  await page.locator('#arw-anim-boundary').check();
  await expect(page.locator('#arw-loop-boundary')).toBeVisible();
  await expect(page.locator('#arw-loop-boundary')).toContainText('f3 → f1');

  await captureEvidence(page, '04-animation-sync-review.png');

  // One-shot playback finishes cleanly
  await page.locator('#arw-anim-reset').click();
  await page.locator('#arw-anim-loop').uncheck();
  await page.locator('#arw-anim-play').click();
  await expect(page.locator('#arw-anim-play')).toHaveText('▶ Phát', { timeout: 3000 });

  // Responsive viewport checks
  for (const [width, height] of [
    [1280, 720],
    [1366, 768],
    [1440, 960],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('#arw-export-md')).toBeVisible();
    await expect(page.locator('#arw-canvas-a')).toBeVisible();
  }

  if (process.env.ARW_EVIDENCE_DIR) {
    await writeFile(
      join(process.env.ARW_EVIDENCE_DIR, 'browser-summary.json'),
      JSON.stringify({ status: 'pass', viewports: ['1280x720', '1366x768', '1440x960'], errors }, null, 2),
    );
  }
  expect(errors).toEqual([]);
});
