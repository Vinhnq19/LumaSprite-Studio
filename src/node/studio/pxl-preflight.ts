import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import type { Identifier, Node, Program } from 'estree';
import { posix, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Project } from '../../core/project.ts';
import { compilePxlSource } from '../load.ts';
import type { StudioDiagnostic } from '../../studio/diagnostic.ts';
import { StudioError } from './store.ts';

const vmGlobals = new Set<string>([
  ...Object.keys(new Project().env()),
  ...runInNewContext('Object.getOwnPropertyNames(globalThis)'),
  'console',
]);
const posixName = (file: string) => process.platform === 'win32' ? file.replaceAll('\\', '/').toLowerCase() : file;

function sourceError(code: StudioDiagnostic['code'], file: string, node: Node, detail: string, identifier?: string) {
  const { line, column } = node.loc!.start;
  const message = identifier
    ? `Biến “${identifier}” chưa khai báo. Với khóa palette, truyền chuỗi như '${identifier}' thay cho tên biến.`
    : detail;
  return new StudioError(`${file}:${line}:${column + 1}: ${detail}`, 400, {
    code, message, location: { file, line, column: column + 1 }, ...(identifier ? { identifier } : {}),
  });
}

function* astNodes(root: Node): Generator<Node> {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    yield node;
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child.type === 'string') pending.push(child);
    }
  }
}

/** Inspect the reachable scripts in the shared PXL VM without evaluating candidate code. */
export function validatePxlReferences(files: Readonly<Record<string, string>>, entry: string): void {
  const options = { ecmaVersion: 2024, locations: true, ranges: true } as const;
  const paths = new Map(Object.keys(files).map(file => [posixName(file), file]));
  const visited = new Set<string>();
  const known = new Set(vmGlobals);
  const unresolved: { file: string; identifier: Identifier }[] = [];
  let runtimeScope = false;
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    let code: string;
    try { code = compilePxlSource(files[file], file); }
    catch { runtimeScope = true; return; }
    let program: Program;
    try { program = parse(code, { ...options, sourceType: 'script' }) as unknown as Program; }
    catch {
      let module: Program;
      try { module = parse(code, { ...options, sourceType: 'module' }) as unknown as Program; }
      catch { runtimeScope = true; return; }
      const declaration = module.body.find(node => node.type === 'ImportDeclaration' || node.type.startsWith('Export'));
      if (declaration) throw sourceError('PXL_MODULE_UNSUPPORTED', file, declaration, 'PXL dùng include() cho file nguồn, chưa hỗ trợ import/export.');
      return;
    }
    const global = analyze(program, { ecmaVersion: options.ecmaVersion, sourceType: 'script', optimistic: true }).globalScope!;
    for (const variable of global.variables) known.add(variable.name);
    const references = new Set<Identifier>(global.through.map(ref => ref.identifier));
    const exempt = new Set<Identifier>();
    for (const node of astNodes(program)) {
      if (node.type === 'WithStatement' || node.type === 'ThisExpression') runtimeScope = true;
      if (node.type === 'UnaryExpression' && (node.operator === 'typeof' || node.operator === 'delete') && node.argument.type === 'Identifier') exempt.add(node.argument);
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'include' || !references.has(node.callee)) continue;
      exempt.add(node.callee);
      const arg = node.arguments[0];
      if (arg?.type !== 'Literal' || typeof arg.value !== 'string') { runtimeScope = true; continue; }
      const absolute = posix.isAbsolute(arg.value) || (process.platform === 'win32' && win32.isAbsolute(arg.value));
      const target = absolute ? undefined : paths.get(posix.normalize(posix.join(posix.dirname(posixName(file)), posixName(arg.value))));
      // The loader remains authoritative for includes outside the captured literal graph.
      if (target) visit(target);
      else runtimeScope = true;
    }
    for (const ref of global.through) {
      const name = ref.identifier.name;
      if (exempt.has(ref.identifier)) continue;
      if (['include', 'globalThis', 'eval', 'Function'].includes(name)) runtimeScope = true;
      if (ref.isWriteOnly() && !ref.from.isStrict) known.add(name);
      unresolved.push({ file, identifier: ref.identifier });
    }
  }
  visit(entry);
  // Dynamic shared globals and include order are resolved by the existing loader.
  if (runtimeScope) return;
  const error = unresolved.find(({ identifier }) => !known.has(identifier.name));
  if (error) {
    const name = error.identifier.name;
    throw sourceError('PXL_UNDECLARED_IDENTIFIER', error.file, error.identifier, `${name} is not defined`, name);
  }
}
