# AI generation quality checkpoint

Implemented one-pass pixel generation with three style presets, explicit viewpoint,
server-snapshotted RGBA palette/canvas and opt-in first-frame/source reference. Both CLI
adapters receive the same prompt builder. Normal requests use one CLI call; only malformed
JSON/source/build failures receive the existing single repair. New pixel jobs have a total
180-second cap. Legacy requests retain their previous behavior and timeout configuration.

Raster inspection runs in the worker, covers all frames of exported assets, and checks
empty images, final canvas dimensions, visible color count, palette violations and partial
alpha. Empty/wrong-size images are blocked server-side at Apply. Color issues are warnings.
Underscore-prefixed helper sprites stay in source and are excluded from imported assets.
Rasterized asset palettes come from actual output pixels. Preview has native/integer zoom.

## Live comparison — 2026-10-19

Used the same installed Codex executable (`896a0166b774037a/codex.exe`), account,
environment and default model selection, with no model override or global settings edits.
The CLI did not expose an exact model identifier in the collected output, so this is a
same-configuration comparison rather than independently verified model-version pinning.
Each arm started from an empty canvas with the same subject prompt; the new arm added
the generation configuration with the default 32-color asset palette. No visual refinement
pass was requested. Eight requests covered four pairs. Three diagnostic images initially
selected helper sprites instead of the main output; those were excluded from visual
assessment and regenerated after fixing helper filtering (11 real calls total).

| Subject | Canvas | Old time | New time | Visible colors old/new | New colors outside selected palette |
| --- | --- | ---: | ---: | ---: | ---: |
| Forest knight, tiny | 18×18 | 30.5 s | 25.0 s | 10 / 10 | 0 |
| Forest knight | 64×64 | 46.4 s | 45.2 s | 15 / 12 | 0 |
| Red health potion | 32×32 | 25.7 s | 25.9 s | 11 / 12 | 0 |
| Wooden treasure chest | 48×32 | 32.1 s | 35.6 s | 10 / 7 | 0 |

All four final new outputs used one CLI attempt, matched the requested canvas and had
no partial-alpha pixels or blocking/warning findings. All subject prompts produced
recognizable assets in both arms. The old arm was not instructed to use the new palette;
its palette warnings measure that difference, not a failure of the old renderer.

Visual observations after inspecting nearest-neighbor renders:

- At 18×18 both knights read as hooded characters holding a sword. The new version has
  a tighter dark contour; the old version has a broader face and lighter clothing. The
  new output is not an unambiguous aesthetic improvement at this tiny size.
- At 64×64 the new knight separates face, cloak and boots more clearly, with a stronger
  silhouette and fewer colors. Both retain the requested green hood, visible face,
  sword and standing pose; highlights are coherent rather than diffuse.
- Both potion icons have a cork, red liquid and highlights. The new image has a clearer
  gray glass/white-highlight ramp; the old image's pale cyan glass is also a viable style.
- The new chest uses seven deliberate colors and a clearer central lock/band structure.
  The old chest has more wooden texture and brighter highlights. Both read as closed
  chests with a slight three-quarter view and fit the rectangular canvas.

This small, stochastic sample supports better palette/style control and usable output,
not a universal beauty ranking or a guaranteed speed improvement. No seed control or
live Antigravity image-quality certification is claimed. Antigravity's protocol, reference
delivery and one-call/repair behavior are covered with the local CLI fixture.

## Verification and artifacts

Typecheck/build and 84 Node tests passed. All 15 Chrome Playwright workflows passed,
including configuration, actual palette import, integer preview zoom, color warnings,
blocked empty/outline-size outputs, old API compatibility and stale revision rejection.
All 13 original examples built successfully. The npm package contains native/legacy UI,
the generation modules and docs; installation without devDependencies rebuilds successfully
and the legacy CLI works. Packaged generation API validation is also checked without a live
AI request. No package was published. Test images and projects use temporary storage and are removed
after inspection; user project content is not used by the evaluation.

An additional regression verifies that old proposals retain their original source snapshot
after starting another job with different reference settings on the same project/revision.
The final snapshot fix was covered by all 84 Node tests and a repeat of both AI UI workflows.
