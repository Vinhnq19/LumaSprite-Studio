import { RetouchEditor } from '../../src/studio/quality/retouch-editor.ts';
import type { FrameRetouchConstraints } from '../../src/studio/quality/retouch.ts';
import type { RecipePixelEdit } from '../../src/studio/quality/recipe.ts';
import type { QualityRun, QualityVariantSummary } from '../../src/studio/quality/run.ts';
import { dataArray, dataObject, dataNumber, dataId, dataUnique } from '../../src/studio/quality/data.ts';
import { QualityRetouchView } from './quality-retouch-view.ts';
import { draft } from './session.ts';

interface Options { projectId: string; run: QualityRun; variant: QualityVariantSummary; frameId: string; current: () => boolean; onError: (e: unknown) => void }
interface Info { revision: number; w: number; h: number; frameId: string; palette: number[]; pixelEdits: RecipePixelEdit[]; constraints: FrameRetouchConstraints; sourceLockedFrames: string[]; movementMask: string | null }
async function json(response: Response): Promise<any> { const value = await response.json(); if (!response.ok) throw Error(value.error ?? `HTTP ${response.status}`); return value; }
async function pixels(blob: Blob, w: number, h: number): Promise<Uint32Array> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width !== w || bitmap.height !== h || w * h > 8_000_000) throw Error('Ảnh chỉnh pixel sai kích thước hoặc vượt ngân sách native.');
    const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
    const b = ctx.getImageData(0, 0, w, h).data;
    return Uint32Array.from({ length: w * h }, (_, i) => b[i * 4 + 3] === 0 ? 0 : ((b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3]) >>> 0);
  } finally { bitmap.close(); }
}

