import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { serveStudio } from '../src/node/studio/server.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { newDocument, newAsset, wireParse, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';
import { createMap, MapStroke, getMap } from '../src/studio/map-commands.ts';
import { decodeTestPng, unzipTestStored } from './fixtures/image-assertions.ts';

async function fixture(action: (ctx: { store: PixelStore; doc: PixelDocument; origin: string; call: (path: string, input?: unknown, status?: number) => Promise<any>; binary: (path: string, input: unknown) => Promise<Buffer> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pxl-terrain-api-'));
  let server: Awaited<ReturnType<typeof serveStudio>> | undefined;
  try {
    const store = new PixelStore(root), doc = store.create('Vật liệu', 16, 16, 0x338844ff);
    server = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio') });
    const origin = server.url.slice(0, -1), base = `${origin}/api/pixel/projects/${doc.id}/`;
    const call = async (path: string, input?: unknown, status = 200) => {
      const response = await fetch(base + path, input === undefined ? undefined : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: wireStringify(input) });
      const data = wireParse(await response.text()); assert.equal(response.status, status, JSON.stringify(data)); return data;
    };
    const binary = async (path: string, input: unknown) => {
      const response = await fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: wireStringify(input) });
      assert.equal(response.status, 200, response.status === 200 ? '' : await response.text()); return Buffer.from(await response.arrayBuffer());
    };
    await action({ store, doc, origin, call, binary });
  } finally {
    await server?.close(); assert.equal(resolve(dirname(root)), resolve(tmpdir())); assert.ok(root.startsWith(join(tmpdir(), 'pxl-terrain-api-'))); rmSync(root, { recursive: true, force: true });
  }
}
async function settled(call: (path: string) => Promise<any>, id: string): Promise<any> {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const job = await call(`terrain/jobs/${id}`); if (job.status !== 'running') return job; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Terrain worker did not finish');
}
const start = (d: PixelDocument) => ({ revision: d.revision, assetId: d.assets[0].id, frameId: d.assets[0].frames[0].id, name: 'Đất cỏ', tileSize: 16, inset: 2, sampling: 'mirror' });

test('Terrain HTTP: local job -> PNG preview -> explicit new tileset -> exact portable map PNG/JSON/ZIP', async () => fixture(async ({ store, doc, origin, call, binary }) => {
  const manifest = readFileSync(join(store.dir(doc.id), 'pxl.project.json'));
  const started = await call('terrain/proposal', start(doc), 202), ready = await settled(call, started.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.w, 128); assert.equal(ready.h, 96);
  assert.equal(JSON.stringify(ready).includes('$rgba'), false); assert.equal(JSON.stringify(ready).includes('png'), false);
  assert.deepEqual(readFileSync(join(store.dir(doc.id), 'pxl.project.json')), manifest, 'Preview never saves source');
  const previewResponse = await fetch(`${origin}/api/pixel/projects/${doc.id}/terrain/jobs/${started.id}/preview?revision=${doc.revision}`);
  assert.equal(previewResponse.status, 200); const png = decodeTestPng(Buffer.from(await previewResponse.arrayBuffer()));
  const applied = await call(`terrain/jobs/${started.id}/apply`, { revision: doc.revision });
  assert.equal(applied.document.assets.length, 2); assert.notEqual(applied.assetId, doc.assets[0].id); assert.ok(applied.document.studio.tilesets[applied.tilesetId]);
  assert.equal(applied.document.studio.library[applied.assetId].kind, 'tileset');
  const atlasZip = unzipTestStored(await binary('terrain/tileset-export', { revision: applied.document.revision, tilesetId: applied.tilesetId }));
  assert.deepEqual(decodeTestPng(atlasZip['image.png']), png);
  const d = store.load(doc.id); createMap(d, applied.tilesetId, 'Bản đồ mùa hè', 2, 1, 'summer');
  const stroke = new MapStroke(d, 'summer', getMap(d, 'summer').layers[0].id); stroke.set(0, 0, 48, false); stroke.commit();
  const saved = store.save(d.id, d.revision, d);
  const zipped = unzipTestStored(await binary('terrain/map-export', { revision: saved.revision, mapId: 'summer', format: 'zip' }));
  const portable = JSON.parse(zipped['map.json'].toString('utf8')); assert.equal(portable.revision, saved.revision); assert.equal(portable.layers[0].chunks[0].tiles[0], 48);
  const flat = decodeTestPng(await binary('terrain/map-export', { revision: saved.revision, mapId: 'summer', format: 'png' }));
  assert.equal(flat.w, 32); assert.equal(flat.h, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) assert.equal(flat.data[y * 32 + x], x < 16 ? 0x338844ff : 0);
  const json = JSON.parse((await binary('terrain/map-export', { revision: saved.revision, mapId: 'summer', format: 'json' })).toString('utf8'));
  assert.deepEqual(json, portable); assert.deepEqual(decodeTestPng(zipped[`tilesets/${applied.tilesetId}/image.png`]), png);
  const jobs = await call('ai'); assert.equal(jobs.length, 0, 'Local processing makes no AI job');
}));

test('Terrain HTTP: invalid inputs/Origin, changed revision, canceled or closed proposal never apply', async () => fixture(async ({ store, doc, origin, call }) => {
  for (const patch of [{ tileSize: 18 }, { inset: 0 }, { sampling: 'blur' }, { assetId: '__proto__' }, { revision: 999 }, { extra: true }]) {
    await call('terrain/proposal', { ...start(doc), ...patch }, 'revision' in patch ? 409 : 400);
  }
  const rejected = await fetch(`${origin}/api/pixel/projects/${doc.id}/terrain/proposal`, { method: 'POST', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: JSON.stringify(start(doc)) }); assert.equal(rejected.status, 403);
  const first = await call('terrain/proposal', start(doc), 202); await settled(call, first.id);
  const next = store.load(doc.id); next.name = 'Đã sửa'; const saved = store.save(doc.id, next.revision, next);
  await call(`terrain/jobs/${first.id}/apply`, { revision: saved.revision }, 409);
  const second = await call('terrain/proposal', start(saved), 202);
  await call(`terrain/jobs/${second.id}/cancel`, { revision: saved.revision });
  await call(`terrain/jobs/${second.id}/apply`, { revision: saved.revision }, 409);
  const third = await call('terrain/proposal', start(saved), 202);
  await call('close', {}); await call(`terrain/jobs/${third.id}`, undefined, 404); await call(`terrain/jobs/${third.id}/apply`, { revision: saved.revision }, 404);
  assert.equal(store.load(doc.id).assets.length, 1);
}));

test('Terrain HTTP: empty or wrong-sized native material produces actionable failure without saving', async () => fixture(async ({ store, doc, call }) => {
  const d = store.load(doc.id); d.assets.push(newAsset('Trống', 16, 16)); const saved = store.save(d.id, d.revision, d), empty = saved.assets[1];
  const job = await call('terrain/proposal', { ...start(saved), assetId: empty.id, frameId: empty.frames[0].id }, 202);
  const failed = await settled(call, job.id); assert.equal(failed.status, 'failed'); assert.match(failed.error, /rỗng/);
  await call(`terrain/jobs/${job.id}/apply`, { revision: saved.revision }, 409);
  assert.equal(store.load(d.id).revision, saved.revision);
  assert.ok(readdirSync(store.root).length === 1);
}));
