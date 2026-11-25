/** Packed pixels use 0xRRGGBBAA on every platform. */
export class Img {
  readonly w: number;
  readonly h: number;
  readonly data: Uint32Array;

  constructor(width: number, height: number, pixels?: Uint32Array) {
    const count = width * height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !Number.isSafeInteger(count) || count > 67_108_864 || (pixels && pixels.length !== count)) {
      throw new RangeError('Invalid raster dimensions or pixel count.');
    }
    this.w = width;
    this.h = height;
    this.data = pixels ?? new Uint32Array(count);
  }

  get(x: number, y: number): number {
    return x >= 0 && x < this.w && y >= 0 && y < this.h ? this.data[y * this.w + x] ?? 0 : 0;
  }

  set(x: number, y: number, pixel: number): void {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.data[y * this.w + x] = pixel;
  }
}

export function pack(red: number, green: number, blue: number, alpha = 255): number {
  return ((red & 255) * 0x1000000 + (green & 255) * 0x10000 + (blue & 255) * 256 + (alpha & 255)) >>> 0;
}

export function channels(pixel: number): [number, number, number, number] {
  return [pixel >>> 24, pixel >>> 16 & 255, pixel >>> 8 & 255, pixel & 255];
}

export function luma8(pixel: number): number {
  const [r, g, b] = channels(pixel);
  return (54 * r + 183 * g + 19 * b + 128) >>> 8;
}

export function parseHex(text: string): number | undefined {
  const hex = text.replace(/^#/, '');
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return;
  const digits = hex.length <= 4 ? Array.from(hex, digit => digit.repeat(2)).join('') : hex;
  const rgba = Number.parseInt(digits.length === 6 ? digits + 'ff' : digits, 16);
  return rgba % 256 === 0 ? 0 : rgba;
}

export function toHex(rgba: number): string {
  const hex = (rgba >>> 0).toString(16).padStart(8, '0');
  return '#' + ((rgba & 255) === 255 ? hex.slice(0, 6) : hex);
}
