import { useState } from 'react';
import type { CouncilProposal, World } from '../shared/schema';
import { CONSTITUTION_LIMIT, CONSTITUTION_TEXT_LIMIT, lawId } from '../shared/schema';
import { COUNCIL_DURATION, councilTopics } from '../world/council';

export function TownConstitution({
  world,
  readOnly,
  connected,
  proposing,
  error,
  onPropose,
}: {
  world: World;
  readOnly: boolean;
  connected: boolean;
  proposing: boolean;
  error: string;
  onPropose: (proposal: CouncilProposal) => Promise<void>;
}) {
  const laws = world.laws || [];
  const [draft, setDraft] = useState<CouncilProposal | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const matches = laws.filter((law) =>
    (law.rule + councilTopics.find((t) => t.id === law.topic)!.lawTitle).includes(query.trim()),
  );
  const pages = Math.max(1, Math.ceil(matches.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const active = world.council?.status === 'open';
  return (
    <section className="town-constitution" aria-label="现行小镇宪法">
      <p className="constitution-intro">
        现行 {laws.length} 项条款 / {CONSTITUTION_LIMIT} · 正文{' '}
        {laws.reduce((n, law) => n + law.rule.length, 0)}/{CONSTITUTION_TEXT_LIMIT} 字
      </p>
      {!laws.length && <p className="council-empty">宪法尚无条款。第一项通过的提案将写在这里。</p>}
      {laws.length > 20 && (
        <label className="constitution-search">
          搜索条款
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
      )}
      {laws.length > 0 && matches.length === 0 && <p className="council-empty">没有匹配的条款。</p>}
      {matches.slice(currentPage * 20, (currentPage + 1) * 20).map((law) => {
        const topic = councilTopics.find((item) => item.id === law.topic)!;
        return (
          <article key={lawId(law)}>
            <div className="constitution-meta">
              <strong>{topic.lawTitle}</strong>
              <span>第 {law.revision} 版</span>
              <time dateTime={new Date(law.updatedAt).toISOString()}>
                {new Date(law.updatedAt).toLocaleDateString('zh-CN')}
              </time>
            </div>
            <p className="law-text">{law.rule}</p>
            {!readOnly && (
              <div className="law-actions">
                <button
                  onClick={() =>
                    setDraft({
                      topic: law.topic,
                      lawId: lawId(law),
                      operation: 'amend',
                      rule: law.rule,
                    })
                  }
                  disabled={!connected || proposing}
                >
                  修订{topic.lawTitle}
                </button>
                <button
                  onClick={() =>
                    setDraft({ topic: law.topic, lawId: lawId(law), operation: 'repeal' })
                  }
                  disabled={!connected || proposing}
                >
                  废止{topic.lawTitle}
                </button>
              </div>
            )}
          </article>
        );
      })}
      {pages > 1 && (
        <nav className="law-actions" aria-label="宪法分页">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            上一页
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>
            下一页
          </button>
        </nav>
      )}
      {!readOnly && laws.length < CONSTITUTION_LIMIT && (
        <button
          className="constitution-more"
          disabled={!connected || proposing}
          onClick={() => {
            const topic = councilTopics[0];
            setDraft({ topic: topic.id, operation: 'adopt', rule: topic.rule });
          }}
        >
          提出新条款
        </button>
      )}
      {draft && !readOnly && (
        <form
          className="constitution-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onPropose(draft);
          }}
        >
          <h3>
            {draft.operation === 'repeal'
              ? '提议废止条款'
              : draft.operation === 'amend'
                ? '提议修订条款'
                : '提议新增条款'}
          </h3>
          {draft.operation === 'adopt' && (
            <label>
              条款主题
              <select
                value={draft.topic}
                onChange={(event) => {
                  const topic = councilTopics.find((item) => item.id === event.target.value)!;
                  setDraft({ ...draft, topic: topic.id, rule: topic.rule });
                }}
              >
                {councilTopics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.lawTitle}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.operation !== 'repeal' ? (
            <label>
              条款内容
              <textarea
                value={draft.rule || ''}
                required
                maxLength={300}
                rows={4}
                onChange={(event) => setDraft({ ...draft, rule: event.target.value })}
              />
            </label>
          ) : (
            <p>
              通过后将移除「{councilTopics.find((topic) => topic.id === draft.topic)!.lawTitle}」。
            </p>
          )}
          <p className="council-hint">
            {active
              ? '当前议题仍在投票，结束后可提交。'
              : `提交后开启 ${COUNCIL_DURATION / 1000} 秒投票，通过后生效。`}
          </p>
          {error && (
            <p className="council-error" role="alert">
              {error}
            </p>
          )}
          <div className="law-actions">
            <button type="submit" disabled={!connected || proposing || active}>
              {proposing ? '提交中…' : '提交议会投票'}
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              取消修改
            </button>
          </div>
        </form>
      )}
      {readOnly && <p className="council-hint">回放中的宪法只供查看。</p>}
    </section>
  );
}
