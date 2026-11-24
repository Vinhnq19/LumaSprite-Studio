---
name: pxl-art
description: Create and modify pixel art sprites, character animations, and autotiled game terrains using pxl Node DSL or JSON proposals with disciplined pixel-level craft.
---

# pxl-art: Pixel Art Craft and DSL Engine

Expert craft guidance and execution rules for authoring clean, idiomatic pixel art assets.

Repository references currently contain experimental revision 3. Evaluate actual rendered output before recommending it as the host application's default; this skill does not grant permission to change that default.

## Reference Routing
Always load [core.md](references/core.md) alongside exactly one topic reference matching the active task:
- Static characters, props, items, and directional sprites: [sprite.md](references/sprite.md)
- Walk cycles, run cycles, and loop timing: [animation.md](references/animation.md)
- Tiles, seamless surfaces, terrain transitions, and autotiles: [terrain.md](references/terrain.md)

## Modes of Operation

### 1. App Mode
When invoked inside host application pipelines:
- Output **ONLY** the structured JSON proposal adhering strictly to the host schema.
- **NEVER** run shell commands, file modifications, subagent launches, automated multi-turn critique loops, or additional AI provider calls.

### 2. Direct Agent Mode
When running directly in the workspace environment:
- Execute `pxl` commands using the repository Node CLI:
  - `node <project>/bin/pxl.js list [file]`
  - `node <project>/bin/pxl.js build [file] [--only <name>]`
  - `node <project>/bin/pxl.js ascii [file] <name>`
- Inspect rendered visual previews at 1× native resolution and clean integer zoom factors (2×, 4×, 8×).
- Confine all source modifications and rendered outputs strictly to the isolated target path requested for the task.
- **NEVER** overwrite manual user art or assets outside the designated target.

## Precedence and Constraints
1. **User Configuration First**: User-specified canvas dimensions, palette ramps, timing, frame budgets, and masks take absolute precedence over generic craft heuristics.
2. **Strict Canvas Integrity**: Maintain declared canvas dimensions and animation timing. Never automatically expand or crop canvases to accommodate weapons, accessories, or outlines. If an element exceeds boundaries, report the clipping risk explicitly.
3. **Immutability of Frozen Regions**: Pixels outside active editable masks and designated frozen frames are strictly read-only.
4. **Raster Layer Boundary**: Do not invent or assume reconstructed layers from flattened raster sources.
5. **Craft Freedom**: Avoid dogmatic restrictions. Pure black, pure white, asymmetric silhouettes, and intentional single-pixel specular highlights are valid when purposefully chosen.
6. **Self-Contained Engine**: Pxl DSL engine syntax and options are documented in the repository's `reference.md` and root `SKILL.md`. Never require external skill dependencies or make claims regarding system timeouts.
