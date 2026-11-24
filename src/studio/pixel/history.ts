type Path = (string | number)[];
interface Change { path: Path; before: any; after: any; indices?: Uint32Array }
interface Entry { label: string; changes: Change[]; bytes: number }
// Immutable pixel buffers are shared by snapshots. Editing a cel must replace its buffer first.
export function snapshot<T>(value: T): T {
  if (!value || typeof value !== 'object' || value instanceof Uint32Array) return value;
  if (Array.isArray(value)) return value.map(snapshot) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)])) as T;
}
function differences(before: any, after: any, path: Path = [], out: Change[] = []): Change[] {
  if (before === after) return out;
  if (before instanceof Uint32Array && after instanceof Uint32Array && before.length === after.length) {
    const indices: number[] = [], old: number[] = [], next: number[] = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { indices.push(i); old.push(before[i]); next.push(after[i]); }
    if (indices.length) out.push({ path, indices: Uint32Array.from(indices), before: Uint32Array.from(old), after: Uint32Array.from(next) });
  } else if (before && after && typeof before === 'object' && typeof after === 'object' && !(before instanceof Uint32Array) && !(after instanceof Uint32Array) && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) differences(before[key], after[key], [...path, key], out);
  } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let i = 0; i < before.length; i++) differences(before[i], after[i], [...path, i], out);
  } else out.push({ path, before: snapshot(before), after: snapshot(after) });
  return out;
}
function size(value: any): number {
  if (value instanceof Uint32Array) return value.byteLength;
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((s, v) => s + size(v), 32);
  return typeof value === 'string' ? value.length * 2 : 8;
}
export class PixelHistory {
  private past: Entry[] = []; private future: Entry[] = []; bytes = 0; trimmed = false;
  readonly limit: number; readonly count: number;
  constructor(limit = 64 * 1024 * 1024, count = 100) { this.limit = limit; this.count = count; }
  clear(): void { this.past = []; this.future = []; this.bytes = 0; this.trimmed = false; }
  nextPaths(redo = false): Path[] {
    const from = redo ? this.future : this.past;
    const entry = from.at(-1);
    if (!entry) return [];
    return entry.changes.filter(c => c.indices !== undefined).map(c => [...c.path]);
  }
  commit(before: any, after: any, label: string): boolean {
    const changes = differences(before, after).filter(c => !['revision'].includes(String(c.path[0])));
    if (!changes.length) return false;
    const entry = { changes, label, bytes: size(changes) };
    this.future = []; this.past.push(entry); this.bytes = this.past.reduce((s, e) => s + e.bytes, 0);
    while (this.past.length > this.count || this.bytes > this.limit) { this.bytes -= this.past.shift()!.bytes; this.trimmed = true; }
    return true;
  }
  undo(target: any, redo = false): string | undefined {
    const from = redo ? this.future : this.past, to = redo ? this.past : this.future, entry = from.pop(); if (!entry) return;
    for (const c of redo ? entry.changes : [...entry.changes].reverse()) {
      let p = target; for (const k of c.path.slice(0, -1)) p = p[k]; const key = c.path.at(-1)!;
      const value = redo ? c.after : c.before;
      if (c.indices) { const next = p[key].slice(); for (let i = 0; i < c.indices.length; i++) next[c.indices[i]] = value[i]; p[key] = next; }
      else if (value === undefined) delete p[key]; else p[key] = snapshot(value);
    }
    to.push(entry); return entry.label;
  }
}
