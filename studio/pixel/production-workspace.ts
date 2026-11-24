import './production.css';
import { applyLibraryVersion, getAssetLibraryInfo } from '../../src/studio/asset-library.ts';
import { type PixelAsset, uid } from '../../src/studio/pixel/model.ts';
import { emptyProduction, productionKind, productionKinds, productionLimits, productionProfile, sameStamp, sceneSourceIssues,
  type Production, type ProductionAsset, type ProductionKind, type ProductionCatalog, type ScenePlacement } from '../../src/studio/production.ts';
import { renderSceneFrame, sceneFrameIndices, type ScenePreview } from '../../src/studio/scene-preview.ts';
import { api, type Session } from './session.ts';

type Tab = 'library' | 'style' | 'scene';
const labels: Record<ProductionKind, string> = { character: 'Nhân vật', prop: 'Đạo cụ', item: 'Vật phẩm', tileset: 'Tileset', animation: 'Animation', ui: 'Giao diện', vfx: 'Hiệu ứng' };
const statuses = { draft: 'Bản chỉnh sửa', approved: 'Đã duyệt', stale: 'Nội dung đã đổi' };
const perPage = 12;
const options = (entries: [string, string][], label: string) => [new Option(label, ''), ...entries.map(([id, name]) => new Option(name, id))];
interface WorkspaceOptions { session: Session; prepare(): Promise<void>; openAsset(id: string): Promise<void>; openMap(id?: string): Promise<void> }

export class ProductionWorkspace {
  readonly dialog = document.createElement('dialog');
  private readonly config: WorkspaceOptions;
  private tab: Tab = 'library';
  private catalog?: ProductionCatalog;
  private assetId = '';
  private page = 0;
  private busy = false;
  private preview?: ScenePreview;
  private animation = 0;
  private alive = 0;
  private get session() { return this.config.session; }
  private get doc() { return this.session.doc!; }
  private get data() { return this.doc.studio?.production ?? emptyProduction(); }
  private get asset() { return this.doc.assets.find(a => a.id === this.assetId); }
  private get collection() { return this.data.collections.find(c => c.id === this.value('collection')); }
  private get profile() { return this.data.profiles.find(p => p.id === this.value('profile')); }
  private get scene() { return this.data.scenes.find(s => s.id === this.value('scene-id')); }
  private get placement() { return this.scene?.placements.find(p => p.id === this.value('placement')); }
  private get play() { return this.el<HTMLButtonElement>('play'); }

