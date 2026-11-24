import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  type StudioResource,
  validateResourceId,
  isValidResourceId,
  validateResourceRef,
  validateResource,
  validateResourceMap,
  cloneResource,
  cloneResourceMap,
  editResourceData,
  resourceBytes,
  resourcePixels,
  wireStringify,
  wireParse,
} from '../src/studio/resources.ts';
import {
  ResourceBlobStore,
  resourceRefKey,
  parseResourceRefKey,
} from '../src/node/studio/resource-store.ts';

const tempRoots: string[] = [];
function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pxl-res-test-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      assert.equal(resolve(dirname(root)), resolve(tmpdir()));
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if already removed
    }
  }
});

test('Shared Resource: ID validation and reserved name rejection', () => {
  assert.equal(isValidResourceId('cat_01'), true);
  assert.equal(isValidResourceId('hero-mask'), true);
  assert.equal(isValidResourceId('a'), true);
  assert.equal(isValidResourceId('tile_12-map'), true);
  assert.equal(validateResourceId('hero_run_01'), 'hero_run_01');

  // Invalid IDs
  assert.equal(isValidResourceId(''), false);
  assert.equal(isValidResourceId('with space'), false);
  assert.equal(isValidResourceId('special@char'), false);
  assert.equal(isValidResourceId('a'.repeat(81)), false);
  assert.throws(() => validateResourceId(''), /ID tài nguyên không hợp lệ/);
  assert.throws(() => validateResourceId('invalid/id'), /ID tài nguyên không hợp lệ/);
  assert.throws(() => validateResourceId(123), /phải là chuỗi/);

  // Reserved names
  const reserved = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'];
  for (const name of reserved) {
    assert.equal(isValidResourceId(name), false);
    assert.throws(() => validateResourceId(name), /dự lưu/);
  }
});

test('Shared Resource: exact contract, bounds, kinds, binary masks, and map validation', () => {
  const validRgba: StudioResource = {
    version: 1,
    kind: 'rgba',
    w: 32,
    h: 32,
    data: new Uint32Array(32 * 32),
  };
  validateResource(validRgba);

  // Unknown extra fields rejected
  assert.throws(
    () => validateResource({ ...validRgba, extraField: 'bad' }),
    /Trường không hợp lệ trong tài nguyên/
  );

  // Invalid version
  assert.throws(() => validateResource({ ...validRgba, version: 2 }), /Phiên bản tài nguyên không hợp lệ/);

  // Invalid kind
  assert.throws(() => validateResource({ ...validRgba, kind: 'unknown' }), /Loại tài nguyên không hợp lệ/);

  // Dimensions
  assert.throws(() => validateResource({ ...validRgba, w: 0 }), /số nguyên dương/);
  assert.throws(() => validateResource({ ...validRgba, w: 4097 }), /vượt giới hạn tối đa 4096/);
  assert.throws(() => validateResource({ ...validRgba, h: 4097 }), /vượt giới hạn tối đa 4096/);

  // Tile-index dimensions limit (max 32)
  const validTile: StudioResource = {
    version: 1,
    kind: 'tile-index',
    w: 16,
    h: 16,
    data: new Uint32Array(16 * 16),
  };
  validateResource(validTile);
  assert.throws(() => validateResource({ ...validTile, w: 33 }), /vượt giới hạn tối đa 32/);

  // Missing both data and blob
  assert.throws(
    () => validateResource({ version: 1, kind: 'rgba', w: 10, h: 10 }),
    /phải có ít nhất blob hoặc data/
  );

  // Non-Uint32Array data (plain array / object - no coercion)
  assert.throws(
    () => validateResource({ version: 1, kind: 'rgba', w: 2, h: 2, data: [0, 0, 0, 0] as any }),
    /phải là Uint32Array/
  );

  // Data length mismatch
  assert.throws(
    () => validateResource({ version: 1, kind: 'rgba', w: 4, h: 4, data: new Uint32Array(15) }),
    /không khớp kích thước w\*h/
  );

  // Mask binary validation
  const validMaskData = new Uint32Array(16);
  validMaskData[0] = 1;
  validMaskData[5] = 1;
  const validMask: StudioResource = {
    version: 1,
    kind: 'mask',
    w: 4,
    h: 4,
    data: validMaskData,
  };
  validateResource(validMask);

  const invalidMaskData = new Uint32Array(16);
  invalidMaskData[3] = 2; // non-binary
  assert.throws(
    () => validateResource({ version: 1, kind: 'mask', w: 4, h: 4, data: invalidMaskData }),
    /Mặt nạ chỉ cho phép giá trị nhị phân 0 hoặc 1/
  );

  // Blob validation (must be 64-character lowercase hex)
  const validBlob = 'a'.repeat(64);
  validateResource({ version: 1, kind: 'rgba', w: 16, h: 16, blob: validBlob });
  assert.throws(
    () => validateResource({ version: 1, kind: 'rgba', w: 16, h: 16, blob: 'SHORT' }),
    /Blob digest phải là chuỗi 64 ký tự hex chữ thường/
  );
  assert.throws(
    () => validateResource({ version: 1, kind: 'rgba', w: 16, h: 16, blob: 'A'.repeat(64) }),
    /Blob digest phải là chuỗi 64 ký tự hex chữ thường/
  );

  // Map validation
  const map: Record<string, StudioResource> = {
    res1: validRgba,
    res2: validMask,
  };
  validateResourceMap(map);

  assert.throws(() => validateResourceMap(null), /phải là đối tượng/);
  assert.throws(() => validateResourceMap([]), /phải là đối tượng/);

  // Map size limit
  const hugeMap: Record<string, StudioResource> = {};
  for (let i = 0; i < 1025; i++) {
    hugeMap[`id_${i}`] = validRgba;
  }
  assert.throws(() => validateResourceMap(hugeMap), /vượt quá giới hạn 1024/);
});

