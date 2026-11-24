import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newAsset, validateDocument, wireParse, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';
import { terrainSlot } from '../src/studio/terrain.ts';
import { validateMapIndex, assertAtlasMutationAllowed } from '../src/studio/tilemaps.ts';
import { registerTileset, createMap, MapStroke, getMap, getMapLayer, readMapCell, addMapLayer, updateMapLayer, reorderMapLayer, removeMapLayer, removeMap, unlinkTileset, copyMapRect, pasteMapRect, setTileCollision, mapResizeLoss, resizeMap } from '../src/studio/map-commands.ts';
import { removeAssetLibraryAndReferences } from '../src/studio/asset-library.ts';

import { mapFixture } from './tilemap-fixture.ts';
const layerId = (d: PixelDocument) => getMap(d, 'forest').layers[0].id;
const cell = (d: PixelDocument, x: number, y: number) => { const m = getMap(d, 'forest'); return readMapCell(d, m, m.layers[0], x, y); };
function paint(d: PixelDocument, action: (s: MapStroke) => void): boolean { const s = new MapStroke(d, 'forest', layerId(d)); action(s); return s.commit(); }

test('Map: stroke crosses chunk31/32, canonical corners/cavities, cancel and sparse erase', () => {
  const d = mapFixture(), empty = wireStringify(d), s = new MapStroke(d, 'forest', layerId(d));
  for (let y = 30; y < 34; y++) for (let x = 30; x < 34; x++) s.set(x, y, 1);
  assert.equal(wireStringify(d), empty, 'No edits before commit'); assert.equal(s.commit(), true);
  assert.equal(Object.keys(getMap(d, 'forest').layers[0].chunks).length, 4);
  assert.equal(cell(d, 31, 31), terrainSlot(255) + 1);
  assert.equal(cell(d, 30, 30), terrainSlot(2 | 4 | 32) + 1);
  paint(d, s => s.set(30, 30, 0));
  assert.equal(cell(d, 31, 31), terrainSlot(127) + 1);
  const beforeCancel = wireStringify(d), cancel = new MapStroke(d, 'forest', layerId(d)); cancel.set(31, 31, 0); cancel.cancel();
  assert.equal(wireStringify(d), beforeCancel); assert.throws(() => cancel.commit());
  const erase = new MapStroke(d, 'forest', layerId(d));
  for (let y = 30; y < 34; y++) for (let x = 30; x < 34; x++) erase.set(x, y, 0);
  erase.commit(); assert.deepEqual(getMap(d, 'forest').layers[0].chunks, {}); assert.equal(Object.keys(d.studio!.resources!).length, 0);
});

test('Map: one gesture one history entry, buffers immutable, locks/read-only and stale owner', () => {
  const d = mapFixture(), history = new PixelHistory(), first = snapshot(d);
  paint(d, s => { s.set(31, 1, 1); s.set(32, 1, 1); }); history.commit(first, d, 'Vẽ');
  const oldBuffer = Object.values(d.studio!.resources!)[0].data!, oldPixels = oldBuffer.slice(), before = snapshot(d);
  paint(d, s => { s.set(31, 1, 48, false); s.set(32, 1, 48, false); }); history.commit(before, d, 'Trang trí');
  assert.deepEqual(oldBuffer, oldPixels);
  assert.equal(history.undo(d), 'Trang trí'); assert.notEqual(cell(d, 31, 1), 48); assert.equal(history.undo(d), 'Vẽ'); assert.equal(cell(d, 31, 1), 0);
  history.undo(d, true); history.undo(d, true); assert.equal(cell(d, 31, 1), 48); assert.equal(history.undo(d, true), undefined);
  const stale = new MapStroke(d, 'forest', layerId(d)); stale.set(1, 1, 1);
  updateMapLayer(d, 'forest', layerId(d), { locked: true });
  assert.throws(() => stale.commit(), /thay đổi/); assert.throws(() => new MapStroke(d, 'forest', layerId(d)), /khóa/);
  assert.equal(copyMapRect(d, 'forest', layerId(d), 31, 1, 2, 1).data[0], 48);
  const reader = new MapStroke(d, 'forest', layerId(d), true); assert.throws(() => reader.set(1, 1, 1), /bộ đọc/);
});

