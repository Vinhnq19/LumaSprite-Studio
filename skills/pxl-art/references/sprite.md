# Sprite shape and material decisions

Choose a silhouette that communicates the requested subject, view and pose. Do not force a frontal idle character into a dramatic stance or 3/4 view. Deliberate symmetry can support an icon; asymmetry can distinguish equipment when the brief allows it.

Compose the whole object, including weapons and outline, inside the fixed canvas. Leave readable space around important contours. Separate a sword from the body, a hand from a held prop, and the feet from each other through negative space or decisive overlap. Avoid near-tangent outlines that merge distinct parts.

For characters, establish head, shoulder/torso, pelvis, hands and feet as connected masses before drawing a face or clothing folds. Vary limb contours at joints so arms and legs do not become uniform bars. Scale proportions to the requested style and available pixels; do not mandate one head-to-body ratio. At 18px, suggest a face with a few pixels; at 64–128px, shape cheeks, hood opening and fabric planes instead of just multiplying the tiny design.

For an inventory item, prioritize its defining structure: bottle neck versus body, visible contents, cork and a restrained glass highlight. Keep a highlight on the lit plane rather than tracing the full contour. Remove decorative marks that compete with recognition at native size.

Draw outlines inside the canvas using the resolved outline setting. Use dark internal separation only where forms overlap; avoid boxing every material patch into equally thick borders. Highlights, broad middle values and shadow masses should describe distinct planes rather than nested concentric shapes. Keep material ramps and light direction consistent across accessories.

For a naturally proportioned character at 64–128px, start with a ONE native-pixel external outline. Larger canvas does not imply thicker ink. Avoid several nested black polygons around hood, face, arms, belt and boots: that creates a chunky toy-like result. Interior folds use a material's shadow color, not another black contour. Reserve a second dark pixel for an intentional overlap/cast shadow. Keep mouth and eyes economical rather than enclosing the whole face in a thick ring. Explicit chunky/chibi styling still takes precedence.

One optional way to obtain a single-pixel inward contour on NEW high-resolution art is to draw filled masses first, then collect opaque pixels touching transparency and recolor only those. Supported pxl callback methods are `c.w`, `c.h`, `c.is(x,y,'*')` for opaque, `c.is(x,y,'.')` for transparent, and `c.px(x,y,color)`. Collect coordinates before writing; do not call the canvas-growing outline option. Do not run this over approved reference pixels, small delicate features or locked regions.

With a reference, preserve its identifying colors, silhouette, equipment side and proportions unless the request changes them. Mirroring a direction must not silently swap asymmetric equipment or reverse established lighting.
