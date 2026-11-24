import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startQualityProcess } from '../src/node/studio/quality-process.ts';

test('owned supervisor preserves argv, stdin and nonzero exit without invoking a shell', { timeout: 20000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'lumasprite-process-'));
  try {
    const script = join(work, 'fixture.cjs'); writeFileSync(script, `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),input:s}));console.error('fixture-error');process.exitCode=7;});`);
    const args = ['dấu tiếng Việt', '', 'a"b', 'C:\\trailing\\', '$() & ` ;'];
    const task = startQualityProcess({ executable: process.execPath, args: [script, ...args], cwd: work, input: 'prompt tiếng Việt\n\"\\', budgetMs: 15000 });
    const r = await task.promise; assert.equal(r.code, 7, r.stderr); assert.match(r.stderr, /fixture-error/);
    assert.deepEqual(JSON.parse(r.stdout), { args, input: 'prompt tiếng Việt\n\"\\' }); assert.equal(await task.stop(Date.now() + 1000), true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('cancel confirms both root and a spawned grandchild are stopped, keeps unrelated process alive', { timeout: 20000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'lumasprite-process-'));
  let pid = 0;
  try {
    const script = join(work, 'fixture.cjs'), mark = join(work, 'child.json');
    writeFileSync(script, `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(mark)},JSON.stringify({root:process.pid,child:p.pid}));setInterval(()=>{},1000);`);
    const task = startQualityProcess({ executable: process.execPath, args: [script], cwd: work, budgetMs: 15000 });
    const end = performance.now() + 10000;
    while (!existsSync(mark) && performance.now() < end) await new Promise(r => setTimeout(r, 25));
    assert.ok(existsSync(mark), 'fixture must launch within budget');
    const ids = JSON.parse(readFileSync(mark, 'utf8')); pid = ids.child;
    assert.equal(await task.stop(Date.now() + 5000), true); await assert.rejects(task.promise, /hủy/);
    for (const owned of [ids.root, ids.child]) assert.throws(() => process.kill(owned, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } rmSync(work, { recursive: true, force: true }); }
});

test('cancel before supervisor initialization never starts the provider and timeout stops owned work', { timeout: 20000 }, async () => {
  for (const immediate of [true, false]) {
    const work = mkdtempSync(join(tmpdir(), 'lumasprite-process-'));
    try {
      const task = startQualityProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: work, budgetMs: immediate ? 15000 : 1500 });
      if (immediate) assert.equal(await task.stop(Date.now() + 5000), true);
      await assert.rejects(task.promise, immediate ? /hủy/ : /thời gian/);
      assert.equal(await task.stop(Date.now() + 5000), true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

test('root exiting naturally cannot leave its grandchild running; oversized output and missing executable fail with confirmed shutdown', { timeout: 20000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'lumasprite-process-'));
  try {
    const mark = join(work, 'child.pid'), script = join(work, 'natural.cjs');
    writeFileSync(script, `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(mark)},String(p.pid));p.unref();`);
    const natural = startQualityProcess({ executable: process.execPath, args: [script], cwd: work, budgetMs: 10000 });
    const result = await natural.promise; assert.equal(result.code, 0, result.stderr); assert.throws(() => process.kill(Number(readFileSync(mark, 'utf8')), 0), { code: 'ESRCH' });
  } finally { rmSync(work, { recursive: true, force: true }); }
  for (const large of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'lumasprite-process-'));
    try {
      const task = startQualityProcess({ executable: large ? process.execPath : join(dir, 'missing.exe'), args: large ? ['-e', "process.stdout.write('x'.repeat(8100000))"] : [], cwd: dir, budgetMs: 10000 });
      await assert.rejects(task.promise, large ? /8 MB/ : /Không chạy được CLI/); assert.equal(await task.stop(Date.now() + 1000), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('owned CLI child never receives the server-only DeepSeek key but keeps unrelated environment', { timeout: 20000 }, async () => {
  const keyName = 'PXL_DEEPSEEK_API_KEY', mixedName = 'Pxl_DeepSeek_Api_Key', sentinelName = 'PXL_QUALITY_TEST_SENTINEL';
  const synthetic = 'synthetic-not-a-credential';
  // Snapshot exact existing spellings/values (Windows keeps one case-insensitive key) for restoration.
  const prior = Object.keys(process.env)
    .filter(name => name.toUpperCase() === keyName || name === sentinelName)
    .map(name => [name, process.env[name]] as const);
  const work = mkdtempSync(join(tmpdir(), 'lumasprite-process-'));
  try {
    // Mixed casing is set first so Windows keeps the canonical spelling as the live key.
    process.env[mixedName] = 'synthetic-mixed-case-not-a-credential';
    process.env[keyName] = synthetic;
    process.env[sentinelName] = 'sentinel-value';
    const script = join(work, 'env-fixture.cjs');
    // Report only a presence count and the sentinel: never print any environment value by key.
    writeFileSync(script, `const keys=Object.keys(process.env).filter(k=>k.toUpperCase()===${JSON.stringify(keyName)});console.log(JSON.stringify({leaked:keys.length,sentinel:process.env[${JSON.stringify(sentinelName)}]??null}));`);
    const task = startQualityProcess({ executable: process.execPath, args: [script], cwd: work, budgetMs: 15000 });
    const r = await task.promise;
    assert.equal(r.code, 0, r.stderr);
    const seen = JSON.parse(r.stdout);
    assert.equal(seen.leaked, 0, 'no casing variant of the DeepSeek key may reach the CLI child');
    assert.equal(seen.sentinel, 'sentinel-value');
    assert.equal(process.env[keyName], synthetic, 'process.env must not be mutated by the child environment');
    assert.equal(await task.stop(Date.now() + 1000), true);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (name.toUpperCase() === keyName || name === sentinelName) delete process.env[name];
    }
    for (const [name, value] of prior) if (value !== undefined) process.env[name] = value;
    rmSync(work, { recursive: true, force: true });
  }
});
