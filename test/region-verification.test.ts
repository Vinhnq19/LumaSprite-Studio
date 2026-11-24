// Independent acceptance checks: compare decoded output, not just fixture labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { serveStudio } from '../src/node/studio/server.ts';
import { composite, celFor, duplicateFrame, newAsset, wireParse, wireStringify, type PixelDocument } from '../src/studio/pixel/model.ts';
import { imageSource } from '../src/studio/pixel/processing.ts';
import { processRequest } from '../src/node/studio/processing-worker.ts';
import type { GenerationContext, ProjectDocument } from '../src/studio/types.ts';

function png(b: Buffer): { w: number; h: number; data: Uint32Array } {
  let w = 0, h = 0, mode = 0, colors = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let at = 8; at + 12 <= b.length;) {
    const n = b.readUInt32BE(at), kind = b.toString('ascii', at + 4, at + 8), data = b.subarray(at + 8, at + 8 + n);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); mode = data[9]; }
    if (kind === 'PLTE') colors = Buffer.from(data);
    if (kind === 'tRNS') alpha = Buffer.from(data);
    if (kind === 'IDAT') chunks.push(data);
    at += n + 12;
  }
  assert.ok(mode === 3 || mode === 6);
  const row = w * (mode === 3 ? 1 : 4) + 1, raw = inflateSync(Buffer.concat(chunks));
  const data = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * row], 0, 'pxl encoder uses PNG filter0');
    for (let x = 0; x < w; x++) {
      const at = y * row + 1 + x * (mode === 3 ? 1 : 4), i = raw[at];
      data[y * w + x] = mode === 6 ? raw.readUInt32BE(at) : ((colors[i * 3] << 24) | (colors[i * 3 + 1] << 16) | (colors[i * 3 + 2] << 8) | (alpha[i] ?? 255)) >>> 0;
    }
  }
  return { w, h, data };
}
function unzip(b: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 30 <= b.length && b.readUInt32LE(at) === 0x04034b50;) {
    assert.equal(b.readUInt16LE(at + 8), 0);
    const size = b.readUInt32LE(at + 18), nl = b.readUInt16LE(at + 26), el = b.readUInt16LE(at + 28), start = at + 30 + nl + el;
    files.set(b.toString('utf8', at + 30, at + 30 + nl), b.subarray(start, start + size)); at = start + size;
  }
  return files;
}
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pxl-region-acceptance-'));
  const app = await serveStudio(root, { port: 0, providers: {
    codex: process.execPath, antigravity: process.execPath,
    prefix: [resolve('studio/fake-cli.js'), '--state-dir', root], timeout: 5000,
  } });
  const request = (path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') => fetch(`${app.url}api/pixel/${path}`, {
    method, headers: { origin: app.url.slice(0, -1), 'content-type': 'application/json' }, body: value === undefined ? undefined : wireStringify(value),
  });
  async function json(path: string, value?: unknown, method?: string): Promise<any> {
    const r = await request(path, value, method), text = await r.text(); assert.ok(r.ok, `${r.status}: ${text}`); return wireParse(text);
  }
  async function hydrate(doc: PixelDocument): Promise<PixelDocument> {
    for (const a of doc.assets) for (const c of Object.values(a.cels)) {
      if (!c.data) c.data = (await json(`projects/${doc.id}/cel?revision=${doc.revision}&asset=${a.id}&cel=${c.id}`)).data;
    }
    return doc;
  }
  async function wait(path: string, active: string[] = ['running']): Promise<any> {
    const until = Date.now() + 20000;
    while (Date.now() < until) { const j = await json(path); if (!active.includes(j.status)) return j; await new Promise(r => setTimeout(r, 25)); }
    throw Error(`Timed out ${path}`);
  }
  return { root, request, json, hydrate, wait, calls: () => existsSync(join(root, 'fixture-cli-calls.jsonl')) ? readFileSync(join(root, 'fixture-cli-calls.jsonl'), 'utf8').trim().split('\n').length : 0,
    close: async () => { await app.close(); assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } };
}