  constructor(config: WorkspaceOptions) {
    this.config = config;
    this.dialog.id = 'production-workspace';
    this.dialog.className = 'large-workspace';
    this.dialog.setAttribute('aria-labelledby', 'prod-title');
    this.dialog.innerHTML = `
      <div class="workspace-header"><h2 id="prod-title">Production Workspace</h2><button id="prod-close" type="button">Về Pixel Editor</button></div>
      <div class="workspace-modes" aria-label="Khu vực sản xuất">
        <button id="prod-tab-library" class="mode-tab" type="button">Thư viện</button>
        <button id="prod-tab-style" class="mode-tab" type="button">Phong cách</button>
        <button id="prod-tab-scene" class="mode-tab" type="button">Cảnh game</button>
        <button id="prod-undo" type="button">Hoàn tác</button><button id="prod-redo" type="button">Làm lại</button>
      </div>
      <div class="prod-context">
        <label>Collection<select id="prod-collection"></select></label>
        <button id="prod-export" type="button">Xuất gói collection</button>
        <label><input id="prod-include-scene" type="checkbox"> Kèm cảnh đã chọn</label>
        <p id="prod-status" role="status"></p>
        <p id="prod-error" role="alert" hidden></p>
        <small>ZIP tối đa ${productionLimits.packageAssets} asset và 8 triệu pixel frame</small>
      </div>
      <div id="prod-panel-library" class="prod-panel">
        <div class="prod-side">
          <label>Tìm asset<input id="prod-search" type="search" autocomplete="off"></label>
          <label><input id="prod-members-only" type="checkbox"> Chỉ hiện thành viên collection</label>
          <div class="prod-fields"><label>Loại<select id="prod-kind-filter"></select></label><label>Nhóm phiên bản<select id="prod-group-filter"></select></label></div>
          <div id="prod-asset-list" class="prod-asset-list" aria-label="Danh sách asset"></div>
          <div class="row"><button id="prod-prev" type="button">Trang trước</button><span id="prod-page" class="hint"></span><button id="prod-next" type="button">Trang sau</button></div>
        </div>
        <div class="prod-content">
          <section>
            <h3 id="prod-asset-name">Asset</h3><p id="prod-asset-info"></p><p id="prod-asset-refs" class="hint"></p>
            <div class="prod-fields"><label>Phân loại<select id="prod-kind"></select></label><label>Profile của asset<select id="prod-asset-profile"></select></label></div>
            <div class="row wrap"><button id="prod-save-asset" type="button">Lưu phân loại và profile</button><button id="prod-approve" type="button">Duyệt nội dung hiện tại</button><button id="prod-inspect" type="button">Kiểm style kỹ thuật</button></div>
            <div class="row wrap"><button id="prod-open-asset" type="button">Mở trong Pixel Editor</button><button id="prod-version" type="button">Tạo phiên bản từ asset</button><button id="prod-membership" type="button">Thêm vào collection</button></div>
          </section>
          <section>
            <h3>Quản lý collection</h3>
            <label>Tên collection mới<input id="prod-collection-name" maxlength="100"></label>
            <div class="row wrap"><button id="prod-add-collection" type="button">Tạo collection</button><button id="prod-remove-collection" type="button">Xóa collection</button></div>
            <label>Profile mặc định của collection<select id="prod-collection-profile"></select></label>
            <button id="prod-save-collection" type="button">Lưu profile collection</button>
          </section>
        </div>
      </div>
      <div id="prod-panel-style" class="prod-panel" hidden>
        <div class="prod-side">
          <label>Style Profile<select id="prod-profile"></select></label>
          <p id="prod-project-colors"></p>
          <button id="prod-project-palette" type="button">Dùng palette asset làm palette dự án</button>
          <p class="hint">Kiểm định kỹ thuật gồm palette RGBA đã khóa và tình trạng duyệt reference. Góc nhìn, tỷ lệ pixel, hướng sáng và outline là quy ước mỹ thuật lưu trong profile.</p>
        </div>
        <div class="prod-content">
          <section>
            <label>Tên profile<input id="prod-profile-name" maxlength="100"></label>
            <div class="prod-fields"><label>Góc nhìn<input id="prod-view" maxlength="100" value="3/4"></label><label>Pixel scale<input id="prod-scale" type="number" min="1" max="16" value="1"></label></div>
            <div class="prod-fields"><label>Hướng sáng<input id="prod-light" maxlength="50" value="upper-left"></label><label>Outline<input id="prod-outline" maxlength="50" value="dark"></label></div>
            <label>Nguồn palette<select id="prod-palette"><option value="existing">Giữ palette profile</option><option value="project">Palette dự án</option><option value="asset">Palette asset đã chọn</option></select></label>
            <label><input id="prod-lock-palette" type="checkbox"> Kiểm màu ngoài palette</label>
            <label>Reference (chọn tối đa 3 bản đã duyệt)<select id="prod-references" multiple size="4"></select></label>
            <div class="row wrap"><button id="prod-save-profile" class="primary" type="button">Lưu profile</button><button id="prod-remove-profile" type="button">Xóa profile</button></div>
          </section>
        </div>
      </div>
      <div id="prod-panel-scene" class="prod-panel" hidden>
        <div class="prod-side">
          <label>Cảnh đã lưu<select id="prod-scene-id"></select></label>
          <div class="prod-fields"><label>Tên cảnh mới<input id="prod-scene-name" maxlength="100"></label><label>Bản đồ<select id="prod-map"></select></label></div>
          <div class="row wrap"><button id="prod-create-scene" type="button">Tạo cảnh</button><button id="prod-delete-scene" type="button">Xóa cảnh</button></div>
          <div class="row wrap"><button id="prod-open-map" type="button">Mở Tilemap</button><button id="prod-refresh-map" type="button">Xác nhận bản đồ hiện tại</button></div>
          <label>Bố trí từ dưới lên<select id="prod-placement"></select></label>
          <label>Asset đã duyệt<select id="prod-sprite"></select></label>
          <label>Animation<select id="prod-tag"></select></label>
          <div class="prod-fields"><label>X pivot<input type="number" id="prod-x" value="0" min="-4096" max="8192"></label><label>Y pivot<input type="number" id="prod-y" value="0" min="-4096" max="8192"></label></div>
          <div class="row wrap"><button id="prod-save-placement" class="primary" type="button">Lưu bố trí</button><button id="prod-remove-placement" type="button">Gỡ sprite</button></div>
          <div class="row wrap"><button id="prod-lower" type="button">Xuống lớp</button><button id="prod-raise" type="button">Lên lớp</button><button id="prod-open-sprite" type="button">Chỉnh sprite nguồn</button></div>
        </div>
        <div class="prod-content">
          <div class="prod-view-controls">
            <button id="prod-render" type="button">Xem cảnh đã lưu</button><button id="prod-play" type="button">Phát animation</button>
            <label>Zoom<select id="prod-zoom"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
            <label>Nền<select id="prod-background"><option value="checker">Trong suốt</option><option value="light">Sáng</option><option value="dark">Tối</option></select></label>
            <label><input id="prod-grid" type="checkbox"> Lưới</label><label><input id="prod-pivot" type="checkbox"> Pivot</label>
          </div>
          <p id="prod-scene-info" class="hint"></p>
          <ul id="prod-scene-issues" hidden></ul>
          <div id="prod-stage" data-background="checker"><canvas id="prod-canvas" aria-label="Cảnh game ở lưới pixel gốc" hidden></canvas></div>
        </div>
      </div>`;
    document.body.append(this.dialog);
    this.bind();
  }

