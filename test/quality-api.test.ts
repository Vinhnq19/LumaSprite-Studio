import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { serveStudio } from '../src/node/studio/server.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { celFor, composite, newLayer, wireParse, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';
import { decodeTestPng, unzipTestStored } from './fixtures/image-assertions.ts';
import { motionFixture } from './quality-motion-fixture.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { QualityJournal } from '../src/node/studio/quality-journal.ts';
import { startQualityProcess } from '../src/node/studio/quality-process.ts';
import { startRender } from '../src/node/studio/runner.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import { exportPixel } from '../src/node/studio/pixel-render.ts';
import { qualityHttpFixture } from './fixtures/quality-http.ts';
import { approvedQualityContext } from '../src/node/studio/quality-source.ts';

async function setup(scenario = 'valid', characterConstructionEffort?: 'low') {
  const root = mkdtempSync(join(tmpdir(), 'pxl-quality-api-')), log = join(root, 'fixture-calls.jsonl'), store = new PixelStore(root);
  let doc = store.create('Nguồn chất lượng', 18, 18, 0x70c989ff);
  doc.assets[0].metadata = { pivot: { x: 0.5, y: 1 }, hitbox: { x: 2, y: 3, w: 6, h: 7 }, events: [{ frame: 0, name: 'start' }] };
  doc = store.save(doc.id, doc.revision, doc);
  const options = { port: 0, uiDir: resolve('dist/studio'), providers: { codex: process.execPath, deepseek: qualityHttpFixture(scenario, log), prefix: [resolve('test/fixtures/quality-cli.cjs'), scenario, log], timeout: 15000, characterFinishStudy: scenario === 'character-finish', characterConstructionEffort } };
  let server = await serveStudio(root, options), origin = server.url.slice(0, -1);
  const call = async (path: string, input?: unknown, status = 200, method?: string) => {
    const response = await fetch(`${origin}/api/pixel/projects/${path}`, input === undefined ? undefined : { method: method ?? 'POST', headers: { origin, 'content-type': 'application/json' }, body: wireStringify(input) });
    const value = wireParse(await response.text()); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  return { root, store, doc, call, get origin() { return origin; },
    async restart() { await server.close(); server = await serveStudio(root, options); origin = server.url.slice(0, -1); },
    async close() { await server.close(); rmSync(root, { recursive: true, force: true }); },
    calls() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(v => JSON.parse(v)) : []; },
  };
}
const approve = (doc: PixelDocument) => ({ revision: doc.revision, assetId: doc.assets[0].id, frameId: doc.assets[0].frames[0].id, kind: 'static', sourceApproved: true });
test('Quality HTTP: preserve visible source layers through restart, with exact order and composite', { timeout: 30000 }, async () => {
  const x = await setup();
  try {
    const doc = x.store.load(x.doc.id, true), asset = doc.assets[0], frameId = asset.frames[0].id;
    const base = asset.layers[0], group = newLayer('Trang bị', 'group');
    const sword = newLayer('Kiếm', 'image', group.id), shield = newLayer('Khiên'), hidden = newLayer('Lớp ẩn');
    hidden.visible = false;
    asset.layers.push(group, sword, shield, hidden);
    const [green, steel] = [0x70c989ff, 0x51596eff];
    asset.palette = [green, steel];
    celFor(asset, sword.id, frameId, true)!.data![1] = steel;
    celFor(asset, shield.id, frameId, true)!.data![1] = green;
    celFor(asset, shield.id, frameId, true)!.data![2] = steel;
    celFor(asset, hidden.id, frameId, true)!.data![2] = green;
    const original = x.store.save(doc.id, doc.revision, doc);
    const locked = await x.call(`${doc.id}/quality/approvals`, { ...approve(original), preserveLayers: true }, 201);
    assert.deepEqual(locked.approval.recipe.parts.map((part: { id: string }) => part.id), [base.id, sword.id, shield.id]);
    await x.restart();
    const saved = x.store.load(doc.id, true), accepted = saved.studio!.quality!.approvals[locked.approval.id];
    const context = approvedQualityContext(x.store, saved, accepted);
    assert.equal(context.kind, 'free');
    if (context.kind !== 'free') throw new Error('Fixture should capture a static frame');
    const replay = createRecipeRenderer(context.recipe, context.resources).renderFrame(frameId).image.data;
    assert.deepEqual(replay, composite(saved.assets[0], frameId).data);
    assert.deepEqual([...replay.slice(0, 3)], [green, green, steel]);
    assert.equal(x.calls().length, 0);

    const layer = saved.assets[0].layers.find(layer => layer.id === sword.id)!;
    layer.opacity = 128; // The layer remains fully covered where it has paint.
    const changed = x.store.save(doc.id, saved.revision, saved);
    await x.call(`${doc.id}/quality/approvals`, { ...approve(changed), preserveLayers: true }, 422);
    assert.equal(x.store.load(doc.id).revision, changed.revision);
  } finally { await x.close(); }
});

