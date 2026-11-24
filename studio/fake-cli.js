// Integration-test fixture: no network or real AI tools. Same protocol as both CLIs.
import { readFileSync, writeFileSync, existsSync, rmSync, appendFileSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
let stateDir = process.cwd();
const stateDirIdx = args.indexOf('--state-dir');
if (stateDirIdx !== -1 && args[stateDirIdx + 1]) {
  stateDir = args[stateDirIdx + 1];
}

if (args.includes('login')) { process.stdout.write('Logged in using fixture\n'); process.exit(0); }
if (existsSync('source-recipe.json') && existsSync('resource-index.json')) {
  process.stdin.resume();
  const source = JSON.parse(readFileSync('source-recipe.json', 'utf8')), schema = JSON.parse(readFileSync('response-schema.json', 'utf8'));
  const role = schema.properties.recipe ? 'builder' : schema.properties.decision ? 'reviewer' : 'director';
  const request = readFileSync('request.md', 'utf8');
  appendFileSync(join(stateDir, 'fixture-quality-calls.jsonl'), JSON.stringify({role, provider: args.includes('--print') ? 'antigravity' : 'codex'}) + '\n');
  if (request.includes('FIXTURE_QUALITY_HANG')) await new Promise(() => setInterval(() => {}, 1000));
  let value = role === 'director' ? { version: 1, description: 'Giữ nguồn thử UI', materials: source.materials, parts: source.parts.map(({ paint, ...p }) => p), allowedOperations: ['rect', 'line', 'polygon', 'pixels', 'raster'] }
    : role === 'builder' ? { version: 1, description: 'Đề xuất UI native', recipe: source } : { version: 1, description: 'Đã xem ảnh thử UI', decision: 'keep', patches: [] };
  if (role === 'director' && !schema.properties.parts) {
    delete value.materials;
    delete value.parts;
  }
  if (role === 'reviewer' && request.includes('FIXTURE_QUALITY_REVIEW_PATCH')) {
    const color = source.palette.indexOf(0xffffffff); if (color < 0) throw Error('Review patch fixture needs white in the approved palette');
    value = { version: 1, description: 'Sửa có mục tiêu: một pixel sáng ở góc, giữ cấu trúc.', decision: 'patch', patches: [{ partId: source.parts[0].id, paint: [...source.parts[0].paint, { kind: 'pixels', pixels: [{ x: 0, y: 0, color }] }] }] };
  }
  if (args.includes('--print')) process.stdout.write(JSON.stringify({status: 'SUCCESS', response: JSON.stringify(value)}));
  else { writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(value)); process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 10, output_tokens: 10}})); }
  process.exit(0);
}
const printed = args.includes('--print') ? args[args.indexOf('--print') + 1] : undefined;
const input = printed?.includes('You are creating pixel art with pxl.') ? printed : args.includes('--print') ? readFileSync('request.md','utf8') : await new Promise(r => { let s=''; process.stdin.on('data', c=>s+=c); process.stdin.on('end',()=>r(s)); });
if (args.includes('--print') && input.includes('FIXTURE_ANTIGRAVITY_STDIN') && !fstatSync(0).isCharacterDevice()) throw new Error('Antigravity --print must use null stdin, not an empty pipe');
const calls = existsSync('.fixture-calls') ? Number(readFileSync('.fixture-calls', 'utf8')) + 1 : 1;
writeFileSync('.fixture-calls', String(calls));

const altMatch = input.match(/ALTERNATIVE:\s*(\d+)/);
const altIndex = altMatch ? Number(altMatch[1]) : 1;
if(stateDirIdx!==-1){const guidance=input.match(/PIXEL CRAFT GUIDANCE \(([^,]+), ([^)]+)\):/);appendFileSync(join(stateDir,'fixture-cli-calls.jsonl'),JSON.stringify({alternative:altIndex,call:calls,...guidance?{guidanceId:guidance[1],guidanceTopic:guidance[2],guidanceDigest:createHash('sha256').update(input.slice(guidance.index).split('\nEND PIXEL CRAFT GUIDANCE')[0]).digest('hex')}: {}})+'\n');}

