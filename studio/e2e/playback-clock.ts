import type { Page } from '@playwright/test';

/** Fire one due timer while the monotonic clock says more time has elapsed. */
export async function lateTimer(page: Page, extraElapsed: number) {
  await page.evaluate(offset => {
    const now = performance.now.bind(performance);
    (window as any).__restorePixelPlaybackClock = () => Object.defineProperty(performance, 'now', { configurable: true, value: now });
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + offset });
  }, extraElapsed);
  await page.clock.runFor(120);
  await page.evaluate(() => { (window as any).__restorePixelPlaybackClock(); delete (window as any).__restorePixelPlaybackClock; });
}
