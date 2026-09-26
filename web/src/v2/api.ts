// Veilance v2 web — client for the v2 node (agent/API_V2.md).
// The API key lives in sessionStorage only: closing the tab signs out.

export const V2_URL = (import.meta.env.VITE_V2_URL as string | undefined) ?? 'http://localhost:4100';

const KEY = 'veilance-v2-key';
export const getKey = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const setKey = (key: string | null) => {
  try {
    if (key) sessionStorage.setItem(KEY, key);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage is optional */
  }
};

export class V2Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function v2<T>(method: string, path: string, body?: unknown, key: string | null = getKey()): Promise<T> {
  const res = await fetch(`${V2_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new V2Error(json.error ?? `HTTP ${res.status}`, res.status, json.code);
  return json;
}

export type Health = { ready: boolean; step: string; contractAddress?: string; error?: string };

export type Profile = {
  id: string;
  name: string;
  role: 'admin' | 'company';
  partyId: string;
  certId: string;
  deployed: boolean;
  supplier: boolean;
  recycler: 'eu' | 'other' | null;
  receivingKey: boolean;
};

export type Job = {
  id: string;
  op: string;
  stage: 'queued' | 'proving' | 'confirmed' | 'rejected' | 'failed';
  createdAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  txHash?: string;
  blockHeight?: number;
  result?: Record<string, unknown>;
  error?: string;
};

export type LotView = {
  id: string;
  commitment: string;
  status: 'ACTIVE' | 'CONSUMED';
  source: string;
  material: string;
  quantityKg: number;
  recycledEuKg: number;
  recycledOtherKg: number;
  carbonClass: number;
  custody: string;
  origins: { origin: string; issuer: string }[];
  memo?: string;
  createdAt: string;
  consumedAt?: string;
};

export type AccountView = {
  id: string;
  plant: string;
  period: number;
  material: string;
  status: 'OPEN' | 'DECLARED';
  totalKg: number;
  recycledEuKg: number;
  recycledOtherKg: number;
  maxDeclarableBps: number;
  declaredBps?: number;
};

export type DirectoryEntry = { name: string; partyId: string };
export type TenantCreated = { id: string; partyId: string; certId: string; apiKey: string; registerJob?: Job };
export type AuditorPackage = { owner: string; plant: string; period: number; material: string; totalKg: number; salt: string };
export type DeclarationCheck = { declared: boolean; shareBps?: number; totalCommit?: string; totalMatches?: boolean };
export type AttestationCheck = { attested: boolean; policyVersion?: string; currentPolicyVersion?: string; fresh?: boolean };

export const isDone = (j?: Job) => !!j && ['confirmed', 'rejected', 'failed'].includes(j.stage);

export const kg = (n: number) => (n >= 1000 && n % 100 === 0 ? `${(n / 1000).toLocaleString()} t` : `${n.toLocaleString()} kg`);
export const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
export const short = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
