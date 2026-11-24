// Strict JSON-data primitives shared by versioned quality contracts.
const RESERVED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
export function invalidData(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
export function dataObject(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidData(path, 'phải là object thuần.');
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k)) || keys.some(k => !descriptors[k] || !('value' in descriptors[k]))) invalidData(path, 'thuộc tính thiếu hoặc không được hỗ trợ.');
  return value as Record<string, unknown>;
}
export function dataArray(value: unknown, min: number, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalidData(path, `phải là mảng từ ${min} đến ${max} phần tử.`);
  // Include non-enumerable/symbol properties and accessors: JSON arrays cannot carry them.
  if (Reflect.ownKeys(value).length !== value.length + 1) invalidData(path, 'mảng thưa hoặc có thuộc tính lạ.');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !('value' in d)) invalidData(path, 'mảng thưa hoặc có getter.');
  }
  return value;
}
export function dataNumber(value: unknown, min: number, max: number, path: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalidData(path, `số${integer ? ' nguyên' : ''} phải trong ${min}..${max}.`);
  return value;
}
export function dataId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value) || RESERVED.has(value)) invalidData(path, 'ID không hợp lệ.');
  return value;
}
export function dataName(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalidData(path, 'tên phải có 1–100 ký tự, không có ký tự điều khiển.');
  return value.trim();
}
export function dataBoolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') invalidData(path, 'phải là boolean.'); return value; }
export function dataUnique<T>(values: T[], path: string): T[] {
  if (new Set(values).size !== values.length) invalidData(path, 'phần tử trùng nhau.');
  return values;
}
