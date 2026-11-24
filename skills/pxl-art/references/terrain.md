# Tiles, Terrains, and Autotiling

Tiles repeat across large surfaces. Any distinct visual flaw or isolated high-contrast pixel repeats into an obvious grid pattern.

## Seamless Tile Construction
- **Master Wrap**: Author the base tile with wrapping edges. Offset the canvas by half width and half height to expose edge seams in the center, paint out seam artifacts, and offset back.
- **3×3 Repetition Check**: Always preview tiles tiled in a 3×3 grid at native 1x resolution. Never judge a standalone square in isolation.
- **Eliminating Unintended Grids**:
  - Avoid high-contrast single spots or noisy focal points that draw the eye.
  - Avoid value gradients that fade across a single tile dimension.
  - Allow natural pixel clusters to cross edges so forms connect smoothly.
- **Seamless Variants**: Keep outer 1–2 border pixels identical to the master tile so all variants join seamlessly. Vary only the interior features across 3–4 alternates.

## Layering and Subdued Contrast
- **Quiet Surfaces**: Background and floor tiles must maintain lower contrast and saturation than foreground sprites and characters.
- **Decal Layering**: Place detail tufts, rocks, cracks, and patches on transparent overlays above base terrain rather than baking unique combinations into separate full tiles.
- **Consistent Shadows**: Cast wall and ledge shadows uniformly (typically 1 tile length maximum), aligned strictly to upper-left key lighting.

## Transitions and Edges
- **Composite Masking**: Build transitions directly from the two adjoining base tiles using a transition mask. Both sides naturally match their respective terrain without mismatched repainting.
- **Boundary Continuity**: Align transition boundary contours at consistent edge entry and exit offsets (e.g. 5 pixels from corner) so adjacent transition tiles snap together without jagged seams.
- **Directional Boundary Pass**:
  - Light from upper-left: 1px dark edge along upper terrain border.
  - 1px light rim along edges facing north or west.
  - 1px cast shadow on lower terrain along edges facing south or east.

## Autotile Set Layouts
- **9-Slice**: Ideal for UI boxes, platforms, and clean rectangular structures (corners, edges, center).
- **4-Bit (16 Tiles)**: Connects cardinal lines, pipes, roads, and walls with 4-directional adjacency.
- **Blob47**: Diagonal neighbors count only when both adjacent cardinals exist, reducing256 masks to47 shapes. pxl uses an8×6 atlas:47 canonical shapes plus one spare. Use pxl's own mask order (N=1,E=2,S=4,W=8,NE=16,SE=32,SW=64,NW=128), not an imported engine's tile ordering. Generate one material proposal; the host assembles transitions locally, not47 separate AI designs.
