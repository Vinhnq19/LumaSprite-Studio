import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deepSeekConfigured, startDeepSeekRequest, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL, type DeepSeekSettings } from '../src/node/studio/deepseek-http.ts';

const key = 'fixture-secret-never-expose-824190';
const request = () => ({ prompt: 'Vẽ lọ thuốc', schema: { type: 'object' }, context: { palette: ['#ffffffff'] }, budgetMs: 2000 });
const event = (content: string, finish_reason: string | null = null) => JSON.stringify({ model: 'deepseek-v4.1-flash-1017', choices: [{ index: 0, delta: { content }, finish_reason }] });
const sse = (...events: string[]) => events.map(e => `data: ${e}\n\n`).join('');
const success = (output = '{"description":"Hiệp sĩ"}') => sse(event(output), event('', 'stop'), '[DONE]');
function fake(text: string, chunkSize = 37): { settings: DeepSeekSettings; calls: { url: unknown; init: RequestInit }[]; canceled: () => number } {
  const calls: { url: unknown; init: RequestInit }[] = []; let canceled = 0;
  const bytes = new TextEncoder().encode(text);
  return { calls, canceled: () => canceled, settings: { apiKey: key, fetch: (async (url, init) => {
    calls.push({ url, init: init! }); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset < bytes.length) { c.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize; } else c.close(); }, cancel() { canceled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch } };
}

test('DeepSeek: local configuration performs no calls; one text-only request carries fixed model, inline context/schema and auth header', async () => {
  const f = fake(success()), input = request(), before = structuredClone(input);
  assert.equal(deepSeekConfigured(f.settings), true); assert.equal(deepSeekConfigured({ apiKey: '' }), false); assert.equal(f.calls.length, 0);
  const task = startDeepSeekRequest(input, f.settings), result = await task.promise;
  assert.deepEqual(input, before); assert.equal(result.output, '{"description":"Hiệp sĩ"}'); assert.equal(result.transport, 'http'); assert.equal(result.model, 'deepseek-v4.1-flash-1017'); assert.deepEqual(result.usage, { unavailable: true });
  assert.equal(f.calls.length, 1); const { url, init } = f.calls[0]; assert.equal(url, DEEPSEEK_BASE_URL + '/chat/completions');
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer ' + key); assert.equal(init.redirect, 'error');
  const payload = JSON.parse(init.body as string); assert.equal(payload.model, 'deepseek-v4.1-flash-1017'); assert.equal(payload.stream, true);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.tools, undefined); assert.equal(payload.response_format, undefined); assert.equal(payload.tool_choice, undefined);
  const inline = JSON.parse(payload.messages[1].content); assert.deepEqual(inline, { prompt: input.prompt, schema: input.schema, context: input.context });
  assert.ok(!(init.body as string).includes(key)); assert.equal(await task.stop(Date.now() + 10), true);
});

test('DeepSeek: stream counters distinguish reasoning from JSON without retaining reasoning text', async () => {
  const hidden = 'private reasoning ' + key;
  const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: hidden }, finish_reason: null }] });
  const output = '{"ok":true}', wire = sse(reasoning, event(output), event('', 'stop'), '[DONE]');
  const result = await startDeepSeekRequest(request(), fake(wire, 1).settings).promise;
  assert.deepEqual(result.streamStats, { events: 4, wireBytes: Buffer.byteLength(wire), contentBytes: Buffer.byteLength(output), reasoningBytes: Buffer.byteLength(hidden) });
  assert.equal(result.output, output);
  assert.ok(!JSON.stringify(result).includes(hidden) && !JSON.stringify(result).includes(key));
});

test('DeepSeek: non-stop finish records safe diagnostics and never returns partial text', async () => {
  for (const [finish, label] of [['length', 'length'], [key, 'khác']]) {
    const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: key }, finish_reason: null }] });
    const partial = '{"partial":';
    const fixture = fake(sse(reasoning, event(partial, finish), '[DONE]'), 1);
    await assert.rejects(startDeepSeekRequest(request(), fixture.settings).promise, error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`finish_reason=${label}`));
      assert.ok(error.message.includes(`${Buffer.byteLength(partial)} byte nội dung`));
      assert.ok(error.message.includes(`${Buffer.byteLength(key)} byte suy luận`));
      assert.ok(!error.message.includes(key) && !error.message.includes(partial));
      return true;
    });
    assert.equal(fixture.calls.length, 1);
  }
});

