import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { generationOptions, defaultGenerationOptions, inspectGeneration } from '../src/studio/generation.ts';
import { buildAiPrompt, generationBrief } from '../src/node/studio/ai-prompt.ts';
import { newAsset, newDocument, celFor, wireParse, wireStringify } from '../src/studio/pixel/model.ts';
import { serveStudio } from '../src/node/studio/server.ts';
import { fastHttpFixture } from './fixtures/fast-http.ts';
import { renderDocument, type ExportResult } from '../src/node/studio/render.ts';
import type { GenerationContext, ProjectDocument, AiJob } from '../src/studio/types.ts';

const context = (): GenerationContext => ({ options: { ...defaultGenerationOptions }, assetId: 'asset', w: 18, h: 24, palette: [0, 0x70c989ff, 0xffffffff] });
test('AI generation: validated presets and prompt use exact canvas/RGBA without changing the request', () => {
  const c = context(), doc: ProjectDocument = { schemaVersion: 1, id: 'p', revision: 1, name: 'Test', entry: 'art.px.js', files: { 'art.px.js': "sprite('proposal',{w:18,h:24})" }, pixels: {}, metadata: {} };
  assert.deepEqual(generationOptions({}), defaultGenerationOptions);
  for (const value of [null, [], 'game', { style: '__proto__' }, { view: 'bad' }, { paletteMode: 16 }, { paletteMode: ['asset'] }, { reference: 'false' }, { palette: [] }]) assert.throws(() => generationOptions(value));
  for (const style of ['game', 'eight-bit', 'flat-icon'] as const) for (const view of ['description', 'front', 'side', 'top-down'] as const) {
    c.options = { ...defaultGenerationOptions, style, view };
    const p = buildAiPrompt(doc, 'hiệp sĩ — giữ tiếng Việt', 'REFERENCE');
    assert.ok(p.includes('hiệp sĩ — giữ tiếng Việt')); assert.ok(!p.includes('PIXEL GENERATION SETTINGS'));
    const enhanced = buildAiPrompt(doc, 'hiệp sĩ', 'REFERENCE', '', c);
    assert.match(enhanced, /Target canvas: 18x24/); assert.ok(enhanced.includes(`#70c989ff`)); assert.ok(enhanced.includes('Style: '+style)); assert.ok(enhanced.includes('View: '+view));
    assert.match(enhanced, /No preview image is provided/); assert.match(enhanced, /No antialiasing/);
  }
  c.options.reference = true; assert.match(generationBrief(c), /REFERENCE ENABLED/);
  c.options.paletteMode = 'auto16'; assert.match(generationBrief(c), /at most 16 visible RGBA colors/);
});

test('figure stages keep the pixel settings and ask for work specific to each stage', () => {
  const c = context();
  const shape = generationBrief(c, undefined, 0, 'cli', 'shape');
  assert.match(shape, /Target canvas: 18x24/);
  assert.match(shape, /Omit highlights, cast shadows, texture and material shading/);
  assert.doesNotMatch(shape, /highlight\/base\/shadow|2–3 deliberate shades|seven-to|seven-and-a-half/);
  c.options.reference = true;
  const finish = generationBrief(c, { light: 'upper-right' }, 0, 'cli', 'finish');
  assert.match(finish, /approved coordinates/);
  assert.match(finish, /with upper-right lighting/);
  assert.match(generationBrief(c, undefined, 0, 'cli', 'repair'), /movement-mask\.png marks editable pixels in white/);
  assert.match(generationBrief(c), /highlight\/base\/shadow/);
});

test('standing pose guidance is limited to fresh CLI sprites without references', () => {
  const c = context(), cue = /plant the supporting foot/;
  assert.match(generationBrief(c), cue);
  assert.doesNotMatch(generationBrief(c, undefined, 0, 'http'), cue);
  assert.doesNotMatch(generationBrief(c, undefined, ['guide.png']), cue);
  c.options.reference = true;
  assert.doesNotMatch(generationBrief(c), cue);
});

test('fresh CLI sprites budget material details by the shorter native dimension', () => {
  const c = context();
  for (const [w, h, cue] of [[128, 32, /single light cluster/], [64, 64, /curved midtone/], [128, 128, /subordinate bevels/]] as const) {
    Object.assign(c, { w, h });
    assert.match(generationBrief(c), cue);
  }
  assert.doesNotMatch(generationBrief(c, undefined, 0, 'http'), /sharp reflected band/);
  c.options.reference = true;
  assert.doesNotMatch(generationBrief(c), /sharp reflected band/);
});

