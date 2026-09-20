// Veilance Party Agent — startup sequence.
//
// Mirrors contract/e2e/run.ts's runFull() setup phase almost exactly (health
// check -> setNetworkId -> build+fund wallets -> ensure DUST -> build
// providers), reusing the same e2e/lib helpers, but as a long-lived process:
// GET /health is served immediately (see index.ts) while this runs in the
// background, and if `agent/.state/deployment.json` already exists it
// reconnects every party to that contract instead of waiting for POST
// /deploy.

import * as ledger from "@midnight-ntwrk/ledger-v8";
import path from "node:path";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { createVeilancePrivateState } from "../../contract/src/witnesses.js";
import { generateEncKeypair } from "../../contract/src/sealed-entry.js";
import { checkDevnetHealth, formatHealthReport } from "../../contract/e2e/lib/health.js";
import { checkZkBuild } from "../../contract/e2e/lib/zk.js";
import { buildWallet, ensureDust, fundFromGenesis, waitForSync } from "../../contract/e2e/lib/wallet.js";
import { buildProviders, type VeilanceProviders } from "../../contract/e2e/lib/providers.js";
import { createDelegatedWalletProvider } from "./delegatedWallet.js";
import type { MidnightProvider, WalletProvider } from "@midnight-ntwrk/midnight-js-types";

import {
  AGENT_STATE_DIR,
  CONTRACT_ADDRESS_OVERRIDE,
  FUNDING_AMOUNT,
  FUNDER_SEED,
  HOSTED_PARTIES,
  SHARED_FEE_WALLET,
  AGENT_WALLET,
  NETWORK_ID,
  WALLET_SEEDS,
  type PartyName,
} from "./config.js";
import { appState, type AppParty } from "./appState.js";
import { fromHex, ZERO_HEX_32 } from "./bytes.js";
import { registry } from "./registry.js";
import { findVeilance } from "./contractSetup.js";
import { loadDeployment, loadOrCreatePartyFile, saveDeployment } from "./state.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHealthyDevnet = async (): Promise<void> => {
  for (;;) {
    const health = await checkDevnetHealth();
    console.log(formatHealthReport(health));
    if (health.allHealthy) {
      for (const w of health.warnings) console.warn(`WARN ${w}`);
      return;
    }
    appState.boot.step = "waiting for devnet health";
    console.log("Devnet not healthy yet — retrying in 3s...");
    await sleep(3_000);
  }
};

const defaultCertId = (party: PartyName): string => registry.supplierCertId(party) ?? ZERO_HEX_32;

