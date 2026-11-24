import { luma8 } from '../../core/color.ts';
import type { AssetRecipe, RecipePart } from '../../studio/quality/recipe.ts';
import type { RecipeRenderer } from '../../studio/quality/renderer.ts';

const jointName = /(?:^|[-_])(?:neck|shoulder|pauldron|arm|forearm|hand|glove|gauntlet|grip|hilt|blade|sword|shield|hip|hips|pelvis|leg|thigh|knee|shin|boot|foot)(?:[-_]|$)/i;
const limbName = /(?:^|[-_])(?:arms?|forearms?|hands?|gloves?|gauntlets?|legs?|thighs?|knees?|shins?|boots?)(?:[-_]|$)/i;
const garmentName = /(?:^|[-_])(?:cape|cloak|mantle|coat|skirt)(?:[-_]|$)/i;

interface JointContact {
  part: RecipePart;
  parent: RecipePart;
  shared: number;
  edge: number;
  parentPixels: number;
  partPixels: number;
  visibleEdges: number;
  highContrastEdges: number;
  samples: string[];
}

function garmentBoundaryNotes(recipe: AssetRecipe, visible: Uint8Array, pixels: Map<string, Uint32Array>): string {
  const { w } = recipe.canvas;
  const roles = [null, ...recipe.parts.map(({ id }) => garmentName.test(id) ? 'cloth' : limbName.test(id) ? 'limb' : null)];
  if (!roles.includes('limb') || !roles.includes('cloth')) return '';
  const boundaries = new Map<string, { total: number; low: number; samples: string[] }>();
  for (let i = 0; i < visible.length; i++) {
    const a = visible[i], role = roles[a];
    if (!role) continue;
    for (const j of [i % w + 1 < w ? i + 1 : -1, i + w]) {
      const b = visible[j];
      if (!roles[b] || roles[b] === role) continue;
      const pa = recipe.parts[a - 1].id, pb = recipe.parts[b - 1].id;
      const key = role === 'limb' ? `${pa} / ${pb}` : `${pb} / ${pa}`;
      let edge = boundaries.get(key);
      if (!edge) { edge = { total: 0, low: 0, samples: [] }; boundaries.set(key, edge); }
      edge.total++;
      if (Math.abs(luma8(pixels.get(pa)![i]) - luma8(pixels.get(pb)![j])) >= 24) continue;
      edge.low++;
      if (edge.samples.length < 4) edge.samples.push(`(${i % w},${Math.floor(i / w)})/(${j % w},${Math.floor(j / w)})`);
    }
  }
  const flagged = [...boundaries].filter(([, edge]) => edge.low >= 8 && edge.low * 3 >= edge.total * 2)
    .sort(([, a], [, b]) => b.low - a.low).slice(0, 2);
  if (!flagged.length) return '';
  const notes = flagged.map(([name, { low, total, samples }]) => `${name}: ${low}/${total} cạnh thấy được chênh sáng <24/255 tại ${samples.join(' ')}`);
  return `\nRà tay/chân dễ chìm vào vải ở 1×: ${notes.join(' | ')}. Xem hình trước khi sửa. Nếu khối hòa vào nhau, tách bằng một khe âm hợp tư thế hoặc một mảng sáng/tối liền theo vật liệu, giữ chỗ chồng có chủ ý.`;
}

