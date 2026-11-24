import type { GenerationContext, ProjectDocument } from '../../studio/types.ts';
import { rgbaHex } from '../../studio/generation.ts';
import type { ArtDirection } from '../../studio/art-direction.ts';
import type { FigureStage } from '../../studio/pixel/figure-review.ts';
import { canonicalSourceKey } from './source-name.ts';

export type PromptTransport = 'cli' | 'http';

export const batchResponseSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    manifest: {
      type: ['object', 'null'],
      properties: {
        version: { type: 'integer' },
        palette: {
          type: ['object', 'null'],
          properties: {
            name: { type: ['string', 'null'] },
            colors: { type: 'array', items: { type: 'string' } },
            ramps: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  colors: { type: 'array', items: { type: 'string' } },
                },
                required: ['name', 'colors'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'colors', 'ramps'],
          additionalProperties: false,
        },
        materials: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              colors: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'colors'],
            additionalProperties: false,
          },
        },
        parts: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              box: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  w: { type: 'number' },
                  h: { type: 'number' },
                },
                required: ['x', 'y', 'w', 'h'],
                additionalProperties: false,
              },
            },
            required: ['name', 'box'],
            additionalProperties: false,
          },
        },
        landmarks: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['name', 'x', 'y'],
            additionalProperties: false,
          },
        },
      },
      required: ['version', 'palette', 'materials', 'parts', 'landmarks'],
      additionalProperties: false,
    },
  },
  required: ['description', 'files', 'manifest'],
  additionalProperties: false,
};

function isOwnedHelperFile(path: string, generation?: GenerationContext): boolean {
  if (generation?.animation?.referenceFile) {
    try {
      if (canonicalSourceKey(generation.animation.referenceFile) === canonicalSourceKey(path)) return true;
    } catch {
      if (generation.animation.referenceFile === path) return true;
    }
  }
  if (generation?.clip?.helperFiles) {
    try {
      const canon = canonicalSourceKey(path);
      if (generation.clip.helperFiles.some(h => canonicalSourceKey(h) === canon)) return true;
    } catch {
      if (generation.clip.helperFiles.includes(path)) return true;
    }
  }
  return false;
}

function promptOutputText(transport: PromptTransport, schemaShape: string): string {
  return transport === 'http'
    ? `Return ONLY JSON matching the supplied INLINE response schema: ${schemaShape}.`
    : `Return ONLY JSON matching response-schema.json: ${schemaShape}.`;
}

function promptImageText(transport: PromptTransport, cliInstruction: string): string {
  return transport === 'http'
    ? 'This is a text-only request: no images, attachments or files are provided, and no image-viewing, file or other local tools are available. Any image reference names below are text labels only: their pixels are not attached to this request and must not be opened or read from the filesystem. Use only the inline captured source, settings and reference text below.'
    : cliInstruction;
}

