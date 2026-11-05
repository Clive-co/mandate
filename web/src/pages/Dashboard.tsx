import { api, usePoll } from '../api';
import type { AgentSummary } from '../types';
import { Addr, Badge, Card, Empty, ErrorNote, Time, Usdc } from '../ui';

function Tile({ label, value, tone, hint }: { label: string; value: string; tone?: 'warn' | 'bad'; hint?: string }) {
  return (
    <div className={`tile${tone ? ` tile-${tone}` : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value num">{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}

function AgentCard({ a, go }: { a: AgentSummary; go: (path: string) => void }) {
  const spent = Number(a.allowedTodayUsdc);
  const limit = Number(a.mandate.dailyLimitUsdc);
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const m = a.mandate;

  return (
    <article className={`agent${m.status === 'active' ? '' : ' agent-paused'}`}>
      <header className="agent-head">
        <div>
          <h3>{a.agentId}</h3>
          <span className="muted small">
            Mandate v{m.version} · {m.categories.join(', ')}
          </span>
        </div>
        <Badge status={m.status} />
      </header>

      <div className="meter" aria-label={`Allowed ${a.allowedTodayUsdc} of ${m.dailyLimitUsdc} USDC today`}>
        <div className="meter-fill" style={{ width: `${pct}%` }} data-high={pct >= 85} />
      </div>
      <div className="meter-caption">
        <span>
          <strong className="num">{a.allowedTodayUsdc}</strong> of <span className="num">{m.dailyLimitUsdc}</span> USDC today
        </span>
        <span className="muted num">{a.remainingTodayUsdc} left</span>
      </div>

      <dl className="facts">
        <div>
          <dt>Per transaction</dt>
          <dd className="num">≤ {m.perTxLimitUsdc}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            <Time ms={m.expiresAt} />
          </dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd>{m.allowedRecipients ? m.allowedRecipients.length : 'any'}</dd>
        </div>
      </dl>

      <div className="agent-foot">
        <span>
          <span className="dot dot-allow" /> {a.allowCount} allowed
        </span>
        <span>
          <span className="dot dot-deny" /> {a.denyCount} denied
        </span>
        <span>
          <span className="dot dot-pending" /> {a.awaitingPaymentCount} awaiting payment
        </span>
      </div>
      <div className="agent-chain">
        <span>
          Matched onchain: <strong className="num">{a.matchedUsdc}</strong> USDC
        </span>
        {a.pendingCount > 0 && <span className="muted"> · {a.pendingCount} pending</span>}
        {a.mismatchCount > 0 && <span className="text-bad"> · {a.mismatchCount} mismatch</span>}
        <button type="button" className="link link-right" onClick={() => go('/mandates')}>
          Mandates →
        </button>
      </div>
    </article>
  );
}

export function Dashboard({ go }: { go: (path: string) => void }) {
  const summary = usePoll(api.summary, 'summary');
  const recent = usePoll(() => api.decisions({ limit: 10 }), 'decisions-recent');
  const t = summary.data?.totals;

  return (
    <div className="stack">
      <ErrorNote message={summary.error ?? recent.error} />

      <div className="tiles">
        <Tile label="Allowed today (UTC)" value={t ? `${t.allowedTodayUsdc} USDC` : '–'} hint={t ? `${t.allowCount} allowed · ${t.denyCount} denied, all time` : undefined} />
        <Tile
          label="Awaiting payment"
          value={String(t?.awaitingPaymentCount ?? '–')}
          tone={t && t.awaitingPaymentCount > 0 ? 'warn' : undefined}
          hint="Allowed, no matching transfer yet"
        />
        <Tile label="Matched onchain" value={t ? `${t.matchedUsdc} USDC` : '–'} hint="Verified against a Base Sepolia transfer" />
        <Tile
          label="Mismatches"
          value={String(t?.mismatchCount ?? '–')}
          tone={t && t.mismatchCount > 0 ? 'bad' : undefined}
          hint={t && t.pendingCount > 0 ? `${t.pendingCount} pending receipt` : undefined}
        />
      </div>

      <Card title="Spend per agent">
        {summary.data && summary.data.agents.length === 0 && <Empty>No agents yet. Run `npm run seed`, or create a mandate on the Mandates page.</Empty>}
        <div className="agents">
          {summary.data?.agents.map((a) => (
            <AgentCard key={a.agentId} a={a} go={go} />
          ))}
        </div>
      </Card>

      <Card
        title="Recent approvals"
        aside={
          <button type="button" className="link" onClick={() => go('/decisions')}>
            View all
          </button>
        }
      >
        {recent.data && recent.data.length === 0 && <Empty>No authorizations yet. Try the Simulator.</Empty>}
        {recent.data && recent.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th className="right">Amount</th>
                  <th>Recipient</th>
                  <th>Category</th>
                  <th>Verdict</th>
                  <th>Onchain</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => go(`/decisions/${d.id}`)}>
                    <td>
                      <Time ms={d.createdAt} />
                    </td>
                    <td>{d.agentId}</td>
                    <td className="right">
                      <Usdc value={d.amountUsdc} />
                    </td>
                    <td>
                      <Addr value={d.recipient} />
                    </td>
                    <td>{d.category}</td>
                    <td>
                      <Badge status={d.verdict} />
                    </td>
                    <td>{d.payment ? <Badge status={d.payment.status} /> : <span className="muted">{d.verdict === 'allow' ? 'unpaid' : '–'}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
