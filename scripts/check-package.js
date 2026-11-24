import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { gunzipSync } from 'node:zlib';
const root = mkdtempSync(join(tmpdir(), 'pxl-package-check-'));
try {
  const workspace = resolve('.');
  let archive = process.env.PXL_RC_TARBALL;
  if (!archive) {
    const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!existsSync(npm)) throw new Error('Cannot find bundled npm CLI for package verification');
    // npm can still run prepare with --ignore-scripts: isolate all pack inputs.
    const staging = join(root, 'source'); mkdirSync(staging);
    const metadata = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
    for (const name of [...metadata.files, 'package.json', 'README.md', 'LICENSE']) {
      if (name === 'examples/*.px.js') {
        mkdirSync(join(staging, 'examples'), { recursive: true });
        for (const file of readdirSync(join(workspace, 'examples')).filter(f => f.endsWith('.px.js'))) cpSync(join(workspace, 'examples', file), join(staging, 'examples', file));
      } else {
        const source = resolve(workspace, name);
        if (name.includes('*') || !source.startsWith(workspace + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsupported package input: ' + name);
        cpSync(source, join(staging, name), { recursive: true });
      }
    }
    const result = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', root], { cwd: staging, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const marker = result.stdout.lastIndexOf('\n[');
    archive = join(root, JSON.parse(result.stdout.slice(marker < 0 ? 0 : marker + 1))[0].filename);
  }
  const tar = gunzipSync(readFileSync(archive));
  const installed = join(root, 'node_modules/pxl-pixelart'); mkdirSync(installed, { recursive: true });
  const lock = JSON.parse(readFileSync(join(workspace, 'package-lock.json'), 'utf8'));
  const runtimeRoot = process.env.PXL_RC_RUNTIME_ROOT ?? workspace;
  for (const [name, info] of Object.entries(lock.packages)) {
    if (name.startsWith('node_modules/') && !info.dev) {
      const source = join(runtimeRoot, name);
      const installed = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      assert.equal(installed.version, info.version, `Runtime dependency ${name}`);
      cpSync(source, join(root, name), { recursive: true });
    }
  }
  let extractedFiles = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512), name = header.toString('utf8', 0, 100).replace(/\0.*$/, ''), size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    if (!name) break;
    if (header[156] === 0 || header[156] === 48) {
      if (!name.startsWith('package/') || name.split('/').includes('..')) throw new Error('Unsafe package path');
      const path = join(installed, name.slice(8)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, tar.subarray(offset + 512, offset + 512 + size));
      extractedFiles++;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const rebuild = spawnSync(process.execPath, ['scripts/build.js'], { cwd: installed, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (rebuild.status !== 0) throw new Error(`Published build without devDependencies: ${rebuild.stderr}`);
  const cli = spawnSync(process.execPath, ['bin/pxl.js', 'list', 'examples/basics.px.js'], { cwd: installed, encoding: 'utf8', windowsHide: true });
  if (cli.status !== 0 || !cli.stdout.includes('slime')) throw new Error(`Published legacy CLI failed: ${cli.stderr}`);
  const { serveStudio } = await import(pathToFileURL(join(installed, 'dist/node/studio/server.js')).href);
  // Reuse offline HTTP fixtures against the extracted adapter, without packaging test files.
  const adapterUrl = pathToFileURL(join(installed, 'dist/node/studio/deepseek-http.js')).href;
  for (const name of ['quality-http', 'fast-http']) {
    const source = readFileSync(join(workspace, 'test/fixtures', name + '.ts'), 'utf8');
    writeFileSync(join(root, name + '.mjs'), stripTypeScriptTypes(source, { mode: 'strip' })
      .replaceAll('../../src/node/studio/deepseek-http.ts', adapterUrl).replaceAll('./quality-http.ts', './quality-http.mjs'));
  }
  const { qualityHttpFixture } = await import(pathToFileURL(join(root, 'quality-http.mjs')).href);
  const { fastHttpFixture } = await import(pathToFileURL(join(root, 'fast-http.mjs')).href);
  // Verify the new controlled renderer and its worker from the actual extracted package.
  const { startRender: qualityRender } = await import(pathToFileURL(join(installed, 'dist/node/studio/runner.js')).href);
  const qualityRecipe = { version: 1, name: 'Kiểm tra gói', canvas: { w: 18, h: 18 }, palette: [0x70c989ff], pivot: { x: 9, y: 18 }, materials: [],
    parts: [{ id: 'body', name: 'Thân', parentId: null, pivot: { x: 0, y: 0 }, origin: 'authored', materialIds: [], paint: [{ kind: 'rect', x: 1, y: 1, w: 2, h: 3, color: 0 }] }],
    frames: [{ id: 'still', durationMs: 120, poses: [] }], loop: false };
  const qualityOutput = await qualityRender({ mode: 'quality-render', revision: 5, operation: 'inspect', recipe: qualityRecipe, resources: { sources: [], masks: [] } }).promise;
  const qualityInfo = JSON.parse(Buffer.from(qualityOutput.data).toString('utf8'));
  if (qualityInfo.revision !== 5 || qualityInfo.w !== 18 || qualityInfo.frames[0].visiblePixels !== 6 || qualityInfo.frames[0].durationMs !== 120 || qualityInfo.loop !== false) throw new Error('Packaged controlled quality renderer/worker failed');
  const { qualityRgbaHash } = await import(pathToFileURL(join(installed, 'dist/node/studio/quality-digest.js')).href);
  const { createMotionApproval } = await import(pathToFileURL(join(installed, 'dist/node/studio/motion-approval.js')).href);
  const { solveTwoBone } = await import(pathToFileURL(join(installed, 'dist/studio/quality/kinematics.js')).href);
  const { parseMotionContact } = await import(pathToFileURL(join(installed, 'dist/studio/quality/motion.js')).href);
  const heelContact = { chainId: 'leg', phase: 'stance', target: { x: 2, y: 5 }, contactSocketId: 'heel' };
  assert.deepEqual(parseMotionContact(heelContact), heelContact);
  assert.equal(Object.hasOwn(parseMotionContact({ chainId: 'leg', phase: 'swing', target: null }), 'contactSocketId'), false);
  const ik = solveTwoBone({ x: 0, y: 0 }, { x: 6, y: 0 }, 5, 5, 1);
  if (!ik.reachable || Math.abs(ik.end.x - 6) > 1e-8 || Math.abs(ik.end.y) > 1e-8) throw new Error('Packaged fixed-length IK failed');
  const qualityPixels = new Uint32Array(18 * 18);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 3; x++) qualityPixels[y * 18 + x] = 0x70c989ff;
  const motionRig = { version: 1, id: 'rig', source: { projectId: 'project', assetId: 'source', frameId: 'frame', revision: 5, rgbaSha256: qualityRgbaHash(qualityPixels), canvas: { w: 18, h: 18 }, pivot: { x: 9, y: 18 } },
    joints: [{ id: 'root', parentId: null, rest: { x: 0, y: 0 }, minRotation: -180, maxRotation: 180 }], sockets: [], chains: [], bindings: [{ partId: 'body', jointId: 'root', socketId: null }] };
  const motionPlan = { version: 1, id: 'plan', rigId: 'rig', action: 'idle', loop: false, rootMotion: false, frames: [{ id: 'still', durationMs: 120, root: { dx: 0, dy: 0 }, travel: { dx: 0, dy: 0 }, rotations: [], order: ['body'], contacts: [] }] };
  const motionSnapshot = { recipe: qualityRecipe, rig: motionRig, plan: motionPlan, resources: { sources: [], masks: [] }, source: { projectId: 'project', assetId: 'source', frameId: 'frame', revision: 5, pixels: qualityPixels }, movementMask: null, frozenFrames: [] };
  const motionReceipt = createMotionApproval(motionSnapshot);
  const verifiedMotion = await qualityRender({ mode: 'quality-render', operation: 'motion-verify', revision: 5, recipe: qualityRecipe, snapshot: motionSnapshot, approval: motionReceipt }).promise;
  if (JSON.parse(Buffer.from(verifiedMotion.data).toString('utf8')).frameHashes[0].rgbaSha256 !== qualityRgbaHash(qualityPixels)) throw new Error('Packaged motion approval/guard failed');
  const emptyMotion = { ...qualityRecipe, parts: qualityRecipe.parts.map(p => ({ ...p, paint: [] })) };
  await assert.rejects(qualityRender({ mode: 'quality-render', operation: 'motion-verify', revision: 5,
    recipe: emptyMotion, snapshot: motionSnapshot, approval: motionReceipt }).promise, /Frame 1 rỗng/);
  const { QualityEngine } = await import(pathToFileURL(join(installed, 'dist/node/studio/quality-engine.js')).href);
  const { QualityRuntime } = await import(pathToFileURL(join(installed, 'dist/node/studio/quality-runtime.js')).href);
  const runtime = new QualityRuntime(); let qualityBusy = false; const qualityCalls = [];
  const qualityDirector = { version: 1, description: 'Giữ cụm nguồn', materials: [], parts: qualityRecipe.parts.map(({ paint, ...part }) => part), allowedOperations: ['rect'] };
  const engine = new QualityEngine(runtime.ports({
    acquire() { if (qualityBusy) throw new Error('busy'); qualityBusy = true; return { release() { qualityBusy = false; }, check() { if (!qualityBusy) throw new Error('lost lease'); } }; },
    assertCurrent(_id, revision) { if (revision !== 5) throw new Error('stale'); },
    execute(request) { qualityCalls.push(request); return { promise: Promise.resolve({ output: JSON.stringify(request.role === 'director' ? qualityDirector : request.role === 'builder' ? { version: 1, description: 'Bản dựng', recipe: qualityRecipe } : { version: 1, description: 'Giữ nguyên', decision: 'keep', patches: [] }) }), stop: async () => true }; },
  }));
  try {
    const result = await engine.wait(engine.start({ projectId: 'project', revision: 5, prompt: 'Packaged data-only fixture', style: 'RPG', context: { kind: 'free', recipe: qualityRecipe, resources: { sources: [], masks: [] } } }).id);
    if (result.status !== 'ready' || result.cliCalls !== 3 || result.variants.length !== 2 || qualityBusy) throw new Error('Packaged quality engine/runtime worker fixture failed: ' + result.message);
    const png = await runtime.materialize(qualityCalls[0].snapshotId, result.selectedVariantId, 5, 'still').promise;
    if (png.mime !== 'image/png' || png.data.length < 20) throw new Error('Packaged quality lazy preview failed');
  } finally { await engine.close(); runtime.close(true); }
  // Exercise the compiled Codex process supervisor and DeepSeek HTTP adapter offline.
  const { QualityCliTransport } = await import(pathToFileURL(join(installed, 'dist/node/studio/quality-cli.js')).href);
  const qualityFixture = join(root, 'quality-cli.cjs');
  writeFileSync(qualityFixture, `const fs=require('node:fs'),a=process.argv.slice(2),s=JSON.parse(fs.readFileSync('source-recipe.json','utf8')),schema=JSON.parse(fs.readFileSync('response-schema.json','utf8'));process.stdin.resume();process.stdin.on('end',()=>{const r=schema.properties.recipe?{version:1,description:'fixture',recipe:s}:schema.properties.decision?{version:1,description:'fixture',decision:'keep',patches:[]}:{version:1,description:'fixture',materials:s.materials,parts:s.parts.map(({paint,...p})=>p),allowedOperations:['rect','raster']};if(a.includes('--print'))console.log(JSON.stringify({status:'SUCCESS',response:JSON.stringify(r)}));else {fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify(r));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}))}});`);
  const cliRuntime = new QualityRuntime(), qualityTransport = new QualityCliTransport((s, c) => cliRuntime.cliContext(s, c), { providers: { codex: { executable: process.execPath, prefix: [qualityFixture] } }, deepseek: qualityHttpFixture('valid', join(root, 'package-quality-calls.jsonl')) });
  const cliEngine = new QualityEngine(cliRuntime.ports({ acquire: () => ({ release() {}, check() {} }), assertCurrent() {}, execute: r => qualityTransport.execute(r) }), { limits: { director: 15000, builder: 15000, reviewer: 15000, total: 60000 } });
  try {
    const result = await cliEngine.wait(cliEngine.start({ projectId: 'project', revision: 5, prompt: 'Packaged transport fixture', style: 'RPG', context: { kind: 'free', recipe: qualityRecipe, resources: { sources: [], masks: [] } } }).id);
    if (result.status !== 'ready' || result.cliCalls !== 3) throw new Error('Packaged quality CLI transport failed: ' + result.message);
    assert.deepEqual(result.calls.map(c => c.provider), ['codex', 'deepseek', 'codex']);
  } finally { await cliEngine.close(); if (!await qualityTransport.close()) throw new Error('Packaged quality CLI did not stop'); cliRuntime.close(true); }
  const { captureArtGuidance } = await import(pathToFileURL(join(installed, 'dist/node/studio/art-guidance.js')).href);
  for(const topic of ['sprite','terrain','animation']){
    const guidance=captureArtGuidance('skill-v1',{options:{reference:false},...(topic==='animation'?{animation:{}}:{})},topic);
    if(guidance.id!=='skill-v1'||guidance.topic!==topic||!guidance.text||!guidance.hash)throw new Error('Packaged standalone art guidance failed: '+topic);
  }
  const app = await serveStudio(join(root, 'projects'), { port: 0, providers: {
    codex: join(root, 'deliberately-missing-codex.exe'),
    antigravity: join(root, 'deliberately-missing-antigravity.exe'),
  } });
  try {
    for (const page of ['', 'legacy.html']) {
      const response = await fetch(app.url + page), html = await response.text(); if (!response.ok || !html.includes(page ? 'pxl Studio' : 'LumaSprite Studio')) throw new Error(`Published Studio UI failed: ${page}`);
      for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) if (!(await fetch(new URL(match[1], app.url))).ok) throw new Error(`Missing packaged Studio asset: ${match[1]}`);
    }
    const origin = app.url.slice(0, -1), headers = { origin, 'content-type': 'application/json' };
    const created = await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Package pixel', w: 18, h: 18 }) });
    const pixel = await created.json();
    if (!created.ok || pixel.schemaVersion !== 2 || pixel.assets[0].palette.length !== 32) throw new Error('Packaged pixel model/default palette failed');
    // Invalid configuration must be rejected before a provider can be invoked.
    const rejected = await fetch(app.url + `api/pixel/projects/${pixel.id}/ai`, { method: 'POST', headers, body: JSON.stringify({ revision: pixel.revision, assetId: pixel.assets[0].id, provider: 'codex', prompt: 'No AI call', generationOptions: { style: 'invalid' } }) });
    if (rejected.status !== 400 || !(await rejected.json()).error.includes('Phong cách')) throw new Error('Packaged generation options validation failed');
    const invalidBatch = await fetch(app.url + `api/pixel/projects/${pixel.id}/generation-batches`, { method: 'POST', headers, body: JSON.stringify({ revision: pixel.revision, provider: 'codex', prompt: 'No AI call', generationOptions: { style: 'invalid' } }) });
    if (invalidBatch.status !== 400 || !(await invalidBatch.json()).error.includes('Phong cách')) throw new Error('Packaged batch validation failed');
    const noBatch = await fetch(app.url + `api/pixel/projects/${pixel.id}/generation-batches`);
    if (!noBatch.ok || (await noBatch.json()).length) throw new Error('Invalid packaged requests started an AI batch');
    const { normalizePixels }=await import(pathToFileURL(join(installed,'dist/studio/pixel/processing.js')).href);
    if(normalizePixels(Uint32Array.from([0xffffff7f,0xffffff80]),[0xffffffff])[1]!==0xffffffff)throw new Error('Packaged OKLab processing module failed');
    const preview=await fetch(app.url+`api/pixel/projects/${pixel.id}/code-preview`,{method:'POST',headers,body:JSON.stringify({revision:pixel.revision,entry:'art.px.js',files:{'art.px.js':"sprite('Packed',{w:18,h:18},px(0,0,'#70c989'))"},variants:true})});
    const proposal=await preview.json();if(!preview.ok||!proposal.variants?.[0].canApply||proposal.variants[0].assets[0].cels)throw new Error('Packaged lazy variants worker failed');
    const variant=proposal.variants[0],asset=variant.assets[0],frame=await fetch(app.url+`api/pixel/projects/${pixel.id}/proposals/${proposal.proposalId}/variants/${variant.id}/frame?revision=${pixel.revision}&asset=${asset.id}&frame=${asset.frames[0].id}`);
    if(!frame.ok)throw new Error('Packaged lazy frame failed');await frame.arrayBuffer();
    const apply = await fetch(app.url+`api/pixel/projects/${pixel.id}/apply-proposal`,{method:'POST',headers,body:JSON.stringify({revision:pixel.revision,proposalId:proposal.proposalId,variantId:variant.id,library:{kind:'character',versionOf:pixel.assets[0].id,name:'Packed v2'}})});
    const saved=await apply.json(),applied=saved.assets?.[1];
    if(!apply.ok||saved.studio?.library?.[applied?.id]?.version!==2)throw new Error('Packaged library/version apply failed');
    const invalidRegion=await fetch(app.url+`api/pixel/projects/${pixel.id}/generation-batches`,{method:'POST',headers,body:JSON.stringify({revision:saved.revision,provider:'codex',prompt:'Package fixture only',assetId:applied.id,regionEdit:{frameId:applied.frames[0].id,mask:[]}})});
    if(invalidRegion.status!==400)throw new Error('Packaged region mask validation failed');
    const region=await fetch(app.url+`api/pixel/projects/${pixel.id}/generation-batches`,{method:'POST',headers,body:JSON.stringify({revision:saved.revision,provider:'codex',prompt:'Package missing-provider fixture only',assetId:applied.id,regionEdit:{frameId:applied.frames[0].id,mask:Array.from({length:324},(_,i)=>+(i===0))}})});
    let batch=await region.json();
    if(region.status!==202||batch.config?.operation!=='region-edit'||batch.config?.regionEdit?.duration!==100)throw new Error('Packaged region reference preparation failed');
    const until=Date.now()+5000;
    while(batch.status==='running'&&Date.now()<until){await new Promise(r=>setTimeout(r,50));batch=await(await fetch(app.url+`api/pixel/projects/${pixel.id}/generation-batches/${batch.id}`)).json();}
    if(batch.status!=='failed'||batch.candidates.some(c=>c.cliExecutions))throw new Error('Packaged missing-provider fixture failed; no real CLI may execute');

    const docWithResource = JSON.parse(JSON.stringify(saved));
    const testMask = [0, 1, 1, 0];
    docWithResource.studio = {
      ...(docWithResource.studio ?? { version: 1 }),
      resources: {
        'test-mask': {
          version: 1,
          kind: 'mask',
          w: 2,
          h: 2,
        },
      },
    };
    const { wireStringify: wireEnc, wireParse: wireDec } = await import(pathToFileURL(join(installed, 'dist/studio/pixel/model.js')).href);
    docWithResource.studio.resources['test-mask'].data = Uint32Array.from(testMask);
    const putRes = await fetch(app.url + `api/pixel/projects/${saved.id}`, {
      method: 'PUT',
      headers,
      body: wireEnc({ revision: saved.revision, document: docWithResource }),
    });
    const putSaved = wireDec(await putRes.text());
    if (!putRes.ok || !putSaved.studio?.resources?.['test-mask']?.blob || putSaved.studio.resources['test-mask'].data) {
      throw new Error('Packaged resource persistence/metadata strip failed');
    }
    const lazyRes = await fetch(app.url + `api/pixel/projects/${saved.id}/resource?revision=${putSaved.revision}&resource=test-mask`);
    if (!lazyRes.ok) throw new Error('Packaged lazy resource retrieval failed');
    const lazyData = wireDec(await lazyRes.text());
    if (!lazyData.data || Array.from(lazyData.data).join(',') !== testMask.join(',')) {
      throw new Error('Packaged lazy resource data mismatch');
    }
    const staleRes = await fetch(app.url + `api/pixel/projects/${saved.id}/resource?revision=${saved.revision}&resource=test-mask`);
    if (staleRes.status !== 409) throw new Error('Packaged stale resource revision was not rejected');
    const copyRes = await fetch(app.url + 'api/pixel/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Packaged copy', document: putSaved, sourceProjectId: saved.id }),
    });
    const copied = await copyRes.json();
    if (!copyRes.ok || !copied.studio?.resources?.['test-mask']?.blob) {
      throw new Error('Packaged resource copy failed');
    }
    const { newDocument, celFor } = await import(pathToFileURL(join(installed, 'dist/studio/pixel/model.js')).href);
    const characterCommands = await import(pathToFileURL(join(installed, 'dist/studio/character-commands.js')).href);
    const { resolvePixelPivot } = await import(pathToFileURL(join(installed, 'dist/studio/characters.js')).href);
    const characterDoc = newDocument('Packaged character', 18, 18), sourceAsset = characterDoc.assets[0];
    sourceAsset.metadata.pivot = { x: 0.25, y: 1 };
    celFor(sourceAsset, sourceAsset.layers[0].id, sourceAsset.frames[0].id, true).data[0] = 0x70c989ff;
    characterCommands.ensureCharacterExtension(characterDoc);
    const profile = characterCommands.createCharacterProfile(characterDoc, { id: 'hero', name: 'Nhân vật đóng gói', assetId: sourceAsset.id, frameId: sourceAsset.frames[0].id });
    const mask = new Uint32Array(324); mask[0] = mask[1] = mask[18] = 1;
    characterCommands.addCharacterPart(characterDoc, profile.id, 'head', { name: 'Đầu', selection: mask });
    characterCommands.addCharacterLandmark(characterDoc, profile.id, 'eye', { name: 'Mắt', x: 1, y: 1, partId: 'head' });
    characterCommands.approveCharacterProfile(characterDoc, profile.id);
    const characterRes = await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers, body: wireEnc({ name: characterDoc.name, document: characterDoc }) });
    const characterSaved = wireDec(await characterRes.text()), hero = characterSaved.studio?.characters?.hero;
    if (!characterRes.ok || !hero?.approved || hero.source.pivot.x !== 4.5 || hero.source.pivot.y !== 18 || hero.landmarks.eye.partId !== 'head') throw new Error('Packaged character profile/pixel pivot lifecycle failed');
    const pivot = resolvePixelPivot(sourceAsset.metadata.pivot, 18, 18);
    if (pivot.x !== 4.5 || pivot.y !== 18) throw new Error('Packaged normalized pivot conversion failed');
    const masterRes = await fetch(app.url + `api/pixel/projects/${characterSaved.id}/resource?revision=${characterSaved.revision}&resource=${hero.source.rgbaResourceId}`);
    const master = wireDec(await masterRes.text());
    if (!masterRes.ok || master.data?.length !== 324 || master.data[0] !== 0x70c989ff || characterSaved.studio.resources[hero.source.rgbaResourceId].data) throw new Error('Packaged character master lazy RGBA failed');
    const characterCopyRes = await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers, body: wireEnc({ name: 'Character copy', document: characterSaved, sourceProjectId: characterSaved.id }) });
    const characterCopy = wireDec(await characterCopyRes.text());
    if (!characterCopyRes.ok || characterCopy.id === characterSaved.id || JSON.stringify(characterCopy.studio.characters) !== JSON.stringify(characterSaved.studio.characters)) throw new Error('Packaged character copy failed');
    const clipCommands = await import(pathToFileURL(join(installed, 'dist/studio/clip-commands.js')).href);
    clipCommands.ensureClipExtension(characterDoc);
    const clip = clipCommands.createClip(characterDoc, { id: 'walk', name: 'Clip đóng gói', characterId: 'hero',
      template: 'walk', mode: 'whole', loop: false, slotCount: 4 });
    clip.slots.forEach((slot, i) => {
      clipCommands.setSlotDuration(characterDoc, clip.id, slot.id, [80, 140, 200, 100][i]);
      clipCommands.setSlotSelection(characterDoc, clip.id, slot.id, i === 2);
    });
    clipCommands.setSlotFrozen(characterDoc, clip.id, clip.slots[0].id, true);
    const clipSave = await fetch(app.url + `api/pixel/projects/${characterSaved.id}`, { method: 'PUT', headers,
      body: wireEnc({ revision: characterSaved.revision, document: { ...characterDoc, id: characterSaved.id, revision: characterSaved.revision } }) });
    const clipSaved = wireDec(await clipSave.text());
    if (!clipSave.ok || !clipSaved.studio?.clips?.walk) throw new Error('Packaged clip persistence failed');
    const { VariantStore } = await import(pathToFileURL(join(installed, 'dist/node/studio/variant-store.js')).href);
    const { startRender } = await import(pathToFileURL(join(installed, 'dist/node/studio/runner.js')).href);
    const { composite } = await import(pathToFileURL(join(installed, 'dist/studio/pixel/model.js')).href);
    const clipRepo = new VariantStore();
    try {
      async function clipWork(request) {
        const result = await startRender({ mode: 'pixel-process', root: clipRepo.root, ...request }).promise;
        return wireDec(Buffer.from(result.data).toString('utf8'));
      }
      const snapshot = await clipWork({ operation: 'clip-prepare', projectRoot: join(root, 'projects'),
        projectId: clipSaved.id, revision: clipSaved.revision, clipId: clip.id, paletteMode: 'asset', targetPalette: sourceAsset.palette });
      if (snapshot.context.projectId !== clipSaved.id || snapshot.context.pivot.x !== 4.5 || snapshot.guideMetadata.w > 1024) throw new Error('Packaged clip snapshot/guide failed');
      const request = { context: snapshot.context, referenceId: snapshot.referenceId, revision: clipSaved.revision };
      const captured = await clipWork({ ...request, operation: 'clip-capture', document: snapshot.contextDoc });
      if (!captured.protected?.canApply || captured.raw?.canApply || captured.raw?.assets[0].frames.length !== 1) throw new Error('Packaged K1/fullN clip processing failed');
      const normalized = await clipWork({ ...request, operation: 'clip-normalize', rawVariantId: captured.raw.id, alphaThreshold: 128 });
      const verified = await clipWork({ ...request, operation: 'clip-verify', variantId: normalized.info.id });
      const full = clipRepo.assets(normalized.info.id)[0];
      if (!verified.valid || full.frames.length !== 4 || full.tags[0].loop || full.frames.map(f => f.duration).join(',') !== '80,140,200,100') throw new Error('Packaged clip timing/verification failed');
      for (const frame of full.frames) {
        const image = composite(full, frame.id).data;
        if (image[0] !== 0x70c989ff || image.slice(1).some(Boolean)) throw new Error('Packaged clip exact RGBA failed');
      }
    } finally { clipRepo.close(); }
    // Exercise the extracted package's actual local terrain worker and map
    // export APIs. Deliberately missing provider paths above ensure no AI call.
    const terrainCreatedRes = await fetch(app.url + 'api/pixel/projects', { method: 'POST', headers,
      body: JSON.stringify({ name: 'Vật liệu đóng gói', w: 16, h: 16, background: 0x338844ff }) });
    const terrainDoc = wireDec(await terrainCreatedRes.text());
    if (!terrainCreatedRes.ok) throw new Error('Packaged terrain material create failed');
    const terrainBase = app.url + `api/pixel/projects/${terrainDoc.id}/terrain/`;
    const terrainStart = await fetch(terrainBase + 'proposal', { method: 'POST', headers, body: JSON.stringify({
      revision: terrainDoc.revision, assetId: terrainDoc.assets[0].id, frameId: terrainDoc.assets[0].frames[0].id,
      name: 'Cỏ đóng gói', tileSize: 16, inset: 2, sampling: 'mirror',
    }) });
    let terrainJob = await terrainStart.json();
    if (terrainStart.status !== 202) throw new Error(`Packaged terrain start failed: ${JSON.stringify(terrainJob)}`);
    const terrainDeadline = Date.now() + 8000;
    while (terrainJob.status === 'running' && Date.now() < terrainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
      terrainJob = await (await fetch(terrainBase + `jobs/${terrainJob.id}`)).json();
    }
    if (terrainJob.status !== 'ready' || terrainJob.w !== 128 || terrainJob.h !== 96 || JSON.stringify(terrainJob).includes('$rgba')) throw new Error('Packaged terrain worker/compact job failed');
    const terrainPreview = await fetch(terrainBase + `jobs/${terrainJob.id}/preview?revision=${terrainDoc.revision}`);
    const terrainPng = Buffer.from(await terrainPreview.arrayBuffer());
    if (!terrainPreview.ok) throw new Error('Packaged terrain preview failed');
    const terrainApply = await fetch(terrainBase + `jobs/${terrainJob.id}/apply`, { method: 'POST', headers, body: JSON.stringify({ revision: terrainDoc.revision }) });
    const terrainApplied = wireDec(await terrainApply.text());
    if (!terrainApply.ok || terrainApplied.document.assets.length !== 2 || !terrainApplied.document.studio.tilesets[terrainApplied.tilesetId]) throw new Error('Packaged terrain explicit apply failed');
    const mapCommands = await import(pathToFileURL(join(installed, 'dist/studio/map-commands.js')).href);
    const mapDoc = terrainApplied.document;
    mapCommands.createMap(mapDoc, terrainApplied.tilesetId, 'Bản đồ đóng gói', 40, 2, 'packaged_map');
    const mapLayer = mapDoc.studio.mapIndex.packaged_map.layers[0];
    const mapStroke = new mapCommands.MapStroke(mapDoc, 'packaged_map', mapLayer.id);
    mapStroke.set(31, 1, 48, false); mapStroke.set(32, 1, 48, false); mapStroke.commit();
    const mapSave = await fetch(app.url + `api/pixel/projects/${mapDoc.id}`, { method: 'PUT', headers, body: wireEnc({ revision: mapDoc.revision, document: mapDoc }) });
    const mapSaved = wireDec(await mapSave.text());
    if (!mapSave.ok) throw new Error('Packaged map persistence failed');
    async function mapExport(format) {
      const response = await fetch(terrainBase + 'map-export', { method: 'POST', headers, body: JSON.stringify({ revision: mapSaved.revision, mapId: 'packaged_map', format }) });
      if (!response.ok) throw new Error(`Packaged map ${format} export failed: ${await response.text()}`);
      return Buffer.from(await response.arrayBuffer());
    }
    const mapJson = JSON.parse((await mapExport('json')).toString('utf8'));
    if (mapJson.revision !== mapSaved.revision || mapJson.layers[0].chunks.length !== 2 || mapJson.layers[0].chunks[0].tiles[63] !== 48 || mapJson.layers[0].chunks[1].tiles[32] !== 48 || JSON.stringify(mapJson).includes('blob')) throw new Error('Packaged portable map chunks failed');
    const mapZip = await mapExport('zip'), mapEntries = {};
    for (let offset = 0; offset + 30 <= mapZip.length && mapZip.readUInt32LE(offset) === 0x04034b50;) {
      const size = mapZip.readUInt32LE(offset + 18), nl = mapZip.readUInt16LE(offset + 26), el = mapZip.readUInt16LE(offset + 28), start = offset + 30 + nl + el;
      mapEntries[mapZip.toString('utf8', offset + 30, offset + 30 + nl)] = mapZip.subarray(start, start + size); offset = start + size;
    }
    if (!mapEntries[`tilesets/${terrainApplied.tilesetId}/image.png`]?.equals(terrainPng) || JSON.stringify(JSON.parse(mapEntries['map.json'].toString('utf8'))) !== JSON.stringify(mapJson)) throw new Error('Packaged map ZIP revision/atlas equality failed');
    const { Img } = await import(pathToFileURL(join(installed, 'dist/core/image.js')).href);
    const { encodePng } = await import(pathToFileURL(join(installed, 'dist/node/png.js')).href);
    const mapExpected = new Img(640, 32);
    for (let y = 16; y < 32; y++) mapExpected.data.fill(0x338844ff, y * 640 + 31 * 16, y * 640 + 33 * 16);
    if (!(await mapExport('png')).equals(encodePng(mapExpected))) throw new Error('Packaged flattened map exact PNG failed');
    const terrainAiJobs = await (await fetch(app.url + `api/pixel/projects/${mapSaved.id}/ai`)).json();
    if (terrainAiJobs.length) throw new Error('Local packaged terrain/map made an AI call');
  }
  finally { await app.close(); }
  // Validate a frame after frame0 through the compiled package's real AI
  // manager/worker, with a local process fixture and no remote provider.
  const lateFixture = join(root, 'late-frame-cli.mjs');
  writeFileSync(lateFixture, `import {readFileSync,writeFileSync,existsSync,fstatSync} from 'node:fs';
const args=process.argv.slice(2);if(args.includes('login')){process.stdout.write('Logged in using fixture');process.exit(0);}
const anti=args.includes('--print');if(anti&&(args[args.indexOf('--model')+1]!=='gemini-3.8-flash-high'||args[args.indexOf('--effort')+1]!=='high'||!args[args.indexOf('--print')+1].includes('Authoritative response JSON schema')||!fstatSync(0).isCharacterDevice()))throw Error('Compiled Anti profile/schema/stdin mismatch');
process.stdin.resume();const counter='.late-frame-attempt',attempt=existsSync(counter)?Number(readFileSync(counter,'utf8'))+1:1;writeFileSync(counter,String(attempt));
const code="pal({g:'#70c989'})\\nanim('compiled',{w:8,h:8},frame({ms:100},px(1,1,'g')),frame({ms:100},px(2,1,'"+(attempt===1?'missing':'g')+"')))";
const output=JSON.stringify({description:'compiled later-frame repair',files:[{path:args[0],content:code}]});const at=args.indexOf('--output-last-message');if(at>=0)writeFileSync(args[at+1],output);process.stdout.write(anti?JSON.stringify({status:'SUCCESS',structured_output:JSON.parse(output)}):output);
`);
  const { ProjectStore } = await import(pathToFileURL(join(installed, 'dist/node/studio/store.js')).href);
  const { AiManager } = await import(pathToFileURL(join(installed, 'dist/node/studio/ai.js')).href);
  const checkStore = new ProjectStore(join(root, 'late-frame-projects')), checkDoc = checkStore.create('Packaged frame validation', 'blank');
  const checkManager = new AiManager(checkStore, () => {}, { codex: process.execPath, deepseek: fastHttpFixture(root), prefix: [lateFixture, checkDoc.entry], timeout: 12000 });
  try {
    for (const provider of ['codex', 'deepseek']) {
      const job = await checkManager.start(checkDoc, provider, 'FIXTURE_LATE_FRAME_REPAIR: validate every animation frame');
      const done = await checkManager.waitFor(job.id);
      if (done.status !== 'ready' || done.attempt !== 2 || done.cliExecutions !== 2 || done.build.errors.length) {
        throw new Error(`Packaged later-frame fixture ${provider}: ${done.status}, attempt=${done.attempt}, calls=${done.cliExecutions}, ${done.error ?? done.message ?? ''}`);
      }
    }
  } finally { await checkManager.close(); }
  // Full product quality API from the package, with owned local process fixtures.
  const qualityProjectRoot = join(root, 'quality-http-projects');
  const packagedProviders = { codex: process.execPath, deepseek: qualityHttpFixture('valid', join(root, 'package-quality-api-calls.jsonl')), prefix: [qualityFixture], timeout: 15000 };
  let qualityApp = await serveStudio(qualityProjectRoot, { port: 0, providers: packagedProviders });
  async function qualityPost(path, data, status = 200) {
    const origin = qualityApp.url.slice(0, -1), response = await fetch(qualityApp.url + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json(); if (response.status !== status) throw new Error('Packaged quality API: ' + JSON.stringify(value)); return value;
  }
  try {
    const doc = await qualityPost('api/pixel/projects', { name: 'Quality packaged', w: 18, h: 18, background: 0x70c989ff }, 201);
    const base = 'api/pixel/projects/' + doc.id + '/', accepted = await qualityPost(base + 'quality/approvals', { revision: doc.revision, assetId: doc.assets[0].id, frameId: doc.assets[0].frames[0].id, kind: 'static', sourceApproved: true }, 201);
    if (accepted.document.schemaVersion !== 2 || accepted.document.studio.version !== 2 || accepted.approval.revision !== accepted.document.revision) throw new Error('Packaged durable quality approval failed');
    let job = await qualityPost(base + 'quality-runs', { revision: accepted.document.revision, approvalId: accepted.approval.id, prompt: 'Local packaged quality API fixture' }, 202);
    const end = Date.now() + 20000;
    while (job.status === 'running' && Date.now() < end) { await new Promise(r => setTimeout(r, 30)); job = await (await fetch(qualityApp.url + base + 'quality-runs/' + job.id)).json(); }
    if (job.status !== 'ready' || job.cliCalls !== 3) throw new Error('Packaged three-role quality API failed: ' + job.message);
    const variant = job.variants.find(v => v.id === job.selectedVariantId), frame = variant.frames[0].id;
    const before = await fetch(qualityApp.url + base + 'quality-runs/' + job.id + '/variants/' + variant.id + '/frame?revision=' + accepted.document.revision + '&frame=' + frame);
    if (!before.ok) throw new Error('Packaged quality PNG preview failed'); const expected = Buffer.from(await before.arrayBuffer());
    const applied = await qualityPost(base + 'quality-runs/' + job.id + '/apply', { revision: accepted.document.revision, variantId: variant.id });
    if (applied.document.assets.length !== 2 || !applied.document.assets[1].source.files['quality-provenance.js']) throw new Error('Packaged quality new asset/provenance failed');
    await qualityApp.close(); qualityApp = await serveStudio(qualityProjectRoot, { port: 0, providers: packagedProviders });
    const restored = await (await fetch(qualityApp.url + base + 'quality-runs/' + job.id)).json();
    if (restored.previewAvailable || restored.appliedAssetId !== applied.assetId) throw new Error('Packaged quality history/restart failed');
    const origin = qualityApp.url.slice(0, -1), exported = await fetch(qualityApp.url + base + 'export', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: applied.document.revision, assetId: applied.assetId, format: 'png' }) });
    if (!exported.ok || !Buffer.from(await exported.arrayBuffer()).equals(expected)) throw new Error('Packaged quality exact RGBA PNG round trip failed');
    const rig = await qualityPost(base + 'rig-drafts', { revision: applied.document.revision, assetId: doc.assets[0].id, frameId: doc.assets[0].frames[0].id }, 201);
    if (rig.document.assets.length !== 3 || Object.keys(rig.document.studio.quality.approvals).length !== 1 || rig.draft.rig.source.assetId !== rig.assetId) throw new Error('Packaged rig source must copy pixels without granting a new approval');
    const refreshed = await qualityPost(base + 'rig-drafts/' + rig.draft.id + '/refresh', { revision: rig.document.revision, parts: rig.draft.recipe.parts.map(p => ({ layerId: p.id, origin: p.origin, pivot: p.pivot })) });
    if (refreshed.document.revision !== rig.document.revision + 1 || refreshed.draft.id !== rig.draft.id || JSON.stringify(refreshed.draft.plan) !== JSON.stringify(rig.draft.plan) || Object.keys(refreshed.document.studio.quality.approvals).length !== 1) throw new Error('Packaged rig refresh worker changed timing or authority');
    await qualityApp.close(); qualityApp = await serveStudio(qualityProjectRoot, { port: 0 });
    const rigDoc = await (await fetch(qualityApp.url + 'api/pixel/projects/' + doc.id)).json();
    if (!rigDoc.studio.rigDrafts[rig.draft.id] || rigDoc.assets.length !== 3) throw new Error('Packaged rig draft did not reopen');
    const rigPng = await fetch(qualityApp.url + base + 'export', { method: 'POST', headers: { origin: qualityApp.url.slice(0, -1), 'content-type': 'application/json' }, body: JSON.stringify({ revision: rigDoc.revision, assetId: rig.assetId, format: 'png' }) });
    if (!rigPng.ok || !Buffer.from(await rigPng.arrayBuffer()).equals(expected)) throw new Error('Packaged rig source copy changed native PNG pixels');
  } finally { await qualityApp.close(); }
  console.log(JSON.stringify({ package: basename(archive), files: extractedFiles, qualityTransport: 'passed-local-Codex-process-and-fake-DeepSeek-HTTP', qualityApi: 'passed-approval-three-roles-new-asset-restart-exact-PNG', rigDraft: 'passed-copy-refresh-no-approval-restart-exact-PNG', ui: 'passed', legacyUi: 'passed', legacyCli: 'passed', pixelGeneration: 'passed',pixelVariants:'passed',libraryVersions:'passed',regionReference:'passed-no-real-CLI', resourceLifecycle: 'passed', characterLifecycle: 'passed', clipLifecycle: 'passed-no-real-CLI', terrainLifecycle: 'passed-no-real-CLI', mapLifecycle: 'passed-exact-PNG-JSON-ZIP', lateFrameValidation: 'passed-CLI-and-HTTP-no-real-AI', providerMigration: 'Codex-CLI+DeepSeek-HTTP', buildWithoutDevDependencies: 'passed', published: false }));
} finally {
  if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error('Refusing cleanup outside temporary directory');
  rmSync(root, { recursive: true, force: true });
}
