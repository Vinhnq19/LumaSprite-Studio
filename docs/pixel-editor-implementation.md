# Pixel Editor v2 — implementation and verification

The default Studio page is now a native pixel editor. `/legacy.html` retains the v1
procedural-code/overlay workflow. This release does not include `.ase/.aseprite`, tilemap
editing, indexed-color documents, advanced blending or a desktop wrapper.

## Model and persistence

- Shared model, algorithms, patch history and shortcut registry: `src/studio/pixel/`.
  Browser session, canvas and timeline are separate modules in `studio/pixel/`.
- PixelDocument `schemaVersion:2`, `kind:pixel` has stable asset/layer/frame/cel/tag IDs.
  Layer cel maps reference frame IDs and shared cel IDs. RGBA uses packed 0xRRGGBBAA
  Uint32Array values. Wire JSON uses `{$rgba:base64}` of little-endian uint32 bytes.
- Disk manifests reference SHA-256-addressed zlib blobs, written before atomic manifest
  replacement. History keeps 20 manifests and their blobs. Unreferenced app-owned blobs
  have a 24-hour grace period. Backup import validates hashes/lengths, assigns a new
  project ID and preserves history.
- Revision checks protect saves; external manifest changes advance revision. Blob
  checksum verification is cached by file timestamps/size and repeated on change.
  IndexedDB retains drafts; Save copy preserves conflicts. Intact history can recover
  a damaged latest cel. History/backup operations never rewrite the original imported project.
- Undo stores pixel/structural deltas, capped at 100 commands / 64 MiB. Buffers use
  copy-on-write; autosave pauses during pointer gestures. Unmodified pixel cache is
  reclaimed above 64 MiB, excluding the active frame. Thumbnail loads are queued.

## API additions

Existing `/api/studio/*` and CLI workflows remain supported. Pixel writes retain
localhost Host/Origin and workspace/symlink checks.

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/pixel/projects` | List/create, copy drafts, import backups |
| `GET/PUT /api/pixel/projects/:id` | Metadata / revision-checked save |
| `GET .../cel?asset=ID&cel=ID&revision=N` | Lazy RGBA cel load |
| `GET/POST .../history`, `GET .../backup` | History, restore and ZIP backup |
| `POST .../export` | PNG/GIF/strip/atlas/selected ZIP from one revision |
| `POST /api/pixel/from-legacy` | Copy rasterized final v1 assets into a pixel project |
| `POST .../code-preview`, `POST .../apply-proposal` | Worker validation / explicit import as new assets |
| `GET/POST .../ai`, `GET .../ai/:job`, `POST .../ai/:job/cancel`, `POST .../ai/:job/preview` | CLI tasks, native previews, revision-safe apply |
| `POST .../close` | Release watches and owned export/code workers |

SSE reuses `/api/studio/events`: `pixel-saved`, `pixel-external`, `pixel-error`,
`pixel-ai`. AI preserves existing CLI permissions/timeouts/cancellation. Results add
assets, preserve painting and retain source/includes for CodeMirror inspection/editing.

## Verification

```powershell
npm run check
npm run build
npm run test:studio-ui
node scripts/check-examples.js
node scripts/check-package.js
node scripts/check-pixel-performance.js
```

The performance script opens isolated headed Chrome by default. It reports `headless`,
visibility/focus, sample count, p95 draw latency and PNG export time. Set
`PXL_PERF_HEADLESS=1` for a separate diagnostic, never counted as foreground. Timing is
pointer handling to completed Canvas drawing in requestAnimationFrame, excluding physical
display scanout. `PXL_STUDIO_SCREENSHOT` optionally stores a temporary QA screenshot.
Art/projects are temporary and cleaned on exit.

Tests cover resize anchors/scale, linked/independent cels, group opacity and locking,
tag playback/deletion, events, undo, shortcuts, checksum rejection, backup/history restore,
stale proposals, exact PNG/atlas RGBA, mocked CLI protocols, new UI and previous CLI/Studio.

Observed on this Windows machine, 2026-10-19:

- Typecheck and 79/79 Node tests passed; 10/10 Chrome Playwright workflows passed.
- All 13 original examples built into temporary directories and were cleaned afterward.
- Packed npm installation includes native/legacy UI assets, original CLI, and rebuilds
  without devDependencies. No package was published.
- Headed Chrome 155.0.8059.80, visible/focused, 64×64 with 8 layers × 24 frames:
  246 pointer-to-draw samples, p95 **1.7 ms**, median **1.0 ms**. PNG request through
  completed download **1961 ms** in that run, including server reads and worker startup.
  The earlier run before selective cel hydration measured 3492 ms for the same export.
- QA screenshot was visually inspected and deleted. Provider integration uses both mock
  CLI protocols in UI tests; this upgrade did not invoke a live Antigravity worker or
  change CLI/global permissions. The previous real Codex smoke test remains documented
  in the v1 checkpoint; no new live-provider certification is implied.

GIF retains format/encoder limits: indexed colors, binary transparency, 10ms timing units
with a 20ms minimum. PNG/JSON retain full RGBA/native timing respectively. Workers provide
responsiveness/resource limits, not a security sandbox for untrusted JavaScript.

## Tool-switching repair

Reproduced two regressions: a host-consumed Space/Alt keyup kept a temporary tool active
after selecting Pen, and subtracting the whole selection left a zero mask blocking every
brush pixel. Both browser regressions failed before the fix and passed afterward.

Explicit tool changes now release temporary commands, abort unfinished gestures and
release pointer capture. Focus/visibility loss clears temporary state; pointer modifier
flags reconcile a missed Alt keyup. Empty selections are removed, while real selections
remain constrained and show a visible "Bỏ chọn Ctrl+D" action. The toolbar highlights the
effective tool and warns about transparent drawing color.

Validation: typecheck/build and all 80 Node tests passed, including synthetic missing-keyup,
focus/visibility and listener-disposal scenarios. All 13 Chrome Playwright workflows passed,
including switching tools mid-stroke and clearing a real selection. Approval review briefly
blocked the browser run at its usage limit; after the stated reset time, the same review
path approved the rerun. Direct inspection of the user's Codex browser was unavailable
(`iab` provider not connected). No user project data was changed to test this repair.

At the user's request, a live Antigravity prompt-only smoke test returned
`ANTI_OK — prompt received.` in approximately 18 seconds. It requested no tools, commands
or edits and did not resume anti-dev. The CLI warned that auto mode was unavailable for
the account and continued in its default mode; this confirms prompt delivery and response,
not command execution permissions. No CLI/global configuration was changed.

## View preferences and starter palette

New pixel assets receive a 32-color palette. Existing/imported palettes are retained;
the explicit default-palette action adds missing colors without replacing custom colors.
The neutral checkerboard and workspace background are lighter, with local display
preferences for workspace color, checker theme and sidebar width (360 px default,
280–520 px control with a narrower responsive layout). CodeMirror now uses the full
available panel width. The AI panel explains the first-frame reference and new-asset
apply behavior rather than implying direct layer editing.

Build/typecheck and 80 Node tests passed; all 14 Chrome Playwright workflows passed.
The added UI check verifies starter/custom palettes, persistent display preferences,
responsive sidebar width and identical PNG bytes across checker theme changes.
Test projects and output images use temporary storage; no user project was modified.
