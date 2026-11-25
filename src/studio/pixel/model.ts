import { Img } from '../raster.ts';
import { pack, channels } from '../raster.ts';
import type { AssetMetadata } from '../types.ts';
import { validateMetadata } from '../validation.ts';
import { defaultPalette } from './palette.ts';
import { type StudioExtension, validateStudioExtension } from '../art-direction.ts';
import { type DesignManifest, validateDesignManifest } from '../design-manifest.ts';
import { type ClipGenerationContext, validateClipGenerationContext } from '../clip-generation.ts';
import type { RecordedAiProvider } from '../ai-providers.ts';

export interface BatchProvenanceConfig {
  target?: {
    w?: number;
    h?: number;
    name?: string;
    assetId?: string;
  };
  operation?: 'region-edit' | 'clip-regenerate';
  regionEdit?: {
    frameId?: string;
    duration?: number;
    anchor?: { x?: number; y?: number };
  };
  clip?: ClipGenerationContext;
  options?: {
    style?: string;
    view?: string;
    paletteMode?: string;
    reference?: boolean | string;
  };
  artDirection?: {
    style?: string;
    paletteMode?: string;
    palette?: number[];
    light?: string;
    detailLevel?: string;
    outline?: string;
    references?: { assetId: string; frameId: string; name?: string }[];
  };
}

export interface BatchProvenance {
  batchId?: string;
  candidateId?: string;
  provider?: RecordedAiProvider;
  transport?: 'cli' | 'http';
  model?: string;
  usage?: { input?: number; output?: number; cached?: number; unavailable?: boolean };
  prompt?: string;
  config?: BatchProvenanceConfig;
  manifest?: DesignManifest;
}

