import { serialize } from 'node:v8';
import { PixelStore } from './pixel-store.ts';
import { prepareQualityApproval, qualityRevision } from './quality-source.ts';
import { prepareRigDraftSource } from './rig-source.ts';
import { prepareRigDraftRefresh } from './rig-refresh.ts';
import type { ExportResult } from './render.ts';
export interface QualitySourceRequest { mode: 'quality-source'; root: string; projectId: string; revision: number; input: unknown; operation?: 'rig-draft' | 'rig-refresh' }
/** Private worker result, never accepted from HTTP or deserialized from a project file. */
export function qualitySourceWorker(request: QualitySourceRequest): ExportResult {
  const store = new PixelStore(request.root), doc = store.load(request.projectId); qualityRevision(doc, request.revision);
  const captured = request.operation === 'rig-draft' ? prepareRigDraftSource(store, doc, request.input) : request.operation === 'rig-refresh' ? prepareRigDraftRefresh(store, doc, request.input) : prepareQualityApproval(store, doc, request.input);
  const result = 'draft' in captured ? { document: captured.document, draft: captured.draft } : { document: captured.document, approval: captured.approval };
  return { data: serialize(result), mime: 'application/x-lumasprite-worker', filename: 'quality-source.bin' };
}
