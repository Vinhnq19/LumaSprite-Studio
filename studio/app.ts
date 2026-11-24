import './style.css';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import type { AiJob, AssetSummary, BuildSummary, Picture, PixelLayer, ProjectDocument } from '../src/studio/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas'), context = canvas.getContext('2d')!;
let doc: ProjectDocument | undefined, summary: BuildSummary | undefined, picture: Picture | undefined;
let selected = '', file = '', frame = 0, tool = 'pen', color = 0x70c989ff, suppressEditor = false;
let dirty = false, generation = 0, saving: Promise<void> | undefined, conflict = false;
let saveTimer: ReturnType<typeof setTimeout>, buildId = '', loadTicket = 0, requestTicket = 0;
let playing = false, playTimer: ReturnType<typeof setTimeout>, job: AiJob | undefined;
let undoStack: string[] = [], redoStack: string[] = [], chosen = new Set<string>();
let historyCommand: Promise<void> = Promise.resolve();
let selection: { x: number; y: number; w: number; h: number } | undefined;
let atlasMode = false;
let comparing = false;
let clipboard: { w: number; h: number; data: Uint32Array } | undefined;
let dragging: { x: number; y: number; lastX: number; lastY: number; before: Uint32Array; snapshot: string } | undefined;
let lastCursor = { x: 0, y: 0 }, onionPicture: Picture | undefined, traces: Picture['trace'];
const frames = new Map<string, Picture>(); let providers: any = {};
const editor = new EditorView({ parent: $('editor'), state: EditorState.create({ doc: '// Tạo hoặc mở dự án để bắt đầu.', extensions: [
  lineNumbers(), highlightActiveLine(), drawSelection(), history({ minDepth: 100 }), javascript({ typescript: true }), syntaxHighlighting(defaultHighlightStyle), autocompletion(),
  keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
  EditorView.theme({ '&': { backgroundColor: '#111923', color: '#e9f0ed' }, '.cm-cursor': { borderLeftColor: '#a5e3aa' } }, { dark: true }),
  EditorView.updateListener.of(update => {
    if (!update.docChanged || suppressEditor || !doc || !file) return;
    pushUndo(); doc.files[file] = update.state.doc.toString(); changed();
  }),
] }) });
class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
async function api(path: string, method = 'GET', value?: unknown): Promise<any> {
  const res = await fetch('/api/studio' + path, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await res.json(); if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status); return data;
}
function notice(message = ''): void { $('notice').hidden = !message; $('notice').textContent = message; }
function error(e: unknown): void { const message = e instanceof Error ? e.message : String(e); notice(message); }
function guard(fn: () => void | Promise<void>): () => void { return () => { Promise.resolve().then(fn).catch(error); }; }
function stateSnapshot(): string { return JSON.stringify({ files: doc!.files, pixels: doc!.pixels, metadata: doc!.metadata }); }
function pushUndo(snapshot = doc ? stateSnapshot() : ''): void { if (!snapshot || undoStack.at(-1) === snapshot) return; undoStack.push(snapshot); if (undoStack.length > 100) undoStack.shift(); redoStack = []; }
function setCode(text: string): void { suppressEditor = true; editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); suppressEditor = false; }
function changed(): void {
  if (!doc) return; dirty = true; generation++; $('save-status').textContent = 'Chưa lưu…';
  try { localStorage.setItem(`pxl.draft.${doc.id}`, JSON.stringify({ revision: doc.revision, state: stateSnapshot() })); } catch { /* Disk autosave remains available. */ }
  clearTimeout(saveTimer); if (!conflict) saveTimer = setTimeout(() => void flushSave().catch(error), 500);
}
async function flushSave(snapshot = false): Promise<void> {
  clearTimeout(saveTimer);
  if (saving) { await saving; if (dirty) return flushSave(snapshot); return; }
  if (!doc || (!dirty && !snapshot)) return;
  if (conflict) throw new Error('Có xung đột. Sao chép bản nháp sang dự án mới hoặc tải lại để tiếp tục.');
  saving = (async () => {
    while (doc && (dirty || snapshot)) {
      const token = generation, id = doc.id;
      const saved = await api(`/projects/${id}`, 'PUT', { revision: doc.revision, changes: JSON.parse(stateSnapshot()), snapshot });
      snapshot = false; if (!doc || doc.id !== id) return;
      doc.revision = saved.revision; dirty = generation !== token;
      if (!dirty) { localStorage.removeItem(`pxl.draft.${id}`); $('save-status').textContent = `Đã lưu · r${doc.revision}`; frames.clear(); await build(); }
    }
  })();
  try { await saving; } catch (e) { if (e instanceof ApiError && e.status === 409) { conflict = true; $('save-status').textContent = 'Xung đột — bản nháp vẫn được giữ trong tab'; } throw e; } finally { saving = undefined; }
}
async function projectList(current?: string): Promise<void> {
  const all = await api('/projects'); const box = $<HTMLSelectElement>('projects'); box.replaceChildren(new Option('Chọn dự án…', ''));
  for (const p of all) box.add(new Option(p.name, p.id)); if (current) box.value = current;
}
async function openProject(id: string): Promise<void> {
  if (!id) return;
  const ticket = ++loadTicket; stopPlaying();
  await flushSave();
  if (doc && doc.id !== id) await api(`/projects/${doc.id}/close`, 'POST', {});
  const loaded = await api(`/projects/${id}`); if (ticket !== loadTicket) return;
  doc = loaded; conflict = false; dirty = false; frames.clear(); undoStack = []; redoStack = []; chosen.clear(); summary = undefined; picture = undefined; selected = ''; frame = 0; selection = undefined; job = undefined;
  atlasMode = false; canvas.hidden = true; $('empty').hidden = false; $('asset-info').textContent = ''; $('frame-info').textContent = '—'; $('palette').replaceChildren(); $('trace-panel').hidden = true;
  $('project-name').textContent = doc!.name; $('save-status').textContent = `Đã lưu · r${doc!.revision}`; $('proposal').hidden = true;
  localStorage.setItem('pxl.project', id); refreshFiles(doc!.entry); notice(); await projectList(id); await build();
  const jobs = await api(`/projects/${id}/ai`);
  if (doc?.id === id && jobs.length) { const latest = jobs.at(-1) as AiJob; job = undefined; updateJob(latest); if (['running', 'validating', 'canceling'].includes(latest.status)) void pollAi(latest.id); }
  const draft = localStorage.getItem(`pxl.draft.${id}`);
  if (draft) { notice('Có bản nháp chưa lưu từ phiên trước. Nhấn “Khôi phục bản nháp” để lấy lại.'); const button = document.createElement('button'); button.textContent = 'Khôi phục bản nháp'; button.onclick = () => { try { pushUndo(); Object.assign(doc!, JSON.parse(JSON.parse(draft).state)); setCode(doc!.files[file] ?? ''); changed(); notice('Đã khôi phục bản nháp trong tab; đang lưu theo revision mới.'); } catch (e) { error(e); } }; $('notice').append(' ', button); }
}
function refreshFiles(preferred?: string): void {
  if (!doc) return; file = preferred && doc.files[preferred] !== undefined ? preferred : Object.keys(doc.files)[0];
  const list = $<HTMLSelectElement>('files'); list.replaceChildren(...Object.keys(doc.files).map(n => new Option(n, n))); list.value = file; setCode(doc.files[file]);
}
async function build(): Promise<void> {
  if (!doc || conflict) return; $('build-status').textContent = 'Đang dựng trong worker…';
  const buildJob = await api(`/projects/${doc.id}/build`, 'POST', { revision: doc.revision }); buildId = buildJob.id;
  // SSE normally wins; bounded polling also recovers a lost/reconnected event stream.
  void pollBuild(buildJob.id, doc.id);
}
async function pollBuild(id: string, projectId: string): Promise<void> {
  for (let i = 0; i < 70 && buildId === id && doc?.id === projectId; i++) {
    await new Promise(r => setTimeout(r, 500)); if (buildId !== id) return;
    try { const j = await api(`/builds/${id}`); if (j.status === 'ready' || j.status === 'failed') { acceptBuild(j); return; } if (j.status === 'canceled') return; } catch (e) { error(e); return; }
  }
}
function acceptBuild(j: any): void {
  if (j.id !== buildId || !doc || doc.id !== j.projectId || doc.revision !== j.revision || dirty) return;
  buildId = '';
  if (j.status === 'failed') { $('build-status').textContent = 'Dựng lỗi · giữ ảnh thành công gần nhất'; notice(j.error); return; }
  summary = j.result; $('build-status').textContent = `${summary!.assets.length} asset · ${summary!.ms} ms · r${summary!.revision}`;
  if (summary!.errors.length) notice(summary!.errors.join('\n'));
  else if (summary!.conflicts.length) notice(`Lớp pixel cần chuyển: ${summary!.conflicts.join(', ')}. Có thể xem ảnh nhưng chưa xuất được.`);
  else notice();
  renderAssets(); renderConflicts();
  $<HTMLSelectElement>('sheets').replaceChildren(...(summary!.sheets.length ? summary!.sheets : ['atlas']).map(n => new Option(n, n)));
  if (!summary!.assets.some(a => a.name === selected && !a.error)) selected = summary!.assets.find(a => !a.error && !a.name.startsWith('_'))?.name ?? summary!.assets.find(a => !a.error)?.name ?? '';
  if (atlasMode) void previewAtlas().catch(error); else if (selected) void selectAsset(selected, true).catch(error);
  else { picture = undefined; canvas.hidden = true; $('empty').hidden = false; $('asset-info').textContent = ''; }
}
let thumbChain = Promise.resolve();
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    observer.unobserve(entry.target); const row = entry.target as HTMLElement, name = row.dataset.name!, id = doc?.id, revision = doc?.revision;
    thumbChain = thumbChain.then(async () => { if (!id || doc?.id !== id || revision !== doc.revision) return; try { const pic = await getFrame(name, 0); if (row.isConnected) paintSmall(row.querySelector('canvas')!, pic); } catch { /* Main view reports build errors. */ } });
  }
});
function renderAssets(): void {
  observer.disconnect(); const assets = $('assets'); assets.replaceChildren();
  const q = $<HTMLInputElement>('filter').value.toLowerCase();
  for (const a of summary?.assets ?? []) {
    if (!a.name.toLowerCase().includes(q)) continue;
    const row = document.createElement('div'); row.className = `asset${a.name === selected ? ' selected' : ''}`; row.dataset.name = a.name;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = chosen.has(a.name); checkbox.setAttribute('aria-label', `Xuất ${a.name}`); checkbox.onclick = e => { e.stopPropagation(); if (checkbox.checked) chosen.add(a.name); else chosen.delete(a.name); };
    const thumbnail = document.createElement('canvas'); thumbnail.width = 32; thumbnail.height = 32;
    const label = document.createElement('span'); label.className = 'label'; label.textContent = a.name;
    const info = document.createElement('small'); info.textContent = a.error ? 'Lỗi' : `${a.w}×${a.h} · ${a.durations.length || 1} frame`; if (a.error) info.className = 'error'; label.append(info);
    row.append(checkbox, thumbnail, label); row.onclick = guard(async () => { if (a.error) notice(a.error); else await selectAsset(a.name); }); assets.append(row); if (!a.error) observer.observe(row);
  }
}
function asset(): AssetSummary | undefined { return summary?.assets.find(a => a.name === selected); }
function decode(value: string): Uint32Array { const str = atob(value), bytes = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i); return new Uint32Array(bytes.buffer); }
function imageData(data: Uint32Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h); for (let i = 0; i < data.length; i++) { const c = data[i]; img.data[i * 4] = c >>> 24; img.data[i * 4 + 1] = c >>> 16 & 255; img.data[i * 4 + 2] = c >>> 8 & 255; img.data[i * 4 + 3] = c & 255; } return img;
}
function paintSmall(target: HTMLCanvasElement, pic: Picture): void { target.width = pic.w; target.height = pic.h; target.getContext('2d')!.putImageData(imageData(decode(pic.rgba), pic.w, pic.h), 0, 0); }
async function getFrame(name: string, index: number, trace = false, traceStep?: number): Promise<Picture> {
  if (!doc) throw new Error('Chưa mở dự án.'); const id = doc.id, revision = doc.revision, key = `${id}:${revision}:${name}:${index}:${trace}:${traceStep}`;
  const cached = frames.get(key); if (cached) return cached;
  const pic = await api(`/projects/${id}/frame?revision=${revision}&name=${encodeURIComponent(name)}&frame=${index}${trace ? '&trace=1' : ''}${traceStep === undefined ? '' : `&traceStep=${traceStep}`}`);
  if (doc?.id === id && doc.revision === revision) { if (frames.size >= 32) frames.delete(frames.keys().next().value!); frames.set(key, pic); } return pic;
}
async function selectAsset(name: string, preserve = false): Promise<void> {
  if (dirty) await flushSave(); const previousFrame = frame; atlasMode = false; stopPlaying(); selected = name; frame = preserve ? previousFrame : 0; selection = undefined; traces = undefined; $('trace-panel').hidden = true;
  $<HTMLButtonElement>('trace').disabled = false;
  renderAssets(); const a = asset(); if (!a) return;
  $('asset-info').textContent = `${a.name} · ${a.w}×${a.h}`;
  frame = Math.min(frame, Math.max(0, a.durations.length - 1));
  $<HTMLInputElement>('frame').max = String(Math.max(0, a.durations.length - 1)); $<HTMLInputElement>('frame').value = String(frame);
  $('palette').replaceChildren(); for (const [key, value] of Object.entries(a.palette)) { const b = document.createElement('button'); b.style.background = value; b.title = `${key}: ${value}`; b.setAttribute('aria-label', `Màu ${key}`); b.onclick = () => setColor(value); $('palette').append(b); }
  $<HTMLTextAreaElement>('metadata').value = JSON.stringify(doc?.metadata[name] ?? {}, null, 2);
  $<HTMLInputElement>('overlay').checked = doc?.pixels[name]?.enabled !== false;
  await showFrame();
  if (!preserve) fitCanvas();
}
async function showFrame(): Promise<void> {
  if (!doc || !selected) return; const ticket = ++requestTicket;
  const revision = doc.revision;
  let pic: Picture;
  try { pic = await getFrame(selected, frame); } catch (e) { if (ticket !== requestTicket || doc?.revision !== revision) return; throw e; }
  if (ticket !== requestTicket) return;
  picture = pic; onionPicture = undefined; $('empty').hidden = true; canvas.hidden = false;
  $('frame-info').textContent = `${frame + 1}/${asset()?.durations.length || 1}${pic.duration ? ` · ${pic.duration} ms` : ''}`;
  draw();
  if ($<HTMLInputElement>('onion').checked && frame > 0) { const previous = await getFrame(selected, frame - 1); if (ticket === requestTicket) { onionPicture = previous; draw(); } }
}
function currentPixels(): Uint32Array {
  if (!picture) return new Uint32Array();
  if (atlasMode) return decode(picture.rgba);
  const layer = doc?.pixels[selected];
  if (comparing || !$<HTMLInputElement>('overlay').checked) return decode(picture.base ?? picture.rgba);
  const pixels = decode(picture.base ?? picture.rgba);
  if (layer?.enabled && !summary?.conflicts.includes(selected) && layer.layout.w === picture.w && layer.layout.h === picture.h) for (const [index, value] of Object.entries(layer.frames[String(frame)] ?? {})) pixels[+index] = value;
  return pixels;
}
function draw(preview?: Uint32Array): void {
  if (!picture) return; const zoom = Number($<HTMLSelectElement>('zoom').value), w = picture.w, h = picture.h;
  if (canvas.width !== w * zoom || canvas.height !== h * zoom) { canvas.width = w * zoom; canvas.height = h * zoom; }
  const tile = document.createElement('canvas'); tile.width = zoom * 2; tile.height = zoom * 2;
  const checker = tile.getContext('2d')!; checker.fillStyle = '#24303b'; checker.fillRect(0, 0, tile.width, tile.height); checker.fillStyle = '#2e3d48'; checker.fillRect(zoom, 0, zoom, zoom); checker.fillRect(0, zoom, zoom, zoom);
  context.fillStyle = context.createPattern(tile, 'repeat')!; context.fillRect(0, 0, canvas.width, canvas.height);
  const offscreen = document.createElement('canvas'); offscreen.width = w; offscreen.height = h;
  offscreen.getContext('2d')!.putImageData(imageData(preview ?? currentPixels(), w, h), 0, 0); context.imageSmoothingEnabled = false;
  if (onionPicture && onionPicture.w === w && onionPicture.h === h && $<HTMLInputElement>('onion').checked) {
    const prev = document.createElement('canvas'); paintSmall(prev, onionPicture); context.globalAlpha = .25; context.drawImage(prev, 0, 0, w * zoom, h * zoom); context.globalAlpha = 1;
  }
  context.drawImage(offscreen, 0, 0, w * zoom, h * zoom);
  if ($<HTMLInputElement>('grid').checked && zoom >= 4) { context.strokeStyle = '#07111b55'; context.lineWidth = 1; context.beginPath(); for (let x = 0; x <= w; x++) { context.moveTo(x * zoom + .5, 0); context.lineTo(x * zoom + .5, h * zoom); } for (let y = 0; y <= h; y++) { context.moveTo(0, y * zoom + .5); context.lineTo(w * zoom, y * zoom + .5); } context.stroke(); }
  if (selection) { context.strokeStyle = '#ffe29a'; context.lineWidth = 1.5; context.setLineDash([4, 3]); context.strokeRect(selection.x * zoom + .5, selection.y * zoom + .5, selection.w * zoom - 1, selection.h * zoom - 1); context.setLineDash([]); }
}
function fitCanvas(): void {
  if (!picture) return; const stage = $('stage'); const fit = Math.max(1, Math.floor(Math.min((stage.clientWidth - 48) / picture.w, (stage.clientHeight - 48) / picture.h)));
  const zoom = $<HTMLSelectElement>('zoom'); const value = [...zoom.options].map(o => +o.value).filter(n => n <= fit).at(-1) ?? 1; zoom.value = String(value); draw();
}
function setColor(hex: string): void {
  if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(hex)) return; color = parseInt(hex.slice(1).padEnd(8, 'f'), 16) >>> 0;
  $<HTMLInputElement>('color').value = hex.slice(0, 7); $<HTMLInputElement>('hex').value = hex;
}
function layer(): PixelLayer {
  if (!doc || !picture || !asset()) throw new Error('Chọn asset trước khi vẽ.');
  if (summary?.conflicts.includes(selected)) throw new Error('Chuyển lớp pixel xung đột trước khi vẽ.');
  const a = asset()!;
  return doc.pixels[selected] ??= { enabled: true, layout: { w: picture.w, h: picture.h, durations: [...a.durations] }, frames: {} };
}
function commitPixels(values: Uint32Array, original: Uint32Array, snapshot: string): void {
  let different = false; const changes: [number, number][] = [];
  for (let i = 0; i < values.length; i++) if (values[i] !== original[i]) { different = true; changes.push([i, values[i]]); }
  if (!different) { draw(); return; }
  const l = layer(); l.enabled = true; const patches = l.frames[String(frame)] ??= {}; for (const [index, value] of changes) patches[String(index)] = value;
  pushUndo(snapshot); changed(); $<HTMLInputElement>('overlay').checked = true; draw();
}
function point(e: PointerEvent): { x: number; y: number } { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(picture!.w - 1, Math.floor((e.clientX - r.left) * picture!.w / r.width))), y: Math.max(0, Math.min(picture!.h - 1, Math.floor((e.clientY - r.top) * picture!.h / r.height))) }; }
function line(data: Uint32Array, x0: number, y0: number, x1: number, y1: number, value: number): void {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1; let err = dx + dy;
  for (;;) { data[y0 * picture!.w + x0] = value; if (x0 === x1 && y0 === y1) break; const e = 2 * err; if (e >= dy) { err += dy; x0 += sx; } if (e <= dx) { err += dx; y0 += sy; } }
}
let strokePixels: Uint32Array | undefined;
canvas.addEventListener('pointerdown', e => {
  if (!doc || !picture || playing || comparing || !$('trace-panel').hidden || e.button !== 0 || atlasMode) return;
  try {
    if (tool !== 'pick' && tool !== 'select') layer();
    const p = point(e), before = currentPixels(); lastCursor = p;
    if (tool === 'pick') { setColor('#' + before[p.y * picture.w + p.x].toString(16).padStart(8, '0')); return; }
    canvas.setPointerCapture(e.pointerId); canvas.focus(); dragging = { ...p, lastX: p.x, lastY: p.y, before, snapshot: stateSnapshot() }; strokePixels = before.slice();
    if (tool === 'pen' || tool === 'erase') { line(strokePixels, p.x, p.y, p.x, p.y, tool === 'erase' ? 0 : color); draw(strokePixels); }
    else if (tool === 'fill') {
      const target = before[p.y * picture.w + p.x]; if (target !== color) { const stack = [p.y * picture.w + p.x]; strokePixels[stack[0]] = color;
        while (stack.length) { const index = stack.pop()!, x = index % picture.w, y = Math.floor(index / picture.w); for (const n of [x > 0 ? index - 1 : -1, x < picture.w - 1 ? index + 1 : -1, y > 0 ? index - picture.w : -1, y < picture.h - 1 ? index + picture.w : -1]) if (n >= 0 && strokePixels[n] === target) { strokePixels[n] = color; stack.push(n); } }
      } draw(strokePixels);
    } else if (tool === 'select') { selection = { ...p, w: 1, h: 1 }; draw(); }
  } catch (e) { error(e); }
});
canvas.addEventListener('pointermove', e => {
  if (!picture) return; const p = point(e); lastCursor = p; $('cursor').textContent = `${p.x}, ${p.y}`;
  if (!dragging || !strokePixels) return;
  const d = dragging;
  if (tool === 'pen' || tool === 'erase') line(strokePixels, d.lastX, d.lastY, p.x, p.y, tool === 'erase' ? 0 : color);
  else if (tool === 'line') { strokePixels = d.before.slice(); line(strokePixels, d.x, d.y, p.x, p.y, color); }
  else if (tool === 'rect') { strokePixels = d.before.slice(); line(strokePixels, d.x, d.y, p.x, d.y, color); line(strokePixels, p.x, d.y, p.x, p.y, color); line(strokePixels, p.x, p.y, d.x, p.y, color); line(strokePixels, d.x, p.y, d.x, d.y, color); }
  else if (tool === 'select') selection = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x) + 1, h: Math.abs(p.y - d.y) + 1 };
  else if (tool === 'move' && selection) {
    strokePixels = d.before.slice(); const dx = p.x - d.x, dy = p.y - d.y;
    for (let y = 0; y < selection.h; y++) for (let x = 0; x < selection.w; x++) strokePixels[(selection.y + y) * picture.w + selection.x + x] = 0;
    for (let y = 0; y < selection.h; y++) for (let x = 0; x < selection.w; x++) { const tx = selection.x + x + dx, ty = selection.y + y + dy; if (tx >= 0 && ty >= 0 && tx < picture.w && ty < picture.h) strokePixels[ty * picture.w + tx] = d.before[(selection.y + y) * picture.w + selection.x + x]; }
  }
  d.lastX = p.x; d.lastY = p.y; draw(tool === 'select' ? undefined : strokePixels);
});
function finishStroke(): void {
  if (!dragging || !strokePixels) return; const d = dragging, values = strokePixels; dragging = undefined; strokePixels = undefined;
  if (tool !== 'select' && tool !== 'pick') {
    if (tool === 'move' && selection && picture) { const x = selection.x + d.lastX - d.x, y = selection.y + d.lastY - d.y; const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(picture.w, x + selection.w), y1 = Math.min(picture.h, y + selection.h); selection = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined; }
    try { commitPixels(values, d.before, d.snapshot); } catch (e) { error(e); }
  } else draw();
}
canvas.addEventListener('pointerup', finishStroke); canvas.addEventListener('pointercancel', () => { dragging = undefined; strokePixels = undefined; draw(); });
function region(): { x: number; y: number; w: number; h: number } { return selection ?? { x: 0, y: 0, w: picture!.w, h: picture!.h }; }
function copy(): void { if (!picture) return; const r = region(), data = currentPixels(), copied = new Uint32Array(r.w * r.h); for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) copied[y * r.w + x] = data[(r.y + y) * picture.w + r.x + x]; clipboard = { w: r.w, h: r.h, data: copied }; }
function paste(): void { if (!clipboard || !doc || !picture) return; const before = currentPixels(), next = before.slice(), p = selection ?? lastCursor; for (let y = 0; y < clipboard.h; y++) for (let x = 0; x < clipboard.w; x++) if (p.x + x < picture.w && p.y + y < picture.h) next[(p.y + y) * picture.w + p.x + x] = clipboard.data[y * clipboard.w + x]; commitPixels(next, before, stateSnapshot()); }
function flip(axis: 'x' | 'y'): void { if (!doc || !picture) return; const r = region(), before = currentPixels(), next = before.slice(); for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) next[(r.y + y) * picture.w + r.x + x] = before[(r.y + (axis === 'y' ? r.h - 1 - y : y)) * picture.w + r.x + (axis === 'x' ? r.w - 1 - x : x)]; commitPixels(next, before, stateSnapshot()); }
function undo(redo = false): Promise<void> {
  const next = historyCommand.then(async () => { await flushSave(); if (!doc) return; const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack, previous = from.pop(); if (!previous) return; to.push(stateSnapshot()); Object.assign(doc, JSON.parse(previous)); refreshFiles(file); changed(); draw(); await flushSave(); });
  historyCommand = next.catch(() => {}); return next;
}
function renderConflicts(): void { const list = summary?.conflicts ?? []; $('pixel-conflicts').hidden = !list.length; $<HTMLSelectElement>('conflict-source').replaceChildren(...list.map(n => new Option(n, n))); }
async function rebase(disable = false): Promise<void> {
  if (!doc || !picture || !asset()) return; const source = $<HTMLSelectElement>('conflict-source').value, old = doc.pixels[source]; if (!old) return; pushUndo();
  if (disable) old.enabled = false;
  else {
    if (source !== selected && doc.pixels[selected]) throw new Error('Asset đích đã có lớp pixel. Chọn asset khác hoặc loại lớp hiện tại trước.');
    const next: PixelLayer = { enabled: true, layout: { w: picture.w, h: picture.h, durations: [...asset()!.durations] }, frames: {} };
    for (const [index, values] of Object.entries(old.frames)) { if (+index >= Math.max(1, next.layout.durations.length)) continue; const pixels: Record<string, number> = {}; for (const [offset, value] of Object.entries(values)) { const x = +offset % old.layout.w, y = Math.floor(+offset / old.layout.w); if (x < picture.w && y < picture.h) pixels[String(y * picture.w + x)] = value; } next.frames[index] = pixels; }
    old.enabled = false; doc.pixels[selected] = next;
  }
  changed(); await flushSave();
}
function stopPlaying(): void { playing = false; clearTimeout(playTimer); $('play').textContent = '▶ Phát'; }
async function playNext(): Promise<void> {
  if (!playing) return; const a = asset(); if (!a?.durations.length) { stopPlaying(); return; }
  await showFrame(); if (!playing) return;
  playTimer = setTimeout(() => { if (!a.loop && frame === a.durations.length - 1) { stopPlaying(); return; } frame = (frame + 1) % a.durations.length; $<HTMLInputElement>('frame').value = String(frame); void playNext().catch(e => { stopPlaying(); error(e); }); }, a.durations[frame]);
}
async function download(format: string): Promise<void> {
  await historyCommand; await flushSave(); if (!doc || !selected) throw new Error('Chọn asset trước khi xuất.');
  if (atlasMode && ['png', 'gif', 'strip'].includes(format)) throw new Error('Đang xem atlas. Tải “Atlas + JSON” hoặc chọn lại asset để tải ảnh riêng.');
  const res = await fetch(`/api/studio/projects/${doc.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: doc.revision, name: selected, frame, format, selected: [...chosen], sheet: $<HTMLSelectElement>('sheets').value }) });
  if (!res.ok) { const b = await res.json(); throw new ApiError(b.error, res.status); }
  const disposition = res.headers.get('content-disposition') ?? '', encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  saveBlob(await res.blob(), encoded ? decodeURIComponent(encoded) : 'asset.zip'); notice();
}
async function previewAtlas(): Promise<void> {
  await historyCommand; await flushSave(); if (!doc) return; stopPlaying(); atlasMode = true; selection = undefined; onionPicture = undefined;
  const id = doc.id, revision = doc.revision;
  const p = await api(`/projects/${id}/atlas?revision=${revision}&sheet=${encodeURIComponent($<HTMLSelectElement>('sheets').value)}`);
  if (doc?.id !== id || doc.revision !== revision || !atlasMode) return;
  picture = p; $('empty').hidden = true; canvas.hidden = false; $('trace-panel').hidden = true; $<HTMLButtonElement>('trace').disabled = true;
  $('asset-info').textContent = `Atlas · ${p.w}×${p.h} · chọn asset để vẽ`; $<HTMLSelectElement>('zoom').value = '4'; draw();
}
function saveBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
async function checkProviders(): Promise<void> { providers = await api('/providers'); providerStatus(); }
function providerStatus(): void { const p = $<HTMLSelectElement>('provider').value; $('provider-status').textContent = providers[p]?.message ?? 'Chưa kiểm tra cấu hình AI'; }
async function generate(): Promise<void> {
  await flushSave(); if (!doc) throw new Error('Tạo hoặc mở dự án trước.'); stopPlaying(); $('proposal').hidden = true;
  job = await api(`/projects/${doc.id}/ai`, 'POST', { revision: doc.revision, provider: $<HTMLSelectElement>('provider').value, prompt: $<HTMLTextAreaElement>('prompt').value }); updateJob(job!); void pollAi(job!.id);
}
async function pollAi(id: string): Promise<void> { while (job?.id === id && ['running', 'validating', 'canceling'].includes(job.status)) { await new Promise(r => setTimeout(r, 1000)); try { updateJob(await api(`/ai/${id}`)); } catch (e) { error(e); return; } } }
function updateJob(next: AiJob): void {
  if (!doc || next.projectId !== doc.id || (job && next.id !== job.id)) return; const wasReady = job?.status === 'ready'; job = next;
  const active = ['running', 'validating', 'canceling', 'unknown'].includes(job.status); $<HTMLButtonElement>('generate').disabled = active; $<HTMLButtonElement>('cancel-ai').disabled = !active; $('cancel-ai').textContent = job.status === 'unknown' ? 'Kiểm tra lại việc hủy' : 'Hủy';
  $('ai-status').textContent = `${job.message} · ${Math.floor((Date.now() - job.started) / 1000)} giây`;
  if (job.status === 'ready' && !wasReady) void showProposal().catch(error);
  if (job.status === 'applied') $('proposal').hidden = true;
}
async function showProposal(): Promise<void> {
  if (!job?.proposal || !doc) return; $('proposal').hidden = false; $('proposal-description').textContent = job.proposal.description;
  $('diff').textContent = job.proposal.files.map(f => `--- ${f.path} (hiện tại)\n${doc!.files[f.path] ?? '(file mới)'}\n+++ ${f.path} (đề xuất)\n${f.content}`).join('\n\n');
  if (picture) paintSmall($<HTMLCanvasElement>('before'), { ...picture, rgba: picture.rgba });
  const name = job.build?.assets.find(a => a.name === selected)?.name ?? job.build?.assets.find(a => !a.error)?.name;
  if (name) { const p = await api(`/ai/${job.id}/frame?name=${encodeURIComponent(name)}`); paintSmall($<HTMLCanvasElement>('after'), p); }
}
const stream = new EventSource('/api/studio/events');
stream.onmessage = e => {
  try {
    const event = JSON.parse(e.data);
    if (event.type === 'build') acceptBuild(event.job);
    else if (event.type === 'ai') updateJob(event.job);
    else if (event.type === 'external' && doc && doc.id === event.projectId && event.revision !== doc.revision) {
      if (dirty || saving) { conflict = true; notice('File đã thay đổi bên ngoài. Bản nháp trong tab được giữ nguyên. Dùng Tải lại hoặc lưu bản sao dự án.'); }
      else void openProject(doc.id).catch(error);
    } else if (event.type === 'log') { $('logs').textContent = `${event.time} ${event.message}\n${$('logs').textContent}`.slice(0, 12000); }
  } catch (e) { error(e); }
};
stream.onerror = () => { $('build-status').textContent = 'Đang nối lại máy chủ…'; };
$('new-project').onclick = () => $<HTMLDialogElement>('create-dialog').showModal();
$('cancel-create').onclick = () => $<HTMLDialogElement>('create-dialog').close();
$('create-form').onsubmit = e => { e.preventDefault(); void (async () => { await flushSave(); const p = await api('/projects', 'POST', { name: $<HTMLInputElement>('new-name').value, template: $<HTMLSelectElement>('template').value }); $<HTMLDialogElement>('create-dialog').close(); await openProject(p.id); })().catch(error); };
$('projects').onchange = guard(() => openProject($<HTMLSelectElement>('projects').value));
$('files').onchange = () => { if (!doc) return; file = $<HTMLSelectElement>('files').value; setCode(doc.files[file]); };
$('add-file').onclick = () => { if (!doc) return; const name = prompt('Tên file, ví dụ parts.px.js'); if (!name) return; if (doc.files[name] !== undefined) { notice('File đã tồn tại.'); return; } pushUndo(); doc.files[name] = '// Thêm asset tại đây\n'; refreshFiles(name); changed(); };
$('filter').oninput = renderAssets;
$('save').onclick = guard(() => flushSave(true));
$('reload').onclick = guard(async () => {
  if (!doc) return;
  if (dirty || conflict) {
    const copy = confirm('Bản nháp có thể chưa lưu. Bấm OK để tạo bản sao dự án trước khi tải lại; Cancel để giữ nguyên tab.'); if (!copy) return;
    const saved = await api('/projects', 'POST', { name: `${doc!.name} (bản nháp)`.slice(0, 100), files: doc!.files, entry: doc!.entry });
    await api(`/projects/${saved.id}`, 'PUT', { revision: saved.revision, changes: { pixels: doc!.pixels, metadata: doc!.metadata } });
    dirty = false; conflict = false; await projectList(doc!.id);
  }
  await openProject(doc!.id);
});
$('undo').onclick = guard(() => undo()); $('redo').onclick = guard(() => undo(true));
$('tools').onclick = e => { const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tool]'); if (!button) return; tool = button.dataset.tool!; for (const b of $('tools').querySelectorAll('button')) b.classList.toggle('active', b === button); stopPlaying(); };
$('color').oninput = () => setColor($<HTMLInputElement>('color').value); $('hex').onchange = () => setColor($<HTMLInputElement>('hex').value);
for (const id of ['zoom', 'grid']) $(id).onchange = () => draw();
const fitButton = document.createElement('button'); fitButton.textContent = 'Vừa khung'; fitButton.id = 'fit'; fitButton.onclick = fitCanvas; document.querySelector('.canvas-toolbar')!.append(fitButton);
$('overlay').onchange = () => { if (doc?.pixels[selected]) { pushUndo(); doc.pixels[selected].enabled = $<HTMLInputElement>('overlay').checked; changed(); } draw(); };
$('compare-code').onpointerdown = e => { ($('compare-code') as HTMLElement).setPointerCapture(e.pointerId); comparing = true; draw(); };
$('compare-code').onpointerup = $('compare-code').onpointercancel = () => { comparing = false; draw(); };
$('onion').onchange = guard(showFrame);
$('copy').onclick = copy; $('paste').onclick = guard(() => paste()); $('flip-x').onclick = guard(() => flip('x')); $('flip-y').onclick = guard(() => flip('y'));
$('rebase').onclick = guard(() => rebase()); $('disable-layer').onclick = guard(() => rebase(true));
$('frame').oninput = guard(async () => { stopPlaying(); frame = +$<HTMLInputElement>('frame').value; selection = undefined; await showFrame(); });
$('play').onclick = guard(async () => { await flushSave(); if (playing) stopPlaying(); else { playing = true; $('play').textContent = '❚❚ Dừng'; await playNext(); } });
$('trace').onclick = guard(async () => { if (!$('trace-panel').hidden) { $('trace-panel').hidden = true; await showFrame(); return; } await flushSave(); if (!selected) return; stopPlaying(); const p = await getFrame(selected, 0, true); traces = p.trace; if (!traces?.length) return; $('trace-panel').hidden = false; $<HTMLInputElement>('trace-step').max = String(traces.length - 1); $<HTMLInputElement>('trace-step').value = String(traces.length - 1); $('trace-label').textContent = traces.at(-1)!.label + ' (frame 1; đóng bảng để vẽ)'; });
let traceTimer: ReturnType<typeof setTimeout>, traceTicket = 0;
$('trace-step').oninput = () => {
  const index = +$<HTMLInputElement>('trace-step').value, step = traces?.[index]; if (!step) return; $('trace-label').textContent = step.label;
  const ticket = ++traceTicket; clearTimeout(traceTimer);
  traceTimer = setTimeout(() => { void (async () => {
    const p = await getFrame(selected, 0, true, index), t = p.trace?.[index];
    if (!t?.rgba || ticket !== traceTicket || $('trace-panel').hidden) return;
    const old = picture; picture = { w: t.w, h: t.h, rgba: t.rgba, frame: 0, duration: 0 }; draw(decode(t.rgba)); picture = old;
  })().catch(error); }, 100);
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.onclick = () => { $('editors').className = `mode-${button.dataset.tab}`; for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b === button); editor.requestMeasure(); if (button.dataset.tab !== 'code') fitCanvas(); };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-export]')) button.onclick = guard(() => download(button.dataset.export!));
$('save-metadata').onclick = guard(async () => { if (!doc || !selected) return; const metadata = JSON.parse($<HTMLTextAreaElement>('metadata').value); pushUndo(); doc.metadata[selected] = metadata; changed(); await flushSave(); });
$('preview-atlas').onclick = guard(previewAtlas);
$('check-provider').onclick = guard(checkProviders); $('provider').onchange = providerStatus; $('generate').onclick = guard(generate);
$('cancel-ai').onclick = guard(async () => { if (job) updateJob(await api(`/ai/${job.id}/cancel`, 'POST', {})); });
$('apply-ai').onclick = guard(async () => { await flushSave(); if (!doc || !job) return; const saved = await api(`/ai/${job.id}/apply`, 'POST', { revision: doc.revision }); dirty = false; doc = saved; $('proposal').hidden = true; refreshFiles(file); frames.clear(); await build(); $('save-status').textContent = `Đã áp dụng · r${doc!.revision}`; });
$('history').onclick = guard(async () => {
  await flushSave(); if (!doc) return; const list = await api(`/projects/${doc.id}/history`); $('history-list').replaceChildren();
  for (const item of list) { const b = document.createElement('button'); b.textContent = `${new Date(item.time).toLocaleString('vi-VN')} · ${item.label} · r${item.revision}`; b.onclick = guard(async () => { const saved = await api(`/projects/${doc!.id}/history`, 'POST', { revision: doc!.revision, snapshot: item.id }); doc = saved; dirty = false; $<HTMLDialogElement>('history-dialog').close(); await openProject(saved.id); }); $('history-list').append(b); }
  $<HTMLDialogElement>('history-dialog').showModal();
});
$('close-history').onclick = () => $<HTMLDialogElement>('history-dialog').close();
$('backup').onclick = guard(async () => { await flushSave(); if (!doc) return; const res = await fetch(`/api/studio/projects/${doc.id}/backup`); if (!res.ok) throw new Error('Không tạo được sao lưu.'); saveBlob(await res.blob(), `${doc.name}.zip`); });
$('import').onchange = guard(async () => {
  const uploaded = [...($<HTMLInputElement>('import').files ?? [])]; if (!uploaded.length) return; const files: Record<string, string> = {}; let manifest: any, pixels: any, metadata: any;
  for (const f of uploaded) { const path = (f.webkitRelativePath || f.name).split('/').slice(1).join('/'); if (path.includes('node_modules/') || path.startsWith('out/') || path.startsWith('exports/') || path.startsWith('.git/')) continue; if (/\.[cm]?[jt]s$/.test(path) && !path.startsWith('.pxl/')) files[path] = await f.text(); else if (path === 'pxl.project.json') manifest = JSON.parse(await f.text()); else if (path === '.pxl/pixels.json') pixels = JSON.parse(await f.text()); else if (path === '.pxl/metadata.json') metadata = JSON.parse(await f.text()); }
  const entry = manifest?.entry ?? Object.keys(files).find(n => /\.px\.[jt]s$/.test(n)) ?? Object.keys(files)[0]; if (!entry) throw new Error('Thư mục không chứa file mã.');
  const created = await api('/projects', 'POST', { name: (manifest?.name ?? uploaded[0].webkitRelativePath.split('/')[0]).slice(0, 100), files, entry });
  if (pixels || metadata) await api(`/projects/${created.id}`, 'PUT', { revision: created.revision, changes: { pixels: pixels ?? {}, metadata: metadata ?? {} } }); await openProject(created.id);
});
window.addEventListener('keydown', e => {
  const target = e.target as HTMLElement; if (target.closest('.cm-editor') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); void undo(e.shiftKey).catch(error); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); void undo(true).catch(error); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); try { paste(); } catch (e) { error(e); } }
  else { const tools: Record<string, string> = { b: 'pen', e: 'erase', g: 'fill', i: 'pick' }; const next = tools[e.key.toLowerCase()]; if (next) ($('tools').querySelector(`[data-tool="${next}"]`) as HTMLButtonElement).click(); }
});
window.addEventListener('beforeunload', e => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } });
setInterval(() => { if (job && ['running', 'validating', 'canceling'].includes(job.status)) $('ai-status').textContent = `${job.message} · ${Math.floor((Date.now() - job.started) / 1000)} giây`; }, 1000);
void (async () => { await projectList(); const last = localStorage.getItem('pxl.project'); if (last && [...$<HTMLSelectElement>('projects').options].some(o => o.value === last)) await openProject(last); })().catch(error);
