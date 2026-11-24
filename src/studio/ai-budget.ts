export const DEFAULT_CANDIDATE_TIMEOUT = 300000;
export const DEFAULT_BATCH_TIMEOUT = 900000;

export function candidateTimeoutMs(configured?: number, requested?: number): number {
  let boundMin = DEFAULT_CANDIDATE_TIMEOUT;

  for (const bound of [configured, requested]) {
    if (typeof bound === 'number' && Number.isFinite(bound) && bound > 0) {
      const normalized = Math.max(1, Math.floor(bound));
      if (normalized < boundMin) {
        boundMin = normalized;
      }
    }
  }

  return boundMin;
}

export function candidateDeadline(
  now: number,
  batchDeadline: number = Infinity,
  configured?: number,
  requested?: number,
): number {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('now must be a finite number');
  }

  if (
    typeof batchDeadline !== 'number' ||
    Number.isNaN(batchDeadline) ||
    batchDeadline === Number.NEGATIVE_INFINITY
  ) {
    throw new TypeError('batchDeadline must be a finite number or positive Infinity');
  }

  const timeout = candidateTimeoutMs(configured, requested);
  return Math.min(now + timeout, batchDeadline);
}