export const bootstrap = async (): Promise<void> => {
  try {
    appState.boot.step = "checking ZK build";
    const zkCheck = checkZkBuild();
    console.log(zkCheck.message);
    if (!zkCheck.ok) {
      appState.boot = { ready: false, step: "ZK build missing", error: zkCheck.message };
      return;
    }

    appState.boot.step = "checking devnet health";
    await waitForHealthyDevnet();

    setNetworkId(NETWORK_ID);

    appState.boot.step = "building wallets";
    // On the local devnet the funder is the genesis wallet. On a public network
    // it is a faucet-funded wallet given via VEILANCE_FUNDER_SEED, or absent —
    // then the party wallets must already hold NIGHT.
    // Build every wallet before waiting on any of them so they sync in parallel:
    // a fresh wallet's first sync on a public network walks millions of blocks,
    // and five sequential syncs would multiply that wait. Wallet state is
    // persisted under AGENT_STATE_DIR/wallets so later boots restore instantly.
    const walletStateDir = path.join(AGENT_STATE_DIR, "wallets");
    const funder = AGENT_WALLET && FUNDER_SEED ? await buildWallet("funder", FUNDER_SEED, { stateDir: walletStateDir }) : null;
    const wallets: Record<PartyName, Awaited<ReturnType<typeof buildWallet>> | null> = {} as never;
    if (!AGENT_WALLET) {
      // Wallet-less mode: nothing to build, sync, fund or register. Fees are
      // balanced + signed by a browser wallet connected per party.
      appState.boot.step = "wallet-less mode (fees paid by a connected browser wallet)";
      for (const name of HOSTED_PARTIES) wallets[name] = null;
    } else if (SHARED_FEE_WALLET) {
      // One fee-paying wallet for every party (see config.ts SHARED_FEE_WALLET).
      if (!funder) throw new Error("VEILANCE_SHARED_FEE_WALLET=1 requires VEILANCE_FUNDER_SEED");
      appState.boot.step = "syncing the shared fee wallet (a first sync on a public network takes a long time)";
      await waitForSync(funder);
      for (const name of HOSTED_PARTIES) wallets[name] = funder;
      appState.boot.step = "ensuring DUST on the shared fee wallet";
      await ensureDust(funder);
    } else {
      for (const name of HOSTED_PARTIES) {
        wallets[name] = await buildWallet(name, WALLET_SEEDS[name], { stateDir: walletStateDir });
      }
      appState.boot.step = "syncing wallets (a first sync on a public network takes a long time)";
      if (funder) await waitForSync(funder);

      appState.boot.step = "funding wallets (if needed)";
      const needsFunding = [];
      for (const name of HOSTED_PARTIES) {
        const s = await waitForSync(wallets[name]!);
        const night = s.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
        if (night < FUNDING_AMOUNT / 2n) needsFunding.push(wallets[name]!);
        else console.log(`  ${name}: already holds ${night} NIGHT, skipping funding`);
      }
      if (needsFunding.length > 0) {
        if (!funder) {
          throw new Error(
            `${needsFunding.length} party wallet(s) hold less than ${FUNDING_AMOUNT / 2n} NIGHT and no funder wallet is configured (VEILANCE_FUNDER_SEED). Fund them from the network faucet first.`,
          );
        }
        await fundFromGenesis(funder, needsFunding);
      }

      appState.boot.step = "ensuring DUST";
      for (const name of HOSTED_PARTIES) await ensureDust(wallets[name]!);
    }

    appState.boot.step = "building providers and private state";
    for (const name of HOSTED_PARTIES) {
      const builtProviders = await buildProviders(name, wallets[name], {
        baseStateDir: AGENT_STATE_DIR,
        accountId: `agent-${name}`,
      });
      // Delegated wallet (v1.4 addendum, agent/API.md): wrap this party's
      // agent-owned WalletProvider & MidnightProvider so a browser wallet
      // connected via POST /wallet/session (delegatedWallet.ts's session
      // map) transparently takes over balancing — falling straight back to
      // the pair `buildProviders` just returned whenever no session is
      // active. `walletProvider`/`midnightProvider` are readonly on
      // `MidnightProviders`, and `builtProviders.walletProvider ===
      // builtProviders.midnightProvider` (both are the same object from
      // `asMidnightJsProvider` — see providers.ts), so this rebuilds the
      // providers object with both replaced by the same new wrapper rather
      // than mutating either field in place.
      // `VeilanceProviders`'s type only narrows this to `WalletProvider`, but
      // providers.ts constructs `walletProvider`/`midnightProvider` from the
      // very same `asMidnightJsProvider(wallet)` object, so it already
      // implements `submitTx` too — this assertion just recovers that fact.
      const fallback = builtProviders.walletProvider as WalletProvider & MidnightProvider;
      const delegated = createDelegatedWalletProvider(name, fallback);
      const providers: VeilanceProviders = { ...builtProviders, walletProvider: delegated, midnightProvider: delegated };

      const file = loadOrCreatePartyFile(name, name === "admin" ? ZERO_HEX_32 : defaultCertId(name));
      if (!file.encPk || !file.encSk) {
        const enc = generateEncKeypair();
        file.encPk = Buffer.from(enc.encPk).toString("hex");
        file.encSk = Buffer.from(enc.encSk).toString("hex");
      }

      // Not written to the private state provider here: deployVeilance() /
      // findVeilance() (contractSetup.ts) pass this as `initialPrivateState`,
      // which the SDK writes for us once the contract address is known —
      // exactly the deployContract/findDeployedContract convention
      // contract/e2e/run.ts follows.
      const privateState = createVeilancePrivateState(fromHex(file.partySecret), fromHex(file.certId));

      const appParty: AppParty = {
        name,
        party: {
          name,
          wallet: wallets[name],
          providers,
          enc: { encPk: fromHex(file.encPk), encSk: fromHex(file.encSk) },
          privateState,
        },
        file,
      };
      appState.parties.set(name, appParty);
      for (const job of file.jobs) appState.registerJob(job);
    }
    console.log(AGENT_WALLET ? "All party wallets funded, DUST-registered, and providers built." : "Wallet-less mode: providers built, no agent wallet.");

    appState.boot.step = "reconnecting to deployed contract (if any)";
    // A single-company agent (HOSTED_PARTIES excludes "admin") never calls
    // POST /deploy itself — it needs to be told the address admin's own
    // agent deployed to. AGENT_CONTRACT_ADDRESS covers that: on first boot
    // (no deployment.json yet) it's used and persisted; every later boot
    // reads deployment.json as before, so the env var only matters once.
    const existing = loadDeployment();
    const deployment = existing ?? (CONTRACT_ADDRESS_OVERRIDE ? { contractAddress: CONTRACT_ADDRESS_OVERRIDE } : null);
    if (deployment) {
      for (const name of HOSTED_PARTIES) {
        const appParty = appState.partyOrThrow(name);
        appParty.party.providers.privateStateProvider.setContractAddress(deployment.contractAddress);
        appParty.contract = await findVeilance(appParty.party, deployment.contractAddress);
      }
      appState.contractAddress = deployment.contractAddress;
      if (!existing) saveDeployment(deployment);
      console.log(`Reconnected to existing contract at ${deployment.contractAddress}${existing ? "" : " (from AGENT_CONTRACT_ADDRESS)"}`);
    } else {
      console.log("No agent/.state/deployment.json yet and no AGENT_CONTRACT_ADDRESS set — waiting for POST /deploy.");
    }

    appState.boot = { ready: true, step: "ready" };
    console.log("Party Agent ready.");
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("Bootstrap failed:", message);
    appState.boot = { ready: false, step: "bootstrap failed", error: message };
  }
};
