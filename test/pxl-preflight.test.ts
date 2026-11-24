import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from '../src/node/load.ts';
import { startRender } from '../src/node/studio/runner.ts';
import { validatePxlReferences } from '../src/node/studio/pxl-preflight.ts';
import { StudioError } from '../src/node/studio/store.ts';

test('PXL preflight follows literal includes, shared VM declarations and the actual DSL scope', () => {
  const entry = 'draw/art.px.ts';
  const source = `include('../colors.px.js');
const valid: number = 2;
function draw(x=valid) { const k='k'; return poly([x,0,3,0,0,3],k); }
sprite('canvas',{w:4,h:4},draw(),px(Math.floor(seed),1,ink));
if(typeof missing === 'undefined') console.log('supported optional global test');
delete anotherOptional;
`;
  assert.doesNotThrow(() => validatePxlReferences({
    [entry]: source,
    'colors.px.js': "pal({k:'#24324b'}); const ink='k'; const seed=0;",
    'unreferenced.px.js': 'this file is not loaded',
  }, entry));
  const standalone = "pal({k:'#24324b'});sprite('canvas',{w:4,h:4},poly([0,0,3,0,0,3],'k'));";
  validatePxlReferences({ 'art.px.js': standalone }, 'art.px.js');
  assert.ok(loadSource(standalone).build('canvas').img.data.some(p => (p & 255) > 0));
  assert.throws(() => validatePxlReferences({
    'art.px.js': "include('helper.px.js');",
    'helper.px.js': "px(0, 0, typo);",
  }, 'art.px.js'), (e: unknown) => e instanceof StudioError && e.diagnostic?.location?.file === 'helper.px.js' && e.diagnostic.identifier === 'typo');
});

test('PXL preflight preserves dynamic includes but rejects static module declarations', () => {
  const entry = 'art.px.js';
  assert.doesNotThrow(() => validatePxlReferences({
    [entry]: "const helper='helper.px.js'; include(helper); sprite('canvas',{w:4,h:4},paint());",
    'helper.px.js': "function paint(){ return px(0,0,'#24324b'); }",
  }, entry));
  assert.throws(() => validatePxlReferences({ [entry]: "import { paint } from './helper.px.js';" }, entry),
    (e: unknown) => e instanceof StudioError && e.diagnostic?.code === 'PXL_MODULE_UNSUPPORTED');
});

test('candidate worker reports a free identifier before any statement in its source runs', async () => {
  const entry = 'art.px.js';
  const request = { mode: 'summary' as const, document: {
    schemaVersion: 1 as const, id: 'fixture', name: 'fixture', entry, revision: 1, pixels: {}, metadata: {},
    files: { [entry]: "throw Error('execution sentinel');\nsprite('canvas',{w:4,h:4},px(0,0,k));" },
  }};
  await assert.rejects(startRender({ ...request, validateSource: true }).promise, (e: unknown) => {
    assert.ok(e instanceof StudioError);
    assert.equal(e.diagnostic?.code, 'PXL_UNDECLARED_IDENTIFIER');
    assert.deepEqual(e.diagnostic?.location,{file:entry,line:2,column:34});
    return true;
  });
  await assert.rejects(startRender(request).promise, /execution sentinel/);
  const other = { ...request.document, files: { [entry]: request.document.files[entry].replace(',k));', ',i));') } };
  await assert.rejects(startRender({ ...request, document: other, validateSource: true }).promise, (e: unknown) => {
    assert.ok(e instanceof StudioError);
    assert.equal(e.diagnostic?.code, 'PXL_UNDECLARED_IDENTIFIER');
    assert.equal(e.diagnostic?.identifier, 'i');
    return true;
  });
});
