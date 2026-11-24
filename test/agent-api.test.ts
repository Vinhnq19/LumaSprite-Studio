import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { agentPath } from '../src/studio/agent-contract.ts';
import { celFor, composite, newAsset } from '../src/studio/pixel/model.ts';
import { decodeTestPng, unzipTestStored } from './fixtures/image-assertions.ts';
import { productionRpgFixture, rpgAgentToken as token, rpgIds, setupRpgProduction } from './fixtures/production-rpg.ts';
import { startExternalEngine } from './fixtures/external-engine.ts';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('Agent perimeter rejects foreign Host/Origin and does not echo malformed request text', async t => {
  const { root, store, saved } = fixture();
  const app = await serveStudio(root, { port: 0, agentWriteToken: token });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const base = new URL(app.url), path = join(store.dir(saved.id), 'pxl.project.json'), before = readFileSync(path);
  const post = (body: string, origin = base.origin, host = base.host) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(new URL(agentPath, base), {
      method: 'POST', headers: { host, origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const read = JSON.stringify({ version: 1, operation: 'project.get', projectId: saved.id, input: {} });
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal((await post(read, 'http://example.invalid')).status, 403);
  assert.equal((await post(read, base.origin, 'example.invalid')).status, 403);
  const malformed = await post(token);
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body).error, { code: 'INVALID_REQUEST', message: 'JSON Agent không hợp lệ.' });
  assert.ok(!malformed.body.includes(token.slice(0, 10)));
  assert.equal((await post(read)).status, 200);
  assert.deepEqual(readFileSync(path), before);
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-agent-rpg-')), store = new PixelStore(root);
  const seed = productionRpgFixture();
  seed.assets[0].layers[0].locked = true;
  const created = store.create(seed.name, 32, 32, 0, seed), doc = store.load(created.id);
  setupRpgProduction(doc);
  return { root, store, seed, saved: store.save(doc.id, doc.revision, doc, 'Production fixture') };
};

async function cli(port: string, request?: object, authorize = false) {
  const bin = process.env.PXL_S5_BIN;
  const args = ['agent', request ? 'call' : 'capabilities', '--port', port];
  const launch = bin ? [bin, ...args] : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module',
    '-e', "const {main}=await import('./src/node/cli.ts');process.exitCode=await main(process.argv.slice(1))", '--', ...args];
  const child = spawn(process.execPath, launch, { windowsHide: true, env: { ...process.env, PXL_AGENT_WRITE_TOKEN: authorize ? token : '' } });
  const output: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.end(request ? JSON.stringify(request) : undefined);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(Buffer.concat(stderr).toString(), '');
  const raw = Buffer.concat(output).toString();
  assert.ok(!raw.includes(token));
  return { code, run: JSON.parse(raw) };
}

test('S5 Mini RPG: Windows CLI/HTTP discover, export ZIP, revision conflict and scoped rollback', async t => {
  const { root, store, saved, seed } = fixture(), engine = await startExternalEngine();
  const app = await serveStudio(root, { port: 0, agentWriteToken: token, externalEnginePort: engine.port });
  t.after(async () => { await app.close(); await engine.stop(); rmSync(root, { recursive: true, force: true }); });
  const url = new URL(app.url), port = url.port, pathname = join(store.dir(saved.id), 'pxl.project.json'), before = readFileSync(pathname);
  const started = performance.now(), timingMs: Record<string, number> = {};
  let calls = 0;
  const request = (operation: string, input: object, expectedRevision?: number) =>
    ({ version: 1, operation, projectId: saved.id, input, ...(expectedRevision !== undefined && { expectedRevision }) });
  const run = async (operation: string, input: object = {}, expectedRevision?: number, authorized = false) => {
    const result = await cli(port, request(operation, input, expectedRevision), authorized); calls++; return result;
  };
  assert.equal((await cli(port)).run.data.externalCostEnabled, false);
  const noWrites = await run('asset.rename', { assetId: rpgIds.hero, name: 'Tên trái phép' }, saved.revision);
  assert.equal(noWrites.code, 3);
  assert.equal(noWrites.run.error.code, 'PERMISSION_DENIED');
  assert.equal((await cli(port, { version: 1, operation: 'engine.capabilities', input: {} })).run.data.capabilities.versions[0], 1);
  assert.equal((await cli(port, { version: 1, operation: 'engine.submit', input: {} }, true)).run.error.code, 'APPROVAL_REQUIRED');
  assert.equal((await cli(port, { version: 1, operation: 'projects.list', input: {} })).run.data.projects[0].id, saved.id);
  assert.equal((await run('project.get')).run.data.project.schemaVersion, 2);
  const rows = (await run('assets.list')).run.data.assets;
  assert.equal(rows.find((r: { id: string }) => r.id === rpgIds.hero).status, 'approved');
  assert.equal((await run('collections.list')).run.data.collections[0].id, 'release-pack');
  assert.equal((await run('profiles.list')).run.data.profiles[0].lockPalette, true);
  const style = (await run('style.check', { assetId: rpgIds.hero, collectionId: 'release-pack' })).run.data;
  assert.deepEqual(style, { technical: { profileId: 'rpg-style', outside: 0, staleReferences: [] }, artisticStatus: 'unreviewed' });
  const scene = (await run('scenes.list')).run.data.scenes[0];
  assert.equal(scene.stale, false);
  assert.deepEqual(scene.size, { w: 224, h: 160, tileSize: 16 });
  assert.deepEqual((await run('animations.list')).run.data.animations[0].frames.map((f: { duration: number }) => f.duration), [100, 180]);
  assert.equal((await run('tilemaps.list')).run.data.tilemaps[0].id, rpgIds.map);
  const params = { collectionId: 'release-pack', sceneId: 'village' };
  assert.equal((await run('package.plan', params)).run.data.eligible, true);
  timingMs.readAndCheck = Math.round(performance.now() - started);
  const beganExport = performance.now();
  const { id } = (await run('package.start', params, saved.revision)).run.data.job;
  const jobInput = { jobId: id };
  const status = async () => (await run('jobs.status', jobInput)).run.data.job;
  let job = await status();
  for (let attempts = 0; job.state === 'running' && attempts < 12; attempts++) { await setTimeout(50); job = await status(); }
  assert.equal(job.state, 'ready');
  const result = (await run('jobs.result', jobInput)).run.data.result;
  const zip = Buffer.from(result.content, 'base64'), files = unzipTestStored(zip);
  timingMs.exportWall = Math.round(performance.now() - beganExport);
  timingMs.exportWorker = job.elapsedMs;
  assert.equal(sha(zip), result.sha256);
  assert.equal(zip.length, result.byteLength);
  const manifest = JSON.parse(files['production.json'].toString()), hero = seed.assets[0];
  const manifestHero = manifest.assets.find((a: { id: string }) => a.id === hero.id);
  assert.equal(manifestHero.approved, true);
  assert.equal(manifestHero.version, 1);
  const heroPixels = composite(hero, hero.frames[0].id).data;
  assert.deepEqual(decodeTestPng(files[manifestHero.png]).data, heroPixels);
  const atlas = unzipTestStored(files[manifest.atlas]), atlasImg = decodeTestPng(atlas['image.png']);
  const atlasJson = JSON.parse(atlas['image.json'].toString());
  assert.deepEqual(atlasJson.meta.pxl.assets[hero.id].pivot, hero.metadata.pivot);
  assert.deepEqual(atlasJson.meta.pxl.assets[hero.id].hitbox, hero.metadata.hitbox);
  const packed = Object.entries(atlasJson.frames).find(([key]) => key.endsWith(`_${hero.id.slice(0, 8)}_0`))?.[1] as { frame: { x: number; y: number; w: number; h: number } };
  assert.deepEqual([packed.frame.w, packed.frame.h], [hero.w, hero.h]);
  for (let y = 0; y < hero.h; y++) {
    const start = (packed.frame.y + y) * atlasImg.w + packed.frame.x;
    assert.deepEqual(atlasImg.data.slice(start, start + hero.w), heroPixels.slice(y * hero.w, (y + 1) * hero.w));
  }
  assert.deepEqual([decodeTestPng(files[manifest.scene.image]).w, manifest.scene.placements.length], [224, 3]);
  assert.deepEqual(readFileSync(pathname), before);
  const direct = async (operation: string, input: object, expectedRevision?: number) => {
    calls++;
    const response = await fetch(url.origin + agentPath, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify(request(operation, input, expectedRevision)) });
    return response.json();
  };
  const cancelId = (await direct('package.start', params, saved.revision)).data.job.id;
  assert.equal((await direct('jobs.cancel', { jobId: cancelId })).data.job.state, 'canceled');
  assert.equal((await direct('jobs.result', { jobId: cancelId })).error.code, 'NOT_READY');
  const updated = await run('asset.rename', { assetId: hero.id, name: 'Lữ khách đã đổi tên' }, saved.revision, true);
  assert.equal(updated.code, 0);
  const next = updated.run.revision;
  assert.equal(next, saved.revision + 1);
  const stale = await run('asset.rename', { assetId: hero.id, name: 'Bản ghi cũ' }, saved.revision, true);
  assert.equal(stale.code, 4);
  assert.equal(stale.run.error.code, 'STALE_REVISION');
  assert.equal((await run('jobs.result', jobInput)).run.error.code, 'STALE_REVISION');
  const rollback = await run('project.rollback', { snapshotId: updated.run.data.receipt.snapshotId }, next, true);
  assert.equal(rollback.run.revision, next + 1);
  const restored = store.load(saved.id, true).assets[0];
  assert.equal(restored.name, hero.name);
  assert.equal(restored.layers[0].locked, true);
  assert.deepEqual(composite(restored, restored.frames[0].id).data, heroPixels);
  const evidence = process.env.PXL_S5_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'mini-rpg-agent.zip'), zip);
    writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ inference: 0, requestCount: calls + 4, timingMs, job, manifest,
      mutation: updated.run.data.receipt, stale: stale.run.error.code, rollback: rollback.run.data.receipt, lockedRgbaUnchanged: true }, null, 2));
  }
});