test('Map: bounded iterative contiguous fill does not cross decorations, preserves manual IDs', () => {
  const d = mapFixture(64, 2);
  paint(d, s => { s.set(31, 0, 48, false); s.set(31, 1, 48, false); });
  paint(d, s => s.fill(0, 0, 1));
  assert.equal(cell(d, 30, 1) !== 0, true); assert.equal(cell(d, 31, 1), 48); assert.equal(cell(d, 32, 1), 0);
  const snap = wireStringify(d); assert.equal(paint(d, () => {}), false); assert.equal(wireStringify(d), snap);
  const manual = mapFixture(2, 2); paint(manual, s => { s.set(0, 0, 42, false); s.set(1, 0, 42, false); }); assert.equal(cell(manual, 0, 0), 42);
  const large = mapFixture(256, 256); paint(large, s => s.fill(0, 0, 48, false));
  assert.equal(cell(large, 255, 255), 48); assert.equal(Object.keys(large.studio!.resources!).length, 64);
});

test('Map: lazy missing/foreign/edge chunk bytes and unsafe metadata rejected without writes', () => {
  const d = mapFixture(33, 2); paint(d, s => s.set(32, 1, 1, false));
  const map = getMap(d, 'forest'), layer = map.layers[0], ref = layer.chunks['1,0'];
  const good = d.studio!.resources![ref].data!;
  delete d.studio!.resources![ref].data; d.studio!.resources![ref].blob = 'a'.repeat(64); validateDocument(d);
  assert.throws(() => cell(d, 32, 1), /tải khối/);
  d.studio!.resources![ref].data = good.slice(); d.studio!.resources![ref].data![1] = 5;
  assert.throws(() => validateDocument(d), /mép/);
  d.studio!.resources![ref].data = good.slice(); d.studio!.resources![ref].data![32] = 0xffffffff;
  assert.throws(() => validateDocument(d), /ID ô lạ/);
  d.studio!.resources![ref].data = good;
  const maps = d.studio!.mapIndex!, sets = d.studio!.tilesets!, resources = d.studio!.resources!;
  for (const key of ['01,0', '-1,0', '0,0x0', '__proto__', '2,0']) {
    const bad = structuredClone(maps); bad.forest.layers[0].chunks = { [key]: ref };
    assert.throws(() => validateMapIndex(bad, sets, resources));
  }
  const bad = JSON.parse('{"__proto__": {}}'); assert.throws(() => validateMapIndex(bad, sets, resources), /dự lưu/);
  const before = wireStringify(d); assert.throws(() => createMap(d, 'ground', 'Sai', 257, 2)); assert.equal(wireStringify(d), before);
});

test('Map: native dependencies, explicit unlink clears IDs atomically and is undoable', () => {
  const d = mapFixture(); paint(d, s => s.set(0, 0, 1));
  const a = d.assets[0], before = wireStringify(d);
  assert.throws(() => assertAtlasMutationAllowed(d, a.id, { w: 64 }), /gỡ|Gỡ/);
  assert.throws(() => assertAtlasMutationAllowed(d, a.id, { removedFrameIds: [a.frames[0].id] }));
  assert.throws(() => removeAssetLibraryAndReferences(d, [a.id]));
  assert.throws(() => unlinkTileset(d, 'ground'), /sử dụng/); assert.equal(wireStringify(d), before);
  const b = newAsset('Đá', 128, 96); d.assets.push(b); registerTileset(d, b.id, b.frames[0].id, 16, 'Đá', 'rock');
  const history = new PixelHistory(), snap = snapshot(d); unlinkTileset(d, 'ground', 'rock'); history.commit(snap, d, 'Đổi vật liệu');
  assert.equal(cell(d, 0, 0), 0); assert.equal(d.studio!.tilesets!.ground, undefined);
  history.undo(d); assert.equal(cell(d, 0, 0), 1); assert.ok(d.studio!.tilesets!.ground); validateDocument(d);
});

