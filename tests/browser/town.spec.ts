import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { round, decision } from '../fixture';
import { applyRound, createWorld, exportReplay } from '../../src/world/engine';

type Call = { world: ReturnType<typeof createWorld>; agentId?: string; prompt?: string };
async function mock(page: Page, failFirst = false) {
  const rounds: Call[] = [];
  const chats: Call[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).hostname !== '127.0.0.1') external.push(req.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { configured: true, model: 'qwen3.8-flash', wireApi: 'responses' } }),
  );
  await page.route('**/api/turn', (r) => {
    rounds.push(r.request().postDataJSON());
    return r.fulfill(
      failFirst && rounds.length === 1
        ? { status: 502, json: { error: '模型暂时不可用' } }
        : { json: { round, usage: { input: 1061, output: 415 } } },
    );
  });
  await page.route('**/api/decide', (r) => {
    chats.push(r.request().postDataJSON());
    return r.fulfill({ json: { decision, usage: { input: 400, output: 80 } } });
  });
  await page.goto('/');
  if (!failFirst) {
    await expect(page.locator('.clock')).toContainText('08:15');
    await page.getByRole('button', { name: '暂停观察', exact: true }).click();
  }
  return { rounds, chats, external, errors };
}

test('starts with real-model mode, applies a batch, selects residents and controls the map', async ({
  page,
}, info) => {
  const { rounds, errors, external } = await mock(page);
  await expect(page.getByRole('heading', { name: '星落镇' })).toBeVisible();
  await expect(page.locator('.clock')).toContainText('08:15');
  await expect(page.locator('.resident-card').first()).toContainText('去广场交流');
  await expect(page.locator('.feed-list')).toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '选择居民米拉' }).click();
  await expect(page.locator('.profile-hero h2')).toContainText('米拉');
  await expect(page.locator('.speech-preview')).toContainText(round.decisions[0].speech);
  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  await page.getByRole('button', { name: '重置视角' }).click();
  await page.getByRole('button', { name: '切换白天灯光' }).click();
  await expect(page.locator('.scene')).toHaveClass('scene day');
  expect(rounds).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('town.png'), fullPage: true });
});

test('events automatically request reactions while preserving the paused state', async ({
  page,
}) => {
  const { rounds } = await mock(page);
  await page.getByRole('button', { name: '投放事件', exact: true }).click();
  await page.getByRole('button', { name: /下一场星星雨/ }).click();
  await expect(page.locator('.effects-row')).toContainText('下一场星星雨');
  await expect(page.locator('.clock')).toContainText('08:30');
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeVisible();
  expect(rounds).toHaveLength(2);
  expect(rounds[1].world.effects[0].id).toBe('rain');
  await page.getByRole('button', { name: '投放事件', exact: true }).click();
  await page.getByRole('button', { name: /免费面包日/ }).click();
  await expect(page.locator('.clock')).toContainText('08:45');
  await expect(page.locator('.world-metrics').first()).toContainText('185');
});

test('human joins and receives a model reply with safe text rendering', async ({ page }) => {
  const { chats } = await mock(page);
  await page.getByRole('button', { name: '作为人类加入', exact: true }).click();
  await expect(page.getByRole('button', { name: '已加入小镇', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '选择居民回声' }).click();
  const text = '你好 🌌 <img src=x onerror=alert(1)>';
  await page.getByLabel('对回声说句话').fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.speech-preview')).toContainText(decision.speech);
  expect(chats).toHaveLength(1);
  expect(chats[0]).toMatchObject({ agentId: 'echo', prompt: text, world: { human: true } });
  await page.getByRole('button', { name: /小镇动态/ }).click();
  await expect(page.locator('.feed-list')).toContainText(text);
  await expect(page.locator('.feed-list img')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
    })),
  ).toEqual({ local: 0, session: 0, cookies: '' });
});

