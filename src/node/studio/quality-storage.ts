import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { safePath } from './store.ts';
import { dataId } from '../../studio/quality/data.ts';
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function assertQualityRoot(root: string): void {
  if (realpathSync(root) !== resolve(root) || lstatSync(root).isSymbolicLink()) throw new Error('Gốc kho chất lượng đã bị thay bằng liên kết.');
}
export function qualityDirectory(root: string, id: string): string {
  assertQualityRoot(root); dataId(id, 'ID kho chất lượng');
  const path = safePath(root, id);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Không dùng liên kết làm snapshot chất lượng.');
  return path;
}
/** Binary buffers are separate compressed blobs; never construct a huge base64 JSON string. */
export function writeQualitySnapshot(root: string, id: string, value: unknown): string {
  const dir = qualityDirectory(root, id); if (existsSync(dir)) throw new Error('Snapshot chất lượng đã tồn tại.'); mkdirSync(dir);
  let index = 0;
  const json = JSON.stringify(value, function(key, v) {
    const original = key === '' ? value : this[key];
    if (!(original instanceof Uint32Array) && !(original instanceof Uint8Array)) return v;
    const kind = original instanceof Uint32Array ? 'u32' : 'u8', length = original.length;
    if (original.byteLength > 128_000_000) throw new Error('Buffer snapshot vượt giới hạn.');
    const bytes = kind === 'u32' ? Buffer.alloc(original.byteLength) : Buffer.from(original);
    if (kind === 'u32') for (let i = 0; i < length; i++) bytes.writeUInt32BE(original[i], i * 4);
    const file = `buffer-${index++}.bin.z`;
    qualityDirectory(root, id);
    writeFileSync(safePath(dir, file), deflateSync(bytes), { flag: 'wx' });
    return { $qualityArray: kind, file, length, sha256: sha(bytes) };
  });
  if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error('Metadata snapshot quá lớn.');
  qualityDirectory(root, id);
  writeFileSync(safePath(dir, 'snapshot.json'), json, { flag: 'wx' }); return sha(json);
}
export function readQualitySnapshot(root: string, id: string, expected: string): unknown {
  const dir = qualityDirectory(root, id), json = readFileSync(safePath(dir, 'snapshot.json'), 'utf8');
  if (sha(json) !== expected) throw new Error('Snapshot chất lượng đã bị thay đổi.');
  return JSON.parse(json, (_, value) => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, '$qualityArray')) return value;
    if (Object.keys(value).length !== 4 || !['u32', 'u8'].includes(value.$qualityArray) || !/^buffer-\d+\.bin\.z$/.test(value.file) || !Number.isInteger(value.length) || value.length < 0) throw new Error('Tham chiếu buffer snapshot không hợp lệ.');
    const size = value.length * (value.$qualityArray === 'u32' ? 4 : 1);
    if (size > 128_000_000) throw new Error('Buffer snapshot vượt giới hạn.');
    const bytes = inflateSync(readFileSync(safePath(dir, value.file)), { maxOutputLength: Math.max(1, size) });
    if (bytes.length !== size || sha(bytes) !== value.sha256) throw new Error('Buffer snapshot đã bị thay đổi.');
    if (value.$qualityArray === 'u8') return new Uint8Array(bytes);
    const pixels = new Uint32Array(value.length); for (let i = 0; i < pixels.length; i++) pixels[i] = bytes.readUInt32BE(i * 4); return pixels;
  });
}
export function writeQualityVariant(root: string, snapshotId: string, variantId: string, value: unknown): string {
  const dir = qualityDirectory(root, snapshotId); dataId(variantId, 'ID biến thể chất lượng');
  const path = safePath(dir, `variant-${variantId}.json`); if (existsSync(path)) throw new Error('Biến thể chất lượng đã tồn tại.');
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > 5_000_000) throw new Error('Biến thể chất lượng quá lớn.'); writeFileSync(path, text, { flag: 'wx' }); return sha(text);
}
export function readQualityVariant(root: string, snapshotId: string, variantId: string, expected: string): unknown {
  dataId(variantId, 'ID biến thể chất lượng'); const path = safePath(qualityDirectory(root, snapshotId), `variant-${variantId}.json`), text = readFileSync(path, 'utf8');
  if (sha(text) !== expected) throw new Error('Biến thể chất lượng đã bị thay đổi.'); return JSON.parse(text);
}
