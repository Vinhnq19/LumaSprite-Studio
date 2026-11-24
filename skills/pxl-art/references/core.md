# Pixel construction — experimental revision 3

Draw at the requested native resolution. Explicit canvas, palette, light, mask, pose, frame count and durations override craft suggestions. Do not resize, crop, add colors, or change timing to improve a composition.

Build in three passes within one proposal: recognizable outer shape; coherent material/value masses; a few structural accents. At 1x, the subject and required equipment must read before surface detail. Larger canvases need shaped contours and larger connected planes, not an enlarged tiny icon or a carpet of isolated texture pixels.

Assign existing palette colors to material ramps before drawing. Use a clear base, shadow and optional highlight where the palette permits; reuse colors deliberately. Keep lighting consistent on related planes. Shade with connected clusters that explain volume; avoid parallel bright borders around every shape, random flecks, banding and checker dithering. A purposeful eye or specular pixel is valid. Keep transparency binary unless explicitly requested otherwise.

Use only the supplied pxl API. Drawing ops go directly into sprite(), or use canvas methods inside its callback:
`sprite('proposal',{w:18,h:18},rect(5,3,8,12,'#347647'));`
`sprite('proposal',{w:18,h:18},(c)=>{c.rect(5,3,8,12,'#347647');});`
These illustrate syntax, not a finished design or a palette override. Global `rect()`/`poly()` calls discarded inside a callback do not draw. Never invent APIs; use compact shapes and reusable local functions rather than thousands of explicit pixel calls.

In app mode, make these decisions while composing the JSON-only response: no tool calls, extra critique turn or aesthetic retry. Direct-agent mode may render and inspect at 1x and integer zoom within the authorized target.