async function settle(x: Awaited<ReturnType<typeof setup>>, project: string, job: string) {
  const end = performance.now() + 20000;
  while (performance.now() < end) { const r = await x.call(`${project}/quality-runs/${job}`); if (!['running', 'canceling'].includes(r.status)) return r; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Quality job did not finish');
}

for (const scenario of ['template-valid', 'template-outside']) {
  test(`Quality HTTP: scoped layered template [${scenario}]`, { timeout: 45000 }, async () => {
    const x = await setup(scenario);
    try {
      const doc = x.store.load(x.doc.id, true), asset = doc.assets[0], frameId = asset.frames[0].id;
      const green = 0x70c989ff, steel = 0x51596eff, shield = newLayer('Khiên');
      asset.palette = [green, steel];
      asset.layers.push(shield);
      celFor(asset, shield.id, frameId, true)!.data![19] = steel;
      const before = composite(asset, frameId).data;
      const initial = x.store.save(doc.id, doc.revision, doc);
      const { document, approval } = await x.call(`${doc.id}/quality/approvals`, {
        ...approve(initial), preserveLayers: true, templateScope: { partIds: [shield.id], region: { x: 1, y: 1, w: 1, h: 1 } },
      }, 201);
      const run = await x.call(`${doc.id}/quality-runs`, { revision: document.revision, approvalId: approval.id, prompt: 'Chỉnh màu lớp khiên' }, 202);
      const done = await settle(x, doc.id, run.id);
      if (scenario === 'template-outside') {
        assert.equal(done.status, 'failed');
        assert.match(done.message, /layer ngoài vùng/);
        assert.deepEqual(x.calls().map(call => call.role), ['director', 'builder', 'builder']);
        assert.equal(x.store.load(doc.id).revision, document.revision);
        return;
      }
      assert.equal(done.status, 'ready', done.message);
      const { assetId } = await x.call(`${doc.id}/quality-runs/${run.id}/apply`, { revision: document.revision, variantId: done.selectedVariantId });
      await x.restart();
      const saved = x.store.load(doc.id, true), source = saved.assets.find(a => a.id === asset.id)!, result = saved.assets.find(a => a.id === assetId)!;
      assert.equal(result.layers.length, 2);
      assert.deepEqual(celFor(result, result.layers[0].id, result.frames[0].id)?.data, celFor(source, source.layers[0].id, frameId)?.data);
      const expected = before.slice(); expected[19] = green;
      assert.deepEqual(composite(result, result.frames[0].id).data, expected);
      assert.deepEqual(composite(source, frameId).data, before);
      assert.deepEqual(result.palette, [green, steel]);
    } finally { await x.close(); }
  });
}

test('Quality HTTP: explicit approval upgrades only studio; Codex processes and fake HTTP -> exact native PNG -> new asset with source/metadata/history/export', { timeout: 60000 }, async () => {
  const x = await setup();
  try {
    const path = join(x.store.dir(x.doc.id), 'pxl.project.json'), before = readFileSync(path), sourceId = x.doc.assets[0].id;
    await x.call(`${x.doc.id}/quality/approvals`); assert.deepEqual(readFileSync(path), before, 'opening old doc never rewrites it');
    const accepted = await x.call(`${x.doc.id}/quality/approvals`, approve(x.doc), 201), d = accepted.document, a = accepted.approval;
    assert.equal(d.schemaVersion, 2); assert.equal(d.studio.version, 2); assert.equal(a.revision, d.revision); assert.equal(a.revision, x.doc.revision + 1);
    assert.ok(d.studio.resources[a.source.resourceId].blob); assert.equal(d.studio.resources[a.source.resourceId].data, undefined);
    const afterApproval = readFileSync(path), job = await x.call(`${d.id}/quality-runs`, { revision: d.revision, approvalId: a.id, prompt: 'Fixture giữ nguồn' }, 202), ready = await settle(x, d.id, job.id);
    assert.equal(ready.status, 'ready', ready.message); assert.equal(ready.cliCalls, 3); assert.equal(ready.variants.length, 2); assert.equal(ready.previewAvailable, true);
    assert.deepEqual(readFileSync(path), afterApproval, 'AI preview never modifies the manifest');
    assert.equal(JSON.stringify(ready).includes('$rgba'), false); assert.equal(JSON.stringify(ready).includes('cliRoot'), false); assert.equal(JSON.stringify(ready).includes('recipe'), false);
    const variant = ready.variants[1], frame = variant.frames[0];
    const preview = await fetch(`${x.origin}/api/pixel/projects/${d.id}/quality-runs/${job.id}/variants/${variant.id}/frame?revision=${d.revision}&frame=${frame.id}`);
    assert.equal(preview.status, 200, await preview.clone().text()); const png = decodeTestPng(Buffer.from(await preview.arrayBuffer())); assert.deepEqual([png.w, png.h], [18, 18]); assert.ok(png.data.every(p => p === 0x70c989ff));
    const applied = await x.call(`${d.id}/quality-runs/${job.id}/apply`, { revision: d.revision, variantId: variant.id, library: { kind: 'character', versionOf: sourceId, name: 'Bản chất lượng' } });
    assert.equal(applied.document.assets.length, 2); const result = applied.document.assets[1]; assert.notEqual(result.id, sourceId);
    assert.deepEqual(result.metadata, { pivot: { x: 0.5, y: 1 }, hitbox: { x: 2, y: 3, w: 6, h: 7 }, events: [{ frame: 0, name: 'start' }] });
    assert.ok(result.source.files['quality-recipe.js']); assert.ok(result.source.files['quality-provenance.js']); assert.ok(x.store.history(d.id).some(v => v.label.includes('chất lượng')));
    const rebuilt = await startRender({ mode: 'raster', document: { schemaVersion: 1, id: d.id, name: 'Round trip', revision: 1, files: result.source.files, entry: result.source.entry, pixels: {}, metadata: {} } }).promise as { data: Uint8Array };
    const reconstructed = wireParse(Buffer.from(rebuilt.data).toString('utf8'))[0]; assert.deepEqual(composite(reconstructed, reconstructed.frames[0].id).data, png.data);
    const exportRes = await fetch(`${x.origin}/api/pixel/projects/${d.id}/export`, { method: 'POST', headers: { origin: x.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: applied.document.revision, assetId: result.id, format: 'png' }) });
    assert.equal(exportRes.status, 200); assert.deepEqual(decodeTestPng(Buffer.from(await exportRes.arrayBuffer())), png);
    const atlasRes = await fetch(`${x.origin}/api/pixel/projects/${d.id}/export`, { method: 'POST', headers: { origin: x.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: applied.document.revision, assetId: result.id, selected: [result.id], format: 'atlas' }) });
    assert.equal(atlasRes.status, 200); const files = unzipTestStored(Buffer.from(await atlasRes.arrayBuffer())); const json = JSON.parse(files['image.json'].toString('utf8')); assert.deepEqual(json.meta.pxl.assets[result.id].hitbox, result.metadata.hitbox);
    const atlas = decodeTestPng(files['image.png']), uv = (Object.values(json.frames)[0] as { frame: { x: number; y: number; w: number; h: number } }).frame;
    assert.deepEqual([uv.w, uv.h], [18, 18]); for (let y = 0; y < 18; y++) for (let px = 0; px < 18; px++) assert.equal(atlas.data[(uv.y + y) * atlas.w + uv.x + px], png.data[y * 18 + px]);
    await x.restart(); const saved = x.store.load(d.id, true); assert.deepEqual(composite(saved.assets[1], saved.assets[1].frames[0].id).data, png.data);
    const history = await x.call(`${d.id}/quality-runs/${job.id}`); assert.equal(history.status, 'ready'); assert.equal(history.previewAvailable, false); assert.equal(history.appliedAssetId, result.id);
    await x.call(`${d.id}/quality-runs/${job.id}/apply`, { revision: saved.revision }, 409); assert.equal(x.calls().length, 3);
    assert.equal(readdirSync(join(x.store.dir(d.id), '.pxl/quality-runs')).filter(v => v.endsWith('.response.json')).length, 3);
    const response = await x.call(`${d.id}/quality-runs/${job.id}/calls/${ready.calls[0].id}`); assert.equal(JSON.parse(response.output).version, 1);
    const changedLog = join(x.store.dir(d.id), `.pxl/quality-runs/${job.id}-${ready.calls[0].id}.response.json`), changedText = readFileSync(changedLog, 'utf8') + '\n'; writeFileSync(changedLog, changedText);
    await x.call(`${d.id}/quality-runs/${job.id}`, { revision: saved.revision }, 200, 'DELETE');
    assert.equal(readFileSync(changedLog, 'utf8'), changedText); assert.equal(x.store.load(d.id).assets.length, 2); await x.call(`${d.id}/quality-runs/${job.id}`, undefined, 404);
  } finally { await x.close(); }
});

