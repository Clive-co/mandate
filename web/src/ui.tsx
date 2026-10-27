import { useState, type ReactNode } from 'react';
import { api } from './api';
import type { Decision, Outcome, PaymentStatus } from './types';

const LABELS: Record<Outcome | PaymentStatus, string> = {
  approved: 'Approved',
  denied: 'Denied',
  needs_approval: 'Needs approval',
  pending: 'Pending',
  confirmed: 'Confirmed',
  mismatch: 'Mismatch',
};

export function Badge({ status }: { status: Outcome | PaymentStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}

export function Addr({ value, full = false }: { value: string; full?: boolean }) {
  const text = full || value.length < 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
  return (
    <code className="mono addr" title={value}>
      {text}
    </code>
  );
}

export function Usdc({ value }: { value: string }) {
  return (
    <span className="num">
      {value} <span className="unit">USDC</span>
    </span>
  );
}

/** Exact USDC base units -> decimal string, without floating point ("12500000" -> "12.5"). */
export function formatBaseUnits(raw: string): string {
  const padded = raw.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const frac = padded.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleString();

export function Time({ ms }: { ms: number }) {
  return (
    <time dateTime={new Date(ms).toISOString()} title={fmtTime(ms)}>
      {timeAgo(ms)}
    </time>
  );
}

export function Card({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title && (
        <header className="card-head">
          <h2>{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Calls the server's /verify and shows whether the signature checks out. */
export function VerifyButton({ decision }: { decision: Decision }) {
  const [state, setState] = useState<'idle' | 'busy' | 'valid' | 'invalid' | 'error'>('idle');

  async function run() {
    setState('busy');
    try {
      const r = await api.verify(decision.message, decision.signature);
      setState(r.valid ? 'valid' : 'invalid');
    } catch {
      setState('error');
    }
  }

  if (state === 'valid') return <span className="verify verify-ok">✓ Signature valid</span>;
  if (state === 'invalid') return <span className="verify verify-bad">✗ Invalid</span>;
  if (state === 'error') return <span className="verify verify-bad">Could not verify</span>;
  return (
    <button type="button" className="btn btn-small" onClick={() => void run()} disabled={state === 'busy'}>
      {state === 'busy' ? 'Verifying…' : 'Verify signature'}
    </button>
  );
}

export function shortSig(sig: string): string {
  return `${sig.slice(0, 10)}…${sig.slice(-6)}`;
}