test('DeepSeek: explicit low reasoning changes only its request and performs no fallback', async () => {
  const f = fake(success());
  const result = await startDeepSeekRequest({ ...request(), reasoningEffort: 'low' }, f.settings).promise;
  assert.equal(result.output, '{"description":"Hiệp sĩ"}');
  const payload = JSON.parse(f.calls[0].init.body as string);
  assert.equal(payload.model, DEEPSEEK_MODEL);
  assert.equal(payload.reasoning_effort, 'low');
  assert.equal(payload.max_tokens, 32768);
  assert.equal(f.calls.length, 1);
  assert.throws(() => startDeepSeekRequest({ ...request(), reasoningEffort: 'other' as 'low' }, f.settings), /suy luận/);
  assert.equal(f.calls.length, 1);
});

test('DeepSeek: byte-split Unicode, CRLF, comments, multiline data, terminal usage and invalid proposal JSON stay separate from transport parsing', async () => {
  const first = event('not proposal JSON · đuôi 🦊').replace(',"choices"', ',\n"choices"');
  const wire = ': keepalive\r\nevent: message\r\ndata: ' + first.replace(/\n/g, '\r\ndata: ') + '\r\n\r\n' + sse(event('', 'stop'), JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 15, prompt_cache_hit_tokens: 8 } }), '[DONE]');
  const result = await startDeepSeekRequest(request(), fake(wire, 1).settings).promise;
  assert.equal(result.output, 'not proposal JSON · đuôi 🦊'); assert.deepEqual(result.usage, { input: 42, output: 15, cached: 8 });
});

test('DeepSeek: whitespace reaches JSON validation, but refusal and credential data stop at transport', async () => {
  const empty = fake(sse(event(' \t'), event('', 'stop'), JSON.stringify({ choices: [], usage: { completion_tokens: 21 } }), '[DONE]'));
  const result = await startDeepSeekRequest(request(), empty.settings).promise;
  assert.equal(result.output.trim(), '');
  assert.deepEqual(result.usage, { output: 21 });
  assert.equal(empty.calls.length, 1);

  const refusal = fake(sse(JSON.stringify({ choices: [{ delta: { refusal: key }, finish_reason: 'stop' }] }), '[DONE]'));
  await assert.rejects(startDeepSeekRequest(request(), refusal.settings).promise, error => error instanceof Error && /từ chối/.test(error.message) && !error.message.includes(key));
  const sensitive = fake(success(key));
  await assert.rejects(startDeepSeekRequest(request(), sensitive.settings).promise, error => error instanceof Error && /dữ liệu nhạy cảm.*chặn/.test(error.message) && !error.message.includes(key));
  assert.equal(refusal.calls.length, 1);
  assert.equal(sensitive.calls.length, 1);
});

test('DeepSeek: empty deltas reporting completion tokens fail transport without becoming a proposal or retrying', async () => {
  for (const outputTokens of [256, 32768]) {
    const wire = sse(
      JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: outputTokens } }),
      '[DONE]',
    );
    const f = fake(wire, 1), task = startDeepSeekRequest(request(), f.settings);
    await assert.rejects(task.promise, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DeepSeek API.*không trả nội dung.*Không tự gọi lại/);
      assert.ok(error.message.includes(`usage đầu ra: ${outputTokens}`));
      assert.ok(!error.message.includes(key));
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(await task.stop(Date.now() + 50), true);
  }
});

test('DeepSeek: validation rejects missing key, invalid budget, cyclic context and oversized request before I/O', () => {
  const f = fake(success());
  assert.throws(() => startDeepSeekRequest(request(), { ...f.settings, apiKey: ' ' }), /PXL_DEEPSEEK_API_KEY/);
  for (const budgetMs of [0, -1, NaN, Infinity, 300001]) assert.throws(() => startDeepSeekRequest({ ...request(), budgetMs }, f.settings), /giới hạn/);
  const cycle: any = {}; cycle.self = cycle;
  assert.throws(() => startDeepSeekRequest({ ...request(), context: cycle }, f.settings), /JSON/);
  assert.throws(() => startDeepSeekRequest({ ...request(), context: 'x'.repeat(1_048_576) }, f.settings), /1 MiB/);
  assert.throws(() => startDeepSeekRequest({ ...request(), prompt: 'x'.repeat(250001) }, f.settings), /giới hạn/); assert.equal(f.calls.length, 0);
});

