import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  newDocument,
  newAsset,
  newLayer,
  celFor,
  composite,
  validateDocument,
  type PixelDocument,
} from '../src/studio/pixel/model.ts';
import { PixelHistory, snapshot } from '../src/studio/pixel/history.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import {
  isValidCharacterId,
  validateCharacterId,
  validateCharacterProfile,
  validateCharacterMap,
  cloneCharacterProfile,
  cloneCharacterMap,
  checkCharacterReadiness,
  MAX_CHARACTER_PROFILES,
  MAX_CHARACTER_PARTS,
  MAX_CHARACTER_LANDMARKS,
  MAX_CHARACTER_LINKS,
  MAX_CHARACTER_ACTIONS,
  type CharacterProfile,
} from '../src/studio/characters.ts';
import {
  ensureCharacterExtension,
  createCharacterProfile,
  approveCharacterProfile,
  recaptureCharacterProfile,
  renameCharacterProfile,
  removeCharacterProfile,
  addCharacterPart,
  updateCharacterPart,
  removeCharacterPart,
  addCharacterLandmark,
  updateCharacterLandmark,
  removeCharacterLandmark,
  addCharacterLink,
  removeCharacterLink,
  addCharacterAction,
  updateCharacterAction,
  removeCharacterAction,
} from '../src/studio/character-commands.ts';
import { Session } from '../studio/pixel/session.ts';

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'pxl-char-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

function createTestDoc(): { doc: PixelDocument; assetId: string; frameId: string } {
  const doc = newDocument('Dự án nhân vật', 16, 16);
  const asset = doc.assets[0];
  const frameId = asset.frames[0].id;

  // Add some distinct pixel data to layer 0
  const cel0 = celFor(asset, asset.layers[0].id, frameId, true)!;
  cel0.data![0] = 0xff0000ff; // Red
  cel0.data![1] = 0x00ff00ff; // Green

  // Add a second layer with opacity
  const layer1 = newLayer('Layer Overlay');
  layer1.opacity = 200;
  asset.layers.push(layer1);
  const cel1 = celFor(asset, layer1.id, frameId, true)!;
  cel1.data![1] = 0x0000ffff; // Blue blending over Green
  cel1.data![2] = 0xffffffff; // White

  return { doc, assetId: asset.id, frameId };
}

test('Characters schema: strict safe IDs, fields, versions, limits, and unknown key rejection', () => {
  assert.equal(isValidCharacterId('hero_1'), true);
  assert.equal(isValidCharacterId('hero-warrior-01'), true);
  assert.equal(isValidCharacterId('a'.repeat(80)), true);
  assert.equal(isValidCharacterId('a'.repeat(81)), false);
  assert.equal(isValidCharacterId('hero 1'), false);
  assert.equal(isValidCharacterId('hero@1'), false);
  assert.equal(isValidCharacterId('__proto__'), false);
  assert.equal(isValidCharacterId('constructor'), false);

  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);

  const profile = createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });

  assert.equal(profile.id, 'hero');
  assert.equal(profile.name, 'Chiến binh');
  assert.equal(profile.approved, false);
  assert.equal(profile.source.assetId, assetId);
  assert.equal(profile.source.frameId, frameId);
  assert.equal(profile.source.w, 16);
  assert.equal(profile.source.h, 16);
  assert.deepEqual(profile.source.pivot, { x: 8, y: 16 });

  // Unknown fields rejected
  const invalid = structuredClone(profile) as any;
  invalid.unknownField = 'bad';
  assert.throws(() => validateCharacterProfile(invalid, 'hero', doc));

  // Version !== 1 rejected
  const badVersion = structuredClone(profile) as any;
  badVersion.version = 2;
  assert.throws(() => validateCharacterProfile(badVersion, 'hero', doc));

  // Blank name rejected
  const badName = structuredClone(profile) as any;
  badName.name = '   ';
  assert.throws(() => validateCharacterProfile(badName, 'hero', doc));

  // ID mismatch rejected
  assert.throws(() => validateCharacterProfile(profile, 'other_id', doc));

  // Map limits: max 128
  const maxMap: Record<string, CharacterProfile> = {};
  for (let i = 0; i < MAX_CHARACTER_PROFILES; i++) {
    const p = structuredClone(profile);
    p.id = `hero_${i}`;
    maxMap[p.id] = p;
  }
  validateCharacterMap(maxMap);

  const overflowMap = { ...maxMap };
  const extra = structuredClone(profile);
  extra.id = 'hero_overflow';
  overflowMap.hero_overflow = extra;
  assert.throws(() => validateCharacterMap(overflowMap));
});

