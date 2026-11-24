export interface Command { id: string; title: string; keys: string[]; run: () => void; temporary?: boolean; release?: () => void; enabled?: () => boolean }
export type Bindings = Record<string, string[]>;
export const reserved = ['Ctrl+n', 'Ctrl+w', 'Ctrl+t', 'Ctrl+l', 'Ctrl+Shift+n', 'Ctrl+Shift+t', 'Alt+F4', 'F5', 'Ctrl+r'];
export function normalizeBinding(value: string): string {
  const parts = value.trim().split('+').map(p => p.trim()), modifiers: string[] = [];
  const key = parts.pop() ?? ''; const names: Record<string, string> = { ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Ctrl', meta: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  for (const p of parts) { const m = names[p.toLowerCase()]; if (!m || modifiers.includes(m)) throw new Error(`Tổ hợp phím không hợp lệ: ${value}`); modifiers.push(m); }
  const special: Record<string, string> = { space: 'Space', escape: 'Escape', esc: 'Escape', enter: 'Enter', delete: 'Delete', backspace: 'Backspace', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', alt: 'Alt', shift: 'Shift', control: 'Control', tab: 'Tab' };
  const canonical = key.length === 1 ? key.toLowerCase() : special[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : '');
  if (!canonical) throw new Error(`Tên phím không hợp lệ: ${value}`);
  return [...['Ctrl', 'Alt', 'Shift'].filter(m => modifiers.includes(m)), canonical].join('+');
}
export function shortcut(e: KeyboardEvent): string {
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['Alt', 'Control', 'Shift', 'Meta'].includes(key)) return key;
  return [...(e.ctrlKey || e.metaKey ? ['Ctrl'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey && (e.key.length > 1 || /[a-z]/i.test(e.key)) ? ['Shift'] : []), key].join('+');
}
export function bindingErrors(bindings: Bindings, ids: string[]): string[] {
  const used = new Map<string, string>(), errors: string[] = [];
  for (const [id, keys] of Object.entries(bindings)) {
    if (!ids.includes(id) || !Array.isArray(keys) || keys.some(k => typeof k !== 'string' || k.length > 50)) { errors.push(`Lệnh/phím không hợp lệ: ${id}`); continue; }
    for (const raw of keys) { let key: string; try { key = normalizeBinding(raw); } catch (e) { errors.push((e as Error).message); continue; } if (reserved.some(r => r.toLowerCase() === key.toLowerCase())) errors.push(`${key}: Chrome/Windows giữ tổ hợp này.`); const previous = used.get(key); if (previous && previous !== id) errors.push(`${key}: trùng ${previous} và ${id}.`); used.set(key, id); }
  }
  return errors;
}
export class Commands {
  items = new Map<string, Command>(); bindings: Bindings = {}; private held = new Set<string>();
  add(command: Command): void { this.items.set(command.id, command); }
  defaults(preset: 'aseprite' | 'studio' = 'aseprite'): Bindings {
    const bindings = Object.fromEntries([...this.items.values()].map(c => [c.id, [...c.keys]]));
    if (preset === 'studio') bindings['tool.pen'] = ['b']; return bindings;
  }
  configure(value: Bindings): void {
    const merged = { ...this.defaults(), ...value }, errors = bindingErrors(merged, [...this.items.keys()]); if (errors.length) throw new Error(errors.join('\n'));
    this.bindings = Object.fromEntries(Object.entries(merged).map(([id, keys]) => [id, keys.map(normalizeBinding)]));
  }
  execute(id: string): void { const c = this.items.get(id); if (c && (!c.enabled || c.enabled())) { if (id.startsWith('tool.') && !c.temporary) this.release(); c.run(); } }
  release(): void { for (const id of this.held) this.items.get(id)?.release?.(); this.held.clear(); }
  listen(target: Window = window): () => void {
    const down = (e: KeyboardEvent) => {
      const el = e.target as Element | null;
      if (e.isComposing || e.keyCode === 229 || el?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false]),.cm-editor,dialog[open]')) return;
      if ((e.key === 'Enter' || e.key === ' ') && el?.closest?.('button,summary,a[href]')) return;
      const key = shortcut(e), id = Object.keys(this.bindings).find(id => this.bindings[id].includes(key)); if (!id) return;
      const c = this.items.get(id); if (!c || c.enabled && !c.enabled()) return;
      e.preventDefault(); if (c.temporary) { if (this.held.has(id)) return; this.held.add(id); c.run(); } else this.execute(id);
    };
    const up = (e: KeyboardEvent) => { const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key; for (const id of [...this.held]) if (this.bindings[id].some(binding => binding.split('+').includes(key) || key === 'Control' && binding.includes('Ctrl'))) { this.items.get(id)?.release?.(); this.held.delete(id); } };
    const release = () => this.release();
    const visibility = () => { if (target.document.hidden) this.release(); };
    const pointer = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('button,input,textarea,select,summary,dialog')) { this.release(); return; }
      // A browser host may consume keyup. Pointer modifier flags remain authoritative.
      for (const id of [...this.held]) if (this.bindings[id].some(binding => binding.split('+').some(k => k === 'Alt' && !e.altKey || k === 'Ctrl' && !e.ctrlKey && !e.metaKey || k === 'Shift' && !e.shiftKey))) { this.items.get(id)?.release?.(); this.held.delete(id); }
    };
    target.addEventListener('keydown', down); target.addEventListener('keyup', up); target.addEventListener('blur', release); target.addEventListener('focus', release);
    target.addEventListener('pointerdown', pointer, true); target.document.addEventListener('visibilitychange', visibility);
    return () => { this.release(); target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); target.removeEventListener('blur', release); target.removeEventListener('focus', release); target.removeEventListener('pointerdown', pointer, true); target.document.removeEventListener('visibilitychange', visibility); };
  }
}
