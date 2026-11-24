const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2), scenario = args[0], log = args[1], flags = args.slice(2), codex = flags[0] === 'exec';
if (flags[0] === 'login') { console.log('Logged in using local fixture'); return; }
if (flags[0] === 'mcp' && flags[1] === 'list') {
  assert.equal(scenario, 'character-finish');
  assert.deepEqual(flags.slice(2), ['--disable', 'plugins', '--disable', 'apps', '--json']);
  console.log(JSON.stringify([{ name: 'fixture-art-server', enabled: true }, { name: 'already-disabled', enabled: false }]));
  return;
}
if (!fs.existsSync('source-recipe.json')) {
  process.stdin.resume();
  setTimeout(() => {
    const body = JSON.stringify({ description: 'Legacy local fixture', files: [{ path: 'art.px.js', content: "sprite('legacy',{w:18,h:18},px(0,0,'#70c989'))" }] });
    if (codex) { fs.writeFileSync(flags[flags.indexOf('--output-last-message') + 1], body); console.log('{}'); }
    else console.log(JSON.stringify({ status: 'SUCCESS', response: body }));
  }, 1500); return;
}
const source = JSON.parse(fs.readFileSync('source-recipe.json', 'utf8'));
const schema = JSON.parse(fs.readFileSync('response-schema.json', 'utf8'));
const role = schema.properties.recipe ? 'builder' : schema.properties.decision ? 'reviewer' : 'director';
const index = JSON.parse(fs.readFileSync('resource-index.json', 'utf8'));
const images = codex ? flags.flatMap((v, i) => v === '--image' ? [flags[i + 1]] : []) : [];
let input = '';
process.stdin.on('data', b => input += b);
process.stdin.on('end', () => {
  if (scenario === 'terrain-review' && role === 'reviewer') {
    const names = images.map(file => path.basename(file));
    assert.ok(names.includes('review-terrain-repeat.png'), 'terrain reviewer requires the repeat image');
    assert.ok(names.includes('review-terrain-map.png'), 'terrain reviewer requires the native map image');
    assert.ok(!names.includes('review-shape-value.png'), 'terrain uses the repeat image instead of the static subject guide');
    assert.match(input, /review-terrain-repeat\.png/);
    assert.match(input, /review-terrain-map\.png/);
  }
  const record = { role, codex, flags, images, index, stdin: input, print: flags[flags.indexOf('--print') + 1] };
  if (scenario.startsWith('frame-edits')) {
    const motion = JSON.parse(fs.readFileSync('approved-motion.json', 'utf8'));
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    record.protection = { motion, maskHash: motion.movementMask && hash(motion.movementMask.file),
      frozenHashes: motion.frozenFrames.map(f => ({ frameId: f.frameId, hash: hash(f.file) })) };
  }
  fs.appendFileSync(log, JSON.stringify(record) + '\n');
  const count = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  if (scenario === 'director-progress-timeout' && role === 'director') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'hidden-fixture-value' }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'hidden-fixture-value' } }));
    console.log('{"type":"item.started"');
    console.error('hidden-fixture-stderr');
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'stderr-warnings-nonzero' || scenario === 'stderr-only-nonzero') {
    // Eight 600-char warning lines, then one terminal signal; exit 1 with no answer.
    const warnings = Array.from({ length: 8 }, (_, i) => `[warn ${i}] ` + 'w'.repeat(591)).join('\n') + '\n';
    fs.writeSync(2, warnings);
    if (scenario === 'stderr-warnings-nonzero') fs.writeSync(1, JSON.stringify({ type: 'turn.failed', error: { message: 'fixture root cause' } }) + '\n');
    else fs.writeSync(2, 'fixture root cause: provider aborted\n');
    process.exit(1);
  }
  if (scenario === 'quota') { console.log(codex ? JSON.stringify({ type: 'turn.failed', error: { message: 'quota exhausted' } }) : JSON.stringify({ status: 'ERROR', error: 'quota exhausted' })); return; }
  if (scenario === 'tamper') fs.writeFileSync('source-recipe.json', '{}');
  let answer = role === 'director' ? { version: 1, description: 'Fixture giữ cấu trúc', materials: source.materials, parts: source.parts.map(({ paint, ...p }) => p), allowedOperations: ['rect', 'line', 'pixels', 'raster'] }
    : role === 'builder' ? { version: 1, description: 'Fixture dựng một bản', recipe: source }
      : { version: 1, description: 'Fixture kiểm tra', decision: 'keep', patches: [] };
  if (role === 'director' && scenario === 'character-finish') {
    assert.equal(schema.properties.construction.items.properties.commands.items.type, 'string');
    assert.deepEqual(schema.properties.parts.items.required, ['id', 'parentId', 'pivot', 'materialIds']);
    assert.match(input, /about 40–55 commands total/);
    assert.match(input, /Construct one static character/);
    assert.match(input, /Palette by index/);
    assert.match(input, /"A x,y"/);
    assert.doesNotMatch(input, /Read first:|source-recipe\.json|resource-index\.json/);
    assert.equal(input.includes('X 4 3 .001/01121/.121'), source.palette.length <= 16);
    const large = source.canvas.w > 64 || source.canvas.h > 64;
    if (large && source.palette.length <= 16) assert.match(input, /at most 16×16 pixels per X command/);
    assert.ok(flags.some(flag => /^model_reasoning_effort="(?:low|medium)"$/.test(flag)));
    assert.ok(flags.includes('mcp_servers.fixture-art-server.enabled=false'));
    assert.ok(!flags.includes('mcp_servers.already-disabled.enabled=false'));
    assert.deepEqual(flags.flatMap((flag, i) => flag === '--disable' ? [flags[i + 1]] : []), ['plugins', 'apps']);
    const guided = source.canvas.w === source.canvas.h && [32, 64, 128].includes(source.canvas.w);
    assert.equal(images.length, guided ? source.canvas.w === 32 ? 1 : 2 : 0);
    if (guided) {
      assert.equal(path.basename(images[0]), 'construction-volumes.png');
      const guide = fs.readFileSync(images[0]);
      const zoomed = source.canvas.w === 128 ? 256 : 192;
      assert.deepEqual([guide.readUInt32BE(16), guide.readUInt32BE(20)], [zoomed, zoomed]);
      assert.match(input, /drawn on the requested native grid/);
      assert.match(input, /original silhouette for the brief/);
      if (source.canvas.w === 64 || source.canvas.w === 128) {
        assert.equal(path.basename(images[1]), 'construction-materials.png');
        const materialGuide = fs.readFileSync(images[1]);
        assert.deepEqual([materialGuide.readUInt32BE(16), materialGuide.readUInt32BE(20)], source.canvas.w === 64 ? [192, 72] : [176, 80]);
        assert.match(input, /curved steel.*cloth folds/);
        if (source.canvas.w === 64) assert.match(input, /far forearm a real volume/);
      }
    }
    assert.ok(source.palette.length >= 4 && source.parts.every(part => part.paint.length === 0));
    answer.materials = [{ id: 'steel', name: 'Thép', colors: [0, 1, 2, 3] }];
    answer.parts[0].materialIds = ['steel'];
    answer.allowedOperations = ['rect', 'pixels'];
    answer.construction = answer.parts.map((part, index) => ({ partId: part.id,
      commands: index ? [] : [0, 1, 2, 3].map(color => `R ${3 + color} 5 1 7 ${color}`),
    }));
    if (large && source.palette.length <= 16) answer.construction[0].commands.push('X 8 8 .1/02');
    if (source.canvas.w >= 64 && source.canvas.h >= 64) {
      assert.match(input, /lights one side of a directed line/);
      assert.match(input, /lights one solid ellipse inside the polygon/);
      answer.construction[0].commands.push('F 1 3 0 15,22 24,22 15,19 24,19 24,25 15,25');
      answer.parts.push({ id: 'head', name: 'Đầu', parentId: answer.parts[0].id, pivot: { x: 54, y: 22 }, origin: 'authored', materialIds: ['steel'] });
      answer.construction.push({ partId: 'head', commands: ['R 48 14 12 9 1', 'R 50 15 8 6 2'] });
      answer.parts.push({ id: 'pelvis', name: 'Hông', parentId: answer.parts[0].id, pivot: { x: 52, y: 28 }, origin: 'authored', materialIds: ['steel'] },
        { id: 'near-leg', name: 'Chân', parentId: 'pelvis', pivot: { x: 52, y: 30 }, origin: 'authored', materialIds: ['steel'] },
        { id: 'near-hand', name: 'Tay trống', parentId: answer.parts[0].id, pivot: { x: 6, y: 28 }, origin: 'authored', materialIds: ['steel'] },
        { id: 'far-hand', name: 'Tay cầm', parentId: answer.parts[0].id, pivot: { x: 18, y: 28 }, origin: 'authored', materialIds: ['steel'] },
        { id: 'grip', name: 'Chuôi', parentId: 'far-hand', pivot: { x: 21, y: 30 }, origin: 'authored', materialIds: ['steel'] });
      answer.construction.push({ partId: 'pelvis', commands: ['R 48 25 8 8 1'] }, { partId: 'near-leg', commands: ['R 50 30 5 28 2'] },
        { partId: 'near-hand', commands: ['R 6 28 4 4 2'] }, { partId: 'far-hand', commands: ['R 17 28 4 4 2'] },
        { partId: 'grip', commands: ['R 20 29 5 2 3'] });
      answer.parts.unshift({ id: 'cloak', parentId: null, pivot: { x: 55, y: 34 }, materialIds: [] });
      answer.construction.push({ partId: 'cloak', commands: ['R 55 34 5 16 2'] });
      if (source.canvas.w === 128) {
        answer.construction.find(part => part.partId === 'body').commands.push('F 1 3 0 64,84 108,84 64,69 110,69 110,96 64,96');
        const hand = answer.parts.find(part => part.id === 'far-hand');
        const weapon = answer.parts.find(part => part.id === 'grip');
        hand.id = 'hand'; weapon.id = 'sword'; weapon.parentId = hand.id;
        answer.construction.find(part => part.partId === 'far-hand').partId = hand.id;
        answer.construction.find(part => part.partId === 'grip').partId = weapon.id;
      }
    }
    answer.parts = answer.parts.map(({ name, origin, ...part }) => {
      const entry = answer.construction.find(layer => layer.partId === part.id);
      if (part.id === 'head') {
        // Draw the left brow locally at x=50, then move the part 2 px left as a unit.
        entry.commands = ['A 54,22', 'R 50 14 12 9 1', 'R 52 15 8 6 2'];
        return { ...part, pivot: { x: 56, y: 22 } };
      }
      entry.commands.unshift(`A ${part.pivot.x},${part.pivot.y}`);
      return part;
    });
  }
  if (role === 'reviewer' && scenario === 'character-finish' && source.canvas.w >= 64 && source.canvas.h >= 64) {
    const inlineAt = input.split('\n').findIndex(line => line.startsWith('Inline controlled JSON (no shell read needed)'));
    assert.ok(inlineAt > 0);
    assert.doesNotMatch(input, /Read first:|candidate-recipe\.json/);
    const inline = input.split('\n')[inlineAt + 1];
    const candidate = JSON.parse(inline);
    assert.ok(Buffer.byteLength(inline) <= 24 * 1024);
    assert.deepEqual(candidate.canvas, source.canvas);
    if (source.canvas.w === 128) {
      const full = fs.readFileSync('candidate-recipe.json');
      assert.ok(full.length > 24 * 1024);
      const dense = JSON.parse(full).parts.find(part => part.id === 'body').paint.at(-1);
      const packed = candidate.parts.find(part => part.id === 'body').paint.at(-1);
      assert.equal(packed.kind, 'pixel-runs');
      const unpacked = packed.runs.flatMap(([x, y, n, color]) => Array.from({ length: n }, (_, dx) => ({ x: x + dx, y, color })));
      assert.deepEqual(unpacked, dense.pixels);
    }
    const detail = images.find(file => path.basename(file) === 'review-head-grip-4x.png');
    assert.ok(detail);
    assert.match(input, /Đầu 9 px trên đỉnh đầu đến đế 44 px \(20\.5%\)/);
    assert.match(input, /Hông y=25–32\. Chân y=30–57\./);
    assert.match(input, /\(x=46, y=12\)/);
    assert.match(input, /Crop bàn tay\/trang bị 4× bên phải bắt đầu tại \(x=14, y=25\)/);
    assert.match(input, /Head crop \(46,12\) 16×13, shown as palette indices in native rows/);
    assert.match(input, /near-hand ↔ body \(6,28\): 0 ô chồng, 0 ô chạm cạnh/);
    assert.match(input, /near-leg \/ cloak: 16\/16.*\(54,34\)\/\(55,34\)/);
    const gripWidth = source.canvas.w === 128 ? 10 : 14;
    assert.ok(input.includes(`Grip crop (14,25) ${gripWidth}×10, shown as palette indices in native rows`));
    const png = fs.readFileSync(detail);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [(17 + gripWidth) * 4, 52]);
    assert.ok(schema.properties.patches.items.anyOf.some(option => option.properties.touchups));
    assert.ok(schema.properties.patches.items.anyOf.some(option => option.properties.shift));
    assert.match(input, /appends commands to that part's current paint/);
    assert.match(input, /lights one solid ellipse inside the polygon/);
    answer = { version: 1, description: 'Tách mảng sáng trên mũ và tay cầm', decision: 'patch',
      patches: [{ partId: 'head', touchups: ['R 51 15 2 2 -', 'X 51 15 30/.3'] }, { partId: source.canvas.w === 128 ? 'hand' : 'far-hand', touchups: ['X 17 28 0.3'] }] };
    if (source.canvas.w === 128) answer.patches.unshift({ partId: 'hand', shift: { x: 0, y: 1 } });
  }
  if (scenario.startsWith('template-') && role === 'director') {
    assert.ok(!schema.properties.parts && fs.existsSync('template-scope.json') && images.length > 0);
    answer = { version: 1, description: 'Giữ nguyên nguồn. Chỉ sửa layer đã chọn.', allowedOperations: ['raster', 'pixels'] };
  } else if (role === 'director' && !schema.properties.parts) {
    assert.deepEqual(schema.required, ['version', 'description', 'allowedOperations']);
    assert.ok(fs.existsSync('approved-motion.json') && images.length > 0);
    assert.match(input, /View the attached artwork/);
    assert.ok(!input.includes('Read first:'));
    delete answer.materials;
    delete answer.parts;
    if (scenario === 'frame-edits-pixels-only') answer.allowedOperations = ['pixels'];
  }
  if (scenario === 'compact-pixels' && role === 'reviewer') answer = { version: 1, description: 'Fixture sửa một cụm', decision: 'patch',
    patches: [{ partId: source.parts[0].id, paint: [{ kind: 'pixels', x: 2, y: 3, rows: ['.1', '10'] }] }] };
  if (scenario === 'outside-mask' && role === 'builder') answer.recipe.parts[0].paint.push({ kind: 'pixels', pixels: [{ x: 3, y: 3, color: 1 }] });
  if (scenario.startsWith('frame-edits') && role === 'builder') answer.recipe.frames[1].pixelEdits = [{ x: 4, y: 8, color: 1 }];
  if (scenario.startsWith('frame-edits') && role === 'reviewer') answer = {
    version: 1, description: 'Fixture sửa nét đúng frame', decision: 'patch', patches: [{
      frameId: source.frames[scenario === 'frame-edits-frozen' ? 0 : 1].id,
      pixelEdits: [scenario === 'frame-edits-outside' ? { x: 0, y: 0, color: 1 }
        : scenario === 'frame-edits-frozen' ? { x: 4, y: 4, color: 1 } : { x: 5, y: 8, color: 1 }],
    }],
  };
  if (scenario === 'reviewer-exit' && role === 'reviewer') {
    // Reviewer-only terminal failure after a successful builder draw; no answer is written.
    fs.writeSync(1, JSON.stringify({ type: 'turn.failed', error: { message: 'fixture reviewer failed after builder' } }) + '\n');
    process.exitCode = 1;
    return;
  }
  let body = scenario === 'repair' && count === 2 ? '{bad JSON' : JSON.stringify(answer);
  if (scenario === 'fence') body = '```json\n' + body + '\n```';
  if (codex) {
    fs.writeFileSync(flags[flags.indexOf('--output-last-message') + 1], body);
    if (role === 'reviewer' && scenario.startsWith('reviewer-completed-')) {
      const text = scenario === 'reviewer-completed-mismatch' ? '{}' : body;
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
      if (scenario === 'reviewer-completed-nonzero') process.exitCode = 7;
      else setInterval(() => {}, 1000);
    }
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 37, output_tokens: 23, cached_input_tokens: 11 } }));
  } else console.log(JSON.stringify({ status: 'SUCCESS', response: body }));
});
