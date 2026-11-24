import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, type DeepSeekSettings } from '../../src/node/studio/deepseek-http.ts';
import { qualityHttpFixture } from './quality-http.ts';

/** Offline fixture for Studio HTTP integration and browser tests; never opens a socket. */
export function fastHttpFixture(stateDir: string): DeepSeekSettings {
  const quality = qualityHttpFixture('valid', join(stateDir, 'fixture-quality-calls.jsonl'));
  return { apiKey: 'studio-http-fixture-never-real', fetch: (async (url, init) => {
    assert.equal(url, DEEPSEEK_BASE_URL + '/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, DEEPSEEK_MODEL); assert.equal(body.stream, true);
    assert.equal(body.tools, undefined); assert.equal(body.response_format, undefined);
    const inline = JSON.parse(body.messages[1].content), input = inline.prompt as string;
    assert.equal(typeof input, 'string');
    const signal = init!.signal!;
    const alt = Number(input.match(/ALTERNATIVE:\s*(\d+)/)?.[1] ?? 1);
    const calls = input.includes('Your previous response failed validation:') ? 2 : 1;
    const guidance = input.match(/PIXEL CRAFT GUIDANCE \(([^,]+), ([^)]+)\):/);
    appendFileSync(join(stateDir, 'fixture-cli-calls.jsonl'), JSON.stringify({ provider: 'deepseek', transport: 'http', alternative: alt, call: calls,
      ...(guidance ? { guidanceId: guidance[1], guidanceTopic: guidance[2], guidanceDigest: createHash('sha256').update(input.slice(guidance.index).split('\nEND PIXEL CRAFT GUIDANCE')[0]).digest('hex') } : {}) }) + '\n');
    if (/\bFIXTURE_HANG\b|FIXTURE_QUALITY_HANG/.test(input) || input.includes(`FIXTURE_HANG_${alt}`)) {
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(Error('fixture aborted'));
        else signal.addEventListener('abort', () => reject(Error('fixture aborted')), { once: true });
      });
    }
    if (inline.context?.files?.['source-recipe.json']) return quality.fetch!(url, init);
    if (input.includes('FIXTURE_ERROR')) return new Response('', { status: 429 });
    if (alt === 2 && /FIXTURE_SECOND_FAILS|FIXTURE_FAIL_2/.test(input)) {
      const marker = join(stateDir, 'pxl-fixture-alt2-fail-once');
      if (/FAIL_ONCE|RETRY/.test(input) && existsSync(marker)) unlinkSync(marker);
      else { if (/FAIL_ONCE|RETRY/.test(input)) writeFileSync(marker, '1'); return new Response('', { status: 503 }); }
    }
    if (input.includes('FIXTURE_DELAY')) await new Promise(r => setTimeout(r, 100));
    const colors = ['#70c989', '#3b82f6', '#ef4444'], color = colors[(alt - 1) % 3];
    let w = 32, h = 32;
    const target = input.match(/Target canvas: (\d+)x(\d+)/);
    if (target) { w = Number(target[1]); h = Number(target[2]); }
    assert.ok(Number.isInteger(w) && w > 0 && w <= 4096 && Number.isInteger(h) && h > 0 && h <= 4096);
    const x = Math.floor(w / 2), y = Math.floor(h / 2);
    let paint = `rect(${Math.max(0, x - 2)},${Math.max(0, y - 2)},${Math.min(4, w)},${Math.min(4, h)},'${color}'),px(${x},${y},'#ffffff')`;
    if (/\bFIXTURE_EMPTY\b/.test(input)) paint = '';
    if (input.includes('FIXTURE_OUTSIDE')) paint = "px(0,0,'#123456')";
    if (input.includes('FIXTURE_ALPHA')) paint = "px(0,0,'#12345680')";
    if (input.includes('FIXTURE_MANY_COLORS')) paint = Array.from({ length: 17 }, (_, i) => `px(${i % w},${Math.floor(i / w)},'#${(0x010101 + i).toString(16).padStart(6, '0')}')`).join(',');
    let source = `sprite('canvas',{w:${w},h:${h}${input.includes('FIXTURE_OUTLINE') ? ",outline:'#172333'" : ''}}${paint ? ',' + paint : ''})`;
    if (input.includes('FIXTURE_LATE_FRAME_REPAIR') || input.includes('FIXTURE_LATE_FRAME_INVALID')) {
      const bad = input.includes('FIXTURE_LATE_FRAME_INVALID') || calls === 1;
      source = `pal({a:'#70c989'})\nanim('canvas',{w:32,h:32},frame({ms:100},px(1,1,'a')),frame({ms:100},px(2,1,'${bad ? 'missing' : 'a'}')))`;
    }
    if (input.includes('FIXTURE_EMPTY_ALWAYS') || (input.includes('FIXTURE_EMPTY_REPAIR') && calls === 1)) source = "sprite('canvas',{w:32,h:32},()=>{rect(1,1,10,10,'#70c989')})";
    if ((/FIXTURE_SOURCE_REPAIR|FIXTURE_REPAIR/.test(input) || (alt === 2 && /FIXTURE_SECOND_REPAIR|FIXTURE_REPAIR_2/.test(input))) && calls === 1) source = 'not valid pixel art javascript (';
    if (input.includes('FIXTURE_RESIZE')) source = source.replace('w:32,h:32', 'w:16,h:32');
    const proposal: Record<string, unknown> = { description: `fixture alt=${alt}; calls=${calls}; preview=false; source=${input.includes('SOURCE_REFERENCE_MARKER')}; refs=0`, files: [{ path: 'art.px.js', content: source }] };
    if (inline.schema.properties.manifest) proposal.manifest = null;
    if (input.includes('FIXTURE_MANIFEST_VALID')) proposal.manifest = {
      version: 1, palette: { name: 'star-palette', colors: ['#70c989', '#ffffff'], ramps: null }, materials: [{ name: 'star-body', colors: ['#70c989'] }],
      parts: [{ name: 'core', box: { x: 8, y: 8, w: 16, h: 16 } }], landmarks: [{ name: 'center', x: 16, y: 16 }],
    };
    else if (input.includes('FIXTURE_MANIFEST_REPAIR')) proposal.manifest = calls === 1
      ? { version: 1, palette: null, materials: null, parts: [{ name: 'out-of-bounds', box: { x: 100, y: 100, w: 20, h: 20 } }], landmarks: null }
      : { version: 1, palette: { name: 'repaired-palette', colors: ['#70c989'], ramps: null }, materials: null, parts: [{ name: 'repaired-core', box: { x: 8, y: 8, w: 16, h: 16 } }], landmarks: null };
    else if (input.includes('FIXTURE_MANIFEST_INVALID')) proposal.manifest = { version: 1, palette: null, materials: null, parts: [{ name: 'bad-bounds', box: { x: -5, y: -5, w: 10, h: 10 } }], landmarks: null };
    const wire = [JSON.stringify({ model: DEEPSEEK_MODEL, choices: [{ delta: { content: JSON.stringify(proposal) }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 23 } }), '[DONE]'].map(e => `data: ${e}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    return new Response(new ReadableStream({ pull(c) {
      if (signal.aborted) { c.error(Error('fixture aborted')); return; }
      if (offset >= bytes.length) c.close(); else { c.enqueue(bytes.subarray(offset, offset + 127)); offset += 127; }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch };
}
