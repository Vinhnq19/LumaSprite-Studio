import { parentPort, workerData } from 'node:worker_threads';
import { renderDocument } from './render.ts';
import { exportPixel } from './pixel-render.ts';
import { processRequest, variantFrame } from './processing-worker.ts';
import { terrainRequest } from './terrain-worker.ts';
import { productionRequest } from './production-worker.ts';
import { renderQuality } from './quality-worker.ts';
import { qualityStage } from './quality-stage-worker.ts';
import { qualitySourceWorker } from './quality-source-worker.ts';
import { StudioError } from './store.ts';
try {
  if (workerData.mode === 'summary' && workerData.validateSource) {
    const { validatePxlReferences } = await import('./pxl-preflight.ts');
    validatePxlReferences(workerData.document.files, workerData.document.entry);
  }
  parentPort!.postMessage({ ok: true, value: workerData.mode === 'quality-source' ? qualitySourceWorker(workerData) : workerData.mode === 'quality-stage' ? qualityStage(workerData) : workerData.mode === 'quality-render' ? renderQuality(workerData) : workerData.mode === 'terrain' ? terrainRequest(workerData) : workerData.mode === 'production' ? productionRequest(workerData) : workerData.mode === 'variant-frame' ? variantFrame(workerData) : workerData.mode === 'pixel-process' ? processRequest(workerData) : workerData.mode === 'pixel-export' ? exportPixel(workerData) : renderDocument(workerData) });
} catch (e) {
  const error = (e as Error).message;
  const status = (['quality-source', 'quality-stage'].includes(workerData.mode) || e instanceof StudioError && (e.diagnostic || workerData.mode === 'production'))
    ? (e as {status?: number}).status : undefined;
  const diagnostic = (e instanceof StudioError && e.diagnostic) ||
    { code: ['pixel-export', 'export'].includes(workerData.mode) ? 'EXPORT_FAILED' : 'RENDER_FAILED', message: error };
  parentPort!.postMessage({ ok: false, error, status, diagnostic });
}
