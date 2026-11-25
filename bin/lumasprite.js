#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error('LumaSprite Studio needs Node.js 22.18 or newer.');
  process.exitCode = 2;
} else {
  const { main } = await import('../dist/node/cli.js');
  process.exitCode = await main(process.argv.slice(2));
}
