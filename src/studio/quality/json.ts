/** Exactly one complete JSON object. Wrappers are syntax, never guessed out of prose. */
export function parseQualityJson(text: string, maxBytes = 2_000_000): Record<string, unknown> {
  if (typeof text !== 'string') throw new Error('Kết quả AI phải là chuỗi JSON.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_000_000) throw new Error('Giới hạn JSON phải từ 1 đến 2.000.000 byte.');
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Kết quả JSON vượt giới hạn byte.');
  let body = text.trim();
  if (!body) throw new Error('AI không trả nội dung JSON đề xuất.');
  if (body.startsWith('```')) {
    const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body);
    if (!match) throw new Error('Chỉ nhận một JSON hoàn chỉnh hoặc một khối Markdown JSON.');
    body = match[1].trim();
  }
  let depth = 0, string = false, escaped = false;
  for (const c of body) {
    if (string) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') string = false; }
    else if (c === '"') string = true;
    else if (c === '{' || c === '[') { if (++depth > 64) throw new Error('JSON lồng quá 64 cấp.'); }
    else if (c === '}' || c === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error('JSON không hoàn chỉnh, nhiều kết quả hoặc có lời giải thích lẫn ngoài.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kết quả phải là một object JSON.');
  return value as Record<string, unknown>;
}
