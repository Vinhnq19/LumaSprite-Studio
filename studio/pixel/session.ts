import { PixelHistory, snapshot } from '../../src/studio/pixel/history.ts';
import { composite, validateDocument, wireParse, wireStringify, type PixelAsset, type PixelDocument } from '../../src/studio/pixel/model.ts';
import {
  validateResource,
  validateResourceId,
  editResourceData,
  cloneResource,
  type StudioResource,
} from '../../src/studio/resources.ts';

export async function api(path: string, method = 'GET', value?: unknown, signal?: AbortSignal): Promise<any> {
  const r = await fetch(path.startsWith('/api/') ? path : '/api/pixel/' + path, { method, headers: value === undefined ? {} : { 'content-type': 'application/json' }, body: value === undefined ? undefined : wireStringify(value), signal });
  const text = await r.text(); let data; try { data = wireParse(text); } catch { throw new Error(`Máy chủ trả dữ liệu không hợp lệ (${r.status}).`); }
  if (!r.ok) { const e = new Error(data.error ?? `HTTP ${r.status}`) as Error & { status: number }; e.status = r.status; throw e; } return data;
}
export async function draft(action: 'get' | 'put' | 'delete', key: string, value?: PixelDocument): Promise<PixelDocument | string | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('pxl-pixel-drafts', 1); open.onupgradeneeded = () => open.result.createObjectStore('drafts'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('drafts', action === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('drafts'); const request = action === 'get' ? store.get(key) : action === 'put' ? store.put(value, key) : store.delete(key); tx.oncomplete = () => { resolve(request.result); db.close(); }; tx.onerror = () => { reject(tx.error); db.close(); }; };
  });
}
export class Session {
  doc?: PixelDocument; assetId = ''; layerId = ''; frameId = ''; dirty = false; conflict = false; saving = false;
  history = new PixelHistory(); version = 0; private timer?: ReturnType<typeof setTimeout>; private inflight?: Promise<void>;
  private loading = new Map<string, Promise<any>>();
  private pinnedResources = new Map<object, number>();
  private pinnedCels = new Map<object, number>();
  private held = false;
  onchange: () => void = () => {}; onstatus: (message: string) => void = () => {}; onerror: (error: unknown) => void = () => {};
  onframe: () => void = () => {};
  private frameFailure?: { asset: PixelAsset; frame: string; message: string };
  get asset(): PixelAsset | undefined { return this.doc?.assets.find(a => a.id === this.assetId); }
  get layer() { return this.asset?.layers.find(l => l.id === this.layerId); }
  get frame() { return this.asset?.frames.find(f => f.id === this.frameId); }
  get path() { return `projects/${this.doc!.id}`; }
  get framePending(): boolean {
    return !!this.asset?.layers.some(layer => {
      const id = layer.cels[this.frameId];
      return id && !this.asset!.cels[id]?.data;
    });
  }
  get frameError(): string | undefined {
    const failure = this.frameFailure;
    return failure?.asset === this.asset && failure?.frame === this.frameId ? failure.message : undefined;
  }

  private pinResource(owner: object): void {
    this.pinnedResources.set(owner, (this.pinnedResources.get(owner) ?? 0) + 1);
  }
  private unpinResource(owner: object): void {
    const count = (this.pinnedResources.get(owner) ?? 0) - 1;
    if (count <= 0) this.pinnedResources.delete(owner);
    else this.pinnedResources.set(owner, count);
  }
  private pinCel(owner: object): void {
    this.pinnedCels.set(owner, (this.pinnedCels.get(owner) ?? 0) + 1);
  }
  private unpinCel(owner: object): void {
    const count = (this.pinnedCels.get(owner) ?? 0) - 1;
    if (count <= 0) this.pinnedCels.delete(owner);
    else this.pinnedCels.set(owner, count);
  }

