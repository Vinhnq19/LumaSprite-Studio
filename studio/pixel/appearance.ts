import type { PixelCanvas } from './canvas.ts';

const themes = {
  neutral: ['#929aa7', '#b8bec8'],
  light: ['#d2d6dc', '#f0f2f5'],
  dark: ['#222934', '#303a48'],
} satisfies Record<string, [string, string]>;
type Theme = keyof typeof themes;
const storageKey = 'pxl.pixel.appearance';

export function setupAppearance(painter: PixelCanvas): void {
  const workspace = document.querySelector<HTMLInputElement>('#workspace-color')!;
  const checker = document.querySelector<HTMLSelectElement>('#checker-theme')!;
  const width = document.querySelector<HTMLInputElement>('#sidebar-width')!;
  const label = document.querySelector<HTMLOutputElement>('#sidebar-width-value')!;
  let saved: Record<string, unknown> = {};
  try { const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}'); if (value && typeof value === 'object') saved = value; } catch { /* Keep defaults if preferences are unavailable. */ }
  workspace.value = typeof saved.workspace === 'string' && /^#[\da-f]{6}$/i.test(saved.workspace) ? saved.workspace : '#454b56';
  checker.value = typeof saved.checker === 'string' && Object.hasOwn(themes, saved.checker) ? saved.checker : 'neutral';
  width.value = String(typeof saved.width === 'number' && Number.isFinite(saved.width) ? Math.max(280, Math.min(520, saved.width)) : 360);
  function apply(): void {
    document.documentElement.style.setProperty('--workspace-color', workspace.value);
    document.documentElement.style.setProperty('--sidebar-width', `${width.value}px`);
    label.value = `${width.value} px`;
    painter.checker = themes[checker.value as Theme]; painter.draw();
  }
  function update(): void {
    apply();
    try { localStorage.setItem(storageKey, JSON.stringify({ workspace: workspace.value, checker: checker.value, width: Number(width.value) })); } catch { /* Drawing still works without local storage. */ }
  }
  for (const field of [workspace, checker, width]) field.addEventListener('input', update);
  document.querySelector('#appearance-reset')!.addEventListener('click', () => { workspace.value = '#454b56'; checker.value = 'neutral'; width.value = '360'; update(); });
  apply();
}
