import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { Img } from '../src/studio/raster.ts';
import { encodePng } from '../src/node/studio/png.ts';
import { readStudioPng } from '../studio/pixel/read-png.ts';

test('PNG import preserves straight RGBA including colors whose alpha would round through Canvas', async () => {
  const data = Uint32Array.of(0x1c2d3e55, 0x00000000, 0xf07935ff);
  const png = Buffer.from(encodePng(new Img(3, 1, data)));
  assert.deepEqual(await readStudioPng(new Blob([png]), 3, 1), data);
  png[45] ^= 1;
  await assert.rejects(readStudioPng(new Blob([png]), 3, 1), /Chunk PNG hỏng/);
});

test('PNG import preserves indexed tRNS and reconstructs filtered rows across IDAT chunks', async () => {
  function chunk(type: string, bytes: Buffer): Buffer {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([length, name, bytes, checksum]);
  }
  const header = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 3, 0, 0, 0]);
  const compressed = deflateSync(Buffer.from([1, 1, 255, 2, 255, 1]));
  const png = Buffer.concat([
    Buffer.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', header),
    chunk('PLTE', Buffer.of(28, 45, 62, 240, 121, 53)), chunk('tRNS', Buffer.of(85)),
    chunk('IDAT', compressed.subarray(0, 5)), chunk('IDAT', compressed.subarray(5)), chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.deepEqual(await readStudioPng(new Blob([png]), 2, 2), Uint32Array.of(0xf07935ff, 0x1c2d3e55, 0x1c2d3e55, 0xf07935ff));
});
