import { test, expect } from '@playwright/test';
import { round, decision } from '../fixture';

test('live observation rotates new dialogue, holds on pause and prioritizes resident selection', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/status', (route) => route.fulfill({ json: { configured: true } }));
  await page.route('**/api/turn', (route) => {
    calls++;
    return route.fulfill({ json: { round } });
  });
  await page.route('**/api/decide', (route) => {
    calls++;
    return route.fulfill({ json: { decision } });
  });
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.goto('/?paused=1');
  const bubble = page.getByLabel('地图对白');
  await expect(bubble).toHaveCount(0);
  await page.getByRole('button', { name: '开始观察', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.clock.fastForward(3000);
  await expect(bubble).toContainText(round.decisions[1].speech);
  await page.getByRole('button', { name: '暂停观察', exact: true }).click();
  await page.clock.fastForward(10000);
  await expect(bubble).toContainText(round.decisions[1].speech);
  await page.getByRole('button', { name: '选择居民回声', exact: true }).click();
  await expect(bubble).toContainText(round.decisions[4].speech);
  await page.getByRole('textbox').fill('取消选择后也要保留的草稿');
  await page.getByRole('button', { name: '开始观察', exact: true }).click();
  await page.clock.fastForward(3000);
  await expect(bubble).toContainText(round.decisions[2].speech);
  // Either surface toggles the same selection, and deselection resumes the queue.
  await page.getByRole('button', { name: '查看回声', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择居民回声', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: '查看回声', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: /小镇动态/ })).toHaveClass('active');
  await expect(bubble).toContainText(round.decisions[3].speech);
  await page.getByRole('button', { name: '选择居民回声', exact: true }).click();
  await expect(bubble).toContainText(round.decisions[4].speech);
  await expect(page.getByRole('textbox')).toHaveValue('取消选择后也要保留的草稿');
  await page.getByRole('textbox').fill('回声，你在想什么？');
  await page.getByRole('textbox').press('Enter');
  await expect(bubble).toContainText(decision.speech);
  expect(calls).toBe(2);
  const slider = page.getByRole('slider', { name: '回放时间线' });
  await slider.focus();
  await slider.press('Home');
  await expect(bubble).toHaveCount(0);
  await page.clock.fastForward(15000);
  await expect(bubble).toHaveCount(0);
  expect(calls).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('a completed round clears after its last utterance without extra model requests', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/status', (route) => route.fulfill({ json: { configured: true } }));
  await page.route('**/api/turn', (route) => {
    calls++;
    return route.fulfill({ json: { round } });
  });
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.goto('/?paused=1');
  await page.getByRole('button', { name: '开始观察', exact: true }).click();
  const bubble = page.getByLabel('地图对白');
  for (const line of round.decisions) {
    await expect(bubble).toContainText(line.speech);
    await page.clock.fastForward(3000);
  }
  await expect(bubble).toHaveCount(0);
  expect(calls).toBe(1);
});
