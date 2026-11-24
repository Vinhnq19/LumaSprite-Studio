import type { PixelAsset } from './pixel/model.ts';
import type { GenerationContext, GenerationReport } from './types.ts';
import type { ProcessingStats } from './pixel/processing.ts';
export type VariantAsset = Pick<PixelAsset,'id'|'name'|'w'|'h'|'frames'|'tags'|'metadata'|'palette'>;
export interface VariantClipMapping {
  clipId: string;
  characterId: string;
  sourceAssetId: string;
  sourceFrameId?: string;
  projectId?: string;
  revision: number;
  slotIds: string[];
  selectedSlotIds: string[];
  baselineAssetId?: string;
  masterAssetId?: string;
  contextDigest?: string;
  maskDigest?: string;
  referenceId?: string;
}
export interface VariantInfo {
  id: string; label: string; kind: 'raw'|'protected'|'normalized'|'reference'; canApply: boolean;
  assets: VariantAsset[]; quality?: GenerationReport; stats?: ProcessingStats[]; alphaThreshold?: number;
  clip?: VariantClipMapping;
}
export interface VariantPreview {
  proposalId: string; variants: VariantInfo[]; selectedVariantId: string; generation?: GenerationContext;
  referenceVariantId?: string;
  reference?: VariantInfo;
}
export interface VariantFrame { w: number; h: number; data: Uint32Array; duration: number; bounds?: {x:number;y:number;w:number;h:number;bottom:number}; count?: number }
export interface ProcessingJob { id: string; projectId: string; proposalId: string; revision: number; status: 'running'|'ready'|'failed'|'canceled'; message: string; variantId?: string }
