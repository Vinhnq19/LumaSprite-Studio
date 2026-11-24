import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { antigravityArgs, antigravityResponse } from '../src/node/studio/antigravity-protocol.ts';
const config = { executable: 'C:/CLI/agy.exe', work: 'D:/Copied context', schemaPath: 'D:/Copied context/response-schema.json', schema: '{"type":"object","required":["files"]}', images: [], timeoutMins: 3 };
test('Antigravity protocol: direct context and complete inline schema preserve execution configuration', () => {
  const args = antigravityArgs({ ...config, prompt: 'Exact native32 content' });
  assert.match(args[1], /Exact native32 content/); assert.match(args[1], /No reference image files/);
  assert.ok(args[1].includes(config.schema)); assert.ok(!args.includes('--json-schema'));
  assert.equal(args[args.indexOf('--mode') + 1], 'auto'); assert.ok(args.includes('--dangerously-skip-permissions')); assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(args[args.indexOf('--print-timeout') + 1], '3m');
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash-high'); assert.equal(args[args.indexOf('--effort') + 1], 'high');
});
test('Antigravity protocol: large quoted contexts use full file context and absolute image paths', () => {
  const args = antigravityArgs({ ...config, prompt: '\\"'.repeat(20000), images: ['preview.png', 'clip-guide.png'] });
  assert.ok(args[1].includes(JSON.stringify(join(config.work, 'request.md'))));
  assert.ok(args[1].includes(JSON.stringify(join(config.work, 'clip-guide.png'))));
  assert.ok(args[1].length < 1000); assert.match(args[1], /complete request/);
  assert.throws(() => antigravityArgs({ ...config, prompt: 'x', prefix: ['x'.repeat(30000)] }), /giới hạn/);
});
test('Antigravity protocol: structured envelopes remain subject to success and denied-action checks', () => {
  const proposal = { description: 'test', files: [{ path: 'art.px.js', content: 'sprite()' }] };
  for (const envelope of [{ status: 'SUCCESS', response: JSON.stringify(proposal) }, { status: 'SUCCESS', structured_output: proposal }]) assert.deepEqual(JSON.parse(antigravityResponse(JSON.stringify(envelope))), proposal);
  assert.throws(() => antigravityResponse(JSON.stringify({ status: 'SUCCESS', structured_output: proposal, denied_actions: ['read denied'] })), /read denied/);
  assert.throws(() => antigravityResponse(JSON.stringify({ status: 'FAILED', response: proposal, error: 'actual CLI error' })), /actual CLI error/);
  assert.throws(() => antigravityResponse('{'), SyntaxError);
});
