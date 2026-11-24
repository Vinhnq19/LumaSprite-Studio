import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { serveStudio } from '../src/node/studio/server.ts';
import { celFor, duplicateFrame, newDocument, wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';

test('Cel HTTP reads verify the requested blob while project open, save and export still validate the whole store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-cel-integrity-')), store = new PixelStore(root);
  const app = await serveStudio(root, { port: 0 });
  t.after(async () => {
    await app.close();
    assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
  });
  const doc = newDocument('Hai cel riêng', 2, 2), a = doc.assets[0], layer = a.layers[0].id, first = a.frames[0].id;
  const second = duplicateFrame(a, first, 'blank');
  const aCel = celFor(a, layer, first, true)!, bCel = celFor(a, layer, second, true)!;
  aCel.data![0] = 0x12345680;
  bCel.data![0] = 0xfedcbaab;
  const created = store.create(doc.name, 2, 2, 0, doc), persisted = store.load(created.id);
  const onDisk = join(store.dir(persisted.id), 'pxl.project.json'), before = readFileSync(onDisk);
  const aBlob = persisted.assets[0].cels[aCel.id].blob!, bBlob = persisted.assets[0].cels[bCel.id].blob!;
  writeFileSync(join(store.dir(persisted.id), '.pxl/cels', bBlob + '.rgba.z'), 'damaged');
  const base = app.url + `api/pixel/projects/${persisted.id}`, origin = new URL(app.url).origin;
  const get = (id: string, revision = persisted.revision, blob?: string) => fetch(
    `${base}/cel?revision=${revision}&asset=${a.id}&cel=${id}${blob ? `&blob=${blob}&w=2&h=2` : ''}`);
  const intact = await get(aCel.id);
  assert.equal(intact.status, 200);
  assert.deepEqual(wireParse(await intact.text()).data, aCel.data);
  assert.equal((await get(bCel.id, persisted.revision, bBlob)).status, 409);
  assert.equal((await get(aCel.id, persisted.revision - 1, aBlob)).status, 409);
  assert.equal((await fetch(base)).status, 409);
  const headers = { origin, 'content-type': 'application/json' };
  assert.equal((await fetch(base, { method: 'PUT', headers, body: wireStringify({ revision: persisted.revision, document: persisted }) })).status, 409);
  assert.equal((await fetch(base + '/export', { method: 'POST', headers, body: JSON.stringify({ revision: persisted.revision, format: 'png' }) })).status, 409);
  assert.deepEqual(readFileSync(onDisk), before);
});

