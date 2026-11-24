import { newDocument, type PixelDocument } from '../src/studio/pixel/model.ts';
import { registerTileset, createMap } from '../src/studio/map-commands.ts';

export function mapFixture(w = 65, h = 34): PixelDocument {
  const doc = newDocument('Bản đồ thử', 128, 96);
  registerTileset(doc, doc.assets[0].id, doc.assets[0].frames[0].id, 16, 'Đất', 'ground');
  createMap(doc, 'ground', 'Khu rừng', w, h, 'forest'); return doc;
}
