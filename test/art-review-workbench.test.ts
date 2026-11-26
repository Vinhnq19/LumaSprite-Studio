import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeTimingSync,
  expandPlaybackSequence,
  getLoopBoundaryFrames,
  sampleSequenceAtTime,
  sampleSyncedPlayback,
} from '../src/studio/art-review/animation-sync.ts';
import { parseAnimationMetadata, parseReviewManifest } from '../src/studio/art-review/metadata.ts';
import {
  checkCompatibility,
  computeAlignedLayout,
  computeFrameDiff,
  computeIntegerFitZoom,
  computePixelDiff,
  computeSilhouette,
  readPixelRgba,
  sliceSpriteStrip,
} from '../src/studio/art-review/pixel-ops.ts';
import {
  createAssetReferenceSnapshot,
  createEmptyReviewSession,
  parseReviewJson,
  renderReviewMarkdown,
  serializeReviewJson,
} from '../src/studio/art-review/report.ts';
import {
  DEFAULT_WORKBENCH_RUBRIC,
  parseRubricJson,
  summarizeReviewScores,
} from '../src/studio/art-review/rubrics.ts';
import { ASSET_FAMILIES } from '../src/studio/art-review/types.ts';

test('ArtReview pixel-ops: straight-alpha RGBA readout and non-mutation of source buffers', () => {
  const srcA = Uint32Array.of(0x1c2d3e55, 0xff0000ff, 0x00ff0080, 0x00000000);
  const srcB = Uint32Array.of(0x1c2d3e55, 0x0000ffff, 0x00ff00ff, 0x00000000);
  const copyA = srcA.slice();
  const copyB = srcB.slice();

  const px = readPixelRgba(srcA, 2, 2, 0, 0);
  assert.deepEqual(px, {
    x: 0,
    y: 0,
    r: 28,
    g: 45,
    b: 62,
    a: 85,
    packed: 0x1c2d3e55,
    hex: '#1c2d3e55',
  });
  assert.equal(readPixelRgba(srcA, 2, 2, -1, 0), null);
  assert.equal(readPixelRgba(srcA, 2, 2, 2, 0), null);

  const diff = computePixelDiff(
    { width: 2, height: 2, rgba: srcA },
    { width: 2, height: 2, rgba: srcB },
    { mode: 'top-left', offsetX: 0, offsetY: 0, confirmed: true },
  );
  assert.equal(diff.stats.changedPixels, 2);
  assert.equal(diff.stats.rgbDiffPixels, 1);
  assert.equal(diff.stats.alphaDiffPixels, 1);
  assert.equal(diff.stats.identicalOverlapPixels, 2);
  assert.equal(diff.stats.maxChannelDelta, 255);

  const sil = computeSilhouette(srcA, 2, 2, 'binary');
  assert.equal(sil.opaquePixels, 1);
  assert.equal(sil.semiTransparentPixels, 2);
  assert.equal(sil.transparentPixels, 1);
  assert.notEqual(sil.rgba[0], 0);
  assert.equal(sil.rgba[3], 0);

  const alphaView = computeSilhouette(srcA, 2, 2, 'alpha-channel');
  assert.equal(alphaView.rgba[0], 0x555555ff);
  assert.equal(alphaView.rgba[1], 0xffffffff);
  assert.equal(alphaView.rgba[3], 0);

  assert.deepEqual(srcA, copyA);
  assert.deepEqual(srcB, copyB);
});

