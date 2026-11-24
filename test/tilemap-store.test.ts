import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { bytes, validateDocument, type PixelDocument } from '../src/studio/pixel/model.ts';
import { MapStroke, getMap, copyMapRect, removeMap } from '../src/studio/map-commands.ts';
import { mapFixture } from './tilemap-fixture.ts';

function withStore(action: (store: PixelStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'pxl-tilemap-store-'));
  try { action(new PixelStore(root)); } finally { assert.equal(resolve(dirname(root)), resolve(tmpdir())); assert.ok(root.startsWith(join(tmpdir(), 'pxl-tilemap-store-'))); rmSync(root, { recursive: true, force: true }); }
}
function hydrateMap(store: PixelStore, d: PixelDocument): PixelDocument {
  for (const map of Object.values(d.studio!.mapIndex!)) for (const layer of map.layers) for (const ref of Object.values(layer.chunks)) d.studio!.resources![ref] = store.resource(d.id, ref);
  return d;
}
function draw(d: PixelDocument): void { const s = new MapStroke(d, 'forest', getMap(d, 'forest').layers[0].id); s.set(31, 1, 48, false); s.set(32, 1, 42, false); s.commit(); }
function copied(d: PixelDocument): Uint32Array { return copyMapRect(d, 'forest', getMap(d, 'forest').layers[0].id, 31, 1, 2, 1).data; }

test('MapStore: restart, immutable blobs, revision conflict, history, copy and portable backup', () => withStore(store => {
  const draft = mapFixture(); draw(draft);
  const created = store.create(draft.name, 128, 96, 0, draft), initial = new PixelStore(store.root).load(created.id);
  assert.ok(Object.values(initial.studio!.resources!).every(r => !r.data && r.kind === 'tile-index' && r.blob));
  assert.deepEqual(copied(hydrateMap(store, initial)), Uint32Array.from([48, 42]));
  const initialHistory = store.history(initial.id)[0].id;
  const edited = structuredClone(initial); removeMap(edited, 'forest');
  const saved = store.save(initial.id, initial.revision, edited);
  assert.throws(() => store.save(initial.id, initial.revision, initial), /đã đổi/);
  const restored = store.restore(saved.id, saved.revision, initialHistory);
  assert.deepEqual(copied(hydrateMap(store, restored)), Uint32Array.from([48, 42]));
  const copy = store.copy('Bản sao bản đồ', store.load(restored.id), restored.id);
  assert.deepEqual(copied(hydrateMap(store, copy)), Uint32Array.from([48, 42]));
  const blobs: Record<string, string> = {}, resources: Record<string, string> = {}, history: any[] = [];
  for (const f of store.backupFiles(restored.id)) {
    const cel = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba.z$/.exec(f.path), res = /^\.pxl\/resources\/([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/.exec(f.path);
    if (cel) blobs[cel[1]] = f.data.toString('base64');
    if (res) resources[`${res[2]}:${res[1]}`] = f.data.toString('base64');
    if (/^\.pxl\/pixel-history\/.+\.json$/.test(f.path)) history.push(JSON.parse(f.data.toString('utf8')));
  }
  const imported = store.importBackup('Khôi phục ZIP', store.load(restored.id), blobs, history, resources);
  assert.deepEqual(copied(hydrateMap(store, imported)), Uint32Array.from([48, 42]));
  assert.equal(imported.studio!.tilesets!.ground.assetId, initial.studio!.tilesets!.ground.assetId);
}));

test('MapStore: partial old clients cannot drop tilesets/mapIndex; invalid source mutation never saves', () => withStore(store => {
  const d = store.create('Atlas', 128, 96, 0, mapFixture());
  for (const field of ['tilesets', 'mapIndex'] as const) {
    const partial = structuredClone(d); delete partial.studio![field]; assert.throws(() => store.save(d.id, d.revision, partial), /Không được bỏ/);
  }
  for (const change of ['size', 'frame', 'asset']) {
    const next = structuredClone(d);
    if (change === 'size') next.assets[0].w = 64;
    if (change === 'frame') next.assets[0].frames[0].id = 'replacement';
    if (change === 'asset') next.assets[0].id = 'replacement';
    assert.throws(() => store.save(d.id, d.revision, next), /Atlas/);
    assert.equal(store.load(d.id).revision, d.revision);
  }
}));

test('MapStore: valid hash with foreign tile ID or nonzero clipped edge is rejected on read/save/copy/backup import', () => withStore(store => {
  const draft = mapFixture(33, 2); draw(draft); const created = store.create('Biên', 128, 96, 0, draft);
  const ref = getMap(created, 'forest').layers[0].chunks['1,0'];
  for (const offset of [32, 1]) {
    const invalid = new Uint32Array(1024); invalid[offset] = offset === 32 ? 0xffffffff : 1;
    const blob = store.resourceStore(created.id).put({ version: 1, kind: 'tile-index', w: 32, h: 32, data: invalid }).blob;
    const next = store.load(created.id); next.studio!.resources![ref] = { version: 1, kind: 'tile-index', w: 32, h: 32, blob };
    validateDocument(next); // Metadata-only validation intentionally stays lazy.
    assert.throws(() => store.save(created.id, created.revision, next), /ID ô lạ|mép/);
    const count = readdirSync(store.root).length;
    assert.throws(() => store.copy('Sai', next, created.id), /ID ô lạ|mép/); assert.equal(readdirSync(store.root).length, count);
    const resources: Record<string, string> = {};
    for (const r of Object.values(next.studio!.resources!)) resources[`${r.kind}:${r.blob}`] = store.resourceStore(created.id).compressed({ ...r, blob: r.blob! }).toString('base64');
    assert.throws(() => store.importBackup('Sai ZIP', next, {}, [], resources), /ID ô lạ|mép/); assert.equal(readdirSync(store.root).length, count);
  }
  assert.deepEqual(copied(hydrateMap(store, store.load(created.id))), Uint32Array.from([48, 42]));
}));
