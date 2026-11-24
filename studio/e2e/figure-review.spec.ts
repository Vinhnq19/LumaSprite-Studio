import { test, expect } from '@playwright/test';

test('Codex shape review waits for approval and can reopen the saved flat image', async ({ page }) => {
  const r=await page.request.post('/api/pixel/projects',{headers:{origin:'http://127.0.0.1:4329'},data:{name:'Figure UI',w:18,h:24}});
  expect(r.ok()).toBeTruthy();
  const doc=await r.json();
  await page.goto('/');
  await page.locator('#projects').selectOption(doc.id);
  await expect(page.locator('#asset-info')).toContainText('18 × 24');
  await page.locator('#ai-workspace-open').click();
  await page.locator('#figure-open').click();
  await page.locator('[data-brief]').fill('Knight');
  await page.locator('[data-start]').click();
  await expect(page.locator('[data-approve]')).toBeEnabled({timeout:20000});
  await expect(page.locator('[data-apply]')).toBeDisabled();
  await page.locator('[data-scale]').selectOption('1');
  await expect(page.locator('[data-shadow]')).toHaveCSS('width','18px');
  await page.locator('[data-color]').click();
  await page.locator('[data-save-shape]').click();
  await expect(page.locator('[data-original]')).toBeVisible();
  await expect(page.locator('[data-apply]')).toBeDisabled();
  await page.locator('[data-approve]').click();
  await expect(page.locator('[data-apply]')).toBeEnabled({timeout:20000});
  await page.locator('dialog[open] button[data-close]').last().click();
  await page.locator('#figure-open').click();
  await expect(page.locator('[data-history] option')).toHaveCount(4);
  for(const id of await page.locator('[data-history] option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value).filter(Boolean))){
    await page.locator('[data-history]').selectOption(id);
    await expect(page.locator('[data-history]')).toBeEnabled();
    if(await page.locator('[data-apply]').isEnabled()) break;
  }
  await expect(page.locator('[data-brief]')).toHaveValue('Knight');
  await page.locator('[data-note]').fill('Sửa cụm sáng ở giữa');
  await page.locator('[data-color]').click();
  await page.locator('[data-repair]').click();
  await expect(page.locator('[data-before]')).toBeVisible({timeout:20000});
  await expect(page.locator('[data-original]')).toBeVisible();
  await page.locator('[data-marks]').check();
  await page.locator('[data-apply]').click();
  await expect(page.locator('[data-apply]')).toHaveCount(0);
});

test('optional pose guide shows native pixels and keeps the prior shape after a part move', async ({page})=>{
  const r=await page.request.post('/api/pixel/projects',{headers:{origin:'http://127.0.0.1:4329'},data:{name:'Structured figure UI',w:64,h:64}});
  expect(r.ok()).toBeTruthy();
  const doc=await r.json();
  doc.assets[0].palette=[0,0x24324bff,0x406d8bff,0xe2a36bff,0xdb7252ff,0xae4f49ff,0x69bea6ff];
  const saved=await page.request.put('/api/pixel/projects/'+doc.id,{
    headers:{origin:'http://127.0.0.1:4329'},data:{revision:doc.revision,document:doc},
  });
  expect(saved.ok()).toBeTruthy();
  await page.goto('/');
  await page.locator('#projects').selectOption(doc.id);
  await expect(page.locator('#asset-info')).toContainText('64 × 64');
  await page.locator('#ai-workspace-open').click();
  await page.locator('#figure-open').click();
  await page.locator('[data-brief]').fill('Shape fixture with a tool');
  await page.getByText('Lập kế hoạch bằng mốc dáng').click();
  await expect(page.locator('[data-use-pose]')).not.toBeChecked();
  await page.locator('[data-example]').click();
  await expect(page.locator('[data-use-pose]')).toBeChecked();
  await page.locator('[data-start]').click();
  await expect(page.locator('[data-move]')).toBeVisible({timeout:20000});
  await expect(page.locator('[data-apply]')).toBeDisabled();
  const readCanvas=()=>page.locator('[data-color]').evaluate(c=>(c as HTMLCanvasElement).toDataURL());
  const original=await readCanvas();
  const originalId=await page.locator('[data-history]').inputValue();
  await expect(page.locator('[data-color]')).toHaveCSS('width','64px');
  await page.locator('[data-overlay]').check();
  expect(await readCanvas()).not.toEqual(original);
  await page.locator('[data-overlay]').uncheck();
  expect(await readCanvas()).toEqual(original);
  await page.locator('[data-scale]').selectOption('4');
  await expect(page.locator('[data-shadow]')).toHaveCSS('width','256px');
  await page.locator('[data-part]').selectOption('prop');
  await page.locator('[data-dx]').fill('6');
  await page.locator('[data-move]').click();
  await expect(page.locator('[data-original]')).toBeVisible();
  expect(await readCanvas()).not.toEqual(original);
  await expect(page.getByRole('list',{name:'Cảnh báo hình học'})).toContainText('điểm nắm');
  await page.locator('[data-marks]').check();
  await page.locator('[data-history]').selectOption(originalId);
  await expect(page.locator('[data-original]')).toBeHidden();
  expect(await readCanvas()).toEqual(original);
});

test('static PXL failure shows symbol and location and leaves the editor revision intact', async ({page})=>{
  const headers={origin:'http://127.0.0.1:4329'};
  const r=await page.request.post('/api/pixel/projects',{headers,data:{name:'Source diagnostic fixture',w:64,h:64,background:0xffffffff}});
  expect(r.ok()).toBeTruthy();
  const doc=await r.json();
  await page.goto('/');
  await page.locator('#projects').selectOption(doc.id);
  await expect(page.locator('#asset-info')).toContainText('64 × 64');
  await page.locator('#ai-workspace-open').click();
  await page.locator('#figure-open').click();
  await page.getByText('Lập kế hoạch bằng mốc dáng').click();
  await page.locator('[data-example-empty]').click();
  await page.locator('[data-brief]').fill('FIXTURE_POSE_PILOT_64B-Y');
  await page.locator('[data-start]').click();
  await expect(page.locator('[data-status]')).toContainText('art.px.js:6:76: k is not defined',{timeout:20000});
  await expect(page.locator('[data-status]')).toContainText('chưa khai báo');
  await expect(page.locator('[data-apply]')).toBeDisabled();
  await expect(page.locator('[data-approve]')).toBeDisabled();
  const saved=await page.request.get('/api/pixel/projects/'+doc.id);
  expect(await saved.json()).toEqual(doc);
  await page.locator('dialog[open] [data-close]').last().click();
  await expect(page.locator('#asset-info')).toContainText('64 × 64');
});
