import type { IncomingMessage, ServerResponse } from 'node:http';
import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Proposals } from './proposals.ts';
import { PixelStore } from './pixel-store.ts';
import { ProjectStore, StudioError, validateFiles } from './store.ts';
import { RenderPool, type RenderTask, type WorkerRequest } from './runner.ts';
import { AiManager, assertDeepSeekTextOnly, type ProviderSettings } from './ai.ts';
import { GenerationBatchManager, toCompactBatch } from './generation-batches.ts';
import { prepareGenerationSnapshot, resolveTargetSettings, type PreparedSnapshot } from './generation-prep.ts';
import { validateArtDirection } from '../../studio/art-direction.ts';
import { isActiveAiProvider } from '../../studio/ai-providers.ts';
import { checkClipReadiness, validateClipId } from '../../studio/clips.ts';
import { applyLibraryVersion, validateApplyLibraryOptions } from '../../studio/asset-library.ts';
import { validateResourceId, validateResourceRef } from '../../studio/resources.ts';
import { wireStringify, wireParse, composite, newDocument, playback, type PixelDocument, type PixelAsset, type BatchProvenance } from '../../studio/pixel/model.ts';
import type { ProjectDocument, GenerationContext, GenerationReport } from '../../studio/types.ts';
import { generationOptions } from '../../studio/generation.ts';
import { encodePng } from '../png.ts';
import { Img } from '../../core/image.ts';
import { exportPixel } from './pixel-render.ts';
import type { ExportResult } from './render.ts';
import { zipFiles } from './zip.ts';
import { TerrainApi } from './terrain-api.ts';
import { QualityApi } from './quality-api.ts';
import { figureHistory, figureInput, figureSample, prepareFigure, rememberFigure, renderFigure, reviseFigure } from './figure-review.ts';
import { flatAsset } from '../../studio/pixel/processing.ts';
import { newAsset } from '../../studio/pixel/model.ts';
import { QualityJournal, qualityRunning } from './quality-journal.ts';
import { ExternalEngineApi } from './external-engine-api.ts';
import { productionCatalog, type ProductionRequest } from './production-worker.ts';
import { dataId } from '../../studio/quality/data.ts';

