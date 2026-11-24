import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { wireParse, wireStringify } from '../../src/studio/pixel/model.ts';
import { defaultPalette } from '../../src/studio/pixel/palette.ts';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log('REGION UI DIAGNOSTIC', await page.evaluate(() =>
      Object.fromEntries(['notice', 'save-status', 'ai-status', 'ai-modal-error', 'region-error', 'region-status', 'proposal-errors', 'proposal-description'].map(
        id => [id, window.document.getElementById(id)?.textContent]
      ))
    ));
  }
});

function decodePng(data: Uint8Array): { w: number; h: number; pixels: Uint32Array } {
  const b = Buffer.from(data);
  let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let o = 8; o + 12 <= b.length;) {
    const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); mode = d[9]; }
    if (t === 'PLTE') palette = Buffer.from(d);
    if (t === 'tRNS') alpha = Buffer.from(d);
    if (t === 'IDAT') chunks.push(d);
    o += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), out = new Uint32Array(w * h), stride = w * (mode === 3 ? 1 : 4) + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * stride + 1 + x * (mode === 3 ? 1 : 4);
      if (mode === 3) {
        const i = raw[j];
        out[y * w + x] = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) | (palette[i * 3 + 2] << 8) | (alpha[i] ?? 255)) >>> 0;
      } else {
        out[y * w + x] = raw.readUInt32BE(j);
      }
    }
  }
  return { w, h, pixels: out };
}

async function create(page: Page, name: string, size = 18): Promise<void> {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption(String(size));
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();
  await expect(page.locator('#asset-info')).toContainText(`${size} × ${size}`);
}

async function createAndSeed(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.locator('#new-project').click();
  await page.locator('#new-name').fill(name);
  await page.locator('#size-preset').selectOption('32');
  await page.locator('#create-form').getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible();

  const curDoc = await document(page);
  const asset = curDoc.assets[0];
  const updatedAsset = structuredClone(asset);
  updatedAsset.frames.push({ id: 'frame-extra-137', duration: 137 });
  updatedAsset.metadata = {
    pivot: { x: 0.23, y: 0.91 },
    hitbox: { x: 4, y: 4, w: 12, h: 12 },
    events: [{ frame: 1, name: 'hit' }],
  };
  const layerId = updatedAsset.layers[0].id;
  updatedAsset.layers[0].cels['frame-extra-137'] = 'cel-f137';
  const data = new Uint32Array(32 * 32);
  data[0] = 0x70c989ff;
  // Sparse L-shape of 3 white pixels (0xffffffff is in defaultPalette)
  data[15 * 32 + 15] = 0xffffffff;
  data[16 * 32 + 15] = 0xffffffff;
  data[16 * 32 + 16] = 0xffffffff;
  updatedAsset.cels['cel-f137'] = { id: 'cel-f137', layerId, frameId: 'frame-extra-137', data };

  const putRes = await page.request.put(`/api/pixel/projects/${curDoc.id}`, {
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:4329',
    },
    data: wireStringify({
      revision: curDoc.revision,
      document: {
        ...curDoc,
        assets: [updatedAsset],
      },
    }),
  });
  expect(putRes.status()).toBe(200);

  // Reload page cleanly to load the seeded document
  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();
  return curDoc.id;
}

async function document(page: Page): Promise<any> {
  const id = await page.locator('#projects').inputValue();
  return wireParse(await (await page.request.get(`/api/pixel/projects/${id}`, { maxRetries: 2 })).text());
}

async function color(page: Page, value: string): Promise<void> {
  await page.locator('#hex').fill(value);
  await page.locator('#hex').press('Tab');
}

test('Region UI: Missing selection disables submit with clear guidance', async ({ page }) => {
  await create(page, 'No Selection Test', 18);
  await page.locator('#ai-open').click();
  await expect(page.locator('#generation-workspace')).toBeVisible();

  // Click #ai-region-edit without any selection on canvas
  await page.locator('#ai-region-edit').click();
  await expect(page.locator('#region-dialog')).toBeVisible();

  // Submit button must be disabled, with explanation shown
  await expect(page.locator('#region-submit')).toBeDisabled();
  await expect(page.locator('#region-status')).toContainText('Chưa chọn vùng pixel');

  // Cancel closes the dialog safely
  await page.locator('#region-close').click();
  await expect(page.locator('#region-dialog')).not.toBeVisible();
});

