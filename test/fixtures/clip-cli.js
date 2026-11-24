// Parent-owned deterministic CLI protocol fixture. Never calls a real provider.
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
if (args.includes('login')) { process.stdout.write('Logged in using clip fixture\n'); process.exit(0); }
const anti = args.includes('--print');
const printed = anti ? option('--print') : undefined;
const prompt = printed?.includes('You are creating pixel art with pxl.') ? printed : anti ? readFileSync('request.md', 'utf8') : await new Promise(resolve => {
  let value = ''; process.stdin.on('data', chunk => { value += chunk; }); process.stdin.on('end', () => resolve(value));
});
const scenario = option('--scenario') ?? 'valid', logRoot = option('--state-dir');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const imageNames = ['preview.png', 'movement-mask.png', 'clip-guide.png', 'art-ref-1.png', 'art-ref-2.png', 'art-ref-3.png'].filter(existsSync);
const supplied = anti ? imageNames.filter(name => option('--print').includes(name))
  : args.flatMap((arg, i) => args[i - 1] === '--image' ? [arg.replaceAll('\\', '/').split('/').at(-1)] : []);
if (logRoot) appendFileSync(join(logRoot, 'clip-cli-log.jsonl'), JSON.stringify({
  provider: anti ? 'antigravity' : 'codex', scenario, prompt, supplied,
  images: Object.fromEntries(imageNames.map(name => [name, digest(name)])),
}) + '\n');
const entry = readFileSync('art.px.js', 'utf8'), helper = readdirSync('.').find(name => name.startsWith('_pxl_clip_master')) ?? '_pxl_reference.px.js';
const files = [{ path: 'art.px.js', content: entry }];
if (scenario.startsWith('owned-') || scenario === 'legacy-case') {
  const alias = scenario.endsWith('case') ? helper.slice(0, -6).toUpperCase() + '.px.js' : scenario.endsWith('dot') ? `./${helper}`
    : scenario.endsWith('backslash') ? `.\\${helper}` : helper;
  files.push({ path: alias, content: readFileSync(helper, 'utf8') });
}
if (scenario === 'duplicate-alias') files.push({ path: './ART.px.js', content: entry });
if (scenario === 'modify-copy') writeFileSync(helper, "sprite('_pxl_clip_master',{w:1,h:1})");
const response = JSON.stringify({ description: 'Deterministic clip fixture', files, manifest: null });
if (anti) process.stdout.write(JSON.stringify(args.includes('--json-schema') ? { status: 'SUCCESS', structured_output: JSON.parse(response) } : { status: 'SUCCESS', response }));
else {
  writeFileSync(option('--output-last-message'), response);
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
}
