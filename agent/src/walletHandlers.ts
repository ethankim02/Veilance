// Veilance Party Agent — delegated wallet HTTP handlers (v1.4 addendum,
// agent/API.md). Route wiring lives in routes.ts; this module holds the
// logic so routes.ts stays a thin dispatch table, matching the existing
// split (ledgerRead.ts, graph.ts, explorer.ts).

import * as ledger from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

import { appState } from "./appState.js";
import { fromHex, toHex } from "./bytes.js";
import { HOSTED_PARTIES, NETWORK_ID, type PartyName } from "./config.js";
import { waitForSync } from "../../contract/e2e/lib/wallet.js";
import {
  clearWalletSession,
  getWalletSession,
  listWalletSessions,
  resolveJobWalletRequest,
  setWalletSession,
} from "./delegatedWallet.js";
import { getJob } from "./jobs.js";
import { balanceUnboundTransaction } from "../../contract/e2e/lib/wallet.js";
import type { WalletSession } from "./types.js";

// ---------------------------------------------------------------------------
// POST /wallet/session · GET /wallet/session · DELETE /wallet/session/:party
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /wallet/session`. Named `coinPublicKey` /
 * `encryptionPublicKey` to match every other hex field this API uses, but —
 * deliberately, not by API constraint — carries the DApp Connector's native
 * Bech32m encoding (`getShieldedAddresses()`'s `shieldedCoinPublicKey` /
 * `shieldedEncryptionPublicKey`, and `getUnshieldedAddress()`'s
 * `unshieldedAddress`), not raw hex. Decoding Bech32m needs
 * `@midnight-ntwrk/wallet-sdk-address-format`, which itself depends on
 * `@midnight-ntwrk/ledger-v8` (a WASM package) — pulling that into the
 * browser bundle just to decode three strings the agent can decode itself
 * (it already depends on both) would mean adding vite-plugin-wasm /
 * vite-plugin-top-level-await / node polyfills to `web/` for no other
 * reason. See docs/WALLET.md's "verified facts" section.
 */
export type WalletSessionBody = {
  readonly party: string;
  readonly networkId: string;
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
  readonly unshieldedAddress: string;
};

export type WalletSessionError = { readonly message: string; readonly code: string };

const isSessionBody = (body: unknown): body is WalletSessionBody =>
  !!body &&
  typeof body === "object" &&
  typeof (body as WalletSessionBody).party === "string" &&
  typeof (body as WalletSessionBody).networkId === "string" &&
  typeof (body as WalletSessionBody).coinPublicKey === "string" &&
  typeof (body as WalletSessionBody).encryptionPublicKey === "string" &&
  typeof (body as WalletSessionBody).unshieldedAddress === "string";

/**
 * `party` is checked against `HOSTED_PARTIES` (the static config), not
 * `appState.parties` (only populated once bootstrap finishes) — a wallet
 * can be connected for a party this process is configured to host even
 * while it is still booting; the browser will just see `awaiting_wallet`
 * jobs once one is actually started.
 */
export const createWalletSession = (
  body: unknown,
): { ok: true; session: WalletSession } | { ok: false; error: WalletSessionError } => {
  if (!isSessionBody(body)) {
    return { ok: false, error: { message: "party, networkId, coinPublicKey, encryptionPublicKey and unshieldedAddress are required", code: "bad_request" } };
  }
  if (!(HOSTED_PARTIES as readonly string[]).includes(body.party)) {
    return { ok: false, error: { message: `this agent does not host party "${body.party}"`, code: "unknown_party" } };
  }
  if (body.networkId !== NETWORK_ID) {
    return {
      ok: false,
      error: { message: `wallet is on network "${body.networkId}", this agent is on "${NETWORK_ID}"`, code: "network_mismatch" },
    };
  }

  let coinPublicKey: string;
  let encryptionPublicKey: string;
  try {
    coinPublicKey = ShieldedCoinPublicKey.codec.decode(NETWORK_ID as never, MidnightBech32m.parse(body.coinPublicKey)).toHexString();
    encryptionPublicKey = ShieldedEncryptionPublicKey.codec
      .decode(NETWORK_ID as never, MidnightBech32m.parse(body.encryptionPublicKey))
      .toHexString();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { message: `could not decode wallet keys: ${message}`, code: "bad_request" } };
  }

  const session: WalletSession = {
    party: body.party as PartyName,
    networkId: body.networkId,
    coinPublicKey,
    encryptionPublicKey,
    unshieldedAddress: body.unshieldedAddress,
    connectedAt: new Date().toISOString(),
  };
  setWalletSession(session);
  return { ok: true, session };
};

export const removeWalletSession = (party: string): boolean => clearWalletSession(party as PartyName);

export const listSessions = (): WalletSession[] => listWalletSessions();

// ---------------------------------------------------------------------------
// POST /jobs/:id/wallet-result
// ---------------------------------------------------------------------------

export type WalletResultBody = { readonly requestId: string } & (
  | { readonly txHash: string }
  | { readonly balancedTxHex: string }
  | { readonly error: string }
);

const isWalletResultBody = (body: unknown): body is WalletResultBody =>
  !!body &&
  typeof body === "object" &&
  typeof (body as WalletResultBody).requestId === "string" &&
  ("balancedTxHex" in (body as object) || "txHash" in (body as object) || "error" in (body as object));

export type WalletResultOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string };

/**
 * `jobId` is only used to (a) 404 on an unknown job and (b) double-check the
 * job is actually the one that issued `requestId` (its `walletRequest.id`) —
 * the actual resolution is keyed purely by `requestId` in
 * delegatedWallet.ts's registry, since that is what `balanceTx` is really
 * waiting on. Design note (see delegatedWallet.ts's module doc): only
 * `balancedTxHex` is meaningful today — the agent always submits the
 * balanced tx itself, so a browser that instead reports `txHash` (having
 * called the connector's `submitTransaction` itself) is treated as a
 * client-side implementation this API does not (yet) support, distinct from
 * an outright bad request.
 */
export const submitWalletResult = (jobId: string, body: unknown): WalletResultOutcome => {
  const job = getJob(jobId);
  if (!job) return { status: "not_found", message: "job not found" };
  if (!isWalletResultBody(body)) {
    return { status: "bad_request", message: "requestId and exactly one of balancedTxHex/txHash/error are required" };
  }
  if (job.stage !== "awaiting_wallet" || job.walletRequest?.id !== body.requestId) {
    return { status: "not_found", message: "no matching pending wallet request for this job" };
  }
  if ("txHash" in body) {
    return {
      status: "bad_request",
      message: "this agent always submits the balanced transaction itself (see docs/WALLET.md) — post balancedTxHex, not txHash",
    };
  }

  const payload = "error" in body ? { error: body.error } : { balancedTxHex: body.balancedTxHex };
  const handled = resolveJobWalletRequest(body.requestId, payload);
  if (!handled) return { status: "not_found", message: "wallet request already resolved or timed out" };
  return { status: "accepted" };
};

// ---------------------------------------------------------------------------
// POST /wallet/dev-balance-submit (dev-only, VEILANCE_DEV_WALLET=1)
// ---------------------------------------------------------------------------

export type DevBalanceSubmitBody = { readonly party: string; readonly txHex: string };

/**
 * Stands in for a real browser wallet's `balanceUnsealedTransaction`: takes
 * the SAME hex the delegated provider parked on the job and balances it
 * using `party`'s own headless agent wallet (via
 * `contract/e2e/lib/wallet.ts`'s `balanceUnboundTransaction` — the exact
 * function `asMidnightJsProvider`'s non-delegated `balanceTx` also calls),
 * returning `{ tx: hex }` in the same shape the real connector's
 * `balanceUnsealedTransaction` would. `web/src/lib/devWallet.ts`'s fake
 * `window.midnight.veilanceDev` is the only caller — see docs/WALLET.md.
 * This does NOT itself touch the job or the wallet-request registry: the
 * fake connector in the browser still posts the result to
 * `POST /jobs/:id/wallet-result` exactly like a real wallet would, so the
 * round trip this exercises is identical to the real one except for who
 * signs.
 */
export const devBalanceSubmit = async (
  body: unknown,
): Promise<{ ok: true; tx: string } | { ok: false; error: { message: string; code: string } }> => {
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as DevBalanceSubmitBody).party !== "string" ||
    typeof (body as DevBalanceSubmitBody).txHex !== "string"
  ) {
    return { ok: false, error: { message: "party and txHex are required", code: "bad_request" } };
  }
  const { party, txHex } = body as DevBalanceSubmitBody;
  if (!(HOSTED_PARTIES as readonly string[]).includes(party)) {
    return { ok: false, error: { message: `this agent does not host party "${party}"`, code: "unknown_party" } };
  }
  const appParty = appState.partyOrThrow(party as PartyName);

  let unbound: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;
  try {
    unbound = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>(
      "signature",
      "proof",
      "pre-binding",
      fromHex(txHex),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { message: `could not deserialize txHex: ${message}`, code: "bad_request" } };
  }

  if (!appParty.party.wallet) return { ok: false, error: { message: "dev wallet needs an agent wallet (VEILANCE_AGENT_WALLET=1)", code: "bad_request" } };
  const finalized = await balanceUnboundTransaction(appParty.party.wallet, unbound);
  return { ok: true, tx: toHex(finalized.serialize()) };
};

// ---------------------------------------------------------------------------
// GET /wallet/dev-identity/:party (dev-only, VEILANCE_DEV_WALLET=1)
// ---------------------------------------------------------------------------

/**
 * Bech32m-encoded identity for `party`'s own headless agent wallet — exactly
 * the shape a real connector's `getShieldedAddresses()` /
 * `getUnshieldedAddress()` return, so `web/src/lib/devWallet.ts`'s fake
 * `window.midnight.veilanceDev` can hand it straight to
 * `POST /wallet/session` without the agent's dev endpoints and the browser
 * needing to agree on any different encoding. This is the ONLY dev-wallet
 * endpoint that reads keys rather than acting on a transaction — it exists
 * purely so the dev round trip does not need a second, hex-based identity
 * format just for itself.
 */
export const devIdentity = async (
  party: string,
): Promise<
  | { ok: true; coinPublicKey: string; encryptionPublicKey: string; unshieldedAddress: string; networkId: string }
  | { ok: false; error: { message: string; code: string } }
> => {
  if (!(HOSTED_PARTIES as readonly string[]).includes(party)) {
    return { ok: false, error: { message: `this agent does not host party "${party}"`, code: "unknown_party" } };
  }
  const appParty = appState.partyOrThrow(party as PartyName);
  if (!appParty.party.wallet) return { ok: false, error: { message: "dev wallet needs an agent wallet (VEILANCE_AGENT_WALLET=1)", code: "bad_request" } };
  const state = await waitForSync(appParty.party.wallet);
  const coinPublicKey = ShieldedCoinPublicKey.codec.encode(NETWORK_ID as never, state.shielded.coinPublicKey).asString();
  const encryptionPublicKey = ShieldedEncryptionPublicKey.codec
    .encode(NETWORK_ID as never, state.shielded.encryptionPublicKey)
    .asString();
  const addr = await appParty.party.wallet.facade.unshielded.getAddress();
  const unshieldedAddress = UnshieldedAddress.codec.encode(NETWORK_ID as never, addr).asString();
  return { ok: true, coinPublicKey, encryptionPublicKey, unshieldedAddress, networkId: NETWORK_ID };
};
