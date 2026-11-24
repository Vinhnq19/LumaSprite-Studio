import type { CharacterClip } from '../../src/studio/clips.ts';
import { drawClipRaster } from './clip-pose-view.ts';

/** Only visible cells request pixels; cached thumbnails contain at most 64² pixels. */
export class ClipTimelineView {
  private observer?: IntersectionObserver;
  private ticket = 0;
  private cache = new Map<string, HTMLCanvasElement>();
  private host: HTMLElement;
  constructor(host: HTMLElement) { this.host = host; }
  reset(): void { this.ticket++; this.observer?.disconnect(); this.host.replaceChildren(); this.cache.clear(); }
  show(clip: CharacterClip, active: string, keys: Map<string, string>, w: number, h: number,
    load: (resourceId: string) => Promise<Uint32Array | undefined>, select: (slotId: string) => void): void {
    this.ticket++; this.observer?.disconnect(); this.host.replaceChildren();
    const ticket = this.ticket;
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.observer?.unobserve(entry.target);
        const button = entry.target as HTMLButtonElement, id = button.dataset.resource!, key = keys.get(id)!;
        const canvas = button.querySelector('canvas')!;
        const draw = (image: HTMLCanvasElement) => {
          canvas.width = image.width; canvas.height = image.height;
          canvas.getContext('2d')!.drawImage(image, 0, 0);
        };
        const cached = this.cache.get(key);
        if (cached) { draw(cached); continue; }
        void load(id).then(data => {
          if (ticket !== this.ticket || !data || !button.isConnected) return;
          const image = document.createElement('canvas'); drawClipRaster(image, data, w, h, Math.min(1, 64 / Math.max(w, h)));
          while (this.cache.size >= 48) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, image); draw(image);
        }).catch(() => { if (ticket === this.ticket) button.title = 'Chưa tải được thumbnail; chọn frame để xem lỗi.'; });
      }
    }, { root: this.host, rootMargin: '64px' });
    for (let i = 0; i < clip.slots.length; i++) {
      const slot = clip.slots[i], button = document.createElement('button');
      button.type = 'button'; button.dataset.clipSlot = slot.id; button.dataset.resource = slot.rgbaResourceId;
      button.className = 'clip-slot' + (slot.id === active ? ' active' : '');
      button.setAttribute('aria-pressed', String(slot.id === active));
      button.title = `Frame ${i + 1} · ${slot.frozen ? 'Đóng băng' : slot.selected ? 'Tạo lại bằng AI' : 'Giữ nguyên'}`;
      const image = document.createElement('canvas'); image.width = image.height = 32;
      const label = document.createElement('span'); label.textContent = `${i + 1} · ${slot.duration} ms`;
      const badges = document.createElement('small'); badges.textContent = `${slot.frozen ? '🔒' : slot.selected ? '✓ AI' : 'Giữ'}${slot.keyframe ? ' · ◆' : ''}`;
      button.append(image, label, badges); button.onclick = () => select(slot.id); this.host.append(button); this.observer.observe(button);
    }
  }
}
