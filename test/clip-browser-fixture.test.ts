// Verifies the browser harness supports real clip helpers; no real CLI calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { AiManager } from '../src/node/studio/ai.ts';
import { startRender } from '../src/node/studio/runner.ts';
import type { GenerationContext } from '../src/studio/types.ts';

test('Browser fake CLI handles Codex clips with actual guide and K1/fullN source pixels', async () => {
  const f = savedClipFixture('whole', true);
  const proposals = new Proposals(f.store, async (_id, request) => startRender(request).promise, () => {});
  let manager: AiManager | undefined;
  try {
    const snapshot = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
    const generation: GenerationContext = { operation: 'clip-regenerate', assetId: f.source.id, w: 4, h: 3,
      options: { style: 'game', view: 'side', paletteMode: 'asset', reference: true }, palette: snapshot.context.palette,
      clip: { context: snapshot.context, helperFiles: snapshot.helperFiles, facing: snapshot.facing,
        template: snapshot.template, guideMetadata: snapshot.guideMetadata } };
    manager = new AiManager({ load: () => snapshot.contextDoc, save: () => { throw new Error('Fixture must not save'); } }, () => {},
      { codex: process.execPath, antigravity: process.execPath,
        prefix: [resolve('studio/fake-cli.js'), '--state-dir', f.root], timeout: 10_000 });
    for (const provider of ['codex'] as const) {
      const job = await manager.start(snapshot.contextDoc, provider, 'Clip browser fixture', Buffer.from(snapshot.preview, 'base64'),
        generation, undefined, { candidateIndex: 0,
          guideImage: { name: 'clip-guide.png', data: Buffer.from(snapshot.guidePreview, 'base64') } });
      const done = await manager.waitFor(job.id);
      assert.equal(done.status, 'ready', done.message); assert.equal(done.cliExecutions, 1);
      proposals.rememberReference(job.id, f.saved.id, snapshot.referenceId);
      const preview = await proposals.capture(f.saved.id, f.saved.revision, manager.candidate(job.id), generation, job.id);
      const raw = preview.variants.find(v => v.kind === 'raw')!, full = preview.variants.find(v => v.kind === 'protected')!;
      assert.equal(raw.assets[0].frames.length, 1); assert.equal(raw.canApply, false);
      assert.equal(preview.selectedVariantId, full.id);
      for (let i = 0; i < 4; i++) {
        const frame = await proposals.frame(f.saved.id, preview.proposalId, full.id, full.assets[0].id, f.clip.slots[i].id, f.saved.revision);
        assert.deepEqual(frame.data, f.images[i]); assert.equal(frame.duration, f.durations[i]);
      }
    }
    assert.deepEqual(readFileSync(f.manifest), f.originalManifest);
  } finally { try { await manager?.close(); } finally { proposals.close(); f.close(); } }
});
