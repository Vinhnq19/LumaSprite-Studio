import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { newDocument, newAsset, celFor, composite, duplicateFrame, deleteFrames, resizeAsset, validateDocument } from '../src/studio/pixel/model.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';

const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), 'pxl-character-independent-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
function fixture(): any {
  const d: any = newDocument('Nhân vật chuẩn', 18, 18), a = d.assets[0], f = a.frames[0].id;
  celFor(a, a.layers[0].id, f, true)!.data![0] = 0xff0000ff;
  a.metadata.pivot = { x: 8.5 / 18, y: 17.5 / 18 }; duplicateFrame(a, f, 'copy'); d.assets.push(newAsset('Vật phẩm', 8, 8));
  d.studio = { version: 1, resources: {
    master: { version: 1, kind: 'rgba', w: 18, h: 18, data: composite(a, f).data.slice() },
    headmask: { version: 1, kind: 'mask', w: 18, h: 18, data: Uint32Array.from({ length: 324 }, (_, i) => +(i < 3)) },
  }, characters: { hero: { version: 1, id: 'hero', name: 'Nhân vật', approved: true,
    source: { assetId: a.id, frameId: f, captureRevision: 777, w: 18, h: 18, rgbaResourceId: 'master', palette: [...a.palette], pivot: { x: 8.5, y: 17.5 } },
    parts: { head: { name: 'Đầu', maskResourceId: 'headmask' } },
    landmarks: { root: { name: 'Chân', x: 8, y: 17 }, hand: { name: 'Tay', x: 7, y: 8, partId: 'head' } },
    links: [{ from: 'root', to: 'hand' }], actions: { idle: { name: 'Đứng', template: 'idle' } },
  } } };
  return d;
}

test('Character verification: strict references/versions/geometry reject invalid profiles before a manifest changes', () => {
  const store = new PixelStore(temporary()), created = store.create('Nhân vật', 18, 18, 0, fixture()), current: any = store.load(created.id);
  const path = join(store.dir(current.id), 'pxl.project.json'), initial = readFileSync(path, 'utf8');
  const changes = [
    (d: any) => { d.studio.characters.hero.version = 2; },
    (d: any) => { d.studio.characters.hero.extra = true; },
    (d: any) => { d.studio.characters.hero.id = 'different'; },
    (d: any) => { d.studio.characters.hero.source.assetId = 'missing'; },
    (d: any) => { d.studio.characters.hero.source.frameId = 'missing'; },
    (d: any) => { d.studio.characters.hero.source.rgbaResourceId = 'headmask'; },
    (d: any) => { d.studio.characters.hero.parts.head.maskResourceId = 'master'; },
    (d: any) => { d.studio.characters.hero.landmarks.hand.x = 18; },
    (d: any) => { d.studio.characters.hero.landmarks.hand.partId = 'missing'; },
    (d: any) => { d.studio.characters.hero.links.push({ from: 'hand', to: 'root' }); },
    (d: any) => { d.studio.characters.hero.actions.idle.template = 'not-supported'; },
    (d: any) => { delete d.studio.characters; },
  ];
  for (const change of changes) { const invalid = structuredClone(current); change(invalid); assert.throws(() => store.save(current.id, current.revision, invalid)); assert.equal(readFileSync(path, 'utf8'), initial); }
});

test('Character verification: active source deletion/frame removal/resize fail, but native pixel edits can be saved without rewriting approved source', () => {
  const d = fixture(); validateDocument(d);
  const removed = structuredClone(d); removed.assets.shift(); assert.throws(() => validateDocument(removed));
  const frame = structuredClone(d); deleteFrames(frame.assets[0], [frame.studio.characters.hero.source.frameId]); assert.throws(() => validateDocument(frame));
  const resized = structuredClone(d); resizeAsset(resized.assets[0], 32, 32, 'scale'); assert.throws(() => validateDocument(resized));
  const store = new PixelStore(temporary()), created = store.create('Thử bản chuẩn', 18, 18, 0, d), current: any = store.load(created.id, true);
  const original = store.resource(current.id, 'master').data.slice(), source = structuredClone(current.studio.characters.hero.source);
  const a = current.assets[0], c = a.cels[a.layers[0].cels[a.frames[0].id]]; c.data = c.data.slice(); c.data[1] = 0x00ff00ff; delete c.blob;
  const edited = store.save(current.id, current.revision, current);
  assert.deepEqual((edited.studio as any).characters.hero.source, source); assert.deepEqual(store.resource(edited.id, 'master').data, original);
});

test('Character verification: copying preserves approved IDs, fractional pivot and old capture revision; explicit map removal is reversible', () => {
  const store = new PixelStore(temporary()), created = store.create('Chép nhân vật', 18, 18, 0, fixture()), current: any = store.load(created.id);
  const copied: any = store.copy('Bản sao', current, current.id);
  assert.notEqual(copied.id, current.id); assert.equal(copied.revision, 1);
  assert.deepEqual(copied.studio.characters, current.studio.characters);
  assert.deepEqual(copied.studio.characters.hero.source.pivot, { x: 8.5, y: 17.5 });
  assert.equal(copied.studio.characters.hero.source.captureRevision, 777);
  assert.deepEqual(store.resource(copied.id, 'master').data, store.resource(current.id, 'master').data);
  assert.equal(copied.studio.resources.master.data, undefined);
  const cleared = structuredClone(copied); cleared.studio.characters = {};
  const removed: any = store.save(copied.id, copied.revision, cleared); assert.deepEqual(removed.studio.characters, {});
  const point = store.history(copied.id).find(h => h.revision === copied.revision)!; assert.ok(point);
  const restored: any = store.restore(copied.id, removed.revision, point.id); assert.deepEqual(restored.studio.characters, current.studio.characters);
});
