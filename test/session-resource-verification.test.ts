import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draft, Session } from '../studio/pixel/session.ts';
import { celFor, newAsset, newDocument, validateDocument, wireStringify, wireParse } from '../src/studio/pixel/model.ts';
import { snapshot } from '../src/studio/pixel/history.ts';

// Isolated browser transport: delayed responses exercise identity guards, not CLI/rendering.
function environment() {
  const originalFetch = globalThis.fetch, originalIDB = globalThis.indexedDB;
  const documents = new Map<string, any>(), words = new Map<string, Uint32Array>(), drafts = new Map<string, unknown>();
  let draftOpenGate: Promise<void> | undefined;
  let sequence = 1, saveGate: Promise<void> | undefined, readGate: Promise<void> | undefined, copyGate: Promise<void> | undefined, readError = false, mismatchBlob = false;
  let saved: (() => void) | undefined, reading: (() => void) | undefined, copying: (() => void) | undefined;
  const sessions: Session[] = [];
  const clone = (value: any) => wireParse(wireStringify(value));
  const digest = () => (sequence++).toString(16).padStart(64, '0');
  function persist(value: any) {
    const d = clone(value);
    for (const r of Object.values(d.studio?.resources ?? {}) as any[]) if (r.data) { r.blob = digest(); words.set(r.blob, r.data); delete r.data; }
    for (const a of d.assets) for (const c of Object.values(a.cels) as any[]) if (c.data) { c.blob = digest(); words.set(c.blob, c.data); delete c.data; }
    documents.set(d.id, d); return clone(d);
  }
  (globalThis as any).indexedDB = { open() {
    const request: any = {};
    const ready = () => {
      request.result = { close() {}, transaction() {
        const tx: any = { objectStore: () => ({
          get: (key: string) => ({ result: drafts.get(key) }),
          put: (value: unknown, key: string) => { drafts.set(key, structuredClone(value)); return {}; },
          delete: (key: string) => { drafts.delete(key); return {}; },
        }) };
        queueMicrotask(() => tx.oncomplete?.()); return tx;
      } }; request.onsuccess?.();
    };
    if (draftOpenGate) void draftOpenGate.then(ready);
    else queueMicrotask(ready);
    return request;
  } };
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input), 'http://resource.test'), id = url.pathname.split('/')[4], d = documents.get(id);
    if (init.method === 'POST' && url.pathname === '/api/pixel/projects') {
      const body = wireParse(init.body), result = persist({ ...body.document, id: body.document.id + '-copy', name: body.name, revision: 1 });
      copying?.(); if (copyGate) await copyGate;
      return new Response(wireStringify(result), { status: 201 });
    }
    if (init.method === 'PUT') {
      const body = wireParse(init.body), result = persist({ ...body.document, revision: body.revision + 1 });
      saved?.(); if (saveGate) await saveGate;
      return new Response(wireStringify(result), { status: 200 });
    }
    if (url.pathname.endsWith('/resource')) {
      if (readError) return new Response(JSON.stringify({ error: 'Tài nguyên bị hỏng' }), { status: 409 });
      const r = url.searchParams.has('blob') ? { version: 1, kind: url.searchParams.get('kind'), w: Number(url.searchParams.get('w')), h: Number(url.searchParams.get('h')), blob: url.searchParams.get('blob') } : clone(d.studio.resources[url.searchParams.get('resource')!]);
      r.data = words.get(r.blob)!.slice();
      if (mismatchBlob) r.blob = 'f'.repeat(64);
      reading?.(); if (readGate) await readGate;
      return new Response(wireStringify(r), { status: 200 });
    }
    if (url.pathname.endsWith('/cel')) {
      const id = url.searchParams.get('cel')!, asset = d.assets.find((a: any) => a.id === url.searchParams.get('asset')), cel = asset?.cels[id];
      const blob = url.searchParams.get('blob') ?? cel?.blob;
      return new Response(wireStringify({ ...cel, id, blob, data: words.get(blob)?.slice() }), { status: 200 });
    }
    throw new Error(`Unexpected transport ${init.method ?? 'GET'} ${url.pathname}`);
  }) as typeof fetch;
  return {
    persist, words, digest,
    delayDraftOpen() {
      let release!: () => void;
      draftOpenGate = new Promise<void>(resolve => { release = resolve; });
      return () => { draftOpenGate = undefined; release(); };
    },
    failRead(failed: boolean) { readError = failed; },
    mismatchBlob(mismatched: boolean) { mismatchBlob = mismatched; },
    session(doc = newDocument('Tài nguyên', 18, 18)): any { const session = new Session(); session.doc = clone(persist(doc)); session.normalize(); session.hold(); sessions.push(session); return session; },
    delaySave() { let release!: () => void, observed!: () => void; saveGate = new Promise(r => { release = r; }); const started = new Promise<void>(r => { observed = r; }); saved = observed; return { started, release: () => { release(); saveGate = undefined; } }; },
    delayRead() { let release!: () => void, observed!: () => void; readGate = new Promise(r => { release = r; }); const started = new Promise<void>(r => { observed = r; }); reading = observed; return { started, release: () => { release(); readGate = undefined; } }; },
    delayCopy() { let release!: () => void, observed!: () => void; copyGate = new Promise(r => { release = r; }); const started = new Promise<void>(r => { observed = r; }); copying = observed; return { started, release: () => { release(); copyGate = undefined; } }; },
    restore() { for (const s of sessions) { s.hold(); s.doc = undefined; } globalThis.fetch = originalFetch; (globalThis as any).indexedDB = originalIDB; },
  };
}
const mask = () => ({ version: 1 as const, kind: 'mask' as const, w: 3, h: 2, data: Uint32Array.from([0, 1, 0, 1, 1, 0]) });