test('Quality HTTP: blank source accepts compact rows with omitted trailing dots through review and export', { timeout: 60000 }, async () => {
  const x = await setup('compact-pixels');
  try {
    let doc = x.store.create('Mẫu lưới', 32, 32, 0);
    const palette = [0x70c989ff, 0xeef7f8ff];
    doc.assets[0].palette = palette;
    doc = x.store.save(doc.id, doc.revision, doc);
    const accepted = await x.call(`${doc.id}/quality/approvals`, approve(doc), 201), d = accepted.document;
    const job = await x.call(`${d.id}/quality-runs`, { revision: d.revision, approvalId: accepted.approval.id, prompt: 'Vẽ cụm nhỏ theo lưới' }, 202);
    const ready = await settle(x, d.id, job.id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.cliCalls, 3);
    const variant = ready.variants.find((v: { id: string }) => v.id === ready.selectedVariantId);
    assert.equal(variant.kind, 'reviewed');
    const preview = await fetch(`${x.origin}/api/pixel/projects/${d.id}/quality-runs/${job.id}/variants/${variant.id}/frame?revision=${d.revision}&frame=${variant.frames[0].id}`);
    assert.equal(preview.status, 200);
    const png = decodeTestPng(Buffer.from(await preview.arrayBuffer()));
    const expected = new Uint32Array(32 * 32);
    expected[3 * 32 + 3] = palette[1]; expected[4 * 32 + 2] = palette[1]; expected[4 * 32 + 3] = palette[0];
    assert.deepEqual(png, { w: 32, h: 32, data: expected });
    const applied = await x.call(`${d.id}/quality-runs/${job.id}/apply`, { revision: d.revision, variantId: variant.id });
    await x.restart();
    const saved = x.store.load(d.id, true), asset = saved.assets.find(a => a.id === applied.assetId)!;
    const retainedRecipe = JSON.parse(asset.source!.files['quality-recipe.js'].slice('export default '.length));
    assert.deepEqual(retainedRecipe.parts[0].paint[0], { kind: 'pixels', x: 2, y: 3, rows: ['.1', '10'] });
    assert.deepEqual(composite(asset, asset.frames[0].id).data, expected);
    const exported = await fetch(`${x.origin}/api/pixel/projects/${d.id}/export`, { method: 'POST', headers: { origin: x.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: saved.revision, assetId: asset.id, format: 'png' }) });
    assert.equal(exported.status, 200);
    assert.deepEqual(decodeTestPng(Buffer.from(await exported.arrayBuffer())), png);
  } finally { await x.close(); }
});