  private el<T extends HTMLElement = HTMLElement>(name: string): T { return this.dialog.querySelector<T>(`#prod-${name}`)!; }
  private value(name: string): string { return this.el<HTMLInputElement>(name).value; }
  private field(name: string, value: string | number): void { this.el<HTMLInputElement>(name).value = String(value); }
  private checked(name: string): boolean { return this.el<HTMLInputElement>(name).checked; }
  private select(name: string, entries: [string, string][], blank: string, keep = this.value(name)): void {
    const select = this.el<HTMLSelectElement>(name);
    select.replaceChildren(...options(entries, blank));
    if (entries.some(([id]) => id === keep)) select.value = keep;
  }
  private path(operation: string, fields: Record<string, string> = {}): string {
    return `${this.session.path}/production?${new URLSearchParams({ operation, ...(operation !== 'thumbnail' && { revision: String(this.doc.revision) }), ...fields })}`;
  }
  private message(value: string): void { this.el('status').textContent = value; }
  private async refresh(): Promise<void> {
    const project = this.doc.id, revision = this.doc.revision;
    const catalog: ProductionCatalog = await api(this.path('catalog'));
    if (this.doc.id !== project || this.doc.revision !== revision || catalog.revision !== revision) throw Error('Dự án vừa đổi. Mở lại workspace.');
    this.catalog = catalog;
  }

  open(): void {
    if (!this.session.doc || this.dialog.open) return;
    this.assetId = this.session.assetId;
    this.catalog = undefined; this.page = 0;
    this.el('asset-list').textContent = 'Đang tải asset…';
    for (const name of ['collection', 'profile', 'scene-id', 'placement', 'search', 'kind-filter', 'group-filter']) this.field(name, '');
    this.dialog.showModal();
    this.showTab('library');
    this.message('Đang tải thư viện…');
    void this.run(async () => {
      try { await this.config.prepare(); await this.refresh(); this.render(); this.message('Sẵn sàng'); }
      catch (error) { this.message('Tải thư viện thất bại'); this.el('asset-list').textContent = 'Đóng và mở lại workspace để thử tải lại.'; throw error; }
    });
  }

  private async run(action: () => unknown | Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.dialog.setAttribute('aria-busy', 'true');
    this.el('error').hidden = true;
    try { await action(); } catch (error) { this.el('error').textContent = (error as Error).message; this.el('error').hidden = false; }
    finally { this.busy = false; this.dialog.setAttribute('aria-busy', 'false'); }
  }

