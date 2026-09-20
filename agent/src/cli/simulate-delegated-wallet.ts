// Veilance Party Agent — delegated-wallet round-trip simulation (no
// devnet, no proof server, no real wallet — see docs/WALLET.md's "what was
// and wasn't exercised" section).
//
// Exercises the REAL agent-side machinery end to end except for one
// boundary that genuinely cannot be reached without a running proof server:
// a `Transaction<SignatureEnabled, Proof, Binding>` requires an actual ZK
// proof, so nothing offline can produce valid bytes for it. Everything else
// is real, not mocked:
//   - a real Job, created and driven through jobs.ts's actual sequential
//     `enqueueJob`/`drain()` queue (not called directly — this is the only
//     way `delegatedWallet.ts`'s `getActiveJob()` correctly resolves to it,
//     exactly as it does for a genuine circuit call);
//   - a real wallet session, via `delegatedWallet.ts`'s own session map
//     (`setWalletSession`) — not a fake substitute;
//   - a real `createDelegatedWalletProvider(...).balanceTx(...)` call,
//     given a stub "unbound transaction" (an object shaped like one, since
//     building a genuine `UnboundTransaction` needs a real circuit call —
//     see the module doc comment) — this is the "stubbed midnight-js call"
//     the task's verification scope asked for: midnight-js-contracts itself
//     is never invoked, but everything on the agent's side of the boundary
//     midnight-js would normally call through is real;
//   - a real `resolveJobWalletRequest`, simulating what
//     `POST /jobs/:id/wallet-result`'s route handler does when the browser
//     posts back — this script plays "the browser" by reading
//     `job.walletRequest.txHex` off the real parked job, exactly as
//     `useDelegatedWalletHandoff` (web/src/components/JobRing.tsx) does.
//
// Usage: `AGENT_STATE_DIR=/tmp/veilance-sim npx tsx src/cli/simulate-delegated-wallet.ts`
// (an isolated AGENT_STATE_DIR is required — this writes real job-history
// JSON files, and must never touch a real deployment's `.state`).

import assert from "node:assert/strict";
import path from "node:path";

if (!process.env.AGENT_STATE_DIR) {
  console.error("Refusing to run without AGENT_STATE_DIR set to a throwaway directory (this writes job-history files).");
  process.exit(1);
}

const { appState } = await import("../appState.js");
const { enqueueJob, getJob } = await import("../jobs.js");
const { createDelegatedWalletProvider, setWalletSession, resolveJobWalletRequest, clearWalletSession } = await import(
  "../delegatedWallet.js"
);
const { toHex } = await import("../bytes.js");
const stateModule = await import("../state.js");

type FakeAppParty = Parameters<typeof appState.parties.set>[1];

const PARTY = "mine" as const;

// A minimal PartyAgentFile — real shape (see types.ts), just empty. Job
// persistence (jobs.ts's persistJob -> state.ts's upsertJob) writes this to
// AGENT_STATE_DIR/mine/agent.json for real, which is why AGENT_STATE_DIR
// must be a throwaway directory.
const file = stateModule.loadOrCreatePartyFile(PARTY, "00".repeat(32));
appState.parties.set(PARTY, {
  name: PARTY,
  // Nothing in this simulation touches `.party` (no real circuit call is
  // made — see the module doc comment), only `.file` — a real `Party`
  // (wallet + midnight-js providers) is deliberately not constructed.
  party: {} as FakeAppParty["party"],
  file,
});

// A stub "fallback" WalletProvider & MidnightProvider — stands in for the
// agent's own headless wallet (`asMidnightJsProvider`), only reached when
// no session is connected. Asserted never to be called in the "session
// active" case below.
let fallbackCalled = false;
const fallback = {
  getCoinPublicKey: () => "fallback-cpk",
  getEncryptionPublicKey: () => "fallback-epk",
  balanceTx: async () => {
    fallbackCalled = true;
    throw new Error("fallback.balanceTx should not be called while a wallet session is active");
  },
  submitTx: async () => {
    fallbackCalled = true;
    return "fallback-tx-id";
  },
} as Parameters<typeof createDelegatedWalletProvider>[1];

const fakeUnboundTxBytes = Buffer.from("simulated-unbound-transaction-bytes");
// Only `.serialize()` is real here — a genuine `UnboundTransaction` needs a
// real circuit call (proof server), which this offline simulation does not
// have. See the module doc comment.
const fakeUnboundTx = { serialize: () => fakeUnboundTxBytes } as unknown as Parameters<
  ReturnType<typeof createDelegatedWalletProvider>["balanceTx"]
