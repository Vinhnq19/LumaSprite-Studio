import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 18) {
  console.error('Can Node.js 22.18 tro len.');
  process.exit(1);
}
if (!existsSync(join(root, 'dist/studio/index.html'))) {
  console.error('Chay npm ci va npm run build truoc khi mo Studio.');
  process.exit(1);
}

const args = process.argv.slice(2);
const openBrowser = process.platform === 'win32' && !args.includes('--no-browser');
const child = spawn(process.execPath, ['bin/lumasprite.js', 'studio', ...args.filter(arg => arg !== '--no-browser')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  console.log(line);
  const url = /^LumaSprite Studio: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(line)?.[1];
  if (openBrowser && url) {
    const browser = spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore' });
    browser.once('error', () => console.error(`Mo dia chi sau trong trinh duyet: ${url}`));
    browser.unref();
  }
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
process.once('SIGINT', () => child.kill('SIGINT'));