  private bind(): void {
    const click = (name: string, action: () => unknown | Promise<unknown>) => { this.el(name).onclick = () => void this.run(action); };
    const change = (name: string, action: () => void) => { this.el(name).onchange = () => { if (!this.busy) action(); }; };
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.dialog.onclose = () => this.resetPreview();
    click('close', () => this.dialog.close());
    for (const tab of ['library', 'style', 'scene'] as const) click(`tab-${tab}`, () => this.showTab(tab));
    click('undo', () => this.undo(false)); click('redo', () => this.undo(true));
    click('prev', () => { this.page--; this.renderList(); }); click('next', () => { this.page++; this.renderList(); });
    this.el('search').oninput = () => { this.page = 0; this.renderList(); };
    for (const name of ['kind-filter', 'group-filter', 'members-only']) change(name, () => { this.page = 0; this.renderList(); });
    change('collection', () => { this.page = 0; this.renderLibrary(); });
    click('save-asset', () => this.edit('Lưu thông tin asset', data => {
      const row = this.row(data);
      row.kind = this.value('kind') as ProductionKind; row.profileId = this.value('asset-profile') || null;
    }));
    click('approve', async () => {
      await this.config.prepare(); await this.refresh();
      const stamp = this.catalog?.assets[this.assetId]?.stamp;
      if (!stamp) throw Error('Chọn asset trước khi duyệt.');
      await this.edit('Duyệt asset sản xuất', data => { this.row(data).approved = stamp; });
    });
    click('open-asset', () => this.openAsset(this.assetId));
    click('inspect', () => this.inspect());
    click('version', () => this.newVersion());
    click('add-collection', async () => {
      const id = uid();
      await this.edit('Tạo collection', data => { data.collections.push({ id, name: this.value('collection-name'), assets: [], profileId: null }); });
      this.field('collection', id); this.field('collection-name', ''); this.renderLibrary();
    });
    click('remove-collection', () => this.edit('Xóa collection', data => { data.collections = data.collections.filter(c => c.id !== this.collection?.id); }));
    click('save-collection', () => this.edit('Gán profile collection', data => {
      const row = data.collections.find(c => c.id === this.collection?.id);
      if (row) row.profileId = this.value('collection-profile') || null;
    }));
    click('membership', () => this.edit('Sửa thành viên collection', data => {
      const row = data.collections.find(c => c.id === this.collection?.id);
      if (!row || !this.asset) return;
      row.assets = row.assets.includes(this.assetId) ? row.assets.filter(id => id !== this.assetId) : [...row.assets, this.assetId];
    }));
    change('profile', () => this.fillProfile());
    click('project-palette', () => this.edit('Đặt palette dự án', () => {
      if (!this.asset?.palette.length) throw Error('Asset đang chọn chưa có palette.');
      this.doc.studio!.artDirection = { ...this.doc.studio!.artDirection, paletteMode: 'asset', palette: this.asset.palette.slice() };
    }));
    click('save-profile', () => this.saveProfile());
    click('remove-profile', () => this.edit('Xóa profile', data => { data.profiles = data.profiles.filter(p => p.id !== this.profile?.id); }));
    change('scene-id', () => { this.resetPreview(); this.renderScene(); });
    change('placement', () => this.fillPlacement());
    change('sprite', () => this.fillTags());
    click('create-scene', () => this.createScene());
    click('delete-scene', () => this.edit('Xóa cảnh', data => { data.scenes = data.scenes.filter(s => s.id !== this.scene?.id); }));
    click('refresh-map', async () => {
      await this.config.prepare(); await this.refresh();
      const stamp = this.scene && this.catalog?.maps[this.scene.mapId];
      if (!stamp) throw Error('Bản đồ không tồn tại.');
      await this.edit('Xác nhận bản đồ trong cảnh', () => { this.scene!.mapSha256 = stamp; });
    });
    click('open-map', async () => { const id = this.scene?.mapId ?? (this.value('map') || undefined); this.dialog.close(); await this.config.openMap(id); });
    click('save-placement', () => this.place());
    click('remove-placement', () => this.edit('Gỡ sprite khỏi cảnh', () => {
      if (this.scene && this.placement) this.scene.placements = this.scene.placements.filter(p => p.id !== this.placement?.id);
    }));
    click('lower', () => this.reorder(-1)); click('raise', () => this.reorder(1));
    click('open-sprite', () => this.openAsset(this.value('sprite')));
    click('render', () => this.readScene());
    click('play', () => this.animation ? this.stop() : this.start());
    for (const name of ['zoom', 'grid', 'pivot', 'background']) change(name, () => this.paint());
    this.el<HTMLCanvasElement>('canvas').onclick = (event) => {
      const r = this.el('canvas').getBoundingClientRect();
      this.field('x', Math.floor((event.clientX - r.left) / Number(this.value('zoom'))));
      this.field('y', Math.floor((event.clientY - r.top) / Number(this.value('zoom'))));
    };
    click('export', () => this.export());
  }

  private showTab(tab: Tab): void {
    this.tab = tab;
    if (tab !== 'scene') this.stop();
    for (const name of ['library', 'style', 'scene'] as const) {
      this.el(`panel-${name}`).hidden = name !== tab;
      this.el(`tab-${name}`).classList.toggle('active', name === tab);
      this.el(`tab-${name}`).setAttribute('aria-pressed', String(name === tab));
    }
    this.render();
  }

  private render(): void {
    this.select('collection', this.data.collections.map(c => [c.id, c.name]), 'Tất cả asset');
    this.renderLibrary();
    if (this.tab === 'style') this.renderStyle();
    if (this.tab === 'scene') this.renderScene();
  }

