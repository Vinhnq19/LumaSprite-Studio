import { Img } from '../../src/core/image.ts';
import { createMap, getMap, MapStroke, registerTileset } from '../../src/studio/map-commands.ts';
import { celFor, duplicateFrame, newAsset, newDocument, type PixelAsset, type PixelDocument } from '../../src/studio/pixel/model.ts';
import { emptyProduction, productionKind } from '../../src/studio/production.ts';
import { productionCatalog } from '../../src/node/studio/production-worker.ts';
import { assembleTerrain } from '../../src/studio/terrain.ts';

type Raster = { w: number; h: number; data: Uint32Array };
export const rpgIds = { hero: 'hero-main', sword: 'sword-prop', potion: 'potion-item', atlas: 'grass-atlas', map: 'village-map', set: 'grass-set', idle: 'hero-idle' };
export const rpgAgentToken = 'fixture-agent-token-not-a-user-secret-v1';
const inks = { outline: 0x212937ff, grass: 0x486956ff, moss: 0x527a5aff, dark: 0x355748ff, light: 0xd2bd86ff, red: 0xdc7263ff, blue: 0x508196ff };

function fromRaster(id: string, name: string, image: Raster): PixelAsset {
  const asset = newAsset(name, image.w, image.h);
  asset.id = id;
  asset.palette = [0, ...new Set(image.data)].filter((ink, index, all) => all.indexOf(ink) === index);
  celFor(asset, asset.layers[0].id, asset.frames[0].id, true)!.data = image.data;
  return asset;
}
function sprite(w: number, h: number, mask: (x: number, y: number) => number): Img {
  const out = new Img(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(x, y, mask(x, y));
  return out;
}

export function productionRpgFixture(references?: { sword: Raster; potion: Raster }, extras = 0) {
  const material = sprite(16, 16, (x, y) => (x * 7 + y * 9) % 19 < 3 ? inks.moss : (x + y * 3) % 17 < 2 ? inks.dark : inks.grass);
  const terrain = assembleTerrain(material.data, { tileSize: 16, inset: 2, sampling: 'repeat' });
  const atlas = fromRaster(rpgIds.atlas, 'Cỏ làng', terrain);
  const heroPose = (pose: number) => sprite(24, 32, (x, y) => {
    if (y >= 2 && y <= 13 && x >= 6 && x <= 17) return x === 6 || x === 17 || y < 5 ? inks.outline : y === 10 && x > 13 ? inks.outline : inks.light;
    if (y >= 14 && y <= 24 && x >= 4 && x <= 19) return x <= 6 || x > 17 || y === 24 ? inks.outline : y === 15 + pose ? inks.red : inks.blue;
    if (y > 24 && y <= 29 + pose && (x >= 6 && x <= 10 || x >= 13 && x <= 17)) return inks.outline;
    return 0;
  });
  const hero = fromRaster(rpgIds.hero, 'Lữ khách', heroPose(0));
  const frame = duplicateFrame(hero, hero.frames[0].id, 'blank');
  hero.frames[0].duration = 100; hero.frames[1].duration = 180;
  celFor(hero, hero.layers[0].id, frame, true)!.data = heroPose(1).data;
  hero.tags = [{ id: rpgIds.idle, name: 'idle', from: hero.frames[0].id, to: frame, direction: 'forward', loop: true }];
  hero.metadata = { pivot: { x: .5, y: 30 / 32 }, hitbox: { x: 6, y: 13, w: 13, h: 17 } };
  const sword = fromRaster(rpgIds.sword, 'Khiên làng', references?.sword ?? sprite(16, 16, (x, y) => {
    const halfWidth = y < 10 ? 5 : 14 - y;
    if (y < 2 || y > 13 || Math.abs(x - 8) > halfWidth) return 0;
    return y === 2 || Math.abs(x - 8) === halfWidth ? inks.outline : x < 8 ? inks.light : inks.blue;
  }));
  const potion = fromRaster(rpgIds.potion, 'Bình thuốc', references?.potion ?? sprite(16, 16, (x, y) => y > 4 && y < 14 && x >= 4 && x <= 11 ? y > 8 ? inks.red : inks.light : 0));
  const doc = newDocument('Mini Pixel RPG Production Project');
  doc.assets = [hero, sword, potion, atlas, ...Array.from({ length: extras }, (_, i) => newAsset(`Kho vật phẩm ${i + 1}`, 16, 16, inks.grass))];
  doc.studio = { version: 1, artDirection: { palette: [...new Set(doc.assets.flatMap(asset => asset.palette))], light: 'upper-left', outline: 'dark' },
    library: { [hero.id]: { kind: 'character', groupId: hero.id, version: 1 }, [atlas.id]: { kind: 'tileset', groupId: atlas.id, version: 1 } } };
  registerTileset(doc, atlas.id, atlas.frames[0].id, 16, 'Cỏ làng', rpgIds.set);
  createMap(doc, rpgIds.set, 'Quảng trường', 14, 10, rpgIds.map);
  const map = getMap(doc, rpgIds.map), stroke = new MapStroke(doc, map.id, map.layers[0].id);
  for (let y = 1; y <= 8; y++) for (let x = 1; x <= 12; x++) if (!(y === 1 && (x < 3 || x > 10))) stroke.set(x, y, 1, true);
  stroke.commit();
  return doc;
}

/** Call after saving the initial fixture so stamps address persisted cel and map blobs. */
export function setupRpgProduction(doc: PixelDocument): void {
  const catalog = productionCatalog(doc), settings = doc.studio!.production = emptyProduction();
  settings.profiles.push({ id: 'rpg-style', name: 'Bảng màu làng', view: '3/4', pixelScale: 2, lockPalette: true,
    direction: { palette: doc.studio!.artDirection!.palette, light: 'upper-left', outline: 'dark',
      references: [{ assetId: rpgIds.sword, frameId: doc.assets.find(a => a.id === rpgIds.sword)!.frames[0].id }] } });
  settings.assets = doc.assets.map(asset => ({ assetId: asset.id, kind: productionKind(doc, asset.id), profileId: null, approved: catalog.assets[asset.id].stamp }));
  settings.collections.push({ id: 'release-pack', name: 'Gói RPG', assets: [rpgIds.hero, rpgIds.potion], profileId: 'rpg-style' });
  settings.scenes.push({ id: 'village', name: 'Quảng trường', mapId: rpgIds.map, mapSha256: catalog.maps[rpgIds.map], placements: [
    { id: 'sword-placement', assetId: rpgIds.sword, x: 58, y: 60, stamp: catalog.assets[rpgIds.sword].stamp, tagId: null },
    { id: 'potion-placement', assetId: rpgIds.potion, x: 122, y: 76, stamp: catalog.assets[rpgIds.potion].stamp, tagId: null },
    { id: 'hero-placement', assetId: rpgIds.hero, x: 92, y: 95, stamp: catalog.assets[rpgIds.hero].stamp, tagId: rpgIds.idle },
  ] });
}
