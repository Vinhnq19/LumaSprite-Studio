import type { Img } from '../../studio/raster.ts';

interface Frame { img: Img; ms: number }

function paletteFor(frames: readonly Frame[]): { colors: number[]; index: (rgba: number) => number } {
  // Slot zero is always available for transparent pixels. An opaque black uses its own slot.
  const indices = new Map<number, number>();
  const colors = [0];
  for (const { img } of frames) {
    for (const rgba of img.data) {
      const rgb = rgba >>> 8;
      if ((rgba & 255) < 128 || indices.has(rgb)) continue;
      if (colors.length === 256) {
        // A uniform RGB grid fits the remaining 255 slots across every frame.
        const levels = [0, 51, 102, 153, 204, 255];
        const grid = [0];
        for (const r of levels) for (const g of levels) for (const b of levels) grid.push(r * 65536 + g * 256 + b);
        return { colors: grid, index: pixel => {
          if ((pixel & 255) < 128) return 0;
          const r = Math.round((pixel >>> 24) / 51);
          const g = Math.round((pixel >>> 16 & 255) / 51);
          const b = Math.round((pixel >>> 8 & 255) / 51);
          return 1 + r * 36 + g * 6 + b;
        } };
      }
      indices.set(rgb, colors.length);
      colors.push(rgb);
    }
  }
  return { colors, index: rgba => (rgba & 255) < 128 ? 0 : indices.get(rgba >>> 8)! };
}

// Emit short runs of literal LZW symbols. Reset before the decoder widens its code size.
function frameCodes(image: Img, lookup: (pixel: number) => number, depth: number): Buffer {
  const clear = 1 << depth;
  const run = clear - 2;
  const bits = depth + 1;
  const packed = Buffer.alloc(Math.ceil((image.data.length + Math.ceil(image.data.length / run) + 1) * bits / 8));
  let byte = 0;
  let held = 0;
  let count = 0;
  function write(code: number): void {
    held |= code << count;
    count += bits;
    if (count >= 8) {
      packed[byte++] = held & 255;
      held >>>= 8;
      count -= 8;
      if (count >= 8) {
        packed[byte++] = held & 255;
        held >>>= 8;
        count -= 8;
      }
    }
  }
  for (let i = 0; i < image.data.length; i++) {
    if (i % run === 0) write(clear);
    write(lookup(image.data[i]));
  }
  write(clear + 1);
  if (count) packed[byte] = held;
  const blocks = Buffer.alloc(1 + packed.length + Math.ceil(packed.length / 255) + 1);
  blocks[0] = depth;
  let offset = 1;
  for (let i = 0; i < packed.length; i += 255) {
    const block = packed.subarray(i, i + 255);
    blocks[offset++] = block.length;
    block.copy(blocks, offset);
    offset += block.length;
  }
  return blocks;
}

export function encodeGif(frames: readonly Frame[], options: { loop?: boolean } = {}): Buffer {
  if (!frames.length) throw new Error('GIF needs at least one frame.');
  const { w, h } = frames[0].img;
  if (w > 65535 || h > 65535 || frames.some(({ img }) => img.w !== w || img.h !== h)) {
    throw new RangeError('GIF frames must have equal dimensions within the format limit.');
  }
  const { colors, index } = paletteFor(frames);
  const depth = Math.max(2, Math.ceil(Math.log2(colors.length)));
  const header = Buffer.alloc(13 + (3 << depth));
  header.write('GIF89a');
  header.writeUInt16LE(w, 6);
  header.writeUInt16LE(h, 8);
  header[10] = 0xf0 | (depth - 1);
  colors.forEach((color, i) => header.writeUIntBE(color, 13 + i * 3, 3));
  const chunks: Buffer[] = [header];
  if (options.loop !== false) chunks.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]));
  for (const { img, ms } of frames) {
    const descriptor = Buffer.from([0x21, 0xf9, 4, 9, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    descriptor.writeUInt16LE(Math.max(1, Math.min(65535, Math.round(ms / 10))), 4);
    descriptor.writeUInt16LE(w, 13);
    descriptor.writeUInt16LE(h, 15);
    chunks.push(descriptor, frameCodes(img, index, depth));
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}
