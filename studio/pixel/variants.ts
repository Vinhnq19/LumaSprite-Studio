import { api } from './session.ts';
import { sampleMotionPlayback } from '../../src/studio/quality/playback.ts';
import { composite, type PixelAsset } from '../../src/studio/pixel/model.ts';
import { generationStyles, generationViews } from '../../src/studio/generation.ts';
import type { VariantPreview, VariantInfo, VariantFrame, ProcessingJob } from '../../src/studio/variants.ts';
import { zoomProposal } from './proposal-preview.ts';
import { resolveClipComparison, isClipPreview } from './clip-preview.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const select = (id: string) => $<HTMLSelectElement>(id), input = (id: string) => $<HTMLInputElement>(id);

function canvasImage(frame: VariantFrame, tint?: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = frame.w;
  c.height = frame.h;
  const bytes = new Uint8ClampedArray(frame.data.length * 4);
  frame.data.forEach((p, i) => {
    bytes[i * 4] = tint?.[0] ?? p >>> 24;
    bytes[i * 4 + 1] = tint?.[1] ?? (p >>> 16 & 255);
    bytes[i * 4 + 2] = tint?.[2] ?? (p >>> 8 & 255);
    bytes[i * 4 + 3] = p & 255;
  });
  c.getContext('2d')!.putImageData(new ImageData(bytes, c.width, c.height), 0, 0);
  return c;
}

export class VariantPreviewController {
  private current?: VariantPreview;
  private before?: PixelAsset;
  private path = '';
  private revision = 0;
  private frameIndex = 0;
  private assetIndex = 0;
  private ticket = 0;
  private playing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private cache = new Map<string, VariantFrame>();
  private cacheBytes = 0;
  private processing?: string;
  private playStarted = 0;
  private playEpoch = 0;
  private context: () => { path: string; revision: number } | undefined;
  private flush: () => Promise<void>;
  private onerror: (e: unknown) => void;
  private onChange?: () => void;

  constructor(
    context: () => { path: string; revision: number } | undefined,
    flush: () => Promise<void>,
    onerror: (e: unknown) => void,
    onChange?: () => void
  ) {
    this.context = context;
    this.flush = flush;
    this.onerror = onerror;
    this.onChange = onChange;
    const host = document.createElement('div');
    host.id = 'variant-controls';
    host.hidden = true;
    host.innerHTML = `<label>Bản xem trước<select id="proposal-variant" aria-label="Biến thể đề xuất"></select></label><label>Asset<select id="proposal-asset" aria-label="Asset đề xuất"></select></label><div class="row wrap"><button id="proposal-play" type="button">▶ Phát preview</button><label>Frame<select id="proposal-frame" aria-label="Frame đề xuất"></select></label></div><label>Ảnh đối chiếu<select id="proposal-compare" aria-label="Ảnh đối chiếu"><option value="reference">Mẫu chuẩn / asset hiện tại</option><option value="raw">AI gốc cùng frame</option></select></label><div class="row wrap"><label><input id="proposal-onion" type="checkbox">Onion-skin</label><label><input id="proposal-anchor" type="checkbox">Điểm neo</label></div><label>Lớp kiểm tra<select id="proposal-overlay" aria-label="Lớp kiểm tra"><option value="">Tắt</option><option value="difference">Khác biệt với ảnh đối chiếu</option><option value="movement">Vùng được phép sửa</option><option value="singletons">Pixel màu đơn (4 láng giềng)</option><option value="checkerboards">Mẫu xen kẽ 2×2</option></select></label><small>Overlay chỉ để xem, không xuất vào ảnh. Pixel đơn/xen kẽ có thể là chi tiết có chủ ý.</small><p id="proposal-frame-status" role="status"></p><div class="row wrap"><label>Ngưỡng alpha <input id="normalize-alpha" type="number" min="1" max="255" value="128"></label><button id="proposal-normalize" type="button">Chuẩn hóa palette</button></div><p id="processing-status" role="status"></p><small>Giữ ảnh gốc; chuẩn hóa tạo thêm bản xem trước, không gọi AI và không tự áp dụng.</small>`;
    $('proposal-stats').after(host);

    select('proposal-variant').onchange = () => {
      this.stop();
      this.assetIndex = 0;
      this.frameIndex = 0;
      const v = this.selected();
      if (this.isClip() && v) {
        const rawComp = resolveClipComparison(this.current!, v, 0, 0, 'raw');
        select('proposal-compare').value = (v.kind === 'raw' || ('unavailable' in rawComp)) ? 'reference' : 'raw';
      } else {
        select('proposal-compare').value = v?.kind === 'raw' ? 'reference' : 'raw';
      }
      this.options();
      this.draw();
      this.onChange?.();
    };

    select('proposal-asset').onchange = () => {
      this.stop();
      this.assetIndex = Number(select('proposal-asset').value);
      this.frameIndex = 0;
      this.options();
      this.draw();
    };

    select('proposal-frame').onchange = () => {
      this.stop();
      this.frameIndex = Number(select('proposal-frame').value);
      this.updateCompareAndOverlayOptions();
      this.draw();
    };

    for (const id of ['proposal-compare', 'proposal-overlay', 'proposal-onion', 'proposal-anchor']) {
      $(id).addEventListener('change', () => {
        if (id === 'proposal-compare') {
          this.updateCompareAndOverlayOptions();
        }
        this.draw();
      });
    }

    $('proposal-play').onclick = () => {
      if (this.playing) this.stop();
      else {
        this.playStarted = performance.now(); this.playEpoch++;
        this.playing = true;
        $('proposal-play').textContent = '■ Dừng preview';
        void this.play().catch(e => {
          this.stop();
          this.onerror(e);
        });
      }
    };

    $('proposal-normalize').onclick = () => {
      void this.normalize().catch(e => {
        $('processing-status').textContent = (e as Error).message;
        this.onerror(e);
      });
    };
  }