/** Inspect layer contact near actual pivots without changing the review image or the proposal. */
export function characterJointNotes(recipe: AssetRecipe, renderer: RecipeRenderer): string {
  const { w, h } = recipe.canvas;
  const radius = Math.max(w, h) <= 32 ? 2 : Math.max(w, h) <= 64 ? 3 : 5;
  const parts = new Map(recipe.parts.map(part => [part.id, part]));
  const pixels = new Map(recipe.parts.map(part => [part.id, renderer.staticPartPixels(part.id)]));
  const layerNumbers = new Map(recipe.parts.map((part, index) => [part.id, index + 1]));
  const visible = new Uint8Array(w * h);
  for (const [id, rgba] of pixels) {
    const owner = layerNumbers.get(id)!;
    for (let index = 0; index < rgba.length; index++) if (rgba[index]) visible[index] = owner;
  }
  const contacts: JointContact[] = [];
  for (const part of recipe.parts) {
    if (!part.parentId || !jointName.test(part.id)) continue;
    const parent = parts.get(part.parentId)!;
    const child = pixels.get(part.id)!, upper = pixels.get(parent.id)!;
    if (!child.some(Boolean) || !upper.some(Boolean)) continue;
    const x = Math.round(part.pivot.x), y = Math.round(part.pivot.y);
    const contact: JointContact = { part, parent, shared: 0, edge: 0, parentPixels: 0, partPixels: 0, visibleEdges: 0, highContrastEdges: 0, samples: [] };
    const sameMaterial = part.materialIds.length > 0 && part.materialIds[0] === parent.materialIds[0];
    const childNumber = layerNumbers.get(part.id), parentNumber = layerNumbers.get(parent.id);
    for (let row = Math.max(0, y - radius); row <= Math.min(h - 1, y + radius); row++) {
      for (let col = Math.max(0, x - radius); col <= Math.min(w - 1, x + radius); col++) {
        const index = row * w + col;
        if (upper[index]) contact.parentPixels++;
        if (!child[index]) continue;
        contact.partPixels++;
        if (upper[index]) contact.shared++;
        else if ((col > 0 && upper[index - 1]) || (col + 1 < w && upper[index + 1])
          || (row > 0 && upper[index - w]) || (row + 1 < h && upper[index + w])) contact.edge++;
        if (!sameMaterial || visible[index] !== childNumber) continue;
        const neighbors = [col > 0 ? index - 1 : -1, col + 1 < w ? index + 1 : -1,
          row > 0 ? index - w : -1, row + 1 < h ? index + w : -1];
        for (const next of neighbors) {
          if (next < 0 || visible[next] !== parentNumber) continue;
          contact.visibleEdges++;
          if (Math.abs(luma8(child[index]) - luma8(upper[next])) < 56) continue;
          contact.highContrastEdges++;
          if (contact.samples.length < 4) contact.samples.push(`(${col},${row})/(${next % w},${Math.floor(next / w)})`);
        }
      }
    }
    contacts.push(contact);
  }
  const suspect = contacts.filter(contact => contact.shared <= 1
      || (contact.highContrastEdges >= 2 && contact.highContrastEdges * 2 >= contact.visibleEdges))
    .sort((a, b) => a.shared - b.shared || a.edge - b.edge).slice(0, 4);
  const fabric = garmentBoundaryNotes(recipe, visible, pixels);
  if (!suspect.length) return fabric;
  const notes = suspect.map(({ part, parent, shared, edge, parentPixels, partPixels, highContrastEdges, visibleEdges, samples }) => {
    const location = `(${part.pivot.x},${part.pivot.y})`;
    const contrast = highContrastEdges >= 2
      ? `, ${highContrastEdges}/${visibleEdges} cạnh thấy được cùng vật liệu chênh độ sáng ≥56/255 tại các cặp con/cha như ${samples.join(' ')}` : '';
    return `${part.id} ↔ ${parent.id} ${location}: ${shared} ô chồng, ${edge} ô chạm cạnh (lớp con/cha ${partPixels}/${parentPixels} ô đục)${contrast}`;
  });
  return `\nRà đường ráp ở 1×, dùng tọa độ canvas và cửa sổ bán kính ${radius} px quanh điểm gắn: ${notes.join(' | ')}. Đây là gợi ý xem ảnh. Nếu khớp thật bị hở hoặc viền đứt khối, nối mảng sáng/gốc/bóng qua chỗ ráp trong lớp thích hợp. Giữ khe âm có chủ ý và các bộ phận che khuất đúng phối cảnh.${fabric}`;
}
