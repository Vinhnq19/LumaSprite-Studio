import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeAssetLibraryAndReferences } from '../src/studio/asset-library.ts';
import { removeMap, setTileCollision } from '../src/studio/map-commands.ts';
import { celFor, composite, type PixelDocument, wireParse } from '../src/studio/pixel/model.ts';
import { productionProfile } from '../src/studio/production.ts';
import { renderSceneFrame, sceneFrameIndices, type ScenePreview } from '../src/studio/scene-preview.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { productionCatalog } from '../src/node/studio/production-worker.ts';
import { decodeTestPng, unzipTestStored } from './fixtures/image-assertions.ts';
import { productionRpgFixture, rpgIds, setupRpgProduction } from './fixtures/production-rpg.ts';

test('S4 hardening: project backup preserves production metadata and rejects future versions without a write', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-s4-compat-'));
  try {
    const store = new PixelStore(root), fixture = productionRpgFixture();
    const created = store.create(fixture.name, 32, 32, 0, fixture);
    const doc = store.load(created.id);
    assert.equal(doc.studio?.production, undefined);
    setupRpgProduction(doc);
    const saved = store.save(doc.id, doc.revision, doc, 'Thêm Production');
    const files = store.backupFiles(doc.id);
    const blobs: Record<string, string> = {}, resourceBlobs: Record<string, string> = {};
    const history = [];
    for (const { path, data } of files) {
      const cel = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba\.z$/.exec(path);
      const resource = /^\.pxl\/resources\/([a-f0-9]{64})\.([\w-]+)\.z$/.exec(path);
      if (cel) blobs[cel[1]] = data.toString('base64');
      if (resource) resourceBlobs[`${resource[2]}:${resource[1]}`] = data.toString('base64');
      if (path.startsWith('.pxl/pixel-history/')) history.push(JSON.parse(data.toString()));
    }
    const imported = store.importBackup('RPG phục hồi', saved, blobs, history, resourceBlobs);
    assert.deepEqual(store.load(imported.id).studio?.production, saved.studio?.production);
    const original = fixture.assets[0], restored = store.load(imported.id, true).assets[0];
    assert.deepEqual(composite(restored, restored.frames[0].id).data, composite(original, original.frames[0].id).data);
    const path = join(store.dir(doc.id), 'pxl.project.json'), envelope = JSON.parse(readFileSync(path, 'utf8'));
    envelope.document.studio.production.version = 2;
    const newer = JSON.stringify(envelope);
    writeFileSync(path, newer);
    assert.throws(() => store.load(doc.id), { diagnostic: { code: 'UNSUPPORTED_PRODUCTION_VERSION', message: 'Phiên bản Production không tương thích. Mở dự án bằng Studio hỗ trợ schema này hoặc dùng bản sao lưu tương thích.' } });
    assert.equal(readFileSync(path, 'utf8'), newer);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('S4: optional production index survives PixelStore; references protect assets and maps', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-s4-store-'));
  try {
    const store = new PixelStore(root);
    const fixture = productionRpgFixture();
    assert.equal(fixture.studio?.production, undefined);
    const created = store.create(fixture.name, 32, 32, 0, fixture), doc = store.load(created.id);
    setupRpgProduction(doc);
    const saved = store.save(doc.id, doc.revision, doc, 'Production');
    const reopened = new PixelStore(root).load(doc.id);
    assert.deepEqual(reopened.studio?.production, saved.studio?.production);
    assert.equal(productionProfile(reopened, rpgIds.hero, 'release-pack')?.id, 'rpg-style');
    assert.equal(productionProfile(reopened, rpgIds.sword, 'release-pack'), undefined);
    reopened.studio!.production!.assets.find(asset => asset.assetId === rpgIds.sword)!.profileId = 'rpg-style';
    assert.equal(productionProfile(reopened, rpgIds.sword)?.id, 'rpg-style');
    assert.throws(() => removeAssetLibraryAndReferences(reopened, [rpgIds.hero]), /cảnh/);
    assert.throws(() => removeAssetLibraryAndReferences(reopened, [rpgIds.sword]), /Style Profile/);
    assert.throws(() => removeMap(reopened, rpgIds.map), /cảnh tham chiếu/);
    reopened.studio!.production!.collections = [];
    assert.equal(reopened.assets.length, 4);
    reopened.studio!.production!.scenes[0].placements[0].assetId = '../asset';
    assert.throws(() => store.save(reopened.id, reopened.revision, reopened), /ID/);
    assert.equal(store.load(reopened.id).revision, saved.revision);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('S4: native scene composition, pinned sources, and export package via Studio API', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-s4-api-'));
  const app = await serveStudio(root, { port: 0 });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const fixture = productionRpgFixture(); fixture.assets[1].name = '../Đạo cụ';
  const store = new PixelStore(root);
  const created = store.create(fixture.name, 32, 32, 0, fixture);
  let doc = store.load(created.id);
  setupRpgProduction(doc);
  doc = store.save(doc.id, doc.revision, doc, 'Cảnh đã duyệt');
  const call = (operation: string, fields: Record<string, string> = {}, revision = doc.revision) => fetch(app.url + `api/pixel/projects/${doc.id}/production?` +
    new URLSearchParams({ operation, revision: String(revision), ...fields }));
  assert.equal((await call('scene', { sceneId: 'village' }, doc.revision - 1)).status, 409);
  const catalog = await (await call('catalog')).json();
  assert.equal(catalog.assets[rpgIds.hero].status, 'approved');
  assert.equal(catalog.assets[rpgIds.hero].used, true);
  const thumbs = { assetId: rpgIds.hero, sha256: catalog.assets[rpgIds.hero].stamp.sha256 };
  const thumb = await call('thumbnail', thumbs);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  assert.equal(decodeTestPng(Buffer.from(await thumb.arrayBuffer())).w, 24);
  const style = await (await call('inspect', { assetId: rpgIds.hero, collectionId: 'release-pack' })).json();
  assert.deepEqual(style, { profileId: 'rpg-style', outside: 0, staleReferences: [] });
  const preview: ScenePreview = wireParse(await (await call('scene', { sceneId: 'village' })).text());
  assert.deepEqual([preview.width, preview.height, preview.sprites.length], [224, 160, 3]);
  assert.deepEqual(preview.tracks[2].frames.map(frame => frame.durationMs), [100, 180]);
  assert.deepEqual(sceneFrameIndices(preview, 100), [0, 0, 1]);
  assert.deepEqual(sceneFrameIndices(preview, 280), [0, 0, 0]);
  const image = renderSceneFrame(preview, sceneFrameIndices(preview, 0));
  const next = renderSceneFrame(preview, sceneFrameIndices(preview, 100));
  assert.notDeepEqual(image.data, next.data);
  assert.equal(image.data[0], 0);
  const hero = fixture.assets[0];
  const heroRgba = composite(hero, hero.frames[0].id).data;
  const index = heroRgba.findIndex(ink => !!(ink & 255));
  assert.equal(image.get(92 - 12 + index % hero.w, 95 - 30 + Math.floor(index / hero.w)), heroRgba[index]);

  const response = await call('package', { collectionId: 'release-pack', sceneId: 'village' });
  assert.equal(response.status, 200);
  const files = unzipTestStored(Buffer.from(await response.arrayBuffer()));
  const manifest = JSON.parse(files['production.json'].toString());
  assert.deepEqual(manifest.assets.map((asset: { id: string }) => asset.id).sort(), [rpgIds.hero, rpgIds.potion, rpgIds.sword].sort());
  assert.ok(Object.keys(files).every(path => !path.includes('..') && !path.startsWith('/')));
  assert.deepEqual(decodeTestPng(files[manifest.scene.image]).data, image.data);
  assert.deepEqual(decodeTestPng(files[`assets/${hero.id}/sprite.png`]).data, heroRgba);
  const atlas = unzipTestStored(files[manifest.atlas]), atlasJson = JSON.parse(atlas['image.json'].toString());
  assert.deepEqual(atlasJson.meta.pxl.assets[hero.id].pivot, hero.metadata.pivot);
  assert.deepEqual(atlasJson.meta.pxl.assets[hero.id].hitbox, hero.metadata.hitbox);
  assert.equal(Object.keys(atlasJson.frames).length, 4);
  const packedHero = Object.entries(atlasJson.frames).find(([name]) => name.endsWith(`_${hero.id.slice(0, 8)}_0`))?.[1] as { frame: { x: number; y: number; w: number; h: number } };
  const atlasPng = decodeTestPng(atlas['image.png']), rect = packedHero.frame;
  assert.deepEqual([rect.w, rect.h], [hero.w, hero.h]);
  for (let y = 0; y < hero.h; y++) assert.deepEqual(atlasPng.data.slice((rect.y + y) * atlasPng.w + rect.x, (rect.y + y) * atlasPng.w + rect.x + hero.w),
    heroRgba.slice(y * hero.w, (y + 1) * hero.w));
  const strip = unzipTestStored(files[`assets/${hero.id}/strip.zip`]);
  assert.deepEqual(JSON.parse(strip['image.json'].toString()).meta.pxl.playback.map((f: { duration: number }) => f.duration), [100, 180]);
  const map = unzipTestStored(files[manifest.scene.terrain]), mapJson = JSON.parse(map['map.json'].toString());
  assert.equal(mapJson.tileSize, 16);
  assert.equal(mapJson.tilesets[0].tiles.filter((tile: { mask: number | null }) => tile.mask !== null).length, 47);
  assert.equal(mapJson.tilesets[0].tiles[0].collision, 'solid');
  assert.ok(mapJson.layers[0].chunks[0].tiles.some((tile: number) => tile > 0));
  assert.ok(map[mapJson.tilesets[0].image]);
  assert.equal(store.load(doc.id).revision, doc.revision);
  assert.equal((await call('thumbnail', thumbs, doc.revision - 1)).status, 200);

  const changed = store.load(doc.id, true), edited = changed.assets[0];
  const cel = celFor(edited, edited.layers[0].id, edited.frames[0].id)!;
  cel.data![0] = 0xde8c33ff; delete cel.blob;
  doc = store.save(doc.id, doc.revision, changed, 'Sửa nguồn');
  assert.equal((await (await call('catalog')).json()).assets[hero.id].status, 'stale');
  assert.equal((await call('thumbnail', thumbs)).status, 409);
  assert.equal((await call('scene', { sceneId: 'village' })).status, 409);
  assert.equal((await call('package', { collectionId: 'release-pack', sceneId: 'village' })).status, 409);
  assert.equal((await (await call('inspect', { assetId: hero.id, collectionId: 'release-pack' })).json()).outside, 1);
  const refresh = productionCatalog(doc);
  doc.studio!.production!.assets.find(a => a.assetId === hero.id)!.approved = refresh.assets[hero.id].stamp;
  doc = store.save(doc.id, doc.revision, doc, 'Duyệt lại');
  assert.equal((await call('scene', { sceneId: 'village' })).status, 409, 'Duyệt lại không tự đổi cảnh');
  doc.studio!.production!.scenes[0].placements[2].stamp = refresh.assets[hero.id].stamp;
  doc = store.save(doc.id, doc.revision, doc, 'Chọn lại nội dung');
  assert.equal((await call('scene', { sceneId: 'village' })).status, 200);
  setTileCollision(doc, rpgIds.set, 1, 'one-way');
  doc = store.save(doc.id, doc.revision, doc, 'Sửa collision');
  assert.equal((await call('scene', { sceneId: 'village' })).status, 409);
});

test('S4 scene sprites composite in placement order with native alpha and one-shot timing', () => {
  const preview: ScenePreview = {
    width: 1, height: 1, tileSize: 16, terrain: Uint32Array.of(0x0000ffff),
    sprites: [0, 1].map(track => ({ track, id: String(track), assetId: String(track), name: 'Fixture', x: 0, y: 0, pivot: { x: 0, y: 0 } })),
    tracks: [0xff0000ff, 0x00ff0080].map(value => ({
      w: 1, h: 1, loop: false, frames: [{ id: 'a', durationMs: 75, rgba: Uint32Array.of(value) }, { id: 'b', durationMs: 110, rgba: Uint32Array.of(value) }],
    })),
  };
  assert.deepEqual(sceneFrameIndices(preview, 900), [1, 1]);
  assert.equal(renderSceneFrame(preview, [0, 0]).data[0], 0x7f8000ff);
  preview.sprites.reverse();
  assert.equal(renderSceneFrame(preview, [0, 0]).data[0], 0xff0000ff);
});