  private renderLibrary(): void {
    this.el<HTMLButtonElement>('export').disabled = !this.collection;
    this.el<HTMLInputElement>('members-only').disabled = !this.collection;
    this.el<HTMLInputElement>('include-scene').disabled = !this.data.scenes.length;
    const entries = this.data.profiles.map(p => [p.id, p.name] as [string, string]);
    this.select('kind-filter', productionKinds.map(k => [k, labels[k]]), 'Tất cả loại');
    const groups = new Map<string, string>();
    for (const asset of this.doc.assets) {
      const id = getAssetLibraryInfo(this.doc, asset.id).groupId;
      if (!groups.has(id)) groups.set(id, asset.name);
    }
    this.select('group-filter', [...groups.entries()], 'Tất cả nhóm');
    this.select('collection-profile', entries, 'Không chọn', this.collection?.profileId ?? '');
    for (const name of ['save-collection', 'remove-collection', 'membership']) this.el<HTMLButtonElement>(name).disabled = !this.collection;
    this.renderList();
    const a = this.asset, row = this.data.assets.find(entry => entry.assetId === a?.id);
    this.el('asset-name').textContent = a?.name ?? 'Chọn asset';
    for (const name of ['save-asset', 'approve', 'inspect', 'open-asset', 'version']) this.el<HTMLButtonElement>(name).disabled = !a;
    if (!a) { this.el('asset-info').textContent = ''; this.el('asset-refs').textContent = ''; return; }
    const lib = getAssetLibraryInfo(this.doc, a.id), state = this.catalog?.assets[a.id]?.status ?? 'draft';
    const prof = productionProfile(this.doc, a.id, this.collection?.id);
    this.el('asset-info').textContent = `v${lib.version} · ${a.w}×${a.h} · ${a.frames.length} frame · ${statuses[state]}${prof ? ` · ${prof.name}` : ''}`;
    const scenes = this.data.scenes.filter(s => s.placements.some(p => p.assetId === a.id)).map(s => s.name);
    const sets = Object.values(this.doc.studio?.tilesets ?? {}).filter(t => t.assetId === a.id);
    const characters = new Set(Object.values(this.doc.studio?.characters ?? {}).filter(profile => profile.source.assetId === a.id).map(profile => profile.id));
    const clips = Object.values(this.doc.studio?.clips ?? {}).filter(clip => characters.has(clip.characterId)).map(clip => clip.name);
    const usedBy = [...scenes, ...clips, ...Object.values(this.doc.studio?.mapIndex ?? {}).filter(m => m.layers.some(l => sets.some(t => t.id === l.tilesetId))).map(m => m.name)];
    this.el('asset-refs').textContent = [usedBy.length ? `Đang dùng trong ${usedBy.join(', ')}` : '', a.tags.length ? `Tags: ${a.tags.map(t => t.name).join(', ')}` : '',
      a.metadata.pivot && `Pivot ${a.metadata.pivot.x},${a.metadata.pivot.y}`, a.metadata.hitbox && 'Có hitbox'].filter(Boolean).join(' · ');
    this.select('kind', productionKinds.map(k => [k, labels[k]]), 'Chọn loại', productionKind(this.doc, a.id));
    this.select('asset-profile', entries, 'Kế thừa collection', row?.profileId ?? '');
    this.el('membership').textContent = this.collection?.assets.includes(a.id) ? 'Gỡ khỏi collection' : 'Thêm vào collection';
  }

  private renderList(): void {
    const list = this.el('asset-list'), query = this.value('search').trim().toLocaleLowerCase();
    const group = this.value('group-filter'), kind = this.value('kind-filter'), collection = this.collection;
    const members = collection && this.checked('members-only') ? new Set(collection.assets) : null;
    const families = new Map<string, PixelAsset[]>();
    for (const a of this.doc.assets) {
      if ((members && !members.has(a.id)) || (kind && productionKind(this.doc, a.id) !== kind) || (query && !a.name.toLocaleLowerCase().includes(query))) continue;
      const id = getAssetLibraryInfo(this.doc, a.id).groupId;
      if (group && group !== id) continue;
      if (!families.has(id)) families.set(id, []);
      families.get(id)!.push(a);
    }
    const found = [...families.values()].flat(), sections = new Map<string, HTMLElement>();
    const pages = Math.max(1, Math.ceil(found.length / perPage));
    this.page = Math.min(Math.max(0, this.page), pages - 1);
    this.el('page').textContent = `${this.page + 1}/${pages} · ${found.length} asset`;
    this.el<HTMLButtonElement>('prev').disabled = this.page === 0;
    this.el<HTMLButtonElement>('next').disabled = this.page + 1 >= pages;
    list.replaceChildren();
    for (const asset of found.slice(this.page * perPage, (this.page + 1) * perPage)) {
      const item = document.createElement('button'), title = document.createElement('span'), state = document.createElement('small'), img = document.createElement('img');
      item.className = 'prod-asset'; item.type = 'button'; item.dataset.assetId = asset.id;
      item.setAttribute('aria-pressed', String(asset.id === this.assetId));
      const lib = getAssetLibraryInfo(this.doc, asset.id);
      item.title = asset.name;
      title.textContent = `${asset.name} · v${lib.version}`;
      const entry = this.catalog?.assets[asset.id];
      state.textContent = `${labels[productionKind(this.doc, asset.id)]} · ${statuses[entry?.status ?? 'draft']}${entry?.used ? ' · Trong cảnh' : ''}`;
      img.alt = ''; img.width = 40; img.height = 40; img.loading = 'lazy'; img.decoding = 'async';
      if (entry) img.src = '/api/pixel/' + this.path('thumbnail', { assetId: asset.id, sha256: entry.stamp.sha256 });
      title.append(state);
      item.append(img, title); item.onclick = () => { if (!this.busy) { this.assetId = asset.id; this.renderLibrary(); this.el<HTMLButtonElement>('open-asset').focus(); } };
      if (families.get(lib.groupId)!.length === 1) { list.append(item); continue; }
      if (!sections.has(lib.groupId)) {
        const family = document.createElement('div'), heading = document.createElement('p');
        family.className = 'prod-family'; heading.className = 'hint';
        heading.textContent = `${families.get(lib.groupId)![0].name} · ${families.get(lib.groupId)!.length} phiên bản`;
        family.append(heading); sections.set(lib.groupId, family); list.append(family);
      }
      sections.get(lib.groupId)!.append(item);
    }
    if (!found.length) list.textContent = 'Không có asset phù hợp.';
  }

