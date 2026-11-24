import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { QualityEngine, QualityTechnicalError } from '../src/node/studio/quality-engine.ts';
import type { QualityOwnedTask, QualityPorts, QualityExecution, QualityPrepared, QualityValidated, QualityStartInput } from '../src/node/studio/quality-ports.ts';
import type { QualityRun, QualityRole, QualityVariantSummary } from '../src/studio/quality/run.ts';
import { parseQualityJson } from '../src/studio/quality/json.ts';
import { validateQualityDirector, validateQualityBuilder, validateQualityReview, type QualityDirector } from '../src/studio/quality/protocol.ts';
import { createRecipeRenderer } from '../src/studio/quality/renderer.ts';
import { encodePng } from '../src/node/png.ts';
import { qualityRgbaHash } from '../src/node/studio/quality-digest.ts';
import { motionFixture } from './quality-motion-fixture.ts';

function done<T>(value: T): QualityOwnedTask<T> { return { promise: Promise.resolve(value), stop: async () => true }; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness() {
  const base = motionFixture().recipe; base.frames = base.frames.slice(0, 1);
  const context = { sources: [], masks: [] }, busy = new Set<string>(), events: QualityRun[] = [], calls: QualityExecution[] = [], dropped: string[] = [];
  const variants = new Map<string, typeof base>(); let counter = 0, revision = 7, releases = 0;
  const input: QualityStartInput = { projectId: 'project', revision, prompt: 'Tạo kiếm sáng, viền mảnh', style: 'RPG fantasy ánh sáng trái trên', context: { recipe: base } };
  const rawDirector = { version: 1, description: 'Kế hoạch', materials: base.materials, parts: base.parts.map(({ paint: _, ...p }) => p), allowedOperations: ['rect', 'line', 'pixels'] };
  const prepared = (): QualityPrepared => ({ snapshotId: `snapshot-${++counter}`, base: structuredClone(base), context, structureLocked: true, sourceImages: [{ name: 'source.png', data: encodePng(createRecipeRenderer(base).renderFrame('rest').image) }] });
  const output = (role: QualityRole): string => JSON.stringify(role === 'director' ? rawDirector : role === 'builder' ? { version: 1, description: 'Bản dựng', recipe: base } : { version: 1, description: 'Giữ nét', decision: 'keep', patches: [] });
  const ports: QualityPorts = {
    acquire(id) { if (busy.has(id)) throw new Error('busy'); busy.add(id); return { check() { if (!busy.has(id)) throw new Error('lease expired'); }, release() { busy.delete(id); releases++; } }; },
    assertCurrent(_id, value) { if (value !== revision) throw new Error('stale revision'); },
    prepare: () => done(prepared()),
    execute(request) { calls.push(request); return done({ output: output(request.role) }); },
    validate(role, text, p, director, candidateId) {
      try {
        const value = parseQualityJson(text);
        if (role === 'director') return done({ kind: 'director', director: validateQualityDirector(value, p.base, p.context, true) });
        const candidate = role === 'builder' ? validateQualityBuilder(value, p.base, director!, p.context) : validateQualityReview(value, p.base, director!, variants.get(candidateId!)!, p.context);
        const id = `variant-${++counter}`, renderer = createRecipeRenderer(candidate.recipe);
        variants.set(id, candidate.recipe);
        return done({ kind: 'variant', variant: { id, kind: role === 'builder' ? 'builder' : 'reviewed', description: candidate.description, w: base.canvas.w, h: base.canvas.h, loop: base.loop,
          frames: candidate.recipe.frames.map(f => ({ id: f.id, durationMs: f.durationMs, rgbaSha256: qualityRgbaHash(renderer.renderFrame(f.id).image.data) })) }, images: [{ name: 'review.png', data: encodePng(renderer.renderFrame('rest').image) }] });
      } catch (e) { return { promise: Promise.reject(new QualityTechnicalError((e as Error).message)), stop: async () => true }; }
    },
    drop(id) { dropped.push(id); },
  };
  return { ports, base, rawDirector, input, events, calls, busy, dropped, prepared, output, get releases() { return releases; }, setRevision(v: number) { revision = v; } };
}
const limits = { director: 1000, builder: 1000, reviewer: 1000, total: 5000, local: 1000, stop: 30 };

test('character guidance applies only to new unlocked humanoid sprites and reserves local review time', async () => {
  for (const [prompt, source, expected] of [
    ['Forest knight, complete silhouette, readable equipment', 'blank', true],
    ['Steel-and-scarlet RPG knight, thin outlines, coherent materials', 'blank', true],
    ['Naturally proportioned fantasy traveler, shaped contours rather than enlarged tiny sprite', 'blank', true],
    ['Tạo hiệp sĩ cầm kiếm', 'blank', true],
    ['Draw a sprite of an adventurer wearing a cloak', 'blank', true],
    ['Shield for a forest knight', 'blank', false],
    ['Knight helmet icon', 'blank', false],
    ['Forest knight', 'painted', false],
    ['Forest knight', 'motion', false],
  ] as const) {
    const h = harness(), engine = new QualityEngine(h.ports, { limits });
    h.input.prompt = prompt;
    h.ports.prepare = () => {
      const prepared = h.prepared();
      prepared.structureLocked = source === 'motion';
      if (source === 'blank') for (const part of prepared.base.parts) part.paint = [];
      return done(prepared);
    };
    try {
      const run = await engine.wait(engine.start(h.input).id);
      assert.equal(run.status, 'ready', run.message);
      assert.equal(h.calls[2].staticCharacterReview === true, expected, prompt);
      assert.equal(h.calls[1].reasoningEffort === 'low', expected, prompt);
      if (expected) assert.ok(h.calls[2].budgetMs <= 950, prompt);
    } finally { await engine.close(); }
  }
});

test('completed quality run registers an immutable local variant and emits it without another CLI call', async () => {
  const h = harness(), engine = new QualityEngine(h.ports, { limits, emit: r => h.events.push(r) });
  try {
    const ready = await engine.wait(engine.start(h.input).id), parent = ready.variants[1];
    const local: QualityVariantSummary = { ...structuredClone(parent), id: 'local-1', kind: 'edited', parentVariantId: parent.id };
    const registered = engine.addRetouchVariant(ready.id, local);
    assert.equal(registered.selectedVariantId, local.id); assert.equal(registered.variants.length, 3);
    assert.equal(registered.cliCalls, 3); assert.equal(registered.technicalRepairs, 0); assert.equal(h.calls.length, 3);
    assert.deepEqual(registered.calls, ready.calls);
    assert.equal(h.events.at(-1)!.variants.at(-1)!.parentVariantId, parent.id);
    local.frames[0].durationMs = 9; registered.variants[2].description = 'modified';
    assert.equal(engine.get(ready.id).variants[2].frames[0].durationMs, 100);
    assert.notEqual(engine.get(ready.id).variants[2].description, 'modified');
    h.setRevision(8);
    assert.throws(() => engine.addRetouchVariant(ready.id, { ...structuredClone(parent), id: 'local-stale', kind: 'edited', parentVariantId: parent.id }), /stale/);
    assert.equal(engine.get(ready.id).variants.length, 3);
  } finally { await engine.close(); }
});

test('local variant registration rejects foreign parent, changed frame structure, duplicate IDs and capacity overflow', async () => {
  const h = harness(), engine = new QualityEngine(h.ports, { limits });
  try {
    const ready = await engine.wait(engine.start(h.input).id), parent = ready.variants[1];
    const local: QualityVariantSummary = { ...structuredClone(parent), id: 'local-new', kind: 'edited', parentVariantId: parent.id };
    for (const edit of [
      (v: QualityVariantSummary) => { v.parentVariantId = 'foreign'; },
      (v: QualityVariantSummary) => { v.parentVariantId = undefined; },
      (v: QualityVariantSummary) => { v.kind = 'builder'; },
      (v: QualityVariantSummary) => { v.id = parent.id; },
      (v: QualityVariantSummary) => { v.w++; },
      (v: QualityVariantSummary) => { v.loop = !v.loop; },
      (v: QualityVariantSummary) => { v.frames[0].id = 'foreign-frame'; },
      (v: QualityVariantSummary) => { v.frames[0].durationMs++; },
      (v: QualityVariantSummary) => { v.frames[0].rgbaSha256 = 'invalid'; },
    ]) {
      const value = structuredClone(local); edit(value);
      assert.throws(() => engine.addRetouchVariant(ready.id, value));
      assert.equal(engine.get(ready.id).variants.length, 2);
    }
    for (let i = 0; i < 18; i++) engine.addRetouchVariant(ready.id, { ...structuredClone(local), id: `local-${i}` });
    assert.equal(engine.get(ready.id).variants.length, 20);
    assert.throws(() => engine.addRetouchVariant(ready.id, { ...structuredClone(local), id: 'local-overflow' }));
    assert.equal(h.calls.length, 3);
    await engine.closeProject('project');
    assert.throws(() => engine.addRetouchVariant(ready.id, local));
  } finally { await engine.close(); }
});
async function until(test: () => boolean) { for (let i = 0; i < 200; i++) { if (test()) return; await nextTurn(); } assert.fail('Expected observable stage did not start'); }

test('three-role run uses Codex/DeepSeek/Codex, frozen context, real fixture PNGs and compact immutable events', async () => {
  const h = harness(), engine = new QualityEngine(h.ports, { limits, emit: r => h.events.push(r) });
  try {
    const started = engine.start(h.input); h.input.prompt = 'changed'; h.input.style = 'changed';
    const result = await engine.wait(started.id);
    assert.equal(result.status, 'ready'); assert.equal(result.cliCalls, 3); assert.equal(result.technicalRepairs, 0);
    assert.deepEqual(h.calls.map(c => [c.role, c.provider]), [['director', 'codex'], ['builder', 'deepseek'], ['reviewer', 'codex']]);
    assert.deepEqual(result.calls.map(c => c.transport), ['cli', 'http', 'cli']);
    assert.ok(h.calls.every(c => c.snapshotId === h.calls[0].snapshotId));
    assert.ok(h.calls[0].instruction.includes('Tạo kiếm sáng')); assert.ok(!h.calls[0].instruction.includes('Hồ sơ mỹ thuật: changed'));
    assert.equal(h.calls[2].images.length, 2); assert.deepEqual([...h.calls[2].images[1].data.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(result.variants.length, 2); assert.equal(h.releases, 1); assert.equal(h.busy.size, 0);
    const serialized = JSON.stringify(h.events); for (const forbidden of ['instruction', 'sourceImages', 'paint', 'pixels', 'rawOutput']) assert.ok(!serialized.includes('"' + forbidden + '"'));
    result.variants[0].description = 'tampered'; assert.equal(engine.get(started.id).variants[0].description, 'Bản dựng');
  } finally { await engine.close(); }
});
test('HTTP usage/model metadata is retained and incompatible transport does not consume a repair', async () => {
  for (const mismatch of [false, true]) {
    const h = harness();
    h.ports.execute = r => {
      h.calls.push(r);
      return done({ output: h.output(r.role), transport: r.role === 'builder' && !mismatch ? 'http' as const : 'cli' as const,
        model: r.role === 'builder' ? 'deepseek-aideepseek-v4.1-flash-1017' : 'invalid\nmodel', usage: { input: 19, output: 13 } });
    };
    const engine = new QualityEngine(h.ports, { limits });
    try {
      const result = await engine.wait(engine.start(h.input).id);
      assert.equal(result.status, mismatch ? 'failed' : 'ready');
      assert.equal(result.cliCalls, mismatch ? 2 : 3); assert.equal(result.technicalRepairs, 0);
      assert.equal(result.calls[0].model, undefined); assert.equal(h.busy.size, 0);
      if (mismatch) assert.match(result.message, /Transport/);
      else { assert.equal(result.calls[1].model, 'deepseek-aideepseek-v4.1-flash-1017'); assert.deepEqual(result.calls[1].usage, { input: 19, output: 13 }); }
    } finally { await engine.close(); }
  }
});
test('confirmed local HTTP cancellation releases the lease without claiming remote processing stopped', async () => {
  const h = harness(), pending = deferred<{ output: string }>();
  h.ports.execute = r => {
    h.calls.push(r);
    return r.role === 'builder' ? { promise: pending.promise, stop: async () => true } : done({ output: h.output(r.role) });
  };
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const start = engine.start(h.input); await until(() => h.calls.length === 2);
    const result = await engine.cancel(start.id);
    assert.equal(result.status, 'canceled'); assert.equal(result.calls[1].transport, 'http');
    assert.match(result.message, /cục bộ đã dừng/); assert.match(result.message, /chưa xác nhận.*DeepSeek/);
    assert.equal(h.busy.size, 0); assert.equal(h.releases, 1);
    pending.resolve({ output: h.output('builder') }); await engine.wait(start.id);
    assert.equal(h.calls.length, 2); assert.equal(engine.get(start.id).variants.length, 0);
  } finally { pending.resolve({ output: h.output('builder') }); await engine.close(); }
});
test('later confirmation after unknown HTTP cancellation still discloses remote processing uncertainty', async () => {
  const h = harness(), pending = deferred<{ output: string }>(); let confirmed = false;
  h.ports.execute = r => { h.calls.push(r); return r.role === 'builder' ? { promise: pending.promise, stop: async () => confirmed } : done({ output: h.output(r.role) }); };
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const start = engine.start(h.input); await until(() => h.calls.length === 2);
    assert.equal((await engine.cancel(start.id)).status, 'unknown'); assert.equal(h.busy.size, 1);
    pending.resolve({ output: h.output('builder') }); await engine.wait(start.id); confirmed = true;
    const result = await engine.cancel(start.id);
    assert.equal(result.status, 'canceled'); assert.match(result.message, /chưa xác nhận.*DeepSeek/);
    assert.equal(h.busy.size, 0); assert.equal(h.releases, 1); assert.equal(h.calls.length, 2);
  } finally { confirmed = true; pending.resolve({ output: h.output('builder') }); await engine.close(); }
});
test('confirmed builder timeout retains sanitized HTTP progress in the run and call', async () => {
  const h = harness(), pending = deferred<{ output: string }>();
  const diagnosis = 'Đã nhận HTTP 200, 2 event, 180 byte SSE, 0 byte nội dung; chưa xác nhận nhà cung cấp DeepSeek đã dừng.';
  h.ports.execute = request => {
    h.calls.push(request);
    return request.role === 'builder' ? { promise: pending.promise, stop: async () => true, diagnostic: () => diagnosis }
      : done({ output: h.output(request.role) });
  };
  const engine = new QualityEngine(h.ports, { limits: { ...limits, builder: 50 } });
  try {
    const result = await engine.wait(engine.start(h.input).id);
    assert.equal(result.status, 'failed');
    assert.ok(result.message.includes(diagnosis));
    assert.equal(result.calls[1].message, result.message);
    assert.equal(result.cliCalls, 2);
    assert.equal(h.busy.size, 0);
  } finally { pending.resolve({ output: h.output('builder') }); await engine.close(); }
});
test('one technical repair is shared and does not reset the role deadline or exceed four attempts', async () => {
  const h = harness(), execute = h.ports.execute; let builderCalls = 0;
  h.ports.execute = r => { const task = execute(r); if (r.role === 'builder' && builderCalls++ === 0) return done({ output: '{broken' }); return task; };
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const result = await engine.wait(engine.start(h.input).id);
    assert.equal(result.status, 'ready'); assert.equal(result.cliCalls, 4); assert.equal(result.technicalRepairs, 1);
    const attempts = result.calls.filter(c => c.role === 'builder'); assert.equal(attempts[0].deadline, attempts[1].deadline); assert.equal(attempts[1].repair, true);
  } finally { await engine.close(); }
});
test('a repair used by director is not available again for invalid builder/reviewer output', async () => {
  const h = harness(); let directors = 0;
  h.ports.execute = r => { h.calls.push(r); return done({ output: r.role === 'director' && directors++ > 0 ? h.output(r.role) : 'not JSON' }); };
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const result = await engine.wait(engine.start(h.input).id);
    assert.equal(result.status, 'failed'); assert.equal(result.cliCalls, 3); assert.equal(result.technicalRepairs, 1); assert.equal(h.busy.size, 0);
  } finally { await engine.close(); }
});
test('CLI quota/login/missing failures are not treated as JSON repair or switched to another provider', async () => {
  for (const message of ['quota exhausted', 'login expired', 'CLI missing']) {
    const h = harness(); h.ports.execute = r => { h.calls.push(r); return { promise: Promise.reject(new Error(message)), stop: async () => true }; };
    const engine = new QualityEngine(h.ports, { limits });
    try { const r = await engine.wait(engine.start(h.input).id); assert.equal(r.status, 'failed'); assert.equal(r.cliCalls, 1); assert.equal(r.technicalRepairs, 0); assert.equal(r.message, message); }
    finally { await engine.close(); }
  }
});
test('stale project after a role completes fails without executing the next role or losing failure history', async () => {
  const h = harness(), execute = h.ports.execute;
  h.ports.execute = r => { const value = execute(r); h.setRevision(8); return value; };
  const engine = new QualityEngine(h.ports, { limits });
  try { const r = await engine.wait(engine.start(h.input).id); assert.equal(r.status, 'failed'); assert.match(r.message, /stale/); assert.equal(r.cliCalls, 1); assert.equal(h.releases, 1); }
  finally { await engine.close(); }
});
test('shared lease blocks a second tab and confirmed cancellation releases it before returning', async () => {
  const h = harness(), pending = deferred<{ output: string }>(); h.ports.execute = r => { h.calls.push(r); return { promise: pending.promise, stop: async () => true }; };
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const first = engine.start(h.input); await until(() => h.calls.length === 1);
    assert.throws(() => engine.start(h.input), /busy/);
    assert.equal((await engine.cancel(first.id)).status, 'canceled'); assert.equal(h.busy.size, 0); assert.equal(h.releases, 1);
    pending.resolve({ output: h.output('director') }); await engine.wait(first.id); assert.equal(h.calls.length, 1); assert.equal(engine.get(first.id).variants.length, 0);
  } finally { await engine.close(); }
});
test('unknown stop retains the busy gate and late results; a later confirmed stop releases exactly once', async () => {
  const h = harness(), pending = deferred<{ output: string }>(); let confirmed = false;
  h.ports.execute = r => { h.calls.push(r); return { promise: pending.promise, stop: async () => confirmed }; };
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const start = engine.start(h.input); await until(() => h.calls.length === 1);
    assert.equal((await engine.cancel(start.id)).status, 'unknown'); assert.equal((await engine.wait(start.id)).calls[0].status, 'unknown');
    assert.throws(() => engine.start(h.input), /busy/); assert.throws(() => engine.dispose(start.id)); assert.equal(h.releases, 0);
    pending.resolve({ output: h.output('director') }); await nextTurn(); assert.equal(h.calls.length, 1); assert.equal(engine.get(start.id).status, 'unknown');
    confirmed = true; const stopped = await engine.cancel(start.id); assert.equal(stopped.status, 'canceled'); assert.equal(stopped.calls[0].status, 'canceled'); assert.equal(h.releases, 1);
  } finally { confirmed = true; await engine.close(); }
});
test('late preparation is not deleted while stop is unknown; cleanup happens after confirmation', async () => {
  const h = harness(), pending = deferred<QualityPrepared>(); let confirmed = false;
  h.ports.prepare = () => ({ promise: pending.promise, stop: async () => confirmed });
  const engine = new QualityEngine(h.ports, { limits });
  try {
    const start = engine.start(h.input); assert.equal((await engine.cancel(start.id)).status, 'unknown');
    const late = h.prepared(); pending.resolve(late); await nextTurn(); assert.deepEqual(h.dropped, []);
    confirmed = true; await engine.cancel(start.id); await engine.wait(start.id); assert.deepEqual(h.dropped, [late.snapshotId]); assert.equal(h.calls.length, 0);
  } finally { confirmed = true; await engine.close(); }
});
test('role and whole-run deadlines stop owned tasks, discard late success and bound a hanging stop', async () => {
  const h = harness(), pending = deferred<{ output: string }>(); let stops = 0;
  h.ports.execute = r => { h.calls.push(r); return { promise: pending.promise, stop: async () => { stops++; return true; } }; };
  const engine = new QualityEngine(h.ports, { limits: { ...limits, director: 30 } });
  try {
    const r = await engine.wait(engine.start(h.input).id); assert.equal(r.status, 'failed'); assert.match(r.message, /thời gian/); assert.equal(stops, 1); assert.equal(r.calls[0].status, 'failed');
    pending.resolve({ output: h.output('director') }); await nextTurn(); assert.equal(h.calls.length, 1);
  } finally { await engine.close(); }
  const other = harness(), stuck: QualityOwnedTask<{ output: string }> = { promise: new Promise(() => {}), stop: () => new Promise(() => {}) };
  other.ports.execute = r => { other.calls.push(r); return stuck; };
  const bounded = new QualityEngine(other.ports, { limits: { ...limits, total: 70, stop: 20 } });
  const result = await bounded.wait(bounded.start(other.input).id); assert.equal(result.status, 'unknown'); assert.equal(other.busy.size, 1);
  // Resolve ownership through the same handle without creating any new work.
  other.ports.execute = () => { throw Error('must not restart'); };
  assert.equal(result.cliCalls, 1);
  stuck.stop = async () => true; const stopped = await bounded.cancel(result.id); assert.equal(stopped.status, 'failed'); await bounded.close();
});
test('closing a project drains lazy previews, prevents concurrent restart, and keeps artifacts if drain is unconfirmed', async () => {
  const h = harness(), gate = deferred<boolean>(); h.ports.drain = () => gate.promise;
  const engine = new QualityEngine(h.ports, { limits: { ...limits, stop: 1000 } });
  const ready = await engine.wait(engine.start(h.input).id), closing = engine.closeProject('project');
  assert.throws(() => engine.start(h.input), /đóng/); gate.resolve(false);
  await assert.rejects(closing, /worker xem trước/); assert.equal(engine.get(ready.id).status, 'ready'); assert.equal(h.dropped.length, 0);
  h.ports.drain = async () => true; await engine.close(); assert.equal(h.dropped.length, 1);
});
test('server limits can only shorten the accepted budgets, never raise them', async () => {
  const h = harness(), engine = new QualityEngine(h.ports, { limits: { director: 9e9, builder: 9e9, reviewer: 9e9, total: 9e9, stop: 9e9 } });
  try {
    const r = await engine.wait(engine.start(h.input).id); assert.equal(r.status, 'ready'); assert.equal(r.deadline - r.started, 900000);
    h.calls.forEach((call, i) => assert.ok(call.budgetMs <= [90000, 300000, 240000][i]));
  } finally { await engine.close(); }
});
test('wall-clock changes cannot extend a repair or hide elapsed time', { timeout: 5000 }, async () => {
  const h = harness(), originalNow = Date.now, originalExecute = h.ports.execute; let builderCalls = 0;
  h.ports.execute = request => {
    if (request.role !== 'builder') return originalExecute(request);
    h.calls.push(request);
    if (builderCalls++ === 0) { Date.now = () => originalNow() - 3600000; return done({ output: 'invalid JSON' }); }
    return { promise: new Promise(() => {}), stop: async () => true };
  };
  const engine = new QualityEngine(h.ports, { limits: { ...limits, builder: 500 } });
  try {
    const result = await engine.wait(engine.start(h.input).id); assert.equal(result.status, 'failed'); assert.equal(result.technicalRepairs, 1);
    const attempts = h.calls.filter(c => c.role === 'builder'); assert.equal(attempts.length, 2); assert.equal(attempts[0].deadline, attempts[1].deadline);
    assert.ok(attempts[1].budgetMs <= 500); assert.ok(result.elapsedMs! >= 450 && result.elapsedMs! < 4000);
  } finally { Date.now = originalNow; await engine.close(); }
});
test('a reviewer failure retains the valid builder preview but never marks the run ready', async () => {
  const h = harness(), execute = h.ports.execute;
  h.ports.execute = r => r.role === 'reviewer' ? { promise: Promise.reject(new Error('review quota')), stop: async () => true } : execute(r);
  const engine = new QualityEngine(h.ports, { limits });
  try { const r = await engine.wait(engine.start(h.input).id); assert.equal(r.status, 'failed'); assert.equal(r.variants.length, 1); assert.equal(r.variants[0].kind, 'builder'); assert.equal(r.selectedVariantId, undefined); }
  finally { await engine.close(); }
});
test('project/server close stops work, forbids late revival and releases only owned snapshots', async () => {
  const h = harness(), pending = deferred<{ output: string }>(); h.ports.execute = r => { h.calls.push(r); return { promise: pending.promise, stop: async () => true }; };
  const engine = new QualityEngine(h.ports, { limits, emit: () => { throw Error('SSE disconnected'); } });
  const start = engine.start(h.input); await until(() => h.calls.length === 1); await engine.closeProject('project'); assert.equal(h.releases, 1); assert.equal(h.dropped.length, 1);
  pending.resolve({ output: h.output('director') }); await nextTurn(); assert.equal(engine.list('project').length, 0);
  await engine.close(); assert.throws(() => engine.start(h.input), /đóng/);
});
