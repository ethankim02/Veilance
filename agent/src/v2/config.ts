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
