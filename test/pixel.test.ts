import { decodeTestGif } from './fixtures/gif-assertions.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { newDocument, newAsset, newLayer, celFor, composite, duplicateFrame, unlinkCel, deleteFrames, resizeAsset, mergeDown, playback, validateDocument, wireParse, wireStringify, uid, isLocked } from '../src/studio/pixel/model.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';
import { line, brush, region, shape, rectangle, combineSelection, copySelection, transformClipboard } from '../src/studio/pixel/tools.ts';
import { bindingErrors, Commands } from '../src/studio/pixel/commands.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';
import { serveStudio } from '../src/node/studio/server.ts';

const roots: string[] = [];
const temporary = () => { const p = mkdtempSync(join(tmpdir(), 'pxl-pixel-test-')); roots.push(p); return p; };
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
function zip(data: Uint8Array): Record<string, Buffer> { const b = Buffer.from(data), files: Record<string, Buffer> = {}; let o = 0; while (o + 30 < b.length && b.readUInt32LE(o) === 0x04034b50) { const size = b.readUInt32LE(o + 18), nl = b.readUInt16LE(o + 26), el = b.readUInt16LE(o + 28), start = o + 30 + nl + el; files[b.toString('utf8', o + 30, o + 30 + nl)] = b.subarray(start, start + size); o = start + size; } return files; }
function png(data: Uint8Array): { w: number; h: number; pixels: Uint32Array } {
  const b = Buffer.from(data); let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0); const chunks: Buffer[] = [];
  for (let o = 8; o + 12 <= b.length;) { const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n); if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); mode = d[9]; } if (t === 'PLTE') palette = Buffer.from(d); if (t === 'tRNS') alpha = Buffer.from(d); if (t === 'IDAT') chunks.push(d); o += n + 12; }
  const raw = inflateSync(Buffer.concat(chunks)), out = new Uint32Array(w * h), stride = w * (mode === 3 ? 1 : 4) + 1;
  for (let y = 0; y < h; y++) { assert.equal(raw[y * stride], 0); for (let x = 0; x < w; x++) { const j = y * stride + 1 + x * (mode === 3 ? 1 : 4); if (mode === 3) { const i = raw[j]; out[y * w + x] = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) | palette[i * 3 + 2] << 8 | (alpha[i] ?? 255)) >>> 0; } else out[y * w + x] = raw.readUInt32BE(j); } }
  return { w, h, pixels: out };
}

