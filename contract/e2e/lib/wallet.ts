// Veilance e2e — wallet construction, genesis funding, and DUST registration.
//
// Built against the STABLE generation: @midnight-ntwrk/wallet-sdk-facade
// 4.1.0 + wallet-sdk-{shielded,unshielded-wallet,dust-wallet,address-format,hd}
// (see ../README.md "Version compatibility" for why this replaced the
// next-gen prerelease line this file previously used). This follows the
// `midnight-js` skill's §5–§8 wiring and the `example-counter` skill's
// counter-cli/src/api.ts almost verbatim — that is the canonical 4.x pattern
// this generation expects, not something invented per-project.

import { WebSocket } from "ws";
// Must run before any @midnight-ntwrk/wallet-sdk-* import touches the
// network: GraphQL subscriptions (wallet sync) silently fail in Node.js
// without a global WebSocket. See midnight-js / wallet-sdk skills.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = WebSocket;

import fs from "node:fs";
import path from "node:path";
import * as Rx from "rxjs";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { WalletFacade, WalletEntrySchema, type FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import type { CombinedTokenTransfer, UtxoWithMeta } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import type { WalletProvider, MidnightProvider } from "@midnight-ntwrk/midnight-js-types";
import { makeDefaultSubmissionService } from "@midnight-ntwrk/wallet-sdk-capabilities/submission";
import {
  INDEXER_HTTP_URL,
  INDEXER_WS_URL,
  NETWORK_ID,
  NODE_URL,
  PROOF_SERVER_URL,
  FUNDING_AMOUNT,
} from "./config.js";

const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Derives the three per-role keys this generation's wallets are built from
 * (Zswap / NightExternal / Dust), the same HD path the `midnight-js` and
 * `example-counter` skills use: account 0, index 0.
 */
export const deriveKeys = (masterSeed: Uint8Array) => {
  const hdWallet = HDWallet.fromSeed(masterSeed);
  if (hdWallet.type !== "seedOk") {
    throw new Error(`invalid wallet seed: ${String(hdWallet.error)}`);
  }
  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  hdWallet.hdWallet.clear();
  if (derivationResult.type !== "keysDerived") {
    throw new Error("failed to derive Zswap/NightExternal/Dust keys from seed");
  }
  return derivationResult.keys;
};

export type Wallet = {
  readonly label: string;
  readonly facade: WalletFacade;
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly keystore: UnshieldedKeystore;
};

export type BuildWalletOptions = {
  /**
   * Directory for persisted wallet state. When set, the three sub-wallets are
   * restored from `<stateDir>/<label>.{shielded,unshielded,dust}.json` if those
   * files exist (skipping the long first sync on public networks), and their
   * state is written back once synced and then every minute.
   */
  readonly stateDir?: string;
};

const stateFile = (dir: string, label: string, kind: "shielded" | "unshielded" | "dust") =>
  path.join(dir, `${label}.${kind}.json`);

const readState = (dir: string | undefined, label: string, kind: "shielded" | "unshielded" | "dust"): string | undefined => {
  if (!dir) return undefined;
  const f = stateFile(dir, label, kind);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined;
};

/** Serialises the three sub-wallets to `stateDir`. Safe to call repeatedly. */
export const persistWallet = async (wallet: Wallet, stateDir: string): Promise<void> => {
  fs.mkdirSync(stateDir, { recursive: true });
  const [sh, un, du] = await Promise.all([
    wallet.facade.shielded.serializeState(),
    wallet.facade.unshielded.serializeState(),
    wallet.facade.dust.serializeState(),
  ]);
  for (const [kind, data] of [["shielded", sh], ["unshielded", un], ["dust", du]] as const) {
    const f = stateFile(stateDir, wallet.label, kind);
    // Keep an hourly previous copy. A checkpoint can turn out unrestorable (seen
    // once: the dust wallet refused to resume with "received an event with a
    // timestamp prior to the time already synced to"), and a full dust re-sync on
    // a public network costs hours.
    if (fs.existsSync(f)) {
      const prev = `${f}.prev`;
      const stale = !fs.existsSync(prev) || Date.now() - fs.statSync(prev).mtimeMs > 3_600_000;
      if (stale) fs.copyFileSync(f, prev);
    }
    fs.writeFileSync(`${f}.tmp`, data);
    fs.renameSync(`${f}.tmp`, f);
  }
};

/** Builds and starts a wallet from a 32-byte-hex seed against the configured network. */
export const buildWallet = async (label: string, seedHex: string, options: BuildWalletOptions = {}): Promise<Wallet> => {
  const masterSeed = hexToBytes(seedHex);
  const keys = deriveKeys(masterSeed);
  const saved = {
    shielded: readState(options.stateDir, label, "shielded"),
    unshielded: readState(options.stateDir, label, "unshielded"),
    dust: readState(options.stateDir, label, "dust"),
  };
  // Each sub-wallet restores independently, so losing one checkpoint (usually the
  // slow dust one) does not force the other two to start over.
  if (options.stateDir) {
    const how = (k: keyof typeof saved) => `${k} ${saved[k] ? "restored" : "fresh"}`;
    console.log(`  wallet ${label}: ${how("shielded")}, ${how("unshielded")}, ${how("dust")}`);
  }

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const keystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);

  const indexerClientConnection = { indexerHttpUrl: INDEXER_HTTP_URL, indexerWsUrl: INDEXER_WS_URL };
  const relayURL = new URL(NODE_URL.replace(/^http/, "ws"));
  const provingServerUrl = new URL(PROOF_SERVER_URL);

  const configuration = {
    networkId: NETWORK_ID,
    indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
    // additionalFeeOverhead: on an idle local devnet feesWithMargin is 0 and a
    // zero-fee transaction is rejected as NotNormalized (see the wallet skill's
    // fund-wallet-undeployed.ts). A small overhead keeps every fee non-zero.
    costParameters: { feeBlocksMargin: 5, additionalFeeOverhead: 1_000_000n },
    relayURL,
    provingServerUrl,
  };

  const facade = await WalletFacade.init({
    configuration,
    shielded: (config) =>
      saved.shielded ? ShieldedWallet(config).restore(saved.shielded) : ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config) =>
      saved.unshielded ? UnshieldedWallet(config).restore(saved.unshielded) : UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (config) =>
      saved.dust
        ? DustWallet(config).restore(saved.dust)
        : DustWallet(config).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);

  const wallet: Wallet = { label, facade, shieldedSecretKeys, dustSecretKey, keystore };
  if (options.stateDir) {
    const dir = options.stateDir;
    // Persist once the wallet first reports synced, then every minute.
    facade
      .waitForSyncedState()
      .then(() => persistWallet(wallet, dir))
      .catch((e) => console.warn(`  wallet ${label}: persist after sync failed: ${String(e)}`));
    const timer = setInterval(() => {
      persistWallet(wallet, dir).catch((e) => console.warn(`  wallet ${label}: periodic persist failed: ${String(e)}`));
    }, 60_000);
    timer.unref();
  }
  return wallet;
};

