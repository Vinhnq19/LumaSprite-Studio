import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { composite, wireParse, wireStringify, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { decodeTestPng, unzipTestStored } from '../../test/fixtures/image-assertions.ts';
import { productionRpgFixture, rpgAgentToken, rpgIds, setupRpgProduction } from '../../test/fixtures/production-rpg.ts';
import { agentPath } from '../../src/studio/agent-contract.ts';

const sources = {
  sword: 'quality-q5/reviews/q5-static-b3vTYg/sprite.png',
  potion: 'quality-q5/reviews/q5-static-A06A8x/sprite.png',
};
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function seed(page: Page, extras = 0, reviewed = false, beforeOpen?: (fixture: PixelDocument) => Promise<void>) {
  await page.goto('/');
  const root = reviewed ? process.env.PXL_S4_FIXTURE_ROOT : undefined;
  const input = root ? await Promise.all([readFile(join(root, sources.sword)), readFile(join(root, sources.potion))]) : [];
  const fixture = productionRpgFixture(input.length ? { sword: decodeTestPng(input[0]), potion: decodeTestPng(input[1]) } : undefined, extras);
  await beforeOpen?.(fixture);
  const response = await page.request.post('/api/pixel/projects', {
    headers: { origin: new URL(page.url()).origin, 'Content-Type': 'application/json' },
    data: wireStringify({ name: fixture.name, document: fixture }),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const doc: PixelDocument = wireParse(await response.text());
  await page.reload();
  await page.locator('#projects').selectOption(doc.id);
  await expect(page.locator('#asset-info')).toContainText('Lữ khách');
  const saved = async (): Promise<PixelDocument> => wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}`)).text());
  return { doc, saved, inputs: input, root, fixture };
}

const item = (page: Page, id: string) => page.locator(`#prod-asset-list [data-asset-id="${id}"]`);
async function click(page: Page, name: string) {
  await expect(page.locator('#production-workspace')).toHaveAttribute('aria-busy', 'false');
  await page.locator(`#prod-${name}`).click();
  await expect(page.locator('#production-workspace')).toHaveAttribute('aria-busy', 'false');
}
async function open(page: Page) {
  await page.locator('#production-open').click();
  await expect(page.locator('#prod-status')).toHaveText('Sẵn sàng');
  await expect(page.locator('#production-workspace')).toHaveAttribute('aria-busy', 'false');
}

test('S4 Mini Pixel RPG: collection, style, production scene, source edit, reopen and verified package', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await seed(page, 0, true);
  const performanceMs: Record<string, number> = {};
  let started = performance.now();
  const evidence = process.env.PXL_S4_EVIDENCE_DIR;
  const capture = async (name: string) => { if (evidence) await page.screenshot({ path: join(evidence, name) }); };
  await page.locator('#play-tag').selectOption(rpgIds.idle);
  await expect(page.locator('#timeline thead button')).toHaveCount(2);
  await capture('02-animation-workspace.png');
  await page.locator('[data-map-id="village-map"]').click();
  await expect(page.locator('#map-canvas')).toHaveAttribute('data-ready', 'true');
  performanceMs.mapViewport = performance.now() - started;
  await page.locator('#map-actual').click();
  const map = page.locator('#map-canvas'), box = (await map.boundingBox())!;
  const camera = await map.evaluate((canvas: HTMLCanvasElement) => ({ x: Number(canvas.dataset.cameraX), y: Number(canvas.dataset.cameraY), zoom: Number(canvas.dataset.zoom) }));
  await page.mouse.click(box.x + camera.x + 7.5 * 16 * camera.zoom, box.y + camera.y + 9.5 * 16 * camera.zoom);
  started = performance.now(); await page.locator('#map-save').click();
  await expect(page.locator('#save-status')).toContainText('Đã lưu');
  performanceMs.mapSave = performance.now() - started;
  await capture('03-tilemap-workspace.png');
  await page.locator('#map-close').click();
  await open(page);
  await page.locator('#prod-collection-name').fill('Bản chơi thử RPG');
  await click(page, 'add-collection');
  for (const [id, kind] of [[rpgIds.hero, 'character'], [rpgIds.sword, 'prop'], [rpgIds.potion, 'item'], [rpgIds.atlas, 'tileset']]) {
    await item(page, id).click();
    await page.locator('#prod-kind').selectOption(kind);
    await click(page, 'save-asset'); await click(page, 'membership');
    if (kind !== 'tileset') await click(page, 'approve');
  }
  await item(page, rpgIds.sword).click();
  started = performance.now(); await click(page, 'version');
  performanceMs.newVersion = performance.now() - started;
  await expect(page.locator('#prod-asset-info')).toContainText('v2');
  const version2 = (await fixture.saved()).assets.at(-1)!;
  await click(page, 'approve');
  await page.locator('#prod-search').fill('Khiên');
  await page.locator('#prod-kind-filter').selectOption('prop');
  await expect(page.locator('#prod-asset-list button')).toHaveCount(2);
  await page.locator('#prod-search').clear(); await page.locator('#prod-kind-filter').selectOption('');
  await page.locator('#prod-collection').selectOption({ label: 'Bản chơi thử RPG' });
  await item(page, rpgIds.hero).click();
  await click(page, 'tab-style');
  await page.locator('#prod-profile-name').fill('Bảng màu làng');
  await page.locator('#prod-scale').fill('2');
  await page.locator('#prod-lock-palette').check();
  await page.locator('#prod-references').selectOption(rpgIds.sword);
  await click(page, 'save-profile');
  const profileId = await page.locator('#prod-profile').inputValue();
  await click(page, 'tab-library');
  await page.locator('#prod-collection-profile').selectOption(profileId);
  await click(page, 'save-collection');
  await click(page, 'inspect');
  await expect(page.locator('#prod-status')).toContainText('0 pixel ngoài palette khóa');
  await expect(page.locator('#prod-asset-info')).toContainText('Bảng màu làng');
  await expect.poll(() => page.locator('#prod-asset-list img').evaluateAll(images => images.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await capture('01-asset-library.png');
  await click(page, 'tab-scene');
  await page.locator('#prod-scene-name').fill('Quảng trường trong game');
  await page.locator('#prod-map').selectOption(rpgIds.map);
  await click(page, 'create-scene');
  const sceneId = await page.locator('#prod-scene-id').inputValue();
  for (const [id, x, y, tag] of [[rpgIds.sword, 55, 72, ''], [rpgIds.potion, 139, 65, ''], [rpgIds.hero, 113, 102, rpgIds.idle]] as const) {
    await page.locator('#prod-placement').selectOption('');
    await page.locator('#prod-sprite').selectOption(id);
    await page.locator('#prod-tag').selectOption(tag);
    await page.locator('#prod-x').fill(String(x)); await page.locator('#prod-y').fill(String(y));
    await click(page, 'save-placement');
  }
  const stable = await fixture.saved(), scene = stable.studio!.production!.scenes[0];
  expect(scene.placements).toHaveLength(3);
  await click(page, 'lower'); await click(page, 'undo'); await click(page, 'redo'); await click(page, 'undo');
  expect((await fixture.saved()).studio?.production?.scenes[0].placements.map(p => p.id)).toEqual(scene.placements.map(p => p.id));
  started = performance.now(); await click(page, 'render');
  const canvas = page.locator('#prod-canvas');
  await expect(canvas).toHaveCSS('width', '224px');
  performanceMs.scenePreview = performance.now() - started;
  await expect(canvas).toHaveCSS('image-rendering', 'pixelated');
  const band = () => canvas.evaluate((el: HTMLCanvasElement) => el.getContext('2d')!.getImageData(113 - 12 + 12, 102 - 30 + 15, 1, 1).data[0]);
  const first = await band();
  started = performance.now(); await click(page, 'play'); await expect.poll(band).not.toBe(first);
  performanceMs.firstObservedAnimationChange = performance.now() - started;
  await click(page, 'play');
  await page.locator('#prod-zoom').selectOption('2');
  await page.locator('#prod-grid').check(); await page.locator('#prod-pivot').check(); await page.locator('#prod-background').selectOption('dark');
  await capture('04-game-scene.png');
  await page.locator('#prod-grid').uncheck(); await page.locator('#prod-pivot').uncheck(); await page.locator('#prod-background').selectOption('light');
  const viewRevision = (await fixture.saved()).revision;
  await canvas.click({ position: { x: 30, y: 30 } });
  expect((await fixture.saved()).revision).toBe(viewRevision);
  await page.locator('#prod-placement').selectOption(scene.placements[0].id);
  await page.locator('#prod-open-sprite').click();
  await expect(page.locator('#asset-info')).toContainText('Khiên làng');
  await page.locator('#actual').click();
  await page.locator('#hex').fill('#e3448aff'); await page.locator('#hex').press('Tab');
  await page.locator('[data-tool="pen"]').click();
  await page.locator('#canvas').click({ position: { x: .5, y: .5 } });
  await expect.poll(async () => (await fixture.saved()).revision).toBeGreaterThan(viewRevision);
  await open(page); await click(page, 'tab-scene'); await page.locator('#prod-scene-id').selectOption(sceneId);
  await expect(page.locator('#prod-scene-issues')).toContainText('Bản có thể mở để đối chiếu');
  await expect(page.locator('#prod-scene-issues')).toContainText('v2');
  if (evidence) await capture('06-stale-scene.png');
  await click(page, 'render'); await expect(page.locator('#prod-error')).toContainText('đã đổi');
  await expect(canvas).toBeHidden();
  await page.locator('#prod-placement').selectOption(scene.placements[0].id);
  await page.locator('#prod-sprite').selectOption(version2.id);
  await click(page, 'save-placement');
  started = performance.now(); await page.reload(); await expect(page.locator('#production-open')).toBeEnabled();
  await open(page); await click(page, 'tab-scene'); await page.locator('#prod-scene-id').selectOption(sceneId);
  await click(page, 'render'); await expect(canvas).toBeVisible();
  performanceMs.reopenToScene = performance.now() - started;
  await page.locator('#prod-collection').selectOption({ label: 'Bản chơi thử RPG' });
  // Point the profile at the approved replacement and drop the stale v1 membership.
  await click(page, 'tab-style');
  await page.locator('#prod-profile').selectOption(profileId);
  await page.locator('#prod-references').selectOption(version2.id);
  await click(page, 'save-profile');
  await click(page, 'tab-library');
  await item(page, rpgIds.sword).click(); await click(page, 'membership');
  await item(page, version2.id).click(); await click(page, 'membership');
  await click(page, 'tab-scene'); await click(page, 'render');
  await page.locator('#prod-include-scene').check();
  started = performance.now(); const waiting = page.waitForEvent('download'); await click(page, 'export');
  const download = await waiting, packageBytes = await readFile((await download.path())!);
  performanceMs.exportPackage = performance.now() - started;
  const files = unzipTestStored(packageBytes), info = JSON.parse(files['production.json'].toString());
  const packScene = decodeTestPng(files[info.scene.image]), mapZip = unzipTestStored(files[info.scene.terrain]);
  expect(info.scene.placements[0].assetId).toBe(version2.id);
  expect(info.scene.placements[0].stamp.version).toBe(2);
  expect(info.profiles[0].direction.references[0].assetId).toBe(version2.id);
  expect(info.assets.map((row: {id: string}) => row.id)).not.toContain(rpgIds.sword);
  expect([packScene.w, packScene.h, packScene.data[0]]).toEqual([224, 160, 0]);
  expect(JSON.parse(mapZip['map.json'].toString()).tileSize).toBe(16);
  const heroFile = unzipTestStored(files[info.assets.find((a: {id: string}) => a.id === rpgIds.hero).strip]);
  const strip = JSON.parse(heroFile['image.json'].toString());
  expect(strip.meta.pxl.playback.map((frame: {duration: number}) => frame.duration)).toEqual([100, 180]);
  if (fixture.root) {
    const originals = await Promise.all([readFile(join(fixture.root, sources.sword)), readFile(join(fixture.root, sources.potion))]);
    expect(originals.map(hash)).toEqual(fixture.inputs.map(hash));
    const swordFile = info.assets.find((a: {id: string}) => a.id === version2.id).png;
    expect(decodeTestPng(files[swordFile]).data).toEqual(decodeTestPng(originals[0]).data);
  }
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await download.saveAs(join(evidence, 'mini-rpg-production.zip'));
    const rgba = Buffer.alloc(packScene.data.length * 4);
    packScene.data.forEach((ink, index) => rgba.writeUInt32BE(ink, index * 4));
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ revision: info.revision, assets: info.assets.length, placements: info.scene.placements,
      nativeScene: [packScene.w, packScene.h], scenePngSha256: hash(files[info.scene.image]), rgbaSha256: hash(rgba), packageSha256: hash(packageBytes),
      bytes: packageBytes.length, timingMs: [100, 180], sourceHashes: fixture.inputs.map(hash), performanceMs, inference: 0 }, null, 2));
  }
  expect(errors).toEqual([]);
});

