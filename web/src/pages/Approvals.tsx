import { useState } from 'react';
import { ApiError, api, usePoll } from '../api';
import type { Reason } from '../types';
import { Addr, Badge, Card, Empty, ErrorNote, Time, Usdc, VerifyButton, formatBaseUnits, shortSig } from '../ui';

const ACTOR_KEY = 'mandate.actor';

function loadActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? 'reviewer';
  } catch {
    return 'reviewer';
  }
}

export function Approvals({ go }: { go: (path: string) => void }) {
  const queue = usePoll(() => api.requests('needs_approval'), 'queue');
  const decisions = usePoll(api.decisions, 'decisions');
  const [actor, setActor] = useState(loadActor);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function updateActor(value: string) {
    setActor(value);
    try {
      localStorage.setItem(ACTOR_KEY, value);
    } catch {
      /* storage unavailable: fine */
    }
  }

  async function act(id: string, action: 'approve' | 'reject') {
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: '' }));
    try {
      await api.resolve(id, action, actor.trim() || 'reviewer');
      await Promise.all([queue.refresh(), decisions.refresh()]);
    } catch (e) {
      const err = e as ApiError;
      const detail = Array.isArray(err.details)
        ? ` ${(err.details as Reason[]).map((d) => d.message).join(' ')}`
        : '';
      setErrors((prev) => ({ ...prev, [id]: `${err.message}${detail}` }));
    } finally {
      setBusy(null);
    }
  }

  const reasonsFor = (requestId: string): Reason[] =>
    decisions.data?.find((d) => d.requestId === requestId && d.decidedBy === 'policy')?.reasons ?? [];

  return (
    <div className="stack">
      <ErrorNote message={queue.error ?? decisions.error} />

      <Card
        title={`Waiting for approval${queue.data ? ` (${queue.data.length})` : ''}`}
        aside={
          <label className="inline-field">
            Reviewing as
            <input value={actor} onChange={(e) => updateActor(e.target.value)} maxLength={40} aria-label="Reviewer name" />
          </label>
        }
      >
        {queue.data && queue.data.length === 0 && <Empty>Nothing is waiting. Agents are inside their mandates.</Empty>}
        <ul className="queue">
          {queue.data?.map((r) => (
            <li key={r.id} className="queue-item">
              <div className="queue-main">
                <div className="queue-title">
                  <strong>{r.agentId}</strong> wants to pay <Usdc value={r.amountUsdc} />
                </div>
                <div className="muted">
                  to <Addr value={r.recipient} full /> · <Time ms={r.createdAt} />
                </div>
                {r.memo && <div className="memo">“{r.memo}”</div>}
                <ul className="reasons">
                  {reasonsFor(r.id).map((reason) => (
                    <li key={reason.code}>{reason.message}</li>
                  ))}
                </ul>
                <ErrorNote message={errors[r.id] ?? null} />
              </div>
              <div className="queue-actions">
                <button type="button" className="btn btn-primary" disabled={busy === r.id} onClick={() => void act(r.id, 'approve')}>
                  Approve
                </button>
                <button type="button" className="btn" disabled={busy === r.id} onClick={() => void act(r.id, 'reject')}>
                  Reject
                </button>
                <button type="button" className="link" onClick={() => go(`/requests/${r.id}`)}>
                  Details
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Decision log" aside={<span className="muted">Every decision is signed (EIP-712)</span>}>
        {decisions.data && decisions.data.length === 0 && <Empty>No decisions yet.</Empty>}
        {decisions.data && decisions.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Decision</th>
                  <th>By</th>
                  <th>Agent</th>
                  <th className="right">Amount</th>
                  <th>Signature</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {decisions.data.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Time ms={d.createdAt} />
                    </td>
                    <td>
                      <Badge status={d.outcome} />
                    </td>
                    <td>{d.decidedBy}</td>
                    <td>
                      <button type="button" className="link" onClick={() => go(`/requests/${d.requestId}`)}>
                        {d.message.agentId}
                      </button>
                    </td>
                    <td className="right">
                      <Usdc value={formatBaseUnits(d.message.amount)} />
                    </td>
                    <td>
                      <code className="mono muted" title={d.signature}>
                        {shortSig(d.signature)}
                      </code>
                    </td>
                    <td className="right">
                      <VerifyButton decision={d} />
                    </td>
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
