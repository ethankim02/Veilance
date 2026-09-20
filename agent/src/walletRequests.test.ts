// Unit tests for the delegated-wallet park/resolve/timeout logic
// (walletRequests.ts). Plain node:assert + tsx, same pattern as
// shared/graphScope.test.ts — run via `npm test` (agent/package.json).
// No ledger types, no HTTP, no devnet: this only exercises the generic
// promise-registry semantics delegatedWallet.ts builds on.

import assert from "node:assert/strict";
import { isWalletRequestPending, parkWalletRequest, resolveWalletRequest } from "./walletRequests.js";

async function testResolveSuccess() {
  const p = parkWalletRequest("req-1", 5_000);
  assert.equal(isWalletRequestPending("req-1"), true);
  const handled = resolveWalletRequest("req-1", { balancedTxHex: "abcd" });
  assert.equal(handled, true);
  const result = await p;
  assert.deepEqual(result, { balancedTxHex: "abcd" });
  assert.equal(isWalletRequestPending("req-1"), false);
}

async function testResolveError() {
  const p = parkWalletRequest("req-2", 5_000);
  const handled = resolveWalletRequest("req-2", { error: "rejected by user" });
  assert.equal(handled, true);
  await assert.rejects(p, /rejected by user/);
  assert.equal(isWalletRequestPending("req-2"), false);
}

async function testUnknownIdIsNotHandled() {
  const handled = resolveWalletRequest("never-parked", { balancedTxHex: "00" });
  assert.equal(handled, false);
}

async function testDoubleResolveIsIgnored() {
  const p = parkWalletRequest("req-3", 5_000);
  assert.equal(resolveWalletRequest("req-3", { balancedTxHex: "aa" }), true);
  // Second resolve for the same id: registry entry is already gone.
  assert.equal(resolveWalletRequest("req-3", { balancedTxHex: "bb" }), false);
  const result = await p;
  assert.deepEqual(result, { balancedTxHex: "aa" });
}

async function testTimeout() {
  const started = Date.now();
  const p = parkWalletRequest("req-4", 30);
  assert.equal(isWalletRequestPending("req-4"), true);
  await assert.rejects(p, /wallet did not respond/);
  assert.ok(Date.now() - started >= 30, "should not settle before the timeout elapses");
  assert.equal(isWalletRequestPending("req-4"), false);
  // A late resolve after timeout must be a no-op, not a crash.
  assert.equal(resolveWalletRequest("req-4", { balancedTxHex: "late" }), false);
}

async function testConcurrentRequestsAreIndependent() {
  const a = parkWalletRequest("req-5a", 5_000);
  const b = parkWalletRequest("req-5b", 5_000);
  resolveWalletRequest("req-5b", { balancedTxHex: "b" });
  resolveWalletRequest("req-5a", { balancedTxHex: "a" });
  assert.deepEqual(await a, { balancedTxHex: "a" });
  assert.deepEqual(await b, { balancedTxHex: "b" });
}

async function main() {
  await testResolveSuccess();
  await testResolveError();
  await testUnknownIdIsNotHandled();
  await testDoubleResolveIsIgnored();
  await testTimeout();
  await testConcurrentRequestsAreIndependent();
  console.log("walletRequests.test.ts: all assertions passed (6 tests)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
