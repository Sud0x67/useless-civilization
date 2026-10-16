import { test, expect, type Page } from '@playwright/test';
import { createWorld, exportReplay } from '../../src/world/engine';
import { decision, round } from '../fixture';

async function prepare(page: Page) {
  const messages: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { configured: true, model: 'qwen3.8-flash', wireApi: 'responses' } }),
  );
  await page.route('**/api/turn', (r) =>
    r.fulfill({ json: { round, usage: { input: 100, output: 50 } } }),
  );
  await page.route('**/api/decide', (r) => {
    messages.push(r.request().postDataJSON().prompt);
    return r.fulfill({ json: { decision, usage: { input: 100, output: 20 } } });
  });
  await page.goto('/?paused=1');
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeEnabled();
  return messages;
}
async function fullTimeline(page: Page) {
  const world = createWorld();
  world.feed = Array.from({ length: 90 }, (_, index) => ({
    id: 90 - index,
    minute: 480,
    type: 'social' as const,
    actor: 'mira' as const,
    text: `历史动态 ${90 - index}：小镇今天发生的故事。`,
    source: 'model' as const,
  }));
  world.nextId = 91;
  await page.getByLabel('导入回放文件').setInputFiles({
    name: 'history.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportReplay([world])),
  });
  await expect(page.locator('.live-pill')).toHaveText('REPLAY');
  await page.getByRole('button', { name: '返回当前世界' }).click();
}
const bottomGap = (page: Page) =>
  page
    .getByRole('region', { name: '小镇动态时间线' })
    .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

test('town activity reads oldest to newest and follows new entries at the bottom', async ({
  page,
}) => {
  await prepare(page);
  await fullTimeline(page);
  const rows = page.locator('.feed-item');
  await expect(rows.first()).toHaveAttribute('data-feed-id', '1');
  await expect(rows.last()).toHaveAttribute('data-feed-id', '90');
  expect(await bottomGap(page)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '运行一轮', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  await expect(rows.first()).toHaveAttribute('data-feed-id', '7');
  await expect(rows.last()).toHaveAttribute('data-feed-id', '96');
  expect(
    await rows.evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.feedId))),
  ).toEqual(Array.from({ length: 90 }, (_, i) => i + 7));
  expect(await bottomGap(page)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: '正在跟随最新动态', exact: true })).toBeDisabled();
});

test('reading history keeps the same visible entry as old rows expire and new rows arrive', async ({
  page,
}, info) => {
  await prepare(page);
  await fullTimeline(page);
  const list = page.getByRole('region', { name: '小镇动态时间线' });
  await list.evaluate((el) => {
    const row = el.querySelector<HTMLElement>('[data-feed-id="40"]')!;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeEnabled();
  const offset = () =>
    list.evaluate(
      (el) =>
        el.querySelector('[data-feed-id="40"]')!.getBoundingClientRect().top -
        el.getBoundingClientRect().top,
    );
  const before = await offset();
  await page.getByRole('button', { name: '运行一轮', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  await expect(
    page.getByRole('button', { name: '回到最新（6 条新动态）', exact: true }),
  ).toBeEnabled();
  expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
  expect(await bottomGap(page)).toBeGreaterThan(500);
  await page.screenshot({ path: info.outputPath('reading-history.png'), fullPage: true });
  await page.getByRole('button', { name: '回到最新（6 条新动态）', exact: true }).click();
  await expect(page.getByRole('button', { name: '正在跟随最新动态', exact: true })).toBeDisabled();
  expect(await bottomGap(page)).toBeLessThanOrEqual(1);
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeEnabled();
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole('button', { name: '正在跟随最新动态', exact: true })).toBeDisabled();
});

test('tablet activity stays in one vertical reading column', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await prepare(page);
  await fullTimeline(page);
  const rows = await page.locator('.feed-item').evaluateAll((els) =>
    els.slice(-3).map((el) => ({
      top: el.getBoundingClientRect().top,
      left: el.getBoundingClientRect().left,
    })),
  );
  expect(rows[0].top).toBeLessThan(rows[1].top);
  expect(rows[1].top).toBeLessThan(rows[2].top);
  expect(new Set(rows.map((row) => row.left)).size).toBe(1);
});

test('Enter sends and Shift+Enter inserts a line break without sending', async ({ page }, info) => {
  const messages = await prepare(page);
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  const input = page.getByLabel('对米拉说句话');
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二行');
  await expect(input).toHaveValue('第一行\n第二行');
  expect(messages).toEqual([]);
  await input.press('Enter');
  await expect(page.locator('.chat-bubble.model')).toContainText(decision.speech);
  expect(messages).toEqual(['第一行\n第二行']);
  await expect(input).toHaveValue('');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(messages).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('keyboard-chat.png'), fullPage: true });
});

test('IME confirmation and held Enter do not accidentally submit the draft', async ({ page }) => {
  const messages = await prepare(page);
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  const input = page.getByLabel('对米拉说句话');
  await input.fill('中文输入测试');
  await input.dispatchEvent('compositionstart', { data: 'zhongwen' });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await expect(input).toHaveValue('中文输入测试');
  await input.dispatchEvent('compositionend', { data: '中文' });
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
    keyCode: 13,
  });
  await expect(input).toHaveValue('中文输入测试');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await expect(input).toHaveValue('中文输入测试');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
  await expect(input).toHaveValue('中文输入测试');
  expect(messages).toEqual([]);
  await input.press('Enter');
  await expect(page.locator('.chat-bubble.model')).toHaveCount(1);
  expect(messages).toEqual(['中文输入测试']);
});

test('Enter can queue another message while a human reply is in progress', async ({ page }) => {
  await prepare(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const messages: string[] = [];
  await page.route('**/api/decide', async (r) => {
    const text = r.request().postDataJSON().prompt;
    messages.push(text);
    if (messages.length === 1) await gate;
    await r.fulfill({
      json: {
        decision: { ...decision, speech: `收到：${text}` },
        usage: { input: 100, output: 20 },
      },
    });
  });
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  const input = page.getByLabel('对米拉说句话');
  await input.fill('第一条');
  await input.press('Enter');
  await expect(page.locator('.conversation-history')).toContainText('等待回应');
  await input.fill('第二条');
  await input.press('Enter');
  await expect(page.locator('.conversation-history')).toContainText('已排队');
  await expect(input).toHaveValue('');
  release();
  await expect(page.locator('.chat-bubble.model')).toHaveCount(2);
  expect(messages).toEqual(['第一条', '第二条']);
});
