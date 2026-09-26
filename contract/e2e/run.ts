#!/usr/bin/env -S node
// Veilance — devnet end-to-end script.
//
// Reproduces the exact demo sequence in test/demo.test.ts (landing.md §10)
// against a REAL Midnight devnet instead of the @midnight-ntwrk/compact-runtime
// simulator: admin bootstrap, Mine -> Refiner -> Battery Manufacturer
// provenance chain, three attestation profiles, and the double-claim attack.
//
// See README.md before running this:
//   1. `npm run compile:zk` (full ZK build — this script checks for it)
//   2. devnet up and healthy (this script checks that too)
//   3. `npm run e2e`        (full run)
//      `npm run e2e:dry-run` (everything except network calls)
//
// IMPORTANT — read README.md "Version compatibility" for the history here:
// this contract and this e2e script were originally built against a
// next-generation (ledger-v9 / compact-runtime 0.19.0) prerelease SDK line,
// then migrated back to the STABLE generation (Compact compiler 0.31.1,
// compact-runtime 0.16.0, midnight-js-* 4.1.1, wallet-sdk-facade 4.1.0) to
// match the official support matrix and the devnet.yml images given for
// this task (node 0.22.5, proof-server 8.1.0 — both stable/ledger-v8). The
// health check below now WARNS if the proof server it finds is NOT 8.x.

import * as ledger from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import type { DeployedContract, FoundContract } from "@midnight-ntwrk/midnight-js-contracts";

import { Contract, pureCircuits } from "../src/managed/veilance/contract/index.js";
import {
  createVeilancePrivateState,
  forAttest,
  rotated,
  forIssue,
  forTransfer,
  partyIdOf,
  witnesses,
  type Credential,
  type VeilancePrivateState,
} from "../src/witnesses.js";
import {
  ENTRY_BYTES,
  generateEncKeypair,
  scanInbox,
  sealCredential,
  type EncKeypair,
} from "../src/sealed-entry.js";

import {
  NETWORK_ID,
  PARTY_NAMES,
  WALLET_SEEDS,
  GENESIS_WALLET_SEED,
  FUNDING_AMOUNT,
  ZK_CONFIG_DIR,
  type PartyName,
} from "./lib/config.js";
import { checkDevnetHealth, formatHealthReport } from "./lib/health.js";
import { checkZkBuild } from "./lib/zk.js";
import { buildWallet, fundFromGenesis, ensureDust, waitForSync, type Wallet } from "./lib/wallet.js";
import { buildProviders, VEILANCE_PRIVATE_STATE_ID } from "./lib/providers.js";
import { Report } from "./lib/report.js";
import { setPrivateState, currentLedger, snapshotLedger, type Party } from "./lib/party.js";

const DRY_RUN = process.argv.includes("--dry-run");

const bytes32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).slice(0, 32));
  return out;
};

const CERT_A = bytes32("cert:A/mine");
const CERT_B = bytes32("cert:B/refiner");
const CERT_C = bytes32("cert:C/batteryMfr");
const ORIGIN_CONGO_MINE_X = bytes32("origin:congo-mine-x");
const MATERIAL_COBALT = bytes32("material:cobalt");
const BATCH_1 = bytes32("batch:1/mine->refiner");
const BATCH_2 = bytes32("batch:2/refiner->battery");
const CH1 = bytes32("challenge:consumer");
const CH2 = bytes32("challenge:procurement");
const CH3 = bytes32("challenge:regulator");

const PARTY_SECRETS: Record<PartyName, Uint8Array> = {
  admin: bytes32("veilance-e2e:secret:admin"),
  mine: bytes32("veilance-e2e:secret:mine"),
  refiner: bytes32("veilance-e2e:secret:refiner"),
  batteryMfr: bytes32("veilance-e2e:secret:batteryMfr"),
};
const CERT_IDS: Record<PartyName, Uint8Array> = {
  admin: new Uint8Array(32),
  mine: CERT_A,
  refiner: CERT_B,
  batteryMfr: CERT_C,
};

// ---------------------------------------------------------------------------
// Dry run — everything up to but excluding network calls.
// ---------------------------------------------------------------------------

