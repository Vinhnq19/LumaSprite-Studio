import { composite, type PixelAsset } from '../../src/studio/pixel/model.ts';

export interface RegionEditorContext {
  projectId: string;
  asset: PixelAsset;
  frameId: string;
  revision: number;
  mask?: Uint8Array;
}

export interface RegionEditorStartOptions {
  regionEdit: {
    frameId: string;
    mask: number[];
  };
  prompt: string;
  expectedSource: {
    projectId: string;
    assetId: string;
    frameId: string;
    revision: number;
    w: number;
    h: number;
  };
}

export interface RegionSnapshot {
  projectId: string;
  assetId: string;
  assetName: string;
  w: number;
  h: number;
  frameId: string;
  frameIndex: number;
  duration: number;
  revision: number;
  pivot: { x: number; y: number };
  mask: Uint8Array;
  snapshotPixels: Uint32Array;
}

export function setupRegionEditor(options: {
  context: () => RegionEditorContext | undefined;
  prepare: () => Promise<void>;
  start: (opts: RegionEditorStartOptions) => Promise<void>;
  normalizeReference: () => Promise<void>;
  onerror: (e: unknown) => void;
  isLocked?: () => boolean;
  isParentOpen?: () => boolean;
}): { reset: () => void; close: () => void } {
  const dialog = document.createElement('dialog');
  dialog.id = 'region-dialog';
  dialog.innerHTML = `<form id="region-form">
  <h2>Chỉnh sửa vùng đã chọn</h2>
  <p id="region-source"></p>
  <label>Mô tả chỉnh sửa
    <textarea id="region-prompt" rows="3" required placeholder="Mô tả chi tiết cần thay đổi trong vùng đã chọn…">Đổi chi tiết trong vùng chọn, giữ nguyên nét và màu xung quanh.</textarea>
  </label>
  <div class="region-preview-wrap">
    <canvas id="region-preview" aria-label="Mẫu chuẩn và vùng được chọn"></canvas>
  </div>
  <p id="region-status"></p>
  <small>Xanh: vùng được phép sửa. Phải bao gồm cả vị trí cũ và mới của chi tiết. Ngoài vùng này giữ nguyên tuyệt đối; không tự mở rộng viền hay thay thế bằng toàn canvas.</small>
  <p id="region-error" role="alert"></p>
  <div class="row wrap">
    <button id="region-normalize" type="button">Chuẩn hóa mẫu thành bản sao</button>
    <button id="region-close" type="button">Hủy</button>
    <button id="region-submit" class="primary" type="submit">Xác nhận và tạo 3 đề xuất</button>
  </div>
</form>`;
  document.body.append(dialog);

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;

  let snapshot: RegionSnapshot | undefined;
  let inFlight = false;
  let isOpening = false;
  let openTicket = 0;
  let submitTicket = 0;
  let resetTicket = 0;

  const draw = () => {
    if (!snapshot) return;
    const { assetName, frameIndex, w, h, duration, pivot, mask, snapshotPixels } = snapshot;
    const canvas = $<HTMLCanvasElement>('region-preview');
    canvas.width = w;
    canvas.height = h;

    // Integer zoom with no smoothing inside scrollable preview wrapper
    const scale = Math.max(1, Math.min(16, Math.floor(256 / Math.max(w, h))));
    canvas.style.width = `${w * scale}px`;
    canvas.style.height = `${h * scale}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const bytes = new Uint8ClampedArray(snapshotPixels.length * 4);
    for (let i = 0; i < snapshotPixels.length; i++) {
      const p = snapshotPixels[i];
      bytes[i * 4] = p >>> 24;
      bytes[i * 4 + 1] = (p >>> 16) & 255;
      bytes[i * 4 + 2] = (p >>> 8) & 255;
      bytes[i * 4 + 3] = p & 255;
    }
    ctx.putImageData(new ImageData(bytes, w, h), 0, 0);

    const count = mask.reduce((n, v) => n + (v ? 1 : 0), 0);
    if (count > 0) {
      ctx.fillStyle = '#55cfff66';
      for (let i = 0; i < mask.length; i++) {
        if (mask[i]) {
          ctx.fillRect(i % w, Math.floor(i / w), 1, 1);
        }
      }
    }

    // Anchor cross indicator
    const px = Math.min(w - 1, Math.max(0, pivot.x * w));
    const py = Math.min(h - 1, Math.max(0, pivot.y * h));
    ctx.fillStyle = '#ffcc44';
    ctx.fillRect(Math.round(px) - 2, Math.min(h - 1, Math.round(py)), 5, 1);
    ctx.fillRect(Math.min(w - 1, Math.round(px)), Math.round(py) - 2, 1, 5);

    $('region-source').textContent = `${assetName} · frame ${frameIndex + 1} · ${w}×${h} · ${duration} ms`;

    if (count > 0) {
      $('region-status').textContent = `${count} pixel được chọn để sửa; ngoài vùng giữ đúng RGBA mẫu chuẩn.`;
      $<HTMLButtonElement>('region-submit').disabled = inFlight;
    } else {
      $('region-status').textContent = 'Chưa chọn vùng pixel. Đóng hộp thoại, quay lại canvas và dùng công cụ chọn (M) hoặc đũa thần (W) để chọn vùng cần sửa.';
      $<HTMLButtonElement>('region-submit').disabled = true;
    }
  };

  const open = () => {
    if (isOpening || inFlight) return;
    if (options.isLocked?.()) return;

    const currentOpenTicket = ++openTicket;
    const currentResetTicket = resetTicket;
    isOpening = true;

    void (async () => {
      try {
        await options.prepare();
        if (currentOpenTicket !== openTicket || currentResetTicket !== resetTicket) return;
        if (options.isLocked?.()) return;
        if (options.isParentOpen && !options.isParentOpen()) return;

        const c = options.context();
        if (!c) throw new Error('Chọn asset và dự án trước khi chỉnh sửa vùng.');

        const frameIdx = c.asset.frames.findIndex(f => f.id === c.frameId);
        const targetFrame = c.asset.frames[frameIdx >= 0 ? frameIdx : 0];
        const duration = targetFrame?.duration ?? 100;
        const comp = composite(c.asset, c.frameId);

        // Immutable capture of primitives and pixel copy
        snapshot = {
          projectId: c.projectId,
          assetId: c.asset.id,
          assetName: c.asset.name,
          w: c.asset.w,
          h: c.asset.h,
          frameId: c.frameId,
          frameIndex: frameIdx >= 0 ? frameIdx : 0,
          duration,
          revision: c.revision,
          pivot: c.asset.metadata?.pivot ? { ...c.asset.metadata.pivot } : { x: 0.5, y: 1.0 },
          mask: c.mask ? c.mask.slice() : new Uint8Array(c.asset.w * c.asset.h),
          snapshotPixels: comp.data.slice(),
        };

        $('region-error').textContent = '';
        draw();
        dialog.showModal();
      } finally {
        if (currentOpenTicket === openTicket) {
          isOpening = false;
        }
      }
    })().catch(err => {
      if (currentOpenTicket === openTicket && currentResetTicket === resetTicket) {
        options.onerror(err);
      }
    });
  };

  const trigger = $('ai-region-edit') as HTMLButtonElement | null;
  if (trigger) {
    trigger.onclick = open;
  }

  $('region-close').onclick = () => {
    if (inFlight) return;
    dialog.close();
  };

  $('region-normalize').onclick = () => {
    if (inFlight) return;
    dialog.close();
    void options.normalizeReference().catch(options.onerror);
  };

  dialog.addEventListener('cancel', e => {
    if (inFlight) e.preventDefault();
  });

  dialog.addEventListener('keydown', e => {
    if (inFlight && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  $<HTMLFormElement>('region-form').onsubmit = e => {
    e.preventDefault();
    if (inFlight || !snapshot) return;

    const currentSubmitTicket = ++submitTicket;
    const currentResetTicket = resetTicket;

    void (async () => {
      const prompt = ($<HTMLTextAreaElement>('region-prompt')).value.trim();
      if (!prompt) {
        $('region-error').textContent = 'Vui lòng nhập mô tả chỉnh sửa (1–12.000 ký tự).';
        return;
      }
      const count = snapshot.mask.reduce((n, v) => n + (v ? 1 : 0), 0);
      if (count === 0) {
        $('region-error').textContent = 'Chưa chọn vùng pixel. Hủy hộp thoại, chọn vùng trên canvas rồi mở lại.';
        return;
      }

      const current = options.context();
      if (
        !current ||
        current.projectId !== snapshot.projectId ||
        current.asset.id !== snapshot.assetId ||
        current.frameId !== snapshot.frameId ||
        current.revision !== snapshot.revision ||
        current.asset.w !== snapshot.w ||
        current.asset.h !== snapshot.h
      ) {
        $('region-error').textContent = 'Mẫu hoặc phiên bản đã thay đổi. Đóng và mở lại hộp thoại.';
        return;
      }

      inFlight = true;
      const submitBtn = $<HTMLButtonElement>('region-submit');
      const closeBtn = $<HTMLButtonElement>('region-close');
      const normBtn = $<HTMLButtonElement>('region-normalize');
      submitBtn.disabled = true;
      closeBtn.disabled = true;
      normBtn.disabled = true;
      $('region-error').textContent = '';

      const capturedExpected = {
        projectId: snapshot.projectId,
        assetId: snapshot.assetId,
        frameId: snapshot.frameId,
        revision: snapshot.revision,
        w: snapshot.w,
        h: snapshot.h,
      };
      const binaryMask = Array.from(snapshot.mask).map(v => (v ? 1 : 0));

      try {
        await options.start({
          regionEdit: {
            frameId: capturedExpected.frameId,
            mask: binaryMask,
          },
          prompt,
          expectedSource: capturedExpected,
        });

        if (currentSubmitTicket !== submitTicket || currentResetTicket !== resetTicket) return;
        dialog.close();
      } catch (err) {
        if (currentSubmitTicket !== submitTicket || currentResetTicket !== resetTicket) return;
        $('region-error').textContent = (err as Error).message;
      } finally {
        if (currentResetTicket === resetTicket) {
          inFlight = false;
          closeBtn.disabled = false;
          normBtn.disabled = false;
          const recheck = options.context();
          const valid = recheck &&
            recheck.projectId === snapshot?.projectId &&
            recheck.asset.id === snapshot?.assetId &&
            recheck.frameId === snapshot?.frameId &&
            recheck.revision === snapshot?.revision;
          submitBtn.disabled = !valid || count === 0;
        }
      }
    })().catch(err => {
      if (currentSubmitTicket === submitTicket && currentResetTicket === resetTicket) {
        $('region-error').textContent = (err as Error).message;
      }
    });
  };

  return {
    reset: () => {
      resetTicket++;
      openTicket++;
      submitTicket++;
      isOpening = false;
      inFlight = false;
      snapshot = undefined;
      if (dialog.open) dialog.close();
    },
    close: () => {
      if (dialog.open) dialog.close();
    },
  };
}