  private renderStyle(): void {
    this.select('profile', this.data.profiles.map(p => [p.id, p.name]), 'Profile mới');
    this.el('project-colors').textContent = `Palette dự án · ${this.doc.studio?.artDirection?.palette?.length ?? 0} màu`;
    this.fillProfile();
  }

  private fillProfile(): void {
    const profile = this.profile, refs = profile?.direction.references ?? [];
    this.field('profile-name', profile?.name ?? ''); this.field('view', profile?.view ?? '3/4');
    this.field('scale', profile?.pixelScale ?? 1); this.field('light', profile?.direction.light ?? 'upper-left');
    this.field('outline', profile?.direction.outline ?? 'dark'); this.field('palette', profile ? 'existing' : 'project');
    this.el<HTMLInputElement>('lock-palette').checked = profile?.lockPalette ?? false;
    this.el<HTMLSelectElement>('references').replaceChildren(...this.doc.assets.map(a => {
      const status = this.catalog?.assets[a.id]?.status ?? 'draft', selected = refs.some(ref => ref.assetId === a.id);
      const option = new Option(`${a.name} · ${statuses[status]}`, a.id, false, selected);
      option.disabled = status !== 'approved' && !selected;
      return option;
    }));
    this.el<HTMLButtonElement>('remove-profile').disabled = !profile;
  }

  private async saveProfile(): Promise<void> {
    const existing = this.profile, id = existing?.id ?? uid(), mode = this.value('palette');
    const palette = mode === 'project' ? this.doc.studio?.artDirection?.palette : mode === 'asset' ? this.asset?.palette : existing?.direction.palette;
    if (mode !== 'existing' && !palette?.length) throw Error('Nguồn đã chọn chưa có palette.');
    const references = [...this.el<HTMLSelectElement>('references').selectedOptions].map(option => {
      const a = this.doc.assets.find(asset => asset.id === option.value)!;
      if (this.catalog?.assets[a.id]?.status !== 'approved') throw Error('Reference đã đổi hoặc chưa được duyệt.');
      return existing?.direction.references?.find(r => r.assetId === a.id) ?? { assetId: a.id, frameId: a.frames[0].id };
    });
    await this.edit('Lưu Style Profile', data => {
      const profile = { id, name: this.value('profile-name'), view: this.value('view'), pixelScale: Number(this.value('scale')), lockPalette: this.checked('lock-palette'),
        direction: { ...existing?.direction, ...(palette && { palette: palette.slice() }), light: this.value('light'), outline: this.value('outline'), references } };
      data.profiles = [...data.profiles.filter(p => p.id !== id), profile];
    });
    this.field('profile', id); this.fillProfile();
  }

  private renderScene(): void {
    this.select('scene-id', this.data.scenes.map(s => [s.id, s.name]), 'Chọn cảnh');
    this.select('map', Object.values(this.doc.studio?.mapIndex ?? {}).map(m => [m.id, m.name]), 'Chọn map');
    const scene = this.scene, stale = scene && scene.mapSha256 !== this.catalog?.maps[scene.mapId];
    this.select('placement', scene?.placements.map((p, index) => {
      const a = this.doc.assets.find(a => a.id === p.assetId);
      const state = this.catalog?.assets[p.assetId];
      return [p.id, `${index + 1}. ${a?.name} · v${p.stamp.version}${state?.status !== 'approved' || !sameStamp(state.stamp, p.stamp) ? ' · Cần chọn lại' : ''}`];
    }) ?? [], 'Bố trí mới');
    this.el('scene-info').textContent = scene
      ? `${scene.name} · ${scene.placements.length}/${productionLimits.scenePlacements} sprite · Map tối đa ${productionLimits.sceneSide}×${productionLimits.sceneSide} · 2 triệu pixel preview` : 'Tạo cảnh từ một bản đồ đã lưu.';
    const list = this.el('scene-issues');
    const issues = scene && this.catalog ? sceneSourceIssues(scene, this.catalog) : [];
    list.hidden = !issues.length; list.replaceChildren();
    for (const issue of issues) {
      const item = document.createElement('li');
      if (issue.kind === 'map') {
        item.textContent = `Bản đồ hoặc atlas đã đổi (${issue.expected.slice(0, 8)} → ${issue.current?.slice(0, 8) ?? 'thiếu'}). Mở Tilemap để kiểm tra rồi xác nhận bản đồ hiện tại.`;
      } else {
        const name = this.doc.assets.find(a => a.id === issue.assetId)?.name ?? issue.assetId;
        const group = getAssetLibraryInfo(this.doc, issue.assetId).groupId;
        const candidates = this.doc.assets.filter(a => this.catalog?.assets[a.id]?.status === 'approved' && getAssetLibraryInfo(this.doc, a.id).groupId === group);
        const candidateNames = candidates.map(a => `${a.name} v${this.catalog!.assets[a.id].stamp.version} · ${this.catalog!.assets[a.id].stamp.sha256.slice(0, 8)}`);
        item.textContent = `${name} v${issue.expected.version} đã đổi hoặc chưa được duyệt (${issue.expected.sha256.slice(0, 8)} → ${issue.current?.sha256.slice(0, 8) ?? 'thiếu'}). ${candidateNames.length ? `Bản có thể mở để đối chiếu trong Thư viện: ${candidateNames.join(', ')}. Chọn lại asset và lưu bố trí.` : 'Kiểm tra và duyệt nội dung trong Thư viện, rồi chọn lại asset và lưu bố trí.'}`;
      }
      list.append(item);
    }
    for (const name of ['delete-scene', 'refresh-map', 'save-placement']) this.el<HTMLButtonElement>(name).disabled = !scene;
    this.el<HTMLButtonElement>('render').disabled = !scene || !!stale;
    this.fillPlacement();
  }

