// Parent future acceptance; activate default test discovery after public clip API implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { wireParse, wireStringify, validateDocument, newAsset } from '../src/studio/pixel/model.ts';

function decodePng(buffer: Buffer) {
  let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset), kind = buffer.toString('ascii', offset + 4, offset + 8), data = buffer.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); mode = data[9]; }
    if (kind === 'PLTE') palette = Buffer.from(data);
    if (kind === 'tRNS') alpha = Buffer.from(data);
    if (kind === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  assert.ok(mode === 3 || mode === 6); const channels = mode === 3 ? 1 : 4, stride = w * channels + 1;
  const raw = inflateSync(Buffer.concat(chunks)), pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * stride], 0);
    for (let x = 0; x < w; x++) {
      const offset = y * stride + 1 + x * channels;
      if (mode === 6) pixels[y * w + x] = raw.readUInt32BE(offset);
      else { const i = raw[offset]; pixels[y * w + x] = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) |
        (palette[i * 3 + 2] << 8) | (alpha[i] ?? 255)) >>> 0; }
    }
  }
  return { w, h, pixels };
}
function unzipStored(buffer: Buffer) {
  const files: Record<string, Buffer> = {};
  for (let offset = 0; offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const length = buffer.readUInt32LE(offset + 18), names = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + names + extra, name = buffer.toString('utf8', offset + 30, offset + 30 + names);
    files[name] = buffer.subarray(start, start + length); offset = start + length;
  }
  return files;
}

