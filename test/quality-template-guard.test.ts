import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTemplateCandidate } from '../src/node/studio/quality-template-guard.ts';
import type { AssetRecipe, RecipePaintOp } from '../src/studio/quality/recipe.ts';

test('A scoped template protects other layers even inside the selected rectangle', () => {
  const rectangle = (x: number, color: number): RecipePaintOp => ({ kind: 'rect', x, y: 1, w: 1, h: 1, color });
  const base: AssetRecipe = {
    version: 1, name: 'Template', canvas: { w: 4, h: 4 }, pivot: { x: 2, y: 4 }, palette: [0x51596eff, 0x70c989ff],
    materials: [], frames: [{ id: 'still', durationMs: 100, poses: [] }], loop: false,
    parts: ['body', 'shield'].map((id, i) => ({
      id, name: id, parentId: null, pivot: { x: 0, y: 0 }, origin: 'authored', materialIds: [], paint: [rectangle(i + 1, i)],
    })),
  };
  const resources = { sources: [], masks: [] }, scope = { partIds: ['shield'], region: { x: 1, y: 1, w: 2, h: 1 } };
  const changed = structuredClone(base); changed.parts[1].paint = [rectangle(2, 0)];
  assert.doesNotThrow(() => verifyTemplateCandidate(base, changed, resources, scope));
  const occluded = structuredClone(changed); occluded.parts[1].paint.push(rectangle(1, 1));
  assert.throws(() => verifyTemplateCandidate(base, occluded, resources, scope), /che hoặc đổi pixel/);
  const unselected = structuredClone(changed); unselected.parts[0].paint = [rectangle(1, 1)];
  assert.throws(() => verifyTemplateCandidate(base, unselected, resources, scope), /layer chưa được chọn/);
  const overlapping = structuredClone(base); overlapping.parts[1].paint.push(rectangle(1, 0));
  const recolored = structuredClone(overlapping); recolored.parts[1].paint[1] = rectangle(1, 1);
  assert.doesNotThrow(() => verifyTemplateCandidate(overlapping, recolored, resources, scope));
});
