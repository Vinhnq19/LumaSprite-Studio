import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { celFor, newAsset, newDocument, composite, over, wireParse, type PixelDocument } from '../src/studio/pixel/model.ts';
import { renderMapCells, preflightMapImage } from '../src/studio/tilemap-render.ts';
import { MapStroke, getMap, registerTileset, createMap, addMapLayer, updateMapLayer } from '../src/studio/map-commands.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { startRender } from '../src/node/studio/runner.ts';
import type { ExportResult } from '../src/node/studio/render-result.ts';
import { mapFixture } from './tilemap-fixture.ts';
import { decodeTestPng, unzipTestStored } from './fixtures/image-assertions.ts';

function atlasPixels(d: PixelDocument): void {
  const a = d.assets[0], cel = celFor(a, a.layers[0].id, a.frames[0].id, true)!;
  cel.data!.fill(0x885522ff); cel.data![0] = 0x77889980; a.metadata = { pivot: { x: .5, y: 1 }, hitbox: { x: 2, y: 3, w: 4, h: 5 } };
}
test('Map renderer: viewport and full export share exact normal alpha/layer order, hidden layers and source edits', () => {
  const d = mapFixture(33, 2); atlasPixels(d);
  const base = getMap(d, 'forest').layers[0].id;
  let s = new MapStroke(d, 'forest', base); s.set(31, 0, 1, false); s.set(32, 0, 48, false); s.commit();
  const b = newAsset('Đá', 128, 96, 0x3366aa80); d.assets.push(b); registerTileset(d, b.id, b.frames[0].id, 16, 'Đá', 'rock');
  const top = addMapLayer(d, 'forest', 'rock', 'Nước'); s = new MapStroke(d, 'forest', top); s.set(31, 0, 1, false); s.commit(); updateMapLayer(d, 'forest', top, { opacity: 128 });
  const viewport = renderMapCells(d, 'forest', { x: 31, y: 0, w: 2, h: 2 }), full = renderMapCells(d, 'forest');
  assert.equal(viewport.data[0], over(0x77889980, 0x3366aa80, 128));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) assert.equal(viewport.data[y * 32 + x], full.data[y * full.w + 31 * 16 + x]);
  updateMapLayer(d, 'forest', top, { visible: false }); assert.equal(renderMapCells(d, 'forest', { x: 31, y: 0, w: 1, h: 1 }).data[0], 0x77889980);
  celFor(d.assets[0], d.assets[0].layers[0].id, d.assets[0].frames[0].id)!.data![0] = 0xff00ffff;
  assert.equal(renderMapCells(d, 'forest', { x: 31, y: 0, w: 1, h: 1 }).data[0], 0xff00ffff);
  const ref = getMap(d, 'forest').layers[0].chunks['1,0']; delete d.studio!.resources![ref].data; d.studio!.resources![ref].blob = 'a'.repeat(64);
  assert.doesNotThrow(() => renderMapCells(d, 'forest', { x: 0, y: 0, w: 1, h: 1 }), 'Unseen chunks are never loaded');
  assert.throws(() => renderMapCells(d, 'forest', { x: 32, y: 0, w: 1, h: 1 }), /tải khối/);
  assert.throws(() => preflightMapImage(8192, 8192), /4096/);
  assert.throws(() => renderMapCells(d, 'forest', { x: 0, y: 0, w: 1.5, h: 2 }), /nguyên/);
});

test('Map renderer: incremental stroke rectangles reproduce full RGBA across chunk edges and autotile neighbors', () => {
  const d = mapFixture(40, 4); atlasPixels(d);
  const layer = getMap(d, 'forest').layers[0].id;
  const seed = new MapStroke(d, 'forest', layer); seed.fill(0, 0, 1, true); seed.commit();
  const stroke = new MapStroke(d, 'forest', layer), displayed = renderMapCells(d, 'forest');
  for (const [x, y, tile] of [[31, 1, 0], [32, 1, 0], [33, 2, 48], [31, 1, 1]]) {
    stroke.set(x, y, tile, true); const rect = stroke.takePaintRect(); assert.ok(rect);
    const preview = stroke.preview(), patch = renderMapCells(preview, 'forest', rect);
    for (let py = 0; py < patch.h; py++) displayed.data.set(patch.data.subarray(py * patch.w, (py + 1) * patch.w), (rect.y * 16 + py) * displayed.w + rect.x * 16);
    assert.deepEqual(displayed.data, renderMapCells(preview, 'forest').data, 'All changed neighbors belong to the reported patch');
    assert.equal(stroke.takePaintRect(), undefined, 'Completed paint consumes only its pending rectangle');
  }
  stroke.cancel(); assert.notDeepEqual(displayed.data, renderMapCells(d, 'forest').data, 'Cancel still requires restoring the full original view');
});