async function fixture(mode: 'region' | 'whole' = 'region') {
  const f = savedClipFixture(mode, true);
  try {
    const app = await serveStudio(f.root, { port: 0, uiDir: resolve('dist/studio'), providers: {
      codex: process.execPath, antigravity: process.execPath,
      prefix: [resolve('test/fixtures/clip-cli.js'), '--scenario', 'valid', '--state-dir', f.root], timeout: 10_000,
    } });
    const base = `projects/${f.saved.id}`;
    const req = (path: string, method = 'GET', data?: unknown) => fetch(`${app.url}api/pixel/${path}`, {
      method, headers: { origin: app.url.slice(0, -1), ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
      body: data === undefined ? undefined : wireStringify(data),
    });
    async function json(path: string, method = 'GET', data?: unknown, status = 200): Promise<any> {
      const response = await req(path, method, data), value = wireParse(await response.text());
      assert.equal(response.status, status, JSON.stringify(value)); return value;
    }
    async function wait(batchId: string) {
      const until = Date.now() + 30_000;
      let batch: any;
      do {
        batch = await json(`${base}/generation-batches/${batchId}`);
        if (batch.status !== 'running') return batch;
        await new Promise(r => setTimeout(r, 20));
      } while (Date.now() < until);
      assert.fail(`Batch did not settle: ${JSON.stringify(batch)}`);
    }
    const logPath = join(f.root, 'clip-cli-log.jsonl');
    const calls = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { f, app, base, req, json, wait, calls, async close() { try { await app.close(); } finally { f.close(); } } };
  } catch (error) { f.close(); throw error; }
}

test('Independent clip HTTP: each CLI/scoped mode makes three calls, protects fullN, normalizes locally and applies exact lazy pixels', async () => {
  for (const provider of ['codex']) for (const mode of ['region', 'whole'] as const) {
    const h = await fixture(mode), { f, base } = h;
    try {
      const started = await h.json(`${base}/generation-batches`, 'POST', { revision: f.saved.revision,
        provider, prompt: 'Create selected motion', generationOptions: { paletteMode: 'asset' }, clipGeneration: { clipId: f.clip.id } }, 202);
      const batch = await h.wait(started.id);
      assert.equal(batch.status, 'ready'); assert.equal(batch.config.operation, 'clip-regenerate');
      assert.equal(batch.config.target.assetId, f.source.id); assert.equal(batch.config.clip.sourceFrameId, f.character.source.frameId);
      assert.deepEqual(batch.config.clip.slots.map((slot: any) => slot.duration), f.durations);
      assert.equal(h.calls().length, 3); assert.ok(batch.candidates.every((c: any) => c.cliExecutions === 1));
      assert.ok(h.calls().every(call => call.images['clip-guide.png'] === h.calls()[0].images['clip-guide.png']));
      for (const forbidden of ['"data":', 'rgbaResourceId', 'guidePreview', 'contextDoc', '"files":']) assert.equal(JSON.stringify(batch).includes(forbidden), false);
      assert.deepEqual(readFileSync(f.manifest), f.originalManifest, 'generation never autosaves source');
      const p = await h.json(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[0].id}/preview`, 'POST', { revision: f.saved.revision });
      const raw = p.variants.find((v: any) => v.kind === 'raw'), full = p.variants.find((v: any) => v.kind === 'protected');
      assert.equal(raw.canApply, false); assert.equal(raw.assets[0].frames.length, 1); assert.equal(full.assets[0].frames.length, 4);
      assert.equal(p.selectedVariantId, full.id);
      for (let i = 0; i < 4; i++) {
        const frame = await h.json(`${base}/proposals/${p.proposalId}/variants/${full.id}/frame?revision=${f.saved.revision}&asset=${full.assets[0].id}&frame=${f.clip.slots[i].id}`);
        assert.deepEqual(frame.data, f.images[i]); assert.equal(frame.duration, f.durations[i]);
      }
      const normalize = await h.json(`${base}/proposals/${p.proposalId}/normalize`, 'POST', { revision: f.saved.revision, alphaThreshold: 128 }, 202);
      let processing: any; const until = Date.now() + 10_000;
      do { processing = await h.json(`${base}/processing/${normalize.id}`); if (processing.status !== 'running') break;
        await new Promise(r => setTimeout(r, 20)); } while (Date.now() < until);
      assert.equal(processing.status, 'ready', processing.message); assert.equal(h.calls().length, 3);
      const saved = await h.json(`${base}/apply-proposal`, 'POST', { revision: f.saved.revision, proposalId: p.proposalId, variantId: processing.variantId });
      const asset = saved.assets.at(-1);
      assert.notEqual(asset.id, f.clip.id); assert.deepEqual(asset.frames.map((frame: any) => frame.id), f.clip.slots.map(slot => slot.id));
      assert.deepEqual(asset.frames.map((frame: any) => frame.duration), f.durations); assert.equal(asset.tags[0].loop, false);
      assert.deepEqual(asset.metadata.pivot, f.source.metadata.pivot);
      assert.deepEqual(asset.metadata.hitbox, f.source.metadata.hitbox);
      assert.ok(asset.metadata.events.some((event: any) => event.name === 'từ frame 2'));
      assert.equal(asset.provenance.batch.config.operation, 'clip-regenerate'); assert.equal(asset.provenance.batch.config.clip.clipId, f.clip.id);
      validateDocument(saved);
      const pngResponse = await h.req(`${base}/export`, 'POST', { revision: saved.revision, format: 'png', assetId: asset.id, frameId: asset.frames[2].id });
      assert.equal(pngResponse.status, 200);
      const png = decodePng(Buffer.from(await pngResponse.arrayBuffer()));
      assert.deepEqual([png.w, png.h], [4, 3]); assert.deepEqual(png.pixels, f.images[2]);
      const atlasResponse = await h.req(`${base}/export`, 'POST', { revision: saved.revision, format: 'atlas', selected: [asset.id] });
      assert.equal(atlasResponse.status, 200);
      const files = unzipStored(Buffer.from(await atlasResponse.arrayBuffer())), atlas = decodePng(files['image.png']);
      const metadata = JSON.parse(files['image.json'].toString('utf8'));
      assert.equal(metadata.meta.pxl.revision, saved.revision); assert.equal(metadata.meta.frameTags[0].loop, false);
      for (let i = 0; i < 4; i++) {
        const item = metadata.frames[`${asset.name}_${asset.id.slice(0, 8)}_${i}`], rect = item.frame, pixels = new Uint32Array(12);
        assert.deepEqual([rect.w, rect.h, item.duration], [4, 3, f.durations[i]]);
        for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) pixels[y * 4 + x] = atlas.pixels[(rect.y + y) * atlas.w + rect.x + x];
        assert.deepEqual(pixels, f.images[i], 'atlas UV excludes edge extrusion and matches protected revision');
      }
      await h.json(`${base}/apply-proposal`, 'POST', { revision: f.saved.revision, proposalId: p.proposalId, variantId: full.id }, 409);
    } finally { await h.close(); }
  }
});

test('Independent clip HTTP: malformed/conflicting input and all-frozen draft fail before either provider executes', async () => {
  const h = await fixture(), { f, base } = h;
  try {
    for (const input of [null, {}, { clipId: 2 }, { clipId: f.clip.id, mask: [] },
      { clipId: '' }, { clipId: '../walk' }, { clipId: '__proto__' }, { clipId: 'constructor' }]) {
      const result = await h.req(`${base}/generation-batches`, 'POST', { revision: f.saved.revision, provider: 'codex', prompt: 'No call', clipGeneration: input });
      assert.equal(result.status, 400); await result.text();
    }
    for (const extra of [{ assetId: 'foreign' }, { regionEdit: { frameId: f.character.source.frameId, mask: [...f.mask] } },
      { generationOptions: { animation: { frameId: f.character.source.frameId, mode: 'whole', frames: 2, duration: 100,
        loop: true, anchor: { x: 2, y: 3 } } } }]) {
      const result = await h.req(`${base}/generation-batches`, 'POST', { revision: f.saved.revision, provider: 'codex', prompt: 'No call',
        clipGeneration: { clipId: f.clip.id }, ...extra });
      assert.ok([400, 404].includes(result.status)); await result.text();
    }
    const document = await h.json(base);
    document.studio.clips[f.clip.id].slots.forEach((slot: any) => { slot.selected = false; slot.frozen = true; });
    const saved = await h.json(base, 'PUT', { revision: document.revision, document });
    const blocked = await h.req(`${base}/generation-batches`, 'POST', { revision: saved.revision, provider: 'codex', prompt: 'No call', clipGeneration: { clipId: f.clip.id } });
    assert.ok([400, 422].includes(blocked.status));
    const failure = await blocked.json(); assert.match(failure.error, /chọn|khóa|frozen|slot|frame/i);
    assert.equal(h.calls().length, 0);
  } finally { await h.close(); }
});

test('Independent clip HTTP: repeated generation versions have fresh IDs and historical clip context survives source-profile removal/copy', async () => {
  const h = await fixture('whole'), { f, base } = h;
  try {
    let document = await h.json(base), previousId: string | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const initial = await h.json(`${base}/generation-batches`, 'POST', { revision: document.revision, provider: 'codex', prompt: 'Version',
        generationOptions: { paletteMode: 'asset' }, clipGeneration: { clipId: f.clip.id } }, 202);
      const batch = await h.wait(initial.id); assert.equal(batch.status, 'ready');
      const p = await h.json(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[0].id}/preview`, 'POST', { revision: document.revision });
      document = await h.json(`${base}/apply-proposal`, 'POST', { revision: document.revision, proposalId: p.proposalId, variantId: p.selectedVariantId,
        library: previousId ? { versionOf: previousId } : { kind: 'character', name: 'Animation versions' } });
      previousId = document.assets.at(-1).id; ids.push(previousId!);
    }
    assert.notEqual(ids[0], ids[1]); assert.ok(ids.every(id => id !== f.clip.id)); assert.equal(h.calls().length, 6);
    assert.equal(document.studio.library[ids[1]].version, 2);
    document.studio.clips = {}; document.studio.characters = {};
    document = await h.json(base, 'PUT', { revision: document.revision, document }); validateDocument(document);
    const copied = await h.json('projects', 'POST', { name: 'Historical clip copy', document, sourceProjectId: f.saved.id }, 201);
    assert.notEqual(copied.id, f.saved.id); validateDocument(copied);
    for (const id of ids) assert.equal(copied.assets.find((asset: any) => asset.id === id).provenance.batch.config.clip.clipId, f.clip.id);
  } finally { await h.close(); }
});

