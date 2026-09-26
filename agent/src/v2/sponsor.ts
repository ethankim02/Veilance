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
import * as Rx from "rxjs";
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
import fs from "node:fs";
import { SPONSOR_DAILY_LIMIT, SPONSOR_SEED, SPONSOR_TOKENS, V2_STATE_DIR } from "./config.js";

export const sponsorState: { ready: boolean; step: string; error?: string; balanced: number } = {
  ready: false,
  step: "starting",
  balanced: 0,
};

let wallet: Wallet | null = null;
let identity: { coinPublicKey: string; encryptionPublicKey: string } | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let latest: any = null;

// One wallet, one DUST pool: balance strictly one transaction at a time so two
// requests never pick the same DUST coin.
let chain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a restored checkpoint may sit without progress before it is abandoned. */
const STALL_MS = Number(process.env.VEILANCE_SPONSOR_STALL_MINUTES ?? "10") * 60_000;

/**
 * Resolves when sync progress has not moved for STALL_MS — only for a wallet
 * restored from a checkpoint (a fresh sync that stalls is a network problem,
 * not a bad checkpoint, and restarting it would only lose progress).
 */
const stalled = async (restored: boolean): Promise<void> => {
  if (!restored) return new Promise(() => {});
  let mark = "";
  let since = Date.now();
  for (;;) {
    await sleep(30_000);
    const st = latest;
    const now = st ? `${st.shielded?.state?.progress?.appliedIndex}/${st.dust?.state?.progress?.appliedIndex}/${st.unshielded?.progress?.appliedIndex}` : "";
    if (st?.isSynced) return new Promise(() => {});
    if (now !== mark) {
      mark = now;
      since = Date.now();
    } else if (Date.now() - since > STALL_MS) {
      return;
    }
  }
};