const isHangAll = /\bFIXTURE_HANG\b/.test(input) || (input.includes('FIXTURE_HANG') && !input.includes('FIXTURE_HANG_'));
if (isHangAll) await new Promise(()=>setInterval(()=>{},1000));
if (input.includes('FIXTURE_HANG_1') && altIndex === 1) await new Promise(()=>setInterval(()=>{},1000));
if (input.includes('FIXTURE_HANG_2') && altIndex === 2) await new Promise(()=>setInterval(()=>{},1000));
if (input.includes('FIXTURE_HANG_3') && altIndex === 3) await new Promise(()=>setInterval(()=>{},1000));
if (input.includes('FIXTURE_DELAY')) await new Promise(r => setTimeout(r, 100));

if (input.includes('FIXTURE_ERROR')) { process.stderr.write('fixture quota denied'); process.exit(2); }
if (altIndex === 2 && (input.includes('FIXTURE_SECOND_FAILS') || input.includes('FIXTURE_FAIL_2'))) {
  const failMarker = join(stateDir, 'pxl-fixture-alt2-fail-once');
  if (input.includes('FAIL_ONCE') || input.includes('RETRY')) {
    if (!existsSync(failMarker)) {
      writeFileSync(failMarker, '1');
      process.stderr.write('fixture candidate 2 error');
      process.exit(2);
    } else {
      try { rmSync(failMarker, { force: true }); } catch {}
    }
  } else {
    process.stderr.write('fixture candidate 2 error');
    process.exit(2);
  }
}

const altPalette = [
  { color: '#70c989', name: 'g', x: 8, y: 8, w: 16, h: 16, px: 16, py: 16 },
  { color: '#3b82f6', name: 'b', x: 4, y: 4, w: 12, h: 12, px: 10, py: 10 },
  { color: '#ef4444', name: 'r', x: 12, y: 12, w: 14, h: 14, px: 18, py: 18 },
];
const currentAlt = altPalette[(altIndex - 1) % 3];

const proposal = {
  description: 'Đề xuất thử nghiệm đã dựng: ngôi sao.',
  files: [{
    path: 'art.px.js',
    content: `pal({${currentAlt.name}:'${currentAlt.color}',w:'#ffffff'})\nsprite('canvas',{w:32,h:32},rect(${currentAlt.x},${currentAlt.y},${currentAlt.w},${currentAlt.h},'${currentAlt.name}'),px(${currentAlt.px},${currentAlt.py},'w'))\nsheet('atlas',['canvas'],{pad:1})\n`
  }]
};

const refFiles = ['art-ref-1.png', 'art-ref-2.png', 'art-ref-3.png'].filter(f => existsSync(f));
if (input.includes('FIXTURE_LATE_FRAME_REPAIR') || input.includes('FIXTURE_LATE_FRAME_INVALID')) {
  const bad = input.includes('FIXTURE_LATE_FRAME_INVALID') || calls === 1;
  proposal.files[0].content = `pal({a:'#70c989'})\nanim('canvas',{w:32,h:32},frame({ms:100},px(1,1,'a')),frame({ms:100},px(2,1,'${bad ? 'missing' : 'a'}')))`;
}
for (const file of refFiles) {
  if (args.includes('--print')) {
    if (!args[args.indexOf('--print') + 1].includes(file)) throw Error('Missing art reference viewer instruction');
  } else if (!args.some((arg,i)=>args[i-1]==='--image'&&arg.replaceAll('\\','/').endsWith('/'+file))) throw Error('Missing art reference --image argument');
}
proposal.description = `fixture alt=${altIndex}; calls=${calls}; preview=${existsSync('preview.png')}; refs=${refFiles.length}`;

