import { crc32, deflateSync, inflateSync } from 'node:zlib';
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced 8-bit PNG into big-endian packed RGBA32 + raw RGBA bytes. */
export function decodePng(buffer: Buffer): { w: number; h: number; data: Uint32Array; rgbaBytes: Buffer } {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(sig)) throw new Error('File PNG không hợp lệ (sai chữ ký đầu file).');
  let w = 0, h = 0, bitDepth = 0, colorType = -1, compression = -1, filter = -1, interlace = -1;
  let seenIhdr = false, seenIend = false;
  let palette = Buffer.alloc(0), alpha = Buffer.alloc(0);
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) throw new Error('Chunk PNG bị cắt cụt.');
    const kind = buffer.toString('ascii', offset + 4, offset + 8);
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length)) >>> 0;
    if (actualCrc !== expectedCrc) throw new Error(`Chunk PNG ${kind} bị lỗi CRC.`);
    if (kind === 'IHDR') {
      if (length !== 13 || seenIhdr) throw new Error('Chunk IHDR PNG không hợp lệ.');
      seenIhdr = true;
      w = payload.readUInt32BE(0); h = payload.readUInt32BE(4);
      bitDepth = payload[8]; colorType = payload[9];
      compression = payload[10]; filter = payload[11]; interlace = payload[12];
    } else if (kind === 'PLTE') {
      if (length % 3 !== 0) throw new Error('Bảng màu PLTE PNG không hợp lệ.');
      palette = Buffer.from(payload);
    } else if (kind === 'tRNS') {
      alpha = Buffer.from(payload);
    } else if (kind === 'IDAT') {
      idat.push(payload);
    } else if (kind === 'IEND') {
      seenIend = true;
      break;
    }
    offset += 12 + length;
  }
  if (!seenIhdr || !seenIend || !idat.length) throw new Error('File PNG thiếu IHDR/IDAT/IEND.');
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 16_777_216) {
    throw new Error(`Kích thước PNG vượt giới hạn: ${w}x${h}.`);
  }
  if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) {
    throw new Error(`Định dạng PNG không được hỗ trợ (depth=${bitDepth}, color=${colorType}, interlace=${interlace}).`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = w * channels;
  const stride = rowBytes + 1;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: stride * h });
  if (raw.length !== stride * h) throw new Error('Dữ liệu pixel PNG giải nén không khớp kích thước.');

  const scan = new Uint8Array(rowBytes);
  const prev = new Uint8Array(rowBytes);
  const rgbaBytes = Buffer.alloc(w * h * 4);
  const data = new Uint32Array(w * h);

  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const base = y * stride + 1;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[base + i];
      const a = i >= channels ? scan[i - channels] : 0;
      const b = y > 0 ? prev[i] : 0;
      const c = (y > 0 && i >= channels) ? prev[i - channels] : 0;
      if (f === 0) scan[i] = x;
      else if (f === 1) scan[i] = (x + a) & 255;
      else if (f === 2) scan[i] = (x + b) & 255;
      else if (f === 3) scan[i] = (x + ((a + b) >> 1)) & 255;
      else if (f === 4) scan[i] = (x + paeth(a, b, c)) & 255;
      else throw new Error(`Bộ lọc dòng PNG không hợp lệ: ${f}.`);
    }
    prev.set(scan);
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 255;
      const idx = x * channels;
      if (colorType === 6) {
        r = scan[idx]; g = scan[idx + 1]; b = scan[idx + 2]; a = scan[idx + 3];
      } else if (colorType === 2) {
        r = scan[idx]; g = scan[idx + 1]; b = scan[idx + 2];
      } else if (colorType === 3) {
        const pi = scan[idx];
        if (pi * 3 + 2 >= palette.length) throw new Error('Chỉ số bảng màu PNG vượt PLTE.');
        r = palette[pi * 3]; g = palette[pi * 3 + 1]; b = palette[pi * 3 + 2];
        a = pi < alpha.length ? alpha[pi] : 255;
      } else if (colorType === 0) {
        r = g = b = scan[idx];
      } else {
        r = g = b = scan[idx]; a = scan[idx + 1];
      }
      const outOffset = (y * w + x) * 4;
      rgbaBytes[outOffset] = r; rgbaBytes[outOffset + 1] = g; rgbaBytes[outOffset + 2] = b; rgbaBytes[outOffset + 3] = a;
      data[y * w + x] = (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
    }
  }
  return { w, h, data, rgbaBytes };
}
