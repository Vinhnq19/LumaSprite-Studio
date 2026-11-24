import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { prepareRigDraftSource } from '../src/node/studio/rig-source.ts';
import { prepareRigDraftRefresh } from '../src/node/studio/rig-refresh.ts';
import { celFor, composite, newLayer, wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';

test('Rig refresh HTTP: worker snapshots saved layers; revision/Origin/authority guarded; restart preserves exact parts and original source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-refresh-api-'));
  let server: Awaited<ReturnType<typeof serveStudio>> | undefined;
  try {
    const store = new PixelStore(root), original = store.create('Nguồn HTTP refresh', 18, 18, 0x70c989ff);
    server = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio') });
    const origin = server.url.slice(0, -1), prefix = `/api/pixel/projects/${original.id}`;
    const call = async (suffix: string, data: unknown, expected = 200, method = 'POST', requestOrigin = origin) => {
      const response = await fetch(origin + prefix + suffix, { method, headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: wireStringify(data) });
      const result = wireParse(await response.text()); assert.equal(response.status, expected, JSON.stringify(result)); return result;
    };
    const created = await call('/rig-drafts', { revision: original.revision, assetId: original.assets[0].id, frameId: original.assets[0].frames[0].id }, 201);
    const path = `/rig-drafts/${created.draft.id}/refresh`, layerId = created.document.assets[1].layers[0].id;
    const request = { revision: created.document.revision, parts: [{ layerId, origin: 'visible', pivot: { x: 9, y: 18 } }] };
    await call(path, request, 403, 'POST', 'https://foreign.invalid');
    await call(path, { ...request, draftId: created.draft.id }, 400);
    await call(path, { ...request, revision: request.revision - 1 }, 409);
    await call(path + '/ignored', request, 404);
    const refreshed = await call(path, request);
    assert.equal(refreshed.document.revision, request.revision + 1); assert.equal(refreshed.draft.id, created.draft.id);
    assert.notEqual(refreshed.draft.resources.sources[0].resourceId, created.draft.resources.sources[0].resourceId);
    assert.deepEqual(refreshed.draft.plan, created.draft.plan); assert.deepEqual(refreshed.document.assets[0], created.document.assets[0]);
    assert.deepEqual(refreshed.document.studio.quality.approvals, {});
    await call('/quality-runs', { revision: refreshed.document.revision, approvalId: refreshed.draft.id, prompt: 'Not approved' }, 409);
    const edited = structuredClone(refreshed.document); edited.assets[1].layers[0].opacity = 128;
    const saved = await call('', { revision: edited.revision, document: edited }, 200, 'PUT');
    const manifest = readFileSync(join(store.dir(original.id), 'pxl.project.json'));
    await call(path, { ...request, revision: saved.revision }, 422);
    assert.deepEqual(readFileSync(join(store.dir(original.id), 'pxl.project.json')), manifest);
    await server.close(); server = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio') });
    const reopened = wireParse(await (await fetch(server.url + prefix.slice(1))).text());
    assert.equal(reopened.studio.rigDrafts[created.draft.id].rig.source.revision, refreshed.document.revision);
    const doc = store.load(original.id, true); assert.ok(composite(doc.assets[0], doc.assets[0].frames[0].id).data.every(c => c === 0x70c989ff));
    assert.ok(store.history(original.id).some(h => h.label.includes('bộ phận rig')));
  } finally { await server?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Rig refresh: splits source cel into 2 visible layers, refreshes non-approved draft with fresh sources, stable IDs, retained graph/timing, and new part placeholder', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-refresh-'));
  try {
    const store = new PixelStore(root);
    let doc = store.create('Nguồn vẽ refresh', 18, 18, 0x70c989ff);
    const a = doc.assets[0];
    a.frames.push({ id: 'frame-selected', duration: 150 });
    celFor(a, a.layers[0].id, 'frame-selected', true)!.data!.fill(0xffffffff);
    a.metadata = { pivot: { x: 0.25, y: 0.75 } };
    doc = store.save(doc.id, doc.revision, doc);

    // Initial draft from rig source
    const { document: d1, draft: draft1 } = prepareRigDraftSource(store, doc, {
      revision: doc.revision,
      assetId: a.id,
      frameId: 'frame-selected',
    });
    const initialResourceId = draft1.resources.sources[0].resourceId;
    const initialResourceData = d1.studio!.resources![initialResourceId].data!.slice();
    doc = store.saveQuality(d1.id, d1.revision, d1, 'Lưu nháp rig ban đầu');
    store.hydrate(doc);

    const working = doc.assets[1];
    const initialLayer = working.layers[0];

    // Split cel into 2 visible image layers preserving composite
    const l2 = newLayer('Layer Thân dưới', 'image');
    working.layers.push(l2);
    const cel0 = celFor(working, initialLayer.id, working.frames[0].id)!;
    const cel1 = celFor(working, l2.id, working.frames[0].id, true)!;
    const half = 9 * 18;
    for (let i = 0; i < half; i++) {
      cel1.data![i] = 0;
    }
    for (let i = half; i < 18 * 18; i++) {
      cel1.data![i] = cel0.data![i];
      cel0.data![i] = 0;
    }
    // Verify composite is preserved
    assert.ok(composite(working, working.frames[0].id).data.every(c => c === 0xffffffff));

    doc = store.save(doc.id, doc.revision, doc);
    const manifestPath = join(store.dir(doc.id), 'pxl.project.json');
    const beforeManifest = readFileSync(manifestPath);

    // Refresh draft
    const partsInput = [
      { layerId: initialLayer.id, origin: 'visible' as const, pivot: { x: 4.5, y: 13.5 } },
      { layerId: l2.id, origin: 'authored' as const, pivot: { x: 9, y: 9 } },
    ];
    const { document: refreshedDoc, draft: refreshedDraft } = prepareRigDraftRefresh(store, doc, {
      revision: doc.revision,
      draftId: draft1.id,
      parts: partsInput,
    });

    // Caller is not committed yet (no disk write in helper)
    assert.deepEqual(readFileSync(manifestPath), beforeManifest);
    assert.equal(refreshedDraft.id, draft1.id);
    assert.equal(refreshedDraft.recipe.parts.length, 2);

    // Stable part IDs and names from current layers
    assert.equal(refreshedDraft.recipe.parts[0].id, initialLayer.id);
    assert.equal(refreshedDraft.recipe.parts[0].name, initialLayer.name);
    assert.equal(refreshedDraft.recipe.parts[0].parentId, null);
    assert.deepEqual(refreshedDraft.recipe.parts[0].pivot, { x: 4.5, y: 13.5 });
    assert.equal(refreshedDraft.recipe.parts[0].origin, 'visible');

    assert.equal(refreshedDraft.recipe.parts[1].id, l2.id);
    assert.equal(refreshedDraft.recipe.parts[1].name, l2.name);
    assert.equal(refreshedDraft.recipe.parts[1].parentId, null);
    assert.deepEqual(refreshedDraft.recipe.parts[1].pivot, { x: 9, y: 9 });
    assert.equal(refreshedDraft.recipe.parts[1].origin, 'authored');

    // Fresh source resource IDs starting with rigp_
    assert.ok(refreshedDraft.resources.sources[0].resourceId.startsWith('rigp_'));
    assert.ok(refreshedDraft.resources.sources[1].resourceId.startsWith('rigp_'));
    assert.equal(refreshedDraft.resources.sources[0].id, 'pixels_' + initialLayer.id);
    assert.equal(refreshedDraft.resources.sources[1].id, 'pixels_' + l2.id);

    // Old resource is preserved intact, not mutated
    assert.deepEqual(refreshedDoc.studio!.resources![initialResourceId].blob, doc.studio!.resources![initialResourceId].blob);
    assert.deepEqual(store.resource(doc.id, initialResourceId).data, initialResourceData);

    // Retained graph & timing
    assert.deepEqual(refreshedDraft.rig.joints, draft1.rig.joints);
    assert.deepEqual(refreshedDraft.recipe.frames.map(f => f.durationMs), draft1.recipe.frames.map(f => f.durationMs));
    assert.deepEqual(refreshedDraft.plan.frames.map(f => f.durationMs), draft1.plan.frames.map(f => f.durationMs));

    // Bindings: retained part preserves joint/socket, new part binds to root as placeholder
    const rootJointId = draft1.rig.joints.find(j => j.parentId === null)!.id;
    assert.deepEqual(refreshedDraft.rig.bindings, [
      { partId: initialLayer.id, jointId: rootJointId, socketId: null },
      { partId: l2.id, jointId: rootJointId, socketId: null },
    ]);

    // Plan order: surviving part retained, new part appended in layer order
    assert.deepEqual(refreshedDraft.plan.frames[0].order, [initialLayer.id, l2.id]);

    // Exact rest composite rendering
    const renderer = createRecipeRenderer(refreshedDraft.recipe, {
      sources: refreshedDraft.resources.sources.map(s => {
        const r = refreshedDoc.studio!.resources![s.resourceId];
        return { id: s.id, w: r.w, h: r.h, pixels: r.data! };
      }),
      masks: [],
    });
    const rendered = renderer.renderFrame(refreshedDraft.recipe.frames[0].id);
    assert.deepEqual(rendered.image.data, composite(working, working.frames[0].id).data);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rig refresh: deleted part cleanup, preserved custom occlusion order, nested groups opacity 255, and hidden layers ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-refresh-'));
  try {
    const store = new PixelStore(root);
    let doc = store.create('Nguồn phức hợp', 18, 18, 0x70c989ff);
    doc = store.save(doc.id, doc.revision, doc);
    const a = doc.assets[0];
    const { document: d1, draft: draft1 } = prepareRigDraftSource(store, doc, {
      revision: doc.revision,
      assetId: a.id,
      frameId: a.frames[0].id,
    });
    doc = store.saveQuality(d1.id, d1.revision, d1, 'Lưu nháp rig phức hợp');

    // First split into 2 layers and refresh to have 2 parts in draft
    const working = doc.assets[1];
    const l1 = working.layers[0];
    const l2 = newLayer('Layer 2', 'image');
    working.layers.push(l2);
    celFor(working, l2.id, working.frames[0].id, true)!.data!.fill(0x70c989ff);
    doc = store.save(doc.id, doc.revision, doc);

    const { document: d2, draft: draftWith2Parts } = prepareRigDraftRefresh(store, doc, {
      revision: doc.revision,
      draftId: draft1.id,
      parts: [
        { layerId: l1.id, origin: 'visible', pivot: { x: 4.5, y: 13.5 } },
        { layerId: l2.id, origin: 'authored', pivot: { x: 0, y: 0 } },
      ],
    });
    // Set custom occlusion order: l2 in front of l1
    draftWith2Parts.plan.frames[0].order = [l2.id, l1.id];
    d2.studio!.rigDrafts![draft1.id] = draftWith2Parts;
    doc = store.save(d2.id, d2.revision, d2);

    // Now delete l2 from working layers, add nested group with image layer, and a hidden layer
    doc.assets[1].layers = doc.assets[1].layers.filter(l => l.id !== l2.id);

    const group = newLayer('Group Thân', 'group');
    group.opacity = 255;
    doc.assets[1].layers.push(group);

    const lNested = newLayer('Layer Trong Group', 'image', group.id);
    lNested.opacity = 255;
    doc.assets[1].layers.push(lNested);
    celFor(doc.assets[1], lNested.id, doc.assets[1].frames[0].id, true)!.data!.fill(0x70c989ff);

    const lHidden = newLayer('Layer Bị Ẩn', 'image');
    lHidden.visible = false;
    doc.assets[1].layers.push(lHidden);
    celFor(doc.assets[1], lHidden.id, doc.assets[1].frames[0].id, true)!.data!.fill(0x70c989ff);

    doc = store.save(doc.id, doc.revision, doc);

    // Call refresh: only visible image layers in composite order: l1, lNested
    const { draft: refreshedDraft } = prepareRigDraftRefresh(store, doc, {
      revision: doc.revision,
      draftId: draft1.id,
      parts: [
        { layerId: l1.id, origin: 'visible', pivot: { x: 4.5, y: 13.5 } },
        { layerId: lNested.id, origin: 'derived', pivot: { x: 9, y: 9 } },
      ],
    });

    // Deleted l2 removed from bindings; surviving l1 retained; lNested bound to root
    const rootJointId = draft1.rig.joints.find(j => j.parentId === null)!.id;
    assert.deepEqual(refreshedDraft.rig.bindings, [
      { partId: l1.id, jointId: rootJointId, socketId: null },
      { partId: lNested.id, jointId: rootJointId, socketId: null },
    ]);

    // Custom occlusion order preserved: l2 removed, surviving l1 retained, lNested appended
    assert.deepEqual(refreshedDraft.plan.frames[0].order, [l1.id, lNested.id]);
    assert.equal(refreshedDraft.recipe.parts.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rig refresh: changed palette append remaps materials without altering timing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-refresh-'));
  try {
    const store = new PixelStore(root);
    let doc = store.create('Nguồn palette', 18, 18, 0x70c989ff);
    doc = store.save(doc.id, doc.revision, doc);
    const a = doc.assets[0];
    const { document: d1, draft: draft1 } = prepareRigDraftSource(store, doc, {
      revision: doc.revision,
      assetId: a.id,
      frameId: a.frames[0].id,
    });

    // Color index of 0x70c989ff in draft1.recipe.palette
    const targetColorIndex = draft1.recipe.palette.indexOf(0x70c989ff);
    assert.ok(targetColorIndex >= 0);

    // Add material referencing this color index
    draft1.recipe.materials = [{ id: 'mat-body', name: 'Thân', colors: [targetColorIndex] }];
    draft1.recipe.parts[0].materialIds = ['mat-body'];
    d1.studio!.rigDrafts![draft1.id] = draft1;
    doc = store.saveQuality(d1.id, d1.revision, d1, 'Lưu nháp kèm vật liệu');

    const working = doc.assets[1];
    // Prepend a new unique opaque color to palette: all colors shift by 1
    working.palette = [0x112233ff, ...working.palette];
    doc = store.save(doc.id, doc.revision, doc);

    const { draft: refreshedDraft } = prepareRigDraftRefresh(store, doc, {
      revision: doc.revision,
      draftId: draft1.id,
      parts: [{ layerId: working.layers[0].id, origin: 'visible', pivot: { x: 4.5, y: 13.5 } }],
    });

    // Color index remapped from targetColorIndex to targetColorIndex + 1
    assert.deepEqual(refreshedDraft.recipe.materials, [{ id: 'mat-body', name: 'Thân', colors: [targetColorIndex + 1] }]);
    assert.deepEqual(refreshedDraft.recipe.parts[0].materialIds, ['mat-body']);
    // Timing preserved
    assert.deepEqual(refreshedDraft.plan.frames.map(f => f.durationMs), draft1.plan.frames.map(f => f.durationMs));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rig refresh: comprehensive rejections leave doc and manifest untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-refresh-'));
  try {
    const store = new PixelStore(root);
    let doc = store.create('Nguồn kiểm tra lỗi', 18, 18, 0x70c989ff);
    doc = store.save(doc.id, doc.revision, doc);
    const a = doc.assets[0];
    const { document: d1, draft: draft1 } = prepareRigDraftSource(store, doc, {
      revision: doc.revision,
      assetId: a.id,
      frameId: a.frames[0].id,
    });
    doc = store.saveQuality(d1.id, d1.revision, d1, 'Lưu nháp rig kiểm tra lỗi');

    const working = doc.assets[1];
    const manifestPath = join(store.dir(doc.id), 'pxl.project.json');
    let beforeBytes = readFileSync(manifestPath);
    store.hydrate(doc);
    const snapshotDoc = structuredClone(doc);
    const saveFixture = (value: typeof doc) => {
      value.revision = store.load(doc.id).revision;
      const saved = store.save(value.id, value.revision, value);
      beforeBytes = readFileSync(manifestPath);
      return saved;
    };

    const validParts = [{ layerId: working.layers[0].id, origin: 'visible' as const, pivot: { x: 4.5, y: 13.5 } }];

    // 1. Stale revision
    assert.throws(
      () => prepareRigDraftRefresh(store, doc, { revision: doc.revision - 1, draftId: draft1.id, parts: validParts }),
      /Revision/,
    );
    assert.deepEqual(doc, snapshotDoc);
    assert.deepEqual(readFileSync(manifestPath), beforeBytes);

    // 2. Layer opacity !== 255
    const dOpacity = structuredClone(doc);
    dOpacity.assets[1].layers[0].opacity = 200;
    assert.throws(
      () => prepareRigDraftRefresh(store, dOpacity, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /opacity/,
    );

    // 3. Group opacity !== 255
    const dGroup = structuredClone(doc);
    const grp = newLayer('Group', 'group');
    grp.opacity = 180;
    dGroup.assets[1].layers.push(grp);
    dGroup.assets[1].layers[0].parent = grp.id;
    assert.throws(
      () => prepareRigDraftRefresh(store, dGroup, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /opacity/,
    );

    // 4. Partial alpha in cel
    store.hydrate(doc);
    let dAlpha = structuredClone(doc);
    celFor(dAlpha.assets[1], dAlpha.assets[1].layers[0].id, dAlpha.assets[1].frames[0].id)!.data![0] = 0x70c98980;
    dAlpha = saveFixture(dAlpha);
    assert.throws(
      () => prepareRigDraftRefresh(store, dAlpha, { revision: dAlpha.revision, draftId: draft1.id, parts: validParts }),
      /Chuẩn hóa/,
    );

    // 5. Pixel not in palette
    let dPalette = structuredClone(doc);
    celFor(dPalette.assets[1], dPalette.assets[1].layers[0].id, dPalette.assets[1].frames[0].id)!.data![0] = 0x123456ff;
    dPalette = saveFixture(dPalette);
    assert.throws(
      () => prepareRigDraftRefresh(store, dPalette, { revision: dPalette.revision, draftId: draft1.id, parts: validParts }),
      /Chuẩn hóa/,
    );

    // 6. Material color missing from palette
    let dWithMat = structuredClone(doc);
    dWithMat.studio!.rigDrafts![draft1.id].recipe.materials = [{ id: 'm-lost', name: 'Mất màu', colors: [0] }];
    dWithMat.assets[1].palette = [0x999999ff]; // old color removed
    celFor(dWithMat.assets[1], working.layers[0].id, working.frames[0].id)!.data!.fill(0x999999ff);
    dWithMat = saveFixture(dWithMat);
    assert.throws(
      () => prepareRigDraftRefresh(store, dWithMat, { revision: dWithMat.revision, draftId: draft1.id, parts: validParts }),
      /không còn trong palette mới/,
    );

    // 7. Canvas dimension changed
    const dDim = structuredClone(doc);
    dDim.assets[1].w = 24;
    assert.throws(
      () => prepareRigDraftRefresh(store, dDim, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /Kích thước canvas đã đổi/,
    );

    // 8. Missing mask resource
    const dMask = structuredClone(doc);
    dMask.studio!.rigDrafts![draft1.id].resources.masks = [{ id: 'mask-missing', resourceId: 'nonexistent-res' }];
    assert.throws(
      () => prepareRigDraftRefresh(store, dMask, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /thiếu tài nguyên đúng loại|Thiếu tài nguyên mask/,
    );

    // 9. Missing frozen frame
    const dWithFrozen = structuredClone(doc);
    dWithFrozen.studio!.rigDrafts![draft1.id].frozenFrames = [{ frameId: 'f1', sourceFrameId: 'nonexistent-frame' }];
    assert.throws(
      () => prepareRigDraftRefresh(store, dWithFrozen, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /không còn tồn tại/,
    );

    // 10. Missing layer reference in parts
    assert.throws(
      () => prepareRigDraftRefresh(store, doc, { revision: doc.revision, draftId: draft1.id, parts: [] }),
      /phải là mảng từ 1 đến 64/,
    );

    // 11. Duplicate layer reference in parts
    assert.throws(
      () => prepareRigDraftRefresh(store, doc, {
        revision: doc.revision,
        draftId: draft1.id,
        parts: [validParts[0], validParts[0]],
      }),
      /trùng/,
    );

    // 12. Hidden layer included in parts
    const dHidden = structuredClone(doc);
    const hiddenL = newLayer('Hidden', 'image');
    hiddenL.visible = false;
    dHidden.assets[1].layers.push(hiddenL);
    assert.throws(
      () => prepareRigDraftRefresh(store, dHidden, {
        revision: doc.revision,
        draftId: draft1.id,
        parts: [...validParts, { layerId: hiddenL.id, origin: 'authored', pivot: { x: 0, y: 0 } }],
      }),
      /không hợp lệ|không khớp/,
    );

    // 13. Nonexistent / extra layer reference in parts
    assert.throws(
      () => prepareRigDraftRefresh(store, doc, {
        revision: doc.revision,
        draftId: draft1.id,
        parts: [...validParts, { layerId: 'completely-fake', origin: 'authored', pivot: { x: 0, y: 0 } }],
      }),
      /không hợp lệ|không khớp/,
    );

    // 14. Getters rejected
    const getterReq = { draftId: draft1.id, parts: validParts };
    Object.defineProperty(getterReq, 'revision', { get() { return doc.revision; }, enumerable: true });
    assert.throws(() => prepareRigDraftRefresh(store, doc, getterReq), /thuộc tính thiếu hoặc không được hỗ trợ/);

    const getterPart = { layerId: working.layers[0].id, origin: 'visible' as const };
    Object.defineProperty(getterPart, 'pivot', { get() { return { x: 0, y: 0 }; }, enumerable: true });
    assert.throws(
      () => prepareRigDraftRefresh(store, doc, { revision: doc.revision, draftId: draft1.id, parts: [getterPart] }),
      /thuộc tính thiếu hoặc không được hỗ trợ/,
    );

    // 15. Existing recipe with nonempty poses rejected
    const dWithPoses = structuredClone(doc);
    dWithPoses.studio!.rigDrafts![draft1.id].recipe.frames[0].poses = [
      { partId: working.layers[0].id, dx: 0, dy: 0, rotation: 0, z: 0, visible: true },
    ];
    assert.throws(
      () => prepareRigDraftRefresh(store, dWithPoses, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /đã có pose trong frame/,
    );

    // 16. Existing recipe with hierarchical parts rejected
    const dWithHierarchy = structuredClone(doc);
    dWithHierarchy.studio!.rigDrafts![draft1.id].recipe.parts[0].parentId = 'root-part';
    assert.throws(
      () => prepareRigDraftRefresh(store, dWithHierarchy, { revision: doc.revision, draftId: draft1.id, parts: validParts }),
      /cấu trúc phân cấp bộ phận/,
    );

    // Final check: manifest on disk and doc unchanged
    assert.deepEqual(doc, snapshotDoc);
    assert.deepEqual(readFileSync(manifestPath), beforeBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
