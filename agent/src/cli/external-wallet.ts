// A stand-in for a browser wallet (Lace), run as a SEPARATE process with its own
// headless wallet. It does exactly what the web UI does with a DApp Connector
// wallet: registers a wallet session for a party, waits for that party's job to
// reach `awaiting_wallet`, balances + signs the proven transaction with ITS OWN
// wallet, and posts the result back. It never sees a witness secret, and the
// agent it talks to may own no wallet at all (VEILANCE_AGENT_WALLET=0).
//
//   npx tsx src/cli/external-wallet.ts <agentUrl> <party> <walletSeedHex> [--once]
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { balanceUnboundTransaction, buildWallet, ensureDust, waitForSync } from "../../../contract/e2e/lib/wallet.js";
import { NETWORK_ID } from "../config.js";

const [agent, party, seed, flag] = process.argv.slice(2);
if (!agent || !party || !seed) throw new Error("usage: external-wallet.ts <agentUrl> <party> <walletSeedHex> [--once]");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(agent + path, { ...init, headers: { "content-type": "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

setNetworkId(NETWORK_ID);
console.log(`[ext-wallet] building own wallet on ${NETWORK_ID}…`);
const wallet = await buildWallet(`ext-${party}`, seed);
const state = await waitForSync(wallet);
await ensureDust(wallet);
const addr = await wallet.facade.unshielded.getAddress();
await j("/wallet/session", {
  method: "POST",
  body: JSON.stringify({
    party,
    networkId: NETWORK_ID,
    coinPublicKey: ShieldedCoinPublicKey.codec.encode(NETWORK_ID as never, state.shielded.coinPublicKey).asString(),
    encryptionPublicKey: ShieldedEncryptionPublicKey.codec.encode(NETWORK_ID as never, state.shielded.encryptionPublicKey).asString(),
    unshieldedAddress: UnshieldedAddress.codec.encode(NETWORK_ID as never, addr).asString(),
  }),
});
console.log(`[ext-wallet] session registered for ${party}; waiting for awaiting_wallet jobs`);

const handled = new Set<string>();
for (;;) {
  const jobs: any[] = await j(`/jobs?party=${party}`);
  const job = jobs.find((x) => x.stage === "awaiting_wallet" && x.walletRequest && !handled.has(x.walletRequest.id));
  if (job) {
    handled.add(job.walletRequest.id);
    const t0 = Date.now();
    try {
      const unbound = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>(
        "signature", "proof", "pre-binding", Buffer.from(job.walletRequest.txHex, "hex"));
      const finalized = await balanceUnboundTransaction(wallet, unbound);
      await j(`/jobs/${job.id}/wallet-result`, { method: "POST", body: JSON.stringify({ requestId: job.walletRequest.id, balancedTxHex: hex(finalized.serialize()) }) });
      console.log(`[ext-wallet] balanced+signed ${job.circuit} in ${Date.now() - t0} ms`);
    } catch (e) {
      await j(`/jobs/${job.id}/wallet-result`, { method: "POST", body: JSON.stringify({ requestId: job.walletRequest.id, error: String(e) }) });
      console.log(`[ext-wallet] FAILED ${job.circuit}: ${String(e)}`);
    }
    if (flag === "--once") { await wallet.facade.stop(); process.exit(0); }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
