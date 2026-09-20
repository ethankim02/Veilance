import type { VeilanceApi, WalletResultInput } from './client';
import { ApiError, type Challenge, type PartyName, type WalletSessionInput } from './types';

export function createHttpApi(baseUrl: string): VeilanceApi {
  const base = baseUrl.replace(/\/$/, '');

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
    } catch (e) {
      throw new ApiError(`Agent unreachable at ${base}`, 'NETWORK', 0);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const b = body as { error?: string; code?: string } | null;
      throw new ApiError(b?.error ?? `HTTP ${res.status}`, b?.code ?? `HTTP_${res.status}`, res.status);
    }
    return body as T;
  }
  const post = <T,>(path: string, body?: unknown) =>
    req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    mode: 'http',
    baseUrl: base,
    health: () => req('/health'),
    parties: () => req('/parties'),
    ledger: () => req('/ledger'),
    policy: () => req('/ledger/policy'),
    job: (id) => req(`/jobs/${encodeURIComponent(id)}`),
    jobs: (party?: PartyName) => req(party ? `/jobs?party=${party}` : '/jobs'),
    addOrigin: (input) => post('/admin/origins', input),
    addSupplier: (input) => post('/admin/suppliers', input),
    setCarbonThreshold: (threshold) => post('/admin/carbon-threshold', { threshold }),
    registerEncKey: (party) => post(`/parties/${party}/enc-key`),
    credentials: (party) => req(`/parties/${party}/credentials`),
    scan: (party) => post(`/parties/${party}/scan`),
    issue: (party, input) => post(`/parties/${party}/issue`, input),
    transfer: (party, id, input) => post(`/parties/${party}/credentials/${encodeURIComponent(id)}/transfer`, input),
    attest: (party, id, input) => post(`/parties/${party}/credentials/${encodeURIComponent(id)}/attest`, input),
    createChallenge: (input) => post('/verify/challenges', input),
    challenges: () => req('/verify/challenges'),
    openRequests: async (holder) => {
      const list = await req<Challenge[]>(`/verify/challenges?holder=${holder}&open=true`);
      return list
        .filter((c) => c.holder === holder)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    verify: (challenge, holder, profile) =>
      req(`/verify/${encodeURIComponent(challenge)}?holder=${holder}&profile=${profile}`),
    graph: (viewer = 'batteryMfr') => req(`/graph?viewer=${viewer}`),
    explorerTip: () => req('/explorer/tip'),
    explorerBlock: (height) => req(`/explorer/block/${height}`),
    explorerTx: (hash) => req(`/explorer/tx/${encodeURIComponent(hash)}`),
    explorerContract: () => req('/explorer/contract'),
    explorerLedgerRaw: () => req('/explorer/ledger-raw'),
    walletSessions: () => req('/wallet/session'),
    connectWallet: (input: WalletSessionInput) => post('/wallet/session', input),
    disconnectWallet: (party) => req(`/wallet/session/${party}`, { method: 'DELETE' }).then(() => undefined),
    postWalletResult: (jobId, input: WalletResultInput) => post(`/jobs/${encodeURIComponent(jobId)}/wallet-result`, input).then(() => undefined),
  };
}
