import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { SharedTown } from '../../server/town.mjs';
import { createHandler } from '../../server/app.mjs';
import { decision, round } from '../fixture';
import { applyRound } from '../../src/world/engine';

let server: Server, town: SharedTown, base: string;
let pending: Array<{ resolve: (value: object) => void; body: { prompt?: string } }>;
let hold: boolean;
let contexts: BrowserContext[];
test.beforeEach(async () => {
  pending = [];
  hold = false;
  contexts = [];
  const config = { baseUrl: 'http://mock', model: 'shared-test', adminToken: 'test-admin' };
  town = new SharedTown({
    path: ':memory:',
    config,
    council: false,
    limits: { cooldown: 1, interval: 3600000, callsMinute: 100 },
    model: async (_config: object, body: { prompt?: string }) => {
      if (hold) return new Promise((resolve) => pending.push({ resolve, body }));
      return { decision, round, usage: { input: 10, output: 20 } };
    },
  });
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
async function open(browser: Browser, freezeTime = false) {
  const context = await browser.newContext(test.info().project.use);
  contexts.push(context);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (freezeTime) {
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(new Date(now.getTime() + 1000));
  }
  await page.goto(base);
  await expect(page.getByLabel('共享小镇状态')).toContainText('共享小镇 · 实时连接');
  await expect(page.getByLabel('共享小镇状态')).toContainText('今日参与 0/600');
  await expect(page.getByLabel('共享小镇状态')).toContainText('全站今日模型 0/5000 次');
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  return page;
}
const reply = (text: string) => ({
  decision: { ...decision, speech: text },
  round,
  usage: { input: 10, output: 20 },
});

test('live shared observation clears Soren focus and rotates all residents in subsequent rounds', async ({
  browser,
}) => {
  const advance = (nextRound = round) => {
    town.transaction(() => town.commit(applyRound(town.world, nextRound)));
    town.publish();
  };
  advance();
  const page = await open(browser, true);
  const bubble = page.getByLabel('地图对白');
  await page.getByRole('button', { name: '选择居民索伦', exact: true }).click();
  await expect(bubble).toContainText(round.decisions[5].speech);
  await page.getByRole('button', { name: '查看索伦', exact: true }).click();
  for (const name of ['选择居民索伦', '查看索伦']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  }
  await expect(page.locator('.live-pill')).toHaveText('LIVE');
  for (const line of round.decisions.slice(1, 5)) {
    await expect(bubble).toContainText(line.speech);
    await page.clock.fastForward(3000);
  }
  await expect(bubble).toHaveCount(0);
  const nextRound = {
    ...round,
    decisions: round.decisions.map((line) => ({ ...line, speech: `新一轮：${line.speech}` })),
  };
  advance(nextRound);
  await expect(page.locator('.clock')).toContainText('08:30');
  for (const line of nextRound.decisions) {
    await expect(bubble).toContainText(line.speech);
    await page.clock.fastForward(3000);
  }
  await expect(bubble).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择居民索伦', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByLabel('模型累计用量')).toContainText('0 次调用');
});

test('shared replay freezes its frames while the town advances and refreshes history on return', async ({
  browser,
}) => {
  const advance = () => {
    town.transaction(() => town.commit(applyRound(town.world, round)));
    town.publish();
  };
  advance();
  advance();
  const alice = await open(browser),
    bob = await open(browser);
  const slider = alice.getByRole('slider', { name: '回放时间线' });
  await expect(slider).toHaveAttribute('max', '2');
  await slider.focus();
  await slider.press('Home');
  await expect(alice.getByLabel('回放进度')).toHaveText('第 1 天 08:00 · 1/3');
  advance();
  advance();
  await expect(bob.locator('.clock')).toContainText('09:00');
  await expect(alice.locator('.clock')).toContainText('08:00');
  await expect(slider).toHaveAttribute('max', '2');
  await expect(alice.getByRole('button', { name: '投放事件', exact: true })).toBeDisabled();
  await alice.getByRole('button', { name: '返回当前世界', exact: true }).click();
  await expect(alice.locator('.clock')).toContainText('09:00');
  await expect(slider).toHaveAttribute('max', '4');
  await slider.focus();
  await slider.press('Home');
  await expect(alice.getByLabel('回放进度')).toHaveText('第 1 天 08:00 · 1/5');
  await expect(alice.getByLabel('模型累计用量')).toContainText('0 次调用');
});

test('anonymous visitors share FIFO conversations and reconnect to the same saved town', async ({
  browser,
}) => {
  const alice = await open(browser),
    bob = await open(browser);
  hold = true;
  await alice.getByRole('textbox').fill('Alice 的公开消息');
  await alice.getByRole('textbox').press('Enter');
  await expect.poll(() => pending.length).toBe(1);
  await bob.getByRole('textbox').fill('Bob 的公开消息');
  await bob.getByRole('textbox').press('Enter');
  await expect(bob.getByRole('region', { name: '人类操作队列' })).toContainText('Bob 的公开消息');
  expect(pending).toHaveLength(1);
  pending[0].resolve(reply('先回应 Alice'));
  await expect.poll(() => pending.length).toBe(2);
  pending[1].resolve(reply('再回应 Bob'));
  for (const page of [alice, bob]) {
    await expect(page.getByText('先回应 Alice', { exact: true })).toBeVisible();
    await expect(page.getByText('再回应 Bob', { exact: true })).toBeVisible();
  }
  await alice.reload();
  await expect(alice.getByLabel('共享小镇状态')).toContainText('共享小镇 · 实时连接');
  await alice.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  await expect(alice.getByText('再回应 Bob', { exact: true })).toBeVisible();
  expect(
    await alice.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
    })),
  ).toEqual({ local: 0, session: 0, cookies: '' });
  await alice.screenshot({ path: test.info().outputPath('shared-town.png'), fullPage: true });
  await expect(alice.locator('.toast')).toHaveCount(0);
  await expect(alice.getByLabel('共享小镇状态')).toContainText('今日参与 1/600');
  await expect(alice.getByLabel('共享小镇状态')).toContainText('全站今日模型 2/5000 次');
  await expect(alice.getByLabel('模型累计用量')).toHaveText('2 次调用60 tokens');
  await expect(alice.locator('body')).not.toContainText(
    /Cookie|SQLite|不用先暂停|人类操作优先|累计用量|shared-test/,
  );
  const cookies = await contexts[0].cookies();
  expect(cookies[0].httpOnly).toBe(true);
});

