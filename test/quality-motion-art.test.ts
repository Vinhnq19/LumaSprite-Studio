import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMotionArtwork } from '../src/studio/quality/motion-art.ts';
import { walkFixture } from './fixtures/quality-walk.ts';
import { createWalkPlan } from '../src/studio/quality/motion-walk.ts';
import { compileMotionRecipe } from '../src/studio/quality/motion-render.ts';
import type { RecipeResources } from '../src/studio/quality/renderer.ts';
import type { AssetRecipe } from '../src/studio/quality/recipe.ts';
import type { MotionPlan, MotionRig } from '../src/studio/quality/motion.ts';

test('1. Valid biped walk passes and preserves input (no mutation)', () => {
  const f = walkFixture();
  const beforeFixture = structuredClone(f);
  const edit = createWalkPlan(f, {
    legIds: ['a', 'b'],
    armIds: [],
    stridePx: 4,
    liftPx: 3,
    crouchPx: 2,
    armSwingDegrees: 0,
    rootMotion: false,
  });
  const compiled = compileMotionRecipe(edit.recipe, edit.rig, edit.plan);
  const resources: RecipeResources = { sources: [], masks: [] };
  const beforeCompiled = structuredClone(compiled);

  assert.doesNotThrow(() => assertMotionArtwork(compiled, resources));
  assert.deepEqual(f, beforeFixture);
  assert.deepEqual(compiled, beforeCompiled);
});

test('2. Empty leg parts fail even if compileMotionRecipe geometry passes', () => {
  const f = walkFixture();
  for (const p of f.recipe.parts) {
    if (p.id !== 'root') p.paint = [];
  }
  const edit = createWalkPlan(f, {
    legIds: ['a', 'b'],
    armIds: [],
    stridePx: 4,
    liftPx: 3,
    crouchPx: 2,
    armSwingDegrees: 0,
    rootMotion: false,
  });
  const compiled = compileMotionRecipe(edit.recipe, edit.rig, edit.plan);
  const resources: RecipeResources = { sources: [], masks: [] };

  assert.throws(
    () => assertMotionArtwork(compiled, resources),
    /Chuỗi chân 1: khớp gốc .*không có pixel RGBA/,
  );
});

test('3. Raster with correct dimensions but all transparent actual pixels fails', () => {
  const f = walkFixture();
  const hipPart = f.recipe.parts.find(p => p.id === 'hip-a')!;
  hipPart.paint = [
    {
      kind: 'raster',
      sourceId: 'src_transparent',
      sourceRect: { x: 0, y: 0, w: 2, h: 2 },
      x: 27,
      y: 34,
      maskId: null,
    },
  ];
  const resources: RecipeResources = {
    sources: [
      {
        id: 'src_transparent',
        w: 2,
        h: 2,
        pixels: new Uint32Array(4), // fully transparent (all 0)
      },
    ],
    masks: [],
  };
  const context = {
    sources: [{ id: 'src_transparent', w: 2, h: 2 }],
    masks: [],
  };
  const edit = createWalkPlan(f, {
    legIds: ['a', 'b'],
    armIds: [],
    stridePx: 4,
    liftPx: 3,
    crouchPx: 2,
    armSwingDegrees: 0,
    rootMotion: false,
  }, context);
  const compiled = compileMotionRecipe(edit.recipe, edit.rig, edit.plan, context);

  assert.throws(
    () => assertMotionArtwork(compiled, resources),
    /Chuỗi chân 1: khớp gốc .*không có pixel RGBA/,
  );
});

test('4. Proposed candidate erasing one bound limb joint fails at guard gate', () => {
  const f = walkFixture();
  const edit = createWalkPlan(f, {
    legIds: ['a', 'b'],
    armIds: [],
    stridePx: 4,
    liftPx: 3,
    crouchPx: 2,
    armSwingDegrees: 0,
    rootMotion: false,
  });
  const resources: RecipeResources = { sources: [], masks: [] };

  const candidateRecipe = structuredClone(edit.recipe);
  const knee = candidateRecipe.parts.find(p => p.id === 'knee-b')!;
  knee.paint = [];

  const compiledCandidate = compileMotionRecipe(candidateRecipe, edit.rig, edit.plan);
  assert.throws(
    () => assertMotionArtwork(compiledCandidate, resources),
    /Chuỗi chân 2: khớp giữa .*không có pixel RGBA/,
  );
});