test('Quality HTTP: blank character paint compiles from parts only and exports without changing the source', { timeout: 30000 }, async () => {
  const x = await setup('reviewer-completed-character');
  try {
    let source = x.store.create('Hiệp sĩ', 32, 32, 0);
    const palette = [0x51596eff, 0x8893a1ff, 0xc6d8dfff];
    source.assets[0].palette = palette;
    source = x.store.save(source.id, source.revision, source);
    const { document, approval } = await x.call(`${source.id}/quality/approvals`, approve(source), 201);
    const path = join(x.store.dir(source.id), 'pxl.project.json'), snapshot = readFileSync(path);
    const started = await x.call(`${source.id}/quality-runs`,
      { revision: document.revision, approvalId: approval.id, prompt: 'Tạo hiệp sĩ cầm kiếm' }, 202);
    const ready = await settle(x, source.id, started.id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.cliCalls, 3);
    assert.deepEqual(readFileSync(path), snapshot);
    const output = await x.call(`${source.id}/quality-runs/${started.id}/calls/${ready.calls[1].id}`);
    assert.deepEqual(Object.keys(JSON.parse(output.output)).sort(), ['description', 'parts', 'version']);
    const applied = await x.call(`${source.id}/quality-runs/${started.id}/apply`, { revision: document.revision, variantId: ready.selectedVariantId });
    const exported = await fetch(`${x.origin}/api/pixel/projects/${source.id}/export`, { method: 'POST',
      headers: { origin: x.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: applied.document.revision, assetId: applied.assetId, format: 'png' }) });
    assert.equal(exported.status, 200);
    const pixels = new Uint32Array(32 * 32);
    for (let y = 3; y < 8; y++) pixels.fill(palette[0], y * 32 + 2, y * 32 + 5);
    assert.deepEqual(decodeTestPng(Buffer.from(await exported.arrayBuffer())), { w: 32, h: 32, data: pixels });
    await x.restart();
    const saved = x.store.load(source.id, true), original = saved.assets.find(a => a.id === source.assets[0].id)!;
    assert.ok(composite(original, original.frames[0].id).data.every(pixel => pixel === 0));
  } finally { await x.close(); }
});

test('Quality HTTP: construction trial sends a tiny finish choice and preserves source canvas and export', { timeout: 30000 }, async () => {
  const x = await setup('character-finish', 'low');
  try {
    let source = x.store.create('Thử phối giáp', 32, 32, 0);
    const palette = [0x1f1424ff, 0x707d8fff, 0x8893a1ff, 0x9ba7b1ff];
    source.assets[0].palette = palette;
    source = x.store.save(source.id, source.revision, source);
    const { document, approval } = await x.call(`${source.id}/quality/approvals`, approve(source), 201);
    const started = await x.call(`${source.id}/quality-runs`,
      { revision: document.revision, approvalId: approval.id, prompt: 'Tạo hiệp sĩ cầm kiếm' }, 202);
    const ready = await settle(x, source.id, started.id);
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.cliCalls, 3);
    assert.equal(ready.technicalRepairs, 0);
    const calls = x.calls();
    assert.deepEqual(calls.map(call => call.role), ['director', 'builder', 'reviewer']);
    assert.ok(calls[0].flags.includes('model_reasoning_effort="low"'));
    assert.ok(calls[2].flags.every((flag: string) => !flag.startsWith('model_reasoning_effort=')));
    assert.equal(calls[1].finishChoice, true);
    assert.equal(calls[1].context, null);
    assert.equal(calls[1].tones.visiblePixels, 28);
    assert.equal(calls[1].tones.A.changedPixels, 7);
    assert.equal(calls[1].tones.B.changedPixels, 7);
    const applied = await x.call(`${source.id}/quality-runs/${started.id}/apply`,
      { revision: document.revision, variantId: ready.selectedVariantId });
    const exportRes = await fetch(`${x.origin}/api/pixel/projects/${source.id}/export`, { method: 'POST',
      headers: { origin: x.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: applied.document.revision, assetId: applied.assetId, format: 'png' }) });
    assert.equal(exportRes.status, 200);
    const expected = new Uint32Array(32 * 32);
    for (let y = 5; y <= 11; y++) expected.set([palette[0], palette[1], palette[2], palette[2]], y * 32 + 3);
    assert.deepEqual(decodeTestPng(Buffer.from(await exportRes.arrayBuffer())), { w: 32, h: 32, data: expected });
    const save = x.store.load(source.id, true);
    assert.ok(composite(save.assets[0], save.assets[0].frames[0].id).data.every(pixel => pixel === 0));
  } finally { await x.close(); }
});