test('Terrain worker: exact native assembly, PNG/JSON/ZIP and oversize preflight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-terrain-worker-'));
  try {
    const store = new PixelStore(root), d = mapFixture(33, 2); atlasPixels(d);
    const s = new MapStroke(d, 'forest', getMap(d, 'forest').layers[0].id); s.set(31, 1, 1, false); s.set(32, 1, 48, false); s.commit();
    const material = newAsset('Cỏ mùa hè', 16, 16, 0x339944ff); d.assets.push(material);
    const saved = store.create('Rừng nhỏ', 128, 96, 0, d);
    const request = { mode: 'terrain' as const, root, projectId: saved.id, revision: saved.revision };
    const output = await startRender({ ...request, operation: 'assemble', assetId: material.id, frameId: material.frames[0].id, name: 'Đất cỏ', options: { tileSize: 16, inset: 2, sampling: 'mirror' } }).promise as ExportResult;
    const proposal = wireParse(Buffer.from(output.data).toString('utf8')), preview = decodeTestPng(Buffer.from(proposal.png, 'base64'));
    assert.equal(preview.w, 128); assert.equal(preview.h, 96); assert.deepEqual(preview.data, composite(proposal.asset, proposal.asset.frames[0].id).data);
    assert.equal(proposal.asset.source, undefined); assert.deepEqual(proposal.asset.palette, [0x339944ff]);
    const zip = await startRender({ ...request, operation: 'map-export', mapId: 'forest', format: 'zip' }).promise as ExportResult;
    const files = unzipTestStored(Buffer.from(zip.data)), portable = JSON.parse(files['map.json'].toString('utf8'));
    assert.equal(portable.revision, saved.revision); assert.equal(portable.layers[0].chunks.length, 2); assert.equal(portable.tilesets[0].tiles[47].mask, null);
    assert.deepEqual(portable.tilesets[0].maskBits, { N: 1, E: 2, S: 4, W: 8, NE: 16, SE: 32, SW: 64, NW: 128 });
    assert.deepEqual(decodeTestPng(files['tilesets/ground/image.png']).data, composite(d.assets[0], d.assets[0].frames[0].id).data);
    assert.equal(JSON.stringify(portable).includes('blob'), false);
    const png = await startRender({ ...request, operation: 'map-export', mapId: 'forest', format: 'png' }).promise as ExportResult;
    assert.deepEqual(decodeTestPng(Buffer.from(png.data)).data, renderMapCells(d, 'forest').data); assert.match(png.filename, /Khu_rừng/);
    const tiles = await startRender({ ...request, operation: 'tileset-export', tilesetId: 'ground' }).promise as ExportResult;
    const tilefiles = unzipTestStored(Buffer.from(tiles.data)); assert.deepEqual(JSON.parse(tilefiles['tileset.json'].toString()).metadata, d.assets[0].metadata);
    await assert.rejects(startRender({ ...request, revision: 999, operation: 'tileset-export', tilesetId: 'ground' }).promise, /Revision/);
    const huge = newDocument('Lớn', 256, 192);
    registerTileset(huge, huge.assets[0].id, huge.assets[0].frames[0].id, 32, 'Ô 32', 'ground');
    createMap(huge, 'ground', 'Lớn', 256, 256, 'forest');
    const hugeSaved = store.create('Lớn', 256, 192, 0, huge);
    // No atlas cel or map chunk needs to be decoded to reject an oversized PNG.
    await assert.rejects(startRender({ ...request, projectId: hugeSaved.id, operation: 'map-export', mapId: 'forest', format: 'png' }).promise, /4096/);
    assert.equal(store.load(saved.id).revision, saved.revision);
  } finally { assert.equal(resolve(dirname(root)), resolve(tmpdir())); assert.ok(root.startsWith(join(tmpdir(), 'pxl-terrain-worker-'))); rmSync(root, { recursive: true, force: true }); }
});