export function generationBrief(c: GenerationContext, artDirection?: ArtDirection, referenceCountOrNames: number | string[] = 0, transport: PromptTransport = 'cli', figureStage?: FigureStage): string {
  const refNames = Array.isArray(referenceCountOrNames)
    ? referenceCountOrNames
    : Array.from({ length: referenceCountOrNames }, (_, i) => `art-ref-${i + 1}.png`);
  const referenceCount = refNames.length;

  const isClip = Boolean(c.clip);
  const resolvedStyle = (isClip ? c.options.style : artDirection?.style) ?? c.options.style;
  const resolvedPaletteMode = isClip ? 'asset' : (artDirection?.paletteMode ?? c.options.paletteMode);
  const resolvedPalette = isClip
    ? (c.clip!.context.palette.length > 0 ? c.clip!.context.palette : c.palette)
    : ((artDirection?.palette && artDirection.palette.length > 0) ? artDirection.palette : c.palette);
  const resolvedLight = artDirection?.light ?? 'upper-left';

  const styleMap = {
    game: `Readable game sprite: use 2–3 deliberate shades per material, a consistent ${resolvedLight} light, and clear separation of body parts.`,
    'eight-bit': 'Minimal 8-bit sprite: few shades, simple intentional shapes, restrained detail, little or no dithering.',
    'flat-icon': 'Flat pixel icon: bold clear color masses, at most one shadow shade per material, minimal texture.',
  };
  const style = figureStage === 'shape'
    ? 'Use a small set of distinct base colors to separate overlapping forms. Reserve tonal ramps for the finishing pass.'
    : styleMap[resolvedStyle] ?? styleMap.game;
  const view = { description: 'Follow the requested viewing angle in the user description.', front: 'Front view.', side: 'Side view.', 'top-down': 'Top-down view.' }[c.options.view];
  const adLight = (!isClip && artDirection?.light) ? `Lighting preference: ${artDirection.light}.` : '';
  const adDetail = (!isClip && artDirection?.detailLevel) ? `Detail level: ${artDirection.detailLevel}.` : '';
  const adOutline = (!isClip && artDirection?.outline) ? `Outline preference: ${artDirection.outline}.` : '';
  const adRefs = referenceCount > 0
    ? transport === 'http'
      ? `ART DIRECTION REFERENCES (TEXT ONLY): ${referenceCount} approved project reference name(s) listed in the inline context (${refNames.join(', ')}). Their pixels are not attached in this transport; maintain visual harmony, palette balance and style consistency using the inline descriptions.`
      : `ART DIRECTION REFERENCES: ${referenceCount} approved project reference image(s) provided (${refNames.join(', ')}). Maintain visual harmony, palette balance and style consistency with these reference assets.`
    : '';
  const guideIntro = transport === 'http'
    ? 'VISUAL GUIDANCE (text guide description): no guide image is attached in this transport. Use this textual contact-sheet description and the pose/keyframe guidance as the sole guide.'
    : 'VISUAL GUIDANCE (clip-guide.png):\nclip-guide.png is provided as a separate guide image showing contact sheet previews and pose/keyframe landmarks across slots.';

  let operationSection = '';
  if (c.clip) {
    const clipDesc = c.clip;
    const ctx = clipDesc.context;
    const selectedSlots = ctx.slots.filter(s => s.selected);
    const K = selectedSlots.length;
    const N = ctx.slots.length;
    const partsStr = Object.entries(ctx.parts).map(([id, p]) => `${id} ("${p.name}")`).join(', ') || 'none';
    const landmarksStr = Object.entries(ctx.landmarks).map(([id, lm]) => `${id} ("${lm.name}" at (${lm.x},${lm.y})${lm.partId ? ` in part ${lm.partId}` : ''})`).join(', ') || 'none';
    const linksStr = ctx.links.map(l => `${l.from} -> ${l.to}`).join(', ') || 'none';
    const guideLegend = clipDesc.guideMetadata.slots.map(s => `- Slot ${s.order + 1} [id: ${s.id}]: duration ${s.duration} ms, ${s.selected ? 'SELECTED' : 'retained'}, ${s.frozen ? 'FROZEN' : 'unfrozen'}, keyframe: ${s.keyframe}, edited pose: ${s.isEditedPose}`).join('\n');
    const timelineDesc = ctx.slots.map((s, idx) => `- Slot ${idx + 1} of ${N} [id: ${s.id}]: duration ${s.duration} ms${s.frozen ? ' (FROZEN)' : s.selected ? ' (SELECTED for generation)' : ' (RETAINED)'}${s.keyframe ? ' (keyframe)' : ''}`).join('\n');
    const explicitPoseGuidance = selectedSlots.map((s, k) => {
      const gSlot = clipDesc.guideMetadata.slots.find(gs => gs.id === s.id);
      const isEdited = gSlot?.isEditedPose || s.keyframe;
      if (isEdited && s.pose && Object.keys(s.pose).length > 0) {
        const ptStr = Object.entries(s.pose).map(([lm, pt]) => `${lm}: (${Math.round(pt.x)},${Math.round(pt.y)})`).join(', ');
        return `- Slot "${s.id}" (canonical frame ${k + 1} of ${K}): explicit keyframe/edited pose. Landmarks: ${ptStr}. Follow this pose guidance closely for this frame.`;
      }
      return `- Slot "${s.id}" (canonical frame ${k + 1} of ${K}): in-between frame. Maintain continuous motion between adjacent keyframe poses while keeping approved character silhouette and proportions.`;
    }).join('\n');

    const helperUsage = selectedSlots.map((s, k) => `- Slot id "${s.id}" (canonical frame ${k + 1} of ${K}, duration ${s.duration} ms): baseline helper '_pxl_clip_slot_${k}'. Clear canvas with rect(0, 0, ${ctx.w}, ${ctx.h}, '_') then use stamp('_pxl_clip_slot_${k}', 0, 0) as starting pose; erase modified moving pixels explicitly.`).join('\n');

    operationSection = `CLIP REGENERATION FROM APPROVED REFERENCE:
Create exactly ONE public animation asset in your entry file:
${clipDesc.helperFiles.map(h => `include('${h}');`).join('\n')}

anim(${JSON.stringify(ctx.name)}, { w: ${ctx.w}, h: ${ctx.h}, base: '_pxl_clip_master', loop: ${ctx.loop} },
${selectedSlots.map((s, k) => `  frame({ ms: ${s.duration} }, rect(0, 0, ${ctx.w}, ${ctx.h}, '_'), stamp('_pxl_clip_slot_${k}', 0, 0), /* apply edited pixels for this frame */)`).join(',\n')}
);
Canvas: exact ${ctx.w}x${ctx.h} pixels including outline. Fixed pixel pivot: (${ctx.pivot.x}, ${ctx.pivot.y}).
Facing: ${clipDesc.facing}. Template: ${clipDesc.template}.
Loop: ${ctx.loop}.
No automatic mirroring, resize/crop/antialiasing/dithering. Compact context contains no pixel arrays.

TIMELINE AND FRAME CONSTRAINTS:
Total timeline slots: ${N}. Exactly ${K} selected unlocked slot(s) to generate in canonical order.
${timelineDesc}
The app recomposes full ${N} frames and enforces region constraints server-side; do NOT emit retained or frozen frames. Return exactly ${K} frame(s) in canonical selected order.

HELPER ASSETS AND BASELINE USAGE:
App-owned helper files: ${clipDesc.helperFiles.join(', ')}.
Approved master reference: '_pxl_clip_master'.
Per-slot baseline helpers:
${helperUsage}
All helper sources are app-owned and immutable: never return, replace, redefine or edit them. Return only the single public animation asset in your entry source file.

CHARACTER ANATOMY & POSE GUIDANCE:
Parts: ${partsStr}
Landmarks: ${landmarksStr}
Links: ${linksStr}
Default unedited anatomy is design information, not a rigid static pose for each frame. Frozen frame pixel constraints are enforced separately by the server.
Prioritize same approved character design, palette, materials, and lighting across all generated frames; vary motion and pose dynamics, not character identity.
Per-slot pose guidance:
${explicitPoseGuidance}

${guideIntro}
Guide contact sheet layout: ${clipDesc.guideMetadata.cols} cols x ${clipDesc.guideMetadata.rows} rows, total guide image size ${clipDesc.guideMetadata.w}x${clipDesc.guideMetadata.h} pixels.
Slot guide legend:
${guideLegend}
${ctx.mode === 'region' ? 'movement-mask.png is a separate binary mask: white pixels may be edited, black pixels are locked. Only the white edit region is editable; the app restores all pixels outside that region from the approved reference.' : 'Whole-character motion is allowed; preserve character design, materials, proportions and ground contact intentionally.'}`;
  } else if (c.operation === 'region-edit' && c.animation) {
    operationSection = `ONE-FRAME REGION EDIT FROM APPROVED REFERENCE: include('${c.animation.referenceFile}'); use anim('proposal',{base:'_pxl_reference',w:${c.w},h:${c.h},loop:true},frame({ms:${c.animation.duration}},...)). Return exactly 1 frame with duration ${c.animation.duration} ms. The frame starts from the exact reference pixels. The reference source is app-owned and immutable: never return, replace, redefine or edit ${c.animation.referenceFile} or _pxl_reference. Return only the complete entry source and any new helpers. The reference image is the selected source frame, not necessarily frame 1. Keep the fixed anchor at (${c.animation.anchor.x},${c.animation.anchor.y}); do not recenter, crop or rescale frames. movement-mask.png is a separate binary mask: white pixels may be edited, black pixels are locked. preview.png shows the unmodified reference colors; never copy mask colors into the sprite. Only the white edit region is editable. The app restores and locks all pixels outside that region from the approved reference. No animation, movement or sprite sheet.`;
  } else if (c.animation) {
    operationSection = `ANIMATION FROM APPROVED REFERENCE: include('${c.animation.referenceFile}'); use anim('proposal',{base:'_pxl_reference',w:${c.w},h:${c.h},loop:${c.animation.loop}},frame({ms:${c.animation.duration}},...),...). Return exactly ${c.animation.frames} frames, each ${c.animation.duration} ms. Every frame starts from the same exact reference pixels; erase old moving pixels explicitly before drawing a new pose. The reference source is app-owned and immutable: never return, replace, redefine or edit ${c.animation.referenceFile} or _pxl_reference. Return only the complete entry source and any new helpers. The reference image is the selected source frame, not necessarily frame 1. Keep the fixed anchor at (${c.animation.anchor.x},${c.animation.anchor.y}); do not recenter, crop or rescale frames. ${c.animation.mode==='region'?'movement-mask.png is a separate binary mask: white pixels may move, black pixels are locked. preview.png shows the unmodified reference colors; never copy mask colors into the sprite. Only the white movement region is editable. The app restores all pixels outside that region from the approved reference. Include both old and new positions inside the region.':'Whole-character motion is allowed; preserve character design, materials, proportions and ground contact intentionally.'} Keep colors consistent across all frames. No dithering. Prefer frame patches over the common base, never redraw independent character designs.`;
  } else if (c.options.reference) {
    operationSection = 'REFERENCE ENABLED: preview.png shows the first frame of the selected asset. Its source is supplied if available. Use these as visual/content reference; the result is a separate complete asset.';
  } else if (referenceCount > 0) {
    operationSection = transport === 'http'
      ? `REFERENCE DISABLED: the source is an empty starter only. Create fresh art from the request. No source preview is attached; the art reference name(s) (${refNames.join(', ')}) are inline text labels only and their pixels are unavailable in this transport, so use only the inline style descriptions.`
      : `REFERENCE DISABLED: the source is an empty starter only. Create fresh art from the request. While there is no direct source asset preview, use the provided art reference image(s) (${refNames.join(', ')}) as visual and style reference.`;
  } else {
    operationSection = 'REFERENCE DISABLED: the source is an empty starter only. Create fresh art from the request. There is no reference image; do not infer an existing design.';
    if (transport === 'cli' && !figureStage) {
      operationSection += ' Construct a full-body human from the inside out before designing equipment. Unless the requested age, anatomy or stylization specifies otherwise, use an adult mannequin about seven to seven-and-a-half bare heads tall, excluding plumes and helmet trim. In the entry source, lay out crown, chin, shoulder sockets, elbows, wrists, crotch, knees and soles in native pixel coordinates first; derive the visible figure from those marks. Put the crotch near half the standing height, knees halfway down the legs, relaxed elbows near the waist and wrists near the crotch. Start with a shoulder span of roughly two head widths before perspective. Fit armor around those volumes: preserve a neck, tapered wrists and ankles, and modest boots. Even at 32px simplify facial features before enlarging the head or shortening the thighs.';
      operationSection += ' When the brief calls for a standing figure, make the facing direction clear and show the weight shift: plant the supporting foot beneath the loaded hip and bend or set back the free leg. If the figure holds something, show the fingers wrapping around its grip with a gap or value contrast against the torso so the contact reads at native size. Follow any pose specified in the brief.';
      const shortSide = Math.min(c.w, c.h);
      const materialScale = shortSide <= 32
        ? 'Spend pixels on a single light cluster per shiny form and broad shadow shapes; omit seams and speckle.'
        : shortSide <= 64
          ? 'Turn the chest or other rounded forms with a curved midtone and a short off-centre glint. Group cloth into one or two folds; separate overlapping dark forms at their contact.'
          : 'Model the large planes first. Use a few subordinate bevels, fold returns or strap edges to describe their construction; keep quiet areas between them.';
      operationSection += ' For materials present in the brief, follow the selected light: use a sharp reflected band on steel, broad matte folds on cloth, and a subdued edge on leather. ' + materialScale;
    }
  }
  const figureTask = figureStage === 'shape'
    ? 'POSE REVIEW — draw an actual flat-color sprite. Lay out the crown, chin, shoulder sockets, hips, knees, wrists and sole contacts on the native grid before filling the forms. Follow the requested proportions and perspective, including foreshortening. Draw the support and free limbs with distinct contacts, readable joints and intentional negative space. When a hand meets equipment, make the point of contact visible at 1×. Keep each form a coherent color mass. Omit highlights, cast shadows, texture and material shading.'
    : figureStage === 'finish'
      ? 'APPROVED POSE — use preview.png and its exact source coordinates as the painting surface. Keep all edges, openings, limb positions and equipment contacts at their approved coordinates. Shade existing planes with groups of pixels. Use broad matte folds for fabric, short sharper highlights for metal and a sparse reflection for glass when those materials are requested. Place detail around the focal area and adapt it to the canvas size.'
      : figureStage === 'repair'
        ? 'REGION REPAIR — preview.png shows the approved input and movement-mask.png marks editable pixels in white. Keep unmarked pixels exact and retain the silhouette everywhere. Resolve the requested defect only, using the established palette and light direction.'
        : '';

  const targetW = isClip ? c.clip!.context.w : c.w;
  const targetH = isClip ? c.clip!.context.h : c.h;
  return `PIXEL GENERATION SETTINGS — these control dimensions, palette and style even if the user description conflicts:
Target canvas: ${targetW}x${targetH} pixels, exact final output including outline. Create one complete new sprite/animation asset, not a partial overlay. Do not crop, resize, or grow the canvas with outline; draw outlines within its bounds. Use explicit w/h, preserve the requested canvas aspect ratio, and avoid accidental duplicate helper assets.
Style: ${resolvedStyle}. ${style}
View: ${c.options.view}. ${view}
${resolvedPaletteMode === 'asset' ? `Use only these allowed RGBA colors (plus fully transparent): ${resolvedPalette.map(rgbaHex).join(', ')}. Select a coherent subset; do not use every color just because it is available.` : 'Choose a cohesive palette of at most 16 visible RGBA colors total across frames, plus fully transparent.'}
Prioritize a readable silhouette at native resolution, connected intentional pixel clusters${figureStage === 'shape' ? ' and clear separation between forms' : ', coherent color ramps and clear focal details'}. Adapt detail to ${c.w}x${c.h}; at small sizes use fewer features rather than noise. Keep the subject entirely inside the canvas with breathing room where feasible. Transparent background, no unrelated scenery or text. No dithering. No antialiasing, smoothing, blur, gradients or accidental semi-transparent pixels.${figureStage === 'shape' ? '' : ` Use clear highlight/base/shadow clusters with ${resolvedLight} lighting.`}
${adLight} ${adDetail} ${adOutline}
${adRefs}
${operationSection}
${figureTask ? figureTask + '\n' : ''}${figureStage ? 'Return one proposal for this stage in this CLI call; do not perform tool-driven critique, iterative refinement or generate several alternatives.' : transport === 'http' ? 'Return one finished proposal in response to this generation request; do not perform tool-driven critique, iterative refinement or generate several alternatives.' : 'Return one finished proposal in this CLI call; do not perform tool-driven critique, iterative refinement or generate several alternatives.'}`;
}