test('DeepSeek: HTTP failures never retry or echo bodies/keys; raw fetch exceptions are sanitized', async () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    let calls = 0, drained = false;
    const fetcher = (async () => { calls++; return new Response(new ReadableStream({ cancel() { drained = true; } }), { status, headers: { 'content-type': 'text/plain' } }); }) as typeof fetch;
    const task = startDeepSeekRequest(request(), { apiKey: key, fetch: fetcher });
    await assert.rejects(task.promise, e => e instanceof Error && e.message.includes(String(status)) && !e.message.includes(key)
      && (status !== 402 || e.message.includes('khóa Studio trên LiteRouter')));
    assert.equal(calls, 1); assert.equal(drained, true); assert.equal(await task.stop(Date.now() + 10), true);
  }
  await assert.rejects(startDeepSeekRequest(request(), { apiKey: key, fetch: (async () => { throw Error('Authorization Bearer ' + key); }) as typeof fetch }).promise, e => e instanceof Error && !e.message.includes(key) && !e.message.includes('Authorization'));
});

test('DeepSeek: LiteRouter HTTP 400 exposes only recognized structured reasons', async () => {
  for (const [error, expected] of [
    [{ code: 'model_not_found' }, /không tìm thấy model/],
    [{ code: 'invalid_parameter' }, /tham số yêu cầu/],
    [{ status_code: '402' }, /Mã upstream HTTP 402/],
    [{ code: 'private-unrecognized-reason' }, /không có mã nguyên nhân nhận diện được/],
    [{ code: 'model_not_found', oversized: 'x'.repeat(16_384) }, /không có mã nguyên nhân nhận diện được/],
  ] as const) {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ error: { ...error, message: key } }, { status: 400 });
    }) as typeof fetch;
    const task = startDeepSeekRequest(request(), { apiKey: key, fetch: fetcher });
    await assert.rejects(task.promise, e => e instanceof Error && /HTTP 400/.test(e.message) && expected.test(e.message)
      && !e.message.includes(key) && !e.message.includes('private-unrecognized-reason'));
    assert.equal(calls, 1);
    assert.equal(await task.stop(Date.now() + 50), true);
  }
});

test('DeepSeek: HTTP 403 distinguishes an HTML gateway response and recognized model permission errors', async () => {
  for (const [response, hint] of [
    [new Response(`<html>${key}</html>`, { status: 403, headers: { 'content-type': 'text/html' } }), /trang HTML/],
    [new Response(`<html>${key}</html>`, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }), /Cloudflare đang yêu cầu kiểm tra trình duyệt/],
    [Response.json({ error: { code: 'model_access_denied', message: key } }, { status: 403 }), /không có quyền dùng model/],
  ] as const) {
    let calls = 0;
    const fetcher = (async () => { calls++; return response; }) as typeof fetch;
    const task = startDeepSeekRequest(request(), { apiKey: key, fetch: fetcher });
    await assert.rejects(task.promise, e => e instanceof Error && e.message.includes('HTTP 403')
      && hint.test(e.message) && !e.message.includes(key) && !e.message.includes('<html>'));
    assert.equal(calls, 1);
    assert.equal(await task.stop(Date.now() + 50), true);
  }
});

test('DeepSeek: malformed/truncated streams, abnormal finish and tool calls cannot become proposals', async () => {
  const streams = [
    sse('not JSON'), sse(event('{}')), sse(event('{}'), '[DONE]'), sse(event('{}', 'length'), '[DONE]'),
    sse(event('{}', 'content_filter'), '[DONE]'), sse(JSON.stringify({ error: { message: key } })),
    sse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'write' } }] } }] })),
    sse(JSON.stringify({ choices: [{ delta: { content: [key] } }] })),
    sse(event('{}', 'stop'), event('late'), '[DONE]'), success(key),
  ];
  for (const stream of streams) {
    const f = fake(stream); await assert.rejects(startDeepSeekRequest(request(), f.settings).promise, e => e instanceof Error && !e.message.includes(key)); assert.equal(f.calls.length, 1);
  }
  const f = fake(success()); f.settings.fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  await assert.rejects(startDeepSeekRequest(request(), f.settings).promise, /SSE/);
});