test('S4 library: paged thumbnails and filters on a 100-asset project', async ({ page }) => {
  test.setTimeout(90000);
  const start = performance.now(), fixture = await seed(page, 96);
  const opened = performance.now();
  await open(page);
  const visible = page.locator('#prod-asset-list button');
  await expect(visible).toHaveCount(12);
  await expect(page.locator('#prod-page')).toContainText('1/9 · 100 asset');
  const catalog = performance.now();
  await expect.poll(() => visible.first().locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const thumbnail = performance.now();
  await page.locator('#prod-search').fill('vật phẩm 95');
  await expect(visible).toHaveCount(1);
  await visible.first().click();
  await expect(page.locator('#prod-asset-name')).toHaveText('Kho vật phẩm 95');
  const found = performance.now();
  await page.locator('#prod-open-asset').click();
  await expect(page.locator('#asset-info')).toContainText('Kho vật phẩm 95');
  const editor = performance.now();
  expect((await fixture.saved()).revision).toBe(fixture.doc.revision);
  const evidence = process.env.PXL_S4_EVIDENCE_DIR;
  if (evidence) await writeFile(join(evidence, 'library-performance.json'), JSON.stringify({ assets: 100, thumbnailsPerPage: 12,
    setupAndReopenMs: opened - start, catalogMs: catalog - opened, firstThumbnailMs: thumbnail - catalog, filterAndSelectMs: found - thumbnail,
    openEditorMs: editor - found, method: 'Chrome wall time via Playwright including fixture setup and automatic waits' }, null, 2));
});

test('S4 hardening: lazy cel failure recovers and a late frame cannot replace the active frame', async ({ page }) => {
  let unblock!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  let mode = 'fail';
  const { doc, fixture } = await seed(page, 0, false, async fixture => {
    const hero = fixture.assets[0], cel = hero.layers[0].cels[hero.frames[1].id];
    await page.route(url => url.pathname.endsWith('/cel') && url.searchParams.get('cel') === cel, async route => {
    if (mode === 'fail') { await route.fulfill({ status: 503, json: { error: 'Cel thử nghiệm chưa sẵn sàng' } }); return; }
    await held;
    await route.continue();
    });
  });
  const hero = fixture.assets[0], second = hero.frames[1];
  const frame = (id: string) => page.locator(`#timeline button.cel[data-frame="${id}"]`).first();
  const expectPixels = async (id: string) => {
    const ink = composite(hero, id).data, opaque = Array.from(ink.entries()).filter(([, color]) => (color & 255) === 255);
    const indices = opaque.map(([index]) => index);
    await expect.poll(() => page.locator('#canvas').evaluate((canvas: HTMLCanvasElement, info) => {
      const ctx = canvas.getContext('2d')!, zoom = canvas.width / info.width;
      return info.indices.map(index => {
        const px = ctx.getImageData(Math.floor(index % info.width * zoom), Math.floor(Math.floor(index / info.width) * zoom), 1, 1).data;
        return ((px[0] << 24) | (px[1] << 16) | (px[2] << 8) | px[3]) >>> 0;
      });
    }, { indices, width: hero.w })).toEqual(opaque.map(([, value]) => value));
  };
  await page.locator('#actual').click();
  await expectPixels(hero.frames[0].id);
  await frame(second.id).click();
  await expect(page.locator('#frame-load')).toContainText('Cel thử nghiệm chưa sẵn sàng');
  await expect(page.locator('#canvas')).toBeHidden();
  mode = 'hold';
  await page.locator('#frame-load button').click();
  await expect(page.locator('#frame-load')).toContainText('Đang tải');
  await frame(hero.frames[0].id).click();
  const completed = page.waitForResponse(response => response.url().includes(`cel=${hero.layers[0].cels[second.id]}&`) && response.ok());
  unblock();
  await completed;
  await expect(page.locator('#canvas')).toBeVisible();
  await expectPixels(hero.frames[0].id);
  await frame(second.id).click();
  await expectPixels(second.id);
  const thumb = frame(second.id).locator('canvas');
  const source = composite(hero, second.id).data;
  await expect.poll(() => thumb.evaluate((canvas: HTMLCanvasElement, input) => {
    const native = document.createElement('canvas'); native.width = input.width; native.height = input.height;
    const nativeCtx = native.getContext('2d')!, pixels = nativeCtx.createImageData(native.width, native.height);
    pixels.data.set(input.rgba); nativeCtx.putImageData(pixels, 0, 0);
    const expected = document.createElement('canvas'); expected.width = canvas.width; expected.height = canvas.height;
    const ctx = expected.getContext('2d')!, zoom = Math.min(canvas.width / native.width, canvas.height / native.height);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(native, 0, 0, native.width * zoom, native.height * zoom);
    const displayed = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data.every((value, index) => displayed[index] === value);
  }, { width: hero.w, height: hero.h, rgba: Array.from(source).flatMap(c => [c >>> 24, c >>> 16 & 255, c >>> 8 & 255, c & 255]) })).toBe(true);
  const reloaded = wireParse(await (await page.request.get(`/api/pixel/projects/${doc.id}`)).text());
  expect(reloaded.revision).toBe(doc.revision);
  const evidence = process.env.PXL_S4_EVIDENCE_DIR;
  if (evidence) await page.screenshot({ path: join(evidence, '05-editor-loaded-after-retry.png') });
});

test('S4 hardening: Tilemap zoom follows the pointer and persists without saving the project', async ({ page }) => {
  const { doc, saved } = await seed(page);
  const map = page.locator('#map-canvas');
  const openMap = () => page.locator('[data-map-id="village-map"]').click();
  const camera = () => map.evaluate((canvas: HTMLCanvasElement) => ({
    x: Number(canvas.dataset.cameraX), y: Number(canvas.dataset.cameraY), zoom: Number(canvas.dataset.zoom), w: canvas.width, h: canvas.height,
  }));
  await openMap();
  await page.locator('#map-fit').click();
  await expect(map).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => { const view = await camera(); return Math.abs(view.y * 2 + 160 * view.zoom - view.h); }).toBeLessThanOrEqual(1);
  const fitted = await camera();
  expect(Math.abs(fitted.x * 2 + 224 * fitted.zoom - fitted.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(fitted.y * 2 + 160 * fitted.zoom - fitted.h)).toBeLessThanOrEqual(1);
  const evidence = process.env.PXL_S4_EVIDENCE_DIR;
  if (evidence) await page.screenshot({ path: join(evidence, '07-tilemap-fit.png') });
  const here = { x: 93, y: 88 }, box = (await map.boundingBox())!;
  await page.mouse.move(box.x + here.x, box.y + here.y);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await camera()).zoom).toBeLessThan(fitted.zoom);
  const zoomed = await camera();
  expect(Math.abs((here.x - zoomed.x) / zoomed.zoom - (here.x - fitted.x) / fitted.zoom)).toBeLessThan(1);
  expect(Math.abs((here.y - zoomed.y) / zoomed.zoom - (here.y - fitted.y) / fitted.zoom)).toBeLessThan(1);
  await page.locator('#map-close').click();
  await page.reload();
  await expect(page.locator('#asset-info')).toContainText('Lữ khách');
  await openMap();
  await expect(map).toHaveAttribute('data-ready', 'true');
  expect(await camera()).toEqual(zoomed);
  await page.locator('#map-center').click();
  await expect.poll(async () => (await camera()).x).toBe(Math.floor((zoomed.w - 224 * zoomed.zoom) / 2));
  expect((await saved()).revision).toBe(doc.revision);
});

