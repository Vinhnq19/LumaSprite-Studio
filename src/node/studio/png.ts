import { crc32, deflateSync } from 'node:zlib';
import type { Img } from '../../studio/raster.ts';

function chunk(name: string, payload: Buffer): Buffer {
  const block = Buffer.alloc(payload.length + 12);
  block.writeUInt32BE(payload.length);
  block.write(name, 4, 'ascii');
  payload.copy(block, 8);
  block.writeUInt32BE(crc32(block.subarray(4, block.length - 4)), block.length - 4);
  return block;
}

/** Write the packed raster as lossless RGBA at its native size. */
export function encodePng(image: Img): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.w);
  header.writeUInt32BE(image.h, 4);
  header.set([8, 6], 8);
  const stride = image.w * 4 + 1;
  const scanlines = Buffer.alloc(stride * image.h);
  for (let y = 0; y < image.h; y++) {
    const row = y * stride + 1;
    for (let x = 0; x < image.w; x++) scanlines.writeUInt32BE(image.data[y * image.w + x], row + x * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
