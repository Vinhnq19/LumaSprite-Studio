import { join } from 'node:path';
// User-selected app profile; per-invocation flags never change CLI/global config.
export const ANTIGRAVITY_MODEL = 'gemini-3.8-flash-high';
export const ANTIGRAVITY_EFFORT = 'high';

/** Conservative UTF-16 bound including Windows argv quoting. Keep margin below
 * CreateProcess's32767 limit; never truncate the actual prompt. */
function commandLength(parts: string[]): number {
  return parts.reduce((n, p) => n + p.length + (p.match(/[\\"]/g)?.length ?? 0) + 3, 0);
}
export function antigravityArgs(input: { executable: string; prefix?: string[]; prompt: string; work: string; schemaPath: string; schema: string; images: string[]; timeoutMins: number; contextFiles?: string[] }): string[] {
  const images = input.images.length
    ? `Reference images in this copied context (view only if needed): ${input.images.map(name => JSON.stringify(join(input.work, name))).join(', ')}.`
    : 'No reference image files are provided. No image-viewing tool is needed.';
  const end = `Authoritative response JSON schema, supplied in full here; no schema-file lookup is needed:\n${input.schema}\n${images} Do not edit files, run commands, invoke subagents or browse. Return ONLY the JSON proposal required by this schema. The app validates JSON and renders all frames before accepting it.`;
  // Keep JSON envelopes and validate the proposal in AiManager. Supplying the
  // complete schema avoids a separate schema-file tool lookup.
  const args = (text: string) => ['--print', text, '--output-format', 'json', '--print-timeout', `${input.timeoutMins}m`, '--model', ANTIGRAVITY_MODEL, '--effort', ANTIGRAVITY_EFFORT, '--mode', 'auto', '--dangerously-skip-permissions', '--disable-slash-commands'];
  const context = input.contextFiles?.length ? `The request and schema follow inline. You MUST read these copied context files using read-only tools: ${input.contextFiles.map(name => JSON.stringify(join(input.work, name))).join(', ')}. Use only this context; do not search the real project.\n` : 'The complete request, source context and schema follow inline. No file-reading tools are needed for them.\n';
  const direct = args(`${context}${input.prompt}\n${end}`);
  if (commandLength([input.executable, ...input.prefix ?? [], ...direct]) <= 24000) return direct;
  // Long source/reference contexts are already written in full by AiManager.
  // An absolute path avoids depending on the CLI's selected project directory.
  const file = args(`Read the complete request at absolute path ${JSON.stringify(join(input.work, 'request.md'))} using the file-reading tool. ${context}Use only that copied context; no project search is needed. ${end}`);
  if (commandLength([input.executable, ...input.prefix ?? [], ...file]) > 24000) throw new Error('Tham số CLI vượt giới hạn an toàn; rút ngắn đường dẫn hoặc cấu hình launcher.');
  return file;
}

export function antigravityResponse(output: string): string {
  const envelope = JSON.parse(output.replace(/^\uFEFF/, ''));
  if (envelope.status !== 'SUCCESS' || envelope.denied_actions?.length) throw new Error(envelope.error ?? JSON.stringify(envelope.denied_actions ?? envelope));
  const response = envelope.structured_output ?? envelope.response;
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && !Array.isArray(response)) return JSON.stringify(response);
  throw new Error('CLI chưa trả nội dung đề xuất JSON.');
}
