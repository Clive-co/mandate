import { useState, type FormEvent } from 'react';
import { api, usePoll } from '../api';
import type { Decision, SpendRequest } from '../types';
import { Addr, Badge, Card, ErrorNote, VerifyButton } from '../ui';

/** Plays the part of an AI agent: submit a spend request and see the signed decision come back. */
export function Simulator({ go }: { go: (path: string) => void }) {
  const summary = usePoll(api.summary, 'summary-sim', 15000);
  const [agentId, setAgentId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('10');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ request: SpendRequest; decision: Decision } | null>(null);

  const agents = summary.data?.agents ?? [];
  const selected = agents.find((a) => a.agentId === agentId) ?? agents[0];
  const activeAgentId = selected?.agentId ?? '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.submit({ agentId: activeAgentId, recipient: recipient.trim(), amount: amount.trim(), memo: memo.trim() || undefined }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="two-col">
      <Card title="Agent simulator">
        <p className="muted">
          Act as an agent calling <code>POST /requests</code>. The policy engine decides instantly; a request to an unknown
          recipient or above the auto-approval threshold lands in the approvals queue.
        </p>
        <form className="form" onSubmit={(e) => void submit(e)}>
          <label>
            Agent
            <select value={activeAgentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name} ({a.agentId})
                </option>
              ))}
            </select>
          </label>
          <label>
            Recipient address
            <input
              className="mono"
              list="allowed"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              required
            />
            <datalist id="allowed">
              {selected?.allowedRecipients.map((r) => (
                <option key={r} value={r}>
                  allowlisted
                </option>
              ))}
            </datalist>
          </label>
          <div className="form-row">
            <label>
              Amount (USDC)
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
            </label>
            <label className="grow">
              Memo
              <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={280} placeholder="What is this for?" />
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !activeAgentId}>
            {busy ? 'Submitting…' : 'Submit spend request'}
          </button>
          <ErrorNote message={error} />
        </form>
      </Card>

      <Card title="Response">
        {!result && <p className="empty">Submit a request to see the decision the agent would receive.</p>}
        {result && (
          <div className="stack-small">
            <div className="decision-head">
              <Badge status={result.decision.outcome} />
              <span>
                {result.request.amountUsdc} USDC → <Addr value={result.request.recipient} />
              </span>
            </div>
            {result.decision.reasons.length > 0 && (
              <ul className="reasons">
                {result.decision.reasons.map((r) => (
                  <li key={r.code}>{r.message}</li>
                ))}
              </ul>
            )}
            <pre className="json">{JSON.stringify({ message: result.decision.message, signature: result.decision.signature, signer: result.decision.signer }, null, 2)}</pre>
            <div className="decision-head">
              <VerifyButton decision={result.decision} />
              <span className="spacer" />
              <button type="button" className="link" onClick={() => go(`/requests/${result.request.id}`)}>
                Open audit trail →
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
