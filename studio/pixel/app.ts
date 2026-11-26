import './style.css';
import logo from '../../docs/brand/lumasprite.png';
import { sampleMotionPlayback } from '../../src/studio/quality/playback.ts';
import { setupAppearance } from './appearance.ts';
import { setupLayout } from './layout.ts';
import { defaultPalette } from '../../src/studio/pixel/palette.ts';
import { Session, api } from './session.ts';
import { PixelCanvas, type Tool } from './canvas.ts';
import { Timeline } from './timeline.ts';
import { readStudioPng } from './read-png.ts';
import { Commands, bindingErrors, reserved, type Bindings } from '../../src/studio/pixel/commands.ts';
import { newAsset, newDocument, celFor, composite, resizeAsset, mergeDown, presets, uid, playback, playbackTag, isLocked, validateDocument, wireParse, wireStringify, type PixelAsset, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { parseHex, toHex } from '../../src/studio/raster.ts';
import { renderAssetLibraryPanel } from './asset-library-panel.ts';
import { removeAssetLibraryAndReferences } from '../../src/studio/asset-library.ts';
import { assertAtlasMutationAllowed } from '../../src/studio/tilemaps.ts';
import { TerrainEditorController } from './terrain-editor.ts';
import { MapEditorController } from './map-editor.ts';
import { ProductionWorkspace } from './production-workspace.ts';
import { ExternalEnginePanel } from './external-engine-panel.ts';
import { ArtReviewWorkbench } from './art-review/workbench.ts';

document.querySelector('#app')!.innerHTML = `
<header><a class="brand" href="/" aria-label="LumaSprite Studio"><img alt="" src="${logo}">LumaSprite <span>STUDIO</span></a><span class="badge">PIXEL EDITOR</span><span id="project-title">Xưởng pixel của bạn</span><span class="grow"></span><span id="save-status" role="status">Chọn hoặc tạo dự án</span><button data-command="file.save">Lưu</button><button id="command-search">Tìm lệnh /</button><button id="shortcuts">Phím tắt</button></header>
<nav><button id="new-project" class="primary">+ Dự án pixel</button><select id="projects" aria-label="Dự án"><option value="">Chọn dự án…</option></select><button id="new-asset">+ Asset</button><button id="rename-asset">Đổi tên asset</button><button id="delete-asset">Xóa asset</button><button id="ai-workspace-open">External Engine</button><label class="button">Nhập PNG<input id="png-input" type="file" accept="image/png" hidden></label><label class="button">Mở sao lưu<input id="project-import" type="file" webkitdirectory multiple hidden></label><button id="history">Lịch sử</button><button id="backup">Sao lưu ZIP</button><button id="copy-project">Lưu bản sao</button><button id="draft">Khôi phục bản nháp</button><button id="reload">Tải lại</button></nav>
<div id="notice" role="alert" hidden></div>
<div class="workspace"><aside class="tools-panel"><div id="tools" role="group" aria-label="Dụng cụ pixel"></div><hr><button data-command="edit.undo" aria-label="Hoàn tác">↶</button><button data-command="edit.redo" aria-label="Làm lại">↷</button><hr><div class="asset-list-header"><h2>Asset</h2><button id="asset-add" title="Thêm asset" aria-label="Thêm asset">+</button></div><div id="asset-list"></div><small id="asset-status" role="status"></small></aside>
<main><div class="canvas-toolbar"><div class="canvas-context"><strong id="asset-info">Bắt đầu bằng canvas 18×18, 64×64 hoặc kích thước bất kỳ</strong><span id="edit-target"></span></div><span class="grow"></span><button id="canvas-resize">Canvas…</button><button id="image-scale">Co giãn ảnh…</button><button id="zoom-out" aria-label="Thu nhỏ" title="Ctrl + cuộn để thu hoặc phóng">−</button><span id="zoom-value">800%</span><button id="zoom-in" aria-label="Phóng to" title="Ctrl + cuộn để thu hoặc phóng">+</button><button id="fit">Vừa khung</button><button id="actual" aria-label="Xem 100%">100%</button><label><input id="grid" type="checkbox" checked>Lưới</label><label>Ô <input id="cell-grid" type="number" min="0" max="4096" value="0"></label><button id="inspector-toggle" type="button" aria-controls="properties" aria-expanded="true">Bảng chỉnh sửa</button></div>
<div id="stage"><div id="stage-inner"><div id="empty"><span class="pixel-mark">▦</span><h1>Vẽ từng pixel.<br>Tạo cả thế giới.</h1><p>Canvas tùy chỉnh · Layer · Animation · Asset game</p><button id="start-create" class="primary">Tạo dự án đầu tiên</button><small>Kéo PNG vào đây để nhập ảnh</small></div><canvas id="canvas" aria-label="Canvas vẽ pixel" tabindex="0" hidden></canvas></div></div>
<div id="timeline-splitter" class="splitter horizontal-splitter" role="separator" aria-label="Đổi chiều cao canvas và timeline" aria-orientation="horizontal" aria-controls="stage timeline" tabindex="0" title="Kéo để đổi chiều cao canvas / timeline · Nhấp đúp để đặt lại"></div><div class="timeline-toolbar"><button data-command="animation.play" id="play">▶ Phát</button><select id="play-tag" aria-label="Tag phát"><option value="">Tất cả frame</option></select><button id="tag-edit">Tag…</button><button data-command="frame.add">+ Frame</button><button id="frame-copy">Nhân bản</button><button id="frame-link">Nhân bản liên kết</button><button id="frame-delete">Xóa frame</button><label>ms <input id="duration" type="number" min="1" max="60000" value="100"></label><button id="cel-unlink">Tách liên kết</button><button id="cel-delete">Xóa cel</button><span class="grow"></span><label><input id="onion" type="checkbox">Onion-skin</label><button id="onion-options">⚙</button></div><div id="timeline" tabindex="0"></div>
<footer><span id="cursor">—</span><span id="tool-hint">P bút · Alt lấy màu · Space kéo canvas · Ctrl+S lưu</span><span class="grow"></span><span id="performance"></span></footer></main>
<div id="sidebar-splitter" class="splitter vertical-splitter" role="separator" aria-label="Đổi độ rộng thanh bên phải" aria-orientation="vertical" aria-controls="properties" tabindex="0" title="Kéo để đổi độ rộng thanh bên · Nhấp đúp để đặt lại"></div><aside class="properties" id="properties">
<section><h2>Màu & palette</h2><div class="row"><input id="color" type="color" value="#70c989" aria-label="Màu trước"><input id="back-color" type="color" value="#ffffff" aria-label="Màu sau"><button data-command="color.swap">⇄ X</button></div><div class="row"><input id="hex" aria-label="Màu RGBA" value="#70c989ff"><label>A <input id="alpha" type="number" min="0" max="255" value="255"></label></div><div id="palette"></div><div class="row wrap"><button id="palette-add">+ Màu</button><button id="palette-delete">Xóa màu</button><button id="palette-image">Từ ảnh</button><button id="palette-default" title="Bổ sung 32 màu mẫu, giữ các màu đang có">+ Bảng màu mặc định</button></div></section>
<section><details id="appearance-panel"><summary>Hiển thị vùng vẽ</summary><label>Nền vùng làm việc <input id="workspace-color" type="color" aria-label="Nền vùng làm việc" value="#454b56"></label><label>Nền trong suốt<select id="checker-theme" aria-label="Nền trong suốt"><option value="neutral">Xám trung tính</option><option value="light">Sáng</option><option value="dark">Tối</option></select></label><label>Độ rộng thanh bên <output id="sidebar-width-value">360 px</output><input id="sidebar-width" type="range" min="280" max="520" step="10" value="360" aria-label="Độ rộng thanh bên"></label><button id="appearance-reset">Mặc định hiển thị</button><p class="hint">Chỉ đổi cách xem, không đổi nền ảnh khi xuất. Lưu riêng trên máy này.</p></details></section>
<section><h2>Layer hiện tại</h2><div class="row wrap"><button data-command="layer.add">+ Layer</button><button id="layer-group">+ Nhóm</button><button id="layer-copy">Nhân bản</button><button id="layer-delete">Xóa</button></div><label>Tên<input id="layer-name" maxlength="100"></label><label>Độ đục <input id="layer-opacity" type="range" min="0" max="255" value="255"></label><label>Nhóm cha<select id="layer-parent"><option value="">Không có</option></select></label><div class="row"><button id="layer-up">Lên</button><button id="layer-down">Xuống</button><button id="layer-merge">Gộp xuống</button></div></section>
<section><h2>Nét vẽ</h2><div class="row"><label>Cỡ <input id="brush-size" type="number" min="1" max="64" value="1"></label><select id="brush-shape" aria-label="Đầu bút"><option value="square">Vuông</option><option value="round">Tròn</option></select></div><label><input id="pixel-perfect" type="checkbox" checked>Pixel-perfect (bút 1px)</label><div class="row"><label><input id="mirror-x" type="checkbox">Đối xứng X</label><label><input id="mirror-y" type="checkbox">Y</label></div><label><input id="filled" type="checkbox">Hình đặc</label><details><summary>Tô vùng / đũa thần</summary><label><input id="contiguous" type="checkbox" checked>Liền nhau</label><label>Sai số <input id="tolerance" type="number" min="0" max="255" value="0"></label><label><input id="sample-all" type="checkbox">Lấy mẫu ảnh tổng hợp</label></details></section>
<section><h2>Vùng chọn</h2><div class="row wrap"><button data-command="edit.cut">Cắt</button><button data-command="edit.copy">Copy</button><button data-command="edit.paste">Dán</button><button data-command="selection.all">Chọn hết</button><button data-command="selection.clear">Bỏ chọn</button><button id="flip-x">Lật X</button><button id="flip-y">Lật Y</button><button id="rotate">Xoay 90°</button><button id="confirm-float">Áp dụng Enter</button><button id="cancel-float">Hủy Esc</button></div></section>
<section><h2>Xuất asset</h2><div class="row wrap"><button data-export="png">PNG</button><button data-export="gif">GIF</button><button data-export="strip">Strip + JSON</button><button data-export="atlas">Atlas + JSON</button><button data-export="zip">ZIP asset đã chọn</button><button id="atlas-preview">Xem atlas</button></div><small>Chọn checkbox cạnh asset để xuất nhiều. GIF/strip dùng tag đang chọn.</small></section>
<section><details><summary>Thuộc tính game</summary><textarea id="metadata" rows="5" aria-label="Metadata game"></textarea><button id="metadata-save">Lưu pivot / hitbox / event</button></details></section>
<section><button id="ai-open" class="primary" type="button" style="width:100%">External Engine…</button></section></aside></div>
<dialog id="create-dialog"><form id="create-form"><h2 id="create-title">Tạo dự án pixel</h2><label>Tên<input id="new-name" required maxlength="100" value="Dự án pixel"></label><label>Preset<select id="size-preset">${presets.map(n => `<option value="${n}" ${n === 32 ? 'selected' : ''}>${n} × ${n}</option>`).join('')}<option value="custom">Tùy chỉnh</option></select></label><div class="row"><label>Rộng<input id="new-width" type="number" min="1" max="4096" value="32" required></label><label>Cao<input id="new-height" type="number" min="1" max="4096" value="32" required></label></div><label><input id="size-lock" type="checkbox">Khóa tỉ lệ</label><label><input id="transparent" type="checkbox" checked>Nền trong suốt</label><label>Màu nền<input id="new-background" type="color" value="#ffffff"></label><div class="row"><button type="button" data-close>Hủy</button><button type="submit" class="primary">Tạo</button></div></form></dialog>
<dialog id="resize-dialog"><form id="resize-form"><h2 id="resize-title">Đổi kích thước canvas</h2><div class="row"><label>Rộng<input id="resize-width" type="number" min="1" max="4096" required></label><label>Cao<input id="resize-height" type="number" min="1" max="4096" required></label></div><label><input id="resize-lock" type="checkbox">Khóa tỉ lệ</label><div id="anchor-grid">${[0, .5, 1].flatMap(y => [0, .5, 1].map(x => `<button type="button" data-anchor="${x},${y}" class="${x === .5 && y === .5 ? 'selected' : ''}">${x === .5 && y === .5 ? '●' : '·'}</button>`)).join('')}</div><p id="resize-description"></p><canvas id="resize-preview" width="240" height="180"></canvas><small>Vùng đỏ nằm ngoài canvas mới sẽ bị cắt; có thể hoàn tác. Pivot ngoài canvas sẽ được giới hạn về mép gần nhất.</small><div class="row"><button type="button" data-close>Hủy</button><button type="submit" class="primary">Áp dụng</button></div></form></dialog>
<dialog id="shortcut-dialog"><h2>Phím tắt</h2><p>Alt: lấy màu tạm · Space: kéo canvas tạm. Không áp dụng khi nhập văn bản.</p><div class="row"><select id="shortcut-preset"><option value="aseprite">Gần Aseprite</option><option value="studio">Studio hiện tại</option></select><button id="shortcut-defaults">Khôi phục preset</button><button id="shortcut-export">Xuất JSON</button><label class="button">Nhập JSON<input id="shortcut-import" type="file" accept="application/json" hidden></label></div><input id="shortcut-filter" placeholder="Tìm lệnh/phím…" aria-label="Tìm phím tắt"><p class="hint" id="reserved"></p><div id="shortcut-list"></div><p id="shortcut-errors" role="alert"></p><div class="row"><button data-close>Đóng</button><button id="shortcut-save" class="primary">Lưu cấu hình</button></div></dialog>
<dialog id="commands-dialog"><h2>Tìm lệnh</h2><input id="commands-filter" aria-label="Tìm lệnh" placeholder="Nhập tên lệnh…"><div id="commands-list"></div><button data-close>Đóng</button></dialog>
<dialog id="tag-dialog"><form id="tag-form"><h2>Tag animation</h2><select id="tag-list"><option value="">+ Tag mới</option></select><label>Tên<input id="tag-name" required maxlength="100"></label><div class="row"><label>Từ<select id="tag-from"></select></label><label>Đến<select id="tag-to"></select></label></div><label>Hướng<select id="tag-direction"><option value="forward">Xuôi</option><option value="reverse">Ngược</option><option value="ping-pong">Ping-pong</option></select></label><label><input id="tag-loop" type="checkbox" checked>Lặp</label><div class="row"><button type="button" data-close>Đóng</button><button type="button" id="tag-delete">Xóa tag</button><button type="submit" class="primary">Lưu tag</button></div></form></dialog>
<dialog id="import-dialog"><form id="import-form"><h2>Nhập PNG / sprite sheet</h2><p id="import-info"></p><label>Tên asset<input id="import-name" required maxlength="100"></label><label><input id="import-sheet" type="checkbox">Cắt thành các frame</label><div class="row"><label>Rộng ô<input id="import-width" type="number" min="1" max="4096" required></label><label>Cao ô<input id="import-height" type="number" min="1" max="4096" required></label></div><div class="row"><label>Lề ngoài<input id="import-margin" type="number" min="0" value="0"></label><label>Khoảng cách<input id="import-spacing" type="number" min="0" value="0"></label></div><label>Thứ tự<select id="import-order"><option value="rows">Theo hàng</option><option value="columns">Theo cột</option></select></label><p>Frame mới có duration 100 ms; có thể sửa trên timeline.</p><div class="row"><button type="button" data-close>Hủy</button><button type="submit" class="primary">Nhập ảnh</button></div></form></dialog>
<dialog id="history-dialog"><h2>Lịch sử phục hồi</h2><div id="history-list"></div><button data-close>Đóng</button></dialog>
<dialog id="generation-workspace" class="large-workspace" aria-labelledby="external-engine-title">
  <div class="workspace-header"><h2 id="external-engine-title">External Engine</h2><button id="ai-close" type="button">Về Pixel Editor</button></div>
  <div id="external-engine-panel"></div>
</dialog>
<dialog id="onion-dialog"><h2>Onion-skin</h2><label>Frame trước<input id="onion-before" type="number" min="0" max="8" value="1"></label><label>Frame sau<input id="onion-after" type="number" min="0" max="8" value="1"></label><label>Độ mờ<input id="onion-opacity" type="range" min="0" max="100" value="25"></label><div class="row"><input id="onion-prev-color" type="color" value="#ff6677" aria-label="Màu frame trước"><input id="onion-next-color" type="color" value="#66bbff" aria-label="Màu frame sau"></div><button data-close>Đóng</button></dialog>
<dialog id="atlas-dialog"><h2>Preview atlas</h2><p id="atlas-info"></p><div class="atlas-stage"><img id="atlas-image" alt="Atlas pixel"></div><button id="atlas-download">Tải PNG/JSON cùng revision</button><button data-close>Đóng</button></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const input = (id: string) => $<HTMLInputElement>(id), select = (id: string) => $<HTMLSelectElement>(id), number = (id: string) => Number(input(id).value), checked = (id: string) => input(id).checked;
const session = new Session(), painter = new PixelCanvas($('canvas'), $('stage'), session), timeline = new Timeline($('timeline'), session), commands = new Commands();
setupAppearance(painter);
setupLayout();

function error(e: unknown): void { $('notice').textContent = e instanceof Error ? e.message : String(e); $('notice').hidden = false; }
function safe<T extends unknown[]>(fn: (...args: T) => unknown | Promise<unknown>): (...args: T) => void {
  return (...args: T) => {
    try {
      Promise.resolve(fn(...args)).catch(error);
    } catch (e) {
      error(e);
    }
  };
}
function show(id: string): void { $<HTMLDialogElement>(id).showModal(); }
function close(id: string): void { $<HTMLDialogElement>(id).close(); }
function bind(id: string, fn: () => unknown | Promise<unknown>): void { $(id).onclick = safe(fn); }

let projectLocks = 0;
function projectLock(enter: boolean): void {
  projectLocks += enter ? 1 : -1; const busy = projectLocks > 0;
  if (busy && painter.hasGesture) painter.abort();
  document.querySelector<HTMLElement>('.workspace')!.inert = busy; document.querySelector<HTMLElement>('nav')!.inert = busy; painter.ready = !busy;
  if (busy) $('canvas').hidden = true; else painter.present();
}

const expectedWrites = new Set<string>();
async function writeRevision(path: string, value: Record<string, unknown>): Promise<any> {
  const id = session.doc!.id, key = `${id}:${Number(value.revision) + 1}`; expectedWrites.add(key);
  while (expectedWrites.size > 100) expectedWrites.delete(expectedWrites.values().next().value!);
  try { return await api(path, 'POST', value); }
  catch (e) { expectedWrites.delete(key); if ((e as any).status === 409 && session.doc?.id === id) session.conflict = true; throw e; }
}

async function prepareEdit(): Promise<void> {
  painter.confirm();
  await session.loadFrame();
  await session.flush();
}

async function openAssetFrame(assetId: string, frameId: string, layerId = ''): Promise<void> {
  painter.cancel(); session.assetId = assetId; session.frameId = frameId; session.layerId = layerId;
  session.normalize(); await session.loadFrame(); render(); painter.fit(true); renderEditTarget();
}

const engineDialog = $<HTMLDialogElement>('generation-workspace');
const engineClose = $<HTMLButtonElement>('ai-close');
const engine = new ExternalEnginePanel($('external-engine-panel'), session, prepareEdit,
  () => painter.selection, writeRevision, async saved => {
    const current = session.doc;
    if (current?.id !== saved.id || session.dirty || session.conflict) throw new Error('Dự án đã đổi; tải lại trước khi nhận kết quả.');
    const before = session.begin()!;
    if (!before.studio && saved.studio) before.studio = { version: saved.studio.version };
    for (const asset of saved.assets) for (const cel of Object.values(asset.cels)) {
      const old = current.assets.find(item => item.id === asset.id)?.cels[cel.id];
      if (old?.blob === cel.blob && old?.data) cel.data = old.data;
    }
    for (const [id, resource] of Object.entries(saved.studio?.resources ?? {})) {
      const old = current.studio?.resources?.[id];
      if (old?.blob === resource.blob && old?.data) resource.data = old.data;
    }
    session.history.commit(before, saved, 'Áp dụng External Engine');
    session.doc = saved;
    session.version++;
    const asset = saved.assets.at(-1)!;
    await openAssetFrame(asset.id, asset.frames[0].id);
    session.onstatus(`Đã lưu · r${saved.revision}`);
    engineDialog.close();
  }, applying => { engineClose.disabled = applying; });
engineDialog.addEventListener('close', () => engine.hide());
engineDialog.addEventListener('cancel', event => { if (engineClose.disabled) event.preventDefault(); });
bind('ai-close', () => { if (!engineClose.disabled) engineDialog.close(); });
async function openEngine() {
  if (!session.doc) return;
  stop();
  await prepareEdit();
  engineDialog.showModal();
  await engine.show();
}
bind('ai-open', openEngine);
bind('ai-workspace-open', openEngine);

const mapEditor = new MapEditorController({ session, prepare: prepareEdit, error });
const production = new ProductionWorkspace({
  session,
  prepare: async () => { stop(); await prepareEdit(); },
  openAsset: async id => {
    const asset = session.doc?.assets.find(value => value.id === id);
    if (asset) { timeline.clear(); await openAssetFrame(id, asset.frames[0].id); }
  },
  openMap: id => mapEditor.open(id),
});
const terrainEditor = new TerrainEditorController({ session, prepare: prepareEdit, error, write: writeRevision, applied: async assetId => {
  const id = session.doc?.id; if (!id) return;
  await openProject(id); session.assetId = assetId; session.normalize(); await session.loadFrame(); render(); painter.fit(true); renderEditTarget();
} });
for (const [id, label, action] of [['terrain-editor-open', 'Tileset từ vật liệu', () => terrainEditor.open()], ['map-editor-open', 'Bản đồ', () => mapEditor.open()], ['production-open', 'Sản xuất', () => production.open()]] as const) {
  const button = document.createElement('button'); button.id = id; button.textContent = label; button.disabled = !session.doc;
  $('ai-workspace-open').after(button); bind(id, action);
}
const artReview = new ArtReviewWorkbench({ session, error });
{
  const button = document.createElement('button');
  button.id = 'art-review-open';
  button.type = 'button';
  button.textContent = 'Art Review';
  $('ai-workspace-open').after(button);
  bind('art-review-open', () => { stop(); artReview.open(); });
}

const selectionReset = document.createElement('button'); selectionReset.id = 'deselect'; selectionReset.dataset.command = 'selection.clear'; selectionReset.textContent = 'Bỏ chọn'; selectionReset.hidden = true; document.querySelector('.canvas-toolbar')!.append(selectionReset);
let creatingAsset = false, resizing: 'canvas' | 'scale' = 'canvas', anchorX = .5, anchorY = .5, playing = false, playTimer: ReturnType<typeof setTimeout>, playTicket = 0;
const selectedAssets = new Set<string>();
let imported: { w: number; h: number; data: Uint32Array; name: string } | undefined, atlas: { blob: Blob; revision: number; objectUrl: string } | undefined;
let shortcutDraft: Bindings = {}, projectList: { id: string; name: string }[] = [];

function option(value: string, text: string): HTMLOptionElement { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }
function download(blob: Blob, name: string): void { const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function colors(): void { input('color').value = toHex(painter.color).slice(0, 7); input('hex').value = '#' + painter.color.toString(16).padStart(8, '0'); input('alpha').value = String(painter.color & 255); input('back-color').value = toHex(painter.background).slice(0, 7); renderTools(); }
function command(id: string, title: string, keys: string[], fn: () => unknown | Promise<unknown>, enabled = () => !!session.doc): void { commands.add({ id, title, keys, run: safe(fn), enabled }); }
const tools: [Tool, string, string][] = [['pen', 'Bút', 'p'], ['erase', 'Tẩy', 'e'], ['fill', 'Tô vùng', 'g'], ['pick', 'Lấy màu', 'i'], ['line', 'Đường', 'l'], ['rect', 'Chữ nhật', 'u'], ['ellipse', 'Ellipse', 'o'], ['select', 'Chọn vùng', 'm'], ['wand', 'Đũa thần', 'w'], ['move', 'Di chuyển', 'v'], ['hand', 'Kéo canvas', 'h']];
for (const [tool, name, key] of tools) { command(`tool.${tool}`, name, [key], () => { stop(); painter.setTool(tool); renderTools(); }); const b = document.createElement('button'); b.dataset.command = `tool.${tool}`; b.dataset.tool = tool; b.textContent = name; $('tools').append(b); }
command('file.save', 'Lưu phiên bản', ['Ctrl+s'], async () => { painter.confirm(); await session.flush(true); });
function undoEdit(redo = false): Promise<void> | void {
  stop();
  const pending = painter.hasGesture || !!painter.floating;
  painter.cancel();
  if (!pending) return session.undo(redo);
}
command('edit.undo', 'Hoàn tác', ['Ctrl+z'], () => undoEdit()); command('edit.redo', 'Làm lại', ['Ctrl+Shift+z', 'Ctrl+y'], () => undoEdit(true));
command('edit.copy', 'Sao chép pixel / cel', ['Ctrl+c'], () => document.activeElement?.closest('#timeline') ? timeline.copyCells() : painter.copy()); command('edit.cut', 'Cắt pixel / cel', ['Ctrl+x'], () => document.activeElement?.closest('#timeline') ? timeline.copyCells(true) : painter.copy(true)); command('edit.paste', 'Dán pixel / cel', ['Ctrl+v'], () => document.activeElement?.closest('#timeline') ? timeline.pasteCells() : painter.paste());
command('edit.delete', 'Xóa vùng pixel / cel', ['Delete'], () => { if (document.activeElement?.closest('#timeline')) timeline.deleteCells(); else painter.eraseSelection(); });
command('selection.all', 'Chọn tất cả pixel', ['Ctrl+a'], () => painter.all()); command('selection.clear', 'Bỏ vùng chọn', ['Ctrl+d'], () => painter.cancel());
command('color.swap', 'Đổi màu trước và sau', ['x'], () => { [painter.color, painter.background] = [painter.background, painter.color]; colors(); });
command('brush.smaller', 'Giảm cỡ bút', ['['], () => { painter.size = Math.max(1, painter.size - 1); input('brush-size').value = String(painter.size); }); command('brush.larger', 'Tăng cỡ bút', [']'], () => { painter.size = Math.min(64, painter.size + 1); input('brush-size').value = String(painter.size); });
command('layer.add', 'Thêm layer', ['Shift+n'], () => timeline.addLayer()); command('frame.add', 'Thêm frame trống', ['Shift+f'], () => timeline.addFrame('blank'));
command('animation.play', 'Phát / dừng animation hoặc xác nhận vùng nổi', ['Enter'], () => { if (painter.floating) painter.confirm(); else void play().catch(error); });
command('selection.cancel', 'Hủy thao tác / vùng nổi', ['Escape'], () => { if (painter.hasGesture) painter.abort(); else painter.cancel(); });
command('command.search', 'Tìm lệnh', ['/'], () => openCommands(), () => true);
command('terrain.open', 'Tileset từ vật liệu', [], () => terrainEditor.open());
command('map.open', 'Bản đồ platformer', [], () => mapEditor.open());
command('art-review.open', 'Mở Art Review Workbench', [], () => { stop(); artReview.open(); }, () => true);
command('view.fit', 'Vừa khung', [], () => painter.fit()); command('view.actual', 'Xem 100%', [], () => painter.setZoom(1));
for (const [key, dx, dy] of [['ArrowLeft', -1, 0], ['ArrowRight', 1, 0], ['ArrowUp', 0, -1], ['ArrowDown', 0, 1]] as [string, number, number][]) command(`move.${key}`, `Dịch vùng ${key}`, [key], async () => { if (painter.floating) painter.nudge(dx, dy); else if (dx) { stop(); const a = session.asset!, i = a.frames.findIndex(f => f.id === session.frameId); painter.cancel(); await session.selectFrame(a.frames[Math.max(0, Math.min(a.frames.length - 1, i + dx))].id); } });
const temporaryTools = new Map<string, Tool>();
for (const [id, title, key, tool] of [['quick.pick', 'Giữ để lấy màu', 'Alt', 'pick'], ['quick.hand', 'Giữ để kéo canvas', 'Space', 'hand']] as const) commands.add({ id, title, keys: [key], temporary: true, run: () => { if (tool === 'pick' && ['select', 'wand'].includes(painter.tool)) return; temporaryTools.set(id, tool); painter.temporary = [...temporaryTools.values()].at(-1); painter.draw(); renderTools(); }, release: () => { temporaryTools.delete(id); painter.temporary = [...temporaryTools.values()].at(-1); painter.draw(); renderTools(); }, enabled: () => !!session.doc });
try { commands.configure(JSON.parse(localStorage.getItem('pxl.pixel.shortcuts') ?? '{}')); } catch { commands.configure({}); }
commands.listen();
document.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-command]'); if (b) commands.execute(b.dataset.command!); const c = (e.target as HTMLElement).closest<HTMLElement>('[data-close]'); if (c) c.closest('dialog')!.close(); });

function renderTools(): void {
  const binding = (id: string) => commands.bindings[id]?.join(' / ');
  for (const b of $('tools').querySelectorAll<HTMLButtonElement>('button')) {
    const active = b.dataset.tool === painter.currentTool;
    b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); b.disabled = !session.asset;
    const key = binding(b.dataset.command!); b.title = key ? `${b.textContent} (${key})` : b.textContent!;
  }
  for (const id of ['edit.undo', 'edit.redo']) {
    const button = document.querySelector<HTMLButtonElement>(`.tools-panel [data-command="${id}"]`)!;
    button.disabled = !session.asset; button.title = binding(id) || button.getAttribute('aria-label')!;
  }
  selectionReset.hidden = !painter.selection;
  selectionReset.title = binding('selection.clear') || 'Bỏ chọn';
  $<HTMLButtonElement>('confirm-float').disabled = !painter.floating;
  $<HTMLButtonElement>('cancel-float').disabled = !painter.floating && !painter.hasGesture;
  const name = tools.find(([id]) => id === painter.currentTool)?.[1] ?? painter.currentTool;
  const hints = [name + (painter.temporary ? ' (tạm thời)' : '')];
  if (painter.floating) {
    hints.push('Vùng nổi');
    if (binding('animation.play')) hints.push(binding('animation.play') + ' xác nhận');
    if (binding('selection.cancel')) hints.push(binding('selection.cancel') + ' hủy');
  } else if (painter.selection) hints.push('Chỉ vẽ trong vùng chọn');
  else for (const [id, action] of [['quick.pick', 'lấy màu'], ['quick.hand', 'kéo canvas']]) if (binding(id)) hints.push(`${binding(id)} ${action}`);
  if (!(painter.color & 255)) hints.push('Màu trong suốt (A=0)');
  $('tool-hint').textContent = hints.join(' · ');
}
const frameLoad = document.createElement('div');
frameLoad.id = 'frame-load'; frameLoad.hidden = true;
const frameMessage = document.createElement('span'), retryFrame = document.createElement('button');
frameMessage.setAttribute('role', 'status'); retryFrame.type = 'button'; retryFrame.textContent = 'Thử tải lại';
frameLoad.append(frameMessage, retryFrame); $('stage').append(frameLoad);
retryFrame.onclick = safe(async () => {
  const asset = session.asset, frame = session.frameId;
  await loadCurrent();
  if (session.asset === asset && session.frameId === frame) render();
});
function renderEditTarget(): void {
  const a = session.asset, l = session.layer, frame = session.frame;
  const label = $('edit-target'), pending = session.framePending, failure = pending && session.frameError;
  const locked = !!(a && l && isLocked(a, l));
  label.textContent = a && l && frame ? `${l.name} · Frame ${a.frames.indexOf(frame) + 1}/${a.frames.length}${locked ? ' · Khóa' : ''}${failure ? ' · Tải lỗi' : pending ? ' · Đang tải…' : ''}` : '';
  label.title = label.textContent;
  label.dataset.locked = String(locked);
  frameLoad.hidden = !pending; retryFrame.hidden = !failure;
  frameMessage.textContent = failure ? `Không tải được frame. ${failure}` : 'Đang tải frame…';
}
function render(): void {
  $('asset-status').textContent='';
  session.normalize(); const a = session.asset, l = session.layer;
  if (session.doc) { if (![...select('projects').options].some(o => o.value === session.doc!.id)) select('projects').append(option(session.doc.id, session.doc.name)); select('projects').value = session.doc.id; }
  $('empty').hidden = !!a; $('project-title').textContent = session.doc?.name ?? 'Xưởng pixel của bạn';
  $('asset-info').textContent = a ? `${a.name} · ${a.w} × ${a.h} · ${a.layers.filter(l => l.type === 'image').length} layer · ${a.frames.length} frame` : 'Canvas tùy chỉnh · Nhiều layer · Animation';
  $('zoom-value').textContent = `${Math.round(painter.zoom * 100)}%`;
  renderEditTarget();
  for (const id of ['canvas-resize', 'image-scale', 'zoom-in', 'zoom-out', 'fit', 'actual', 'play', 'grid', 'cell-grid']) $<HTMLButtonElement>(id).disabled = !a;
  if (session.doc) {
    renderAssetLibraryPanel($('asset-list'), {
      doc: session.doc,
      activeAssetId: session.assetId,
      selectedAssets,
      onSelectAsset: safe(async (assetId) => {
        painter.confirm();
        stop();
        painter.reset();
        timeline.clear();
        session.assetId = assetId;
        session.normalize();
        render();
        await loadCurrent();
      }),
      onDeleteAsset: safe((assetId) => deleteAsset(assetId)),
      onOpenMap: safe((id) => mapEditor.open(id)),
      onToggleExport: (assetId, selected) => {
        if (selected) selectedAssets.add(assetId);
        else selectedAssets.delete(assetId);
      },
    });
  } else {
    $('asset-list').replaceChildren();
  }
  input('layer-name').value = l?.name ?? ''; input('layer-opacity').value = String(l?.opacity ?? 255); select('layer-parent').replaceChildren(option('', 'Không có'));
  for (const group of a?.layers.filter(g => g.type === 'group' && g.id !== l?.id) ?? []) select('layer-parent').append(option(group.id, group.name)); select('layer-parent').value = l?.parent ?? '';
  input('duration').value = String(session.frame?.duration ?? 100); $('metadata').textContent = JSON.stringify(a?.metadata ?? {}, null, 2); $<HTMLTextAreaElement>('metadata').value = JSON.stringify(a?.metadata ?? {}, null, 2);
  const selectedTag = select('play-tag').value; select('play-tag').replaceChildren(option('', 'Tất cả frame')); for (const t of a?.tags ?? []) select('play-tag').append(option(t.id, `${t.name} · ${t.direction}${t.loop ? '' : ' · 1 lần'}`)); select('play-tag').value = a?.tags.some(t => t.id === selectedTag) ? selectedTag : '';
  renderPalette(); renderTools(); timeline.render(); painter.draw();
}
function renderPalette(): void {
  $('palette').replaceChildren(); const a = session.asset;
  (a?.palette ?? defaultPalette).forEach((color, i) => { const b = document.createElement('button'); b.style.background = toHex(color); b.title = `${toHex(color)} · kéo để sắp xếp`; b.classList.toggle('chosen', painter.color === color); b.onclick = () => { painter.color = color; colors(); renderPalette(); }; b.draggable = !!a; b.ondragstart = e => e.dataTransfer!.setData('application/pxl-color', String(i)); b.ondragover = e => e.preventDefault(); b.ondrop = e => { e.preventDefault(); const index = Number(e.dataTransfer!.getData('application/pxl-color')); if (a && Number.isInteger(index) && index >= 0 && index < a.palette.length) session.change('Sắp xếp palette', () => { const c = a.palette.splice(index, 1)[0]; a.palette.splice(i, 0, c); }); }; $('palette').append(b); });
}
session.onchange = () => { for (const id of ['ai-open', 'ai-workspace-open', 'terrain-editor-open', 'map-editor-open', 'production-open']) $<HTMLButtonElement>(id).disabled = !session.doc; render(); terrainEditor.gate(); mapEditor.update(); }; session.onstatus = text => { $('save-status').textContent = text; queueMicrotask(() => { engine.refresh(); terrainEditor.gate(); mapEditor.gate(); }); }; session.onerror = error; painter.onerror = error; painter.onchange = () => { renderTools(); $('zoom-value').textContent = `${Math.round(painter.zoom * 100)}%`; }; painter.onpick = () => { colors(); renderPalette(); }; painter.oncursor = p => $('cursor').textContent = `${p.x}, ${p.y}`;
timeline.onerror = error; timeline.beforeSelect = () => { stop(); painter.confirm(); painter.cancel(); }; timeline.onselect = () => { render(); void loadCurrent().catch(error); };
session.onframe = () => { renderEditTarget(); painter.draw(); };
painter.beforeEdit = stop;
async function loadCurrent(): Promise<void> {
  const doc = session.doc, a = session.asset, frame = session.frameId;
  try { await session.loadFrame(frame, a); }
  catch (cause) { if (session.doc === doc && session.asset === a && session.frameId === frame) throw cause; return; }
  if (session.doc !== doc || session.asset !== a || session.frameId !== frame) return;
  renderEditTarget(); painter.draw(); if (!a || !painter.onion) return; const i = a.frames.findIndex(f => f.id === frame);
  for (let n = i - painter.onionBefore; n <= i + painter.onionAfter; n++) {
    if (session.asset !== a || session.frameId !== frame) return;
    if (a.frames[n] && n !== i) await session.loadFrame(a.frames[n].id, a);
  }
  painter.draw();
}
async function listProjects(selected = session.doc?.id): Promise<void> { projectList = await api('projects'); select('projects').replaceChildren(option('', 'Chọn dự án…')); for (const p of projectList) select('projects').append(option(p.id, p.name)); select('projects').value = selected ?? ''; }

async function openProject(id: string): Promise<void> {
  stop(); painter.confirm(); if (engineDialog.open) engineDialog.close(); engine.hide(); terrainEditor.reset(); mapEditor.reset(); production.resetProject(); if(session.doc&&session.doc.id!==id){await session.flush();await api(`${session.path}/close`,'POST',{});} painter.reset(); timeline.clear(); selectedAssets.clear();
  projectLock(true);
  try { await session.open(id); await listProjects(id); render(); painter.fit(true); }
  finally { projectLock(false); }
}
function openCreate(asset = false): void { creatingAsset = asset; $('create-title').textContent = asset ? 'Thêm asset pixel' : 'Tạo dự án pixel'; input('new-name').value = asset ? `Sprite ${(session.doc?.assets.length ?? 0) + 1}` : 'Dự án pixel'; show('create-dialog'); }
bind('new-project', () => openCreate()); bind('start-create', () => openCreate()); bind('new-asset', () => { if (!session.doc) openCreate(); else openCreate(true); });
select('size-preset').onchange = () => { if (select('size-preset').value !== 'custom') { input('new-width').value = input('new-height').value = select('size-preset').value; } };
function lockSize(w: string, h: string, lock: string, changed: () => void): void {
  let ratio = number(w) / number(h); input(lock).onchange = () => { ratio = number(w) / number(h); };
  input(w).oninput = () => { if (checked(lock)) input(h).value = String(Math.max(1, Math.round(number(w) / ratio))); changed(); }; input(h).oninput = () => { if (checked(lock)) input(w).value = String(Math.max(1, Math.round(number(h) * ratio))); changed(); };
}
lockSize('new-width', 'new-height', 'size-lock', () => select('size-preset').value = 'custom');
$('create-form').onsubmit = e => { e.preventDefault(); safe(async () => {
  const name = input('new-name').value.trim(), w = number('new-width'), h = number('new-height'), bg = checked('transparent') ? 0 : parseHex(input('new-background').value)!;
  if (creatingAsset && session.doc) { painter.confirm(); session.change('Thêm asset', () => { const a = newAsset(name, w, h, bg); session.doc!.assets.push(a); session.assetId = a.id; }); await session.loadFrame(); close('create-dialog'); painter.fit(true); }
  else { await session.flush(); const d = await api('projects', 'POST', { name, document: newDocument(name, w, h, bg) }); close('create-dialog'); await openProject(d.id); }
})(); };
select('projects').onchange = safe(async () => { const id = select('projects').value; if (id) await openProject(id); });
bind('rename-asset', () => { const a = session.asset; if (!a) return; const name = prompt('Tên asset', a.name); if (name) session.change('Đổi tên asset', () => a.name = name.trim()); });
async function deleteAsset(id=session.assetId):Promise<void>{
  const doc=session.doc,asset=doc?.assets.find(a=>a.id===id);if(!doc||!asset)return;
  stop();painter.confirm();projectLock(true);
  try{
    await session.flush();
    for(const frame of asset.frames)await session.loadFrame(frame.id,asset);
    if(session.doc!==doc)return;
    const current=session.assetId===id,last=doc.assets.length===1,index=doc.assets.indexOf(asset);
    if(current){painter.reset();timeline.clear();}
    session.change(`Xóa asset ${asset.name}`,()=>{
      const cleaned = removeAssetLibraryAndReferences(doc, [asset.id]);
      if (cleaned.studio) doc.studio = cleaned.studio;
      doc.assets.splice(index,1);
      if(last){const blank=newAsset('Sprite',asset.w,asset.h);blank.palette=[...asset.palette];doc.assets.push(blank);}
      if(current){session.assetId=doc.assets[Math.min(index,doc.assets.length-1)].id;session.layerId='';session.frameId='';}
    });
    selectedAssets.delete(id);await session.loadFrame();render();
    $('asset-status').textContent=last?'Đã xóa; tạo canvas trống. Ctrl+Z để khôi phục.':'Đã xóa asset. Ctrl+Z để khôi phục.';
  }finally{projectLock(false);}
}
bind('delete-asset',()=>deleteAsset());bind('asset-add',()=>$('new-asset').click());
bind('copy-project', async () => { painter.confirm(); const id = await session.copy(); await openProject(id); });
bind('draft', () => session.restoreDraft()); bind('reload', async () => { if (!session.doc) return; if (session.dirty) { const id = await session.copy(); error(`Đã giữ bản nháp thành bản sao ${id}. Đang mở lại bản gốc.`); } session.dirty = false; session.conflict = false; await openProject(session.doc.id); });
bind('backup', async () => { painter.confirm(); if (!session.doc) return; if (session.conflict) { download(new Blob([wireStringify(session.doc)], { type: 'application/json' }), `${session.doc.name}-draft.json`); return; } await session.flush(); const r = await fetch(`/api/pixel/${session.path}/backup`); if (!r.ok) throw new Error('Không tạo được sao lưu.'); download(await r.blob(), `${session.doc.name}.zip`); });

function resizePreview(): void {
  const a = session.asset; if (!a) return; const w = number('resize-width'), h = number('resize-height'); if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) return;
  $('resize-description').textContent = resizing === 'scale' ? `${a.w}×${a.h} → ${w}×${h} · nearest-neighbor · tất cả layer/frame` : `${a.w}×${a.h} → ${w}×${h} · neo ${anchorX}, ${anchorY} · tất cả layer/frame`;
  const c = $<HTMLCanvasElement>('resize-preview'), ctx = c.getContext('2d')!, s = Math.min(220 / Math.max(a.w, w), 160 / Math.max(a.h, h)), dx = Math.floor((w - a.w) * anchorX), dy = Math.floor((h - a.h) * anchorY);
  ctx.clearRect(0, 0, c.width, c.height); ctx.fillStyle = '#d2616155'; ctx.fillRect(10 + Math.max(0, -dx) * s, 10 + Math.max(0, -dy) * s, a.w * s, a.h * s);
  ctx.strokeStyle = '#70c989'; ctx.lineWidth = 2; ctx.strokeRect(10 + Math.max(0, dx) * s, 10 + Math.max(0, dy) * s, w * s, h * s);
  const temp = structuredClone(a); try { for (const id of Object.keys(temp.cels)) if (!temp.cels[id].data) delete temp.cels[id]; for (const l of temp.layers) for (const [f, id] of Object.entries(l.cels)) if (!temp.cels[id]) delete l.cels[f]; resizeAsset(temp, w, h, resizing, anchorX, anchorY); const img = composite(temp, session.frameId); const p = pictureCanvas(img.data, w, h); ctx.imageSmoothingEnabled = false; ctx.drawImage(p, 10 + Math.max(0, dx) * s, 10 + Math.max(0, dy) * s, w * s, h * s); } catch { /* Input validation is repeated on Apply. */ }
}
async function openResize(mode: 'canvas' | 'scale'): Promise<void> { if (!session.asset) return; painter.confirm(); stop(); await session.loadAll(); resizing = mode; input('resize-width').value = String(session.asset.w); input('resize-height').value = String(session.asset.h); input('resize-lock').checked = false; $('resize-title').textContent = mode === 'canvas' ? 'Đổi kích thước canvas' : 'Co giãn ảnh'; $('anchor-grid').hidden = mode === 'scale'; resizePreview(); show('resize-dialog'); }
bind('canvas-resize', () => openResize('canvas')); bind('image-scale', () => openResize('scale')); lockSize('resize-width', 'resize-height', 'resize-lock', resizePreview);
$('anchor-grid').onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-anchor]'); if (!b) return; [anchorX, anchorY] = b.dataset.anchor!.split(',').map(Number); for (const el of $('anchor-grid').children) el.classList.toggle('selected', el === b); resizePreview(); };
$('resize-form').onsubmit = e => { e.preventDefault(); safe(() => { assertAtlasMutationAllowed(session.doc!, session.asset!.id, { w: number('resize-width'), h: number('resize-height') }); session.change('Đổi kích thước', () => resizeAsset(session.asset!, number('resize-width'), number('resize-height'), resizing, anchorX, anchorY)); painter.cancel(); close('resize-dialog'); painter.fit(true); })(); };
bind('fit', () => painter.fit()); bind('actual', () => painter.setZoom(1)); bind('zoom-in', () => painter.setZoom(painter.zoom * 2)); bind('zoom-out', () => painter.setZoom(painter.zoom / 2));
for (const [id, property] of [['grid', 'grid'], ['pixel-perfect', 'perfect'], ['mirror-x', 'mirrorX'], ['mirror-y', 'mirrorY'], ['filled', 'filled'], ['contiguous', 'contiguous'], ['sample-all', 'sampleAll']] as const) input(id).onchange = () => { painter[property] = checked(id); painter.draw(); };
input('cell-grid').onchange = () => { painter.cellGrid = Math.max(0, Math.min(4096, number('cell-grid'))); painter.draw(); }; input('brush-size').onchange = () => { painter.size = Math.max(1, Math.min(64, Math.round(number('brush-size')))); input('brush-size').value = String(painter.size); }; select('brush-shape').onchange = () => painter.round = select('brush-shape').value === 'round'; input('tolerance').onchange = () => painter.tolerance = Math.max(0, Math.min(255, number('tolerance')));
input('color').oninput = () => { painter.color = (parseHex(input('color').value)! & 0xffffff00 | number('alpha')) >>> 0; colors(); }; input('back-color').oninput = () => painter.background = parseHex(input('back-color').value)!;
input('hex').onchange = safe(() => { const color = parseHex(input('hex').value); if (color === undefined) throw new Error('Dùng màu #RGB, #RRGGBB hoặc #RRGGBBAA.'); painter.color = color; colors(); }); input('alpha').onchange = () => { painter.color = (painter.color & 0xffffff00 | Math.max(0, Math.min(255, number('alpha')))) >>> 0; colors(); };
bind('palette-add', () => { if (session.asset) session.change('Thêm màu', () => { if (!session.asset!.palette.includes(painter.color)) session.asset!.palette.push(painter.color); }); }); bind('palette-delete', () => { if (session.asset) session.change('Xóa màu', () => session.asset!.palette = session.asset!.palette.filter(c => c !== painter.color)); }); bind('palette-image', () => { if (session.asset) session.change('Palette từ ảnh', () => session.asset!.palette = [...new Set(composite(session.asset!, session.frameId).data)].slice(0, 4096)); });
bind('palette-default', () => { if (session.asset) session.change('Bổ sung bảng màu mặc định', () => { const a = session.asset!, colors = [...new Set([...a.palette, ...defaultPalette])]; if (colors.length > 4096) throw new Error('Palette vượt 4096 màu.'); a.palette = colors; }); });
for (const [id, transform] of [['flip-x', 'x'], ['flip-y', 'y'], ['rotate', 'rotate']] as const) bind(id, () => { painter.transform(transform); $('canvas').focus({ preventScroll: true }); });
bind('confirm-float', () => painter.confirm()); bind('cancel-float', () => painter.cancel());
bind('layer-group', () => timeline.addLayer(true)); bind('layer-copy', () => timeline.duplicateLayer()); bind('layer-delete', () => timeline.deleteLayer());
bind('layer-merge', async () => {
  timeline.beforeSelect();
  const a = session.asset, layer = session.layer;
  if (!a || !layer) return;
  await session.loadAll();
  if (session.asset === a && session.layer === layer) session.change('Gộp layer xuống', () => mergeDown(a, layer.id));
});
input('layer-name').onchange = safe(() => session.change('Đổi tên layer', () => { if (session.layer) session.layer.name = input('layer-name').value.trim(); })); input('layer-opacity').onchange = safe(() => session.change('Độ đục layer', () => { if (session.layer) session.layer.opacity = number('layer-opacity'); })); select('layer-parent').onchange = safe(() => session.change('Chuyển nhóm', () => { if (session.layer) session.layer.parent = select('layer-parent').value || undefined; }));
for (const [id, delta] of [['layer-up', 1], ['layer-down', -1]] as const) bind(id, () => { const a = session.asset, l = session.layer; if (!a || !l) return; session.change('Di chuyển layer', () => { const siblings = a.layers.filter(k => k.parent === l.parent), i = siblings.indexOf(l), other = siblings[i + delta]; if (other) { const x = a.layers.indexOf(l), y = a.layers.indexOf(other); [a.layers[x], a.layers[y]] = [a.layers[y], a.layers[x]]; } }); });
bind('frame-copy', () => timeline.addFrame('copy')); bind('frame-link', () => timeline.addFrame('linked')); bind('frame-delete', () => timeline.deleteFrames()); bind('cel-unlink', () => timeline.unlink()); bind('cel-delete', () => timeline.deleteCells());
input('duration').onchange = safe(() => { const duration = number('duration'); session.change('Timing frame', () => { for (const f of session.asset?.frames ?? []) if (timeline.selectedFrames.size ? timeline.selectedFrames.has(f.id) : f.id === session.frameId) f.duration = duration; }); });
function stop(): void { playing = false; ++playTicket; clearTimeout(playTimer); $('play').textContent = '▶ Phát'; }
async function play(): Promise<void> {
  if (playing) { stop(); return; } const a = session.asset, doc = session.doc; if (!a) return;
  const ticket = ++playTicket; painter.confirm(); await session.loadAll();
  if (ticket !== playTicket || session.asset !== a || session.doc !== doc) return;
  const sequence = playback(a, select('play-tag').value), loop = playbackTag(a,select('play-tag').value)?.loop ?? true;
  const frames = sequence.map(s => ({ durationMs: s.frame.duration })), started = performance.now();
  playing = true; $('play').textContent = '❚❚ Dừng';
  const next = () => {
    if (!playing || ticket !== playTicket) return;
    if (session.asset !== a || session.doc !== doc) { stop(); return; }
    const stamp = performance.now(), sample = sampleMotionPlayback(frames, stamp - started, loop), item = sequence[sample.index];
    session.frameId = item.frame.id; painter.draw(); renderEditTarget(); input('duration').value = String(item.frame.duration);
    if (sample.done) { stop(); render(); return; }
    playTimer = setTimeout(next, Math.max(1, sample.delayMs - (performance.now() - stamp)));
  }; next();
}
select('play-tag').onchange = () => { stop(); }; input('onion').onchange = safe(async () => { painter.onion = checked('onion'); await loadCurrent(); painter.draw(); }); bind('onion-options', () => show('onion-dialog'));
for (const id of ['onion-before', 'onion-after', 'onion-opacity', 'onion-prev-color', 'onion-next-color']) input(id).oninput = safe(async () => { painter.onionBefore = Math.max(0, Math.min(8, number('onion-before'))); painter.onionAfter = Math.max(0, Math.min(8, number('onion-after'))); painter.onionOpacity = number('onion-opacity') / 100; painter.onionPreviousColor = input('onion-prev-color').value; painter.onionNextColor = input('onion-next-color').value; await loadCurrent(); painter.draw(); });
function fillTag(): void { const a = session.asset!; const t = a.tags.find(t => t.id === select('tag-list').value); input('tag-name').value = t?.name ?? ''; select('tag-from').replaceChildren(...a.frames.map((f, i) => option(f.id, String(i + 1)))); select('tag-to').replaceChildren(...a.frames.map((f, i) => option(f.id, String(i + 1)))); select('tag-from').value = t?.from ?? a.frames[0].id; select('tag-to').value = t?.to ?? a.frames.at(-1)!.id; select('tag-direction').value = t?.direction ?? 'forward'; input('tag-loop').checked = t?.loop ?? true; }
bind('tag-edit', () => { if (!session.asset) return; select('tag-list').replaceChildren(option('', '+ Tag mới'), ...session.asset.tags.map(t => option(t.id, t.name))); fillTag(); show('tag-dialog'); }); select('tag-list').onchange = fillTag;
$('tag-form').onsubmit = e => { e.preventDefault(); safe(() => { session.change('Lưu tag animation', () => { const a = session.asset!, t = { id: select('tag-list').value || uid(), name: input('tag-name').value.trim(), from: select('tag-from').value, to: select('tag-to').value, direction: select('tag-direction').value as 'forward' | 'reverse' | 'ping-pong', loop: checked('tag-loop') }; const i = a.tags.findIndex(k => k.id === t.id); if (i < 0) a.tags.push(t); else a.tags[i] = t; }); close('tag-dialog'); })(); };
bind('tag-delete', () => { session.change('Xóa tag', () => session.asset!.tags = session.asset!.tags.filter(t => t.id !== select('tag-list').value)); close('tag-dialog'); });
bind('metadata-save', () => session.change('Metadata game', () => { session.asset!.metadata = JSON.parse($<HTMLTextAreaElement>('metadata').value); }));

function openCommands(): void { renderCommands(); show('commands-dialog'); input('commands-filter').focus(); }
function renderCommands(): void { const query = input('commands-filter').value.toLocaleLowerCase(); $('commands-list').replaceChildren(); for (const c of commands.items.values()) if (!c.temporary && c.title.toLocaleLowerCase().includes(query)) { const b = document.createElement('button'); b.textContent = `${c.title}    ${(commands.bindings[c.id] ?? []).join(' / ')}`; b.disabled = c.enabled ? !c.enabled() : false; b.onclick = () => { close('commands-dialog'); commands.execute(c.id); }; $('commands-list').append(b); } }
bind('command-search', openCommands); input('commands-filter').oninput = renderCommands;
function renderShortcuts(): void {
  const query = input('shortcut-filter').value.toLocaleLowerCase(); $('shortcut-list').replaceChildren();
  for (const c of commands.items.values()) if (`${c.title} ${c.id} ${shortcutDraft[c.id]?.join()}`.toLocaleLowerCase().includes(query)) { const label = document.createElement('label'); label.textContent = c.title; const field = document.createElement('input'); field.value = shortcutDraft[c.id]?.join(', ') ?? ''; field.dataset.commandId = c.id; field.placeholder = 'Ví dụ Ctrl+Shift+z (phân cách dấu phẩy)'; field.onchange = () => { shortcutDraft[c.id] = field.value.split(',').map(s => s.trim()).filter(Boolean); $('shortcut-errors').textContent = bindingErrors(shortcutDraft, [...commands.items.keys()]).join('\n'); }; label.append(field); $('shortcut-list').append(label); }
}
bind('shortcuts', () => { shortcutDraft = structuredClone(commands.bindings); $('reserved').textContent = `Chrome/Windows giữ: ${reserved.join(', ')}. Dùng menu/nút cho các lệnh này.`; $('shortcut-errors').textContent = ''; renderShortcuts(); show('shortcut-dialog'); }); input('shortcut-filter').oninput = renderShortcuts;
bind('shortcut-defaults', () => { shortcutDraft = commands.defaults(select('shortcut-preset').value as 'aseprite' | 'studio'); $('shortcut-errors').textContent = ''; renderShortcuts(); });
bind('shortcut-save', () => { try { commands.configure(shortcutDraft); localStorage.setItem('pxl.pixel.shortcuts', JSON.stringify(commands.bindings)); close('shortcut-dialog'); renderTools(); } catch (e) { $('shortcut-errors').textContent = (e as Error).message; } });
bind('shortcut-export', () => download(new Blob([JSON.stringify(shortcutDraft, null, 2)], { type: 'application/json' }), 'pxl-shortcuts.json'));
input('shortcut-import').onchange = safe(async () => { const file = input('shortcut-import').files?.[0]; if (!file) return; const data = JSON.parse(await file.text()), errors = bindingErrors(data, [...commands.items.keys()]); if (errors.length) throw new Error(errors.join('\n')); shortcutDraft = { ...commands.defaults(), ...data }; renderShortcuts(); });

function pictureCanvas(data: Uint32Array, w: number, h: number): HTMLCanvasElement { const c = document.createElement('canvas'); c.width = w; c.height = h; const b = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < data.length; i++) { const p = data[i]; b[i * 4] = p >>> 24; b[i * 4 + 1] = p >>> 16 & 255; b[i * 4 + 2] = p >>> 8 & 255; b[i * 4 + 3] = p & 255; } c.getContext('2d')!.putImageData(new ImageData(b, w, h), 0, 0); return c; }
async function readPng(file: File): Promise<void> {
  if (file.size > 64 * 1024 * 1024) throw new Error('PNG vượt 64 MiB.');
  const head = new Uint8Array(await file.slice(0, 24).arrayBuffer()); if (![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => head[i] === b)) throw new Error('Chọn ảnh PNG hợp lệ.');
  const v = new DataView(head.buffer), w = v.getUint32(16), h = v.getUint32(20); if (!w || !h || w > 16384 || h > 16384 || w * h > 32_000_000) throw new Error('PNG vượt giới hạn 32 triệu pixel hoặc 16384 px mỗi chiều.');
  let data = await readStudioPng(file, w, h);
  if (!data) {
    const img = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0); img.close();
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const pixels = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    data = Uint32Array.from({ length: w * h }, (_, index) => pixels.getUint32(index * 4));
  }
  imported = { w, h, data, name: file.name.replace(/\.png$/i, '') }; input('import-name').value = imported.name.slice(0, 100); input('import-width').value = String(Math.min(4096, w)); input('import-height').value = String(Math.min(4096, h)); input('import-sheet').checked = w > 4096 || h > 4096; $('import-info').textContent = `${file.name} · ${w} × ${h}`; show('import-dialog');
}
input('png-input').onchange = safe(async () => { const f = input('png-input').files?.[0]; if (f) await readPng(f); input('png-input').value = ''; });
$('stage').ondragover = e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); }; $('stage').ondrop = e => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) void readPng(f).catch(error); };
$('import-form').onsubmit = e => { e.preventDefault(); safe(async () => {
  if (!imported) return; const src = imported, sheet = checked('import-sheet'), w = sheet ? number('import-width') : src.w, h = sheet ? number('import-height') : src.h, margin = sheet ? number('import-margin') : 0, gap = sheet ? number('import-spacing') : 0;
  const a = newAsset(input('import-name').value.trim(), w, h), positions: { x: number; y: number }[] = [];
  if (!Number.isInteger(margin) || !Number.isInteger(gap) || margin < 0 || gap < 0) throw new Error('Lề và khoảng cách cần số nguyên không âm.');
  for (let y = margin; y + h <= src.h - margin; y += h + gap) for (let x = margin; x + w <= src.w - margin; x += w + gap) positions.push({ x, y });
  if (!positions.length || positions.length > 600 || positions.length * w * h > 32_000_000) throw new Error('Sheet cần 1–600 ô vừa ảnh và tối đa 32 triệu pixel cel.');
  if (sheet && select('import-order').value === 'columns') positions.sort((a, b) => a.x - b.x || a.y - b.y);
  a.frames = positions.map(p => { const frame = { id: uid(), duration: 100 }, id = uid(), data = new Uint32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = src.data[(p.y + y) * src.w + p.x + x]; a.cels[id] = { id, data }; a.layers[0].cels[frame.id] = id; return frame; });
  a.palette = [...new Set(src.data)].slice(0, 4096); if (session.doc) { painter.confirm(); session.change('Nhập PNG/sprite sheet', () => { session.doc!.assets.push(a); session.assetId = a.id; }); await session.loadFrame(); }
  else { const doc = newDocument(a.name); doc.assets = [a]; const d = await api('projects', 'POST', { name: a.name, document: doc }); await openProject(d.id); }
  imported = undefined; close('import-dialog'); painter.fit(true);
})(); };
input('project-import').onchange = safe(async () => {
  const files = [...input('project-import').files ?? []], manifest = files.find(f => /(^|\/)pxl\.project\.json$/.test(f.webkitRelativePath)); if (!manifest) throw new Error('Chọn thư mục sao lưu đã giải nén, có pxl.project.json.');
  const envelope = JSON.parse(await manifest.text()), d = envelope.document as PixelDocument; if (!d || d.schemaVersion !== 2) throw new Error('Bản này chỉ mở bản sao lưu Pixel v2. Hãy xuất PNG hoặc chuyển đổi bằng phiên bản Studio cũ trước.');
  const history = await Promise.all(files.filter(f => /\/\.pxl\/pixel-history\/[\w-]+\.json$/.test(f.webkitRelativePath)).slice(-20).map(async f => JSON.parse(await f.text())));
  const blobs: Record<string, string> = {}; for (const file of files.filter(f => /\/\.pxl\/cels\/[a-f0-9]{64}\.rgba\.z$/.test(f.webkitRelativePath))) { const digest = file.name.slice(0, 64), data = new Uint8Array(await file.arrayBuffer()); let text = ''; for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192)); blobs[digest] = btoa(text); }
  const resourceBlobs: Record<string, string> = {};
  for (const file of files.filter(f => /(?:^|\/)\.pxl\/resources\/[a-f0-9]{64}\.(rgba|mask|tile-index)\.z$/.test(f.webkitRelativePath))) {
    const match = file.name.match(/^([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/);
    if (match) {
      const digest = match[1], kind = match[2];
      const data = new Uint8Array(await file.arrayBuffer());
      let text = '';
      for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
      resourceBlobs[`${kind}:${digest}`] = btoa(text);
    }
  }
  validateDocument(d); await session.flush(); const created = await api('projects', 'POST', { name: d.name, backup: { document: d, blobs, history, resourceBlobs } }); await openProject(created.id); input('project-import').value = '';
});
bind('history', async () => { if (!session.doc) return; await session.flush(); const entries: { id: string; label: string; time: string; revision: number }[] = await api(`${session.path}/history`); $('history-list').replaceChildren(); for (const h of entries) { const b = document.createElement('button'); b.textContent = `${new Date(h.time).toLocaleString('vi-VN')} · r${h.revision} · ${h.label}`; b.onclick = safe(async () => { await session.flush(); const saved = await writeRevision(`${session.path}/history`, { revision: session.doc!.revision, snapshot: h.id }); close('history-dialog'); await openProject(saved.id); }); $('history-list').append(b); } show('history-dialog'); });

async function exported(format: string): Promise<Blob> { if (!session.doc) throw new Error('Tạo dự án trước khi xuất.'); painter.confirm(); await session.flush(); const r = await fetch(`/api/pixel/${session.path}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: session.doc.revision, format, assetId: session.assetId, frameId: session.frameId, tagId: select('play-tag').value || undefined, selected: [...selectedAssets] }) }); if (!r.ok) throw new Error((await r.json()).error); return r.blob(); }
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-export]')) b.onclick = safe(async () => { const format = b.dataset.export!; download(await exported(format), `${session.asset?.name ?? 'assets'}.${['png', 'gif'].includes(format) ? format : 'zip'}`); });
async function zipEntry(blob: Blob, wanted: string): Promise<Blob> { const bytes = new Uint8Array(await blob.arrayBuffer()), v = new DataView(bytes.buffer); let at = 0; while (at + 30 <= bytes.length && v.getUint32(at, true) === 0x04034b50) { const length = v.getUint32(at + 18, true), nl = v.getUint16(at + 26, true), el = v.getUint16(at + 28, true), start = at + 30 + nl + el, name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nl)); if (name === wanted) return new Blob([bytes.slice(start, start + length)], { type: 'image/png' }); at = start + length; } throw new Error('ZIP không chứa ' + wanted); }
bind('atlas-preview', async () => { const blob = await exported('atlas'); if (atlas) URL.revokeObjectURL(atlas.objectUrl); const objectUrl = URL.createObjectURL(await zipEntry(blob, 'image.png')); atlas = { blob, objectUrl, revision: session.doc!.revision }; $<HTMLImageElement>('atlas-image').src = objectUrl; $('atlas-info').textContent = `Atlas · revision ${atlas.revision} · tải PNG/JSON từ chính bản này`; show('atlas-dialog'); });
bind('atlas-download', () => { if (atlas) download(atlas.blob, `atlas-r${atlas.revision}.zip`); });

