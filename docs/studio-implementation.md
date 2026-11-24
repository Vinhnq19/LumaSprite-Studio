# Studio implementation checkpoint

This file records the original v1 code/overlay implementation. The default page has since
been upgraded to the native [Pixel Editor v2](pixel-editor-implementation.md); v1 remains
available at `/legacy.html`.

User-approved implementation, 2026-10-19. Codex-only; no anti-dev workflow dispatch.
Existing edits in bin/pxl.js, package.json, test_art.px.js and start-viewer.bat are preserved.

- [x] Project persistence, revisions/history/import and worker rendering
- [x] Studio code editor, preview/download and pixel tools
- [x] Codex/Antigravity proposal adapters with explicit apply/cancellation
- [x] Animation/atlas export correctness and lazy/cache behavior
- [x] Automated regression, API, export and browser verification
- [ ] Live Antigravity acceptance check (intentionally not invoked while this chat is Codex-only)

The existing game-feasibility directory is historical, not the Studio implementation.
Tests and screenshots must use temporary directories and clean up their generated images.

## Verification evidence

- Windows, Node v22.15.0; existing compatibility changes kept, no runtime upgrade.
- `npm run check`: TypeScript + **68/68 Node tests passed**. Includes original 59 tests,
  pixel propagation through stamps, revisions/external writes/history, symlink and include boundaries,
  worker timeout/queued cancellation, PNG atlas UV/extrusion, crop alignment, loop/one-shot,
  metadata ZIP, both fake CLI protocols, stale proposals, structural AI changes and export ownership.
- `npm run test:studio-ui`: **5/5 Chrome Playwright flows passed** (latest run ~24.7s):
  source/pixel/undo/download/reopen/atlas; two CLI proposals with explicit apply/history;
  frame/selection/fill/flip/trace; external-write draft recovery; layer toggle/resize/rebase.
- The earlier three UI scenarios also passed three repetitions (9/9) while investigating save races.
- `node scripts/check-examples.js`: **13/13 bundled examples exported**, no previews, temporary outputs removed.
- `node scripts/check-package.js`: actual temporary npm pack/extract, **103 packaged files**;
  prebuilt UI, legacy CLI and rebuild without devDependencies all passed. Nothing published.
- `node scripts/smoke-studio-ai.js codex`: **real Codex CLI passed** proposal generation,
  build validation, no write before Apply, explicit Apply to revision 2 and history creation.
- UI screenshot was visually reviewed from the temporary directory, then removed.
- `git diff --check` passed. Historical test-output directories in the repo still contain zero PNG/GIFs.

## Integration notes and remaining validation

- The Antigravity adapter preserves existing CLI execution flags/settings, uses a copied working
  directory and a request file to avoid Windows command-line limits. Its JSON envelope, error,
  cancellation and apply behavior have been exercised with a real subprocess fixture; real account,
  tool availability and image-viewing behavior remain **unverified**, respecting the user's anti-dev off.
- This is a local implementation build; no v1 release is declared until that live provider acceptance
  criterion is met. Enabling the provider inside the product and resuming anti-dev development are separate actions.
- Chrome UI checks ran headless. API responsiveness during looping art is tested (<500ms assertion),
  but no foreground GPU/FPS or hardware-wide brush latency guarantee is claimed.
- Pixel editing is post-render, separate from source. Crop/size/timing/name changes require explicit
  rebase or disabling the old layer. Structural AI proposals preserve old pixel data and show a warning.
- Studio enforces one-page 4096px atlases; legacy shelf strips retain their prior size behavior so
  cave/grotto examples remain compatible. Export format includes additive `meta.pxl` game metadata.
- Render workers/VM are resource and responsiveness boundaries, not a security sandbox for arbitrary
  untrusted programs. Studio binds only to localhost and validates write origins/workspace paths.
- CLI login, quota and OS permission errors are surfaced; no silent provider switch, global config edits,
  permission bypass beyond the pre-existing Antigravity selection, commits or pushes were performed.

## Entry points

- `npm run studio` / `node bin/pxl.js studio --root DIR --port N`.
- Windows: `start-studio.bat` after initial build.
- User guide: `docs/STUDIO.md`.
- New Studio API: `/api/studio/projects`, project `build/frame/atlas/export/history/backup/ai/close`,
  `/api/studio/builds/:job`, `/api/studio/ai/:job` (including cancel/apply/frame), providers/logs/events.
- Studio project schemaVersion 1; pixel/metadata sidecars, optimistic revision saves, last 20 snapshots.
- Optional core Project `transform` hook, GIF `loop` option, sheet packing/extrusion options and
  additive `meta.pxl` export data; original commands and default art DSL remain supported.