test('S5 rejects invalid or unapproved edits and reads fingerprint drift without writing it', async t => {
  const { root, store, saved } = fixture();
  const app = await serveStudio(root, { port: 0, agentWriteToken: token });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const origin = new URL(app.url).origin;
  const call = async (operation: string, input: object, projectId?: string, expectedRevision?: number) => {
    const response = await fetch(origin + agentPath, { method: 'POST', headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: 1, operation, input, projectId, expectedRevision }) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await call('project.get', {}, '../other')).value.error.code, 'INVALID_REQUEST');
  const created = await call('project.create', { name: 'Tệp biệt lập', width: 4, height: 4 }, undefined, 0);
  assert.equal(created.value.revision, 1);
  const painting = await call('asset.create', { name: 'Một pixel', width: 1, height: 1, rgba: [0xabcdef80] }, created.value.projectId, 1);
  assert.equal(painting.value.revision, 2);
  const made = store.load(created.value.projectId, true).assets[1];
  assert.equal(celFor(made, made.layers[0].id, made.frames[0].id)?.data?.[0], 0xabcdef80);
  const current = store.load(saved.id), draft = newAsset('V2 chưa duyệt', 16, 16), version = { id: 'shield-v3-ok' };
  current.assets.push(draft, { ...structuredClone(current.assets[1]), id: version.id, name: 'V3 đã duyệt' });
  const lib = current.studio!.library!;
  lib[rpgIds.sword] = { kind: 'object', groupId: rpgIds.sword, version: 1 };
  lib[draft.id] = { kind: 'object', groupId: rpgIds.sword, version: 2 };
  lib[version.id] = { kind: 'object', groupId: rpgIds.sword, version: 3 };
  const approved = current.studio!.production!.assets.find(a => a.assetId === rpgIds.sword)!.approved!;
  current.studio!.production!.assets.push({ assetId: version.id, approved: { ...approved, version: 3 }, kind: 'prop', profileId: null });
  const fixtureRev = store.save(saved.id, saved.revision, current).revision;
  const placement = { sceneId: 'village', placementId: null, assetId: draft.id, tagId: null, x: 2, y: 3 };
  const manifest = join(store.dir(saved.id), 'pxl.project.json'), before = readFileSync(manifest);
  assert.equal((await call('scene.place', placement, saved.id, fixtureRev)).value.error.code, 'STALE_SOURCE');
  assert.equal((await call('asset.create', { name: 'Sai', width: 2, height: 1, rgba: [0] }, saved.id, fixtureRev)).value.error.code, 'INVALID_REQUEST');
  assert.deepEqual(readFileSync(manifest), before);
  let revision = (await call('collection.membership', { collectionId: 'release-pack', assetId: rpgIds.sword, include: true }, saved.id, fixtureRev)).value.revision;
  const selection = { collectionId: 'release-pack', assetId: rpgIds.sword };
  assert.equal((await call('collection.selectVersion', { ...selection, replacementId: draft.id }, saved.id, revision)).value.error.code, 'STALE_SOURCE');
  revision = (await call('collection.selectVersion', { ...selection, replacementId: version.id }, saved.id, revision)).value.revision;
  revision = (await call('asset.assignProfile', { assetId: version.id, profileId: 'rpg-style' }, saved.id, revision)).value.revision;
  revision = (await call('scene.place', { ...placement, assetId: version.id }, saved.id, revision)).value.revision;
  const check = store.load(saved.id);
  assert.equal(check.revision, revision);
  assert.ok(check.studio?.production?.collections[0].assets.includes(version.id));
  assert.equal(check.studio?.production?.assets.find(a => a.assetId === version.id)?.profileId, 'rpg-style');
  assert.equal(check.studio?.production?.scenes[0].placements.at(-1)?.stamp.version, 3);
  const untouched = store.create('Chưa mở'), untouchedPath = join(store.dir(untouched.id), 'pxl.project.json');
  const tampered = JSON.parse(readFileSync(untouchedPath, 'utf8'));
  tampered.document.name = 'Thay đổi bên ngoài';
  const foreign = JSON.stringify(tampered);
  writeFileSync(untouchedPath, foreign);
  assert.equal((await call('project.get', {}, untouched.id)).value.error.code, 'STALE_REVISION');
  assert.equal((await call('projects.list', {})).value.data.projects.some((p: { id: string }) => p.id === untouched.id), false);
  assert.equal(readFileSync(untouchedPath, 'utf8'), foreign);
});
