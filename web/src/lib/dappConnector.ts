// Veilance web — DApp Connector API v4.0.1 helpers (agent/API.md "Delegated
// wallet" v1.4 addendum; see docs/WALLET.md for the verified facts and
// sources this is built against).
//
// Deliberately thin: everything here is either a plain pass-through to
// `window.midnight[<id>]` or a tiny bit of glue. In particular, nothing here
// decodes the connector's Bech32m-encoded keys/addresses — those go to the
// agent as-is (`POST /wallet/session`) and the agent decodes them, so this
// file (and the rest of `web/`) never needs `@midnight-ntwrk/ledger-v8` or
// `wallet-sdk-address-format` — both WASM-touching packages that would
// otherwise pull vite-plugin-wasm / vite-plugin-top-level-await / node
// polyfills into the browser bundle just for this.
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';

export type DiscoveredWallet = {
  /** The key under `window.midnight` (e.g. `"mnLace"`) — NOT the same as `rdns`. */
  id: string;
  rdns: string;
  name: string;
  icon: string;
  apiVersion: string;
  api: InitialAPI;
};

/** `window.midnight` wallets found right now. Static — a DApp Connector wallet injects itself once at page load, so this is a snapshot, not a subscription. */
export function discoverWallets(): DiscoveredWallet[] {
  const midnight = typeof window !== 'undefined' ? window.midnight : undefined;
  if (!midnight) return [];
  return Object.entries(midnight)
    .filter((entry): entry is [string, InitialAPI] => !!entry[1] && typeof entry[1].connect === 'function')
    .map(([id, api]) => ({ id, rdns: api.rdns, name: api.name, icon: api.icon, apiVersion: api.apiVersion, api }));
}

export class NetworkMismatchError extends Error {
  constructor(
    readonly walletNetworkId: string,
    readonly agentNetworkId: string,
  ) {
    super(`Wallet is on "${walletNetworkId}", this agent is on "${agentNetworkId}"`);
  }
}

/**
 * Connects to `wallet`, hinting `agentNetworkId`, then double-checks the
 * connection actually landed on that network via `getConfiguration()` — the
 * DApp Connector's `connect(networkId)` takes the id only as a *hint*
 * (verified against `api.d.ts`'s doc comment: "hinting desired network id"),
 * so a wallet that ignores it must still be caught here rather than trusted.
 */
export async function connectWallet(wallet: DiscoveredWallet, agentNetworkId: string): Promise<ConnectedAPI> {
  const api = await wallet.api.connect(agentNetworkId);
  const config = await api.getConfiguration();
  if (config.networkId !== agentNetworkId) {
    throw new NetworkMismatchError(config.networkId, agentNetworkId);
  }
  return api;
}

/**
 * The three values `POST /wallet/session` needs from a connected wallet, all
 * still Bech32m-encoded (see the module doc comment — the agent decodes
 * them). Two separate connector calls (`getShieldedAddresses` +
 * `getUnshieldedAddress`), matching the verified API surface: there is no
 * single call that returns both.
 */
export async function readWalletIdentity(
  api: ConnectedAPI,
): Promise<{ coinPublicKey: string; encryptionPublicKey: string; unshieldedAddress: string }> {
  const [shielded, unshielded] = await Promise.all([api.getShieldedAddresses(), api.getUnshieldedAddress()]);
  return {
    coinPublicKey: shielded.shieldedCoinPublicKey,
    encryptionPublicKey: shielded.shieldedEncryptionPublicKey,
    unshieldedAddress: unshielded.unshieldedAddress,
  };
}

/**
 * Balances a parked job's proven-but-unbalanced transaction through the
 * connected wallet. Returns the balanced-and-sealed transaction hex, ready
 * to post back to `POST /jobs/:id/wallet-result` — see delegatedWallet.ts's
 * module doc comment for why the agent submits it, not the browser.
 */
export async function balanceThroughWallet(api: ConnectedAPI, txHex: string): Promise<string> {
  const { tx } = await api.balanceUnsealedTransaction(txHex);
  return tx;
}
