// Independent acceptance tests: immutable resources must survive the project lifecycle.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, utimesSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { ResourceBlobStore } from '../src/node/studio/resource-store.ts';
import { editResourceData } from '../src/studio/resources.ts';
import { newDocument, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';

const roots: string[] = [];
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'pxl-resource-independent-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
const mask = () => ({ version: 1 as const, kind: 'mask' as const, w: 3, h: 2, data: Uint32Array.from([0, 1, 0, 1, 1, 0]) });
function document(): PixelDocument { const doc = newDocument('Nguồn nhân vật', 18, 18); doc.studio = { version: 1, resources: { body: mask() } } as any; return doc; }
function ref(doc: PixelDocument): any { return (doc.studio as any).resources.body; }
function owned(store: PixelStore, doc: PixelDocument, resource = ref(doc)): string { return join(store.dir(doc.id), '.pxl', 'resources', `${resource.blob}.${resource.kind}.z`); }
function backup(store: PixelStore, id: string): { blobs: Record<string, string>; resources: Record<string, string>; history: any[] } {
  const blobs: Record<string, string> = {}, resources: Record<string, string> = {}, history: any[] = [];
  for (const file of store.backupFiles(id)) {
    const resource = /^\.pxl\/resources\/([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/.exec(file.path);
    if (resource) resources[`${resource[2]}:${resource[1]}`] = file.data.toString('base64');
    const cel = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba\.z$/.exec(file.path);
    if (cel) blobs[cel[1]] = file.data.toString('base64');
    if (/^\.pxl\/pixel-history\/[\w-]+\.json$/.test(file.path)) history.push(JSON.parse(file.data.toString('utf8')));
  }
  return { blobs, resources, history };
}

test('Resource verification: immutable lazy save, compressed copy, backup histories and recovery preserve every word', () => {
  const root = temporary(), store = new PixelStore(root);
  const created = store.create('Nguồn nhân vật', 18, 18, 0, document());
  let current = store.load(created.id);
  const first = ref(current), firstPath = owned(store, current);
  assert.equal(first.data, undefined);
  assert.deepEqual(store.resource(current.id, 'body').data, mask().data);
  assert.equal(ref(store.load(current.id, true)).data, undefined, 'Native cel hydration must not load masks');
  const next = structuredClone(current);
  (next.studio as any).resources.body = editResourceData(store.resource(current.id, 'body'), Uint32Array.from([1, 1, 0, 1, 0, 1]));
  current = store.save(current.id, current.revision, next);
  assert.notEqual(ref(current).blob, first.blob);
  assert.deepEqual(new ResourceBlobStore(store.dir(current.id)).read(first), mask().data);
  const beforeCopy = wireStringify(current);
  const copied = store.copy('Bản sao', current, current.id);
  assert.equal(wireStringify(current), beforeCopy, 'Copy must not rewrite caller project ID or buffers');
  assert.notEqual(copied.id, current.id);
  assert.deepEqual(store.resource(copied.id, 'body').data, Uint32Array.from([1, 1, 0, 1, 0, 1]));
  assert.equal(ref(copied).data, undefined);
  assert.deepEqual(readFileSync(owned(store, copied)), readFileSync(owned(store, current)));
  const saved = backup(store, current.id);
  const imported = store.importBackup('Khôi phục', current, saved.blobs, saved.history, saved.resources);
  assert.deepEqual(store.resource(imported.id, 'body').data, store.resource(current.id, 'body').data);
  assert.ok(existsSync(join(store.dir(imported.id), '.pxl', 'resources', `${first.blob}.mask.z`)), 'Historical resource is copied too');
  writeFileSync(owned(store, current), 'corrupt latest resource');
  assert.throws(() => store.load(current.id));
  const snapshot = store.history(current.id).find(h => ref(JSON.parse(readFileSync(join(store.dir(current.id), '.pxl', 'pixel-history', h.id), 'utf8')).document).blob === first.blob)!;
  assert.ok(snapshot);
  const restored = store.restore(current.id, current.revision, snapshot.id);
  assert.deepEqual(store.resource(restored.id, 'body').data, mask().data);
  assert.ok(existsSync(firstPath));
});

test('Resource verification: malformed manifests and conflicting historical sizes cannot commit or create a partial project', () => {
  const root = temporary(), store = new PixelStore(root);
  const created = store.create('Giới hạn', 18, 18, 0, document()), current = store.load(created.id);
  const manifest = join(store.dir(current.id), 'pxl.project.json'), original = readFileSync(manifest, 'utf8');
  for (const mutate of [
    (d: any) => { delete d.studio.resources; },
    (d: any) => { d.studio.resources.body.version = 2; },
    (d: any) => { d.studio.resources.body.w = 8192; d.studio.resources.body.h = 1 / 8192; },
    (d: any) => { d.studio.resources.body = { ...mask(), data: Uint32Array.from([0, 1, 3, 1, 0, 0]) }; },
    (d: any) => { d.studio.resources.body.blob = '0'.repeat(64); },
  ]) {
    const next = structuredClone(current); mutate(next);
    assert.throws(() => store.save(current.id, current.revision, next));
    assert.equal(readFileSync(manifest, 'utf8'), original);
  }
  const saved = backup(store, current.id), historyDoc = structuredClone(current);
  ref(historyDoc).w = 2; ref(historyDoc).h = 2;
  const before = readdirSync(root).sort();
  assert.throws(() => store.importBackup('Sai lịch sử', current, saved.blobs, [{ document: historyDoc, label: 'conflicting samples', time: new Date().toISOString() }], saved.resources));
  assert.deepEqual(readdirSync(root).sort(), before, 'Failed import must not retain a partially created project');
  assert.throws(() => store.importBackup('Thiếu blob', current, saved.blobs, saved.history));
  assert.deepEqual(readdirSync(root).sort(), before);
  const empty = structuredClone(current); (empty.studio as any).resources = {};
  const removed = store.save(current.id, current.revision, empty);
  assert.deepEqual((removed.studio as any).resources, {});
  assert.throws(() => store.save(current.id, current.revision, empty), (e: any) => e.status === 409);
});

test('Resource verification: GC retains current/history and arbitrary images, prunes only aged owned unreferenced resources', () => {
  const root = temporary(), store = new PixelStore(root);
  const created = store.create('Thu gom', 18, 18, 0, document()); let current = store.load(created.id);
  const first = ref(current), firstPath = owned(store, current), blobStore = new ResourceBlobStore(store.dir(current.id));
  const orphan = blobStore.put({ version: 1, kind: 'mask', w: 3, h: 2, data: new Uint32Array(6) });
  const orphanPath = owned(store, current, orphan), image = join(store.dir(current.id), '.pxl', 'resources', 'ảnh-tự-thêm.png');
  writeFileSync(image, 'user file'); const old = new Date(Date.now() - 3 * 86400000);
  for (const path of [firstPath, orphanPath, image]) utimesSync(path, old, old);
  const removed = structuredClone(current); (removed.studio as any).resources = {};
  current = store.save(current.id, current.revision, removed);
  assert.ok(existsSync(firstPath), 'Historical reference is retained');
  assert.equal(existsSync(orphanPath), false);
  assert.ok(existsSync(image));
  for (let i = 0; i < 23; i++) { const next = structuredClone(current); next.name = `Thu gom ${i}`; current = store.save(current.id, current.revision, next); }
  assert.equal(store.history(current.id).length, 20);
  assert.equal(existsSync(firstPath), false, 'Pruned history no longer roots the aged blob');
  assert.ok(existsSync(image));
});

test('Resource verification: uncertain history roots skip all GC while a valid save still returns its committed revision', () => {
  const root = temporary(), store = new PixelStore(root), created = store.create('Lịch sử hỏng', 18, 18, 0, document());
  let current = store.load(created.id); const historical = owned(store, current);
  const next = structuredClone(current); (next.studio as any).resources = {};
  current = store.save(current.id, current.revision, next);
  const old = new Date(Date.now() - 3 * 86400000); utimesSync(historical, old, old);
  for (const h of store.history(current.id)) {
    const path = join(store.dir(current.id), '.pxl', 'pixel-history', h.id), entry = JSON.parse(readFileSync(path, 'utf8'));
    if (entry.document.studio?.resources?.body) { entry.document.studio.resources.body = {}; writeFileSync(path, JSON.stringify(entry)); }
  }
  const again = structuredClone(current); again.name = 'Vẫn lưu được';
  const saved = store.save(current.id, current.revision, again);
  assert.equal(saved.revision, current.revision + 1);
  assert.equal(store.load(saved.id).name, 'Vẫn lưu được');
  assert.ok(existsSync(historical), 'Uncertain roots must never be swept');
});

test('Resource verification: backup resource input has canonical ownership keys and metadata-only history', () => {
  const root = temporary(), store = new PixelStore(root), created = store.create('Định dạng sao lưu', 18, 18, 0, document());
  const current = store.load(created.id), saved = backup(store, current.id), before = readdirSync(root).sort();
  const inline = structuredClone(current); ref(inline).data = mask().data;
  const histories = [{ document: inline, label: 'inline not a persisted reference', time: new Date().toISOString() }];
  assert.throws(() => store.importBackup('Sai lịch sử', current, saved.blobs, histories, saved.resources));
  for (const resourceBlobs of [[], { ...saved.resources, '../bad': 'AAAA' }, { [ref(current).blob]: saved.resources[`mask:${ref(current).blob}`] }]) {
    assert.throws(() => store.importBackup('Sai khóa', current, saved.blobs, saved.history, resourceBlobs as any));
    assert.deepEqual(readdirSync(root).sort(), before);
  }
  assert.deepEqual(readdirSync(root).sort(), before);
});

test('Resource verification: GC never follows internal directory junctions, including the .pxl ancestor', t => {
  for (const ancestor of [false, true]) {
    const root = temporary(), userFolder = join(root, 'user-folder'); mkdirSync(userFolder);
    const dataDir = ancestor ? join(userFolder, 'resources') : userFolder; mkdirSync(dataDir, { recursive: true });
    if (!ancestor) mkdirSync(join(root, '.pxl'));
    const file = join(dataDir, `${'a'.repeat(64)}.mask.z`); writeFileSync(file, 'user-owned-file');
    const old = new Date(Date.now() - 3 * 86400000); utimesSync(file, old, old);
    try { symlinkSync(userFolder, ancestor ? join(root, '.pxl') : join(root, '.pxl', 'resources'), 'junction'); }
    catch (error: any) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(`OS junction creation denied: ${error.code}`); return; } throw error; }
    try { new ResourceBlobStore(root).collect(new Set()); } catch (error: any) { assert.ok([400, 403].includes(error.status)); }
    assert.ok(existsSync(file), `Must retain user file through ${ancestor ? '.pxl ancestor' : 'resources root'} junction`);
  }
});

test('Resource verification: a linked unused resource directory cannot delete user files or make a committed save report failure', t => {
  for (const folder of ['resources', 'cels']) {
  const root = temporary(), store = new PixelStore(root), created = store.create('Liên kết Windows', 18, 18), current = store.load(created.id);
  const userFolder = join(store.dir(current.id), 'user-folder'); mkdirSync(userFolder);
  const file = join(userFolder, `${'b'.repeat(64)}.rgba.z`); writeFileSync(file, 'user-owned-file');
  const old = new Date(Date.now() - 3 * 86400000); utimesSync(file, old, old);
  try { symlinkSync(userFolder, join(store.dir(current.id), '.pxl', folder), 'junction'); }
  catch (error: any) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(`OS junction creation denied: ${error.code}`); return; } throw error; }
  current.name = 'Lưu thành công'; const saved = store.save(current.id, current.revision, current);
  assert.equal(saved.revision, current.revision + 1); assert.equal(store.load(saved.id).name, 'Lưu thành công');
  assert.ok(existsSync(file), `Keep user file through ${folder} junction`);
  }
});
