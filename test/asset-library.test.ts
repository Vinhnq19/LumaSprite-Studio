import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  newDocument,
  newAsset,
  celFor,
  resizeAsset,
  validateDocument,
  validateBatchProvenance,
  wireParse,
  wireStringify,
  type PixelDocument,
} from '../src/studio/pixel/model.ts';
import {
  validateLibrary,
  validateApplyLibraryOptions,
  getAssetLibraryInfo,
  groupDocumentAssets,
  applyLibraryVersion,
  removeAssetLibraryAndReferences,
} from '../src/studio/asset-library.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';
import { serveStudio } from '../src/node/studio/server.ts';

const roots: string[] = [];
const temporary = () => {
  const p = mkdtempSync(join(tmpdir(), 'pxl-lib-test-'));
  roots.push(p);
  return p;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      assert.equal(resolve(dirname(root)), resolve(tmpdir()));
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

test('Asset Library: validateLibrary checks bounded IDs, kind, safe counter (1..1,000,000), uniqueness, and doc asset existence', () => {
  const doc = newDocument('Project');
  const a1 = doc.assets[0];
  const a2 = newAsset('Asset 2', 32, 32);
  doc.assets.push(a2);

  // Valid entries
  const valid = validateLibrary({
    [a1.id]: { kind: 'character', groupId: 'hero-group', version: 1 },
    [a2.id]: { kind: 'character', groupId: 'hero-group', version: 2 },
  }, doc);
  assert.equal(valid[a1.id].kind, 'character');
  assert.equal(valid[a1.id].version, 1);
  assert.equal(valid[a2.id].version, 2);

  // Rejects non-object / array / null
  assert.throws(() => validateLibrary(null), /object/);
  assert.throws(() => validateLibrary([1, 2, 3]), /object/);
  assert.throws(() => validateLibrary('not-an-object'), /object/);

  // Rejects invalid kind
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'weapon', groupId: 'g1', version: 1 } }, doc), /Loại asset/);

  // Rejects missing asset in doc
  assert.throws(() => validateLibrary({ 'non-existent-id': { kind: 'object', groupId: 'g1', version: 1 } }, doc), /không tồn tại trong tài liệu/);

  // Rejects duplicate version in same group
  assert.throws(() => validateLibrary({
    [a1.id]: { kind: 'character', groupId: 'hero-group', version: 1 },
    [a2.id]: { kind: 'character', groupId: 'hero-group', version: 1 },
  }, doc), /đã tồn tại trong nhóm/);

  // Rejects inconsistent kind in same group
  assert.throws(() => validateLibrary({
    [a1.id]: { kind: 'character', groupId: 'hero-group', version: 1 },
    [a2.id]: { kind: 'object', groupId: 'hero-group', version: 2 },
  }, doc), /không đồng nhất/);

  // Rejects non-positive integer versions and unsafe counters
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: 'g1', version: 0 } }, doc), /1 đến 1\.000\.000/);
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: 'g1', version: -2 } }, doc), /1 đến 1\.000\.000/);
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: 'g1', version: 1.5 } }, doc), /1 đến 1\.000\.000/);
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: 'g1', version: 9007199254740992 } }, doc), /1 đến 1\.000\.000/);
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: 'g1', version: 1_000_001 } }, doc), /1 đến 1\.000\.000/);

  // Rejects invalid group ID pattern
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: 'invalid/id!', version: 1 } }, doc), /Mã nhóm/);
  assert.throws(() => validateLibrary({ [a1.id]: { kind: 'object', groupId: '__proto__', version: 1 } }, doc), /Mã nhóm/);
});

