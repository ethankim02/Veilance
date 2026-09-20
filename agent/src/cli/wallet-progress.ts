// Restores the funder wallet from a COPY of a checkpoint directory and prints each
// sub-wallet's sync progress. Use it to test whether a checkpoint is restorable
// before restarting the agent on it.  Usage: npx tsx src/cli/wallet-progress.ts <dir> [seconds]
import * as Rx from "rxjs";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { buildWallet } from "../../../contract/e2e/lib/wallet.js";
import { NETWORK_ID, FUNDER_SEED } from "../config.js";
setNetworkId(NETWORK_ID);
const w = await buildWallet("funder", FUNDER_SEED, { stateDir: process.argv[2] });
const f = (p: any) => `applied=${p.appliedIndex} relevantWallet=${p.highestRelevantWalletIndex} highest=${p.highestIndex} conn=${p.isConnected} strict=${p.isStrictlyComplete()}`;
const t0 = Date.now();
w.facade.state().pipe(Rx.throttleTime(20000)).subscribe((s: any) => console.log(`${((Date.now()-t0)/1000)|0}s synced=${s.isSynced}\n  shielded   ${f(s.shielded.state.progress)}\n  dust       ${f(s.dust.state.progress)}\n  unshielded ${f(s.unshielded.progress)}`));
setTimeout(() => process.exit(0), Number(process.argv[3] ?? 120) * 1000);
