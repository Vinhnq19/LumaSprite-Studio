import type { ArtDirection, ArtDirectionReference } from '../../src/studio/art-direction.ts';
import { defaultArtDirection } from '../../src/studio/art-direction.ts';
import { generationStyles, generationViews } from '../../src/studio/generation.ts';
import type { GenerationOptions } from '../../src/studio/types.ts';
import type { Session } from './session.ts';
import { api } from './session.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const select = (id: string) => $<HTMLSelectElement>(id);
const input = (id: string) => $<HTMLInputElement>(id);

export class ArtDirectionFormController {
  private session: Session;
  private selectedRefs: ArtDirectionReference[] = [];
  private lastProjectId?: string;
  private lastPersistedSignature?: string;

  constructor(session: Session, container: HTMLElement) {
    this.session = session;
    this.render(container);
    this.bindEvents();
  }

  private render(container: HTMLElement): void {
    container.innerHTML = `
      <div class="art-direction-section">
        <label>Nhà cung cấp AI
          <select id="provider" aria-label="Nhà cung cấp AI" aria-describedby="provider-help">
            <option value="codex">Codex</option>
            <option value="deepseek">DeepSeek API</option>
          </select>
        </label>
        <div class="row">
          <button id="provider-check" type="button">Kiểm tra cấu hình</button>
          <span id="provider-status" class="hint" role="status">Chưa kiểm tra cấu hình AI</span>
        </div>
        <p id="provider-help" class="hint">DeepSeek API chỉ tạo từ văn bản; ảnh tham chiếu, sửa vùng và animation cần chọn Codex.</p>
      </div>

      <div class="art-direction-section">
        <h3>Phong cách & Chỉ đạo nghệ thuật</h3>
        <label>Phong cách
          <select id="ai-style" aria-label="Phong cách AI">
            ${Object.entries(generationStyles).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
        </label>
        <label>Góc nhìn
          <select id="ai-view" aria-label="Góc nhìn AI">
            ${Object.entries(generationViews).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
        </label>
        <label>Bảng màu
          <select id="ai-palette" aria-label="Palette AI">
            <option value="asset">Palette asset hiện tại</option>
            <option value="project">Palette dự án đã lưu</option>
            <option value="auto16">AI tự chọn tối đa 16 màu</option>
          </select>
        </label>
        <div class="row">
          <label>Hướng sáng
            <input id="ai-light" value="${defaultArtDirection.light}" maxlength="50" aria-label="Hướng sáng">
          </label>
          <label>Chi tiết
            <select id="ai-detail-level" aria-label="Mức độ chi tiết">
              <option value="low">Thấp</option>
              <option value="medium" selected>Trung bình</option>
              <option value="high">Cao</option>
            </select>
          </label>
        </div>
        <label>Đường bao
          <input id="ai-outline" value="${defaultArtDirection.outline}" maxlength="50" aria-label="Đường bao">
        </label>

        <label><input id="ai-reference" type="checkbox"> Tham chiếu asset hiện tại (frame 1)</label>

        <details id="ai-art-refs-panel">
          <summary>Ảnh mẫu từ dự án (tối đa 3)</summary>
          <div id="ai-art-refs-list" class="refs-picker"></div>
          <small class="hint">Chọn tối đa 3 frame từ các asset trong dự án làm tham chiếu phong cách.</small>
        </details>

        <div class="row" style="margin-top: 8px;">
          <button id="save-art-direction" type="button" class="button">Lưu phong cách dự án</button>
          <span id="art-direction-status" class="hint" role="status"></span>
        </div>
      </div>

      <div class="art-direction-section">
        <h3>Mô tả & Mẫu prompt</h3>
        <div id="prompt-library"></div>
        <label>Yêu cầu tạo pixel
          <textarea id="ai-prompt" rows="3" placeholder="Ví dụ: hiệp sĩ áo choàng xanh, kiếm nhỏ, dáng đứng rõ, dùng làm sprite game…" aria-label="Mô tả AI"></textarea>
        </label>
      </div>
    `;
  }

  private bindEvents(): void {
    select('provider').onchange = () => {
      $('provider-status').textContent = 'Chưa kiểm tra cấu hình AI';
    };

    bindSafe('provider-check', async () => {
      const providers = await api('/api/studio/providers');
      $('provider-status').textContent = providers[select('provider').value]?.message ?? '';
    });

    bindSafe('save-art-direction', async () => {
      await this.saveToDoc();
    });
  }