>[0];

async function main() {
  console.log(`AGENT_STATE_DIR = ${process.env.AGENT_STATE_DIR}`);

  // --- Case 1: no wallet session -> falls straight back to the agent's own wallet ---
  {
    const provider = createDelegatedWalletProvider(PARTY, fallback);
    assert.equal(provider.getCoinPublicKey(), "fallback-cpk");
    assert.equal(provider.getEncryptionPublicKey(), "fallback-epk");
    fallbackCalled = false;
    await assert.rejects(provider.balanceTx(fakeUnboundTx, undefined), /fallback\.balanceTx should not be called/);
    assert.equal(fallbackCalled, true, "fallback.balanceTx should have been reached with no session connected");
    console.log("case 1 (no session -> fallback): OK");
  }

  // --- Case 2: wallet session active -> parks on the job, "browser" resolves it ---
  setWalletSession({
    party: PARTY,
    networkId: "undeployed",
    coinPublicKey: "sim-coin-public-key",
    encryptionPublicKey: "sim-encryption-public-key",
    unshieldedAddress: "mn_addr_undeployed1simulated",
    connectedAt: new Date().toISOString(),
  });

  const provider = createDelegatedWalletProvider(PARTY, fallback);
  let sawAwaitingWallet = false;
  let observedTxHex: string | undefined;

  const job = enqueueJob(PARTY, "issueProvenance", async (ctx) => {
    ctx.setStage("proving");
    // Real call — midnight-js-contracts would call exactly this, with a
    // real UnboundTransaction. `fakeUnboundTx` only stubs `.serialize()`.
    await provider.balanceTx(fakeUnboundTx, undefined);
    // Not reached in this simulation: deserializing the "browser"'s
    // (fake) balanced hex into a real ledger Transaction always throws —
    // see the module doc comment. A genuine executor would continue on to
    // `contract.callTx`'s own `submitTx` call here.
    return {};
  });

  // Poll for the job to reach `awaiting_wallet`, exactly like
  // web/src/components/JobRing.tsx's `useDelegatedWalletHandoff` does via
  // `GET /jobs/:id` — here it's `getJob` directly, same data.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = getJob(job.id);
    if (current?.stage === "awaiting_wallet" && current.walletRequest) {
      sawAwaitingWallet = true;
      observedTxHex = current.walletRequest.txHex;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(sawAwaitingWallet, true, "job should have reached awaiting_wallet");
  assert.equal(observedTxHex, toHex(fakeUnboundTxBytes), "walletRequest.txHex should be the serialized unbound tx, hex-encoded");
  console.log("case 2a (session active -> job parks in awaiting_wallet with the right txHex): OK");

  const requestId = getJob(job.id)!.walletRequest!.id;
  // "The browser": post back a balanced tx. Real bytes are unreachable
  // offline (see module doc comment) — this deliberately uses bytes that
  // are NOT a valid ledger Transaction, so the one real-ledger-bytes step
  // this simulation cannot cross fails in an EXPECTED, RECOGNIZABLE way
  // (a deserialize error), not silently or as a timeout.
  const handled = resolveJobWalletRequest(requestId, { balancedTxHex: "deadbeef" });
  assert.equal(handled, true, "resolveJobWalletRequest should find the pending request");
  console.log("case 2b (resolveJobWalletRequest accepts the browser's response): OK");

  // Wait for the job to finish (jobs.ts's drain() catches the deserialize
  // throw and marks it failed).
  const finishDeadline = Date.now() + 5_000;
  let finished = getJob(job.id)!;
  while (finished.stage !== "failed" && finished.stage !== "confirmed" && finished.stage !== "rejected" && Date.now() < finishDeadline) {
    await new Promise((r) => setTimeout(r, 5));
    finished = getJob(job.id)!;
  }
  assert.equal(finished.stage, "failed", `expected "failed" (deserialize error on fake bytes), got "${finished.stage}"`);
  assert.notEqual(finished.error, "wallet did not respond", "should fail on deserialize, not on the 5-minute timeout");
  assert.equal(finished.walletRequest, undefined, "walletRequest should be cleared once the job leaves awaiting_wallet");
  console.log(`case 2c (job ends "failed" on the one boundary this simulation cannot cross — real ledger bytes): OK`);
  console.log(`  -> error was: ${finished.error}`);

  clearWalletSession(PARTY);
  console.log("\nAll simulated cases passed. See docs/WALLET.md for exactly what this does and does not verify.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
