import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SharedTown } from '../../server/town.mjs';
import { createHandler } from '../../server/app.mjs';
import { openCouncil, COUNCIL_DURATION } from '../../src/world/council';
import type { World } from '../../src/shared/schema';
import { round } from '../fixture';

let town: SharedTown, server: Server, base: string, now: number, calls: number;
let contexts: BrowserContext[];
test.beforeEach(async () => {
  now = Date.now();
  calls = 0;
  contexts = [];
  const config = { baseUrl: 'http://mock', model: 'council-test' };
  town = new SharedTown({
    path: ':memory:',
    config,
    clock: false,
    now: () => now,
    limits: { interval: 3600000 },
    model: async (_config: object, { world }: { world: World }) => {
      calls++;
      return {
        round: {
          decisions: round.decisions.map((plan, i) => ({
            ...plan,
            councilVote: { motionId: world.council!.id, choice: i < 3 ? 'yes' : 'no' },
          })),
        },
      };
    },
  });
  town.transaction(() => town.commit(openCouncil(town.world, 'bread', randomUUID(), now)));
  server = createServer(createHandler({ town, config, production: true }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterEach(async () => {
  for (const context of contexts) await context.close();
  town.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function open(browser: Browser, options: { paused?: boolean; popup?: boolean } = {}) {
  const context = await browser.newContext(test.info().project.use);
  contexts.push(context);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1000));
  await page.goto(base + (options.paused ? '/?paused=1' : '/'));
  await expect(page.getByLabel('共享小镇状态')).toContainText('实时连接');
  if (options.popup !== false)
    await expect(page.getByRole('dialog', { name: '小镇议会投票', exact: true })).toBeVisible();
  return page;
}

test('online visitors receive one voting popup and one result popup without losing their draft', async ({
  browser,
}) => {
  const page = await open(browser, { paused: true });
  await expect(page.getByLabel('议会投票剩余时间')).toHaveText('0:45');
  await expect(page.getByRole('dialog')).toContainText('每场 45 秒');
  await expect(page.getByRole('button', { name: '赞成提案', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '稍后再看', exact: true }).click();
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  await page.getByRole('textbox').fill('投票弹窗之后要保留的草稿');
  town.publish();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /小镇议会 ·/ }).click();
  await page.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(page.getByLabel('议会票数')).toContainText('赞成 1');
  await page.getByRole('button', { name: '稍后再看', exact: true }).click();
  now += COUNCIL_DURATION;
  town.finishCouncil();
  await expect(page.getByRole('dialog', { name: '议会结果', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('提案通过，已更新小镇宪法。');
  await expect(page.getByRole('button', { name: '知道了', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await page.screenshot({ path: test.info().outputPath('council-result.png'), fullPage: true });
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  town.publish();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveValue('投票弹窗之后要保留的草稿');
  const newcomer = await open(browser, { popup: false });
  await expect(newcomer.getByRole('dialog')).toHaveCount(0);
  expect(calls).toBe(0);
});

test('visitors share votes, change ballots, recover from failures and retain their vote on reload', async ({
  browser,
}) => {
  const alice = await open(browser),
    bob = await open(browser);
  const a = alice.getByRole('dialog'),
    b = bob.getByRole('dialog');
  await a.locator('.council-opinions > summary').click();
  await town.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
  await expect(a.locator('.council-opinions > summary')).toContainText('6/6');
  await expect(a).toContainText(round.decisions[5].speech);
  await a.getByRole('button', { name: '赞成提案', exact: true }).click();
  await b.getByRole('button', { name: '反对提案', exact: true }).click();
  for (const card of [a, b]) {
    await expect(card.getByLabel('议会票数')).toContainText('赞成 4');
    await expect(card.getByLabel('议会票数')).toContainText('反对 4');
    await expect(card.getByLabel('议会票数')).toContainText('访客 2 票');
  }
  now += 1000;
  town.publish();
  await a.getByRole('button', { name: '反对提案', exact: true }).click();
  await expect(b.getByLabel('议会票数')).toContainText('反对 5');
  now += 1000;
  town.publish();
  await alice.route(
    '**/api/council/vote',
    (route) => route.fulfill({ status: 503, json: { error: '暂时无法投票，请重试。' } }),
    { times: 1 },
  );
  await a.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(a.getByRole('alert')).toHaveText('暂时无法投票，请重试。');
  await a.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(a.getByRole('alert')).toHaveCount(0);
  await alice.reload();
  await expect(a.getByRole('button', { name: '赞成提案', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(a.getByLabel('议会票数')).toContainText('访客 2 票');
  expect(calls).toBe(1);
});

test('the separate constitution editor replaces a clause after voting and supports repeal', async ({
  browser,
}) => {
  const page = await open(browser, { paused: true }),
    other = await open(browser, { paused: true });
  await page.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(page.getByLabel('议会票数')).toContainText('赞成 1');
  now += COUNCIL_DURATION;
  town.finishCouncil();
  await expect(page.getByRole('dialog')).toContainText('访客弃权 1');
  await page.getByRole('button', { name: '查看小镇宪法', exact: true }).click();
  const constitution = page.getByRole('dialog', { name: '小镇宪法', exact: true });
  await expect(constitution.getByRole('article')).toHaveCount(1);
  await constitution.getByRole('button', { name: '修订面包共享', exact: true }).click();
  await constitution
    .getByRole('textbox', { name: '条款内容', exact: true })
    .fill('先把面包分给最饥饿的居民。');
  await constitution.getByRole('button', { name: '提交议会投票', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '小镇议会投票', exact: true })).toContainText(
    '先把面包分给最饥饿的居民。',
  );
  await page.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(page.getByLabel('议会票数')).toContainText('赞成 4');
  await expect(page.locator('.council-opinions > summary')).toContainText('6/6');
  const food = town.world.food;
  now += COUNCIL_DURATION;
  town.finishCouncil();
  await expect(page.getByRole('dialog')).toContainText('已更新小镇宪法');
  await page.getByRole('button', { name: '查看小镇宪法', exact: true }).click();
  await expect(constitution.getByRole('article')).toHaveCount(1);
  await expect(constitution).toContainText('第 2 版');
  await expect(constitution).toContainText('先把面包分给最饥饿的居民。');
  expect(town.world.food).toBe(food);
  now += 60000;
  await constitution.getByRole('button', { name: '废止面包共享', exact: true }).click();
  await constitution.getByRole('button', { name: '提交议会投票', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '小镇议会投票', exact: true })).toContainText(
    '废止「面包共享」',
  );
  await page.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(page.getByLabel('议会票数')).toContainText('赞成 4');
  await expect(page.locator('.council-opinions > summary')).toContainText('6/6');
  const foodBeforeRepeal = town.world.food;
  now += COUNCIL_DURATION;
  town.finishCouncil();
  await expect(page.getByRole('dialog')).toContainText('已更新小镇宪法');
  await page.getByRole('button', { name: '查看小镇宪法', exact: true }).click();
  await expect(constitution.getByRole('article')).toHaveCount(0);
  await expect(constitution).toContainText('现行 0 项条款');
  expect(town.world.laws).toHaveLength(0);
  expect(town.world.food).toBe(foodBeforeRepeal);
  expect(calls).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('constitution.png'), fullPage: true });
  await other.close();
});

test('replay uses historical read-only dialogs and never pops up live votes over the timeline', async ({
  browser,
}) => {
  const page = await open(browser);
  await page.getByRole('button', { name: '稍后再看', exact: true }).click();
  const slider = page.getByRole('slider', { name: '回放时间线' });
  await slider.focus();
  await slider.press('Home');
  town.publish();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await slider.press('ArrowRight');
  await page.getByRole('button', { name: /小镇议会 ·/ }).click();
  await expect(page.getByRole('dialog')).toContainText('历史投票');
  await expect(page.getByRole('button', { name: '赞成提案', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '查看小镇宪法', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('回放中的宪法只供查看');
  await expect(page.getByRole('button', { name: '提出新条款', exact: true })).toHaveCount(0);
  expect(calls).toBe(0);
});

test('queued results do not replace an open constitution editor or its unsent text', async ({
  browser,
}) => {
  const page = await open(browser);
  await page.getByRole('button', { name: '稍后再看', exact: true }).click();
  await page.getByRole('button', { name: '宪法', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '小镇宪法', exact: true });
  await dialog.getByRole('button', { name: '提出新条款', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: '条款内容', exact: true })
    .fill('这段草稿不能被结果弹窗覆盖。');
  now += COUNCIL_DURATION;
  town.finishCouncil();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue('这段草稿不能被结果弹窗覆盖。');
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '议会结果', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('平票，维持现状。');
  expect(calls).toBe(0);
});

test('a large constitution is searchable and paginated, edits target one exact clause and the cap prevents new entries', async ({
  browser,
}) => {
  town.transaction(() =>
    town.commit({
      ...town.world,
      laws: Array.from({ length: 1024 }, (_, n) => ({
        id: randomUUID(),
        motionId: randomUUID(),
        topic: 'bread' as const,
        rule: `独立法条${n}`,
        revision: 1,
        updatedAt: now,
      })),
    }),
  );
  const page = await open(browser, { paused: true });
  await page.getByRole('button', { name: '稍后再看', exact: true }).click();
  await page.getByRole('button', { name: '宪法', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '小镇宪法', exact: true });
  await expect(dialog).toContainText('现行 1024 项条款 / 1024');
  await expect(dialog.getByRole('article')).toHaveCount(20);
  await expect(dialog.getByRole('button', { name: '提出新条款', exact: true })).toHaveCount(0);
  const pagination = dialog.getByRole('navigation', { name: '宪法分页', exact: true });
  await pagination.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(dialog.getByRole('article').first()).toContainText('独立法条20');
  await expect(pagination).toContainText('2 / 52');
  await dialog.getByRole('searchbox', { name: '搜索条款', exact: true }).fill('独立法条999');
  await expect(dialog.getByRole('article')).toHaveCount(1);
  const targetId = town.world.laws[999].id;
  await dialog.getByRole('button', { name: '修订面包共享', exact: true }).click();
  await dialog.getByRole('textbox', { name: '条款内容', exact: true }).fill('第999条修订文本');
  now += COUNCIL_DURATION;
  town.finishCouncil();
  await expect(dialog.getByRole('button', { name: '提交议会投票', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '提交议会投票', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '小镇议会投票', exact: true })).toContainText(
    '第999条修订文本',
  );
  expect(town.world.council.lawId).toBe(targetId);
  await page.getByRole('button', { name: '赞成提案', exact: true }).click();
  await expect(page.getByLabel('议会票数')).toContainText('赞成 4');
  await expect(page.locator('.council-opinions > summary')).toContainText('6/6');
  now += COUNCIL_DURATION;
  town.finishCouncil();
  expect(town.world.laws).toHaveLength(1024);
  expect(town.world.laws.find((law: { id: string }) => law.id === targetId)).toMatchObject({
    rule: '第999条修订文本',
    revision: 2,
  });
  expect(town.world.laws[0].rule).toBe('独立法条0');
  expect(calls).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
