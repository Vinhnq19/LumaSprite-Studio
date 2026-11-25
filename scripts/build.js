import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const source = join(root, 'src');
const studio = join(root, 'studio');
const output = join(root, 'dist');
if (!existsSync(join(studio, 'index.html'))) {
  if (!existsSync(join(output, 'studio', 'index.html'))) throw new Error('Studio source and prebuilt files are missing.');
} else {
  if (existsSync(output)) {
    if (lstatSync(output).isSymbolicLink() || realpathSync(output) !== output) throw new Error('Build output must be a local dist directory.');
    rmSync(output, { recursive: true, force: true });
  }
  for (const file of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.ts')) continue;
    const input = join(file.parentPath, file.name);
    const dest = join(output, relative(source, input).replace(/\.ts$/, '.js'));
    const code = stripTypeScriptTypes(readFileSync(input, 'utf8')).replace(/((?:from\s+|import\s*\()?['"]\.{1,2}\/[^'"\r\n]+)\.ts(?=['"])/g, '$1.js');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, code);
  }

  const { build } = await import('vite');
  await build({
    configFile: false,
    root: studio,
    build: { outDir: join(output, 'studio'), emptyOutDir: false, target: 'es2022', modulePreload: { polyfill: false } },
  });
}
