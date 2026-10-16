import { test, expect, type Page, type Route } from '@playwright/test';
import { round, decision } from '../fixture';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
async function configured(page: Page) {
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { configured: true, model: 'qwen3.8-flash', wireApi: 'responses' } }),
  );
}
async function reply(route: Route, speech = decision.speech) {
  await route.fulfill({
    json: { decision: { ...decision, speech }, usage: { input: 100, output: 20 } },
  });
}
async function turn(route: Route) {
  await route.fulfill({ json: { round, usage: { input: 200, output: 80 } } });
}
async function live(page: Page) {
  await configured(page);
  await page.route('**/api/turn', turn);
  await page.goto('/');
  await expect(page.locator('.clock')).toContainText('08:15');
}
async function speak(page: Page, name: string, text: string) {
  await page.getByRole('button', { name: `选择居民${name}`, exact: true }).click();
  await page.getByLabel(`对${name}说句话`).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

test('an event preempts a busy automatic turn, reacts immediately and preserves live mode', async ({
  page,
}) => {
  await configured(page);
  const old = gate();
  const completed = gate();
  const requests: any[] = [];
  await page.route('**/api/turn', async (r) => {
    requests.push(r.request().postDataJSON());
    if (requests.length === 1) {
      await old.promise;
      await r
        .fulfill({
          json: {
            round: { decisions: round.decisions.map((d) => ({ ...d, speech: '过期的决定' })) },
          },
        })
        .catch(() => {});
      completed.release();
    } else await turn(r);
  });
  await page.goto('/');
  await expect(page.locator('.top-center')).toContainText('居民思考中');
  await expect(page.getByRole('button', { name: '投放事件', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '投放事件', exact: true }).click();
  await page.getByRole('button', { name: /下一场星星雨/ }).click();
  await expect(page.locator('.clock')).toContainText('08:15');
  expect(requests).toHaveLength(2);
  expect(requests[1].world.effects[0].id).toBe('rain');
  old.release();
  await completed.promise;
  await expect(page.locator('.clock')).toContainText('08:15');
  await expect(page.locator('.feed-list')).not.toContainText('过期的决定');
  await expect(page.getByRole('button', { name: '暂停观察', exact: true })).toBeVisible();
});

test('chat preempts automatic work while input and event buttons stay available', async ({
  page,
}) => {
  await configured(page);
  const old = gate();
  let calls = 0;
  await page.route('**/api/turn', async (r) => {
    calls++;
    await old.promise;
    await turn(r).catch(() => {});
  });
  await page.route('**/api/decide', (r) => reply(r));
  await page.goto('/');
  await expect(page.locator('.top-center')).toContainText('居民思考中');
  await speak(page, '米拉', '不用开会，先聊聊。');
  await expect(page.locator('.conversation-history')).toContainText(decision.speech);
  await expect(page.locator('.clock')).toContainText('08:00');
  expect(calls).toBe(1);
  await expect(page.getByRole('button', { name: '暂停观察', exact: true })).toBeVisible();
  old.release();
});

test('human conversations and events run FIFO, preserve drafts, and resume after a reading interval', async ({
  page,
}) => {
  await live(page);
  await page.clock.install();
  const first = gate(),
    weather = gate();
  const calls: { type: string; data: any }[] = [];
  await page.route('**/api/decide', async (r) => {
    const data = r.request().postDataJSON();
    calls.push({ type: 'chat', data });
    if (data.prompt === '第一句话') await first.promise;
    await reply(r, `已回应：${data.prompt}`);
  });
  await page.route('**/api/turn', async (r) => {
    calls.push({ type: 'round', data: r.request().postDataJSON() });
    if (calls.length === 2) await weather.promise;
    await turn(r);
  });
  await speak(page, '米拉', '第一句话');
  await expect(page.locator('.conversation-history')).toContainText('等待回应');
  await page.getByLabel('对米拉说句话').fill('米拉的下一条草稿');
  await page.getByRole('button', { name: '投放事件', exact: true }).click();
  await page.getByRole('button', { name: /下一场星星雨/ }).click();
  await speak(page, '回声', '第二句话');
  await page.getByLabel('对回声说句话').fill('回声的草稿');
  await expect(page.getByRole('region', { name: '人类操作队列' })).toContainText('2 项等待');
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  await expect(page.getByLabel('对米拉说句话')).toHaveValue('米拉的下一条草稿');
  first.release();
  await expect(page.locator('.conversation-history')).toContainText('已回应：第一句话');
  await expect(page.getByRole('region', { name: '人类操作队列' })).toContainText('1 项等待');
  expect(calls[1].type).toBe('round');
  expect(calls[1].data.world.conversations).toHaveLength(2);
  expect(calls[1].data.world.effects[0].id).toBe('rain');
  weather.release();
  await page.getByRole('button', { name: '选择居民回声', exact: true }).click();
  await expect(page.locator('.conversation-history')).toContainText('已回应：第二句话');
  await expect(page.getByLabel('对回声说句话')).toHaveValue('回声的草稿');
  expect(calls.map((c) => c.type)).toEqual(['chat', 'round', 'chat']);
  expect(calls[2].data.world.conversations).toHaveLength(3);
  await expect(page.getByRole('region', { name: '人类操作队列' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '暂停观察', exact: true })).toBeVisible();
  await page.clock.fastForward(19000);
  expect(calls).toHaveLength(3);
  await page.clock.fastForward(2000);
  await expect(page.locator('.clock')).toContainText('08:45');
  expect(calls).toHaveLength(4);
  await page.getByRole('button', { name: '选择居民米拉', exact: true }).click();
  await expect(page.locator('.conversation-history')).toContainText('已回应：第一句话');
});

test('failed event retries once without duplicating its effects and keeps subsequent messages', async ({
  page,
}) => {
  await live(page);
  let attempts = 0;
  const snapshots: any[] = [];
  await page.route('**/api/turn', (r) => {
    attempts++;
    snapshots.push(r.request().postDataJSON().world);
    return attempts === 1
      ? r.fulfill({ status: 502, json: { error: '事件回应暂时失败' } })
      : turn(r);
  });
  await page.route('**/api/decide', (r) => reply(r));
  await page.getByRole('button', { name: '投放事件', exact: true }).click();
  await page.getByRole('button', { name: /免费面包日/ }).click();
  await expect(page.getByRole('alert')).toContainText('事件回应暂时失败');
  await expect(page.locator('.world-metrics')).toContainText('161');
  await speak(page, '米拉', '吃到面包了吗？');
  await expect(page.locator('.conversation-history')).toContainText('已排队');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.conversation-history')).toContainText(decision.speech);
  expect(snapshots.map((w) => w.food)).toEqual([161, 161]);
  await expect(page.locator('.world-metrics')).toContainText('173');
  await page.getByRole('button', { name: /小镇动态/ }).click();
  await expect(
    page.locator('.feed-body>p').filter({ hasText: '你投放了「免费面包日」' }),
  ).toHaveCount(1);
});

test('queued messages can be cancelled without disturbing an active conversation', async ({
  page,
}) => {
  await live(page);
  const first = gate();
  const messages: string[] = [];
  await page.route('**/api/decide', async (r) => {
    messages.push(r.request().postDataJSON().prompt);
    await first.promise;
    await reply(r);
  });
  await speak(page, '米拉', '正在回应的消息');
  await speak(page, '回声', '我想撤回这条');
  await page.getByRole('button', { name: '取消等待：对回声说：我想撤回这条', exact: true }).click();
  await expect(page.getByLabel('对回声说句话')).toHaveValue('我想撤回这条');
  first.release();
  await expect(page.getByRole('region', { name: '人类操作队列' })).toHaveCount(0);
  expect(messages).toEqual(['正在回应的消息']);
});

test('a conversation survives hidden-tab suspension without duplicating the question', async ({
  page,
}) => {
  await live(page);
  const first = gate();
  const requests: any[] = [];
  await page.route('**/api/decide', async (r) => {
    requests.push(r.request().postDataJSON());
    if (requests.length === 1) {
      await first.promise;
      await reply(r, '过期回复').catch(() => {});
    } else await reply(r, '回来了，接着聊。');
  });
  await speak(page, '米拉', '稍等我一下');
  await expect(page.locator('.conversation-history')).toContainText('等待回应');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('region', { name: '人类操作队列' })).toContainText(
    '等待返回当前世界后继续',
  );
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.conversation-history')).toContainText('回来了，接着聊。');
  expect(requests).toHaveLength(2);
  expect(requests[1].world.conversations.filter((e: any) => e.role === 'human')).toHaveLength(1);
  await expect(page.locator('.chat-bubble.human')).toHaveCount(1);
  first.release();
});

test('entering replay suspends a human reply and resumes it on the current world', async ({
  page,
}) => {
  await live(page);
  const first = gate();
  const requests: any[] = [];
  await page.route('**/api/decide', async (r) => {
    requests.push(r.request().postDataJSON());
    if (requests.length === 1) {
      await first.promise;
      await reply(r, '过期回复').catch(() => {});
    } else await reply(r, '接着聊这个世界。');
  });
  await speak(page, '米拉', '等我回放一下。');
  await expect(page.locator('.conversation-history')).toContainText('等待回应');
  await page.getByLabel('回放时间线').focus();
  await page.getByLabel('回放时间线').press('Home');
  await expect(page.locator('.live-pill')).toHaveText('REPLAY');
  await expect(page.locator('.clock')).toContainText('08:00');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '返回当前世界' }).click();
  await expect(page.locator('.conversation-history')).toContainText('接着聊这个世界。');
  expect(requests).toHaveLength(2);
  expect(requests[1].world.minute).toBe(495);
  await expect(page.locator('.chat-bubble.human')).toHaveCount(1);
  first.release();
});

test('resident details remain accessible and dialogue text is safely retained', async ({
  page,
}, info) => {
  await live(page);
  await page.route('**/api/decide', (r) => reply(r, '你好 🌟 <script>这是一段文字</script>'));
  await speak(page, '米拉', '你好，想和你聊聊小镇。');
  await expect(page.locator('.conversation-history')).toContainText(
    '<script>这是一段文字</script>',
  );
  await expect(page.locator('.conversation-history script')).toHaveCount(0);
  await page.getByRole('tab', { name: '档案', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '档案', exact: true })).toContainText(
    '当前人生目标',
  );
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(page.locator('.conversation-history')).toContainText('你好，想和你聊聊小镇。');
  const available = await page.locator('.profile-panel').evaluate((el) => {
    const style = getComputedStyle(el);
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  const form = await page.locator('.chat-form').boundingBox();
  expect(Math.abs(form!.width - available)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('conversation.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
