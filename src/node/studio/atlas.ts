import { Img } from '../../studio/raster.ts';

interface Item { name: string; img: Img; ms: number }
interface Placement { x: number; y: number }

export function spriteSheet(items: readonly Item[], strip: boolean) {
  if (!items.length) throw new Error('Sprite sheet needs at least one frame.');
  const margin = strip ? 0 : 1;
  const longest = Math.max(...items.map(item => item.img.w + 2 * margin));
  const area = items.reduce((sum, { img }) => sum + (img.w + 2 * margin) * (img.h + 2 * margin), 0);
  const target = strip ? items.reduce((sum, item) => sum + item.img.w, 0)
    : Math.min(4096, Math.max(longest, Math.ceil(Math.sqrt(area))));
  const order = items.map((item, index) => ({ item, index }));
  if (!strip) order.sort((a, b) => b.item.img.h - a.item.img.h);

  let width = 0;
  let left = 0;
  let top = 0;
  let shelf = 0;
  const placements: Placement[] = [];
  for (const { item: { img }, index } of order) {
    const w = img.w + 2 * margin;
    if (left + w > target) {
      top += shelf;
      shelf = 0;
      left = 0;
    }
    placements[index] = { x: left + margin, y: top + margin };
    left += w;
    width = Math.max(width, left);
    shelf = Math.max(shelf, img.h + 2 * margin);
  }

  const height = top + shelf;
  if (!strip && (width > 4096 || height > 4096)) throw new Error('Atlas exceeds the 4096 px limit.');
  const sheet = new Img(width, height);
  const frames = Object.fromEntries(items.map(({ name, img, ms }, index) => {
    const { x, y } = placements[index];
    const { w, h } = img;
    for (let row = -margin; row < h + margin; row++) {
      const sourceY = Math.min(h - 1, Math.max(0, row));
      for (let col = -margin; col < w + margin; col++) {
        const sourceX = Math.min(w - 1, Math.max(0, col));
        sheet.data[(y + row) * width + x + col] = img.get(sourceX, sourceY);
      }
    }
    return [name, {
      frame: { x, y, w, h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h }, sourceSize: { w, h }, duration: ms,
    }];
  }));
  return { sheet, frames };
}
