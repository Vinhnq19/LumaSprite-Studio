import test from 'node:test';
import assert from 'node:assert/strict';
import { RetouchEditor } from '../src/studio/quality/retouch-editor.ts';

const green = 0x70c989ff, white = 0xffffffff;
const options = () => ({ w: 4, h: 3, palette: [green, white], frameIds: ['a', 'b'], constraints: { lockedFrames: [] as string[], region: null }, sourceLockedFrames: [] as string[], movementMask: null });
function ready() { const e = new RetouchEditor(options()); e.loadFrame('a', new Uint32Array(12).fill(green)); return e; }
function draw(e: RetouchEditor, id: string, x: number, y: number, color: number | null = 1) { e.beginStroke(id); e.paint({ x, y }, { x, y }, color); return e.endStroke(); }

test('retouch editor: continuous stroke is one undo, inputs stay immutable, later loaded frames survive undo', () => {
  const e = new RetouchEditor(options()), input = new Uint32Array(12).fill(green); e.loadFrame('a', input);
  e.beginStroke('a'); e.paint({ x: 0, y: 0 }, { x: 3, y: 0 }, 1); assert.equal(e.endStroke(), true);
  assert.deepEqual([...e.getPixels('a').slice(0, 4)], Array(4).fill(white)); assert.equal(input[0], green);
  e.loadFrame('b', input); e.loadFrame('a', input); assert.equal(e.getPixels('a')[0], white);
  e.undo(); assert.deepEqual(e.getPixels('a'), input); assert.deepEqual(e.getPixels('b'), input);
  e.undo(true); assert.equal(e.getPixels('a')[3], white);
  e.beginStroke('a'); e.paint({ x: 1, y: 1 }, { x: 1, y: 1 }, null); e.cancelStroke(); assert.equal(e.getPixels('a')[5], green);
  e.undo(); assert.deepEqual(e.getPixels('a'), input); assert.deepEqual(e.patches(), []);
});

test('retouch editor: mask and inherited region intersect, locks cannot be dropped, dirty work is never silently discarded', () => {
  const mask = new Uint8Array(12); mask[5] = 1; mask[6] = 1;
  const e = new RetouchEditor({ ...options(), movementMask: mask, constraints: { region: { x: 1, y: 1, w: 2, h: 1 }, lockedFrames: [] }, sourceLockedFrames: ['b'] }); mask.fill(1);
  e.loadFrame('a', new Uint32Array(12).fill(green)); e.loadFrame('b', new Uint32Array(12).fill(green));
  assert.throws(() => e.setLocked('b', false)); assert.throws(() => e.beginStroke('b'));
  e.beginStroke('a'); e.paint({ x: 0, y: 1 }, { x: 3, y: 1 }, 1); e.endStroke();
  assert.deepEqual([...e.getPixels('a').slice(4, 8)], [green, white, white, green]);
  assert.throws(() => e.setLocked('a', true), /Lưu biến thể/);
  assert.throws(() => e.setRegion({ x: 2, y: 1, w: 1, h: 1 })); assert.equal(e.getPixels('a')[5], white);
  e.setRegion(null); assert.deepEqual(e.state.region, { x: 1, y: 1, w: 2, h: 1 });
  e.undo(); assert.equal(e.getPixels('a')[5], green);
  e.setLocked('a', true); assert.throws(() => e.beginStroke('a')); e.undo(); assert.doesNotThrow(() => e.beginStroke('a')); e.cancelStroke();
  assert.throws(() => e.setRegion({ x: 0, y: 0, w: 1, h: 1 }));
});

test('retouch editor: merge original frame edits, preserve transparent erasures, return independent row-major patches', () => {
  const e = ready(), edits = [{ x: 3, y: 2, color: 1 }];
  const b = new Uint32Array(12).fill(green); b[11] = white; e.loadFrame('b', b, edits); edits[0].x = 0;
  draw(e, 'b', 1, 0, null); draw(e, 'b', 0, 0, 1);
  const patches = e.patches(); assert.deepEqual(patches, [{ frameId: 'b', pixelEdits: [{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: null }, { x: 3, y: 2, color: 1 }] }]);
  patches[0].pixelEdits[0].x = 2; assert.equal(e.patches()[0].pixelEdits[0].x, 0);
  e.undo(); e.undo(); assert.deepEqual(e.patches(), []);
  assert.equal(draw(e, 'a', 1, 1, 0), false);
});

test('retouch editor: validates inputs and bounded payloads without truncation', () => {
  assert.throws(() => new RetouchEditor({ ...options(), w: 4097 }));
  assert.throws(() => new RetouchEditor({ ...options(), frameIds: ['__proto__'] }));
  assert.throws(() => new RetouchEditor({ ...options(), palette: [0x70c98980] }));
  const e = ready(); assert.throws(() => e.loadFrame('b', new Uint32Array(11))); assert.throws(() => e.loadFrame('x', new Uint32Array(12)));
  e.beginStroke('a'); assert.throws(() => e.paint({ x: 0, y: 0 }, { x: 0, y: 0 }, 2)); assert.throws(() => e.paint({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 65)); e.cancelStroke();
  const many = new RetouchEditor({ ...options(), frameIds: Array.from({ length: 9 }, (_, i) => 'f' + i) });
  for (let i = 0; i < 8; i++) { many.loadFrame('f' + i, new Uint32Array(12)); draw(many, 'f' + i, 0, 0); }
  many.loadFrame('f8', new Uint32Array(12)); assert.throws(() => draw(many, 'f8', 0, 0), /8/); assert.equal(many.patches().length, 8); assert.equal(many.getPixels('f8')[0], 0);
  const large = new RetouchEditor({ ...options(), w: 128, h: 128 }); large.loadFrame('a', new Uint32Array(128 * 128));
  large.beginStroke('a'); large.paint({ x: 32, y: 32 }, { x: 96, y: 96 }, 1, 64); assert.throws(() => large.endStroke(), /8192/); assert.deepEqual(large.patches(), []); assert.ok(large.getPixels('a').every(p => p === 0));
});