for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
  test(`S4 hardening: Library navigation at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await seed(page, 96);
    await open(page);
    await page.locator('#prod-search').fill('không-tồn-tại');
    await expect(page.locator('#prod-asset-list')).toHaveText('Không có asset phù hợp.');
    await page.locator('#prod-search').clear();
    await click(page, 'next');
    await expect(page.locator('#prod-page')).toContainText('2/9');
    await expect(page.locator('#prod-open-asset')).toBeInViewport();
    const thumbnail = page.locator('#prod-asset-list img').first();
    await thumbnail.scrollIntoViewIfNeeded();
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    const evidence = process.env.PXL_S4_EVIDENCE_DIR;
    if (evidence) await page.screenshot({ path: join(evidence, `library-${width}x${height}.png`) });
  });
}

test('S5 Mini RPG remains editable and exports exact PNG pixels after an Agent mutation', async ({ page }) => {
  const { saved, fixture } = await seed(page), doc = await saved();
  setupRpgProduction(doc);
  const origin = new URL(page.url()).origin, headers = { origin, 'content-type': 'application/json' };
  const initial = await page.request.put(`/api/pixel/projects/${doc.id}`, { headers, data: wireStringify({ revision: doc.revision, document: doc }) });
  expect(initial.ok()).toBeTruthy();
  const ready = wireParse(await initial.text()) as PixelDocument;
  const response = await page.request.post(agentPath, { headers: { ...headers, authorization: `Bearer ${rpgAgentToken}` },
    data: { version: 1, operation: 'asset.rename', projectId: doc.id, expectedRevision: ready.revision,
      input: { assetId: rpgIds.hero, name: 'Lữ khách · Agent' } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const renamed = await response.json();
  await page.reload();
  await expect(page.locator('#asset-info')).toContainText('Lữ khách · Agent');
  await page.locator('#actual').click();
  await page.locator('#hex').fill('#e3448aff'); await page.locator('#hex').press('Tab');
  await page.locator('[data-tool="pen"]').click();
  await page.locator('#canvas').click({ position: { x: .5, y: .5 } });
  await expect.poll(async () => (await saved()).revision).toBeGreaterThan(renamed.revision);
  const downloading = page.waitForEvent('download');
  await page.locator('[data-export="png"]').click();
  const download = await downloading;
  const image = decodeTestPng(await readFile((await download.path())!)), hero = fixture.assets[0];
  const expected = composite(hero, hero.frames[0].id).data;
  expected[0] = 0xe3448aff;
  expect(image.data).toEqual(expected);
  const evidence = process.env.PXL_S5_EVIDENCE_DIR;
  if (evidence) await page.screenshot({ path: join(evidence, 'mini-rpg-agent-editor.png') });
});

for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
  test(`S6 workspace review at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const { saved } = await seed(page);
    const doc = await saved();
    setupRpgProduction(doc);
    const origin = new URL(page.url()).origin;
    const updated = await page.request.put(`/api/pixel/projects/${doc.id}`, {
      headers: { origin, 'content-type': 'application/json' }, data: wireStringify({ revision: doc.revision, document: doc }),
    });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    await page.reload();
    await expect(page.locator('#canvas')).toBeVisible();
    const sizes: Record<string, { x: number; y: number; width: number; height: number }> = {};
    const evidence = process.env.PXL_RC_UX;
    const review = async (name: string, anchor: string) => {
      const control = page.locator(anchor);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: .99 });
      sizes[name] = (await control.boundingBox())!;
      const rect = sizes[name];
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height + 1);
      if (evidence) await page.screenshot({ path: join(evidence, `${width}x${height}-${name}.png`) });
    };
    await page.locator('#actual').click();
    await expect(page.locator('#canvas')).toHaveCSS('width', '24px');
    await review('editor', '#canvas');
    await page.locator('#play-tag').selectOption(rpgIds.idle);
    await expect(page.locator('#timeline thead button')).toHaveCount(2);
    await review('timeline', '#timeline thead th:nth-child(2) button');
    await open(page);
    await expect.poll(() => page.locator('#prod-asset-list img').first().evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    await review('library', '#prod-open-asset');
    await click(page, 'tab-style');
    await page.locator('#prod-profile').selectOption('rpg-style');
    await review('style', '#prod-save-profile');
    await click(page, 'tab-scene');
    await page.locator('#prod-scene-id').selectOption('village');
    await click(page, 'render');
    await expect(page.locator('#prod-canvas')).toHaveCSS('width', '224px');
    await review('scene', '#prod-render');
    await page.locator('#prod-zoom').selectOption('4');
    await expect(page.locator('#prod-canvas')).toHaveCSS('width', '896px');
    await click(page, 'close');
    await page.locator('[data-map-id="village-map"]').click();
    await expect(page.locator('#map-canvas')).toHaveAttribute('data-ready', 'true');
    await review('tilemap', '#map-fit');
    await page.locator('#map-close').click();
    await page.locator('#ai-open').click();
    await review('generation', '#generation-source');
    await page.locator('#generation-source').selectOption('external');
    await expect(page.locator('#external-engine-connection')).toContainText('Mock Engine');
    await page.locator('#external-engine-brief').fill('Fixture RC, phác một đạo cụ');
    await page.locator('#external-engine-submit').click();
    await expect(page.locator('#external-engine-canvas')).toBeVisible();
    await review('external-engine', '#external-engine-canvas');
    await page.locator('#ai-close').click();
    await expect(page.locator('#generation-workspace')).toBeHidden();
    await expect(page.locator('#asset-info')).toContainText('Lữ khách');
    if (evidence) await writeFile(join(evidence, `${width}x${height}-layout.json`), JSON.stringify({ width, height, sizes }, null, 2));
  });
}
