import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// JS installer is shared by source and extracted package.
// @ts-ignore no JS declarations needed for this runtime acceptance
import { installSkill } from '../scripts/install-pixel-skill.js';
test('Skill install: dry run writes nothing, exact copies are idempotent, differing user files are preserved',()=>{
  const root=mkdtempSync(join(tmpdir(),'pxl-skill-install-')),source=join(root,'source'),target=join(root,'target');
  try{mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: test\ndescription: test\n---\n');
    assert.equal(installSkill(source,target).status,'would-install');assert.equal(existsSync(target),false);
    assert.equal(installSkill(source,target,true).status,'installed');assert.equal(installSkill(source,target,true).status,'identical');
    writeFileSync(join(target,'SKILL.md'),'user version');assert.throws(()=>installSkill(source,target,true),/preserved/);assert.equal(readFileSync(join(target,'SKILL.md'),'utf8'),'user version');
  }finally{rmSync(root,{recursive:true,force:true});}
});
