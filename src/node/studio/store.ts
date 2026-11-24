import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ProjectDocument } from '../../studio/types.ts';
import { templates } from './templates.ts';
import { validatePixels, validateMetadata } from '../../studio/validation.ts';
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
function atomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value, 'utf8'); renameSync(tmp, path);
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const serial = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export function validateFiles(files: Record<string, string>, entry: string): void {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.hasOwn(files, entry)) throw new StudioError('Thiếu file nguồn chính.');
  if (Object.keys(files).length > 100) throw new StudioError('Tối đa 100 file nguồn mỗi dự án.');
  for (const [path, content] of Object.entries(files)) {
    if (!/^[\p{L}\p{N}_.\-/ ]+\.[cm]?[jt]s$/u.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || !p) || path.startsWith('.pxl/') || path.startsWith('exports/')) throw new StudioError(`Tên file không hợp lệ: ${path}`);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2_000_000) throw new StudioError('File nguồn quá lớn hoặc không hợp lệ.');
  }
}
export class ProjectStore {
  readonly root: string;
  private fingerprints = new Map<string, string>();
  constructor(root: string) { mkdirSync(root, { recursive: true }); this.root = realpathSync(root); }
  dir(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new StudioError('ID dự án không hợp lệ.');
    return safePath(this.root, id);
  }
  list(): { id: string; name: string; revision: number }[] {
    return readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).flatMap(d => {
      try { const p = this.load(d.name); return [{ id: p.id, name: p.name, revision: p.revision }]; } catch { return []; }
    });
  }
  private diskFiles(dir: string, names?: string[]): Record<string, string> {
    const files: Record<string, string> = {};
    const scan = (path: string) => {
      for (const d of readdirSync(path, { withFileTypes: true })) {
        if (d.isSymbolicLink() || d.name.startsWith('.') || ['node_modules', 'out', 'exports', 'dist'].includes(d.name)) continue;
        const abs = join(path, d.name);
        if (d.isDirectory()) scan(abs);
        else if (/\.[cm]?[jt]s$/.test(d.name)) {
          if (Object.keys(files).length >= 100 || lstatSync(abs).size > 2_000_000) throw new StudioError('Dự án vượt giới hạn file.');
          files[relative(dir, abs).split(sep).join('/')] = readFileSync(abs, 'utf8');
        }
      }
    };
    if (names) for (const n of names) { const abs = safePath(dir, n); if (existsSync(abs)) files[n] = readFileSync(abs, 'utf8'); }
    else scan(dir);
    return files;
  }
  private fingerprint(p: ProjectDocument): string { return createHash('sha256').update(serial([p.files, p.pixels, p.metadata])).digest('hex'); }
  load(id: string): ProjectDocument {
    const dir = this.dir(id);
    if (!existsSync(dir)) throw new StudioError('Không tìm thấy dự án.', 404);
    const manifest = safePath(dir, 'pxl.project.json');
    if (!existsSync(manifest)) throw new StudioError('Không tìm thấy dự án.', 404);
    const m = json(manifest);
    if (m.schemaVersion !== 1 || m.id !== id || !Number.isInteger(m.revision) || m.revision < 1) throw new StudioError('Định dạng dự án không được hỗ trợ.');
    const pixelPath = safePath(dir, '.pxl/pixels.json'), metadataPath = safePath(dir, '.pxl/metadata.json');
    const p: ProjectDocument = { ...m, files: this.diskFiles(dir), pixels: existsSync(pixelPath) ? json(pixelPath) : {}, metadata: existsSync(metadataPath) ? json(metadataPath) : {} };
    validateFiles(p.files, p.entry);
    validatePixels(p); validateMetadata(p.metadata);
    const fp = this.fingerprint(p), previous = this.fingerprints.get(id) ?? m.fingerprint;
    if (previous && previous !== fp) { p.revision++; this.writeManifest(p); }
    this.fingerprints.set(id, fp);
    return p;
  }
  private writeManifest(p: ProjectDocument): void {
    atomic(safePath(this.dir(p.id), 'pxl.project.json'), serial({ schemaVersion: 1, id: p.id, name: p.name, entry: p.entry, revision: p.revision, fingerprint: this.fingerprint(p) }));
  }
  create(name: string, template = 'sprite', files?: Record<string, string>, entry = 'art.px.js'): ProjectDocument {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new StudioError('Tên dự án cần 1–100 ký tự.');
    if (!files && !Object.hasOwn(templates, template)) throw new StudioError('Mẫu dự án không hợp lệ.');
    const p: ProjectDocument = { schemaVersion: 1, id: randomUUID(), name: name.trim(), entry, revision: 1, files: files ?? { [entry]: templates[template] }, pixels: {}, metadata: {} };
    validateFiles(p.files, p.entry); mkdirSync(this.dir(p.id)); this.write(p); this.snapshot(p, 'Tạo dự án'); return p;
  }
  private write(p: ProjectDocument): void {
    const dir = this.dir(p.id);
    for (const [path, content] of Object.entries(p.files)) atomic(safePath(dir, path), content);
    atomic(safePath(dir, '.pxl/pixels.json'), serial(p.pixels)); atomic(safePath(dir, '.pxl/metadata.json'), serial(p.metadata));
    this.writeManifest(p); this.fingerprints.set(p.id, this.fingerprint(p));
  }
  save(id: string, revision: number, changes: Partial<Pick<ProjectDocument, 'files' | 'pixels' | 'metadata' | 'name' | 'entry'>>, label?: string): ProjectDocument {
    const current = this.load(id);
    if (current.revision !== revision) throw new StudioError('Dự án đã thay đổi bên ngoài hoặc ở tab khác. Tải lại trước khi lưu.', 409);
    const next = { ...current, ...changes, id, schemaVersion: 1 as const, revision: current.revision + 1 };
    validateFiles(next.files, next.entry);
    validatePixels(next); validateMetadata(next.metadata);
    if (!next.name?.trim() || next.name.length > 100) throw new StudioError('Tên dự án không hợp lệ.');
    if (label) this.snapshot(current, label);
    for (const old of Object.keys(current.files)) if (!Object.hasOwn(next.files, old)) rmSync(safePath(this.dir(id), old));
    this.write(next); return next;
  }
  snapshot(p: ProjectDocument, label: string): void {
    const dir = safePath(this.dir(p.id), '.pxl/history'); mkdirSync(dir, { recursive: true });
    atomic(join(dir, `${Date.now()}-${randomUUID()}.json`), serial({ label, time: new Date().toISOString(), document: p }));
    const all = readdirSync(dir).filter(n => n.endsWith('.json')).sort();
    for (const old of all.slice(0, -20)) rmSync(join(dir, old));
  }
  history(id: string): { id: string; label: string; time: string; revision: number }[] {
    this.load(id); const dir = safePath(this.dir(id), '.pxl/history');
    return existsSync(dir) ? readdirSync(dir).filter(n => /^[\w-]+\.json$/.test(n)).sort().reverse().map(n => { const h = json(safePath(dir, n)); return { id: n, label: h.label, time: h.time, revision: h.document.revision }; }) : [];
  }
  restore(id: string, revision: number, snapshot: string): ProjectDocument {
    if (!/^[\w-]+\.json$/.test(snapshot)) throw new StudioError('Phiên bản không hợp lệ.');
    const doc = json(safePath(this.dir(id), `.pxl/history/${snapshot}`)).document;
    return this.save(id, revision, { files: doc.files, pixels: doc.pixels, metadata: doc.metadata, entry: doc.entry, name: doc.name }, 'Trước khi phục hồi');
  }
  importFolder(path: string, name: string, entry: string): ProjectDocument {
    const dir = safePath(this.root, path); if (!existsSync(dir)) throw new StudioError('Không tìm thấy thư mục nhập.');
    return this.create(name, 'sprite', this.diskFiles(dir), entry);
  }
}
