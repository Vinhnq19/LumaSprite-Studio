export type ResourceKind = 'rgba' | 'mask' | 'tile-index';

export interface StudioResource {
  version: 1;
  kind: ResourceKind;
  w: number;
  h: number;
  blob?: string;
  data?: Uint32Array;
}

export interface ResourceRef {
  version?: 1;
  kind: ResourceKind;
  w: number;
  h: number;
  blob: string;
}

export const RESOURCE_VERSION = 1 as const;
export const RESOURCE_KINDS: readonly ResourceKind[] = ['rgba', 'mask', 'tile-index'] as const;
export const MAX_RESOURCE_ENTRIES = 1024;
export const MAX_RGBA_DIMENSION = 4096;
export const MAX_MASK_DIMENSION = 4096;
export const MAX_TILE_INDEX_DIMENSION = 32;
export const MAX_TOTAL_PIXELS = 16_777_216;

const RESERVED_RESOURCE_IDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'isPrototypeOf',
  'toString',
  'valueOf',
  'toLocaleString',
  'hasOwnProperty',
  'propertyIsEnumerable',
]);

const ALLOWED_RESOURCE_FIELDS = new Set(['version', 'kind', 'w', 'h', 'blob', 'data']);

export function isValidResourceId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 80 &&
    /^[A-Za-z0-9_-]+$/.test(id) &&
    !RESERVED_RESOURCE_IDS.has(id)
  );
}

export function validateResourceId(id: unknown): string {
  if (typeof id !== 'string') throw new Error('ID tài nguyên phải là chuỗi ký tự.');
  if (id.length < 1 || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`ID tài nguyên không hợp lệ: "${id}". Chỉ cho phép 1-80 ký tự ASCII chữ, số, gạch dưới, gạch nối.`);
  }
  if (RESERVED_RESOURCE_IDS.has(id)) {
    throw new Error(`ID tài nguyên không được dùng tên dự lưu: "${id}".`);
  }
  return id;
}

export function validateResourceRef(ref: unknown): asserts ref is ResourceRef {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error('Tham chiếu tài nguyên phải là đối tượng hợp lệ.');
  }
  const obj = ref as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) {
    throw new Error(`Phiên bản tài nguyên không hợp lệ: ${String(obj.version)}. Chỉ hỗ trợ phiên bản 1.`);
  }
  const kind = obj.kind;
  if (kind !== 'rgba' && kind !== 'mask' && kind !== 'tile-index') {
    throw new Error(`Loại tài nguyên không hợp lệ: "${String(kind)}".`);
  }
  const w = obj.w;
  const h = obj.h;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error('Kích thước tài nguyên (w, h) phải là số nguyên dương.');
  }
  const maxDim = kind === 'tile-index' ? MAX_TILE_INDEX_DIMENSION : MAX_RGBA_DIMENSION;
  if (w > maxDim || h > maxDim) {
    throw new Error(`Kích thước tài nguyên loại ${kind} vượt giới hạn tối đa ${maxDim}: ${w}x${h}.`);
  }
  const total = w * h;
  if (total > MAX_TOTAL_PIXELS || !Number.isSafeInteger(total)) {
    throw new Error(`Tổng số điểm ảnh vượt quá giới hạn an toàn (${MAX_TOTAL_PIXELS}): ${total}.`);
  }
  if (typeof obj.blob !== 'string' || !/^[a-f0-9]{64}$/.test(obj.blob)) {
    throw new Error('Blob digest phải là chuỗi 64 ký tự hex chữ thường SHA256.');
  }
}

