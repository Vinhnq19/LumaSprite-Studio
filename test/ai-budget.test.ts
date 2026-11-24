import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CANDIDATE_TIMEOUT,
  DEFAULT_BATCH_TIMEOUT,
  candidateTimeoutMs,
  candidateDeadline,
} from '../src/studio/ai-budget.ts';

test('AI budget: exports authorized default constants', () => {
  assert.equal(DEFAULT_CANDIDATE_TIMEOUT, 300000);
  assert.equal(DEFAULT_BATCH_TIMEOUT, 900000);
});

test('AI budget: normal default timeout without bounds', () => {
  assert.equal(candidateTimeoutMs(), 300000);
  assert.equal(candidateTimeoutMs(undefined, undefined), 300000);
});

test('AI budget: lower fixture timeout preserves smaller configured or requested values', () => {
  assert.equal(candidateTimeoutMs(5000), 5000);
  assert.equal(candidateTimeoutMs(undefined, 2500), 2500);
});

test('AI budget: both bounds take the minimum of provided bounds and default', () => {
  assert.equal(candidateTimeoutMs(10000, 4000), 4000);
  assert.equal(candidateTimeoutMs(3000, 8000), 3000);
  assert.equal(candidateTimeoutMs(6000, 6000), 6000);
});

test('AI budget: upper clamp prevents values above 300000ms', () => {
  assert.equal(candidateTimeoutMs(600000), 300000);
  assert.equal(candidateTimeoutMs(undefined, 450000), 300000);
  assert.equal(candidateTimeoutMs(1000000, 500000), 300000);
});

test('AI budget: fractional values floor and enforce 1ms minimum', () => {
  assert.equal(candidateTimeoutMs(0.4), 1);
  assert.equal(candidateTimeoutMs(0.001), 1);
  assert.equal(candidateTimeoutMs(2.9), 2);
  assert.equal(candidateTimeoutMs(undefined, 0.99), 1);
  assert.equal(candidateTimeoutMs(5000.8), 5000);
});

test('AI budget: invalid bounds are ignored and valid bounds or defaults are preserved', () => {
  assert.equal(candidateTimeoutMs(-500), 300000);
  assert.equal(candidateTimeoutMs(0), 300000);
  assert.equal(candidateTimeoutMs(NaN), 300000);
  assert.equal(candidateTimeoutMs(Infinity), 300000);
  assert.equal(candidateTimeoutMs(-Infinity), 300000);
  assert.equal(candidateTimeoutMs('5000' as unknown as number), 300000);
  assert.equal(candidateTimeoutMs(null as unknown as number), 300000);

  // Mixed valid and invalid bounds
  assert.equal(candidateTimeoutMs(5000, -200), 5000);
  assert.equal(candidateTimeoutMs(NaN, 4000), 4000);
  assert.equal(candidateTimeoutMs(0, 7000), 7000);
  assert.equal(candidateTimeoutMs(Infinity, -Infinity), 300000);
});

test('AI budget: candidateDeadline calculates bounded deadline with batch deadline and remaining time', () => {
  const now = 1000;
  // Default batchDeadline is Infinity
  assert.equal(candidateDeadline(now), 301000);
  assert.equal(candidateDeadline(now, Infinity), 301000);

  // Candidate timeout is sooner than batch deadline
  assert.equal(candidateDeadline(now, 500000), 301000);

  // Batch deadline is sooner than candidate timeout
  assert.equal(candidateDeadline(now, 50000), 50000);

  // Custom configured and requested bounds applied to deadline
  assert.equal(candidateDeadline(now, 10000, 2000), 3000);
  assert.equal(candidateDeadline(now, 2500, 2000), 2500);
});

test('AI budget: expired batch deadline is not extended and returned as-is for rejection', () => {
  const now = 10000;
  // Batch deadline in the past
  assert.equal(candidateDeadline(now, 5000), 5000);
  // Batch deadline equal to now
  assert.equal(candidateDeadline(now, 10000), 10000);
});

test('AI budget: invalid now or batchDeadline throws TypeError', () => {
  assert.throws(() => candidateDeadline(NaN), TypeError);
  assert.throws(() => candidateDeadline(Infinity), TypeError);
  assert.throws(() => candidateDeadline(-Infinity), TypeError);
  assert.throws(() => candidateDeadline('1000' as unknown as number), TypeError);
  assert.throws(() => candidateDeadline(null as unknown as number), TypeError);

  assert.throws(() => candidateDeadline(1000, NaN), TypeError);
  assert.throws(() => candidateDeadline(1000, -Infinity), TypeError);
  assert.throws(() => candidateDeadline(1000, '5000' as unknown as number), TypeError);
  assert.throws(() => candidateDeadline(1000, null as unknown as number), TypeError);
});
