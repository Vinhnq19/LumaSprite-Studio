import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, realpathSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import type { QualityRun, QualityCall } from '../../studio/quality/run.ts';
import { dataId } from '../../studio/quality/data.ts';
import { qualityDirectory } from './quality-storage.ts';
import { HTTP_MARKER_FILE, HTTP_RECEIPT_FILE, isHttpOwnership, type HttpOwnership, type HttpOwnershipKind } from './quality-cli.ts';
import { PixelStore } from './pixel-store.ts';
import { safePath, StudioError } from './store.ts';
export interface QualityJournalRecord {
  version: 1; run: QualityRun; approvalId: string; prompt: string; style: string; cliRoot: string; ownerPid: number;
  snapshotId?: string; appliedAssetId?: string;
  ownerClosed?: boolean;
  responses?: { callId: string; sha256: string }[];
}
export const qualityRunning = (run: QualityRun) => ['running', 'canceling', 'unknown'].includes(run.status);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
/** Bounded, symlink-free read of one local ownership/legacy primitive receipt. */
const ownedMaxBytes = 4096;
function readOwned(root: string, callId: string, name: string): unknown {
  const path = safePath(qualityDirectory(root, callId), name), info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > ownedMaxBytes) throw new Error('Chứng từ cục bộ không đáng tin.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
/** 'missing' only when lstat proves absence; a dangling symlink or any other error stays unknown. */
function ownedRoot(root: string): 'owned' | 'missing' | 'unknown' {
  let info: Stats;
  try { info = lstatSync(root); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown'; }
  if (info.isSymbolicLink() || !info.isDirectory()) return 'unknown';
  try { return realpathSync(root) === resolve(root) ? 'owned' : 'unknown'; } catch { return 'unknown'; }
}
/** The per-call directory must be a real directory, not a symlink, at its exact resolved path. */
function ownedCallDirectory(root: string, callId: string, allowMissing: boolean): boolean {
  const dir = qualityDirectory(root, callId);
  let info: Stats;
  try { info = lstatSync(dir); }
  catch (e) { return allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT'; }
  return !info.isSymbolicLink() && info.isDirectory() && realpathSync(dir) === resolve(dir);
}
/** Legacy CLI proof: the helper PID is dead and its supervisor confirmed local shutdown. */
function cliStopped(root: string, callId: string): boolean {
  try {
    const marker = readOwned(root, callId, 'owned-helper.json') as { pid?: unknown }, receipt = readOwned(root, callId, 'owned-receipt.json') as { confirmed?: unknown };
    return Number.isInteger(marker.pid) && (marker.pid as number) > 0 && !alive(marker.pid as number) && receipt.confirmed === true;
  } catch { return false; }
}
/**
 * HTTP proof for a live owner: a matching request-attempt marker AND a matching
 * local drain receipt, both bound to this call, snapshot and owning PID. The
 * receipt says only that fetch/reader went idle; it never mentions remote billing.
 */
function httpDrained(root: string, record: QualityJournalRecord, callId: string): boolean {
  const snapshotId = record.snapshotId;
  if (typeof snapshotId !== 'string') return false;
  const bound = (value: unknown, kind: HttpOwnershipKind): boolean => {
    if (!isHttpOwnership(value, kind)) return false;
    const ownership = value as HttpOwnership;
    return ownership.callId === callId && ownership.snapshotId === snapshotId && ownership.ownerPid === record.ownerPid;
  };
  try {
    return bound(readOwned(root, callId, HTTP_MARKER_FILE), 'request-attempt') && bound(readOwned(root, callId, HTTP_RECEIPT_FILE), 'local-settled');
  } catch { return false; }
}
export class QualityJournal {
  private store: PixelStore;
  constructor(store: PixelStore) { this.store = store; }
  private directory(project: string, create = false): string {
    const dir = safePath(this.store.dir(project), '.pxl/quality-runs');
    if (create) mkdirSync(dir, { recursive: true });
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir))) throw new StudioError('Không dùng liên kết làm nhật ký chất lượng.', 403);
    return dir;
  }
  list(project: string): QualityJournalRecord[] {
    const dir = this.directory(project); if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(n => /^[A-Za-z0-9_-]{1,80}\.json$/.test(n)).map(n => this.get(project, n.slice(0, -5)));
  }
  get(project: string, id: string): QualityJournalRecord {
    dataId(id, 'Lượt chất lượng'); const dir = this.directory(project);
    if (!existsSync(dir)) throw new StudioError('Không tìm thấy lượt chất lượng.', 404);
    const path = safePath(dir, id + '.json');
    if (!existsSync(path)) throw new StudioError('Không tìm thấy lượt chất lượng.', 404);
    if (statSync(path).size > 1_000_000) throw new StudioError('Nhật ký chất lượng quá lớn.', 409);
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    if (envelope.version !== 1 || !envelope.record || typeof envelope.record !== 'object' || envelope.sha256 !== createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex')) throw new StudioError('Nhật ký chất lượng bị sửa ngoài app; giữ nguyên dữ liệu để kiểm tra.', 409);
    const value = envelope.record as QualityJournalRecord;
    if (value.version !== 1 || value.run?.id !== id || value.run.projectId !== project || !Array.isArray(value.run.calls) || value.run.calls.length > 4 || !Array.isArray(value.run.variants) || !Number.isInteger(value.ownerPid) || value.ownerPid < 1) throw new StudioError('Nhật ký chất lượng sai quyền sở hữu/định dạng.', 409);
    if (value.responses !== undefined && (!Array.isArray(value.responses) || value.responses.length > 4 || value.responses.some(r => !value.run.calls.some(c => c.id === r.callId) || !/^[a-f0-9]{64}$/.test(r.sha256)))) throw new StudioError('Danh sách response của nhật ký không hợp lệ.', 409);
    return value;
  }
  save(record: QualityJournalRecord): void {
    const dir = this.directory(record.run.projectId, true); dataId(record.run.id, 'Lượt chất lượng');
    const body = JSON.stringify(record), text = JSON.stringify({ version: 1, sha256: createHash('sha256').update(body).digest('hex'), record }); if (Buffer.byteLength(text) > 1_000_000) throw new Error('Nhật ký vượt 1 MB.');
    const path = safePath(dir, record.run.id + '.json'), tmp = safePath(dir, record.run.id + '-' + randomUUID() + '.tmp');
    writeFileSync(tmp, text, { flag: 'wx' }); renameSync(tmp, path);
  }
  response(record: QualityJournalRecord, callId: string, output: string): void {
    dataId(callId, 'Lượt CLI'); const dir = this.directory(record.run.projectId, true);
    const path = safePath(dir, `${record.run.id}-${callId}.response.json`), bytes = Buffer.from(output);
    const text = JSON.stringify({ receivedBytes: bytes.length, truncated: bytes.length > 2_000_000, output: bytes.subarray(0, 2_000_000).toString('utf8') });
    writeFileSync(path, text, { flag: 'wx' }); (record.responses ??= []).push({ callId, sha256: createHash('sha256').update(text).digest('hex') }); this.save(record);
  }
  readResponse(record: QualityJournalRecord, callId: string): unknown {
    dataId(callId, 'Lượt CLI'); const ref = record.responses?.find(r => r.callId === callId);
    if (!ref) throw new StudioError('Lượt này chưa trả response.', 404);
    const path = safePath(this.directory(record.run.projectId), `${record.run.id}-${callId}.response.json`);
    if (statSync(path).size > 3_000_000) throw new StudioError('Response vượt giới hạn.', 409);
    const text = readFileSync(path, 'utf8'); if (createHash('sha256').update(text).digest('hex') !== ref.sha256) throw new StudioError('Response bị sửa ngoài app; giữ bản đã sửa.', 409);
    return JSON.parse(text);
  }
  remove(record: QualityJournalRecord): void {
    if (qualityRunning(record.run)) throw new StudioError('Hủy và xác nhận dừng trước khi xóa lịch sử.', 409);
    const dir = this.directory(record.run.projectId);
    for (const ref of record.responses ?? []) {
      dataId(ref.callId, 'Lượt CLI'); const file = safePath(dir, `${record.run.id}-${ref.callId}.response.json`);
      if (existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === ref.sha256) unlinkSync(file);
    }
    dataId(record.run.id, 'Lượt chất lượng'); unlinkSync(safePath(dir, record.run.id + '.json'));
  }
  /** Never signal another live server, kill by PID, or infer stop from elapsed time. */
  async recover(record: QualityJournalRecord, cancel: boolean): Promise<boolean> {
    if (!qualityRunning(record.run)) return true;
    // A live owner still running its own job is never raced.
    if (alive(record.ownerPid) && !record.ownerClosed) return false;
    const pending = record.run.calls.filter(c => ['running', 'unknown'].includes(c.status));
    const root = record.cliRoot;
    // An old antigravity record may omit transport: only an HTTP DeepSeek call takes
    // the local HTTP path, everything else keeps the legacy owned CLI helper proof.
    const isHttp = (call: QualityCall) => call.transport === 'http' && call.provider === 'deepseek';
    const ownerAlive = alive(record.ownerPid);
    // Namespace/parent, every pending call ID and the owned root identity are checked
    // before any path is trusted; a race or unreadable path stays unknown, never throws.
    let rootState: 'owned' | 'missing' | 'unknown' = 'missing';
    if (pending.length) {
      try {
        if (typeof root !== 'string' || resolve(dirname(root)) !== realpathSync(tmpdir()) || !/^lumasprite-quality-cli-[A-Za-z0-9_-]+$/.test(root.split(/[\\/]/).at(-1)!)) return false;
        for (const call of pending) dataId(call.id, 'Lượt CLI');
        rootState = ownedRoot(root);
        if (rootState === 'unknown') return false;
        // An existing root must show each call as an exact, symlink-free directory;
        // a dangling root symlink is not a genuinely missing root and was rejected above.
        // A dead HTTP owner may have crashed after journaling but before mkdir.
        if (rootState === 'owned') for (const call of pending) if (!ownedCallDirectory(root, call.id, !ownerAlive && isHttp(call))) return false;
      } catch { return false; }
    }
    // A confirmed-dead PID means this process's fetch/reader no longer lives, so a
    // crash before the marker is still safely terminal. A live but closed owner
    // must show the exact marker AND local drain receipt for this call/snapshot/PID.
    const locallyStopped = (call: QualityCall) => isHttp(call)
      ? ownerAlive ? httpDrained(root, record, call.id) : rootState === 'owned' || (rootState === 'missing' && pending.every(isHttp))
      : cliStopped(root, call.id);
    const stopped = () => pending.every(locallyStopped);
    // Owned stop files belong to the CLI supervisor only; HTTP has no local helper to signal.
    if (cancel && !stopped()) for (const call of pending.filter(c => !isHttp(c))) {
      try { const path = safePath(qualityDirectory(root, call.id), 'owned-stop'); if (!existsSync(path)) writeFileSync(path, '', { flag: 'wx' }); } catch { /* Remain unknown if the owned context is missing or untrusted. */ }
    }
    const end = performance.now() + (cancel ? 5000 : 0);
    while (!stopped() && performance.now() < end) await new Promise(r => setTimeout(r, 25));
    if (!stopped()) return false;
    const remoteUnknown = pending.some(isHttp);
    record.run.status = cancel ? 'canceled' : 'failed'; record.run.stage = 'done'; record.run.ended = Date.now();
    // Never claim a remote cancel: a sent HTTP request may still be processed/billed.
    record.run.message = `Phiên máy chủ cũ đã ngắt; đã xác nhận công việc cục bộ dừng. Không tự chạy lại.${remoteUnknown ? ' Chưa xác nhận nhà cung cấp từ xa đã ngừng xử lý hoặc tính phí.' : ''}`;
    for (const call of pending) { call.status = cancel ? 'canceled' : 'failed'; call.ended = record.run.ended; }
    this.save(record); return true;
  }
}