export const waitForSync = async (wallet: Wallet): Promise<FacadeState> => wallet.facade.waitForSyncedState();

/** The party's unshielded (NIGHT-holding) address. */
export const unshieldedAddress = (wallet: Wallet) => wallet.facade.unshielded.getAddress();

const defaultTtl = () => new Date(Date.now() + 30 * 60 * 1000);

/**
 * Sends `amount` NIGHT from `from` (expected to be the genesis wallet on a
 * local "undeployed" devnet) to each recipient's unshielded address, then
 * waits for each recipient's balance to reflect the send.
 *
 * This is the genesis-wallet / faucet pattern documented for local devnets
 * in the `midnight-wallet:managing-test-wallets` and `multinetwork` skills.
 */
export const fundFromGenesis = async (
  from: Wallet,
  recipients: readonly Wallet[],
  amount: bigint = FUNDING_AMOUNT,
): Promise<void> => {
  const recipientAddresses = await Promise.all(recipients.map((r) => unshieldedAddress(r)));

  const outputs: CombinedTokenTransfer[] = [
    {
      type: "unshielded",
      outputs: recipientAddresses.map((addr) => ({
        type: ledger.unshieldedToken().raw,
        receiverAddress: addr,
        amount,
      })),
    },
  ];

  const recipe = await from.facade.transferTransaction(
    outputs,
    { shieldedSecretKeys: from.shieldedSecretKeys, dustSecretKey: from.dustSecretKey },
    { ttl: defaultTtl(), payFees: true },
  );
  // Unshielded NIGHT inputs each need a signature from the sender's unshielded
  // signing key; submitting unsigned yields node error 192
  // (InputsSignaturesLengthMismatch). Mirrors the wallet skill's
  // fund-wallet-undeployed.ts Step 8.
  const signed = await from.facade.signRecipe(recipe, (payload) => from.keystore.signData(payload));
  const finalized = await from.facade.finalizeRecipe(signed);
  await from.facade.submitTransaction(finalized);

  await Promise.all(
    recipients.map((r) =>
      Rx.firstValueFrom(
        r.facade.state().pipe(
          Rx.throttleTime(2_000),
          Rx.filter((s) => s.isSynced && (s.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n) > 0n),
        ),
      ),
    ),
  );
};

/**
 * Registers every unregistered NIGHT UTxO for DUST generation, then waits
 * for DUST to actually be spendable. No-op if DUST is already available.
 * Mirrors the DUST flow documented in the `midnight-js` and
 * `midnight-wallet:managing-test-wallets` skills, adapted to this
 * generation's `registerNightUtxosForDustGeneration` / `waitForGeneratedDust`
 * facade methods.
 */
