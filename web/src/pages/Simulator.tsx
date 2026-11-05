import { useState, type FormEvent } from 'react';
import { API_BASE, api, usePoll } from '../api';
import type { Decision, SellerResult } from '../types';
import { Addr, Badge, Card, ErrorNote, shortToken } from '../ui';

interface Attempt {
  n: number;
  result: SellerResult;
  expected: string;
}

/** Plays two roles: the agent asking for permission, and the seller checking the verdict it is handed. */
export function Simulator({ go }: { go: (path: string) => void }) {
  const summary = usePoll(api.summary, 'summary-sim', 15000);
  const [agentId, setAgentId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('10');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);

  const [exp, setExp] = useState({ amount: '', currency: 'USDC', recipient: '' });
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [sellerBusy, setSellerBusy] = useState(false);

  const agents = summary.data?.agents ?? [];
  const selected = agents.find((a) => a.agentId === agentId) ?? agents[0];
  const activeAgentId = selected?.agentId ?? '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api.authorize({
        agentId: activeAgentId,
        recipient: recipient.trim(),
        amount: amount.trim(),
        category: category.trim() || selected?.mandate.categories[0] || 'data',
      });
      setDecision(d);
      setExp({ amount: d.amountUsdc, currency: d.currency, recipient: d.recipient });
      setAttempts([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!decision) return;
    setSellerBusy(true);
    try {
      const result = await api.sellerVerify(decision.token, exp);
      setAttempts((a) => [{ n: a.length + 1, result, expected: `${exp.amount} ${exp.currency} → ${exp.recipient.slice(0, 8)}…` }, ...a]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSellerBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="two-col">
        <Card title="1. Agent asks for permission">
          <p className="muted">
            Act as an agent calling <code>POST /authorize</code>. The policy engine checks the mandate&apos;s limits, categories and expiry,
            and returns allow or deny with a reason, as a signed token.
          </p>
          <form className="form" onSubmit={(e) => void submit(e)}>
            <label>
              Agent
              <select value={activeAgentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.agentId} (mandate v{a.mandate.version}, {a.mandate.status})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Recipient address
              <input className="mono" list="allowed" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" spellCheck={false} required />
              <datalist id="allowed">
                {selected?.mandate.allowedRecipients?.map((r) => (
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
                Category
                <input list="cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={selected?.mandate.categories[0] ?? 'data'} />
                <datalist id="cats">
                  {selected?.mandate.categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </label>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !activeAgentId}>
              {busy ? 'Asking…' : 'Request spend'}
            </button>
            <ErrorNote message={error} />
          </form>
        </Card>

        <Card title="Verdict">
          {!decision && <p className="empty">Submit a request to see the verdict the agent receives.</p>}
          {decision && (
            <div className="stack-small">
              <div className="decision-head">
                <Badge status={decision.verdict} />
                <span>
                  {decision.amountUsdc} USDC → <Addr value={decision.recipient} />
                </span>
              </div>
              <p className={decision.verdict === 'allow' ? 'muted' : 'reason-deny'}>
                {decision.reasonCode ? `${decision.reasonCode}: ` : ''}
                {decision.reason}
              </p>
              <div className="mono token">{shortToken(decision.token)}</div>
              <pre className="json">{JSON.stringify(decision.claims, null, 2)}</pre>
              <div className="decision-head">
                <a href={`${API_BASE}/.well-known/jwks.json`} target="_blank" rel="noreferrer">
                  JWKS ↗
                </a>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => go(`/decisions/${decision.id}`)}>
                  Open the trail →
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {decision && (
        <Card title="2. Seller verifies the verdict" aside={<span className="muted small">Simulated seller with its own nonce store</span>}>
          <p className="muted">
            A seller runs the verifier before delivering anything: signature, expiry, then amount, currency and recipient against what it expects to
            be paid. Click once to accept, click again to see the replay rejected. Edit an expected value to see a mismatch.
          </p>
          <div className="form-row seller-row">
            <label>
              Expected amount (USDC)
              <input value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} inputMode="decimal" />
            </label>
            <label>
              Currency
              <input value={exp.currency} onChange={(e) => setExp({ ...exp, currency: e.target.value })} />
            </label>
            <label className="grow">
              Expected recipient
              <input className="mono" value={exp.recipient} onChange={(e) => setExp({ ...exp, recipient: e.target.value })} spellCheck={false} />
            </label>
            <button type="button" className="btn btn-primary" disabled={sellerBusy} onClick={() => void verify()}>
              {sellerBusy ? 'Verifying…' : 'Verify as seller'}
            </button>
          </div>
          {attempts.length > 0 && (
            <ul className="attempts">
              {attempts.map((a) => (
                <li key={a.n} className={a.result.ok ? 'attempt-ok' : 'attempt-bad'}>
                  <strong>#{a.n}</strong> {a.result.ok ? '✓ Accepted' : `✗ Rejected: ${a.result.code}`}
                  <span className="muted"> {a.result.ok ? '' : a.result.message} · expected {a.expected}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
