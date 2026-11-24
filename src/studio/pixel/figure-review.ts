import { Img } from '../../core/image.ts';
import { diagnostics } from './processing.ts';
import type { ArtDirection } from '../art-direction.ts';
import type { GenerationContext } from '../types.ts';
import type { CharacterPoseSpec, CharacterShapeFinding, PoseRasters } from './character-pose.ts';

export interface FigurePlan {
  brief: string; generation: GenerationContext; art: ArtDirection;
  grid: 1; pose: string; proportions: string; projection: string;
  poseSpec?: CharacterPoseSpec;
}
export type FigureStage = 'shape' | 'finish' | 'repair';
export interface FigureSample {
  id: string; revision: number; stage: FigureStage; plan: FigurePlan;
  pixels: Uint32Array; approved?: Uint32Array; parent?: string;
  submittedAt?: number; previewAt?: number;
  restored?: number;
  finishNotes?: string;
  shapeParts?: PoseRasters;
  shapeFindings?: CharacterShapeFinding[];
  warnings: { index: number; reason: string }[]; errors: string[];
}
export function protectFigure(generated: Uint32Array, approved: Uint32Array, mask?: number[]) {
  if (generated.length !== approved.length) throw Error('Sai kích thước ảnh so với bản duyệt.');
  const result = approved.slice(), area = mask && new Set(mask);
  for (let i = 0; i < result.length; i++) {
    if ((area && !area.has(i)) || !(approved[i] & 255) || !(generated[i] & 255)) continue;
    result[i] = (generated[i] & 0xffffff00) | (approved[i] & 255);
  }
  return result;
}
export function figureDiagnostics(img: Img) {
  const stats = diagnostics(img.data, img.w);
  const samples = [
    ...stats.singletons.slice(0, 16).map(index => ({ index, reason: 'Pixel khác màu các ô cạnh. Kiểm tra điểm sáng hoặc nhiễu.' })),
    ...stats.checkerboards.slice(0, 8).map(index => ({ index, reason: 'Cụm caro. Kiểm tra dithering và biên.' })),
  ];
  const semi = img.data.findIndex(p => (p & 255) > 0 && (p & 255) < 255);
  if (semi >= 0) samples.push({ index: semi, reason: 'Biên bán trong suốt. Kiểm tra chủ đích.' });
  let edgeSamples = 0, valueSamples = 0;
  for (let i = 1; i < img.data.length && (edgeSamples < 4 || valueSamples < 4); i++) {
    const x = i % img.w, color = img.data[i], left = img.data[i - 1];
    if (!x || !(color & 255)) continue;
    if (valueSamples < 4 && (left & 255) === (color & 255) && left !== color &&
      [8,16,24].every(shift => Math.abs((left >>> shift & 255) - (color >>> shift & 255)) <= 8)) {
      samples.push({ index:i, reason:'Hai màu kề nhau có độ chênh RGB rất thấp. Xem lại ở 1×.' });
      valueSamples++;
    }
    if (edgeSamples < 4 && i >= img.w && i + img.w < img.data.length && x + 1 < img.w &&
      !(img.data[i-img.w] & 255) && !(left & 255) && !(img.data[i+1] & 255) && (img.data[i+img.w] & 255)) {
      samples.push({ index:i, reason:'Mũi nhô một pixel trên đường bao. Kiểm tra nét gãy hoặc chi tiết có chủ đích.' });
      edgeSamples++;
    }
  }
  return samples;
}
