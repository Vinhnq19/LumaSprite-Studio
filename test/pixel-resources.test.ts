import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { ResourceBlobStore } from '../src/node/studio/resource-store.ts';
import { editResourceData } from '../src/studio/resources.ts';
import { newDocument, type PixelDocument } from '../src/studio/pixel/model.ts';

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'pxl-res-worker-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      assert.equal(resolve(dirname(root)), resolve(tmpdir()));
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if already removed
    }
  }
});

const sampleMask = () => ({
  version: 1 as const,
  kind: 'mask' as const,
  w: 2,
  h: 2,
  data: Uint32Array.from([1, 0, 0, 1]),
});

const sampleRgba = () => ({
  version: 1 as const,
  kind: 'rgba' as const,
  w: 2,
  h: 2,
  data: Uint32Array.from([0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff]),
});

function createDocWithResources(): PixelDocument {
  const doc = newDocument('Dự án tài nguyên', 16, 16);
  doc.studio = {
    version: 1,
    resources: {
      selMask: sampleMask(),
      spriteLayer: sampleRgba(),
    },
  };
  return doc;
}

function extractBackup(store: PixelStore, id: string) {
  const blobs: Record<string, string> = {};
  const resources: Record<string, string> = {};
  const history: any[] = [];
  for (const file of store.backupFiles(id)) {
    const resMatch = /^\.pxl\/resources\/([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/.exec(file.path);
    if (resMatch) {
      resources[`${resMatch[2]}:${resMatch[1]}`] = file.data.toString('base64');
    }
    const celMatch = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba\.z$/.exec(file.path);
    if (celMatch) {
      blobs[celMatch[1]] = file.data.toString('base64');
    }
    if (/^\.pxl\/pixel-history\/[\w-]+\.json$/.test(file.path)) {
      history.push(JSON.parse(file.data.toString('utf8')));
    }
  }
  return { blobs, resources, history };
}

test('PixelResources: malformed history skips GC without deleting aged referenced blob and returns committed revision', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('Dự án GC', 16, 16, 0, createDocWithResources());
  let current = store.load(created.id);

  const initialMaskBlob = current.studio!.resources!.selMask.blob!;
  const initialMaskPath = join(store.dir(current.id), '.pxl', 'resources', `${initialMaskBlob}.mask.z`);
  assert.ok(existsSync(initialMaskPath));

  // Save revision 2 with edited mask so initialMaskBlob becomes referenced in history
  const next = structuredClone(current);
  next.studio!.resources!.selMask = editResourceData(
    store.resource(current.id, 'selMask'),
    Uint32Array.from([0, 1, 1, 0])
  );
  current = store.save(current.id, current.revision, next);
  const rev2Blob = current.studio!.resources!.selMask.blob!;
  assert.notEqual(rev2Blob, initialMaskBlob);

  // Age the initial historical blob past 24h
  const pastTime = new Date(Date.now() - 3 * 86400000);
  utimesSync(initialMaskPath, pastTime, pastTime);

  // Inject a malformed history file (invalid JSON / schema)
  const historyDir = join(store.dir(current.id), '.pxl', 'pixel-history');
  writeFileSync(join(historyDir, 'bad-history-entry.json'), '{"not": "a valid document"}');

  // Save revision 3
  const rev3Doc = structuredClone(current);
  rev3Doc.name = 'Dự án GC Rev 3';
  const savedRev3 = store.save(current.id, current.revision, rev3Doc);

  // Save must succeed and return revision 3
  assert.equal(savedRev3.revision, current.revision + 1);
  assert.equal(savedRev3.name, 'Dự án GC Rev 3');

  // Crucial: The aged historical blob must NOT have been swept because GC was skipped on uncertain roots!
  assert.ok(existsSync(initialMaskPath), 'Aged referenced blob must be retained when history is uncertain');
});

test('PixelResources: invalid resourceBlobs key/array and inline history data reject with zero new directories', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('Gốc', 16, 16, 0, createDocWithResources());
  const current = store.load(created.id);
  const backup = extractBackup(store, current.id);

  const countDirs = () => readdirSync(root).length;
  const initialCount = countDirs();

  // 1. Array for resourceBlobs rejected
  assert.throws(
    () => store.importBackup('ArrayBlobs', current, backup.blobs, backup.history, [] as any),
    /Sao lưu không hợp lệ/
  );
  assert.equal(countDirs(), initialCount, 'No new directory created on array resourceBlobs');

  // 2. Non-canonical key rejected (bare hex hash without kind:)
  const badKeyBlobs = { [backup.resources[Object.keys(backup.resources)[0]]]: 'base64' };
  assert.throws(
    () => store.importBackup('BadKey', current, backup.blobs, backup.history, badKeyBlobs),
    /Khóa hoặc dữ liệu blob tài nguyên không hợp lệ/
  );
  assert.equal(countDirs(), initialCount, 'No new directory created on non-canonical key');

  // 3. Non-string value rejected
  const nonStringValue = { [Object.keys(backup.resources)[0]]: 12345 as any };
  assert.throws(
    () => store.importBackup('NonString', current, backup.blobs, backup.history, nonStringValue),
    /Khóa hoặc dữ liệu blob tài nguyên không hợp lệ/
  );
  assert.equal(countDirs(), initialCount, 'No new directory created on non-string blob value');

  // 4. Inline resource.data in history rejected
  const historyWithInline = structuredClone(backup.history);
  historyWithInline[0].document.studio.resources.selMask.data = Uint32Array.from([1, 1, 1, 1]);
  assert.throws(
    () => store.importBackup('InlineHist', current, backup.blobs, historyWithInline, backup.resources),
    /không được chứa dữ liệu nội dòng/
  );
  assert.equal(countDirs(), initialCount, 'No new directory created on inline history resource.data');

  // 5. Inline resource.data in current doc rejected
  const currentWithInline = structuredClone(current);
  currentWithInline.studio!.resources!.selMask.data = Uint32Array.from([0, 0, 0, 0]);
  assert.throws(
    () => store.importBackup('InlineCurr', currentWithInline, backup.blobs, backup.history, backup.resources),
    /không được chứa dữ liệu nội dòng/
  );
  assert.equal(countDirs(), initialCount, 'No new directory created on inline current resource.data');
});

