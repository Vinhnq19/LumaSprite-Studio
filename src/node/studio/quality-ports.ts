import type { AssetRecipe, RecipeContext } from '../../studio/quality/recipe.ts';
import type { QualityDirector } from '../../studio/quality/protocol.ts';
import type { QualityRole, QualityProvider, QualityVariantSummary, QualityCall } from '../../studio/quality/run.ts';
import type { TemplateScope } from '../../studio/quality/template-scope.ts';

/** A stop resolves true only after all work owned by this handle is confirmed stopped. */
export interface QualityOwnedTask<T> { promise: Promise<T>; stop(deadline: number): Promise<boolean>; diagnostic?(): string }
export interface QualityImage { name: string; data: Uint8Array }
export interface QualityStartInput { projectId: string; revision: number; prompt: string; style: string; context: unknown }
export interface QualityPrepared {
  snapshotId: string; base: AssetRecipe; context: RecipeContext; structureLocked: boolean; sourceImages: QualityImage[];
  terrainReview?: boolean;
  characterStudy?: boolean;
  characterFinishStudy?: boolean;
  templateScope?: TemplateScope;
}
export interface QualityExecution {
  role: QualityRole; provider: QualityProvider; callId: string; deadline: number; budgetMs: number; instruction: string;
  snapshotId: string; director?: QualityDirector; candidateId?: string; images: QualityImage[];
  reasoningEffort?: 'low';
  staticCharacterBuilder?: true;
  staticCharacterReview?: true;
  characterFinishStep?: 'construction' | 'choice' | 'touchups';
}
export interface QualityCliResult { output: string; usage?: QualityCall['usage']; model?: string; transport?: 'cli' | 'http' }
export interface CharacterToneChange { changedPixels: number; strongDifferences: number; meanLuma: number }
export interface CharacterToneComparison { visiblePixels: number; originalMeanLuma: number; A: CharacterToneChange; B: CharacterToneChange }
export type QualityValidated = { kind: 'director'; director: QualityDirector; toneComparison?: CharacterToneComparison } |
  { kind: 'variant'; variant: QualityVariantSummary; images: QualityImage[]; reviewNotes?: string };
export interface QualityLease { release(): void; check(): void }
export interface QualityPorts {
  acquire(projectId: string): QualityLease;
  /** Re-read current project state; throwing makes the captured run stale. */
  assertCurrent(projectId: string, revision: number): void;
  prepare(input: QualityStartInput): QualityOwnedTask<QualityPrepared>;
  execute(request: QualityExecution): QualityOwnedTask<QualityCliResult>;
  validate(role: QualityRole, output: string, prepared: QualityPrepared, director?: QualityDirector, candidateId?: string): QualityOwnedTask<QualityValidated>;
  /** Stop lazy preview/materialization workers before disposing a completed run. */
  drain?(snapshotId: string, deadline: number): Promise<boolean>;
  /** Release only owned artifacts, after all handles for this run are stopped. */
  drop(snapshotId: string): void;
}
