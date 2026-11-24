/**
 * Normalization and validation for source file names and Windows filesystem aliases.
 */

/**
 * Normalizes a source file path:
 * - Rejects non-string, empty, null bytes
 * - Converts all backslashes to forward slashes
 * - Strips leading `./` or `.\\`
 * - Rejects absolute paths (starts with `/` or Windows drive letter `C:`)
 * - Rejects path traversal (`..` segments)
 * - Normalizes empty and `.` segments
 */
export function normalizeSourcePath(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new Error('Đường dẫn file nguồn không hợp lệ.');
  }
  const trimmed = raw.trim();
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Đường dẫn tuyệt đối không được phép: ${raw}`);
  }
  const segments = normalized.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`Đường dẫn chứa ký tự điều hướng không hợp lệ: ${raw}`);
    }
    resolved.push(seg);
  }
  if (resolved.length === 0) {
    throw new Error(`Đường dẫn không hợp lệ: ${raw}`);
  }
  return resolved.join('/');
}

/**
 * Returns a canonical key for comparison on Windows filesystems:
 * - Normalizes slashes and strips leading `./`
 * - Strips Windows-ignored trailing dots and trailing spaces from each segment
 * - Converts to lower-case (case-insensitive on Windows)
 */
export function canonicalSourceKey(raw: string): string {
  const norm = normalizeSourcePath(raw);
  const segments = norm.split('/').map(seg => seg.replace(/[. ]+$/, ''));
  if (segments.some(seg => !seg)) {
    throw new Error(`Đường dẫn không hợp lệ trên Windows: ${raw}`);
  }
  return segments.join('/').toLowerCase();
}
