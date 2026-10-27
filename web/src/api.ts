import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Decision,
  Outcome,
  Payment,
  RequestDetail,
  SpendRequest,
  Summary,
  WireDecision,
} from './types';

const BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? res.statusText, e.details);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body });

export const api = {
  summary: () => call<Summary>('/summary'),
  requests: (status?: Outcome) => call<SpendRequest[]>(`/requests${status ? `?status=${status}` : ''}`),
  request: (id: string) => call<RequestDetail>(`/requests/${id}`),
  decisions: () => call<Decision[]>('/decisions'),
  submit: (input: { agentId: string; recipient: string; amount: string; memo?: string }) =>
    post<{ request: SpendRequest; decision: Decision }>('/requests', input),
  resolve: (id: string, action: 'approve' | 'reject', actor: string) =>
    post<{ request: SpendRequest; decision: Decision }>(`/requests/${id}/resolve`, { action, actor }),
  attachTx: (id: string, txHash: string) => post<Payment>(`/requests/${id}/payment`, { txHash }),
  recheck: (id: string) => post<Payment>(`/requests/${id}/payment/recheck`),
  verify: (message: WireDecision, signature: string) =>
    post<{ valid: boolean; signer: string }>('/verify', { message, signature }),
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