export async function editQualityVariant(o: Options): Promise<QualityRun | undefined> {
  const dialog = document.createElement('dialog'); dialog.id = 'quality-retouch-dialog'; dialog.className = 'large-workspace'; dialog.setAttribute('aria-labelledby', 'quality-retouch-title');
  dialog.innerHTML = `<div class="workspace-header"><div><h2 id="quality-retouch-title">Sửa nét đề xuất</h2><p class="hint">Bản gốc được giữ nguyên · không gọi AI · lưu biến thể rồi áp dụng thành asset mới</p></div><button id="quality-retouch-close" type="button">Đóng · giữ bản nháp</button></div><div class="retouch-body"><div class="row wrap"><label>Frame<select id="quality-retouch-frame"></select></label><button id="quality-retouch-save" type="button" class="primary">Lưu biến thể</button><button id="quality-retouch-cancel" type="button">Hủy xử lý</button><button id="quality-retouch-download" type="button">Tải frame nháp PNG</button><button id="quality-retouch-restore" type="button" hidden>Khôi phục bản nháp</button><button id="quality-retouch-discard" type="button" hidden>Bỏ bản nháp</button></div><p id="quality-retouch-status" role="status"></p><p id="quality-retouch-error" role="alert"></p><div id="quality-retouch-mount"></div></div>`;
  const el = <T extends HTMLElement = HTMLElement>(name: string) => dialog.querySelector('#quality-retouch-' + name)! as T;
  const base = `/api/pixel/projects/${o.projectId}/quality-runs/${o.run.id}/variants/${o.variant.id}`;
  const key = `quality-retouch:${o.projectId}:${o.run.id}:${o.variant.id}:${o.run.revision}`, abort = new AbortController();
  const frame = el<HTMLSelectElement>('frame');
  o.variant.frames.forEach((f, i) => { const option = document.createElement('option'); option.value = f.id; option.textContent = `${i + 1} · ${f.durationMs} ms`; frame.append(option); });
  frame.value = o.variant.frames.some(f => f.id === o.frameId) ? o.frameId : o.variant.frames[0].id;
  const loaded = new Map<string, { image: Uint32Array; info: Info }>();
  let model: RetouchEditor | undefined, view: QualityRetouchView | undefined, initial: Info | undefined, mask: Uint8Array | null = null;
  let changed = false, closed = false, loading = true, saving = false, recovering = false, found = '', ticket = 0, displayed = '';
  let timer: ReturnType<typeof setTimeout> | undefined, saveAbort: AbortController | undefined, saveStarted = 0;
  let queue: Promise<void> = Promise.resolve(), done!: (run?: QualityRun) => void;
  const completion = new Promise<QualityRun | undefined>(resolve => { done = resolve; });
  const alive = () => !closed && dialog.open && o.current();
  const error = (e: unknown) => { if (closed || (e as Error).name === 'AbortError') return; el('error').textContent = (e as Error).message ?? String(e); o.onError(e); };
  const payload = () => ({ version: 1, revision: o.run.revision, patches: model!.patches(), lockedFrames: model!.state.lockedFrames, region: model!.state.region });
  const persist = (): Promise<void> => {
    clearTimeout(timer); if (!model || !changed) return queue;
    const text = JSON.stringify(payload()); const write = queue.catch(() => {}).then(() => draft('put', key, text)); queue = write;
    return write.then(() => { if (!closed && !saving) el('status').textContent = 'Đã giữ bản nháp trên máy · chưa thay đổi dự án.'; });
  };
  const gate = () => {
    const invalid = !alive(), busy = loading || saving || recovering;
    frame.disabled = busy || invalid; view?.setBusy(busy || invalid || !!found);
    el<HTMLButtonElement>('save').disabled = busy || invalid || !model || !changed || !!found;
    el<HTMLButtonElement>('cancel').disabled = !saving;
    el<HTMLButtonElement>('download').disabled = busy || !view || !displayed || !!found;
    for (const name of ['restore', 'discard']) { const button = el<HTMLButtonElement>(name); button.hidden = !found; button.disabled = busy || invalid; }
    if (invalid && !closed) el('error').textContent = 'Nguồn hoặc revision đã đổi. Bản nháp được giữ; không áp dụng lên nguồn mới.';
    if (saving) el('status').textContent = `Đang dựng biến thể cục bộ · ${Math.floor((performance.now() - saveStarted) / 1000)} giây`;
  };
  const modified = () => { changed = true; el('status').textContent = 'Đang giữ bản nháp…'; clearTimeout(timer); timer = setTimeout(() => void persist().catch(error), 500); gate(); };
  const install = (next: RetouchEditor) => { view?.dispose(); model = next; view = new QualityRetouchView(next, modified, error); el('mount').replaceChildren(view.root); };
  const request = async (path: string) => { const r = await fetch(path, { signal: abort.signal }); if (!r.ok) await json(r); return r; };
  const load = async (id: string) => {
    if (!o.variant.frames.some(f => f.id === id)) throw Error('Frame bản nháp không thuộc biến thể.');
    const prior = loaded.get(id); if (prior) return prior;
    const query = `?revision=${o.run.revision}&frame=${encodeURIComponent(id)}`;
    const [info, png] = await Promise.all([request(base + '/retouch' + query).then(json) as Promise<Info>, request(base + '/frame' + query).then(r => r.blob())]);
    if (!alive()) throw new DOMException('Preview đã đóng', 'AbortError');
    if (info.revision !== o.run.revision || info.frameId !== id || info.w !== o.variant.w || info.h !== o.variant.h) throw Error('Metadata frame không khớp biến thể.');
    const image = await pixels(png, info.w, info.h); if (!alive()) throw new DOMException('Preview đã đóng', 'AbortError');
    if (!model) {
      initial = info;
      if (info.movementMask !== null) { const b = Uint8Array.from(atob(info.movementMask), c => c.charCodeAt(0)); const rgba = await pixels(new Blob([b], { type: 'image/png' }), info.w, info.h); mask = Uint8Array.from(rgba, p => +(p !== 0)); }
      if (!alive()) throw new DOMException('Preview đã đóng', 'AbortError');
      install(new RetouchEditor({ w: info.w, h: info.h, palette: info.palette, frameIds: o.variant.frames.map(f => f.id), constraints: info.constraints, sourceLockedFrames: info.sourceLockedFrames, movementMask: mask }));
    }
    model!.loadFrame(id, image, info.pixelEdits); const value = { image, info }; loaded.set(id, value); return value;
  };
  const show = async (id: string) => {
    const mine = ++ticket; loading = true; gate();
    try {
      const current = await load(id), index = o.variant.frames.findIndex(f => f.id === id), previous = index > 0 ? await load(o.variant.frames[index - 1].id) : undefined;
      if (!alive() || mine !== ticket) return; view!.setFrame(id); view!.setReference(current.image, previous?.image, mask ?? undefined); displayed = id;
    } catch (e) { if (displayed && mine === ticket) frame.value = displayed; throw e; }
    finally { if (!closed && mine === ticket) { loading = false; gate(); } }
  };
  const close = async (run?: QualityRun) => {
    if (closed) return; saveAbort?.abort(); abort.abort();
    try { if (!run) await persist(); } catch (e) { error(e); el('error').textContent += ' Không đóng bảng vì bản nháp chưa được lưu.'; return; }
    closed = true; ticket++; clearTimeout(timer); clearInterval(poll); view?.dispose(); dialog.close(); dialog.remove(); done(run);
  };
  const restore = async () => {
    if (!initial || !found || !model) return; recovering = true; gate();
    try {
      const data = dataObject(JSON.parse(found), ['version', 'revision', 'patches', 'lockedFrames', 'region'], 'Bản nháp');
      if (data.version !== 1 || data.revision !== o.run.revision) throw Error('Bản nháp khác phiên bản/revision.');
      const patches = dataArray(data.patches, 0, 8, 'Frame bản nháp').map(value => {
        const p = dataObject(value, ['frameId', 'pixelEdits'], 'Frame bản nháp'), id = dataId(p.frameId, 'Frame');
        const edits = dataArray(p.pixelEdits, 0, 8192, 'Nét sửa').map(value => {
          const e = dataObject(value, ['x', 'y', 'color'], 'Nét sửa'); return { x: dataNumber(e.x, 0, initial!.w - 1, 'X', true), y: dataNumber(e.y, 0, initial!.h - 1, 'Y', true), color: e.color === null ? null : dataNumber(e.color, 0, initial!.palette.length - 1, 'Màu', true) };
        });
        dataUnique(edits.map(e => e.y * initial!.w + e.x), 'Tọa độ bản nháp'); return { id, edits };
      });
      dataUnique(patches.map(p => p.id), 'Frame bản nháp');
      for (const p of patches) await load(p.id);
      if (!alive()) return;
      const next = new RetouchEditor({ w: initial.w, h: initial.h, palette: initial.palette, frameIds: o.variant.frames.map(f => f.id), constraints: initial.constraints, sourceLockedFrames: initial.sourceLockedFrames, movementMask: mask });
      for (const [id, value] of loaded) next.loadFrame(id, value.image, value.info.pixelEdits);
      for (const p of patches) {
        if (!p.edits.length) continue; next.beginStroke(p.id);
        for (const e of p.edits) { next.paint(e, e, e.color); if (next.getPixels(p.id)[e.y * initial.w + e.x] !== (e.color === null ? 0 : initial.palette[e.color])) throw Error('Nét bản nháp vi phạm vùng khóa.'); }
        next.endStroke();
      }
      next.setRegion(data.region as FrameRetouchConstraints['region']);
      for (const id of dataArray(data.lockedFrames, 0, o.variant.frames.length, 'Frame khóa')) next.setLocked(dataId(id, 'Frame khóa'), true);
      next.history.clear(); found = ''; install(next); await show(frame.value); modified();
    } catch (e) { error(e); } finally { recovering = false; gate(); }
  };
  const save = async () => {
    if (!alive() || !model || saving || loading || recovering || found || !changed) return;
    saving = true; saveStarted = performance.now(); saveAbort = new AbortController(); gate(); el('error').textContent = '';
    try {
      await persist(); if (!alive()) throw Error('Nguồn đã đổi; giữ bản nháp.');
      const data = payload(); const result = await json(await fetch(base + '/retouch', { method: 'POST', signal: saveAbort.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: data.revision, patches: data.patches, lockedFrames: data.lockedFrames, region: data.region }) }));
      if (!alive()) throw Error('Nguồn đã đổi sau khi lưu; giữ bản nháp và xem lịch sử.');
      try { await draft('delete', key); } catch (e) { o.onError(e); }
      await close(result.run);
    } catch (e) { if ((e as Error).name === 'AbortError' && !closed) el('error').textContent = 'Đã hủy yêu cầu. Giữ bản nháp; kiểm tra lịch sử trước khi lưu lại.'; else error(e); }
    finally { saving = false; saveAbort = undefined; if (!closed) gate(); }
  };
  el<HTMLButtonElement>('close').onclick = () => void close();
  dialog.addEventListener('cancel', e => { e.preventDefault(); e.stopPropagation(); void close(); });
  el<HTMLButtonElement>('save').onclick = () => void save(); el<HTMLButtonElement>('cancel').onclick = () => saveAbort?.abort();
  el<HTMLButtonElement>('download').onclick = () => {
    if (!view || !displayed || loading || saving || recovering || found) return;
    view.setBusy(true); view.setBusy(!alive()); const frameId = displayed;
    view.canvas.toBlob(blob => {
      if (!blob || closed) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
      link.download = `${o.variant.id}-${frameId}-r${o.run.revision}-nhap.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };
  el<HTMLButtonElement>('restore').onclick = () => void restore();
  el<HTMLButtonElement>('discard').onclick = () => { void draft('delete', key).then(() => { found = ''; gate(); }).catch(error); };
  frame.onchange = () => void show(frame.value).catch(error);
  document.body.append(dialog); dialog.showModal();
  const poll = setInterval(gate, 500);
  gate(); void (async () => { try { found = await draft('get', key) ?? ''; if (!closed) await show(frame.value); } catch (e) { loading = false; error(e); gate(); } })();
  return completion;
}
