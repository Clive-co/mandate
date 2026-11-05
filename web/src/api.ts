import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Decision,
  DecisionDetail,
  Mandate,
  MandateTermsInput,
  Recon,
  SellerResult,
  Summary,
  Verdict,
} from './types';

export const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? res.statusText);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body });

export const api = {
  summary: () => call<Summary>('/summary'),
  decisions: (q: { verdict?: Verdict; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.verdict) p.set('verdict', q.verdict);
    if (q.limit) p.set('limit', String(q.limit));
    return call<Decision[]>(`/decisions${p.size ? `?${p}` : ''}`);
  },
  decision: (id: string) => call<DecisionDetail>(`/decisions/${id}`),
  authorize: (input: { agentId: string; amount: string; recipient: string; category: string }) =>
    post<Decision>('/authorize', { ...input, currency: 'USDC' }),
  attachTx: (id: string, txHash: string) => post<Recon>(`/decisions/${id}/payment`, { txHash }),
  recheck: (id: string) => post<Recon>(`/decisions/${id}/payment/recheck`),

  mandates: () => call<Mandate[]>('/mandates'),
  createMandate: (agentId: string, terms: MandateTermsInput) => post<Mandate>('/mandates', { agentId, ...terms }),
  replaceMandate: (id: string, terms: MandateTermsInput, reason: string) =>
    post<Mandate>(`/mandates/${id}/replace`, { ...terms, reason }),
  revokeMandate: (id: string, reason: string) => post<Mandate>(`/mandates/${id}/revoke`, { reason }),

  /** The demo seller: runs the real verifier with its own nonce store. */
  sellerVerify: (token: string, expected: { amount: string; currency: string; recipient: string }) =>
    post<SellerResult>('/demo/seller/verify', { token, expected }),
};

/** Fetch on mount, on `key` change, and every `ms`. `refresh()` forces an immediate reload. */
export function usePoll<T>(fn: () => Promise<T>, key: string, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [refresh, key, ms]);

  return { data, error, refresh };
}
