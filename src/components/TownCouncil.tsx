import { useEffect, useState } from 'react';
import type { VoteChoice, World } from '../shared/schema';
import { councilDescription, councilTally } from '../world/council';
import { Icon } from './Icons';

export function TownCouncil({
  world,
  yourVote,
  serverTime,
  connected,
  readOnly,
  replaying,
  voting,
  error,
  onVote,
}: {
  world: World;
  yourVote: VoteChoice | null;
  serverTime: number;
  connected: boolean;
  readOnly: boolean;
  replaying: boolean;
  voting: boolean;
  error: string;
  onVote: (motionId: string, choice: VoteChoice) => void;
}) {
  const motion = world.council;
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!motion || motion.status !== 'open' || replaying) return;
    const receivedAt = Date.now();
    const update = () =>
      setRemaining(
        Math.max(0, Math.ceil((motion.closesAt - serverTime - (Date.now() - receivedAt)) / 1000)),
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [motion?.id, motion?.status, motion?.closesAt, serverTime, replaying]);
  const topic = motion ? councilDescription(motion) : null;
  const totals = motion ? councilTally(motion) : null;
  const closed = motion?.status === 'closed';
  const disabled = readOnly || !connected || voting || closed || remaining === 0;
  return (
    <section className="town-council" aria-label="小镇议会">
      <div className="council-heading">
        <h2>
          <Icon name="people" size={16} />
          小镇议会
        </h2>
        <span className={closed ? 'council-badge closed' : 'council-badge'}>
          {!motion ? '等待开题' : closed ? '已结算' : replaying ? '历史投票' : '投票中'}
        </span>
        {motion && !closed && !replaying && (
          <time aria-label="议会投票剩余时间">
            {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
          </time>
        )}
      </div>
      {!motion || !topic || !totals ? (
        <p className="council-empty">下一场议会，等大家一起开场。</p>
      ) : (
        <>
          <h3>{topic.title}</h3>
          {motion.proposer && !closed && (
            <p className="council-hint">
              {world.agents.find((a) => a.id === motion.proposer)?.name}提议
            </p>
          )}
          {motion.resolutionNote && <p className="council-hint">{motion.resolutionNote}</p>}
          {!closed && (
            <>
              <blockquote className="proposed-rule">{topic.rule}</blockquote>
              <p className="council-description">{topic.description}</p>
              <p className="council-impact">
                <Icon name="bolt" size={13} />
                <span>通过后：{topic.effect}</span>
              </p>
            </>
          )}
          <div className="council-votes" aria-label="议会票数" aria-live="polite">
            <strong>赞成 {totals.yes}</strong>
            <span>反对 {totals.no}</span>
            <small>
              居民 {motion.residents.length} 票 · 访客 {motion.visitorYes + motion.visitorNo} 票
            </small>
          </div>
          <div className="council-meter" aria-hidden="true">
            <span
              style={{
                width: `${totals.yes + totals.no ? (totals.yes / (totals.yes + totals.no)) * 100 : 50}%`,
              }}
            />
          </div>
          {closed && (
            <p className="council-hint">
              居民弃权 {6 - motion.residents.length} · 访客弃权 {motion.visitorAbstain}
            </p>
          )}
          {closed ? (
            <p className="council-result" role="status">
              {motion.result === 'passed'
                ? '提案通过，已更新小镇宪法。'
                : motion.result === 'tied'
                  ? '平票，维持现状。'
                  : '提案未通过，维持现状。'}
            </p>
          ) : (
            <>
              <div className="council-actions">
                {(['yes', 'no'] as const).map((choice) => (
                  <button
                    key={choice}
                    disabled={disabled || (!replaying && yourVote === choice)}
                    aria-pressed={!replaying && yourVote === choice}
                    onClick={() => onVote(motion.id, choice)}
                  >
                    <Icon name={choice === 'yes' ? 'check' : 'close'} size={15} />
                    {choice === 'yes' ? '赞成提案' : '反对提案'}
                  </button>
                ))}
              </div>
              <p className="council-hint" role="status">
                {replaying
                  ? '回放中的投票记录'
                  : readOnly
                    ? '继续观察后可投票'
                    : !connected
                      ? '连接恢复后可投票'
                      : voting
                        ? '正在投票…'
                        : remaining === 0
                          ? '投票截止，等待结果'
                          : yourVote
                            ? `你已投${yourVote === 'yes' ? '赞成' : '反对'}，截止前可改票`
                            : '每人一票，截止前可改票'}
              </p>
            </>
          )}
          {!readOnly && !closed && error && (
            <p className="council-error" role="alert">
              {error}
            </p>
          )}
          <details className="council-opinions">
            <summary>
              居民意见 <span>{motion.residents.length}/6</span>
            </summary>
            {world.agents.map((agent) => {
              const vote = motion.residents.find((entry) => entry.agentId === agent.id);
              return (
                <div className="council-opinion" key={agent.id}>
                  <span className="council-resident" style={{ color: agent.color }}>
                    {agent.name}
                    <small>
                      {vote
                        ? vote.choice === 'yes'
                          ? '赞成'
                          : '反对'
                        : closed
                          ? '弃权'
                          : '尚未表态'}
                    </small>
                  </span>
                  {vote && <p>{vote.opinion}</p>}
                </div>
              );
            })}
          </details>
          {!closed && (
            <p className="council-rule">
              每场 {(motion.closesAt - motion.openedAt) / 1000}{' '}
              秒，每票同权；超时未投票视为弃权，平票维持现状。
            </p>
          )}
        </>
      )}
    </section>
  );
}
