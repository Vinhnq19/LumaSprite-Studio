import { composite, playback, playbackTag, type PixelDocument } from '../../studio/pixel/model.ts';
import { spriteSheet } from './atlas.ts';
import { encodePng } from './png.ts';
import { encodeGif } from './gif.ts';
import { zipFiles } from './zip.ts';
import type { ExportResult } from './render-result.ts';
import { StudioError } from './store.ts';
export interface PixelExport { document: PixelDocument; assetId?: string; frameId?: string; tagId?: string; format: 'png' | 'gif' | 'strip' | 'atlas' | 'zip'; selected?: string[] }
export function exportPixel(r: PixelExport): ExportResult {
  if (r.assetId && !r.document.assets.some(a => a.id === r.assetId)) throw new StudioError('Asset không tồn tại.',400,'ASSET_NOT_FOUND');
  if (r.selected?.some(id => !r.document.assets.some(a => a.id === id))) throw new StudioError('Danh sách xuất chứa asset không tồn tại.',400,'ASSET_NOT_FOUND');
  const asset = r.document.assets.find(a => a.id === r.assetId) ?? r.document.assets[0];
  if (!asset) throw new StudioError('Không tìm thấy asset.',400,'ASSET_NOT_FOUND');
  if (r.tagId && !asset.tags.some(t => t.id === r.tagId)) throw new Error('Tag không tồn tại.');
  const filename = asset.name.replace(/[^\p{L}\p{N}_-]/gu, '_'), sequence = playback(asset, r.tagId), tag = playbackTag(asset,r.tagId);
  if (r.format === 'png') { const frame = r.frameId ?? asset.frames[0].id; if (!asset.frames.some(f => f.id === frame)) throw new Error('Frame không tồn tại.'); return { data: encodePng(composite(asset, frame)), mime: 'image/png', filename: filename + '.png' }; }
  if (r.format === 'gif') return { data: encodeGif(sequence.map(s => ({ img: composite(asset, s.frame.id), ms: s.frame.duration })), { loop: tag?.loop ?? true }), mime: 'image/gif', filename: filename + '.gif' };
  if (r.format === 'zip') {
    const files: { path: string; data: Buffer }[] = [];
    for (const a of r.document.assets.filter(a => !r.selected?.length || r.selected.includes(a.id))) {
      const folder = `${a.name.replace(/[^\p{L}\p{N}_-]/gu, '_')}_${a.id.slice(0, 8)}`;
      const e = exportPixel({ ...r, assetId: a.id, frameId: a.frames[0].id, tagId: undefined, format: 'strip' }), zip = Buffer.from(e.data);
      for (let offset = 0; offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50;) {
        const size = zip.readUInt32LE(offset + 18), nl = zip.readUInt16LE(offset + 26), el = zip.readUInt16LE(offset + 28), start = offset + 30 + nl + el, name = zip.toString('utf8', offset + 30, offset + 30 + nl);
        files.push({ path: `${folder}/${name}`, data: zip.subarray(start, start + size) }); offset = start + size;
      }
    }
    return { data: zipFiles(files), mime: 'application/zip', filename: 'assets.zip' };
  }
  const assets = r.format === 'atlas' ? r.document.assets.filter(a => !r.selected?.length || r.selected.includes(a.id)) : [asset];
  const items = assets.flatMap(a => (r.format === 'strip' ? sequence : a.frames.map((frame, index) => ({ frame, index }))).map((s, index) => ({ name: `${a.name}_${a.id.slice(0, 8)}_${index}`, img: composite(a, s.frame.id), ms: s.frame.duration })));
  const packed = spriteSheet(items, r.format === 'strip');
  const json = { frames: packed.frames, meta: { app: 'LumaSprite Studio', image: 'image.png', format: 'RGBA8888', size: { w: packed.sheet.w, h: packed.sheet.h }, scale: '1' } } as { frames: typeof packed.frames; meta: Record<string, any> };
  let offset = 0;
  json.meta.frameTags = [];
  json.meta.pxl = { schemaVersion: 2, revision: r.document.revision, assets: Object.fromEntries(assets.map(a => [a.id, { name: a.name, ...a.metadata, frames: a.frames, tags: a.tags }])) };
  for (const a of assets) {
    for (const t of a.tags) { const i = a.frames.findIndex(f => f.id === t.from), j = a.frames.findIndex(f => f.id === t.to); json.meta.frameTags.push({ name: t.name, from: offset + Math.min(i, j), to: offset + Math.max(i, j), direction: t.direction === 'ping-pong' ? 'pingpong' : t.direction, loop: t.loop }); }
    offset += a.frames.length;
  }
  if (r.format === 'strip') { json.meta.frameTags = [{ name: tag?.name ?? asset.name, from: 0, to: sequence.length - 1, direction: 'forward', loop: tag?.loop ?? true }]; json.meta.pxl.playback = sequence.map(s => ({ frameId: s.frame.id, duration: s.frame.duration })); }
  return { data: zipFiles([{ path: 'image.png', data: encodePng(packed.sheet) }, { path: 'image.json', data: Buffer.from(JSON.stringify(json, null, 2)) }]), mime: 'application/zip', filename: `${r.format === 'atlas' ? 'atlas' : filename + '-strip'}.zip` };
}
