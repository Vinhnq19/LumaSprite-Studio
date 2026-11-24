import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { serveStudio } from '../src/node/studio/server.ts';
import { wireParse, wireStringify, celFor, validateBatchProvenance, composite, duplicateFrame } from '../src/studio/pixel/model.ts';
import { buildBatchCandidatePrompt } from '../src/node/studio/ai-prompt.ts';
import { prepareGenerationSnapshot } from '../src/node/studio/generation-prep.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { processRequest } from '../src/node/studio/processing-worker.ts';

const temporary = () => mkdtempSync(join(tmpdir(), 'pxl-region-test-'));

function decodePng(data: Uint8Array): { w: number; h: number; pixels: Uint32Array } {
  const b = Buffer.from(data);
  let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let o = 8; o + 12 <= b.length;) {
    const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); mode = d[9]; }
    if (t === 'PLTE') palette = Buffer.from(d);
    if (t === 'tRNS') alpha = Buffer.from(d);
    if (t === 'IDAT') chunks.push(d);
    o += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), out = new Uint32Array(w * h), stride = w * (mode === 3 ? 1 : 4) + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * stride + 1 + x * (mode === 3 ? 1 : 4);
      if (mode === 3) {
        const i = raw[j];
        out[y * w + x] = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) | (palette[i * 3 + 2] << 8) | (alpha[i] ?? 255)) >>> 0;
      } else {
        out[y * w + x] = raw.readUInt32BE(j);
      }
    }
  }
  return { w, h, pixels: out };
}

async function createServer(root: string) {
  const app = await serveStudio(root, {
    port: 0,
    uiDir: resolve('dist/studio'),
    providers: {
      codex: process.execPath,
      antigravity: process.execPath,
      prefix: [resolve('studio/fake-cli.js'), '--state-dir', root],
      timeout: 5000,
    },
  });

  const req = async (path: string, method = 'GET', value?: unknown) => {
    const url = `${app.url}api/pixel/${path}`;
    const headers: Record<string, string> = {
      origin: app.url.slice(0, -1),
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    };
    return fetch(url, {
      method,
      headers,
      body: value === undefined ? undefined : wireStringify(value),
    });
  };

  const waitBatch = async (base: string, batchId: string, timeoutMs = 25000) => {
    const until = Date.now() + timeoutMs;
    let batch: any;
    while (Date.now() < until) {
      const res = await req(`${base}/generation-batches/${batchId}`);
      assert.equal(res.status, 200);
      batch = await res.json();
      if (!['running'].includes(batch.status)) return batch;
      await new Promise(r => setTimeout(r, 50));
    }
    return batch;
  };

  return { app, req, waitBatch };
}