for (const provider of ['codex'] as const) {
  test(`Region UI: Real selection, ${provider} provider, frame 137ms metadata, protected/raw, normalize, exact PNG export`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    let batchCalls = 0;
    page.on('request', r => {
      if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) batchCalls++;
    });

    const docId = await createAndSeed(page, `Region E2E ${provider}`);
    const base = `/api/pixel/projects/${docId}`;

    // Click actual timeline cel for frame-extra-137
    const celBtn = page.locator('button.cel[data-frame="frame-extra-137"]');
    await celBtn.click();
    await expect(page.locator('#duration')).toHaveValue('137');

    // Select the sparse L-shape of 3 white pixels with Wand tool ('w')
    await page.locator('[data-tool="wand"]').click();
    const box = (await page.locator('#canvas').boundingBox())!;
    const pixelScale = box.width / 32;
    await page.mouse.click(box.x + 15.5 * pixelScale, box.y + 15.5 * pixelScale);

    // Open AI Workspace
    await page.locator('#ai-open').click();
    await expect(page.locator('#generation-workspace')).toBeVisible();

    // Select provider
    await page.locator('#provider').selectOption(provider);

    // Open Region Dialog
    await page.locator('#ai-region-edit').click();
    await expect(page.locator('#region-dialog')).toBeVisible();

    // Verify source information: frame duration 137 ms and exact 3-pixel selection status
    await expect(page.locator('#region-source')).toContainText('137 ms');
    await expect(page.locator('#region-status')).toContainText('3 pixel được chọn để sửa');
    await expect(page.locator('#region-submit')).toBeEnabled();

    // Fill region edit description
    await page.locator('#region-prompt').fill('Sửa huy hiệu trung tâm');

    // Submit region edit
    await page.locator('#region-submit').click();
    await expect(page.locator('#region-dialog')).not.toBeVisible();

    // Wait for candidate 1 ready and proposal visible
    await expect(page.locator('.candidate-card[data-index="0"] .card-status')).toHaveText('Sẵn sàng', { timeout: 25000 });
    await expect(page.locator('#proposal')).toBeVisible({ timeout: 25000 });

    // Every candidate has its own fixture directory/call counter; count actual CLI starts on the batch.
    await expect(page.locator('.candidate-card[data-index="2"] .card-status')).toHaveText('Sẵn sàng', { timeout: 25000 });
    await page.locator('.candidate-card[data-index="2"]').click();
    await expect(page.locator('#proposal-description')).toContainText('alt=3');
    const batches = await (await page.request.get(`${base}/generation-batches`)).json();
    expect(batches[0].candidates.reduce((n: number, c: any) => n + c.cliExecutions, 0)).toBe(3);
    await expect(page.locator('#ai-modal-error')).toBeHidden();

    // Verify default variant is 'Đã khóa vùng' (protected)
    await expect(page.locator('#proposal-variant option:checked')).toHaveText('Đã khóa vùng');
    await expect(page.locator('#proposal-apply')).toBeEnabled();

    // Raw variant must be view-only and apply button disabled
    await page.locator('#proposal-variant').selectOption({ label: 'AI gốc · chỉ xem' });
    await expect(page.locator('#proposal-apply')).toBeDisabled();
    await expect(page.locator('#proposal-errors')).toContainText('Ảnh AI gốc ở chế độ khóa vùng chỉ để xem');

    // Normalize palette locally
    await page.locator('#proposal-normalize').click();
    await expect(page.locator('#processing-status')).toContainText('Đã chuẩn hóa', { timeout: 20000 });

    // Select the normalized variant
    await expect(page.locator('#proposal-variant option:checked')).toContainText('Đã chuẩn hóa');
    await expect(page.locator('#proposal-apply')).toBeEnabled();

    // Apply as a new version of the existing asset
    await page.locator('#proposal-mode-version').check();
    await expect(page.locator('#proposal-version-target-row')).toBeVisible();
    await page.locator('#proposal-apply').click();
    await expect(page.locator('#generation-workspace')).toBeHidden();

    // Verify applied document
    const afterApplyDoc = await document(page);
    expect(afterApplyDoc.assets.length).toBe(2);

    // Original source asset is untouched
    const sourceAsset = afterApplyDoc.assets[0];
    expect(sourceAsset.frames.length).toBe(2);
    expect(sourceAsset.frames[1].duration).toBe(137);
    expect(sourceAsset.metadata.pivot).toEqual({ x: 0.23, y: 0.91 });
    expect(sourceAsset.metadata.hitbox).toEqual({ x: 4, y: 4, w: 12, h: 12 });

    // New version asset
    const newVersionAsset = afterApplyDoc.assets[1];

    // Single frame with 137ms duration
    expect(newVersionAsset.frames.length).toBe(1);
    expect(newVersionAsset.frames[0].duration).toBe(137);

    // Metadata preservation: fractional pivot (.23, .91), hitbox, and remapped event
    expect(Math.round(newVersionAsset.metadata.pivot.x * 100) / 100).toBe(0.23);
    expect(Math.round(newVersionAsset.metadata.pivot.y * 100) / 100).toBe(0.91);
    expect(newVersionAsset.metadata.hitbox).toEqual({ x: 4, y: 4, w: 12, h: 12 });
    expect(newVersionAsset.metadata.events).toEqual([{ frame: 0, name: 'hit' }]);

    // Outside reference pixel (0, 0) must exactly match 0x70c989ff
    const newCelKey = Object.keys(newVersionAsset.cels)[0];
    const celRes = await page.request.get(`${base}/cel?asset=${newVersionAsset.id}&cel=${newCelKey}&revision=${afterApplyDoc.revision}`);
    const celPixels = wireParse(await celRes.text()).data;
    expect(celPixels[0]).toBe(0x70c989ff);

    // Export PNG and verify every decoded pixel matches applied cel pixels
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-export="png"]').click();
    const download = await downloadPromise;
    const downloadStream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of downloadStream!) chunks.push(Buffer.from(chunk));
    const pngBytes = new Uint8Array(Buffer.concat(chunks));
    const decoded = decodePng(pngBytes);
    expect(decoded.w).toBe(32);
    expect(decoded.h).toBe(32);

    for (let i = 0; i < 32 * 32; i++) {
      expect(decoded.pixels[i]).toBe(celPixels[i]);
    }

    // Reload page succeeds and preserves state
    await page.reload();
    await expect(page.locator('#canvas')).toBeVisible();
    const reloadedDoc = await document(page);
    expect(reloadedDoc.assets.length).toBe(2);
    expect(reloadedDoc.assets[1].frames[0].duration).toBe(137);

    // Exactly 1 batch request was initiated
    expect(batchCalls).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('Region UI: External revision closes the obsolete dialog and source selection can be captured again', async ({ page }) => {
  const id = await createAndSeed(page, 'External region source');
  await page.locator('button.cel[data-frame="frame-extra-137"]').click();
  await expect(page.locator('#duration')).toHaveValue('137');
  await page.locator('[data-tool="wand"]').click();
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + 16.5 * box.width / 32, box.y + 16.5 * box.height / 32);
  await page.locator('#ai-open').click(); await page.locator('#ai-region-edit').click();
  await expect(page.locator('#region-dialog')).toBeVisible();
  const old = await document(page);
  const response = await page.request.put(`/api/pixel/projects/${id}`, { headers: { origin: 'http://127.0.0.1:4329', 'content-type': 'application/json' }, data: wireStringify({ revision: old.revision, document: { ...old, name: 'Externally updated source' } }) });
  expect(response.ok()).toBeTruthy();
  await expect(page.locator('#project-title')).toHaveText('Externally updated source');
  await expect(page.locator('#region-dialog')).toBeHidden();
  await page.locator('#ai-region-edit').click();
  await expect(page.locator('#region-submit')).toBeDisabled();
  await expect(page.locator('#region-status')).toContainText('Chưa chọn');
  await page.locator('#region-close').click(); await page.locator('#ai-close').click();
  await page.locator('button.cel[data-frame="frame-extra-137"]').click();
  await expect(page.locator('#duration')).toHaveValue('137');
  await page.locator('[data-tool="wand"]').click();
  const next = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(next.x + 16.5 * next.width / 32, next.y + 16.5 * next.height / 32);
  await page.locator('#ai-open').click(); await page.locator('#ai-region-edit').click();
  await expect(page.locator('#region-source')).toContainText('137 ms');
  await expect(page.locator('#region-status')).toContainText('3 pixel');
  expect(await (await page.request.get(`/api/pixel/projects/${id}/generation-batches`)).json()).toEqual([]);
});