test('Region acceptance: full RGBA mask, normalized preview/PNG/atlas/baked source, source unchanged, exactly3calls, stale refusal (Codex)', async () => {
  for (const provider of ['codex']) {
    const h = await harness();
    try {
      let d: PixelDocument = await h.json('projects', { name: `Exact region ${provider}`, w: 18, h: 12 });
      const base = `projects/${d.id}`, a = d.assets[0], frameId = duplicateFrame(a, a.frames[0].id, 'blank');
      a.frames[1].duration = 137; a.palette = [0x70c989ff, 0xffffffff];
      a.metadata = { pivot: { x: .23, y: .91 }, hitbox: { x: 1, y: 2, w: 10, h: 8 }, events: [{ frame: 0, name: 'old' }, { frame: 1, name: 'selected' }] };
      const data = celFor(a, a.layers[0].id, frameId, true)!.data!;
      data.set(Uint32Array.from({ length: a.w * a.h }, (_, i) => i % 7 === 0 ? 0 : i % 2 ? 0x70c989ff : 0xffffffff));
      data[6 * 18 + 9] = 0xffffffff;
      d = await h.hydrate(await h.json(base, { revision: d.revision, document: d }, 'PUT'));
      const original = structuredClone(d.assets[0]), baseline = composite(original, frameId).data;
      const mask = Array.from({ length: 216 }, (_, i) => +[6 * 18 + 8, 6 * 18 + 9, 7 * 18 + 8].includes(i));
      const started = await h.json(`${base}/generation-batches`, { revision: d.revision, provider, assetId: a.id, prompt: 'Change only emblem', regionEdit: { frameId, mask } });
      const b = await h.wait(`${base}/generation-batches/${started.id}`);
      assert.equal(b.status, 'ready'); assert.equal(h.calls(), 3);
      const p = await h.json(`${base}/generation-batches/${b.id}/candidates/${b.candidates[1].id}/preview`, { revision: d.revision });
      assert.equal(p.generation.operation, 'region-edit');
      assert.ok(!JSON.stringify(b.config).includes('mask'));
      const raw = p.variants.find((v: any) => v.kind === 'raw'), protectedV = p.variants.find((v: any) => v.kind === 'protected');
      assert.equal(p.selectedVariantId, protectedV.id); assert.equal(raw.canApply, false);
      const getFrame = (v: any) => h.json(`${base}/proposals/${p.proposalId}/variants/${v.id}/frame?revision=${d.revision}&asset=${v.assets[0].id}&frame=${v.assets[0].frames[0].id}`);
      const protectedFrame = await getFrame(protectedV);
      for (let i = 0; i < mask.length; i++) if (!mask[i]) assert.equal(protectedFrame.data[i], baseline[i], `protected outside pixel${i}`);
      assert.notEqual(protectedFrame.data[6 * 18 + 9], baseline[6 * 18 + 9]);
      const j = await h.json(`${base}/proposals/${p.proposalId}/normalize`, { revision: d.revision, alphaThreshold: 128 });
      const processed = await h.wait(`${base}/processing/${j.id}`); assert.equal(processed.status, 'ready');
      const info = await h.json(`${base}/proposals/${p.proposalId}?revision=${d.revision}`), normalized = info.variants.find((v: any) => v.id === processed.variantId);
      const expected = (await getFrame(normalized)).data as Uint32Array;
      for (let i = 0; i < mask.length; i++) if (!mask[i]) assert.equal(expected[i], baseline[i], `normalized outside pixel${i}`);
      d = await h.hydrate(await h.json(`${base}/apply-proposal`, { revision: d.revision, proposalId: p.proposalId, variantId: normalized.id, library: { kind: 'character', versionOf: a.id } }));
      assert.deepEqual(d.assets[0], original, 'all manual source frames/cels/metadata remain exact');
      const result = d.assets.at(-1)!;
      assert.equal(result.frames.length, 1); assert.equal(result.frames[0].duration, 137);
      assert.deepEqual(result.metadata.hitbox, original.metadata.hitbox);
      assert.deepEqual(result.metadata.events, [{ frame: 0, name: 'selected' }]);
      assert.ok(Math.abs(result.metadata.pivot!.x - original.metadata.pivot!.x) < 1e-12);
      assert.ok(Math.abs(result.metadata.pivot!.y - original.metadata.pivot!.y) < 1e-12);
      assert.deepEqual(composite(result, result.frames[0].id).data, expected);
      const response = await h.request(`${base}/export`, { revision: d.revision, assetId: result.id, format: 'png' });
      assert.ok(response.ok); const decoded = png(Buffer.from(await response.arrayBuffer()));
      assert.deepEqual([decoded.w, decoded.h], [18, 12]); assert.deepEqual(decoded.data, expected);
      const atlasResponse = await h.request(`${base}/export`, { revision: d.revision, format: 'atlas', selected: [result.id] });
      assert.ok(atlasResponse.ok); const files = unzip(Buffer.from(await atlasResponse.arrayBuffer()));
      const atlas = png(files.get('image.png')!), meta = JSON.parse(files.get('image.json')!.toString());
      const f = (Object.values(meta.frames)[0] as any).frame;
      assert.deepEqual([f.w, f.h], [18, 12]); assert.equal((Object.values(meta.frames)[0] as any).duration, 137);
      for (let y = 0; y < 12; y++) for (let x = 0; x < 18; x++) assert.equal(atlas.data[(f.y + y) * atlas.w + f.x + x], expected[y * 18 + x], `atlas${x},${y}`);
      assert.deepEqual(meta.meta.pxl.assets[result.id].events, [{ frame: 0, name: 'selected' }]);
      const baked = await h.json(`${base}/code-preview`, { revision: d.revision, ...result.source });
      assert.deepEqual(composite(baked.assets[0], baked.assets[0].frames[0].id).data, expected, 'stored source reconstructs exact chosen pixels');
      assert.equal(baked.assets[0].frames[0].duration, 137); assert.equal(h.calls(), 3, 'local operations never invoke another CLI');
      const again = await h.json(`${base}/generation-batches`, { revision: d.revision, provider, assetId: a.id, prompt: 'Stale region verification', regionEdit: { frameId, mask } });
      const next = await h.wait(`${base}/generation-batches/${again.id}`);
      assert.equal(next.status, 'ready');
      const pending = await h.json(`${base}/generation-batches/${next.id}/candidates/${next.candidates[0].id}/preview`, { revision: d.revision });
      const rev = d.revision; d.name = 'External change'; d = await h.json(base, { revision: rev, document: d }, 'PUT');
      assert.equal((await h.request(`${base}/apply-proposal`, { revision: rev, proposalId: pending.proposalId, variantId: pending.selectedVariantId })).status, 409);
      assert.equal((await h.request(`${base}/apply-proposal`, { revision: d.revision, proposalId: pending.proposalId, variantId: pending.selectedVariantId })).status, 409);
      const reloaded = await h.hydrate(await h.json(base));
      assert.deepEqual(reloaded.assets[0], original); assert.equal(h.calls(), 6);
    } finally { await h.close(); }
  }
});

