// Veilance B-2 — fee sponsor (operator side).
//
// Owns one fee wallet. Exposes:
//   GET  /sponsor/identity  — the wallet's public coin/encryption keys, which a
//                             node needs to build a call (the v2 contract sends
//                             no coins, so these keys carry no value to anyone)
//   POST /sponsor/balance   — takes a proven-but-unbalanced transaction, adds
//                             and signs the DUST fee inputs, returns it sealed.
// It never receives a party secret or a witness: proving happened on the node,
// and a proven transaction cannot be altered without invalidating the proof.
//   POST /sponsor/submit    — submits the sealed transaction through the same
//                             wallet, reverting its DUST booking on failure.

import * as ledger from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import path from "node:path";
import { inspect } from "node:util";
import type { Hono } from "hono";

import { checkDevnetHealth } from "../../../contract/e2e/lib/health.js";
import {
  asMidnightJsProvider,
  balanceUnboundTransaction,
  buildWallet,
  ensureDust,
  fundFromGenesis,
  waitForSync,
  type Wallet,
} from "../../../contract/e2e/lib/wallet.js";
import { FUNDER_SEED, IS_LOCAL_DEVNET, NETWORK_ID, FUNDING_AMOUNT } from "../../../contract/e2e/lib/config.js";
import { fromHex, toHex } from "../bytes.js";
import { SPONSOR_SEED, SPONSOR_TOKEN, V2_STATE_DIR } from "./config.js";

export const sponsorState: { ready: boolean; step: string; error?: string; balanced: number } = {
  ready: false,
  step: "starting",
  balanced: 0,
};

let wallet: Wallet | null = null;
let identity: { coinPublicKey: string; encryptionPublicKey: string } | null = null;

// One wallet, one DUST pool: balance strictly one transaction at a time so two
// requests never pick the same DUST coin.
let chain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const bootSponsor = async (): Promise<void> => {
  try {
    if (!SPONSOR_SEED) throw new Error("VEILANCE_SPONSOR_SEED is required outside the local devnet");
    if (!SPONSOR_TOKEN) throw new Error("VEILANCE_SPONSOR_TOKEN is required outside the local devnet");
    sponsorState.step = "waiting for devnet health";
    for (;;) {
      const h = await checkDevnetHealth();
      if (h.allHealthy) break;
      await sleep(3_000);
    }
    setNetworkId(NETWORK_ID);

    sponsorState.step = "building the fee wallet";
    const stateDir = path.join(V2_STATE_DIR, "sponsor-wallet");
    wallet = await buildWallet("sponsor", SPONSOR_SEED, { stateDir });
    sponsorState.step = "syncing the fee wallet";
    const synced = await waitForSync(wallet);
    const night = synced.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
    if (night < FUNDING_AMOUNT / 2n) {
      if (!IS_LOCAL_DEVNET) throw new Error(`sponsor wallet holds ${night} NIGHT; fund it from the network faucet first`);
      sponsorState.step = "funding the fee wallet from genesis";
      const funder = await buildWallet("sponsor-funder", FUNDER_SEED, { stateDir: path.join(V2_STATE_DIR, "funder-wallet") });
      await waitForSync(funder);
      await fundFromGenesis(funder, [wallet]);
    }
    sponsorState.step = "ensuring DUST";
    await ensureDust(wallet);

    const provider = await asMidnightJsProvider(wallet);
    identity = { coinPublicKey: provider.getCoinPublicKey(), encryptionPublicKey: provider.getEncryptionPublicKey() };
    sponsorState.ready = true;
    sponsorState.step = "ready";
    console.log("Sponsor ready.");
  } catch (err) {
    sponsorState.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    sponsorState.step = "boot failed";
    console.error("Sponsor boot failed:", sponsorState.error);
  }
};

const authorized = (header: string | undefined) => header === `Bearer ${SPONSOR_TOKEN}`;

export const mountSponsor = (app: Hono): void => {
  app.get("/sponsor/health", async (c) => {
    if (!wallet) return c.json(sponsorState);
    const st = await wallet.facade.waitForSyncedState();
    return c.json({
      ...sponsorState,
      dust: { balance: st.dust.balance(new Date()).toString(), coins: st.dust.availableCoins.length },
    });
  });

  app.get("/sponsor/identity", (c) => {
    if (!identity) return c.json({ error: "sponsor not ready", code: "not_ready", step: sponsorState.step }, 503);
    return c.json({ ...identity, networkId: NETWORK_ID });
  });

  app.post("/sponsor/balance", async (c) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
    if (!wallet) return c.json({ error: "sponsor not ready", code: "not_ready" }, 503);
    const body = await c.req.json<{ txHex?: string }>().catch(() => ({}) as { txHex?: string });
    if (typeof body.txHex !== "string") return c.json({ error: "txHex is required", code: "bad_request" }, 400);
    let unbound: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;
    try {
      unbound = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>(
        "signature",
        "proof",
        "pre-binding",
        fromHex(body.txHex),
      );
    } catch (err) {
      return c.json({ error: `could not deserialize txHex: ${err instanceof Error ? err.message : String(err)}`, code: "bad_request" }, 400);
    }
    try {
      const finalized = await serialized(() => balanceUnboundTransaction(wallet!, unbound));
      sponsorState.balanced += 1;
      return c.json({ txHex: toHex(finalized.serialize()) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), code: "balance_failed" }, 502);
    }
  });

  // Submission goes through the fee wallet too, so a transaction the node
  // rejects releases the DUST it booked (revertTransaction) instead of leaving
  // it locked until the TTL runs out.
  app.post("/sponsor/submit", async (c) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
    if (!wallet) return c.json({ error: "sponsor not ready", code: "not_ready" }, 503);
    const body = await c.req.json<{ txHex?: string }>().catch(() => ({}) as { txHex?: string });
    if (typeof body.txHex !== "string") return c.json({ error: "txHex is required", code: "bad_request" }, 400);
    let tx: ledger.FinalizedTransaction;
    try {
      tx = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>("signature", "proof", "binding", fromHex(body.txHex));
    } catch (err) {
      return c.json({ error: `could not deserialize txHex: ${err instanceof Error ? err.message : String(err)}`, code: "bad_request" }, 400);
    }
    try {
      const txId = await serialized(() => wallet!.facade.submitTransaction(tx));
      return c.json({ txId });
    } catch (err) {
      await wallet.facade.revertTransaction(tx).catch(() => undefined);
      // SDK submission errors wrap the node's reason several levels deep.
      const detail = inspect(err, { depth: 8, breakLength: Infinity }).replace(/\s+at .*$/gm, "").slice(0, 4000);
      console.error("sponsor submit failed:", detail);
      return c.json({ error: detail, code: "submit_failed" }, 502);
    }
  });
};
