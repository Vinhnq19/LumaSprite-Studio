import { agentInputBytes, agentPath, agentVersion, type AgentCode } from '../studio/agent-contract.ts';

const help = `lumasprite agent capabilities [--port 4321]
lumasprite agent call [--port 4321]

Start Studio with lumasprite studio --root DIR first. The CLI only connects to 127.0.0.1.
'call' reads one v1 JSON request from stdin. Responses are JSON on stdout.
Optional mutations use LUMASPRITE_AGENT_WRITE_TOKEN from the process environment.
Exit codes: 0 success, 2 usage or validation, 3 permission, 4 conflict/not ready,
5 unavailable or processing failure.`;

export async function agentCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.length === 1 && ['-h', '--help'].includes(argv[0])) { console.log(help); return 0; }
  const failure = (code: AgentCode, message: string, exit: number) => {
    const error = { code, message };
    console.log(JSON.stringify({ version: agentVersion, requestId: null, operation: null, projectId: null, revision: null, status: 'error', diagnostics: [error], error }));
    return exit;
  };
  const [command, flag, rawPort] = argv, port = argv.length === 1 ? 4321 : Number(rawPort);
  if (!['capabilities', 'call'].includes(command) || (argv.length !== 1 && !(argv.length === 3 && flag === '--port' && /^\d{1,5}$/.test(rawPort))) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return failure('INVALID_REQUEST', 'Xem lumasprite agent --help.', 2);
  }
  let body = JSON.stringify({ version: agentVersion, operation: 'capabilities', input: {} });
  if (command === 'call') {
    if (process.stdin.isTTY) return failure('INVALID_REQUEST', 'Truyền JSON qua stdin.', 2);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > agentInputBytes) return failure('LIMIT_EXCEEDED', 'JSON Agent tối đa 1 MiB.', 2);
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  }
  const origin = `http://127.0.0.1:${port}`;
  try {
    const token = process.env.LUMASPRITE_AGENT_WRITE_TOKEN ?? process.env.PXL_AGENT_WRITE_TOKEN;
    const response = await fetch(origin + agentPath, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { origin, 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body });
    const result = await response.json();
    if (result?.version !== agentVersion || result.status !== (response.ok ? 'ok' : 'error')) {
      return failure('STUDIO_UNAVAILABLE', 'Studio không trả JSON Agent v1 hợp lệ.', 5);
    }
    console.log(JSON.stringify(result));
    if (response.ok) return 0;
    if (response.status === 403) return 3;
    if (response.status === 409) return 4;
    return response.status >= 500 ? 5 : 2;
  } catch {
    return failure('STUDIO_UNAVAILABLE', 'Không nhận được phản hồi Agent v1. Kiểm tra cổng Studio.', 5);
  }
}
