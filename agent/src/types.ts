// Veilance Party Agent — HTTP-facing types, matching agent/API.md verbatim.

import { PARTY_NAMES, type PartyName } from "./config.js";
export type { PartyName };

export const isPartyName = (value: string): value is PartyName =>
  (PARTY_NAMES as readonly string[]).includes(value);

const VERIFIER_PROFILES = ["consumer", "procurement", "regulator"] as const;
export const isVerifierProfileName = (value: string): value is VerifierProfileName =>
  (VERIFIER_PROFILES as readonly string[]).includes(value);

export type VerifierProfileName = "consumer" | "procurement" | "regulator";

export type JobCircuit =
  | "deploy"
  | "registerEncKey"
  | "certifyOrigin"
  | "certifySupplier"
  | "setCarbonThreshold"
  | "issueProvenance"
  | "transferProvenance"
  | "attestConsumer"
  | "attestProcurement"
  | "attestRegulator";

export type JobStage =
  | "queued"
  | "preparing"
  | "proving"
  | "awaiting_wallet"
  | "submitting"
  | "confirmed"
  | "rejected"
  | "failed";

/**
 * Parked on a job while its `balanceTx` call is delegated to a connected
 * browser wallet (agent/API.md "Delegated wallet" addendum) — the browser
 * polls `GET /jobs/:id`, sees this, calls the DApp Connector's
 * `balanceUnsealedTransaction(txHex)` with it, and posts the result back to
 * `POST /jobs/:id/wallet-result`. `kind` is always `"balance-and-submit"`
 * today (the agent submits the balanced tx itself through its own node
 * connection — see delegatedWallet.ts's doc comment for why) but is a
 * literal union, not a bare string, so a future second kind (the browser
 * submitting too) is a type-checked addition, not a silent string match.
 */
export type WalletRequest = {
  readonly id: string;
  readonly kind: "balance-and-submit";
  /** The proven-but-unbalanced transaction, `Transaction<SignatureEnabled, Proof, PreBinding>`, hex-serialized. */
  readonly txHex: string;
  readonly networkId: string;
};

export type Job = {
  id: string;
  party: PartyName;
  circuit: JobCircuit;
  stage: JobStage;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  txHash?: string;
  blockHeight?: number;
  result?: Record<string, unknown>;
  error?: string;
  /** Present only while `stage === "awaiting_wallet"`. */
  walletRequest?: WalletRequest;
};

// ---------------------------------------------------------------------------
// Delegated wallet (v1.4 addendum) — see agent/API.md and docs/WALLET.md.
// ---------------------------------------------------------------------------

/**
 * A browser wallet connected on behalf of `party` (in-memory only — lost on
 * restart, same as everything else `appState` holds). `coinPublicKey` /
 * `encryptionPublicKey` are hex (the browser's connector returns them
 * Bech32m-encoded via `getShieldedAddresses()`; the agent decodes them at
 * session-creation time — see delegatedWallet.ts — so this shape matches
 * what `WalletProvider.getCoinPublicKey`/`getEncryptionPublicKey` need
 * verbatim, and so the browser never needs `@midnight-ntwrk/ledger-v8` or
 * `wallet-sdk-address-format` in its bundle just to connect a wallet).
 */
export type WalletSession = {
  readonly party: PartyName;
  readonly networkId: string;
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
  readonly unshieldedAddress: string;
  readonly connectedAt: string;
};

export type CredentialStatus = "ACTIVE" | "CONSUMED";

/**
 * One credential held in a party's local vault (L2). This is the full
 * internal record — `batchSecret` and `ownerId` are needed to reconstruct
 * the contract's `Credential` struct for `heldCredential()` witness
 * reconstruction on transfer/attest, but are not part of the public
 * GET /parties/:party/credentials shape (see {@link toPublicCredential}).
 */
export type HeldCredential = {
  /** = commitment, hex. Used as the `:id` path segment in credential routes. */
  readonly id: string;
  readonly commitment: string;
  readonly ownerId: string;
  readonly originId: string;
  readonly originLabel?: string;
  /** Hex-encoded Bytes<32> (UTF-8 label, zero-padded — see materials.ts). */
  readonly materialType: string;
  readonly materialLabel?: string;
  readonly carbonClass: number;
  readonly batchSecret: string;
  status: CredentialStatus;
  readonly receivedAt: string;
  readonly inboxIndex?: number;
  readonly issuedBy?: PartyName;
  /**
   * Set in place by `startTransferJob` at the moment `status` flips to
   * CONSUMED — the evidence a later `GET /graph` needs to mark the edge
   * that delivered this credential as CONSUMED (not just DELIVERED), and
   * to show the Lot drawer's "Nullifier" evidence row (UX_V3.md §4.2).
   * Absent for a credential that has never been transferred onward.
   */
  consumedNullifier?: string;
  consumedTxHash?: string;
  consumedBlockHeight?: number;
  consumedAt?: string;
  consumedByJobId?: string;
};

export type PublicCredential = Omit<HeldCredential, "batchSecret" | "ownerId">;

export const toPublicCredential = (c: HeldCredential): PublicCredential => {
  const { batchSecret: _batchSecret, ownerId: _ownerId, ...pub } = c;
  // Vaults written before inboxIndex became a number may hold decimal strings.
  const raw = (c as { inboxIndex?: number | string }).inboxIndex;
  return { ...pub, inboxIndex: raw === undefined ? undefined : Number(raw) };
};

