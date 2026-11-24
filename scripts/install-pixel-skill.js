// Install only our repository-owned skill. No package manager or CLI config edits.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function skillHashes(root) {
  const result = {};
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path), key = prefix + name;
      if (stat.isSymbolicLink()) throw new Error('Skill installation refuses symlinks: ' + key);
      if (stat.isDirectory()) walk(path, key + '/');
      else if (stat.isFile()) result[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
      else throw new Error('Unsupported skill entry: ' + key);
    }
  }
  walk(root); return result;
}

export function installSkill(source, target, write = false) {
  const hashes = skillHashes(source);
  if (!hashes['SKILL.md']) throw new Error('Missing skill entrypoint');
  const existing = existsSync(target);
  if (existing && JSON.stringify(skillHashes(target)) !== JSON.stringify(hashes)) throw new Error('Existing skill differs; preserved without overwrite: ' + target);
  if (write && !existing) { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true, errorOnExist: true, force: false }); }
  if (write && JSON.stringify(skillHashes(target)) !== JSON.stringify(hashes)) throw new Error('Skill copy verification failed: ' + target);
  return { target, status: existing ? 'identical' : write ? 'installed' : 'would-install', hashes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), home = homedir();
  const source = join(root, 'skills/pxl-art');
  const targets = [
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'skills/pxl-art') : join(home, '.agents/skills/pxl-art'),
    join(home, '.gemini/antigravity-cli/skills/pxl-art'),
    join(home, '.gemini/antigravity/skills/pxl-art'),
  ];
  const write = process.argv.includes('--install');
  console.log(JSON.stringify({ skill: 'pxl-art', write, copies: targets.map(target => installSkill(source, target, write)) }, null, 2));
}