test('AI generation: worker checks distinguish blocking geometry/empty errors from color warnings', () => {
  const a = newAsset('Check', 18, 24), c = context();
  assert.match(inspectGeneration([a], c).errors.join(), /rỗng/);
  celFor(a, a.layers[0].id, a.frames[0].id, true)!.data![0] = 0x12345680;
  const report = inspectGeneration([a], c);
  assert.equal(report.errors.length, 0); assert.equal(report.assets[0].colorCount, 1); assert.equal(report.assets[0].outsidePaletteColors, 1); assert.equal(report.assets[0].semiTransparentPixels, 1);
  c.w = 16; assert.match(inspectGeneration([a], c).errors.join(), /18×24/);
  c.w = 18; c.options.paletteMode = 'auto16'; const pixels = Object.values(a.cels)[0].data!;
  for (let i = 0; i < 17; i++) pixels[i] = (0x010101ff + i * 256) >>> 0;
  assert.match(inspectGeneration([a], c).warnings.join(), /17 màu/);
});

test('AI generation: internal helper sprites stay in source, not in the proposal or size checks', () => {
  const c = context();
  const doc: ProjectDocument = { schemaVersion: 1, id: 'p', revision: 1, name: 'Helpers', entry: 'art.px.js', files: { 'art.px.js': "sprite('_sword',{w:2,h:4},rect(0,0,2,4,'#ffffff')); sprite('knight',{w:18,h:24},stamp('_sword',8,10))" }, pixels: {}, metadata: {} };
  const out = renderDocument({ document: doc, mode: 'generation-preview', generation: c }) as ExportResult;
  const p = wireParse(Buffer.from(out.data).toString('utf8'));
  assert.deepEqual(p.assets.map((a: any) => a.name), ['knight']); assert.deepEqual(p.quality.errors, []);
  assert.ok(p.assets[0].source.files['art.px.js'].includes('_sword'));
});