test('ArtReview pixel-ops: mismatch detection, integer alignment without scaling, and strip slicing', () => {
  const a = Uint32Array.of(0x112233ff, 0x445566ff, 0x778899ff, 0xaabbccff); // 2x2
  const b = new Uint32Array(4 * 4); // 4x4 with identical 2x2 placed at (1, 1)
  b[1 * 4 + 1] = 0x112233ff;
  b[1 * 4 + 2] = 0x445566ff;
  b[2 * 4 + 1] = 0x778899ff;
  b[2 * 4 + 2] = 0xaabbccff;

  const compat = checkCompatibility(
    { width: 2, height: 2, pivot: { x: 0, y: 0 } },
    { width: 4, height: 4, pivot: { x: 1, y: 1 } },
  );
  assert.equal(compat.sameSize, false);
  assert.equal(compat.samePivot, false);
  assert.equal(compat.requiresAlignment, true);

  const layout = computeAlignedLayout(
    { width: 2, height: 2, pivot: { x: 0, y: 0 } },
    { width: 4, height: 4, pivot: { x: 1, y: 1 } },
    { mode: 'pivot', offsetX: 0, offsetY: 0, confirmed: true },
  );
  assert.deepEqual(layout, { width: 4, height: 4, aX: 1, aY: 1, bX: 0, bY: 0, dx: -1, dy: -1 });

  const alignedDiff = computePixelDiff(
    { width: 2, height: 2, rgba: a, pivot: { x: 0, y: 0 } },
    { width: 4, height: 4, rgba: b, pivot: { x: 1, y: 1 } },
    { mode: 'pivot', offsetX: 0, offsetY: 0, confirmed: true },
  );
  assert.equal(alignedDiff.width, 4);
  assert.equal(alignedDiff.height, 4);
  assert.equal(alignedDiff.stats.changedPixels, 0);

  const sliced = sliceSpriteStrip(b, 4, 4, [
    { x: 1, y: 1, w: 2, h: 2, durationMs: 75 },
    { x: 0, y: 0, w: 2, h: 2, durationMs: 145 },
  ]);
  assert.equal(sliced.length, 2);
  assert.deepEqual(sliced[0].rgba, a);
  assert.equal(sliced[0].durationMs, 75);
  assert.equal(sliced[1].durationMs, 145);

  assert.throws(() => sliceSpriteStrip(b, 4, 4, [{ x: 3, y: 0, w: 2, h: 2, durationMs: 80 }]), /ngoài ảnh nguồn/);
});

test('ArtReview metadata: parses real frame timings without 100ms fallback and rejects invalid JSON', () => {
  const studioStripJson = JSON.stringify({
    frames: {
      f0: { frame: { x: 0, y: 0, w: 16, h: 16 }, duration: 70 },
      f1: { frame: { x: 16, y: 0, w: 16, h: 16 }, duration: 130 },
      f2: { frame: { x: 32, y: 0, w: 16, h: 16 }, duration: 210 },
    },
    meta: {
      frameTags: [{ name: 'walk', from: 0, to: 2, direction: 'pingpong', loop: false }],
      pxl: { assets: { hero: { pivot: { x: 8, y: 15 } } } },
    },
  });

  const parsed = parseAnimationMetadata(studioStripJson, 48, 16);
  assert.deepEqual(
    parsed.frames.map(f => f.durationMs),
    [70, 130, 210],
  );
  assert.deepEqual(parsed.pivot, { x: 8, y: 15 });
  assert.equal(parsed.direction, 'ping-pong');
  assert.equal(parsed.loop, false);

  const bareArray = parseAnimationMetadata('[65, 195]', 32, 16);
  assert.deepEqual(
    bareArray.frames.map(f => f.durationMs),
    [65, 195],
  );

  assert.throws(() => parseAnimationMetadata('{bad json', 32, 16), /JSON metadata không hợp lệ/);
  assert.throws(
    () => parseAnimationMetadata(JSON.stringify({ frames: [{ x: 0, y: 0, w: 16, h: 16 }] }), 32, 16),
    /không tự gán 100 ms/,
  );
  assert.throws(() => parseAnimationMetadata('[0, 100]', 32, 16), /không hợp lệ/);

  const manifest = parseReviewManifest(
    JSON.stringify({
      kind: 'lumasprite.art-review-manifest.v1',
      assetFamily: 'vfx',
      baseline: { fileName: 'slash_a.png', pivot: { x: 12, y: 12 } },
      candidate: { fileName: 'slash_b.png' },
    }),
  );
  assert.equal(manifest.assetFamily, 'vfx');
  assert.deepEqual(manifest.baseline?.pivot, { x: 12, y: 12 });
  assert.throws(() => parseReviewManifest('{broken'), /JSON manifest không hợp lệ/);
});

