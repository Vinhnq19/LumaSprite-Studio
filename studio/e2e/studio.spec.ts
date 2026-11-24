import { test, expect } from '@playwright/test';
test.afterEach(async ({page},info)=>{if(info.status!==info.expectedStatus)console.log('STUDIO DIAGNOSTIC',await page.locator('#notice').textContent(),await page.locator('#save-status').textContent(),await page.locator('#build-status').textContent());});

async function create(page: import('@playwright/test').Page, name: string, template = 'blank') {
  await page.goto('/legacy.html'); await page.getByRole('button', { name: '+ Tạo mới' }).click();
  await page.locator('#new-name').fill(name); await page.locator('#template').selectOption(template); await page.locator('#create-form').getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(page.locator('#canvas')).toBeVisible(); await expect(page.locator('#build-status')).toContainText('asset');
}
test('Create → edit code → paint → undo → download → reopen → atlas', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  await create(page, 'Vườn thử nghiệm');
  await page.getByRole('button', { name: 'Mã nguồn', exact: true }).click();
  const source = "pal({g:'#70c989'})\nsprite('canvas',{w:32,h:32},rect(2,2,4,4,'g'))\nsheet('atlas',['canvas'])\n";
  await page.locator('.cm-content').fill(source); await expect(page.locator('#save-status')).toContainText('Đã lưu');
  await expect(page.locator('#build-status')).toContainText('asset');
  await page.getByRole('button', { name: 'Vẽ & xem', exact: true }).click();
  await page.locator('#color').fill('#ff0000'); await page.locator('#color').dispatchEvent('input');
  await page.locator('#canvas').click({ position: { x: 4, y: 4 } });
  await expect.poll(async () => {
    const id = await page.locator('#projects').inputValue(); const response = await page.request.get(`/api/studio/projects/${id}`); return (await response.json()).pixels.canvas?.frames?.['0']?.['0'];
  }).toBe(0xff0000ff);
  await page.locator('#undo').click();
  await expect.poll(async () => { const id=await page.locator('#projects').inputValue(); return (await(await page.request.get(`/api/studio/projects/${id}`)).json()).pixels.canvas?.frames?.['0']?.['0'] ?? null; }).toBeNull();
  await page.locator('#redo').click(); await expect(page.locator('#save-status')).toContainText('Đã lưu');
  const download = page.waitForEvent('download'); await page.getByRole('button',{name:'PNG gốc',exact:true}).click(); const file=await download; expect(file.suggestedFilename()).toBe('canvas.png');
  await page.reload(); await expect(page.locator('#canvas')).toBeVisible();
  await page.getByRole('button',{name:'Xem atlas',exact:true}).click(); await expect(page.locator('#asset-info')).toContainText('Atlas');
  const zip = page.waitForEvent('download'); await page.getByRole('button',{name:'Atlas + JSON',exact:true}).click(); expect((await zip).suggestedFilename()).toBe('atlas.zip');
  expect(failures).toEqual([]);
  if(process.env.PXL_STUDIO_SCREENSHOT){await page.locator('.asset').first().click();await page.getByRole('button',{name:'Mã + ảnh',exact:true}).click();await page.screenshot({path:process.env.PXL_STUDIO_SCREENSHOT,fullPage:true});}
});
test('AI proposals: CLI and HTTP preview without writes, explicit apply and history', async ({ page }) => {
  await create(page,'AI đề xuất'); const id=await page.locator('#projects').inputValue();
  for(const provider of ['codex','deepseek']){
    await page.locator('#provider').selectOption(provider);await page.locator('#prompt').fill('Vẽ ngôi sao bằng palette hiện tại');
    const before=await(await page.request.get(`/api/studio/projects/${id}`)).json();
    await page.locator('#generate').click(); await expect(page.locator('#proposal')).toBeVisible({timeout:15000});
    const pending=await(await page.request.get(`/api/studio/projects/${id}`)).json(); expect(pending.revision).toBe(before.revision);
    await page.locator('#apply-ai').click(); await expect(page.locator('#proposal')).toBeHidden();
    await expect.poll(async()=> (await(await page.request.get(`/api/studio/projects/${id}`)).json()).revision).toBe(before.revision+1);
  }
  await page.locator('#history').click(); await expect(page.locator('#history-list')).toContainText('Trước khi áp dụng AI');
});
test('Legacy AI: unknown state blocks generation and permits explicit same-job cancel checks without polling', async ({ page }) => {
  await create(page, 'Legacy unknown UI'); const id = await page.locator('#projects').inputValue();
  const before = await (await page.request.get(`/api/studio/projects/${id}`)).json();
  const job = { id: 'unknown-ui-fixture', projectId: id, revision: before.revision, provider: 'deepseek', started: Date.now(),
    status: 'unknown', message: 'Chưa xác nhận dừng cục bộ; nhà cung cấp có thể vẫn xử lý.' };
  let starts = 0, polls = 0; const canceledUrls: string[] = [];
  await page.route(`**/api/studio/projects/${id}/ai`, route => { starts++; return route.fulfill({ json: job }); });
  await page.route('**/api/studio/ai/unknown-ui-fixture', route => { polls++; return route.fulfill({ json: job }); });
  await page.route('**/api/studio/ai/unknown-ui-fixture/cancel', route => {
    canceledUrls.push(route.request().url());
    return route.fulfill({ json: { ...job, status: canceledUrls.length === 1 ? 'unknown' : 'canceled' } });
  });
  await page.locator('#provider').selectOption('deepseek'); await page.locator('#prompt').fill('Tác vụ UI giả lập'); await page.locator('#generate').click();
  await expect(page.locator('#generate')).toBeDisabled(); await expect(page.locator('#cancel-ai')).toHaveText('Kiểm tra lại việc hủy');
  await page.locator('#cancel-ai').click(); await expect(page.locator('#cancel-ai')).toBeEnabled(); await expect(page.locator('#generate')).toBeDisabled();
  await page.locator('#cancel-ai').click(); await expect(page.locator('#cancel-ai')).toBeDisabled(); await expect(page.locator('#generate')).toBeEnabled();
  expect(starts).toBe(1); expect(polls).toBe(0); expect(canceledUrls).toHaveLength(2); expect(canceledUrls[0]).toBe(canceledUrls[1]);
  expect((await (await page.request.get(`/api/studio/projects/${id}`)).json()).revision).toBe(before.revision);
});

