// Veilance B-2 — configuration for the v2 node and the fee sponsor
// (docs/PLATFORM_LAYER.md, agent/API_V2.md).
//
// Two roles, runnable as one process or two:
//   node    — hosted by a platform or a company. Holds each tenant's party
//             secret, builds and proves v2 transactions, owns NO wallet.
//   sponsor — run by the operator. Owns the fee wallet, only balances
//             proven transactions it is handed. Never sees a party secret.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_STATE_DIR, CORS_ORIGINS } from "../config.js";
import { IS_LOCAL_DEVNET } from "../../../contract/e2e/lib/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const env = (name: string, fallback: string): string => {
  const v = process.env[name]?.trim();
  return v === undefined || v === "" ? fallback : v;
};

export type V2Role = "node" | "sponsor" | "both";

export const V2_ROLE = env("VEILANCE_V2_ROLE", "both") as V2Role;
if (!["node", "sponsor", "both"].includes(V2_ROLE)) throw new Error(`VEILANCE_V2_ROLE must be node|sponsor|both, got "${V2_ROLE}"`);

export const V2_PORT = Number(env("VEILANCE_V2_PORT", "4100"));

/** Tenants, their vaults and private state. One directory per node. */
export const V2_STATE_DIR = path.resolve(env("VEILANCE_V2_STATE_DIR", path.join(AGENT_STATE_DIR, "v2")));

/** Compiled v2 contract (keys/, zkir/) — `npm run compile:zk:v2` in contract/. */
export const ZK_V2_DIR = path.resolve(here, "../../../contract/src/managed/veilance_v2");

/** Where a node reaches its sponsor. Defaults to itself when running both roles. */
export const SPONSOR_URL = env("VEILANCE_SPONSOR_URL", `http://localhost:${V2_PORT}`);

/**
 * Shared secret a node presents to the sponsor. The sponsor is a paid
 * service: it must not balance transactions for anyone who asks.
 */
export const SPONSOR_TOKEN = env("VEILANCE_SPONSOR_TOKEN", IS_LOCAL_DEVNET ? "local-dev-sponsor-token" : "");

/** Seed of the sponsor's fee wallet. Local devnet: a fixed dev seed, funded from genesis at boot. */
export const SPONSOR_SEED = env(
  "VEILANCE_SPONSOR_SEED",
  IS_LOCAL_DEVNET ? "5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e0a5e01" : "",
);

export { CORS_ORIGINS };

/**
 * Node master key (64 hex): encrypts party secrets and receiving keys inside
 * tenant files. Local devnet: generated once into <state>/master-key (0600).
 * Elsewhere it must be provided — losing it makes the tenants unrecoverable.
 */
export const MASTER_KEY_HEX = process.env.VEILANCE_V2_MASTER_KEY?.trim() || "";

/**
 * Password for each tenant's private-state database (witness state includes
 * the party secret). Local devnet keeps the historical dev password so
 * existing local tenants stay readable; elsewhere it must be provided.
 */
export const V2_STATE_PASSWORD = env(
  "VEILANCE_V2_STATE_PASSWORD",
  IS_LOCAL_DEVNET ? "Veilance-e2e-2026!LocalOnly#Pw" : "",
);

/**
 * Per-node sponsor credentials: "nodeA:token1,nodeB:token2". When unset, the
 * single VEILANCE_SPONSOR_TOKEN is accepted under the name "default".
 */
export const SPONSOR_TOKENS: ReadonlyMap<string, string> = (() => {
  const raw = process.env.VEILANCE_SPONSOR_TOKENS?.trim();
  const m = new Map<string, string>(); // token -> node name
  if (raw) {
    for (const pair of raw.split(",")) {
      const [name, token] = pair.split(":").map((x) => x.trim());
      if (!name || !token) throw new Error(`VEILANCE_SPONSOR_TOKENS: bad entry "${pair}" (want name:token)`);
      m.set(token, name);
    }
  } else if (SPONSOR_TOKEN) {
    m.set(SPONSOR_TOKEN, "default");
  }
  return m;
})();

/** Balanced transactions allowed per node per UTC day; 0 = unlimited. */
export const SPONSOR_DAILY_LIMIT = Number(env("VEILANCE_SPONSOR_DAILY_LIMIT", "0"));

/**
 * Jobs a node runs at once. Each tenant's own jobs always stay in order;
 * with N > 1, different tenants' jobs prove in parallel.
 *
 * Keep it at 1 for the v2 contract. Measured on the local devnet: two issues
 * proven in parallel both landed, but the second failed its fallible section
 * ("FailFallible") and still paid its fee — every v2 operation writes shared
 * state (provenance-tree index, inbox counter), so a transaction proven
 * against a state that has since moved no longer matches its transcript.
 * Higher throughput needs a contract without those shared write points.
 */
export const V2_CONCURRENCY = Math.max(1, Number(env("VEILANCE_V2_CONCURRENCY", "1")));