  private fillPlacement(): void {
    const row = this.placement;
    this.select('sprite', this.doc.assets.filter(a => this.catalog?.assets[a.id]?.status === 'approved' || row?.assetId === a.id)
      .map(a => [a.id, `${a.name} · v${getAssetLibraryInfo(this.doc, a.id).version}`]), 'Chọn asset', row?.assetId ?? this.value('sprite'));
    this.field('x', row?.x ?? 0); this.field('y', row?.y ?? 0);
    this.fillTags(row?.tagId ?? '');
    for (const name of ['lower', 'raise', 'remove-placement']) this.el<HTMLButtonElement>(name).disabled = !row;
  }

  private fillTags(initial = ''): void {
    const asset = this.doc.assets.find(a => a.id === this.value('sprite'));
    this.select('tag', asset?.tags.map(t => [t.id, t.name]) ?? [], 'Frame đầu', initial);
  }

  private async createScene(): Promise<void> {
    await this.config.prepare(); await this.refresh();
    const mapId = this.value('map'), mapSha256 = this.catalog?.maps[mapId], id = uid();
    if (!mapSha256) throw Error('Chọn một map đã lưu.');
    await this.edit('Tạo cảnh game', data => data.scenes.push({ id, name: this.value('scene-name'), mapId, mapSha256, placements: [] }));
    this.field('scene-id', id); this.field('scene-name', ''); this.renderScene();
  }

  private async place(): Promise<void> {
    if (!this.scene) throw Error('Chọn cảnh trước.');
    await this.config.prepare(); await this.refresh();
    const assetId = this.value('sprite'), selected = this.catalog?.assets[assetId], old = this.placement;
    if (selected?.status !== 'approved') throw Error('Chỉ bố trí asset có nội dung đã duyệt.');
    const placement: ScenePlacement = { id: old?.id ?? uid(), assetId, tagId: this.value('tag') || null, stamp: selected.stamp,
      x: this.el<HTMLInputElement>('x').valueAsNumber, y: this.el<HTMLInputElement>('y').valueAsNumber };
    await this.edit('Lưu bố trí cảnh', () => {
      const scene = this.scene!;
      if (old) scene.placements = scene.placements.map(p => p.id === old.id ? placement : p);
      else scene.placements.push(placement);
    });
    this.field('placement', placement.id); this.fillPlacement();
  }

  private async reorder(offset: number): Promise<void> {
    const scene = this.scene, row = this.placement;
    if (!scene || !row) return;
    const index = scene.placements.indexOf(row), next = index + offset;
    if (next < 0 || next >= scene.placements.length) return;
    await this.edit('Đổi thứ tự sprite', () => { [scene.placements[index], scene.placements[next]] = [scene.placements[next], scene.placements[index]]; });
  }

  private row(data: Production): ProductionAsset {
    if (!this.asset) throw Error('Chọn asset trước.');
    let entry = data.assets.find(a => a.assetId === this.assetId);
    if (!entry) {
      entry = { assetId: this.assetId, kind: productionKind(this.doc, this.assetId), profileId: null, approved: null };
      data.assets.push(entry);
    }
    return entry;
  }

  private async edit(label: string, update: (data: Production) => unknown): Promise<void> {
    this.session.change(label, () => {
      this.doc.studio ??= { version: 1 };
      this.doc.studio.production ??= emptyProduction();
      update(this.doc.studio.production);
    });
    this.resetPreview();
    await this.session.flush();
    await this.refresh();
    this.render();
    this.message(label);
  }

  private async undo(redo: boolean): Promise<void> {
    await this.session.undo(redo);
    this.resetPreview(); await this.session.flush(); await this.refresh(); this.render();
  }

  private async newVersion(): Promise<void> {
    const asset = this.asset;
    if (!asset) throw Error('Chọn asset nguồn.');
    const previous = this.data.assets.find(entry => entry.assetId === asset.id);
    const copy: PixelAsset = { ...structuredClone(asset), id: uid() };
    await this.edit('Tạo phiên bản asset', data => {
      const library = getAssetLibraryInfo(this.doc, asset.id);
      const next = applyLibraryVersion(this.doc, copy, { versionOf: asset.id, kind: library.kind });
      this.doc.assets = next.assets;
      this.doc.studio = next.studio;
      if (previous) data.assets.push({ ...previous, assetId: copy.id, approved: null });
    });
    this.assetId = copy.id;
    this.field('collection', ''); this.field('search', ''); this.page = 0; this.renderLibrary();
  }