test('Characters commands: multilayer visible composite, source unchanged, unapproved default', () => {
  const { doc, assetId, frameId } = createTestDoc();
  const asset = doc.assets[0];

  // Snapshot cel pixels before create
  const cel0DataBefore = new Uint32Array(celFor(asset, asset.layers[0].id, frameId)!.data!);
  const cel1DataBefore = new Uint32Array(celFor(asset, asset.layers[1].id, frameId)!.data!);

  const expectedComp = composite(asset, frameId).data;

  ensureCharacterExtension(doc);
  const profile = createCharacterProfile(doc, {
    id: 'hero',
    name: 'Hiệp sĩ',
    assetId,
    frameId,
    pivot: { x: 4.5, y: 12.5 },
  });

  assert.equal(profile.approved, false);
  assert.deepEqual(profile.source.pivot, { x: 4.5, y: 12.5 });

  // Dedicated RGBA resource created with matching composite data
  const res = doc.studio!.resources![profile.source.rgbaResourceId];
  assert.ok(res);
  assert.equal(res.kind, 'rgba');
  assert.equal(res.w, 16);
  assert.equal(res.h, 16);
  assert.deepEqual(res.data, expectedComp);

  // Source cel pixels must NOT be mutated or normalized
  assert.deepEqual(celFor(asset, asset.layers[0].id, frameId)!.data, cel0DataBefore);
  assert.deepEqual(celFor(asset, asset.layers[1].id, frameId)!.data, cel1DataBefore);
});

test('Character readiness helper: unapproved, missing-data, ready, and exact stale detection', () => {
  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);

  const profile = createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });

  const sourceRes = doc.studio!.resources![profile.source.rgbaResourceId];
  const liveComp = composite(doc.assets[0], frameId).data;

  // 1. Initial state is unapproved
  let ready = checkCharacterReadiness({
    profile,
    sourceResourceData: sourceRes.data,
    currentComposite: liveComp,
  });
  assert.equal(ready.status, 'unapproved');

  // 2. Approve character
  approveCharacterProfile(doc, 'hero');
  assert.equal(profile.approved, true);

  const approvedRes = doc.studio!.resources![profile.source.rgbaResourceId];
  const freshComp = composite(doc.assets[0], frameId).data;

  // 3. Exact match -> ready
  ready = checkCharacterReadiness({
    profile,
    sourceResourceData: approvedRes.data,
    currentComposite: freshComp,
    currentWidth: 16,
    currentHeight: 16,
    currentPalette: profile.source.palette,
    currentPivot: profile.source.pivot,
  });
  assert.equal(ready.status, 'ready');

  // 4. Missing resource data -> missing-data
  ready = checkCharacterReadiness({
    profile,
    sourceResourceData: null,
    currentComposite: freshComp,
  });
  assert.equal(ready.status, 'missing-data');

  // 5. Stale: pixel changes
  const modifiedComp = new Uint32Array(freshComp);
  modifiedComp[5] = 0x12345678;
  ready = checkCharacterReadiness({
    profile,
    sourceResourceData: approvedRes.data,
    currentComposite: modifiedComp,
  });
  assert.equal(ready.status, 'stale');
  assert.equal(ready.differences?.pixelsChanged, true);

  // 6. Stale: palette changes
  const modifiedPalette = [...profile.source.palette, 0x11223344];
  ready = checkCharacterReadiness({
    profile,
    sourceResourceData: approvedRes.data,
    currentComposite: freshComp,
    currentPalette: modifiedPalette,
  });
  assert.equal(ready.status, 'stale');
  assert.equal(ready.differences?.paletteChanged, true);

  // 7. Stale: pivot changes
  ready = checkCharacterReadiness({
    profile,
    sourceResourceData: approvedRes.data,
    currentComposite: freshComp,
    currentPivot: { x: 9, y: 9 },
  });
  assert.equal(ready.status, 'stale');
  assert.equal(ready.differences?.pivotChanged, true);

  // 8. Stale: dimensions changed
  ready = checkCharacterReadiness({
    profile,
    sourceResourceData: approvedRes.data,
    currentComposite: freshComp,
    currentWidth: 32,
    currentHeight: 32,
  });
  assert.equal(ready.status, 'stale');
  assert.equal(ready.differences?.dimensionsChanged, true);
});

