// Veilance e2e — devnet configuration.
//
// Every endpoint here matches contract task's devnet.yml
// (node 0.22.5, indexer-standalone 4.2.1, proof-server 8.1.0, network id
// "undeployed"). See ../README.md "Version compatibility" for why the SDK
// pinned in package.json is a prerelease line, and why these devnet images
// are very likely the WRONG generation for this contract until they are
// upgraded per that section.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(here, "..");
export const CONTRACT_DIR = path.resolve(E2E_DIR, "..");
export const STATE_DIR = path.join(E2E_DIR, ".state");
export const ZK_CONFIG_DIR = path.join(CONTRACT_DIR, "src", "managed", "veilance");
export const REPORT_JSON_PATH = path.join(E2E_DIR, "report.json");
export const REPORT_MD_PATH = path.join(E2E_DIR, "REPORT.md");

// ---------------------------------------------------------------------------
// Network selection. Defaults are the local devnet (devnet.yml). Every value
// can be overridden by environment variables so the same code targets a
// public Midnight test network:
//   VEILANCE_NETWORK_ID   e.g. "undeployed" (local) or the public network's id
//   VEILANCE_NODE_URL / VEILANCE_NODE_WS_URL
//   VEILANCE_INDEXER_HTTP_URL / VEILANCE_INDEXER_WS_URL
//   VEILANCE_PROOF_SERVER_URL   (the proof server always runs locally)
//   VEILANCE_FUNDER_SEED  64-hex seed of a wallet that already holds NIGHT and
//                         funds the four party wallets. Defaults to the local
//                         devnet genesis wallet; on a public network set it to a
//                         faucet-funded wallet, or leave it empty to skip
//                         funding entirely (fund the party wallets yourself).
//   VEILANCE_FUNDING_AMOUNT  NIGHT (smallest unit) sent to each party.
// ---------------------------------------------------------------------------
const env = (k: string, d: string): string => process.env[k] ?? d;

export const NETWORK_ID = env("VEILANCE_NETWORK_ID", "undeployed");
export const IS_LOCAL_DEVNET = NETWORK_ID === "undeployed";

export const NODE_URL = env("VEILANCE_NODE_URL", "http://localhost:9944");
export const NODE_WS_URL = env("VEILANCE_NODE_WS_URL", "ws://localhost:9944");
export const INDEXER_HTTP_URL = env("VEILANCE_INDEXER_HTTP_URL", "http://localhost:8088/api/v4/graphql");
export const INDEXER_WS_URL = env("VEILANCE_INDEXER_WS_URL", "ws://localhost:8088/api/v4/graphql/ws");
export const PROOF_SERVER_URL = env("VEILANCE_PROOF_SERVER_URL", "http://localhost:6300");

/** The four demo parties, matching test/demo.test.ts's cast exactly. */
export const PARTY_NAMES = ["admin", "mine", "refiner", "batteryMfr"] as const;
export type PartyName = (typeof PARTY_NAMES)[number];

/**
 * Deterministic 64-hex-char (32-byte) wallet seeds for local devnet only.
 *
 * These are NOT secret — this is a throwaway local e2e harness, not a
 * production key management example. Real DApps must never hardcode wallet
 * seeds. Each party's NIGHT/DUST wallet seed is intentionally distinct from
 * its contract-level `partySecret` witness (see witnesses.ts / demo.test.ts)
 * — the wallet seed controls on-chain funds, the party secret controls the
 * pseudonymous identity proven inside the ZK circuits. Conflating the two
 * would not be wrong cryptographically, but keeping them separate mirrors
 * how a real DApp keeps "who pays gas" and "who the circuit says I am"
 * as independent concerns.
 */
export const WALLET_SEEDS: Record<PartyName, string> = {
  admin: "a1".repeat(32),
  mine: "b2".repeat(32),
  refiner: "c3".repeat(32),
  batteryMfr: "d4".repeat(32),
};

/**
 * The well-known local-devnet genesis wallet seed. Pre-funded with NIGHT in
 * the "undeployed" network's genesis block — this is the standard
 * genesis-wallet / faucet pattern for local Midnight devnets (see the
 * `midnight-wallet:managing-test-wallets` and `example-counter` skills).
 * It is publicly documented and identical across every local devnet; it is
 * not a secret of any kind.
 */
const LOCAL_GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
/** Seed of the wallet that funds the parties. Empty string = no funding step. */
export const FUNDER_SEED: string = process.env.VEILANCE_FUNDER_SEED ?? (IS_LOCAL_DEVNET ? LOCAL_GENESIS_SEED : "");
/** @deprecated use FUNDER_SEED */
export const GENESIS_WALLET_SEED = FUNDER_SEED;

/** How much NIGHT (in the smallest unit) the genesis wallet sends each party. */
// The dev-preset genesis wallet holds 250_000_000_000_000 NIGHT (5 UTxOs of
// 50_000_000_000_000, verified against the running devnet on 2026-09-09).
// 4 parties x 40_000_000_000_000 = 160_000_000_000_000 leaves headroom for fees.
/**
 * When true, every party uses the funder wallet to pay fees instead of its own
 * wallet. A party's on-chain identity is the partySecret proven inside the
 * circuits, not the wallet, so this changes nothing in the protocol — it only
 * links all fee payments to one address. Default on public networks, where a
 * fresh wallet's first sync takes hours per wallet; off on the local devnet.
 */
export const SHARED_FEE_WALLET = env("VEILANCE_SHARED_FEE_WALLET", IS_LOCAL_DEVNET ? "0" : "1") === "1";

/**
 * "0" = the process owns NO wallet at all: nothing is synced, no seed is read,
 * and every transaction's fees are balanced + signed by a browser wallet
 * connected for that party (agent/docs WALLET.md). The process still proves
 * locally and submits the finished transaction to the node. Default "1".
 */
export const AGENT_WALLET = env("VEILANCE_AGENT_WALLET", "1") === "1";

export const FUNDING_AMOUNT = BigInt(env("VEILANCE_FUNDING_AMOUNT", IS_LOCAL_DEVNET ? "40000000000000" : "1000000000"));

/** Private-state store password. Local e2e only — never a real secret. */
export const PRIVATE_STATE_PASSWORD = "Veilance-e2e-2026!LocalOnly#Pw";
