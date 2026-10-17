import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { TownStore } from './store.mjs';
import { HttpError, ModelError, validationDetails, requestModel } from './model.mjs';
import {
  IDS,
  EVENT_IDS,
  DecisionSchema,
  RoundSchema,
  VoteChoiceSchema,
  CouncilProposalSchema,
} from '../src/shared/schema.ts';
import {
  councilTopics,
  COUNCIL_BREAK,
  AI_PROPOSAL_MAX_DELAY,
  proposalError,
  openCouncil,
  closeCouncil,
  recordCouncilOpinions,
  councilTally,
} from '../src/world/council.ts';
import {
  addHumanMessage,
  applyChatReply,
  applyEvent,
  applyRound,
  createWorld,
  importReplay,
  joinWorld,
} from '../src/world/engine.ts';

const Action = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('chat'),
      agentId: z.enum(IDS),
      text: z.string().trim().min(1).max(300),
    })
    .strict(),
  z.object({ type: z.literal('event'), eventId: z.enum(EVENT_IDS) }).strict(),
  z.object({ type: z.literal('join') }).strict(),
  z.object({ type: z.literal('round') }).strict(),
  z.object({ type: z.literal('retry'), id: z.number().int().positive() }).strict(),
]);
export const CommandSchema = z.object({ requestId: z.string().uuid(), action: Action }).strict();
const DEFAULTS = {
  cooldown: 10000,
  visitorHour: 20,
  visitorDay: 600,
  ipHour: 100,
  perVisitorPending: 2,
  queue: 20,
  callsMinute: 6,
  callsDay: 5000,
  interval: 20000,
  maxViewers: 200,
};
const hour = 3600000,
  day = 86400000;
