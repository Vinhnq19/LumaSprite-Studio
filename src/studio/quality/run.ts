import type { RecordedAiProvider } from '../ai-providers.ts';

export type QualityRole = 'director' | 'builder' | 'reviewer';
/** Historical records may name Antigravity; new records may name DeepSeek. */
export type QualityProvider = RecordedAiProvider;
export type QualityRunStatus = 'running' | 'canceling' | 'unknown' | 'ready' | 'failed' | 'canceled';
export type QualityStage = 'preparing' | QualityRole | 'validating' | 'done';
export interface QualityCall {
  id: string; role: QualityRole; provider: QualityProvider; repair: boolean;
  started: number; deadline: number; ended?: number;
  elapsedMs?: number;
  status: 'running' | 'succeeded' | 'invalid' | 'failed' | 'canceled' | 'unknown';
  message?: string; usage?: { input?: number; output?: number; cached?: number; unavailable?: boolean };
  transport?: 'cli' | 'http'; model?: string;
  reasoningEffort?: 'low';
}
export interface QualityVariantSummary {
  id: string; kind: 'builder' | 'reviewed' | 'edited'; parentVariantId?: string; description: string; w: number; h: number;
  frames: { id: string; durationMs: number; rgbaSha256: string }[]; loop: boolean;
}
/** Compact public record: no source, raw provider text, resource buffers or image data in SSE. */
export interface QualityRun {
  version: 1; id: string; projectId: string; revision: number;
  status: QualityRunStatus; stage: QualityStage; started: number; deadline: number; ended?: number;
  elapsedMs?: number;
  cliCalls: number; technicalRepairs: number; message: string;
  calls: QualityCall[]; variants: QualityVariantSummary[]; selectedVariantId?: string;
}
export const QUALITY_ROLE_LIMITS = { director: 90_000, builder: 300_000, reviewer: 240_000 } as const;
export const QUALITY_TOTAL_LIMIT = 900_000;
export const QUALITY_STOP_RESERVE = 5_000;
export const QUALITY_MAX_CLI_CALLS = 4;
export const QUALITY_MAX_TECHNICAL_REPAIRS = 1;
export const QUALITY_PROVIDERS: Readonly<Record<QualityRole, QualityProvider>> = { director: 'codex', builder: 'deepseek', reviewer: 'codex' };
