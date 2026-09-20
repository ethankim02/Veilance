// Veilance e2e — MidnightProviders assembly, one set per party.
//
// Follows the 6-provider pattern from the `midnight-dapp-dev:core` /
// `midnight-js` skills: private state, public data (indexer), ZK config,
// proof, wallet, midnight. Each party gets its OWN private state provider,
// backed by a LevelDB database under e2e/.state/<party>/ — exactly how a
// real multi-party DApp keeps one browser tab's / one machine's private
// state from leaking into another's.

import path from "node:path";
import { Level } from "level";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import type { VeilancePrivateState } from "../../src/witnesses.js";
import {
  INDEXER_HTTP_URL,
  INDEXER_WS_URL,
  PROOF_SERVER_URL,
  PRIVATE_STATE_PASSWORD,
  STATE_DIR,
  ZK_CONFIG_DIR,
  type PartyName,
} from "./config.js";
import { asMidnightJsProvider, makeWalletlessProvider, type Wallet } from "./wallet.js";

export const VEILANCE_PRIVATE_STATE_ID = "veilancePrivateState" as const;
export type VeilancePrivateStateId = typeof VEILANCE_PRIVATE_STATE_ID;

/** The circuit ids exported by veilance.compact, matching src/managed/veilance/contract's ImpureCircuits. */
export type VeilanceCircuitId =
  | "registerEncKey"
  | "certifyOrigin"
  | "certifySupplier"
  | "setCarbonThreshold"
  | "issueProvenance"
  | "transferProvenance"
  | "attestConsumer"
  | "attestProcurement"
  | "attestRegulator";

export type VeilanceProviders = MidnightProviders<
  VeilanceCircuitId,
  VeilancePrivateStateId,
  VeilancePrivateState
>;

/**
 * Builds the full provider set for one party. Each call opens its own
 * LevelDB database at `e2e/.state/<party>/veilance-private-state`, isolated
 * from every other party's — the `levelFactory` hook is what makes the
 * per-party directory (rather than a single shared LevelDB keyed only by
 * account id) explicit and inspectable.
 */
export type BuildProvidersOptions = {
  /**
   * Root directory each party's LevelDB private-state directory is nested
   * under (`<baseStateDir>/<party>`). Defaults to the e2e script's own
   * `STATE_DIR` (`e2e/.state`). The Party Agent passes its own
   * `agent/.state` here so its private state never collides with (or
   * overwrites) the e2e script's — same wallet seeds, separate storage.
   */
  readonly baseStateDir?: string;
  /**
   * Account id the private state provider scopes its password-derived
   * storage under. Defaults to the bare party name (matching the e2e
   * script's historical behavior). The agent passes a distinct id (e.g.
   * `agent-mine`) purely for clarity — the LevelDB directory is already
   * isolated via `baseStateDir`.
   */
  readonly accountId?: string;
};

export const buildProviders = async (
  party: PartyName,
  wallet: Wallet | null,
  options: BuildProvidersOptions = {},
): Promise<VeilanceProviders> => {
  const baseStateDir = options.baseStateDir ?? STATE_DIR;
  const accountId = options.accountId ?? party;
  const partyDir = path.join(baseStateDir, party);

  const zkConfigProvider = new NodeZkConfigProvider<VeilanceCircuitId>(ZK_CONFIG_DIR);

  const publicDataProvider = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);

  const proofProvider = httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider);

  const privateStateProvider = levelPrivateStateProvider<VeilancePrivateStateId, VeilancePrivateState>(
    {
      accountId,
      privateStoragePasswordProvider: () => PRIVATE_STATE_PASSWORD,
      // `Level` (from the `level` package) structurally extends the provider's
      // own `DatabaseLevel = AbstractLevel<...>` alias, but its generic
      // self-referential methods (e.g. sublevel/batch) make TS see the two
      // `abstract-level` instantiations as invariant-incompatible even though
      // they resolve to the same installed package and are the exact type the
      // option is documented to take. Runtime behavior is unaffected.
      levelFactory: (dbName: string) => new Level(path.join(partyDir, dbName)) as never,
    },
  );

  const walletAndMidnightProvider = wallet ? await asMidnightJsProvider(wallet) : makeWalletlessProvider(party);

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};
