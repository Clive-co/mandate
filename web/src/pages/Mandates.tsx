import { useMemo, useState, type FormEvent } from 'react';
import { api, usePoll } from '../api';
import type { Mandate, MandateTermsInput } from '../types';
import { Addr, Badge, Card, Empty, ErrorNote, fmtTime } from '../ui';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 16);

interface FormState {
  agentId: string;
  perTxLimit: string;
  dailyLimit: string;
  categories: string;
  recipients: string;
  payer: string;
  expiresAt: string;
  reason: string;
}

const blank = (agentId = ''): FormState => ({
  agentId,
  perTxLimit: '50',
  dailyLimit: '100',
  categories: 'cloud, data',
  recipients: '',
  payer: '',
  expiresAt: inDays(30),
  reason: '',
});

const fromMandate = (m: Mandate): FormState => ({
  agentId: m.agentId,
  perTxLimit: m.perTxLimitUsdc,
  dailyLimit: m.dailyLimitUsdc,
  categories: m.categories.join(', '),
  recipients: (m.allowedRecipients ?? []).join('\n'),
  payer: m.payerAddress ?? '',
  expiresAt: inDays(30),
  reason: '',
});

function toTerms(f: FormState): MandateTermsInput {
  const list = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  const recipients = list(f.recipients, /[\s,]+/);
  return {
    perTxLimit: f.perTxLimit.trim(),
    dailyLimit: f.dailyLimit.trim(),
    categories: list(f.categories, /,/),
    allowedRecipients: recipients.length ? recipients : null,
    payerAddress: f.payer.trim() || null,
    expiresAt: new Date(f.expiresAt).toISOString(),
  };
}

function TermsForm({
  value,
  onChange,
  mode,
  busy,
  onSubmit,
  onCancel,
}: {
  value: FormState;
  onChange: (f: FormState) => void;
  mode: 'create' | 'replace';
  busy: boolean;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit();
  }
  return (
    <form className="form" onSubmit={submit}>
      {mode === 'create' && (
        <label>
          Agent id
          <input value={value.agentId} onChange={set('agentId')} placeholder="research-bot" required />
        </label>
      )}
      <div className="form-row">
        <label className="grow">
          Per-transaction limit (USDC)
          <input value={value.perTxLimit} onChange={set('perTxLimit')} inputMode="decimal" required />
        </label>
        <label className="grow">
          Daily limit (USDC)
          <input value={value.dailyLimit} onChange={set('dailyLimit')} inputMode="decimal" required />
        </label>
      </div>
      <label>
        Categories (comma separated)
        <input value={value.categories} onChange={set('categories')} required />
      </label>
      <label>
        Allowed recipients (one per line; empty = any recipient)
        <textarea className="mono" rows={3} value={value.recipients} onChange={set('recipients')} spellCheck={false} />
      </label>
      <div className="form-row">
        <label className="grow">
          Payer wallet (optional, enables the sender check)
          <input className="mono" value={value.payer} onChange={set('payer')} placeholder="0x…" spellCheck={false} />
        </label>
        <label>
          Expires
          <input type="datetime-local" value={value.expiresAt} onChange={set('expiresAt')} required />
        </label>
      </div>
      {mode === 'replace' && (
        <label>
          Reason for replacing
          <input value={value.reason} onChange={set('reason')} placeholder="e.g. raise the daily limit" required />
        </label>
      )}
      <div className="form-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {mode === 'create' ? 'Create mandate' : 'Revoke and replace'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function MandateRow({ m, current, onChanged }: { m: Mandate; current: boolean; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<'view' | 'replace' | 'revoke'>('view');
  const [form, setForm] = useState<FormState>(() => fromMandate(m));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode('view');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canChange = current && m.status !== 'revoked' && m.status !== 'replaced';

  return (
    <li className={`mandate${current ? '' : ' mandate-old'}`}>
      <div className="mandate-head">
        <strong>v{m.version}</strong>
        <Badge status={m.status} />
        <span className="muted small">created {fmtTime(m.createdAt)}</span>
        <span className="spacer" />
        {canChange && mode === 'view' && (
          <>
            <button type="button" className="btn btn-small" onClick={() => setMode('replace')}>
              Replace
            </button>
            <button type="button" className="btn btn-small" onClick={() => setMode('revoke')}>
              Revoke
            </button>
          </>
        )}
      </div>
      <dl className="facts facts-wide">
        <div>
          <dt>Per transaction</dt>
          <dd className="num">≤ {m.perTxLimitUsdc} USDC</dd>
        </div>
        <div>
          <dt>Daily</dt>
          <dd className="num">≤ {m.dailyLimitUsdc} USDC</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{fmtTime(m.expiresAt)}</dd>
        </div>
        <div>
          <dt>Categories</dt>
          <dd>{m.categories.join(', ')}</dd>
        </div>
        <div className="full">
          <dt>Recipients</dt>
          <dd>
            {m.allowedRecipients ? (
              <span className="addr-list">
                {m.allowedRecipients.map((a) => (
                  <Addr key={a} value={a} />
                ))}
              </span>
            ) : (
              <span className="muted">any</span>
            )}
          </dd>
        </div>
      </dl>
      {m.revokedAt && (
        <p className="muted small">
          {m.status === 'replaced' ? 'Replaced' : 'Revoked'} {fmtTime(m.revokedAt)}: {m.revokeReason}
        </p>
      )}

      {mode === 'revoke' && (
        <form
          className="tx-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.revokeMandate(m.id, reason));
          }}
        >
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required). Revoking blocks all new spend." required />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Confirm revoke
          </button>
          <button type="button" className="btn" onClick={() => setMode('view')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'replace' && (
        <TermsForm
          mode="replace"
          value={form}
          onChange={setForm}
          busy={busy}
          onCancel={() => setMode('view')}
          onSubmit={() => void run(() => api.replaceMandate(m.id, toTerms(form), form.reason))}
        />
      )}
      <ErrorNote message={error} />
    </li>
  );
}

export function Mandates() {
  const list = usePoll(api.mandates, 'mandates', 8000);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(() => blank());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byAgent = useMemo(() => {
    const groups = new Map<string, Mandate[]>();
    for (const m of list.data ?? []) groups.set(m.agentId, [...(groups.get(m.agentId) ?? []), m]);
    for (const g of groups.values()) g.sort((a, b) => b.version - a.version);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.createMandate(form.agentId.trim(), toTerms(form));
      setCreating(false);
      setForm(blank());
      await list.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <ErrorNote message={list.error} />
      <Card
        title="Mandates"
        aside={
          !creating && (
            <button type="button" className="btn btn-primary btn-small" onClick={() => setCreating(true)}>
              New mandate
            </button>
          )
        }
      >
        <p className="muted small log-note">
          Mandates are immutable. To change one, revoke and replace it: the old version stays on record and a new version takes over.
        </p>
        {creating && (
          <div className="mandate-new">
            <TermsForm mode="create" value={form} onChange={setForm} busy={busy} onSubmit={() => void create()} onCancel={() => setCreating(false)} />
            <ErrorNote message={error} />
          </div>
        )}
        {list.data && list.data.length === 0 && !creating && <Empty>No mandates yet.</Empty>}
      </Card>

      {byAgent.map(([agentId, versions]) => (
        <Card key={agentId} title={agentId}>
          <ul className="mandates">
            {versions.map((m, i) => (
              <MandateRow key={m.id} m={m} current={i === 0} onChanged={list.refresh} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
