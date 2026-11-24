import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { savedClipFixture } from './clip-worker-fixture.ts';
import { Proposals } from '../src/node/studio/proposals.ts';
import { startRender, type WorkerRequest } from '../src/node/studio/runner.ts';
import type { GenerationContext, ProjectDocument } from '../src/studio/types.ts';
import { celFor, duplicateFrame } from '../src/studio/pixel/model.ts';
import { recaptureCharacterProfile, approveCharacterProfile } from '../src/studio/character-commands.ts';

function createProposals(store: any, emit = (_: any) => {}) {
  return new Proposals(store, async (_id: string, req: WorkerRequest) => {
    return startRender(req).promise;
  }, emit);
}

for (const mode of ['region', 'whole'] as const) {
  test(`Clip proposals bridge: ${mode} scope + K1/N4 mixed timing, nonfirst source, capture, normalize, forApply`, async () => {
    const f = savedClipFixture(mode, true);
    const proposals = createProposals(f.store);
    try {
      // 1. clipReference
      const snapshot = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
      assert.ok(snapshot.referenceId);
      assert.equal(snapshot.context.mode, mode);
      assert.equal(snapshot.context.slots.length, 4);
      assert.equal(snapshot.context.sourceFrameId, f.character.source.frameId);

      proposals.rememberReference('job-clip-1', f.saved.id, snapshot.referenceId);

      const generation: GenerationContext = {
        options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
        assetId: snapshot.context.clipId,
        w: snapshot.context.w,
        h: snapshot.context.h,
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

      // 2. capture
      const preview = await proposals.capture(f.saved.id, f.saved.revision, snapshot.contextDoc, generation, 'job-clip-1');
      assert.equal(preview.variants.length, 2);
      const raw = preview.variants.find(v => v.kind === 'raw')!;
      const prot = preview.variants.find(v => v.kind === 'protected')!;
      assert.ok(raw);
      assert.ok(prot);
      assert.equal(raw.canApply, false);
      assert.equal(prot.canApply, true);
      // Protected is selected by default even for whole mode (K=N or K=1)
      assert.equal(preview.selectedVariantId, prot.id);

      // 3. raw and reference apply refusal
      await assert.rejects(
        () => proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision, raw.id),
        /raw|mẫu tham chiếu|chưa thể áp dụng/i
      );
      await assert.rejects(
        () => proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision, snapshot.referenceId),
        /raw|mẫu tham chiếu|chưa thể áp dụng|không thuộc/i
      );

      // 4. Lazy frames and difference mapping
      // Valid frame for protected variant at selected slot (index 2)
      const slot2Id = f.clip.slots[2].id;
      const frameSelected = await proposals.frame(f.saved.id, preview.proposalId, prot.id, prot.assets[0].id, slot2Id, f.saved.revision);
      assert.equal(frameSelected.w, f.w);
      assert.equal(frameSelected.h, f.h);

      // Mapped difference between protected and reference (baseline)
      const diffBaseline = await proposals.frame(f.saved.id, preview.proposalId, prot.id, prot.assets[0].id, slot2Id, f.saved.revision, 'difference', 'reference');
      assert.equal(diffBaseline.w, f.w);
      assert.ok(diffBaseline.data instanceof Uint32Array);

      // Mapped difference between protected and raw (maps to selected-slot order)
      const diffRaw = await proposals.frame(f.saved.id, preview.proposalId, prot.id, prot.assets[0].id, slot2Id, f.saved.revision, 'difference', 'raw');
      assert.equal(diffRaw.w, f.w);
      assert.ok(diffRaw.data instanceof Uint32Array);

      // Unselected-raw error: slot 0 is unselected/retained, has no raw counterpart
      const slot0Id = f.clip.slots[0].id;
      await assert.rejects(
        () => proposals.frame(f.saved.id, preview.proposalId, prot.id, prot.assets[0].id, slot0Id, f.saved.revision, 'difference', 'raw'),
        /không được chọn|không có ảnh AI thô/i
      );

      // Master error: difference against master is unsupported
      const masterAssetId = snapshot.referenceInfo.clip!.masterAssetId!;
      const masterAsset = snapshot.referenceInfo.assets.find(a => a.id === masterAssetId)!;
      await assert.rejects(
        () => proposals.frame(f.saved.id, preview.proposalId, snapshot.referenceId, masterAssetId, masterAsset.frames[0].id, f.saved.revision, 'difference', 'reference'),
        /master/i
      );

      // 5. Local normalize
      const normJob = proposals.startNormalize(f.saved.id, preview.proposalId, f.saved.revision, 128);
      assert.equal(normJob.status, 'running');
      // Wait for async normalization to complete
      for (let i = 0; i < 50; i++) {
        if (normJob.status !== 'running') break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(normJob.status, 'ready');
      const updatedPreview = proposals.describe(f.saved.id, preview.proposalId, f.saved.revision);
      assert.equal(updatedPreview.variants.length, 3);
      const normalized = updatedPreview.variants.find(v => v.kind === 'normalized')!;
      assert.ok(normalized);
      assert.equal(normalized.canApply, true);

      // 6. forApply - repeated applications return fresh IDs without mutating stored variant
      const applied1 = await proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision);
      const applied2 = await proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision);

      assert.equal(applied1.assets.length, 1);
      assert.equal(applied2.assets.length, 1);
      assert.notEqual(applied1.assets[0].id, applied2.assets[0].id);
      assert.notEqual(applied1.assets[0].id, f.clip.id);

      // Stored variant in repository still has asset.id === clipId
      const storedAsset = proposals.repo.assets(prot.id)[0];
      assert.equal(storedAsset.id, f.clip.id);

      // Check preserved properties
      const asset = applied1.assets[0];
      assert.equal(asset.frames.length, 4);
      assert.deepEqual(asset.frames.map(fr => fr.id), f.clip.slots.map(s => s.id));
      assert.deepEqual(asset.frames.map(fr => fr.duration), f.durations);
      assert.deepEqual(asset.metadata.hitbox, f.source.metadata.hitbox);
      assert.deepEqual(asset.metadata.pivot, f.source.metadata.pivot);

      // 7. Releasing one proposal preserves shared reference
      proposals.releaseProposal(f.saved.id, preview.proposalId);
      assert.ok(proposals.repo.assets(snapshot.referenceId).length > 0);
    } finally {
      proposals.close();
      f.close();
    }
  });
}