const same = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export class SharedTown {
  constructor({
    path,
    config = {},
    limits = {},
    model = requestModel,
    now = Date.now,
    clock = true,
    council = true,
    draw = randomInt,
  } = {}) {
    this.store = new TownStore(path);
    this.config = config;
    this.limits = { ...DEFAULTS, ...limits };
    for (const value of Object.values(this.limits))
      if (!Number.isFinite(value) || value <= 0) throw new Error('共享小镇限额必须为正数');
    this.model = model;
    this.now = now;
    this.councilEnabled = council;
    this.draw = draw;
    if (!this.store.get('next_council_proposal_at')) this.scheduleProposal();
    this.world = JSON.parse(this.store.get('world'));
    this.version = Number(this.store.get('version'));
    if (!this.store.get('current_constitution_v1')) {
      this.store.transaction(() => {
        if (!this.world.laws) {
          const laws = new Map();
          for (const row of this.store.db
            .prepare('SELECT article FROM constitution_articles ORDER BY id')
            .all()) {
            const article = JSON.parse(row.article);
            if (article.result !== 'passed') continue;
            if (article.operation === 'repeal') {
              laws.delete(article.topic);
              continue;
            }
            const topic = councilTopics.find((item) => item.id === article.topic);
            if (topic)
              laws.set(topic.id, {
                topic: topic.id,
                rule: article.rule || topic.rule,
                revision: (laws.get(topic.id)?.revision || 0) + 1,
                updatedAt: article.decidedAt,
                motionId: article.motionId,
              });
          }
          if (laws.size) {
            this.world = { ...this.world, laws: [...laws.values()] };
            this.version = this.store.saveWorld(this.world);
          }
        }
        this.store.set('current_constitution_v1', 'true');
      });
    }
    this.listeners = new Set();
    this.active = null;
    this.controller = null;
    this.nextTurn = now() + this.limits.interval;
    this.closed = false;
    this.lastMaintenance = 0;
    this.autoError = this.store.get('auto_error') || '';
    this.queueCouncilRound();
    if (clock) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref();
    }
  }
  setAutoError(message) {
    this.autoError = message;
    this.store.set('auto_error', message);
  }
  configured() {
    return Boolean(this.config.baseUrl && this.config.model);
  }
  hash(value) {
    return createHmac('sha256', this.store.get('secret')).update(value).digest('hex');
  }
  identity(req, res) {
    const cookie = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('town_visitor='))
      ?.slice(13);
    let id, signature;
    if (cookie) [id, signature] = cookie.split('.');
    if (!/^[a-f0-9]{48}$/.test(id || '') || !same(signature || '', this.hash('cookie:' + id))) {
      id = randomBytes(24).toString('hex');
      const secure = this.config.publicOrigin?.startsWith('https://') ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `town_visitor=${id}.${this.hash('cookie:' + id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
      );
    }
    // Trust only an explicitly enabled, loopback reverse proxy. Never trust arbitrary X-Forwarded-For.
    const remote = req.socket.remoteAddress || 'unknown';
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    const ip =
      this.config.trustProxy && loopback ? String(req.headers['x-real-ip'] || remote) : remote;
    return { owner: this.hash('visitor:' + id), ip: this.hash('ip:' + ip) };
  }
  count(where, ...values) {
    return Number(
      this.store.db.prepare('SELECT count(*) AS n FROM commands WHERE ' + where).get(...values).n,
    );
  }
  budget() {
    const now = this.now(),
      midnight = Math.floor(now / day) * day;
    const rows = this.store.db
      .prepare('SELECT created FROM calls WHERE created>? ORDER BY created')
      .all(now - 60000);
    const used = Number(
      this.store.db.prepare('SELECT count(*) AS n FROM calls WHERE created>=?').get(midnight).n,
    );
    let resetsAt = 0;
    if (rows.length >= this.limits.callsMinute)
      resetsAt = rows[rows.length - this.limits.callsMinute].created + 60000;
    if (used >= this.limits.callsDay) resetsAt = Math.max(resetsAt, midnight + day);
    return { minuteUsed: rows.length, dayUsed: used, dayLimit: this.limits.callsDay, resetsAt };
  }
  quota(identity) {
    const now = this.now();
    const latest = this.store.db
      .prepare('SELECT created FROM commands WHERE owner=? ORDER BY id DESC LIMIT 1')
      .get(identity.owner);
    const usedHour = this.count('owner=? AND created>?', identity.owner, now - hour);
    const midnight = Math.floor(now / day) * day;
    const usedDay = this.count('owner=? AND created>=?', identity.owner, midnight);
    return {
      usedHour,
      hourLimit: this.limits.visitorHour,
      usedDay,
      dayLimit: this.limits.visitorDay,
      nextAt: latest ? latest.created + this.limits.cooldown : 0,
    };
  }
  name(owner) {
    return '访客' + owner.slice(0, 6).toUpperCase();
  }
  tasks(identity) {
    return this.store.db
      .prepare(
        "SELECT * FROM commands WHERE status IN ('pending','running') OR (owner=? AND status='failed') ORDER BY id DESC LIMIT 40",
      )
      .all(identity.owner)
      .reverse()
      .map((r) => ({
        id: r.id,
        kind: 'human',
        action: JSON.parse(r.action),
        mine: r.owner === identity.owner,
        author: this.name(r.owner),
        state: r.status,
        error: r.owner === identity.owner ? r.error : '',
      }));
  }
  snapshot(identity) {
    const usage = this.store.db
      .prepare(
        'SELECT count(*) AS calls, coalesce(sum(input),0) AS input, coalesce(sum(output),0) AS output FROM calls',
      )
      .get();
    return {
      you: this.name(identity.owner),
      world: this.world,
      version: this.version,
      tasks: this.tasks(identity),
      active: this.active ? { id: this.active.id, kind: this.active.kind } : null,
      online: this.listeners.size,
      running: this.store.get('paused') !== 'true',
      autoError: this.autoError,
      quota: this.quota(identity),
      budget: this.budget(),
      usage,
      limits: this.limits,
      serverTime: this.now(),
      councilVote: this.world.council
        ? this.store.db
            .prepare('SELECT choice FROM council_votes WHERE motion_id=? AND owner=?')
            .get(this.world.council.id, identity.owner)?.choice || null
        : null,
      constitutionCount: this.world.laws?.length || 0,
    };
  }
  attendCouncil(identity) {
    const motion = this.world.council;
    if (!motion || motion.status !== 'open' || this.now() >= motion.closesAt) return;
    this.store.db
      .prepare('INSERT OR IGNORE INTO council_attendees VALUES (?, ?)')
      .run(motion.id, identity.owner);
  }
  finishCouncil() {
    const motion = this.world.council;
    const now = this.now();
    if (!motion || motion.status !== 'open' || now < motion.closesAt) return;
    this.transaction(() => {
      const world = structuredClone(this.world);
      world.council.visitorAbstain = this.store.db
        .prepare(
          'SELECT count(*) AS n FROM council_attendees a WHERE motion_id=? AND NOT EXISTS (SELECT 1 FROM council_votes v WHERE v.motion_id=a.motion_id AND v.owner=a.owner)',
        )
        .get(motion.id).n;
      const next = closeCouncil(world, now);
      const tally = councilTally(next.council);
      const article = {
        motionId: motion.id,
        topic: motion.topic,
        decidedAt: now,
        result: next.council.result,
        yes: tally.yes,
        no: tally.no,
        residentAbstain: 6 - motion.residents.length,
        visitorAbstain: next.council.visitorAbstain,
        ...(motion.lawId ? { lawId: motion.lawId } : {}),
        operation: next.council.operation || 'adopt',
        rule: next.council.rule || councilTopics.find((topic) => topic.id === motion.topic).rule,
      };
      const inserted = this.store.db
        .prepare('INSERT INTO constitution_articles(motion_id,article) VALUES (?, ?)')
        .run(motion.id, JSON.stringify(article));
      article.id = Number(inserted.lastInsertRowid);
      this.store.db
        .prepare('UPDATE constitution_articles SET article=? WHERE id=?')
        .run(JSON.stringify(article), article.id);
      next.constitution = [...(next.constitution || []), article].slice(-20);
      this.store.db.prepare('DELETE FROM constitution_articles WHERE id<=?').run(article.id - 200);
      this.commit(next);
      this.scheduleProposal();
    });
    this.publish();
  }
  councilTick() {
    if (!this.councilEnabled || this.closed || this.store.get('paused') === 'true') return;
    this.finishCouncil();
  }
  queueCouncilRound() {
    const motion = this.world.council;
    if (
      motion?.status === 'open' &&
      this.now() < motion.closesAt &&
      motion.residents.length < IDS.length &&
      this.store.get('council_ballot_attempt') !== motion.id
    )
      this.pendingCouncilRound = motion.id;
  }
  councilRoundDue() {
    const motion = this.world.council;
    return (
      this.councilEnabled &&
      motion?.status === 'open' &&
      this.now() < motion.closesAt &&
      this.pendingCouncilRound === motion.id &&
      motion.residents.length < IDS.length &&
      this.store.get('council_ballot_attempt') !== motion.id &&
      [...this.listeners].some((l) => l.online && this.now() - l.lastActive < 600000)
    );
  }
  scheduleProposal() {
    const delay = COUNCIL_BREAK + this.draw(AI_PROPOSAL_MAX_DELAY - COUNCIL_BREAK + 1);
    this.store.set('next_council_proposal_at', this.now() + delay);
    this.store.set('council_proposal_generation', randomUUID());
  }
  proposalCandidates() {
    const rows = this.store.db
      .prepare('SELECT agent_id FROM council_ai_proposals WHERE created>?')
      .all(this.now() - hour);
    return rows.length >= 2 ? [] : IDS.filter((id) => !rows.some((row) => row.agent_id === id));
  }
  inviteProposal(task) {
    if (
      !this.councilEnabled ||
      task.kind !== 'automatic' ||
      task.action.type !== 'round' ||
      this.world.council?.status === 'open' ||
      this.store.get('paused') === 'true' ||
      this.now() < Number(this.store.get('next_council_proposal_at')) ||
      ![...this.listeners].some((l) => l.visible && this.now() - l.lastActive < 600000)
    )
      return;
    // Persist before the model request: declines, errors and restarts cannot trigger rapid retries.
    this.scheduleProposal();
    const candidates = this.proposalCandidates();
    if (!candidates.length) return;
    return {
      agentId: candidates[this.draw(candidates.length)],
      generation: this.store.get('council_proposal_generation'),
    };
  }
  acceptResidentProposal(round, invitation) {
    const candidate = round.councilProposal;
    if (
      !invitation ||
      !candidate ||
      candidate.agentId !== invitation.agentId ||
      invitation.generation !== this.store.get('council_proposal_generation') ||
      this.world.council?.status === 'open' ||
      !this.proposalCandidates().includes(candidate.agentId)
    )
      return;
    const now = this.now(),
      id = randomUUID();
    if (proposalError(this.world, candidate.proposal, id, now)) return;
    const next = openCouncil(this.world, candidate.proposal.topic, id, now, candidate.proposal);
    next.council.proposer = candidate.agentId;
    next.council.residents.push({
      agentId: candidate.agentId,
      choice: 'yes',
      opinion: candidate.reason,
    });
    this.commit(next);
    this.queueCouncilRound();
    this.store.db.exec('DELETE FROM council_votes; DELETE FROM council_attendees');
    this.store.db.prepare('DELETE FROM council_ai_proposals WHERE created<=?').run(now - day);
    this.store.db
      .prepare('INSERT INTO council_ai_proposals VALUES (?, ?, ?)')
      .run(id, candidate.agentId, now);
    for (const listener of this.listeners)
      if (listener.online && now - listener.lastActive < 600000)
        this.attendCouncil(listener.identity);
  }
  vote(identity, body) {
    const parsed = z
      .object({ motionId: z.string().uuid(), choice: VoteChoiceSchema })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new HttpError(400, '请选择赞成或反对。');
    if (this.store.get('paused') === 'true') throw new HttpError(503, '小镇暂时休息，请稍后再来。');
    this.councilTick();
    const motion = this.world.council;
    if (
      !motion ||
      motion.id !== parsed.data.motionId ||
      motion.status !== 'open' ||
      this.now() >= motion.closesAt
    )
      throw new HttpError(409, '这场投票已结束，请查看最新议题。');
    const previous = this.store.db
      .prepare('SELECT choice, updated FROM council_votes WHERE motion_id=? AND owner=?')
      .get(motion.id, identity.owner);
    if (previous?.choice === parsed.data.choice) return { choice: previous.choice };
    if (previous && this.now() - previous.updated < 1000)
      throw new HttpError(429, '改票太快，请稍后再试。');
    const ipCount = this.store.db
      .prepare('SELECT count(*) AS n FROM council_votes WHERE motion_id=? AND ip=?')
      .get(motion.id, identity.ip).n;
    if (!previous && ipCount >= 30) throw new HttpError(429, '当前网络参与较频繁，请稍后再来。');
    this.transaction(() => {
      this.attendCouncil(identity);
      this.store.db
        .prepare(
          'INSERT INTO council_votes VALUES (?, ?, ?, ?, ?) ON CONFLICT(motion_id, owner) DO UPDATE SET choice=excluded.choice, updated=excluded.updated',
        )
        .run(motion.id, identity.owner, identity.ip, parsed.data.choice, this.now());
      const next = structuredClone(this.world);
      if (previous) next.council[previous.choice === 'yes' ? 'visitorYes' : 'visitorNo']--;
      next.council[parsed.data.choice === 'yes' ? 'visitorYes' : 'visitorNo']++;
      this.commit(next);
    });
    this.publish();
    return { choice: parsed.data.choice };
  }
  propose(identity, body) {
    const parsed = CouncilProposalSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, '条款内容需为 1–300 字。');
    if (this.store.get('paused') === 'true') throw new HttpError(503, '小镇暂时休息，请稍后再来。');
    this.finishCouncil();
    if (this.world.council?.status === 'open')
      throw new HttpError(409, '当前议题仍在投票，请结束后再提交。');
    const proposal = parsed.data;
    const now = this.now(),
      id = randomUUID();
    const error = proposalError(this.world, proposal, id, now);
    if (error) throw new HttpError(409, error);
    const latest = this.store.db
      .prepare('SELECT max(created) AS created FROM council_proposals WHERE owner=?')
      .get(identity.owner).created;
    if (latest !== null && now - latest < 60000)
      throw new HttpError(429, '请间隔一分钟再提交议题。');
    const count = this.store.db
      .prepare('SELECT count(*) AS n FROM council_proposals WHERE ip=? AND created>?')
      .get(identity.ip, now - hour).n;
    if (count >= 10) throw new HttpError(429, '当前网络提议较频繁，请稍后再来。');
    this.transaction(() => {
      this.scheduleProposal();
      this.commit(openCouncil(this.world, proposal.topic, id, now, proposal));
      this.queueCouncilRound();
      this.store.db.exec('DELETE FROM council_votes; DELETE FROM council_attendees');
      this.store.db.prepare('DELETE FROM council_proposals WHERE created<?').run(now - hour);
      this.store.db
        .prepare('INSERT INTO council_proposals VALUES (?, ?, ?)')
        .run(identity.owner, identity.ip, now);
      for (const listener of this.listeners)
        if (listener.online && now - listener.lastActive < 600000)
          this.attendCouncil(listener.identity);
      this.attendCouncil(identity);
    });
    this.publish();
    queueMicrotask(() => this.tick());
    return { motionId: id };
  }
  publish() {
    for (const listener of this.listeners) listener.send(this.snapshot(listener.identity));
  }
  connect(identity, send, connection = 'default') {
    if (
      this.listeners.size >= this.limits.maxViewers ||
      [...this.listeners].filter((l) => l.identity.ip === identity.ip).length >= 8
    )
      throw new HttpError(429, '在线连接过多，请关闭重复页面后重试。');
    const listener = {
      identity,
      send,
      connection,
      visible: false,
      online: false,
      lastActive: this.now(),
    };
    this.listeners.add(listener);
    this.publish();
    queueMicrotask(() => this.tick());
    return () => {
      this.listeners.delete(listener);
      if (!this.closed) this.publish();
    };
  }
  presence(identity, visible, connection = 'default', online = visible) {
    for (const l of this.listeners)
      if (l.identity.owner === identity.owner && l.connection === connection) {
        l.visible = visible;
        l.online = online;
        l.lastActive = this.now();
        if (online) this.attendCouncil(identity);
      }
  }
  accept(identity, body) {
    const parsed = CommandSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, '操作格式不正确。');
    const { requestId, action } = parsed.data;
    const existing = this.store.db
      .prepare('SELECT * FROM commands WHERE owner=? AND request_id=?')
      .get(identity.owner, requestId);
    if (existing) {
      if (existing.original !== JSON.stringify(action))
        throw new HttpError(409, '此请求编号已用于另一项操作。');
      return { id: existing.id, state: existing.status };
    }
    if (action.type === 'round' && !this.autoError)
      throw new HttpError(409, '当前没有需要重试的思考回合。');
    if (!this.configured()) throw new HttpError(503, '小镇暂时无法互动，请稍后再来。');
    if (this.store.get('paused') === 'true') throw new HttpError(503, '小镇暂时休息，请稍后再来。');
    const budget = this.budget();
    if (budget.resetsAt > this.now()) throw new HttpError(429, '全站互动额度已用完，请稍后再来。');
    const quota = this.quota(identity);
    if (quota.nextAt > this.now()) throw new HttpError(429, '请间隔 10 秒再发送。');
    if (quota.usedHour >= this.limits.visitorHour || quota.usedDay >= this.limits.visitorDay)
      throw new HttpError(429, '互动次数已达上限，请稍后再来。');
    if (this.count('ip=? AND created>?', identity.ip, this.now() - hour) >= this.limits.ipHour)
      throw new HttpError(429, '当前网络参与较频繁，请稍后再来。');
    if (
      this.count("owner=? AND status IN ('pending','running')", identity.owner) >=
      this.limits.perVisitorPending
    )
      throw new HttpError(429, '你已有 2 项未完成操作，请稍候。');
    if (this.count("status IN ('pending','running')") >= this.limits.queue)
      throw new HttpError(429, '队列已满，请稍后再来。');
    let resolved = action;
    if (action.type === 'retry') {
      const previous = this.store.db
        .prepare('SELECT * FROM commands WHERE id=? AND owner=? AND status=?')
        .get(action.id, identity.owner, 'failed');
      if (!previous) throw new HttpError(404, '无法重试这项操作。');
      resolved = JSON.parse(previous.action);
    }
    const id = this.transaction(() => {
      if (action.type === 'retry')
        this.store.db.prepare("UPDATE commands SET status='retried' WHERE id=?").run(action.id);
      return Number(
        this.store.db
          .prepare(
            'INSERT INTO commands(owner,ip,request_id,created,action,original,status) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            identity.owner,
            identity.ip,
            requestId,
            this.now(),
            JSON.stringify(resolved),
            JSON.stringify(action),
            'pending',
          ).lastInsertRowid,
      );
    });
    const voting =
      this.active?.councilMotionId === this.world.council?.id &&
      this.world.council?.status === 'open' &&
      this.now() < this.world.council.closesAt;
    if (this.active?.kind === 'automatic' && !voting) {
      this.controller.abort();
      this.active = null;
    }
    this.setAutoError('');
    this.publish();
    this.tick();
    return { id, state: 'pending' };
  }
  cancel(identity, id) {
    const result = this.store.db
      .prepare(
        "UPDATE commands SET status='cancelled' WHERE id=? AND owner=? AND status IN ('pending','failed')",
      )
      .run(id, identity.owner);
    if (!result.changes) throw new HttpError(409, '只能取消自己尚未执行或已失败的操作。');
    this.publish();
  }
  transaction(fn) {
    const world = this.world,
      version = this.version;
    try {
      return this.store.transaction(fn);
    } catch (error) {
      this.world = world;
      this.version = version;
      throw error;
    }
  }
  commit(world) {
    this.version = this.store.saveWorld(world);
    this.world = world;
  }
  pump() {
    if (
      this.closed ||
      this.active ||
      !this.configured() ||
      this.store.get('paused') === 'true' ||
      this.budget().resetsAt > this.now()
    )
      return;
    const row = this.store.db
      .prepare("SELECT * FROM commands WHERE status='pending' ORDER BY id LIMIT 1")
      .get();
    if (row) this.start({ id: row.id, kind: 'human', action: JSON.parse(row.action) });
  }
  tick() {
    if (this.closed) return;
    this.councilTick();
    if (this.now() - this.lastMaintenance > hour) {
      this.lastMaintenance = this.now();
      this.store.db.prepare('DELETE FROM model_failures WHERE created<?').run(this.now() - 7 * day);
      // Seven days of detailed audit records; lifetime usage totals are retained separately.
      this.store.db
        .prepare(
          "DELETE FROM commands WHERE created<? AND status NOT IN ('pending','running','failed')",
        )
        .run(this.now() - 7 * day);
    }
    const councilRound = this.councilRoundDue();
    if (!councilRound) this.pump();
    if (
      this.active ||
      !this.configured() ||
      this.store.get('paused') === 'true' ||
      (this.autoError && !councilRound) ||
      this.budget().resetsAt > this.now()
    )
      return;
    const watching = [...this.listeners].some(
      (l) => l.visible && this.now() - l.lastActive < 600000,
    );
    if (councilRound || (watching && this.now() >= this.nextTurn))
      this.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
  }
  async start(task) {
    this.active = task;
    const controller = new AbortController();
    this.controller = controller;
    let callId, resultUsage;
    try {
      this.transaction(() => {
        const action = task.action;
        if (task.kind === 'human') {
          const owner = this.store.db
            .prepare('SELECT owner FROM commands WHERE id=?')
            .get(task.id).owner;
          const author = this.name(owner);
          const prepare = (next) => {
            next.feed[0].author = author;
            if (action.type === 'chat') next.conversations.at(-1).author = author;
            this.commit(next);
          };
          if (action.type === 'event' && !action.prepared) {
            prepare(applyEvent(this.world, action.eventId));
            action.prepared = true;
          }
          if (action.type === 'chat' && action.messageId === undefined) {
            prepare(addHumanMessage(this.world, action.agentId, action.text));
            action.messageId = this.world.conversations.at(-1).id;
          }
          if (action.type === 'join' && !this.world.human) prepare(joinWorld(this.world));
          this.store.db
            .prepare("UPDATE commands SET status='running', action=? WHERE id=?")
            .run(JSON.stringify(action), task.id);
        }
        if (action.type !== 'join')
          callId = Number(
            this.store.db.prepare('INSERT INTO calls(created) VALUES (?)').run(this.now())
              .lastInsertRowid,
          );
      });
      this.publish();
      if (task.action.type !== 'join') {
        const world = this.world,
          action = task.action;
        const proposalInvitation = this.inviteProposal(task);
        if (action.type !== 'chat' && world.council?.status === 'open') {
          task.councilMotionId = world.council.id;
          this.store.set('council_ballot_attempt', world.council.id);
          this.pendingCouncilRound = undefined;
        }
        const result = await this.model(
          this.config,
          {
            world,
            round: action.type !== 'chat',
            ...(proposalInvitation ? { proposalInvitation } : {}),
            ...(action.type === 'chat' ? { agentId: action.agentId, prompt: action.text } : {}),
          },
          controller.signal,
        );
        if (controller.signal.aborted || this.closed || this.active !== task) return;
        resultUsage = result.usage;
        this.finishCouncil();
        if (JSON.stringify(world.laws || []) !== JSON.stringify(this.world.laws || [])) {
          this.store.db
            .prepare('UPDATE calls SET input=?, output=? WHERE id=?')
            .run(
              Math.max(0, Number(result.usage?.input) || 0),
              Math.max(0, Number(result.usage?.output) || 0),
              callId,
            );
          if (task.kind === 'human') throw new HttpError(409, '宪法已更新，请重试本次对话。');
          return;
        }
        let next =
          action.type === 'chat'
            ? applyChatReply(
                this.world,
                action.agentId,
                DecisionSchema.parse(result.decision),
                action.messageId,
              )
            : applyRound(this.world, RoundSchema.parse(result.round));
        if (action.type !== 'chat')
          next = recordCouncilOpinions(
            next,
            RoundSchema.parse(result.round),
            world.council?.id,
            this.now(),
          );
        this.transaction(() => {
          this.commit(next);
          if (action.type !== 'chat')
            this.acceptResidentProposal(RoundSchema.parse(result.round), proposalInvitation);
          this.store.db
            .prepare('UPDATE calls SET input=?, output=? WHERE id=?')
            .run(
              Math.max(0, Number(result.usage?.input) || 0),
              Math.max(0, Number(result.usage?.output) || 0),
              callId,
            );
          if (task.kind === 'human')
            this.store.db.prepare("UPDATE commands SET status='completed' WHERE id=?").run(task.id);
        });
        this.setAutoError('');
        this.finishCouncil();
      } else
        this.store.db.prepare("UPDATE commands SET status='completed' WHERE id=?").run(task.id);
    } catch (e) {
      if (controller.signal.aborted || this.closed || this.active !== task) return;
      if (callId) {
        const diagnostic =
          e instanceof ModelError
            ? e.diagnostic
            : {
                code:
                  e?.name === 'ZodError'
                    ? 'world_validation'
                    : e instanceof HttpError
                      ? 'application_http'
                      : 'internal',
                ...(e?.name === 'ZodError' ? { issues: validationDetails(e.issues) } : {}),
              };
        this.store.db
          .prepare('INSERT OR REPLACE INTO model_failures VALUES (?, ?, ?, ?)')
          .run(callId, this.now(), task.kind, JSON.stringify(diagnostic));
        const usage = e instanceof ModelError ? e.usage : resultUsage;
        if (usage)
          this.store.db
            .prepare('UPDATE calls SET input=?,output=? WHERE id=?')
            .run(
              Number.isFinite(Number(usage.input)) ? Math.max(0, Number(usage.input)) : 0,
              Number.isFinite(Number(usage.output)) ? Math.max(0, Number(usage.output)) : 0,
              callId,
            );
      }
      // Never expose provider response bodies, SQL diagnostics, or server credentials.
      const error = e instanceof HttpError ? e.message : '暂时无法回应，请重试。';
      if (task.kind === 'human')
        this.store.db
          .prepare("UPDATE commands SET status='failed', error=? WHERE id=?")
          .run(error, task.id);
      else this.setAutoError(error);
    } finally {
      if (this.active === task && !this.closed) {
        this.active = null;
        this.nextTurn = this.now() + this.limits.interval;
        this.publish();
        queueMicrotask(() => this.tick());
      }
    }
  }
  admin(token, action, replay) {
    if (!this.config.adminToken || !same(token || '', this.config.adminToken))
      throw new HttpError(403, '需要管理员凭据。');
    if (action === 'pause' || action === 'resume') {
      this.store.set('paused', action === 'pause' ? 'true' : 'false');
      if (action === 'resume') this.setAutoError('');
    } else if (action === 'reset' || action === 'import') {
      const next = action === 'reset' ? createWorld() : importReplay(replay).at(-1);
      this.controller?.abort();
      this.active = null;
      this.transaction(() => {
        this.store.db.exec(
          "UPDATE commands SET status='cancelled' WHERE status IN ('pending','running','failed')",
        );
        this.store.db.exec('DELETE FROM council_votes');
        this.store.db.exec('DELETE FROM council_attendees');
        this.store.db.exec('DELETE FROM constitution_articles');
        for (const article of next.constitution || [])
          this.store.db
            .prepare('INSERT INTO constitution_articles(id,motion_id,article) VALUES (?, ?, ?)')
            .run(article.id, article.motionId, JSON.stringify(article));
        this.commit(next);
        this.store.set('paused', 'true');
        this.scheduleProposal();
      });
      this.setAutoError('');
    } else throw new HttpError(400, '管理操作不正确。');
    this.publish();
    this.tick();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    this.listeners.clear();
    this.store.close();
  }
}
