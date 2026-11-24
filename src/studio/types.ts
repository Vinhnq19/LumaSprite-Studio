import type { DesignManifest } from './design-manifest.ts';
import type { ClipGenerationContext } from './clip-generation.ts';
import type { RecordedAiProvider } from './ai-providers.ts';

export interface ClipGuideSlotDescriptor {
  id: string;
  order: number;
  duration: number;
  selected: boolean;
  frozen: boolean;
  keyframe: boolean;
  isEditedPose: boolean;
}
export interface ClipGuideDescriptor {
  w: number;
  h: number;
  cols: number;
  rows: number;
  slots: ClipGuideSlotDescriptor[];
}
export interface GenerationClipDescriptor {
  context: ClipGenerationContext;
  helperFiles: string[];
  facing: string;
  template: string;
  guideMetadata: ClipGuideDescriptor;
}

export interface Layout { w: number; h: number; durations: number[] }
export interface PixelLayer {
  layout: Layout;
  enabled: boolean;
  frames: Record<string, Record<string, number>>;
}
export interface AssetMetadata {
  pivot?: { x: number; y: number };
  hitbox?: { x: number; y: number; w: number; h: number };
  events?: { frame: number; name: string }[];
}
export interface ProjectDocument {
  schemaVersion: 1; id: string; name: string; entry: string; revision: number;
  files: Record<string, string>;
  pixels: Record<string, PixelLayer>;
  metadata: Record<string, AssetMetadata>;
}
export interface AssetSummary {
  name: string; kind: string; w: number; h: number; durations: number[];
  loop: boolean; palette: Record<string, string>; error?: string;
}
export interface BuildSummary {
  revision: number; assets: AssetSummary[]; sheets: string[]; conflicts: string[]; errors: string[]; ms: number;
}
export interface Picture {
  w: number; h: number; rgba: string; base?: string; frame: number; duration: number;
  trace?: { label: string; rgba: string; w: number; h: number }[];
}
export type JobStatus = 'running' | 'validating' | 'ready' | 'failed' | 'canceling' | 'canceled' | 'unknown' | 'applied';
export interface AiProposal { description: string; files: { path: string; content: string }[]; manifest?: DesignManifest }
export interface GenerationOptions {
  style: 'game' | 'eight-bit' | 'flat-icon';
  view: 'description' | 'front' | 'side' | 'top-down';
  paletteMode: 'asset' | 'auto16';
  reference: boolean;
  animation?: AnimationOptions;
}
export interface AnimationOptions {
  frameId: string; mode: 'region' | 'whole'; frames: number; duration: number; loop: boolean;
  anchor: { x: number; y: number }; mask?: number[];
}
export interface GenerationContext {
  options: GenerationOptions; assetId: string; w: number; h: number; palette: number[];
  animation?: Omit<AnimationOptions, 'mask'> & { referenceFile: string };
  operation?: 'region-edit' | 'clip-regenerate';
  clip?: GenerationClipDescriptor;
}
export interface GenerationAssetReport {
  assetId: string; name: string; w: number; h: number; frames: number; colorCount: number;
  outsidePaletteColors: number; semiTransparentPixels: number; emptyFrames: number[];
  errors: string[]; warnings: string[];
}
export interface GenerationReport { assets: GenerationAssetReport[]; errors: string[]; warnings: string[] }
export interface AiJob {
  diagnostic?: import('./diagnostic.ts').StudioDiagnostic;
  metrics?: { budgetMs: number; referenceChars: number; promptChars: number };
  guidance?: import('./batch-types.ts').ArtGuidanceInfo;
  id: string; projectId: string; provider: RecordedAiProvider; revision: number;
  transport?: 'cli' | 'http'; model?: string;
  usage?: { input?: number; output?: number; cached?: number; unavailable?: boolean };
  status: JobStatus; started: number; message: string; proposal?: AiProposal;
  build?: BuildSummary; attempt: number;
  generation?: GenerationContext; quality?: GenerationReport;
  candidateIndex?: number; cliExecutions?: number;
}
