import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQualityJson } from '../src/studio/quality/json.ts';
test('quality JSON accepts one raw or fenced object with Unicode/BOM/CRLF and escaped brackets', () => {
  const value = { text: 'Đuôi [mèo] "x" \\ } {', nested: { x: [1, 2] } }, raw = JSON.stringify(value);
  for (const input of [raw, '\ufeff  ' + raw + '\n', '```json\n' + raw + '\n```', '```JSON\r\n' + raw + '\r\n```', '```\n' + raw + '\n```']) assert.deepEqual(parseQualityJson(input), value);
  const parsed = parseQualityJson(raw); (parsed.nested as any).x[0] = 9; assert.equal((parseQualityJson(raw).nested as any).x[0], 1);
});
test('quality JSON rejects prose, multiple results, partial output, bad fences and primitive roots', () => {
  for (const input of ['Before\n{}', '{} after', '{} {}', '```json\n{}\n```\n```json\n{}\n```', '```js\n{}\n```', '```json\n{}', '{"a":', '[]', 'null', 'false', '3', '"{}"', '']) assert.throws(() => parseQualityJson(input));
  assert.throws(() => parseQualityJson({} as string));
});
test('quality JSON counts UTF8 bytes before parsing and caps depth without counting string brackets', () => {
  const input = JSON.stringify({ text: 'áá' }); assert.throws(() => parseQualityJson(input, input.length));
  assert.doesNotThrow(() => parseQualityJson(input, new TextEncoder().encode(input).length));
  for (const limit of [0, 1.5, Infinity, 2_000_001]) assert.throws(() => parseQualityJson('{}', limit));
  assert.throws(() => parseQualityJson('{"a":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}'), /64/);
  assert.doesNotThrow(() => parseQualityJson(JSON.stringify({ text: '['.repeat(1000) })));
});
