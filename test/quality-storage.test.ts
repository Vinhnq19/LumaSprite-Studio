import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeQualitySnapshot, readQualitySnapshot, qualityDirectory, assertQualityRoot } from '../src/node/studio/quality-storage.ts';

function temp(prefix: string) { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }
function cleanup(path: string) { assert.equal(dirname(path), realpathSync(tmpdir())); assertQualityRoot(path); rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
test('snapshot binary codec is portable RGBA, preserves byte masks and detects changed manifests/blobs', () => {
  const root = temp('pxl-quality-storage-');
  try {
    const data = { title: 'Mẫu giáp', pixels: new Uint32Array([0, 0xff0000ff, 0x70c989ff]), mask: new Uint8Array([0, 1, 1]) };
    const digest = writeQualitySnapshot(root, 'sample', data), restored = readQualitySnapshot(root, 'sample', digest);
    assert.deepEqual(restored, data);
    writeFileSync(join(root, 'sample', 'buffer-0.bin.z'), 'bad'); assert.throws(() => readQualitySnapshot(root, 'sample', digest));
    assert.throws(() => qualityDirectory(root, '../outside'));
  } finally { cleanup(root); }
});
test('a snapshot junction cannot read/write/delete another directory', () => {
  const root = temp('pxl-quality-storage-'), outside = temp('pxl-quality-outside-'), link = join(root, 'linked');
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeQualitySnapshot(root, 'linked', {}), /liên kết|symlink/);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { try { unlinkSync(link); } catch {} cleanup(root); cleanup(outside); }
});
test('replacing the whole owned root with a junction is refused before any child path is used', () => {
  const parent = temp('pxl-quality-parent-'), outside = temp('pxl-quality-outside-'), root = join(parent, 'owned-root');
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  try {
    symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => qualityDirectory(root, 'snapshot'), /Gốc kho|liên kết/);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { try { unlinkSync(root); } catch {} cleanup(parent); cleanup(outside); }
});
