// Codex independent model/persistence acceptance. No provider, UI or user project access.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { newDocument, celFor, validateDocument } from '../src/studio/pixel/model.ts';
import { approveCharacterProfile, ensureCharacterExtension, createCharacterProfile, addCharacterLandmark } from '../src/studio/character-commands.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';

const roots: string[] = [];
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'pxl-clip-independent-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
function fixture(): any {
  const d: any = newDocument('Clip có khung cố định', 18, 18), a = d.assets[0], frameId = a.frames[0].id;
  celFor(a, a.layers[0].id, frameId, true)!.data![0] = 0xff0000ff;
  ensureCharacterExtension(d);
  const p = createCharacterProfile(d, { id: 'hero', name: 'Nhân vật', assetId: a.id, frameId });
  addCharacterLandmark(d, p.id, 'hand', { name: 'Tay', x: 5, y: 6 });
  approveCharacterProfile(d, p.id);
  d.studio.resources.move = { version: 1, kind: 'mask', w: 18, h: 18, data: Uint32Array.from({ length: 324 }, (_, i) => +(i < 3)) };
  d.studio.clips = { walk: { version: 1, id: 'walk', name: 'Đi tại chỗ', characterId: 'hero', template: 'walk',
    loop: true, facing: 'source', mode: 'region', movementMaskResourceId: 'move',
    slots: ['a', 'b', 'c'].map((id, i) => ({ id, duration: [80, 140, 200][i], selected: i === 1,
      frozen: i === 0, keyframe: i === 0, rgbaResourceId: p.source.rgbaResourceId, pose: { hand: { x: 5 + i, y: 6 } } })),
  } };
  return d;
}
function backup(store: PixelStore, id: string) {
  const cels: Record<string, string> = {}, resources: Record<string, string> = {}, history: any[] = [];
  for (const file of store.backupFiles(id)) {
    const resource = /^\.pxl\/resources\/([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/.exec(file.path);
    const cel = /^\.pxl\/cels\/([a-f0-9]{64})\.rgba\.z$/.exec(file.path);
    if (resource) resources[`${resource[2]}:${resource[1]}`] = file.data.toString('base64');
    if (cel) cels[cel[1]] = file.data.toString('base64');
    if (/^\.pxl\/pixel-history\/[\w-]+\.json$/.test(file.path)) history.push(JSON.parse(file.data.toString('utf8')));
  }
  return { cels, resources, history };
}

test('Clip verification: malformed slot identities, flags, poses, kinds and extension dropping cannot commit', () => {
  const store = new PixelStore(temporary()), saved: any = store.create('Clip kiểm tra', 18, 18, 0, fixture());
  const current: any = store.load(saved.id), manifest = join(store.dir(saved.id), 'pxl.project.json'), bytes = readFileSync(manifest);
  const changes = [
    (d: any) => { delete d.studio.clips; },
    (d: any) => { d.studio.clips.walk.version = 2; },
    (d: any) => { d.studio.clips.walk.extra = true; },
    (d: any) => { d.studio.clips.walk.id = 'other'; },
    (d: any) => { d.studio.clips.walk.characterId = 'missing'; },
    (d: any) => { d.studio.clips.walk.slots = d.studio.clips.walk.slots.slice(0, 1); },
    (d: any) => { d.studio.clips.walk.slots = Array.from({ length: 25 }, (_, i) => ({ ...d.studio.clips.walk.slots[1], id: 'x' + i })); },
    (d: any) => { d.studio.clips.walk.slots[1].id = 'a'; },
    (d: any) => { d.studio.clips.walk.slots[1].duration = 0; },
    (d: any) => { d.studio.clips.walk.slots[1].selected = 'yes'; },
    (d: any) => { d.studio.clips.walk.slots[0].selected = true; },
    (d: any) => { d.studio.clips.walk.slots[1].rgbaResourceId = 'move'; },
    (d: any) => { d.studio.clips.walk.slots[1].pose.missing = { x: 1, y: 1 }; },
    (d: any) => { d.studio.clips.walk.slots[1].pose.hand.x = 18; },
    (d: any) => { d.studio.clips.walk.slots[1].pose.hand.x = Number.NaN; },
    (d: any) => { d.studio.clips.walk.slots[1].pose.hand.extra = true; },
    (d: any) => { delete d.studio.clips.walk.movementMaskResourceId; },
    (d: any) => { d.studio.clips.walk.movementMaskResourceId = d.studio.characters.hero.source.rgbaResourceId; },
    (d: any) => { delete d.studio.characters.hero.landmarks.hand; },
    (d: any) => { d.studio.characters = {}; },
    (d: any) => { d.studio.resources.move.w = 9; d.studio.resources.move.h = 36; },
    (d: any) => { d.studio.clips = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['clip' + i, { ...d.studio.clips.walk, id: 'clip' + i }])); },
  ];
  for (const change of changes) {
    const bad = structuredClone(current); change(bad);
    assert.throws(() => store.save(current.id, current.revision, bad));
    assert.deepEqual(readFileSync(manifest), bytes, 'Rejected clips may not rewrite the manifest');
  }
});