test('personal pause freezes only that view and other visitors keep interacting', async ({
  browser,
}) => {
  const alice = await open(browser),
    bob = await open(browser);
  await alice.getByRole('button', { name: '暂停观察', exact: true }).click();
  await bob.getByRole('textbox').fill('暂停期间仍然能聊');
  await bob.getByRole('textbox').press('Enter');
  await expect(bob.getByText(decision.speech, { exact: true })).toBeVisible();
  await expect(alice.getByText(decision.speech, { exact: true })).toHaveCount(0);
  await alice.getByRole('button', { name: '开始观察', exact: true }).click();
  await expect(alice.getByText(decision.speech, { exact: true })).toBeVisible();
  await alice.getByRole('button', { name: '世界设置', exact: true }).click();
  await expect(alice.getByRole('button', { name: '重置世界', exact: true })).toHaveCount(0);
  await expect(alice.getByRole('button', { name: '导入回放', exact: true })).toHaveCount(0);
});

test('only the owner can cancel waiting work and admin pause blocks new submissions', async ({
  browser,
}) => {
  const alice = await open(browser),
    bob = await open(browser);
  hold = true;
  await alice.getByRole('textbox').fill('正在处理');
  await alice.getByRole('textbox').press('Enter');
  await expect.poll(() => pending.length).toBe(1);
  await bob.getByRole('textbox').fill('等待操作');
  await bob.getByRole('textbox').press('Enter');
  await expect(bob.getByRole('button', { name: /取消等待/ })).toBeVisible();
  await expect(alice.getByRole('button', { name: /取消等待/ })).toHaveCount(0);
  await bob.getByRole('button', { name: /取消等待/ }).click();
  await expect(bob.getByRole('button', { name: /取消等待/ })).toHaveCount(0);
  town.admin('test-admin', 'pause');
  // The backend rejects even a hand-written operation; UI reflects the same global pause.
  const response = await contexts[1].request.post(base + '/api/commands', {
    data: {
      requestId: crypto.randomUUID(),
      action: { type: 'chat', agentId: 'mira', text: '不能绕过暂停' },
    },
  });
  expect(response.status()).toBe(503);
  await expect(bob.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
});

test('quota errors preserve drafts and delayed acknowledgements do not erase newer text', async ({
  browser,
}) => {
  const page = await open(browser);
  const release = { resolve: () => {} };
  const delayed = new Promise<void>((resolve) => {
    release.resolve = resolve;
  });
  await page.route('**/api/commands', async (route) => {
    await delayed;
    await route.fulfill({ status: 429, json: { error: '互动次数已达上限，请稍后再来。' } });
  });
  await page.getByRole('textbox').fill('需要保留的草稿');
  await page.getByRole('textbox').press('Enter');
  await page.getByRole('textbox').fill('等待提交时写的新草稿');
  release.resolve();
  await expect(page.getByRole('alert')).toContainText('次数已达上限');
  await expect(page.getByRole('textbox')).toHaveValue('等待提交时写的新草稿');
  expect(town.world.conversations).toHaveLength(0);
  await page.unroute('**/api/commands');
  const accepted = { resolve: () => {} };
  const acknowledgement = new Promise<void>((resolve) => {
    accepted.resolve = resolve;
  });
  await page.route('**/api/commands', async (route) => {
    const response = await route.fetch();
    await acknowledgement;
    await route.fulfill({ response });
  });
  await page.getByRole('textbox').press('Enter');
  await expect.poll(() => town.world.conversations.length).toBe(2);
  await page.getByRole('textbox').fill('成功回执前写好的下一条');
  accepted.resolve();
  await page.getByRole('button', { name: '世界设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('今日互动 1/600');
  await expect(page.getByRole('dialog')).not.toContainText(/Cookie|SQLite|LLM_|API|服务器/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox')).toHaveValue('成功回执前写好的下一条');
});

test('a failed automatic round can be retried from its error banner while personally paused, without injecting an event', async ({
  browser,
}) => {
  const page = await open(browser, true);
  await page.getByRole('button', { name: '暂停观察', exact: true }).click();
  town.autoError = '回应格式有误，请重试。';
  town.publish();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('回应格式有误，请重试。');
  await alert.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('共享小镇状态')).toContainText('全站今日模型 1/5000 次');
  expect(town.world.tick).toBe(1);
  expect(town.world.effects).toEqual([]);
  expect(town.world.human).toBe(false);
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeVisible();
});
