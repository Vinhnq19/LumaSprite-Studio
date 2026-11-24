import { composite, type PixelAsset } from '../../src/studio/pixel/model.ts';
import { generationStyles, generationViews } from '../../src/studio/generation.ts';
import type { GenerationContext, GenerationReport } from '../../src/studio/types.ts';

export function zoomProposal(): void {
  const zoom = Number((document.getElementById('proposal-zoom') as HTMLSelectElement).value);
  for (const id of ['before', 'after']) {
    const c = document.getElementById(id) as HTMLCanvasElement;
    c.style.width = `${c.width * zoom}px`; c.style.height = `${c.height * zoom}px`;
  }
}
function picture(id: string, a?: PixelAsset): void {
  const c = document.getElementById(id) as HTMLCanvasElement;
  if (!a) { c.width = c.height = 1; return; }
  const img = composite(a, a.frames[0].id), bytes = new Uint8ClampedArray(img.data.length * 4);
  for (let i = 0; i < img.data.length; i++) { const p = img.data[i]; bytes[i * 4] = p >>> 24; bytes[i * 4 + 1] = p >>> 16 & 255; bytes[i * 4 + 2] = p >>> 8 & 255; bytes[i * 4 + 3] = p & 255; }
  c.width = img.w; c.height = img.h; const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.putImageData(new ImageData(bytes, img.w, img.h), 0, 0);
}
export function renderProposalPreview(before: PixelAsset | undefined, assets: PixelAsset[], quality?: GenerationReport, generation?: GenerationContext): void {
  picture('before', before); picture('after', assets[0]); zoomProposal();
  const config = document.getElementById('proposal-settings')!;
  config.textContent = generation ? `${generation.w}×${generation.h} · ${generationStyles[generation.options.style]} · ${generationViews[generation.options.view]} · ${generation.options.paletteMode === 'asset' ? 'Palette asset' : 'AI chọn ≤16 màu'} · ${generation.options.reference ? 'Tham chiếu frame 1' : 'Không tham chiếu'}` : 'Đề xuất từ mã / API tương thích';
  const stats = document.getElementById('proposal-stats')!, warnings = document.getElementById('proposal-warnings')!, errors = document.getElementById('proposal-errors')!;
  stats.textContent = quality ? quality.assets.map(a => `${a.name}: ${a.w}×${a.h} · ${a.frames} frame · ${a.colorCount} màu`).join('\n') : assets.map(a => `${a.name}: ${a.w}×${a.h} · ${a.frames.length} frame`).join('\n');
  warnings.textContent = quality?.warnings.length ? `Cảnh báo (có thể áp dụng nếu chấp nhận):\n${quality.warnings.join('\n')}` : '';
  errors.textContent = quality?.errors.length ? `Chưa thể áp dụng:\n${quality.errors.join('\n')}` : '';
  (document.getElementById('proposal-apply') as HTMLButtonElement).disabled = !!quality?.errors.length;
}