test('Shared Resource: cloning, editing helper mutation isolation, LE bytes, and wire format', () => {
  const originalData = new Uint32Array([0x12345678, 0x9abcdef0]);
  const res: StudioResource = {
    version: 1,
    kind: 'rgba',
    w: 2,
    h: 1,
    blob: 'c'.repeat(64),
    data: originalData,
  };

  // cloneResource
  const shallowClone = cloneResource(res, false);
  assert.equal(shallowClone.data, originalData);
  const deepClone = cloneResource(res, true);
  assert.notEqual(deepClone.data, originalData);
  assert.deepEqual(deepClone.data, originalData);

  // cloneResourceMap
  const mapClone = cloneResourceMap({ test: res }, true);
  assert.notEqual(mapClone.test.data, originalData);
  assert.deepEqual(mapClone.test.data, originalData);

  // Finding 4: editResourceData MUST own a fresh buffer and isolate mutations from both old and nextData
  const inputBuffer = new Uint32Array([0x00000001, 0x00000002]);
  const edited = editResourceData(res, inputBuffer);
  assert.notEqual(edited.data, inputBuffer); // Must NOT alias inputBuffer
  assert.deepEqual(edited.data, inputBuffer);
  assert.equal(edited.blob, undefined); // Clears blob

  // Mutating edited.data must NOT affect inputBuffer or res.data
  edited.data![0] = 0x99999999;
  assert.equal(inputBuffer[0], 0x00000001);
  assert.equal(res.data![0], 0x12345678);

  // Mutating inputBuffer must NOT affect edited.data
  inputBuffer[1] = 0x77777777;
  assert.equal(edited.data![1], 0x00000002);

  // editResourceData with old resource data
  const editedFromSelf = editResourceData(res, res.data!);
  editedFromSelf.data![0] = 0x55555555;
  assert.equal(res.data![0], 0x12345678); // Original buffer untouched

  // LE bytes and pixels roundtrip
  const testWords = new Uint32Array([0x00000000, 0xffffffff, 0x12345678, 0xaabbccdd]);
  const bytes = resourceBytes(testWords);
  assert.equal(bytes.length, 16);
  // Verify little-endian byte ordering: 0x12345678 -> 0x78, 0x56, 0x34, 0x12
  assert.equal(bytes[8], 0x78);
  assert.equal(bytes[9], 0x56);
  assert.equal(bytes[10], 0x34);
  assert.equal(bytes[11], 0x12);

  const restored = resourcePixels(bytes);
  assert.deepEqual(restored, testWords);

  // Wire stringify and wire parse
  const serialized = wireStringify({ resource: res });
  assert.equal(typeof serialized, 'string');
  assert.match(serialized, /\$rgba/);
  const parsed = wireParse(serialized);
  assert.ok(parsed.resource.data instanceof Uint32Array);
  assert.deepEqual(parsed.resource.data, originalData);
});

