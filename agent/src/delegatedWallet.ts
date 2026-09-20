// Veilance Party Agent — delegated wallet (v1.4 addendum, agent/API.md).
//
// Proving and all witness secrets stay in the agent (nothing here changes
// that — see contractSetup.ts / bootstrap.ts: the compiled contract, ZK
// assets and every witness stay exactly where they were). Only fee
// balancing + submission move to a connected browser wallet, when one is
// connected for a party.
//
// This file implements the `WalletProvider & MidnightProvider` pair
// bootstrap.ts installs per hosted party, wrapping that party's own
// agent-owned pair (from `contract/e2e/lib/wallet.ts`'s `asMidnightJsProvider`,
// the `fallback` parameter below) so every call transparently falls back to
// the agent's own headless wallet whenever no browser wallet is connected —
// nothing about the non-delegated path changes.
//
// --- Why `balanceTx` parks on the job instead of calling the wallet directly ---
// `balanceTx` runs deep inside `@midnight-ntwrk/midnight-js-contracts`'s
// `callTx`/`deployContract` machinery, with no HTTP request in scope — it
// cannot itself make a round trip to a browser. Instead it:
//   1. serializes the proven-but-unbalanced transaction it was given,
//   2. parks it on the job currently being worked (jobs.ts's sequential
//      queue guarantees there is exactly one, `getActiveJob()`),
//   3. awaits a promise that `POST /jobs/:id/wallet-result` resolves once
//      the browser has called the connector and posted the result back.
// See docs/WALLET.md for the full round trip and the verified DApp
// Connector facts this is built on.
//
// --- Why `submitTx` does NOT branch on whether a wallet is connected ---
// The verified `@midnight-ntwrk/dapp-connector-api` v4.0.1 surface has TWO
// ways a balanced transaction could reach the network:
//   - `submitTransaction(tx: string): Promise<void>` — the wallet submits,
//     but reports back nothing (not even a transaction id).
//   - the agent submits the balanced tx itself through its own node
//     connection (any hosted party's `WalletFacade.submitTransaction` is a
//     dumb relay of already-signed-and-bound bytes to the node — see
//     docs/WALLET.md's open risks for the one part of this that is NOT
//     independently verified: whether the node accepts a transaction a
//     different wallet balanced/signed, submitted through an unrelated
//     wallet's facade).
// Since `submitTransaction` can't hand back a `job.txHash`, this agent
// always takes the second path — which means `submitTx` never needs session
// state at all: it is always the SAME fallback used for the fully-agent-owned
// path.
import { randomUUID } from "node:crypto";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import type { MidnightProvider, UnboundTransaction, WalletProvider } from "@midnight-ntwrk/midnight-js-types";

import { fromHex, toHex } from "./bytes.js";
import { beginAwaitingWallet, clearJobWalletRequest, getActiveJob, setSubmitting } from "./jobs.js";
import { parkWalletRequest, resolveWalletRequest, type WalletResultPayload, type WalletSuccessPayload } from "./walletRequests.js";
import type { PartyName, WalletSession } from "./types.js";

const sessions = new Map<PartyName, WalletSession>();

export const setWalletSession = (session: WalletSession): void => {
  sessions.set(session.party, session);
};

export const clearWalletSession = (party: PartyName): boolean => sessions.delete(party);

export const getWalletSession = (party: PartyName): WalletSession | undefined => sessions.get(party);

export const listWalletSessions = (): WalletSession[] => Array.from(sessions.values());

/**
 * Deserializes a hex-encoded `Transaction<SignatureEnabled, Proof, Binding>`
 * (what `balanceUnsealedTransaction`'s `{ tx }` result decodes to, per the
 * DApp Connector's own doc comment — verified against
 * `@midnight-ntwrk/dapp-connector-api` 4.0.1's `api.d.ts`, see docs/WALLET.md).
 * The literal marker strings ("signature"/"proof"/"binding"), not property
 * access on a class, are the documented calling convention for this generic
 * — see `contract/e2e/lib/wallet.ts`'s `signTransactionIntents`, which
 * already does the same thing for `Intent.deserialize` elsewhere in this
 * codebase.
 */
const deserializeFinalizedTx = (hex: string): ledger.FinalizedTransaction =>
  ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>(
    "signature",
    "proof",
    "binding",
    fromHex(hex),
  );

/**
 * Builds the `WalletProvider & MidnightProvider` pair for `party`, dispatching
 * to a connected browser wallet's delegated flow when one is connected, and
 * to `fallback` (this party's own agent-owned wallet, from
 * `asMidnightJsProvider`) otherwise. Installed once per hosted party at boot
 * (bootstrap.ts) — connecting/disconnecting a wallet only changes what
 * `sessions` returns, never which provider object `contract.callTx` holds.
 */
export const createDelegatedWalletProvider = (
  party: PartyName,
  fallback: WalletProvider & MidnightProvider,
): WalletProvider & MidnightProvider => ({
  getCoinPublicKey: () => getWalletSession(party)?.coinPublicKey ?? fallback.getCoinPublicKey(),
  getEncryptionPublicKey: () => getWalletSession(party)?.encryptionPublicKey ?? fallback.getEncryptionPublicKey(),

  balanceTx: async (tx: UnboundTransaction, ttl?: Date) => {
    const session = getWalletSession(party);
    if (!session) return fallback.balanceTx(tx, ttl);

    const job = getActiveJob();
    if (!job) {
      // Should not happen: balanceTx only runs from inside a job executor
      // (jobs.ts's drain loop sets `currentJob` before calling it), and the
      // queue is strictly sequential — but fail loudly rather than silently
      // dropping the wallet request if this invariant is ever violated.
      throw new Error(`delegatedWallet: balanceTx called for "${party}" with no active job to attach the wallet request to`);
    }

    const requestId = randomUUID();
    const txHex = toHex(tx.serialize());
    beginAwaitingWallet(job, { id: requestId, kind: "balance-and-submit", txHex, networkId: session.networkId });

    let payload: WalletSuccessPayload;
    try {
      payload = await parkWalletRequest(requestId);
    } catch (err) {
      clearJobWalletRequest(job);
      throw err;
    }
    clearJobWalletRequest(job);
    setSubmitting(job);
    return deserializeFinalizedTx(payload.balancedTxHex);
  },

  // See the module doc comment: submission is never delegated, so this never
  // needs to look at `sessions` at all.
  submitTx: (tx) => fallback.submitTx(tx),
});

/**
 * `POST /jobs/:id/wallet-result`'s handler calls this — it does not need
 * `jobId` itself (the pending request is keyed by `requestId`, which is
 * unique across the whole process, not just within one job) but the route
 * validates the two agree before calling in, so a stale/mistargeted result
 * can't be posted against the wrong job. Returns `false` if `requestId`
 * was not pending (already resolved, or timed out) — the route turns that
 * into 404/409, not a 500.
 */
export const resolveJobWalletRequest = (requestId: string, payload: WalletResultPayload): boolean =>
  resolveWalletRequest(requestId, payload);
