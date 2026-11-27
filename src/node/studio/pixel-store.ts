import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, statSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { safePath, StudioError, validateFiles } from './store.ts';
import { validateMetadata } from '../../studio/validation.ts';
import { newDocument, validateDocument, bytes, pixels, type PixelDocument, type PixelAsset } from '../../studio/pixel/model.ts';
import {
  type ResourceKind,
  type StudioResource,
  validateResourceId,
  validateResource,
  validateResourceRef,
  resourcePixels,
} from '../../studio/resources.ts';
import { ResourceBlobStore } from './resource-store.ts';
import { validateMapChunk } from '../../studio/tilemaps.ts';
import { canonicalJson } from '../../studio/native-scene.ts';
import { isDeepStrictEqual } from 'node:util';

function atomic(path: string, data: string | Uint8Array): void { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`; writeFileSync(tmp, data); renameSync(tmp, path); }
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export class PixelStore {
  readonly root: string;
  private verified = new Map<string, string>();
  private resourceStores = new Map<string, ResourceBlobStore>();

  constructor(root: string, rejectExternalEdits = false) { this.root = root; this.rejectExternalEdits = rejectExternalEdits; }
  private readonly rejectExternalEdits: boolean;
  dir(id: string): string { if (!/^[\w-]{1,80}$/.test(id)) throw new StudioError('ID không hợp lệ.'); return safePath(this.root, id); }

  resourceStore(id: string): ResourceBlobStore {
    let store = this.resourceStores.get(id);
    if (!store) {
      store = new ResourceBlobStore(this.dir(id));
      this.resourceStores.set(id, store);
      if (this.resourceStores.size > 32) {
        this.resourceStores.delete(this.resourceStores.keys().next().value!);
      }
    }
    return store;
  }

  releaseResources(id?: string): void {
    if (id !== undefined) {
      this.resourceStores.delete(id);
    } else {
      this.resourceStores.clear();
    }
  }

  list(): { id: string; name: string; revision: number; schemaVersion: 2 }[] {
    return readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).flatMap(d => { try { const p = this.load(d.name); return [{ id: p.id, name: p.name, revision: p.revision, schemaVersion: 2 as const }]; } catch { return []; } });
  }

  create(name: string, w = 32, h = 32, background = 0, document?: PixelDocument): PixelDocument {
    const d = document ?? newDocument(name, w, h, background); d.id = randomUUID(); d.revision = 1; d.name = name;
    this.validate(d); mkdirSync(this.dir(d.id)); this.write(d); this.snapshot(d, 'Tạo dự án'); return d;
  }

  resource(id: string, resourceId: string): StudioResource & { data: Uint32Array } {
    validateResourceId(resourceId);
    const d = this.load(id, false, false);
    if (!d.studio?.resources || !Object.hasOwn(d.studio.resources, resourceId)) {
      throw new StudioError('Không tìm thấy tài nguyên.', 404);
    }
    const res = d.studio.resources[resourceId];
    validateResource(res);
    if (!res.blob) throw new StudioError('Tài nguyên thiếu blob.', 400);
    const resStore = this.resourceStore(id);
    const data = resStore.read({ version: 1, kind: res.kind, w: res.w, h: res.h, blob: res.blob });
    this.validateMapResource(d, resourceId, { ...res, data });
    return {
      version: 1,
      kind: res.kind,
      w: res.w,
      h: res.h,
      blob: res.blob,
      data,
    };
  }

  copy(name: string, document: PixelDocument, sourceProjectId: string): PixelDocument {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw new StudioError('Tên dự án không hợp lệ.');
    }
    if (!sourceProjectId || !/^[\w-]{1,80}$/.test(sourceProjectId)) {
      throw new StudioError('ID dự án nguồn không hợp lệ.');
    }
    const sourceDir = this.dir(sourceProjectId);
    if (!existsSync(safePath(sourceDir, 'pxl.project.json'))) {
      throw new StudioError('Không tìm thấy dự án nguồn.', 404);
    }
    const sourceDoc = this.load(sourceProjectId, false, true);
    this.validate(sourceDoc);
    if (!document || typeof document !== 'object') {
      throw new StudioError('Tài liệu không hợp lệ.');
    }
    const targetDoc = structuredClone(document);
    this.validate(targetDoc);

    const newId = randomUUID();
    targetDoc.id = newId;
    targetDoc.name = name;
    targetDoc.revision = 1;

    const targetDir = this.dir(newId);
    mkdirSync(targetDir);
    try {
      for (const a of targetDoc.assets) {
        for (const c of Object.values(a.cels)) {
          if (c.blob && !c.data) {
            const sourcePath = safePath(sourceDir, `.pxl/cels/${c.blob}.rgba.z`);
            if (!existsSync(sourcePath)) {
              throw new StudioError(`Cel blob ${c.blob} không tồn tại trong dự án nguồn.`, 404);
            }
            const cData = readFileSync(sourcePath);
            if (hash(cData) !== c.blob) throw new StudioError('Cel blob nguồn bị hỏng.', 409);
            atomic(safePath(targetDir, `.pxl/cels/${c.blob}.rgba.z`), cData);
          }
        }
      }

      if (targetDoc.studio?.resources) {
        const sourceResStore = this.resourceStore(sourceProjectId);
        const targetResStore = this.resourceStore(newId);
        for (const [resId, res] of Object.entries(targetDoc.studio.resources)) {
          if (res.blob && !res.data) {
            const compressed = sourceResStore.compressed({
              version: 1,
              kind: res.kind,
              w: res.w,
              h: res.h,
              blob: res.blob,
            });
            targetResStore.import(
              {
                version: 1,
                kind: res.kind,
                w: res.w,
                h: res.h,
                blob: res.blob,
              },
              compressed
            );
          }
        }
      }

      this.write(targetDoc);
      this.snapshot(targetDoc, 'Sao chép dự án');
      return this.load(newId, false, false);
    } catch (err) {
      this.releaseResources(newId);
      const target = this.dir(newId);
      if (resolve(target) !== resolve(this.root, newId)) throw new StudioError('Không dọn thư mục ngoài workspace.');
      rmSync(target, { recursive: true, force: true });
      throw err;
    }
  }

  importBackup(
    name: string,
    document: PixelDocument,
    blobs: Record<string, string>,
    history: { document: PixelDocument; label: string; time: string }[] = [],
    resourceBlobs: Record<string, string> = {}
  ): PixelDocument {
    if (
      !Array.isArray(history) ||
      history.length > 20 ||
      !blobs ||
      typeof blobs !== 'object' ||
      Array.isArray(blobs) ||
      !resourceBlobs ||
      typeof resourceBlobs !== 'object' ||
      Array.isArray(resourceBlobs) ||
      (Object.getPrototypeOf(resourceBlobs) !== Object.prototype && Object.getPrototypeOf(resourceBlobs) !== null)
    ) {
      throw new StudioError('Sao lưu không hợp lệ.', 400);
    }

    for (const [k, v] of Object.entries(resourceBlobs)) {
      if (!/^(rgba|mask|tile-index):[a-f0-9]{64}$/.test(k) || typeof v !== 'string') {
        throw new StudioError(`Khóa hoặc dữ liệu blob tài nguyên không hợp lệ: "${k}".`, 400);
      }
    }

    const id = randomUUID(), d = { ...document, id, name, revision: 1 };
    this.validate(d);
    for (const h of history) {
      this.validate(h.document);
      if (typeof h.label !== 'string' || h.label.length > 200 || !Number.isFinite(Date.parse(h.time))) {
        throw new StudioError('Lịch sử trong sao lưu sai định dạng.');
      }
    }

    for (const doc of [d, ...history.map(h => h.document)]) {
      if (doc.studio?.resources) {
        for (const [resId, res] of Object.entries(doc.studio.resources)) {
          if (res.data !== undefined) {
            throw new StudioError(`Tài nguyên "${resId}" trong sao lưu không được chứa dữ liệu nội dòng (inline data).`, 400);
          }
          if (!res.blob) {
            throw new StudioError(`Sao lưu thiếu tham chiếu blob cho tài nguyên "${resId}".`, 400);
          }
        }
      }
    }

    const expected = new Map<string, number>();
    for (const doc of [d, ...history.map(h => h.document)]) {
      for (const a of doc.assets) {
        for (const c of Object.values(a.cels)) {
          if (!c.blob) throw new StudioError('Sao lưu thiếu tham chiếu cel.');
          expected.set(c.blob, a.w * a.h);
        }
      }
    }
    const data = new Map<string, Buffer>();
    for (const [digest, length] of expected) {
      const b64 = blobs[digest];
      if (typeof b64 !== 'string') throw new StudioError('Sao lưu thiếu blob cel.');
      const compressed = Buffer.from(b64, 'base64');
      if (hash(compressed) !== digest || inflateSync(compressed, { maxOutputLength: length * 4 }).length !== length * 4) {
        throw new StudioError('Blob trong sao lưu sai checksum/kích thước.');
      }
      data.set(digest, compressed);
    }

    const expectedResources = new Map<string, { kind: ResourceKind; digest: string; w: number; h: number }>();
    for (const doc of [d, ...history.map(h => h.document)]) {
      if (doc.studio?.resources) {
        for (const res of Object.values(doc.studio.resources)) {
          validateResourceRef({ version: 1, kind: res.kind, w: res.w, h: res.h, blob: res.blob! });
          const key = `${res.kind}:${res.blob}`;
          const prev = expectedResources.get(key);
          if (prev) {
            if (prev.w * prev.h !== res.w * res.h) {
              throw new StudioError(`Xung đột kích thước tài nguyên cho cùng một hash (${key}): ${prev.w * prev.h} != ${res.w * res.h}.`, 400);
            }
          } else {
            expectedResources.set(key, { kind: res.kind, digest: res.blob!, w: res.w, h: res.h });
          }
        }
      }
    }

    const resData = new Map<string, { kind: ResourceKind; digest: string; compressed: Buffer }>();
    for (const [key, exp] of expectedResources) {
      const b64 = resourceBlobs[key];
      if (typeof b64 !== 'string') {
        throw new StudioError(`Sao lưu thiếu blob tài nguyên: ${key}.`, 400);
      }
      const compressed = Buffer.from(b64, 'base64');
      if (hash(compressed) !== exp.digest) {
        throw new StudioError(`Blob tài nguyên ${key} trong sao lưu sai checksum.`, 400);
      }
      const total = exp.w * exp.h;
      let decompressed: Buffer;
      try {
        decompressed = inflateSync(compressed, { maxOutputLength: total * 4 });
      } catch {
        throw new StudioError(`Giải nén tài nguyên ${key} trong sao lưu thất bại.`, 400);
      }
      if (decompressed.length !== total * 4) {
        throw new StudioError(`Kích thước tài nguyên ${key} trong sao lưu không khớp.`, 400);
      }
      if (exp.kind === 'mask') {
        const pix = resourcePixels(decompressed);
        for (let i = 0; i < pix.length; i++) {
          if (pix[i] !== 0 && pix[i] !== 1) {
            throw new StudioError(`Mặt nạ tài nguyên ${key} trong sao lưu chứa giá trị không phải 0 hoặc 1.`, 400);
          }
        }
      }
      resData.set(key, { kind: exp.kind, digest: exp.digest, compressed });
    }

    const dir = this.dir(id);
    mkdirSync(dir);
    try {
      for (const [digest, b] of data) atomic(safePath(dir, `.pxl/cels/${digest}.rgba.z`), b);
      for (const { kind, digest, compressed } of resData.values()) {
        atomic(safePath(dir, `.pxl/resources/${digest}.${kind}.z`), compressed);
      }
      this.write(d);
      for (const h of history) {
        this.validateStoredMaps({ ...h.document, id });
        atomic(safePath(dir, `.pxl/pixel-history/${Date.parse(h.time)}-${randomUUID()}.json`), JSON.stringify({ ...h, document: { ...h.document, id } }));
      }
      if (!history.length) this.snapshot(d, 'Nhập sao lưu');
      return this.load(id);
    } catch (e) {
      this.releaseResources(id);
      const target = this.dir(id);
      if (resolve(target) !== resolve(this.root, id)) throw new StudioError('Không dọn thư mục ngoài workspace.');
      rmSync(target, { recursive: true, force: true });
      throw e;
    }
  }

  private validate(d: PixelDocument): void {
    if (d.studio?.production && d.studio.production.version !== 1) {
      throw new StudioError('Phiên bản Production không tương thích. Mở dự án bằng Studio hỗ trợ schema này hoặc dùng bản sao lưu tương thích.', 409, 'UNSUPPORTED_PRODUCTION_VERSION');
    }
    validateDocument(d);
    for (const a of d.assets) { validateMetadata({ [a.id]: a.metadata }); if (a.source) validateFiles(a.source.files, a.source.entry); if(a.provenance?.originalSource)validateFiles(a.provenance.originalSource.files,a.provenance.originalSource.entry); }
  }

  private validateMapResource(d: PixelDocument, resourceId: string, resource: StudioResource): void {
    for (const map of Object.values(d.studio?.mapIndex ?? {})) for (const layer of map.layers) {
      for (const [key, ref] of Object.entries(layer.chunks)) if (ref === resourceId) {
        validateMapChunk(map, key, resource, d.studio!.tilesets![layer.tilesetId], true);
      }
    }
  }

  private validateStoredMaps(d: PixelDocument): void {
    // At most 1024 × 4 KiB chunks; no eager RGBA/character loads.
    const checked = new Map<string, StudioResource>();
    for (const map of Object.values(d.studio?.mapIndex ?? {})) for (const layer of map.layers) for (const [key, ref] of Object.entries(layer.chunks)) {
      let resource = checked.get(ref);
      if (!resource) {
        const stored = d.studio!.resources![ref];
        resource = stored.data ? stored : { ...stored, data: this.resourceStore(d.id).read({ ...stored, blob: stored.blob! }) };
        checked.set(ref, resource);
      }
      validateMapChunk(map, key, resource, d.studio!.tilesets![layer.tilesetId], true);
    }
  }

  load(id: string, hydrate = false, verifyBlobs = true): PixelDocument {
    const path = safePath(this.dir(id), 'pxl.project.json'); if (!existsSync(path)) throw new StudioError('Không tìm thấy dự án pixel.', 404);
    const raw = readFileSync(path, 'utf8'), envelope = JSON.parse(raw);
    const d: PixelDocument = envelope.document;
    if (!d || d.id !== id) throw new StudioError('Không phải dự án pixel v2.', 404);
    this.validate(d);
    // Verify compressed blobs even for metadata-only reads, without inflating pixel buffers.
    if (verifyBlobs) {
      for (const digest of new Set(d.assets.flatMap(a => Object.values(a.cels).map(c => c.blob!)))) this.verify(id, digest);
      if (d.studio?.resources) {
        const resStore = this.resourceStore(id);
        for (const res of Object.values(d.studio.resources)) {
          if (!res.blob) throw new StudioError('Tài nguyên thiếu blob.', 400);
          resStore.verify(res.kind, res.blob);
        }
      }
    }
    const fingerprint = hash(JSON.stringify(d));
    if (envelope.fingerprint !== fingerprint) {
      if (this.rejectExternalEdits) throw new StudioError('Manifest đã đổi ngoài Studio. Mở lại dự án trong Studio trước.', 409, 'STALE_REVISION');
      d.revision++; this.write(d);
    }
    if (hydrate) this.hydrate(d);
    return d;
  }

  hydrate(d: PixelDocument, needed: (asset: PixelAsset, frameId: string) => boolean = () => true): PixelDocument {
    const decoded = new Map<string, Uint32Array>();
    for (const a of d.assets) {
      const refs = new Set(a.layers.flatMap(l => Object.entries(l.cels).filter(([f]) => needed(a, f)).map(([, id]) => id)));
      for (const id of refs) { const c = a.cels[id], key = `${c.blob}:${a.w * a.h}`; if (!decoded.has(key)) decoded.set(key, this.cel(d.id, c.blob!, a.w * a.h)); c.data = decoded.get(key); }
    }
    return d;
  }

  private verify(id: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new StudioError('Blob không hợp lệ.');
    const path = safePath(this.dir(id), `.pxl/cels/${digest}.rgba.z`);
    if (!existsSync(path)) throw new StudioError('Cel bị thiếu hoặc thay đổi ngoài app. Khôi phục từ lịch sử/sao lưu.', 409);
    const s = statSync(path), signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`, key = `${id}:${digest}`;
    if (this.verified.get(key) !== signature) {
      if (hash(readFileSync(path)) !== digest) throw new StudioError('Cel bị thiếu hoặc thay đổi ngoài app. Khôi phục từ lịch sử/sao lưu.', 409);
      this.verified.set(key, signature); if (this.verified.size > 8192) this.verified.delete(this.verified.keys().next().value!);
    }
    return path;
  }

  cel(id: string, blob: string, length: number): Uint32Array {
    const data = readFileSync(this.verify(id, blob));
    const out = pixels(inflateSync(data, { maxOutputLength: length * 4 })); if (out.length !== length) throw new StudioError('Kích thước cel sai.'); return out;
  }

  private write(d: PixelDocument): void {
    this.validate(d); this.validateStoredMaps(d); const manifest = structuredClone(d), dir = this.dir(d.id);
    for (const a of manifest.assets) for (const c of Object.values(a.cels)) {
      if (c.data) { const data = deflateSync(bytes(c.data)), digest = hash(data); const path = safePath(dir, `.pxl/cels/${digest}.rgba.z`); if (!existsSync(path)) atomic(path, data); c.blob = digest; delete c.data; }
      else {
        const path = safePath(dir, `.pxl/cels/${c.blob}.rgba.z`); if (!existsSync(path)) throw new StudioError('Cel chưa được lưu.');
        // Validate referenced blob length; a client cannot reuse arbitrary files as RGBA.
        this.cel(d.id, c.blob!, a.w * a.h);
      }
    }
    if (manifest.studio?.resources) {
      const resStore = this.resourceStore(d.id);
      for (const [resId, res] of Object.entries(manifest.studio.resources)) {
        const stored = resStore.put(res);
        manifest.studio.resources[resId] = {
          version: 1,
          kind: stored.kind,
          w: stored.w,
          h: stored.h,
          blob: stored.blob,
        };
      }
    }
    atomic(safePath(dir, 'pxl.project.json'), JSON.stringify({ schemaVersion: 2, fingerprint: hash(JSON.stringify(manifest)), document: manifest }, null, 2));
  }

  save(id: string, revision: number, document: PixelDocument, label?: string): PixelDocument {
    return this.saveDocument(id, revision, document, label, false, false);
  }
  /** Server-owned human approval endpoint only; never a flag accepted from HTTP. */
  saveQuality(id: string, revision: number, document: PixelDocument, label: string): PixelDocument {
    return this.saveDocument(id, revision, document, label, true, false);
  }
  /** Server-owned native Engine scene import/re-import endpoint only. */
  saveNativeScene(id: string, revision: number, document: PixelDocument, label: string): PixelDocument {
    return this.saveDocument(id, revision, document, label, false, true);
  }
  private saveDocument(id: string, revision: number, document: PixelDocument, label: string | undefined, qualityMutation: boolean, nativeSceneImport: boolean): PixelDocument {
    const current = this.load(id); if (current.revision !== revision) throw new StudioError('Dự án đã đổi ở tab khác hoặc ngoài app. Bản nháp được giữ.', 409, 'STALE_REVISION');
    if (!qualityMutation && !isDeepStrictEqual(current.studio?.quality, document.studio?.quality)) throw new StudioError('Nguồn chất lượng chỉ được duyệt qua lệnh Duyệt nguồn; không nhận receipt từ tài liệu gửi lên.', 409);
    const curNative = current.studio?.production?.nativeScenes ?? [];
    const nextNative = document.studio?.production?.nativeScenes ?? [];
    if (curNative.length > 0 && document.studio?.production && document.studio.production.nativeScenes === undefined) {
      throw new StudioError('Không được bỏ trường nativeScenes của dự án đã có dữ liệu.', 400);
    }
    for (const ns of nextNative) {
      const expectedSha = hash(canonicalJson(ns.engineSnapshot));
      if (ns.protectedSha256 !== expectedSha) {
        throw new StudioError(`PROTECTED_ENGINE_SOURCE: Hash nguồn Engine của '${ns.id}' không khớp protectedSha256.`, 409, 'PROTECTED_ENGINE_SOURCE');
      }
      const prev = curNative.find(item => item.id === ns.id);
      if (prev && !nativeSceneImport) {
        if (prev.protectedSha256 !== ns.protectedSha256 || !isDeepStrictEqual(prev.engineSnapshot, ns.engineSnapshot)) {
          throw new StudioError(`PROTECTED_ENGINE_SOURCE: Không được sửa dữ liệu gốc Engine của scene '${ns.id}'.`, 409, 'PROTECTED_ENGINE_SOURCE');
        }
      }
    }
    if (current.studio && !document.studio) throw new StudioError('Không được xóa extension studio đã tồn tại.', 400);
    if (current.studio && ![1, 2].includes(current.studio.version)) throw new StudioError('Không được ghi đè extension studio không rõ phiên bản.', 400);
    if (document.studio && ![1, 2].includes(document.studio.version)) throw new StudioError('Phiên bản extension studio không được hỗ trợ.', 400);
    if (current.studio?.version === 2 && document.studio?.version !== 2) throw new StudioError('Không được hạ phiên bản extension studio đã có nguồn chất lượng.', 400);
    if (current.studio?.resources !== undefined && document.studio?.resources === undefined) {
      throw new StudioError('Không được xóa trường tài nguyên đã tồn tại.', 400);
    }
    if (current.studio?.characters !== undefined && document.studio?.characters === undefined) {
      throw new StudioError('Không được xóa trường nhân vật đã tồn tại.', 400);
    }
    if (
      current.studio?.clips !== undefined &&
      Object.keys(current.studio.clips).length > 0 &&
      document.studio?.clips === undefined
    ) {
      throw new StudioError('Không được xóa trường clip đã tồn tại khi có clip.', 400);
    }
    for (const field of ['tilesets', 'mapIndex', 'rigDrafts'] as const) {
      if (current.studio?.[field] !== undefined && document.studio?.[field] === undefined) {
        throw new StudioError(`Không được bỏ trường ${field} của dự án đã có dữ liệu.`, 400);
      }
    }
    const next = { ...document, schemaVersion: 2 as const, kind: 'pixel' as const, id, revision: revision + 1 }; this.validate(next);
    this.snapshot(current, label ?? 'Trước khi tự lưu');
    this.write(next); this.collect(id); return this.load(id);
  }

  snapshot(d: PixelDocument, label: string): void {
    // Persist only immutable blob references in history, not repeated RGBA arrays.
    const saved = this.load(d.id, false, false), dir = safePath(this.dir(d.id), '.pxl/pixel-history'); mkdirSync(dir, { recursive: true });
    atomic(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ document: saved, label, time: new Date().toISOString() }));
    const names = readdirSync(dir).filter(n => n.endsWith('.json')).sort(); for (const n of names.slice(0, -20)) rmSync(safePath(dir, n));
  }

  history(id: string): { id: string; label: string; time: string; revision: number }[] {
    const dir = safePath(this.dir(id), '.pxl/pixel-history'); if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(n => /^[\w-]+\.json$/.test(n)).sort().reverse().map(n => { const h = JSON.parse(readFileSync(safePath(dir, n), 'utf8')); return { id: n, label: h.label, time: h.time, revision: h.document.revision }; });
  }

  restore(id: string, revision: number, snapshot: string): PixelDocument {
    if (!/^[\w-]+\.json$/.test(snapshot)) throw new StudioError('Mốc phục hồi không hợp lệ.');
    const h = JSON.parse(readFileSync(safePath(this.dir(id), `.pxl/pixel-history/${snapshot}`), 'utf8'));
    const current = this.load(id, false, false); if (current.revision !== revision) throw new StudioError('Revision đã thay đổi.', 409, 'STALE_REVISION');
    const next = { ...h.document, id, revision: revision + 1 }; this.validate(next);
    let intact = true; try { this.load(id); } catch { intact = false; }
    if (intact) this.snapshot(current, 'Trước khi phục hồi');
    else atomic(safePath(this.dir(id), `.pxl/recovery-manifest-${Date.now()}.json`), JSON.stringify(current));
    this.write(next); return this.load(id);
  }

  private collect(id: string): void {
    const usedCels = new Set<string>();
    const usedResourceKeys = new Set<string>();

    try {
      // A linked owned directory does not establish ownership of its target files.
      for (const relative of ['.pxl', '.pxl/cels', '.pxl/resources']) {
        const path = safePath(this.dir(id), relative);
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
          console.warn('[PixelStore] Bỏ qua dọn dẹp thư mục liên kết.');
          return;
        }
      }
      const current = this.load(id, false, false);
      this.validate(current);
      for (const a of current.assets) {
        for (const c of Object.values(a.cels)) {
          if (c.blob) usedCels.add(c.blob);
        }
      }
      if (current.studio?.resources) {
        for (const res of Object.values(current.studio.resources)) {
          if (res && res.blob) {
            usedResourceKeys.add(`${res.kind}:${res.blob}`);
          }
        }
      }

      const dir = safePath(this.dir(id), '.pxl/pixel-history');
      if (existsSync(dir)) {
        for (const h of this.history(id)) {
          const raw = readFileSync(safePath(dir, h.id), 'utf8');
          const entry = JSON.parse(raw);
          if (!entry || typeof entry !== 'object' || !entry.document) {
            throw new Error('Mục lịch sử không hợp lệ.');
          }
          const histDoc: PixelDocument = entry.document;
          this.validate(histDoc);
          for (const a of histDoc.assets) {
            for (const c of Object.values(a.cels)) {
              if (c.blob) usedCels.add(c.blob);
            }
          }
          if (histDoc.studio?.resources) {
            for (const res of Object.values(histDoc.studio.resources)) {
              if (res && res.blob) {
                usedResourceKeys.add(`${res.kind}:${res.blob}`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[PixelStore] Bỏ qua dọn dẹp do gốc tài liệu/lịch sử không chắc chắn: ${(err as Error).message}`);
      return;
    }

    try {
      const blobs = safePath(this.dir(id), '.pxl/cels');
      if (existsSync(blobs)) {
        for (const n of readdirSync(blobs)) {
          if (!/^[a-f0-9]{64}\.rgba\.z$/.test(n) || usedCels.has(n.slice(0, 64))) continue;
          const path = join(blobs, n), entry = lstatSync(path, { throwIfNoEntry: false });
          if (entry?.isFile() && !entry.isSymbolicLink() && Date.now() - entry.mtimeMs > 86400000) rmSync(path);
        }
      }
      const resStore = this.resourceStore(id);
      resStore.collect(usedResourceKeys);
    } catch (err) {
      console.warn(`[PixelStore] Bỏ qua dọn dẹp tài nguyên do lỗi: ${(err as Error).message}`);
    }
  }

  backupFiles(id: string): { path: string; data: Buffer }[] {
    this.load(id); const out: { path: string; data: Buffer }[] = [];
    const walk = (relative: string) => { const dir = safePath(this.dir(id), relative); for (const d of readdirSync(dir, { withFileTypes: true })) { const p = `${relative}/${d.name}`; if (d.isSymbolicLink()) throw new StudioError('Không sao lưu symlink.'); if (d.isDirectory()) walk(p); else out.push({ path: p.replace(/^\//, ''), data: readFileSync(safePath(this.dir(id), p)) }); } };
    out.push({ path: 'pxl.project.json', data: readFileSync(safePath(this.dir(id), 'pxl.project.json')) }); if (existsSync(safePath(this.dir(id), '.pxl'))) walk('.pxl'); return out;
  }
}
