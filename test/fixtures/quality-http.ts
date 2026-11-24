import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { DeepSeekSettings } from '../../src/node/studio/deepseek-http.ts';
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from '../../src/node/studio/deepseek-http.ts';

/** Fake builder using actual captured JSON resources. Never contacts a provider. */
export function qualityHttpFixture(scenario: string, log: string): DeepSeekSettings {
  return { apiKey: 'quality-http-fixture-key-458921', fetch: (async (url, init) => {
    assert.equal(url, DEEPSEEK_BASE_URL + '/chat/completions');
    const body = JSON.parse(init!.body as string); assert.equal(body.model, DEEPSEEK_MODEL);
    assert.equal(body.tools, undefined); assert.equal(body.response_format, undefined);
    const inline = JSON.parse(body.messages[1].content);
    if (scenario === 'character-finish') {
      assert.equal(body.max_tokens, 1024);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(inline.context, null);
      assert.deepEqual(inline.schema.required, ['finish']);
      assert.deepEqual(inline.schema.properties.finish.enum, ['A', 'B', 'C']);
      assert.doesNotMatch(inline.prompt, /source-recipe|construction|rgba|fixture-key/i);
      const measured = /Rendered measurements [^\n]+?: (\{.+\})\. Use these counts/.exec(inline.prompt);
      assert.ok(measured);
      const tones = JSON.parse(measured[1]);
      assert.ok(tones.visiblePixels > 0 && tones.A.changedPixels >= 0 && tones.B.changedPixels >= 0);
      appendFileSync(log, JSON.stringify({ role: 'builder', provider: 'deepseek', transport: 'http', finishChoice: true, context: inline.context, tones }) + '\n');
      const finish = tones.A.changedPixels ? 'A' : 'C';
      const output = JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ finish }) }, finish_reason: 'stop' }] });
      return new Response(`data: ${output}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    const files = inline.context.files;
    assert.ok(files['source-recipe.json']); assert.ok(files['resource-index.json']);
    assert.ok(Object.keys(files).every(k => k.endsWith('.json')));
    const source = structuredClone(files['source-recipe.json']);
    assert.ok(!/Read first:.*[A-Z]:[\\/]/.test(inline.prompt));
    appendFileSync(log, JSON.stringify({ role: 'builder', provider: 'deepseek', transport: 'http', codex: false,
      images: [], flags: [], stdin: inline.prompt, index: files['resource-index.json'], files }) + '\n');
    if (files['template-scope.json']) {
      assert.equal(inline.schema.properties.recipe, undefined);
      const scope = files['template-scope.json'];
      const part = source.parts.find((part: { id: string }) => part.id === scope.partIds[0]);
      assert.ok(part);
      const n = scope.region;
      const pixel = scenario === 'template-outside' ? { x: 0, y: 0, color: 0 } : { x: n.x, y: n.y, color: 0 };
      const output = { version: 1, description: 'Thử chỉnh lớp đã duyệt', decision: 'patch',
        patches: [{ partId: part.id, paint: [...part.paint, { kind: 'pixels', pixels: [pixel] }] }] };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }
    const count = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
    if (scenario === 'compact-pixels') {
      const paint = inline.schema.properties.recipe.properties.parts.items.properties.paint.items.anyOf;
      assert.ok(paint.some((op: { properties: { rows?: unknown } }) => op.properties.rows));
      source.parts[0].paint.push({ kind: 'pixels', x: 2, y: 3, rows: ['.0', '1'] });
    }
    if (scenario === 'reviewer-completed-character') {
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(inline.schema.properties.recipe, undefined);
      assert.deepEqual(inline.schema.required, ['version', 'description', 'parts']);
      const ops = inline.schema.properties.parts.items.properties.paint.items.anyOf;
      assert.ok(ops.some((op: { properties: { rows?: unknown } }) => op.properties.rows));
      assert.doesNotMatch(inline.prompt, /approved-motion\.json/);
      source.parts[0].paint.push({ kind: 'rect', x: 2, y: 3, w: 3, h: 5, color: 0 });
    }
    if (scenario === 'outside-mask') source.parts[0].paint.push({ kind: 'pixels', pixels: [{ x: 3, y: 3, color: 1 }] });
    if (scenario.startsWith('frame-edits')) source.frames[1].pixelEdits = [{ x: 4, y: 8, color: 1 }];
    const description = 'Fixture HTTP dựng từ ngữ cảnh thật';
    let proposal: unknown = { version: 1, description, recipe: source };
    if (scenario === 'reviewer-completed-character') {
      proposal = { version: 1, description, parts: source.parts.map((part: { id: string; paint: unknown[] }) => ({ partId: part.id, paint: part.paint })).reverse() };
    }
    if (files['approved-motion.json']) {
      assert.ok(inline.schema.properties.patches);
      assert.equal(inline.schema.properties.recipe, undefined);
      const patches = scenario === 'outside-mask' ? [{ partId: source.parts[0].id, paint: source.parts[0].paint }]
        : scenario.startsWith('frame-edits') ? [{ frameId: source.frames[1].id, pixelEdits: source.frames[1].pixelEdits }] : [];
      proposal = { version: 1, description, decision: patches.length ? 'patch' : 'keep', patches };
    }
    let output = scenario === 'repair' && count === 2 ? '{bad JSON' : JSON.stringify(proposal);
    if (scenario === 'empty-json' && count === 2) output = ' \t';
    if (scenario === 'empty-stream') output = '';
    if (scenario === 'fence') output = '```json\n' + output + '\n```';
    const wire = [JSON.stringify({ model: DEEPSEEK_MODEL, choices: [{ delta: { content: output }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), JSON.stringify({ choices: [], usage: { prompt_tokens: 19, completion_tokens: 13 } }), '[DONE]']
      .map(e => `data: ${e}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (init!.signal!.aborted) { c.error(Error('fixture request aborted')); return; }
      if (offset >= bytes.length) c.close(); else { c.enqueue(bytes.slice(offset, offset + 257)); offset += 257; } } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch };
}
