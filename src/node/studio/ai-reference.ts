import type { GenerationContext } from '../../studio/types.ts';

/** Give new art and app-owned animation the exact drawing API they need.
 * Existing arbitrary source edits retain the complete engine reference. */
export function aiReference(full: string, generation?: GenerationContext): string {
  const animation=Boolean(generation?.animation?.referenceFile || generation?.clip?.helperFiles.length);
  if (!generation || !animation && (generation.options.reference || generation.operation)) return full;
  const drawing = `PXL DRAWING API — native pixel coordinates, JavaScript globals, no imports.
pal({k:'#101522',r:'#c35353',h:'#f49a66',w:'#ffffff'}); // example keys; use ONLY the resolved palette
sprite(name,{w,h},...items); Items are drawing ops, grid strings, or(c)=>{c.rect(...);c.px(...)}.
rect(x,y,w,h,color); box(x,y,w,h,color) draws a1px border; px(x,y,color).
line(x0,y0,x1,y1,color,width=1); hline(x,y,length,color); vline(x,y,length,color).
circ(cx,cy,r,color); ring(cx,cy,r,color); ellipse(cx,cy,rx,ry,color); poly([x0,y0,x1,y1,...],color).
grid(x,y,'..kk..\\n.krrk.'); one character per pixel. '.' skips, '_' erases; all other keys must exist in pal().
stamp(name,x,y,opts?); clip([x,y,w,h],...ops); include('relative.px.js') loads another source unchanged.
Colors: one-character palette keys or '#rrggbb'/'#rrggbbaa'. Integer0-based coordinates from top-left.
No auto-outline/crop/scale (outline options grow dimensions); draw outlines INSIDE the canvas. No blur/gradient/dithering or guessed APIs.
Prefer compact ops/functions for repeated forms. Return complete source in JSON files, not tools or a build script.`;
  if(animation)return `${drawing}
ANIMATION API — use the exact public name, dimensions, helpers and timing in the generation contract.
anim(name,{w,h,loop:true,base:'existing_asset'},...items); frame({ms:100},...ops) is an item of anim.
Each explicit frame runs its own ops over shared items/base, NOT over the previous frame. Provide exactly the requested count and duration. loop:false is one-shot.
Use include() for the APP-OWNED helper file named in the request; never return/replace its content. Helper asset names can be stamped or used as base. They are exact approved pixels, not a design to redraw.
Example structure only (substitute requested names/timing): include('owned-reference.px.js'); anim('proposal',{w:32,h:32,loop:true,base:'_owned_reference'},frame({ms:100}),frame({ms:100},rect(12,8,2,1,'_'),px(12,9,'k')));
When the contract specifies per-slot helpers, each frame starts rect(0,0,w,h,'_'),stamp('_pxl_clip_slot_N',0,0), then only edits allowed parts. Erase OLD moving pixels before placing NEW positions. Frozen and unselected slots follow the exact contract; no invented frames or shifted pivots.
Do not alter source/mask/palette/count/dimensions/timing for craft suggestions. The host recomposes locked regions and validates every frame.`;
  return `${drawing}
Define exactly one public sprite with explicit requested w,h; no extra scene or sheet.
sprite('proposal',{w:32,h:32},...items); // example size, use the requested dimensions
Grid rows have equal width. Draw silhouette, material masses, then shadow/highlight clusters. Prefer compact ops/functions for repeated forms; avoid thousands of individual px() calls.
Return complete art.px.js in the required JSON files array, not a build script or tool command.`;
}
