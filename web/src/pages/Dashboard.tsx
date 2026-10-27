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

function AgentCard({ a, onOpen }: { a: AgentSummary; onOpen: () => void }) {
  const spent = Number(a.spentTodayUsdc);
  const limit = Number(a.dailyLimitUsdc);
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;

  return (
    <article className={`agent${a.active ? '' : ' agent-paused'}`}>
      <header className="agent-head">
        <div>
          <h3>{a.name}</h3>
          <code className="mono muted">{a.agentId}</code>
        </div>
        {!a.active && <span className="badge badge-denied">Paused</span>}
        {a.pendingApprovals > 0 && (
          <button type="button" className="chip chip-warn" onClick={onOpen}>
            {a.pendingApprovals} waiting
          </button>
        )}
      </header>

      <div className="meter" aria-label={`Spent ${a.spentTodayUsdc} of ${a.dailyLimitUsdc} USDC today`}>
        <div className="meter-fill" style={{ width: `${pct}%` }} data-high={pct >= 85} />
      </div>
      <div className="meter-caption">
        <span>
          <strong className="num">{a.spentTodayUsdc}</strong> of <span className="num">{a.dailyLimitUsdc}</span> USDC today
        </span>
        <span className="muted num">{a.remainingTodayUsdc} left</span>
      </div>

      <dl className="facts">
        <div>
          <dt>Per payment</dt>
          <dd className="num">≤ {a.perPaymentLimitUsdc}</dd>
        </div>
        <div>
          <dt>Auto-approve up to</dt>
          <dd className="num">{a.approvalThresholdUsdc ?? 'no cap'}</dd>
        </div>
        <div>
          <dt>Allowlist</dt>
          <dd className="num">{a.allowedRecipients.length}</dd>
        </div>
      </dl>

      <div className="agent-foot">
        <span>
          <span className="dot dot-approved" /> {a.requestCounts.approved} approved
        </span>
        <span>
          <span className="dot dot-needs_approval" /> {a.requestCounts.needs_approval} queued
        </span>
        <span>
          <span className="dot dot-denied" /> {a.requestCounts.denied} denied
        </span>
      </div>
      <div className="agent-chain">
        <span>
          Onchain: <strong className="num">{a.confirmedOnchainUsdc}</strong> USDC confirmed
        </span>
        {a.pendingPayments > 0 && <span className="muted"> · {a.pendingPayments} awaiting receipt</span>}
        {a.mismatches > 0 && <span className="text-bad"> · {a.mismatches} mismatch</span>}
      </div>
    </article>
  );
}

export function Dashboard({ go }: { go: (path: string) => void }) {
  const summary = usePoll(api.summary, 'summary');
  const recent = usePoll(() => api.requests(), 'requests-all');

  const t = summary.data?.totals;

  return (
    <div className="stack">
      <ErrorNote message={summary.error ?? recent.error} />

      <div className="tiles">
        <Tile
          label="Waiting on a human"
          value={String(t?.pendingApprovals ?? '–')}
          tone={t && t.pendingApprovals > 0 ? 'warn' : undefined}
        />
        <Tile label="Approved spend today (UTC)" value={t ? `${t.spentTodayUsdc} USDC` : '–'} />
        <Tile label="Confirmed onchain" value={t ? `${t.confirmedOnchainUsdc} USDC` : '–'} hint="Matched to a Base Sepolia transfer" />
        <Tile
          label="Mismatches"
          value={String(t?.mismatches ?? '–')}
          tone={t && t.mismatches > 0 ? 'bad' : undefined}
          hint={t && t.pendingPayments > 0 ? `${t.pendingPayments} awaiting receipt` : undefined}
        />
      </div>

      <Card title="Agents">
        {summary.data && summary.data.agents.length === 0 && (
          <Empty>No agents yet. Run `npm run seed` or create a mandate with PUT /mandates/:agentId.</Empty>
        )}
        <div className="agents">
          {summary.data?.agents.map((a) => (
            <AgentCard key={a.agentId} a={a} onOpen={() => go('/approvals')} />
          ))}
        </div>
      </Card>

      <Card
        title="Recent requests"
        aside={
          <button type="button" className="link" onClick={() => go('/requests')}>
            View all
          </button>
        }
      >
        {recent.data && recent.data.length === 0 && <Empty>No requests yet. Try the Simulator tab.</Empty>}
        {recent.data && recent.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th className="right">Amount</th>
                  <th>Recipient</th>
                  <th>Decision</th>
                  <th>Onchain</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.slice(0, 8).map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => go(`/requests/${r.id}`)}>
                    <td>
                      <Time ms={r.createdAt} />
                    </td>
                    <td>{r.agentId}</td>
                    <td className="right">
                      <Usdc value={r.amountUsdc} />
                    </td>
                    <td>
                      <Addr value={r.recipient} />
                    </td>
                    <td>
                      <Badge status={r.status} />
                    </td>
                    <td>{r.payment ? <Badge status={r.payment.status} /> : <span className="muted">–</span>}</td>
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