test('Parts, landmarks, links, and actions: creation, validation, cascades, and removal', () => {
  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);

  const profile = createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });

  // 1. Part mask validation: rejects empty selection, non-binary, wrong dimensions
  const emptyMask = new Uint32Array(16 * 16);
  assert.throws(() => addCharacterPart(doc, 'hero', 'head', { name: 'Đầu', selection: emptyMask }));

  const wrongSizeMask = new Uint32Array(8 * 8);
  wrongSizeMask[0] = 1;
  assert.throws(() => addCharacterPart(doc, 'hero', 'head', { name: 'Đầu', selection: wrongSizeMask }));

  const nonBinaryMask = new Uint32Array(16 * 16);
  nonBinaryMask[0] = 2;
  assert.throws(() => addCharacterPart(doc, 'hero', 'head', { name: 'Đầu', selection: nonBinaryMask }));

  // Valid part creation
  const validMask = new Uint32Array(16 * 16);
  validMask[0] = 1;
  validMask[1] = 1;
  const part = addCharacterPart(doc, 'hero', 'head', { name: 'Đầu', selection: validMask });
  assert.equal(part.name, 'Đầu');
  assert.ok(doc.studio!.resources![part.maskResourceId]);

  // 2. Landmarks: bounds checking and optional partId
  assert.throws(() => addCharacterLandmark(doc, 'hero', 'pt1', { name: 'Mũi', x: 16, y: 5 })); // x >= w
  assert.throws(() => addCharacterLandmark(doc, 'hero', 'pt1', { name: 'Mũi', x: 5, y: -1 })); // y < 0
  assert.throws(() => addCharacterLandmark(doc, 'hero', 'pt1', { name: 'Mũi', x: 5, y: 5, partId: 'missing' }));

  const lmHead = addCharacterLandmark(doc, 'hero', 'head_pt', { name: 'Đỉnh đầu', x: 2, y: 2, partId: 'head' });
  const lmNeck = addCharacterLandmark(doc, 'hero', 'neck_pt', { name: 'Cổ', x: 2, y: 5 });
  assert.equal(lmHead.partId, 'head');
  assert.equal(lmNeck.partId, undefined);

  // 3. Links: distinct landmarks, no duplicate undirected pairs
  assert.throws(() => addCharacterLink(doc, 'hero', 'head_pt', 'head_pt')); // self-link
  assert.throws(() => addCharacterLink(doc, 'hero', 'head_pt', 'nonexistent'));

  const link = addCharacterLink(doc, 'hero', 'head_pt', 'neck_pt');
  assert.deepEqual(link, { from: 'head_pt', to: 'neck_pt' });

  // Duplicate undirected link rejected
  assert.throws(() => addCharacterLink(doc, 'hero', 'head_pt', 'neck_pt'));
  assert.throws(() => addCharacterLink(doc, 'hero', 'neck_pt', 'head_pt'));

  // 4. Actions: template check
  assert.throws(() =>
    addCharacterAction(doc, 'hero', 'act1', { name: 'Đi', template: 'flying' as any })
  );
  const act = addCharacterAction(doc, 'hero', 'idle_act', { name: 'Nghỉ', template: 'idle' });
  assert.equal(act.name, 'Nghỉ');
  assert.equal(act.template, 'idle');

  // 5. Cascade: removing part clears landmark partId in the same operation
  removeCharacterPart(doc, 'hero', 'head');
  assert.equal(profile.parts.head, undefined);
  assert.equal(profile.landmarks.head_pt.partId, undefined); // Cleared in the same op
  assert.equal(profile.landmarks.head_pt.name, 'Đỉnh đầu'); // Point retained
  assert.equal(profile.links.length, 1); // Link retained

  // 6. Cascade: removing landmark removes connected links
  removeCharacterLandmark(doc, 'hero', 'head_pt');
  assert.equal(profile.landmarks.head_pt, undefined);
  assert.equal(profile.links.length, 0); // Connected link removed
});