test('Asset Library: validateBatchProvenance enforces exact nested keys, types, numeric bounds, and rejects arbitrary objects', () => {
  // Rejects arbitrary unrecognized configuration object
  assert.throws(() => validateBatchProvenance({
    config: {
      unexpected: { frames: [1, 2, 3] },
      target: { w: -5, h: Infinity },
    },
  }), /không được hỗ trợ|phải là số nguyên/);

  // Rejects negative or infinite target dimensions
  assert.throws(() => validateBatchProvenance({
    config: { target: { w: -5, h: 32 } },
  }), /target\.w/);
  assert.throws(() => validateBatchProvenance({
    config: { target: { w: 32, h: Infinity } },
  }), /target\.h/);

  // Rejects non-boolean reference option
  assert.throws(() => validateBatchProvenance({
    config: { options: { reference: 'not-a-bool' } },
  }), /options\.reference.*boolean/);

  // Rejects >3 references in artDirection
  assert.throws(() => validateBatchProvenance({
    config: {
      artDirection: {
        references: [
          { assetId: 'a1', frameId: 'f1' },
          { assetId: 'a2', frameId: 'f2' },
          { assetId: 'a3', frameId: 'f3' },
          { assetId: 'a4', frameId: 'f4' },
        ],
      },
    },
  }), /tối đa 3 tham chiếu/);

  // Accepts valid captured config
  const valid = validateBatchProvenance({
    provider: 'codex',
    prompt: 'A hero warrior',
    config: {
      target: { w: 32, h: 32, name: 'Hero' },
      options: { style: 'game', view: 'front', paletteMode: 'asset', reference: false },
      artDirection: {
        style: 'game',
        paletteMode: 'auto16',
        palette: [0xff0000ff],
        light: 'upper-left',
        detailLevel: 'medium',
        outline: 'dark',
        references: [{ assetId: 'a1', frameId: 'f1', name: 'Ref 1' }],
      },
    },
  });
  assert.equal(valid.provider, 'codex');
});

test('Native resize regression: resizing asset does not invalidate historical manifest suggestions', () => {
  const doc = newDocument('Hero', 32, 32);
  const asset = doc.assets[0];
  asset.provenance = {
    kind: 'generated',
    originalSource: asset.source,
    batch: {
      provider: 'codex',
      prompt: 'A 32x32 character',
      config: {
        target: { w: 32, h: 32, name: 'Hero' },
      },
      manifest: {
        version: 1,
        parts: [{ name: 'core', box: { x: 8, y: 8, w: 16, h: 16 } }],
      },
    },
  };

  // Valid at 32x32
  validateDocument(doc);

  // Resize canvas down to 18x18
  resizeAsset(asset, 18, 18, 'canvas');
  assert.equal(asset.w, 18);
  assert.equal(asset.h, 18);

  // Must not throw despite part core box extending beyond 18x18, because historical manifest refers to captured target 32x32
  validateDocument(doc);
});

test('Asset Library: lookup and grouping defaults uncategorized assets without colliding with explicit groupIds', () => {
  const doc = newDocument('Project');
  const a1 = doc.assets[0];
  const a2 = newAsset('Uncategorized', 16, 16);
  const a3 = newAsset('Char v2', 32, 32);
  doc.assets.push(a2, a3);

  // Explicit group that happens to use a2's id
  doc.studio = {
    version: 1,
    library: {
      [a1.id]: { kind: 'character', groupId: a2.id, version: 1 },
      [a3.id]: { kind: 'character', groupId: a2.id, version: 2 },
    },
  };

  // Lookup explicit
  const info1 = getAssetLibraryInfo(doc, a1.id);
  assert.equal(info1.kind, 'character');
  assert.equal(info1.groupId, a2.id);
  assert.equal(info1.isExplicit, true);

  // Lookup uncategorized default uses isolated synthetic group prefix
  const info2 = getAssetLibraryInfo(doc, a2.id);
  assert.equal(info2.kind, 'object');
  assert.equal(info2.groupId, `asset:${a2.id}`);
  assert.equal(info2.version, 1);
  assert.equal(info2.isExplicit, false);

  // Grouped library isolates the unclassified asset from the explicit group
  const grouped = groupDocumentAssets(doc);
  assert.equal(grouped.characters.length, 1);
  assert.equal(grouped.characters[0].groupId, a2.id);
  assert.equal(grouped.characters[0].versions.length, 2);

  assert.equal(grouped.objects.length, 1);
  assert.equal(grouped.objects[0].groupId, `asset:${a2.id}`);
  assert.equal(grouped.objects[0].versions.length, 1);
  assert.equal(grouped.objects[0].versions[0].asset.id, a2.id);
});