setInterval(() => {
  const samples = [...painter.latencies].sort((a, b) => a - b);
  if (samples.length) $('performance').textContent = `Nét vẽ p95 ${samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))].toFixed(1)} ms`;
}, 1000);

const events = new EventSource('/api/studio/events');
events.onmessage = e => {
  try {
    const event = JSON.parse(e.data);
    if (event.projectId !== session.doc?.id) return;
    if (['pixel-external', 'pixel-saved'].includes(event.type) && expectedWrites.has(`${event.projectId}:${event.revision}`)) return;
    if (['pixel-external', 'pixel-saved'].includes(event.type) && event.revision > session.doc!.revision && !(session.saving && event.revision === session.doc!.revision + 1)) {
      if (session.dirty || session.saving || painter.hasGesture || painter.floating || terrainEditor.hasGesture || mapEditor.hasGesture || engineDialog.open) {
        session.conflict = true;
        $('save-status').textContent = 'Xung đột · bản nháp được giữ';
        error('Dự án đã thay đổi ở tab khác/ngoài app. Lưu bản sao hoặc Tải lại.');
        engine.refresh(); terrainEditor.gate(); mapEditor.gate();
      } else void openProject(event.projectId).catch(error);
    }
    if (event.type === 'pixel-error') {
      session.conflict = true;
      engine.refresh(); terrainEditor.gate(); mapEditor.gate();
      error(event.message);
    }
  } catch (err) {
    error(err);
  }
};
events.onerror = () => $('save-status').textContent = 'Đang nối lại máy chủ…';
window.addEventListener('beforeunload', e => { if (session.dirty || session.saving || painter.floating || terrainEditor.hasGesture || mapEditor.hasGesture || engineClose.disabled) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', () => painter.draw());
(window as any).pxlDiagnostics = () => ({ visibility: document.visibilityState, focused: document.hasFocus(), samples: [...painter.latencies], width: session.asset?.w, height: session.asset?.h, layers: session.asset?.layers.length, frames: session.asset?.frames.length, ready: painter.ready, pendingFrame: (painter as any).raf, pendingLoads: (session as any).loading.size, rect: $('canvas').getBoundingClientRect().toJSON() });
void (async () => { await listProjects(); const last = localStorage.getItem('pxl.pixel.last'); if (last && projectList.some(p => p.id === last)) await openProject(last); else { $('ai-open').setAttribute('disabled', ''); $('ai-workspace-open').setAttribute('disabled', ''); render(); } if (new URLSearchParams(location.search).get('workbench') === 'art-review' || location.hash === '#art-review') artReview.open(); })().catch(error);
