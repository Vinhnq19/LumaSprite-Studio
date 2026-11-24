/** Shared provider contract for the user-approved AI provider migration. Pure data, no I/O. */
export type ActiveAiProvider = 'codex' | 'deepseek';
/** Historical records may still name providers no longer offered for new jobs. */
export type RecordedAiProvider = ActiveAiProvider | 'antigravity';

export function isActiveAiProvider(value: unknown): value is ActiveAiProvider {
  return value === 'codex' || value === 'deepseek';
}

const AI_PROVIDER_LABELS: Readonly<Record<RecordedAiProvider, string>> = {
  codex: 'Codex CLI',
  deepseek: 'DeepSeek API',
  antigravity: 'Antigravity (lịch sử)',
};

export function aiProviderLabel(provider: RecordedAiProvider): string {
  return AI_PROVIDER_LABELS[provider];
}