test('Clip proposals: foreign reference and missing reference are rejected', async () => {
  const f1 = savedClipFixture();
  const f2 = savedClipFixture();
  const proposals = createProposals(f1.store);
  try {
    const snap1 = await proposals.clipReference(f1.saved.id, f1.saved.revision, f1.clip.id, 'asset', f1.source.palette);
    proposals.rememberReference('job-foreign', f1.saved.id, snap1.referenceId);

    // Copy second project into f1's store so foreign reference case reaches ownership guard
    const foreignSaved = f1.store.create(f2.document.name, 4, 3, 0, f2.document);

    // Try to use f1's reference in foreign project
    const gen2: GenerationContext = {
      options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
      assetId: f2.clip.id,
      w: f2.w,
      h: f2.h,
      palette: f2.source.palette,
      operation: 'clip-regenerate',
      clip: {
        context: snap1.context,
        helperFiles: snap1.helperFiles,
        facing: snap1.facing,
        template: snap1.template,
        guideMetadata: snap1.guideMetadata,
      },
    };

    await assert.rejects(
      () => proposals.capture(foreignSaved.id, foreignSaved.revision, snap1.contextDoc, gen2, 'job-foreign'),
      /không thuộc dự án/i
    );

    // Missing reference
    await assert.rejects(
      () => proposals.capture(f1.saved.id, f1.saved.revision, snap1.contextDoc, gen2, 'job-nonexistent'),
      /không tồn tại|hết hạn|thiếu mẫu/i
    );
  } finally {
    proposals.close();
    f1.close();
    f2.close();
  }
});

test('Clip proposals: project close cancels jobs and cleans up variants without late resurrection', async () => {
  const f = savedClipFixture();
  const events: any[] = [];
  const proposals = createProposals(f.store, e => events.push(e));
  try {
    const snapshot = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
    proposals.rememberReference('job-close', f.saved.id, snapshot.referenceId);

    const generation: GenerationContext = {
      options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
      assetId: snapshot.context.clipId,
      w: snapshot.context.w,
      h: snapshot.context.h,
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

    const preview = await proposals.capture(f.saved.id, f.saved.revision, snapshot.contextDoc, generation, 'job-close');
    const normJob = proposals.startNormalize(f.saved.id, preview.proposalId, f.saved.revision, 128);

    // Close project while job may be in flight
    proposals.closeProject(f.saved.id);

    // Subsequent access throws
    assert.throws(() => proposals.get(f.saved.id, preview.proposalId, f.saved.revision), /đã đóng|cũ hoặc hết hạn/i);
    await assert.rejects(() => proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision), /đã đóng|cũ hoặc hết hạn/i);

    // Fresh explicit clipReference MUST work again after closeProject
    const reopened = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
    assert.ok(reopened.referenceId);

    // Wait briefly and verify job canceled, no ready event
    await new Promise(r => setTimeout(r, 100));
    assert.ok(events.some(e => e.job?.status === 'canceled'));
    assert.ok(!events.some(e => e.job?.id === normJob.id && e.job?.status === 'ready'));

    // Globally disposed instance blocked
    proposals.close();
    await assert.rejects(
      () => proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette),
      /đóng|hết hạn|closed|disposed/i
    );
  } finally {
    proposals.close();
    f.close();
  }
});

test('Clip proposals: stale revision or modified source rejects forApply', async () => {
  const f = savedClipFixture();
  const proposals = createProposals(f.store);
  try {
    const snapshot = await proposals.clipReference(f.saved.id, f.saved.revision, f.clip.id, 'asset', f.source.palette);
    proposals.rememberReference('job-stale', f.saved.id, snapshot.referenceId);

    const generation: GenerationContext = {
      options: { style: 'game', view: 'description', paletteMode: 'asset', reference: false },
      assetId: snapshot.context.clipId,
      w: snapshot.context.w,
      h: snapshot.context.h,
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

    const preview = await proposals.capture(f.saved.id, f.saved.revision, snapshot.contextDoc, generation, 'job-stale');

    // Mutate source profile in store (hydrating cels)
    const doc = f.store.load(f.saved.id, true);
    const sourceAsset = doc.assets.find(a => a.id === f.source.id)!;
    const pixels = celFor(sourceAsset, sourceAsset.layers[0].id, sourceAsset.frames[0].id, true)!.data!;
    pixels[0] = 0x123456ff; // change pixel
    recaptureCharacterProfile(doc, f.character.id);
    approveCharacterProfile(doc, f.character.id);
    const saved2 = f.store.save(f.saved.id, doc.revision, doc);

    // Old revision forApply fails with 409
    await assert.rejects(
      () => proposals.forApply(f.saved.id, preview.proposalId, f.saved.revision),
      /cũ hoặc hết hạn|revision/i
    );
  } finally {
    proposals.close();
    f.close();
  }
});
