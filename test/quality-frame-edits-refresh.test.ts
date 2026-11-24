import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { prepareRigDraftSource } from '../src/node/studio/rig-source.ts';
import { prepareRigDraftRefresh } from '../src/node/studio/rig-refresh.ts';
import { StudioError } from '../src/node/studio/store.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { newLayer, celFor } from '../src/studio/pixel/model.ts';

test('rig draft refresh refuses frame pixel edits with a 422 before hydrating', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-frame-refresh-'));
  try {
    const store = new PixelStore(root);
    const original = store.load(store.create('Test', 16, 16, 0x70c989ff).id);
    const source = prepareRigDraftSource(store, original, {
      revision: original.revision,
      assetId: original.assets[0]!.id,
      frameId: original.assets[0]!.frames[0]!.id,
    });
    const doc = store.saveQuality(
      source.document.id,
      source.document.revision,
      source.document,
      'Test',
    );
    store.hydrate(doc);
    const draft = doc.studio!.rigDrafts![source.draft.id]!;
    draft.recipe.frames[0]!.pixelEdits = [{ x: 0, y: 0, color: 0 }];
    const before = structuredClone(doc);
    const manifestPath = join(store.dir(doc.id), 'pxl.project.json');
    const bytes = readFileSync(manifestPath);

    const request = {
      revision: doc.revision,
      draftId: draft.id,
      parts: [
        {
          layerId: doc.assets[1]!.layers[0]!.id,
          origin: 'visible' as const,
          pivot: { ...draft.recipe.parts[0]!.pivot },
        },
      ],
    };

    let hydrated = false;
    (store as { hydrate: typeof store.hydrate }).hydrate = () => {
      hydrated = true;
      throw new Error('Unexpected hydrate');
    };

    assert.throws(
      () => prepareRigDraftRefresh(store, doc, request),
      (error: unknown) =>
        error instanceof StudioError &&
        error.status === 422 &&
        error.message.includes('nét chỉnh'),
    );
    assert.equal(hydrated, false);
    assert.deepEqual(doc, before);
    assert.deepEqual(readFileSync(manifestPath), bytes);
  } finally {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('rig draft refresh preserves frame contact socket/target without mutating input doc or manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-frame-refresh-'));
  try {
    const store = new PixelStore(root);
    const original = store.load(store.create('Test', 16, 16, 0x70c989ff).id);
    const source = prepareRigDraftSource(store, original, {
      revision: original.revision,
      assetId: original.assets[0]!.id,
      frameId: original.assets[0]!.frames[0]!.id,
    });
    let doc = store.saveQuality(
      source.document.id,
      source.document.revision,
      source.document,
      'Test',
    );
    store.hydrate(doc);
    const working = doc.assets[1]!;
    for (const name of ['Khớp giữa', 'Khớp cuối']) {
      const layer = newLayer(name);
      working.layers.push(layer);
      celFor(working, layer.id, working.frames[0]!.id, true)!.data!.fill(0x70c989ff);
    }
    doc = store.save(doc.id, doc.revision, doc);
    store.hydrate(doc);
    const draft = doc.studio!.rigDrafts![source.draft.id]!;
    const template = structuredClone(draft.recipe.parts[0]!);
    draft.recipe.parts = doc.assets[1]!.layers.map(layer => ({
      ...structuredClone(template), id: layer.id, name: layer.name,
    }));
    const m = motionFixture();
    draft.rig.joints = m.rig.joints;
    draft.rig.sockets = m.rig.sockets;
    draft.rig.chains = m.rig.chains.map(c => ({ ...c, kind: 'leg' as const }));
    draft.rig.bindings = doc.assets[1]!.layers.map((layer, i) => ({
      partId: layer.id, jointId: ['shoulder', 'elbow', 'wrist'][i]!, socketId: null,
    }));
    for (const frame of draft.plan.frames) frame.order = draft.recipe.parts.map(part => part.id);
    const contact = {
      chainId: 'arm',
      phase: 'stance' as const,
      target: { x: 9, y: 4 },
      contactSocketId: 'grip',
    };
    draft.plan.frames[0]!.contacts = [contact];
    const before = structuredClone(doc);
    const manifestPath = join(store.dir(doc.id), 'pxl.project.json');
    const bytes = readFileSync(manifestPath);

    const request = {
      revision: doc.revision,
      draftId: draft.id,
      parts: doc.assets[1]!.layers.map(layer => ({
        layerId: layer.id, origin: 'visible' as const, pivot: { ...template.pivot },
      })),
    };

    const { draft: refreshed } = prepareRigDraftRefresh(store, doc, request);
    const returned = refreshed.plan.frames[0]!.contacts[0]!;
    assert.deepEqual(returned, contact);
    assert.equal(Object.hasOwn(returned, 'contactSocketId'), true);
    assert.equal(returned.contactSocketId, 'grip');
    assert.ok(returned.target);
    assert.notEqual(returned.target, contact.target);
    returned.target!.x = 1;
    assert.deepEqual(doc, before);
    assert.deepEqual(readFileSync(manifestPath), bytes);
    assert.deepEqual(doc.studio!.quality!.approvals, {});
  } finally {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
