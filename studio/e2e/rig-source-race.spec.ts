import { test, expect } from '@playwright/test';

test('Rig source: own save and file-watch SSE cannot conflict while its committed POST response is held', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.EventSource; (window as any).rigSse = [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('message', event => { try { (window as any).rigSse.push(JSON.parse(event.data)); } catch {} });
      }
    };
  });
  const response = await page.request.post('/api/pixel/projects', { headers: { origin: 'http://127.0.0.1:4329' }, data: { name: 'Giữ phản hồi nguồn', w: 18, h: 18, background: 0x70c989ff } });
  expect(response.ok()).toBe(true); const doc = await response.json();
  await page.goto('/'); await page.locator('#projects').selectOption(doc.id); await expect(page.locator('#asset-info')).toContainText('18 × 18');
  let committed = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/projects/${doc.id}/rig-drafts`, async route => {
    const response = await route.fetch(); expect(response.ok(), await response.text()).toBe(true); committed = true;
    await gate; await route.fulfill({ response });
  });
  try {
    await page.locator('#rig-open').click(); await page.locator('#rig-btn-create-source').click();
    await expect.poll(() => committed).toBe(true);
    await page.waitForFunction(id => (window as any).rigSse.some((e: any) => e.type === 'pixel-external' && e.projectId === id && e.revision === 2), doc.id);
    await expect(page.locator('#rig-status-badge')).not.toContainText('Xung đột'); await expect(page.locator('#rig-btn-close')).toBeDisabled();
    expect(await page.locator('.workspace').evaluate(e => (e as HTMLElement).inert)).toBe(true);
    release(); await expect(page.locator('#rig-btn-review')).toBeEnabled({ timeout: 15000 });
    await expect(page.locator('#rig-error')).not.toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
