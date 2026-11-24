// Child process intentionally retains Node's default unhandled-rejection policy.
import assert from 'node:assert/strict';
import { GenerationBatchManager, type BatchRecord } from '../../src/node/studio/generation-batches.ts';
import { StudioError } from '../../src/node/studio/store.ts';
import type { PixelStore } from '../../src/node/studio/pixel-store.ts';
import type { Proposals } from '../../src/node/studio/proposals.ts';
import type { AiManager } from '../../src/node/studio/ai.ts';

const reason = process.argv[2] ?? 'revision';
let reject!: (reason: unknown) => void, captures = 0;
const held = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
const preview = { proposalId: 'retry-preview', variants: [], selectedVariantId: 'retry-variant' };
const variants = { records: new Map(), capture: async () => { captures++; return captures === 1 ? await held : preview; },
  releaseProposal: () => {} } as unknown as Proposals;
const store = { load: () => ({ revision: 1 }) } as unknown as PixelStore;
const ai = { candidate: () => ({}) } as unknown as AiManager;
const manager = new GenerationBatchManager(store, variants, ai, () => {});
manager.batches.set('batch', { id: 'batch', projectId: 'project', revision: 1, status: 'ready',
  snapshot: {}, candidates: [{ id: 'candidate', status: 'ready', jobId: 'job' }] } as BatchRecord);
const first = manager.previewCandidate('project', 'batch', 'candidate', 1);
const concurrent = manager.previewCandidate('project', 'batch', 'candidate', 1);
const received = Promise.allSettled([first, concurrent]);
reject(new StudioError(reason, reason === 'worker' ? 422 : 409));
for (const result of await received) {
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.reason.message, reason);
}
assert.equal(captures, 1, 'deduplicated callers receive the same failed capture');
// A detached rejecting .finally promise terminates the child on this turn.
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal((await manager.previewCandidate('project', 'batch', 'candidate', 1)).proposalId, preview.proposalId);
assert.equal(captures, 2, 'failure clears deduplication so retry can rebuild');
await new Promise<void>(resolve => setImmediate(resolve));
console.log(JSON.stringify({ survived: true, captures, reason }));
