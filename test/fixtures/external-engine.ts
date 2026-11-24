import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export async function startExternalEngine(version = 1) {
  const script = fileURLToPath(new URL('../../scripts/mock-external-engine.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0', '--version', String(version)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const output = createInterface({ input: child.stdout });
  const closed = once(child, 'exit');
  const stop = async () => { child.kill(); await closed; };
  try {
    const ready = await Promise.race([
      once(output, 'line').then(([line]) => String(line)),
      closed.then(() => { throw Error('External Mock Engine exited before binding.'); }),
    ]);
    output.close();
    return { url: ready, port: Number(new URL(ready).port), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