/**
 * One entry this party's own `issueProvenance` or `transferProvenance` call
 * created (this party is always the edge's `from`). Written by
 * `startIssueJob` / `startTransferJob` in the issuer's own vault so
 * `GET /graph` can rebuild edges without re-deriving them from job history
 * on every request, and so they survive a restart (agent/API.md v1.1
 * addendum: "Persist an issued[] list in the issuer's vault"). Credential
 * data that predates this field (jobs run before this change) has no
 * `issued[]` entry — `graph.ts` falls back to reconstructing those from job
 * history + held-credential vaults + inbox decryption.
 */
export type IssuedEntry = {
  /** = the new commitment this call created. */
  readonly commitment: string;
  readonly recipient: PartyName;
  readonly circuit: "issueProvenance" | "transferProvenance";
  readonly inboxIndex?: number;
  readonly txHash?: string;
  readonly blockHeight?: number;
  readonly carbonClass?: number;
  readonly materialLabel?: string;
  readonly originLabel?: string;
  readonly createdAt: string;
  readonly jobId: string;
};

/** Per-party persisted sidecar: agent/.state/<party>/agent.json. */
export type PartyAgentFile = {
  partySecret: string;
  certId: string;
  encPk?: string;
  encSk?: string;
  heldCredentials: HeldCredential[];
  lastSeenInboxIndex: string;
  jobs: Job[];
  /** See {@link IssuedEntry}. Absent/`undefined` on vaults written before this field existed — always read via `?? []`. */
  issued: IssuedEntry[];
};

/** A verifier's outstanding challenge (agent/.state/challenges.json, global — verifiers have no wallet/party). */
export type StoredChallenge = {
  challenge: string;
  attestationKey: string;
  profile: VerifierProfileName;
  holder: PartyName;
  createdAt: string;
};

export const PROFILE_CODE: Record<VerifierProfileName, bigint> = {
  consumer: 1n,
  procurement: 2n,
  regulator: 3n,
};

export const CIRCUIT_FOR_PROFILE: Record<VerifierProfileName, JobCircuit> = {
  consumer: "attestConsumer",
  procurement: "attestProcurement",
  regulator: "attestRegulator",
};

// ---------------------------------------------------------------------------
// v1.1 addendum — GET /graph
// ---------------------------------------------------------------------------

export type EdgeStatus = "ISSUED" | "DELIVERED" | "CONSUMED";

export type GraphNode = {
  id: PartyName | "verifier";
  org: string;
  role: string;
  certified: boolean;
  encKeyRegistered: boolean;
  held: number;
  consumed: number;
  attestations: number;
  lastActivityAt?: string;
};

export type GraphEdge = {
  id: string;
  from: PartyName;
  to: PartyName;
  credentialId: string;
  commitment: string;
  status: EdgeStatus;
  circuit: "issueProvenance" | "transferProvenance";
  txHash?: string;
  blockHeight?: number;
  inboxIndex?: number;
  carbonClass?: number;
  materialLabel?: string;
  originLabel?: string;
  createdAt: string;
  jobId?: string;
  /** 1-based, in edge-creation order (agent/API.md v1.1: "the UI labels lots 'Cobalt · lot 2'"). */
  lotNumber: number;
  /** Additive enrichment (not required by API.md, kept optional): set once this edge's credential is later consumed by a downstream transfer — see {@link HeldCredential}'s `consumed*` fields. */
  nullifier?: string;
  consumedTxHash?: string;
  consumedBlockHeight?: number;
  deliveredAt?: string;
  /**
   * Evidence panel fields (roadmap milestone 3, HANDOFF.md §4-3): how long
   * this edge's own `circuit` call took end to end (proving + balancing +
   * submit + finality — see jobs.ts's module doc), and a short sha256
   * fingerprint of the verifier key that checks every proof for `circuit`
   * (see verifierKeys.ts — the key itself is a public, circuit-wide build
   * artifact, not per-job data, so this is present even when `provingMs` is
   * absent for an edge whose job history this process no longer holds).
   */
  provingMs?: number;
  verifierKeyFingerprint?: string;
};

export type GraphAttestation = {
  holder: PartyName;
  profile: VerifierProfileName;
  attestationKey: string;
  policyVersion: string;
  txHash?: string;
  blockHeight?: number;
  challenge?: string;
  createdAt: string;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  attestations: GraphAttestation[];
  activeJob?: Job;
  queue: Job[];
};

// ---------------------------------------------------------------------------
// v1.1 addendum — GET /explorer/*
// ---------------------------------------------------------------------------

export type ExplorerContractActionKind = "deploy" | "call" | "update";

export type ExplorerTip = {
  blockHeight: number;
  blockHash: string;
  timestamp: string;
};

export type ExplorerBlock = {
  height: number;
  hash: string;
  parentHash?: string;
  timestamp: string;
  txCount: number;
  txHashes: string[];
};

export type ExplorerTx = {
  hash: string;
  blockHeight: number;
  blockHash: string;
  timestamp: string;
  status?: "applied" | "failed";
  contractActions: Array<{ address: string; kind: ExplorerContractActionKind; entryPoint?: string }>;
  identifiers?: string[];
  /** Everything on this shape comes straight from the indexer (agent/README.md "Explorer & graph" explains why no job-history fill is needed here). */
  source: "indexer";
};

export type ExplorerContractAction = {
  txHash: string;
  blockHeight: number;
  timestamp?: string;
  kind: ExplorerContractActionKind;
  entryPoint?: string;
  party?: PartyName;
  circuit?: string;
  jobId?: string;
  /** "indexer" for the one row independently cross-checked against the chain's own latest `contractAction`; "agent" for the rest, filled from job history (see agent/README.md). */
  source: "indexer" | "agent";
};

export type ExplorerContract = {
  address: string;
  deployTxHash?: string;
  deployBlockHeight?: number;
  latestBlockHeight: number;
  actionCount: number;
  actions: ExplorerContractAction[];
};