  loadFromDoc(forceReset = false): void {
    const doc = this.session.doc;
    if (!doc) return;

    const currentSignature = JSON.stringify(doc.studio?.artDirection);
    const isDifferentProject = this.lastProjectId !== doc.id;
    const isProfileChanged = this.lastPersistedSignature !== currentSignature;

    if (isDifferentProject || forceReset || isProfileChanged) {
      this.lastProjectId = doc.id;
      this.lastPersistedSignature = currentSignature;
      const ad = doc.studio?.artDirection;

      select('ai-style').value = ad?.style ?? defaultArtDirection.style;
      if (ad?.paletteMode === 'asset') {
        select('ai-palette').value = ad.palette?.length ? 'project' : 'asset';
      } else if (ad?.paletteMode === 'auto16') {
        select('ai-palette').value = 'auto16';
      } else {
        select('ai-palette').value = defaultArtDirection.paletteMode;
      }
      input('ai-light').value = ad?.light ?? defaultArtDirection.light;
      select('ai-detail-level').value = ad?.detailLevel ?? defaultArtDirection.detailLevel;
      input('ai-outline').value = ad?.outline ?? defaultArtDirection.outline;

      this.selectedRefs = ad?.references ? structuredClone(ad.references) : [];
      if (isDifferentProject || forceReset) input('ai-reference').checked = false;
    }

    // Prune nonexistent pairs on document refresh, preventing deleted refs from blocking generation
    this.selectedRefs = this.selectedRefs.filter(ref => {
      const asset = doc.assets.find(a => a.id === ref.assetId);
      return asset && asset.frames.some(f => f.id === ref.frameId);
    });

    this.renderReferencesList();
  }

  private renderReferencesList(): void {
    const list = $('ai-art-refs-list');
    list.replaceChildren();
    const doc = this.session.doc;
    if (!doc || !doc.assets.length) {
      list.innerHTML = '<small class="hint">Chưa có asset nào trong dự án.</small>';
      return;
    }

    for (const asset of doc.assets) {
      for (const [idx, frame] of asset.frames.entries()) {
        const isChecked = this.selectedRefs.some(r => r.assetId === asset.id && r.frameId === frame.id);
        const row = document.createElement('label');
        row.className = 'ref-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isChecked;
        cb.onchange = () => {
          if (cb.checked) {
            if (this.selectedRefs.length >= 3) {
              cb.checked = false;
              $('art-direction-status').textContent = 'Tối đa 3 tham chiếu.';
              return;
            }
            this.selectedRefs.push({ assetId: asset.id, frameId: frame.id });
          } else {
            this.selectedRefs = this.selectedRefs.filter(r => !(r.assetId === asset.id && r.frameId === frame.id));
          }
        };
        row.append(cb, document.createTextNode(` ${asset.name} (frame ${idx + 1})`));
        list.append(row);
      }
    }
  }

  async saveToDoc(): Promise<void> {
    const doc = this.session.doc;
    if (!doc) return;

    // FIRST save: insert empty studio{version:1} marker before command snapshot so undo doesn't drop extension
    if (!doc.studio) {
      doc.studio = { version: 1 };
    }

    const ad = this.getArtDirection();
    this.session.change('Lưu phong cách dự án', () => {
      this.session.doc!.studio = {
        ...(this.session.doc!.studio ?? { version: 1 }),
        version: 1,
        artDirection: ad,
      };
    });

    this.lastPersistedSignature = JSON.stringify(ad);
    await this.session.flush();
    $('art-direction-status').textContent = 'Đã lưu phong cách vào dự án.';
  }

  getArtDirection(): ArtDirection {
    const style = select('ai-style').value as ArtDirection['style'];
    const pModeRaw = select('ai-palette').value;
    const light = input('ai-light').value.trim() || defaultArtDirection.light;
    const detailLevel = select('ai-detail-level').value as ArtDirection['detailLevel'];
    const outline = input('ai-outline').value.trim() || defaultArtDirection.outline;
    const references = this.selectedRefs.slice(0, 3).map(r => ({ assetId: r.assetId, frameId: r.frameId }));

    const doc = this.session.doc;
    let paletteMode: ArtDirection['paletteMode'] = 'asset';
    let palette: number[] | undefined;

    if (pModeRaw === 'auto16') {
      paletteMode = 'auto16';
    } else if (pModeRaw === 'project') {
      paletteMode = 'asset';
      palette = doc?.studio?.artDirection?.palette ? [...doc.studio.artDirection.palette] : (this.session.asset?.palette ? [...this.session.asset.palette] : undefined);
    } else {
      // 'asset' mode: send current asset palette explicitly
      paletteMode = 'asset';
      palette = this.session.asset?.palette ? [...this.session.asset.palette] : (doc?.studio?.artDirection?.palette ? [...doc.studio.artDirection.palette] : undefined);
    }

    return {
      style,
      paletteMode,
      palette,
      light,
      detailLevel,
      outline,
      references,
    };
  }

  getGenerationOptions(): GenerationOptions {
    const pModeRaw = select('ai-palette').value;
    return {
      style: select('ai-style').value as GenerationOptions['style'],
      view: select('ai-view').value as GenerationOptions['view'],
      paletteMode: pModeRaw === 'auto16' ? 'auto16' : 'asset',
      reference: input('ai-reference').checked,
    };
  }
}

function bindSafe(id: string, fn: () => Promise<void>): void {
  const el = document.getElementById(id);
  if (el) {
    el.onclick = () => {
      fn().catch(e => {
        const modalError = document.getElementById('ai-modal-error');
        if (modalError) {
          modalError.textContent = (e as Error).message;
          modalError.hidden = false;
        }
        const notice = document.getElementById('notice');
        if (notice) {
          notice.textContent = (e as Error).message;
          notice.hidden = false;
        }
      });
    };
  }
}
