import type { IncomingMessage, ServerResponse } from 'node:http';
import { deserialize } from 'node:v8';
import { QualityEngine } from './quality-engine.ts';
import { QualityRuntime } from './quality-runtime.ts';
import { QualityCliTransport } from './quality-cli.ts';
import { QualityJournal, qualityRunning, type QualityJournalRecord } from './quality-journal.ts';
import { qualityInput, qualityRevision } from './quality-source.ts';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';
import type { GenerationBatchManager } from './generation-batches.ts';
import type { ProviderSettings } from './ai.ts';
import { RenderPool, type RenderTask } from './runner.ts';
import type { ExportResult } from './render.ts';
import type { QualityRun } from '../../studio/quality/run.ts';
import type { QualityProjectApproval } from '../../studio/quality/project.ts';
import type { RigDraft } from '../../studio/quality/rig-draft.ts';
import { wireParse, wireStringify, type PixelDocument, type PixelAsset } from '../../studio/pixel/model.ts';
import { dataId } from '../../studio/quality/data.ts';
import { applyLibraryVersion, validateApplyLibraryOptions } from '../../studio/asset-library.ts';

const send = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(wireStringify(value)); };
/** Project-facing quality pipeline. No receipt, context root or provider choice is accepted from HTTP. */
export class QualityApi {
  private store: PixelStore; private pool: RenderPool; private batches: GenerationBatchManager;
  private emit: (event: unknown) => void; private journal: QualityJournal;
  private runtime: QualityRuntime; private cli: QualityCliTransport; private engine: QualityEngine;
  private records = new Map<string, QualityJournalRecord>();
  private preparing = new Map<string, Set<RenderTask>>(); private closing = new Set<string>(); private closed = false;
  private starting?: { approvalId: string; prompt: string; style: string };
  private removeGuard: () => void;
  private journalErrors = new Map<string, string>();
  constructor(store: PixelStore, pool: RenderPool, batches: GenerationBatchManager, emit: (e: unknown) => void, settings: ProviderSettings = {}) {
    this.store = store; this.pool = pool; this.batches = batches; this.emit = emit; this.journal = new QualityJournal(store); this.runtime = new QualityRuntime(pool);
    // Delegate DeepSeek HTTP config to the transport as trusted server config; never from an HTTP request.
    this.cli = new QualityCliTransport((s, c) => this.runtime.cliContext(s, c), {
      providers: { ...(settings.codex ? { codex: { executable: settings.codex, prefix: settings.prefix } } : {}) },
      ...(settings.deepseek ? { deepseek: settings.deepseek } : {}),
      motionReviewerEffort: settings.motionReviewerEffort,
      characterConstructionEffort: settings.characterConstructionEffort,
    });
    const ports = this.runtime.ports({ acquire: project => {
      if (this.closed || this.closing.has(project)) throw new StudioError('Dự án chất lượng đang đóng.', 409);
      const lease = batches.acquireLease(project); return { release: lease.release, check: () => batches.checkLeaseValid(project, lease.epoch) };
    }, assertCurrent: (project, revision) => {
      if (this.journalErrors.has(project)) throw new Error(`Không lưu được nhật ký: ${this.journalErrors.get(project)}`);
      qualityRevision(store.load(project), revision);
    }, execute: request => {
      const record = [...this.records.values()].find(r => r.snapshotId === request.snapshotId);
      if (!record) throw new Error('Mất quyền sở hữu snapshot của lượt tạo.');
      // Persist the call and owned context root BEFORE starting any process.
      record.run = this.engine.get(record.run.id); this.journal.save(record);
      return this.cli.execute(request);
    } });
    const prepare = ports.prepare, validate = ports.validate, drop = ports.drop;
    ports.prepare = input => {
      const record = [...this.records.values()].find(r => r.run.projectId === input.projectId && qualityRunning(r.run));
      if (!record) throw new Error('Mất lượt tạo trước khi chuẩn bị nguồn.');
      const task = prepare(input);
      return { promise: task.promise.then(value => {
        record.snapshotId = value.snapshotId; this.journal.save(record); return value;
      }), stop: d => task.stop(d) };
    };
    ports.validate = (role, output, prepared, director, candidateId) => {
      const record = [...this.records.values()].find(r => r.snapshotId === prepared.snapshotId);
      if (!record) throw new Error('Mất nhật ký cho vai chất lượng.');
      this.journal.response(record, this.engine.get(record.run.id).calls.at(-1)!.id, output);
      return validate(role, output, prepared, director, candidateId);
    };
    ports.drop = snapshot => { this.cli.dropSnapshot(snapshot); drop(snapshot); for (const [id, r] of this.records) if (r.snapshotId === snapshot) this.records.delete(id); };
    const short = typeof settings.timeout === 'number' ? { director: settings.timeout, builder: settings.timeout, reviewer: settings.timeout } : undefined;
    this.engine = new QualityEngine(ports, { limits: short, characterFinishStudy: settings.characterFinishStudy, emit: run => {
      let record = this.records.get(run.id);
      if (!record && this.starting) { record = { version: 1, run, ...this.starting, cliRoot: this.cli.root, ownerPid: process.pid }; this.records.set(run.id, record); }
      if (record) { record.run = run; try { this.journal.save(record); } catch (e) { this.journalErrors.set(run.projectId, (e as Error).message); } }
      this.emit({ type: 'pixel-quality', run });
    } });
    this.removeGuard = batches.addBusyGuard(project => this.journal.list(project).some(r => !this.records.has(r.run.id) && qualityRunning(r.run)));
  }
  private descriptor(project: string, revision: number, approvalId: string) { return { kind: 'project-approval', root: this.store.root, projectId: project, revision, approvalId }; }
  hasUnresolved(project: string): boolean { return this.engine.list(project).some(qualityRunning) || this.journal.list(project).some(r => !this.records.has(r.run.id) && qualityRunning(r.run)); }
  private async history(project: string): Promise<QualityJournalRecord[]> {
    const records = this.journal.list(project);
    for (const r of records) if (!this.records.has(r.run.id) && qualityRunning(r.run) && !await this.journal.recover(r, false)) { r.run.status = 'unknown'; r.run.message = 'Tác vụ thuộc phiên máy chủ trước; chưa xác nhận đã dừng. Không tự chạy lại.'; }
    return records;
  }
  private record(project: string, id: string): QualityJournalRecord {
    dataId(id, 'Lượt chất lượng'); const active = this.records.get(id);
    if (active) { if (active.run.projectId !== project) throw new StudioError('Lượt tạo không thuộc dự án.', 404); try { active.run = this.engine.get(id); return active; } catch { this.records.delete(id); } }
    return this.journal.get(project, id);
  }
  private public(record: QualityJournalRecord) { return { ...record.run, approvalId: record.approvalId, previewAvailable: this.records.has(record.run.id) && !!record.snapshotId && !record.appliedAssetId && !this.closing.has(record.run.projectId), ...(record.appliedAssetId ? { appliedAssetId: record.appliedAssetId } : {}) }; }
  private async local(project: string, request: Parameters<RenderPool['start']>[0]): Promise<ExportResult> {
    if (this.closed || this.closing.has(project)) throw new StudioError('Dự án đang đóng.', 409);
    const task = this.pool.start(request); let set = this.preparing.get(project); if (!set) this.preparing.set(project, set = new Set()); set.add(task);
    try { return await task.promise as ExportResult; } finally { set.delete(task); if (!set.size) this.preparing.delete(project); }
  }
  async route(req: IncomingMessage, res: ServerResponse, parts: string[], d: PixelDocument, body: () => Promise<any>, url: URL): Promise<boolean> {
    const action = parts[4], project = d.id;
    if (!['quality', 'quality-runs', 'rig-drafts'].includes(action)) return false;
    if (action === 'rig-drafts') {
      if (parts[5]) dataId(parts[5], 'ID nháp rig');
      if (parts[6] && (parts[6] !== 'refresh' || parts[7])) throw new StudioError('Không tìm thấy lệnh nháp rig.', 404);
      if (parts[6] === 'refresh') {
        if (req.method !== 'POST') throw new StudioError('Refresh rig cần POST.', 405);
        const input = qualityInput(await body(), ['revision', 'parts']); qualityRevision(d, input.revision); await this.history(project);
        const lease = this.batches.acquireLease(project);
        try {
          const result = await this.local(project, { mode: 'quality-source', root: this.store.root, projectId: project, revision: d.revision, operation: 'rig-refresh', input: { ...input, draftId: parts[5] } });
          this.batches.checkLeaseValid(project, lease.epoch); qualityRevision(this.store.load(project), d.revision);
          const prepared = deserialize(Buffer.from(result.data)) as { document: PixelDocument; draft: RigDraft };
          const saved = this.store.save(project, d.revision, prepared.document, 'Trước khi cập nhật pixel bộ phận rig');
          this.emit({ type: 'pixel-saved', projectId: project, revision: saved.revision }); send(res, { document: saved, draft: saved.studio!.rigDrafts![prepared.draft.id], assetId: prepared.draft.rig.source.assetId });
        } finally { lease.release(); }
        return true;
      }
      if (req.method === 'GET') {
        if (parts[5]) { const draft = d.studio?.rigDrafts?.[parts[5]]; if (!draft) throw new StudioError('Không tìm thấy nháp rig.', 404); send(res, draft); }
        else send(res, Object.values(d.studio?.rigDrafts ?? {}).map(r => ({ id: r.id, name: r.name, assetId: r.rig.source.assetId, frameId: r.rig.source.frameId })));
        return true;
      }
      if (req.method === 'POST' && !parts[5]) {
        const input = qualityInput(await body(), ['revision', 'assetId', 'frameId', 'name']); qualityRevision(d, input.revision); await this.history(project);
        const lease = this.batches.acquireLease(project);
        try {
          const result = await this.local(project, { mode: 'quality-source', root: this.store.root, projectId: project, revision: d.revision, operation: 'rig-draft', input });
          this.batches.checkLeaseValid(project, lease.epoch); qualityRevision(this.store.load(project), d.revision);
          const prepared = deserialize(Buffer.from(result.data)) as { document: PixelDocument; draft: RigDraft };
          const saved = this.store.saveQuality(project, d.revision, prepared.document, 'Trước khi tạo bản sao nguồn rig');
          this.emit({ type: 'pixel-saved', projectId: project, revision: saved.revision }); send(res, { document: saved, draft: saved.studio!.rigDrafts![prepared.draft.id], assetId: prepared.draft.rig.source.assetId }, 201);
        } finally { lease.release(); }
        return true;
      }
      if (req.method === 'DELETE' && parts[5]) {
        const input = qualityInput(await body(), ['revision']); qualityRevision(d, input.revision);
        if (this.batches.isProjectBusy(project)) throw new StudioError('Đang có tác vụ AI; chưa xóa nháp rig.', 409);
        if (!d.studio?.rigDrafts?.[parts[5]]) throw new StudioError('Không tìm thấy nháp rig.', 404);
        delete d.studio.rigDrafts[parts[5]];
        const saved = this.store.save(project, d.revision, d, 'Trước khi xóa nháp rig'); this.emit({ type: 'pixel-saved', projectId: project, revision: saved.revision }); send(res, saved); return true;
      }
      throw new StudioError('Method nháp rig không hợp lệ.', 405);
    }
    if (action === 'quality') {
      if (parts[5] !== 'approvals') throw new StudioError('Không tìm thấy lệnh duyệt chất lượng.', 404);
      if (parts[6]) dataId(parts[6], 'ID nguồn duyệt');
      if (req.method === 'GET') {
        const approvals = Object.values(d.studio?.quality?.approvals ?? {});
        if (parts[6]) { const a = d.studio?.quality?.approvals[parts[6]]; if (!a) throw new StudioError('Không tìm thấy nguồn đã duyệt.', 404); send(res, a); }
        else send(res, approvals.map(a => ({ id: a.id, kind: a.kind, revision: a.revision, approvedAt: a.approvedAt, source: a.source, canvas: a.recipe.canvas, pivot: a.recipe.pivot, frames: a.recipe.frames.map(f => ({ id: f.id, durationMs: f.durationMs })), stale: a.projectId !== project || a.revision !== d.revision })));
        return true;
      }
      if (req.method === 'POST' && !parts[6]) {
        const input = await body(); qualityRevision(d, input.revision); await this.history(project);
        const lease = this.batches.acquireLease(project);
        try {
          const result = await this.local(project, { mode: 'quality-source', root: this.store.root, projectId: project, revision: d.revision, input });
          this.batches.checkLeaseValid(project, lease.epoch); qualityRevision(this.store.load(project), d.revision);
          const prepared = deserialize(Buffer.from(result.data)) as { document: PixelDocument; approval: QualityProjectApproval };
          const saved = this.store.saveQuality(project, d.revision, prepared.document, 'Trước khi duyệt nguồn chất lượng');
          this.emit({ type: 'pixel-saved', projectId: project, revision: saved.revision }); send(res, { document: saved, approval: saved.studio!.quality!.approvals[prepared.approval.id] }, 201);
        } finally { lease.release(); }
        return true;
      }
      if (req.method === 'DELETE' && parts[6]) {
        const input = qualityInput(await body(), ['revision']); qualityRevision(d, input.revision);
        if (this.batches.isProjectBusy(project)) throw new StudioError('Đang có tác vụ AI; chưa xóa nguồn đang dùng.', 409);
        if (!d.studio?.quality?.approvals[parts[6]]) throw new StudioError('Không tìm thấy nguồn đã duyệt.', 404);
        delete d.studio.quality.approvals[parts[6]];
        const saved = this.store.saveQuality(project, d.revision, d, 'Trước khi xóa nguồn duyệt'); send(res, saved); this.emit({ type: 'pixel-saved', projectId: project, revision: saved.revision }); return true;
      }
      throw new StudioError('Method duyệt nguồn không hợp lệ.', 405);
    }
    if (!parts[5]) {
      if (req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 20); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StudioError('Giới hạn lịch sử từ 1 đến 100.');
        send(res, (await this.history(project)).sort((a, b) => Number(qualityRunning(b.run)) - Number(qualityRunning(a.run)) || b.run.started - a.run.started).slice(0, limit).map(r => this.public(this.records.has(r.run.id) ? this.record(project, r.run.id) : r))); return true;
      }
      if (req.method !== 'POST') throw new StudioError('Method chất lượng không hợp lệ.', 405);
      const input = qualityInput(await body(), ['revision', 'approvalId', 'prompt', 'style']); qualityRevision(d, input.revision); dataId(input.approvalId, 'Nguồn đã duyệt');
      const a = d.studio?.quality?.approvals[input.approvalId];
      if (!a || a.projectId !== project || a.revision !== d.revision) throw new StudioError('Duyệt nguồn trong dự án và revision hiện tại trước khi tạo.', 409);
      await this.history(project);
      if (this.journal.list(project).length >= 100) throw new StudioError('Nhật ký đã giữ 100 lượt. Sao lưu trước khi dọn lịch sử để tạo tiếp.', 409);
      this.starting = { approvalId: a.id, prompt: input.prompt, style: input.style ?? 'RPG/fantasy rõ nét, viền mảnh, ánh sáng trên trái; palette/vật liệu nguồn là bắt buộc.' };
      this.journalErrors.delete(project);
      try { const run = this.engine.start({ projectId: project, revision: d.revision, prompt: this.starting.prompt, style: this.starting.style, context: this.descriptor(project, d.revision, a.id) }); send(res, this.public(this.record(project, run.id)), 202); }
      finally { this.starting = undefined; }
      return true;
    }
    const record = this.record(project, parts[5]), step = parts[6];
    if (!step && req.method === 'DELETE') {
      const input = qualityInput(await body(), ['revision']); qualityRevision(d, input.revision);
      if (qualityRunning(record.run)) throw new StudioError('Hủy và xác nhận dừng trước khi xóa đề xuất.', 409);
      if (this.records.has(record.run.id)) {
        if (record.snapshotId && !await this.runtime.drain(record.snapshotId, Date.now() + 5000)) throw new StudioError('Chưa xác nhận worker preview dừng.', 409);
        qualityRevision(this.store.load(project), d.revision); this.engine.dispose(record.run.id);
      }
      this.records.delete(record.run.id); this.journal.remove(record); send(res, { ok: true }); return true;
    }
    if (!step && req.method === 'GET') { if (!this.records.has(record.run.id) && qualityRunning(record.run) && !await this.journal.recover(record, false)) { record.run.status = 'unknown'; record.run.message = 'Tác vụ thuộc phiên máy chủ trước; chưa xác nhận đã dừng.'; } send(res, this.public(record)); return true; }
    if (step === 'cancel' && req.method === 'POST') {
      const input = qualityInput(await body(), ['revision']); qualityRevision(d, input.revision);
      if (this.records.has(record.run.id)) record.run = await this.engine.cancel(record.run.id);
      else if (!await this.journal.recover(record, true)) { record.run.status = 'unknown'; record.run.message = 'Chưa xác nhận tác vụ của máy chủ trước đã dừng. Giữ khóa; không tự chạy lại hoặc đổi CLI.'; }
      send(res, this.public(record)); return true;
    }
    if (step === 'history' && req.method === 'GET') { send(res, { run: this.public(record), prompt: record.prompt, style: record.style, approvalId: record.approvalId }); return true; }
    if (step === 'calls' && parts[7] && req.method === 'GET') { send(res, this.journal.readResponse(record, parts[7])); return true; }
    if (!this.records.has(record.run.id) || !record.snapshotId) throw new StudioError('Preview tạm đã đóng; lịch sử vẫn còn. Tạo đề xuất mới để xem và áp dụng.', 409);
    if (step === 'variants' && parts[8] === 'retouch' && !parts[9]) {
      dataId(parts[7], 'Biến thể chỉnh pixel');
      const parent = record.run.variants.find(v => v.id === parts[7]);
      if (!parent) throw new StudioError('Biến thể không thuộc lượt tạo.', 404);
      if (record.run.status !== 'ready' || record.appliedAssetId || this.closed || this.closing.has(project)) throw new StudioError('Lượt tạo đã đóng, đã áp dụng hoặc chưa sẵn sàng chỉnh pixel.', 409);
      if (req.method === 'GET') {
        if (!url.searchParams.has('revision')) throw new StudioError('Thiếu revision của bản chỉnh pixel.');
        qualityRevision(d, Number(url.searchParams.get('revision'))); qualityRevision(d, record.run.revision);
        const frameId = url.searchParams.get('frame') ?? ''; dataId(frameId, 'Frame chỉnh pixel');
        if (!parent.frames.some(f => f.id === frameId)) throw new StudioError('Frame không thuộc biến thể.', 404);
        const task = this.runtime.retouchInfo(record.snapshotId, parent.id, d.revision, frameId, this.descriptor(project, d.revision, record.approvalId));
        const stop = () => { if (!res.writableEnded) void task.stop(Date.now() + 5000).catch(() => {}); };
        res.once('close', stop);
        try {
          const info = await task.promise;
          qualityRevision(this.store.load(project), d.revision);
          if (res.destroyed || this.closed || this.closing.has(project)) throw new StudioError('Yêu cầu chỉnh pixel đã đóng.', 409);
          send(res, info);
        } finally { res.off('close', stop); }
        return true;
      }
      if (req.method !== 'POST') throw new StudioError('Chỉnh pixel cần GET hoặc POST.', 405);
      const input = qualityInput(await body(), ['revision', 'patches', 'lockedFrames', 'region']);
      qualityRevision(d, input.revision); qualityRevision(d, record.run.revision);
      if (this.batches.isProjectBusy(project)) throw new StudioError('Đang có tác vụ khác; giữ bản nháp chỉnh pixel.', 409);
      if (record.run.variants.length >= 20) throw new StudioError('Lượt tạo đã giữ 20 biến thể; giữ bản nháp trước khi tạo lượt mới.', 409);
      const predicted = { ...parent, id: 'x'.repeat(80), kind: 'edited', parentVariantId: parent.id, description: 'Chỉnh pixel cục bộ' };
      const prospective = { ...record, run: { ...record.run, selectedVariantId: predicted.id, variants: [...record.run.variants, predicted] } };
      if (Buffer.byteLength(JSON.stringify(prospective)) > 900_000) throw new StudioError('Nhật ký lượt tạo sắp đầy; giữ bản nháp trước khi tạo lượt mới.', 409);
      const lease = this.batches.acquireLease(project);
      try {
        if (res.destroyed || this.closed || this.closing.has(project)) throw new StudioError('Yêu cầu chỉnh pixel đã đóng.', 409);
        const task = this.runtime.retouch(record.snapshotId, parent.id, d.revision,
          { patches: input.patches, lockedFrames: input.lockedFrames, region: input.region }, this.descriptor(project, d.revision, record.approvalId));
        const stop = () => { if (!res.writableEnded) void task.stop(Date.now() + 5000).catch(() => {}); };
        res.once('close', stop);
        let variant;
        try { variant = await task.promise; }
        catch (e) {
          if (e instanceof StudioError || (e as NodeJS.ErrnoException).code) throw e;
          throw new StudioError((e as Error).message, 422, 'INVALID_ASSET_PAYLOAD');
        } finally { res.off('close', stop); }
        this.batches.checkLeaseValid(project, lease.epoch); qualityRevision(this.store.load(project), d.revision);
        if (res.destroyed || this.closed || this.closing.has(project)) throw new StudioError('Yêu cầu chỉnh pixel đã đóng; giữ bản nháp.', 409);
        record.run = this.engine.addRetouchVariant(record.run.id, variant);
        this.journal.save(record);
        send(res, { variant, run: this.public(record) }, 201);
      } finally { lease.release(); }
      return true;
    }
    if (step === 'variants' && parts[8] === 'frame' && req.method === 'GET') {
      qualityRevision(d, Number(url.searchParams.get('revision'))); qualityRevision(d, record.run.revision);
      if (!record.run.variants.some(v => v.id === parts[7])) throw new StudioError('Biến thể không thuộc lượt tạo.', 404);
      const frame = url.searchParams.get('frame') ?? ''; dataId(frame, 'Frame preview');
      const result = await this.runtime.materialize(record.snapshotId, parts[7], d.revision, frame, this.descriptor(project, d.revision, record.approvalId)).promise;
      qualityRevision(this.store.load(project), d.revision);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(Buffer.from(result.data)); return true;
    }
    if (step === 'apply' && req.method === 'POST') {
      const input = qualityInput(await body(), ['revision', 'variantId', 'library']); qualityRevision(d, input.revision); qualityRevision(d, record.run.revision);
      if (record.run.status !== 'ready' || record.appliedAssetId || this.batches.isProjectBusy(project)) throw new StudioError('Chỉ áp dụng lượt đã hoàn tất, chưa áp dụng và không có AI khác đang chạy.', 409);
      const variantId = input.variantId ?? record.run.selectedVariantId;
      const selectedVariant = record.run.variants.find(v => v.id === variantId);
      if (!selectedVariant) throw new StudioError('Biến thể không thuộc lượt tạo.', 404);
      const epoch = this.batches.acquireLease(project);
      try {
        const result = await this.runtime.materialize(record.snapshotId, variantId, d.revision, undefined, this.descriptor(project, d.revision, record.approvalId)).promise;
        this.batches.checkLeaseValid(project, epoch.epoch); qualityRevision(this.store.load(project), d.revision);
        const { asset } = wireParse(Buffer.from(result.data).toString('utf8')) as { asset: PixelAsset };
        const appliedRun = { ...record.run, selectedVariantId: variantId };
        asset.source!.files['quality-provenance.js'] = 'export default ' + JSON.stringify({ version: 1, run: appliedRun, approvalId: record.approvalId, prompt: record.prompt, style: record.style });
        asset.source!.files['quality-recipe.js'] = 'export default ' + JSON.stringify(this.runtime.candidateRecipe(record.snapshotId, variantId));
        if (selectedVariant.kind === 'edited') {
          const info = await this.runtime.retouchInfo(record.snapshotId, variantId, d.revision, selectedVariant.frames[0].id, this.descriptor(project, d.revision, record.approvalId)).promise as { constraints: unknown };
          this.batches.checkLeaseValid(project, epoch.epoch); qualityRevision(this.store.load(project), d.revision);
          asset.source!.files['quality-retouch.js'] = 'export default ' + JSON.stringify({ version: 1, parentVariantId: selectedVariant.parentVariantId, constraints: info.constraints });
        }
        const source = d.assets.find(a => a.id === d.studio!.quality!.approvals[record.approvalId].source.assetId)!;
        if (source.metadata.hitbox) asset.metadata.hitbox = structuredClone(source.metadata.hitbox);
        const sourceFrameId = d.studio!.quality!.approvals[record.approvalId].source.frameId, recipeFrames = record.run.variants.find(v => v.id === variantId)!.frames;
        if (source.metadata.events) asset.metadata.events = source.metadata.events.flatMap(e => {
          const old = source.frames[e.frame]?.id, index = old === sourceFrameId ? 0 : recipeFrames.findIndex(f => f.id === old);
          return index < 0 ? [] : [{ ...e, frame: index }];
        });
        const next = applyLibraryVersion(d, asset, validateApplyLibraryOptions(input.library ?? {}));
        const saved = this.store.save(project, d.revision, next, 'Trước khi áp dụng chế độ chất lượng');
        record.appliedAssetId = asset.id;
        let warning: string | undefined;
        try { this.journal.save(record); } catch (e) { warning = `Asset đã lưu; chưa cập nhật được nhật ký: ${(e as Error).message}`; }
        this.emit({ type: 'pixel-saved', projectId: project, revision: saved.revision }); send(res, { document: saved, assetId: asset.id, run: this.public(record), ...(warning ? { warning } : {}) });
      } finally { epoch.release(); }
      return true;
    }
    throw new StudioError('Không tìm thấy lệnh quality-runs.', 404);
  }
  async closeProject(project: string): Promise<void> {
    this.closing.add(project);
    try { const tasks = [...this.preparing.get(project) ?? []]; tasks.forEach(t => t.cancel()); await Promise.allSettled(tasks.map(t => t.promise)); await this.engine.closeProject(project); }
    finally { this.closing.delete(project); }
  }
  async close(): Promise<void> {
    this.closed = true;
    const tasks = [...this.preparing.values()].flatMap(v => [...v]); tasks.forEach(t => t.cancel()); await Promise.allSettled(tasks.map(t => t.promise));
    await this.engine.close();
    for (const [id, record] of this.records) { try { record.run = this.engine.get(id); } catch { record.run = this.journal.get(record.run.projectId, id).run; } record.ownerClosed = true; this.journal.save(record); }
    if (await this.cli.close()) this.runtime.close(true);
    this.removeGuard();
  }
}
