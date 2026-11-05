import type { ReactNode } from 'react';
import type { MandateStatus, ReconStatus, Verdict } from './types';

const LABELS: Record<Verdict | ReconStatus | MandateStatus, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  pending: 'Pending',
  matched: 'Matched',
  mismatch: 'Mismatch',
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  replaced: 'Replaced',
};

export function Badge({ status }: { status: Verdict | ReconStatus | MandateStatus }) {
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

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  const abs = Math.abs(s);
  const text =
    abs < 45 ? 'a few seconds' : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} d`;
  if (abs < 45) return s >= 0 ? 'just now' : 'in a moment';
  return s >= 0 ? `${text} ago` : `in ${text}`;
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleString();

export function Time({ ms }: { ms: number }) {
  return (
    <time dateTime={new Date(ms).toISOString()} title={fmtTime(ms)}>
      {timeAgo(ms)}
    </time>
  );
}

/** Exact USDC base units -> decimal string, without floating point ("12500000" -> "12.5"). */
export function formatBaseUnits(raw: string): string {
  const padded = raw.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const frac = padded.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
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

/** Decodes a JWT payload for DISPLAY ONLY. This does not verify anything: that is the seller's job. */
export function decodeJwtPart(token: string, part: 0 | 1): Record<string, unknown> | null {
  try {
    const b64 = token.split('.')[part]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function shortToken(token: string): string {
  return `${token.slice(0, 18)}…${token.slice(-10)}`;
}