test('ArtReview animation-sync: order, loop vs one-shot, wall-clock sync for differing timings, and loop boundary', () => {
  const mkFrame = (index: number, durationMs: number, val: number) => ({
    index,
    width: 2,
    height: 2,
    rgba: Uint32Array.of(val, 0, 0, 0),
    durationMs,
  });

  const framesA = [mkFrame(0, 70, 0xff0000ff), mkFrame(1, 140, 0x00ff00ff), mkFrame(2, 90, 0x0000ffff)];
  const framesB = [mkFrame(0, 110, 0xff0000ff), mkFrame(1, 240, 0x0000ffff)];

  const pingPong = expandPlaybackSequence(framesA, 'ping-pong');
  assert.deepEqual(
    pingPong.map(f => f.index),
    [0, 1, 2, 1],
  );
  const reverse = expandPlaybackSequence(framesA, 'reverse');
  assert.deepEqual(
    reverse.map(f => f.index),
    [2, 1, 0],
  );

  const oneShot = sampleSequenceAtTime(framesA, 350, false);
  assert.equal(oneShot?.done, true);
  assert.equal(oneShot?.frame.index, 2);

  const looped = sampleSequenceAtTime(framesA, 350, true); // 350 % 300 = 50 -> frame 0
  assert.equal(looped?.done, false);
  assert.equal(looped?.frame.index, 0);

  const analysis = analyzeTimingSync(framesA, framesB);
  assert.equal(analysis.timingsDiffer, true);
  assert.equal(analysis.totalMsA, 300);
  assert.equal(analysis.totalMsB, 350);
  assert.match(analysis.explanation, /không giả định frame index/);

  // At t=120ms: A is in frame 1 (70..210), B is in frame 1 (110..350)
  // At t=220ms: A is in frame 2 (210..300), B is STILL in frame 1 (110..350)
  const at220 = sampleSyncedPlayback(framesA, framesB, 220, false, 'time');
  assert.equal(at220.a?.frame.index, 2);
  assert.equal(at220.b?.frame.index, 1);
  assert.equal(at220.done, false);

  // At t=310ms: A finished (300ms), B still running (350ms) -> overall one-shot not done yet
  const at310 = sampleSyncedPlayback(framesA, framesB, 310, false, 'time');
  assert.equal(at310.a?.done, true);
  assert.equal(at310.b?.done, false);
  assert.equal(at310.done, false);

  const at360 = sampleSyncedPlayback(framesA, framesB, 360, false, 'time');
  assert.equal(at360.done, true);

  const boundary = getLoopBoundaryFrames(framesA)!;
  assert.equal(boundary.lastFrame.index, 2);
  assert.equal(boundary.firstFrame.index, 0);
  assert.equal(computeFrameDiff(boundary.lastFrame, boundary.firstFrame).stats.changedPixels, 1);
});

test('ArtReview rubrics & report: 7 families, non-E7 disclaimer, no auto-PASS, JSON/Markdown export & invalid rejection', () => {
  assert.equal(ASSET_FAMILIES.length, 7);
  for (const fam of ASSET_FAMILIES) {
    assert.ok(DEFAULT_WORKBENCH_RUBRIC.families[fam.id].length >= 4);
  }
  assert.equal(DEFAULT_WORKBENCH_RUBRIC.isWorkbenchDefault, true);
  assert.match(DEFAULT_WORKBENCH_RUBRIC.disclaimer, /không phải Universal Quality Contract v1/);

  const customRubricJson = JSON.stringify({
    id: 'custom-v2',
    name: 'Custom Studio Check',
    version: '2.0.0',
    families: Object.fromEntries(
      ASSET_FAMILIES.map(f => [
        f.id,
        [{ id: 'readability', label: 'Readability', description: 'Check 1x', maxScore: 5 }],
      ]),
    ),
  });
  const customRubric = parseRubricJson(customRubricJson);
  assert.equal(customRubric.isWorkbenchDefault, false);
  assert.throws(() => parseRubricJson('{"id":"bad"}'), /Rubric thiếu/);

  const session = createEmptyReviewSession('character', DEFAULT_WORKBENCH_RUBRIC);
  assert.equal(session.decision, 'undecided');
  session.scores.silhouette = { score: 5, severity: 'none', note: 'Đọc rõ ở 1x' };
  session.scores.anatomy = { score: 1, severity: 'critical', note: 'Gãy vai ở frame 2' };
  session.regionNotes.push({
    id: 'rn1',
    slot: 'candidate',
    frameIndex: 1,
    x: 10,
    y: 12,
    width: 1,
    height: 1,
    severity: 'critical',
    note: 'Điểm gãy pixel cluster',
  });
  session.decision = 'neither';
  session.summaryNote = 'Cần chỉnh lại anatomy vai trước khi duyệt.';
  session.baselineRef = createAssetReferenceSnapshot({
    slot: 'baseline',
    name: 'hero_v1',
    fileName: 'hero_v1.png',
    sourceSha256: 'aaaa1111',
    width: 24,
    height: 24,
    sourceWidth: 24,
    sourceHeight: 24,
    frames: [
      { index: 0, width: 24, height: 24, rgba: new Uint32Array(24 * 24), durationMs: 90 },
    ],
    loop: true,
    direction: 'forward',
    timingSource: 'single-frame',
    tags: [],
    warnings: [],
  });

  const summary = summarizeReviewScores(
    DEFAULT_WORKBENCH_RUBRIC.families.character,
    session.scores,
    session.regionNotes,
  );
  assert.equal(summary.hasCriticalDefect, true);
  assert.equal(summary.minScore, 1);
  assert.deepEqual(summary.criticalCriteriaIds, ['anatomy']);
  assert.equal('average' in summary, false);
  assert.equal('pass' in summary, false);

  const json = serializeReviewJson(session);
  const reloaded = parseReviewJson(json);
  assert.equal(reloaded.decision, 'neither');
  assert.equal(reloaded.baselineRef?.sourceSha256, 'aaaa1111');
  assert.equal(reloaded.regionNotes.length, 1);

  assert.throws(() => parseReviewJson('{not valid'), /Review JSON không hợp lệ/);
  assert.throws(() => parseReviewJson('{"kind":"wrong"}'), /không đúng định dạng/);

  const md = renderReviewMarkdown(reloaded, DEFAULT_WORKBENCH_RUBRIC);
  assert.match(md, /Neither/);
  assert.match(md, /aaaa1111/);
  assert.match(md, /Critical Defects:\*\* YES/);
  assert.match(md, /không dùng điểm trung bình/);
  assert.doesNotMatch(md, /Artistic PASS/);
});

