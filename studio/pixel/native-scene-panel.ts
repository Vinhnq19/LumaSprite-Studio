import {
  effectiveNativeSceneState,
  fitsWalkable,
  type NativeSceneRecord,
} from '../../src/studio/native-scene.ts';
import {
  renderNativeScene,
  type NativeSceneBuffers,
  type NativeSceneRenderMode,
} from '../../src/studio/native-scene-render.ts';
import { emptyProduction, type Production } from '../../src/studio/production.ts';
import { api, type Session } from './session.ts';

interface PanelConfig {
  session: Session;
  prepare(): Promise<void>;
  run(action: () => unknown | Promise<unknown>): Promise<void>;
  edit(label: string, update: (data: Production) => unknown): Promise<void>;
  message(text: string): void;
  refresh(): Promise<void>;
}

const approvalLabels: Record<string, string> = {
  UNREVIEWED: 'Chưa duyệt (UNREVIEWED)',
  APPROVED: 'Đã duyệt (APPROVED)',
  STALE: 'Nguồn đã đổi (STALE)',
};

export class NativeScenePanel {
  readonly root: HTMLElement;
  private readonly cfg: PanelConfig;
  private sceneId = '';
  private selectedLayerId = '';
  private selectedInteractionId = '';
  private buffers?: NativeSceneBuffers;
  private bufferKey = '';
  private uploadedFiles: Record<string, string> | null = null;