test('DeepSeek: DONE before stop reports byte counts without exposing content or retrying', async () => {
  for (const output of ['', '{"private":"nội dung thử nghiệm"}']) {
    const f = fake(sse(event(output), '[DONE]'));
    const task = startDeepSeekRequest(request(), f.settings);
    await assert.rejects(task.promise, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /finish_reason=stop: chưa/);
      assert.ok(error.message.includes(`${Buffer.byteLength(output)} byte nội dung`));
      assert.ok(!error.message.includes('private') && !error.message.includes('thử nghiệm') && !error.message.includes(key));
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(await task.stop(Date.now() + 10), true);
  }
});

test('DeepSeek: EOF after a complete stop event can omit DONE, but partial events and JSON still fail', async () => {
  const ended = sse(event('{"name":"Lọ thuốc"}'), event('', 'stop'));
  const f = fake(ended, 1);
  const result = await startDeepSeekRequest(request(), f.settings).promise;
  assert.equal(result.output, '{"name":"Lọ thuốc"}');
  assert.deepEqual(result.usage, { unavailable: true });
  assert.equal(f.calls.length, 1);

  for (const wire of [ended + 'data: [DONE]', ended + 'data: {"error":\n', ended + 'event: error\n', sse(event('{"name":', 'stop'))]) {
    await assert.rejects(startDeepSeekRequest(request(), fake(wire, 1).settings).promise, /bị cắt/);
  }
  const partialUtf8 = new Response(Buffer.concat([Buffer.from(ended), Buffer.from([0xf0, 0x9f])]), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(startDeepSeekRequest(request(), { apiKey: key, fetch: async () => partialUtf8 }).promise, /bị cắt/);
});

test('DeepSeek: distinguishes SSE errors without exposing the provider response or retrying', async () => {
  const cases = [
    [[], 'DeepSeek API trả event SSE không phải object.'],
    [{ id: key }, 'DeepSeek API trả event SSE thiếu mảng choices hợp lệ.'],
  ] as const;
  for (const [payload, message] of cases) {
    const f = fake(sse(JSON.stringify(payload)));
    await assert.rejects(startDeepSeekRequest(request(), f.settings).promise, { message });
    assert.equal(f.calls.length, 1);
  }
  for (const [metadata, expected] of [
    [{}, /Mã upstream không xác định/],
    [{ code: 'insufficient_quota' }, /Mã upstream HTTP 429/],
    [{ status_code: '402' }, /Mã upstream HTTP 402/],
    [{ type: 'arbitrary-private-value' }, /Mã upstream không xác định/],
  ] as const) {
    const f = fake(sse(JSON.stringify({ error: { ...metadata, message: key } })));
    await assert.rejects(startDeepSeekRequest(request(), f.settings).promise, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /báo lỗi trong luồng SSE.*Đã nhận HTTP 200, 1 event/);
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(key) && !error.message.includes('arbitrary-private-value'));
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('DeepSeek: stream I/O errors report safe diagnostics and preserve retry policy', async () => {
  const data = new TextEncoder().encode(sse(event('{"partial":')));
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    let first = true;
    return new Response(new ReadableStream({ pull(stream) {
      if (first) { first = false; stream.enqueue(data); }
      else stream.error(new TypeError(key, { cause: { code: 'UND_ERR_SOCKET' } }));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  await assert.rejects(startDeepSeekRequest(request(), { apiKey: key, fetch: fetcher }).promise,
    error => error instanceof Error && error.message.includes('kết nối bị đóng giữa chừng') && error.message.includes('finish_reason=stop: chưa') && !error.message.includes(key));
  assert.equal(calls, 1);
});

test('DeepSeek: output and wire budgets are independent; response model cannot expose the key', async () => {
  await assert.rejects(startDeepSeekRequest(request(), fake(success('x'.repeat(2_000_001)), 64 * 1024).settings).promise, /2 MB/);
  await assert.rejects(startDeepSeekRequest(request(), fake(':' + 'x'.repeat(8 * 1024 * 1024), 128 * 1024).settings).promise, /8 MiB/);
  const result = await startDeepSeekRequest(request(), fake(success().replaceAll('deepseek-v4.1-flash-1017', key)).settings).promise; assert.equal(result.model, undefined);
});

test('DeepSeek: cancellation before send prevents I/O; stream cancellation drains local work and discloses remote uncertainty', async () => {
  const before = fake(success()), early = startDeepSeekRequest(request(), before.settings);
  assert.equal(await early.stop(Date.now() + 1000), true); await assert.rejects(early.promise, /hủy/); assert.equal(before.calls.length, 0);
  let draining!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const drained = new Promise<void>(r => { draining = r; });
  const fetcher = (async () => { entered(); return new Response(new ReadableStream({ cancel() { draining(); } }), { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch;
  const active = startDeepSeekRequest(request(), { apiKey: key, fetch: fetcher }); await ready; await new Promise(r => setTimeout(r, 0));
  assert.equal(await active.stop(Date.now() + 1000), true); await drained; await assert.rejects(active.promise, /hủy/); assert.match(active.diagnostic!(), /chưa xác nhận nhà cung cấp/);
});

test('DeepSeek: timeout aborts/drains; uncooperative fetch stays unknown until its late result is discarded', async () => {
  let aborted = false;
  const fetcher = ((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(Error(key)); }, { once: true }))) as typeof fetch;
  await assert.rejects(startDeepSeekRequest({ ...request(), budgetMs: 20 }, { apiKey: key, fetch: fetcher }).promise,
    /vượt thời gian.*chưa nhận header HTTP/); assert.equal(aborted, true);
  let release!: (r: Response) => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const late = startDeepSeekRequest(request(), { apiKey: key, fetch: (() => { entered(); return new Promise<Response>(r => { release = r; }); }) as typeof fetch });
  await ready; assert.equal(await late.stop(Date.now() + 20), false); assert.match(late.diagnostic!(), /chưa xác nhận kết thúc/);
  release(new Response(success(), { headers: { 'content-type': 'text/event-stream' } })); await assert.rejects(late.promise, /hủy/); assert.equal(await late.stop(Date.now() + 20), true);
});

test('DeepSeek: timeout during an idle stream reports numeric progress without returning a partial proposal', async () => {
  const partial = 'nội dung riêng của đề xuất';
  const wire = new TextEncoder().encode(sse(event(partial)));
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(wire); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const task = startDeepSeekRequest({ ...request(), budgetMs: 50 }, { apiKey: key, fetch: fetcher });
  await assert.rejects(task.promise, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /vượt thời gian.*Đã nhận HTTP 200, 1 event/);
    assert.ok(error.message.includes(`${wire.byteLength} byte SSE, ${Buffer.byteLength(partial)} byte nội dung`));
    assert.ok(!error.message.includes(partial) && !error.message.includes(key));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(await task.stop(Date.now() + 50), true);
});

test('DeepSeek: native fetch handles byte-split SSE and distinguishes socket loss before and after stop', async () => {
  let calls = 0;
  const output = '{"name":"Pháp sư 🦊"}';
  const server = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.headers.authorization !== 'Bearer ' + key || payload.model !== DEEPSEEK_MODEL) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url !== '/normal') {
      const wire = req.url === '/after-stop' ? sse(event(output), event('', 'stop')) : sse(event(output));
      res.write(wire, () => setTimeout(() => res.destroy(), 25));
      return;
    }
    const bytes = Buffer.from(success(output));
    for (let i = 0; i < bytes.length; i += 2) res.write(bytes.subarray(i, i + 2)); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const nativeFetch = globalThis.fetch;
  try {
    const send = (path: string) => startDeepSeekRequest(request(), { apiKey: key, fetch: (url, init) => {
      assert.equal(url, DEEPSEEK_BASE_URL + '/chat/completions');
      return nativeFetch(`http://127.0.0.1:${address.port}${path}`, init);
    } }).promise;
    assert.equal((await send('/normal')).output, output);
    assert.equal((await send('/after-stop')).output, output);
    await assert.rejects(send('/before-stop'), /finish_reason=stop: chưa/);
    assert.equal(calls, 3);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