test('Session resource verification: concurrent consumers of one pending read both receive the same validated resource', async () => {
  const env = environment();
  try {
    const doc = newDocument('Hai panel đọc một ảnh'); doc.studio = { version: 1, resources: { shared: mask() } };
    const session = env.session(doc), gate = env.delayRead(), first = session.loadResource('shared'); await gate.started;
    const second = session.loadResource('shared'); gate.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, session.doc.studio.resources.shared); assert.equal(b, a); assert.deepEqual(b.data, mask().data);
  } finally { env.restore(); }
});

test('Session undo preserves the v2 server extension boundary while older pixel/resource history remains undoable and redoable', async () => {
  const env = environment();
  try {
    const s = env.session();
    s.change('Tạo tài nguyên trước khi có rig', () => { s.doc.studio = { version: 1, resources: {} }; });
    const before = snapshot(s.doc), saved = snapshot(s.doc);
    before.studio = { ...before.studio, version: 2, quality: { version: 1, approvals: {} }, rigDrafts: {} };
    saved.studio = snapshot(before.studio); saved.assets.push(newAsset('Nguồn rig', 18, 18));
    s.history.commit(before, saved, 'Tạo nguồn rig'); s.doc = saved;
    await s.undo(); assert.equal(s.doc.assets.length, 1); validateDocument(s.doc);
    await s.undo(); assert.equal(s.doc.studio.version, 2); assert.deepEqual(s.doc.studio.resources, {}); assert.deepEqual(s.doc.studio.rigDrafts, {}); assert.deepEqual(s.doc.studio.quality.approvals, {}); validateDocument(s.doc);
    await s.undo(true); validateDocument(s.doc); assert.equal(s.doc.studio.version, 2);
    await s.undo(true); validateDocument(s.doc); assert.equal(s.doc.assets.length, 2);
  } finally { env.restore(); }
});

test('Session resources stay editable with undo after quality upgrades the document to studio v2', async () => {
  const env = environment();
  try {
    const d = newDocument('Đã có nguồn chất lượng'); d.studio = { version: 2, quality: { version: 1, approvals: {} }, rigDrafts: {} };
    const s = env.session(d); s.setResource('body', mask());
    s.changeResource('body', Uint32Array.from([1, 1, 0, 1, 1, 0]));
    await s.undo(); assert.deepEqual(s.doc.studio.resources.body.data, mask().data);
    await s.undo(true); assert.equal(s.doc.studio.resources.body.data[0], 1);
    assert.equal(s.doc.studio.version, 2); assert.deepEqual(s.doc.studio.quality.approvals, {}); assert.deepEqual(s.doc.studio.rigDrafts, {});
    s.doc.studio.version = 99; assert.throws(() => s.setResource('bad', mask()), /Phiên bản/);
  } finally { env.restore(); }
});