test('5. Hidden-every-frame part or ancestor fails, but occluded far part with real pixels passes', () => {
  const resources: RecipeResources = { sources: [], masks: [] };

  // 5a. Hidden-every-frame part fails
  {
    const f = walkFixture();
    const edit = createWalkPlan(f, {
      legIds: ['a', 'b'],
      armIds: [],
      stridePx: 4,
      liftPx: 3,
      crouchPx: 2,
      armSwingDegrees: 0,
      rootMotion: false,
    });
    for (const frame of edit.recipe.frames) {
      frame.poses.push({ partId: 'ankle-a', dx: 0, dy: 0, rotation: 0,
        z: edit.recipe.parts.findIndex(p => p.id === 'ankle-a'), visible: false });
    }
    const compiled = compileMotionRecipe(edit.recipe, edit.rig, edit.plan);
    assert.throws(
      () => assertMotionArtwork(compiled, resources),
      /Chuỗi chân 1: khớp cuối .*bị ẩn/,
    );
  }

  // 5b. Hidden ancestor fails
  {
    const f = walkFixture();
    f.recipe.parts.push({ id: 'hidden-parent', name: 'Parent', parentId: null,
      pivot: { x: 32, y: 32 }, origin: 'authored', materialIds: [], paint: [] });
    f.rig.bindings.push({ partId: 'hidden-parent', jointId: 'root', socketId: null });
    for (const frame of f.plan.frames) frame.order.push('hidden-parent');
    f.recipe.parts.find(p => p.id === 'ankle-a')!.parentId = 'hidden-parent';
    const edit = createWalkPlan(f, {
      legIds: ['a', 'b'],
      armIds: [],
      stridePx: 4,
      liftPx: 3,
      crouchPx: 2,
      armSwingDegrees: 0,
      rootMotion: false,
    });
    for (const frame of edit.recipe.frames) {
      frame.poses.push({ partId: 'hidden-parent', dx: 0, dy: 0, rotation: 0,
        z: edit.recipe.parts.findIndex(p => p.id === 'hidden-parent'), visible: false });
    }
    const compiled = compileMotionRecipe(edit.recipe, edit.rig, edit.plan);
    assert.throws(
      () => assertMotionArtwork(compiled, resources),
      /Chuỗi chân 1: khớp cuối .*bị ẩn/,
    );
  }

  // 5c. Occluded far part with real pixels passes
  {
    const f = walkFixture();
    // Shield covers ankle-b in composition by placing a higher-z rect over ankle-b's rest position
    const shieldPart = {
      id: 'shield',
      name: 'Shield',
      parentId: null,
      pivot: { x: 32, y: 32 },
      origin: 'authored' as const,
      materialIds: [],
      paint: [{ kind: 'rect' as const, x: 30, y: 50, w: 12, h: 12, color: 0 }],
    };
    f.recipe.parts.push(shieldPart);
    f.rig.bindings.push({ partId: 'shield', jointId: 'root', socketId: null });
    f.plan.frames.forEach(frame => {
      frame.order = [...f.recipe.parts.map(p => p.id)];
    });

    const edit = createWalkPlan(f, {
      legIds: ['a', 'b'],
      armIds: [],
      stridePx: 4,
      liftPx: 3,
      crouchPx: 2,
      armSwingDegrees: 0,
      rootMotion: false,
    });
    const compiled = compileMotionRecipe(edit.recipe, edit.rig, edit.plan);
    // Ankle-b is occluded in composite frames, but its isolated rest art and explicit visibility are intact!
    assert.doesNotThrow(() => assertMotionArtwork(compiled, resources));
  }
});

test('6. Motion with all 8 identical frames but tiny nonzero joint vectors fails for walk', () => {
  const f = walkFixture();
  const ankleA = f.rig.joints.find(j => j.id === 'ankle-a')!.rest;
  const ankleB = f.rig.joints.find(j => j.id === 'ankle-b')!.rest;

  const plan: MotionPlan = {
    version: 1,
    id: 'walk-micro',
    rigId: f.rig.id,
    action: 'walk',
    loop: true,
    rootMotion: false,
    frames: f.recipe.frames.map((frame, i) => {
      const angle = i % 2 === 0 ? 0.001 : -0.001;
      return {
        id: frame.id,
        durationMs: frame.durationMs,
        root: { dx: 0, dy: 0 },
        travel: { dx: 0, dy: 0 },
        rotations: [
          { jointId: 'hip-a', degrees: angle },
          { jointId: 'knee-a', degrees: -angle },
          { jointId: 'hip-b', degrees: -angle },
          { jointId: 'knee-b', degrees: angle },
        ],
        order: f.recipe.parts.map(p => p.id),
        contacts: [
          { chainId: 'a', phase: 'stance', target: { x: ankleA.x, y: ankleA.y } },
          { chainId: 'b', phase: 'stance', target: { x: ankleB.x, y: ankleB.y } },
        ],
      };
    }),
  };

  const compiled = compileMotionRecipe(f.recipe, f.rig, plan);
  // Verify that compileMotionRecipe passes float geometry constraints
  assert.equal(compiled.geometry.length, 8);
  for (const g of compiled.geometry) {
    assert.ok(g.contacts.every(c => c.rasterError <= 1));
  }

  const resources: RecipeResources = { sources: [], masks: [] };
  // But all 8 native rasterized RGBA frames are identical: assertMotionArtwork must reject
  assert.throws(
    () => assertMotionArtwork(compiled, resources),
    /Hành động walk yêu cầu ít nhất 2 frame RGBA thực tế khác nhau/,
  );
});

