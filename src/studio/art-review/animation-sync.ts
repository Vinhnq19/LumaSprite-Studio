import { sampleMotionPlayback } from '../quality/playback.ts';
import type {
  AnimationTag,
  PlaybackDirection,
  ReviewFrame,
  SyncMode,
} from './types.ts';

export interface SampledSequenceFrame {
  sequenceIndex: number;
  frame: ReviewFrame;
  done: boolean;
  delayMs: number;
  totalMs: number;
  localTimeMs: number;
}

export interface TimingSyncAnalysis {
  timingsDiffer: boolean;
  frameCountA: number;
  frameCountB: number;
  totalMsA: number;
  totalMsB: number;
  recommendedSyncMode: SyncMode;
  explanation: string;
}

export interface SyncedPlaybackSample {
  elapsedMs: number;
  done: boolean;
  nextDelayMs: number;
  a?: SampledSequenceFrame;
  b?: SampledSequenceFrame;
  analysis: TimingSyncAnalysis;
}

export interface LoopBoundaryPair {
  lastFrame: ReviewFrame;
  firstFrame: ReviewFrame;
  hasMultipleFrames: boolean;
}

/** Expand ordered playback sequence preserving real frame durations and tag direction. */
export function expandPlaybackSequence(
  frames: readonly ReviewFrame[],
  direction: PlaybackDirection = 'forward',
  tag?: AnimationTag,
): ReviewFrame[] {
  if (!frames.length) return [];
  const from = tag ? Math.max(0, Math.min(frames.length - 1, tag.from)) : 0;
  const to = tag ? Math.max(from, Math.min(frames.length - 1, tag.to)) : frames.length - 1;
  const slice = frames.slice(from, to + 1);
  const dir = tag?.direction ?? direction;

  if (dir === 'reverse') return [...slice].reverse();
  if (dir === 'ping-pong' && slice.length > 2) {
    return [...slice, ...slice.slice(1, -1).reverse()];
  }
  return slice;
}

/** Sample one animation sequence at wall-clock elapsedMs using Studio's playback sampler. */
export function sampleSequenceAtTime(
  sequence: readonly ReviewFrame[],
  elapsedMs: number,
  loop: boolean,
): SampledSequenceFrame | undefined {
  if (!sequence.length) return undefined;
  const clampedElapsed = Math.max(0, elapsedMs);
  const durations = sequence.map(frame => ({ durationMs: frame.durationMs }));
  const totalMs = durations.reduce((acc, item) => acc + item.durationMs, 0);
  const sample = sampleMotionPlayback(durations, clampedElapsed, loop, 0);
  const localTimeMs = !loop && clampedElapsed >= totalMs ? totalMs : clampedElapsed % totalMs;
  return {
    sequenceIndex: sample.index,
    frame: sequence[sample.index],
    done: sample.done,
    delayMs: sample.delayMs,
    totalMs,
    localTimeMs,
  };
}

/** Compare A and B timelines to report whether wall-clock sync differs from frame-index sync. */
export function analyzeTimingSync(
  seqA: readonly ReviewFrame[],
  seqB: readonly ReviewFrame[],
): TimingSyncAnalysis {
  const totalMsA = seqA.reduce((sum, f) => sum + f.durationMs, 0);
  const totalMsB = seqB.reduce((sum, f) => sum + f.durationMs, 0);

  if (!seqA.length || !seqB.length) {
    return {
      timingsDiffer: false,
      frameCountA: seqA.length,
      frameCountB: seqB.length,
      totalMsA,
      totalMsB,
      recommendedSyncMode: 'time',
      explanation: 'Đang đồng bộ theo thời gian phát thực tế (ms).',
    };
  }

  const sameCount = seqA.length === seqB.length;
  const sameDurations =
    sameCount && seqA.every((frame, index) => frame.durationMs === seqB[index].durationMs);
  const timingsDiffer = !sameCount || !sameDurations;

  const explanation = timingsDiffer
    ? `Timing A (${seqA.length} frame · ${totalMsA} ms) và B (${seqB.length} frame · ${totalMsB} ms) khác nhau — đồng bộ theo thời gian phát thực (ms), không giả định frame index tương ứng.`
    : `Timing A và B khớp nhau (${seqA.length} frame · ${totalMsA} ms).`;

  return {
    timingsDiffer,
    frameCountA: seqA.length,
    frameCountB: seqB.length,
    totalMsA,
    totalMsB,
    recommendedSyncMode: 'time',
    explanation,
  };
}

/** Sample A and B together either by real playback time (ms) or manual step index. */
export function sampleSyncedPlayback(
  seqA: readonly ReviewFrame[],
  seqB: readonly ReviewFrame[],
  elapsedMs: number,
  loop: boolean,
  syncMode: SyncMode,
  manualFrameIndex = 0,
): SyncedPlaybackSample {
  const analysis = analyzeTimingSync(seqA, seqB);

  if (syncMode === 'frame') {
    const pickFrame = (seq: readonly ReviewFrame[]): SampledSequenceFrame | undefined => {
      if (!seq.length) return undefined;
      const idx = Math.max(0, Math.min(seq.length - 1, Math.trunc(manualFrameIndex)));
      const totalMs = seq.reduce((sum, f) => sum + f.durationMs, 0);
      const localTimeMs = seq.slice(0, idx).reduce((sum, f) => sum + f.durationMs, 0);
      return {
        sequenceIndex: idx,
        frame: seq[idx],
        done: !loop && idx >= seq.length - 1,
        delayMs: seq[idx].durationMs,
        totalMs,
        localTimeMs,
      };
    };
    const a = pickFrame(seqA);
    const b = pickFrame(seqB);
    return {
      elapsedMs: Math.max(0, elapsedMs),
      done: Boolean((!a || a.done) && (!b || b.done)),
      nextDelayMs: Math.min(a?.delayMs ?? 100, b?.delayMs ?? 100),
      a,
      b,
      analysis,
    };
  }

  const a = sampleSequenceAtTime(seqA, elapsedMs, loop);
  const b = sampleSequenceAtTime(seqB, elapsedMs, loop);
  const aDone = !a || a.done;
  const bDone = !b || b.done;
  const done = !loop && aDone && bDone;

  const activeDelays: number[] = [];
  if (a && !a.done && a.delayMs > 0) activeDelays.push(a.delayMs);
  if (b && !b.done && b.delayMs > 0) activeDelays.push(b.delayMs);

  return {
    elapsedMs: Math.max(0, elapsedMs),
    done,
    nextDelayMs: activeDelays.length ? Math.min(...activeDelays) : 0,
    a,
    b,
    analysis,
  };
}

/** Return the loop seam pair (last frame -> first frame) for dedicated loop-boundary inspection. */
export function getLoopBoundaryFrames(sequence: readonly ReviewFrame[]): LoopBoundaryPair | undefined {
  if (!sequence.length) return undefined;
  return {
    lastFrame: sequence[sequence.length - 1],
    firstFrame: sequence[0],
    hasMultipleFrames: sequence.length > 1,
  };
}