test('Finding 1: Preexisting corrupted target rejection preventing immutable cache poisoning', () => {
  const dir = createTempDir();
  const store = new ResourceBlobStore(dir);

  const w = 4;
  const h = 4;
  const validData = new Uint32Array(w * h);
  for (let i = 0; i < validData.length; i++) validData[i] = 0xff0000ff; // Red pixels
  const validCompressed = deflateSync(resourceBytes(validData));
  const validDigest = createHash('sha256').update(validCompressed).digest('hex');

  // Pre-seed a CORRUPTED file on disk at the target digest location
  const resDir = join(dir, '.pxl', 'resources');
  mkdirSync(resDir, { recursive: true });
  const targetPath = join(resDir, `${validDigest}.rgba.z`);

  // Write different/corrupted data (e.g. green pixels compressed) to the target path
  const corruptData = new Uint32Array(w * h);
  for (let i = 0; i < corruptData.length; i++) corruptData[i] = 0x00ff00ff; // Green
  const corruptCompressed = deflateSync(resourceBytes(corruptData));
  writeFileSync(targetPath, corruptCompressed);

  // 1. Fresh store calling put with original valid data MUST detect existing corrupt file and throw 409
  assert.throws(
    () => store.put({ version: 1, kind: 'rgba', w, h, data: validData }),
    /bị hỏng hoặc sai checksum/
  );

  // 2. Fresh store calling import with valid compressed bytes MUST detect existing corrupt file and throw 409
  assert.throws(
    () => store.import({ version: 1, kind: 'rgba', w, h, blob: validDigest }, validCompressed),
    /bị hỏng hoặc sai checksum/
  );

  // Ensure corrupt stat signature was NOT cached and read does NOT return corrupt green pixels
  assert.throws(
    () => store.read({ version: 1, kind: 'rgba', w, h, blob: validDigest }),
    /Tài nguyên bị sai checksum hoặc hỏng/
  );
});

test('Finding 2 & 3: verify(no-size) cannot bypass shape, invalid dimensions, or bad masks', () => {
  const dir = createTempDir();
  const store = new ResourceBlobStore(dir);

  const w = 2;
  const h = 2;
  const data = new Uint32Array([1, 2, 3, 4]);
  const ref = store.put({ version: 1, kind: 'rgba', w, h, data });

  // 1. Calling metadata-only verify (no totalPixels)
  const path = store.verify('rgba', ref.blob);
  assert.ok(existsSync(path));

  // 2. Calling verify with wrong totalPixels MUST FAIL despite previous verify cache
  assert.throws(
    () => store.verify('rgba', ref.blob, 100),
    /Kích thước tài nguyên giải nén không khớp/
  );

  // 3. Blob-only put with wrong shape MUST FAIL
  assert.throws(
    () => store.put({ version: 1, kind: 'rgba', w: 10, h: 10, blob: ref.blob }),
    /Kích thước tài nguyên giải nén không khớp/
  );

  // 4. read and compressed with wrong shape MUST FAIL
  assert.throws(
    () => store.read({ version: 1, kind: 'rgba', w: 8, h: 8, blob: ref.blob }),
    /Kích thước tài nguyên giải nén không khớp/
  );
  assert.throws(
    () => store.compressed({ version: 1, kind: 'rgba', w: 8, h: 8, blob: ref.blob }),
    /Kích thước tài nguyên giải nén không khớp/
  );

  // 5. Finding 3: Public read/compressed reject fractional or out-of-budget dimensions (e.g. w: 8192, h: 1/2048)
  assert.throws(
    () => store.read({ version: 1, kind: 'rgba', w: 8192, h: 1 / 2048, blob: ref.blob }),
    /số nguyên dương/
  );
  assert.throws(
    () => store.compressed({ version: 1, kind: 'rgba', w: 8192, h: 1 / 2048, blob: ref.blob }),
    /số nguyên dương/
  );

  // Tile dimension limit (max 32)
  assert.throws(
    () => store.read({ version: 1, kind: 'tile-index', w: 33, h: 1, blob: ref.blob }),
    /vượt giới hạn tối đa 32/
  );

  // 6. Cache cannot bypass malformed-mask decoded values
  const nonBinaryMaskData = new Uint32Array([0, 1, 5, 0]);
  const nonBinaryCompressed = deflateSync(resourceBytes(nonBinaryMaskData));
  const badMaskDigest = createHash('sha256').update(nonBinaryCompressed).digest('hex');
  const badMaskPath = join(dir, '.pxl', 'resources', `${badMaskDigest}.mask.z`);
  writeFileSync(badMaskPath, nonBinaryCompressed);

  // Metadata-only verify succeeds (only verifies sha256)
  store.verify('mask', badMaskDigest);

  // Shape verification / read / verify(total) MUST FAIL on mask binary validation
  assert.throws(
    () => store.verify('mask', badMaskDigest, 4),
    /Mặt nạ chứa giá trị không phải 0 hoặc 1/
  );
  assert.throws(
    () => store.read({ version: 1, kind: 'mask', w: 2, h: 2, blob: badMaskDigest }),
    /Mặt nạ chứa giá trị không phải 0 hoặc 1/
  );

  // Import with explicit invalid blob must fail
  assert.throws(
    () => store.import({ version: 1, kind: 'rgba', w: 2, h: 2, blob: 'invalid-hex' }, nonBinaryCompressed),
    /Blob digest phải là chuỗi 64 ký tự hex chữ thường/
  );
  assert.throws(
    () => store.import({ version: 1, kind: 'rgba', w: 2, h: 2, blob: '' }, nonBinaryCompressed),
    /Blob digest phải là chuỗi 64 ký tự hex chữ thường/
  );
});

