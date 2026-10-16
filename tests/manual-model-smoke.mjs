// Manual only: makes exactly three paid model requests against the running local server.
// Never included in npm test or Playwright's automatic test discovery.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const responses = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (response) => {
    if (/\/api\/(turn|decide)$/.test(response.url()))
      responses.push({
        endpoint: new URL(response.url()).pathname,
        status: response.status(),
        payload: await response.json(),
      });
  });
  const firstRequest = page.waitForRequest((r) => r.url().endsWith('/api/turn'));
  const navigation = await page.goto(process.env.SMOKE_URL || 'http://127.0.0.1:4180/');
  expect(navigation.status()).toBe(200);
  await firstRequest;
  await page.getByRole('button', { name: '暂停观察', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:15', { timeout: 40000 });
  await page.getByRole('button', { name: '投放事件', exact: true }).click();
  await page.getByRole('button', { name: /下一场星星雨/ }).click();
  await expect(page.locator('.clock')).toContainText('08:30', { timeout: 40000 });
  await page.getByRole('button', { name: '选择居民回声' }).click();
  await page.getByLabel('对回声说句话').fill('你喜欢这场星星雨吗？');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.bottom-bar')).toContainText('3 次调用', { timeout: 40000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(responses).toHaveLength(3);
  expect(responses.every((r) => r.status === 200)).toBe(true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/real-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '重置视角' }).click();
  await page.screenshot({ path: 'artifacts/real-mobile.png', fullPage: true });
  const report = {
    model: await page.locator('.model-badge').innerText(),
    calls: responses.map((r) => ({
      endpoint: r.endpoint,
      status: r.status,
      usage: r.payload.usage,
    })),
    lastSpeech: await page.locator('.speech-preview p').innerText(),
    renderer: await page.locator('.town-canvas').getAttribute('data-renderer'),
    errors,
  };
  await writeFile('artifacts/real-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