test('7. Custom or idle identical poses still allowed, and no declared chains flat source allowed', () => {
  const resources: RecipeResources = { sources: [], masks: [] };

  // 7a. Idle action with identical frames allowed
  {
    const f = walkFixture();
    f.plan.action = 'idle';
    const compiled = compileMotionRecipe(f.recipe, f.rig, f.plan);
    assert.doesNotThrow(() => assertMotionArtwork(compiled, resources));
  }

  // 7b. Flat source with no declared chains allowed
  {
    const recipe: AssetRecipe = {
      version: 1,
      name: 'Flat Prop',
      canvas: { w: 16, h: 16 },
      palette: [0xffffffff],
      pivot: { x: 8, y: 8 },
      materials: [],
      parts: [
        {
          id: 'prop',
          name: 'Prop',
          parentId: null,
          pivot: { x: 8, y: 8 },
          origin: 'authored',
          materialIds: [],
          paint: [{ kind: 'rect', x: 4, y: 4, w: 8, h: 8, color: 0 }],
        },
      ],
      frames: [
        { id: 'f0', durationMs: 100, poses: [] },
        { id: 'f1', durationMs: 100, poses: [] },
      ],
      loop: true,
    };
    const rig: MotionRig = {
      version: 1,
      id: 'prop-rig',
      source: {
        projectId: 'p',
        assetId: 'a',
        frameId: 'f0',
        revision: 1,
        rgbaSha256: '0'.repeat(64),
        canvas: recipe.canvas,
        pivot: recipe.pivot,
      },
      joints: [{ id: 'center', parentId: null, rest: { x: 8, y: 8 }, minRotation: -180, maxRotation: 180 }],
      sockets: [],
      bindings: [{ partId: 'prop', jointId: 'center', socketId: null }],
      chains: [],
    };
    const plan: MotionPlan = {
      version: 1,
      id: 'prop-plan',
      rigId: rig.id,
      action: 'custom',
      loop: true,
      rootMotion: false,
      frames: recipe.frames.map(f => ({
        id: f.id,
        durationMs: f.durationMs,
        root: { dx: 0, dy: 0 },
        travel: { dx: 0, dy: 0 },
        rotations: [],
        order: ['prop'],
        contacts: [],
      })),
    };
    const compiled = compileMotionRecipe(recipe, rig, plan);
    assert.doesNotThrow(() => assertMotionArtwork(compiled, resources));
  }

  // 7c. Flat source with completely empty frame fails candidate nonempty check
  {
    const recipe: AssetRecipe = {
      version: 1,
      name: 'Empty Prop',
      canvas: { w: 16, h: 16 },
      palette: [0xffffffff],
      pivot: { x: 8, y: 8 },
      materials: [],
      parts: [
        {
          id: 'prop',
          name: 'Prop',
          parentId: null,
          pivot: { x: 8, y: 8 },
          origin: 'authored',
          materialIds: [],
          paint: [],
        },
      ],
      frames: [{ id: 'f0', durationMs: 100, poses: [] }],
      loop: true,
    };
    const rig: MotionRig = {
      version: 1,
      id: 'prop-rig',
      source: {
        projectId: 'p',
        assetId: 'a',
        frameId: 'f0',
        revision: 1,
        rgbaSha256: '0'.repeat(64),
        canvas: recipe.canvas,
        pivot: recipe.pivot,
      },
      joints: [{ id: 'center', parentId: null, rest: { x: 8, y: 8 }, minRotation: -180, maxRotation: 180 }],
      sockets: [],
      bindings: [{ partId: 'prop', jointId: 'center', socketId: null }],
      chains: [],
    };
    const plan: MotionPlan = {
      version: 1,
      id: 'prop-plan',
      rigId: rig.id,
      action: 'custom',
      loop: true,
      rootMotion: false,
      frames: [{ id: 'f0', durationMs: 100, root: { dx: 0, dy: 0 }, travel: { dx: 0, dy: 0 }, rotations: [], order: ['prop'], contacts: [] }],
    };
    const compiled = compileMotionRecipe(recipe, rig, plan);
    assert.throws(
      () => assertMotionArtwork(compiled, resources),
      /Frame 1 rỗng/,
    );
  }
});
