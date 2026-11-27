import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { decodePng } from '../src/node/studio/png.ts';
import {
  exportNativeScenePackage,
  importNativeSceneFromDirectory,
  importNativeSceneFromFiles,
  loadNativeSceneBuffers,
  validateUnityE8SceneData,
} from '../src/node/studio/native-scene-io.ts';
import { computeWalkableRoute, fitsWalkable } from '../src/studio/native-scene.ts';
import { compareRgbaExact, renderNativeScene } from '../src/studio/native-scene-render.ts';
import { emptyProduction } from '../src/studio/production.ts';
import { wireParse, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';
import { unzipTestStored } from './fixtures/image-assertions.ts';

const ENGINE_E8_ROOT = 'D:\\LumaSprite-Engine\\.cache\\e8-adapter-1';
const ENGINE_E76R_ROOT = 'D:\\LumaSprite-Engine\\benchmarks\\results\\e76r';
const SCENES = ['mistfen-ferry-landing', 'floodgate-maintenance-yard', 'canal-intake-service-platform'] as const;
const LIGHTS = ['day', 'night'] as const;

function hasRealFixtures(): boolean {
  return existsSync(join(ENGINE_E8_ROOT, 'bundle.json')) && existsSync(ENGINE_E76R_ROOT);
}

test('E8.4 Positive & RGBA Parity: import all 3 locked B2 scenes (Day & Night) in both E8 and E7.6R formats without flattening or losing metadata', { skip: !hasRealFixtures() }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-e84-pos-'));
  try {
    const store = new PixelStore(root);
    let doc = store.create('E8.4 Positive Parity', 32, 32);

    for (const sceneKey of SCENES) {
      for (const light of LIGHTS) {
        const e8Dir = join(ENGINE_E8_ROOT, sceneKey, light);
        const importedE8 = importNativeSceneFromDirectory(e8Dir);
        const rec = importedE8.record;
        const snap = rec.engineSnapshot;

        assert.equal(snap.packageFormat, 'e8-runtime');
        assert.equal(snap.sceneKey, sceneKey);
        assert.equal(snap.light, light);
        assert.equal(snap.width, 320);
        assert.equal(snap.height, 208);
        assert.equal(snap.pixelsPerUnit, 32);
        assert.deepEqual(snap.origin, [0, 0]);
        assert.equal(snap.tilemap.ids.length, 260);
        assert.ok(snap.collisionBoxes.length > 0);
        assert.equal(snap.walkableRows.length, 208);
        assert.ok(snap.interactions.length >= 1);
        assert.equal(rec.studioState.approval.status, 'UNREVIEWED');
        assert.equal(rec.studioState.revision, 1);
        assert.ok(snap.provenance.sourceSha256.length === 64);

        const nextDoc = structuredClone(doc);
        nextDoc.studio ??= { version: 1 };
        nextDoc.studio.resources ??= {};
        nextDoc.studio.production ??= emptyProduction();
        nextDoc.studio.production.nativeScenes ??= [];
        const resStore = store.resourceStore(doc.id);
        for (const [resId, res] of Object.entries(importedE8.resources)) {
          nextDoc.studio.resources[resId] = resStore.put(res);
        }
        nextDoc.studio.production.nativeScenes.push(rec);
        doc = store.saveNativeScene(doc.id, doc.revision, nextDoc, `Import ${rec.id}`);

        const buffers = loadNativeSceneBuffers(store, doc, rec);
        const compositeImg = renderNativeScene(rec, buffers, { mode: 'composite', applyOverrides: false });
        const expectedPng = decodePng(readFileSync(join(ENGINE_E76R_ROOT, sceneKey, 'b2', `${light}.png`)));
        const diff = compareRgbaExact(compositeImg.data, expectedPng.data);
        assert.equal(diff.diffPixels, 0, `${sceneKey}/${light} E8 RGBA mismatch at ${diff.firstDiffIndex}`);

        const e76rDir = join(ENGINE_E76R_ROOT, sceneKey, 'b2');
        const imported76 = importNativeSceneFromDirectory(e76rDir, { light, sceneId: `e76r-${sceneKey}-${light}` });
        assert.equal(imported76.record.engineSnapshot.packageFormat, 'e76r-b2');
        assert.ok(imported76.record.engineSnapshot.colliders.length > 0);
        assert.ok(imported76.record.engineSnapshot.styleRef?.sha256);
        assert.ok(imported76.record.engineSnapshot.profileRef?.sha256);
        assert.equal(imported76.record.studioState.approval.status, 'UNREVIEWED');
      }
    }

    const reopened = new PixelStore(root).load(doc.id);
    assert.equal(reopened.studio?.production?.nativeScenes?.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E8.4 Negative Contract Tests: all 10 invalid/tampered cases are rejected without writing corrupted state', { skip: !hasRealFixtures() }, () => {
  const work = mkdtempSync(join(tmpdir(), 'pxl-e84-neg-'));
  try {
    const baseDir = join(work, 'base-mistfen');
    cpSync(join(ENGINE_E8_ROOT, 'mistfen-ferry-landing', 'day'), baseDir, { recursive: true });
    const cloneCase = (name: string) => {
      const dir = join(work, name);
      cpSync(baseDir, dir, { recursive: true });
      return dir;
    };

    // 1. Missing atlas
    {
      const dir = cloneCase('missing-atlas');
      unlinkSync(join(dir, 'atlas.png'));
      assert.throws(() => importNativeSceneFromDirectory(dir), /BROKEN_REFERENCE|không tồn tại/i);
    }

    // 2. Missing / out-of-range tile ID
    {
      const dir = cloneCase('bad-tile-id');
      const s = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
      s.tiles.ids[0] = s.tiles.cellCount + 5;
      writeFileSync(join(dir, 'scene.json'), JSON.stringify(s));
      assert.throws(() => importNativeSceneFromDirectory(dir), /MISSING_TILE_ID|Tile ID/i);
    }

    // 3. Corrupted JSON
    {
      const dir = cloneCase('corrupt-json');
      writeFileSync(join(dir, 'scene.json'), '{"version": 1, "id": ');
      assert.throws(() => importNativeSceneFromDirectory(dir), /JSON bị hỏng|CORRUPTED_JSON/i);
    }

    // 4. Stale hash (flip 1 pixel in foreground or supply wrong expectedHashes)
    {
      const dir = cloneCase('stale-hash');
      assert.throws(
        () => importNativeSceneFromDirectory(dir, { expectedHashes: { 'scene.json': '0'.repeat(64) } }),
        /STALE_HASH/i,
      );
      const s = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
      s.source.rgba = 'f'.repeat(64);
      writeFileSync(join(dir, 'scene.json'), JSON.stringify(s));
      assert.throws(() => importNativeSceneFromDirectory(dir), /STALE_HASH/i);
    }

    // 5. Revision mismatch
    {
      assert.throws(
        () => importNativeSceneFromDirectory(baseDir, { expectedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        /REVISION_MISMATCH/i,
      );
    }

    // 6. Invalid interaction anchor (stand on non-walkable water or at out of bounds)
    {
      const dir = cloneCase('bad-anchor');
      const s = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
      s.landmark.stand = { x: 315, y: 205 }; // water, not walkable
      writeFileSync(join(dir, 'scene.json'), JSON.stringify(s));
      assert.throws(() => importNativeSceneFromDirectory(dir), /INVALID_INTERACTION_ANCHOR/i);
    }

    // 7. Broken reference (missing layer file + path traversal)
    {
      const dir = cloneCase('broken-ref');
      unlinkSync(join(dir, 'layer-surveyor.png'));
      assert.throws(() => importNativeSceneFromDirectory(dir), /BROKEN_REFERENCE|không tồn tại/i);

      const trav = cloneCase('traversal-ref');
      const s = JSON.parse(readFileSync(join(trav, 'scene.json'), 'utf8'));
      s.layers[0].texture = '../../etc/passwd';
      writeFileSync(join(trav, 'scene.json'), JSON.stringify(s));
      assert.throws(() => importNativeSceneFromDirectory(trav), /BROKEN_REFERENCE|thoát/i);
    }

    // 8. Invalid layer metadata (non-monotonic depth / wrong order / bad kind)
    {
      const dir = cloneCase('bad-layer');
      const s = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
      s.layers[1].order = 9;
      writeFileSync(join(dir, 'scene.json'), JSON.stringify(s));
      assert.throws(() => importNativeSceneFromDirectory(dir), /INVALID_LAYER_METADATA/i);
    }

    // 9. Unsupported schema version
    {
      const dir = cloneCase('bad-version');
      const s = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
      s.version = 2;
      writeFileSync(join(dir, 'scene.json'), JSON.stringify(s));
      assert.throws(() => importNativeSceneFromDirectory(dir), /UNSUPPORTED_SCHEMA_VERSION/i);
    }

    // 10. Attempted edit of protected Engine source in PixelStore
    {
      const storeRoot = join(work, 'store-protected');
      mkdirSync(storeRoot, { recursive: true });
      const store = new PixelStore(storeRoot);
      let doc = store.create('Protected Source Check', 32, 32);
      const imported = importNativeSceneFromDirectory(baseDir);
      const resStore = store.resourceStore(doc.id);
      const next = structuredClone(doc);
      next.studio ??= { version: 1 };
      next.studio.resources ??= {};
      next.studio.production ??= emptyProduction();
      next.studio.production.nativeScenes ??= [];
      for (const [k, v] of Object.entries(imported.resources)) next.studio.resources[k] = resStore.put(v);
      next.studio.production.nativeScenes.push(imported.record);
      doc = store.saveNativeScene(doc.id, doc.revision, next, 'Import protected base');

      const tampered = structuredClone(doc);
      tampered.studio!.production!.nativeScenes![0].engineSnapshot.tilemap.ids[0] ^= 1;
      assert.throws(
        () => store.save(doc.id, doc.revision, tampered, 'Illegal tamper'),
        (err: any) => err.diagnostic?.code === 'PROTECTED_ENGINE_SOURCE' || /PROTECTED_ENGINE_SOURCE/.test(err.message),
      );
      // Confirm on-disk project remained untouched
      assert.equal(store.load(doc.id).revision, doc.revision);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('E8.4 Round-Trip, Revision-Safe Edit, Source Revision Change Warning, Review Gate & Export -> Re-import', { skip: !hasRealFixtures() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-e84-rt-'));
  const work = mkdtempSync(join(tmpdir(), 'pxl-e84-rt-src-'));
  const app = await serveStudio(root, { port: 0 });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const store = new PixelStore(root);
  let doc = store.create('RoundTrip Mistfen', 32, 32);
  const origin = new URL(app.url).origin;
  const e8DayDir = join(ENGINE_E8_ROOT, 'mistfen-ferry-landing', 'day');

  // 1. Import via HTTP API
  const impRes = await fetch(`${app.url}api/pixel/projects/${doc.id}/native-scenes/import`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: doc.revision, sourceDir: e8DayDir }),
  });
  assert.equal(impRes.status, 201, await impRes.clone().text());
  const impJson = wireParse(await impRes.text());
  doc = impJson.document;
  const sceneId: string = impJson.sceneId;

  // 2. Verify UNREVIEWED blocks production-gated export while draft export succeeds
  const blockedExport = await fetch(`${app.url}api/pixel/projects/${doc.id}/native-scenes/${sceneId}/export`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: doc.revision, requireApproved: true }),
  });
  assert.equal(blockedExport.status, 409);

  // 3. Controlled Studio edit: valid walkable surveyor override + layer toggle + interaction label override
  const rec0 = doc.studio!.production!.nativeScenes![0];
  const candidateStand = rec0.engineSnapshot.interactions[0].stand!;
  const newActorPos = { x: candidateStand.x - 4, y: candidateStand.y };
  assert.ok(fitsWalkable(rec0.engineSnapshot, newActorPos));

  const edited = structuredClone(doc);
  const nsEdit = edited.studio!.production!.nativeScenes![0];
  nsEdit.studioState.revision += 1;
  nsEdit.studioState.actorOverrides.surveyor = { x: newActorPos.x, y: newActorPos.y };
  nsEdit.studioState.layerVisibility['supply-barrel'] = false;
  nsEdit.studioState.interactionOverrides['primary-landmark'] = {
    label: 'Bến phà Mistfen — Kiểm tra',
    linkedEntityId: 'mooring-2',
    stand: candidateStand,
    note: 'Xác nhận điểm đứng B2',
  };
  const saveRes = await fetch(`${app.url}api/pixel/projects/${doc.id}`, {
    method: 'PUT',
    headers: { origin, 'content-type': 'application/json' },
    body: wireStringify({ revision: doc.revision, document: edited, snapshot: true }),
  });
  assert.equal(saveRes.status, 200, await saveRes.clone().text());
  doc = wireParse(await saveRes.text());

  // 4. Close & Reopen from fresh PixelStore — zero loss check
  const reopened = new PixelStore(root).load(doc.id);
  const reRec = reopened.studio!.production!.nativeScenes![0];
  assert.equal(reRec.protectedSha256, rec0.protectedSha256);
  assert.deepEqual(reRec.studioState.actorOverrides.surveyor, newActorPos);
  assert.equal(reRec.studioState.layerVisibility['supply-barrel'], false);
  assert.equal(reRec.studioState.interactionOverrides['primary-landmark'].label, 'Bến phà Mistfen — Kiểm tra');
  assert.equal(reRec.engineSnapshot.tilemap.ids.length, 260);
  assert.deepEqual(reRec.engineSnapshot.spawn, rec0.engineSnapshot.spawn);

  // 5. Undo via PixelStore.restore & verify rollback
  const hist = store.history(doc.id);
  const beforeEditSnap = hist.find(h => h.label === 'Trước khi lưu thủ công');
  assert.ok(beforeEditSnap);
  const restored = store.restore(doc.id, doc.revision, beforeEditSnap.id);
  assert.deepEqual(restored.studio!.production!.nativeScenes![0].studioState.actorOverrides, {});
  // Re-apply edit so export tests overrides too
  const reapplied = structuredClone(restored);
  reapplied.studio!.production!.nativeScenes![0].studioState = reRec.studioState;
  doc = store.save(restored.id, restored.revision, reapplied, 'Reapply override');

  // 6. Explicit human review -> APPROVED -> Export ZIP
  const revRes = await fetch(`${app.url}api/pixel/projects/${doc.id}/native-scenes/${sceneId}/review`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: doc.revision, status: 'APPROVED', note: 'QA verified B2 Mistfen' }),
  });
  assert.equal(revRes.status, 200);
  doc = wireParse(await revRes.text()).document;
  assert.equal(doc.studio!.production!.nativeScenes![0].studioState.approval.status, 'APPROVED');

  const expRes = await fetch(`${app.url}api/pixel/projects/${doc.id}/native-scenes/${sceneId}/export`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: doc.revision, requireApproved: true }),
  });
  assert.equal(expRes.status, 200);
  const zipBuf = Buffer.from(await expRes.arrayBuffer());
  const files = unzipTestStored(zipBuf);
  const expScene = JSON.parse(files['mistfen-ferry-landing/day/scene.json'].toString('utf8'));
  const expSidecar = JSON.parse(files['studio-scene-sidecar.json'].toString('utf8'));
  const expManifest = JSON.parse(files['export-manifest.json'].toString('utf8'));

  // Validate against Unity E8Contract.cs exact validator
  assert.doesNotThrow(() => validateUnityE8SceneData(expScene));
  assert.deepEqual(expScene.spawn, newActorPos);
  assert.ok(expScene.route.length >= 2);
  assert.equal(expSidecar.unityCompatibility.directE8ImportCompatible, true);
  assert.equal(expManifest.approval.status, 'APPROVED');

  // Re-import exported package files cleanly into fresh Studio check
  const reimportFiles = Object.fromEntries(
    Object.entries(files).filter(([p]) => p.startsWith('mistfen-ferry-landing/day/')),
  );
  const reimported = importNativeSceneFromFiles(reimportFiles);
  assert.deepEqual(reimported.record.engineSnapshot.spawn, newActorPos);
  assert.equal(reimported.record.engineSnapshot.tilemap.ids.length, 260);
  assert.deepEqual(
    computeWalkableRoute(reimported.record.engineSnapshot, newActorPos, candidateStand),
    expScene.route,
  );

  // 7. Re-import with changed sourceRevision -> triggers SOURCE_REVISION_CHANGED warning + STALE approval
  const updatedSrc = join(work, 'mistfen-v2');
  cpSync(e8DayDir, updatedSrc, { recursive: true });
  const s2 = JSON.parse(readFileSync(join(updatedSrc, 'scene.json'), 'utf8'));
  s2.revision = '1111111111111111111111111111111111111111';
  writeFileSync(join(updatedSrc, 'scene.json'), JSON.stringify(s2));
  const upgradeRes = await fetch(`${app.url}api/pixel/projects/${doc.id}/native-scenes/import`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: doc.revision, sourceDir: updatedSrc }),
  });
  assert.equal(upgradeRes.status, 201, await upgradeRes.clone().text());
  const upgradeJson = wireParse(await upgradeRes.text());
  assert.ok(upgradeJson.warnings.some((w: string) => w.startsWith('SOURCE_REVISION_CHANGED:')));
  assert.equal(upgradeJson.document.studio.production.nativeScenes[0].studioState.approval.status, 'STALE');

  // Also test exportNativeScenePackage helper directly for E7.6R record
  const e76 = importNativeSceneFromDirectory(join(ENGINE_E76R_ROOT, 'floodgate-maintenance-yard', 'b2'), { light: 'day' });
  const d2 = store.create('E76R Export Check', 32, 32);
  const rs2 = store.resourceStore(d2.id);
  const n2 = structuredClone(d2);
  n2.studio = { version: 1, resources: {}, production: { ...emptyProduction(), nativeScenes: [e76.record] } };
  for (const [k, v] of Object.entries(e76.resources)) n2.studio.resources![k] = rs2.put(v);
  const saved2 = store.saveNativeScene(d2.id, d2.revision, n2, 'Import E76R Floodgate');
  const exp76 = exportNativeScenePackage(store, saved2, e76.record.id);
  const files76 = unzipTestStored(Buffer.from(exp76.data));
  assert.ok(files76['studio-scene-sidecar.json']);
  const e76Key = e76.record.engineSnapshot.sceneKey;
  assert.ok(files76[`${e76Key}/day/scene-day.json`]);
});
