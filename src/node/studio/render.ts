import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectGeneration } from '../../studio/generation.ts';
import type { BuildSummary, Layout, Picture, ProjectDocument, GenerationContext } from '../../studio/types.ts';
import { Img } from '../../core/image.ts';
import type { Timeline } from '../../core/model.ts';
import { frameAt } from '../../core/build.ts';
import { loadProject } from '../load.ts';
import { writeOutputs } from '../output.ts';
import { encodePng } from '../png.ts';
import { encodeGif } from '../gif.ts';
import { normalizeFrames, packSheet, sheetJson, type FrameTag } from '../../core/render.ts';
import { safePath, validateFiles } from './store.ts';
import { zipFiles } from './zip.ts';
import { validatePixels, validateMetadata } from '../../studio/validation.ts';
import { newAsset, newLayer, uid, wireStringify } from '../../studio/pixel/model.ts';
export { validatePixels } from '../../studio/validation.ts';

export interface RenderRequest {
  document: ProjectDocument; mode: 'summary' | 'frame' | 'export' | 'atlas' | 'raster' | 'generation-preview'; name?: string; frame?: number; sheet?: string;
  generation?: GenerationContext; trace?: boolean; traceStep?: number; format?: 'png' | 'gif' | 'strip' | 'atlas' | 'zip'; selected?: string[];
  /** AI validation must execute every frame before declaring its code ready. */
  validateFrames?: boolean;
  /** Preflight provider-supplied source before creating or evaluating the PXL VM. */
  validateSource?: boolean;
}
export interface ExportResult { data: Uint8Array; mime: string; filename: string }
export function layoutOf(img: Img, tl?: Timeline): Layout {
  const durations = tl ? tl.durations ?? Array.from({ length: Math.round(tl.loop / tl.step) }, () => tl.step) : [];
  if (durations.length > 600) throw new Error('Animation vượt giới hạn 600 frame. Dùng timing tương thích.');
  return { w: img.w, h: img.h, durations };
}
const rgba = (img: Img) => Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString('base64');
const compatible = (a: Layout, b: Layout) => a.w === b.w && a.h === b.h && JSON.stringify(a.durations) === JSON.stringify(b.durations);
function filesUnder(root: string, prefix = ''): { path: string; data: Buffer }[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(d => d.isDirectory() ? filesUnder(join(root, d.name), prefix + d.name + '/') : [{ path: prefix + d.name, data: readFileSync(join(root, d.name)) }]);
}
export function renderDocument(request: RenderRequest): BuildSummary | Picture | ExportResult {
  const start = performance.now(), doc = request.document;
  validateFiles(doc.files, doc.entry); validatePixels(doc); validateMetadata(doc.metadata);
  const dir = mkdtempSync(join(tmpdir(), 'pxl-studio-render-'));
  try {
    for (const [path, source] of Object.entries(doc.files)) { const file = safePath(dir, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); }
    const base = loadProject(join(dir, doc.entry), { includeRoot: dir });
    const layouts = new Map<string, Layout>(), conflicts: string[] = [];
    const namesToInspect = request.mode === 'frame' && request.name ? [...new Set([request.name, ...Object.keys(doc.pixels)])].filter(n => base.assets.has(n)) : base.order;
    const assets = namesToInspect.map(name => {
      const def = base.assets.get(name)!;
      try {
        if (/[/\\:\x00-\x1f]/.test(name) || ['__proto__', 'prototype', 'constructor', '.', '..'].includes(name)) throw new Error('Tên asset không an toàn để xuất file.');
        const b = base.build(name), normalized = b.anim ? normalizeFrames([{ img: b.img }])[0].img : b.img, layout = layoutOf(normalized, b.anim); layouts.set(name, layout);
        return { name, kind: def.kind, ...layout, loop: !b.anim?.once, palette: def.pal.table() };
      } catch (e) { return { name, kind: def.kind, w: 0, h: 0, durations: [], loop: true, palette: def.pal.table(), error: String((e as Error).message) }; }
    });
    if (base.sheets.some(s => /[/\\:\x00-\x1f]/.test(s.name) || ['.', '..'].includes(s.name))) throw new Error('Tên atlas không an toàn để xuất file.');
    for (const [name, layer] of Object.entries(doc.pixels)) if (layer.enabled && (!layouts.has(name) || !compatible(layer.layout, layouts.get(name)!))) conflicts.push(name);
    for (const a of assets) {
      const events = doc.metadata[a.name]?.events ?? [];
      if (events.some(e => e.frame >= Math.max(1, a.durations.length))) a.error = 'Metadata event trỏ tới frame không tồn tại.';
      if (a.w * a.h * Math.max(1, a.durations.length) > 32_000_000) a.error = 'Animation vượt ngân sách 32 triệu pixel/frame tổng; giảm kích thước hoặc số frame.';
    }
    const transform = (name: string, raw: Img, t: number, timeline?: Timeline, omit?: string) => {
      const image = timeline ? normalizeFrames([{ img: raw }])[0].img : raw;
      const layer = doc.pixels[name]; if (name === omit || !layer?.enabled || conflicts.includes(name)) return image;
      if (image.w !== layer.layout.w || image.h !== layer.layout.h) throw new Error(`Lớp pixel '${name}' không khớp kích thước frame; cần chuyển lớp.`);
      const index = timeline ? timeline.durations ? frameAt(timeline, t) : Math.floor(t / timeline.step) : 0;
      const pixels = layer.frames[String(index)]; if (!pixels) return image;
      const copy = image.copy(); for (const [i, color] of Object.entries(pixels)) copy.data[+i] = color; return copy;
    };
    const p = loadProject(join(dir, doc.entry), { includeRoot: dir, trace: request.trace, transform });
    if (request.mode === 'summary') {
      const errors: string[] = [];
      const generated = request.generation ? new Set(p.exported()) : undefined;
      for (const a of assets) if (!a.error) { try {
        let visible = false;
        const check = (image: Img) => {
          if (!generated?.has(a.name)) return;
          if (image.w !== request.generation!.w || image.h !== request.generation!.h) throw new Error(`Kích thước ${image.w}×${image.h} không khớp canvas ${request.generation!.w}×${request.generation!.h}.`);
          visible ||= image.data.some(color => (color & 255) > 0);
        };
        check(p.build(a.name).img);
        if (request.validateFrames || request.generation) {
          let time = 0;
          for (let i = 1; i < a.durations.length; i++) { time += a.durations[i - 1]; check(p.build(a.name, 0, time).img); }
        }
        if (generated?.has(a.name) && !visible) throw new Error('Ảnh rỗng. Trong callback dùng (c)=>{c.poly(...);c.rect(...)}; các hàm global poly/rect chỉ tạo op, không vẽ khi bị bỏ qua trong callback.');
      } catch (e) { a.error = (e as Error).message; } }
      if (generated && !generated.size) errors.push('Không có asset công khai để tạo ảnh.');
      for (const a of assets) if (a.error) errors.push(`${a.name}: ${a.error}`);
      return { revision: doc.revision, assets, sheets: p.sheets.map(s => s.name), conflicts, errors, ms: Math.round(performance.now() - start) };
    }
    if ((request.mode === 'export' || request.mode === 'atlas') && assets.some(a => a.error)) throw new Error(assets.filter(a => a.error).map(a => `${a.name}: ${a.error}`).join('\n'));
    if (request.mode === 'raster' || request.mode === 'generation-preview') {
      if (conflicts.length || assets.some(a => a.error)) throw new Error('Xử lý lỗi dựng/lớp pixel trước khi tạo bản pixel.');
      const exported = new Set(p.exported());
      const result = assets.filter(a => request.mode !== 'generation-preview' || exported.has(a.name)).filter(a => request.name ? a.name === request.name : !request.selected?.length || request.selected.includes(a.name)).map(summary => {
        const a = newAsset(summary.name, summary.w, summary.h), frames = normalizeFrames(p.frames(summary.name));
        a.frames = (frames.length ? frames : [{ img: p.image(summary.name), ms: 100 }]).map(f => ({ id: uid(), duration: f.ms ?? 100 }));
        a.layers = [newLayer('Ảnh đã raster hóa')];
        const images = frames.length ? frames.map(f => f.img) : [p.image(summary.name)];
        images.forEach((img, i) => { const id = uid(); a.cels[id] = { id, data: img.data.slice() }; a.layers[0].cels[a.frames[i].id] = id; });
        if (a.frames.length > 1) a.tags.push({ id: uid(), name: summary.name, from: a.frames[0].id, to: a.frames.at(-1)!.id, direction: 'forward', loop: summary.loop });
        const colors = new Set<number>(); for (const img of images) for (const color of img.data) { if (colors.size < 4096) colors.add(color & 255 ? color : 0); } a.palette = [...colors];
        a.metadata = structuredClone(doc.metadata[summary.name] ?? {}); a.source = { files: doc.files, entry: doc.entry }; return a;
      });
      if (!result.length) throw new Error('Không có asset để chuyển.');
      const payload = request.mode === 'generation-preview' ? { assets: result, quality: inspectGeneration(result, request.generation!) } : result;
      return { data: Buffer.from(wireStringify(payload)), mime: 'application/json', filename: 'pixel-assets.json' };
    }
    if (request.mode === 'atlas' || request.mode === 'export' && request.format === 'atlas') {
      if (conflicts.length) throw new Error(`Cần xử lý lớp pixel: ${conflicts.join(', ')}`);
      const definition = p.sheets.find(s => s.name === request.sheet) ?? p.sheets[0];
      if (request.sheet && p.sheets.length && !p.sheets.some(s => s.name === request.sheet)) throw new Error('Không tìm thấy atlas được chọn.');
      const names = definition ? p.sheetNames(definition) : p.exported();
      const items: { name: string; img: Img; ms?: number }[] = [], tags: FrameTag[] = [];
      for (const n of names) { const fr = normalizeFrames(p.frames(n)); if (!fr.length) items.push({ name: n, img: p.image(n) }); else { tags.push({ name: n, from: items.length, to: items.length + fr.length - 1, loop: !p.timeline(n)?.once }); fr.forEach((f, i) => items.push({ name: `${n}_${i}`, img: f.img, ms: f.ms })); } }
      const packed = packSheet(items, undefined, definition?.opts.pad ?? 1, { ...definition?.opts, pack: 'maxrects', extrude: definition?.opts.extrude ?? 1, maxSize: 4096 });
      if (request.mode === 'atlas') return { w: packed.sheet.w, h: packed.sheet.h, rgba: rgba(packed.sheet), frame: 0, duration: 0 };
      return { data: zipFiles([{ path: 'atlas.png', data: encodePng(packed.sheet) }, { path: 'atlas.json', data: Buffer.from(sheetJson('atlas.png', packed.sheet, packed.frames, tags, doc.metadata)) }]), mime: 'application/zip', filename: 'atlas.zip' };
    }
    const name = request.name ?? p.exported()[0];
    if (!name || !p.assets.has(name)) throw new Error('Không tìm thấy asset.');
    const problem = assets.find(a => a.name === name)?.error; if (problem) throw new Error(problem);
    const tl = p.timeline(name), layout = layouts.get(name)!;
    const frame = Math.max(0, Math.min(Math.max(1, layout.durations.length) - 1, request.frame ?? 0));
    const time = layout.durations.slice(0, frame).reduce((a, b) => a + b, 0);
    const img = p.image(name, 0, time);
    if (request.mode === 'frame') {
      const b = p.build(name, 0, time);
      const withoutOwn = loadProject(join(dir, doc.entry), { includeRoot: dir, transform: (n, i, t, tl) => transform(n, i, t, tl, name) });
      const original = withoutOwn.image(name, 0, time);
      let trace: Picture['trace'];
      if (request.trace && b.trace) {
        trace = b.trace.frames.map(f => ({ label: f.label, w: f.w, h: f.h, rgba: '' }));
        if (request.traceStep !== undefined) {
          if (!Number.isInteger(request.traceStep) || request.traceStep < 0 || request.traceStep >= trace.length) throw new Error('Bước vẽ không hợp lệ.');
          let last: Img | undefined;
          for (let index = 0; index <= request.traceStep; index++) {
            const f = b.trace.frames[index];
            if (f.full) last = new Img(f.w, f.h, f.full.slice());
            else if (last && f.changes) for (let i = 0; i < f.changes.length; i += 2) last.data[f.changes[i]] = f.changes[i + 1];
          }
          trace[request.traceStep].rgba = last ? rgba(last) : rgba(img);
        }
      }
      return { w: img.w, h: img.h, rgba: rgba(img), base: rgba(original), frame, duration: layout.durations[frame] ?? 0, trace };
    }
    if (conflicts.length) throw new Error(`Cần xử lý lớp pixel xung đột: ${conflicts.join(', ')}`);
    if (assets.some(a => a.error)) throw new Error('Dự án có asset lỗi; sửa lỗi trước khi xuất.');
    const format = request.format ?? 'png';
    const filename = name.replace(/[^\p{L}\p{N}_-]/gu, '_');
    if (format === 'png') return { data: encodePng(img), mime: 'image/png', filename: filename + '.png' };
    if (format === 'gif') {
      const frames = normalizeFrames(p.frames(name)); if (!frames.length) throw new Error('Asset tĩnh không có GIF.');
      return { data: encodeGif(frames, { loop: !tl?.once }), mime: 'image/gif', filename: filename + '.gif' };
    }
    if (format === 'strip') {
      const fr = normalizeFrames(p.frames(name)); if (!fr.length) throw new Error('Asset không có animation.');
      const packed = packSheet(fr.map((f, i) => ({ name: `${name}_${i}`, img: f.img, ms: f.ms })), fr.length);
      return { data: zipFiles([{ path: filename + '.png', data: encodePng(packed.sheet) }, { path: filename + '.json', data: Buffer.from(sheetJson(filename + '.png', packed.sheet, packed.frames, [{ name, from: 0, to: fr.length - 1, loop: !tl?.once }], doc.metadata)) }]), mime: 'application/zip', filename: filename + '-animation.zip' };
    }
    const out = join(dir, 'exports');
    const r = writeOutputs(p, out, { preview: false, metadata: doc.metadata, packing: { pack: 'maxrects', extrude: 1, maxSize: 4096 }, only: request.selected?.length ? request.selected : undefined });
    if (r.errors.length) throw new Error(r.errors.map(e => e.message).join('\n'));
    mkdirSync(join(out, 'metadata'), { recursive: true });
    writeFileSync(join(out, 'metadata/pxl.json'), JSON.stringify({ schemaVersion: 1, revision: doc.revision, assets: Object.fromEntries(assets.filter(a => !request.selected?.length || request.selected.includes(a.name)).map(a => [a.name, { ...doc.metadata[a.name], w: a.w, h: a.h, loop: a.loop, durations: a.durations }])) }, null, 2));
    return { data: zipFiles(filesUnder(out)), mime: 'application/zip', filename: 'assets.zip' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