  get currentProposal(): VariantPreview | undefined { return this.current; }
  get selectedVariant(): VariantInfo | undefined { return this.selected(); }
  get canApply(): boolean { const v = this.selected(); return !!v?.canApply && !(v.quality?.errors.length); }
  get selection(): string | undefined { return this.current ? select('proposal-variant').value : undefined; }
  private selected(): VariantInfo | undefined { return this.current?.variants.find(v => v.id === this.selection); }

  private isClip(): boolean {
    return isClipPreview(this.current);
  }

  stop(): void {
    this.playing = false;
    this.playEpoch++;
    clearTimeout(this.timer);
    $('proposal-play').textContent = '▶ Phát preview';
  }

  reset(): void {
    this.stop();
    this.ticket++;
    this.current = undefined;
    this.before = undefined;
    this.processing = undefined;
    this.cache.clear();
    this.cacheBytes = 0;
    $('variant-controls').hidden = true;
    $('processing-status').textContent = '';
    this.onChange?.();
  }

  async show(p: VariantPreview, before?: PixelAsset): Promise<void> {
    this.reset();
    const c = this.context();
    if (!c) return;
    this.path = c.path;
    this.revision = c.revision;
    this.current = p;
    this.before = before;
    this.frameIndex = 0;
    this.assetIndex = 0;
    $('variant-controls').hidden = false;

    this.variantOptions(p.selectedVariantId);
    const v = this.selected();
    if (this.isClip() && v) {
      const rawComp = resolveClipComparison(p, v, 0, 0, 'raw');
      select('proposal-compare').value = (v.kind === 'raw' || ('unavailable' in rawComp)) ? 'reference' : 'raw';
    } else {
      select('proposal-compare').value = v?.kind === 'raw' ? 'reference' : 'raw';
    }
    this.options();
    await this.render();
    this.onChange?.();
  }