test('ArtReview acceptance upgrades: integer Focus/Fit zoom, Engine timing/states schemas, and Critical rationale', () => {
  assert.equal(computeIntegerFitZoom(16, 16, 480, 320), 16);
  assert.equal(computeIntegerFitZoom(24, 24, 480, 320), 12);
  assert.equal(computeIntegerFitZoom(64, 64, 480, 320), 4);
  assert.equal(computeIntegerFitZoom(320, 208, 480, 320), 1);

  // Engine E5.4 W2 Walk schema (pivot array, loop: "repeat", rect, phase)
  const w2Meta = parseAnimationMetadata(
    JSON.stringify({
      version: 1,
      kind: 'lumasprite-animation-timing',
      pivot: [30, 59],
      loop: 'repeat',
      frames: [
        { phase: 'contact', durationMs: 120, rect: { x: 0, y: 0, w: 64, h: 64 } },
        { phase: 'down', durationMs: 115, rect: { x: 64, y: 0, w: 64, h: 64 } },
      ],
    }),
    128,
    64,
  );
  assert.deepEqual(w2Meta.pivot, { x: 30, y: 59 });
  assert.equal(w2Meta.loop, true);
  assert.equal(w2Meta.timingSource, 'metadata');
  assert.deepEqual(
    w2Meta.frames.map(f => f.durationMs),
    [120, 115],
  );
  assert.deepEqual(
    w2Meta.frames.map(f => f.label),
    ['contact', 'down'],
  );

  // Engine E6.4 VFX schema (loop: "once")
  const vfxMeta = parseAnimationMetadata(
    JSON.stringify({
      version: 1,
      kind: 'lumasprite-vfx-timing',
      pivot: [24, 30],
      loop: 'once',
      frames: [
        { phase: 'anticipation', durationMs: 115, rect: { x: 0, y: 0, w: 48, h: 48 } },
        { phase: 'peak', durationMs: 105, rect: { x: 48, y: 0, w: 48, h: 48 } },
      ],
    }),
    96,
    48,
  );
  assert.equal(vfxMeta.loop, false);
  assert.equal(vfxMeta.timingSource, 'metadata');

  // Engine E6.4 UI states.json schema
  const uiStates = parseAnimationMetadata(
    JSON.stringify({
      version: 1,
      pivot: [8, 15],
      states: [
        { id: 'normal', rect: { x: 0, y: 0, w: 16, h: 16 } },
        { id: 'active', rect: { x: 16, y: 0, w: 16, h: 16 } },
      ],
    }),
    32,
    16,
  );
  assert.equal(uiStates.timingSource, 'state-sheet');
  assert.equal(uiStates.loop, false);
  assert.deepEqual(
    uiStates.frames.map(f => f.label),
    ['normal', 'active'],
  );

  // Critical selection rationale roundtrip & Markdown warning
  const session = createEmptyReviewSession('character', DEFAULT_WORKBENCH_RUBRIC);
  session.scores.anatomy = { score: 2, severity: 'critical', note: 'Vai bị lệch' };
  session.decision = 'candidate';
  session.criticalOverrideRationale = 'Giữ B để đối chiếu silhouette, sẽ sửa vai ở vòng sau.';
  const reparsed = parseReviewJson(serializeReviewJson(session));
  assert.equal(reparsed.criticalOverrideRationale, session.criticalOverrideRationale);
  const md = renderReviewMarkdown(reparsed, DEFAULT_WORKBENCH_RUBRIC);
  assert.match(md, /KHÔNG tự đánh dấu Artistic PASS/);
  assert.match(md, /Critical Selection Rationale:\*\* Giữ B để đối chiếu silhouette/);
});
