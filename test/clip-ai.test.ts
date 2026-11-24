import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { AiManager } from '../src/node/studio/ai.ts';
import { startRender } from '../src/node/studio/runner.ts';
import { buildAiPrompt, buildBatchCandidatePrompt } from '../src/node/studio/ai-prompt.ts';
import type { GenerationContext } from '../src/studio/types.ts';

const fixture = resolve('test/fixtures/clip-cli.js');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function setup() {
  const f = savedClipFixture(), proposals = new Proposals(f.store, async (_id, request) => startRender(request).promise, () => {});
  try {
    const snapshot = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
    const generation: GenerationContext = {
      options: { style: 'game', view: 'side', paletteMode: 'auto16', reference: true },
      assetId: f.source.id,
      w: 4,
      h: 3,
      palette: snapshot.context.palette,
      operation: 'clip-regenerate',
      clip: {
        context: snapshot.context,
        helperFiles: snapshot.helperFiles,
        facing: snapshot.facing,
        template: snapshot.template,
        guideMetadata: snapshot.guideMetadata,
      },
    };
    return { f, proposals, snapshot, generation, close() { try { proposals.close(); } finally { f.close(); } } };
  } catch (error) {
    proposals.close();
    f.close();
    throw error;
  }
}

test('Clip AI unit: prompt generates correct clear-before-stamp and whole-image guide dimensions', async () => {
  const h = await setup();
  try {
    const prompt = buildAiPrompt(h.snapshot.contextDoc, 'Vẫy tay', 'DSL', '', h.generation);
    assert.match(prompt, /rect\(0, 0, 4, 3, '_'\), stamp\('_pxl_clip_slot_0', 0, 0\)/);
    const guidePng = Buffer.from(h.snapshot.guidePreview, 'base64');
    assert.ok(prompt.includes(`total guide image size ${guidePng.readUInt32BE(16)}x${guidePng.readUInt32BE(20)} pixels`));
    assert.ok(prompt.includes(JSON.stringify(h.snapshot.context.name)));
  } finally {
    h.close();
  }
});

test('Clip AI unit: start() freezes input bytes, generation, and options before execution', async () => {
  const h = await setup();
  const manager = new AiManager({ load: () => h.snapshot.contextDoc, save: () => { throw new Error('No save'); } }, () => {},
    { codex: process.execPath, antigravity: process.execPath, prefix: [fixture, '--scenario', 'valid', '--state-dir', h.f.root], timeout: 10_000 });
  try {
    const preview = Buffer.from(h.snapshot.preview, 'base64');
    const guide = Buffer.from(h.snapshot.guidePreview, 'base64');
    const mask = Buffer.from(h.snapshot.maskPreview!, 'base64');
    const refs = [{ name: 'custom-ref.png', data: Uint8Array.from([1, 2, 3]) }];
    const options: any = { candidateIndex: 0, guideImage: { name: 'clip-guide.png', data: guide }, referenceImages: refs, timeout: 10_000 };
    const generation = structuredClone(h.generation);

    const starting = manager.start(h.snapshot.contextDoc, 'codex', 'Vẫy tay', preview, generation, mask, options);
    preview.fill(0);
    guide.fill(0);
    mask.fill(0);
    refs[0].data.fill(0);
    generation.clip!.context.loop = true;
    options.timeout = 1;

    const job = await starting;
    const done = await manager.waitFor(job.id);
    assert.equal(done.status, 'ready');
    assert.equal(done.generation!.clip!.context.loop, false);
  } finally {
    await manager.close();
    h.close();
  }
});
