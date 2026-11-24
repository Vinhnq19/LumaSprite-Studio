// Offline validation for this deliberately simple skill frontmatter and links.
// No Python/PyYAML installation or global configuration is required.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillHashes } from './install-pixel-skill.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../skills/pxl-art');
const files=skillHashes(root),entry=readFileSync(join(root,'SKILL.md'),'utf8');
const front=entry.match(/^---\r?\n([\s\S]*?)\r?\n---/);assert.ok(front,'Missing YAML frontmatter');
const fields=Object.fromEntries(front[1].split(/\r?\n/).map(line=>{const at=line.indexOf(':');assert.ok(at>0,'Use simple scalar frontmatter');return[line.slice(0,at),line.slice(at+1).trim()];}));
assert.deepEqual(Object.keys(fields).sort(),['description','name']);assert.equal(fields.name,'pxl-art');assert.ok(fields.description.length>20&&fields.description.length<=1024);
assert.ok(!/[<>]|\[TODO:/.test(fields.description));
for(const name of Object.keys(files).filter(n=>n.endsWith('.md'))){
  const content=readFileSync(join(root,name),'utf8');assert.ok(!/\[TODO:/.test(content),name+' unfinished');
  for(const match of content.matchAll(/\]\(([^)]+)\)/g)){
    if(/^(?:https?:|#)/.test(match[1]))continue;
    const target=resolve(dirname(join(root,name)),match[1]),rel=relative(root,target);assert.ok(rel!=='..'&&!rel.startsWith('..'+sep));assert.ok(existsSync(target),'Broken link '+name+':'+match[1]);
  }
}
assert.ok(files['UPSTREAM-LICENSE']&&files['UPSTREAM.md']);
console.log(JSON.stringify({skill:'pxl-art',frontmatter:'passed',links:'passed',files:Object.keys(files).length,hashes:files}));
