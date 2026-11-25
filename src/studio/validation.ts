import type { AssetMetadata } from './types.ts';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateMetadata(metadata: Record<string, AssetMetadata>): void {
  if (!object(metadata)) throw new Error('Metadata cần là một object.');
  for (const value of Object.values(metadata)) {
    if (!object(value) || Object.keys(value).some(k => !['pivot', 'hitbox', 'events'].includes(k))) throw new Error('Metadata hỗ trợ pivot, hitbox và events.');
    if (value.pivot && (!object(value.pivot) || ![value.pivot.x, value.pivot.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1))) throw new Error('Pivot x/y nằm trong 0–1.');
    if (value.hitbox && (!object(value.hitbox) || ![value.hitbox.x, value.hitbox.y, value.hitbox.w, value.hitbox.h].every(Number.isFinite) || value.hitbox.w <= 0 || value.hitbox.h <= 0)) throw new Error('Hitbox cần x/y/w/h hữu hạn, w/h > 0.');
    if (value.events && (!Array.isArray(value.events) || value.events.length > 600 || value.events.some(e => !object(e) || !Number.isInteger(e.frame) || e.frame < 0 || e.frame > 599 || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 128))) throw new Error('Event cần frame 0–599 và tên không rỗng.');
  }
}
