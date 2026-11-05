import { useState, type FormEvent } from 'react';
import { api, usePoll } from '../api';
import type { DecisionDetail, Recon, TrailEvent, Verdict } from '../types';
import { Addr, Badge, Card, Empty, ErrorNote, Time, Usdc, decodeJwtPart, fmtTime, formatBaseUnits, shortToken } from '../ui';

// ---------------------------------------------------------------- list

export function Decisions({ go }: { go: (path: string) => void }) {
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const list = usePoll(() => api.decisions({ verdict: verdict || undefined, limit: 200 }), `decisions-${verdict}`);

  return (
    <Card
      title="Decision log"
      aside={
        <label className="inline-field">
          Verdict
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict | '')}>
            <option value="">All</option>
            <option value="allow">Allowed</option>
            <option value="deny">Denied</option>
          </select>
        </label>
      }
    >
      <p className="muted small log-note">Append-only: the database rejects any UPDATE or DELETE on this table.</p>
      <ErrorNote message={list.error} />
      {list.data && list.data.length === 0 && <Empty>No decisions match.</Empty>}
      {list.data && list.data.length > 0 && (
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
                <th>Reason</th>
                <th>Onchain</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((d) => (
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
                  <td className="reason-cell">{d.reasonCode ?? <span className="muted">within mandate</span>}</td>
                  <td>{d.payment ? <Badge status={d.payment.status} /> : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- detail

function describeEvent(e: TrailEvent): { title: string; body?: string; tone: string } {
  const d = e.detail as Record<string, string | number | null | undefined>;
  switch (e.type) {
    case 'authorization_requested':
      return {
        title: 'Agent requested a payment',
        body: `${String(d.amountUsdc)} ${String(d.currency)} to ${String(d.recipient)} · ${String(d.category)}`,
        tone: 'neutral',
      };
    case 'verdict_issued':
      return {
        title: d.verdict === 'allow' ? 'Verdict: allow (signed, valid 5 minutes)' : 'Verdict: deny (signed)',
        body: `${String(d.reason)}${d.mandateVersion ? ` · mandate v${String(d.mandateVersion)}` : ''}`,
        tone: String(d.verdict),
      };
    case 'reconciliation_pending':
      return { title: 'Transaction submitted, waiting for the receipt', body: `${String(d.txHash)}\n${String(d.detail ?? '')}`, tone: 'pending' };
    case 'reconciliation_matched':
      return { title: 'Onchain transfer matched the verdict', body: `${String(d.detail)} (block ${String(d.blockNumber)})`, tone: 'matched' };
    case 'reconciliation_mismatch':
      return { title: 'Onchain transfer does not match the verdict', body: String(d.detail ?? d.reason ?? ''), tone: 'mismatch' };
  }
}

function Timeline({ events }: { events: TrailEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => {
        const d = describeEvent(e);
        return (
          <li key={i} className={`tl tl-${d.tone}`}>
            <div className="tl-title">{d.title}</div>
            {d.body && <div className="tl-body">{d.body}</div>}
            <div className="tl-time muted">{fmtTime(e.at)}</div>
          </li>
        );
      })}
    </ol>
  );
}

function PaymentPanel({ detail, onChange }: { detail: DecisionDetail; onChange: () => Promise<void> }) {
  const { decision, mandate, reconciliations } = detail;
  const payment: Recon | null = reconciliations.at(-1) ?? null;
  const [tx, setTx] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<Recon>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setTx('');
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => api.attachTx(decision.id, tx.trim()));
  }

  if (decision.verdict !== 'allow') {
    return <Empty>Only allowed verdicts can be paid, so there is no transaction to reconcile.</Empty>;
  }

  return (
    <div className="stack-small">
      {payment && (
        <div className={`payment payment-${payment.status}`}>
          <div className="payment-head">
            <Badge status={payment.status} />
            <a href={payment.explorerUrl} target="_blank" rel="noreferrer">
              View on BaseScan ↗
            </a>
          </div>
          <div className="mono tx">{payment.txHash}</div>
          {payment.detail && <p>{payment.detail}</p>}

          {payment.status !== 'pending' && payment.actualAmount !== null && (
            <table className="compare">
              <thead>
                <tr>
                  <th />
                  <th>Verdict</th>
                  <th>Onchain</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Amount</th>
                  <td>
                    <Usdc value={decision.amountUsdc} />
                  </td>
                  <td className={payment.actualAmount === decision.amount ? '' : 'text-bad'}>
                    <Usdc value={payment.actualAmountUsdc ?? formatBaseUnits(payment.actualAmount)} />
                  </td>
                </tr>
                <tr>
                  <th>Recipient</th>
                  <td>
                    <Addr value={decision.recipient} />
                  </td>
                  <td className={payment.actualRecipient?.toLowerCase() === decision.recipient.toLowerCase() ? '' : 'text-bad'}>
                    {payment.actualRecipient && <Addr value={payment.actualRecipient} />}
                  </td>
                </tr>
                {mandate?.payerAddress && (
                  <tr>
                    <th>From</th>
                    <td>
                      <Addr value={mandate.payerAddress} />
                    </td>
                    <td className={payment.actualFrom?.toLowerCase() === mandate.payerAddress.toLowerCase() ? '' : 'text-bad'}>
                      {payment.actualFrom && <Addr value={payment.actualFrom} />}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {payment.status === 'pending' && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.recheck(decision.id))}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
          )}
        </div>
      )}

      {payment?.status !== 'matched' && (
        <>
          {!payment && (
            <p className="muted">
              Send <Usdc value={decision.amountUsdc} /> to <Addr value={decision.recipient} /> on Base Sepolia, then paste the transaction hash.
              The server fetches the receipt, decodes the USDC <code>Transfer</code> log, and compares it to the verdict using bigint.
            </p>
          )}
          <form className="tx-form" onSubmit={submit}>
            <input
              className="mono"
              placeholder="0x… transaction hash (Base Sepolia)"
              value={tx}
              onChange={(e) => setTx(e.target.value)}
              aria-label="Transaction hash"
              spellCheck={false}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || tx.trim().length === 0}>
              {payment ? 'Replace transaction' : 'Reconcile transaction'}
            </button>
          </form>
        </>
      )}
      <ErrorNote message={error} />
    </div>
  );
}

export function DecisionDetailView({ id, go }: { id: string; go: (path: string) => void }) {
  const { data, error, refresh } = usePoll(() => api.decision(id), `decision-${id}`);

  if (error && !data) {
    return (
      <Card>
        <ErrorNote message={error} />
        <button type="button" className="link" onClick={() => go('/decisions')}>
          ← Back to the log
        </button>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <Empty>Loading…</Empty>
      </Card>
    );
  }

  const { decision: d, mandate, trail } = data;
  const header = decodeJwtPart(d.token, 0);
  const claims = decodeJwtPart(d.token, 1);

  return (
    <div className="stack">
      <button type="button" className="link back" onClick={() => go('/decisions')}>
        ← Decision log
      </button>

      <Card title={`${d.agentId} → ${d.amountUsdc} USDC`} aside={<Badge status={d.verdict} />}>
        <dl className="facts facts-wide">
          <div className="full">
            <dt>Recipient</dt>
            <dd>
              <Addr value={d.recipient} full />
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              <Usdc value={d.amountUsdc} /> <span className="muted mono">({d.amount})</span>
            </dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{d.category}</dd>
          </div>
          <div>
            <dt>Mandate</dt>
            <dd>{mandate ? `v${mandate.version} (${mandate.status})` : <span className="muted">none</span>}</dd>
          </div>
          <div>
            <dt>Decided</dt>
            <dd>{fmtTime(d.createdAt)}</dd>
          </div>
          <div>
            <dt>Verdict expires</dt>
            <dd>
              <Time ms={d.expiresAt} />
            </dd>
          </div>
          <div className="full">
            <dt>Decision id (JWT jti)</dt>
            <dd className="mono">{d.id}</dd>
          </div>
        </dl>
        <p className={d.verdict === 'allow' ? 'muted small' : 'reason-deny'}>
          {d.reasonCode ? `${d.reasonCode}: ` : ''}
          {d.reason}
        </p>
      </Card>

      <div className="two-col">
        <Card title="Onchain reconciliation">
          <PaymentPanel detail={data} onChange={refresh} />
        </Card>

        <Card title="Trail: request to transaction">
          <Timeline events={trail} />
        </Card>
      </div>

      <Card title="Signed verdict" aside={<span className="muted small">ES256 JWT · verify with /.well-known/jwks.json</span>}>
        <div className="mono token" title="The verdict a seller receives">
          {shortToken(d.token)}
        </div>
        <details>
          <summary>Decoded header and claims (display only, not verified here)</summary>
          <pre className="json">{JSON.stringify({ header, claims }, null, 2)}</pre>
        </details>
        <details>
          <summary>Full token</summary>
          <pre className="json json-wrap">{d.token}</pre>
        </details>
      </Card>
    </div>
  );
}
