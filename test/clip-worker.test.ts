import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { VariantStore } from '../src/node/studio/variant-store.ts';
import { startRender, type WorkerRequest } from '../src/node/studio/runner.ts';
import { wireParse } from '../src/studio/pixel/model.ts';
import type { ExportResult } from '../src/node/studio/render.ts';

async function run(root: string, request: Record<string, unknown>): Promise<any> {
  const result = await startRender({ mode: 'pixel-process', root, ...request } as WorkerRequest).promise as ExportResult;
  return wireParse(Buffer.from(result.data).toString('utf8'));
}
async function setup(f: ReturnType<typeof savedClipFixture>, repo: VariantStore) {
  return run(repo.root, { operation: 'clip-prepare', projectRoot: f.root, projectId: f.saved.id,
    revision: f.saved.revision, clipId: f.clip.id, paletteMode: 'asset', targetPalette: f.source.palette });
}

test('Clip worker: private-only and broken source produce concrete errors without a fabricated raw image', async () => {
  const f = savedClipFixture(), repo = new VariantStore();
  try {
    const snapshot = await setup(f, repo), include = snapshot.helperFiles.map((name: string) => `include(${JSON.stringify(name)});`).join('\n');
    for (const source of [include, 'sprite(']) {
      const document = { ...snapshot.contextDoc, files: { ...snapshot.contextDoc.files, 'art.px.js': source } };
      const result = await run(repo.root, { operation: 'clip-capture', context: snapshot.context, referenceId: snapshot.referenceId,
        revision: snapshot.context.revision, document });
      assert.equal(result.raw, undefined); assert.equal(result.protected, undefined);
      assert.ok(result.quality.errors.length); assert.deepEqual(result.quality.assets, []);
      assert.equal(repo.store.list().length, 1, 'only original reference is retained');
    }
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { repo.close(); f.close(); }
});

test('Clip worker: absent snapshot signatures never fall back to unbound processing', async () => {
  const f = savedClipFixture(), repo = new VariantStore();
  try {
    const snapshot = await setup(f, repo), request = { context: snapshot.context, referenceId: snapshot.referenceId, revision: snapshot.context.revision };
    const result = await run(repo.root, { ...request, operation: 'clip-capture', document: snapshot.contextDoc });
    assert.ok(result.raw && result.protected);
    const rawPath = join(repo.store.dir(result.raw.id), 'variant.json'), originalRaw = readFileSync(rawPath);
    const brokenRaw = JSON.parse(originalRaw.toString('utf8')); delete brokenRaw.clip.contextDigest;
    writeFileSync(rawPath, JSON.stringify(brokenRaw));
    await assert.rejects(() => run(repo.root, { ...request, operation: 'clip-normalize', rawVariantId: result.raw.id, alphaThreshold: 128 }), /snapshot|context/i);
    writeFileSync(rawPath, originalRaw);
    const refPath = join(repo.store.dir(snapshot.referenceId), 'variant.json'), originalRef = readFileSync(refPath);
    for (const field of ['contextDigest', 'maskDigest']) {
      const brokenRef = JSON.parse(originalRef.toString('utf8')); delete brokenRef.clip[field];
      writeFileSync(refPath, JSON.stringify(brokenRef));
      await assert.rejects(() => run(repo.root, { ...request, operation: 'clip-capture', document: snapshot.contextDoc }), /snapshot|context|Mask/i);
      const checked = await run(repo.root, { ...request, operation: 'clip-verify', variantId: result.protected.id });
      assert.equal(checked.valid, false);
      writeFileSync(refPath, originalRef);
    }
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { repo.close(); f.close(); }
});
