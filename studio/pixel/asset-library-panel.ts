import type { PixelDocument, PixelAsset } from '../../src/studio/pixel/model.ts';
import {
  type LibraryKind,
  type GroupedAsset,
  type GroupedLibrary,
  groupDocumentAssets,
  getAssetLibraryInfo,
} from '../../src/studio/asset-library.ts';

export interface AssetLibraryPanelOptions {
  doc: PixelDocument;
  activeAssetId: string;
  selectedAssets: Set<string>;
  onSelectAsset: (assetId: string) => void | Promise<void>;
  onDeleteAsset: (assetId: string) => void | Promise<void>;
  onOpenMap?: (mapId: string) => void | Promise<void>;
  onToggleExport: (assetId: string, selected: boolean) => void;
}

export function renderAssetLibraryPanel(
  container: HTMLElement,
  options: AssetLibraryPanelOptions
): void {
  container.replaceChildren();
  const { doc, activeAssetId, selectedAssets, onSelectAsset, onDeleteAsset, onToggleExport } = options;

  if (!doc || !doc.assets.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-list-empty';
    empty.textContent = 'Chưa có asset';
    container.append(empty);
    return;
  }

  const grouped: GroupedLibrary = groupDocumentAssets(doc);

  const categories: { kind: LibraryKind; label: string; groups: GroupedAsset[] }[] = [
    { kind: 'character', label: 'Nhân vật', groups: grouped.characters },
    { kind: 'object', label: 'Đồ vật', groups: grouped.objects },
    { kind: 'tileset', label: 'Tileset', groups: grouped.tilesets },
  ];

  for (const cat of categories) {
    const section = document.createElement('div');
    section.className = 'asset-category-section';
    section.dataset.kind = cat.kind;

    const totalAssetsInCat = cat.groups.reduce((sum, g) => sum + g.versions.length, 0);

    const header = document.createElement('div');
    header.className = 'asset-category-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'asset-category-title';
    titleSpan.textContent = cat.label;
    const countBadge = document.createElement('span');
    countBadge.className = 'asset-category-count';
    countBadge.textContent = String(totalAssetsInCat);
    header.append(titleSpan, countBadge);
    section.append(header);

    if (cat.groups.length === 0) {
      const catEmpty = document.createElement('div');
      catEmpty.className = 'asset-category-empty';
      catEmpty.textContent = 'Trống';
      section.append(catEmpty);
    } else {
      for (const group of cat.groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'asset-group';
        groupEl.dataset.groupId = group.groupId;
        if (group.versions.length > 1) {
          groupEl.classList.add('has-versions');
        }

        for (const item of group.versions) {
          const asset = item.asset;
          const version = item.version;

          const row = document.createElement('div');
          row.className = 'asset-row';
          row.dataset.assetId = asset.id;

          const check = document.createElement('input');
          check.type = 'checkbox';
          check.checked = selectedAssets.has(asset.id);
          check.setAttribute('aria-label', `Chọn xuất ${asset.name}`);
          check.onchange = () => onToggleExport(asset.id, check.checked);

          const b = document.createElement('button');
          b.className = 'asset-name-btn';
          b.textContent = asset.name;
          b.title = asset.name;
          b.classList.toggle('active', asset.id === activeAssetId);
          b.onclick = () => {
            void onSelectAsset(asset.id);
          };

          const badge = document.createElement('span');
          badge.className = 'asset-version-badge';
          badge.textContent = `v${version}`;
          badge.setAttribute('aria-label', `Phiên bản ${version}`);
          badge.title = `Phiên bản ${version}`;

          const remove = document.createElement('button');
          remove.className = 'asset-delete';
          remove.textContent = '×';
          remove.title = `Xóa ${asset.name} · Ctrl+Z để khôi phục${
            doc.assets.length === 1 ? ' · Tạo canvas trống cùng kích thước' : ''
          }`;
          remove.setAttribute('aria-label', `Xóa asset ${asset.name}`);
          remove.onclick = () => {
            void onDeleteAsset(asset.id);
          };

          row.append(check, b, badge, remove);
          groupEl.append(row);
        }

        section.append(groupEl);
      }
    }

    container.append(section);
  }
  const maps = document.createElement('div'); maps.className = 'asset-category-section'; maps.dataset.kind = 'map';
  const heading = document.createElement('div'); heading.className = 'asset-category-header'; heading.textContent = `Bản đồ · ${Object.keys(doc.studio?.mapIndex ?? {}).length}`; maps.append(heading);
  for (const map of Object.values(doc.studio?.mapIndex ?? {})) {
    const button = document.createElement('button'); button.className = 'asset-name-btn'; button.textContent = `${map.name} · ${map.w}×${map.h}`; button.dataset.mapId = map.id; button.onclick = () => { void options.onOpenMap?.(map.id); }; maps.append(button);
  }
  container.append(maps);
}
