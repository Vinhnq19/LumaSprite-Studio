#!/usr/bin/env node
// Entry point. In a checkout it runs the TypeScript sources directly (Node >= 22.18 strips types);
// installed under node_modules, where Node refuses to strip types, it runs the dist/ build.
// Hide Node's experimental warnings about type stripping so agent output stays clean.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  console.error(`pxl needs Node >= 22.15 (found ${process.versions.node})`);
  process.exit(2);
}

const installed = /\/node_modules\//.test(decodeURIComponent(import.meta.url));
const cliPath = installed || (major === 22 && minor < 18) ? "../dist/node/cli.js" : "../src/node/cli.ts";
const { main } = await import(cliPath);
process.exitCode = await main(process.argv.slice(2));