test('Quality HTTP: 64 and 128 construction review receive native crops and accept local touch-ups', { timeout: 45000 }, async () => {
  const x = await setup('character-finish', 'low');
  try {
    for (const side of [64, 128]) {
      let source = x.store.create(`Thử dáng ${side}`, side, side, 0);
      source.assets[0].palette = [0x1f1424ff, 0x51596eff, 0x8893a1ff, 0xc6d8dfff];
      source = x.store.save(source.id, source.revision, source);
      const { document, approval } = await x.call(`${source.id}/quality/approvals`, approve(source), 201);
      const running = await x.call(`${source.id}/quality-runs`,
        { revision: document.revision, approvalId: approval.id, prompt: 'Tạo hiệp sĩ RPG cầm kiếm' }, 202);
      const ready = await settle(x, source.id, running.id);
      assert.equal(ready.status, 'ready', ready.message);
      assert.equal(ready.cliCalls, 3);
      assert.equal(ready.technicalRepairs, 0);
      const [builder, reviewed] = ready.variants;
      assert.equal(reviewed.id, ready.selectedVariantId);
      assert.notEqual(builder.frames[0].rgbaSha256, reviewed.frames[0].rgbaSha256);
      const [before, after] = await Promise.all([builder, reviewed].map(async variant => {
        const preview = await fetch(`${x.origin}/api/pixel/projects/${source.id}/quality-runs/${running.id}/variants/${variant.id}/frame?revision=${document.revision}&frame=${variant.frames[0].id}`);
        assert.equal(preview.status, 200);
        return decodeTestPng(Buffer.from(await preview.arrayBuffer()));
      }));
      const touched = new Set([15 * side + 51, 15 * side + 52, 16 * side + 51, 16 * side + 52, 28 * side + 17, 28 * side + 19]);
      if (side === 128) {
        for (let row = 28; row <= 32; row++) for (let col = 17; col <= 24; col++) touched.add(row * side + col);
        assert.notEqual(before.data[29 * side + 24], 0);
        assert.equal(after.data[29 * side + 24], 0);
        assert.equal(after.data[30 * side + 24], before.data[29 * side + 24]);
      }
      after.data.forEach((color, index) => { if (!touched.has(index)) assert.equal(color, before.data[index]); });
    }
  } finally { await x.close(); }
});

test('Quality HTTP: old revision, missing human approval, foreign/forged receipt and direct PUT cannot authorize generation', { timeout: 30000 }, async () => {
  const x = await setup();
  try {
    await x.call(`${x.doc.id}/quality/approvals`, { ...approve(x.doc), sourceApproved: false }, 400);
    await x.call(`${x.doc.id}/quality/approvals`, { ...approve(x.doc), receipt: {} }, 400);
    await x.call(`${x.doc.id}/quality/approvals`, { ...approve(x.doc), revision: -1 }, 409);
    const accepted = await x.call(`${x.doc.id}/quality/approvals`, approve(x.doc), 201), d = accepted.document;
    const forged = structuredClone(d); forged.studio.quality.approvals[accepted.approval.id].approvedAt++;
    await x.call(d.id, { revision: d.revision, document: forged }, 409, 'PUT');
    const foreign = x.store.create('Khác', 18, 18, 0x70c989ff);
    await x.call(`${foreign.id}/quality-runs`, { revision: foreign.revision, approvalId: accepted.approval.id, prompt: 'no AI' }, 409);
    await x.call(`${d.id}/quality-runs`, { revision: d.revision, approvalId: '__proto__', prompt: 'no AI' }, 400);
    const deny = await fetch(`${x.origin}/api/pixel/projects/${d.id}/quality-runs`, { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ revision: d.revision, approvalId: accepted.approval.id, prompt: 'no AI' }) }); assert.equal(deny.status, 403);
    const next = x.store.load(d.id); next.name = 'Đã sửa'; const changed = x.store.save(d.id, next.revision, next);
    await x.call(`${d.id}/quality-runs`, { revision: changed.revision, approvalId: accepted.approval.id, prompt: 'no AI' }, 409); assert.equal(x.calls().length, 0);
    const copied = x.store.copy('Bản sao', x.store.load(d.id), d.id); assert.ok(copied.studio?.quality);
    await x.call(`${copied.id}/quality-runs`, { revision: copied.revision, approvalId: accepted.approval.id, prompt: 'no implicit approval on copy' }, 409);
  } finally { await x.close(); }
});

