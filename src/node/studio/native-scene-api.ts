import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalJson, defaultStudioState, validateNativeSceneRecord, type NativeSceneApprovalStatus, type NativeSceneRecord } from '../../studio/native-scene.ts';
import { emptyProduction } from '../../studio/production.ts';
import { wireStringify, type PixelDocument } from '../../studio/pixel/model.ts';
import { dataId } from '../../studio/quality/data.ts';
import {
  exportNativeScenePackage,
  importNativeSceneFromDirectory,
  importNativeSceneFromFiles,
  loadNativeSceneBuffers,
} from './native-scene-io.ts';
import { PixelStore } from './pixel-store.ts';
import { StudioError } from './store.ts';

export class NativeSceneApi {
  private readonly store: PixelStore;
  constructor(store: PixelStore) {
    this.store = store;
  }

  async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    parts: string[],
    d: PixelDocument,
    body: () => Promise<any>,
    observe: (doc: PixelDocument) => void,
    emit: (event: unknown) => void,
  ): Promise<boolean> {
    if (parts[4] !== 'native-scenes') return false;
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(wireStringify(data));
    };
    const checkRevision = (value: unknown) => {
      if (value !== d.revision) throw new StudioError('Revision dự án đã thay đổi; tải lại trước khi thao tác.', 409, 'STALE_REVISION');
    };

    if (parts[5] === 'import' && req.method === 'POST') {
      const input = await body();
      checkRevision(input.revision);
      const light = input.light === 'night' ? 'night' : input.light === 'day' ? 'day' : undefined;
      const expectedRevision = typeof input.expectedRevision === 'string' && input.expectedRevision.trim() ? input.expectedRevision.trim() : undefined;
      const expectedHashes = input.expectedHashes && typeof input.expectedHashes === 'object' ? input.expectedHashes : undefined;
      const sceneName = typeof input.sceneName === 'string' && input.sceneName.trim() ? input.sceneName.trim() : undefined;
      const sceneId = typeof input.sceneId === 'string' && input.sceneId.trim() ? dataId(input.sceneId.trim(), 'sceneId') : undefined;

      let imported;
      if (typeof input.sourceDir === 'string' && input.sourceDir.trim()) {
        imported = importNativeSceneFromDirectory(input.sourceDir.trim(), { light, expectedRevision, expectedHashes, sceneId, sceneName });
      } else if (input.files && typeof input.files === 'object' && !Array.isArray(input.files)) {
        const files: Record<string, Buffer> = {};
        for (const [k, b64] of Object.entries(input.files as Record<string, unknown>)) {
          if (typeof b64 !== 'string') throw new StudioError(`Dữ liệu file '${k}' không hợp lệ.`, 400);
          files[k] = Buffer.from(b64, 'base64');
        }
        imported = importNativeSceneFromFiles(files, { light, expectedRevision, expectedHashes, sceneId, sceneName });
      } else {
        throw new StudioError('Cần cung cấp sourceDir hoặc files để import native scene.', 400);
      }

      const nextDoc = structuredClone(d);
      nextDoc.studio ??= { version: 1 };
      nextDoc.studio.resources ??= {};
      nextDoc.studio.production ??= emptyProduction();
      nextDoc.studio.production.nativeScenes ??= [];

      const resStore = this.store.resourceStore(d.id);
      for (const [resId, resData] of Object.entries(imported.resources)) {
        const stored = resStore.put(resData);
        nextDoc.studio.resources[resId] = stored;
      }

      const existingIdx = nextDoc.studio.production.nativeScenes.findIndex(ns => ns.id === imported.record.id);
      if (existingIdx >= 0) {
        const prev = nextDoc.studio.production.nativeScenes[existingIdx];
        const sourceChanged = prev.engineSnapshot.sourceRevision !== imported.record.engineSnapshot.sourceRevision
          || prev.protectedSha256 !== imported.record.protectedSha256;
        const warnings = [...prev.studioState.sourceWarnings];
        const approval = { ...prev.studioState.approval };
        if (sourceChanged) {
          warnings.push(`SOURCE_REVISION_CHANGED: ${prev.engineSnapshot.sourceRevision} -> ${imported.record.engineSnapshot.sourceRevision}`);
          if (approval.status === 'APPROVED') approval.status = 'STALE';
        }
        const mergedRecord: NativeSceneRecord = {
          ...imported.record,
          studioState: {
            ...prev.studioState,
            revision: prev.studioState.revision + (sourceChanged ? 1 : 0),
            approval,
            sourceWarnings: warnings,
            layerVisibility: { ...imported.record.studioState.layerVisibility, ...prev.studioState.layerVisibility },
            changeLog: sourceChanged
              ? [...prev.studioState.changeLog, { revision: prev.studioState.revision + 1, at: new Date().toISOString(), summary: `Re-import Engine source ${imported.record.engineSnapshot.sourceRevision.slice(0, 12)}` }]
              : prev.studioState.changeLog,
          },
        };
        nextDoc.studio.production.nativeScenes[existingIdx] = mergedRecord;
        imported.record = mergedRecord;
      } else {
        nextDoc.studio.production.nativeScenes.push(imported.record);
      }

      validateNativeSceneRecord(imported.record, nextDoc, nextDoc.studio.resources);
      const saved = this.store.saveNativeScene(d.id, d.revision, nextDoc, `Import native scene ${imported.record.name}`);
      observe(saved);
      emit({ type: 'pixel-saved', projectId: d.id, revision: saved.revision });
      json({ document: saved, sceneId: imported.record.id, warnings: imported.record.studioState.sourceWarnings }, 201);
      return true;
    }

    const targetId = parts[5] ? dataId(parts[5], 'sceneId') : '';
    const record = d.studio?.production?.nativeScenes?.find(ns => ns.id === targetId);

    if (parts[6] === 'render' && req.method === 'GET') {
      checkRevision(Number(url.searchParams.get('revision')));
      if (!record) throw new StudioError('Không tìm thấy native scene.', 404);
      const buffers = loadNativeSceneBuffers(this.store, d, record);
      json({ record, buffers });
      return true;
    }

    if (parts[6] === 'review' && req.method === 'POST') {
      const input = await body();
      checkRevision(input.revision);
      if (!record) throw new StudioError('Không tìm thấy native scene.', 404);
      const status = input.status as NativeSceneApprovalStatus;
      if (status !== 'UNREVIEWED' && status !== 'APPROVED' && status !== 'STALE') {
        throw new StudioError('Trạng thái duyệt phải là UNREVIEWED, APPROVED hoặc STALE.', 400);
      }
      const note = typeof input.note === 'string' ? input.note.slice(0, 500) : '';
      const nextDoc = structuredClone(d);
      const target = nextDoc.studio!.production!.nativeScenes!.find(ns => ns.id === targetId)!;
      target.studioState.approval = {
        status,
        approvedRevision: status === 'APPROVED' ? target.studioState.revision : target.studioState.approval.approvedRevision,
        approvedSourceRevision: status === 'APPROVED' ? target.engineSnapshot.sourceRevision : target.studioState.approval.approvedSourceRevision,
        reviewedAt: new Date().toISOString(),
        note,
      };
      target.studioState.changeLog.push({
        revision: target.studioState.revision,
        at: new Date().toISOString(),
        summary: `Human review: ${status}`,
      });
      const saved = this.store.save(d.id, d.revision, nextDoc, `Duyệt scene ${target.name}: ${status}`);
      observe(saved);
      emit({ type: 'pixel-saved', projectId: d.id, revision: saved.revision });
      json({ document: saved, approval: target.studioState.approval });
      return true;
    }

    if (parts[6] === 'export' && req.method === 'POST') {
      const input = await body();
      checkRevision(input.revision);
      if (!record) throw new StudioError('Không tìm thấy native scene.', 404);
      const out = exportNativeScenePackage(this.store, d, targetId, { requireApproved: input.requireApproved === true });
      res.writeHead(200, {
        'content-type': out.mime,
        'content-disposition': `attachment; filename="${out.filename}"`,
        'cache-control': 'no-store',
      });
      res.end(Buffer.from(out.data));
      return true;
    }

    return false;
  }
}

export { canonicalJson, defaultStudioState };