test('Map: layers, collision, same-material clipboard and wire roundtrip retain IDs', () => {
  const d = mapFixture(), base = layerId(d); paint(d, s => { s.set(1, 1, 48, false); s.set(2, 1, 42, false); });
  const clip = copyMapRect(d, 'forest', base, 1, 1, 2, 1), top = addMapLayer(d, 'forest', 'ground', 'Phía trên');
  pasteMapRect(d, 'forest', top, 31, 1, clip);
  assert.deepEqual(copyMapRect(d, 'forest', top, 31, 1, 2, 1).data, clip.data);
  const before = wireStringify(d);
  assert.throws(() => pasteMapRect(d, 'forest', base, 64, 1, clip));
  assert.throws(() => pasteMapRect(d, 'forest', base, 3, 1, { ...clip, projectId: 'foreign' }));
  assert.equal(wireStringify(d), before);
  setTileCollision(d, 'ground', 48, 'one-way'); assert.equal(d.studio!.tilesets!.ground.tiles[47].collision, 'one-way');
  updateMapLayer(d, 'forest', top, { opacity: 128, visible: false }); reorderMapLayer(d, 'forest', top, 0);
  assert.equal(getMap(d, 'forest').layers[0].id, top);
  const reopened = wireParse(wireStringify(d)); validateDocument(reopened); assert.deepEqual(reopened, d);
  removeMapLayer(d, 'forest', top); assert.equal(getMap(d, 'forest').layers.length, 1);
  assert.throws(() => removeMapLayer(d, 'forest', base)); removeMap(d, 'forest'); assert.equal(Object.keys(d.studio!.resources!).length, 0);
});

test('Map: resource limit failure leaves whole gesture uncommitted and retains unrelated resources', () => {
  const d = mapFixture(256, 1);
  for (let i = 0; i < 1023; i++) d.studio!.resources![`unrelated_${i}`] = { version: 1, kind: 'tile-index', w: 1, h: 1, data: new Uint32Array(1) };
  const s = new MapStroke(d, 'forest', layerId(d)); s.set(0, 0, 1); s.set(32, 0, 1);
  const before = wireStringify(d); assert.throws(() => s.commit(), /1024/); assert.equal(wireStringify(d), before); s.cancel();
  paint(d, stroke => stroke.set(0, 0, 1)); assert.equal(Object.keys(d.studio!.resources!).length, 1024);
  paint(d, stroke => stroke.set(0, 0, 0)); assert.equal(Object.keys(d.studio!.resources!).length, 1023);
});

test('Map: resize preflight reports clipped cells, keeps source chunks immutable and undo restores dimensions/pixels', () => {
  const d = mapFixture(65, 34); paint(d, s => { s.set(31, 1, 48, false); s.set(32, 1, 48, false); s.set(64, 33, 48, false); });
  const before = snapshot(d), history = new PixelHistory(), encoded = wireStringify(d);
  assert.equal(mapResizeLoss(d, 'forest', 32, 32), 2);
  assert.throws(() => resizeMap(d, 'forest', 32, 32), /2 ô/); assert.equal(wireStringify(d), encoded);
  resizeMap(d, 'forest', 32, 32, true); history.commit(before, d, 'Cắt bản đồ');
  assert.equal(cell(d, 31, 1), 48); assert.equal(getMap(d, 'forest').w, 32); assert.equal(Object.keys(d.studio!.resources!).length, 1);
  history.undo(d); assert.equal(getMap(d, 'forest').h, 34); assert.equal(cell(d, 64, 33), 48); assert.deepEqual(d, wireParse(encoded));
  resizeMap(d, 'forest', 256, 256); assert.equal(cell(d, 64, 33), 48); validateDocument(d);
});

test('Map: private preview cannot shadow a pre-existing chunk used by another layer', () => {
  const d = mapFixture(32, 2), bottom = layerId(d), top = addMapLayer(d, 'forest', 'ground', 'Trên');
  const resourceId = 'map_preview_0_0', data = new Uint32Array(1024); data[0] = 42;
  d.studio!.resources![resourceId] = { version: 1, kind: 'tile-index', w: 32, h: 32, data };
  getMapLayer(getMap(d, 'forest'), top).chunks['0,0'] = resourceId;
  const s = new MapStroke(d, 'forest', bottom); s.set(0, 0, 48, false);
  const preview = s.preview(), again = s.preview(), map = getMap(preview, 'forest');
  assert.equal(readMapCell(preview, map, map.layers[1], 0, 0), 42);
  assert.equal(readMapCell(preview, map, map.layers[0], 0, 0), 48);
  assert.equal(getMap(again, 'forest').layers[0].chunks['0,0'], map.layers[0].chunks['0,0']);
  assert.equal(cell(d, 0, 0), 0); assert.deepEqual(d.studio!.resources![resourceId].data, data);
  s.cancel(); assert.equal(cell(d, 0, 0), 0);
});