  private async openAsset(id: string): Promise<void> {
    if (id) { this.dialog.close(); await this.config.openAsset(id); }
  }

  private async inspect(): Promise<void> {
    if (!this.asset) return;
    await this.config.prepare();
    const result = await api(this.path('inspect', { assetId: this.assetId, ...(this.collection && { collectionId: this.collection.id }) }));
    this.message(result.profileId ? `${result.outside} pixel ngoài palette khóa · ${result.staleReferences.length} reference cần duyệt lại` : 'Asset chưa có Style Profile.');
  }

  private resetPreview(): void {
    this.stop(); this.preview = undefined; this.el('canvas').hidden = true;
  }

  resetProject(): void {
    this.catalog = undefined;
    this.resetPreview();
    if (this.dialog.open) this.dialog.close();
  }

  private async readScene(): Promise<void> {
    const scene = this.scene;
    if (!scene) throw Error('Chọn một cảnh.');
    this.resetPreview();
    await this.config.prepare();
    const project = this.doc.id, revision = this.doc.revision;
    const preview: ScenePreview = await api(this.path('scene', { sceneId: scene.id }));
    if (!this.dialog.open || this.doc.id !== project || this.doc.revision !== revision) return;
    this.preview = preview; this.alive = 0; this.paint();
    this.message(`Cảnh ${preview.width}×${preview.height} · ${preview.sprites.length} sprite · r${this.doc.revision}`);
  }

  private paint(indices?: number[]): void {
    const preview = this.preview;
    if (!preview) return;
    const size = Number(this.value('zoom')), cursor = renderSceneFrame(preview, indices ?? sceneFrameIndices(preview, this.alive));
    const canvas = this.el<HTMLCanvasElement>('canvas');
    if (canvas.width !== cursor.w || canvas.height !== cursor.h) { canvas.width = cursor.w; canvas.height = cursor.h; }
    canvas.style.width = `${cursor.w * size}px`; canvas.style.height = `${cursor.h * size}px`;
    this.el('stage').dataset.background = this.value('background');
    const ctx = canvas.getContext('2d')!, image = ctx.createImageData(cursor.w, cursor.h);
    cursor.data.forEach((ink, i) => {
      image.data[i * 4] = ink >>> 24; image.data[i * 4 + 1] = (ink >>> 16) & 255;
      image.data[i * 4 + 2] = (ink >>> 8) & 255; image.data[i * 4 + 3] = ink & 255;
    });
    ctx.putImageData(image, 0, 0);
    if (this.checked('grid')) {
      ctx.fillStyle = '#9babc575';
      for (let x = 0; x < cursor.w; x += preview.tileSize) ctx.fillRect(x, 0, 1, cursor.h);
      for (let y = 0; y < cursor.h; y += preview.tileSize) ctx.fillRect(0, y, cursor.w, 1);
    }
    if (this.checked('pivot')) {
      ctx.fillStyle = '#ffce64';
      for (const sprite of preview.sprites) { ctx.fillRect(sprite.x - 2, sprite.y, 5, 1); ctx.fillRect(sprite.x, sprite.y - 2, 1, 5); }
    }
    canvas.hidden = false;
  }

  private start(): void {
    const preview = this.preview;
    if (!preview?.tracks.some(t => t.frames.length > 1)) throw Error('Cảnh chưa có track animation để phát.');
    const start = performance.now();
    let previous = '';
    const tick = (time: number) => {
      this.alive = Math.max(0, time - start);
      const indices = sceneFrameIndices(preview, this.alive), key = indices.join(',');
      if (previous !== key) { previous = key; this.paint(indices); }
      this.animation = requestAnimationFrame(tick);
    };
    this.animation = requestAnimationFrame(tick); this.play.textContent = 'Dừng phát';
  }

  private stop(): void { cancelAnimationFrame(this.animation); this.animation = 0; this.play.textContent = 'Phát animation'; }

  private async export(): Promise<void> {
    if (!this.collection) throw Error('Chọn một collection.');
    await this.config.prepare();
    const sceneId = this.checked('include-scene') ? this.scene?.id : undefined;
    if (this.checked('include-scene') && !sceneId) throw Error('Chọn cảnh ở tab Cảnh game.');
    const response = await fetch('/api/pixel/' + this.path('package', { collectionId: this.collection.id, ...(sceneId && { sceneId }) }));
    if (!response.ok) throw Error((await response.json()).error ?? 'Không xuất được gói.');
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.download = 'production.zip'; link.href = url; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message(`Đã xuất gói · r${this.doc.revision}`);
  }
}