test('Clip verification: unapproved source and all-frozen/unselected drafts remain saveable without rewriting baselines', () => {
  const d = fixture(), source = d.studio.characters.hero.source.rgbaResourceId;
  d.studio.characters.hero.approved = false;
  for (const slot of d.studio.clips.walk.slots) { slot.selected = false; slot.frozen = true; }
  validateDocument(d);
  const store = new PixelStore(temporary()), saved: any = store.create(d.name, 18, 18, 0, d);
  assert.deepEqual(saved.studio.clips.walk.slots.map((s: any) => s.duration), [80, 140, 200]);
  assert.ok(saved.studio.clips.walk.slots.every((s: any) => !s.selected && s.frozen && s.rgbaResourceId === source));
  assert.equal(saved.studio.characters.hero.approved, false);
});

test('Clip verification: profile recapture retains a master still referenced by clip slots, including backup/copy/restore', () => {
  const store = new PixelStore(temporary()), saved: any = store.create('Clip vòng đời', 18, 18, 0, fixture());
  const current: any = store.load(saved.id, true), oldMaster = current.studio.characters.hero.source.rgbaResourceId;
  const oldPixels = store.resource(saved.id, oldMaster).data.slice();
  const a = current.assets[0], cel = celFor(a, a.layers[0].id, a.frames[0].id)!;
  cel.data = cel.data!.slice(); cel.data[0] = 0x00ff00ff; delete cel.blob;
  approveCharacterProfile(current, 'hero');
  assert.notEqual(current.studio.characters.hero.source.rgbaResourceId, oldMaster);
  assert.ok(current.studio.resources[oldMaster], 'Profile pruning may not erase a retained slot master');
  const changed: any = store.save(saved.id, saved.revision, current);
  assert.deepEqual(store.resource(saved.id, oldMaster).data, oldPixels);
  const copy: any = store.copy('Bản clip sao chép', changed, changed.id);
  assert.deepEqual(copy.studio.clips, changed.studio.clips);
  assert.deepEqual(store.resource(copy.id, oldMaster).data, oldPixels);
  const files = backup(store, changed.id), imported: any = store.importBackup('Nhập clip', changed, files.cels, files.history, files.resources);
  assert.deepEqual(imported.studio.clips, changed.studio.clips);
  assert.deepEqual(store.resource(imported.id, oldMaster).data, oldPixels);
  const clear = structuredClone(changed); clear.studio.clips = {};
  const removed: any = store.save(changed.id, changed.revision, clear);
  assert.deepEqual(removed.studio.clips, {});
  const point = store.history(changed.id).find(p => p.revision === changed.revision)!;
  assert.ok(point);
  const restored: any = store.restore(changed.id, removed.revision, point.id);
  assert.deepEqual(restored.studio.clips, changed.studio.clips);
  assert.deepEqual(store.resource(restored.id, oldMaster).data, oldPixels);
});

test('Clip verification: slot reorder and timing form one reversible delta without copying shared source buffers', () => {
  const d = fixture(), history = new PixelHistory(), before = snapshot(d), master = d.studio.characters.hero.source.rgbaResourceId;
  assert.equal(before.studio.resources[master].data, d.studio.resources[master].data);
  d.studio.clips.walk.slots.reverse(); d.studio.clips.walk.slots[0].duration = 201;
  assert.equal(history.commit(before, d, 'Sắp xếp clip'), true);
  assert.equal(history.undo(d), 'Sắp xếp clip');
  assert.deepEqual(d.studio.clips.walk.slots.map((s: any) => [s.id, s.duration]), [['a', 80], ['b', 140], ['c', 200]]);
  assert.equal(d.studio.resources[master].data, before.studio.resources[master].data);
  assert.equal(history.undo(d), undefined);
  assert.equal(history.undo(d, true), 'Sắp xếp clip');
  assert.deepEqual(d.studio.clips.walk.slots.map((s: any) => [s.id, s.duration]), [['c', 201], ['b', 140], ['a', 80]]);
  assert.equal(d.studio.resources[master].data, before.studio.resources[master].data);
});