  private variantOptions(id: string): void {
    select('proposal-variant').replaceChildren(...this.current!.variants.map(v => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label + (v.canApply ? '' : ' · chỉ xem');
      return o;
    }));
    select('proposal-variant').value = id;
  }

  private updateCompareAndOverlayOptions(): void {
    const v = this.selected();
    if (!v || !this.current) return;
    const isClip = this.isClip();
    const compareSelect = select('proposal-compare');
    const overlaySelect = select('proposal-overlay');

    if (isClip && v.clip) {
      let masterOpt = compareSelect.querySelector<HTMLOptionElement>('option[value="master"]');
      if (v.clip.masterAssetId) {
        if (!masterOpt) {
          masterOpt = document.createElement('option');
          masterOpt.value = 'master';
          masterOpt.textContent = 'Ảnh nguồn tham chiếu (master)';
          compareSelect.append(masterOpt);
        }
      } else if (masterOpt) {
        masterOpt.remove();
      }

      const rawOpt = compareSelect.querySelector<HTMLOptionElement>('option[value="raw"]');
      const refOpt = compareSelect.querySelector<HTMLOptionElement>('option[value="reference"]');

      if (rawOpt) {
        const rawComp = resolveClipComparison(this.current, v, this.assetIndex, this.frameIndex, 'raw');
        const rawUnavailable = 'unavailable' in rawComp;
        rawOpt.disabled = v.kind === 'raw' || rawUnavailable;
        rawOpt.title = rawUnavailable ? rawComp.unavailable : '';
      }

      if (refOpt) {
        const refComp = resolveClipComparison(this.current, v, this.assetIndex, this.frameIndex, 'reference');
        refOpt.disabled = 'unavailable' in refComp;
        refOpt.title = 'unavailable' in refComp ? refComp.unavailable : '';
      }

      if (masterOpt) {
        const masterComp = resolveClipComparison(this.current, v, this.assetIndex, this.frameIndex, 'master');
        masterOpt.disabled = 'unavailable' in masterComp;
        masterOpt.title = 'unavailable' in masterComp ? masterComp.unavailable : '';
      }

      const selectedOpt = compareSelect.querySelector<HTMLOptionElement>(`option[value="${compareSelect.value}"]`);
      if (selectedOpt?.disabled) {
        compareSelect.value = 'reference';
      }

      const against = compareSelect.value;
      const diffOpt = overlaySelect.querySelector<HTMLOptionElement>('option[value="difference"]');
      if (diffOpt) {
        const rawComp = resolveClipComparison(this.current, v, this.assetIndex, this.frameIndex, 'raw');
        const diffSupported = against !== 'master' && (against !== 'raw' || !('unavailable' in rawComp));
        diffOpt.disabled = !diffSupported;
        diffOpt.hidden = !diffSupported;
        if (!diffSupported && overlaySelect.value === 'difference') {
          overlaySelect.value = '';
        }
      }

      const moveOpt = overlaySelect.querySelector<HTMLOptionElement>('option[value="movement"]');
      if (moveOpt) {
        const moveSupported = this.current.generation?.clip?.context?.mode === 'region' && v.kind !== 'raw';
        moveOpt.disabled = !moveSupported;
        moveOpt.hidden = !moveSupported;
        if (!moveSupported && overlaySelect.value === 'movement') {
          overlaySelect.value = '';
        }
      }
    } else if (isClip) {
      compareSelect.querySelector('option[value="master"]')?.remove();
      for (const option of compareSelect.options) {
        option.disabled = true;
        option.title = 'Thiếu ánh xạ frame của clip; chưa thể đối chiếu.';
      }
      compareSelect.value = 'reference';
      for (const kind of ['difference', 'movement']) {
        const option = overlaySelect.querySelector<HTMLOptionElement>(`option[value="${kind}"]`);
        if (option) { option.disabled = true; option.hidden = true; }
        if (overlaySelect.value === kind) overlaySelect.value = '';
      }
    } else {
      const masterOpt = compareSelect.querySelector<HTMLOptionElement>('option[value="master"]');
      if (masterOpt) masterOpt.remove();
      const rawOpt = compareSelect.querySelector<HTMLOptionElement>('option[value="raw"]');
      if (rawOpt) { rawOpt.disabled = false; rawOpt.title = ''; }
      const refOpt = compareSelect.querySelector<HTMLOptionElement>('option[value="reference"]');
      if (refOpt) { refOpt.disabled = false; refOpt.title = ''; }
      const diffOpt = overlaySelect.querySelector<HTMLOptionElement>('option[value="difference"]');
      if (diffOpt) { diffOpt.disabled = false; diffOpt.hidden = false; }
      const moveOpt = overlaySelect.querySelector<HTMLOptionElement>('option[value="movement"]');
      if (moveOpt) { moveOpt.disabled = false; moveOpt.hidden = false; }
    }
  }

  private options(): void {
    const v = this.selected();
    if (!v) return;
    const option = (value: string, label: string) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    };

    select('proposal-asset').replaceChildren(...v.assets.map((a, i) => option(String(i), a.name)));
    select('proposal-asset').value = String(this.assetIndex);

    const a = v.assets[this.assetIndex];
    if (a) {
      const isClip = this.isClip();
      select('proposal-frame').replaceChildren(...a.frames.map((f, i) => {
        let label: string;
        if (isClip && v.clip) {
          if (v.kind === 'raw') {
            const slotId = v.clip.selectedSlotIds[i];
            const slotNum = slotId ? v.clip.slotIds.indexOf(slotId) + 1 : (i + 1);
            label = `Slot ${slotNum} · ${f.duration} ms`;
          } else {
            const slotNum = v.clip.slotIds.indexOf(f.id) + 1;
            label = `${slotNum > 0 ? `Slot ${slotNum}` : i + 1} · ${f.duration} ms`;
          }
        } else {
          label = `${i + 1} · ${f.duration} ms`;
        }
        return option(String(i), label);
      }));
      select('proposal-frame').value = String(this.frameIndex);
    }

    $('proposal-apply').toggleAttribute('disabled', !v.canApply);
    $('proposal-normalize').toggleAttribute('disabled', !this.current?.generation || !!this.processing);

    this.updateCompareAndOverlayOptions();

    const g = this.current!.generation;
    if (g?.clip?.context) {
      const ctx = g.clip.context;
      const k = ctx.slots.filter(s => s.selected).length;
      const n = ctx.slots.length;
      const style = (generationStyles as Record<string, string>)[g.options.style] ?? g.options.style;
      const view = (generationViews as Record<string, string>)[g.options.view] ?? g.options.view;
      const pal = ctx.paletteMode === 'asset' ? 'Palette cố định từ asset' : 'Palette cố định (≤16 màu)';
      const modeStr = ctx.mode === 'region' ? 'Khóa vùng' : 'Toàn bộ';
      const sourceFrame = this.before?.id === ctx.sourceAssetId
        ? this.before.frames.findIndex(frame => frame.id === ctx.sourceFrameId) : -1;
      $('proposal-settings').textContent = `${ctx.w}×${ctx.h} · ${style} · ${view} · ${pal} · ${k}/${n} frame (${modeStr}) · ${sourceFrame >= 0 ? `Frame nguồn ${sourceFrame + 1}` : 'Frame nguồn đã duyệt'}`;
    } else {
      const animLabel = g?.operation === 'region-edit'
        ? 'Chỉnh sửa vùng từ frame đã chọn'
        : g?.animation
        ? 'Mẫu từ frame đã chọn'
        : g?.options.reference
        ? 'Tham chiếu frame 1'
        : 'Không tham chiếu';
      $('proposal-settings').textContent = g
        ? `${g.w}×${g.h} · ${(generationStyles as Record<string, string>)[g.options.style] ?? g.options.style} · ${(generationViews as Record<string, string>)[g.options.view] ?? g.options.view} · ${g.options.paletteMode === 'asset' ? 'Palette asset' : 'AI chọn ≤16 màu'} · ${animLabel}`
        : 'Đề xuất từ mã';
    }

    $('proposal-stats').textContent = v.quality
      ? v.quality.assets.map(a => `${a.name}: ${a.w}×${a.h} · ${a.frames} frame · ${a.colorCount} màu`).join('\n')
      : v.assets.map(a => `${a.name}: ${a.w}×${a.h} · ${a.frames.length} frame`).join('\n');

    if (v.quality?.errors.length) {
      $('proposal-errors').textContent = `Chưa thể áp dụng:\n${v.quality.errors.join('\n')}`;
    } else if (!v.canApply) {
      $('proposal-errors').textContent = v.clip
        ? 'Ảnh AI gốc của clip chỉ để xem đối chiếu, không áp dụng trực tiếp. Vui lòng chọn bản đã ghép hoặc đã chuẩn hóa.'
        : 'Ảnh AI gốc ở chế độ khóa vùng chỉ để xem. Chọn bản đã khóa vùng hoặc đã chuẩn hóa.';
    } else {
      $('proposal-errors').textContent = '';
    }

    $('proposal-warnings').textContent = v.quality?.warnings.length
      ? `Cảnh báo (có thể áp dụng nếu chấp nhận):\n${v.quality.warnings.join('\n')}`
      : '';

    const s = v.stats?.[this.assetIndex];
    if (s) {
      $('proposal-stats').textContent += `\nMàu ${s.beforeColors} → ${s.afterColors} · đổi ${s.changedPixels} pixel (${s.changedColors} màu, ${s.changedAlpha} alpha) · ngoài vùng khóa: ${s.outsideChanges}`;
    }
    this.onChange?.();
  }

  private valid(): boolean {
    const c = this.context();
    return !!this.current && c?.path === this.path && c.revision === this.revision;
  }

  private async fetchVariantFrame(variantId: string, assetId: string, frameId: string, overlay = ''): Promise<VariantFrame> {
    const against = select('proposal-compare').value;
    const key = `${variantId}:${assetId}:${frameId}:${overlay}:${against}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const p = this.current!;
    const value: VariantFrame = await api(`${this.path}/proposals/${p.proposalId}/variants/${variantId}/frame?revision=${this.revision}&asset=${assetId}&frame=${frameId}${overlay ? `&overlay=${overlay}&against=${against}` : ''}`);
    if (!this.valid() || this.current !== p) throw new Error('Đề xuất đã đổi dự án hoặc revision.');
    while (this.cacheBytes + value.data.byteLength > 32 * 1024 * 1024 && this.cache.size) {
      const first = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(first)!.data.byteLength;
      this.cache.delete(first);
    }
    if (value.data.byteLength <= 32 * 1024 * 1024) {
      this.cache.set(key, value);
      this.cacheBytes += value.data.byteLength;
    }
    return value;
  }

  private async frame(v: VariantInfo, index: number, assetIndex = this.assetIndex, overlay = ''): Promise<VariantFrame> {
    if (this.isClip()) {
      const a = v.assets[assetIndex];
      if (!a) throw new Error(`Asset index ${assetIndex} không tồn tại.`);
      const f = a.frames[index];
      if (!f) throw new Error(`Frame index ${index} không tồn tại.`);
      return this.fetchVariantFrame(v.id, a.id, f.id, overlay);
    }
    const a = v.assets[assetIndex] ?? v.assets[0];
    const f = a.frames[Math.min(index, a.frames.length - 1)];
    return this.fetchVariantFrame(v.id, a.id, f.id, overlay);
  }

  private draw(): void {
    const current = this.current;
    void this.render().catch(e => {
      if (this.current === current && this.valid()) this.onerror(e);
    });
  }

  private async render(): Promise<void> {
    if (!this.valid()) return;
    const ticket = ++this.ticket;
    const current = this.current;
    const v = this.selected()!;
    const a = v.assets[this.assetIndex];
    const index = this.frameIndex;
    const isClip = this.isClip();

    try {
      if (!a || index < 0 || index >= a.frames.length) return;
      this.updateCompareAndOverlayOptions();
      const main = isClip
        ? await this.fetchVariantFrame(v.id, a.id, a.frames[index].id)
        : await this.frame(v, index);
      if (ticket !== this.ticket || !this.valid()) return;

      let before: VariantFrame | undefined;
      const against = select('proposal-compare').value;

      if (isClip) {
        const comp = resolveClipComparison(this.current!, v, this.assetIndex, index, against);
        if (!('unavailable' in comp)) {
          before = await this.fetchVariantFrame(comp.variantId, comp.assetId, comp.frameId);
        }
      } else {
        if (against === 'raw') {
          const rawVariant = this.current!.variants.find(x => x.kind === 'raw') ?? this.current!.variants[0];
          before = await this.frame(rawVariant, index);
        } else if (this.current!.reference) {
          before = await this.frame(this.current!.reference, 0, 0);
        } else if (this.before) {
          const frameId = this.current!.generation?.animation?.frameId ?? this.before.frames[0].id;
          const image = composite(this.before, frameId);
          const srcFrame = this.before.frames.find(f => f.id === frameId);
          before = { ...image, duration: srcFrame?.duration ?? 100 };
        }
      }
      if (ticket !== this.ticket || !this.valid()) return;

      let previous: VariantFrame | undefined, next: VariantFrame | undefined;
      if (input('proposal-onion').checked) {
        if (index > 0) previous = await this.frame(v, index - 1);
        if (index + 1 < a.frames.length) next = await this.frame(v, index + 1);
      }

      let overlay: VariantFrame | undefined;
      const overlayType = select('proposal-overlay').value;
      if (overlayType) {
        let allowed = true;
        if (isClip) {
          if (overlayType === 'difference') {
            const comp = resolveClipComparison(this.current!, v, this.assetIndex, index, against);
            if (against === 'master' || ('unavailable' in comp)) {
              allowed = false;
            }
          } else if (overlayType === 'movement') {
            if (this.current!.generation?.clip?.context?.mode !== 'region' || v.kind === 'raw') {
              allowed = false;
            }
          }
        }
        if (allowed) {
          overlay = isClip
            ? await this.fetchVariantFrame(v.id, a.id, a.frames[index].id, overlayType)
            : await this.frame(v, index, this.assetIndex, overlayType);
        }
      }
      if (ticket !== this.ticket || !this.valid()) return;

      if (isClip) {
        const comp = resolveClipComparison(this.current!, v, this.assetIndex, index, against);
        if ('unavailable' in comp) {
          $('proposal-before-label').textContent = comp.unavailable;
        } else if (against === 'raw') {
          $('proposal-before-label').textContent = `AI gốc · slot ${comp.slotNumber}`;
        } else if (against === 'reference') {
          $('proposal-before-label').textContent = `Mẫu chuẩn baseline · slot ${comp.slotNumber}`;
        } else if (against === 'master') {
          $('proposal-before-label').textContent = `Ảnh nguồn master · slot ${comp.slotNumber}`;
        } else {
          $('proposal-before-label').textContent = `Đối chiếu · slot ${comp.slotNumber}`;
        }

        const slotNum = (comp && 'slotNumber' in comp)
          ? comp.slotNumber
          : (v.kind === 'raw' && v.clip
            ? v.clip.slotIds.indexOf(v.clip.selectedSlotIds[index]) + 1
            : (v.clip ? v.clip.slotIds.indexOf(a.frames[index]?.id) + 1 : index + 1));
        $('proposal-after-label').textContent = `${v.label} · slot ${slotNum}`;
      } else {
        const isRegion = this.current!.generation?.operation === 'region-edit';
        const rawVariant = this.current!.variants.find(x => x.kind === 'raw') ?? this.current!.variants[0];
        $('proposal-before-label').textContent = select('proposal-compare').value === 'raw'
          ? `AI gốc · frame ${Math.min(index + 1, rawVariant.assets[this.assetIndex]?.frames.length ?? 1)}`
          : this.current!.reference
          ? 'Mẫu chuẩn · frame nguồn đã chọn'
          : isRegion
          ? 'Mẫu chuẩn · frame đã chọn'
          : 'Asset hiện tại';
        $('proposal-after-label').textContent = `${v.label} · frame ${index + 1}`;
      }

      const beforeCanvas = $<HTMLCanvasElement>('before');
      if (before) {
        beforeCanvas.width = before.w;
        beforeCanvas.height = before.h;
        beforeCanvas.getContext('2d')!.drawImage(canvasImage(before), 0, 0);
      } else {
        beforeCanvas.width = 1;
        beforeCanvas.height = 1;
        beforeCanvas.getContext('2d')!.clearRect(0, 0, 1, 1);
      }

      const after = $<HTMLCanvasElement>('after');
      after.width = main.w;
      after.height = main.h;
      const ctx = after.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;

      for (const [ghost, tint] of [[previous, [255, 90, 110]], [next, [80, 180, 255]]] as const) {
        if (ghost) {
          ctx.globalAlpha = 0.25;
          ctx.drawImage(canvasImage(ghost, [...tint]), 0, 0);
        }
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(canvasImage(main), 0, 0);
      if (overlay) ctx.drawImage(canvasImage(overlay), 0, 0);

      const anchor = this.current!.generation?.clip?.context?.pivot ?? this.current!.generation?.animation?.anchor;
      if (anchor && input('proposal-anchor').checked) {
        ctx.fillStyle = '#00eaff';
        ctx.fillRect(Math.round(anchor.x) - 2, Math.min(main.h - 1, Math.round(anchor.y)), 5, 1);
        ctx.fillRect(Math.min(main.w - 1, Math.round(anchor.x)), Math.round(anchor.y) - 2, 1, 5);
      }

      const b = main.bounds, s = v.stats?.[this.assetIndex]?.frames[index];
      const frameLabel = isClip && v.clip
        ? `Slot ${(v.kind === 'raw' ? v.clip.slotIds.indexOf(v.clip.selectedSlotIds[index]) + 1 : v.clip.slotIds.indexOf(a.frames[index]?.id) + 1)} (${index + 1}/${a.frames.length})`
        : `Frame ${index + 1}/${a.frames.length}`;
      $('proposal-frame-status').textContent = `${frameLabel} · ${main.duration} ms${b ? ` · vùng hình ${b.w}×${b.h}, đáy y=${b.bottom}` : ''}${s ? ` · lệch đáy ${s.bottomDrift} px` : ''}${overlay ? ` · đánh dấu ${overlay.count ?? 0}` : ''}`;
      select('proposal-frame').value = String(index);
      zoomProposal();
    } catch (error) {
      if (ticket !== this.ticket || this.current !== current || !this.valid()) return;
      throw error;
    }
  }

  private async play(): Promise<void> {
    if (!this.playing || !this.valid()) return;
    const epoch = this.playEpoch, stamp = performance.now();
    const a = this.selected()!.assets[this.assetIndex];
    const tag = a.tags[0];
    let order = a.frames.map((_, i) => i);
    if (tag) {
      const from = a.frames.findIndex(f => f.id === tag.from);
      const to = a.frames.findIndex(f => f.id === tag.to);
      order = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    if (tag?.direction === 'reverse') order.reverse();
    if (tag?.direction === 'ping-pong' && order.length > 2) {
      order = [...order, ...order.slice(1, -1).reverse()];
    }
    const sample = sampleMotionPlayback(order.map(i => ({ durationMs: a.frames[i].duration })), stamp - this.playStarted, tag?.loop ?? true);
    this.frameIndex = order[sample.index];
    await this.render();
    if (!this.playing || epoch !== this.playEpoch || !this.valid()) return;
    if (sample.done) { this.stop(); return; }
    this.timer = setTimeout(() => {
      if (!this.playing || epoch !== this.playEpoch) return;
      void this.play().catch(e => {
        this.stop();
        this.onerror(e);
      });
    }, Math.max(1, sample.delayMs - (performance.now() - stamp)));
  }

  private async normalize(): Promise<void> {
    if (!this.current || this.processing) return;
    await this.flush();
    if (!this.valid()) throw new Error('Dự án đã đổi. Tạo lại đề xuất trước khi chuẩn hóa.');
    const p = this.current, path = this.path, revision = this.revision;
    const job: ProcessingJob = await api(`${path}/proposals/${p.proposalId}/normalize`, 'POST', {
      revision,
      alphaThreshold: Number(input('normalize-alpha').value),
    });
    if (this.current !== p) return;
    this.processing = job.id;
    this.options();
    $('processing-status').textContent = job.message;
    try {
      let state = job;
      while (state.status === 'running' && this.current === p) {
        await new Promise(r => setTimeout(r, 200));
        if (this.current !== p) return;
        state = await api(`${path}/processing/${job.id}`);
        if (this.current !== p) return;
        $('processing-status').textContent = state.message;
      }
      if (this.current !== p) return;
      if (state.status !== 'ready') throw new Error(state.message);
      const updated: VariantPreview = await api(`${path}/proposals/${p.proposalId}?revision=${revision}`);
      if (this.current !== p) return;
      this.current = updated;
      this.stop();
      this.frameIndex = 0;
      this.assetIndex = 0;
      this.variantOptions(state.variantId!);
      select('proposal-compare').value = 'raw';
      this.options();
      await this.render();
    } catch (e) {
      if (this.current === p) throw e;
    } finally {
      if (this.processing === job.id) {
        this.processing = undefined;
        if (this.current) this.options();
      }
    }
  }
}