export function pixelApi(root: string, legacy: ProjectStore, pool: RenderPool, emit: (e: unknown) => void, settings?: ProviderSettings, externalEnginePort?: number, externalEngineTimeoutMs?: number) {
  const store = new PixelStore(root), contexts = new Map<string, ProjectDocument>(), proposals = new Map<string, { projectId: string; revision: number; assets: PixelAsset[]; jobId?: string; quality?: GenerationReport }>();
  const watched = new Map<string, number>();
  const externalEngine = new ExternalEngineApi(store, externalEnginePort, externalEngineTimeoutMs);
  const tasks = new Map<string, Set<RenderTask>>();
  async function run(id: string, request: WorkerRequest): Promise<any> { const task = pool.start(request); let set = tasks.get(id); if (!set) tasks.set(id, set = new Set()); set.add(task); try { return await task.promise; } finally { set.delete(task); if (!set.size) tasks.delete(id); } }
  const variants = new Proposals(store,run,emit);
  const terrain = new TerrainApi(store, pool, emit);
  const ai = new AiManager(
    {
      dir: id => store.dir(id),
      load: id => {
        const c = contexts.get(id);
        if (!c) throw new StudioError('Ngữ cảnh AI hết hạn.');
        return { ...c, revision: store.load(id).revision };
      },
      save: () => {
        throw new Error('Đề xuất pixel chỉ được nhập thành asset mới.');
      },
    },
    e => {
      const event = e as { type: string; job?: { candidateIndex?: number } };
      if (event?.job?.candidateIndex !== undefined) {
        // Suppress new batch-owned AiJob raw pixel-ai SSE
        batchManager.onJobUpdate(event.job as import('../../studio/types.ts').AiJob);
        return;
      }
      emit({ type: 'pixel-ai', event: e });
    },
    settings
  );
  const batchManager = new GenerationBatchManager(store, variants, ai, emit);
  let quality: QualityApi | undefined;
  const coldQualityJournal = new QualityJournal(store);
  // A restarted app must not let the legacy/batch/clip paths bypass an unresolved
  // quality run, even before the user has opened the quality panel.
  batchManager.addBusyGuard(id => !quality && coldQualityJournal.list(id).some(r => qualityRunning(r.run)));
  const qualityApi = () => quality ??= new QualityApi(store, pool, batchManager, emit, settings);
  const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(wireStringify(data)); };
  function observe(d: PixelDocument) {
    const path = join(store.dir(d.id), 'pxl.project.json'); const existed = watched.has(path); watched.set(path, d.revision);
    if (existed) return;
    watchFile(path, { interval: 500, persistent: false }, () => {
      try { const next = store.load(d.id); if (next.revision !== watched.get(path)) { watched.set(path, next.revision); emit({ type: 'pixel-external', projectId: d.id, revision: next.revision }); } }
      catch (e) { emit({ type: 'pixel-error', projectId: d.id, message: (e as Error).message }); }
    });
  }
  function revision(d: PixelDocument, value: unknown) { if (value !== d.revision) throw new StudioError('Revision đã thay đổi; giữ bản nháp và tải lại hoặc lưu bản sao.', 409, 'STALE_REVISION'); }
  async function raster(doc: ProjectDocument, name?: string): Promise<PixelAsset[]> {
    const result = await run(doc.id, { document: doc, mode: 'raster', name }) as ExportResult;
    return wireParse(Buffer.from(result.data).toString('utf8'));
  }
  function proposal(projectId: string, rev: number, assets: PixelAsset[], jobId?: string, quality?: GenerationReport): string {
    const id = randomUUID(); proposals.set(id, { projectId, revision: rev, assets, jobId, quality });
    while (proposals.size > 20) proposals.delete(proposals.keys().next().value!); return id;
  }
  async function route(req: IncomingMessage, res: ServerResponse, url: URL, b: () => Promise<any>): Promise<boolean> {
    if (!url.pathname.startsWith('/api/pixel/')) return false;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[2] === 'from-legacy' && req.method === 'POST') {
      const input = await b(), old = legacy.load(input.projectId); if (old.revision !== input.revision) throw new StudioError('Dự án nguồn đã thay đổi.', 409);
      const assets = await raster(old, input.name); if (legacy.load(old.id).revision !== old.revision) throw new StudioError('Dự án nguồn vừa thay đổi.', 409);
      const d = newDocument(`${old.name} (pixel)`.slice(0, 100)); d.assets = assets; const saved = store.create(d.name, 32, 32, 0, d); observe(saved); json(res, saved, 201); return true;
    }
    if (parts[2] === 'projects' && !parts[3]) {
      if (req.method === 'GET') json(res, store.list());
      else if (req.method === 'POST') {
        const input = wireParse(JSON.stringify(await b()));
        if (input.backup) { const saved = store.importBackup(input.name, input.backup.document, input.backup.blobs, input.backup.history, input.backup.resourceBlobs); observe(saved); json(res, saved, 201); return true; }
        if (input.document && input.sourceProjectId) {
          const copied = store.copy(input.name, input.document, input.sourceProjectId);
          observe(copied);
          json(res, copied, 201);
          return true;
        }
        const d = store.create(input.name, input.w, input.h, input.background, input.document); observe(d); json(res, store.load(d.id), 201);
      }
      else throw new StudioError('Method không được phép.', 405);
      return true;
    }
    if (parts[2] !== 'projects' || !parts[3]) throw new StudioError('Không tìm thấy API pixel.', 404);
    const id = parts[3], action = parts[4];
    // A lazy cel read verifies its requested blob in store.cel; rescanning every asset here stalls playback.
    const celRead = action === 'cel' && req.method === 'GET';
    const d = store.load(id, false, action !== 'history' && !celRead); observe(d);
    if (action === 'external-engine') {
      const result = await externalEngine.route(d, req.method ?? '', parts.slice(5), b);
      if (result.saved) {
        observe(result.saved);
        emit({ type: 'pixel-saved', projectId: id, revision: result.saved.revision });
      }
      json(res, result.value, result.status);
      return true;
    }
    if (action === 'production') {
      if (req.method !== 'GET' || parts.length > 5) throw new StudioError('Route Production không hợp lệ.', 405);
      const operation = url.searchParams.get('operation');
      if (operation !== 'thumbnail') revision(d, Number(url.searchParams.get('revision')));
      if (operation === 'catalog') { json(res, productionCatalog(d)); return true; }
      const param = (name: string) => dataId(url.searchParams.get(name), name);
      const base = { mode: 'production' as const, root, projectId: id, revision: d.revision };
      let request: ProductionRequest;
      if (operation === 'thumbnail') {
        const sha256 = url.searchParams.get('sha256');
        if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new StudioError('Hash thumbnail không hợp lệ.');
        request = { ...base, operation, assetId: param('assetId'), sha256 };
      }
      else if (operation === 'inspect') request = { ...base, operation, assetId: param('assetId'), ...(url.searchParams.has('collectionId') && { collectionId: param('collectionId') }) };
      else if (operation === 'scene') request = { ...base, operation, sceneId: param('sceneId') };
      else if (operation === 'package') request = { ...base, operation, collectionId: param('collectionId'), ...(url.searchParams.has('sceneId') && { sceneId: param('sceneId') }) };
      else throw new StudioError('Thao tác Production không hợp lệ.', 400);
      const out = await run(id, request) as ExportResult;
      if (operation !== 'thumbnail') revision(store.load(id), d.revision);
      res.writeHead(200, { 'content-type': out.mime, 'cache-control': operation === 'thumbnail' ? 'private, max-age=600' : 'no-store',
        ...(operation === 'package' && { 'content-disposition': 'attachment; filename="production.zip"' }) });
      res.end(Buffer.from(out.data));
      return true;
    }
    if (['quality', 'quality-runs', 'rig-drafts'].includes(action) && await qualityApi().route(req, res, parts, d, b, url)) return true;
    if (await terrain.route(req, res, parts, d, b)) return true;
    if (!action) {
      if (req.method === 'GET') json(res, d);
      else if (req.method === 'PUT') { const input = wireParse(JSON.stringify(await b())); const saved = store.save(id, input.revision, input.document, input.snapshot ? 'Trước khi lưu thủ công' : undefined); if (input.snapshot) store.snapshot(saved, 'Lưu thủ công'); observe(saved); emit({ type: 'pixel-saved', projectId: id, revision: saved.revision }); json(res, saved); }
      else throw new StudioError('Method không được phép.', 405);
      return true;
    }
    if (action === 'cel' && req.method === 'GET') {
      if (url.searchParams.has('blob')) {
        revision(d, Number(url.searchParams.get('revision')));
        const ref = { version: 1 as const, kind: 'rgba' as const, w: Number(url.searchParams.get('w')), h: Number(url.searchParams.get('h')), blob: url.searchParams.get('blob')! };
        validateResourceRef(ref);
        const celId = url.searchParams.get('cel') ?? '', assetId = url.searchParams.get('asset') ?? '';
        if (!/^[\w-]{1,80}$/.test(celId) || !/^[\w-]{1,80}$/.test(assetId)) throw new StudioError('ID cel/asset không hợp lệ.');
        // Undo can reference an older owned blob before its manifest is saved.
        json(res, { id: celId, blob: ref.blob, data: store.cel(id, ref.blob, ref.w * ref.h) }); return true;
      }
      revision(d, Number(url.searchParams.get('revision'))); const asset = d.assets.find(a => a.id === url.searchParams.get('asset')), c = asset?.cels[url.searchParams.get('cel') ?? ''];
      if (!asset || !c) throw new StudioError('Không tìm thấy cel.', 404);
      json(res, { ...c, data: store.cel(id, c.blob!, asset.w * asset.h) }); return true;
    }
    if (action === 'resource' && req.method === 'GET') {
      revision(d, Number(url.searchParams.get('revision')));
      const resId = url.searchParams.get('resource') ?? '';
      try {
        validateResourceId(resId);
      } catch (err) {
        throw new StudioError((err as Error).message, 400);
      }
      if (url.searchParams.has('blob')) {
        const ref = { version: 1 as const, kind: url.searchParams.get('kind'), w: Number(url.searchParams.get('w')), h: Number(url.searchParams.get('h')), blob: url.searchParams.get('blob') };
        validateResourceRef(ref);
        // The store confines this digest to this project's owned resource folder.
        const data = store.resourceStore(id).read(ref);
        json(res, { ...ref, data }); return true;
      }
      if (!d.studio?.resources || !Object.hasOwn(d.studio.resources, resId)) {
        throw new StudioError('Không tìm thấy tài nguyên.', 404);
      }
      const item = store.resource(id, resId);
      revision(store.load(id, false, false), d.revision);
      json(res, item);
      return true;
    }
    if (action === 'history') {
      if (req.method === 'GET') json(res, store.history(id));
      else if (req.method === 'POST') { const input = await b(); const saved = store.restore(id, input.revision, input.snapshot); observe(saved); emit({ type: 'pixel-saved', projectId: id, revision: saved.revision }); json(res, saved); }
      else throw new StudioError('Method không được phép.', 405);
      return true;
    }
    if (action === 'backup' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="pixel-project.zip"' }); res.end(zipFiles(store.backupFiles(id))); return true; }
    if (action === 'export' && req.method === 'POST') {
      const input = await b(); revision(d, input.revision); if (!['png', 'gif', 'strip', 'atlas', 'zip'].includes(input.format)) throw new StudioError('Định dạng không hợp lệ.', 400, 'EXPORT_FAILED');
      const selected = d.assets.find(a => a.id === input.assetId) ?? d.assets[0], sequence = new Set(playback(selected, input.tagId).map(s => s.frame.id));
      store.hydrate(d, (a, frame) => ['atlas', 'zip'].includes(input.format) ? !input.selected?.length || input.selected.includes(a.id) : a.id === selected.id && (input.format === 'png' ? frame === (input.frameId ?? a.frames[0].id) : sequence.has(frame)));
      const result = await run(id, { mode: 'pixel-export', document: d, assetId: input.assetId, frameId: input.frameId, tagId: input.tagId, format: input.format, selected: input.selected }) as ExportResult; revision(store.load(id), d.revision);
      res.writeHead(200, { 'content-type': result.mime, 'content-disposition': `attachment; filename="asset.${result.filename.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(result.filename)}` }); res.end(Buffer.from(result.data)); return true;
    }
    if (action === 'proposals') {
      const proposalId=parts[5];
      if(!parts[6]&&req.method==='GET'){json(res,variants.describe(id,proposalId,Number(url.searchParams.get('revision'))));return true;}
      if(parts[6]==='normalize'&&req.method==='POST'){const input=await b();revision(d,input.revision);json(res,variants.startNormalize(id,proposalId,d.revision,input.alphaThreshold??128),202);return true;}
      if(parts[6]==='variants'&&parts[8]==='frame'&&req.method==='GET'){json(res,await variants.frame(id,proposalId,parts[7],url.searchParams.get('asset')??'',url.searchParams.get('frame')??'',Number(url.searchParams.get('revision')),url.searchParams.get('overlay')??undefined,url.searchParams.get('against')??'raw'));return true;}
      throw new StudioError('API biến thể không tồn tại.',404);
    }
    if(action==='processing'&&req.method==='GET'){const job=variants.jobs.get(parts[5]);if(!job||job.projectId!==id)throw new StudioError('Tác vụ không tồn tại.',404);json(res,job);return true;}
    if(action==='reference-proposal'&&req.method==='POST'){
      const input=await b();revision(d,input.revision);const a=d.assets.find(a=>a.id===input.assetId);if(!a)throw new StudioError('Asset mẫu không tồn tại.',404);
      let generation: GenerationContext;
      if (input.artDirection !== undefined) {
        let resolved;
        try {
          resolved = resolveTargetSettings(d, a, input.generationOptions, input.artDirection);
        } catch (e) {
          throw new StudioError((e as Error).message, 400);
        }
        delete (resolved.options as any).animation;
        generation = { options: resolved.options, assetId: a.id, w: a.w, h: a.h, palette: resolved.effectivePalette };
      } else {
        let options;try{options=generationOptions(input.generationOptions??{});}catch(e){throw new StudioError((e as Error).message);}delete options.animation;
        generation = { options, assetId: a.id, w: a.w, h: a.h, palette: [...a.palette] };
      }

      const full=store.hydrate(d,(asset,frame)=>asset.id===a.id&&frame===input.frameId).assets.find(k=>k.id===a.id)!;
      const prepared=await variants.reference(id,d.revision,full,input.frameId,generation);revision(store.load(id),d.revision);
      json(res,variants.addReference(id,d.revision,prepared.info,generation));return true;
    }
    if (action === 'code-preview' && req.method === 'POST') {
      const input = await b(); revision(d, input.revision); validateFiles(input.files, input.entry);
      const candidate: ProjectDocument = { schemaVersion: 1, id, name: d.name, revision: d.revision, files: input.files, entry: input.entry, pixels: {}, metadata: {} };
      if(input.variants===true){json(res,await variants.capture(id,d.revision,candidate));return true;}
      const assets = await raster(candidate); revision(store.load(id), d.revision); const proposalId = proposal(id, d.revision, assets); json(res, { proposalId, assets }); return true;
    }
    if (action === 'apply-proposal' && req.method === 'POST') {
      const input = await b(); revision(d, input.revision);

      // Validate exact object/string lengths and kind/target before awaiting raster
      if (input.library !== undefined) {
        try {
          validateApplyLibraryOptions(input.library, d);
        } catch (err) {
          const msg = (err as Error).message;
          const status = msg.includes('không tồn tại') ? 404 : 400;
          throw new StudioError(msg, status);
        }
      }

      const batchMatch = batchManager.findBatchByProposalId(input.proposalId);
      if (batchMatch) {
        if (!['ready', 'partial'].includes(batchMatch.batch.status)) {
          throw new StudioError('Chỉ có thể áp dụng khi đợt tạo đã hoàn tất (ready hoặc partial).', 409);
        }
        if (batchMatch.candidate.status !== 'ready') {
          throw new StudioError('Ứng viên không ở trạng thái sẵn sàng để áp dụng.', 409);
        }
        if (batchMatch.batch.revision !== d.revision) {
          throw new StudioError('Revision đã thay đổi.', 409);
        }
      }
      let assets: PixelAsset[], jobId: string | undefined;
      if (variants.records.has(input.proposalId)) {
        ({ assets, jobId } = await variants.forApply(id, input.proposalId, d.revision, input.variantId));
      } else {
        if (input.variantId) throw new StudioError('Biến thể không tồn tại.', 404);
        const p = proposals.get(input.proposalId);
        if (!p || p.projectId !== id || p.revision !== d.revision) {
          throw new StudioError('Đề xuất đã cũ hoặc hết hạn. Dựng lại trên revision hiện tại.', 409, 'STALE_REVISION');
        }
        if (p.quality?.errors.length) {
          throw new StudioError(`Không thể áp dụng: ${p.quality.errors.join('\n')}`, 422);
        }
        assets = p.assets;
        jobId = p.jobId;
      }

      // Reject multi-asset ambiguity when library options are provided
      if (input.library !== undefined && assets.length !== 1) {
        throw new StudioError('Tùy chọn library chỉ áp dụng cho đề xuất chứa đúng 1 asset.', 400);
      }

      // Preserve captured provider/prompt/generation config and validated manifest suggestions as optional provenance
      if (batchMatch) {
        const batchProv: BatchProvenance = {
          batchId: batchMatch.batch.id,
          candidateId: batchMatch.candidate.id,
          provider: batchMatch.batch.provider,
          transport: batchMatch.candidate.transport,
          model: batchMatch.candidate.model,
          usage: batchMatch.candidate.usage ? { ...batchMatch.candidate.usage } : undefined,
          prompt: batchMatch.batch.prompt,
          config: {
            target: {
              w: batchMatch.batch.snapshot.targetW,
              h: batchMatch.batch.snapshot.targetH,
              name: batchMatch.batch.snapshot.targetName,
              assetId: batchMatch.batch.snapshot.assetId,
            },
            ...(batchMatch.batch.snapshot.generation?.operation === 'region-edit' && batchMatch.batch.snapshot.generation.animation ? {
              operation: 'region-edit' as const,
              regionEdit: {
                frameId: batchMatch.batch.snapshot.generation.animation.frameId,
                duration: batchMatch.batch.snapshot.generation.animation.duration,
                anchor: {
                  x: batchMatch.batch.snapshot.generation.animation.anchor.x,
                  y: batchMatch.batch.snapshot.generation.animation.anchor.y,
                },
              },
            } : {}),
            ...(batchMatch.batch.snapshot.generation?.operation === 'clip-regenerate' && batchMatch.batch.snapshot.generation.clip ? {
              operation: 'clip-regenerate' as const,
              clip: structuredClone(batchMatch.batch.snapshot.generation.clip.context),
            } : {}),
            options: batchMatch.batch.snapshot.generation?.options ? {
              style: batchMatch.batch.snapshot.generation.options.style,
              view: batchMatch.batch.snapshot.generation.options.view,
              paletteMode: batchMatch.batch.snapshot.generation.options.paletteMode,
              reference: batchMatch.batch.snapshot.generation.options.reference,
            } : undefined,
            artDirection: {
              style: batchMatch.batch.snapshot.artDirection.style,
              paletteMode: batchMatch.batch.snapshot.artDirection.paletteMode,
              palette: batchMatch.batch.snapshot.artDirection.palette ? [...batchMatch.batch.snapshot.artDirection.palette] : undefined,
              light: batchMatch.batch.snapshot.artDirection.light,
              detailLevel: batchMatch.batch.snapshot.artDirection.detailLevel,
              outline: batchMatch.batch.snapshot.artDirection.outline,
              references: batchMatch.batch.snapshot.artDirection.references?.map(r => ({
                assetId: r.assetId,
                frameId: r.frameId,
                name: batchMatch.batch.snapshot.referenceAssets.find(a => a.assetId === r.assetId && a.frameId === r.frameId)?.name,
              })),
            },
          },
          manifest: batchMatch.candidate.manifest ? structuredClone(batchMatch.candidate.manifest) : undefined,
        };
        for (const a of assets) {
          a.provenance = {
            ...(a.provenance ?? { kind: 'generated', originalSource: a.source }),
            batch: batchProv,
          };
        }
      }

      // Compute resulting document immutably
      let nextDoc: PixelDocument;
      if (input.library !== undefined) {
        try {
          nextDoc = applyLibraryVersion(d, assets[0], input.library);
        } catch (e) {
          throw new StudioError((e as Error).message, 400);
        }
      } else {
        nextDoc = { ...d, assets: [...d.assets, ...assets] };
      }

      // Recheck batch and candidate state immediately before synchronous store.save!
      if (batchMatch) {
        if (!['ready', 'partial'].includes(batchMatch.batch.status)) {
          throw new StudioError('Chỉ có thể áp dụng khi đợt tạo đã hoàn tất (ready hoặc partial).', 409);
        }
        if (batchMatch.candidate.status !== 'ready') {
          throw new StudioError('Ứng viên không ở trạng thái sẵn sàng để áp dụng.', 409);
        }
        if (batchMatch.batch.revision !== store.load(id).revision) {
          throw new StudioError('Revision đã thay đổi.', 409);
        }
      }
      revision(store.load(id), d.revision);
      const saved = store.save(id, d.revision, nextDoc, 'Trước khi nhập từ mã/AI');
      if (jobId) {
        try {
          const job = ai.get(jobId);
          job.status = 'applied';
          job.message = 'Đã nhập thành asset mới; bản trước được giữ trong lịch sử.';
          if (job.candidateIndex === undefined) {
            emit({ type: 'pixel-ai', event: { type: 'ai', job } });
          }
        } catch {}
      }
      if (batchMatch) {
        batchManager.onProposalApplied(input.proposalId, saved.revision);
      }
      variants.records.delete(input.proposalId);
      proposals.delete(input.proposalId);
      observe(saved);
      emit({ type: 'pixel-saved', projectId: id, revision: saved.revision });
      json(res, saved);
      return true;
    }
    if (action === 'generation-batches') {
      if (!parts[5]) {
        if (req.method === 'GET') {
          json(res, batchManager.list(id));
          return true;
        }
        if (req.method === 'POST') {
          const input = await b();
          revision(d, input.revision);

          // Validate inputs synchronously before preparation
          if (!input || typeof input !== 'object') {
            throw new StudioError('Dữ liệu yêu cầu không hợp lệ.', 400);
          }
          // Only active providers allocate new work; a retired one is never remapped.
          if (!isActiveAiProvider(input.provider)) {
            throw new StudioError('Chọn Codex hoặc DeepSeek API và nhập yêu cầu 1–12.000 ký tự.', 400);
          }
          if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) {
            throw new StudioError('Chọn CLI và nhập yêu cầu 1–12.000 ký tự.', 400);
          }
          if (input.generationOptions !== undefined) {
            if (!input.generationOptions || typeof input.generationOptions !== 'object' || Array.isArray(input.generationOptions)) {
              throw new StudioError('generationOptions phải là cấu hình tạo ảnh.', 400);
            }
            try {
              generationOptions(input.generationOptions);
            } catch (e) {
              throw new StudioError((e as Error).message, 400);
            }
          }
          if (input.artDirection !== undefined) {
            try {
              validateArtDirection(input.artDirection, d);
            } catch (e) {
              throw new StudioError((e as Error).message, 400);
            }
          }
          if (input.provider === 'deepseek') {
            if (input.regionEdit !== undefined || input.clipGeneration !== undefined) {
              throw new StudioError('DeepSeek API chỉ hỗ trợ tạo từ văn bản. Sửa vùng hoặc tạo clip cần chọn Codex.', 400);
            }
            const asset = d.assets.find(a => a.id === input.assetId) ?? (input.assetId ? undefined : d.assets[0]);
            if (!asset) throw new StudioError('Không tìm thấy asset làm ngữ cảnh AI.', 404);
            const resolved = resolveTargetSettings(d, asset, input.generationOptions, input.artDirection);
            assertDeepSeekTextOnly(undefined, {
              assetId: asset.id, w: asset.w, h: asset.h,
              palette: resolved.effectivePalette, options: resolved.options,
            }, undefined, { artDirection: resolved.artDirection });
          }
          if (input.regionEdit !== undefined) {
            if (!input.regionEdit || typeof input.regionEdit !== 'object' || Array.isArray(input.regionEdit)) {
              throw new StudioError('regionEdit phải là một object.', 400);
            }
            const rEdit = input.regionEdit as Record<string, unknown>;
            const allowedKeys = ['frameId', 'mask', 'anchor'];
            for (const k of Object.keys(rEdit)) {
              if (!allowedKeys.includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
                throw new StudioError(`Thuộc tính regionEdit '${k}' không được hỗ trợ.`, 400);
              }
            }
            if (input.generationOptions && (input.generationOptions as any).animation !== undefined) {
              throw new StudioError('Không thể dùng đồng thời animation và regionEdit.', 400);
            }
            const targetAsset = d.assets.find(item => item.id === input.assetId) ?? (input.assetId ? undefined : d.assets[0]);
            if (!targetAsset) throw new StudioError('Không tìm thấy asset làm ngữ cảnh AI.', 404);
            if (typeof rEdit.frameId !== 'string') throw new StudioError('regionEdit.frameId phải là chuỗi.', 400);
            const sourceFrame = targetAsset.frames.find(f => f.id === rEdit.frameId);
            if (!sourceFrame) throw new StudioError('Frame mẫu không tồn tại.', 404);
            if (!Array.isArray(rEdit.mask) || rEdit.mask.length !== targetAsset.w * targetAsset.h || rEdit.mask.some(v => v !== 0 && v !== 1) || !rEdit.mask.some(v => v === 1)) {
              throw new StudioError('Mask không khớp kích thước canvas hoặc không có vùng chọn.', 400);
            }
            if (rEdit.anchor !== undefined) {
              if (!rEdit.anchor || typeof rEdit.anchor !== 'object' || Array.isArray(rEdit.anchor)) {
                throw new StudioError('anchor trong regionEdit phải là object.', 400);
              }
              const anc = rEdit.anchor as Record<string, unknown>;
              for (const k of Object.keys(anc)) {
                if (!['x', 'y'].includes(k) || ['__proto__', 'prototype', 'constructor'].includes(k)) {
                  throw new StudioError(`Thuộc tính anchor '${k}' không được hỗ trợ.`, 400);
                }
              }
              if (typeof anc.x !== 'number' || !Number.isFinite(anc.x) || typeof anc.y !== 'number' || !Number.isFinite(anc.y)) {
                throw new StudioError('Tọa độ anchor phải là số hữu hạn.', 400);
              }
              if (anc.x < 0 || anc.x > targetAsset.w || anc.y < 0 || anc.y > targetAsset.h) {
                throw new StudioError('Điểm neo ngoài canvas.', 400);
              }
            }
          }

          const { release: releasePrepLease, epoch } = batchManager.acquireLease(id);
          let snapshot: PreparedSnapshot;
          try {
            snapshot = await prepareGenerationSnapshot(
              store,
              variants,
              d,
              input.assetId,
              input.generationOptions,
              input.artDirection,
              true,
              input.regionEdit,
              input.clipGeneration
            );
          } catch (err) {
            releasePrepLease();
            throw err;
          }

          try {
            batchManager.checkLeaseValid(id, epoch);
          } catch (err) {
            releasePrepLease();
            if (snapshot.referenceVariantId) {
              try { variants.discardReference(id, snapshot.referenceVariantId); } catch {}
            }
            throw err;
          }

          // Register captured snapshot in contexts immediately so candidate preview can load it
          contexts.set(id, snapshot.contextDoc);

          try {
            const batch = batchManager.createBatch(
              id,
              input.provider,
              input.prompt,
              snapshot,
              releasePrepLease
            );
            json(res, toCompactBatch(batch), 202);
            return true;
          } catch (err) {
            releasePrepLease();
            if (snapshot.referenceVariantId) {
              try { variants.discardReference(id, snapshot.referenceVariantId); } catch {}
            }
            throw err;
          }
        }
        throw new StudioError('Method không được phép.', 405);
      }
      const batchId = parts[5];
      if (!parts[6]) {
        if (req.method === 'GET') {
          json(res, batchManager.getCompact(id, batchId));
          return true;
        }
        throw new StudioError('Method không được phép.', 405);
      }
      if (parts[6] === 'cancel' && req.method === 'POST') {
        const input = await b();
        json(res, await batchManager.cancelBatch(id, batchId, input.revision));
        return true;
      }
      if (parts[6] === 'candidates' && parts[7] && parts[8] === 'retry' && req.method === 'POST') {
        const input = await b();
        json(res, await batchManager.retryCandidate(id, batchId, parts[7], input.revision), 202);
        return true;
      }
      if (parts[6] === 'candidates' && parts[7] && parts[8] === 'preview' && req.method === 'POST') {
        const input = await b();
        const batch = batchManager.getBatch(id, batchId);
        if (!contexts.has(id)) contexts.set(id, batch.snapshot.contextDoc);
        json(res, await batchManager.previewCandidate(id, batchId, parts[7], input.revision));
        return true;
      }
      if (parts[6] === 'preview' && req.method === 'POST') {
        const input = await b();
        const candidateId = input.candidateId ?? url.searchParams.get('candidateId');
        if (!candidateId) throw new StudioError('Thiếu candidateId.', 400);
        const batch = batchManager.getBatch(id, batchId);
        if (!contexts.has(id)) contexts.set(id, batch.snapshot.contextDoc);
        json(res, await batchManager.previewCandidate(id, batchId, candidateId, input.revision));
        return true;
      }
      throw new StudioError('Không tìm thấy thao tác đợt tạo AI.', 404);
    }
    if (action === 'figure-review') {
      if (req.method === 'GET') {
        json(res,parts[5] ? figureSample(store.dir(id),parts[5]) : figureHistory(store.dir(id))); return true;
      }
      if (req.method === 'POST' && parts[6] === 'revise') {
        const input = await b();
        revision(store.load(id), input.revision);
        json(res, reviseFigure(store.dir(id), parts[5], d.revision, input.edits, input.note, input.move), 201);
        return true;
      }
      if (req.method === 'POST' && parts[6]==='select') {
        const input=await b(); revision(d,input.revision);
        const sample=figureSample(store.dir(id),parts[5]); revision(d,sample.revision);
        if(sample.stage==='shape'||sample.errors.length) throw new StudioError('Chọn bản hoàn thiện hợp lệ.',422);
        const g=sample.plan.generation;
        const a=flatAsset(newAsset('Nhân vật',g.w,g.h),[sample.pixels]);
        if(g.options.paletteMode==='asset') a.palette=[...g.palette];
        const png=exportPixel({document:{...d,assets:[a]},assetId:a.id,format:'png'});
        if(!encodePng(new Img(g.w,g.h,sample.pixels)).equals(png.data))
          throw new StudioError('PNG xuất khác với bản đang xem.',422);
        json(res,{proposalId:proposal(id,d.revision,[a],sample.id)});return true;
      }
      throw new StudioError('Thao tác không hợp lệ.',405);
    }
    if (action === 'ai') {
      if (!parts[5]) {
        if (req.method === 'GET') {
          json(res, [...ai.jobs.values()].filter(j => j.projectId === id && j.candidateIndex === undefined));
          return true;
        }
        if (req.method !== 'POST') throw new StudioError('Method không được phép.', 405);
        const input = await b();
        revision(d, input.revision);

        if (!input || typeof input !== 'object') {
          throw new StudioError('Dữ liệu yêu cầu không hợp lệ.', 400);
        }
        // Legacy /ai rejects retired providers with the same admission wording: no remap.
        if (!isActiveAiProvider(input.provider)) {
          throw new StudioError('Chọn Codex hoặc DeepSeek API và nhập yêu cầu 1–12.000 ký tự.', 400);
        }
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) {
          throw new StudioError('Chọn CLI và nhập yêu cầu 1–12.000 ký tự.', 400);
        }
        if (input.generationOptions !== undefined) {
          if (!input.generationOptions || typeof input.generationOptions !== 'object' || Array.isArray(input.generationOptions)) {
            throw new StudioError('generationOptions phải là cấu hình tạo ảnh.', 400);
          }
          try {
            generationOptions(input.generationOptions);
          } catch (e) {
            throw new StudioError((e as Error).message, 400);
          }
        }
        if (input.provider === 'deepseek') {
          if (input.generationOptions === undefined || input.regionEdit !== undefined || input.clipGeneration !== undefined) {
            throw new StudioError('Đường tạo ảnh này cần ảnh nguồn. Chọn Codex hoặc dùng cấu hình tạo mới từ văn bản với DeepSeek API.', 400);
          }
          const asset = d.assets.find(a => a.id === input.assetId) ?? (input.assetId ? undefined : d.assets[0]);
          if (!asset) throw new StudioError('Không tìm thấy asset làm ngữ cảnh AI.', 404);
          let art;
          try { art = input.artDirection === undefined ? undefined : validateArtDirection(input.artDirection, d); }
          catch (error) { throw new StudioError((error as Error).message, 400); }
          assertDeepSeekTextOnly(undefined, {
            assetId: asset.id, w: asset.w, h: asset.h, palette: asset.palette,
            options: generationOptions(input.generationOptions),
          }, undefined, { artDirection: art });
        }
        if (input.regionEdit !== undefined) {
          throw new StudioError('Legacy /ai không hỗ trợ regionEdit.', 400);
        }
        if (input.poseSpec !== undefined && input.figureStage !== 'shape') {
          throw new StudioError('PoseSpec chỉ dùng ở bước dựng dáng.', 400);
        }

        const { release: releasePrepLease, epoch } = batchManager.acquireLease(id);
        let snapshot: PreparedSnapshot;
        let figure: ReturnType<typeof prepareFigure> | undefined;
        try {
          const parentPlan = input.figureStage === 'finish' || input.figureStage === 'repair'
            ? figureSample(store.dir(id), input.parentId).plan : undefined;
          snapshot = await prepareGenerationSnapshot(
            store,
            variants,
            d,
            input.assetId,
            parentPlan?.generation.options ?? input.generationOptions,
            input.figureStage ? parentPlan?.art ?? input.artDirection : undefined,
            Boolean(input.figureStage)
          );
          if(input.figureStage !== undefined){
            if(input.provider!=='codex') throw new StudioError('Duyệt dáng dùng Codex.');
            figure=prepareFigure(store.dir(id),input,snapshot);
          }
        } catch (err) {
          releasePrepLease();
          throw err;
        }

        try {
          batchManager.checkLeaseValid(id, epoch);
        } catch (err) {
          releasePrepLease();
          if (snapshot.referenceVariantId) {
            try { variants.discardReference(id, snapshot.referenceVariantId); } catch {}
          }
          throw err;
        }
        contexts.set(id, snapshot.contextDoc);
        const prompt = snapshot.isLegacyWithoutOptions
          ? `${input.prompt}\nCreate a complete new asset, not a partial overlay. Target canvas ${snapshot.targetW}x${snapshot.targetH}. The attached preview shows the current hand-painted image.`
          : input.prompt;
        try {
          const job = await ai.start(
            snapshot.contextDoc,
            input.provider,
            figure?.prompt ?? prompt,
            snapshot.preview ? new Uint8Array(snapshot.preview) : undefined,
            snapshot.generation,
            snapshot.movementMask ? new Uint8Array(snapshot.movementMask) : undefined,
            figure ? { singleAttempt:true, figureStage:figure.record.stage, artDirection:figure.record.plan.art,
              referenceImages:snapshot.referenceAssets.map(a=>({name:a.name,data:a.image})),
              ...(snapshot.guideImage ? { guideImage:{name:'clip-guide.png',data:snapshot.guideImage} } : {}) } : undefined
          );
          if(figure) rememberFigure(store.dir(id),job.id,figure.record);
          if (snapshot.referenceVariantId) {
            variants.rememberReference(job.id, id, snapshot.referenceVariantId);
          }
          releasePrepLease();
          json(res, job, 202);
          return true;
        } catch (err) {
          releasePrepLease();
          if (snapshot.referenceVariantId) {
            try { variants.discardReference(id, snapshot.referenceVariantId); } catch {}
          }
          throw err;
        }
      }
      const job = ai.get(parts[5]); if (job.projectId !== id) throw new StudioError('Sai dự án.', 403);
      if (!parts[6] && req.method === 'GET') { json(res, job); return true; }
      if (parts[6] === 'cancel' && req.method === 'POST') { await b(); json(res, await ai.cancel(job.id)); return true; }
      if (parts[6] === 'preview' && req.method === 'POST') {
        const input = await b(); revision(d, input.revision); const candidate = ai.candidate(job.id);
        const fig=figureInput(store.dir(id),job.id);
        if(fig){
          revision(d,job.revision);
          const assets=await raster(candidate);
          revision(store.load(id),job.revision);
          json(res,renderFigure(store.dir(id),job.id,fig,assets));return true;
        }
        if(input.variants===true||job.generation?.animation){json(res,await variants.capture(id,d.revision,candidate,job.generation,job.id));return true;}
        let assets: PixelAsset[], quality: GenerationReport | undefined;
        if (job.generation) {
          const result = await run(id, { document: candidate, mode: 'generation-preview', generation: job.generation }) as ExportResult;
          ({ assets, quality } = wireParse(Buffer.from(result.data).toString('utf8')));
        } else assets = await raster(candidate);
        revision(store.load(id), job.revision); job.quality = quality;
        const proposalId = proposal(id, job.revision, assets, job.id, quality);
        json(res, { proposalId, assets, quality, generation: job.generation }); return true;
      }
    }
    if (action === 'close' && req.method === 'POST') {
      await b();
      // Close the shared gate synchronously before awaiting any local worker.
      const closingBatch = batchManager.closeProject(id);
      await quality?.closeProject(id);
      await terrain.closeProject(id);
      await closingBatch;
      for (const job of ai.jobs.values()) {
        if (job.projectId === id && ['running', 'validating', 'canceling'].includes(job.status)) {
          await ai.cancel(job.id);
        }
      }
      contexts.delete(id);
      const path = join(store.dir(id), 'pxl.project.json');
      unwatchFile(path);
      watched.delete(path);
      const pending = [...tasks.get(id) ?? []];
      for (const task of pending) task.cancel();
      await Promise.allSettled(pending.map(t => t.promise));
      variants.closeProject(id);
      batchManager.finishCloseProject(id);
      store.releaseResources(id);
      json(res, { ok: !quality?.hasUnresolved(id), qualityUnknown: quality?.hasUnresolved(id) ?? false });
      return true;
    }
    throw new StudioError('Không tìm thấy thao tác pixel.', 404);
  }
  return {
    route,
    agentSaved: (doc: PixelDocument) => { observe(doc); emit({ type: 'pixel-saved', projectId: doc.id, revision: doc.revision }); },
    close: async () => {
      const closingBatch = batchManager.close();
      await quality?.close();
      await terrain.close();
      for (const p of watched.keys()) unwatchFile(p);
      watched.clear();
      const pending = [...tasks.values()].flatMap(set => [...set]);
      for (const task of pending) task.cancel();
      await Promise.allSettled(pending.map(t => t.promise));
      await closingBatch;
      await ai.close();
      variants.close();
      store.releaseResources();
      contexts.clear();
    },
  };
}
