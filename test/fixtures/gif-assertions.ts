import assert from 'node:assert/strict';

/** Decode the global-palette, full-frame GIFs written by pxl. */
export function decodeTestGif(buffer: Buffer) {
  assert.equal(buffer.toString('ascii', 0, 6), 'GIF89a');
  const w = buffer.readUInt16LE(6), h = buffer.readUInt16LE(8), flags = buffer.readUInt8(10);
  assert.ok(w > 0 && h > 0 && w * h <= 16_777_216 && (flags & 0x80), 'Invalid GIF canvas or global palette.');
  let offset = 13;
  const palette = new Uint32Array(2 << (flags & 7));
  for (let i = 0; i < palette.length; i++, offset += 3) palette[i] = (buffer.readUIntBE(offset, 3) << 8) | 255;
  const subBlocks = () => {
    const blocks: Buffer[] = [];
    for (let length = buffer.readUInt8(offset++); length; length = buffer.readUInt8(offset++)) {
      assert.ok(offset + length <= buffer.length, 'Truncated GIF sub-block.');
      blocks.push(buffer.subarray(offset, offset + length));
      offset += length;
    }
    return blocks;
  };
  const frames: { delay: number; disposal: number; pixels: Uint32Array }[] = [];
  let loop = false, delay = 0, transparent = -1, disposal = 0;
  for (let kind = buffer.readUInt8(offset++); kind !== 0x3b; kind = buffer.readUInt8(offset++)) {
    if (kind === 0x21) {
      const label = buffer.readUInt8(offset++), [first, second] = subBlocks();
      if (label === 0xf9) {
        assert.equal(first?.length, 4);
        delay = first.readUInt16LE(1);
        disposal = (first[0] >> 2) & 7;
        transparent = first[0] & 1 ? first[3] : -1;
        assert.ok(transparent < palette.length);
      }
      if (label === 0xff && first?.toString('ascii') === 'NETSCAPE2.0') {
        assert.equal(second?.length, 3);
        assert.equal(second[0], 1);
        assert.equal(second.readUInt16LE(1), 0, 'Finite loops are outside this fixture.');
        loop = true;
      }
      continue;
    }
    assert.equal(kind, 0x2c, 'Unexpected GIF block.');
    assert.deepEqual([buffer.readUInt16LE(offset), buffer.readUInt16LE(offset + 2), buffer.readUInt16LE(offset + 4), buffer.readUInt16LE(offset + 6)], [0, 0, w, h]);
    assert.equal(buffer.readUInt8(offset + 8) & 0xc0, 0, 'Local GIF palettes and interlacing are outside this fixture.');
    offset += 9;
    const min = buffer.readUInt8(offset++);
    const pixels = Uint32Array.from(unlzw(Buffer.concat(subBlocks()), min, w * h), i => {
      assert.ok(i < palette.length, 'GIF pixel outside the global palette.');
      return i === transparent ? 0 : palette[i];
    });
    frames.push({ delay, disposal, pixels });
    delay = 0; disposal = 0; transparent = -1;
  }
  assert.equal(offset, buffer.length, 'Unexpected bytes after the GIF trailer.');
  return { w, h, loop, frames };
}

function unlzw(data: Buffer, min: number, n: number): number[] {
  assert.ok(min >= 2 && min <= 8);
  const clear = 1 << min, eoi = clear + 1, out: number[] = [];
  let size = min + 1, dictionary: number[][] = [], previous: number[] | undefined, bit = 0;
  while (out.length < n) {
    assert.ok(bit + size <= data.length * 8, 'Truncated GIF pixel data.');
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      dictionary = Array.from({ length: clear }, (_, i) => [i]);
      dictionary.push([], []);
      size = min + 1; previous = undefined;
      continue;
    }
    assert.ok(dictionary.length && code !== eoi && (code < dictionary.length || (code === dictionary.length && previous)), 'Invalid GIF code before the full frame.');
    const entry = dictionary[code] ?? [...previous!, previous![0]];
    assert.ok(out.length + entry.length <= n, 'GIF image has too many pixels.');
    out.push(...entry);
    if (previous && dictionary.length < 4096) dictionary.push([...previous, entry[0]]);
    previous = entry;
    if (dictionary.length === 1 << size && size < 12) size++;
  }
  return out;
}
