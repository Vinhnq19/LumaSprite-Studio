# Palette normalization and reference animation

Implemented 2026-10-20. RGBA document schema remains version 2. Existing legacy
viewer and generation requests without new options retain their previous protocol.

## Pixel guarantees

- Rasterization uses the requested canvas directly. Empty, wrong-size, wrong-count,
  wrong-duration and wrong-loop animation proposals cannot be applied. There is no
  automatic resizing, cropping, singleton cleanup, smoothing or silhouette repair.
- Normalization is explicit and creates an immutable variant. Asset palettes use
  deduplicated opaque colors; auto16 uses one frequency histogram over all frames,
  weighted median-cut and observed representative colors. With a reference, auto16
  is fixed from the approved reference instead of the generated frames.
- Colors map to nearest OKLab, with palette order resolving equal distances. Conversion
  uses [Ottosson's original matrices](https://bottosson.github.io/posts/oklab/).
  Alpha below the selected threshold becomes zero; alpha at/above it becomes 255.
  No dithering is added. A nonempty image with no opaque target color is rejected.
- Region mode requires a nonempty selection, at the current source revision and exact
  canvas size. All output pixels outside it are replaced with the captured visible-layer
  composite. Raw AI output remains view-only. The server compares every outside pixel
  again before applying; it does not trust the client or a prior quality report.
- Reference preflight requires compatible palette and binary alpha for region mode,
  and for auto16 animation in either mode. A separate local reference-normalization
  proposal lets the user approve a copy; the source asset is never changed implicitly.

The immutable `_pxl_reference.px.js` contains run-length pixel drawing commands derived
from the actual composite. Its content is omitted from the prompt. Both CLI adapters
receive the unmodified preview and, in region mode, a separate white/black movement
mask image. The prompt requires `include` plus `base` frame patches. Replacing the
app-owned reference file is rejected as a code error. Existing one-call plus at most
one JSON/code repair policy and 180-second total AI budget remain in place. Local
processing makes no provider calls.

## Modules and temporary data

`processing.ts` contains color mapping, exact baked source, bounds and diagnostics;
`processing-worker.ts` handles capture, normalization, composition, lazy frame and
overlay generation. `VariantStore` persists compressed cels in an owned temporary
directory. `Proposals` manages ownership, revision checks, worker jobs and a 128 MiB
LRU frame cache. Browser proposal frames have a separate 32 MiB limit.

Metadata/SSE messages contain no cel RGBA arrays. Requested frames are fetched
individually; processing still necessarily hydrates all frames to build a common
histogram. There are at most 20 proposal records and 8 variants per proposal; old
normalizations are discarded first. Workers are stopped before project/server
cleanup removes temporary variants. Closing or switching a project discards previews,
not applied assets. Applied assets persist in the normal project cel store/history.

Processed assets contain exact reconstructable `.px.js` source and optional provenance
(original AI source, palette/alpha parameters, source asset/frame/revision, anchor and
mode). The renderer, saved cels and PNG/atlas export use the same final RGBA. The
source-file cap remains 2 MiB; a highly complex image whose exact baked source exceeds
1.9 million characters gets a clear error rather than a lossy or un-rebuildable save.
The existing canvas, frame and 32-million-cel-pixel limits also apply.
GIF retains its format limits: binary transparency, at most 256 palette entries and
centisecond timing. PNG/atlas RGBA and JSON millisecond timing are the exact outputs;
GIF cannot preserve arbitrary partial alpha or every millisecond duration.

## API additions

All routes below are under `/api/pixel/projects/:projectId`. Mutations require the
configured Origin and the current project revision.

- `POST ai`: `generationOptions.animation` accepts `frameId`, `mode: region|whole`,
  `frames` (2–24), `duration` (1–60000 ms), `loop`, pixel-coordinate `anchor: {x,y}`
  and a binary `mask` array in region mode. Palette/dimensions are server-derived.
  The public job's animation config omits the mask.
- `POST ai/:jobId/preview` with `variants:true`: returns `proposalId`, compact
  `variants`, `selectedVariantId`, generation and reference metadata. Animation
  requests always use this protocol, preventing an old preview route from bypassing
  region protection. Old non-animation preview requests retain their old shape.
- `POST code-preview` supports `variants:true`; legacy responses remain available.
- `GET proposals/:proposalId?revision=N`: list variants, quality and statistics.
- `GET proposals/:proposalId/variants/:variantId/frame?revision=N&asset=ID&frame=ID`:
  load one RGBA frame. Optional `overlay=singletons|checkerboards|movement|difference`
  and `against=raw|reference` return a diagnostic layer. Overlays do not affect export.
- `POST proposals/:proposalId/normalize`: `{revision,alphaThreshold}` → HTTP 202
  processing job. `GET processing/:jobId` and `pixel-processing` SSE report completion
  or error. No artificial progress percentage is supplied.
- `POST reference-proposal`: `{revision,assetId,frameId,generationOptions}` creates
  a local sample for normalization and explicit application as a new asset.
- `POST apply-proposal`: optional `variantId`; omitted still selects the original.
  Region originals are blocked. Stale revisions return 409, invalid variants 422.

## Validation

Automated checks cover palette determinism/shared histogram, alpha boundaries,
duplicates/no opaque colors, exact baked source, reference immutability and one repair,
both fixture adapters, protected pixels after apply/reload/export, PNG/atlas decoding,
one-shot GIF/JSON timing, stale proposals, invalid masks and reference preflight.
Chrome Playwright covers normalization/original comparison/application and both
animation modes including no-selection blocking, playback, onion-skin and overlays.

Validation on this Windows machine passed typecheck, all 90 Node tests, all 19 Chrome
Playwright workflows and all 13 original examples. The npm package (145 files) was
extracted and rebuilt without devDependencies; native/legacy UI, legacy CLI, new
processing module and lazy proposal/frame API were verified. No package was published.

Live evaluation uses `node scripts/check-animation-quality.js codex --review` with
three requests in a temporary project: eye blink and tail wave with region protection,
then whole-character walk-in-place. Results and visual findings are recorded below
after inspection. No user project or global CLI setting is modified.

### Live observations, 2026-10-20

The same installed Codex executable and CLI default model selection were used for
three 32×32 cat animations, four frames each, 100 ms/frame, loop enabled. Model/seed
pinning is not claimed. Every result was normalized with the approved five-color
reference palette, previewed, and applied only to a temporary project.

| Motion | Mode | End-to-end time | CLI attempts | Outside-mask changes | Bottom drift |
| --- | --- | ---: | ---: | ---: | ---: |
| Blink | Region | 28.4 s | 1 | 0 | 0 px |
| Tail wave | Region | 28.5 s | 1 | 0 | 0 px |
| Walk-in-place | Whole | 64.8 s | 2 | N/A | 0 px |

The walk used the existing single validation-repair opportunity. Local normalization
made no extra AI calls. All final outputs had four frames at the requested size/timing,
five visible colors, binary alpha and no mechanical quality warnings. Blink normalization
replaced two pixels that introduced extra shades; tail/walk pixels already matched the
approved palette. Both region sequences preserved every outside-mask pixel.

The 3× nearest-neighbor contact sheet was inspected. Blink retained the full character
and changed the tiny eye area; the visual blink is subtle at this scale. The tail had
distinct left/right contours while the head/body/feet stayed fixed. Walk retained the
head/body and ground-contact row, but its thin, broken-looking leg shapes need manual
art review and cleanup before production. No numerical warning detected that aesthetic
weakness. Correct palette, bounds and timing are not a guarantee of natural motion.

The contact sheet, intermediate images, source files and temporary projects were
removed after inspection. Live Antigravity animation quality is not certified; both
adapter protocols and mask/reference delivery are tested with the local CLI fixture.