test('AI generation HTTP: CLI/HTTP text, Codex references, single repair, quality gates, stale proposals and real palettes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pxl-generation-test-'));
  const app = await serveStudio(root, { port: 0, uiDir: resolve('dist/studio'), providers: { codex: process.execPath, deepseek: fastHttpFixture(root), prefix: [resolve('studio/fake-cli.js')], timeout: 8000 } });
  const origin = app.url.slice(0, -1);
  const request = (path: string, method = 'GET', value?: unknown) => fetch(app.url + 'api/pixel/' + path, { method, headers: { origin, ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, body: value === undefined ? undefined : wireStringify(value) });
  try {
    const initial = newDocument('Generation', 18, 24), source = initial.assets[0];
    source.source = { entry: 'old.px.js', files: { 'old.px.js': "// SOURCE_REFERENCE_MARKER\nsprite('old',{w:18,h:24},px(1,1,'#ffffff'))" } };
    let d = wireParse(await (await request('projects', 'POST', { name: initial.name, document: initial })).text());
    const base = `projects/${d.id}`;
    async function start(prompt: string, provider = 'codex', options: unknown = {}, expectedStatus = 'ready') {
      const response = await request(base + '/ai', 'POST', { revision: d.revision, assetId: source.id, provider, prompt, generationOptions: options });
      assert.equal(response.status, 202, await response.clone().text()); let j = await response.json() as AiJob;
      const deadline = Date.now() + 15000;
      while (['running', 'validating'].includes(j.status) && Date.now() < deadline) { await wait(30); j = await (await request(base + '/ai/' + j.id)).json() as AiJob; }
      assert.equal(j.status, expectedStatus, j.message); return j;
    }
    for (const provider of ['codex', 'deepseek']) {
      for (const style of ['game', 'eight-bit', 'flat-icon']) {
        const j = await start('draw', provider, { style }); assert.equal(j.attempt, 1); assert.match(j.proposal!.description, /calls=1; preview=false; source=false/);
        assert.equal(j.generation!.w, 18); assert.deepEqual(j.generation!.palette, source.palette);
        const preview = wireParse(await (await request(`${base}/ai/${j.id}/preview`, 'POST', { revision: d.revision })).text());
        assert.deepEqual(preview.quality.errors, []); assert.deepEqual(preview.quality.warnings, []);
        assert.equal(preview.quality.assets[0].colorCount, 2);
        assert.deepEqual(new Set(preview.assets[0].palette), new Set([0, 0x70c989ff, 0xffffffff]));
        const old = wireParse(await (await request(base)).text()); assert.equal(old.revision, d.revision); assert.equal(old.assets.length, 1);
      }
      const noRef = await start('draw', provider);
      if (provider === 'codex') {
        const ref = await start('draw', provider, { reference: true }); assert.match(ref.proposal!.description, /calls=1; preview=true; source=true/);
      } else {
        const rejected = await request(base + '/ai', 'POST', { revision: d.revision, assetId: source.id, provider, prompt: 'draw', generationOptions: { reference: true } });
        assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /Codex/);
      }
      const previous = wireParse(await (await request(`${base}/ai/${noRef.id}/preview`, 'POST', { revision: d.revision })).text());
      assert.deepEqual(previous.assets.map((a: any) => a.name), ['canvas']);
      assert.equal(previous.assets[0].source.entry, 'art.px.js');
      const repair = await start('FIXTURE_REPAIR', provider); assert.equal(repair.attempt, 2); assert.match(repair.proposal!.description, /calls=2/);
    }
    for (const prompt of ['FIXTURE_EMPTY', 'FIXTURE_OUTLINE', 'FIXTURE_ALPHA', 'FIXTURE_OUTSIDE', 'FIXTURE_MANY_COLORS']) {
      const invalid=['FIXTURE_EMPTY','FIXTURE_OUTLINE'].includes(prompt);
      const j = await start(prompt, 'codex', prompt === 'FIXTURE_MANY_COLORS' ? { paletteMode: 'auto16' } : {},invalid?'failed':'ready');
      if(invalid){assert.equal(j.attempt,2);assert.equal(j.cliExecutions,2);assert.equal(j.proposal,undefined);assert.ok(!(await request(`${base}/ai/${j.id}/preview`,'POST',{revision:d.revision})).ok);assert.equal((await(await request(base)).json()).revision,d.revision);continue;}
      assert.equal(j.attempt, 1);
      const preview = wireParse(await (await request(`${base}/ai/${j.id}/preview`, 'POST', { revision: d.revision })).text());
      if (['FIXTURE_EMPTY', 'FIXTURE_OUTLINE'].includes(prompt)) {
        assert.ok(preview.quality.errors.length); assert.equal((await request(base + '/apply-proposal', 'POST', { revision: d.revision, proposalId: preview.proposalId })).status, 422);
      } else { assert.deepEqual(preview.quality.errors, []); assert.ok(preview.quality.warnings.length); }
    }
    for (const options of [null, { style: 'bad' }, { palette: [42] }]) assert.equal((await request(base + '/ai', 'POST', { revision: d.revision, assetId: source.id, provider: 'codex', prompt: 'draw', generationOptions: options })).status, 400);
    assert.equal((await request(base + '/ai', 'POST', { revision: d.revision, assetId: 'missing', provider: 'codex', prompt: 'draw', generationOptions: {} })).status, 404);
    const good = await start('FIXTURE_ALPHA');
    const preview = wireParse(await (await request(`${base}/ai/${good.id}/preview`, 'POST', { revision: d.revision })).text());
    d = wireParse(await (await request(base + '/apply-proposal', 'POST', { revision: d.revision, proposalId: preview.proposalId })).text());
    assert.equal(d.assets.length, 2); assert.ok(d.assets[1].palette.includes(0x12345680)); assert.ok(!d.assets[1].palette.includes(0x70c989ff));
    const stale = await start('draw');
    const p = wireParse(await (await request(`${base}/ai/${stale.id}/preview`, 'POST', { revision: d.revision })).text());
    d = wireParse(await (await request(base, 'PUT', { revision: d.revision, document: { ...d, name: 'Changed' } })).text());
    assert.equal((await request(base + '/apply-proposal', 'POST', { revision: d.revision, proposalId: p.proposalId })).status, 409);
    assert.equal((await request(`${base}/ai/${stale.id}/preview`, 'POST', { revision: d.revision })).status, 409);
    // Omitted generationOptions retains the existing source+first-frame path.
    const old = await request(base + '/ai', 'POST', { revision: d.revision, assetId: source.id, provider: 'codex', prompt: 'draw' });
    assert.equal(old.status, 202); const legacy = await old.json() as AiJob; assert.equal(legacy.generation, undefined);
  } finally { await app.close(); assert.equal(resolve(dirname(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }
});
