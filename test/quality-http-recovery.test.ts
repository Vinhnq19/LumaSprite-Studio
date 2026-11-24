import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualityJournal, type QualityJournalRecord } from '../src/node/studio/quality-journal.ts';
import { QualityCliTransport } from '../src/node/studio/quality-cli.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { motionFixture } from './quality-motion-fixture.ts';

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'pxl-http-journal-test-'));
  const cliRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lumasprite-quality-cli-')));
  const store = new PixelStore(projectRoot), doc = store.create('Khôi phục HTTP', 16, 16);
  const journal = new QualityJournal(store);
  const record: QualityJournalRecord = { version: 1, approvalId: 'approved', prompt: 'test', style: 'RPG', cliRoot, ownerPid: process.pid, ownerClosed: true, snapshotId: 'snapshot',
    run: { version: 1, id: 'recovery', projectId: doc.id, revision: doc.revision, status: 'unknown', stage: 'builder', started: Date.now(), deadline: Date.now() + 1000,
      cliCalls: 1, technicalRepairs: 0, message: 'interrupted', variants: [], calls: [{ id: 'builder', role: 'builder', provider: 'deepseek', transport: 'http', repair: false, started: Date.now(), deadline: Date.now() + 1000, status: 'unknown' }] } };
  return { record, journal, cliRoot, close() { rmSync(projectRoot, { recursive: true, force: true }); rmSync(cliRoot, { recursive: true, force: true }); } };
}

test('dead HTTP owner releases recovery without a receipt; live closed owner without drain proof stays unknown', async () => {
  const x = fixture();
  try {
    assert.equal(await x.journal.recover(x.record, false), false);
    assert.equal(x.record.run.status, 'unknown');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0); const pid = Number(child.stdout); assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    x.record.ownerPid = pid;
    assert.equal(await x.journal.recover(x.record, false), true);
    assert.equal(x.record.run.status, 'failed'); assert.match(x.record.run.message, /chưa xác nhận/i);
    assert.equal(x.journal.get(x.record.run.projectId, x.record.run.id).run.calls[0].status, 'failed');
  } finally { x.close(); }
});

test('real transport drain receipt authorizes local recovery only for its exact owner, call and snapshot', async () => {
  const x = fixture(), base = motionFixture().recipe;
  let resolveFetch!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const key = 'http-journal-test-key-never-real';
  const transport = new QualityCliTransport(() => ({ promise: Promise.resolve([
    { name: 'source-recipe.json', data: Buffer.from(JSON.stringify(base)) },
    { name: 'resource-index.json', data: Buffer.from('{"sources":[],"masks":[],"parts":[]}') },
  ]), stop: async () => true }), { deepseek: { apiKey: key, fetch: (() => { entered(); return new Promise<Response>(r => { resolveFetch = r; }); }) as typeof fetch } });
  x.record.cliRoot = transport.root;
  const task = transport.execute({ role: 'builder', provider: 'deepseek', callId: 'builder', snapshotId: 'snapshot', budgetMs: 5000, deadline: Date.now() + 5000, instruction: 'fixture', images: [] });
  try {
    await started;
    assert.equal(await task.stop(Date.now() + 10), false);
    assert.equal(await x.journal.recover(x.record, false), false, 'ownerClosed does not prove HTTP drain');
    resolveFetch(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await assert.rejects(task.promise);
    const receiptPath = join(transport.root, 'builder', 'http-settled-receipt.json');
    const receiptText = readFileSync(receiptPath, 'utf8'); assert.ok(!receiptText.includes(key));
    const receipt = JSON.parse(receiptText);
    for (const field of ['ownerPid', 'callId', 'snapshotId']) {
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, [field]: field === 'ownerPid' ? process.pid + 1 : 'foreign' }));
      assert.equal(await x.journal.recover(x.record, false), false, field);
    }
    writeFileSync(receiptPath, receiptText);
    x.record.ownerClosed = false;
    assert.equal(await x.journal.recover(x.record, false), false, 'a live open owner retains its job');
    x.record.ownerClosed = true;
    assert.equal(await x.journal.recover(x.record, true), true);
    assert.equal(x.record.run.status, 'canceled'); assert.match(x.record.run.message, /chưa xác nhận/i);
  } finally { resolveFetch?.(new Response('')); await task.promise.catch(() => {}); await transport.close(); x.close(); }
});

test('HTTP recovery does not trust a root outside its owned temporary namespace', async () => {
  const x = fixture();
  try { x.record.cliRoot = join(x.cliRoot, 'nested'); mkdirSync(x.record.cliRoot); assert.equal(await x.journal.recover(x.record, false), false); }
  finally { x.close(); }
});

test('dead HTTP owners do not bypass symlink, call-ID and root identity guards', async () => {
  const x = fixture(), originalRoot = x.cliRoot, alias = originalRoot + '-alias';
  try {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0); x.record.ownerPid = Number(child.stdout);
    assert.throws(() => process.kill(x.record.ownerPid, 0), { code: 'ESRCH' });
    symlinkSync(originalRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    x.record.cliRoot = alias;
    assert.equal(await x.journal.recover(x.record, false), false, 'symlink root');
    x.record.cliRoot = originalRoot; const callDir = join(originalRoot, 'builder');
    symlinkSync(originalRoot, callDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await x.journal.recover(x.record, false), false, 'symlink call directory');
    unlinkSync(callDir); x.record.run.calls[0].id = '../outside';
    assert.equal(await x.journal.recover(x.record, false), false, 'malformed call ID');
    x.record.run.calls[0].id = 'builder';
    rmSync(originalRoot, { recursive: true, force: true });
    assert.equal(await x.journal.recover(x.record, false), true, 'dead local process cannot own a live HTTP request even after temporary data was removed');
  } finally { try { unlinkSync(alias); } catch {} x.close(); }
});