test('Resource pruning and shared resource preservation', () => {
  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);

  const profile = createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });

  const firstRgbaId = profile.source.rgbaResourceId;
  assert.ok(doc.studio!.resources![firstRgbaId]);

  // Recapturing profile allocates new resource and prunes old dedicated resource
  recaptureCharacterProfile(doc, 'hero');
  const secondRgbaId = profile.source.rgbaResourceId;
  assert.notEqual(firstRgbaId, secondRgbaId);
  assert.ok(doc.studio!.resources![secondRgbaId]);
  assert.equal(doc.studio!.resources![firstRgbaId], undefined); // Pruned

  // Adding part
  const mask = new Uint32Array(16 * 16);
  mask[0] = 1;
  const part = addCharacterPart(doc, 'hero', 'torso', { name: 'Thân', selection: mask });
  const firstMaskId = part.maskResourceId;
  assert.ok(doc.studio!.resources![firstMaskId]);

  // Updating part mask prunes old dedicated mask resource
  const updatedMask = new Uint32Array(16 * 16);
  updatedMask[1] = 1;
  updateCharacterPart(doc, 'hero', 'torso', { selection: updatedMask });
  const secondMaskId = part.maskResourceId;
  assert.notEqual(firstMaskId, secondMaskId);
  assert.ok(doc.studio!.resources![secondMaskId]);
  assert.equal(doc.studio!.resources![firstMaskId], undefined); // Pruned

  // Shared resource preservation: add a shared custom mask manually
  doc.studio!.resources!.shared_armor_mask = {
    version: 1,
    kind: 'mask',
    w: 16,
    h: 16,
    data: new Uint32Array(16 * 16).fill(1),
  };

  // Profile 2 references the same shared resource
  profile.parts.torso.maskResourceId = 'shared_armor_mask';
  validateDocument(doc);

  // Removing part or profile must NOT delete shared_armor_mask
  removeCharacterPart(doc, 'hero', 'torso');
  assert.ok(doc.studio!.resources!.shared_armor_mask);

  removeCharacterProfile(doc, 'hero');
  assert.equal(doc.studio!.characters!.hero, undefined);
  assert.equal(doc.studio!.resources![secondRgbaId], undefined); // Dedicated pruned
  assert.ok(doc.studio!.resources!.shared_armor_mask); // Shared preserved
});

test('PixelHistory: undo and redo with character profiles and markers', () => {
  const { doc, assetId, frameId } = createTestDoc();
  const history = new PixelHistory();

  // Outside first undo snapshot: ensure extension empty markers
  ensureCharacterExtension(doc);

  // Commit initial state
  const beforeCreate = snapshot(doc);
  createCharacterProfile(doc, {
    id: 'hero',
    name: 'Dũng sĩ',
    assetId,
    frameId,
  });
  history.commit(beforeCreate, doc, 'Tạo nhân vật');
  assert.ok(doc.studio?.characters?.hero);

  // Add part with history
  const beforePart = snapshot(doc);
  const mask = new Uint32Array(16 * 16);
  mask[0] = 1;
  addCharacterPart(doc, 'hero', 'shield', { name: 'Khiên', selection: mask });
  history.commit(beforePart, doc, 'Thêm khiên');
  assert.ok(doc.studio?.characters?.hero.parts.shield);

  // Undo part addition
  history.undo(doc);
  assert.equal(doc.studio?.characters?.hero.parts.shield, undefined);

  // Redo part addition
  history.undo(doc, true);
  assert.ok(doc.studio?.characters?.hero.parts.shield);

  // Undo all the way back to before character creation
  history.undo(doc);
  history.undo(doc);
  assert.equal(doc.studio?.characters?.hero, undefined);
  // Empty studio/characters marker remains
  assert.ok(doc.studio?.characters);
});

