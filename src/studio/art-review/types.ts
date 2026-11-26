export const ART_REVIEW_TOOL_VERSION = '1.0.0';
export const ART_REVIEW_SCHEMA_VERSION = 1;
export const ART_REVIEW_REPORT_KIND = 'lumasprite.art-review.v1';
export const ART_REVIEW_MANIFEST_KIND = 'lumasprite.art-review-manifest.v1';

export type AssetFamily =
  | 'character'
  | 'prop'
  | 'terrain'
  | 'environment'
  | 'animation'
  | 'ui'
  | 'vfx';

export const ASSET_FAMILIES: readonly { id: AssetFamily; label: string }[] = [
  { id: 'character', label: 'Character (Nhân vật)' },
  { id: 'prop', label: 'Prop (Đạo cụ)' },
  { id: 'terrain', label: 'Terrain (Địa hình)' },
  { id: 'environment', label: 'Environment (Môi trường)' },
  { id: 'animation', label: 'Animation (Chuyển động)' },
  { id: 'ui', label: 'UI (Giao diện)' },
  { id: 'vfx', label: 'VFX (Hiệu ứng)' },
];

export type ReviewSlot = 'baseline' | 'candidate';

export interface Pivot {
  x: number;
  y: number;
}

export interface ReviewFrame {
  index: number;
  width: number;
  height: number;
  rgba: Uint32Array;
  durationMs: number;
  label?: string;
  pivot?: Pivot;
}

export type TimingSource = 'metadata' | 'explicit-default' | 'single-frame';
export type PlaybackDirection = 'forward' | 'reverse' | 'ping-pong';

export interface AnimationTag {
  name: string;
  from: number;
  to: number;
  direction: PlaybackDirection;
  loop: boolean;
}

export interface LoadedAsset {
  slot: ReviewSlot;
  name: string;
  fileName: string;
  sourceSha256?: string;
  metadataFileName?: string;
  metadataSha256?: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  frames: ReviewFrame[];
  loop: boolean;
  direction: PlaybackDirection;
  pivot?: Pivot;
  timingSource: TimingSource;
  tags: AnimationTag[];
  activeTag?: string;
  warnings: string[];
}

export type AlignmentMode = 'top-left' | 'center' | 'bottom-center' | 'pivot' | 'manual';

export interface AlignmentConfig {
  mode: AlignmentMode;
  offsetX: number;
  offsetY: number;
  confirmed: boolean;
}

export type BackgroundMode = 'checker' | 'light' | 'dark';
export type ViewMode = 'side-by-side' | 'toggle-a' | 'toggle-b' | 'blink' | 'diff' | 'silhouette';
export type SilhouetteMode = 'binary' | 'alpha-channel';
export type SyncMode = 'time' | 'frame';
export type ZoomLevel = 1 | 2 | 4 | 8;

export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  maxScore: number;
}

export interface RubricDefinition {
  id: string;
  name: string;
  version: string;
  isWorkbenchDefault: boolean;
  disclaimer: string;
  families: Record<AssetFamily, readonly RubricCriterion[]>;
}

export type CriterionSeverity = 'none' | 'minor' | 'major' | 'critical';

export interface CriterionScore {
  score: number | null;
  severity: CriterionSeverity;
  note: string;
}

export interface RegionNote {
  id: string;
  slot: ReviewSlot | 'diff';
  frameIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  criterionId?: string;
  severity: CriterionSeverity;
  note: string;
}

export type ReviewDecision = 'undecided' | 'baseline' | 'candidate' | 'neither';

export interface AssetReferenceSnapshot {
  slot: ReviewSlot;
  name: string;
  fileName: string;
  sourceSha256?: string;
  metadataFileName?: string;
  metadataSha256?: string;
  frameWidth: number;
  frameHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  frameCount: number;
  frameDurationsMs: number[];
  timingSource: TimingSource;
  pivot?: Pivot;
}

export interface DiffStats {
  totalUnionPixels: number;
  overlapPixels: number;
  changedPixels: number;
  identicalOverlapPixels: number;
  rgbDiffPixels: number;
  alphaDiffPixels: number;
  onlyAPixels: number;
  onlyBPixels: number;
  maxChannelDelta: number;
}

export interface ReviewSessionData {
  schemaVersion: number;
  kind: typeof ART_REVIEW_REPORT_KIND;
  toolVersion: string;
  timestamp: string;
  assetFamily: AssetFamily;
  rubricId: string;
  rubricName: string;
  rubricVersion: string;
  rubricIsWorkbenchDefault: boolean;
  baselineRef?: AssetReferenceSnapshot;
  candidateRef?: AssetReferenceSnapshot;
  alignment: AlignmentConfig;
  decision: ReviewDecision;
  summaryNote: string;
  scores: Record<string, CriterionScore>;
  regionNotes: RegionNote[];
  diffStats?: DiffStats;
}

export interface ReviewManifest {
  kind: typeof ART_REVIEW_MANIFEST_KIND;
  title?: string;
  assetFamily?: AssetFamily;
  baseline?: {
    name?: string;
    fileName: string;
    metadataFileName?: string;
    pivot?: Pivot;
  };
  candidate?: {
    name?: string;
    fileName: string;
    metadataFileName?: string;
    pivot?: Pivot;
  };
  rubric?: RubricDefinition;
}
