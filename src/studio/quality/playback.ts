/** Sample wall-clock time, so a late timer never stretches the animation cadence. */
export function sampleMotionPlayback(frames: readonly { durationMs: number }[], elapsedMs: number, loop: boolean, startIndex = 0): { index: number; done: boolean; delayMs: number } {
  if (!frames.length || frames.some(f => !Number.isFinite(f.durationMs) || f.durationMs < 1 || f.durationMs > 60000) || !Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isInteger(startIndex) || startIndex < 0 || startIndex >= frames.length) throw Error('Thời gian phát chuyển động không hợp lệ.');
  const total = frames.reduce((n, f) => n + f.durationMs, 0), offset = frames.slice(0, startIndex).reduce((n, f) => n + f.durationMs, 0);
  const time = elapsedMs + offset;
  if (!loop && time >= total) return { index: frames.length - 1, done: true, delayMs: 0 };
  const position = time % total;
  let end = 0;
  for (let index = 0; index < frames.length; index++) {
    end += frames[index].durationMs;
    if (position < end) return { index, done: false, delayMs: end - position };
  }
  throw Error('Không xác định được frame chuyển động.');
}
