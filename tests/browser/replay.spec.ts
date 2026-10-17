import { test, expect, type Page } from '@playwright/test';
import {
  addHumanMessage,
  applyChatReply,
  applyRound,
  createWorld,
  exportReplay,
} from '../../src/world/engine';
import { decision, round } from '../fixture';

async function prepare(page: Page, count = 6) {
  let calls = 0;
  await page.route('**/api/status', (route) => route.fulfill({ json: { configured: true } }));
  await page.route(/\/api\/(turn|decide|commands)$/, (route) => {
    calls++;
    return route.fulfill({ status: 500, json: { error: 'Replay must not invoke a model' } });
  });
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.goto('/?paused=1');
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeEnabled();
  const snapshots = [createWorld()];
  for (let i = 1; i < count; i++) snapshots.push(applyRound(snapshots.at(-1)!, round));
  await page.getByLabel('导入回放文件').setInputFiles({
    name: 'replay.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportReplay(snapshots)),
  });
  await expect(page.locator('.live-pill')).toHaveText('REPLAY');
  return () => calls;
}

test('replay supports seeking, single frames, all speeds and stops at the end without model calls', async ({
  page,
}) => {
  const calls = await prepare(page);
  const progress = page.getByLabel('回放进度');
  const slider = page.getByRole('slider', { name: '回放时间线' });
  const rate = page.getByRole('combobox', { name: '回放倍速' });
  await expect(progress).toHaveText('第 1 天 08:00 · 1/6');
  await expect(page.getByRole('button', { name: '上一帧', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '下一帧', exact: true }).click();
  await expect(progress).toContainText('08:15 · 2/6');
  await page.getByRole('button', { name: '上一帧', exact: true }).click();
  for (const [speed, duration] of [
    [0.5, 2000],
    [1, 1000],
    [2, 500],
    [4, 250],
  ]) {
    await slider.focus();
    await slider.press('Home');
    await rate.selectOption(String(speed));
    await page.getByRole('button', { name: '播放回放', exact: true }).click();
    await page.clock.fastForward(duration - 1);
    await expect(slider).toHaveValue('0');
    await page.clock.fastForward(1);
    await expect(slider).toHaveValue('1');
    await expect(page.getByLabel('地图对白')).toContainText(round.decisions[0].speech);
    await page.clock.fastForward(duration * 3 - 1);
    await expect(page.getByLabel('地图对白')).toContainText(round.decisions[0].speech);
    await page.clock.fastForward(1);
    await expect(page.getByLabel('地图对白')).toContainText(round.decisions[1].speech);
    await page.getByRole('button', { name: '暂停回放', exact: true }).click();
    await page.clock.fastForward(duration * 2);
    await expect(slider).toHaveValue('1');
  }
  await slider.focus();
  await slider.press('Home');
  await page.getByRole('button', { name: '播放回放', exact: true }).click();
  await page.clock.fastForward(250);
  // Every resident gets a turn before moving to the next snapshot.
  for (let index = 1; index <= 5; index++) {
    for (const entry of round.decisions) {
      await expect(page.getByLabel('地图对白')).toContainText(entry.speech);
      await page.clock.fastForward(750);
    }
    await expect(slider).toHaveValue(String(Math.min(index + 1, 5)));
  }
  await expect(progress).toContainText('09:15 · 6/6');
  await expect(page.getByRole('button', { name: '播放回放', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一帧', exact: true })).toBeDisabled();
  await expect(page.locator('.live-pill')).toHaveText('REPLAY');
  await expect(page.getByRole('button', { name: '投放事件', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '播放回放', exact: true }).click();
  await expect(slider).toHaveValue('0');
  // A manual seek pauses playback, including while the timer is running.
  await slider.press('End');
  await page.clock.fastForward(2000);
  await expect(slider).toHaveValue('5');
  await expect(page.getByRole('button', { name: '播放回放', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回当前世界', exact: true }).click();
  await expect(page.locator('.live-pill')).toHaveText('LIVE');
  await page.clock.fastForward(10000);
  expect(calls()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('a single snapshot disables playback and frame navigation', async ({ page }) => {
  const calls = await prepare(page, 1);
  for (const name of ['播放回放', '上一帧', '下一帧']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  await expect(page.getByRole('slider', { name: '回放时间线' })).toBeDisabled();
  await expect(page.getByLabel('回放进度')).toContainText('1/1');
  expect(calls()).toBe(0);
});

test('map dialogue appears automatically during replay and distinguishes human input from replies', async ({
  page,
}) => {
  const calls = await prepare(page);
  const initial = createWorld();
  const first = applyRound(initial, round);
  const human = addHumanMessage(first, 'mira', '回放中的人类消息 👋');
  const reply = applyChatReply(human, 'mira', decision, human.conversations.at(-1)!.id);
  await page.getByLabel('导入回放文件').setInputFiles({
    name: 'dialogue.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportReplay([initial, first, human, reply])),
  });
  const bubble = page.getByLabel('地图对白');
  await expect(bubble).toHaveCount(0);
  await page.getByRole('combobox', { name: '回放倍速' }).selectOption('1');
  await page.getByRole('button', { name: '播放回放', exact: true }).click();
  await page.clock.fastForward(1000);
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '暂停回放', exact: true }).click();
  await page.getByRole('button', { name: '查看米拉', exact: true }).click();
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '下一帧', exact: true }).click();
  await expect(bubble).toContainText('回放中的人类消息 👋');
  await expect(bubble).toContainText('人类观察员 → 米拉');
  await expect(bubble).not.toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '下一帧', exact: true }).click();
  await expect(bubble).toContainText(decision.speech);
  await page.getByRole('button', { name: '上一帧', exact: true }).click();
  await expect(bubble).toContainText('回放中的人类消息 👋');
  expect(calls()).toBe(0);
});

test('cancelling Soren focus replays all residents, with pause, speed changes and seeking', async ({
  page,
}) => {
  const calls = await prepare(page, 3);
  const bubble = page.getByLabel('地图对白');
  const slider = page.getByRole('slider', { name: '回放时间线' });
  const soren = page.getByRole('button', { name: '查看索伦', exact: true });
  const rate = page.getByRole('combobox', { name: '回放倍速' });
  await page.getByRole('button', { name: '下一帧', exact: true }).click();
  await soren.click();
  await expect(soren).toHaveAttribute('aria-pressed', 'true');
  await expect(bubble).toContainText(round.decisions[5].speech);
  await page.getByRole('button', { name: '播放回放', exact: true }).click();
  await page.clock.fastForward(1000);
  await soren.click();
  await expect(soren).toHaveAttribute('aria-pressed', 'false');
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.clock.fastForward(2999);
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.clock.fastForward(1);
  await expect(bubble).toContainText(round.decisions[1].speech);
  await expect(slider).toHaveValue('1');
  await page.getByRole('button', { name: '暂停回放', exact: true }).click();
  await page.clock.fastForward(20000);
  await expect(bubble).toContainText(round.decisions[1].speech);
  await rate.selectOption('2');
  await page.getByRole('button', { name: '播放回放', exact: true }).click();
  for (let i = 2; i < 6; i++) {
    await page.clock.fastForward(1499);
    await expect(bubble).toContainText(round.decisions[i - 1].speech);
    await page.clock.fastForward(1);
    await expect(bubble).toContainText(round.decisions[i].speech);
    await expect(slider).toHaveValue('1');
  }
  await page.clock.fastForward(1500);
  await expect(slider).toHaveValue('2');
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '暂停回放', exact: true }).click();
  await page.clock.fastForward(10000);
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '播放回放', exact: true }).click();
  await expect(slider).toHaveValue('2');
  await page.clock.fastForward(1500);
  await expect(bubble).toContainText(round.decisions[1].speech);
  // Seeking to an earlier snapshot resets its dialogue cursor and pauses the player.
  await slider.focus();
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('1');
  await expect(bubble).toContainText(round.decisions[0].speech);
  await page.clock.fastForward(10000);
  await expect(bubble).toContainText(round.decisions[0].speech);
  await expect(page.getByRole('button', { name: '播放回放', exact: true })).toBeVisible();
  expect(calls()).toBe(0);
});