let schemaHasManifest = false;
try {
  if (existsSync('response-schema.json')) {
    const s = JSON.parse(readFileSync('response-schema.json', 'utf8'));
    schemaHasManifest = Boolean(s.properties && s.properties.manifest);
  }
} catch {}

if (schemaHasManifest) {
  proposal.manifest = null;
}

if (input.includes('FIXTURE_MANIFEST_VALID')) {
  proposal.manifest = {
    version: 1,
    palette: { name: 'star-palette', colors: ['#70c989', '#ffffff'], ramps: null },
    materials: [{ name: 'star-body', colors: ['#70c989'] }],
    parts: [{ name: 'core', box: { x: 8, y: 8, w: 16, h: 16 } }],
    landmarks: [{ name: 'center', x: 16, y: 16 }],
  };
} else if (input.includes('FIXTURE_MANIFEST_REPAIR')) {
  if (calls === 1) {
    proposal.manifest = {
      version: 1,
      palette: null,
      materials: null,
      parts: [{ name: 'out-of-bounds', box: { x: 100, y: 100, w: 20, h: 20 } }],
      landmarks: null,
    };
  } else {
    proposal.manifest = {
      version: 1,
      palette: { name: 'repaired-palette', colors: ['#70c989'], ramps: null },
      materials: null,
      parts: [{ name: 'repaired-core', box: { x: 8, y: 8, w: 16, h: 16 } }],
      landmarks: null,
    };
  }
} else if (input.includes('FIXTURE_MANIFEST_INVALID')) {
  proposal.manifest = {
    version: 1,
    palette: null,
    materials: null,
    parts: [{ name: 'bad-bounds', box: { x: -5, y: -5, w: 10, h: 10 } }],
    landmarks: null,
  };
}