test('Session frame snapshot pins offscreen cels through compositing at the cache limit and releases them afterwards', async () => {
  const env = environment();
  try {
    const d = newDocument('Frame khóa'), a = d.assets[0]; a.frames.push({ id: 'offscreen', duration: 100 });
    celFor(a, a.layers[0].id, 'offscreen', true)!.data![0] = 0x70c989ff;
    const s = env.session(d), target = s.asset.cels[s.asset.layers[0].cels.offscreen];
    s.doc.studio = { version: 1, resources: { resident: { version: 1, kind: 'mask', w: 4096, h: 4096, blob: env.digest(), data: new Uint32Array(16_777_216) } } };
    const pixels = await s.readFrame('offscreen'); assert.equal(pixels[0], 0x70c989ff); assert.equal(s.frameId, a.frames[0].id);
    assert.equal(s.doc.studio.resources.resident.data, undefined, 'cache can reclaim unpinned resources during the read');
    pixels[0] = 0xffffffff; assert.equal(target.data[0], 0x70c989ff, 'snapshot does not alias cel data');
    assert.equal(s.pinnedCels.size, 0);
  } finally { env.restore(); }
});

test('Session resource verification: first-add undo keeps extension markers and lazy pixel-delta undo/redo preserves unchanged words', async () => {
  const env = environment();
  try {
    const s = env.session(); s.setResource('body', mask());
    await s.undo(); assert.deepEqual(s.doc.studio.resources, {}); assert.equal(s.doc.studio.version, 1);
    await s.undo(true); assert.deepEqual(s.doc.studio.resources.body.data, mask().data);
    s.release(); await s.flush(); s.hold();
    const old = s.doc.studio.resources.body.blob;
    s.changeResource('body', Uint32Array.from([1, 1, 0, 1, 1, 0]));
    s.release(); await s.flush(); s.hold();
    assert.notEqual(s.doc.studio.resources.body.blob, old);
    delete s.doc.studio.resources.body.data;
    await s.undo();
    assert.deepEqual(s.doc.studio.resources.body.data, mask().data);
    assert.equal(s.doc.studio.resources.body.blob, old);
    delete s.doc.studio.resources.body.data;
    await s.undo(true);
    assert.deepEqual(s.doc.studio.resources.body.data, Uint32Array.from([1, 1, 0, 1, 1, 0]));
  } finally { env.restore(); }
});

test('Session resource verification: delayed save cannot adopt an old hash when both sent and current buffers are unloaded', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Hash cache'); d.studio = { version: 1, resources: { body: mask() } };
    const s = env.session(d), old = s.doc.studio.resources.body.blob, replacement = env.digest();
    env.words.set(replacement, Uint32Array.from([1, 1, 0, 0, 0, 1]));
    s.change('Tên mới', () => { s.doc.name = 'Đang lưu'; });
    const delayed = env.delaySave(); s.release(); const save = s.flush(); await delayed.started;
    s.hold(); s.setResource('body', { ...s.doc.studio.resources.body, blob: replacement });
    delayed.release(); await save;
    assert.equal(s.doc.studio.resources.body.blob, replacement);
    assert.notEqual(s.doc.studio.resources.body.blob, old);
    assert.equal(s.dirty, true);
  } finally { env.restore(); }
});