test('Pixel v2: RGBA wire, groups isolated opacity/visibility and inherited locking', () => {
  const d = newDocument('Mèo', 18, 18), a = d.assets[0], f = a.frames[0].id;
  celFor(a, a.layers[0].id, f, true)!.data![0] = 0xff0000ff;
  const group = newLayer('Nhóm', 'group'), top = newLayer('Ánh sáng', 'image', group.id); group.opacity = 128; a.layers.push(group, top);
  celFor(a, top.id, f, true)!.data![0] = 0x0000ffff;
  assert.equal(composite(a, f).data[0], 0x7f0080ff); group.visible = false; assert.equal(composite(a, f).data[0], 0xff0000ff);
  group.locked = true; assert.equal(isLocked(a, top), true);
  const copy = wireParse(wireStringify(d)); validateDocument(copy); assert.deepEqual(copy, d); assert.equal(copy.assets[0].cels[Object.keys(a.cels)[0]].data instanceof Uint32Array, true);
});
test('Pixel v2: linked/independent cels, event remapping, stable tag endpoints and deletion', () => {
  const a = newAsset('Sprite', 3, 2), l = a.layers[0].id, first = a.frames[0].id;
  celFor(a, l, first, true)!.data![0] = 0xabcdef80; a.metadata.events = [{ frame: 0, name: 'step' }];
  const linked = duplicateFrame(a, first, 'linked'), independent = duplicateFrame(a, linked, 'copy');
  assert.equal(celFor(a, l, first), celFor(a, l, linked)); assert.notEqual(celFor(a, l, first), celFor(a, l, independent));
  celFor(a, l, linked)!.data![0] = 0xffffffff; assert.equal(celFor(a, l, first)!.data![0], 0xffffffff); assert.equal(celFor(a, l, independent)!.data![0], 0xabcdef80);
  unlinkCel(a, l, linked); assert.notEqual(celFor(a, l, first), celFor(a, l, linked));
  const last = duplicateFrame(a, independent, 'blank'); a.tags.push({ id: uid(), name: 'run', from: first, to: last, direction: 'ping-pong', loop: false });
  assert.deepEqual(playback(a, a.tags[0].id).map(s => s.frame.id), [first, linked, independent, last, independent, linked]);
  deleteFrames(a, [first, last]); assert.equal(a.tags[0].from, linked); assert.equal(a.tags[0].to, independent); assert.deepEqual(a.metadata.events?.map(e => e.frame), [0, 1]);
  deleteFrames(a, [linked]); assert.equal(a.tags[0].from, independent); assert.throws(() => deleteFrames(a, [independent]), /ít nhất/);
});
test('Pixel v2: all nine canvas anchors, nearest scaling, linked cel transformed once and metadata undo', () => {
  for (const x of [0, .5, 1]) for (const y of [0, .5, 1]) {
    const a = newAsset('Anchor', 2, 2), f = a.frames[0].id, l = a.layers[0].id; celFor(a, l, f, true)!.data!.set([1, 2, 3, 4]);
    duplicateFrame(a, f, 'linked'); a.metadata = { pivot: { x: .5, y: .5 }, hitbox: { x: 0, y: 0, w: 2, h: 2 } };
    const d = newDocument('Test'); d.assets = [a]; const h = new PixelHistory(), before = snapshot(d);
    resizeAsset(a, 4, 4, 'canvas', x, y); assert.equal(a.cels[Object.keys(a.cels)[0]].data![(y * 2) * 4 + x * 2], 1); assert.equal(Object.keys(a.cels).length, 1);
    assert.equal(a.metadata.pivot!.x, (1 + x * 2) / 4); h.commit(before, d, 'Resize'); h.undo(d); assert.deepEqual(d, before); h.undo(d, true); assert.equal(d.assets[0].w, 4);
  }
  const a = newAsset('Scale', 2, 1); celFor(a, a.layers[0].id, a.frames[0].id, true)!.data!.set([11, 22]); resizeAsset(a, 4, 2, 'scale'); assert.deepEqual([...Object.values(a.cels)[0].data!], [11, 11, 22, 22, 11, 11, 22, 22]);
  assert.throws(() => resizeAsset(a, 4097, 2, 'canvas'), /4096/);
});
test('Pixel v2: merge preserves compositing and history stores small pixel deltas', () => {
  const d = newDocument('Undo', 64, 64), a = d.assets[0], f = a.frames[0].id; const c = celFor(a, a.layers[0].id, f, true)!;
  const h = new PixelHistory(), before = snapshot(d); c.data = c.data!.slice(); c.data[0] = 0xff0000ff; h.commit(before, d, 'Dot'); assert.ok(h.bytes < 4096); h.undo(d); assert.equal(celFor(d.assets[0], a.layers[0].id, f)!.data![0], 0); h.undo(d, true);
  const top = newLayer('Top'); d.assets[0].layers.push(top); celFor(d.assets[0], top.id, f, true)!.data![0] = 0x0000ff80; const expected = composite(d.assets[0], f).data.slice(); mergeDown(d.assets[0], top.id); assert.deepEqual(composite(d.assets[0], f).data, expected);
  const tiny = new PixelHistory(1); const old = snapshot(d); d.name = 'New'; tiny.commit(old, d, 'name'); assert.equal(tiny.trimmed, true); assert.equal(tiny.bytes, 0);
});
test('Pixel v2: brush interpolation, mirror, mask, fill tolerance, shapes and floating transforms', () => {
  const p = new Uint32Array(36); line({ x: 0, y: 0 }, { x: 5, y: 5 }, (x, y) => brush(p, 6, 6, x, y, 0xffffffff, { size: 1, round: false, mirrorX: false, mirrorY: false })); for (let i = 0; i < 6; i++) assert.equal(p[i * 7], 0xffffffff);
  const fill = region(p, 6, 6, 0, 0, 0, false); assert.equal(fill.reduce((n, v) => n + v, 0), 6);
  assert.equal(region(Uint32Array.from([0xff0000ff, 0xfe0000ff, 0]), 3, 1, 0, 0, 1).reduce((a, b) => a + b, 0), 2);
  const mask = rectangle(6, 6, { x: 0, y: 0 }, { x: 1, y: 1 }), copy = copySelection(p, 6, mask)!; assert.equal(copy.w, 2); assert.equal(transformClipboard(copy, 'rotate').data[1], 0xffffffff);
  assert.equal(combineSelection(mask, mask, 'subtract').some(Boolean), false);
  const points: number[] = []; shape({ x: 0, y: 0 }, { x: 1, y: 1 }, false, true, (x, y) => points.push(y * 2 + x)); assert.equal(points.length, 4);
  brush(p, 6, 6, 0, 2, 42, { size: 1, round: false, mirrorX: true, mirrorY: true }); assert.equal(p[2 * 6 + 5], 42); assert.equal(p[3 * 6], 42);
});
test('Pixel v2: custom shortcut conflicts/reserved chords and old preset', () => {
  const c = new Commands(); c.add({ id: 'tool.pen', title: 'Bút', keys: ['p'], run: () => {} }); c.add({ id: 'tool.erase', title: 'Tẩy', keys: ['e'], run: () => {} });
  assert.deepEqual(c.defaults('studio')['tool.pen'], ['b']); assert.throws(() => c.configure({ 'tool.erase': ['p'] }), /trùng/); assert.match(bindingErrors({ 'tool.pen': ['Ctrl+n'] }, ['tool.pen'])[0], /Chrome/); c.configure({ 'tool.pen': ['b'] }); assert.deepEqual(c.bindings['tool.pen'], ['b']);
});