const runDryRun = async (): Promise<void> => {
  console.log("Veilance e2e — dry run (no network calls)\n");

  console.log("1. Wallet seed handling / key generation");
  for (const party of PARTY_NAMES) {
    const partyId = partyIdOf(PARTY_SECRETS[party]);
    const enc = generateEncKeypair();
    console.log(
      `   ${party.padEnd(11)} partyId=${Buffer.from(partyId).toString("hex").slice(0, 16)}…  ` +
        `encPk=${Buffer.from(enc.encPk).toString("hex").slice(0, 16)}…  ` +
        `walletSeed=${WALLET_SEEDS[party].slice(0, 8)}…`,
    );
  }

  console.log("\n2. Sealing / opening a credential round-trip (src/sealed-entry.ts, real code)");
  const recipient: EncKeypair = generateEncKeypair();
  const cred: Credential = {
    ownerId: partyIdOf(PARTY_SECRETS.refiner),
    originId: ORIGIN_CONGO_MINE_X,
    materialType: MATERIAL_COBALT,
    carbonClass: 3n,
    batchSecret: BATCH_1,
  };
  const commitment = pureCircuits.commitmentOf(cred);
  const entry = sealCredential(recipient.encPk, {
    originId: cred.originId,
    materialType: cred.materialType,
    carbonClass: cred.carbonClass,
    batchSecret: cred.batchSecret,
    commitment,
  });
  if (entry.length !== ENTRY_BYTES) throw new Error(`sealed entry has wrong length: ${entry.length}`);

  const { openCredential } = await import("../src/sealed-entry.js");
  const opened = openCredential(recipient.encSk, entry);
  if (opened === null) throw new Error("round-trip failed: could not open the entry with the matching key");
  if (Buffer.from(opened.commitment).toString("hex") !== Buffer.from(commitment).toString("hex")) {
    throw new Error("round-trip failed: recovered commitment does not match");
  }
  const wrongKeypair = generateEncKeypair();
  const openedByWrongKey = openCredential(wrongKeypair.encSk, entry);
  if (openedByWrongKey !== null) {
    throw new Error("SECURITY: a non-recipient key was able to open a sealed entry");
  }
  console.log("   sealCredential -> openCredential round-trip OK (correct key opens, wrong key does not)");

  console.log("\n3. Provider construction (object construction only, no queries)");
  const zkCheck = checkZkBuild();
  console.log(`   ${zkCheck.message}`);
  // NodeZkConfigProvider's constructor does not touch the filesystem eagerly
  // (file reads happen lazily, on first getProverKey/getVerifierKey/getZKIR
  // call), so this is safe to construct even without a full ZK build. This
  // stable-generation provider (unlike the prerelease one this file used
  // before the migration) does no manifest/integrity check — it just reads
  // the raw key/zkir files.
  const { NodeZkConfigProvider } = await import("@midnight-ntwrk/midnight-js-node-zk-config-provider");
  const zkConfigProvider = new NodeZkConfigProvider(ZK_CONFIG_DIR);
  console.log(`   NodeZkConfigProvider constructed for ${zkConfigProvider.directory}`);

  // Loading one circuit's verifier key is pure local file I/O — no network
  // call — so it belongs in the dry run: it confirms this SDK generation's
  // ZK config provider can actually read what Compact 0.31.1 produced.
  if (zkCheck.ok) {
    const verifierKey = await zkConfigProvider.getVerifierKey("certifyOrigin");
    console.log(`   getVerifierKey("certifyOrigin") loaded OK (${verifierKey.length} bytes)`);
  } else {
    console.log("   (skipping getVerifierKey — full ZK build missing, see above)");
  }

  const { levelPrivateStateProvider } = await import(
    "@midnight-ntwrk/midnight-js-level-private-state-provider"
  );
  const { Level } = await import("level");
  const path = await import("node:path");
  const { STATE_DIR, PRIVATE_STATE_PASSWORD } = await import("./lib/config.js");
  const dryRunDir = path.join(STATE_DIR, "dry-run");
  const privateStateProvider = levelPrivateStateProvider<typeof VEILANCE_PRIVATE_STATE_ID, VeilancePrivateState>({
    accountId: "dry-run",
    privateStoragePasswordProvider: () => PRIVATE_STATE_PASSWORD,
    // See lib/providers.ts for why this cast is needed.
    levelFactory: (dbName: string) => new Level(path.join(dryRunDir, dbName)) as never,
  });
  const fakeAddress = "0200000000000000000000000000000000000000000000000000000000000000dead";
  privateStateProvider.setContractAddress(fakeAddress);
  const baseState = createVeilancePrivateState(PARTY_SECRETS.mine, CERT_A);
  await privateStateProvider.set(VEILANCE_PRIVATE_STATE_ID, baseState);
  const readBack = await privateStateProvider.get(VEILANCE_PRIVATE_STATE_ID);
  if (readBack === null || Buffer.from(readBack.partySecret).toString("hex") !== Buffer.from(baseState.partySecret).toString("hex")) {
    throw new Error("private state provider round-trip failed");
  }
  console.log(`   levelPrivateStateProvider round-trip OK (LevelDB under ${dryRunDir})`);

  console.log("\n4. Compiled contract wrapping (CompiledContract.make + withWitnesses)");
  const compiledContract = CompiledContract.make("veilance", Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(ZK_CONFIG_DIR),
  );
  console.log(`   CompiledContract "${compiledContract.tag}" constructed (ZK assets: ${ZK_CONFIG_DIR})`);

  console.log("\nDry run complete — everything above ran with zero network calls.");
  if (!zkCheck.ok) {
    console.log(
      `\nNOTE: ${zkCheck.message}\nRun "npm run compile:zk" before attempting a full (non-dry-run) e2e run.`,
    );
  }
};