test('Session resource verification: a late resource response cannot replace a newer edit or attach after project switch', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Nguồn'); d.studio = { version: 1, resources: { body: mask() } };
    const s = env.session(d), delayed = env.delayRead(), loading = s.loadResource('body'); await delayed.started;
    const next = Uint32Array.from([1, 0, 1, 0, 1, 0]); s.changeResource('body', next);
    delayed.release(); await Promise.resolve(loading).catch(() => {});
    assert.deepEqual(s.doc.studio.resources.body.data, next);
    const swapped = env.session(d), another = env.delayRead(), pending = swapped.loadResource('body'); await another.started;
    const replacement = newDocument('Dự án khác'); swapped.doc = replacement;
    another.release(); await Promise.resolve(pending).catch(() => {});
    assert.equal(swapped.doc, replacement); assert.equal(swapped.doc.studio, undefined);
  } finally { env.restore(); }
});

test('Session resource verification: decoded cache counts shared buffers once and never evicts unsaved edits', async () => {
  const env = environment();
  try {
    const s = env.session(), first = new Uint32Array(2048 * 4095), second = new Uint32Array(2048 * 4095);
    const resource = (data: Uint32Array, blob?: string) => ({ version: 1, kind: 'rgba', w: 2048, h: 4095, data, ...(blob ? { blob } : {}) });
    s.doc.studio = { version: 1, resources: { live: resource(first), alias: resource(first, env.digest()), cached: resource(second, env.digest()) } };
    await s.loadFrame();
    assert.equal(s.doc.studio.resources.alias.data, first, 'A shared buffer alone must not trigger overcounted eviction');
    assert.equal(s.doc.studio.resources.cached.data, second);
    s.doc.studio.resources.more = resource(new Uint32Array(2048 * 4095), env.digest());
    await s.loadFrame();
    const buffers = new Set<Uint32Array>();
    for (const r of Object.values(s.doc.studio.resources) as any[]) if (r.data) buffers.add(r.data);
    for (const a of s.doc.assets) for (const c of Object.values(a.cels) as any[]) if (c.data) buffers.add(c.data);
    assert.ok([...buffers].reduce((n, b) => n + b.byteLength, 0) <= 64 * 1024 * 1024);
    assert.equal(s.doc.studio.resources.live.data, first, 'Unsaved pixels survive cache reclamation');
  } finally { env.restore(); }
});

test('Session resource verification: a current load failure is reported and an unsuccessful lazy undo does not consume history', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Lỗi đọc'); d.studio = { version: 1, resources: { body: mask() } };
    const s = env.session(d); env.failRead(true);
    await assert.rejects(s.loadResource('body'), /bị hỏng/);
    env.failRead(false); await s.loadResource('body');
    s.changeResource('body', Uint32Array.from([1, 1, 0, 1, 1, 0]));
    s.release(); await s.flush(); s.hold(); delete s.doc.studio.resources.body.data;
    env.failRead(true); await assert.rejects(s.undo(), /bị hỏng/);
    env.failRead(false); await s.undo();
    assert.deepEqual(s.doc.studio.resources.body.data, mask().data);
  } finally { env.restore(); }
});

test('Session resource verification: resource helpers reject the document entry limit atomically', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Giới hạn tài liệu'); d.studio = { version: 1, resources: Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`r${i}`, mask()])) };
    const s = env.session(d);
    assert.throws(() => s.setResource('overflow', mask()), /1024/);
    assert.equal(Object.keys(s.doc.studio.resources).length, 1024);
    assert.equal(s.history.bytes, 0); assert.equal(s.dirty, false);
  } finally { env.restore(); }
});

test('Session resource verification: native cel delta undo hydrates an evicted saved cel before applying changes', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Undo cel', 18, 18), a = d.assets[0], frame = a.frames[0].id;
    a.cels.testcel = { id: 'testcel', data: new Uint32Array(18 * 18) }; a.layers[0].cels[frame] = 'testcel';
    const s = env.session(d); await s.loadFrame();
    s.change('Chấm pixel', () => { const c = s.doc.assets[0].cels.testcel; c.data = c.data.slice(); c.data[5] = 0xff0000ff; delete c.blob; });
    s.release(); await s.flush(); s.hold(); delete s.doc.assets[0].cels.testcel.data;
    await s.undo();
    assert.deepEqual(s.doc.assets[0].cels.testcel.data, new Uint32Array(18 * 18));
  } finally { env.restore(); }
});

