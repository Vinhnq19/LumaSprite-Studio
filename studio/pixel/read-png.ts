const checksumTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ checksumTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function predictor(left: number, above: number, corner: number): number {
  const estimate = left + above - corner;
  const a = Math.abs(estimate - left), b = Math.abs(estimate - above), c = Math.abs(estimate - corner);
  return a <= b && a <= c ? left : b <= c ? above : corner;
}

/** Read straight-alpha pixels from the 8-bit PNG formats exported by Studio and RC02. */
export async function readStudioPng(file: Blob, width: number, height: number): Promise<Uint32Array | undefined> {
  const header = new Uint8Array(await file.slice(0, 33).arrayBuffer());
  const mode = header[25];
  if (header[24] !== 8 || header[28] !== 0 || (mode !== 3 && mode !== 6) || typeof DecompressionStream === 'undefined') return;
  if (header[26] !== 0 || header[27] !== 0) throw Error('PNG dùng kiểu nén hoặc bộ lọc không hợp lệ.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let palette: Uint8Array | undefined;
  let alpha: Uint8Array | undefined;
  let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length || view.getUint32(end) !== pngCrc(bytes.subarray(offset + 4, end))) throw Error('Chunk PNG hỏng hoặc bị cắt.');
    const type = view.getUint32(offset + 4), payload = bytes.subarray(offset + 8, end);
    if (offset === 8 && (type !== 0x49484452 || length !== 13)) throw Error('Thiếu IHDR hợp lệ.');
    if (type === 0x49444154) chunks.push(payload); // IDAT
    else if (type === 0x504c5445) palette = payload; // PLTE
    else if (type === 0x74524e53) alpha = payload; // tRNS
    else if (type === 0x49454e44) { ended = length === 0; break; } // IEND
    offset = end + 4;
  }
  if (!ended || !chunks.length) throw Error('PNG thiếu dữ liệu ảnh.');
  if (mode === 3 && (!palette?.length || palette.length > 768 || palette.length % 3 || (alpha?.length ?? 0) > palette.length / 3)) {
    throw Error('Bảng màu PNG không hợp lệ.');
  }

  const channels = mode === 3 ? 1 : 4;
  const stride = width * channels + 1;
  const raw = new Uint8Array(stride * height);
  const reader = new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let filled = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > raw.length - filled) throw Error('Dữ liệu giải nén PNG vượt kích thước canvas.');
      raw.set(value, filled);
      filled += value.length;
    }
  } finally {
    if (filled !== raw.length) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (filled !== raw.length) throw Error('Dữ liệu giải nén PNG thiếu pixel.');

  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    const start = y * stride + 1, filter = raw[start - 1];
    if (filter > 4) throw Error('Bộ lọc dòng PNG không hợp lệ.');
    if (filter) for (let x = 0; x < stride - 1; x++) {
      const at = start + x;
      const left = x < channels ? 0 : raw[at - channels];
      const above = y === 0 ? 0 : raw[at - stride];
      const corner = y === 0 || x < channels ? 0 : raw[at - stride - channels];
      raw[at] += filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >>> 1 : predictor(left, above, corner);
    }
    for (let x = 0; x < width; x++) {
      const at = start + x * channels;
      if (mode === 3) {
        const index = raw[at], rgb = 3 * index;
        if (rgb >= palette!.length) throw Error('Pixel PNG tham chiếu màu không có trong bảng.');
        pixels[y * width + x] = (palette![rgb] << 24) | (palette![rgb + 1] << 16) | (palette![rgb + 2] << 8) | (alpha?.[index] ?? 255);
      } else pixels[y * width + x] = (raw[at] << 24) | (raw[at + 1] << 16) | (raw[at + 2] << 8) | raw[at + 3];
    }
  }
  return pixels;
}