  constructor(root: HTMLElement, cfg: PanelConfig) {
    this.root = root;
    this.cfg = cfg;
    this.root.innerHTML = `
      <div class="prod-side ns-side">
        <section class="ns-block">
          <h3>Nhập Scene từ Engine</h3>
          <label>Thư mục gói scene<input id="ns-source-dir" placeholder="Đường dẫn thư mục E8 hoặc E7.6R B2"></label>
          <div class="prod-fields">
            <label>Light<select id="ns-light"><option value="day">Day</option><option value="night">Night</option></select></label>
            <label>Expected Rev<input id="ns-expected-rev" placeholder="Tuỳ chọn"></label>
          </div>
          <label>Hoặc chọn thư mục<input id="ns-folder-input" type="file" webkitdirectory multiple></label>
          <div class="row wrap">
            <button id="ns-import-btn" class="primary" type="button">Import Native Scene</button>
          </div>
        </section>
        <section class="ns-block">
          <label>Native Scene đã nhập<select id="ns-scene-select"></select></label>
          <div id="ns-provenance" class="ns-meta-card">Chưa có native scene.</div>
          <ul id="ns-warnings" class="ns-warnings" hidden></ul>
        </section>
        <section class="ns-block">
          <h3>Layers &amp; Ordering</h3>
          <div id="ns-layers" class="ns-layer-list"></div>
          <p id="ns-layer-detail" class="hint"></p>
        </section>
        <section class="ns-block" id="ns-editor">
          <h3>Chỉnh sửa Studio (Revision-Safe)</h3>
          <p id="ns-protected-badge" class="ns-protected"></p>
          <div class="prod-fields">
            <label>Actor<select id="ns-actor-select"></select></label>
            <label>Style Profile<select id="ns-style-profile"></select></label>
          </div>
          <div class="prod-fields">
            <label>Actor X<input id="ns-actor-x" type="number" min="0" max="4096"></label>
            <label>Actor Y<input id="ns-actor-y" type="number" min="0" max="4096"></label>
          </div>
          <div class="row wrap">
            <button id="ns-actor-apply" type="button">Cập nhật Actor</button>
            <button id="ns-style-apply" type="button">Gán Profile</button>
          </div>
          <hr>
          <label>Interaction Anchor<select id="ns-interaction-select"></select></label>
          <div id="ns-interaction-meta" class="ns-meta-card"></div>
          <div class="prod-fields">
            <label>Label hiển thị<input id="ns-int-label" maxlength="120" placeholder="Ví dụ: Kiểm tra bến phà"></label>
            <label>Linked Object ID<input id="ns-int-linked" maxlength="80" placeholder="ID đối tượng liên kết"></label>
          </div>
          <div class="prod-fields">
            <label>Stand X<input id="ns-int-stand-x" type="number" min="0" max="4096"></label>
            <label>Stand Y<input id="ns-int-stand-y" type="number" min="0" max="4096"></label>
          </div>
          <label>Ghi chú tương tác<input id="ns-int-note" maxlength="200"></label>
          <div class="row wrap">
            <button id="ns-int-apply" type="button">Lưu Interaction</button>
            <button id="ns-revert-btn" type="button">Hoàn tác Overrides</button>
          </div>
          <hr>
          <label>Ghi chú duyệt (Human Review)<input id="ns-review-note" maxlength="300" placeholder="Chỉ người duyệt xác nhận"></label>
          <div class="row wrap">
            <button id="ns-approve-btn" type="button">Duyệt Scene</button>
            <button id="ns-unreview-btn" type="button">Đặt lại Unreviewed</button>
          </div>
          <div class="row wrap">
            <label><input id="ns-export-approved" type="checkbox"> Chỉ xuất khi đã duyệt</label>
            <button id="ns-export-btn" class="primary" type="button">Xuất Package ZIP</button>
          </div>
        </section>
      </div>
      <div class="prod-content ns-content">
        <div class="prod-view-controls">
          <label>Chế độ<select id="ns-view-mode">
            <option value="composite">Composite</option>
            <option value="ground">Tilemap Ground</option>
            <option value="foreground">Foreground Layers</option>
            <option value="atlas">Atlas Inspector</option>
          </select></label>
          <label>Zoom<select id="ns-zoom"><option value="1">1×</option><option value="2" selected>2×</option><option value="4">4×</option></select></label>
          <label>Nền<select id="ns-bg"><option value="checker">Trong suốt</option><option value="dark">Tối</option><option value="light">Sáng</option></select></label>
          <label><input id="ns-ov-grid" type="checkbox"> Tile Grid</label>
          <label><input id="ns-ov-collision" type="checkbox"> Collision</label>
          <label><input id="ns-ov-walkable" type="checkbox"> Walkable</label>
          <label><input id="ns-ov-actors" type="checkbox" checked> Actors &amp; Props</label>
          <label><input id="ns-ov-interactions" type="checkbox" checked> Interactions</label>
          <label><input id="ns-ov-occlusion" type="checkbox"> Foreground/Occlusion</label>
        </div>
        <p id="ns-hover-info" class="hint">Di chuột lên scene để đọc tọa độ, tile ID và trạng thái walkable/anchor.</p>
        <div id="ns-stage" class="ns-stage" data-background="checker">
          <div class="ns-canvas-stack">
            <canvas id="ns-canvas" aria-label="Native Scene Canvas (pixel-perfect)" hidden></canvas>
            <canvas id="ns-overlay-canvas" aria-hidden="true" hidden></canvas>
          </div>
        </div>
      </div>`;
    this.bind();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  private val(id: string): string { return this.el<HTMLInputElement>(id).value; }
  private setVal(id: string, value: string | number): void { this.el<HTMLInputElement>(id).value = String(value); }
  private isChecked(id: string): boolean { return this.el<HTMLInputElement>(id).checked; }
  private get doc() { return this.cfg.session.doc; }
  private get scenes(): NativeSceneRecord[] { return this.doc?.studio?.production?.nativeScenes ?? []; }
  private get scene(): NativeSceneRecord | undefined { return this.scenes.find(s => s.id === this.sceneId) ?? this.scenes[0]; }

  reset(): void {
    this.sceneId = '';
    this.selectedLayerId = '';
    this.selectedInteractionId = '';
    this.buffers = undefined;
    this.bufferKey = '';
    this.uploadedFiles = null;
  }

  private bind(): void {
    const click = (id: string, fn: () => unknown | Promise<unknown>) => { this.el(id).onclick = () => void this.cfg.run(fn); };
    this.el<HTMLInputElement>('ns-folder-input').onchange = async () => {
      const input = this.el<HTMLInputElement>('ns-folder-input');
      const files: Record<string, string> = {};
      for (const file of Array.from(input.files ?? [])) {
        if (!/\.(json|png)$/i.test(file.name)) continue;
        const rel = (file.webkitRelativePath || file.name).replace(/^[^/]+\//, '');
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
        files[rel] = btoa(bin);
      }
      this.uploadedFiles = Object.keys(files).length ? files : null;
      this.cfg.message(this.uploadedFiles ? `Đã nạp ${Object.keys(files).length} file sẵn sàng import.` : 'Không tìm thấy file JSON/PNG.');
    };

    click('ns-import-btn', () => this.importScene());
    this.el<HTMLSelectElement>('ns-scene-select').onchange = () => {
      this.sceneId = this.val('ns-scene-select');
      this.selectedLayerId = '';
      this.selectedInteractionId = '';
      this.render();
    };
    for (const id of ['ns-view-mode', 'ns-zoom', 'ns-bg', 'ns-ov-grid', 'ns-ov-collision', 'ns-ov-walkable', 'ns-ov-actors', 'ns-ov-interactions', 'ns-ov-occlusion']) {
      this.el(id).onchange = () => this.paint();
    }
    this.el<HTMLSelectElement>('ns-actor-select').onchange = () => this.fillActorFields();
    this.el<HTMLSelectElement>('ns-interaction-select').onchange = () => {
      this.selectedInteractionId = this.val('ns-interaction-select');
      this.fillInteractionFields();
      this.paint();
    };
    click('ns-actor-apply', () => this.applyActorEdit());
    click('ns-style-apply', () => this.applyStyleProfile());
    click('ns-int-apply', () => this.applyInteractionEdit());
    click('ns-revert-btn', () => this.revertOverrides());
    click('ns-approve-btn', () => this.submitReview('APPROVED'));
    click('ns-unreview-btn', () => this.submitReview('UNREVIEWED'));
    click('ns-export-btn', () => this.exportPackage());

    this.el<HTMLCanvasElement>('ns-overlay-canvas').onmousemove = (event) => this.handleHover(event);
  }

  private async importScene(): Promise<void> {
    if (!this.doc) return;
    await this.cfg.prepare();
    const sourceDir = this.val('ns-source-dir').trim();
    const light = this.val('ns-light') as 'day' | 'night';
    const expectedRevision = this.val('ns-expected-rev').trim() || undefined;
    const payload = sourceDir
      ? { revision: this.doc.revision, sourceDir, light, ...(expectedRevision && { expectedRevision }) }
      : this.uploadedFiles
        ? { revision: this.doc.revision, files: this.uploadedFiles, light, ...(expectedRevision && { expectedRevision }) }
        : null;
    if (!payload) throw Error('Nhập đường dẫn thư mục hoặc chọn thư mục scene trước.');
    this.cfg.session.saving = true;
    let result: any;
    try {
      result = await api(`${this.cfg.session.path}/native-scenes/import`, 'POST', payload);
      this.cfg.session.doc = result.document;
      this.cfg.session.dirty = false;
      this.cfg.session.onchange();
    } finally {
      this.cfg.session.saving = false;
    }
    this.sceneId = result.sceneId;
    this.buffers = undefined;
    await this.cfg.refresh();
    this.render();
    this.cfg.message(`Đã import scene ${result.sceneId} · r${result.document.revision}`);
  }

  private async ensureBuffers(record: NativeSceneRecord): Promise<void> {
    if (!this.doc) return;
    const key = `${this.doc.id}:${this.doc.revision}:${record.id}`;
    if (this.buffers && this.bufferKey === key) return;
    const data = await api(`${this.cfg.session.path}/native-scenes/${record.id}/render?revision=${this.doc.revision}`);
    if (this.doc.id && this.scene?.id === record.id) {
      this.buffers = data.buffers as NativeSceneBuffers;
      this.bufferKey = key;
      this.paint();
    }
  }

  render(): void {
    const scenes = this.scenes;
    const select = this.el<HTMLSelectElement>('ns-scene-select');
    select.replaceChildren(...(scenes.length ? scenes.map(s => new Option(`${s.name} (${s.studioState.approval.status})`, s.id)) : [new Option('Chưa có native scene', '')]));
    const current = this.scene;
    if (current) {
      this.sceneId = current.id;
      select.value = current.id;
    }

    const hasScene = !!current;
    for (const btnId of ['ns-actor-apply', 'ns-style-apply', 'ns-int-apply', 'ns-revert-btn', 'ns-approve-btn', 'ns-unreview-btn', 'ns-export-btn']) {
      this.el<HTMLButtonElement>(btnId).disabled = !hasScene;
    }

    if (!current) {
      this.el('ns-provenance').textContent = 'Nhập gói E8 runtime hoặc E7.6R B2 từ Engine để inspect, chỉnh sửa Studio metadata và xuất package.';
      this.el('ns-warnings').hidden = true;
      this.el('ns-layers').replaceChildren();
      this.el('ns-layer-detail').textContent = '';
      this.el('ns-interaction-meta').textContent = '';
      this.el('ns-protected-badge').textContent = '';
      this.el('ns-canvas').hidden = true;
      this.el('ns-overlay-canvas').hidden = true;
      return;
    }

    const snap = current.engineSnapshot;
    const st = current.studioState;
    const effective = effectiveNativeSceneState(current);

    this.el('ns-provenance').innerHTML = `
      <div><strong>${snap.sceneKey}</strong> (${snap.light}) · <code>${snap.packageFormat}</code></div>
      <div>Kích thước: ${snap.width}×${snap.height} · Origin [${snap.origin.join(', ')}] · PPU ${snap.pixelsPerUnit} · Tile ${snap.tilemap.tileSize}px (${snap.tilemap.cellCount} cells)</div>
      <div>Engine rev: <code title="${snap.sourceRevision}">${snap.sourceRevision.slice(0, 12)}</code> · Studio rev: <strong>s${st.revision}</strong> · Doc r${this.doc!.revision}</div>
      <div>Source SHA: <code title="${snap.provenance.sourceSha256}">${snap.provenance.sourceSha256.slice(0, 12)}</code> · Style: ${snap.styleRef?.file ?? 'n/a'}</div>
      <div>Trạng thái duyệt: <strong>${approvalLabels[st.approval.status] ?? st.approval.status}</strong>${st.approval.note ? ` · ${st.approval.note}` : ''}</div>`;

    this.el('ns-protected-badge').textContent = `Protected Engine Source SHA: ${current.protectedSha256.slice(0, 16)}… (không sửa trực tiếp dữ liệu Engine)`;

    const allWarnings = [...st.sourceWarnings, ...snap.provenance.contractGaps];
    const warnEl = this.el('ns-warnings');
    warnEl.hidden = allWarnings.length === 0;
    warnEl.replaceChildren(...allWarnings.map(w => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }));

    this.renderLayers(current, effective);

    const actors = Object.keys(snap.actors);
    const actorSelect = this.el<HTMLSelectElement>('ns-actor-select');
    const prevActor = actorSelect.value;
    actorSelect.replaceChildren(...actors.map(id => new Option(id, id)));
    if (actors.includes(prevActor)) actorSelect.value = prevActor;
    else if (actors.includes('surveyor')) actorSelect.value = 'surveyor';
    this.fillActorFields();

    const profiles = this.doc?.studio?.production?.profiles ?? [];
    const profSelect = this.el<HTMLSelectElement>('ns-style-profile');
    profSelect.replaceChildren(new Option('Chưa gán profile', ''), ...profiles.map(p => new Option(p.name, p.id)));
    profSelect.value = st.styleProfileId ?? '';

    const intSelect = this.el<HTMLSelectElement>('ns-interaction-select');
    intSelect.replaceChildren(...effective.interactions.map(it => new Option(`${it.kind} (${it.id})`, it.id)));
    if (!this.selectedInteractionId || !effective.interactions.some(it => it.id === this.selectedInteractionId)) {
      this.selectedInteractionId = effective.interactions[0]?.id ?? '';
    }
    intSelect.value = this.selectedInteractionId;
    this.fillInteractionFields();

    void this.ensureBuffers(current).then(() => this.paint());
  }

  private renderLayers(record: NativeSceneRecord, effective: ReturnType<typeof effectiveNativeSceneState>): void {
    const list = this.el('ns-layers');
    list.replaceChildren();
    const layersToList = record.engineSnapshot.packageFormat === 'e76r-b2'
      ? [{ id: 'foreground', kind: 'prop' as const, at: { x: 0, y: 0 }, pivot: { x: 0, y: 0 }, order: -1, visible: effective.foregroundVisible }, ...effective.layers]
      : effective.layers;

    if (!this.selectedLayerId && layersToList.length) this.selectedLayerId = layersToList[0].id;
    for (const layer of layersToList) {
      const row = document.createElement('div');
      row.className = 'ns-layer-row';
      row.dataset.layerId = layer.id;
      row.dataset.selected = String(layer.id === this.selectedLayerId);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = layer.visible;
      cb.setAttribute('aria-label', `Hiện layer ${layer.id}`);
      cb.onchange = () => void this.cfg.run(() => this.toggleLayerVisibility(record.id, layer.id, cb.checked));

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ns-layer-btn';
      btn.textContent = `#${layer.order} ${layer.id} · ${layer.kind} @ (${layer.at.x},${layer.at.y})`;
      btn.onclick = () => {
        this.selectedLayerId = layer.id;
        this.renderLayers(record, effectiveNativeSceneState(record));
        this.paint();
      };
      row.append(cb, btn);
      list.append(row);
    }

    const chosen = record.engineSnapshot.layers.find(l => l.id === this.selectedLayerId);
    this.el('ns-layer-detail').textContent = chosen
      ? `Layer ${chosen.id} (${chosen.kind}): at=(${chosen.at.x},${chosen.at.y}), pivot=(${chosen.pivot.x},${chosen.pivot.y}), order=${chosen.order}${chosen.visibleBefore !== undefined ? `, visible=${chosen.visible}/${chosen.visibleBefore}` : ''}${chosen.hiddenBy ? `, occludedBy=${Object.keys(chosen.hiddenBy).join(',')}` : ''}`
      : 'Chọn layer để xem chi tiết occlusion/pivot.';
  }

  private fillActorFields(): void {
    const current = this.scene;
    if (!current) return;
    const actorId = this.val('ns-actor-select') || 'surveyor';
    const eff = effectiveNativeSceneState(current);
    const pos = eff.actors[actorId] ?? current.engineSnapshot.spawn;
    this.setVal('ns-actor-x', pos.x);
    this.setVal('ns-actor-y', pos.y);
  }

  private fillInteractionFields(): void {
    const current = this.scene;
    if (!current) return;
    const eff = effectiveNativeSceneState(current);
    const item = eff.interactions.find(it => it.id === this.selectedInteractionId) ?? eff.interactions[0];
    if (!item) { this.el('ns-interaction-meta').textContent = 'Không có điểm tương tác.'; return; }
    this.el('ns-interaction-meta').innerHTML = `
      <div><strong>ID:</strong> <code>${item.id}</code> · <strong>Kind:</strong> ${item.kind}</div>
      <div><strong>At:</strong> (${item.at.x}, ${item.at.y}) · <strong>Stand:</strong> ${item.stand ? `(${item.stand.x}, ${item.stand.y})` : 'none'}</div>
      <div><strong>Linked:</strong> ${item.linkedEntityId ?? 'none'} · <strong>Label:</strong> ${item.label ?? '(Engine default)'}</div>
      <div><strong>Source Rev:</strong> <code>${item.sourceRevision.slice(0, 12)}</code></div>`;
    this.setVal('ns-int-label', item.label ?? '');
    this.setVal('ns-int-linked', item.linkedEntityId ?? '');
    this.setVal('ns-int-stand-x', item.stand?.x ?? 0);
    this.setVal('ns-int-stand-y', item.stand?.y ?? 0);
    this.setVal('ns-int-note', item.note ?? '');
  }

  private bumpRecord(record: NativeSceneRecord, summary: string): void {
    record.studioState.revision += 1;
    if (record.studioState.approval.status === 'APPROVED') record.studioState.approval.status = 'STALE';
    record.studioState.changeLog.push({ revision: record.studioState.revision, at: new Date().toISOString(), summary });
  }

  private async toggleLayerVisibility(sceneId: string, layerId: string, visible: boolean): Promise<void> {
    await this.cfg.edit(`Bật/tắt layer ${layerId}`, data => {
      const rec = data.nativeScenes?.find(s => s.id === sceneId);
      if (!rec) return;
      rec.studioState.layerVisibility[layerId] = visible;
      this.bumpRecord(rec, `Layer ${layerId} visible=${visible}`);
    });
  }

  private async applyActorEdit(): Promise<void> {
    const current = this.scene;
    if (!current) return;
    const actorId = this.val('ns-actor-select') || 'surveyor';
    const x = Number(this.val('ns-actor-x')), y = Number(this.val('ns-actor-y'));
    if (actorId === 'surveyor' && !fitsWalkable(current.engineSnapshot, { x, y })) {
      throw Error(`Vị trí (${x}, ${y}) không thỏa walkable/clearance của nhân vật.`);
    }
    await this.cfg.edit(`Chỉnh vị trí actor ${actorId}`, data => {
      const rec = data.nativeScenes?.find(s => s.id === current.id)!;
      rec.studioState.actorOverrides[actorId] = { x, y };
      this.bumpRecord(rec, `Move actor ${actorId} -> (${x},${y})`);
    });
  }

  private async applyStyleProfile(): Promise<void> {
    const current = this.scene;
    if (!current) return;
    const profileId = this.val('ns-style-profile') || null;
    await this.cfg.edit('Gán Style Profile cho scene', data => {
      const rec = data.nativeScenes?.find(s => s.id === current.id)!;
      rec.studioState.styleProfileId = profileId;
      this.bumpRecord(rec, `Set styleProfileId=${profileId ?? 'none'}`);
    });
  }

  private async applyInteractionEdit(): Promise<void> {
    const current = this.scene;
    if (!current || !this.selectedInteractionId) return;
    const stand = { x: Number(this.val('ns-int-stand-x')), y: Number(this.val('ns-int-stand-y')) };
    if (!fitsWalkable(current.engineSnapshot, stand)) {
      throw Error(`Điểm đứng (${stand.x}, ${stand.y}) nằm ngoài vùng đi được.`);
    }
    const label = this.val('ns-int-label').trim() || null;
    const linkedEntityId = this.val('ns-int-linked').trim() || null;
    const note = this.val('ns-int-note').trim() || null;
    await this.cfg.edit(`Cập nhật interaction ${this.selectedInteractionId}`, data => {
      const rec = data.nativeScenes?.find(s => s.id === current.id)!;
      rec.studioState.interactionOverrides[this.selectedInteractionId] = { label, linkedEntityId, stand, note };
      this.bumpRecord(rec, `Edit interaction ${this.selectedInteractionId}`);
    });
  }

  private async revertOverrides(): Promise<void> {
    const current = this.scene;
    if (!current) return;
    await this.cfg.edit(`Hoàn tác overrides scene ${current.name}`, data => {
      const rec = data.nativeScenes?.find(s => s.id === current.id)!;
      for (const k of Object.keys(rec.studioState.layerVisibility)) rec.studioState.layerVisibility[k] = true;
      rec.studioState.layerOrderOverrides = {};
      rec.studioState.actorOverrides = {};
      rec.studioState.propOverrides = {};
      rec.studioState.interactionOverrides = {};
      this.bumpRecord(rec, 'Revert all Studio overrides');
    });
  }

  private async submitReview(status: 'APPROVED' | 'UNREVIEWED'): Promise<void> {
    const current = this.scene;
    if (!current || !this.doc) return;
    await this.cfg.prepare();
    this.cfg.session.saving = true;
    try {
      const res = await api(`${this.cfg.session.path}/native-scenes/${current.id}/review`, 'POST', {
        revision: this.doc.revision,
        status,
        note: this.val('ns-review-note').trim(),
      });
      this.cfg.session.doc = res.document;
      this.cfg.session.dirty = false;
      this.cfg.session.onchange();
    } finally {
      this.cfg.session.saving = false;
    }
    await this.cfg.refresh();
    this.render();
    this.cfg.message(`Scene ${current.name}: ${status}`);
  }

  private async exportPackage(): Promise<void> {
    const current = this.scene;
    if (!current || !this.doc) return;
    await this.cfg.prepare();
    const res = await fetch(`/api/pixel/${this.cfg.session.path}/native-scenes/${current.id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: this.doc.revision, requireApproved: this.isChecked('ns-export-approved') }),
    });
    if (!res.ok) throw Error((await res.json()).error ?? 'Không xuất được package.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${current.id}-e84-export.zip`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.cfg.message(`Đã xuất ${current.id}-e84-export.zip`);
  }

  private paint(): void {
    const current = this.scene;
    const canvas = this.el<HTMLCanvasElement>('ns-canvas');
    const overlay = this.el<HTMLCanvasElement>('ns-overlay-canvas');
    if (!current || !this.buffers) { canvas.hidden = true; overlay.hidden = true; delete canvas.dataset.ready; return; }

    const mode = this.val('ns-view-mode') as NativeSceneRenderMode;
    const zoom = Number(this.val('ns-zoom')) || 2;
    this.el('ns-stage').dataset.background = this.val('ns-bg');

    const img = renderNativeScene(current, this.buffers, { mode, applyOverrides: true });
    if (canvas.width !== img.w || canvas.height !== img.h) { canvas.width = img.w; canvas.height = img.h; }
    canvas.style.width = `${img.w * zoom}px`;
    canvas.style.height = `${img.h * zoom}px`;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(img.w, img.h);
    for (let i = 0; i < img.data.length; i++) {
      const ink = img.data[i];
      imageData.data[i * 4] = ink >>> 24;
      imageData.data[i * 4 + 1] = (ink >>> 16) & 255;
      imageData.data[i * 4 + 2] = (ink >>> 8) & 255;
      imageData.data[i * 4 + 3] = ink & 255;
    }
    ctx.putImageData(imageData, 0, 0);
    canvas.hidden = false;
    canvas.dataset.ready = current.id;

    const ow = img.w * zoom, oh = img.h * zoom;
    if (overlay.width !== ow || overlay.height !== oh) { overlay.width = ow; overlay.height = oh; }
    overlay.style.width = `${ow}px`;
    overlay.style.height = `${oh}px`;
    const octx = overlay.getContext('2d')!;
    octx.clearRect(0, 0, ow, oh);
    overlay.hidden = false;

    if (mode === 'atlas') {
      if (this.isChecked('ns-ov-grid')) {
        octx.strokeStyle = 'rgba(155, 171, 197, 0.5)';
        octx.lineWidth = 1;
        const size = current.engineSnapshot.tilemap.tileSize;
        for (let x = 0; x <= img.w; x += size) { octx.beginPath(); octx.moveTo(x * zoom + 0.5, 0); octx.lineTo(x * zoom + 0.5, oh); octx.stroke(); }
        for (let y = 0; y <= img.h; y += size) { octx.beginPath(); octx.moveTo(0, y * zoom + 0.5); octx.lineTo(ow, y * zoom + 0.5); octx.stroke(); }
      }
      return;
    }

    const snap = current.engineSnapshot;
    const effective = effectiveNativeSceneState(current);

    if (this.isChecked('ns-ov-walkable')) {
      octx.fillStyle = 'rgba(72, 214, 130, 0.28)';
      for (let y = 0; y < snap.walkableRows.length; y++) {
        const spans = snap.walkableRows[y];
        for (let i = 0; i < spans.length; i += 2) {
          octx.fillRect(spans[i] * zoom, y * zoom, (spans[i + 1] - spans[i]) * zoom, zoom);
        }
      }
    }

    if (this.isChecked('ns-ov-collision')) {
      octx.fillStyle = 'rgba(255, 86, 86, 0.34)';
      for (const b of snap.collisionBoxes) octx.fillRect(b.x * zoom, b.y * zoom, b.w * zoom, b.h * zoom);
      octx.strokeStyle = 'rgba(255, 165, 120, 0.8)';
      octx.lineWidth = 1;
      for (const poly of snap.colliders) {
        if (!poly.points.length) continue;
        octx.beginPath();
        octx.moveTo(poly.points[0][0] * zoom, poly.points[0][1] * zoom);
        for (let i = 1; i < poly.points.length; i++) octx.lineTo(poly.points[i][0] * zoom, poly.points[i][1] * zoom);
        octx.closePath();
        octx.stroke();
      }
    }

    if (this.isChecked('ns-ov-grid')) {
      octx.strokeStyle = 'rgba(165, 185, 214, 0.45)';
      octx.lineWidth = 1;
      const size = snap.tilemap.tileSize;
      for (let x = 0; x <= img.w; x += size) { octx.beginPath(); octx.moveTo(x * zoom + 0.5, 0); octx.lineTo(x * zoom + 0.5, oh); octx.stroke(); }
      for (let y = 0; y <= img.h; y += size) { octx.beginPath(); octx.moveTo(0, y * zoom + 0.5); octx.lineTo(ow, y * zoom + 0.5); octx.stroke(); }
    }

    if (this.isChecked('ns-ov-occlusion')) {
      for (const layer of effective.layers) {
        if (!layer.visible) continue;
        const selected = layer.id === this.selectedLayerId;
        octx.strokeStyle = selected ? '#ffda6b' : layer.kind === 'actor' ? '#62e0ff' : '#d28eff';
        octx.lineWidth = selected ? 2 : 1;
        const left = layer.at.x - layer.pivot.x;
        const top = layer.at.y - layer.pivot.y;
        const bw = layer.bounds?.w ?? 16;
        const bh = layer.bounds?.h ?? 16;
        octx.strokeRect(left * zoom + 0.5, top * zoom + 0.5, bw * zoom, bh * zoom);
        octx.fillStyle = selected ? '#ffda6b' : '#e6eef8';
        octx.font = `${Math.max(10, 5 * zoom)}px monospace`;
        octx.fillText(`#${layer.order} ${layer.id} (y=${layer.at.y})`, Math.max(2, left * zoom + 2), Math.max(12, layer.at.y * zoom - 2));
      }
    }

    if (this.isChecked('ns-ov-actors')) {
      for (const [id, pt] of Object.entries(effective.actors)) {
        octx.strokeStyle = '#5ee8ff';
        octx.lineWidth = 1.5;
        octx.strokeRect((pt.x - snap.clearance.x) * zoom, (pt.y - snap.clearance.y) * zoom, (snap.clearance.x * 2 + 1) * zoom, (snap.clearance.y * 2 + 1) * zoom);
        octx.fillStyle = '#5ee8ff';
        octx.fillRect(pt.x * zoom - 3, pt.y * zoom - 1, 7, 3);
        octx.fillRect(pt.x * zoom - 1, pt.y * zoom - 3, 3, 7);
        octx.font = 'bold 11px monospace';
        octx.fillText(`Actor:${id}`, Math.min(ow - 90, pt.x * zoom + 6), Math.max(12, pt.y * zoom - 4));
      }
      for (const prop of snap.propAnchors) {
        octx.fillStyle = '#e79dff';
        octx.fillRect(prop.at.x * zoom - 2, prop.at.y * zoom - 2, 5, 5);
      }
    }

    if (this.isChecked('ns-ov-interactions')) {
      for (const item of effective.interactions) {
        const ax = item.at.x * zoom, ay = item.at.y * zoom;
        if (item.stand) {
          const sx = item.stand.x * zoom, sy = item.stand.y * zoom;
          octx.strokeStyle = 'rgba(255, 217, 124, 0.85)';
          octx.setLineDash([4, 3]);
          octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(sx, sy); octx.stroke();
          octx.setLineDash([]);
          octx.strokeStyle = '#7effb2';
          octx.lineWidth = 1.5;
          octx.strokeRect((item.stand.x - snap.clearance.x) * zoom, (item.stand.y - snap.clearance.y) * zoom, (snap.clearance.x * 2 + 1) * zoom, (snap.clearance.y * 2 + 1) * zoom);
        }
        octx.fillStyle = item.id === this.selectedInteractionId ? '#ffd97c' : '#ffb84d';
        octx.strokeStyle = '#121b1d';
        octx.lineWidth = 1.5;
        octx.beginPath();
        octx.moveTo(ax, ay - 6); octx.lineTo(ax + 6, ay); octx.lineTo(ax, ay + 6); octx.lineTo(ax - 6, ay);
        octx.closePath(); octx.fill(); octx.stroke();

        const tag = `${item.label ?? item.kind} [${item.id} · ${item.sourceRevision.slice(0, 7)}]`;
        octx.font = 'bold 11px sans-serif';
        const tw = octx.measureText(tag).width + 10;
        const bx = Math.max(2, Math.min(ow - tw - 2, ax - tw / 2));
        const by = Math.max(2, ay - 24);
        octx.fillStyle = 'rgba(18, 27, 29, 0.88)';
        octx.fillRect(bx, by, tw, 16);
        octx.fillStyle = '#ffd97c';
        octx.fillText(tag, bx + 5, by + 12);
      }
    }
  }

  private handleHover(event: MouseEvent): void {
    const current = this.scene;
    if (!current) return;
    const overlay = this.el<HTMLCanvasElement>('ns-overlay-canvas');
    const zoom = Number(this.val('ns-zoom')) || 2;
    const rect = overlay.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / zoom);
    const y = Math.floor((event.clientY - rect.top) / zoom);
    const snap = current.engineSnapshot;
    if (x < 0 || x >= snap.width || y < 0 || y >= snap.height) return;
    const col = Math.floor(x / snap.tilemap.tileSize), row = Math.floor(y / snap.tilemap.tileSize);
    const gridCols = snap.width / snap.tilemap.tileSize;
    const tileId = snap.tilemap.ids[row * gridCols + col];
    const spans = snap.walkableRows[y] ?? [];
    let walkable = false;
    for (let i = 0; i < spans.length; i += 2) if (x >= spans[i] && x < spans[i + 1]) { walkable = true; break; }
    const fits = fitsWalkable(snap, { x, y });
    this.el('ns-hover-info').textContent = `(${x}, ${y}) · Tile #${tileId} (c${col}, r${row}) · ${walkable ? 'Walkable' : 'Blocked'}${fits ? ' · Actor clearance OK' : ''}`;
  }
}
