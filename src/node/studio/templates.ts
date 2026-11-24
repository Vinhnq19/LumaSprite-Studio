export const templates: Record<string, string> = {
  sprite: `pal({ k: '#172333', g: '#70c989', G: '#34765a', w: '#eff5d6' })
sprite('slime', { mx: true, outline: 'k' }, \`
  ..ggg
  .ggGg
  ggGwg
  gggkg
  .GGGG
\`)
sheet('atlas', ['slime'], { pad: 1 })
`,
  blank: `pal({ k: '#172333', w: '#ffffff', g: '#70c989' })
sprite('canvas', { w: 32, h: 32 })
sheet('atlas', ['canvas'], { pad: 1 })
`,
  animation: `pal({ k: '#172333', g: '#70c989', w: '#eff5d6' })
anim('bounce', { w: 24, h: 24, frames: 8, fps: 8 }, c => {
  const y = 13 - Math.round(Math.sin(c.phase * Math.PI * 2) * 5)
  c.ellipse(12, y, 7, 5, 'g')
  c.px(10, y - 1, 'k'); c.px(14, y - 1, 'k')
  c.px(9, y - 3, 'w')
})
sheet('atlas', ['bounce'], { pad: 1 })
`,
  scene: `pal({ s: '#172333', g: '#34765a', b: '#70c9c9', w: '#eff5d6' })
sprite('tree', { w: 16, h: 24 }, rect(7, 12, 3, 12, 's'), circ(8, 8, 7, 'g'))
scene('garden', { w: 128, h: 80, bg: 'b' },
  layer('ground', rect(0, 48, 128, 32, 'g')),
  layer('trees', stamp('tree', 20, 28), stamp('tree', 90, 30)),
  layer('sun', circ(92, 15, 7, 'w')))
sheet('atlas', ['tree'], { pad: 1 })
`,
};
