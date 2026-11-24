// Explicit live evaluation: eight real CLI requests, never part of npm test.
// --review waits on stdin so the caller can inspect the temporary contact sheet,
// then cleans all images after Enter. It does not apply to any user project.
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ProjectStore } from '../dist/node/studio/store.js';
import { AiManager, detectProviders } from '../dist/node/studio/ai.js';
import { startRender } from '../dist/node/studio/runner.js';
import { wireParse, composite } from '../dist/studio/pixel/model.js';
import { defaultPalette } from '../dist/studio/pixel/palette.js';
import { defaultGenerationOptions } from '../dist/studio/generation.js';
import { Img } from '../dist/core/image.js';
import { glyph } from '../dist/core/font.js';
import { encodePng } from '../dist/node/png.js';

const provider = process.argv[2];
if (!['codex', 'antigravity'].includes(provider)) { console.error('Usage: node scripts/check-ai-quality.js codex|antigravity [--review] (8 real AI requests)'); process.exit(2); }
const cases = [
  { name: 'CHARACTER 18', w: 18, h: 18, prompt: 'A tiny friendly forest knight, green hood and cloak, visible face, short silver sword in the right hand. Standing front view, full body, readable at native size, transparent background.' },
  { name: 'CHARACTER 64', w: 64, h: 64, prompt: 'A friendly forest knight, green hood and cloak, leather boots and belt, visible face, short silver sword in the right hand. Standing front view, full body, readable at native size, transparent background.' },
  { name: 'ITEM 32', w: 32, h: 32, prompt: 'A red health potion game inventory icon: small glass bottle, cork stopper, red liquid and one clear highlight, centered, transparent background.' },
  { name: 'PROP 48X32', w: 48, h: 32, prompt: 'A closed wooden treasure chest with golden metal bands, slightly three-quarter front view. Wide rectangular silhouette, centered, transparent background.' },
];
const only = process.argv.find(a => a.startsWith('--case='))?.slice(7).split(',');
const arms = process.argv.find(a => a.startsWith('--arms='))?.slice(7).split(',') ?? ['old', 'new'];
if (!arms.length || arms.some(a => !['old', 'new'].includes(a))) throw new Error('Arms must be old,new');
const root = mkdtempSync(join(tmpdir(), 'pxl-ai-quality-')), results = [], pictures = [];
let ai;
const label = (image, text, x, y) => { for (const ch of text) { const g = glyph(ch); for (let yy = 0; yy < g.length; yy++) for (let xx = 0; xx < g[yy].length; xx++) if (g[yy][xx] === '#') image.set(x + xx, y + yy, 0xe0e7efff); x += g[0].length + 1; } };
try {
  const providers = await detectProviders(); if (!providers[provider].available) throw new Error(providers[provider].message);
  // Pin the same executable, environment and default model selection for both arms.
  const store = new ProjectStore(join(root, 'projects'));
  ai = new AiManager(store, () => {}, { [provider]: providers[provider].path, timeout: 180000 });
  console.log(JSON.stringify({ provider, executable: providers[provider].path, modelSelection: 'same CLI default, no model override', directory: root }));
  for (const item of cases.filter(c => !only || only.includes(c.name.replaceAll(' ', '-')))) {
    const pair = [];
    for (const arm of arms) {
      let doc = store.create(`${item.name} ${arm}`, 'blank');
      doc = store.save(doc.id, doc.revision, { files: { [doc.entry]: `sprite('proposal',{w:${item.w},h:${item.h}})` } });
      const generation = { options: { ...defaultGenerationOptions }, assetId: 'evaluation', w: item.w, h: item.h, palette: [...defaultPalette] };
      const started = performance.now();
      const prompt = arm === 'new' ? item.prompt : `${item.prompt}\nCreate a complete new asset, not a partial overlay. Target canvas ${item.w}x${item.h}. The attached preview shows the current hand-painted image.`;
      const job = await ai.start(doc, provider, prompt, undefined, arm === 'new' ? generation : undefined);
      while (['running', 'validating', 'canceling'].includes(job.status)) await new Promise(r => setTimeout(r, 250));
      if (job.status !== 'ready') throw new Error(`${item.name} ${arm}: ${job.message}`);
      const task = startRender({ document: ai.candidate(job.id), mode: 'generation-preview', generation });
      const raster = await task.promise, data = wireParse(Buffer.from(raster.data).toString('utf8'));
      const first = data.assets.find(a => !a.name.startsWith('_') && a.w === item.w && a.h === item.h) ?? data.assets.find(a => !a.name.startsWith('_'));
      if (!first) throw new Error('No exported primary asset to review');
      const image = composite(first, first.frames[0].id);
      writeFileSync(join(root, `${item.name.replaceAll(' ', '-')}-${arm}.png`), encodePng(image)); pair.push(image);
      const result = { case: item.name, arm, ms: Math.round(performance.now() - started), attempts: job.attempt, dimensions: `${image.w}x${image.h}`, quality: data.quality };
      results.push(result); console.log(JSON.stringify(result));
      if (store.load(doc.id).revision !== doc.revision) throw new Error('Evaluation changed a project before Apply');
    }
    pictures.push({ item, pair });
  }
  const width = 680, height = pictures.reduce((sum, { pair }) => sum + Math.max(...pair.map(p => p.h)) * 4 + 32, 24);
  const sheet = new Img(width, height); sheet.data.fill(0x454b56ff); label(sheet, arms.map((a, i) => `${a.toUpperCase()} - ${i ? 'RIGHT' : 'LEFT'}`).join('     ') + '     4X NEAREST', 12, 8);
  let y = 24;
  for (const { item, pair } of pictures) {
    arms.forEach((arm, i) => label(sheet, item.name + ' ' + arm.toUpperCase(), i ? 350 : 12, y));
    pair.forEach((p, i) => sheet.blit(p.scale(4), i ? 350 : 12, y + 14)); y += Math.max(...pair.map(p => p.h)) * 4 + 32;
  }
  const contactSheet = join(root, 'comparison.png'); writeFileSync(contactSheet, encodePng(sheet)); writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
  if (process.argv.includes('--review')) {
    console.log(JSON.stringify({ contactSheet, review: 'Inspect images, then send Enter or create REVIEW_DONE in this temporary directory to clean all artifacts. Automatic cleanup after 10 minutes.' }));
    await new Promise(r => {
      const finish = () => { clearInterval(poll); clearTimeout(deadline); process.stdin.pause(); r(); };
      const poll = setInterval(() => { if (existsSync(join(root, 'REVIEW_DONE'))) finish(); }, 250);
      const deadline = setTimeout(finish, 600000);
      process.stdin.once('data', finish); process.stdin.resume();
    });
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  await ai?.close();
  if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error('Refusing cleanup outside temporary directory');
  rmSync(root, { recursive: true, force: true }); console.log(JSON.stringify({ cleaned: true, results: results.length }));
}
