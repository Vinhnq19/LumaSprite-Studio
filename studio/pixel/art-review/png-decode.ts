import { readStudioPng } from '../read-png.ts';

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint32Array;
  sha256: string;
  byteLength: number;
  fileName: string;
  rawBytes: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 32_000_000;

export async function sha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode a local PNG file into packed straight-alpha 0xRRGGBBAA Uint32Array
 * without mutating source bytes or applying color/alpha distortion.
 */
export async function decodeLocalPng(file: Blob, fileName: string): Promise<DecodedPng> {
  if (file.size > MAX_PNG_BYTES) {
    throw new Error(`Tệp "${fileName}" vượt giới hạn 64 MiB.`);
  }
  const rawBuffer = await file.arrayBuffer();
  const rawBytes = new Uint8Array(rawBuffer);
  if (rawBytes.length < 24 || !PNG_SIGNATURE.every((byte, idx) => rawBytes[idx] === byte)) {
    throw new Error(`Tệp "${fileName}" không phải ảnh PNG hợp lệ.`);
  }

  const view = new DataView(rawBuffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error(`PNG "${fileName}" có kích thước ${width}×${height} vượt giới hạn hỗ trợ.`);
  }

  const sha256 = await sha256Hex(rawBytes);
  const blob = new Blob([rawBytes], { type: 'image/png' });
  let rgba = await readStudioPng(blob, width, height);

  if (!rgba) {
    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Trình duyệt không tạo được 2D context để đọc PNG.');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height).data;
      const pixelView = new DataView(imageData.buffer, imageData.byteOffset, imageData.byteLength);
      rgba = Uint32Array.from({ length: width * height }, (_, index) => pixelView.getUint32(index * 4));
    } finally {
      bitmap.close();
    }
  }

  return {
    width,
    height,
    rgba,
    sha256,
    byteLength: rawBytes.length,
    fileName,
    rawBytes,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
