import { useState, type FormEvent } from 'react';
import { api, usePoll } from '../api';
import type { AuditEvent, Outcome, Payment, RequestDetail } from '../types';
import {
  Addr,
  Badge,
  Card,
  Empty,
  ErrorNote,
  Time,
  Usdc,
  VerifyButton,
  fmtTime,
  formatBaseUnits,
  shortSig,
} from '../ui';

// ---------------------------------------------------------------- list

export function Requests({ go }: { go: (path: string) => void }) {
  const [status, setStatus] = useState<Outcome | ''>('');
  const list = usePoll(() => api.requests(status || undefined), `requests-${status}`);

  return (
    <Card
      title="All requests"
      aside={
        <label className="inline-field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as Outcome | '')}>
            <option value="">All</option>
            <option value="approved">Approved</option>
            <option value="needs_approval">Needs approval</option>
            <option value="denied">Denied</option>
          </select>
        </label>
      }
    >
      <ErrorNote message={list.error} />
      {list.data && list.data.length === 0 && <Empty>No requests match.</Empty>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th className="right">Amount</th>
                <th>Recipient</th>
                <th>Memo</th>
                <th>Decision</th>
                <th>Onchain</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
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
                  <td className="memo-cell">{r.memo ?? <span className="muted">–</span>}</td>
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
  );
}

// ---------------------------------------------------------------- detail

function describeEvent(e: AuditEvent): { title: string; body?: string; tone: string } {
  const d = e.detail as Record<string, string | null | undefined | { message: string }[]>;
  switch (e.type) {
    case 'request_submitted':
      return {
        title: 'Agent requested payment',
        body: `${formatBaseUnits(String(d.amount))} USDC to ${d.recipient}${d.memo ? ` · “${d.memo}”` : ''}`,
        tone: 'neutral',
      };
    case 'decision_signed': {
      const reasons = Array.isArray(d.reasons) ? d.reasons.map((r) => r.message).join(' ') : '';
      return {
        title: `Signed decision: ${String(d.outcome).replace('_', ' ')} (${String(d.decidedBy)})`,
        body: reasons || undefined,
        tone: String(d.outcome),
      };
    }
    case 'human_resolved':
      return { title: `Human ${d.action === 'approve' ? 'approved' : 'rejected'} the request`, body: `Reviewer: ${String(d.actor)}`, tone: 'neutral' };
    case 'payment_submitted':
      return { title: 'Transaction hash attached', body: String(d.txHash), tone: 'neutral' };
    case 'payment_pending':
      return { title: 'Waiting for the transaction receipt', body: d.detail ? String(d.detail) : undefined, tone: 'pending' };
    case 'payment_confirmed':
      return { title: 'Onchain transfer confirmed', body: `${String(d.detail)} (block ${String(d.blockNumber)})`, tone: 'confirmed' };
    case 'payment_mismatch':
      return { title: 'Onchain transfer does not match', body: d.detail ? String(d.detail) : undefined, tone: 'mismatch' };
    default:
      return { title: e.type, tone: 'neutral' };
  }
}

function Timeline({ events }: { events: AuditEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => {
        const d = describeEvent(e);
        return (
          <li key={e.id} className={`tl tl-${d.tone}`}>
            <div className="tl-title">{d.title}</div>
            {d.body && <div className="tl-body">{d.body}</div>}
            <div className="tl-time muted">{fmtTime(e.at)}</div>
          </li>
        );
      })}
    </ol>
  );
}