test('Transitive dependency validation: source deletion or resize rejected with rollback', () => {
  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);

  createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });
  validateDocument(doc);

  // 1. Deleting source asset causes validation error and rollback
  const beforeDeleteAsset = snapshot(doc);
  assert.throws(() => {
    try {
      doc.assets = [];
      validateDocument(doc);
    } catch (e) {
      Object.assign(doc, beforeDeleteAsset);
      throw e;
    }
  });
  assert.equal(doc.assets.length, 1);
  assert.ok(doc.studio!.characters!.hero);

  // 2. Deleting source frame causes validation error and rollback
  const beforeDeleteFrame = snapshot(doc);
  assert.throws(() => {
    try {
      doc.assets[0].frames = [];
      validateDocument(doc);
    } catch (e) {
      Object.assign(doc, beforeDeleteFrame);
      throw e;
    }
  });
  assert.equal(doc.assets[0].frames.length, 1);

  // 3. Resizing source asset causes validation error and rollback
  const beforeResize = snapshot(doc);
  assert.throws(() => {
    try {
      doc.assets[0].w = 32;
      doc.assets[0].h = 32;
      validateDocument(doc);
    } catch (e) {
      Object.assign(doc, beforeResize);
      throw e;
    }
  });
  assert.equal(doc.assets[0].w, 16);
});

test('PixelStore: characters drop guard, explicit {} empty map, and restore bypass', () => {
  const store = new PixelStore(temporary());
  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);

  createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });

  const created = store.create('Dự án nhân vật', 16, 16, 0, doc);
  const loaded = store.load(created.id, true);
  assert.ok(loaded.studio?.characters?.hero);

  // 1. Dropping characters field is rejected
  const droppedField = structuredClone(loaded);
  delete (droppedField.studio as any).characters;
  assert.throws(() => store.save(loaded.id, loaded.revision, droppedField), /Không được xóa trường nhân vật/);

  // 2. Explicit {} empty map is allowed
  const clearedMap = structuredClone(loaded);
  clearedMap.studio!.characters = {};
  const savedCleared = store.save(loaded.id, loaded.revision, clearedMap);
  assert.deepEqual(savedCleared.studio?.characters, {});

  // 3. Restore older snapshot bypasses the drop guard
  const hist = store.history(loaded.id);
  assert.ok(hist.length > 0);
  const restored = store.restore(loaded.id, savedCleared.revision, hist[0].id);
  assert.ok(restored.studio?.characters?.hero);
});

test('Session.copy: doc+version guard against intervening edit race', async () => {
  const session = new Session();
  const { doc, assetId, frameId } = createTestDoc();
  ensureCharacterExtension(doc);
  createCharacterProfile(doc, {
    id: 'hero',
    name: 'Chiến binh',
    assetId,
    frameId,
  });

  session.doc = doc;
  session.dirty = true;
  session.version = 1;

  // Mock global api
  const originalFetch = globalThis.fetch;
  let copyCallCount = 0;
  let resolveCopy: (value: any) => void;
  const copyPromise = new Promise(resolve => {
    resolveCopy = resolve;
  });

  (globalThis as any).fetch = async (url: string, init: any) => {
    if (url.includes('projects') && init?.method === 'POST') {
      copyCallCount++;
      return {
        ok: true,
        status: 200,
        text: async () => {
          await copyPromise;
          return JSON.stringify({ id: 'copy-123' });
        },
      };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  try {
    // Case 1: Intervening edit during copy()
    const copyTask = session.copy();

    // User makes a stroke while copy is awaiting
    session.version = 2; // Incremented by an edit
    session.dirty = true;

    // Finish server response
    resolveCopy!({ id: 'copy-123' });
    const copiedId = await copyTask;
    assert.equal(copiedId, 'copy-123');

    // Because version changed during copy, dirty must NOT be cleared!
    assert.equal(session.dirty, true);

    // Case 2: Unchanged copy() clears dirty
    let resolveCopy2: (value: any) => void;
    const copyPromise2 = new Promise(resolve => {
      resolveCopy2 = resolve;
    });

    (globalThis as any).fetch = async (url: string, init: any) => {
      if (url.includes('projects') && init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          text: async () => {
            await copyPromise2;
            return JSON.stringify({ id: 'copy-456' });
          },
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const copyTask2 = session.copy();
    // No edits occur
    resolveCopy2!({ id: 'copy-456' });
    const copiedId2 = await copyTask2;
    assert.equal(copiedId2, 'copy-456');

    // Since doc and version were unchanged, dirty is cleared
    assert.equal(session.dirty, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