// ---------------------------------------------------------------------------
// Full run — against a live devnet.
// ---------------------------------------------------------------------------

const runFull = async (): Promise<void> => {
  const report = new Report();

  console.log("Veilance e2e — full run against a live devnet\n");

  const zkCheck = checkZkBuild();
  if (!zkCheck.ok) {
    console.error(zkCheck.message);
    process.exitCode = 1;
    return;
  }
  console.log(zkCheck.message);

  const health = await checkDevnetHealth();
  console.log(formatHealthReport(health));
  if (!health.allHealthy) {
    console.error(
      "\nDevnet is not healthy — aborting. Start it and re-run (see README.md).",
    );
    process.exitCode = 1;
    return;
  }

  setNetworkId(NETWORK_ID);

  console.log("\nBuilding wallets and funding from genesis...");
  const genesis = await buildWallet("genesis", GENESIS_WALLET_SEED);
  await waitForSync(genesis);

  const wallets: Record<PartyName, Wallet> = {} as Record<PartyName, Wallet>;
  for (const name of PARTY_NAMES) {
    wallets[name] = await buildWallet(name, WALLET_SEEDS[name]);
  }
  // Party seeds are fixed, so a previous run may already have funded them.
  // Only top up wallets that are below half the funding amount, otherwise a
  // re-run drains the genesis wallet (250_000_000_000_000 NIGHT total).
  const needsFunding: Wallet[] = [];
  for (const name of PARTY_NAMES) {
    const s = await waitForSync(wallets[name]);
    const night = s.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
    if (night < FUNDING_AMOUNT / 2n) needsFunding.push(wallets[name]);
    else console.log(`  ${name}: already holds ${night} NIGHT, skipping funding`);
  }
  if (needsFunding.length > 0) await fundFromGenesis(genesis, needsFunding);
  for (const name of PARTY_NAMES) {
    await ensureDust(wallets[name]);
  }
  console.log("All party wallets funded and DUST-registered.");

  const parties: Record<PartyName, Party> = {} as Record<PartyName, Party>;
  for (const name of PARTY_NAMES) {
    const providers = await buildProviders(name, wallets[name]);
    parties[name] = {
      name,
      wallet: wallets[name],
      providers,
      enc: generateEncKeypair(),
      privateState: createVeilancePrivateState(PARTY_SECRETS[name], CERT_IDS[name]),
    };
  }
  const { admin, mine, refiner, batteryMfr } = parties;

  const compiledContract = CompiledContract.make("veilance", Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(ZK_CONFIG_DIR),
  );

  // --- deploy (admin) -------------------------------------------------------
  console.log("\nDeploying the contract (admin)...");
  const deployed: DeployedContract<Contract<VeilancePrivateState>> = await report.time(
    "deploy",
    "admin",
    () =>
      deployContract(admin.providers, {
        compiledContract,
        privateStateId: VEILANCE_PRIVATE_STATE_ID,
        initialPrivateState: admin.privateState,
      }),
    (d) => ({
      txHash: d.deployTxData.public.txHash,
      blockHeight: d.deployTxData.public.blockHeight,
    }),
  );
  const contractAddress = deployed.deployTxData.public.contractAddress;
  report.contractAddress = contractAddress;
  report.deployTxHash = deployed.deployTxData.public.txHash;
  report.deployBlockHeight = deployed.deployTxData.public.blockHeight;
  console.log(`Deployed at ${contractAddress}`);

  for (const p of [mine, refiner, batteryMfr]) {
    p.providers.privateStateProvider.setContractAddress(contractAddress);
  }

  const found = async (p: Party): Promise<FoundContract<Contract<VeilancePrivateState>>> =>
    findDeployedContract(p.providers, {
      contractAddress,
      compiledContract,
      privateStateId: VEILANCE_PRIVATE_STATE_ID,
      initialPrivateState: p.privateState,
    });

  const mineContract = await found(mine);
  const refinerContract = await found(refiner);
  const batteryContract = await found(batteryMfr);

  // --- step 1: admin bootstrap ----------------------------------------------
  console.log("\nStep 1 — admin bootstrap (policy)...");
  const mineId = partyIdOf(PARTY_SECRETS.mine);
  const refinerId = partyIdOf(PARTY_SECRETS.refiner);
  const batteryId = partyIdOf(PARTY_SECRETS.batteryMfr);

  await report.time("certifyOrigin", "admin", () => deployed.callTx.certifyOrigin(ORIGIN_CONGO_MINE_X));
  await report.time("certifySupplier", "admin", () => deployed.callTx.certifySupplier(mineId, CERT_A));
  await report.time("certifySupplier", "admin", () => deployed.callTx.certifySupplier(refinerId, CERT_B));
  await report.time("certifySupplier", "admin", () => deployed.callTx.certifySupplier(batteryId, CERT_C));
  await report.time("setCarbonThreshold", "admin", () => deployed.callTx.setCarbonThreshold(5n));

  console.log("\nStep 1b — registerEncKey (all four parties)...");
  await report.time("registerEncKey", "admin", () => deployed.callTx.registerEncKey(admin.enc.encPk));
  await report.time("registerEncKey", "mine", () => mineContract.callTx.registerEncKey(mine.enc.encPk));
  await report.time("registerEncKey", "refiner", () => refinerContract.callTx.registerEncKey(refiner.enc.encPk));
  await report.time("registerEncKey", "batteryMfr", () =>
    batteryContract.callTx.registerEncKey(batteryMfr.enc.encPk),
  );

  // --- step 2: Mine issues to Refiner ---------------------------------------
  console.log("\nStep 2 — Mine issues a cobalt credential to the Refiner...");
  const credA: Credential = {
    ownerId: refinerId,
    originId: ORIGIN_CONGO_MINE_X,
    materialType: MATERIAL_COBALT,
    carbonClass: 3n,
    batchSecret: BATCH_1,
  };
  await setPrivateState(
    mine,
    forIssue(
      mine.privateState,
      { originId: ORIGIN_CONGO_MINE_X, materialType: MATERIAL_COBALT, carbonClass: 3n, batchSecret: BATCH_1 },
      refinerId,
    ),
  );
  const ledgerBeforeIssue = await currentLedger(mine.providers, contractAddress);
  const refinerPk = ledgerBeforeIssue.partyEncKeys.lookup(refinerId);
  const entryA = sealCredential(refinerPk, {
    originId: credA.originId,
    materialType: credA.materialType,
    carbonClass: credA.carbonClass,
    batchSecret: credA.batchSecret,
    commitment: pureCircuits.commitmentOf(credA),
  });
  await report.time("issueProvenance", "mine", () => mineContract.callTx.issueProvenance(entryA));

  // --- Refiner scans its inbox (indexer-read ledger state) -----------------
  console.log("Refiner scanning inbox from indexer-read ledger state...");
  const ledgerForScan = await currentLedger(refiner.providers, contractAddress);
  const refinerScan = scanInbox(ledgerForScan, refiner.enc.encSk, refinerId, 0n);
  if (refinerScan.credentials.length !== 1) {
    throw new Error(`refiner expected to recover exactly 1 credential, got ${refinerScan.credentials.length}`);
  }
  const heldByRefiner = refinerScan.credentials[0];

  // --- step 3: Refiner transfers to Battery Manufacturer --------------------
  console.log("\nStep 3 — Refiner transforms and transfers to the Battery Manufacturer...");
  const credB: Credential = {
    ownerId: batteryId,
    originId: ORIGIN_CONGO_MINE_X,
    materialType: MATERIAL_COBALT,
    carbonClass: 4n,
    batchSecret: BATCH_2,
  };
  await setPrivateState(refiner, forTransfer(refiner.privateState, heldByRefiner, batteryId, 4n, BATCH_2));
  const ledgerBeforeTransfer = await currentLedger(refiner.providers, contractAddress);
  const batteryPk = ledgerBeforeTransfer.partyEncKeys.lookup(batteryId);
  const entryB = sealCredential(batteryPk, {
    originId: credB.originId,
    materialType: credB.materialType,
    carbonClass: credB.carbonClass,
    batchSecret: credB.batchSecret,
    commitment: pureCircuits.commitmentOf(credB),
  });
  await report.time("transferProvenance", "refiner", () => refinerContract.callTx.transferProvenance(entryB));

  console.log("Battery Manufacturer scanning inbox...");
  const ledgerForBatteryScan = await currentLedger(batteryMfr.providers, contractAddress);
  const batteryScan = scanInbox(ledgerForBatteryScan, batteryMfr.enc.encSk, batteryId, 0n);
  if (batteryScan.credentials.length !== 1) {
    throw new Error(
      `batteryMfr expected to recover exactly 1 credential, got ${batteryScan.credentials.length}`,
    );
  }
  const heldByBattery = batteryScan.credentials[0];

  // --- step 4: attestations --------------------------------------------------
  console.log("\nStep 4 — Battery Manufacturer proves policy to three verifier profiles...");
  // Rotate-on-attest: each attestation spends the held credential and re-mints
  // it under a fresh secret, so the next attestation must use the rotated one.
  let batteryHeld: Credential = heldByBattery;
  const attestOnce = async (name: "attestConsumer" | "attestProcurement" | "attestRegulator", ch: Uint8Array) => {
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    await setPrivateState(batteryMfr, forAttest(batteryMfr.privateState, batteryHeld, fresh));
    await report.time(name, "batteryMfr", () => batteryContract.callTx[name](ch));
    batteryHeld = rotated(batteryHeld, fresh);
  };
  await attestOnce("attestConsumer", CH1);
  await attestOnce("attestProcurement", CH2);
  await attestOnce("attestRegulator", CH3);

  // --- step 5: ATTACK — replay the already-consumed credential --------------
  console.log("\nStep 5 — ATTACK: Refiner replays the already-consumed credential...");
  const ledgerBeforeAttack = await currentLedger(refiner.providers, contractAddress);
  const nullifiersBefore = ledgerBeforeAttack.nullifiers.size();

  await setPrivateState(refiner, forTransfer(refiner.privateState, heldByRefiner, mineId, 1n, bytes32("batch:3/attack")));
  const attackCred: Credential = {
    ownerId: mineId,
    originId: ORIGIN_CONGO_MINE_X,
    materialType: MATERIAL_COBALT,
    carbonClass: 1n,
    batchSecret: bytes32("batch:3/attack"),
  };
  const minePkForAttack = ledgerBeforeAttack.partyEncKeys.lookup(mineId);
  const attackEntry = sealCredential(minePkForAttack, {
    originId: attackCred.originId,
    materialType: attackCred.materialType,
    carbonClass: attackCred.carbonClass,
    batchSecret: attackCred.batchSecret,
    commitment: pureCircuits.commitmentOf(attackCred),
  });

  let attackRejected = false;
  let attackMessage = "";
  try {
    await refinerContract.callTx.transferProvenance(attackEntry);
  } catch (err) {
    attackRejected = true;
    attackMessage = err instanceof Error ? err.message : String(err);
    console.log(`   ATTACK correctly REJECTED: ${attackMessage}`);
  }
  if (!attackRejected) {
    console.error("   SECURITY REGRESSION: the replayed transfer was NOT rejected.");
  }

  const ledgerAfterAttack = await currentLedger(refiner.providers, contractAddress);
  const nullifiersAfter = ledgerAfterAttack.nullifiers.size();
  report.attackResult = { rejected: attackRejected, message: attackMessage };

  // --- final verification via the indexer ------------------------------------
  console.log("\nVerifying final ledger state via the indexer...");
  const finalLedger = await currentLedger(admin.providers, contractAddress);
  report.finalLedger = snapshotLedger(finalLedger);

  report.expectationsMet = {
    // 2 issued/transferred + 3 rotations; 1 transfer + 3 attestations spent.
    "provenance tree has 5 leaves": finalLedger.provenanceTree.firstFree() === 5n,
    "nullifier set has 4 entries": finalLedger.nullifiers.size() === 4n,
    "attestations map has 3 entries": finalLedger.attestations.size() === 3n,
    "inbox has 2 entries": finalLedger.credentialInboxCount === 2n,
    "partyEncKeys has 4 entries": finalLedger.partyEncKeys.size() === 4n,
    "attack did not change the nullifier count": nullifiersAfter === nullifiersBefore,
    "attack was rejected": attackRejected,
  };

  for (const [k, v] of Object.entries(report.expectationsMet)) {
    console.log(`   [${v ? "x" : " "}] ${k}`);
  }

  report.write();
  console.log(`\nReport written to e2e/report.json and e2e/REPORT.md`);

  const allOk = Object.values(report.expectationsMet).every(Boolean);
  if (!allOk) process.exitCode = 1;
};

const main = async (): Promise<void> => {
  if (DRY_RUN) {
    await runDryRun();
    return;
  }
  await runFull();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