test('Pixel v2: temporary tool state recovers from missing keyup, focus/visibility loss and explicit tool changes', () => {
  const surface = new EventTarget() as EventTarget & { document: EventTarget & { hidden: boolean }; closest: () => null };
  surface.document = Object.assign(new EventTarget(), { hidden: false }); surface.closest = () => null;
  const commands = new Commands(); let active = 'pen';
  commands.add({ id: 'quick.hand', title: 'Hand', keys: ['Space'], temporary: true, run: () => { active = 'hand'; }, release: () => { active = 'pen'; } });
  commands.add({ id: 'quick.pick', title: 'Pick', keys: ['Alt'], temporary: true, run: () => { active = 'pick'; }, release: () => { active = 'pen'; } });
  commands.add({ id: 'tool.pen', title: 'Pen', keys: ['p'], run: () => { active = 'pen'; } }); commands.configure({});
  const dispose = commands.listen(surface as unknown as Window);
  const key = (value: string) => surface.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: value, ctrlKey: false, metaKey: false, altKey: value === 'Alt', shiftKey: false }));
  key(' '); assert.equal(active, 'hand'); commands.execute('tool.pen'); assert.equal(active, 'pen');
  key(' '); assert.equal(active, 'hand'); key('p'); assert.equal(active, 'pen');
  key('Alt'); assert.equal(active, 'pick'); surface.dispatchEvent(Object.assign(new Event('pointerdown'), { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })); assert.equal(active, 'pen');
  key(' '); surface.dispatchEvent(new Event('focus')); assert.equal(active, 'pen');
  key(' '); surface.document.hidden = true; surface.document.dispatchEvent(new Event('visibilitychange')); assert.equal(active, 'pen');
  dispose(); key(' '); assert.equal(active, 'pen');
});
test('Pixel v2: blob persistence, stale revisions, restart, 20 snapshots, tamper and restore', () => {
  const root = temporary(), store = new PixelStore(root); let d = store.create('Đồ họa', 18, 18); const a = d.assets[0]; celFor(a, a.layers[0].id, a.frames[0].id, true)!.data![0] = 0x12345678;
  d = store.save(d.id, 1, d); const disk = store.load(d.id); assert.equal(Object.values(disk.assets[0].cels)[0].data, undefined); assert.equal(new PixelStore(root).load(d.id, true).assets[0].w, 18);
  assert.throws(() => store.save(d.id, 1, d), /tab khác/);
  for (let i = 0; i < 23; i++) { d.name = `Name ${i}`; d = store.save(d.id, d.revision, d); }
  assert.equal(store.history(d.id).length, 20); const rev = d.revision; d = store.restore(d.id, rev, store.history(d.id).at(-1)!.id); assert.equal(d.revision, rev + 1);
  const path = join(store.dir(d.id), 'pxl.project.json'), envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.document.name = 'External'; writeFileSync(path, JSON.stringify(envelope)); assert.equal(store.load(d.id).revision, d.revision + 1);
  const blob = Object.values(d.assets[0].cels)[0].blob!, file = join(store.dir(d.id), `.pxl/cels/${blob}.rgba.z`); const saved = readFileSync(file); writeFileSync(file, 'tamper'); assert.throws(() => store.load(d.id), /thay đổi/); writeFileSync(file, saved); assert.equal(store.load(d.id, true).assets[0].cels[Object.keys(a.cels)[0]].data![0], 0x12345678);
});
test('Pixel v2: PNG/atlas match RGBA, Unicode ZIP, tag order/timing, one-shot and metadata', () => {
  const d = newDocument('Xuất', 18, 18), a = d.assets[0], first = a.frames[0].id; a.name = 'Mèo'; const c = celFor(a, a.layers[0].id, first, true)!; c.data![0] = 0x12345678; c.data![1] = 0xffffffff;
  const next = duplicateFrame(a, first, 'copy'); a.frames[0].duration = 80; a.frames[1].duration = 170; a.cels[a.layers[0].cels[next]].data![1] = 0xff0000ff; a.metadata = { pivot: { x: .5, y: 1 }, hitbox: { x: 1, y: 2, w: 5, h: 8 }, events: [{ frame: 1, name: 'chạm đất' }] };
  a.tags.push({ id: uid(), name: 'Chạy', from: first, to: next, direction: 'reverse', loop: false });
  const image = png(exportPixel({ document: d, format: 'png', assetId: a.id }).data); assert.deepEqual(image.pixels, composite(a, first).data); assert.equal(image.w, 18);
  const atlas = zip(exportPixel({ document: d, format: 'atlas' }).data), atlasImage = png(atlas['image.png']), metadata = JSON.parse(atlas['image.json'].toString());
  const frame = Object.values(metadata.frames)[0] as any; for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) assert.equal(atlasImage.pixels[(frame.frame.y + y) * atlasImage.w + frame.frame.x + x], image.pixels[y * 18 + x]);
  assert.deepEqual(metadata.meta.pxl.assets[a.id].hitbox, a.metadata.hitbox); assert.equal(metadata.meta.frameTags[0].direction, 'reverse');
  const strip = zip(exportPixel({ document: d, format: 'strip', tagId: a.tags[0].id }).data), info = JSON.parse(strip['image.json'].toString()); assert.deepEqual(info.meta.pxl.playback, [{ frameId: next, duration: 170 }, { frameId: first, duration: 80 }]);
  const gif = decodeTestGif(Buffer.from(exportPixel({ document: d, format: 'gif', tagId: a.tags[0].id }).data));
  assert.equal(gif.loop, false);
  assert.deepEqual(gif.frames.map(f => f.delay), [17, 8]);
  assert.deepEqual(gif.frames.map(f => f.pixels.slice(0, 3)), [Uint32Array.of(0, 0xff0000ff, 0), Uint32Array.of(0, 0xffffffff, 0)]);
  assert.match(exportPixel({ document: d, format: 'png' }).filename, /Mèo/);
});
test('Pixel v2: backup imports history and damaged latest cel can recover from an intact snapshot', () => {
  const root = temporary(), store = new PixelStore(root); let d = store.create('Backup', 2, 2);
  celFor(d.assets[0], d.assets[0].layers[0].id, d.assets[0].frames[0].id, true)!.data![0] = 0xff0000ff; d = store.save(d.id, d.revision, d);
  const files = store.backupFiles(d.id), blobs: Record<string, string> = {}, histories: any[] = [];
  for (const file of files) { if (file.path.startsWith('.pxl/cels/')) blobs[file.path.split('/').at(-1)!.slice(0, 64)] = file.data.toString('base64'); if (file.path.startsWith('.pxl/pixel-history/')) histories.push(JSON.parse(file.data.toString())); }
  const imported = store.importBackup('Imported', d, blobs, histories); assert.notEqual(imported.id, d.id); assert.equal(store.history(imported.id).length, histories.length); assert.equal(Object.values(store.load(imported.id, true).assets[0].cels)[0].data![0], 0xff0000ff);
  const full = store.load(d.id, true); Object.values(full.assets[0].cels)[0].data![0] = 0x0000ffff; d = store.save(d.id, d.revision, full);
  const latest = Object.values(d.assets[0].cels)[0].blob!, path = join(store.dir(d.id), `.pxl/cels/${latest}.rgba.z`); writeFileSync(path, 'damaged'); assert.throws(() => store.load(d.id));
  const recovered = store.restore(d.id, d.revision, store.history(d.id)[0].id); assert.equal(Object.values(store.load(recovered.id, true).assets[0].cels)[0].data![0], 0xff0000ff);
});
test('Pixel v2 HTTP: Origin, lazy cel, save/reopen, removed code route and backup', async () => {
  const root = temporary(), app = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio') }); const origin = app.url.slice(0, -1);
  async function request(path: string, method = 'GET', value?: unknown) { return fetch(app.url + 'api/pixel/' + path, { method, headers: { origin, ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, body: value === undefined ? undefined : wireStringify(value) }); }
  try {
    assert.equal((await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    let d = wireParse(await (await request('projects', 'POST', { name: 'HTTP', w: 64, h: 64 })).text()); const a = d.assets[0]; celFor(a, a.layers[0].id, a.frames[0].id, true)!.data![0] = 0xffffffff;
    d = wireParse(await (await request(`projects/${d.id}`, 'PUT', { revision: d.revision, document: d })).text()); const c = Object.values(d.assets[0].cels)[0] as any; assert.equal(c.data, undefined);
    const response = wireParse(await (await request(`projects/${d.id}/cel?asset=${a.id}&cel=${c.id}&revision=${d.revision}`)).text()); assert.equal(response.data[0], 0xffffffff);
    assert.equal((await request(`projects/${d.id}`, 'PUT', { revision: 1, document: d })).status, 409);
    assert.equal((await request(`projects/${d.id}/code-preview`, 'POST', { revision: d.revision })).status, 404);
    const saved = wireParse(await (await request(`projects/${d.id}`, 'PUT', { revision: d.revision, document: { ...d, name: 'Changed' } })).text());
    const backup = await request(`projects/${d.id}/backup`); assert.equal(backup.status, 200); assert.ok(zip(new Uint8Array(await backup.arrayBuffer()))['pxl.project.json']);
    const copy = await request('projects', 'POST', { name: 'Copy', document: saved, sourceProjectId: d.id }); assert.equal(copy.status, 201);
    assert.equal(existsSync(join(root, d.id, 'exports')), false);
  } finally { await app.close(); }
});