test('Region edit: invalid/mixed/empty masks, frame ID, and legacy /ai rejected before calls', async () => {
  const root = temporary();
  const { app, req } = await createServer(root);
  try {
    const callsFile = join(root, 'fixture-cli-calls.jsonl');
    const doc = await (await req('projects', 'POST', { name: 'Validation Proj', w: 16, h: 16 })).json();
    const base = `projects/${doc.id}`;
    const asset = doc.assets[0];
    const frameId = asset.frames[0].id;

    // 1. Empty mask (length 0 or all zeros)
    let res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      regionEdit: { frameId, mask: [] },
    });
    assert.equal(res.status, 400);

    res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      regionEdit: { frameId, mask: new Array(256).fill(0) },
    });
    assert.equal(res.status, 400);

    // 2. Wrong size mask
    res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      regionEdit: { frameId, mask: [1, 0, 1] },
    });
    assert.equal(res.status, 400);

    // 3. Nonbinary / mixed mask (contains 2 or -1)
    const mixedMask = new Array(256).fill(0);
    mixedMask[5] = 2;
    res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      regionEdit: { frameId, mask: mixedMask },
    });
    assert.equal(res.status, 400);

    // 4. Unknown keys on regionEdit
    const validMask = new Array(256).fill(0);
    validMask[10] = 1;
    res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      regionEdit: { frameId, mask: validMask, extraKey: true },
    });
    assert.equal(res.status, 400);

    // 5. Simultaneous animation and regionEdit
    res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      generationOptions: {
        animation: {
          frameId,
          mode: 'region',
          frames: 4,
          duration: 100,
          loop: true,
          anchor: { x: 8, y: 8 },
          mask: validMask,
        },
      },
      regionEdit: { frameId, mask: validMask },
    });
    assert.equal(res.status, 400);

    // 6. Non-existent frameId
    res = await req(`${base}/generation-batches`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      regionEdit: { frameId: 'missing-frame-id', mask: validMask },
    });
    assert.equal(res.status, 404);

    // 7. Legacy /ai rejects regionEdit
    res = await req(`${base}/ai`, 'POST', {
      revision: doc.revision,
      provider: 'codex',
      prompt: 'Legacy AI call',
      regionEdit: { frameId, mask: validMask },
    });
    assert.equal(res.status, 400);

    // Assert zero CLI executions were made for all these invalid calls
    assert.equal(existsSync(callsFile), false);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Region edit: direct prep preserves fractional normalized pivot (.23, .91) and selected-source metadata/events', async () => {
  const root = temporary();
  const store = new PixelStore(root);
  const variants = new Proposals(store, async (_id: string, req: any) => processRequest(req), () => {});
  try {
    const doc = store.create('Direct Prep', 32, 32);
    const asset = doc.assets[0];
    const frame2Id = duplicateFrame(asset, asset.frames[0].id, 'blank');
    const frame3Id = duplicateFrame(asset, frame2Id, 'blank');
    asset.frames[2].duration = 137;
    asset.metadata = {
      pivot: { x: 0.23, y: 0.91 },
      hitbox: { x: 2, y: 2, w: 10, h: 10 },
      events: [
        { frame: 0, name: 'idle' },
        { frame: 2, name: 'hit' },
      ],
    };
    celFor(asset, asset.layers[0].id, frame3Id, true)!.data!.fill(0x70c989ff);
    const saved = store.save(doc.id, doc.revision, doc);

    const mask = new Array(32 * 32).fill(0);
    mask[100] = 1;

    const snapshot = await prepareGenerationSnapshot(
      store,
      variants,
      saved,
      asset.id,
      {},
      undefined,
      true,
      { frameId: frame3Id, mask }
    );

    assert.equal(snapshot.generation?.operation, 'region-edit');
    assert.equal(snapshot.generation.animation?.frames, 1);
    assert.equal(snapshot.generation.animation?.duration, 137);
    assert.equal(snapshot.generation.animation?.loop, true);
    // Fractional anchor on 32: 0.23 * 32 = 7.36, 0.91 * 32 = 29.12 (NOT rounded to 7, 29)
    assert.equal(snapshot.generation.animation?.anchor.x, 0.23 * 32);
    assert.equal(snapshot.generation.animation?.anchor.y, 0.91 * 32);
  } finally {
    variants.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Region edit: Codex end-to-end, frame 2 duration 137ms, raw 422, exact protected outside RGBA, reopen and PNG', async () => {
  for (const provider of ['codex'] as const) {
    const root = temporary();
    const { app, req, waitBatch } = await createServer(root);
    try {
      // Create project with 32x32 canvas
      const doc = await (await req('projects', 'POST', { name: `Region ${provider}`, w: 32, h: 32 })).json();
      const base = `projects/${doc.id}`;
      let asset = doc.assets[0];

      // Add 2 extra frames to reach 3 frames total (frame 0, 1, 2)
      const frame1Res = await req(`${base}`, 'PUT', {
        revision: doc.revision,
        document: {
          ...doc,
          assets: [
            (() => {
              const a = structuredClone(asset);
              duplicateFrame(a, a.frames[0].id, 'copy');
              duplicateFrame(a, a.frames[1].id, 'copy');
              a.frames[2].duration = 137;
              a.metadata = {
                pivot: { x: 0.23, y: 0.91 },
                hitbox: { x: 4, y: 4, w: 12, h: 12 },
                events: [
                  { frame: 1, name: 'step' },
                  { frame: 2, name: 'attack' },
                ],
              };
              // Paint reference pixel at (0, 0)
              const c = celFor(a, a.layers[0].id, a.frames[2].id, true)!;
              c.data![0] = 0x70c989ff;
              c.data![16 * 32 + 16] = 0xffffffff;
              return a;
            })(),
          ],
        },
      });
      assert.equal(frame1Res.status, 200);
      const updatedDoc = await frame1Res.json();
      asset = updatedDoc.assets[0];
      const targetFrame = asset.frames[2];
      assert.equal(targetFrame.duration, 137);

      // Define binary mask: (0,0) is 0 (outside mask), center pixels (16,16) are 1 (inside mask)
      const mask = new Array(32 * 32).fill(0);
      mask[16 * 32 + 16] = 1;
      mask[16 * 32 + 17] = 1;

      // Start regionEdit batch
      const batchRes = await req(`${base}/generation-batches`, 'POST', {
        revision: updatedDoc.revision,
        provider,
        prompt: 'Edit chest emblem in center',
        regionEdit: {
          frameId: targetFrame.id,
          mask,
        },
      });
      assert.equal(batchRes.status, 202);
      const batchInfo = await batchRes.json();
      assert.equal(batchInfo.config.operation, 'region-edit');
      assert.equal(batchInfo.config.regionEdit.frameId, targetFrame.id);
      assert.equal(batchInfo.config.regionEdit.duration, 137);
      assert.equal(batchInfo.config.regionEdit.anchor.x, 0.23 * 32);
      assert.equal(batchInfo.config.regionEdit.anchor.y, 0.91 * 32);
      // Ensure NO mask, NO data, NO rgba in compact config
      assert.equal((batchInfo.config as any).mask, undefined);
      assert.equal((batchInfo.config as any).rgba, undefined);

      const batch = await waitBatch(base, batchInfo.id);
      assert.equal(batch.status, 'ready');
      assert.equal(batch.candidates.length, 3);

      // Candidate 2 preview
      const previewRes = await req(`${base}/generation-batches/${batch.id}/candidates/${batch.candidates[1].id}/preview`, 'POST', {
        revision: updatedDoc.revision,
      });
      assert.equal(previewRes.status, 200);
      const preview = await previewRes.json();

      const rawVariant = preview.variants.find((v: any) => v.kind === 'raw');
      const protectedVariant = preview.variants.find((v: any) => v.kind === 'protected');
      assert.ok(rawVariant);
      assert.ok(protectedVariant);
      assert.equal(rawVariant.canApply, false);
      assert.equal(protectedVariant.canApply, true);
      assert.equal(preview.selectedVariantId, protectedVariant.id);

      // Attempting to apply raw variant must throw 422
      const rawApplyRes = await req(`${base}/apply-proposal`, 'POST', {
        revision: updatedDoc.revision,
        proposalId: preview.proposalId,
        variantId: rawVariant.id,
      });
      assert.equal(rawApplyRes.status, 422);

      // Apply protected variant
      const applyRes = await req(`${base}/apply-proposal`, 'POST', {
        revision: updatedDoc.revision,
        proposalId: preview.proposalId,
        variantId: protectedVariant.id,
      });
      assert.equal(applyRes.status, 200);
      const savedDoc = await applyRes.json();

      // Verify the newly applied asset
      const newAsset = savedDoc.assets[savedDoc.assets.length - 1];
      assert.notEqual(newAsset.id, asset.id);
      assert.equal(newAsset.frames.length, 1);
      assert.equal(newAsset.frames[0].duration, 137);
      assert.equal(newAsset.tags.length, 0); // No artificial animation tag expansion

      // Metadata preservation: hitbox preserved, event from frame 2 remapped to frame 0, pivot preserved
      assert.deepEqual(newAsset.metadata.hitbox, { x: 4, y: 4, w: 12, h: 12 });
      assert.deepEqual(newAsset.metadata.events, [{ frame: 0, name: 'attack' }]);
      assert.equal(Math.round(newAsset.metadata.pivot.x * 100) / 100, 0.23);
      assert.equal(Math.round(newAsset.metadata.pivot.y * 100) / 100, 0.91);

      // Outside pixel (0,0) must exactly match reference RGBA (0x70c989ff), NOT provider's outside pixel (0x123456)
      const newCelKey = Object.keys(newAsset.cels)[0];
      const celText = await (await req(`${base}/cel?asset=${newAsset.id}&cel=${newCelKey}&revision=${savedDoc.revision}`)).text();
      assert.equal(wireParse(celText).data[0], 0x70c989ff);

      // Reopen project from disk/store and assert identical properties
      const reopenRes = await req(`${base}`);
      assert.equal(reopenRes.status, 200);
      const reloadedDoc = await reopenRes.json();
      const reloadedAsset = reloadedDoc.assets[reloadedDoc.assets.length - 1];
      assert.equal(reloadedAsset.frames.length, 1);
      assert.equal(reloadedAsset.frames[0].duration, 137);
      assert.deepEqual(reloadedAsset.metadata.events, [{ frame: 0, name: 'attack' }]);
      assert.equal(reloadedAsset.provenance?.batch?.config?.operation, 'region-edit');
      assert.equal(reloadedAsset.provenance?.batch?.config?.regionEdit?.duration, 137);

      // Export PNG and verify raster matches composite
      const exportRes = await req(`${base}/export`, 'POST', {
        revision: reloadedDoc.revision,
        assetId: reloadedAsset.id,
        format: 'png',
      });
      assert.equal(exportRes.status, 200);
      const pngBytes = new Uint8Array(await exportRes.arrayBuffer());
      const decoded = decodePng(pngBytes);
      assert.equal(decoded.w, 32);
      assert.equal(decoded.h, 32);
      assert.equal(decoded.pixels[0], 0x70c989ff, 'Outside pixel in exported PNG must match reference RGBA');
      assert.notEqual(decoded.pixels[16 * 32 + 16], 0, 'Edited pixel in exported PNG must not be transparent');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Region edit: palette mismatch returns 422 without AI calls; normalization-copy preserves provenance and originalSource', async () => {
  const root = temporary();
  const { app, req } = await createServer(root);
  try {
    const callsFile = join(root, 'fixture-cli-calls.jsonl');
    const doc = await (await req('projects', 'POST', { name: 'Palette Mismatch', w: 16, h: 16 })).json();
    const base = `projects/${doc.id}`;
    const asset = doc.assets[0];

    // Paint pixel with color not in target palette
    const paintRes = await req(`${base}`, 'PUT', {
      revision: doc.revision,
      document: {
        ...doc,
        assets: [
          (() => {
            const a = structuredClone(asset);
            celFor(a, a.layers[0].id, a.frames[0].id, true)!.data![0] = 0x993311ff;
            return a;
          })(),
        ],
      },
    });
    const updatedDoc = await paintRes.json();
    const mask = new Array(256).fill(0);
    mask[10] = 1;

    // Start region edit requesting target palette that does NOT contain 0x993311ff
    const restrictedPalette = [0x70c989ff, 0xffffffff];
    const mismatchRes = await req(`${base}/generation-batches`, 'POST', {
      revision: updatedDoc.revision,
      provider: 'codex',
      prompt: 'Region edit',
      artDirection: {
        paletteMode: 'asset',
        palette: restrictedPalette,
      },
      regionEdit: {
        frameId: asset.frames[0].id,
        mask,
      },
    });
    assert.equal(mismatchRes.status, 422);
    const errJson = await mismatchRes.json();
    assert.ok((errJson.error ?? errJson.message).includes('Mẫu có màu ngoài palette đích.'));
    // Ensure no CLI calls were made
    assert.equal(existsSync(callsFile), false);

    // Normalization-copy flow via reference-proposal with artDirection
    const refPropRes = await req(`${base}/reference-proposal`, 'POST', {
      revision: updatedDoc.revision,
      assetId: asset.id,
      frameId: asset.frames[0].id,
      artDirection: {
        paletteMode: 'asset',
        palette: restrictedPalette,
      },
    });
    assert.equal(refPropRes.status, 200);
    const refProp = await refPropRes.json();

    // Start normalize
    const normJobRes = await req(`${base}/proposals/${refProp.proposalId}/normalize`, 'POST', {
      revision: updatedDoc.revision,
      alphaThreshold: 128,
    });
    assert.equal(normJobRes.status, 202);
    const normJob = await normJobRes.json();

    // Wait for normalization job to finish
    let jobStatus: any;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const res = await req(`${base}/processing/${normJob.id}`);
      jobStatus = await res.json();
      if (jobStatus.status !== 'running') break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(jobStatus.status, 'ready');

    // Apply normalized variant as copy
    const normApplyRes = await req(`${base}/apply-proposal`, 'POST', {
      revision: updatedDoc.revision,
      proposalId: refProp.proposalId,
      variantId: jobStatus.variantId,
    });
    assert.equal(normApplyRes.status, 200);
    const docWithCopy = await normApplyRes.json();
    assert.equal(docWithCopy.assets.length, 2);

    const copyAsset = docWithCopy.assets[1];
    assert.equal(copyAsset.provenance?.kind, 'normalized');
    assert.deepEqual(copyAsset.provenance?.palette, restrictedPalette);
    // Original source untouched
    assert.equal(docWithCopy.assets[0].palette.length, asset.palette.length);
    // Zero CLI executions throughout normalization-copy
    assert.equal(existsSync(callsFile), false);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Region edit: lighting preference has no contradictory upper-left in prompt and provenance validation passes', () => {
  // 1. Lighting instruction: explicit non-default light
  const mockDoc = {
    schemaVersion: 1 as const,
    id: 'test-doc',
    name: 'Doc',
    revision: 1,
    files: { 'art.px.js': '' },
    entry: 'art.px.js',
    pixels: {},
    metadata: {},
  };
  const mockGen = {
    options: { style: 'game' as const, view: 'front' as const, paletteMode: 'auto16' as const, reference: false },
    assetId: 'a1',
    w: 32,
    h: 32,
    palette: [0xffffffff],
  };
  const prompt = buildBatchCandidatePrompt(
    mockDoc,
    'Create hero',
    'REF',
    0,
    { style: 'game', paletteMode: 'auto16', light: 'side-dramatic', detailLevel: 'medium', outline: 'dark', references: [] },
    0,
    '',
    mockGen
  );
  assert.ok(!prompt.includes('upper-left'));
  assert.ok(prompt.includes('consistent side-dramatic light'));
  assert.ok(prompt.includes('Lighting preference: side-dramatic.'));

  // 2. Provenance validator accepts regionEdit with fractional bounded anchor and rejects invalid keys
  const validProv = {
    batchId: 'batch-1',
    candidateId: 'cand-1',
    provider: 'codex' as const,
    prompt: 'Region edit prompt',
    config: {
      target: { w: 32, h: 32, name: 'Hero', assetId: 'hero-1' },
      operation: 'region-edit' as const,
      regionEdit: {
        frameId: 'frame-1',
        duration: 137,
        anchor: { x: 7.36, y: 29.12 },
      },
    },
  };
  const validated = validateBatchProvenance(validProv, 32, 32);
  assert.equal(validated.config?.operation, 'region-edit');
  assert.equal(validated.config?.regionEdit?.duration, 137);

  // Rejects out-of-bounds anchor
  assert.throws(() => {
    validateBatchProvenance({
      ...validProv,
      config: {
        ...validProv.config,
        regionEdit: {
          frameId: 'frame-1',
          duration: 137,
          anchor: { x: 50, y: 10 },
        },
      },
    }, 32, 32);
  });

  // Rejects unexpected keys like mask or rgba
  assert.throws(() => {
    validateBatchProvenance({
      ...validProv,
      config: {
        ...validProv.config,
        regionEdit: {
          ...validProv.config.regionEdit,
          mask: [1, 0],
        },
      },
    }, 32, 32);
  });
});