test('Session resource verification: reject malformed loaded data and discard a pending undo after an intervening edit', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Kiểm tra phản hồi'); d.studio = { version: 1, resources: { body: mask() } };
    const s = env.session(d), old = s.doc.studio.resources.body.blob;
    env.words.set(old, new Uint32Array(2));
    await assert.rejects(s.loadResource('body'));
    assert.equal(s.doc.studio.resources.body.data, undefined);
    env.words.set(old, mask().data); env.mismatchBlob(true);
    await assert.rejects(s.loadResource('body'));
    assert.equal(s.doc.studio.resources.body.data, undefined);
    env.mismatchBlob(false); await s.loadResource('body');
    const next = Uint32Array.from([1, 1, 0, 1, 1, 0]); s.changeResource('body', next);
    s.release(); await s.flush(); s.hold(); delete s.doc.studio.resources.body.data;
    const delayed = env.delayRead(), undo = s.undo(); await delayed.started;
    s.change('Sửa mới hơn', () => { s.doc.name = 'Thao tác mới hơn'; });
    delayed.release(); await undo;
    assert.equal(s.doc.name, 'Thao tác mới hơn');
    assert.deepEqual(s.doc.studio.resources.body.data, next);
  } finally { env.restore(); }
});

test('Session resource verification: cel and resource lazy requests never share a pending cache entry', async () => {
  const env = environment();
  try {
    const d: any = newDocument('Tách khóa tải', 18, 18), a = d.assets[0], celId = '1'.padStart(64, '0');
    a.cels = { [celId]: { id: celId, data: new Uint32Array(18 * 18) } }; a.layers[0].cels[a.frames[0].id] = celId;
    // The first persisted resource gets digest1. This is a legal collision with a cel ID.
    d.studio = { version: 1, resources: { [a.id]: { version: 1, kind: 'rgba', w: 2, h: 2, data: Uint32Array.from([1, 2, 3, 4]) } } };
    const s = env.session(d);
    await Promise.all([s.loadFrame(), s.loadResource(a.id)]);
    assert.deepEqual(s.doc.studio.resources[a.id].data, Uint32Array.from([1, 2, 3, 4]));
    assert.equal(s.doc.assets[0].cels[celId].data.length, 18 * 18);
  } finally { env.restore(); }
});

test('Session copy verification: an edit during copy keeps the source draft dirty and conflicted', async () => {
  const env = environment();
  try {
    const s = env.session(); s.change('Bản nháp', () => { s.doc.name = 'Bản nháp'; }); s.conflict = true;
    const delayed = env.delayCopy(), copying = s.copy(); await delayed.started;
    s.change('Nét vẽ mới hơn', () => { s.doc.name = 'Nét vẽ mới hơn'; });
    delayed.release(); const copiedId = await copying;
    assert.notEqual(copiedId, s.doc.id);
    assert.equal(s.doc.name, 'Nét vẽ mới hơn'); assert.equal(s.dirty, true); assert.equal(s.conflict, true);
    await s.copy(); assert.equal(s.dirty, false); assert.equal(s.conflict, false);
  } finally { env.restore(); }
});

test('A delayed draft of a completed stroke keeps its pixels during the next gesture', async () => {
  const env = environment();
  try {
    const editor = env.session();
    const before = editor.begin();
    const cel = celFor(editor.asset, editor.layer.id, editor.frameId, true)!;
    cel.data![0] = 0x102030ff;
    const releaseDraft = env.delayDraftOpen();
    editor.end(before, 'First stroke');

    // The next writable gesture copies the previous cel before changing it.
    cel.data = cel.data!.slice();
    cel.data[0] = 0x405060ff;
    editor.asset.name = 'Next edit';
    releaseDraft();

    const stored = await draft('get', editor.doc.id);
    assert.ok(stored && typeof stored !== 'string');
    const saved = stored.assets[0];
    assert.notEqual(saved.name, editor.asset.name);
    assert.equal(celFor(saved, saved.layers[0].id, saved.frames[0].id)?.data?.[0], 0x102030ff);
    assert.equal(cel.data[0], 0x405060ff);
  } finally { env.restore(); }
});