test('a provider error pauses without creating dialogue and retry restores operation', async ({
  page,
}) => {
  const { rounds } = await mock(page, true);
  await expect(page.getByRole('alert')).toContainText('模型暂时不可用');
  await expect(page.locator('.clock')).toContainText('08:00');
  await expect(page.locator('.feed-item')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(rounds).toHaveLength(2);
  await page.getByRole('button', { name: '运行一轮', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:30');
});

test('replay is read only and does not call models', async ({ page }) => {
  const { rounds } = await mock(page);
  await page.clock.install();
  await page.getByLabel('回放时间线').focus();
  await page.getByLabel('回放时间线').press('Home');
  await expect(page.locator('.live-pill')).toHaveText('REPLAY');
  await expect(page.locator('.clock')).toContainText('08:00');
  await expect(page.getByRole('button', { name: '运行一轮', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '投放事件', exact: true })).toBeDisabled();
  await page.clock.fastForward(61000);
  expect(rounds).toHaveLength(1);
  await page.getByRole('button', { name: '返回当前世界' }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  await page.getByRole('button', { name: '运行一轮', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:30');
});

test('export/import preserves the world and rejects invalid replay files', async ({ page }) => {
  const { rounds } = await mock(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出回放', exact: true }).click();
  const download = await downloading;
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(data.version).toBe(1);
  expect(data.snapshots).toHaveLength(2);
  expect(JSON.stringify(data)).not.toContain('API_KEY');
  expect(JSON.stringify(data)).not.toContain('Authorization');
  await page.getByLabel('导入回放文件').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"broken":1}'),
  });
  await expect(page.locator('.toast')).toContainText('回放格式不正确');
  const initial = createWorld();
  const history = [initial, applyRound(initial, round)];
  await page.getByLabel('导入回放文件').setInputFiles({
    name: 'good.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportReplay(history)),
  });
  await expect(page.locator('.live-pill')).toHaveText('REPLAY');
  await expect(page.locator('.clock')).toContainText('08:00');
  await page.getByRole('button', { name: '返回当前世界' }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  expect(rounds).toHaveLength(1);
});

test('dialogue error recovers without duplicating human messages', async ({ page }) => {
  await mock(page);
  let count = 0;
  await page.route('**/api/decide', (r) => {
    count++;
    return r.fulfill(
      count === 1
        ? { status: 502, json: { error: '聊天服务暂时失败' } }
        : { json: { decision, usage: { input: 200, output: 50 } } },
    );
  });
  await page.getByRole('button', { name: '选择居民米拉' }).click();
  await page.getByLabel('对米拉说句话').fill('你好，镇长。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('聊天服务暂时失败');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.speech-preview')).toContainText(decision.speech);
  await page.getByRole('button', { name: /小镇动态/ }).click();
  await expect(page.locator('.feed-body>p').filter({ hasText: '你好，镇长。' })).toHaveCount(1);
});

test('missing model configuration never starts a local simulation', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { configured: false, model: null, wireApi: 'responses' } }),
  );
  await page.route('**/api/turn', (r) => {
    calls++;
    return r.abort();
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('小镇暂时无法互动');
  await expect(page.locator('.clock')).toContainText('08:00');
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '了解小镇', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toContainText(/LLM_|SQLite|Cookie|API|\.env/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).toBe(0);
});

test('hidden tab suspends automatic requests; visible tab can resume', async ({ page }) => {
  const { rounds } = await mock(page);
  await page.clock.install();
  await page.getByRole('button', { name: '开始观察', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.top-center')).toContainText('页面已休眠');
  await page.clock.fastForward(61000);
  expect(rounds).toHaveLength(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.top-center')).toContainText('世界运行中');
  await page.clock.fastForward(21000);
  await expect(page.locator('.clock')).toContainText('08:30');
  await page.getByRole('button', { name: '暂停观察', exact: true }).click();
});

test('lightweight fallback keeps resident selection and zoom controls functional', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        if (type.includes('webgl')) return null;
        return (original as (...params: unknown[]) => unknown).apply(this, [type, ...args]);
      },
    });
  });
  const { errors } = await mock(page);
  await expect(page.locator('.town-canvas')).toHaveAttribute('data-renderer', 'fallback');
  await page.getByRole('button', { name: '查看米拉', exact: true }).click();
  await expect(page.locator('.profile-hero')).toContainText('米拉');
  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  expect(
    await page
      .locator('.town-canvas')
      .evaluate((el) => el.style.getPropertyValue('--fallback-zoom')),
  ).toBe('1.15');
  await page.getByRole('button', { name: '重置视角' }).click();
  expect(
    await page
      .locator('.town-canvas')
      .evaluate((el) => el.style.getPropertyValue('--fallback-zoom')),
  ).toBe('1');
  expect(errors).toEqual([]);
});

test('reset clears the world and pauses without making extra requests', async ({ page }) => {
  const { rounds } = await mock(page);
  await page.getByRole('button', { name: '世界设置', exact: true }).click();
  await page.getByRole('button', { name: '重置世界', exact: true }).click();
  await page.getByRole('button', { name: '重置并暂停', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:00');
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeVisible();
  await expect(page.locator('.feed-item')).toHaveCount(1);
  expect(rounds).toHaveLength(1);
});

test('paused preview does not call the model until the observer starts it', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { configured: true, model: 'qwen3.8-flash', wireApi: 'responses' } }),
  );
  await page.route('**/api/turn', (r) => {
    calls++;
    return r.fulfill({ json: { round, usage: { input: 100, output: 50 } } });
  });
  await page.goto('/?paused=1');
  await expect(page.getByRole('button', { name: '开始观察', exact: true })).toBeEnabled();
  expect(calls).toBe(0);
  await expect(page.locator('.clock')).toContainText('08:00');
  await page.getByRole('button', { name: '开始观察', exact: true }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  await page.getByRole('button', { name: '暂停观察', exact: true }).click();
  expect(calls).toBe(1);
});

test('invalid client-side model data cannot partially advance the world', async ({ page }) => {
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { configured: true, model: 'qwen3.8-flash', wireApi: 'responses' } }),
  );
  await page.route('**/api/turn', (r) =>
    r.fulfill({
      json: { round: { decisions: round.decisions.slice(1) }, usage: { input: 100, output: 50 } },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('暂时无法回应');
  await expect(page.locator('.clock')).toContainText('08:00');
  await expect(page.locator('.feed-item')).toHaveCount(1);
});