test('Independent clip HTTP: reordered K2 slots retain true loop/mixed timing and the guide is separate from three art references', async () => {
  const h = await fixture('whole'), { f, base } = h;
  try {
    const document = await h.json(base), clip = document.studio.clips[f.clip.id];
    const extraReference = newAsset('Reference riêng', 4, 3, 0xffffffff);
    document.assets.push(extraReference);
    clip.loop = true;
    clip.slots.reverse();
    clip.slots.forEach((slot: any, i: number) => { slot.selected = !slot.frozen && (i === 0 || i === 2); });
    const saved = await h.json(base, 'PUT', { revision: document.revision, document });
    const refs = [
      ...document.assets[0].frames.map((frame: any) => ({ assetId: f.source.id, frameId: frame.id })),
      { assetId: extraReference.id, frameId: extraReference.frames[0].id },
    ];
    const started = await h.json(`${base}/generation-batches`, 'POST', { revision: saved.revision, provider: 'codex',
      prompt: 'Reorder and keep motion identity', clipGeneration: { clipId: f.clip.id },
      generationOptions: { paletteMode: 'asset' }, artDirection: { style: 'game', paletteMode: 'asset', palette: f.source.palette,
        light: 'upper-left', detailLevel: 'medium', outline: 'dark', references: refs } }, 202);
    const batch = await h.wait(started.id); assert.equal(batch.status, 'ready');
    assert.deepEqual(batch.config.clip.slots.map((s: any) => s.id), clip.slots.map((s: any) => s.id));
    assert.deepEqual(batch.config.clip.slots.map((s: any) => s.duration), [...f.durations].reverse());
    assert.equal(batch.config.clip.loop, true);
    assert.equal(h.calls().length, 3);
    for (const call of h.calls()) {
      assert.deepEqual(call.supplied, ['preview.png', 'clip-guide.png', 'art-ref-1.png', 'art-ref-2.png', 'art-ref-3.png']);
      assert.ok(call.images['clip-guide.png']);
      assert.deepEqual(call.images, h.calls()[0].images);
    }
    const p = await h.json(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[0].id}/preview`, 'POST', { revision: saved.revision });
    const raw = p.variants.find((v: any) => v.kind === 'raw'), full = p.variants.find((v: any) => v.kind === 'protected');
    assert.equal(raw.assets[0].frames.length, 2); assert.equal(full.assets[0].tags[0].loop, true);
    for (let i = 0; i < 4; i++) {
      const frame = await h.json(`${base}/proposals/${p.proposalId}/variants/${full.id}/frame?revision=${saved.revision}&asset=${full.assets[0].id}&frame=${clip.slots[i].id}`);
      assert.deepEqual(frame.data, f.images[3 - i]); assert.equal(frame.duration, f.durations[3 - i]);
    }
  } finally { await h.close(); }
});
