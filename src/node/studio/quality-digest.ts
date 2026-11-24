import { createHash } from 'node:crypto';
/** A portable RGBA byte digest, independent of host Uint32Array endianness. */
export function qualityRgbaHash(pixels: Uint32Array): string {
  const hash = createHash('sha256'), scratch = Buffer.alloc(Math.min(pixels.length, 4096) * 4);
  for (let start = 0; start < pixels.length; start += 4096) {
    const length = Math.min(4096, pixels.length - start);
    for (let i = 0; i < length; i++) scratch.writeUInt32BE(pixels[start + i], i * 4);
    hash.update(scratch.subarray(0, length * 4));
  }
  return hash.digest('hex');
}
