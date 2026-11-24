import { createHash } from 'node:crypto';
import type { EngineAdapterV1, EngineAssetType, EngineCapabilities, EngineFeature, EngineJobV1, EngineRequestV1 } from '../../studio/engine-adapter.ts';
import { dataArray, dataId, dataName, dataNumber, dataObject, dataUnique } from '../../studio/quality/data.ts';
import { StudioError } from './store.ts';

const assetTypes: EngineAssetType[] = ['character', 'prop', 'icon'];
const features: EngineFeature[] = ['progress', 'previews', 'masks'];
const states: EngineJobV1['state'][] = ['queued', 'running', 'canceling', 'canceled', 'unknown', 'ready', 'failed'];
const maxResponseBytes = 2 * 1024 * 1024;
export const externalDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export class ExternalEngineTransport implements EngineAdapterV1 {
  readonly origin: string;
  private readonly timeoutMs: number;
  constructor(port: number, timeoutMs = 3000) {
    this.timeoutMs = timeoutMs;
    this.origin = `http://127.0.0.1:${dataNumber(port, 1, 65535, 'Cổng engine', true)}`;
  }

  private async read(path: string, input?: EngineRequestV1 | object): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
        ...(input && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new StudioError(timedOut ? 'Engine không phản hồi đúng hạn.' : 'External Engine đang offline.', timedOut ? 504 : 503);
    }
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/json') ||
        Number(response.headers.get('content-length')) > maxResponseBytes) {
      await response.body?.cancel();
      throw new StudioError('Engine trả HTTP hoặc kích thước payload không hợp lệ.', 502);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxResponseBytes) throw new StudioError('Payload engine vượt giới hạn.', 502);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof StudioError) throw error;
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new StudioError('Engine tải payload quá hạn.', 504);
      throw new StudioError('Không đọc được payload engine.', 502);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new StudioError('Engine trả JSON không hợp lệ.', 502); }
  }

  async discover(): Promise<{ name: string; capabilities: EngineCapabilities }> {
    const value = dataObject(await this.read('/v1/capabilities'), ['name', 'versions', 'assetTypes', 'features', 'limits'], 'Capabilities');
    const subset = <T extends string>(raw: unknown, supported: T[]) => {
      const entries = dataUnique(dataArray(raw, 0, 64, 'Capabilities').map(item => dataId(item, 'Capability')), 'Capabilities');
      return entries.filter((item): item is T => supported.includes(item as T));
    };
    const versions = dataUnique(dataArray(value.versions, 1, 16, 'Protocol').map(version => dataNumber(version, 1, 65535, 'Protocol', true)), 'Protocol');
    const limits = dataObject(value.limits, ['width', 'height', 'frames'], 'Giới hạn engine');
    return { name: dataName(value.name, 'Tên engine'), capabilities: {
      versions, assetTypes: subset(value.assetTypes, assetTypes), features: subset(value.features, features),
      limits: {
        width: Math.min(dataNumber(limits.width, 1, 4096, 'Chiều rộng engine', true), 512),
        height: Math.min(dataNumber(limits.height, 1, 4096, 'Chiều cao engine', true), 512),
        frames: Math.min(dataNumber(limits.frames, 1, 600, 'Frame engine', true), 1),
      },
    } };
  }

  async capabilities(): Promise<EngineCapabilities> { return (await this.discover()).capabilities; }

  private async job(path: string, input?: object, expectedId?: string): Promise<EngineJobV1> {
    const raw = await this.read(path, input);
    const state = (raw as { state?: EngineJobV1['state'] } | null)?.state;
    if (!state || !states.includes(state)) throw Error('Trạng thái job engine không hợp lệ.');
    const value = dataObject(raw, ['id', 'state', 'progress', ...(state === 'ready' ? ['finalVersionId'] : state === 'failed' ? ['message'] : [])], 'Job engine');
    const id = dataId(value.id, 'ID job');
    if (expectedId && expectedId !== id) throw Error('Engine trả sai ID job.');
    const progress = dataObject(value.progress, ['completed', 'total'], 'Tiến độ');
    const total = dataNumber(progress.total, 1, 100000, 'Tổng tiến độ', true);
    const completed = dataNumber(progress.completed, 0, total, 'Tiến độ', true);
    const base = { id, progress: { completed, total } };
    if (state === 'ready') return { ...base, state, finalVersionId: dataId(value.finalVersionId, 'ID phiên bản') };
    if (state === 'failed') return { ...base, state, diagnostics: [{ code: 'ENGINE_JOB_FAILED', severity: 'error', message: dataName(value.message, 'Lỗi engine') }] };
    return { ...base, state };
  }

  submit(request: EngineRequestV1) { return this.job('/v1/jobs', request); }
  status(id: string) { return this.job(`/v1/jobs/${id}`, undefined, id); }
  cancel(id: string) { return this.job(`/v1/jobs/${id}/cancel`, {}, id); }

  async result(id: string, version: string): Promise<unknown> {
    const raw = await this.read(`/v1/jobs/${id}/results/${version}`);
    const result = dataObject(raw, ['version', 'jobId', 'versionId', 'name', 'w', 'h', 'loop', 'frames'], 'Kết quả engine');
    const w = dataNumber(result.w, 1, 4096, 'Rộng', true), h = dataNumber(result.h, 1, 4096, 'Cao', true);
    const frames = dataArray(result.frames, 1, 600, 'Frame engine').map(rawFrame => {
      const frame = dataObject(rawFrame, ['durationMs', 'rgba', 'sha256'], 'Bitmap engine');
      if (typeof frame.rgba !== 'string' || frame.rgba.length !== Math.ceil(w * h * 4 / 3) * 4) throw Error('Kích thước RGBA không hợp lệ.');
      const bytes = Buffer.from(frame.rgba, 'base64');
      if (bytes.length !== w * h * 4 || frame.rgba !== bytes.toString('base64') || frame.sha256 !== externalDigest(bytes)) throw Error('SHA-256 hoặc dữ liệu RGBA không hợp lệ.');
      const rgba = new Uint32Array(w * h);
      for (let i = 0; i < rgba.length; i++) rgba[i] = bytes.readUInt32BE(i * 4);
      return { durationMs: frame.durationMs, rgba };
    });
    return { ...result, frames };
  }
}
