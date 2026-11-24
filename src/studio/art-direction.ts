import type { PixelDocument } from './pixel/model.ts';
import { type LibraryEntry, validateLibrary } from './asset-library.ts';
import { type StudioResource, validateResourceMap, cloneResourceMap } from './resources.ts';
import { type CharacterProfile, validateCharacterMap, cloneCharacterMap } from './characters.ts';
import { type CharacterClip, validateClipMap, cloneClipMap } from './clips.ts';
import { type TerrainTileset, type TileMap, validateTilesets, validateMapIndex } from './tilemaps.ts';
import { type QualityProject, validateQualityProject } from './quality/project.ts';
import { type RigDraft, validateRigDraftMap } from './quality/rig-draft.ts';
import { type Production, validateProduction } from './production.ts';

export interface ArtDirectionReference {
  assetId: string;
  frameId: string;
}

export interface ArtDirection {
  style?: 'game' | 'eight-bit' | 'flat-icon';
  paletteMode?: 'asset' | 'auto16';
  palette?: number[];
  light?: string;
  detailLevel?: 'low' | 'medium' | 'high';
  outline?: string;
  references?: ArtDirectionReference[];
}

export interface StudioExtension {
  version: 1 | 2;
  artDirection?: ArtDirection;
  library?: Record<string, LibraryEntry>;
  resources?: Record<string, StudioResource>;
  characters?: Record<string, CharacterProfile>;
  clips?: Record<string, CharacterClip>;
  tilesets?: Record<string, TerrainTileset>;
  mapIndex?: Record<string, TileMap>;
  quality?: QualityProject;
  rigDrafts?: Record<string, RigDraft>;
  production?: Production;
}

export const defaultArtDirection: Required<Omit<ArtDirection, 'palette'>> & { palette?: number[] } = {
  style: 'game',
  paletteMode: 'asset',
  light: 'upper-left',
  detailLevel: 'medium',
  outline: 'dark',
  references: [],
};

const idPattern = /^[\w-]{1,80}$/;

export function validateArtDirection(value: unknown, doc?: PixelDocument): ArtDirection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chỉ đạo nghệ thuật phải là một object.');
  }
  const v = value as Record<string, unknown>;
  const allowed = ['style', 'paletteMode', 'palette', 'light', 'detailLevel', 'outline', 'references'];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new Error(`Thuộc tính chỉ đạo nghệ thuật '${k}' không được hỗ trợ.`);
  }

  const out: ArtDirection = {};

  if (v.style !== undefined) {
    if (typeof v.style !== 'string' || !['game', 'eight-bit', 'flat-icon'].includes(v.style)) {
      throw new Error('Phong cách nghệ thuật không hợp lệ (hỗ trợ: game, eight-bit, flat-icon).');
    }
    out.style = v.style as ArtDirection['style'];
  }

  if (v.paletteMode !== undefined) {
    if (typeof v.paletteMode !== 'string' || !['asset', 'auto16'].includes(v.paletteMode)) {
      throw new Error('Chế độ palette không hợp lệ (hỗ trợ: asset, auto16).');
    }
    out.paletteMode = v.paletteMode as ArtDirection['paletteMode'];
  }

  if (v.palette !== undefined) {
    if (!Array.isArray(v.palette) || v.palette.length > 4096 || v.palette.some(c => !Number.isInteger(c) || c < 0 || c > 0xffffffff)) {
      throw new Error('Palette chỉ đạo nghệ thuật không hợp lệ (cần mảng số nguyên RGBA 32-bit tối đa 4096 màu).');
    }
    out.palette = [...v.palette];
  }

  if (v.light !== undefined) {
    if (typeof v.light !== 'string' || !v.light.trim() || v.light.length > 50) {
      throw new Error('Hướng sáng không hợp lệ (chuỗi 1–50 ký tự).');
    }
    out.light = v.light.trim();
  }

  if (v.detailLevel !== undefined) {
    if (typeof v.detailLevel !== 'string' || !['low', 'medium', 'high'].includes(v.detailLevel)) {
      throw new Error('Mức độ chi tiết không hợp lệ (hỗ trợ: low, medium, high).');
    }
    out.detailLevel = v.detailLevel as ArtDirection['detailLevel'];
  }

  if (v.outline !== undefined) {
    if (typeof v.outline !== 'string' || !v.outline.trim() || v.outline.length > 50) {
      throw new Error('Thiết lập đường bao không hợp lệ (chuỗi 1–50 ký tự).');
    }
    out.outline = v.outline.trim();
  }

  if (v.references !== undefined) {
    if (!Array.isArray(v.references)) throw new Error('Tham chiếu chỉ đạo nghệ thuật phải là mảng.');
    if (v.references.length > 3) throw new Error('Tối đa 3 tham chiếu asset/frame được chọn.');

    const refs: ArtDirectionReference[] = [];
    const seen = new Set<string>();

    for (const r of v.references) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Tham chiếu phải là object chứa assetId và frameId.');
      const ref = r as Record<string, unknown>;
      if (typeof ref.assetId !== 'string' || !idPattern.test(ref.assetId) || typeof ref.frameId !== 'string' || !idPattern.test(ref.frameId)) {
        throw new Error('ID asset hoặc frame trong tham chiếu không hợp lệ.');
      }
      const pairKey = `${ref.assetId}:${ref.frameId}`;
      if (seen.has(pairKey)) throw new Error('Tham chiếu bị trùng lặp asset và frame.');
      seen.add(pairKey);

      if (doc) {
        const asset = doc.assets.find(a => a.id === ref.assetId);
        if (!asset) throw new Error(`Asset tham chiếu '${ref.assetId}' không tồn tại trong dự án.`);
        if (!asset.frames.some(f => f.id === ref.frameId)) {
          throw new Error(`Frame tham chiếu '${ref.frameId}' không tồn tại trong asset '${ref.assetId}'.`);
        }
      }

      refs.push({ assetId: ref.assetId, frameId: ref.frameId });
    }
    out.references = refs;
  }

  return out;
}