test('Selection, fill, flip, frame editing, one-shot preview and painting trace', async ({page})=>{
  await create(page,'Animation','animation');
  await page.locator('#frame').evaluate((el: HTMLInputElement)=>{el.value='2';el.dispatchEvent(new Event('input',{bubbles:true}))});await expect(page.locator('#frame-info')).toContainText('3/8');
  await page.getByRole('button',{name:'Tô vùng',exact:true}).click();await page.locator('#canvas').click({position:{x:4,y:4}});await expect(page.locator('#save-status')).toContainText('Đã lưu');
  await page.getByRole('button',{name:'Chọn vùng',exact:true}).click();const box=(await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x+4,box.y+4);await page.mouse.down();await page.mouse.move(box.x+28,box.y+28);await page.mouse.up();
  await page.locator('#copy').click();await page.locator('#paste').click();await page.locator('#flip-x').click();
  await page.locator('#trace').click();await expect(page.locator('#trace-panel')).toBeVisible();
});
test('External edits preserve the unsaved draft; reload saves a separate copy', async ({page})=>{
  await create(page,'Xung đột');const id=await page.locator('#projects').inputValue();
  const original=await(await page.request.get(`/api/studio/projects/${id}`)).json();
  await page.getByRole('button',{name:'Mã nguồn',exact:true}).click();
  const draft=original.files[original.entry]+'\n// local draft';
  await page.locator('.cm-content').fill(draft);
  const other=await page.request.put(`/api/studio/projects/${id}`,{headers:{origin:'http://127.0.0.1:4329'},data:{revision:original.revision,changes:{files:{[original.entry]:original.files[original.entry]+'\n// external'}}}});expect(other.ok()).toBeTruthy();
  await expect(page.locator('#notice')).toContainText(/thay đổi|xung đột/i);
  await expect(page.locator('.cm-content')).toContainText('local draft');
  expect((await(await page.request.get(`/api/studio/projects/${id}`)).json()).files[original.entry]).not.toContain('local draft');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#reload').click();
  await expect(page.locator('.cm-content')).toContainText('external');
  const projects=await(await page.request.get('/api/studio/projects')).json();const copy=projects.find((p:any)=>p.name==='Xung đột (bản nháp)');expect(copy).toBeTruthy();
  expect((await(await page.request.get(`/api/studio/projects/${copy.id}`)).json()).files[original.entry]).toContain('local draft');
});
test('Layer visibility persists; resize conflicts block export and explicit rebase restores it', async ({page})=>{
  await create(page,'Chuyển lớp');const id=await page.locator('#projects').inputValue();
  await page.locator('#canvas').click({position:{x:4,y:4}});await expect.poll(async()=>Object.keys((await(await page.request.get(`/api/studio/projects/${id}`)).json()).pixels).length).toBe(1);
  await page.locator('#overlay').uncheck();await expect.poll(async()=>(await(await page.request.get(`/api/studio/projects/${id}`)).json()).pixels.canvas.enabled).toBe(false);
  await page.locator('#overlay').check();await expect.poll(async()=>(await(await page.request.get(`/api/studio/projects/${id}`)).json()).pixels.canvas.enabled).toBe(true);
  await page.getByRole('button',{name:'Mã nguồn',exact:true}).click();
  const doc=await(await page.request.get(`/api/studio/projects/${id}`)).json();await page.locator('.cm-content').fill(doc.files[doc.entry].replace('w: 32','w: 16'));
  await expect(page.locator('#pixel-conflicts')).toBeVisible();
  const latest=await(await page.request.get(`/api/studio/projects/${id}`)).json();
  const blocked=await page.request.post(`/api/studio/projects/${id}/export`,{headers:{origin:'http://127.0.0.1:4329'},data:{revision:latest.revision,name:'canvas',format:'png'}});expect(blocked.ok()).toBeFalsy();
  await page.getByRole('button',{name:'Vẽ & xem',exact:true}).click();await page.locator('#rebase').click();await expect(page.locator('#pixel-conflicts')).toBeHidden();
  const saved=await(await page.request.get(`/api/studio/projects/${id}`)).json();expect(saved.pixels.canvas.layout.w).toBe(16);
});