export const ensureDust = async (wallet: Wallet): Promise<void> => {
  const state = await wallet.facade.waitForSyncedState();
  if (state.dust.availableCoins.length > 0 && state.dust.balance(new Date()) > 0n) {
    return;
  }

  const unregistered: UtxoWithMeta[] = state.unshielded.availableCoins.filter(
    (coin) => !coin.meta.registeredForDustGeneration,
  );
  if (unregistered.length === 0) {
    await Rx.firstValueFrom(
      wallet.facade.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
      ),
    );
    return;
  }

  const nightVerifyingKey = wallet.keystore.getPublicKey();
  const signSegment = (payload: Uint8Array) => wallet.keystore.signData(payload);
  const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
    unregistered,
    nightVerifyingKey,
    signSegment,
  );
  const finalized = await wallet.facade.finalizeRecipe(recipe);
  await wallet.facade.submitTransaction(finalized);

  await Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
    ),
  );
};

/**
 * Workaround for a wallet SDK bug: `signRecipe`/the default signing path
 * hardcodes a `'pre-proof'` marker, which fails for a proven
 * (`UnboundTransaction`) intent that already carries `'proof'` data ("Failed
 * to clone intent"). Verbatim from the `midnight-js` skill §8 — this is a
 * known SDK issue, not something specific to this contract.
 */
const signTransactionIntents = (
  tx: { intents?: Map<number, ledger.Intent<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: "proof" | "pre-proof",
): void => {
  if (!tx.intents || tx.intents.size === 0) return;

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;

    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      "signature",
      proofMarker,
      "pre-binding",
      intent.serialize(),
    );

    const signature = signFn(cloned.signatureData(segment));

    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }

    tx.intents.set(segment, cloned as unknown as ledger.Intent<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>);
  }
};

/**
 * Balances, signs and binds a proven-but-unbalanced transaction using
 * `wallet`, returning the finalized transaction ready for submission —
 * WITHOUT submitting it. Extracted out of {@link asMidnightJsProvider}'s
 * `balanceTx` so the agent's delegated-wallet dev path (see
 * `agent/src/delegatedWallet.ts`'s `POST /wallet/dev-balance-submit`) can
 * reuse the exact same balancing logic — including the `signTransactionIntents`
 * SDK workaround below — to stand in for a real browser wallet's
 * `balanceUnsealedTransaction` without duplicating it.
 */
export const balanceUnboundTransaction = async (
  wallet: Wallet,
  tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
  ttl?: Date,
): Promise<ledger.FinalizedTransaction> => {
  const signFn = (payload: Uint8Array) => wallet.keystore.signData(payload);
  const recipe = await wallet.facade.balanceUnboundTransaction(
    tx,
    { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
    { ttl: ttl ?? defaultTtl() },
  );

  signTransactionIntents(recipe.baseTransaction, signFn, "proof");
  if (recipe.balancingTransaction) {
    signTransactionIntents(recipe.balancingTransaction, signFn, "pre-proof");
  }

  return wallet.facade.finalizeRecipe(recipe);
};

/**
 * Adapts a {@link Wallet} to the `WalletProvider & MidnightProvider` pair
 * `@midnight-ntwrk/midnight-js-contracts` needs to balance and submit
 * contract-call transactions it built and had proven.
 */
export const asMidnightJsProvider = async (
  wallet: Wallet,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await wallet.facade.waitForSyncedState();
  const coinPublicKey = state.shielded.coinPublicKey.toHexString();
  const encryptionPublicKey = state.shielded.encryptionPublicKey.toHexString();

  return {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    balanceTx: (tx, ttl) => balanceUnboundTransaction(wallet, tx, ttl),
    submitTx: (tx) => wallet.facade.submitTransaction(tx),
  };
};


/**
 * The provider pair for a process that owns NO wallet (VEILANCE_AGENT_WALLET=0).
 * Keys and fee balancing must come from a connected browser wallet — asking this
 * provider for them is a hard, explicit error rather than a silent fallback.
 * Submission needs no wallet at all: it is a relay of already balanced, signed
 * and bound bytes to the node, done with the wallet SDK's standalone submission
 * service (the same one WalletFacade uses internally).
 */
export const makeWalletlessProvider = (label: string): WalletProvider & MidnightProvider => {
  const need = (what: string): never => {
    throw new Error(`no wallet connected for "${label}": ${what} must come from a connected browser wallet (this agent runs with VEILANCE_AGENT_WALLET=0)`);
  };
  const submission = makeDefaultSubmissionService<ledger.FinalizedTransaction>({
    relayURL: new URL(NODE_URL.replace(/^http/, "ws")),
  });
  return {
    getCoinPublicKey: () => need("the coin public key"),
    getEncryptionPublicKey: () => need("the encryption public key"),
    balanceTx: async () => need("fee balancing and signing"),
    submitTx: async (tx) => {
      await submission.submitTransaction(tx, "Finalized");
      const id = tx.identifiers().at(-1);
      if (!id) throw new Error("submitted transaction has no identifier");
      return id;
    },
  };
};
