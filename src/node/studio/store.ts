import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { StudioDiagnostic, StudioErrorCode } from '../../studio/diagnostic.ts';

export class StudioError extends Error {
  status: number;
  diagnostic?: StudioDiagnostic;
  constructor(message: string, status = 400, diagnostic?: StudioErrorCode | StudioDiagnostic) {
    super(message);
    this.status = status;
    if (diagnostic) this.diagnostic = typeof diagnostic === 'string' ? { code: diagnostic, message } : diagnostic;
  }
}
export function safePath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || /^[A-Za-z]:/.test(rel) || rel.startsWith(sep)) throw new StudioError('Đường dẫn nằm ngoài workspace.', 403);
  let current = target;
  while (!existsSync(current)) { const parent = dirname(current); if (parent === current) throw new StudioError('Đường dẫn không hợp lệ.'); current = parent; }
  const real = realpathSync(current), realRoot = realpathSync(root);
  const actual = relative(realRoot, real);
  if (actual === '..' || actual.startsWith('..' + sep) || /^[A-Za-z]:/.test(actual)) throw new StudioError('Không truy cập symlink bên ngoài workspace.', 403);
  return target;
}
export function validateFiles(files: Record<string, string>, entry: string): void {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.hasOwn(files, entry)) throw new StudioError('Thiếu file nguồn chính.');
  if (Object.keys(files).length > 100) throw new StudioError('Tối đa 100 file nguồn mỗi dự án.');
  for (const [path, content] of Object.entries(files)) {
    if (!/^[\p{L}\p{N}_.\-/ ]+\.[cm]?[jt]s$/u.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || !p) || path.startsWith('.pxl/') || path.startsWith('exports/')) throw new StudioError(`Tên file không hợp lệ: ${path}`);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2_000_000) throw new StudioError('File nguồn quá lớn hoặc không hợp lệ.');
  }
}
