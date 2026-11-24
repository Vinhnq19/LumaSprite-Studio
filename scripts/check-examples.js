import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadProject, writeOutputs } from '../dist/index.js';
const artifacts = mkdtempSync(join(tmpdir(), 'pxl-examples-check-'));
try {
  let failed = 0;
  for (const file of readdirSync('examples').filter(f => f.endsWith('.px.js'))) {
    const start = performance.now(), p = loadProject(resolve('examples', file));
    const result = writeOutputs(p, join(artifacts, file), { preview: false });
    console.log(JSON.stringify({ file, ms: Math.round(performance.now() - start), errors: result.errors.map(e => e.message) }));
    if (result.errors.length) failed++;
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  if (resolve(dirname(artifacts)) !== resolve(tmpdir())) throw new Error('Refusing cleanup outside temporary directory');
  rmSync(artifacts, { recursive: true, force: true });
}
