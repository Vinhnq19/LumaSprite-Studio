import type { ProjectDocument } from './types.ts';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validatePixels(doc: Pick<ProjectDocument, 'pixels'>): void {
  if (!object(doc.pixels)) throw new Error('Lớp pixel không hợp lệ.');
  for (const [name, layer] of Object.entries(doc.pixels)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name) || !object(layer) || typeof layer.enabled !== 'boolean' || !object(layer.layout) || !Array.isArray(layer.layout.durations) || !object(layer.frames)) throw new Error('Lớp pixel thiếu dữ liệu.');
    const { w, h, durations } = layer.layout;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > 16_777_216 || durations.length > 600 || durations.some((n: number) => !Number.isFinite(n) || n <= 0)) throw new Error('Kích thước hoặc timing lớp pixel không hợp lệ.');
    for (const [frame, pixels] of Object.entries(layer.frames)) {
      if (!/^\d+$/.test(frame) || +frame >= Math.max(1, durations.length) || !object(pixels)) throw new Error('Frame lớp pixel không hợp lệ.');
      for (const [index, color] of Object.entries(pixels)) if (!/^\d+$/.test(index) || +index >= w * h || !Number.isInteger(color) || color < 0 || color > 0xffffffff) throw new Error('Pixel không hợp lệ.');
    }
  }
}
export function validateMetadata(metadata: ProjectDocument['metadata']): void {
  if (!object(metadata)) throw new Error('Metadata cần là một object.');
  for (const value of Object.values(metadata)) {
    if (!object(value) || Object.keys(value).some(k => !['pivot', 'hitbox', 'events'].includes(k))) throw new Error('Metadata hỗ trợ pivot, hitbox và events.');
    if (value.pivot && (!object(value.pivot) || ![value.pivot.x, value.pivot.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1))) throw new Error('Pivot x/y nằm trong 0–1.');
    if (value.hitbox && (!object(value.hitbox) || ![value.hitbox.x, value.hitbox.y, value.hitbox.w, value.hitbox.h].every(Number.isFinite) || value.hitbox.w <= 0 || value.hitbox.h <= 0)) throw new Error('Hitbox cần x/y/w/h hữu hạn, w/h > 0.');
    if (value.events && (!Array.isArray(value.events) || value.events.length > 600 || value.events.some(e => !object(e) || !Number.isInteger(e.frame) || e.frame < 0 || e.frame > 599 || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 128))) throw new Error('Event cần frame 0–599 và tên không rỗng.');
  }
}
