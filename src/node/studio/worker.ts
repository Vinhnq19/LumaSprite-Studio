import { parentPort, workerData } from 'node:worker_threads';
import { exportPixel } from './pixel-render.ts';
import { productionRequest } from './production-worker.ts';
import { terrainRequest } from './terrain-worker.ts';
import type { WorkerRequest } from './runner.ts';
import { StudioError } from './store.ts';

const request: WorkerRequest = workerData;
try {
  const value = request.mode === 'terrain' ? terrainRequest(request)
    : request.mode === 'production' ? productionRequest(request) : exportPixel(request);
  parentPort!.postMessage({ ok: true, value });
} catch (cause) {
  const error = (cause as Error).message;
  const invalid = cause instanceof StudioError ? cause : undefined;
  const diagnostic = invalid?.diagnostic ?? { code: request.mode === 'pixel-export' ? 'EXPORT_FAILED' : 'RENDER_FAILED', message: error };
  parentPort!.postMessage({ ok: false, error, status: invalid?.status, diagnostic });
}
