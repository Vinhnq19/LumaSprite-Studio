import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fastHttpFixture } from '../test/fixtures/fast-http.ts';
import { startExternalEngine } from '../test/fixtures/external-engine.ts';
import { rpgAgentToken } from '../test/fixtures/production-rpg.ts';
const root = mkdtempSync(join(tmpdir(), 'pxl-studio-browser-'));
const { serveStudio } = process.env.PXL_RC_COMPILED
  ? await import(new URL('../dist/node/studio/server.js', import.meta.url).href) as typeof import('../src/node/studio/server.ts')
  : await import('../src/node/studio/server.ts');
const external = await startExternalEngine();
process.once('exit', () => { void external.stop(); });
const app = await serveStudio(root, { port: 4329, uiDir: resolve('dist/studio'), externalEnginePort: external.port, agentWriteToken: rpgAgentToken,
  providers: { codex: process.execPath, deepseek: fastHttpFixture(root), prefix: [resolve('studio/fake-cli.js'), '--state-dir', root], timeout: 5000 } });
console.log(app.url);
async function stop() { await app.close(); await external.stop(); rmSync(root, { recursive: true, force: true }); process.exit(0); }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
