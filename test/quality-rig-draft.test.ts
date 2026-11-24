import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFixture } from './quality-motion-fixture.ts';
import { validateRigDraft, validateRigDraftMap } from '../src/studio/quality/rig-draft.ts';
import { validateStudioExtension } from '../src/studio/art-direction.ts';

function fixture() { const f = motionFixture(); return { version: 1, id: 'draft', name: 'Nháp kiếm sĩ', origin: { assetId: 'original', frameId: 'source' }, ...f, resources: { sources: [], masks: [] }, movementMaskResourceId: null, frozenFrames: [{ frameId: 'rest', sourceFrameId: 'source-frame' }] }; }
test('Rig draft: normalizes independent editable data without granting approval; stale source identity remains for explicit refresh', () => {
  const d = fixture(), out = validateRigDraft(d); assert.deepEqual(out, d); out.rig.joints[0].rest.x++;
  assert.notEqual(out.rig.joints[0].rest.x, d.rig.joints[0].rest.x);
  const stored = validateStudioExtension({ version: 2, quality: { version: 1, approvals: {} }, rigDrafts: { draft: d } });
  assert.deepEqual(stored.quality!.approvals, {}); assert.equal(stored.rigDrafts!.draft.rig.source.projectId, 'project');
  assert.throws(() => validateStudioExtension({ version: 1, rigDrafts: { draft: d } }), /phiên bản/);
  assert.throws(() => validateRigDraft({ ...d, approvedAt: 1 }), /thuộc tính/);
});
test('Rig draft: validates referenced RGBA/mask kinds, canvas, duplicate mappings and frozen frame IDs', () => {
  const d: any = fixture(); d.movementMaskResourceId = 'mask';
  assert.throws(() => validateRigDraft(d), /mask/);
  const mask = { version: 1 as const, kind: 'mask' as const, w: 16, h: 16 };
  assert.equal(validateRigDraft(d, { mask }).movementMaskResourceId, 'mask');
  assert.throws(() => validateRigDraft(d, { mask: { ...mask, w: 18 } }), /mask/);
  d.resources.sources = [{ id: 'source', resourceId: 'mask' }]; assert.throws(() => validateRigDraft(d, { mask }), /đúng loại/);
  d.resources.sources = []; d.resources.masks = [{ id: 'm', resourceId: 'mask' }, { id: 'm', resourceId: 'mask' }]; assert.throws(() => validateRigDraft(d, { mask }), /trùng/);
  d.resources.masks = []; d.frozenFrames.push({ ...d.frozenFrames[0] }); assert.throws(() => validateRigDraft(d, { mask }), /trùng/);
  d.frozenFrames = [{ frameId: 'missing', sourceFrameId: 'source' }]; assert.throws(() => validateRigDraft(d, { mask }), /clip/);
});
test('Rig draft: rejects cycles, hostile properties, mismatched map keys and over-limit collections without mutation', () => {
  const d: any = fixture(), before = structuredClone(d);
  assert.throws(() => validateRigDraftMap({ other: d }), /ID không khớp/);
  const poison: any = { ...d }; Object.defineProperty(poison, 'recipe', { get() { throw Error('getter executed'); }, enumerable: true });
  assert.throws(() => validateRigDraft(poison), /thuộc tính/);
  assert.throws(() => validateRigDraftMap(Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['d' + i, { ...d, id: 'd' + i }]))), /tối đa/);
  d.rig.joints[1].parentId = 'wrist'; assert.throws(() => validateRigDraft(d), /chu trình/); d.rig = before.rig;
  assert.deepEqual(d, before);
});