export interface Cel { id: string; data?: Uint32Array; blob?: string }
export interface PixelFrame { id: string; duration: number }
export interface PixelLayer {
  id: string; name: string; type: 'image' | 'group'; parent?: string;
  visible: boolean; locked: boolean; opacity: number; cels: Record<string, string>;
}
export interface AnimationTag { id: string; name: string; from: string; to: string; direction: 'forward' | 'reverse' | 'ping-pong'; loop: boolean }
export interface PixelAsset {
  id: string; name: string; w: number; h: number; palette: number[];
  layers: PixelLayer[]; frames: PixelFrame[]; cels: Record<string, Cel>;
  tags: AnimationTag[]; metadata: AssetMetadata; source?: { files: Record<string, string>; entry: string };
  provenance?: {
    kind: 'normalized' | 'protected' | 'reference' | 'generated';
    originalSource?: { files: Record<string, string>; entry: string };
    palette?: number[];
    alphaThreshold?: number;
    reference?: { assetId: string; frameId: string; revision: number; mode: 'region' | 'whole'; anchor: { x: number; y: number } };
    batch?: BatchProvenance;
  };
}
export interface PixelDocument { schemaVersion: 2; kind: 'pixel'; id: string; name: string; revision: number; assets: PixelAsset[]; studio?: StudioExtension }
export const uid = () => crypto.randomUUID();
export const presets = [16, 18, 24, 32, 48, 64, 128, 256];
export function dimensions(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) throw new Error('Kích thước phải là số nguyên từ 1 đến 4096 px.');
}
export function newLayer(name = 'Layer 1', type: PixelLayer['type'] = 'image', parent?: string): PixelLayer {
  return { id: uid(), name, type, ...(parent ? { parent } : {}), visible: true, locked: false, opacity: 255, cels: {} };
}
export function newAsset(name: string, w = 32, h = 32, background = 0): PixelAsset {
  dimensions(w, h);
  const frame = { id: uid(), duration: 100 }, layer = newLayer();
  const a: PixelAsset = { id: uid(), name, w, h, palette: [...defaultPalette], layers: [layer], frames: [frame], cels: {}, tags: [], metadata: {} };
  if (background) celFor(a, layer.id, frame.id, true)!.data!.fill(background);
  return a;
}
export function newDocument(name: string, w = 32, h = 32, background = 0): PixelDocument {
  return { schemaVersion: 2, kind: 'pixel', id: uid(), name, revision: 1, assets: [newAsset('Sprite', w, h, background)] };
}
export function celFor(a: PixelAsset, layerId: string, frameId: string, create = false): Cel | undefined {
  const layer = a.layers.find(l => l.id === layerId);
  if (!layer || layer.type !== 'image' || !a.frames.some(f => f.id === frameId)) return;
  const id = layer.cels[frameId];
  if (id) return a.cels[id];
  if (!create) return;
  if ((Object.keys(a.cels).length + 1) * a.w * a.h > 32_000_000) throw new Error('Asset vượt ngân sách 32 triệu pixel cel.');
  const cel: Cel = { id: uid(), data: new Uint32Array(a.w * a.h) }; a.cels[cel.id] = cel; layer.cels[frameId] = cel.id; return cel;
}
export function isLocked(a: PixelAsset, layer: PixelLayer): boolean {
  let current: PixelLayer | undefined = layer;
  while (current) { if (current.locked) return true; current = a.layers.find(l => l.id === current!.parent); }
  return false;
}
export function over(dst: number, src: number, opacity = 255): number {
  const sa = (src & 255) * opacity / 65025, da = (dst & 255) / 255, alpha = sa + da * (1 - sa);
  if (!alpha) return 0;
  const s = channels(src), d = channels(dst);
  return pack(...[0, 1, 2].map(i => Math.round((s[i] * sa + d[i] * da * (1 - sa)) / alpha)) as [number, number, number], Math.round(alpha * 255));
}
export function composite(a: PixelAsset, frameId: string): Img {
  const render = (parent?: string): Img => {
    const out = new Img(a.w, a.h);
    for (const l of a.layers.filter(l => l.parent === parent)) {
      if (!l.visible) continue;
      const data = l.type === 'group' ? render(l.id).data : celFor(a, l.id, frameId)?.data;
      if (!data) continue;
      for (let i = 0; i < data.length; i++) if (data[i] & 255) out.data[i] = over(out.data[i], data[i], l.opacity);
    }
    return out;
  };
  return render();
}
export function playbackTag(a:PixelAsset,tagId?:string):AnimationTag|undefined { return a.tags.find(t=>t.id===tagId)??(!tagId&&a.provenance?a.tags[0]:undefined); }
export function playback(a: PixelAsset, tagId?: string): { frame: PixelFrame; index: number }[] {
  const tag = playbackTag(a,tagId);
  let list = a.frames.map((frame, index) => ({ frame, index }));
  if (!tag) return list;
  const i = a.frames.findIndex(f => f.id === tag.from), j = a.frames.findIndex(f => f.id === tag.to);
  list = list.slice(Math.min(i, j), Math.max(i, j) + 1);
  if (tag.direction === 'reverse') list.reverse();
  if (tag.direction === 'ping-pong' && list.length > 2) list = [...list, ...list.slice(1, -1).reverse()];
  return list;
}
export function collectCels(a: PixelAsset): void {
  const used = new Set(a.layers.flatMap(l => Object.values(l.cels)));
  for (const id of Object.keys(a.cels)) if (!used.has(id)) delete a.cels[id];
}
export function duplicateFrame(a: PixelAsset, frameId: string, mode: 'blank' | 'copy' | 'linked'): string {
  if (a.frames.length >= 600) throw new Error('Tối đa 600 frame.');
  const index = a.frames.findIndex(f => f.id === frameId), f = { id: uid(), duration: mode === 'blank' ? 100 : a.frames[index]?.duration ?? 100 };
  const events = a.metadata.events?.map(e => ({ frameId: a.frames[e.frame]?.id, name: e.name }));
  a.frames.splice(index + 1, 0, f);
  const copies = new Map<string, string>();
  for (const l of a.layers) {
    const id = l.cels[frameId]; if (!id || mode === 'blank') continue;
    if (mode === 'linked') { l.cels[f.id] = id; continue; }
    if (!copies.has(id)) { const original = a.cels[id]; if (!original.data) throw new Error('Cel chưa tải.'); const copy = { id: uid(), data: original.data.slice() }; a.cels[copy.id] = copy; copies.set(id, copy.id); }
    l.cels[f.id] = copies.get(id)!;
  }
  if (events) a.metadata.events = events.flatMap(e => [{ frame: a.frames.findIndex(k => k.id === e.frameId), name: e.name }, ...(mode !== 'blank' && e.frameId === frameId ? [{ frame: index + 1, name: e.name }] : [])]);
  validateAsset(a); return f.id;
}
export function deleteFrames(a: PixelAsset, ids: string[]): void {
  const keep = a.frames.filter(f => !ids.includes(f.id)); if (!keep.length) throw new Error('Cần giữ ít nhất một frame.');
  for (const tag of [...a.tags]) {
    const start = a.frames.findIndex(f => f.id === tag.from), end = a.frames.findIndex(f => f.id === tag.to);
    const remaining = a.frames.slice(Math.min(start, end), Math.max(start, end) + 1).filter(f => !ids.includes(f.id));
    if (!remaining.length) a.tags = a.tags.filter(t => t !== tag);
    else { tag.from = remaining[0].id; tag.to = remaining.at(-1)!.id; }
  }
  const events = a.metadata.events?.flatMap(e => { const f = a.frames[e.frame]; const i = keep.findIndex(k => k.id === f?.id); return i < 0 ? [] : [{ ...e, frame: i }]; });
  if (events) a.metadata.events = events;
  a.frames = keep; for (const l of a.layers) for (const id of ids) delete l.cels[id]; collectCels(a);
}
export function unlinkCel(a: PixelAsset, layerId: string, frameId: string): void {
  const c = celFor(a, layerId, frameId); if (!c) return; if (!c.data) throw new Error('Cel chưa tải.');
  const id = uid(); a.cels[id] = { id, data: c.data.slice() }; a.layers.find(l => l.id === layerId)!.cels[frameId] = id; collectCels(a);
}
export function resizeAsset(a: PixelAsset, w: number, h: number, mode: 'canvas' | 'scale', anchorX = .5, anchorY = .5): void {
  dimensions(w, h);
  if (w * h * Object.keys(a.cels).length > 32_000_000) throw new Error('Kích thước mới vượt 32 triệu pixel cel.');
  const oldW = a.w, oldH = a.h, dx = Math.floor((w - oldW) * anchorX), dy = Math.floor((h - oldH) * anchorY);
  const updates: Record<string, Uint32Array> = {};
  for (const c of Object.values(a.cels)) {
    if (!c.data) throw new Error('Cần tải cel trước khi đổi kích thước.');
    const next = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ox = mode === 'scale' ? Math.floor(x * oldW / w) : x - dx, oy = mode === 'scale' ? Math.floor(y * oldH / h) : y - dy;
      if (ox >= 0 && ox < oldW && oy >= 0 && oy < oldH) next[y * w + x] = c.data[oy * oldW + ox];
    }
    updates[c.id] = next;
  }
  for (const [id, data] of Object.entries(updates)) { a.cels[id].data = data; delete a.cels[id].blob; }
  if (mode === 'canvas' && a.metadata.pivot) { const p = a.metadata.pivot; p.x = Math.max(0, Math.min(1, (p.x * oldW + dx) / w)); p.y = Math.max(0, Math.min(1, (p.y * oldH + dy) / h)); }
  if (a.metadata.hitbox) {
    const b = a.metadata.hitbox;
    if (mode === 'scale') { b.x *= w / oldW; b.y *= h / oldH; b.w *= w / oldW; b.h *= h / oldH; }
    else { b.x += dx; b.y += dy; }
  }
  a.w = w; a.h = h;
}
export function mergeDown(a: PixelAsset, layerId: string): void {
  const index = a.layers.findIndex(l => l.id === layerId), top = a.layers[index];
  const bottom = a.layers.slice(0, index).findLast(l => l.parent === top.parent);
  if (!bottom || top.type !== 'image' || bottom.type !== 'image' || isLocked(a, top) || isLocked(a, bottom)) throw new Error('Chọn hai layer ảnh không khóa để gộp.');
  if (!top.visible || !bottom.visible) throw new Error('Bật hiển thị cả hai layer trước khi gộp.');
  const pairs = new Map<string, string>();
  for (const f of a.frames) {
    const pair = `${bottom.cels[f.id] ?? ''}:${top.cels[f.id] ?? ''}`;
    if (pair === ':') { delete bottom.cels[f.id]; continue; }
    if (pairs.has(pair)) { bottom.cels[f.id] = pairs.get(pair)!; continue; }
    const d = celFor(a, bottom.id, f.id)?.data, s = celFor(a, top.id, f.id)?.data, data = new Uint32Array(a.w * a.h);
    for (let i = 0; i < data.length; i++) data[i] = over(over(0, d?.[i] ?? 0, bottom.opacity), s?.[i] ?? 0, top.opacity);
    const id = uid(); a.cels[id] = { id, data }; bottom.cels[f.id] = id; pairs.set(pair, id);
  }
  bottom.opacity = 255; a.layers.splice(index, 1); collectCels(a); validateAsset(a);
}
const idOK = (s: unknown) => typeof s === 'string' && /^[\w-]{1,80}$/.test(s) && !['__proto__', 'prototype', 'constructor'].includes(s);
export function validateBatchProvenance(value: unknown, canvasW?: number, canvasH?: number): BatchProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Batch provenance phải là một object.');
  }
  const v = value as Record<string, unknown>;
  const allowed = ['batchId', 'candidateId', 'provider', 'transport', 'model', 'usage', 'prompt', 'config', 'manifest'];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
      throw new Error(`Thuộc tính batch provenance '${k}' không được hỗ trợ.`);
    }
  }
  if (v.batchId !== undefined && (!idOK(v.batchId) || typeof v.batchId !== 'string')) {
    throw new Error('Mã batchId trong provenance không hợp lệ.');
  }
  if (v.candidateId !== undefined && (!idOK(v.candidateId) || typeof v.candidateId !== 'string')) {
    throw new Error('Mã candidateId trong provenance không hợp lệ.');
  }
  if (v.provider !== undefined && !['codex', 'deepseek', 'antigravity'].includes(v.provider as string)) {
    throw new Error('Provider trong provenance không hợp lệ.');
  }
  if (v.transport !== undefined && v.transport !== 'cli' && v.transport !== 'http') {
    throw new Error('transport trong provenance không hợp lệ.');
  }
  if (v.model !== undefined && (typeof v.model !== 'string' || !/^[\x20-\x7e]{1,200}$/.test(v.model))) {
    throw new Error('model trong provenance không hợp lệ (1–200 ký tự ASCII in được).');
  }
  if (v.usage !== undefined) {
    if (!v.usage || typeof v.usage !== 'object' || Array.isArray(v.usage)) {
      throw new Error('usage trong provenance phải là object.');
    }
    if (Object.getPrototypeOf(v.usage) !== Object.prototype && Object.getPrototypeOf(v.usage) !== null) {
      throw new Error('usage trong provenance phải là object thuần.');
    }
    const usage = v.usage as Record<string, unknown>;
    const allowedUsageKeys = ['input', 'output', 'cached', 'unavailable'];
    for (const k of Object.keys(usage)) {
      if (!allowedUsageKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
        throw new Error(`Thuộc tính usage '${k}' không được hỗ trợ.`);
      }
    }
    for (const key of ['input', 'output', 'cached'] as const) {
      const n = usage[key];
      if (n !== undefined && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) {
        throw new Error(`usage.${key} trong provenance phải là số nguyên không âm an toàn.`);
      }
    }
    if (usage.unavailable !== undefined && typeof usage.unavailable !== 'boolean') {
      throw new Error('usage.unavailable trong provenance phải là boolean.');
    }
  }
  if (v.prompt !== undefined && (typeof v.prompt !== 'string' || v.prompt.length > 12000)) {
    throw new Error('Prompt trong provenance không hợp lệ (tối đa 12.000 ký tự).');
  }
  if (v.config !== undefined) {
    if (!v.config || typeof v.config !== 'object' || Array.isArray(v.config)) {
      throw new Error('Cấu hình batch provenance phải là một object.');
    }
    const cfg = v.config as Record<string, unknown>;
    const allowedConfigKeys = ['target', 'options', 'artDirection', 'operation', 'regionEdit', 'clip'];
    for (const k of Object.keys(cfg)) {
      if (!allowedConfigKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
        throw new Error(`Thuộc tính cấu hình batch provenance '${k}' không được hỗ trợ.`);
      }
    }

    if (cfg.operation !== undefined && cfg.operation !== 'region-edit' && cfg.operation !== 'clip-regenerate') {
      throw new Error('operation trong cấu hình provenance không hợp lệ.');
    }

    if (cfg.operation === 'region-edit' && cfg.regionEdit === undefined) {
      throw new Error('Cấu hình provenance cho region-edit cần có regionEdit.');
    }

    if (cfg.operation === 'region-edit' && cfg.clip !== undefined) {
      throw new Error('Cấu hình provenance cho region-edit không thể có clip.');
    }

    if (cfg.operation === 'clip-regenerate') {
      if (cfg.clip === undefined) {
        throw new Error('Cấu hình provenance cho clip-regenerate cần có clip.');
      }
      if (cfg.regionEdit !== undefined) {
        throw new Error('Cấu hình provenance cho clip-regenerate không thể có regionEdit.');
      }
    }

    if (cfg.clip !== undefined) {
      try {
        validateClipGenerationContext(cfg.clip);
      } catch (err) {
        throw new Error(`clip trong provenance không hợp lệ: ${(err as Error).message}`);
      }
    }

    if (cfg.regionEdit !== undefined) {
      if (!cfg.regionEdit || typeof cfg.regionEdit !== 'object' || Array.isArray(cfg.regionEdit)) {
        throw new Error('regionEdit trong cấu hình provenance phải là object.');
      }
      const re = cfg.regionEdit as Record<string, unknown>;
      const allowedReKeys = ['frameId', 'duration', 'anchor'];
      for (const k of Object.keys(re)) {
        if (!allowedReKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
          throw new Error(`Thuộc tính regionEdit '${k}' không được hỗ trợ.`);
        }
      }
      if (typeof re.frameId !== 'string' || !idOK(re.frameId)) {
        throw new Error('regionEdit.frameId trong provenance không hợp lệ.');
      }
      if (!Number.isInteger(re.duration) || (re.duration as number) < 1 || (re.duration as number) > 60000) {
        throw new Error('regionEdit.duration trong provenance phải là số nguyên 1..60000 ms.');
      }
      if (!re.anchor || typeof re.anchor !== 'object' || Array.isArray(re.anchor)) {
        throw new Error('regionEdit.anchor trong provenance phải là object.');
      }
      const anc = re.anchor as Record<string, unknown>;
      const allowedAncKeys = ['x', 'y'];
      for (const k of Object.keys(anc)) {
        if (!allowedAncKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
          throw new Error(`Thuộc tính anchor '${k}' không được hỗ trợ.`);
        }
      }
      if (typeof anc.x !== 'number' || !Number.isFinite(anc.x) || typeof anc.y !== 'number' || !Number.isFinite(anc.y)) {
        throw new Error('regionEdit.anchor tọa độ phải là số hữu hạn.');
      }
      const targetW = typeof (cfg.target as any)?.w === 'number' ? (cfg.target as any).w : canvasW;
      const targetH = typeof (cfg.target as any)?.h === 'number' ? (cfg.target as any).h : canvasH;
      if (typeof targetW === 'number' && (anc.x < 0 || anc.x > targetW)) {
        throw new Error('regionEdit.anchor.x nằm ngoài kích thước canvas.');
      }
      if (typeof targetH === 'number' && (anc.y < 0 || anc.y > targetH)) {
        throw new Error('regionEdit.anchor.y nằm ngoài kích thước canvas.');
      }
    }

    if (cfg.target !== undefined) {
      if (!cfg.target || typeof cfg.target !== 'object' || Array.isArray(cfg.target)) {
        throw new Error('target trong cấu hình provenance phải là object.');
      }
      const tgt = cfg.target as Record<string, unknown>;
      const allowedTargetKeys = ['w', 'h', 'name', 'assetId'];
      for (const k of Object.keys(tgt)) {
        if (!allowedTargetKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
          throw new Error(`Thuộc tính target '${k}' không được hỗ trợ.`);
        }
      }
      if (tgt.w !== undefined && (!Number.isInteger(tgt.w) || (tgt.w as number) < 1 || (tgt.w as number) > 4096)) {
        throw new Error('target.w trong provenance phải là số nguyên 1..4096.');
      }
      if (tgt.h !== undefined && (!Number.isInteger(tgt.h) || (tgt.h as number) < 1 || (tgt.h as number) > 4096)) {
        throw new Error('target.h trong provenance phải là số nguyên 1..4096.');
      }
      if (tgt.name !== undefined && (typeof tgt.name !== 'string' || !tgt.name.trim() || tgt.name.length > 100)) {
        throw new Error('target.name trong provenance không hợp lệ.');
      }
      if (tgt.assetId !== undefined && (!idOK(tgt.assetId) || typeof tgt.assetId !== 'string')) {
        throw new Error('target.assetId trong provenance không hợp lệ.');
      }
    }

    if (cfg.options !== undefined) {
      if (!cfg.options || typeof cfg.options !== 'object' || Array.isArray(cfg.options)) {
        throw new Error('options trong cấu hình provenance phải là object.');
      }
      const opt = cfg.options as Record<string, unknown>;
      const allowedOptKeys = ['style', 'view', 'paletteMode', 'reference'];
      for (const k of Object.keys(opt)) {
        if (!allowedOptKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
          throw new Error(`Thuộc tính options '${k}' không được hỗ trợ.`);
        }
      }
      if (opt.style !== undefined && (typeof opt.style !== 'string' || !['game', 'eight-bit', 'flat-icon'].includes(opt.style as string))) {
        throw new Error('options.style trong provenance không hợp lệ.');
      }
      if (opt.view !== undefined && (typeof opt.view !== 'string' || !['description', 'front', 'side', 'top-down'].includes(opt.view as string))) {
        throw new Error('options.view trong provenance không hợp lệ.');
      }
      if (opt.paletteMode !== undefined && (typeof opt.paletteMode !== 'string' || !['asset', 'auto16'].includes(opt.paletteMode as string))) {
        throw new Error('options.paletteMode trong provenance không hợp lệ.');
      }
      if (opt.reference !== undefined && typeof opt.reference !== 'boolean') {
        throw new Error('options.reference trong provenance phải là boolean.');
      }
    }

    if (cfg.artDirection !== undefined) {
      if (!cfg.artDirection || typeof cfg.artDirection !== 'object' || Array.isArray(cfg.artDirection)) {
        throw new Error('artDirection trong cấu hình provenance phải là object.');
      }
      const ad = cfg.artDirection as Record<string, unknown>;
      const allowedAdKeys = ['style', 'paletteMode', 'palette', 'light', 'detailLevel', 'outline', 'references'];
      for (const k of Object.keys(ad)) {
        if (!allowedAdKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
          throw new Error(`Thuộc tính artDirection '${k}' không được hỗ trợ.`);
        }
      }
      if (ad.style !== undefined && (typeof ad.style !== 'string' || !['game', 'eight-bit', 'flat-icon'].includes(ad.style as string))) {
        throw new Error('artDirection.style trong provenance không hợp lệ.');
      }
      if (ad.paletteMode !== undefined && (typeof ad.paletteMode !== 'string' || !['asset', 'auto16'].includes(ad.paletteMode as string))) {
        throw new Error('artDirection.paletteMode trong provenance không hợp lệ.');
      }
      if (ad.palette !== undefined) {
        if (!Array.isArray(ad.palette) || ad.palette.length > 4096 || ad.palette.some(c => !Number.isInteger(c) || c < 0 || c > 0xffffffff)) {
          throw new Error('artDirection.palette trong provenance không hợp lệ.');
        }
      }
      if (ad.light !== undefined && (typeof ad.light !== 'string' || !ad.light.trim() || ad.light.length > 50)) {
        throw new Error('artDirection.light trong provenance không hợp lệ.');
      }
      if (ad.detailLevel !== undefined && (typeof ad.detailLevel !== 'string' || !['low', 'medium', 'high'].includes(ad.detailLevel as string))) {
        throw new Error('artDirection.detailLevel trong provenance không hợp lệ.');
      }
      if (ad.outline !== undefined && (typeof ad.outline !== 'string' || !ad.outline.trim() || ad.outline.length > 50)) {
        throw new Error('artDirection.outline trong provenance không hợp lệ.');
      }
      if (ad.references !== undefined) {
        if (!Array.isArray(ad.references) || ad.references.length > 3) {
          throw new Error('artDirection.references trong provenance phải là mảng tối đa 3 tham chiếu.');
        }
        for (const r of ad.references) {
          if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Tham chiếu phải là object.');
          const ref = r as Record<string, unknown>;
          const allowedRefKeys = ['assetId', 'frameId', 'name'];
          for (const k of Object.keys(ref)) {
            if (!allowedRefKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
              throw new Error(`Thuộc tính tham chiếu '${k}' không được hỗ trợ.`);
            }
          }
          if (typeof ref.assetId !== 'string' || !idOK(ref.assetId) || typeof ref.frameId !== 'string' || !idOK(ref.frameId)) {
            throw new Error('ID trong tham chiếu provenance không hợp lệ.');
          }
          if (ref.name !== undefined && (typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 100)) {
            throw new Error('Tên trong tham chiếu provenance không hợp lệ.');
          }
        }
      }
    }
  }
  if (v.manifest !== undefined) {
    const res = validateDesignManifest(v.manifest, canvasW, canvasH);
    if (!res.valid) {
      throw new Error(`Design manifest trong provenance không hợp lệ: ${res.errors.join('; ')}`);
    }
  }
  return v as BatchProvenance;
}
export function validateAsset(a: PixelAsset): void {
  dimensions(a.w, a.h);
  if (!idOK(a.id) || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 100) throw new Error('Tên/ID asset không hợp lệ.');
  if (!Array.isArray(a.frames) || !a.frames.length || a.frames.length > 600 || !Array.isArray(a.layers) || !a.layers.length || a.layers.length > 256) throw new Error('Asset cần 1–600 frame, 1–256 layer.');
  const unique = (ids: string[]) => ids.every(idOK) && new Set(ids).size === ids.length;
  if (!unique(a.frames.map(f => f.id)) || !unique(a.layers.map(l => l.id)) || !unique(Object.keys(a.cels))) throw new Error('ID bị trùng hoặc không hợp lệ.');
  if (Object.keys(a.cels).length * a.w * a.h > 32_000_000) throw new Error('Asset vượt ngân sách 32 triệu pixel cel.');
  for (const f of a.frames) if (!Number.isInteger(f.duration) || f.duration < 1 || f.duration > 60000) throw new Error('Duration cần 1–60000 ms.');
  for (const l of a.layers) {
    if (!['image', 'group'].includes(l.type) || typeof l.name !== 'string' || !l.name.trim() || l.name.length > 100 || typeof l.visible !== 'boolean' || typeof l.locked !== 'boolean' || !Number.isInteger(l.opacity) || l.opacity < 0 || l.opacity > 255) throw new Error('Thuộc tính layer không hợp lệ.');
    const visited = new Set([l.id]); let parent = l.parent;
    while (parent) { const group = a.layers.find(g => g.id === parent && g.type === 'group'); if (!group || visited.has(parent)) throw new Error('Nhóm layer có chu kỳ hoặc không tồn tại.'); visited.add(parent); parent = group.parent; }
    for (const [f, c] of Object.entries(l.cels)) if (l.type === 'group' || !a.frames.some(k => k.id === f) || !Object.hasOwn(a.cels, c)) throw new Error('Cel trỏ sai frame/layer.');
  }
  for (const [id, c] of Object.entries(a.cels)) if (c.id !== id || c.data && (!(c.data instanceof Uint32Array) || c.data.length !== a.w * a.h) || !c.data && !/^[a-f0-9]{64}$/.test(c.blob ?? '')) throw new Error('Dữ liệu cel không hợp lệ.');
  if (!Array.isArray(a.palette) || a.palette.length > 4096 || a.palette.some(c => !Number.isInteger(c) || c < 0 || c > 0xffffffff)) throw new Error('Palette không hợp lệ.');
  if (!Array.isArray(a.tags) || a.tags.length > 600 || !unique(a.tags.map(t => t.id))) throw new Error('Tag không hợp lệ.');
  for (const t of a.tags) if (!a.frames.some(f => f.id === t.from) || !a.frames.some(f => f.id === t.to) || !['forward', 'reverse', 'ping-pong'].includes(t.direction) || typeof t.loop !== 'boolean' || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 100) throw new Error('Tag không hợp lệ.');
  if (a.metadata.events?.some(e => e.frame >= a.frames.length)) throw new Error('Event trỏ tới frame không tồn tại.');
  validateMetadata({ [a.id]: a.metadata });
  if (a.provenance?.batch !== undefined) {
    const targetW = a.provenance.batch.config?.target?.w;
    const targetH = a.provenance.batch.config?.target?.h;
    const manifestW = Number.isInteger(targetW) && (targetW as number) >= 1 && (targetW as number) <= 4096 ? (targetW as number) : a.w;
    const manifestH = Number.isInteger(targetH) && (targetH as number) >= 1 && (targetH as number) <= 4096 ? (targetH as number) : a.h;
    validateBatchProvenance(a.provenance.batch, manifestW, manifestH);
  }
}
export function validateDocument(d: PixelDocument): void {
  if (d.schemaVersion !== 2 || d.kind !== 'pixel' || !idOK(d.id) || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 100 || !Number.isInteger(d.revision) || d.revision < 1 || !Array.isArray(d.assets) || !d.assets.length || d.assets.length > 100 || new Set(d.assets.map(a => a.id)).size !== d.assets.length) throw new Error('Tài liệu pixel v2 không hợp lệ.');
  for (const a of d.assets) validateAsset(a);
  if (d.studio !== undefined) validateStudioExtension(d.studio, d);
}

// Explicit little-endian bytes keep project blobs portable across host architectures.
export function bytes(data: Uint32Array): Uint8Array { const b = new Uint8Array(data.length * 4), v = new DataView(b.buffer); for (let i = 0; i < data.length; i++) v.setUint32(i * 4, data[i], true); return b; }
export function pixels(data: Uint8Array): Uint32Array { if (data.byteLength % 4) throw new Error('RGBA thiếu byte.'); const v = new DataView(data.buffer, data.byteOffset, data.byteLength), p = new Uint32Array(data.byteLength / 4); for (let i = 0; i < p.length; i++) p[i] = v.getUint32(i * 4, true); return p; }
export function wireStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (!(v instanceof Uint32Array)) return v;
    const b = bytes(v); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return { $rgba: btoa(s) };
  });
}
export function wireParse(value: string): any { return JSON.parse(value, (_, v) => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$rgba === 'string' ? pixels(Uint8Array.from(atob(v.$rgba), c => c.charCodeAt(0))) : v); }