export function validateStudioExtension(value: unknown, doc?: PixelDocument): StudioExtension {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extension studio phải là một object.');
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1 && v.version !== 2) {
    throw new Error('Phiên bản extension studio không được hỗ trợ.');
  }
  const allowed = ['version', 'artDirection', 'library', 'resources', 'characters', 'clips', 'tilesets', 'mapIndex', 'quality', 'rigDrafts', 'production'];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new Error(`Thuộc tính extension studio '${k}' không được hỗ trợ.`);
  }

  if ((v.version === 1 && v.quality !== undefined) || (v.version === 2 && v.quality === undefined)) throw new Error('Dữ liệu duyệt chất lượng cần extension studio phiên bản 2.');
  if (v.rigDrafts !== undefined && v.version !== 2) throw new Error('Nháp rig cần extension studio phiên bản 2.');
  const out: StudioExtension = { version: v.version as 1 | 2 };
  if (v.artDirection !== undefined) {
    out.artDirection = validateArtDirection(v.artDirection, doc);
  }
  if (v.library !== undefined) {
    out.library = validateLibrary(v.library, doc);
  }
  if (v.resources !== undefined) {
    validateResourceMap(v.resources);
    out.resources = cloneResourceMap(v.resources as Record<string, StudioResource>);
  }
  if (v.characters !== undefined) {
    out.characters = validateCharacterMap(v.characters, doc);
  }
  if (v.clips !== undefined) {
    out.clips = validateClipMap(
      v.clips,
      doc,
      v.characters as Record<string, CharacterProfile> | undefined,
      v.resources as Record<string, StudioResource> | undefined
    );
  }
  if (v.tilesets !== undefined) out.tilesets = validateTilesets(v.tilesets, doc);
  if (v.mapIndex !== undefined) out.mapIndex = validateMapIndex(v.mapIndex, out.tilesets, out.resources);
  if (v.quality !== undefined) out.quality = validateQualityProject(v.quality, out.resources);
  if (v.rigDrafts !== undefined) out.rigDrafts = validateRigDraftMap(v.rigDrafts, out.resources);
  if (v.production !== undefined) out.production = validateProduction(v.production, doc, out.mapIndex);
  return out;
}

export function resolveArtDirection(ad?: ArtDirection, docPalette?: number[]): Required<ArtDirection> {
  return {
    style: ad?.style ?? defaultArtDirection.style,
    paletteMode: ad?.paletteMode ?? defaultArtDirection.paletteMode,
    palette: ad?.palette ? [...ad.palette] : (docPalette ? [...docPalette] : []),
    light: ad?.light ?? defaultArtDirection.light,
    detailLevel: ad?.detailLevel ?? defaultArtDirection.detailLevel,
    outline: ad?.outline ?? defaultArtDirection.outline,
    references: ad?.references ? structuredClone(ad.references) : [],
  };
}