test('PixelResources: current/history missing mask or invalid mask binary values rejected', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('MaskTest', 16, 16, 0, createDocWithResources());
  const current = store.load(created.id);
  const backup = extractBackup(store, current.id);

  const maskKey = Object.keys(backup.resources).find(k => k.startsWith('mask:'))!;
  assert.ok(maskKey);

  // Missing mask in resourceBlobs for current doc
  const missingCurrentMask = { ...backup.resources };
  delete missingCurrentMask[maskKey];
  assert.throws(
    () => store.importBackup('MissingMask', current, backup.blobs, backup.history, missingCurrentMask),
    /Sao lưu thiếu blob tài nguyên/
  );

  // Missing mask in history doc
  const historyDoc = structuredClone(current);
  const missingHistoryBackup = { ...backup.resources };
  delete missingHistoryBackup[maskKey];
  assert.throws(
    () =>
      store.importBackup(
        'MissingHistMask',
        current,
        backup.blobs,
        [{ document: historyDoc, label: 'h1', time: new Date().toISOString() }],
        missingHistoryBackup
      ),
    /Sao lưu thiếu blob tài nguyên/
  );
});

test('PixelResources: compressed cross-project copy and rejection of foreign unowned refs', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('SourceProject', 16, 16, 0, createDocWithResources());
  const sourceDoc = store.load(created.id);

  // Valid copy: transfers compressed resources
  const copied = store.copy('TargetProject', sourceDoc, sourceDoc.id);
  assert.notEqual(copied.id, sourceDoc.id);
  assert.deepEqual(store.resource(copied.id, 'selMask').data, store.resource(sourceDoc.id, 'selMask').data);
  assert.deepEqual(store.resource(copied.id, 'spriteLayer').data, store.resource(sourceDoc.id, 'spriteLayer').data);

  // Verify source project was not mutated
  const sourceReloaded = store.load(sourceDoc.id);
  assert.equal(sourceReloaded.name, 'SourceProject');

  // Attempting copy where requested document contains a foreign resource blob not in source project
  const foreignDoc = structuredClone(sourceDoc);
  foreignDoc.studio!.resources!.selMask.blob = 'e'.repeat(64);

  const countBefore = readdirSync(root).length;
  assert.throws(() => store.copy('ForeignCopy', foreignDoc, sourceDoc.id), /Tài nguyên bị thiếu hoặc bị xóa/);
  assert.equal(readdirSync(root).length, countBefore, 'Failed copy cleans up target directory');
});