test('ResourceBlobStore: compressed bytes export and import transfer between project stores', () => {
  const dirA = createTempDir();
  const dirB = createTempDir();
  const storeA = new ResourceBlobStore(dirA);
  const storeB = new ResourceBlobStore(dirB);

  const w = 8;
  const h = 8;
  const data = new Uint32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = 0xdeadbeef + i;

  const refA = storeA.put({ version: 1, kind: 'rgba', w, h, data });
  const compressedBytes = storeA.compressed(refA);
  assert.ok(compressedBytes instanceof Buffer);

  // Import into store B
  const importInput = { version: 1 as const, kind: 'rgba' as const, w, h, blob: refA.blob };
  const refB = storeB.import(importInput, compressedBytes);

  assert.equal(refB.blob, refA.blob);
  assert.equal(refB.kind, 'rgba');
  assert.equal(refB.w, w);
  assert.equal(refB.h, h);

  // Read back from store B
  const dataB = storeB.read(refB);
  assert.deepEqual(dataB, data);

  // Import rejection: corrupted compressed bytes
  const badCompressed = Buffer.from(compressedBytes);
  badCompressed[badCompressed.length - 1] ^= 0x55;
  assert.throws(() => storeB.import(importInput, badCompressed), /Checksum dữ liệu nén không khớp/);

  // Import rejection: invalid mask values
  const nonBinaryMask = new Uint32Array([0, 1, 9, 1]);
  const badMaskBytes = deflateSync(resourceBytes(nonBinaryMask));
  assert.throws(
    () => storeB.import({ version: 1, kind: 'mask', w: 2, h: 2 }, badMaskBytes),
    /Mặt nạ chứa giá trị không phải 0 hoặc 1/
  );
});