export function validateResource(resource: unknown): asserts resource is StudioResource {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new Error('Tài nguyên phải là đối tượng hợp lệ.');
  }
  const obj = resource as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_RESOURCE_FIELDS.has(key)) {
      throw new Error(`Trường không hợp lệ trong tài nguyên: "${key}".`);
    }
  }

  if (obj.version !== 1) {
    throw new Error(`Phiên bản tài nguyên không hợp lệ: ${String(obj.version)}. Chỉ hỗ trợ phiên bản 1.`);
  }

  const kind = obj.kind;
  if (kind !== 'rgba' && kind !== 'mask' && kind !== 'tile-index') {
    throw new Error(`Loại tài nguyên không hợp lệ: "${String(kind)}".`);
  }

  const w = obj.w;
  const h = obj.h;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error('Kích thước tài nguyên (w, h) phải là số nguyên dương.');
  }

  const maxDim = kind === 'tile-index' ? MAX_TILE_INDEX_DIMENSION : MAX_RGBA_DIMENSION;
  if (w > maxDim || h > maxDim) {
    throw new Error(`Kích thước tài nguyên loại ${kind} vượt giới hạn tối đa ${maxDim}: ${w}x${h}.`);
  }

  const total = w * h;
  if (total > MAX_TOTAL_PIXELS || !Number.isSafeInteger(total)) {
    throw new Error(`Tổng số điểm ảnh vượt quá giới hạn an toàn (${MAX_TOTAL_PIXELS}): ${total}.`);
  }

  if (obj.blob === undefined && obj.data === undefined) {
    throw new Error('Tài nguyên phải có ít nhất blob hoặc data.');
  }

  if (obj.blob !== undefined) {
    if (typeof obj.blob !== 'string' || !/^[a-f0-9]{64}$/.test(obj.blob)) {
      throw new Error('Blob digest phải là chuỗi 64 ký tự hex chữ thường SHA256.');
    }
  }

  if (obj.data !== undefined) {
    if (!(obj.data instanceof Uint32Array)) {
      throw new Error('Dữ liệu tài nguyên phải là Uint32Array, không tự ép kiểu mảng thường.');
    }
    if (obj.data.length !== total) {
      throw new Error(`Độ dài Uint32Array (${obj.data.length}) không khớp kích thước w*h (${total}).`);
    }
    if (kind === 'mask') {
      for (let i = 0; i < obj.data.length; i++) {
        const val = obj.data[i];
        if (val !== 0 && val !== 1) {
          throw new Error(`Mặt nạ chỉ cho phép giá trị nhị phân 0 hoặc 1, phát hiện: ${val} tại vị trí ${i}.`);
        }
      }
    }
  }
}

export function validateResourceMap(map: unknown): asserts map is Record<string, StudioResource> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('Danh sách tài nguyên phải là đối tượng hợp lệ.');
  }
  const entries = Object.keys(map);
  if (entries.length > MAX_RESOURCE_ENTRIES) {
    throw new Error(`Số lượng tài nguyên vượt quá giới hạn ${MAX_RESOURCE_ENTRIES}: ${entries.length}.`);
  }
  const record = map as Record<string, unknown>;
  for (const id of entries) {
    validateResourceId(id);
    validateResource(record[id]);
  }
}

export function cloneResource(resource: StudioResource, cloneData = false): StudioResource {
  validateResource(resource);
  const out: StudioResource = {
    version: 1,
    kind: resource.kind,
    w: resource.w,
    h: resource.h,
  };
  if (resource.blob !== undefined) {
    out.blob = resource.blob;
  }
  if (resource.data !== undefined) {
    out.data = cloneData ? new Uint32Array(resource.data) : resource.data;
  }
  return out;
}

export function cloneResourceMap(
  map: Record<string, StudioResource>,
  cloneData = false
): Record<string, StudioResource> {
  validateResourceMap(map);
  const out: Record<string, StudioResource> = {};
  for (const [id, res] of Object.entries(map)) {
    out[id] = cloneResource(res, cloneData);
  }
  return out;
}

export function editResourceData(resource: StudioResource, nextData: Uint32Array): StudioResource {
  validateResource(resource);
  if (!(nextData instanceof Uint32Array)) {
    throw new Error('Dữ liệu mới phải là Uint32Array.');
  }
  const total = resource.w * resource.h;
  if (nextData.length !== total) {
    throw new Error(`Độ dài dữ liệu mới (${nextData.length}) không khớp kích thước w*h (${total}).`);
  }
  const ownBuffer = new Uint32Array(nextData);
  if (resource.kind === 'mask') {
    for (let i = 0; i < ownBuffer.length; i++) {
      const v = ownBuffer[i];
      if (v !== 0 && v !== 1) {
        throw new Error(`Mặt nạ chỉ cho phép giá trị 0 hoặc 1, phát hiện: ${v} tại vị trí ${i}.`);
      }
    }
  }
  return {
    version: 1,
    kind: resource.kind,
    w: resource.w,
    h: resource.h,
    data: ownBuffer,
  };
}

export function resourceBytes(data: Uint32Array): Uint8Array {
  const b = new Uint8Array(data.length * 4);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < data.length; i++) v.setUint32(i * 4, data[i], true);
  return b;
}

export function resourcePixels(data: Uint8Array): Uint32Array {
  if (data.byteLength % 4 !== 0) throw new Error('Dữ liệu không đủ byte Uint32.');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const p = new Uint32Array(data.byteLength / 4);
  for (let i = 0; i < p.length; i++) p[i] = v.getUint32(i * 4, true);
  return p;
}

export function wireStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (!(v instanceof Uint32Array)) return v;
    const b = resourceBytes(v);
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return { $rgba: btoa(s) };
  });
}

export function wireParse(value: string): any {
  return JSON.parse(value, (_, v) => {
    if (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$rgba === 'string') {
      const bin = atob(v.$rgba);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return resourcePixels(buf);
    }
    return v;
  });
}

export { resourceBytes as bytes, resourcePixels as pixels };
export { wireStringify as wireStringifyResource, wireParse as wireParseResource };
