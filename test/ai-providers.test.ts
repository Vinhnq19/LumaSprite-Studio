import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiProviderLabel, isActiveAiProvider } from '../src/studio/ai-providers.ts';

test('Providers: only exact active provider ids are accepted', () => {
  assert.equal(isActiveAiProvider('codex'), true);
  assert.equal(isActiveAiProvider('deepseek'), true);
  for (const value of ['antigravity', 'unknown', '', null, undefined, 42, {}, [], ['codex'], { provider: 'codex' }, 'Codex', 'DEEPSEEK', ' antigravity']) {
    assert.equal(isActiveAiProvider(value), false);
  }
});

test('Providers: every recorded provider has its exact static label', () => {
  assert.equal(aiProviderLabel('codex'), 'Codex CLI');
  assert.equal(aiProviderLabel('deepseek'), 'DeepSeek API');
  assert.equal(aiProviderLabel('antigravity'), 'Antigravity (lịch sử)');
});
