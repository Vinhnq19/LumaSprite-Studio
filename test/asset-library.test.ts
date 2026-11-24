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
import { fastHttpFixture } from './fixtures/fast-http.ts';

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

test('HTTP API: apply proposal with library classification, batch provenance, exact RGBA, later versions, and failed validation resilience', async () => {
  const root = temporary();
  const app = await serveStudio(root, {
    port: 0,
    uiDir: resolve('dist/studio'),
    providers: {
      codex: process.execPath,
      deepseek: fastHttpFixture(root),
      prefix: [resolve('studio/fake-cli.js'), '--state-dir', root],
      timeout: 5000,
    },
  });

  const req = async (path: string, method = 'GET', value?: unknown) => {
    const url = `${app.url}api/pixel/${path}`;
    const headers: Record<string, string> = {
      origin: app.url.slice(0, -1),
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    };
    return fetch(url, {
      method,
      headers,
      body: value === undefined ? undefined : wireStringify(value),
    });
  };

  try {
    // 1. Create project with red background so cel exists
    const createRes = await req('projects', 'POST', { name: 'Batch Lib Test', background: 0xff0000ff });
    assert.equal(createRes.status, 201);
    let doc = await createRes.json();
    const base = `projects/${doc.id}`;
    const srcAsset = doc.assets[0];

    // Paint source asset cel
    const srcCelKey = Object.keys(srcAsset.cels)[0];
    const srcCelRes = await req(`${base}/cel?asset=${srcAsset.id}&cel=${srcCelKey}&revision=${doc.revision}`);
    assert.equal(srcCelRes.status, 200);
    const srcCel = wireParse(await srcCelRes.text());
    const originalSrcPixel = srcCel.data ? srcCel.data[0] : 0;

    // 2. Start a batch with provider codex
    const startRes = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'FIXTURE_MANIFEST_VALID: A brave warrior hero',
      assetId: srcAsset.id,
    });
    assert.equal(startRes.status, 202);
    const batchInfo = await startRes.json();

    // 3. Wait until ready
    let batch: any;
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      const res = await req(`${base}/generation-batches/${batchInfo.id}`);
      batch = await res.json();
      if (!['running'].includes(batch.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(batch.status, 'ready');
    const cand = batch.candidates[0];

    // 4. Preview candidate
    const prevRes = await req(`${base}/generation-batches/${batch.id}/candidates/${cand.id}/preview`, 'POST', {
      revision: doc.revision,
    });
    assert.equal(prevRes.status, 200);
    const preview = await prevRes.json();

    // Fetch variant frame data to assert exact RGBA
    const frameRes = await req(`${base}/proposals/${preview.proposalId}/variants/${preview.selectedVariantId}/frame?asset=${preview.variants[0].assets[0].id}&frame=${preview.variants[0].assets[0].frames[0].id}&revision=${doc.revision}`);
    assert.equal(frameRes.status, 200);
    const frameData = wireParse(await frameRes.text());

    // 5. Failed apply request: invalid versionOf target leaves proposal and revision intact
    const badApply = await req(`${base}/apply-proposal`, 'POST', {
      revision: doc.revision,
      proposalId: preview.proposalId,
      variantId: preview.selectedVariantId,
      library: {
        kind: 'character',
        versionOf: 'non-existent-id',
      },
    });
    assert.equal(badApply.status, 404);

    // Verify batch and proposal remain usable
    const batchCheck = await (await req(`${base}/generation-batches/${batch.id}`)).json();
    assert.equal(batchCheck.status, 'ready', 'Batch remains ready after failed apply');

    // 6. Successful apply with explicit library options
    const applyRes = await req(`${base}/apply-proposal`, 'POST', {
      revision: doc.revision,
      proposalId: preview.proposalId,
      variantId: preview.selectedVariantId,
      library: {
        kind: 'character',
        name: 'Knight Hero v2',
        versionOf: srcAsset.id,
      },
    });
    assert.equal(applyRes.status, 200);
    const savedDoc = await applyRes.json();
    assert.equal(savedDoc.revision, doc.revision + 1);
    assert.equal(savedDoc.assets.length, 2);

    // Verify exact source pixel unchanged and new selected variant RGBA match
    const reopenRes = await req(base);
    const reopenedDoc = await reopenRes.json();
    const reopenedSrcCel = await (await req(`${base}/cel?asset=${srcAsset.id}&cel=${srcCelKey}&revision=${reopenedDoc.revision}`)).text();
    assert.equal(wireParse(reopenedSrcCel).data[0], originalSrcPixel, 'Source asset cel pixel must remain untouched');

    const newAsset = savedDoc.assets[1];
    const newCelKey = Object.keys(newAsset.cels)[0];
    const newCelRes = await req(`${base}/cel?asset=${newAsset.id}&cel=${newCelKey}&revision=${reopenedDoc.revision}`);
    const newCelData = wireParse(await newCelRes.text());
    assert.deepEqual(Array.from(newCelData.data), Array.from(frameData.data), 'New asset cel data must match selected variant frame');

    // Verify library metadata
    const lib = savedDoc.studio?.library;
    assert.ok(lib);
    assert.equal(lib[srcAsset.id].kind, 'character');
    assert.equal(lib[srcAsset.id].version, 1);
    assert.equal(newAsset.name, 'Knight Hero v2');
    assert.equal(lib[newAsset.id].kind, 'character');
    assert.equal(lib[newAsset.id].version, 2);
    assert.equal(lib[srcAsset.id].groupId, lib[newAsset.id].groupId);

    // Verify captured batch provenance
    const prov = newAsset.provenance?.batch;
    assert.ok(prov, 'Captured batch provenance must be present');
    assert.equal(prov.provider, 'codex');
    assert.ok(prov.prompt.includes('brave warrior hero'));
    assert.ok(prov.config);
    assert.equal(prov.config.target?.w, 32);
    assert.equal(prov.config.target?.h, 32);
    assert.ok(prov.manifest, 'Validated design manifest suggestions present in provenance');
    assert.equal(prov.manifest.version, 1);

    // Ensure no raw RGBA / base64 in provenance
    const provStr = JSON.stringify(prov);
    assert.ok(!provStr.includes('$rgba'));
    assert.ok(!provStr.includes('data:image'));

    // 7. Test project copy round trip
    const copyRes = await req('projects', 'POST', {
      name: 'Project Copy',
      document: savedDoc,
      sourceProjectId: savedDoc.id,
    });
    assert.equal(copyRes.status, 201);
    const copied = await copyRes.json();
    assert.equal(copied.studio?.library?.[newAsset.id].version, 2);
    assert.ok(copied.assets[1].provenance?.batch);

    // 8. Test backup download and import round trip
    const backupRes = await req(`${base}/backup`);
    assert.equal(backupRes.status, 200);
    const backupBuf = Buffer.from(await backupRes.arrayBuffer());

    const extracted: Record<string, Buffer> = {};
    let o = 0;
    while (o + 30 < backupBuf.length && backupBuf.readUInt32LE(o) === 0x04034b50) {
      const size = backupBuf.readUInt32LE(o + 18), nl = backupBuf.readUInt16LE(o + 26), el = backupBuf.readUInt16LE(o + 28), start = o + 30 + nl + el;
      extracted[backupBuf.toString('utf8', o + 30, o + 30 + nl)] = backupBuf.subarray(start, start + size);
      o = start + size;
    }
    assert.ok(extracted['pxl.project.json']);

    const blobs: Record<string, string> = {};
    const histories: any[] = [];
    for (const [path, buf] of Object.entries(extracted)) {
      if (path.startsWith('.pxl/cels/')) {
        const hash = path.split('/').at(-1)!.slice(0, 64);
        blobs[hash] = buf.toString('base64');
      } else if (path.startsWith('.pxl/pixel-history/')) {
        histories.push(JSON.parse(buf.toString('utf8')));
      }
    }

    const importRes = await req('projects', 'POST', {
      name: 'Imported Backup',
      backup: {
        document: JSON.parse(extracted['pxl.project.json'].toString('utf8')).document,
        blobs,
        history: histories,
      },
    });
    assert.equal(importRes.status, 201);
    const imported = await importRes.json();
    assert.equal(imported.studio?.library?.[newAsset.id].version, 2);
    assert.ok(imported.assets[1].provenance?.batch);

    // 9. Test later versions via API and HTTP provider
    const batch2Res = await req(`${base}/generation-batches`, 'POST', {
      revision: savedDoc.revision,
      provider: 'deepseek',
      prompt: 'FIXTURE_MANIFEST_VALID: Knight version 3',
      assetId: newAsset.id,
    });
    assert.equal(batch2Res.status, 202);
    const batch2Info = await batch2Res.json();

    const until2 = Date.now() + 25000;
    let b2: any;
    while (Date.now() < until2) {
      const res = await req(`${base}/generation-batches/${batch2Info.id}`);
      b2 = await res.json();
      if (!['running'].includes(b2.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(b2.status, 'ready');

    const prev2Res = await req(`${base}/generation-batches/${b2.id}/candidates/${b2.candidates[0].id}/preview`, 'POST', {
      revision: savedDoc.revision,
    });
    assert.equal(prev2Res.status, 200);
    const prev2 = await prev2Res.json();

    // Apply as version 3
    const apply3Res = await req(`${base}/apply-proposal`, 'POST', {
      revision: savedDoc.revision,
      proposalId: prev2.proposalId,
      variantId: prev2.selectedVariantId,
      library: {
        versionOf: newAsset.id,
      },
    });
    assert.equal(apply3Res.status, 200);
    const docV3 = await apply3Res.json();
    assert.equal(docV3.assets.length, 3);
    const assetV3 = docV3.assets[2];
    assert.equal(docV3.studio?.library?.[assetV3.id].version, 3);
    assert.equal(docV3.studio?.library?.[assetV3.id].groupId, lib[srcAsset.id].groupId);
    assert.equal(assetV3.provenance?.batch?.provider, 'deepseek');

    // 10. Test legacy apply compatibility (no library option provided)
    const batch3Res = await req(`${base}/generation-batches`, 'POST', {
      revision: docV3.revision,
      provider: 'codex',
      prompt: 'FIXTURE_MANIFEST_VALID: A simple item',
    });
    assert.equal(batch3Res.status, 202);
    const batch3Info = await batch3Res.json();

    const until3 = Date.now() + 25000;
    let b3: any;
    while (Date.now() < until3) {
      const res = await req(`${base}/generation-batches/${batch3Info.id}`);
      b3 = await res.json();
      if (!['running'].includes(b3.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(b3.status, 'ready');

    const prev3Res = await req(`${base}/generation-batches/${b3.id}/candidates/${b3.candidates[0].id}/preview`, 'POST', {
      revision: docV3.revision,
    });
    assert.equal(prev3Res.status, 200);
    const prev3 = await prev3Res.json();

    const legApplyRes = await req(`${base}/apply-proposal`, 'POST', {
      revision: docV3.revision,
      proposalId: prev3.proposalId,
      variantId: prev3.selectedVariantId,
    });
    assert.equal(legApplyRes.status, 200);
    const legSavedDoc = await legApplyRes.json();
    assert.equal(legSavedDoc.revision, docV3.revision + 1);
    assert.equal(legSavedDoc.assets.length, 4);
    assert.ok(legSavedDoc.assets[3].provenance?.batch);
    assert.equal(legSavedDoc.studio?.library?.[legSavedDoc.assets[3].id], undefined);

    // 11. History restore deliberately tested separately
    const historyList = await (await req(`${base}/history`)).json();
    assert.ok(historyList.length > 0);
    const restoreRes = await req(`${base}/history`, 'POST', {
      revision: legSavedDoc.revision,
      snapshot: historyList[0].id,
    });
    assert.equal(restoreRes.status, 200);
    const restored = await restoreRes.json();
    assert.equal(restored.revision, legSavedDoc.revision + 1);
  } finally {
    await app.close();
  }
});
