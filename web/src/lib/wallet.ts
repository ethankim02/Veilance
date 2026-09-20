// Veilance web — wallet connection state (agent/API.md "Delegated wallet"
// v1.4 addendum). One browser tab connects at most one wallet at a time,
// delegated to at most one organisation at a time ("Per-party choice" in the
// task: a single select, not a multi-party session list) — other
// organisations keep using the agent's own wallet regardless.
//
// The live `ConnectedAPI` object is kept OUTSIDE React state (it is not
// something a component should ever re-render on, and holding it in state
// would make it eligible for structural-equality checks it was never meant
// for) — `useWalletState()` exposes only the serializable parts a component
// needs to render, and `getConnectedApi()` is for the one place that needs
// the live object: JobRing's "awaiting_wallet" handling.
import { useSyncExternalStore } from 'react';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { getApi } from '@/api/client';
import { t } from '@/lib/i18n';
import type { PartyName } from '@/api/types';
import {
  balanceThroughWallet,
  connectWallet as connectorConnect,
  discoverWallets,
  NetworkMismatchError,
  readWalletIdentity,
  type DiscoveredWallet,
} from './dappConnector';
import { DEV_WALLET_ID, setDevWalletParty } from './devWallet';

export interface WalletUiState {
  discovered: DiscoveredWallet[];
  status: 'idle' | 'connecting' | 'connected' | 'error';
  walletName: string | null;
  party: PartyName | null;
  unshieldedAddress: string | null;
  networkId: string | null;
  error: string | null;
}

let state: WalletUiState = {
  discovered: [],
  status: 'idle',
  walletName: null,
  party: null,
  unshieldedAddress: null,
  networkId: null,
  error: null,
};
let connectedApi: ConnectedAPI | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const set = (patch: Partial<WalletUiState>) => {
  state = { ...state, ...patch };
  emit();
};

export function useWalletState(): WalletUiState {
  return useSyncExternalStore(subscribe, () => state);
}

/** `window.midnight` is only populated once an extension has injected itself — call after mount, and again if the user asks ("no wallets found, try again"). */
export function refreshDiscoveredWallets(): void {
  set({ discovered: discoverWallets() });
}

/**
 * Connects `walletId` (a key from `discoverWallets()`), hinting/validating
 * `agentNetworkId`, reads its identity, registers it with the agent as
 * delegated for `party` (`POST /wallet/session`), and keeps the live
 * `ConnectedAPI` for JobRing to use. Throws nothing — errors land in
 * `state.error` for the popover to render (UX_V3: max one sentence).
 */
export async function connect(walletId: string, party: PartyName, agentNetworkId: string): Promise<void> {
  const wallet = state.discovered.find((w) => w.id === walletId);
  if (!wallet) {
    set({ status: 'error', error: t('Wallet not found — try refreshing') });
    return;
  }
  set({ status: 'connecting', error: null });
  // The dev wallet's identity is one specific party's real headless agent
  // wallet (see devWallet.ts's doc comment) — a real wallet has no such
  // concept, so this only ever applies to `DEV_WALLET_ID`.
  if (walletId === DEV_WALLET_ID) setDevWalletParty(party);
  try {
    const api = await connectorConnect(wallet, agentNetworkId);
    const identity = await readWalletIdentity(api);
    const session = await getApi().connectWallet({
      party,
      networkId: agentNetworkId,
      coinPublicKey: identity.coinPublicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
      unshieldedAddress: identity.unshieldedAddress,
    });
    connectedApi = api;
    set({
      status: 'connected',
      walletName: wallet.name,
      party: session.party,
      unshieldedAddress: session.unshieldedAddress,
      networkId: session.networkId,
      error: null,
    });
  } catch (err) {
    connectedApi = null;
    const message =
      err instanceof NetworkMismatchError
        ? t('Wallet is on network "{wallet}" — this agent is on "{agent}"', {
            wallet: err.walletNetworkId,
            agent: err.agentNetworkId,
          })
        : err instanceof Error
          ? err.message
          : t('Could not connect to wallet');
    set({ status: 'error', error: message, party: null });
  }
}

export async function disconnect(): Promise<void> {
  const party = state.party;
  connectedApi = null;
  set({ status: 'idle', walletName: null, party: null, unshieldedAddress: null, networkId: null, error: null });
  if (party) {
    try {
      await getApi().disconnectWallet(party);
    } catch {
      /* the session may already be gone (agent restarted) — nothing more to do client-side */
    }
  }
}

/** For JobRing: the live connector, only when connected. */
export function getConnectedApi(): ConnectedAPI | null {
  return state.status === 'connected' ? connectedApi : null;
}

/** For JobRing: which party this browser's connected wallet currently pays for. */
export function getDelegatedParty(): PartyName | null {
  return state.status === 'connected' ? state.party : null;
}

/** Balances `txHex` through the currently connected wallet. Throws if none is connected — callers must check `getDelegatedParty()` first. */
export async function balanceViaConnectedWallet(txHex: string): Promise<string> {
  if (!connectedApi) throw new Error('no wallet connected');
  return balanceThroughWallet(connectedApi, txHex);
}
