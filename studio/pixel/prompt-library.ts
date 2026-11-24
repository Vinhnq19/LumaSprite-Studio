import { promptTemplates, buildTemplatePrompt } from '../../src/studio/prompt-templates.ts';
import { generationStyles, generationViews } from '../../src/studio/generation.ts';
import type { PixelAsset } from '../../src/studio/pixel/model.ts';

export function setupPromptLibrary(currentAsset: () => PixelAsset | undefined): { update: () => void } {
  const host = document.getElementById('prompt-library')!;
  host.innerHTML = `<details id="prompt-library-panel"><summary>Mẫu prompt · ${promptTemplates.length} mẫu</summary><label>Chọn mẫu<select id="prompt-template" aria-label="Mẫu prompt"></select></label><label>Chủ thể / thay đổi mong muốn<input id="template-subject" maxlength="300" aria-label="Chủ thể của mẫu"></label><p id="template-tip" class="hint"></p><p id="template-context" class="hint"></p><textarea id="template-preview" rows="7" readonly aria-label="Xem trước prompt mẫu"></textarea><div class="row wrap"><button id="template-use" type="button">Dùng mẫu</button><button id="template-undo" type="button" disabled>Hoàn tác chèn mẫu</button></div><small>Dùng mẫu thay nội dung, đặt phong cách/góc nhìn/tham chiếu gợi ý. Giữ canvas và palette. Chưa chạy AI.</small><p id="template-status" role="status"></p></details>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const choice = $<HTMLSelectElement>('prompt-template'), subject = $<HTMLInputElement>('template-subject'), preview = $<HTMLTextAreaElement>('template-preview'), prompt = $<HTMLTextAreaElement>('ai-prompt');
  const style = $<HTMLSelectElement>('ai-style'), view = $<HTMLSelectElement>('ai-view'), reference = $<HTMLInputElement>('ai-reference');
  const use = $<HTMLButtonElement>('template-use'), undo = $<HTMLButtonElement>('template-undo');
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const t of promptTemplates) {
    let group = groups.get(t.group); if (!group) { group = document.createElement('optgroup'); group.label = t.group; groups.set(t.group, group); choice.append(group); }
    const option = document.createElement('option'); option.value = t.id; option.textContent = t.name; group.append(option);
  }
  let lastContext: string | undefined, previous: { prompt: string; style: string; view: string; reference: boolean } | undefined;
  const selected = () => promptTemplates.find(t => t.id === choice.value)!;
  function showPreview(): void {
    const a = currentAsset(), t = selected(); use.disabled = !a;
    $('template-tip').textContent = t.tip;
    $('template-context').textContent = `${a ? `Canvas đang dùng: ${a.w}×${a.h}` : 'Tạo/mở dự án để dùng mẫu'} · Gợi ý: ${t.suggestedSize} · ${generationStyles[t.style]} · ${generationViews[t.view]}${t.reference ? ' · Bật tham chiếu' : ''}`;
    preview.value = a ? buildTemplatePrompt(t, a.w, a.h, subject.value) : '';
  }
  choice.onchange = () => { subject.value = selected().subject; $('template-status').textContent = ''; showPreview(); };
  subject.oninput = showPreview;
  use.onclick = () => {
    const a = currentAsset(); if (!a) return;
    const t = selected(); previous = { prompt: prompt.value, style: style.value, view: view.value, reference: reference.checked };
    prompt.value = buildTemplatePrompt(t, a.w, a.h, subject.value); style.value = t.style; view.value = t.view; reference.checked = t.reference;
    prompt.dispatchEvent(new Event('input', { bubbles: true })); undo.disabled = false;
    $('template-status').textContent = `Đã chèn “${t.name}”. Sửa mô tả nếu cần rồi bấm Tạo đề xuất.`;
  };
  undo.onclick = () => {
    if (!previous) return;
    prompt.value = previous.prompt; style.value = previous.style; view.value = previous.view; reference.checked = previous.reference;
    prompt.dispatchEvent(new Event('input', { bubbles: true })); previous = undefined; undo.disabled = true;
    $('template-status').textContent = 'Đã khôi phục mô tả và cấu hình trước khi chèn mẫu.';
  };
  subject.value = selected().subject;
  showPreview();
  return { update: () => {
    const a = currentAsset(), key = a ? `${a.id}:${a.w}:${a.h}` : '';
    if (key === lastContext) return;
    previous = undefined; undo.disabled = true; lastContext = key; $('template-status').textContent = '';
    showPreview();
  } };
}
