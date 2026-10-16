import { chromium } from '@playwright/test';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const ids = ['mira', 'otto', 'lin', 'ada', 'echo', 'soren'];
await page.route('**/api/status', (r) =>
  r.fulfill({ json: { configured: true, model: 'qwen3.8-flash', wireApi: 'responses' } }),
);
await page.route('**/api/turn', (r) =>
  r.fulfill({
    json: {
      round: {
        decisions: ids.map((agentId, i) => ({
          agentId,
          action: 'socialize',
          location: ['hall', 'market', 'farm', 'workshop', 'cafe', 'garden'][i],
          speech: '今天，想做一点不一样的事情。',
          reason: '思考今天的生活',
        })),
      },
      usage: { input: 1000, output: 450 },
    },
  }),
);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:4180');
await page.getByText('08:15', { exact: true }).waitFor();
await page.getByRole('button', { name: '暂停观察', exact: true }).click();
await page.locator('canvas').waitFor();
await page.evaluate(
  () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
);
await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(
  () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
);
await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
console.log(
  JSON.stringify({
    errors,
    renderer: await page.locator('.town-canvas').getAttribute('data-renderer'),
    overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  }),
);
await browser.close();
