// Veilance web — fake DApp Connector wallet for testing without Lace.
//
// Installed as `window.midnight.veilanceDev` when `VITE_DEV_WALLET=1`,
// implementing the same verified `@midnight-ntwrk/dapp-connector-api` v4.0.1
// surface (`InitialAPI`/`ConnectedAPI`) that a real wallet does — the rest
// of the app (dappConnector.ts, wallet.ts) cannot tell it apart from a real
// one. It forwards `balanceUnsealedTransaction` to the agent's dev-only
// `POST /wallet/dev-balance-submit` (`VEILANCE_DEV_WALLET=1`), which
// balances using that party's own real headless agent wallet. Everything
// else in the round trip (job parked in `awaiting_wallet`, the browser
// polling and posting to `POST /jobs/:id/wallet-result`, the agent
// resolving `delegatedWallet.ts`'s pending request and submitting for real)
// is identical to the real-Lace path — see docs/WALLET.md.
//
// One limitation, called out in docs/WALLET.md: the DApp Connector's
// `InitialAPI.connect(networkId)` has no notion of "which party" — a real
// wallet doesn't either, the agent learns that from `POST /wallet/session`'s
// body. This fake wallet's *identity* (its coin/encryption public keys),
// though, has to come from SOME party's real headless wallet, so
// `setDevWalletParty` (called by `wallet.ts`'s `connect()` right before
// connecting, only for this wallet id) picks which one — see that file.
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { getApi } from '@/api/client';
import type { PartyName } from '@/api/types';

export const DEV_WALLET_ID = 'veilanceDev';

let devParty: PartyName = 'mine';
export function setDevWalletParty(party: PartyName): void {
  devParty = party;
}

function agentBaseUrl(): string {
  const base = getApi().baseUrl;
  if (!base) throw new Error('devWallet requires VITE_API_URL (the mock has nothing for it to talk to)');
  return base;
}

async function agentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(agentBaseUrl() + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function unsupported(method: string): never {
  throw new Error(`veilanceDev does not implement ${method} (not needed for the delegated-wallet round trip)`);
}

function buildConnectedApi(networkId: string): ConnectedAPI {
  return {
    async getShieldedBalances() {
      return {};
    },
    async getUnshieldedBalances() {
      return {};
    },
    async getDustBalance() {
      return { cap: 0n, balance: 0n };
    },
    async getShieldedAddresses() {
      const identity = await agentFetch<{ coinPublicKey: string; encryptionPublicKey: string }>(
        `/wallet/dev-identity/${devParty}`,
      );
      return {
        shieldedAddress: identity.coinPublicKey,
        shieldedCoinPublicKey: identity.coinPublicKey,
        shieldedEncryptionPublicKey: identity.encryptionPublicKey,
      };
    },
    async getUnshieldedAddress() {
      const identity = await agentFetch<{ unshieldedAddress: string }>(`/wallet/dev-identity/${devParty}`);
      return { unshieldedAddress: identity.unshieldedAddress };
    },
    async getDustAddress() {
      return { dustAddress: '' };
    },
    async getTxHistory() {
      return [];
    },
    async balanceUnsealedTransaction(tx: string) {
      const result = await agentFetch<{ tx: string }>('/wallet/dev-balance-submit', {
        method: 'POST',
        body: JSON.stringify({ party: devParty, txHex: tx }),
      });
      return { tx: result.tx };
    },
    async balanceSealedTransaction() {
      return unsupported('balanceSealedTransaction');
    },
    async makeTransfer() {
      return unsupported('makeTransfer');
    },
    async makeIntent() {
      return unsupported('makeIntent');
    },
    async signData() {
      return unsupported('signData');
    },
    async submitTransaction() {
      // Not used by the delegated flow (the agent always submits — see
      // delegatedWallet.ts) but implemented as a real no-op rather than
      // `unsupported()` since a correctly-behaving connector's
      // `submitTransaction` genuinely returns nothing to wait for.
    },
    async getProvingProvider() {
      return unsupported('getProvingProvider');
    },
    async getConfiguration() {
      return { indexerUri: '', indexerWsUri: '', substrateNodeUri: '', networkId };
    },
    async getConnectionStatus() {
      return { status: 'connected', networkId };
    },
    async hintUsage() {
      /* no permissions model to hint to */
    },
  };
}

/** Installs `window.midnight.veilanceDev` if not already present. Call once at app startup when `VITE_DEV_WALLET=1`. */
export function installDevWallet(): void {
  if (typeof window === 'undefined') return;
  window.midnight = window.midnight ?? {};
  if (window.midnight[DEV_WALLET_ID]) return;
  const api: InitialAPI = {
    rdns: 'network.midnight.veilance.dev-wallet',
    name: 'Veilance Dev Wallet',
    icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"%3E%3Crect width="16" height="16" rx="3" fill="%23f2b544"/%3E%3C/svg%3E',
    apiVersion: '4.0.1',
    connect: async (networkId: string) => buildConnectedApi(networkId),
  };
  window.midnight[DEV_WALLET_ID] = api;
}