test('Finding 5: Collection destructive-input guard and no-deletion assertions on malformed calls', () => {
  const dir = createTempDir();
  const store = new ResourceBlobStore(dir);

  // Put resources
  const data = new Uint32Array(4 * 4);
  const refUsed = store.put({ version: 1, kind: 'rgba', w: 4, h: 4, data: new Uint32Array(data).fill(1) });
  const refFresh = store.put({ version: 1, kind: 'rgba', w: 4, h: 4, data: new Uint32Array(data).fill(2) });
  const refAged = store.put({ version: 1, kind: 'rgba', w: 4, h: 4, data: new Uint32Array(data).fill(3) });

  const resourcesDir = join(dir, '.pxl', 'resources');
  const usedPath = join(resourcesDir, `${refUsed.blob}.rgba.z`);
  const freshPath = join(resourcesDir, `${refFresh.blob}.rgba.z`);
  const agedPath = join(resourcesDir, `${refAged.blob}.rgba.z`);

  // Age the third blob to 48 hours ago
  const twoDaysAgo = (Date.now() - 48 * 3600 * 1000) / 1000;
  utimesSync(agedPath, twoDaysAgo, twoDaysAgo);

  // Create an unmatched user file (aged 48 hours)
  const userFilePath = join(resourcesDir, 'custom_user_image.png');
  writeFileSync(userFilePath, 'user image bytes');
  utimesSync(userFilePath, twoDaysAgo, twoDaysAgo);

  // Try creating a symlink in the resources dir
  let symlinkCreated = false;
  const symlinkPath = join(resourcesDir, 'symlink-to-used.z');
  try {
    symlinkSync(usedPath, symlinkPath);
    symlinkCreated = true;
  } catch (err) {
    console.log('Skipping symlink construction due to OS denial:', (err as Error).message);
  }

  // 1. Malformed usedKeys must throw and delete NO files
  assert.throws(() => store.collect(null as any), /usedKeys không hợp lệ/);
  assert.throws(() => store.collect('invalid-string' as any), /usedKeys không hợp lệ/);
  assert.throws(() => store.collect(new Set(['oops'])), /Khóa tài nguyên trong usedKeys không hợp lệ/);
  assert.throws(() => store.collect(new Set([`rgba:${'x'.repeat(64)}`])), /Khóa tài nguyên trong usedKeys không hợp lệ/);
  assert.throws(() => store.collect(new Set(['../traversal'])), /Khóa tài nguyên trong usedKeys không hợp lệ/);
  assert.throws(() => store.collect({ source: {} } as any), /Tài nguyên phải là đối tượng hợp lệ|Phiên bản tài nguyên không hợp lệ/);
  assert.throws(() => store.collect({ source: { kind: 'invalid', blob: refUsed.blob } } as any), /Loại tài nguyên không hợp lệ|Phiên bản tài nguyên không hợp lệ/);
  assert.throws(() => store.collect(new Map() as any), /chỉ chấp nhận Set, Array hoặc plain object/);
  assert.throws(() => store.collect(new Date() as any), /chỉ chấp nhận Set, Array hoặc plain object/);
  assert.throws(() => store.collect({ badKey: null } as any), /Tài nguyên phải là đối tượng hợp lệ/);

  // 2. Malformed olderThan must throw and delete NO files
  assert.throws(() => store.collect(new Set(), new Date('invalid date')), /Invalid Date/);
  assert.throws(() => store.collect(new Set(), -1000), /không âm/);
  assert.throws(() => store.collect(new Set(), NaN), /không âm/);

  // Assert NO files were deleted by any of the malformed calls
  assert.equal(existsSync(usedPath), true);
  assert.equal(existsSync(freshPath), true);
  assert.equal(existsSync(agedPath), true);
  assert.equal(existsSync(userFilePath), true);

  // 3. Valid empty collections and valid key grammar forms
  // Empty Set is intentional valid empty
  const emptyCheck = store.collect(new Set(), 24 * 3600 * 1000);
  assert.equal(emptyCheck.deleted, 1); // Only aged unreferenced file is deleted
  assert.equal(existsSync(agedPath), false);
  assert.equal(existsSync(usedPath), true);
  assert.equal(existsSync(freshPath), true);
  assert.equal(existsSync(userFilePath), true);

  // Re-put aged resource and age it again to test valid key grammar forms
  store.put({ version: 1, kind: 'rgba', w: 4, h: 4, data: new Uint32Array(data).fill(3) });
  utimesSync(agedPath, twoDaysAgo, twoDaysAgo);

  // Test retention with kind:hex grammar form
  const retainWithKindHex = store.collect(new Set([`rgba:${refAged.blob}`]), 24 * 3600 * 1000);
  assert.equal(retainWithKindHex.deleted, 0);
  assert.equal(existsSync(agedPath), true);

  // Test retention with hex.kind.z grammar form
  const retainWithFilename = store.collect([`${refAged.blob}.rgba.z`], 24 * 3600 * 1000);
  assert.equal(retainWithFilename.deleted, 0);
  assert.equal(existsSync(agedPath), true);

  // Test retention with valid plain object resource map
  const validMap = {
    myRes: { version: 1 as const, kind: 'rgba' as const, w: 4, h: 4, blob: refAged.blob },
  };
  const retainWithMap = store.collect(validMap, 24 * 3600 * 1000);
  assert.equal(retainWithMap.deleted, 0);
  assert.equal(existsSync(agedPath), true);

  // Finally collect with refUsed only (agedPath will be deleted)
  const finalResult = store.collect(new Set([refUsed.blob]), 24 * 3600 * 1000);
  assert.equal(finalResult.deleted, 1);
  assert.equal(existsSync(agedPath), false);
  assert.equal(existsSync(usedPath), true);
  assert.equal(existsSync(freshPath), true);
  assert.equal(existsSync(userFilePath), true);
  if (symlinkCreated) {
    assert.equal(existsSync(symlinkPath), true, 'Symlink must never be deleted');
  }
});
