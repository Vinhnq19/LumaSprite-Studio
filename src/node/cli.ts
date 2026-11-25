import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agentCli } from './agent-cli.ts';

const help = `LumaSprite Studio
  lumasprite studio [--root DIR] [--port 4321]
  lumasprite agent --help
`;

export async function main(args: string[]): Promise<number> {
  const [command, ...flags] = args;
  if (command === 'agent') return agentCli(flags);
  if (!command || command === '--help' || command === '-h' || (command === 'studio' && flags.length === 1 && ['-h', '--help'].includes(flags[0]))) {
    console.log(help);
    return 0;
  }
  if (command !== 'studio') {
    console.error(`Unknown command: ${command}\n${help}`);
    return 2;
  }
  try {
    const { values } = parseArgs({ args: flags, options: { root: { type: 'string' }, port: { type: 'string' } } });
    const root = resolve(values.root ?? 'projects');
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!/^\d+$/.test(values.port!) || port > 65535)) throw new Error('Use a port between 0 and 65535.');
    const { serveStudio } = await import('./studio/server.ts');
    const studio = await serveStudio(root, { port });
    console.log(`LumaSprite Studio: ${studio.url}  (workspace: ${root}; Ctrl+C to stop)`);
    return await new Promise<number>(done => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        void studio.close().then(() => done(0), error => { console.error(error); done(1); });
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