test('Resource HTTP verification: revision, ownership, compact SSE, copy and ZIP import use exactly the same lazy bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-resource-http-independent-'));
  const app = await serveStudio(root, { port: 0, providers: { codex: join(root, 'missing-codex.exe'), antigravity: join(root, 'missing-anti.exe') } });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const request = async (path: string, method = 'GET', input?: any) => fetch(app.url + 'api/pixel/' + path, { method, headers: { origin: app.url.slice(0, -1), ...(input ? { 'content-type': 'application/json' } : {}) }, body: input ? wireStringify(input) : undefined });
    const pixels = Uint32Array.from([0xff0000ff, 0x00ff00ff, 0x0000ff7f, 0]);
    const d: any = newDocument('HTTP nhân vật', 18, 18); d.studio = { version: 1, resources: { source: { version: 1, kind: 'rgba', w: 2, h: 2, data: pixels } } };
    d.assets[0].cels.independent = { id: 'independent', data: new Uint32Array(18 * 18) };
    d.assets[0].layers[0].cels[d.assets[0].frames[0].id] = 'independent';
    const created = await request('projects', 'POST', { name: d.name, document: d }); assert.equal(created.status, 201);
    let doc = wireParse(await created.text()), base = `projects/${doc.id}`;
    assert.equal(doc.studio.resources.source.data, undefined);
    const first = await request(`${base}/resource?revision=${doc.revision}&resource=source`); assert.equal(first.status, 200);
    assert.deepEqual(wireParse(await first.text()).data, pixels);
    assert.equal((await request(`${base}/resource?resource=source`)).status, 409);
    assert.notEqual((await request(`${base}/resource?revision=${doc.revision}&resource=toString`)).status, 200);
    reader = (await fetch(app.url + 'api/studio/events', { signal: AbortSignal.timeout(10000) })).body!.getReader(); await reader.read();
    const oldRevision = doc.revision; doc.name = 'Sửa tên';
    const update = await request(base, 'PUT', { revision: oldRevision, document: doc }); assert.equal(update.status, 200); doc = wireParse(await update.text());
    const event = await reader.read(), text = new TextDecoder().decode(event.value);
    assert.match(text, /pixel-saved/); assert.doesNotMatch(text, /\$rgba|"data"\s*:|"resources"\s*:/);
    await reader.cancel(); reader = undefined;
    assert.equal((await request(`${base}/resource?revision=${oldRevision}&resource=source`)).status, 409);
    assert.equal((await request(base, 'PUT', { revision: oldRevision, document: doc })).status, 409);
    const copyResponse = await request('projects', 'POST', { name: 'Bản sao', sourceProjectId: doc.id, document: doc }); assert.equal(copyResponse.status, 201);
    const copy = wireParse(await copyResponse.text()); assert.equal(copy.studio.resources.source.blob, doc.studio.resources.source.blob);
    assert.deepEqual(wireParse(await (await request(`projects/${copy.id}/resource?revision=${copy.revision}&resource=source`)).text()).data, pixels);
    const empty = wireParse(await (await request('projects', 'POST', { name: 'Nguồn khác' })).text());
    assert.notEqual((await request('projects', 'POST', { name: 'Không sở hữu', sourceProjectId: empty.id, document: doc })).status, 201);
    const zipped = Buffer.from(await (await request(`${base}/backup`)).arrayBuffer());
    const blobs: Record<string, string> = {}, resourceBlobs: Record<string, string> = {}, history: any[] = [];
    for (let offset = 0; offset + 30 < zipped.length && zipped.readUInt32LE(offset) === 0x04034b50;) {
      const length = zipped.readUInt32LE(offset + 18), nl = zipped.readUInt16LE(offset + 26), extra = zipped.readUInt16LE(offset + 28), start = offset + 30 + nl + extra;
      const name = zipped.toString('utf8', offset + 30, offset + 30 + nl), value = zipped.subarray(start, start + length);
      const cel = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba\.z$/.exec(name), resource = /^\.pxl\/resources\/([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/.exec(name);
      if (cel) blobs[cel[1]] = value.toString('base64');
      if (resource) resourceBlobs[`${resource[2]}:${resource[1]}`] = value.toString('base64');
      if (/^\.pxl\/pixel-history\/[\w-]+\.json$/.test(name)) history.push(JSON.parse(value.toString('utf8')));
      offset = start + length;
    }
    const importedResponse = await request('projects', 'POST', { name: 'Nhập ZIP', backup: { document: doc, blobs, resourceBlobs, history } }); assert.equal(importedResponse.status, 201);
    const imported = wireParse(await importedResponse.text());
    assert.deepEqual(wireParse(await (await request(`projects/${imported.id}/resource?revision=${imported.revision}&resource=source`)).text()).data, pixels);
    const oldRef = doc.studio.resources.source, oldCel = doc.assets[0].cels.independent.blob;
    doc.studio.resources.source = { version: 1, kind: 'rgba', w: 2, h: 2, data: new Uint32Array(4).fill(0x888888ff) };
    doc.assets[0].cels.independent = { id: 'independent', data: new Uint32Array(18 * 18).fill(0xff0000ff) };
    const edited = await request(base, 'PUT', { revision: doc.revision, document: doc }); assert.equal(edited.status, 200); doc = wireParse(await edited.text());
    const oldQuery = `&blob=${oldRef.blob}&kind=rgba&w=2&h=2`;
    const historical = await request(`${base}/resource?revision=${doc.revision}&resource=source${oldQuery}`); assert.equal(historical.status, 200);
    assert.deepEqual(wireParse(await historical.text()).data, pixels);
    const historicalCel = await request(`${base}/cel?revision=${doc.revision}&asset=${doc.assets[0].id}&cel=independent&blob=${oldCel}&w=18&h=18`);
    assert.equal(historicalCel.status, 200); assert.deepEqual(wireParse(await historicalCel.text()).data, new Uint32Array(18 * 18));
    assert.equal((await request(`projects/${empty.id}/resource?revision=${empty.revision}&resource=source${oldQuery}`)).status, 404, 'Owned historical bytes never fall back to another project');
    assert.equal((await request(`${base}/resource?revision=${doc.revision - 1}&resource=source${oldQuery}`)).status, 409);
    assert.equal((await request(`${base}/resource?revision=${doc.revision}&resource=source&blob=${oldRef.blob}&kind=rgba&w=8192&h=1`)).status, 400);
    assert.equal((await request(`${base}/close`, 'POST', {})).status, 200);
  } finally {
    await reader?.cancel().catch(() => {}); await app.close();
    assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
  }
});