test('Quality HTTP: shared lease blocks legacy AI and batches while running, cancel/close prevent late apply, stale preview/apply refuse', { timeout: 60000 }, async () => {
  const x = await setup();
  try {
    const accepted = await x.call(`${x.doc.id}/quality/approvals`, approve(x.doc), 201), d = accepted.document;
    const job = await x.call(`${d.id}/quality-runs`, { revision: d.revision, approvalId: accepted.approval.id, prompt: 'test gate' }, 202);
    await x.call(`${d.id}/quality-runs/${job.id}`, { revision: d.revision }, 409, 'DELETE');
    await x.call(`${d.id}/ai`, { revision: d.revision, provider: 'codex', assetId: d.assets[0].id, prompt: 'must be busy' }, 409);
    await x.call(`${d.id}/generation-batches`, { revision: d.revision, provider: 'codex', assetId: d.assets[0].id, prompt: 'must be busy' }, 409);
    const cancel = await x.call(`${d.id}/quality-runs/${job.id}/cancel`, { revision: d.revision }); assert.equal(cancel.status, 'canceled');
    await x.call(`${d.id}/quality-runs/${job.id}/apply`, { revision: d.revision }, 409);
    const second = await x.call(`${d.id}/quality-runs`, { revision: d.revision, approvalId: accepted.approval.id, prompt: 'complete then change revision' }, 202), ready = await settle(x, d.id, second.id); assert.equal(ready.status, 'ready', ready.message);
    const next = x.store.load(d.id); next.assets[0].name = 'Sửa ngoài'; const changed = x.store.save(d.id, next.revision, next);
    await x.call(`${d.id}/quality-runs/${second.id}/apply`, { revision: changed.revision }, 409);
    const frame = await fetch(`${x.origin}/api/pixel/projects/${d.id}/quality-runs/${second.id}/variants/${ready.variants[0].id}/frame?revision=${changed.revision}&frame=${ready.variants[0].frames[0].id}`); assert.equal(frame.status, 409);
    await x.call(`${d.id}/close`, {}); const history = await x.call(`${d.id}/quality-runs/${second.id}`); assert.equal(history.previewAvailable, false); assert.equal(x.store.load(d.id).assets.length, 1);
  } finally { await x.close(); }
});