test('Region acceptance: explicit project palette source copy keeps real historical provenance; legacy reference palette unchanged, no CLI', async () => {
  const h = await harness();
  try {
    let d: PixelDocument = await h.json('projects', { name: 'Reference provenance', w: 18, h: 12 });
    const base = `projects/${d.id}`, a = d.assets[0]; a.palette = [0x3b82f6ff, 0xffffffff];
    celFor(a, a.layers[0].id, a.frames[0].id, true)!.data![0] = 0x3b82f6ff;
    a.source = { entry: 'art.px.js', files: { 'art.px.js': imageSource('original', 18, 12, [composite(a, a.frames[0].id).data], [100], true) } };
    const provenance = { kind: 'generated' as const, originalSource: { entry: 'old.px.js', files: { 'old.px.js': "sprite('old',{w:18,h:12},px(0,0,'#70c989'))" } }, batch: { provider: 'codex' as const, prompt: 'Original captured request', config: { target: { w: 18, h: 12 }, artDirection: { paletteMode: 'asset', palette: a.palette } } } };
    a.provenance = structuredClone(provenance); d.studio = { version: 1, artDirection: { paletteMode: 'asset', palette: [0x70c989ff, 0xffffffff] } };
    d = await h.hydrate(await h.json(base, { revision: d.revision, document: d }, 'PUT')); const original = structuredClone(d.assets[0]);
    const old = await h.json(`${base}/reference-proposal`, { revision: d.revision, assetId: a.id, frameId: a.frames[0].id });
    assert.deepEqual(old.generation.palette, original.palette);
    const p = await h.json(`${base}/reference-proposal`, { revision: d.revision, assetId: a.id, frameId: a.frames[0].id, artDirection: {} });
    assert.deepEqual(p.generation.palette, [0x70c989ff, 0xffffffff]);
    const j = await h.json(`${base}/proposals/${p.proposalId}/normalize`, { revision: d.revision, alphaThreshold: 128 });
    const processed = await h.wait(`${base}/processing/${j.id}`); assert.equal(processed.status, 'ready');
    d = await h.hydrate(await h.json(`${base}/apply-proposal`, { revision: d.revision, proposalId: p.proposalId, variantId: processed.variantId }));
    const copy = d.assets.at(-1)!; assert.deepEqual(copy.provenance?.batch, provenance.batch); assert.deepEqual(copy.provenance?.originalSource, provenance.originalSource);
    assert.notEqual(composite(copy, copy.frames[0].id).data[0], 0x3b82f6ff); assert.deepEqual(d.assets[0], original); assert.equal(h.calls(), 0);
  } finally { await h.close(); }
});