function PaymentPanel({ detail, onChange }: { detail: RequestDetail; onChange: () => Promise<void> }) {
  const { request } = detail;
  const payment = request.payment;
  const [tx, setTx] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<Payment>) {
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
    void run(() => api.attachTx(request.id, tx.trim()));
  }

  if (request.status !== 'approved') {
    return <Empty>Only approved requests can be paid, so there is no transaction to trace.</Empty>;
  }

  const form = (
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
        {payment ? 'Replace transaction' : 'Trace transaction'}
      </button>
    </form>
  );

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

          {payment.status !== 'pending' && payment.actualAmountUsdc !== null && (
            <table className="compare">
              <thead>
                <tr>
                  <th />
                  <th>Approved</th>
                  <th>Onchain</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Amount</th>
                  <td>
                    <Usdc value={request.amountUsdc} />
                  </td>
                  <td className={payment.actualAmountUsdc === request.amountUsdc ? '' : 'text-bad'}>
                    <Usdc value={payment.actualAmountUsdc} />
                  </td>
                </tr>
                <tr>
                  <th>Recipient</th>
                  <td>
                    <Addr value={request.recipient} />
                  </td>
                  <td className={payment.actualRecipient?.toLowerCase() === request.recipient.toLowerCase() ? '' : 'text-bad'}>
                    {payment.actualRecipient && <Addr value={payment.actualRecipient} />}
                  </td>
                </tr>
                {detail.mandate?.walletAddress && (
                  <tr>
                    <th>From</th>
                    <td>
                      <Addr value={detail.mandate.walletAddress} />
                    </td>
                    <td className={payment.actualFrom?.toLowerCase() === detail.mandate.walletAddress.toLowerCase() ? '' : 'text-bad'}>
                      {payment.actualFrom && <Addr value={payment.actualFrom} />}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {payment.status === 'pending' && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.recheck(request.id))}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
          )}
        </div>
      )}

      {payment?.status !== 'confirmed' && (
        <>
          {!payment && (
            <p className="muted">
              Send <Usdc value={request.amountUsdc} /> to <Addr value={request.recipient} /> on Base Sepolia, then paste the
              transaction hash. The server fetches the receipt, decodes the USDC <code>Transfer</code> event, and checks amount
              and recipient.
            </p>
          )}
          {form}
        </>
      )}
      <ErrorNote message={error} />
    </div>
  );
}

export function RequestDetailView({ id, go }: { id: string; go: (path: string) => void }) {
  const { data, error, refresh } = usePoll(() => api.request(id), `request-${id}`);

  if (error && !data) {
    return (
      <Card>
        <ErrorNote message={error} />
        <button type="button" className="link" onClick={() => go('/requests')}>
          ← Back to requests
        </button>
      </Card>
    );
  }
  if (!data) return <Card><Empty>Loading…</Empty></Card>;

  const { request, mandate, decisions, events } = data;

  return (
    <div className="stack">
      <button type="button" className="link back" onClick={() => go('/requests')}>
        ← All requests
      </button>

      <Card
        title={`${request.agentId} → ${request.amountUsdc} USDC`}
        aside={<Badge status={request.status} />}
      >
        <dl className="facts facts-wide">
          <div className="full">
            <dt>Recipient</dt>
            <dd>
              <Addr value={request.recipient} full />
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              <Usdc value={request.amountUsdc} /> <span className="muted mono">({request.amount})</span>
            </dd>
          </div>
          <div>
            <dt>Memo</dt>
            <dd>{request.memo ?? <span className="muted">–</span>}</dd>
          </div>
          <div>
            <dt>Requested</dt>
            <dd>{fmtTime(request.createdAt)}</dd>
          </div>
          <div className="full">
            <dt>Request ID</dt>
            <dd className="mono">{request.id}</dd>
          </div>
        </dl>
        {mandate && (
          <p className="muted small">
            Mandate: ≤ {mandate.perPaymentLimitUsdc} per payment, {mandate.dailyLimitUsdc}/day
            {mandate.approvalThresholdUsdc ? `, human approval above ${mandate.approvalThresholdUsdc}` : ''},{' '}
            {mandate.allowedRecipients.length} allowed recipient{mandate.allowedRecipients.length === 1 ? '' : 's'}
            {mandate.active ? '' : ' (paused)'}.
          </p>
        )}
      </Card>

      <div className="two-col">
        <Card title="Onchain payment">
          <PaymentPanel detail={data} onChange={refresh} />
        </Card>

        <Card title="Audit trail">
          <Timeline events={events} />
        </Card>
      </div>

      <Card title="Signed decisions">
        <ul className="decisions">
          {decisions.map((d) => (
            <li key={d.id}>
              <div className="decision-head">
                <Badge status={d.outcome} />
                <span>by {d.decidedBy}</span>
                <Time ms={d.createdAt} />
                <span className="spacer" />
                <VerifyButton decision={d} />
              </div>
              {d.reasons.length > 0 && (
                <ul className="reasons">
                  {d.reasons.map((r) => (
                    <li key={r.code}>{r.message}</li>
                  ))}
                </ul>
              )}
              <details>
                <summary>
                  Typed data &amp; signature <code className="mono muted">{shortSig(d.signature)}</code>
                </summary>
                <pre className="json">{JSON.stringify({ domain: 'Mandate v1 · Base Sepolia (84532)', message: d.message, signature: d.signature, signer: d.signer }, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
