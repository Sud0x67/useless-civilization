import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { SharedTown } from '../../server/town.mjs';
import { createHandler } from '../../server/app.mjs';
import { decision, round } from '../fixture';

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
async function open(browser: Browser) {
  const context = await browser.newContext(test.info().project.use);
  contexts.push(context);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base);
  await expect(page.getByLabel('共享小镇状态')).toContainText('已连接');
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  return page;
}
const reply = (text: string) => ({ decision: { ...decision, speech: text }, round });

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
  await expect(alice.getByLabel('共享小镇状态')).toContainText('已连接');
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
  await expect(alice.locator('body')).not.toContainText(
    /Cookie|SQLite|不用先暂停|人类操作优先|累计用量|tokens|shared-test/,
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
  await expect(page.getByRole('dialog')).toContainText('今日互动 1/60');
  await expect(page.getByRole('dialog')).not.toContainText(/Cookie|SQLite|LLM_|API|服务器/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox')).toHaveValue('成功回执前写好的下一条');
});
