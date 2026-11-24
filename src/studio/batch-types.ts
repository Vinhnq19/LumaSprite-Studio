import type { AiProposal, BuildSummary, GenerationReport, AiJob } from './types.ts';
import type { DesignManifest } from './design-manifest.ts';
import type { ArtDirection } from './art-direction.ts';
import type { ClipGenerationContext } from './clip-generation.ts';
import type { RecordedAiProvider } from './ai-providers.ts';

export interface ArtReferenceImage {
  name: string;
  data: Uint8Array;
}

export interface ArtGuidanceInfo { id: 'baseline' | 'skill-v1'; topic: 'sprite' | 'animation' | 'terrain'; hash: string }
/** Internal captured text; only ArtGuidanceInfo is exposed in API/SSE. */
export interface ArtGuidanceSnapshot extends ArtGuidanceInfo { readonly text: string }

export interface CandidateExecutionOptions {
  singleAttempt?: boolean;
  figureStage?: import('./pixel/figure-review.ts').FigureStage;
  artGuidance?: ArtGuidanceSnapshot;
  candidateIndex?: number;
  artDirection?: ArtDirection;
  referenceImages?: ArtReferenceImage[];
  guideImage?: ArtReferenceImage;
  timeout?: number;
  deadline?: number;
}

export type CandidateStatus = 'pending' | 'running' | 'ready' | 'failed' | 'canceled' | 'unknown';
export type BatchStatus = 'running' | 'ready' | 'partial' | 'failed' | 'canceled' | 'unknown' | 'applied';

export interface CandidateSnapshot {
  id: string;
  index: number;
  status: CandidateStatus;
  message: string;
  attempt: number;
  repairs?: number;
  cliExecutions?: number;
  started?: number;
  ended?: number;
  elapsedMs?: number;
  proposal?: AiProposal;
  proposalId?: string;
  build?: BuildSummary;
  quality?: GenerationReport;
  manifest?: DesignManifest;
  error?: string;
}

export interface CompactCandidateInfo {
  diagnostic?: AiJob['diagnostic'];
  metrics?: AiJob['metrics'];
  transport?: AiJob['transport'];
  model?: AiJob['model'];
  usage?: AiJob['usage'];
  id: string;
  index: number;
  status: CandidateStatus;
  message: string;
  description?: string;
  attempt: number;
  repairs?: number;
  cliExecutions?: number;
  dimensions?: { w: number; h: number };
  started?: number;
  ended?: number;
  elapsedMs?: number;
  proposalId?: string;
  error?: string;
  quality?: {
    errors: string[];
    warnings: string[];
  };
  hasManifest?: boolean;
}

export interface RegionEditInput {
  frameId: string;
  mask: number[];
  anchor?: { x: number; y: number };
}

export interface CompactBatchConfig {
  target: {
    w: number;
    h: number;
    name: string;
    assetId: string;
  };
  operation?: 'region-edit' | 'clip-regenerate';
  regionEdit?: {
    frameId: string;
    duration: number;
    anchor: { x: number; y: number };
  };
  clip?: ClipGenerationContext;
  options?: {
    style: string;
    view: string;
    paletteMode: string;
    reference: boolean;
  };
  artDirection: {
    style: string;
    paletteMode: string;
    palette?: number[];
    light: string;
    detailLevel: string;
    outline: string;
    references: { assetId: string; frameId: string; name?: string }[];
  };
}

export interface CompactBatchInfo {
  limits?: { candidateMs: number; batchMs: number };
  guidance?: ArtGuidanceInfo;
  id: string;
  projectId: string;
  revision: number;
  provider: RecordedAiProvider;
  status: BatchStatus;
  started: number;
  ended?: number;
  elapsedMs?: number;
  prompt: string;
  candidates: CompactCandidateInfo[];
  appliedCandidateId?: string;
  config?: CompactBatchConfig;
}

export interface ClipGenerationInput {
  clipId: string;
}

export interface CreateBatchInput {
  revision: number;
  assetId?: string;
  provider: RecordedAiProvider;
  prompt: string;
  generationOptions?: unknown;
  artDirection?: unknown;
  regionEdit?: unknown;
  clipGeneration?: unknown;
}

export interface RetryCandidateInput {
  revision: number;
}