  normalize(): void {
    if (!this.asset) this.assetId = this.doc?.assets[0]?.id ?? '';
    if (!this.layer) this.layerId = this.asset?.layers.find(l => l.type === 'image')?.id ?? this.asset?.layers[0]?.id ?? '';
    if (!this.frame) this.frameId = this.asset?.frames[0]?.id ?? '';
  }
  async open(id: string): Promise<void> {
    await this.flush(); if (this.doc) await api(`${this.path}/close`, 'POST', {});
    this.loading.clear(); this.pinnedResources.clear(); this.pinnedCels.clear();
    this.doc = await api(`projects/${id}`); this.assetId = ''; this.layerId = ''; this.frameId = ''; this.dirty = false; this.conflict = false; this.history.clear(); this.normalize();
    localStorage.setItem('pxl.pixel.last', id); this.onstatus(`Đã mở · r${this.doc!.revision}`); this.onchange(); await this.loadFrame();
    const saved = await draft('get', id); if (saved) this.onstatus('Có bản nháp chưa lưu. Dùng Khôi phục bản nháp để xem lại.');
  }
  async restoreDraft(): Promise<void> {
    if (!this.doc) return; const saved = await draft('get', this.doc.id); if (!saved) throw new Error('Không có bản nháp.');
    const d: PixelDocument = typeof saved === 'string' ? wireParse(saved) : saved; validateDocument(d); this.conflict = d.revision !== this.doc.revision; this.doc = d; this.dirty = true; this.normalize(); this.onchange(); await this.loadFrame(); this.onstatus(this.conflict ? 'Bản nháp có revision cũ. Lưu bản sao để giữ cả hai.' : 'Đã khôi phục bản nháp.');
  }
  private async loadCel(doc: PixelDocument, asset: PixelAsset, id: string): Promise<void> {
    const c = asset.cels[id]; if (!c || c.data) return;
    const blob = c.blob, w = asset.w, h = asset.h;
    if (!blob) throw new Error('Cel chưa có dữ liệu hoặc blob đã lưu.');
    const current = () => this.doc === doc && asset.cels[id] === c && asset.w === w && asset.h === h && c.blob === blob && !c.data;
    const key = `cel:${doc.id}:${doc.revision}:${asset.id}:${id}:${blob}:${w}:${h}`;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = api(`projects/${doc.id}/cel?asset=${asset.id}&cel=${id}&revision=${doc.revision}&blob=${blob}&w=${w}&h=${h}`,
        'GET', undefined, AbortSignal.timeout(12000)).catch(error => {
          if ((error as Error).name === 'TimeoutError') throw Error('Tải cel quá thời gian 12 giây.');
          throw error;
        });
      this.loading.set(key, pending);
    }
    let loaded;
    try { loaded = await pending; }
    catch (error) { if (current()) throw error; return; }
    finally { if (this.loading.get(key) === pending) this.loading.delete(key); }
    if (!current()) return;
    if (loaded.id !== id || loaded.blob !== blob || !(loaded.data instanceof Uint32Array) || loaded.data.length !== w * h) throw new Error('Dữ liệu cel không khớp phiên bản đang dùng.');
    c.data = loaded.data;
  }
  async loadFrame(frameId = this.frameId, asset = this.asset): Promise<void> {
    const doc = this.doc; if (!doc || !asset) return;
    const active = () => this.doc === doc && this.asset === asset && this.frameId === frameId;
    const ids = new Set(asset.layers.map(l => l.cels[frameId]).filter(Boolean));
    if (active() && this.framePending) { this.frameFailure = undefined; this.onframe(); }
    try { await Promise.all([...ids].map(id => this.loadCel(doc, asset, id))); this.reclaim(); }
    catch (error) {
      if (active()) this.frameFailure = { asset, frame: frameId, message: (error as Error).message };
      throw error;
    } finally { if (active()) this.onframe(); }
  }
  async readFrame(frameId: string, asset = this.asset): Promise<Uint32Array> {
    const doc = this.doc, version = this.version;
    if (!doc || !asset || !asset.frames.some(f => f.id === frameId)) throw Error('Frame nguồn không còn tồn tại.');
    const owners = [...new Set(asset.layers.map(l => asset.cels[l.cels[frameId]]).filter(Boolean))];
    // Keep offscreen cels alive until compositing, even under cache pressure.
    owners.forEach(c => this.pinCel(c));
    try {
      await this.loadFrame(frameId, asset);
      if (this.doc !== doc || this.version !== version) throw Error('Dự án đã đổi trong lúc đọc frame.');
      return composite(asset, frameId).data;
    } finally { owners.forEach(c => this.unpinCel(c)); this.reclaim(); }
  }
  async loadResource(id: string): Promise<StudioResource | undefined> {
    const doc = this.doc;
    if (!doc || !doc.studio?.resources) return undefined;
    validateResourceId(id);
    if (!Object.hasOwn(doc.studio.resources, id)) return undefined;
    const res = doc.studio.resources[id];
    if (res.data) return res;
    if (!res.blob) return res;

    const docId = doc.id, revision = doc.revision, resKind = res.kind, resW = res.w, resH = res.h, resBlob = res.blob, resDataPtr = res.data;
    const key = `resource:${docId}:${revision}:${id}:${resBlob}:${resKind}:${resW}:${resH}`;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = api(`projects/${docId}/resource?revision=${revision}&resource=${encodeURIComponent(id)}&blob=${resBlob}&kind=${resKind}&w=${resW}&h=${resH}`);
      this.loading.set(key, pending);
    }
    let loaded: any;
    try {
      loaded = await pending;
    } catch (err) {
      const isCurrent = this.doc === doc && this.doc?.id === docId && this.doc?.studio?.resources && Object.hasOwn(this.doc.studio.resources, id) && this.doc.studio.resources[id] === res;
      if (!isCurrent) return undefined;
      throw err;
    } finally {
      if (this.loading.get(key) === pending) {
        this.loading.delete(key);
      }
    }

    if (this.doc !== doc || this.doc.id !== docId || !this.doc.studio?.resources || !Object.hasOwn(this.doc.studio.resources, id)) {
      return undefined;
    }
    const current = this.doc.studio.resources[id];
    if (current !== res || current.kind !== resKind || current.w !== resW || current.h !== resH || current.blob !== resBlob) {
      return undefined;
    }
    if (current.data !== resDataPtr) return current.data === loaded.data ? current : undefined;

    validateResource(loaded);
    if (loaded.version !== 1 || loaded.kind !== resKind || loaded.w !== resW || loaded.h !== resH || loaded.blob !== resBlob) {
      throw new Error(`Dữ liệu tài nguyên trả về không khớp định dạng (${id}).`);
    }
    if (!(loaded.data instanceof Uint32Array) || loaded.data.length !== resW * resH) {
      throw new Error(`Dữ liệu điểm ảnh tài nguyên không hợp lệ (${id}).`);
    }

    current.data = loaded.data;
    this.pinResource(current);
    try {
      this.reclaim();
    } finally {
      this.unpinResource(current);
    }
    return current;
  }
  setResource(id: string, resource: StudioResource, label = 'Đặt tài nguyên'): void {
    if (!this.doc) return;
    validateResourceId(id);
    validateResource(resource);
    if (this.doc.studio?.version !== undefined && ![1, 2].includes(this.doc.studio.version)) {
      throw new Error(`Phiên bản extension không hợp lệ: ${this.doc.studio.version}`);
    }
    if (!this.doc.studio) {
      this.doc.studio = { version: 1, resources: {} };
    } else if (!this.doc.studio.resources) {
      this.doc.studio.resources = {};
    }
    this.change(label, () => {
      this.doc!.studio!.resources![id] = cloneResource(resource, true);
    });
  }
  changeResource(id: string, nextData: Uint32Array, label = 'Sửa dữ liệu tài nguyên'): void {
    if (!this.doc) return;
    validateResourceId(id);
    if (this.doc.studio?.version !== undefined && ![1, 2].includes(this.doc.studio.version)) {
      throw new Error(`Phiên bản extension không hợp lệ: ${this.doc.studio.version}`);
    }
    if (!this.doc.studio?.resources || !Object.hasOwn(this.doc.studio.resources, id)) {
      throw new Error(`Tài nguyên không tồn tại: ${id}`);
    }
    if (!(nextData instanceof Uint32Array)) {
      throw new Error('Dữ liệu mới phải là Uint32Array.');
    }
    const current = this.doc.studio.resources[id];
    validateResource(current);
    this.change(label, () => {
      this.doc!.studio!.resources![id] = editResourceData(current, nextData);
    });
  }
  private reclaim(): void {
    if (!this.doc) return;
    const currentAsset = this.asset, protectedCelIds = new Set(currentAsset?.layers.map(l => l.cels[this.frameId]));
    const computeSize = () => {
      const counted = new Set<ArrayBufferLike>();
      let s = 0;
      for (const a of this.doc!.assets) for (const c of Object.values(a.cels)) if (c.data && !counted.has(c.data.buffer)) { counted.add(c.data.buffer); s += c.data.buffer.byteLength; }
      if (this.doc!.studio?.resources) for (const r of Object.values(this.doc!.studio.resources)) if (r.data && !counted.has(r.data.buffer)) { counted.add(r.data.buffer); s += r.data.buffer.byteLength; }
      return s;
    };
    let size = computeSize();
    if (size <= 64 * 1024 * 1024) return;
    for (const a of this.doc.assets) {
      for (const c of Object.values(a.cels)) {
        if (size <= 64 * 1024 * 1024) return;
        if (c.data && c.blob && !(a === currentAsset && protectedCelIds.has(c.id)) && !this.pinnedCels.has(c)) {
          delete c.data;
          size = computeSize();
        }
      }
    }
    if (this.doc.studio?.resources) {
      for (const r of Object.values(this.doc.studio.resources)) {
        if (size <= 64 * 1024 * 1024) return;
        if (r.data && r.blob && !this.pinnedResources.has(r)) {
          delete r.data;
          size = computeSize();
        }
      }
    }
  }
  async loadAll(): Promise<void> { const a = this.asset; if (!a) return; for (const f of a.frames) await this.loadFrame(f.id, a); }
  async selectFrame(id: string): Promise<void> { this.frameId = id; await this.loadFrame(); this.onchange(); }
  change(label: string, fn: () => void): void {
    if (!this.doc) return; const before = snapshot(this.doc);
    try { fn(); validateDocument(this.doc); if (this.history.commit(before, this.doc, label)) this.changed(); }
    catch (e) { this.doc = before; this.normalize(); this.onchange(); throw e; }
    this.normalize(); this.onchange();
  }
  begin(): PixelDocument | undefined { return this.doc && snapshot(this.doc); }
  hold(): void { this.held = true; clearTimeout(this.timer); }
  release(): void { this.held = false; if (this.dirty && !this.conflict) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush().catch(this.onerror); }, 500); } }
  end(before: PixelDocument | undefined, label: string): void {
    if (!before || !this.doc) return;
    try {
      validateDocument(this.doc);
      // A new stroke replaces the cel buffer before writing, so this committed snapshot stays stable until IndexedDB clones it.
      if (this.history.commit(before, this.doc, label)) this.changed(snapshot(this.doc));
    }
    catch (e) { this.doc = before; this.onchange(); throw e; }
    this.normalize(); this.onchange();
  }
  rollback(before?: PixelDocument): void { if (before) { if (this.doc?.id === before.id) before.revision = this.doc.revision; this.doc = before; } this.normalize(); this.onchange(); }
  private undoEntry(redo: boolean): boolean {
    const previous = this.doc!.studio, version = previous?.version, quality = previous?.quality;
    const containers = (['resources', 'characters', 'clips', 'tilesets', 'mapIndex', 'rigDrafts'] as const).filter(key => previous?.[key] !== undefined);
    if (!this.history.undo(this.doc, redo)) return false;
    if (version === 1 || version === 2) {
      const studio = this.doc!.studio ??= { version };
      if (version === 2) { studio.version = 2; studio.quality = quality; }
      for (const key of containers) if (studio[key] === undefined) Object.assign(studio, { [key]: {} });
    }
    return true;
  }
  undo(redo = false): Promise<void> | void {
    if (!this.doc) return;
    const paths = this.history.nextPaths(redo);
    const missingResources = new Set<string>();
    const missingCels: { assetIndex: number; celId: string }[] = [];

    for (const path of paths) {
      let p: any = this.doc;
      for (let i = 0; i < path.length - 1; i++) p = p?.[path[i]];
      const key = path.at(-1)!;
      if (p && p[key] === undefined) {
        if (path[0] === 'studio' && path[1] === 'resources' && path[3] === 'data') {
          missingResources.add(path[2] as string);
        } else if (path[0] === 'assets' && path[2] === 'cels' && path[4] === 'data') {
          missingCels.push({ assetIndex: path[1] as number, celId: path[3] as string });
        }
      }
    }

    if (missingResources.size === 0 && missingCels.length === 0) {
      if (this.undoEntry(redo)) {
        this.normalize();
        this.changed();
        this.onchange();
      }
      return;
    }

    return (async () => {
      const capturedDoc = this.doc!;
      const capturedVersion = this.version;
      const capturedHistory = this.history;
      const resourceIds = [...missingResources];
      const pinnedResList = resourceIds.map(id => capturedDoc.studio?.resources?.[id]).filter(owner => owner !== undefined);
      const pinnedCelList = missingCels.map(m => capturedDoc.assets[m.assetIndex]?.cels[m.celId]).filter(owner => owner !== undefined);

      for (const owner of pinnedResList) this.pinResource(owner);
      for (const owner of pinnedCelList) this.pinCel(owner);

      try {
        await Promise.all([
          ...resourceIds.map(id => this.loadResource(id)),
          ...missingCels.map(m => {
            const asset = capturedDoc.assets[m.assetIndex];
            if (!asset) return;
            return this.loadCel(capturedDoc, asset, m.celId);
          }),
        ]);

        if (this.doc !== capturedDoc || this.version !== capturedVersion || this.history !== capturedHistory) {
          return;
        }

        for (const path of paths) {
          let p: any = this.doc;
          for (let i = 0; i < path.length - 1; i++) p = p?.[path[i]];
          const key = path.at(-1)!;
          if (!p || !(p[key] instanceof Uint32Array)) {
            return;
          }
        }

        if (this.undoEntry(redo)) {
          this.normalize();
          this.changed();
          this.onchange();
        }
      } finally {
        for (const owner of pinnedResList) this.unpinResource(owner);
        for (const owner of pinnedCelList) this.unpinCel(owner);
        this.reclaim();
      }
    })();
  }
  changed(committed?: PixelDocument): void {
    this.version++; this.dirty = true; this.onstatus(this.conflict ? 'Xung đột · bản nháp được giữ' : 'Chưa lưu…'); clearTimeout(this.timer);
    const doc = this.doc!; void draft('put', doc.id, committed ?? structuredClone(doc)).catch(this.onerror);
    if (!this.conflict && !this.held) this.timer = setTimeout(() => { void this.flush().catch(this.onerror); }, 500);
  }
  async flush(manual = false): Promise<void> {
    clearTimeout(this.timer); if (this.held) return; if (this.inflight) { await this.inflight; if (this.dirty) return this.flush(manual); return; }
    if (!this.doc || !this.dirty && !manual) return;
    if (this.conflict) throw new Error('Dự án xung đột. Tải lại hoặc lưu bản sao trước khi tiếp tục.');
    this.inflight = this.save(manual); try { await this.inflight; } finally { this.inflight = undefined; }
  }
  private async save(manual: boolean): Promise<void> {
    const doc = this.doc!, version = this.version, sent = snapshot(doc); this.saving = true; this.onstatus('Đang lưu…');
    const wire = snapshot(sent);
    for (const a of wire.assets) for (const c of Object.values(a.cels)) if (c.blob) delete c.data;
    if (wire.studio?.resources) for (const r of Object.values(wire.studio.resources)) if (r.blob) delete r.data;
    try {
      const saved: PixelDocument = await api(`projects/${doc.id}`, 'PUT', { revision: doc.revision, document: wire, snapshot: manual });
      if (this.doc?.id !== saved.id) return;
      this.doc.revision = saved.revision;
      for (const a of this.doc.assets) for (const [id, c] of Object.entries(a.cels)) { const old = sent.assets.find(x => x.id === a.id)?.cels[id], s = saved.assets.find(x => x.id === a.id)?.cels[id]; if (s && old?.data === c.data) c.blob = s.blob; }
      if (this.doc.studio?.resources && sent.studio?.resources && saved.studio?.resources) {
        for (const [id, current] of Object.entries(this.doc.studio.resources)) {
          const sentRes = sent.studio.resources[id], savedRes = saved.studio.resources[id];
          if (sentRes && savedRes) {
            const shapeMatch = current.kind === sentRes.kind && current.w === sentRes.w && current.h === sentRes.h;
            const blobMatch = current.blob === sentRes.blob;
            const dataMatch = current.data === sentRes.data;
            if (shapeMatch && blobMatch && dataMatch && savedRes.blob) {
              current.blob = savedRes.blob;
              const lastEntry = (this.history as any).past?.at(-1);
              if (lastEntry) {
                for (const c of lastEntry.changes) {
                  if (c.path[0] === 'studio' && c.path[1] === 'resources' && c.path[2] === id && c.path[3] === 'blob' && c.after === undefined) {
                    c.after = savedRes.blob;
                  }
                }
              }
            }
          }
        }
      }
      if (version === this.version) { this.dirty = false; await draft('delete', doc.id); } else { void draft('put', doc.id, structuredClone(this.doc)).catch(this.onerror); this.timer = setTimeout(() => { void this.flush().catch(this.onerror); }, 500); }
      this.onstatus(`Đã lưu · r${saved.revision}${this.history.trimmed ? ' · Đã rút gọn undo theo giới hạn bộ nhớ' : ''}`);
    } catch (e) { if ((e as any).status === 409) this.conflict = true; this.onstatus(this.conflict ? 'Xung đột · bản nháp được giữ' : 'Lưu lỗi · thử lại hoặc sao lưu bản nháp'); throw e; }
    finally { this.saving = false; }
  }
  async copy(): Promise<string> {
    if (!this.doc) throw new Error('Chưa có dự án.');
    const capturedDoc = this.doc;
    const capturedVersion = this.version;
    const targetDoc = snapshot(this.doc);
    for (const a of targetDoc.assets) {
      for (const c of Object.values(a.cels)) {
        if (c.blob) delete c.data;
      }
    }
    if (targetDoc.studio?.resources) {
      for (const r of Object.values(targetDoc.studio.resources)) {
        if (r.blob) delete r.data;
      }
    }
    const copy = await api('projects', 'POST', {
      name: `${this.doc.name} (bản sao)`.slice(0, 100),
      document: targetDoc,
      sourceProjectId: this.doc.id,
    });
    if (this.doc === capturedDoc && this.version === capturedVersion) {
      this.dirty = false;
      this.conflict = false;
    }
    return copy.id;
  }
}
