import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
// Independent decode of PNG modes emitted by encodePng; no rendering code is used to derive pixels.
export function decodeQualityPng(data: Uint8Array): { w: number; h: number; pixels: Uint32Array } {
  const b = Buffer.from(data), chunks: Buffer[] = []; let w = 0, h = 0, type = 0, palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  for (let i = 8; i < b.length;) {
    const n = b.readUInt32BE(i), kind = b.toString('ascii', i + 4, i + 8), payload = b.subarray(i + 8, i + 8 + n);
    if (kind === 'IHDR') { w = payload.readUInt32BE(0); h = payload.readUInt32BE(4); type = payload[9]; }
    if (kind === 'PLTE') palette = payload;
    if (kind === 'tRNS') alpha = payload;
    if (kind === 'IDAT') chunks.push(payload);
    i += n + 12;
  }
  assert.ok(type === 3 || type === 6);
  const raw = inflateSync(Buffer.concat(chunks)), stride = 1 + w * (type === 3 ? 1 : 4), pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * stride], 0);
    for (let x = 0; x < w; x++) {
      const offset = y * stride + 1 + x * (type === 3 ? 1 : 4), index = raw[offset];
      const r = type === 3 ? palette[index * 3] : raw[offset], g = type === 3 ? palette[index * 3 + 1] : raw[offset + 1];
      const blue = type === 3 ? palette[index * 3 + 2] : raw[offset + 2], a = type === 3 ? alpha[index] ?? 255 : raw[offset + 3];
      pixels[y * w + x] = ((r << 24) | (g << 16) | (blue << 8) | a) >>> 0;
    }
  }
  return { w, h, pixels };
}
