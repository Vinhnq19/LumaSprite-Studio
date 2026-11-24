import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMask, CANONICAL_MASKS, terrainSlot, assembleTerrain, quadrantKind, terrainBoundaryContrast, terrainEdgeDifferences } from '../src/studio/terrain.ts';

test('Terrain: matching opposing edges can still have a high-contrast band around the join', () => {
  const tile = Uint32Array.from({ length: 16 * 16 }, (_, i) => {
    const x = i % 16;
    return x < 2 || x >= 14 ? 0xffffffff : 0x000000ff;
  });
  assert.deepEqual(terrainEdgeDifferences(tile, 16), { horizontal: [], vertical: [] });
  assert.deepEqual(terrainBoundaryContrast(tile, 16), {
    leftRight: { band: 102, inside: 34 }, topBottom: { band: 0, inside: 0 },
  });
  tile[0] = 0;
  assert.equal(terrainBoundaryContrast(tile, 16), undefined);
});

test('Terrain: all 256 masks collapse to exactly 47 stable canonical tiles', () => {
  const masks = new Set<number>();
  for (let raw = 0; raw < 256; raw++) {
    const actual = canonicalMask(raw); masks.add(actual);
    assert.equal(actual & 15, raw & 15);
    for (const [diagonal, a, b] of [[16, 1, 2], [32, 2, 4], [64, 4, 8], [128, 8, 1]]) {
      assert.equal(!!(actual & diagonal), !!(raw & diagonal) && !!(raw & a) && !!(raw & b));
    }
    assert.equal(canonicalMask(actual), actual);
    assert.equal(CANONICAL_MASKS[terrainSlot(raw)], actual);
  }
  assert.equal(masks.size, 47);
  assert.deepEqual([...masks].sort((a, b) => a - b), CANONICAL_MASKS);
  for (const invalid of [-1, 256, NaN, 1.5, Infinity]) assert.throws(() => canonicalMask(invalid));
});

test('Terrain: five local quadrant templates preserve native pixels, spare and shared palette', () => {
  assert.deepEqual([quadrantKind(false, false, false), quadrantKind(true, false, false), quadrantKind(false, true, false), quadrantKind(true, true, false), quadrantKind(true, true, true)], ['outer', 'horizontal', 'vertical', 'inner', 'interior']);
  for (const size of [16, 32] as const) {
    const material = Uint32Array.from({ length: size * size }, (_, i) => ((i * 256 + 255) >>> 0));
    const saved = material.slice();
    const atlas = assembleTerrain(material, { tileSize: size, inset: 2, sampling: 'repeat' });
    assert.equal(atlas.w, 8 * size); assert.equal(atlas.h, 6 * size);
    assert.deepEqual(material, saved);
    const at = (slot: number, x: number, y: number) => atlas.data[(Math.floor(slot / 8) * size + y) * atlas.w + slot % 8 * size + x];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      assert.equal(at(47, x, y), material[y * size + x]);
      assert.equal(at(terrainSlot(255), x, y), material[y * size + x]);
      assert.equal(at(terrainSlot(0), x, y), x < 2 || y < 2 || x >= size - 2 || y >= size - 2 ? 0 : material[y * size + x]);
    }
    // Missing NW diagonal creates a concave 2x2 hole, without changing other corners.
    assert.equal(at(terrainSlot(127), 0, 0), 0);
    assert.equal(at(terrainSlot(127), 2, 0), material[2]);
    assert.equal(at(terrainSlot(127), size - 1, 0), material[size - 1]);
    const colors = new Set(material); colors.add(0);
    assert.ok(atlas.data.every(v => colors.has(v)));
    assert.deepEqual(assembleTerrain(material, { tileSize: size, inset: 2, sampling: 'repeat' }), atlas);
    const mirrored = assembleTerrain(material, { tileSize: size, inset: 2, sampling: 'mirror' });
    const center = terrainSlot(255), ox = center % 8 * size, oy = Math.floor(center / 8) * size;
    for (let y = 0; y < size; y++) assert.equal(mirrored.data[(oy + y) * mirrored.w + ox], mirrored.data[(oy + y) * mirrored.w + ox + size - 1]);
  }
  assert.throws(() => assembleTerrain(new Uint32Array(256), { tileSize: 16, inset: 1, sampling: 'repeat' }), /rỗng/);
  assert.throws(() => assembleTerrain(new Uint32Array(18 * 18).fill(255), { tileSize: 16, inset: 1, sampling: 'repeat' }), /không tự co/);
});
