import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleMotionPlayback as sample } from '../src/studio/quality/playback.ts';
const frames = [100, 137, 80].map(durationMs => ({ durationMs }));

test('Playback: unequal durations, exact boundaries and late callbacks sample actual elapsed time', () => {
  assert.deepEqual(sample(frames, 0, true), { index: 0, done: false, delayMs: 100 });
  assert.deepEqual(sample(frames, 100, true), { index: 1, done: false, delayMs: 137 });
  assert.deepEqual(sample(frames, 236.5, true), { index: 1, done: false, delayMs: .5 });
  assert.deepEqual(sample(frames, 250, true), { index: 2, done: false, delayMs: 67 });
  assert.deepEqual(sample(frames, 317 * 1000 + 250, true), { index: 2, done: false, delayMs: 67 });
});
test('Playback: selected start frame wraps across the whole loop and one-shot holds its last frame', () => {
  assert.deepEqual(sample(frames, 137, true, 1), { index: 2, done: false, delayMs: 80 });
  assert.deepEqual(sample(frames, 217, true, 1), { index: 0, done: false, delayMs: 100 });
  assert.deepEqual(sample(frames, 216, false, 1), { index: 2, done: false, delayMs: 1 });
  assert.deepEqual(sample(frames, 217, false, 1), { index: 2, done: true, delayMs: 0 });
  assert.deepEqual(sample([{ durationMs: 100 }], 300, false), { index: 0, done: true, delayMs: 0 });
  assert.deepEqual(sample(Array.from({ length: 1198 }, () => ({ durationMs: 5 })), 6000, true), { index: 2, done: false, delayMs: 5 });
});
test('Playback: malformed timing cannot schedule an infinite/negative timer', () => {
  for (const time of [-1, NaN, Infinity]) assert.throws(() => sample(frames, time, true));
  for (const durationMs of [0, -1, NaN, Infinity, 60001]) assert.throws(() => sample([{ durationMs }], 0, true));
  assert.throws(() => sample([], 0, true)); assert.throws(() => sample(frames, 0, true, 3));
});