for (const scenario of ['valid', 'frame-edits', 'retouch-local']) test(`Quality HTTP: motion approval, protected frame edits and exact apply/reopen/export [${scenario}]`, { timeout: 60000 }, async () => {
  const x = await setup(scenario);
  try {
    const f = motionFixture(), d = x.store.load(x.doc.id), source = d.assets[0], image = createRecipeRenderer(f.recipe).renderFrame('rest').image.data;
    source.w = source.h = 16; source.palette = [...f.recipe.palette]; source.metadata = { pivot: { x: 0.5, y: 1 } }; source.cels = { cel: { id: 'cel', data: image } }; source.layers[0].cels = { [source.frames[0].id]: 'cel' };
    const mask = Uint32Array.from({ length: 256 }, (_, i) => scenario !== 'valid'
      ? +(i % 16 >= 4 && i % 16 <= 11 && Math.floor(i / 16) >= 3 && Math.floor(i / 16) <= 9)
      : +(i % 16 >= 5 && i % 16 <= 10 && Math.floor(i / 16) >= 4 && Math.floor(i / 16) <= 6));
    f.plan.frames[1].rotations = [{ jointId: 'shoulder', degrees: 90 }, { jointId: 'elbow', degrees: -90 }];
    d.studio = { version: 1, resources: { mask: { version: 1, kind: 'mask', w: 16, h: 16, data: mask } } };
    const saved = x.store.save(d.id, d.revision, d);
    const input = { revision: saved.revision, assetId: source.id, frameId: source.frames[0].id, kind: 'motion', sourceApproved: true, poseApproved: true, partsApproved: true, recipe: f.recipe, rig: f.rig, plan: f.plan, resources: { sources: [], masks: [] }, movementMaskResourceId: 'mask', frozenFrames: [{ frameId: 'rest', sourceFrameId: source.frames[0].id }] };
    await x.call(`${d.id}/quality/approvals`, { ...input, poseApproved: false }, 400);
    const accepted = await x.call(`${d.id}/quality/approvals`, input, 201); assert.equal(accepted.approval.rig.source.revision, accepted.document.revision);
    const job = await x.call(`${d.id}/quality-runs`, { revision: accepted.document.revision, approvalId: accepted.approval.id, prompt: 'preserve approved parts' }, 202);
    let ready = await settle(x, d.id, job.id); assert.equal(ready.status, 'ready', ready.message);
    let localParent: string | undefined;
    if (scenario === 'retouch-local') {
      localParent = ready.selectedVariantId;
      const manifest = readFileSync(join(x.store.dir(d.id), 'pxl.project.json'));
      const path = `${d.id}/quality-runs/${job.id}/variants/${localParent}/retouch`;
      await x.call(`${path}?frame=carry`, undefined, 400);
      await x.call(`${path}?revision=${accepted.document.revision}&frame=missing`, undefined, 404);
      const info = await x.call(`${path}?revision=${accepted.document.revision}&frame=carry`);
      assert.deepEqual(info.pixelEdits, []); assert.deepEqual(info.sourceLockedFrames, ['rest']);
      assert.deepEqual(decodeTestPng(Buffer.from(info.movementMask, 'base64')).data, Uint32Array.from(mask, n => n ? 0xffffffff : 0));
      const input = { revision: accepted.document.revision, patches: [{ frameId: 'carry', pixelEdits: [{ x: 5, y: 8, color: 1 }] }],
        lockedFrames: ['rest'], region: { x: 4, y: 7, w: 4, h: 3 } };
      await x.call(path, { ...input, revision: input.revision - 1 }, 409);
      await x.call(path, { ...input, receipt: {} }, 400);
      await x.call(`${d.id}/quality-runs/${job.id}/variants/foreign/retouch`, input, 404);
      const foreign = await fetch(`${x.origin}/api/pixel/projects/${path}`, { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: wireStringify(input) });
      assert.equal(foreign.status, 403);
      const local = await x.call(path, input, 201);
      assert.equal(local.variant.kind, 'edited'); assert.equal(local.variant.parentVariantId, localParent);
      ready = await x.call(`${d.id}/quality-runs/${job.id}`);
      assert.equal(ready.selectedVariantId, local.variant.id); assert.equal(ready.variants.length, 3);
      assert.equal(ready.cliCalls, 3); assert.equal(ready.technicalRepairs, 0); assert.equal(x.calls().length, 3);
      assert.deepEqual(readFileSync(join(x.store.dir(d.id), 'pxl.project.json')), manifest, 'local variant does not save or overwrite source project');
      const childPath = `${d.id}/quality-runs/${job.id}/variants/${local.variant.id}/retouch`;
      await x.call(childPath, { revision: input.revision, patches: [{ frameId: 'carry', pixelEdits: [{ x: 8, y: 8, color: 1 }] }], lockedFrames: [], region: null }, 422);
      await x.call(childPath, { revision: input.revision, patches: [{ frameId: 'rest', pixelEdits: [{ x: 4, y: 4, color: 1 }] }], lockedFrames: [], region: null }, 422);
      assert.equal((await x.call(`${d.id}/quality-runs/${job.id}`)).variants.length, 3);
      assert.equal(x.calls().length, 3);
    }
    const expected = createRecipeRenderer(compileMotionRecipe(f.recipe, f.rig, f.plan).recipe).renderFrame('carry').image.data.slice();
    if (scenario !== 'valid') expected[8 * 16 + 5] = f.recipe.palette[1];
    const preview = await fetch(`${x.origin}/api/pixel/projects/${d.id}/quality-runs/${job.id}/variants/${ready.selectedVariantId}/frame?revision=${accepted.document.revision}&frame=carry`);
    assert.equal(preview.status, 200);
    assert.deepEqual(decodeTestPng(Buffer.from(await preview.arrayBuffer())).data, expected);
    const applied = await x.call(`${d.id}/quality-runs/${job.id}/apply`, { revision: accepted.document.revision }); const resultId = applied.assetId;
    await x.restart(); const full = x.store.load(d.id, true), result = full.assets.find(a => a.id === resultId)!;
    assert.deepEqual(composite(result, result.frames[0].id).data, image); assert.deepEqual(result.frames.map(f => f.duration), f.plan.frames.map(f => f.durationMs)); assert.equal(result.tags[0].loop, f.plan.loop);
    const moving = composite(result, result.frames[1].id).data; assert.notDeepEqual(moving, image); assert.equal(moving[6 * 16 + 7], f.recipe.palette[1]);
    assert.deepEqual(moving, expected);
    for (let i = 0; i < image.length; i++) if (!mask[i]) assert.equal(moving[i], image[i], `outside mask pixel ${i}`);
    assert.deepEqual(composite(full.assets[0], full.assets[0].frames[0].id).data, image);
    assert.equal(x.calls().length, 3);
    if (scenario !== 'valid') {
      const recipe = JSON.parse(result.source!.files['quality-recipe.js'].slice('export default '.length));
      assert.deepEqual(recipe.frames[1].pixelEdits, [{ x: 5, y: 8, color: 1 }]);
      const png = decodeTestPng(Buffer.from(exportPixel({ document: full, assetId: result.id, frameId: result.frames[1].id, format: 'png' }).data));
      assert.deepEqual(png.data, expected);
      const zip = unzipTestStored(Buffer.from(exportPixel({ document: full, assetId: result.id, selected: [result.id], format: 'atlas' }).data));
      const atlas = decodeTestPng(zip['image.png']), meta = JSON.parse(zip['image.json'].toString('utf8'));
      const entries = Object.values(meta.frames) as { frame: { x: number; y: number; w: number; h: number }; duration: number }[];
      assert.equal(entries.length, 2);
      entries.forEach((entry, index) => {
        assert.deepEqual([entry.frame.w, entry.frame.h, entry.duration], [16, 16, [100, 120][index]]);
        const pixels = new Uint32Array(256);
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[y * 16 + x] = atlas.data[(entry.frame.y + y) * atlas.w + entry.frame.x + x];
        assert.deepEqual(pixels, index === 0 ? image : expected);
      });
      assert.equal(meta.meta.frameTags[0].loop, true);
      if (scenario === 'retouch-local') {
        const provenance = JSON.parse(result.source!.files['quality-retouch.js'].slice('export default '.length));
        assert.deepEqual(provenance, { version: 1, parentVariantId: localParent, constraints: { lockedFrames: ['rest'], region: { x: 4, y: 7, w: 4, h: 3 } } });
      }
    }
  } finally { await x.close(); }
});