/** Art instructions shared by the CLI adapters; transport selects the HTTP-safe header wording. */
export function buildAiPrompt(doc: ProjectDocument, request: string, reference: string, repair = '', generation?: GenerationContext, transport: PromptTransport = 'cli'): string {
  const layerContext = Object.fromEntries(Object.entries(doc.pixels).map(([name, layer]) => [name, { enabled: layer.enabled, layout: layer.layout, editedFrames: Object.keys(layer.frames), paintedPixels: Object.values(layer.frames).reduce((sum, f) => sum + Object.keys(f).length, 0) }]));
  const cliImage = generation && !generation.options.reference ? 'No preview image is provided.' : 'You may view the copied preview.png using an image-viewing tool if one is available; no other tool actions are needed.';
  return `You are creating pixel art with pxl. ${promptOutputText(transport, '{description:string,files:[{path,content}]}')} files are complete replacement source files, not diffs. Do not edit files, execute shell commands, invoke subagents, browse websites, install dependencies, or touch any real project. Use only the copied source/context below. ${promptImageText(transport, cliImage)} Use reusable pixel-art DSL. ${generation ? 'Create the new asset specified by the generation settings.' : 'Preserve unrelated art. Keep names/frame dimensions/timings stable when editing.'} The app renders your proposal and the user explicitly applies it.
REQUEST:
${request}
CURRENT SOURCE:
${JSON.stringify(Object.fromEntries(Object.entries(doc.files).map(([path, content]) => [path, isOwnedHelperFile(path, generation) ? 'APP-OWNED EXACT PIXEL REFERENCE: available through include(); content omitted from prompt. Do not modify this file.' : content])))}
PIXEL LAYER LAYOUTS AND METADATA (preserve; edits remain separate):
${JSON.stringify({ pixels: layerContext, metadata: doc.metadata })}
PXL REFERENCE:
${reference}
${generation ? generationBrief(generation, undefined, 0, transport) : ''}
${repair}`;
}