test('PixelResources: explicit removal guard, empty removal, restore drop bypass, and old backup backward compatibility', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('RemovalGuard', 16, 16, 0, createDocWithResources());
  let current = store.load(created.id);

  // 1. Dropping resources field completely throws 400
  const droppedResources = structuredClone(current);
  delete (droppedResources.studio as any).resources;
  assert.throws(
    () => store.save(current.id, current.revision, droppedResources),
    /Không được xóa trường tài nguyên đã tồn tại/
  );

  // 2. Explicit empty resources: {} succeeds
  const explicitEmpty = structuredClone(current);
  explicitEmpty.studio!.resources = {};
  current = store.save(current.id, current.revision, explicitEmpty);
  assert.deepEqual(current.studio!.resources, {});

  // 3. Restore to older snapshot that had resources restores them cleanly
  const historySnapshots = store.history(current.id);
  assert.ok(historySnapshots.length > 0);
  const restored = store.restore(current.id, current.revision, historySnapshots[0].id);
  assert.ok(restored.studio?.resources?.selMask);

  // 4. Old backup compatibility: backup without any resources and without resourceBlobs parameter
  const plainDoc = newDocument('PlainDoc', 16, 16);
  const plainCreated = store.create('PlainProject', 16, 16, 0, plainDoc);
  const plainFiles = store.backupFiles(plainCreated.id);
  const plainBlobs: Record<string, string> = {};
  for (const f of plainFiles) {
    const cMatch = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba\.z$/.exec(f.path);
    if (cMatch) plainBlobs[cMatch[1]] = f.data.toString('base64');
  }
  const oldImported = store.importBackup('OldImported', plainDoc, plainBlobs);
  assert.ok(oldImported.id);
  assert.equal(oldImported.name, 'OldImported');
});

test('PixelResources: checksum tampering triggers recovery from intact historical snapshot', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('TamperRecovery', 16, 16, 0, createDocWithResources());
  let current = store.load(created.id);

  const initialBlob = current.studio!.resources!.selMask.blob!;
  const initialData = store.resource(current.id, 'selMask').data;

  // Save revision 2 with edited mask
  const rev2 = structuredClone(current);
  rev2.studio!.resources!.selMask = editResourceData(
    store.resource(current.id, 'selMask'),
    Uint32Array.from([0, 1, 1, 0])
  );
  current = store.save(current.id, current.revision, rev2);

  const rev2Blob = current.studio!.resources!.selMask.blob!;
  const rev2Path = join(store.dir(current.id), '.pxl', 'resources', `${rev2Blob}.mask.z`);

  // Tamper with the latest resource on disk
  writeFileSync(rev2Path, 'corrupted-data');

  // store.load must throw
  assert.throws(() => store.load(current.id));

  // store.restore to revision 1's snapshot recovers the project
  const snapshot = store.history(current.id).find(h => {
    const doc = JSON.parse(readFileSync(join(store.dir(current.id), '.pxl', 'pixel-history', h.id), 'utf8')).document;
    return doc.studio?.resources?.selMask?.blob === initialBlob;
  })!;
  assert.ok(snapshot);

  const recovered = store.restore(current.id, current.revision, snapshot.id);
  assert.equal(recovered.revision, current.revision + 1);
  assert.deepEqual(store.resource(recovered.id, 'selMask').data, initialData);
});

test('PixelResources: bounded resourceStore caching and releaseResources', () => {
  const root = temporary();
  const store = new PixelStore(root);
  const created = store.create('CacheTest', 16, 16, 0, createDocWithResources());

  const s1 = store.resourceStore(created.id);
  const s2 = store.resourceStore(created.id);
  assert.equal(s1, s2, 'resourceStore must return cached instance');

  store.releaseResources(created.id);
  const s3 = store.resourceStore(created.id);
  assert.notEqual(s1, s3, 'releaseResources must evict the store from cache');
});
