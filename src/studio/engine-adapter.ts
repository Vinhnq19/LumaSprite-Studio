import type { ArtDirection } from './art-direction.ts';
import { celFor, newAsset, uid, validateAsset, type PixelAsset } from './pixel/model.ts';
import { dataArray, dataBoolean, dataId, dataName, dataNumber, dataObject } from './quality/data.ts';

export type EngineAssetType = 'character' | 'prop' | 'tileset' | 'tilemap' | 'environment' | 'icon' | 'animation' | 'vfx';
export type EngineFeature = 'references' | 'progress' | 'previews' | 'layers' | 'masks' | 'metadata' | 'usage';
export interface EngineCapabilities {
  versions: readonly number[];
  assetTypes: readonly EngineAssetType[];
  features: readonly EngineFeature[];
  limits: { width: number; height: number; frames: number };
}

export interface EngineRequestV1 {
  version: 1;
  requestId: string;
  assetType: EngineAssetType;
  brief: string;
  canvas: { w: number; h: number };
  frameDurationsMs: readonly number[];
  loop: boolean;
  alpha: 'binary' | 'rgba';
  palette?: readonly number[];
  style?: Omit<ArtDirection, 'references' | 'palette' | 'paletteMode'>;
  references?: readonly { id: string; sha256: string; w: number; h: number }[];
  requiredFeatures?: readonly EngineFeature[];
  /** Optional single-frame region input. Buffers use canonical base64 (RGBA8 and byte mask). */
  region?: { rgba: string; editable: string };
}

export interface EngineDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  location?: { frame?: number; x?: number; y?: number };
}

interface EngineJobDetails {
  id: string;
  progress?: { completed: number; total: number };
  previews?: readonly { id: string; label: string }[];
  diagnostics?: readonly EngineDiagnostic[];
}
export type EngineJobV1 = EngineJobDetails & (
  | { state: 'queued' | 'running' | 'canceling' | 'canceled' | 'unknown' }
  | { state: 'ready'; finalVersionId: string }
  | { state: 'failed'; diagnostics: readonly [EngineDiagnostic, ...EngineDiagnostic[]] }
);

export interface EngineAdapterV1 {
  capabilities(): Promise<EngineCapabilities>;
  submit(request: EngineRequestV1): Promise<EngineJobV1>;
  status(jobId: string): Promise<EngineJobV1>;
  cancel(jobId: string): Promise<EngineJobV1>;
  result(jobId: string, versionId: string): Promise<unknown>;
}

export interface EngineResultV1 {
  version: 1;
  jobId: string;
  versionId: string;
  name: string;
  w: number;
  h: number;
  loop: boolean;
  frames: readonly { durationMs: number; rgba: Uint32Array }[];
}

/** Admission for the core raster contract. Optional result blocks have separate validators in S3. */
export function negotiateEngineV1(caps: EngineCapabilities, request: EngineRequestV1): 1 {
  if (request.version !== 1 || !caps.versions.includes(1)) throw Error('Phiên bản engine không tương thích.');
  if (!caps.assetTypes.includes(request.assetType)) throw Error('Engine không hỗ trợ loại asset đã chọn.');
  dataId(request.requestId, 'ID yêu cầu engine');
  const limit = (value: number, studioMax: number) => Math.min(dataNumber(value, 1, Number.MAX_SAFE_INTEGER, 'Giới hạn engine', true), studioMax);
  const w = dataNumber(request.canvas.w, 1, limit(caps.limits.width, 4096), 'Chiều rộng engine', true);
  const h = dataNumber(request.canvas.h, 1, limit(caps.limits.height, 4096), 'Chiều cao engine', true);
  dataArray(request.frameDurationsMs, 1, limit(caps.limits.frames, 600), 'Danh sách frame engine');
  for (const duration of request.frameDurationsMs) dataNumber(duration, 1, 60000, 'Thời lượng frame', true);
  if (w * h * request.frameDurationsMs.length > 32_000_000) throw Error('Asset vượt ngân sách pixel của Studio.');
  const required = [...(request.requiredFeatures ?? []), ...(request.references?.length ? ['references' as const] : []), ...(request.region ? ['masks' as const] : [])];
  for (const feature of required) {
    if (!caps.features.includes(feature)) throw Error('Engine thiếu khả năng bắt buộc: ' + feature);
  }
  return 1;
}

/** Decode only the core contract into a new detached asset. Apply stays with Studio and its revision guard. */
export function materializeEngineResultV1(value: unknown, request: EngineRequestV1, jobId: string, versionId: string): PixelAsset {
  const result = dataObject(value, ['version','jobId','versionId','name','w','h','loop','frames'], 'Kết quả engine');
  if (result.version !== 1 || dataId(result.jobId, 'ID job') !== jobId || dataId(result.versionId, 'ID preview') !== versionId) {
    throw Error('Kết quả engine không khớp job hoặc phiên bản đã chọn.');
  }
  const { w, h } = request.canvas, count = request.frameDurationsMs.length;
  if (w !== result.w || h !== result.h || dataBoolean(result.loop, 'Loop') !== request.loop) {
    throw Error('Canvas hoặc loop của kết quả không khớp yêu cầu.');
  }
  const frames = dataArray(result.frames, count, count, 'Frame engine');
  const asset = newAsset(dataName(result.name, 'Tên asset engine'), w, h);
  if (w * h * count > 32_000_000 || count < 1 || count > 600) throw Error('Kết quả vượt ngân sách pixel/frame của Studio.');
  // The caller passes Studio's frozen request, never a palette echoed by the engine.
  const locked = request.palette && new Set(request.palette);
  const used = new Set<number>();
  asset.frames = frames.map((_, i) => ({ id: uid(), duration: request.frameDurationsMs[i] }));
  for (const [i, value] of frames.entries()) {
    const frame = dataObject(value, ['durationMs','rgba'], 'Frame engine');
    if (frame.durationMs !== asset.frames[i].duration || !(frame.rgba instanceof Uint32Array) || frame.rgba.length !== w * h) {
      throw Error('Thời lượng hoặc dữ liệu RGBA của frame không hợp lệ.');
    }
    const rgba = new Uint32Array(frame.rgba);
    for (const ink of rgba) {
      const alpha = ink & 255;
      if (!alpha && ink !== 0) throw Error('Pixel trong suốt phải là RGBA 0.');
      if (request.alpha === 'binary' && alpha !== 0 && alpha !== 255) throw Error('Kết quả có alpha ngoài hợp đồng.');
      if (alpha && locked && !locked.has(ink)) throw Error('Kết quả có màu ngoài palette khóa.');
      if (alpha) used.add(ink);
      if (!locked && used.size >= 4096) throw Error('Kết quả vượt giới hạn palette của Studio.');
    }
    celFor(asset, asset.layers[0].id, asset.frames[i].id, true)!.data = rgba;
  }
  if (!used.size) throw Error('Kết quả không có pixel nhìn thấy.');
  asset.palette = request.palette ? [...request.palette] : [0, ...used];
  asset.tags = [{ id: uid(), name: asset.name, from: asset.frames[0].id, to: asset.frames.at(-1)!.id, direction: 'forward', loop: request.loop }];
  validateAsset(asset);
  return asset;
}