if (input.includes('PIXEL GENERATION SETTINGS')) {
  const [, w, h] = input.match(/Target canvas: (\d+)x(\d+)/), x = Math.floor(Number(w) / 2), y = Math.floor(Number(h) / 2);
  const ax = Math.min(currentAlt.x, Number(w) - 1), ay = Math.min(currentAlt.y, Number(h) - 1);
  let body = altMatch
    ? `rect(${ax},${ay},${Math.min(currentAlt.w, Number(w)-ax)},${Math.min(currentAlt.h, Number(h)-ay)},'${currentAlt.color}'),px(${Math.min(currentAlt.px,Number(w)-1)},${Math.min(currentAlt.py,Number(h)-1)},'#ffffff')${Number(w)*Number(h)>1&&(ax!==currentAlt.x||ay!==currentAlt.y)?`,px(0,0,'${currentAlt.color}')`:''}`
    : `rect(${Math.max(0,x-2)},${Math.max(0,y-2)},${Math.min(4,Number(w))},${Math.min(4,Number(h))},'#70c989'),px(${x},${y},'#ffffff')`;
  if (/\bFIXTURE_EMPTY\b/.test(input)) body = '';
  if (input.includes('FIXTURE_OUTSIDE')) body = "px(0,0,'#123456')";
  if (input.includes('FIXTURE_ALPHA')) body = "px(0,0,'#12345680')";
  if (input.includes('FIXTURE_MANY_COLORS')) body = Array.from({ length:17 }, (_,i) => `px(${i%Number(w)},${Math.floor(i/Number(w))},'#${(0x010101+i).toString(16).padStart(6,'0')}')`).join(',');
  const outline = input.includes('FIXTURE_OUTLINE') ? ",outline:'#172333'" : '';
  proposal.files = [{ path:'art.px.js', content:`sprite('canvas',{w:${w},h:${h}${outline}}${body ? ','+body : ''})` }];
  proposal.description = `fixture alt=${altIndex}; calls=${calls}; preview=${existsSync('preview.png')}; source=${input.includes('SOURCE_REFERENCE_MARKER')}; refs=${refFiles.length}`;
  if (input.includes('ONE-FRAME REGION EDIT FROM APPROVED REFERENCE') || input.includes('ONE-FRAME REGION EDIT')) {
    if (input.includes('movement-mask.png is a separate binary mask') && !existsSync('movement-mask.png')) throw new Error('Missing movement mask image');
    const msMatch = input.match(/duration (\d+) ms/);
    const duration = msMatch ? Number(msMatch[1]) : 100;
    proposal.files = [{
      path: 'art.px.js',
      content: `include('_pxl_reference.px.js');anim('canvas',{w:${w},h:${h},base:'_pxl_reference',loop:true},frame({ms:${duration}},px(0,0,'#123456'),px(${x},${y},'${currentAlt.color}')))`
    }];
    if (input.includes('FIXTURE_IMMUTABLE') && calls === 1) proposal.files.push({ path: '_pxl_reference.px.js', content: "sprite('_pxl_reference',{w:1,h:1})" });
  } else if (input.includes('ANIMATION FROM APPROVED REFERENCE')) {
    if (input.includes('movement-mask.png is a separate binary mask') && !existsSync('movement-mask.png')) throw new Error('Missing movement mask image');
    const [, count, ms] = input.match(/Return exactly (\d+) frames, each (\d+) ms/), loop = input.match(/loop:(true|false)/)[1];
    const n = Number(count) - (input.includes('FIXTURE_WRONG_FRAMES') ? 1 : 0), duration = Number(ms) + (input.includes('FIXTURE_WRONG_DURATION') ? 1 : 0);
    proposal.files = [{ path: 'art.px.js', content: `include('_pxl_reference.px.js');anim('canvas',{w:${w},h:${h},base:'_pxl_reference',loop:${loop}},${Array.from({ length: n }, (_, i) => `frame({ms:${duration}},px(0,0,'#123456'),px(${x},${y},'${i % 2 ? '#ffffff' : '#70c989'}'))`).join(',')})` }];
    if (input.includes('FIXTURE_IMMUTABLE') && calls === 1) proposal.files.push({ path: '_pxl_reference.px.js', content: "sprite('_pxl_reference',{w:1,h:1})" });
  }
}
// Structured shape fixture verifies the native render and attachment protocol.
if(args.includes('--pose-pilot')&&!input.includes('STRUCTURED SHAPE:')){
  proposal.files[0].content=proposal.files[0].content.replaceAll('#70c989','#db7252').replaceAll('#ffffff','#e2a36b');
}
if (input.includes('STRUCTURED SHAPE:')) {
  if (!existsSync('clip-guide.png') || !args.some((arg,i)=>args[i-1]==='--image'&&arg.replaceAll('\\','/').endsWith('/clip-guide.png')))
    throw Error('Missing pose guide image');
  const spec=JSON.parse(input.split(/\r?\n/).find(line=>line.startsWith('{"version":1,"camera":')));
  const [,w,h]=input.match(/Target canvas: (\d+)x(\d+)/).map(Number);
  const colors=['#24324b','#406d8b','#e2a36b','#db7252','#ae4f49','#69bea6'];
  const rx=Math.max(1, Math.round(w/30)), ry=Math.max(1,Math.round(h/30));
  const m=spec.landmarks;
  const at=(p,x,y)=>p??{x:Math.floor(w*x),y:Math.floor(h*y)};
  const dot=(p,sx,sy,color)=>`ellipse(${p.x},${p.y},${rx*sx},${ry*sy},'${color}')`;
  const bar=(a,b,color)=>{
    const n=Math.max(1,Math.abs(b.x-a.x),Math.abs(b.y-a.y));
    return Array.from({length:n+1},(_,i)=>dot({
      x:Math.round(a.x+(b.x-a.x)*i/n),y:Math.round(a.y+(b.y-a.y)*i/n),
    },1,1,color)).join(',');
  };
  const hips=at(m.hips,.5,.61);
  const support=spec.support;
  const leg=(part,ankle)=>{
    const p=at(ankle,.5,.82);
    return bar(hips,p,colors[1])+','+(support.part===part
      ? `rect(${Math.min(p.x,support.x)-rx},${p.y},${Math.abs(p.x-support.x)+2*rx+1},${Math.max(1,support.y-p.y+1)},'${colors[0]}')`
      : dot(p,2,1,colors[0]));
  };
  const layers={
    head:dot(m.head,3,3,colors[2])+','+dot({x:m.head.x,y:m.head.y-2*ry},3,1,colors[0]),
    torso:dot(m.torso,4,5,colors[3]),
    hips:dot(hips,3,2,colors[1]),
    near_arm:bar(at(m.nearShoulder,.56,.37),at(m.nearWrist,.68,.49),colors[3])+','+dot(at(m.nearWrist,.68,.49),1,1,colors[2]),
    far_arm:bar(at(m.farShoulder,.42,.37),at(m.farWrist,.32,.49),colors[4]),
    near_leg:leg('near_leg',m.nearAnkle),
    far_leg:leg('far_leg',m.farAnkle),
    prop:spec.grip?`rect(${spec.grip.x},${spec.grip.y-4*ry},1,${8*ry},'${colors[5]}')`:'',
  };
  const stamps=spec.order.map(part=>`stamp('_pose_${part}',0,0)`).join(',');
  proposal.files[0].content=spec.order.map(part=>`sprite('_pose_${part}',{w:${w},h:${h}},${layers[part]})`).join('\n')
    +`\nsprite('proposal',{w:${w},h:${h}},${stamps}${input.includes('FIXTURE_POSE_MISMATCH')?",px(0,0,'#24324b')":''})\n`;
  const pilot=input.match(/\bFIXTURE_POSE_PILOT_(64B-Y|128A-X)\b/);
  if(pilot)proposal.files[0].content=readFileSync(new URL('../test/fixtures/pose-pilot/'+pilot[1]+'.px.txt',import.meta.url),'utf8');
}
// Clip generation uses the app-generated selected-slot seed.
// orchestration/protection, not creative quality, and never reads real projects.
if (input.includes('CLIP REGENERATION FROM APPROVED REFERENCE:')) {
  if (!existsSync('clip-guide.png')) throw new Error('Missing clip guide image');
  if (args.includes('--print')) {
    if (!args[args.indexOf('--print') + 1].includes('clip-guide.png')) throw new Error('Missing clip guide viewer instruction');
  } else if (!args.some((arg, i) => args[i - 1] === '--image' && arg.replaceAll('\\', '/').endsWith('/clip-guide.png'))) {
    throw new Error('Missing clip guide --image argument');
  }
  proposal.files = [{ path: 'art.px.js', content: readFileSync('art.px.js', 'utf8') }];
}
if(input.includes('FIXTURE_EMPTY_ALWAYS')||input.includes('FIXTURE_EMPTY_REPAIR')&&calls===1)proposal.files[0].content="sprite('canvas',{w:32,h:32},()=>{rect(1,1,10,10,'#70c989')})";
if ((input.includes('FIXTURE_SOURCE_REPAIR') || input.includes('FIXTURE_REPAIR') || (altIndex === 2 && (input.includes('FIXTURE_SECOND_REPAIR') || input.includes('FIXTURE_REPAIR_2')))) && calls === 1) {
  proposal.files[0].content = 'not valid pixel art javascript (';
}
if(input.includes('FIXTURE_RESIZE'))proposal.files[0].content=proposal.files[0].content.replace('w:32,h:32','w:16,h:32');
if(input.includes('FIXTURE_UNDECLARED_PXL'))proposal.files[0].content="sprite('canvas',{w:32,h:32},px(0,0,k));";
if (args.includes('--print')) process.stdout.write(JSON.stringify(args.includes('--json-schema') ? { status:'SUCCESS', structured_output:proposal } : { status:'SUCCESS', response:JSON.stringify(proposal) }));
else { writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify(proposal)); process.stdout.write(JSON.stringify({type:'turn.completed'})+'\n'); }
