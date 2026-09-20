// Veilance Party Agent — configuration.
//
// Network/devnet endpoints, wallet seeds, and the ZK config directory are
// all reused verbatim from contract/e2e/lib/config.ts (same devnet, same
// four demo parties, same funded wallets) — never forked. This file adds
// only what is specific to the agent process itself: the HTTP port, the CORS
// origin, and this agent's OWN state directory (kept separate from the e2e
// script's `contract/e2e/.state` so the two never contend for the same
// LevelDB private-state files).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARTY_NAMES as ALL_PARTY_NAMES, type PartyName as PartyNameType } from "../../contract/e2e/lib/config.js";

export {
  NETWORK_ID,
  NODE_URL,
  NODE_WS_URL,
  INDEXER_HTTP_URL,
  INDEXER_WS_URL,
  PROOF_SERVER_URL,
  PARTY_NAMES,
  WALLET_SEEDS,
  GENESIS_WALLET_SEED,
  FUNDER_SEED,
  IS_LOCAL_DEVNET,
  SHARED_FEE_WALLET,
  AGENT_WALLET,
  FUNDING_AMOUNT,
  ZK_CONFIG_DIR,
  PRIVATE_STATE_PASSWORD,
  type PartyName,
} from "../../contract/e2e/lib/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(here, "..");
import { NETWORK_ID as _NET } from "../../contract/e2e/lib/config.js";
// Local devnet keeps the historical `.state`; every other network gets its own
// directory so a testnet deployment never mixes with devnet vaults.
// `AGENT_STATE_DIR` env override: lets a throwaway verification instance
// (e.g. `PORT=4010 AGENT_STATE_DIR=/tmp/... npx tsx src/index.ts`) boot
// without ever touching a real `.state/preprod` another process is using —
// see docs/WALLET.md's "what was and wasn't exercised" section.
const AGENT_STATE_DIR_OVERRIDE = process.env.AGENT_STATE_DIR?.trim();
export const AGENT_STATE_DIR = AGENT_STATE_DIR_OVERRIDE
  ? path.resolve(AGENT_STATE_DIR_OVERRIDE)
  : _NET === "undeployed"
    ? path.join(AGENT_DIR, ".state")
    : path.join(AGENT_DIR, ".state", _NET);
export const DEPLOYMENT_JSON_PATH = path.join(AGENT_STATE_DIR, "deployment.json");
export const CHALLENGES_JSON_PATH = path.join(AGENT_STATE_DIR, "challenges.json");
export const REGISTRY_SEED_PATH = path.join(AGENT_DIR, "registry.json");
export const REGISTRY_RUNTIME_JSON_PATH = path.join(AGENT_STATE_DIR, "registry-runtime.json");

export const PORT = Number(process.env.PORT ?? 4000);
// Comma-separated list. Both spellings of the dev origin are allowed by default so a
// browser opened on 127.0.0.1 is not rejected.
export const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173";
export const CORS_ORIGINS = CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Per-company agent separation (roadmap milestone 1, see HANDOFF.md §4).
//
// The demo runs one process hosting all four parties. In production each
// enterprise runs its own agent hosting exactly one party (see agent/API.md's
// opening paragraph) — `AGENT_PARTIES` is what switches between the two:
// unset, it defaults to every party (today's demo/Preprod behavior,
// unchanged); set to a comma-separated subset (e.g. `AGENT_PARTIES=mine`),
// bootstrap.ts only builds wallets/providers for that subset, so this
// process never touches the other companies' secrets. Every route that
// resolves a party through `appState.parties` (i.e. every route except
// `/admin/suppliers`, which also needs OTHER companies' public partyId — see
// registry.ts's `partyId()`) is automatically scoped by this: a party this
// process does not host is simply not in that map.
const isKnownParty = (s: string): s is PartyNameType => (ALL_PARTY_NAMES as readonly string[]).includes(s);
const AGENT_PARTIES_RAW = process.env.AGENT_PARTIES?.trim();
export const HOSTED_PARTIES: readonly PartyNameType[] = AGENT_PARTIES_RAW
  ? (() => {
      const names = AGENT_PARTIES_RAW.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = names.filter((n) => !isKnownParty(n));
      if (unknown.length > 0) {
        throw new Error(
          `AGENT_PARTIES contains unknown part${unknown.length > 1 ? "ies" : "y"} name(s): ${unknown.join(", ")}. ` +
            `Valid names: ${ALL_PARTY_NAMES.join(", ")}.`,
        );
      }
      if (names.length === 0) throw new Error("AGENT_PARTIES is set but empty — unset it to host every party, or list at least one.");
      return names as PartyNameType[];
    })()
  : ALL_PARTY_NAMES;

// A single-company agent doesn't deploy the contract (only `admin` does, via
// `POST /deploy`) — it needs to be told where the contract already lives.
// If set and no `agent/.state/.../deployment.json` exists yet, bootstrap.ts
// attaches every hosted party to this address and persists it, exactly as if
// `POST /deploy` had been called locally.
export const CONTRACT_ADDRESS_OVERRIDE = process.env.AGENT_CONTRACT_ADDRESS?.trim() || undefined;

// ---------------------------------------------------------------------------
// Delegated wallet (v1.4 addendum, see agent/API.md and docs/WALLET.md).
// ---------------------------------------------------------------------------

/**
 * Enables `POST /wallet/dev-balance-submit`, a dev-only endpoint that lets
 * `web/src/lib/devWallet.ts`'s fake `window.midnight.veilanceDev` exercise
 * the full delegated-wallet round trip without a real Lace install: it
 * balances (and signs/binds) a parked job's transaction using the SAME
 * party's own headless agent wallet, standing in for what a real browser
 * wallet's `balanceUnsealedTransaction` would do. Off by default — this
 * endpoint would let anyone who can reach the agent's HTTP port balance
 * (though not submit without also hitting `/jobs/:id/wallet-result`)
 * arbitrary transactions using a party's real wallet.
 */
export const DEV_WALLET_ENABLED = process.env.VEILANCE_DEV_WALLET === "1";
