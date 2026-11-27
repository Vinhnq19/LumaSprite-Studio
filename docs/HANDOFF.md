# LumaSprite Studio — HANDOFF

- **Branch:** `antigravity/e8-4-native-scene-adapter` (branched from `origin/main` `593650101ed0cd2a54d045197911fc5b7a8bdd83`)
- **Milestone:** E8.4 Native Scene Adapter & Production Workspace Integration
- **Status:** `E8_4_READY_FOR_OWNER_STUDIO_SCENE_REVIEW`
- **Authorization State:** E8.4 Studio Adapter `AUTHORIZED` · E8.5 End-to-End Production Acceptance `NOT YET AUTHORIZED` · Engine Production Defaults `UNCHANGED` · Game-ready Artistic Approval `PENDING`
- **Engine Reference (READ-ONLY):** `D:\LumaSprite-Engine` (`codex/e8-3-runtime-interaction-hardening` @ `74c6e7722d92e5570977cd7760e6130c771c9179`), Unity Runtime Sandbox READ-ONLY.

## What Was Delivered in E8.4
1. **Lossless Native Scene Contract (`src/studio/native-scene.ts`, `src/studio/production.ts`):**
   - Extends existing `Production` v1 with optional `nativeScenes` (100% backward compatible with Studio v1/v2 projects).
   - Preserves all 15 Engine metadata groups (`schemaVersion=1`, tilemap/ids/columns/cellCount, layer order/at/pivot/occlusion stats, RLE walkableRows, collisionBoxes & colliders, actors, props, interactions, PPU, origin, source provenance & style/profile refs) inside `engineSnapshot`.
   - Protects `engineSnapshot` via `protectedSha256` and `PixelStore.saveDocument` (`HTTP 409 PROTECTED_ENGINE_SOURCE`); all Studio edits live strictly in `studioState`.
2. **Engine Importer / Unity-Compatible Exporter / PNG Codec (`src/node/studio/png.ts`, `native-scene-io.ts`, `native-scene-api.ts`):**
   - Lossless `decodePng` (RGBA/RGB/Indexed+PLTE+tRNS/Gray/Gray+Alpha, all 5 filters + CRC32).
   - Imports both `e8-runtime` and `e76r-b2` packages with SHA-256 verification and strict rejection of all 10 negative failure modes.
   - Re-import on changed `sourceRevision` sets `approval.status = 'STALE'` and records `SOURCE_REVISION_CHANGED`.
   - Exports ZIP matching Unity `E8Contract.cs` (`validateUnityE8SceneData` verified) plus `studio-scene-sidecar.json` & `export-manifest.json`; blocks `requireApproved` export until explicitly human-approved (`UNREVIEWED` by default).
3. **Production Workspace UI (`studio/pixel/native-scene-panel.ts`, `production-workspace.ts`):**
   - Added tab `Scene Engine (E8.4)` inside `ProductionWorkspace` with composite/ground/foreground/atlas view modes, integer zoom (`1×/2×/4×`), toggleable Tile Grid, Collision, Walkable, Actors & Props, Interaction Anchors (`at`, `stand`, `label`, `kind`, linked entity, ID, revision), Foreground/Occlusion overlays, layer visibility toggles, controlled actor/interaction editing, Undo/Redo, Human Review, and ZIP Export.
4. **QA & Portable Report:**
   - `npm run typecheck`: PASS
   - `npm run build`: PASS
   - `npm test`: **107/107 PASS** (real fixtures: 6 E8 + 6 E7.6R packages with 0-pixel RGBA diff; 10/10 negative cases; round-trip)
   - `npm run test:studio-ui`: **47/47 PASS** (Chrome Playwright E2E)
   - Portable report: [docs/reports/E8.4-STUDIO-NATIVE-SCENE-ACCEPTANCE.html](reports/E8.4-STUDIO-NATIVE-SCENE-ACCEPTANCE.html)
