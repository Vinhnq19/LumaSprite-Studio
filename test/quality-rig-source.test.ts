import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { prepareRigDraftSource } from '../src/node/studio/rig-source.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { celFor, composite, wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { qualitySourceWorker } from '../src/node/studio/quality-source-worker.ts';
import { deserialize } from 'node:v8';

test('Rig source: copies only the selected visible frame with native pixels/metadata, leaving original and manifest unchanged and approvals empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-source-'));
  try {
    const store = new PixelStore(root); let doc = store.create('Nguồn vẽ', 18, 18, 0x70c989ff), a = doc.assets[0];
    a.frames.push({ id: 'selected-frame', duration: 137 }); celFor(a, a.layers[0].id, 'selected-frame', true)!.data!.fill(0xffffffff);
    a.metadata = { pivot: { x: .25, y: .75 }, hitbox: { x: 1, y: 2, w: 3, h: 4 }, events: [{ frame: 0, name: 'old' }, { frame: 1, name: 'selected' }] };
    doc = store.save(doc.id, doc.revision, doc); const original = structuredClone(doc), path = join(store.dir(doc.id), 'pxl.project.json'), before = readFileSync(path);
    const { document: d, draft } = prepareRigDraftSource(store, doc, { revision: doc.revision, assetId: a.id, frameId: 'selected-frame' });
    assert.deepEqual(doc, original); assert.deepEqual(readFileSync(path), before); assert.equal(d.assets.length, 2);
    const working = d.assets[1]; assert.notEqual(working.id, a.id); assert.ok(composite(working, working.frames[0].id).data.every(c => c === 0xffffffff));
    assert.equal(working.frames[0].duration, 137); assert.deepEqual(working.metadata, { pivot: a.metadata.pivot, hitbox: a.metadata.hitbox, events: [{ frame: 0, name: 'selected' }] });
    assert.deepEqual(draft.origin, { assetId: a.id, frameId: 'selected-frame' }); assert.equal(draft.rig.source.assetId, working.id);
    assert.deepEqual(draft.recipe.pivot, { x: 4.5, y: 13.5 }); assert.deepEqual(draft.plan.frames.map(f => f.durationMs), [137, 137]);
    assert.deepEqual(d.studio!.quality!.approvals, {}); assert.deepEqual(d.studio!.rigDrafts![draft.id], draft);
    const mapping = draft.resources.sources[0], r = d.studio!.resources![mapping.resourceId];
    assert.deepEqual(createRecipeRenderer(draft.recipe, { sources: [{ id: mapping.id, w: r.w, h: r.h, pixels: r.data! }], masks: [] }).renderFrame(draft.recipe.frames[0].id).image.data, composite(working, working.frames[0].id).data);
    const legacy = qualitySourceWorker({ mode: 'quality-source', root, projectId: doc.id, revision: doc.revision, input: { revision: doc.revision, assetId: a.id, frameId: 'selected-frame', kind: 'static', sourceApproved: true } });
    assert.deepEqual(Object.keys(deserialize(Buffer.from(legacy.data))).sort(), ['approval', 'document'], 'approval worker must not duplicate the private RGBA context');
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Rig source: invalid/stale input and unnormalized alpha are refused without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-source-'));
  try {
    const store = new PixelStore(root), initial = store.create('Nguồn alpha', 18, 18, 0x70c98980), doc = store.load(initial.id), input = { revision: doc.revision, assetId: doc.assets[0].id, frameId: doc.assets[0].frames[0].id };
    assert.throws(() => prepareRigDraftSource(store, doc, { ...input, revision: 0 }), /Revision/);
    assert.throws(() => prepareRigDraftSource(store, doc, { ...input, sourceApproved: true }), /không hỗ trợ/);
    assert.throws(() => prepareRigDraftSource(store, doc, input), /Chuẩn hóa/); assert.equal(store.load(doc.id).revision, doc.revision);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Rig HTTP: creates a working copy without authority, saves/reopens editable draft with revision/history, rejects forged approval and preserves assets on delete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-rig-api-')); let app: Awaited<ReturnType<typeof serveStudio>> | undefined;
  try {
    const store = new PixelStore(root), doc = store.create('Nguồn HTTP', 18, 18, 0x70c989ff);
    app = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio') }); const origin = app.url.slice(0, -1), path = `/api/pixel/projects/${doc.id}`;
    const call = async (suffix: string, input: unknown, status = 200, method = 'POST', headerOrigin = origin) => {
      const r = await fetch(origin + path + suffix, { method, headers: { origin: headerOrigin, 'content-type': 'application/json' }, body: wireStringify(input) });
      const out = wireParse(await r.text()); assert.equal(r.status, status, JSON.stringify(out)); return out;
    };
    const input = { revision: doc.revision, assetId: doc.assets[0].id, frameId: doc.assets[0].frames[0].id };
    await call('/rig-drafts', input, 403, 'POST', 'https://unrelated.invalid'); assert.equal(store.load(doc.id).revision, 1);
    const created = await call('/rig-drafts', input, 201); assert.equal(created.document.assets.length, 2); assert.equal(created.document.studio.version, 2);
    const draft = created.draft; assert.deepEqual(created.document.studio.quality.approvals, {}); assert.ok(created.document.studio.resources[draft.resources.sources[0].resourceId].blob);
    await call('/quality-runs', { revision: created.document.revision, approvalId: draft.id, prompt: 'Draft alone must not start a CLI' }, 409);
    const edited = structuredClone(created.document); edited.studio.rigDrafts[draft.id].name = 'Nháp sửa tiếng Việt';
    const saved = await call('', { revision: edited.revision, document: edited }, 200, 'PUT'); assert.equal(saved.studio.rigDrafts[draft.id].name, 'Nháp sửa tiếng Việt');
    await call('/rig-drafts', input, 409); assert.ok(store.history(doc.id).length >= 2);
    const forged = structuredClone(saved); forged.studio.quality.approvals.forged = {};
    await call('', { revision: saved.revision, document: forged }, 409, 'PUT');
    const omitted = structuredClone(saved); delete omitted.studio.rigDrafts;
    await call('', { revision: saved.revision, document: omitted }, 400, 'PUT');
    await app.close(); app = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio') });
    const reopened = wireParse(await (await fetch(app.url + path.slice(1))).text()); assert.equal(reopened.studio.rigDrafts[draft.id].name, 'Nháp sửa tiếng Việt');
    const del = await fetch(app.url + path.slice(1) + '/rig-drafts/' + draft.id, { method: 'DELETE', headers: { origin: app.url.slice(0, -1), 'content-type': 'application/json' }, body: JSON.stringify({ revision: reopened.revision }) });
    assert.equal(del.status, 200); const final = wireParse(await del.text()); assert.equal(final.assets.length, 2); assert.deepEqual(final.studio.rigDrafts, {}); assert.deepEqual(final.studio.quality.approvals, {});
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});
