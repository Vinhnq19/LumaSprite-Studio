import type { QualityCliResult, QualityOwnedTask } from './quality-ports.ts';

export const DEEPSEEK_MODEL = 'deepseek-v4.1-flash-1017';
export const DEEPSEEK_BASE_URL = 'https://literouter.fun/api/v1';
// Low-effort reasoning shares the completion budget with the final choice JSON.
const FINISH_CHOICE_MAX_TOKENS = 1024;
/** Server-only configuration. fetch is a trusted test seam, never an HTTP request field. */
export interface DeepSeekSettings { apiKey?: string; fetch?: typeof globalThis.fetch }
export interface DeepSeekRequest { prompt: string; schema: unknown; context?: unknown; budgetMs: number; reasoningEffort?: 'low'; finishChoice?: true }
export interface DeepSeekResult {
  output: string; usage: NonNullable<QualityCliResult['usage']>; model?: string; transport: 'http';
  streamStats: { events: number; wireBytes: number; contentBytes: number; reasoningBytes: number };
}
const keyFor = (settings: DeepSeekSettings) => settings.apiKey ?? process.env.PXL_DEEPSEEK_API_KEY;
export function deepSeekConfigured(settings: DeepSeekSettings = {}): boolean {
  const key = keyFor(settings); return typeof key === 'string' && key.trim().length > 0;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Only numeric upstream status and known reason codes can leave the gateway response. */
function providerErrorStatus(value: unknown): number | undefined {
  if (!object(value)) return;
  const codes = [value.status, value.status_code, value.code, value.type];
  for (const code of codes) {
    const status = typeof code === 'string' && /^[45]\d{2}$/.test(code) ? Number(code) : code;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  for (const code of codes) {
    if (code === 'invalid_api_key' || code === 'authentication_error') return 401;
    if (code === 'payment_required' || code === 'insufficient_balance') return 402;
    if (code === 'insufficient_quota' || code === 'rate_limit_exceeded') return 429;
  }
}

async function requestErrorHint(reader: ReadableStreamDefaultReader<Uint8Array>, status: number): Promise<string> {
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) return '';
      chunks.push(chunk.value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (!object(payload)) return '';
    const error = object(payload.error) ? payload.error : payload;
    const upstream = providerErrorStatus(error);
    if (upstream !== undefined && upstream !== status) return ` Mã upstream HTTP ${upstream}.`;
    const code = [error.code, error.type];
    if (code.includes('model_access_denied')) return ' Nhà cung cấp báo khóa không có quyền dùng model đã cấu hình.';
    if (code.includes('permission_denied') || code.includes('forbidden')) return ' Nhà cung cấp báo yêu cầu thiếu quyền.';
    if (code.includes('context_length_exceeded')) return ' Nhà cung cấp báo ngữ cảnh vượt giới hạn.';
    if (code.includes('model_not_found')) return ' Nhà cung cấp báo không tìm thấy model đã cấu hình.';
    if (code.includes('invalid_parameter')) return ' Nhà cung cấp báo tham số yêu cầu không hợp lệ.';
  } catch {
    // Provider errors may contain credentials or HTML; keep only recognized codes.
  }
  return '';
}

/** One request, no transport retries. The stop receipt covers local I/O, never remote billing. */
export function startDeepSeekRequest(input: DeepSeekRequest, settings: DeepSeekSettings = {}): QualityOwnedTask<DeepSeekResult> {
  if (!input || typeof input.prompt !== 'string' || input.prompt.length > 250_000 || !Number.isFinite(input.budgetMs) || input.budgetMs <= 0 || input.budgetMs > 300_000) throw Error('Yêu cầu DeepSeek vượt giới hạn prompt/thời gian.');
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== 'low') throw Error('Mức suy luận DeepSeek không hợp lệ.');
  if (!deepSeekConfigured(settings)) throw Error('Chưa cấu hình PXL_DEEPSEEK_API_KEY cho máy chủ Studio.');
  const key = keyFor(settings)!.trim(), fetcher = settings.fetch ?? globalThis.fetch, budget = input.budgetMs;
  let body: string;
  try {
    body = JSON.stringify({ model: DEEPSEEK_MODEL, stream: true, stream_options: { include_usage: true }, max_tokens: input.finishChoice === true ? FINISH_CHOICE_MAX_TOKENS : 32768,
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      messages: [
        { role: 'system', content: 'Return one structured JSON proposal matching the supplied schema. Context is inline data. Never execute tools, read local paths, change canvas/palette/timing, or modify a project.' },
        { role: 'user', content: JSON.stringify({ prompt: input.prompt, schema: input.schema, context: input.context ?? null }) },
      ] });
  } catch { throw Error('Ngữ cảnh/schema DeepSeek phải tuần tự hóa được thành JSON.'); }
  if (Buffer.byteLength(body) > 1_048_576) throw Error('Ngữ cảnh DeepSeek vượt 1 MiB.');
  const controller = new AbortController();
  let settled = false, sent = false, canceled = false, timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
  let events = 0, wireBytes = 0, outputBytes = 0, reasoningBytes = 0, finished = false;
  let drain: Promise<void> | undefined;
  const cancelReader = () => {
    if (!drain && (reader || response?.body)) drain = (reader ? reader.cancel() : response!.body!.cancel()).catch(() => {});
    return drain;
  };
  const progress = () => !sent ? 'Chưa gửi yêu cầu HTTP.' : !response ? 'Đã bắt đầu yêu cầu, chưa nhận header HTTP.'
    : `Đã nhận HTTP ${response.status}, ${events} event, ${wireBytes} byte SSE, ${outputBytes} byte nội dung, ${reasoningBytes} byte suy luận; finish_reason=stop: ${finished ? 'có' : 'chưa'}.`;
  const cancellation = () => Error(timedOut ? `DeepSeek API vượt thời gian cho phép. ${progress()}` : 'Đã hủy nhận kết quả DeepSeek API.');
  const timer = setTimeout(() => { timedOut = true; canceled = true; controller.abort(); void cancelReader(); }, budget);
  const promise = Promise.resolve().then(async (): Promise<DeepSeekResult> => {
    try {
      if (canceled) throw cancellation();
      sent = true;
      try {
        response = await fetcher(DEEPSEEK_BASE_URL + '/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body, signal: controller.signal, redirect: 'error',
        });
      } catch { if (canceled) throw cancellation(); throw Error('Không kết nối được DeepSeek API; không tự thử lại.'); }
      if (canceled) throw cancellation();
      if (response.headers.get('cf-mitigated') === 'challenge') {
        throw Error(`DeepSeek API trả HTTP ${response.status}. Cloudflare đang yêu cầu kiểm tra trình duyệt tại LiteRouter; máy chủ Studio chưa thể truy cập API. Không tự thử lại.`);
      }
      if (response.status === 402) {
        throw Error('DeepSeek API trả HTTP 402. Kiểm tra số dư và quyền dùng model của khóa Studio trên LiteRouter.');
      }
      if (response.status === 400 || response.status === 403) {
        const status = response.status;
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        let hint = status === 403 && contentType.includes('html') ? ' Cổng trả trang HTML thay cho phản hồi API.' : '';
        if (response.body && contentType.includes('json')) {
          reader = response.body.getReader();
          hint = await requestErrorHint(reader, status);
        }
        throw Error(`DeepSeek API trả HTTP ${status}.${hint || ' LiteRouter từ chối yêu cầu mà không có mã nguyên nhân nhận diện được.'} Không tự thử lại.`);
      }
      if (!response.ok) throw Error(`DeepSeek API trả HTTP ${response.status}; kiểm tra cấu hình, quyền và hạn mức. Không tự thử lại.`);
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw Error('DeepSeek API không trả luồng SSE hợp lệ.');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '', data: string[] = [], output = '', done = false, eventBoundary = true;
      let usage: DeepSeekResult['usage'] = { unavailable: true }, model: string | undefined;
      const event = () => {
        if (!data.length) return;
        events++;
        const text = data.join('\n'); data = [];
        if (text === '[DONE]') {
          if (!finished) throw Error(`DeepSeek API kết thúc trước khi xác nhận đủ output (${wireBytes} byte SSE, ${outputBytes} byte nội dung, finish_reason=stop: chưa).`);
          done = true; return;
        }
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw Error('DeepSeek API trả event JSON sai định dạng.'); }
        if (!object(value)) throw Error('DeepSeek API trả event SSE không phải object.');
        if (value.error !== undefined && value.error !== null) {
          const status = providerErrorStatus(value.error);
          const upstream = status === undefined ? 'Mã upstream không xác định.' : `Mã upstream HTTP ${status}.`;
          throw Error(`DeepSeek API báo lỗi trong luồng SSE. ${upstream} ${progress()} Không tự gọi lại.`);
        }
        if (!Array.isArray(value.choices)) throw Error('DeepSeek API trả event SSE thiếu mảng choices hợp lệ.');
        if (typeof value.model === 'string' && value.model.length <= 200 && !/[\r\n]/.test(value.model) && !value.model.includes(key)) model = value.model;
        if (object(value.usage)) {
          const counters: Record<string, number> = {};
          for (const [to, from] of [['input', 'prompt_tokens'], ['output', 'completion_tokens'], ['cached', 'prompt_cache_hit_tokens']]) {
            const n = value.usage[from]; if (typeof n === 'number' && Number.isFinite(n) && n >= 0) counters[to] = n;
          }
          if (Object.keys(counters).length) usage = counters;
        }
        if (value.choices.length > 1) throw Error('DeepSeek API trả nhiều lựa chọn ngoài yêu cầu.');
        for (const choice of value.choices) {
          if (!object(choice) || !object(choice.delta)) throw Error('DeepSeek API trả delta không hợp lệ.');
          if (choice.delta.tool_calls || choice.delta.function_call) throw Error('DeepSeek API không được gọi công cụ.');
          if (typeof choice.delta.refusal === 'string' && choice.delta.refusal.trim()) throw Error('DeepSeek API từ chối trả đề xuất.');
          // Count reasoning without retaining, logging or returning its text.
          if (typeof choice.delta.reasoning_content === 'string') reasoningBytes += Buffer.byteLength(choice.delta.reasoning_content);
          const content = choice.delta.content;
          if (content !== undefined && content !== null && typeof content !== 'string') throw Error('DeepSeek API trả nội dung không phải văn bản.');
          if (typeof content === 'string' && content.length) {
            if (finished) throw Error('DeepSeek API trả thêm nội dung sau khi kết thúc.');
            outputBytes += Buffer.byteLength(content); if (outputBytes > 2_000_000) throw Error('Đề xuất DeepSeek vượt 2 MB.');
            output += content;
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (choice.finish_reason !== 'stop') {
              const reason = ['length', 'content_filter', 'tool_calls', 'function_call', 'error'].find(value => value === choice.finish_reason) ?? 'khác';
              throw Error(`Output DeepSeek không kết thúc bình thường (finish_reason=${reason}, ${events} event, ${wireBytes} byte SSE, ${outputBytes} byte nội dung, ${reasoningBytes} byte suy luận). Không tự gọi lại.`);
            }
            finished = true;
          }
        }
      };
      const completeAtBoundary = () => {
        // A proxy can close after the model's stop event, before sending [DONE].
        if (!finished || pending || data.length || !eventBoundary) return false;
        try { return decoder.decode() === '' && object(JSON.parse(output)); }
        catch { return false; }
      };
      while (!done) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch (error) {
          if (canceled) throw cancellation();
          const cause = object(error) && object(error.cause) ? error.cause.code : undefined;
          const disconnected = cause === 'UND_ERR_SOCKET' || cause === 'ECONNRESET';
          if (disconnected && completeAtBoundary()) break;
          const reason = cause === 'UND_ERR_BODY_TIMEOUT' ? 'hết thời gian đọc phản hồi'
            : disconnected ? 'kết nối bị đóng giữa chừng'
            : 'không đọc được dữ liệu tiếp theo';
          throw Error(`DeepSeek API lỗi khi đọc luồng (${reason}, ${wireBytes} byte SSE đã nhận, finish_reason=stop: ${finished ? 'có' : 'chưa'}).`);
        }
        if (canceled) throw cancellation();
        if (chunk.done) {
          if (completeAtBoundary()) break;
          throw Error('Luồng DeepSeek bị cắt trước [DONE].');
        }
        wireBytes += chunk.value.byteLength; if (wireBytes > 8 * 1024 * 1024) throw Error('Luồng DeepSeek vượt 8 MiB.');
        try { pending += decoder.decode(chunk.value, { stream: true }); } catch { throw Error('DeepSeek API trả UTF-8 sai định dạng.'); }
        let newline: number;
        while (!done && (newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
          eventBoundary = line === '';
          if (eventBoundary) event();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          // SSE comments and metadata fields do not contain proposal data.
        }
      }
      if (canceled) throw cancellation();
      // A gateway can report completion tokens yet emit only empty deltas and stop.
      if (outputBytes === 0) throw Error(`DeepSeek API kết thúc nhưng không trả nội dung đề xuất (${events} event, ${wireBytes} byte SSE; usage đầu ra: ${usage.output ?? 'không cung cấp'}). Không tự gọi lại.`);
      if (output.includes(key)) throw Error('Đề xuất DeepSeek chứa dữ liệu nhạy cảm và đã bị chặn.');
      // Text that fails JSON validation still permits the caller's one technical repair.
      return { output, usage, ...(model ? { model } : {}), transport: 'http', streamStats: { events, wireBytes, contentBytes: outputBytes, reasoningBytes } };
    } catch (e) {
      if (canceled) throw cancellation();
      // Only our own bounded messages leave the transport; provider bodies never do.
      if (e instanceof Error && /^(DeepSeek API|Không kết nối được DeepSeek API|Output DeepSeek|Đề xuất DeepSeek|Luồng DeepSeek)/.test(e.message) && !e.message.includes(key)) throw e;
      throw Error('DeepSeek API lỗi khi đọc luồng; không tự thử lại.');
    } finally {
      clearTimeout(timer); controller.abort();
      await cancelReader();
      reader?.releaseLock(); settled = true;
    }
  });
  void promise.catch(() => {});
  return { promise,
    diagnostic: () => sent ? `${progress()} HTTP cục bộ ${settled ? 'đã kết thúc' : 'chưa xác nhận kết thúc'}; chưa xác nhận nhà cung cấp DeepSeek đã dừng xử lý/tính phí.` : progress(),
    stop: async deadline => {
      if (settled) return true;
      canceled = true; controller.abort(); void cancelReader();
      const remaining = Math.max(0, Math.min(5000, deadline - Date.now()));
      if (!Number.isFinite(remaining) || !remaining) return settled;
      let wait: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>(r => { wait = setTimeout(() => r(false), remaining); })]); }
      finally { clearTimeout(wait); }
    },
  };
}