test('Region acceptance: wrong frame count, timing, dimensions and empty provider rasters stay blocked', () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-region-quality-'));
  try {
    const source = newAsset('Source', 18, 12, 0x70c989ff);
    const animation = { frameId: source.frames[0].id, mode: 'region' as const, frames: 1, duration: 137, loop: true, anchor: { x: 9, y: 12 }, mask: Array.from({ length: 216 }, (_, i) => +(i === 0)) };
    const generation: GenerationContext = { options: { style: 'game', view: 'front', paletteMode: 'asset', reference: true }, assetId: source.id, w: 18, h: 12, palette: [0x70c989ff], operation: 'region-edit', animation: { ...animation, referenceFile: '_pxl_reference.px.js' } };
    const work = (request: Parameters<typeof processRequest>[0]) => wireParse(Buffer.from(processRequest(request).data).toString('utf8'));
    const reference = work({ mode: 'pixel-process', root, operation: 'reference', source, frameId: source.frames[0].id, generation, animation, revision: 1 });
    const cases = [
      { content: "anim('proposal',{w:18,h:12,base:'_pxl_reference'},frame({ms:138}))", error: /137 ms/ },
      { content: "anim('proposal',{w:18,h:12,base:'_pxl_reference'},frame({ms:137}),frame({ms:137}))", error: /đúng 1 frame/ },
      { content: "anim('proposal',{w:19,h:12},frame({ms:137},px(0,0,'#70c989')))", error: /không khớp canvas/ },
      { content: "sprite('proposal',{w:18,h:12})", error: /Ảnh rỗng/ },
    ];
    for (const item of cases) {
      const document: ProjectDocument = { schemaVersion: 1, id: 'quality', name: 'Quality', revision: 1, entry: 'art.px.js', files: { '_pxl_reference.px.js': reference.source, 'art.px.js': `include('_pxl_reference.px.js');${item.content}` }, pixels: {}, metadata: {} };
      const captured = work({ mode: 'pixel-process', root, operation: 'capture', document, generation, referenceId: reference.info.id });
      assert.equal(captured.canApply, false); assert.match(captured.quality.errors.join(' '), item.error);
    }
  } finally { assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }
});