test('Asset Library: applyLibraryVersion validates options, prevents caller mutation, rejects duplicate IDs and counter overflow', () => {
  const doc = newDocument('Project');
  const src = doc.assets[0];
  src.name = 'Original Hero';
  celFor(src, src.layers[0].id, src.frames[0].id, true)!.data![0] = 0x112233ff;

  const newV2 = newAsset('New Hero', 32, 32);

  // Rejects null / non-object options
  assert.throws(() => applyLibraryVersion(doc, newV2, null), /object/);
  assert.throws(() => applyLibraryVersion(doc, newV2, undefined), /object/);
  assert.throws(() => applyLibraryVersion(doc, newV2, 'invalid'), /object/);

  // Rejects if newAsset.id already exists in document
  assert.throws(() => applyLibraryVersion(doc, src, { kind: 'character' }), /đã tồn tại/);

  // Does not mutate caller's newAsset
  const docAfterV2 = applyLibraryVersion(doc, newV2, {
    kind: 'character',
    name: 'Hero Version 2',
    versionOf: src.id,
  });
  assert.equal(newV2.name, 'New Hero', "Caller's newAsset must not be mutated in-place");
  assert.equal(docAfterV2.assets[1].name, 'Hero Version 2');

  // Source asset RGBA, layers, frames, name are 100% untouched
  assert.equal(src.name, 'Original Hero');
  assert.equal(celFor(src, src.layers[0].id, src.frames[0].id)!.data![0], 0x112233ff);

  // Rejects version counter overflow beyond 1,000,000
  const maxDoc: PixelDocument = {
    ...docAfterV2,
    studio: {
      version: 1,
      library: {
        [src.id]: { kind: 'character', groupId: 'hero-group', version: 1_000_000 },
      },
    },
  };
  assert.throws(() => applyLibraryVersion(maxDoc, newAsset('Hero Overflow', 32, 32), {
    versionOf: src.id,
  }), /đạt giới hạn tối đa 1\.000\.000/);
});

test('Asset Library: removal helper cleans library entries and art-direction refs and supports history undo', () => {
  const doc = newDocument('Project');
  const a1 = doc.assets[0];
  const a2 = newAsset('Asset 2', 32, 32);
  doc.assets.push(a2);

  doc.studio = {
    version: 1,
    artDirection: {
      style: 'game',
      references: [{ assetId: a1.id, frameId: a1.frames[0].id }],
    },
    library: {
      [a1.id]: { kind: 'character', groupId: 'g1', version: 1 },
      [a2.id]: { kind: 'object', groupId: 'g2', version: 1 },
    },
  };

  const history = new PixelHistory();
  const beforeSnapshot = snapshot(doc);

  // Remove a1
  let updated = removeAssetLibraryAndReferences(doc, [a1.id]);
  updated = { ...updated, assets: updated.assets.filter(a => a.id !== a1.id) };
  history.commit(beforeSnapshot, updated, 'Delete a1');

  assert.equal(updated.studio?.library?.[a1.id], undefined);
  assert.ok(updated.studio?.library?.[a2.id]);
  assert.deepEqual(updated.studio?.artDirection?.references, []);

  // Undo restores a1 and its references in studio.library and artDirection.references
  history.undo(updated);
  assert.equal(updated.assets.length, 2);
  assert.equal(updated.studio?.library?.[a1.id]?.version, 1);
  const restoredRefs = (updated.studio?.artDirection as any)?.references;
  assert.equal(restoredRefs?.length, 1);
  assert.equal(restoredRefs?.[0]?.assetId, a1.id);
});