test('Region UI: Project palette mismatch returns 422 with 0 calls, explicit normalize-copy review and approval', async ({ page }) => {
  let batchCalls = 0;
  page.on('request', r => {
    if (r.method() === 'POST' && /\/generation-batches$/.test(r.url())) batchCalls++;
  });

  await create(page, 'Project Palette Mismatch', 18);

  // Set project artDirection with a restricted palette containing only green (#70c989ff) and white (#ffffffff)
  // But asset cel has a yellow pixel (#ffcc44ff)
  const curDoc = await document(page);
  const base = `/api/pixel/projects/${curDoc.id}`;
  const asset = curDoc.assets[0];
  const restrictedPalette = [0x70c989ff, 0xffffffff];
  asset.palette = [...defaultPalette];
  const layerId = asset.layers[0].id;
  const celId = 'palette-source-cel';
  asset.layers[0].cels[asset.frames[0].id] = celId;
  const celData = new Uint32Array(18 * 18);
  celData[0] = 0xffcc44ff; // Yellow color not in restrictedPalette
  asset.cels[celId] = { id: celId, layerId, frameId: asset.frames[0].id, data: celData };

  const updatedDoc = {
    ...curDoc,
    assets: [asset],
    studio: {
      ...curDoc.studio,
      version: 1,
      artDirection: {
        paletteMode: 'asset',
        palette: restrictedPalette,
        style: 'game',
        light: 'upper-left',
        detailLevel: 'medium',
        outline: 'single-color',
        references: [],
      },
    },
  };

  const putRes = await page.request.put(base, {
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:4329',
    },
    data: wireStringify({
      revision: curDoc.revision,
      document: updatedDoc,
    }),
  });
  expect(putRes.status()).toBe(200);

  await page.reload();
  await expect(page.locator('#canvas')).toBeVisible();

  // Select yellow pixel with Wand
  await page.locator('[data-tool="wand"]').click();
  const box = (await page.locator('#canvas').boundingBox())!;
  const s = box.width / 18;
  await page.mouse.click(box.x + 0.5 * s, box.y + 0.5 * s);

  // Open workspace and ensure palette mode is 'project'
  await page.locator('#ai-open').click();
  await expect(page.locator('#generation-workspace')).toBeVisible();
  await page.locator('#ai-palette').selectOption('project');

  // Open Region Dialog
  await page.locator('#ai-region-edit').click();
  await expect(page.locator('#region-dialog')).toBeVisible();

  // Submit region edit - server returns 422 because yellow is not in project palette
  await page.locator('#region-prompt').fill('Sửa chi tiết');
  await page.locator('#region-submit').click();

  // Error is displayed inside dialog
  await expect(page.locator('#region-error')).toContainText('Mẫu có màu ngoài palette đích.');

  // The rejected request creates no batch/provider execution.
  expect(batchCalls).toBe(1);
  expect(await (await page.request.get(`${base}/generation-batches`)).json()).toEqual([]);

  // Click #region-normalize to create a source copy normalized to project palette
  await page.locator('#region-normalize').click();
  await expect(page.locator('#region-dialog')).not.toBeVisible();

  // Proposal preview shown for explicit user review
  await expect(page.locator('#proposal')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#proposal-description')).toContainText('Mẫu chuẩn');
  await page.locator('#proposal-normalize').click();
  await expect(page.locator('#proposal-after-label')).toContainText(/chuẩn hóa/i);

  // Original asset is unchanged
  const docBeforeApproval = await document(page);
  expect(docBeforeApproval.assets.length).toBe(1);
  const celCheck = await page.request.get(`${base}/cel?asset=${asset.id}&cel=${celId}&revision=${docBeforeApproval.revision}`);
  expect(wireParse(await celCheck.text()).data[0]).toBe(0xffcc44ff);

  // User explicitly approves normalized copy
  await page.locator('#proposal-apply').click();
  await expect(page.locator('#generation-workspace')).toBeHidden();

  // New normalized asset exists and has 0xffcc44ff mapped to restricted palette
  const docAfterApproval = await document(page);
  expect(docAfterApproval.assets.length).toBe(2);
  const copy = docAfterApproval.assets[1], copyCel = Object.keys(copy.cels)[0];
  const copied = wireParse(await (await page.request.get(`${base}/cel?asset=${copy.id}&cel=${copyCel}&revision=${docAfterApproval.revision}`)).text()).data;
  expect(restrictedPalette).toContain(copied[0]);
  expect(batchCalls).toBe(1);
});