export function buildBatchCandidatePrompt(
  doc: ProjectDocument,
  request: string,
  reference: string,
  candidateIndex: number,
  artDirection?: ArtDirection,
  referenceCountOrNames: number | string[] = 0,
  repair = '',
  generation?: GenerationContext,
  transport: PromptTransport = 'cli',
  figureStage?: FigureStage
): string {
  const refNames = Array.isArray(referenceCountOrNames)
    ? referenceCountOrNames
    : Array.from({ length: referenceCountOrNames }, (_, i) => `art-ref-${i + 1}.png`);
  const layerContext = Object.fromEntries(Object.entries(doc.pixels).map(([name, layer]) => [name, { enabled: layer.enabled, layout: layer.layout, editedFrames: Object.keys(layer.frames), paintedPixels: Object.values(layer.frames).reduce((sum, f) => sum + Object.keys(f).length, 0) }]));
  const candidateHeader = figureStage ? 'Return one static sprite proposal for the current review stage.'
    : generation?.clip
    ? `ALTERNATIVE: ${candidateIndex + 1}\nThis request is candidate alternative ${candidateIndex + 1} of 3 independent sequential proposals. Preserve the exact approved character identity, design, materials, and lighting; vary motion, staging, or frame dynamics across alternatives, not character identity.\nDESIGN MANIFEST: You may optionally include a version 1 design manifest in the manifest property of your response object containing palette (with ramps), materials, parts (bounding boxes within canvas), and landmarks (points within canvas).`
    : `ALTERNATIVE: ${candidateIndex + 1}\nThis request is candidate alternative ${candidateIndex + 1} of 3 independent sequential proposals. Create a distinct creative interpretation matching the request and constraints.\nDESIGN MANIFEST: You may optionally include a version 1 design manifest in the manifest property of your response object containing palette (with ramps), materials, parts (bounding boxes within canvas), and landmarks (points within canvas).`;
  const imageInstruction = generation && !generation.options.reference
    ? (refNames.length > 0
        ? `No source preview.png is provided for fresh creation, but copied art reference image(s) (${refNames.join(', ')}) are provided for visual style guidance. You may view them using an image-viewing tool if one is available.`
        : 'No preview image is provided.')
    : `You may view the copied preview.png${refNames.length > 0 ? ` and art reference image(s) (${refNames.join(', ')})` : ''} using an image-viewing tool if one is available; no other tool actions are needed.`;

  return `You are creating pixel art with pxl. ${promptOutputText(transport, '{description:string,files:[{path,content}],manifest?:{version:1,...}}')} files are complete replacement source files, not diffs. Do not edit files, execute shell commands, invoke subagents, browse websites, install dependencies, or touch any real project. Use only the copied source/context below. ${promptImageText(transport, imageInstruction)} Use reusable pixel-art DSL. ${generation ? 'Create the new asset specified by the generation settings.' : 'Preserve unrelated art. Keep names/frame dimensions/timings stable when editing.'} The app renders your proposal and the user explicitly applies it.
${candidateHeader}
REQUEST:
${request}
CURRENT SOURCE:
${JSON.stringify(Object.fromEntries(Object.entries(doc.files).map(([path, content]) => [path, isOwnedHelperFile(path, generation) ? 'APP-OWNED EXACT PIXEL REFERENCE: available through include(); content omitted from prompt. Do not modify this file.' : content])))}
PIXEL LAYER LAYOUTS AND METADATA (preserve; edits remain separate):
${JSON.stringify({ pixels: layerContext, metadata: doc.metadata })}
PXL REFERENCE:
${reference}
${generation ? generationBrief(generation, artDirection, refNames, transport, figureStage) : ''}
${repair}`;
}