export const bootSponsor = async (): Promise<void> => {
  try {
    if (!SPONSOR_SEED) throw new Error("VEILANCE_SPONSOR_SEED is required outside the local devnet");
    if (SPONSOR_TOKENS.size === 0) throw new Error("VEILANCE_SPONSOR_TOKENS or VEILANCE_SPONSOR_TOKEN is required outside the local devnet");
    sponsorState.step = "waiting for devnet health";
    for (;;) {
      const h = await checkDevnetHealth();
      if (h.allHealthy) break;
      await sleep(3_000);
    }
    setNetworkId(NETWORK_ID);

    const stateDir = path.join(V2_STATE_DIR, "sponsor-wallet");
    let synced: Awaited<ReturnType<typeof waitForSync>> | null = null;
    for (let attempt = 0; synced === null; attempt++) {
      const restored = fs.existsSync(path.join(stateDir, "sponsor.dust.json"));
      sponsorState.step = restored ? "building the fee wallet from its checkpoint" : "building the fee wallet (fresh sync)";
      wallet = await buildWallet("sponsor", SPONSOR_SEED, { stateDir });
      const sub = wallet.facade.state().pipe(Rx.throttleTime(2_000, undefined, { leading: true, trailing: true })).subscribe((st) => (latest = st));
      sponsorState.step = "syncing the fee wallet";
      const outcome = await Promise.race([
        waitForSync(wallet).then((st) => ({ kind: "synced" as const, st })),
        stalled(restored).then(() => ({ kind: "stalled" as const })),
      ]);
      if (outcome.kind === "synced") {
        synced = outcome.st;
        break;
      }
      // A checkpoint that cannot be synced forward (e.g. "event with a
      // timestamp prior to the time already synced to") never recovers by
      // itself: set it aside and sync from scratch.
      sub.unsubscribe();
      await wallet.facade.stop().catch(() => undefined);
      const aside = `${stateDir}.stalled-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.renameSync(stateDir, aside);
      console.warn(`Sponsor wallet checkpoint made no progress for ${STALL_MS / 60_000} min; moved to ${aside}, resyncing from scratch (attempt ${attempt + 2}).`);
    }
    if (!synced || !wallet) throw new Error("unreachable");
    const w: Wallet = wallet;
    const night = synced.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
    if (night < FUNDING_AMOUNT / 2n) {
      if (!IS_LOCAL_DEVNET) throw new Error(`sponsor wallet holds ${night} NIGHT; fund it from the network faucet first`);
      sponsorState.step = "funding the fee wallet from genesis";
      const funder = await buildWallet("sponsor-funder", FUNDER_SEED, { stateDir: path.join(V2_STATE_DIR, "funder-wallet") });
      await waitForSync(funder);
      await fundFromGenesis(funder, [w]);
    }
    sponsorState.step = "ensuring DUST";
    await ensureDust(w);

    const provider = await asMidnightJsProvider(w);
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

/** Which node a request comes from, by its bearer token; undefined = reject. */
const nodeOf = (header: string | undefined): string | undefined => {
  const token = header?.replace(/^Bearer\s+/i, "");
  return token ? SPONSOR_TOKENS.get(token) : undefined;
};

// Per-node, per-UTC-day count of balanced transactions, persisted so a
// restart does not reset anyone's quota.
const usagePath = () => path.join(V2_STATE_DIR, "sponsor-usage.json");
type Usage = { day: string; byNode: Record<string, number> };
const today = () => new Date().toISOString().slice(0, 10);
const loadUsage = (): Usage => {
  try {
    const u = JSON.parse(fs.readFileSync(usagePath(), "utf8")) as Usage;
    return u.day === today() ? u : { day: today(), byNode: {} };
  } catch {
    return { day: today(), byNode: {} };
  }
};
let usage = loadUsage();
const withinQuota = (node: string) => {
  if (usage.day !== today()) usage = { day: today(), byNode: {} };
  return SPONSOR_DAILY_LIMIT <= 0 || (usage.byNode[node] ?? 0) < SPONSOR_DAILY_LIMIT;
};
const countUse = (node: string) => {
  usage.byNode[node] = (usage.byNode[node] ?? 0) + 1;
  try {
    fs.mkdirSync(path.dirname(usagePath()), { recursive: true });
    fs.writeFileSync(usagePath(), JSON.stringify(usage));
  } catch {
    /* quota bookkeeping must never block fees */
  }
};

export const mountSponsor = (app: Hono): void => {
  // Never waits for sync (a first sync on a public network can take hours):
  // reports the latest state the subscription in bootSponsor cached.
  app.get("/sponsor/health", (c) => {
    const st = latest;
    const quota = { day: usage.day, dailyLimit: SPONSOR_DAILY_LIMIT, byNode: usage.byNode };
    if (!st) return c.json({ ...sponsorState, quota });
    const prog = (p: { appliedIndex?: bigint; highestIndex?: bigint } | undefined) =>
      p ? `${p.appliedIndex ?? "?"}/${p.highestIndex ?? "?"}` : "?";
    return c.json({
      ...sponsorState,
      synced: st.isSynced,
      progress: {
        shielded: prog(st.shielded.state.progress),
        dust: prog(st.dust.state.progress),
        unshielded: prog(st.unshielded.progress),
      },
      dust: { balance: st.dust.balance(new Date()).toString(), coins: st.dust.availableCoins.length },
      quota,
    });
  });

  app.get("/sponsor/identity", (c) => {
    if (!identity) return c.json({ error: "sponsor not ready", code: "not_ready", step: sponsorState.step }, 503);
    return c.json({ ...identity, networkId: NETWORK_ID });
  });

  app.post("/sponsor/balance", async (c) => {
    const node = nodeOf(c.req.header("authorization"));
    if (!node) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
    if (!withinQuota(node)) return c.json({ error: `daily sponsorship limit of ${SPONSOR_DAILY_LIMIT} reached for node "${node}"`, code: "quota_exceeded" }, 429);
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
      countUse(node);
      return c.json({ txHex: toHex(finalized.serialize()) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), code: "balance_failed" }, 502);
    }
  });

  // Submission goes through the fee wallet too, so a transaction the node
  // rejects releases the DUST it booked (revertTransaction) instead of leaving
  // it locked until the TTL runs out.
  app.post("/sponsor/submit", async (c) => {
    if (!nodeOf(c.req.header("authorization"))) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
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
