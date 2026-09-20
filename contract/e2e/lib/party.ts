// Veilance — shared `Party` shape and private-state/ledger helpers.
//
// Extracted from e2e/run.ts so the same logic is not forked between the
// devnet e2e script and the long-lived Party Agent (agent/). Both drive the
// exact same three operations against a live devnet:
//   1. hold a party's wallet + midnight-js providers + enc keypair + current
//      VeilancePrivateState together (`Party`);
//   2. write a new VeilancePrivateState to both the in-memory Party AND the
//      party's private state provider in one step (`setPrivateState`) —
//      forgetting the provider half is the classic bug this centralizes away;
//   3. read the contract's public ledger state via the indexer
//      (`currentLedger`) and reduce it to a small JSON-safe snapshot
//      (`snapshotLedger`).

import { ledger as ledgerOf } from "../../src/managed/veilance/contract/index.js";
import type { Ledger } from "../../src/managed/veilance/contract/index.js";
import type { VeilancePrivateState } from "../../src/witnesses.js";
import type { EncKeypair } from "../../src/sealed-entry.js";
import type { PartyName } from "./config.js";
import { VEILANCE_PRIVATE_STATE_ID, type VeilanceProviders } from "./providers.js";
import type { Wallet } from "./wallet.js";

/** Everything one demo participant needs to act against the contract. */
export type Party = {
  readonly name: PartyName;
  /** null when the process runs without its own wallet (VEILANCE_AGENT_WALLET=0). */
  readonly wallet: Wallet | null;
  readonly providers: VeilanceProviders;
  readonly enc: EncKeypair;
  privateState: VeilancePrivateState;
};

/**
 * Writes `state` to both the in-memory `Party` and its private state
 * provider. Circuit calls read private state through the provider (via the
 * witness context), so updating only `party.privateState` without this would
 * silently prove against stale state.
 */
export const setPrivateState = async (party: Party, state: VeilancePrivateState): Promise<void> => {
  party.privateState = state;
  await party.providers.privateStateProvider.set(VEILANCE_PRIVATE_STATE_ID, state);
};

/** Reads and decodes the contract's current public ledger state via the indexer. */
export const currentLedger = async (providers: VeilanceProviders, address: string): Promise<Ledger> => {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (state === null) throw new Error(`contract ${address} not found`);
  return ledgerOf(state.data);
};

/** JSON-safe reduction of a Ledger, for reports and API responses. */
export const snapshotLedger = (l: Ledger) => ({
  adminId: Buffer.from(l.adminId).toString("hex"),
  policyVersion: l.policyVersion.toString(),
  carbonThreshold: l.carbonThreshold.toString(),
  provenanceLeafCount: l.provenanceTree.firstFree().toString(),
  nullifierCount: l.nullifiers.size().toString(),
  attestationCount: l.attestations.size().toString(),
  encKeyCount: l.partyEncKeys.size().toString(),
  inboxCount: l.credentialInboxCount.toString(),
});
