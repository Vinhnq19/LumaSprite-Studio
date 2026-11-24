import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function decodeTestPng(buffer: Buffer): { w: number; h: number; data: Uint32Array } {
  let w = 0, h = 0, mode = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset), kind = buffer.toString('ascii', offset + 4, offset + 8), data = buffer.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); mode = data[9]; }
    if (kind === 'PLTE') palette = Buffer.from(data);
    if (kind === 'tRNS') alpha = Buffer.from(data);
    if (kind === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  assert.ok(mode === 3 || mode === 6); const channels = mode === 3 ? 1 : 4, stride = w * channels + 1;
  const raw = inflateSync(Buffer.concat(chunks)), data = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * stride], 0);
    for (let x = 0; x < w; x++) {
      const offset = y * stride + 1 + x * channels;
      if (mode === 6) data[y * w + x] = raw.readUInt32BE(offset);
      else { const i = raw[offset]; data[y * w + x] = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) | (palette[i * 3 + 2] << 8) | (alpha[i] ?? 255)) >>> 0; }
    }
  }
  return { w, h, data };
}
export function unzipTestStored(buffer: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (let offset = 0; offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const length = buffer.readUInt32LE(offset + 18), names = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + names + extra, name = buffer.toString('utf8', offset + 30, offset + 30 + names);
    files[name] = buffer.subarray(start, start + length); offset = start + length;
  }
  return files;
}
