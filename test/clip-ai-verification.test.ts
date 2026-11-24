// Codex image-context integration; DeepSeek text-only admission is covered separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { AiManager } from '../src/node/studio/ai.ts';
import { startRender } from '../src/node/studio/runner.ts';
import { buildAiPrompt, buildBatchCandidatePrompt } from '../src/node/studio/ai-prompt.ts';
import type { GenerationContext } from '../src/studio/types.ts';

const fixture = resolve('test/fixtures/clip-cli.js');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const records = (root: string) => readFileSync(join(root, 'clip-cli-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function setup() {
  const f = savedClipFixture(), proposals = new Proposals(f.store, async (_id, request) => startRender(request).promise, () => {});
  try {
    const snapshot = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
    const generation: GenerationContext = { options: { style: 'game', view: 'side', paletteMode: 'auto16', reference: true },
      assetId: f.source.id, w: 4, h: 3, palette: snapshot.context.palette, operation: 'clip-regenerate',
      clip: { context: snapshot.context, helperFiles: snapshot.helperFiles, facing: snapshot.facing,
        template: snapshot.template, guideMetadata: snapshot.guideMetadata } };
    return { f, proposals, snapshot, generation, close() { try { proposals.close(); } finally { f.close(); } } };
  } catch (error) { proposals.close(); f.close(); throw error; }
}

test('Independent clip prompt: both builders omit every owned RLE and fix selected K/timing/loop/palette/guide', async () => {
  const h = await setup();
  try {
    const document = structuredClone(h.snapshot.contextDoc);
    h.snapshot.helperFiles.forEach((name, i) => { document.files[name] = `SECRET_OWNED_RLE_${i}_${'0123456789'.repeat(200)}`; });
    for (const prompt of [buildAiPrompt(document, 'Vẫy tay', 'DSL', '', h.generation),
      buildBatchCandidatePrompt(document, 'Vẫy tay', 'DSL', 0, undefined, [], '', h.generation)]) {
      assert.equal(prompt.includes('SECRET_OWNED_RLE'), false);
      assert.ok(prompt.includes('200')); assert.ok(prompt.includes('false'));
      assert.ok(prompt.includes(h.snapshot.context.slots[2].id));
      assert.match(prompt, /clip-guide\.png/); assert.match(prompt, /keyframe|pose/i);
      assert.equal(prompt.includes('Choose a cohesive palette of at most 16'), false, 'approved clip palette is fixed even auto16');
      assert.ok(prompt.length < 250_000);
    }
  } finally { h.close(); }
});

test('Independent Codex clip calls: same separate guide plus three refs, cloned bytes/context and exactly one call each', async () => {
  const h = await setup();
  const manager = new AiManager({ load: () => h.snapshot.contextDoc, save: () => { throw new Error('No project save'); } }, () => {},
    { codex: process.execPath, antigravity: process.execPath, prefix: [fixture, '--scenario', 'valid', '--state-dir', h.f.root], timeout: 10_000 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const provider = 'codex';
      const preview = Buffer.from(h.snapshot.preview, 'base64'), guide = Buffer.from(h.snapshot.guidePreview, 'base64'),
        mask = Buffer.from(h.snapshot.maskPreview!, 'base64');
      const generation = structuredClone(h.generation), expectedGuide = hash(guide), expectedPreview = hash(preview), expectedMask = hash(mask);
      const refs = ['clip-guide.png', 'preview.png', 'movement-mask.png'].map((name, i) => ({ name, data: Uint8Array.from([137, 80, 78, 71, i + 1]) }));
      const options: any = { candidateIndex: 0, guideImage: { name: 'clip-guide.png', data: guide }, referenceImages: refs, timeout: 10_000 };
      const starting = manager.start(h.snapshot.contextDoc, provider, 'Vẫy tay', preview, generation, mask, options);
      guide.fill(0); preview.fill(0); mask.fill(0); refs[0].data.fill(0); generation.clip!.context.loop = true; options.timeout = 1;
      const job = await starting, done = await manager.waitFor(job.id);
      assert.equal(done.status, 'ready', done.message); assert.equal(done.cliExecutions, 1);
      const entry = records(h.f.root).at(-1)!;
      assert.deepEqual(entry.supplied, ['preview.png', 'movement-mask.png', 'clip-guide.png', 'art-ref-1.png', 'art-ref-2.png', 'art-ref-3.png']);
      assert.equal(entry.images['clip-guide.png'], expectedGuide); assert.equal(entry.images['preview.png'], expectedPreview);
      assert.equal(entry.images['movement-mask.png'], expectedMask);
      assert.equal(done.generation!.clip!.context.loop, false);
    }
    const runs = records(h.f.root); assert.equal(runs.length, 2); assert.deepEqual(runs[0].images, runs[1].images);
    assert.deepEqual(readFileSync(h.f.manifest), h.f.originalManifest);
  } finally { await manager.close(); h.close(); }
});

test('Independent clip adapters: exact/case/dot/separator and duplicate aliases cannot replace immutable source; only one repair', async () => {
  const h = await setup();
  try {
    for (const provider of ['codex'] as const) for (const scenario of ['owned-exact', 'owned-case', 'owned-dot', 'owned-backslash', 'duplicate-alias']) {
      const manager = new AiManager({ load: () => h.snapshot.contextDoc, save: () => { throw new Error('No save'); } }, () => {},
        { codex: process.execPath, antigravity: process.execPath, prefix: [fixture, '--scenario', scenario, '--state-dir', h.f.root], timeout: 10_000 });
      try {
        const job = await manager.start(h.snapshot.contextDoc, provider, 'Vẫy tay', Buffer.from(h.snapshot.preview, 'base64'), h.generation,
          Buffer.from(h.snapshot.maskPreview!, 'base64'), { candidateIndex: 0,
            guideImage: { name: 'clip-guide.png', data: Buffer.from(h.snapshot.guidePreview, 'base64') } });
        const done = await manager.waitFor(job.id);
        assert.equal(done.status, 'failed', `${provider}/${scenario}: ${done.message}`); assert.equal(done.cliExecutions, 2);
        assert.equal(done.proposal, undefined); assert.equal(existsSync(h.f.manifest), true);
      } finally { await manager.close(); }
    }
    assert.deepEqual(readFileSync(h.f.manifest), h.f.originalManifest);
  } finally { h.close(); }
});

test('Independent legacy animation adapters: Windows case aliases cannot bypass immutable reference protection', async () => {
  const h = await setup();
  try {
    const document = { ...h.snapshot.contextDoc, files: {
      '_pxl_reference.px.js': h.snapshot.contextDoc.files['_pxl_clip_master.px.js'].replaceAll('_pxl_clip_master', '_pxl_reference'),
      'art.px.js': "include('_pxl_reference.px.js');anim('proposal',{w:4,h:3,base:'_pxl_reference',loop:true},frame({ms:100}),frame({ms:100}))",
    } };
    const generation: GenerationContext = { options: { style: 'game', view: 'description', paletteMode: 'asset', reference: true },
      assetId: h.f.source.id, w: 4, h: 3, palette: h.f.source.palette,
      animation: { frameId: h.f.character.source.frameId, mode: 'whole', frames: 2, duration: 100, loop: true,
        anchor: { x: 2, y: 3 }, referenceFile: '_pxl_reference.px.js' } };
    for (const provider of ['codex'] as const) {
      const manager = new AiManager({ load: () => document, save: () => { throw new Error('No save'); } }, () => {},
        { codex: process.execPath, antigravity: process.execPath, prefix: [fixture, '--scenario', 'legacy-case', '--state-dir', h.f.root], timeout: 10_000 });
      try {
        const job = await manager.start(document, provider, 'Legacy animation', Buffer.from(h.snapshot.preview, 'base64'), generation,
          undefined, { candidateIndex: 0 });
        const done = await manager.waitFor(job.id);
        assert.equal(done.status, 'failed', done.message); assert.equal(done.cliExecutions, 2); assert.equal(done.proposal, undefined);
      } finally { await manager.close(); }
    }
  } finally { h.close(); }
});

test('Independent legacy prompt: a user helper with an underscore prefix is not treated as an app-owned reference', async () => {
  const h = await setup();
  try {
    const document = { ...h.snapshot.contextDoc, files: { 'art.px.js': "include('_pxl_user.px.js')",
      '_pxl_user.px.js': "// USER_OWNED_HELPER_MUST_REMAIN_IN_CONTEXT\nsprite('user',{w:4,h:3})" } };
    assert.ok(buildAiPrompt(document, 'Keep user helpers', 'DSL').includes('USER_OWNED_HELPER_MUST_REMAIN_IN_CONTEXT'));
    assert.ok(buildBatchCandidatePrompt(document, 'Keep user helpers', 'DSL', 0).includes('USER_OWNED_HELPER_MUST_REMAIN_IN_CONTEXT'));
  } finally { h.close(); }
});

test('Independent clip adapters: copied workfile edits never replace immutable candidate source', async () => {
  const h = await setup();
  try {
    for (const provider of ['codex'] as const) {
      const manager = new AiManager({ load: () => h.snapshot.contextDoc, save: () => { throw new Error('No save'); } }, () => {},
        { codex: process.execPath, antigravity: process.execPath, prefix: [fixture, '--scenario', 'modify-copy', '--state-dir', h.f.root], timeout: 10_000 });
      try {
        const job = await manager.start(h.snapshot.contextDoc, provider, 'Use approved source', Buffer.from(h.snapshot.preview, 'base64'), h.generation,
          Buffer.from(h.snapshot.maskPreview!, 'base64'), { candidateIndex: 0,
            guideImage: { name: 'clip-guide.png', data: Buffer.from(h.snapshot.guidePreview, 'base64') } });
        const done = await manager.waitFor(job.id);
        assert.equal(done.status, 'ready', done.message); assert.equal(done.cliExecutions, 1);
        const candidate = manager.candidate(job.id);
        for (const name of h.snapshot.helperFiles) assert.equal(candidate.files[name], h.snapshot.contextDoc.files[name]);
        h.proposals.rememberReference(job.id, h.f.saved.id, h.snapshot.referenceId);
        const preview = await h.proposals.capture(h.f.saved.id, h.f.saved.revision, candidate, h.generation, job.id);
        assert.ok(preview.variants.find(v => v.kind === 'protected')?.canApply);
      } finally { await manager.close(); }
    }
    assert.deepEqual(readFileSync(h.f.manifest), h.f.originalManifest);
  } finally { h.close(); }
});