test('Quality HTTP: a legacy AI job also holds the shared gate against approval and quality start', { timeout: 30000 }, async () => {
  const x = await setup();
  try {
    const accepted = await x.call(`${x.doc.id}/quality/approvals`, approve(x.doc), 201), d = accepted.document;
    const legacy = await x.call(`${d.id}/ai`, { revision: d.revision, provider: 'codex', assetId: d.assets[0].id, prompt: 'local legacy fixture' }, 202);
    await x.call(`${d.id}/quality-runs`, { revision: d.revision, approvalId: accepted.approval.id, prompt: 'must wait' }, 409);
    await x.call(`${d.id}/quality/approvals`, approve(d), 409);
    await x.call(`${d.id}/ai/${legacy.id}/cancel`, {});
    assert.equal(x.calls().length, 0);
  } finally { await x.close(); }
});

test('Quality HTTP: restarted unknown job keeps the cold legacy gate until owned helper/tree stop is confirmed; never replays an AI call', { timeout: 30000 }, async () => {
  const x = await setup(), root = mkdtempSync(join(tmpdir(), 'lumasprite-quality-cli-')), work = join(root, 'owned-call'); mkdirSync(work);
  const pidFile = join(work, 'root.pid'), script = join(work, 'fixture.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const task = startQualityProcess({ executable: process.execPath, args: [script], cwd: work, budgetMs: 15000 });
  try {
    const end = performance.now() + 10000; while (!existsSync(pidFile) && performance.now() < end) await new Promise(r => setTimeout(r, 25)); assert.ok(existsSync(pidFile));
    const journal = new QualityJournal(x.store);
    journal.save({ version: 1, approvalId: 'source-before-restart', prompt: 'owned fixture', style: 'RPG', cliRoot: root, ownerPid: process.pid, ownerClosed: true,
      run: { version: 1, id: 'recovered-run', projectId: x.doc.id, revision: x.doc.revision, status: 'unknown', stage: 'builder', started: Date.now(), deadline: Date.now() + 15000, cliCalls: 1, technicalRepairs: 0, message: 'old server stopped', variants: [], calls: [{ id: 'owned-call', role: 'builder', provider: 'antigravity', repair: false, started: Date.now(), deadline: Date.now() + 15000, status: 'unknown' }] } });
    await x.call(`${x.doc.id}/ai`, { revision: x.doc.revision, provider: 'codex', assetId: x.doc.assets[0].id, prompt: 'blocked by archived unknown' }, 409);
    const unknown = await x.call(`${x.doc.id}/quality-runs/recovered-run`); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.previewAvailable, false);
    const canceled = await x.call(`${x.doc.id}/quality-runs/recovered-run/cancel`, { revision: x.doc.revision }); assert.equal(canceled.status, 'canceled');
    assert.equal(await task.stop(Date.now() + 5000), true); await task.promise.catch(e => assert.match(e.message, /hủy/));
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
    await x.call(`${x.doc.id}/quality/approvals`, approve(x.doc), 201); assert.equal(x.calls().length, 0);
  } finally { assert.equal(await task.stop(Date.now() + 5000), true); await x.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Quality HTTP: semi-transparent source requires explicit normalization and altered journal cannot authorize recovery or another AI', { timeout: 30000 }, async () => {
  const x = await setup();
  try {
    const d = x.store.load(x.doc.id); d.assets[0].layers[0].opacity = 128; const semi = x.store.save(d.id, d.revision, d), path = join(x.store.dir(d.id), 'pxl.project.json'), before = readFileSync(path);
    await x.call(`${d.id}/quality/approvals`, approve(semi), 422); assert.deepEqual(readFileSync(path), before); assert.equal(x.store.load(d.id).studio, undefined);
    const journal = new QualityJournal(x.store);
    journal.save({ version: 1, approvalId: 'absent', prompt: 'no AI', style: 'RPG', cliRoot: 'not-an-owned-root', ownerPid: process.pid,
      run: { version: 1, id: 'changed-journal', projectId: d.id, revision: semi.revision, status: 'failed', stage: 'done', started: Date.now(), deadline: Date.now(), cliCalls: 0, technicalRepairs: 0, message: 'fixture failed', variants: [], calls: [] } });
    const log = join(x.store.dir(d.id), '.pxl/quality-runs/changed-journal.json'), envelope = JSON.parse(readFileSync(log, 'utf8')); envelope.record.ownerClosed = true; writeFileSync(log, JSON.stringify(envelope));
    await x.call(`${d.id}/quality-runs/changed-journal`, undefined, 409);
    await x.call(`${d.id}/ai`, { revision: semi.revision, provider: 'codex', assetId: semi.assets[0].id, prompt: 'must not bypass corrupt journal' }, 409);
    assert.equal(x.calls().length, 0);
  } finally { await x.close(); }
});
