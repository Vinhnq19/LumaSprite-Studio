import type { GenerationOptions, GenerationContext, GenerationReport } from './types.ts';
import { composite, type PixelAsset } from './pixel/model.ts';

export const generationStyles = { game: 'Game rõ nét', 'eight-bit': '8-bit tối giản', 'flat-icon': 'Icon phẳng' };
export const generationViews = { description: 'Theo mô tả', front: 'Chính diện', side: 'Ngang', 'top-down': 'Từ trên xuống' };
export const defaultGenerationOptions: GenerationOptions = { style: 'game', view: 'description', paletteMode: 'asset', reference: false };
export function generationOptions(value: unknown): GenerationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('generationOptions phải là cấu hình tạo ảnh.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['style', 'view', 'paletteMode', 'reference', 'animation'].includes(k))) throw new Error('Cấu hình tạo ảnh có trường không hỗ trợ.');
  const o = { ...defaultGenerationOptions, ...v };
  if (typeof o.style !== 'string' || !Object.hasOwn(generationStyles, o.style) || typeof o.view !== 'string' || !Object.hasOwn(generationViews, o.view) || typeof o.paletteMode !== 'string' || !['asset', 'auto16'].includes(o.paletteMode) || typeof o.reference !== 'boolean') throw new Error('Phong cách, góc nhìn, palette hoặc tham chiếu AI không hợp lệ.');
  if (o.animation !== undefined) {
    const a = o.animation as Record<string, any>;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['frameId','mode','frames','duration','loop','anchor','mask'].includes(k)) || typeof a.frameId !== 'string' || !['region','whole'].includes(a.mode) || !Number.isInteger(a.frames) || a.frames < 2 || a.frames > 24 || !Number.isInteger(a.duration) || a.duration < 1 || a.duration > 60000 || typeof a.loop !== 'boolean' || !a.anchor || !Number.isFinite(a.anchor.x) || !Number.isFinite(a.anchor.y) || a.mask !== undefined && (!Array.isArray(a.mask) || a.mask.some((v: unknown) => v !== 0 && v !== 1))) throw new Error('Cấu hình animation cần 2–24 frame, duration 1–60000 ms, điểm neo và vùng hợp lệ.');
  }
  return o as GenerationOptions;
}
export const rgbaHex = (color: number): string => '#' + color.toString(16).padStart(8, '0');

/** Mechanical checks, not an aesthetic score. Run on rasterized pixels inside a worker. */
export function inspectGeneration(assets: PixelAsset[], context: GenerationContext): GenerationReport {
  const allowed = new Set(context.palette.filter(c => (c & 255) > 0));
  const reports = assets.map(a => {
    const colors = new Set<number>(), outside = new Set<number>(), emptyFrames: number[] = [];
    let semiTransparentPixels = 0, visible = 0;
    a.frames.forEach((f, index) => {
      let frameVisible = 0;
      for (const p of composite(a, f.id).data) {
        const alpha = p & 255; if (!alpha) continue;
        frameVisible++; colors.add(p); if (alpha < 255) semiTransparentPixels++;
        if (context.options.paletteMode === 'asset' && !allowed.has(p)) outside.add(p);
      }
      visible += frameVisible; if (!frameVisible) emptyFrames.push(index + 1);
    });
    const errors: string[] = [], warnings: string[] = [];
    if (!visible) errors.push('Ảnh rỗng: không có pixel nhìn thấy.');
    if (a.w !== context.w || a.h !== context.h) errors.push(`Kích thước ${a.w}×${a.h} không khớp canvas ${context.w}×${context.h}.`);
    if(context.animation) {
      if(a.frames.length!==context.animation.frames)errors.push(`Cần đúng ${context.animation.frames} frame, nhận ${a.frames.length}.`);
      if(a.frames.some(f=>f.duration!==context.animation!.duration))errors.push(`Timing cần ${context.animation.duration} ms mỗi frame.`);
      if((a.tags[0]?.loop??true)!==context.animation.loop)errors.push('Chế độ loop/one-shot không khớp yêu cầu.');
    }
    if (outside.size) warnings.push(`${outside.size} màu nằm ngoài palette đã chọn.`);
    const limit = context.options.paletteMode === 'auto16' ? 16 : allowed.size;
    if (colors.size > limit) warnings.push(`Ảnh có ${colors.size} màu nhìn thấy, vượt giới hạn ${limit} màu.`);
    if (semiTransparentPixels) warnings.push(`${semiTransparentPixels} pixel bán trong suốt (tổng các frame).`);
    if (visible && emptyFrames.length) warnings.push(`Frame rỗng: ${emptyFrames.join(', ')}.`);
    return { assetId: a.id, name: a.name, w: a.w, h: a.h, frames: a.frames.length, colorCount: colors.size, outsidePaletteColors: outside.size, semiTransparentPixels, emptyFrames, errors, warnings };
  });
  return { assets: reports, errors: assets.length ? reports.flatMap(r => r.errors.map(e => `${r.name}: ${e}`)) : ['Không có asset trong đề xuất.'], warnings: reports.flatMap(r => r.warnings.map(w => `${r.name}: ${w}`)) };
}
