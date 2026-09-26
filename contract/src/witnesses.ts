// Veilance — TypeScript witness implementations (layer L2: each participant's
// local private state).
//
// Every witness here runs on the prover's own machine. Nothing it returns
// reaches the chain unless a circuit explicitly `disclose()`s it. In particular
// the Merkle paths produced below are the mechanism that keeps the supplier
// graph private: the circuit proves "this commitment is in the tree" without the
// commitment (or its index) ever appearing in the transcript.

import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { MerkleTreePath } from "@midnight-ntwrk/compact-runtime";
import {
  pureCircuits,
  type Credential,
  type Ledger,
  type MaterialSpec,
} from "./managed/veilance/contract/index.js";

export type { Credential, MaterialSpec };

/** 32 zero bytes — the neutral value for unset `Bytes<32>` fields. */
export const ZERO_32 = (): Uint8Array => new Uint8Array(32);

/**
 * One participant's local state.
 *
 * `held` / `issueSpec` are mutually exclusive per operation:
 *  - issuing a root credential  -> `issueSpec` set, `held` null
 *  - transferring / attesting   -> `held` set, `issueSpec` null
 *
 * Use {@link forIssue}, {@link forTransfer} and {@link forHold} rather than
 * building the object by hand, so that invariant is enforced in one place.
 */
export type VeilancePrivateState = {
  /** The party's root secret. `partyId = H("veilance:id", partySecret)`. Never leaves this machine. */
  readonly partySecret: Uint8Array;
  /** The party's certification id; `certLeaf = H("veilance:cert", partyId, certId)`. */
  readonly certId: Uint8Array;
  /** The provenance credential this party currently holds, if any. */
  readonly held: Credential | null;
  /** The material a root party is about to issue, if any. */
  readonly issueSpec: MaterialSpec | null;
  /** Downstream recipient's partyId for the credential being minted. */
  readonly recipientId: Uint8Array;
  /** Carbon class of the credential being minted (transfer only). */
  readonly newCarbonClass: bigint;
  /** Fresh randomness for the credential being minted — makes the new commitment unlinkable. */
  readonly newBatchSecret: Uint8Array;
};

/** Build a party's baseline private state (no pending operation). */
export const createVeilancePrivateState = (
  partySecret: Uint8Array,
  certId: Uint8Array = ZERO_32(),
): VeilancePrivateState => ({
  partySecret,
  certId,
  held: null,
  issueSpec: null,
  recipientId: ZERO_32(),
  newCarbonClass: 0n,
  newBatchSecret: ZERO_32(),
});

/** The party's on-chain pseudonymous id. */
export const partyIdOf = (partySecret: Uint8Array): Uint8Array =>
  pureCircuits.partyIdOf(partySecret);

/** Prime the state for `issueProvenance()`. */
export const forIssue = (
  base: VeilancePrivateState,
  issueSpec: MaterialSpec,
  recipientId: Uint8Array,
): VeilancePrivateState => ({
  ...base,
  held: null,
  issueSpec,
  recipientId,
});

/** Prime the state for `transferProvenance()`. */
export const forTransfer = (
  base: VeilancePrivateState,
  held: Credential,
  recipientId: Uint8Array,
  newCarbonClass: bigint,
  newBatchSecret: Uint8Array,
): VeilancePrivateState => ({
  ...base,
  held,
  issueSpec: null,
  recipientId,
  newCarbonClass,
  newBatchSecret,
});

/**
 * Prime the state with a held credential only. The attest* circuits also
 * rotate the credential and read `newBatchSecret` — use {@link forAttest}
 * for them; `forHold` leaves whatever secret `base` carries.
 */
export const forHold = (
  base: VeilancePrivateState,
  held: Credential,
): VeilancePrivateState => ({
  ...base,
  held,
  issueSpec: null,
});

/**
 * Prime the state for the attest* circuits. They spend `held` and re-mint it
 * to the same owner under `newBatchSecret` (rotate-on-attest), so the caller
 * must pick fresh randomness and, on success, keep {@link rotated} as the
 * credential it now holds.
 */
export const forAttest = (
  base: VeilancePrivateState,
  held: Credential,
  newBatchSecret: Uint8Array,
): VeilancePrivateState => ({
  ...base,
  held,
  issueSpec: null,
  newBatchSecret,
});

/** The credential an attest* call leaves the holder with: same fields, new secret. */
export const rotated = (held: Credential, newBatchSecret: Uint8Array): Credential => ({
  ...held,
  batchSecret: newBatchSecret,
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Tree = {
  findPathForLeaf(leaf: Uint8Array): MerkleTreePath<Uint8Array> | undefined;
};

/** Tree depths — must stay in sync with the ledger declarations in veilance.compact. */
const ALLOWLIST_DEPTH = 8; // certifiedOrigins, certifiedSuppliers
const PROVENANCE_DEPTH = 16; // provenanceTree

/**
 * A well-formed but non-verifying path for a leaf that is not in the tree.
 * All siblings are the zero digest, so the recomputed root cannot match any
 * real root. This keeps "not certified" / "not in the tree" a *circuit*
 * rejection with the protocol's own error message, instead of the witness
 * throwing locally (`pathForLeaf` refuses indices past the tree's frontier).
 */
const absentPath = (leaf: Uint8Array, depth: number): MerkleTreePath<Uint8Array> => ({
  leaf,
  path: Array.from({ length: depth }, () => ({
    sibling: { field: 0n },
    goes_left: false,
  })),
});

/** Authentication path for `leaf`, or a deliberately non-verifying one if absent. */
const pathFor = (
  tree: Tree,
  leaf: Uint8Array,
  depth: number,
): MerkleTreePath<Uint8Array> => tree.findPathForLeaf(leaf) ?? absentPath(leaf, depth);

const requireHeld = (ps: VeilancePrivateState, who: string): Credential => {
  if (ps.held === null) {
    throw new Error(`veilance witness: ${who} requires a held credential in private state`);
  }
  return ps.held;
};

/** Which origin the current operation is proving: the issued one, else the held one. */
const activeOriginId = (ps: VeilancePrivateState): Uint8Array => {
  if (ps.issueSpec !== null) return ps.issueSpec.originId;
  if (ps.held !== null) return ps.held.originId;
  throw new Error("veilance witness: originPath requires either issueSpec or held in private state");
};

type Ctx = WitnessContext<Ledger, VeilancePrivateState>;

// ---------------------------------------------------------------------------
// Witnesses — keys must match the `witness` declarations in veilance.compact
// ---------------------------------------------------------------------------

export const witnesses = {
  adminSecret: ({ privateState }: Ctx): [VeilancePrivateState, Uint8Array] => [
    privateState,
    privateState.partySecret,
  ],

  ownerSecret: ({ privateState }: Ctx): [VeilancePrivateState, Uint8Array] => [
    privateState,
    privateState.partySecret,
  ],

  certId: ({ privateState }: Ctx): [VeilancePrivateState, Uint8Array] => [
    privateState,
    privateState.certId,
  ],

  certPath: ({
    ledger,
    privateState,
  }: Ctx): [VeilancePrivateState, MerkleTreePath<Uint8Array>] => {
    const partyId = pureCircuits.partyIdOf(privateState.partySecret);
    const certLeaf = pureCircuits.certLeafOf(partyId, privateState.certId);
    return [privateState, pathFor(ledger.certifiedSuppliers, certLeaf, ALLOWLIST_DEPTH)];
  },

  originPath: ({
    ledger,
    privateState,
  }: Ctx): [VeilancePrivateState, MerkleTreePath<Uint8Array>] => [
    privateState,
    pathFor(ledger.certifiedOrigins, activeOriginId(privateState), ALLOWLIST_DEPTH),
  ],

  heldCredential: ({ privateState }: Ctx): [VeilancePrivateState, Credential] => [
    privateState,
    requireHeld(privateState, "heldCredential"),
  ],

  commitmentPath: ({
    ledger,
    privateState,
  }: Ctx): [VeilancePrivateState, MerkleTreePath<Uint8Array>] => {
    const commitment = pureCircuits.commitmentOf(requireHeld(privateState, "commitmentPath"));
    return [privateState, pathFor(ledger.provenanceTree, commitment, PROVENANCE_DEPTH)];
  },

  issuedMaterial: ({ privateState }: Ctx): [VeilancePrivateState, MaterialSpec] => {
    if (privateState.issueSpec === null) {
      throw new Error("veilance witness: issuedMaterial requires issueSpec in private state");
    }
    return [privateState, privateState.issueSpec];
  },

  recipientId: ({ privateState }: Ctx): [VeilancePrivateState, Uint8Array] => [
    privateState,
    privateState.recipientId,
  ],

  newBatchSecret: ({ privateState }: Ctx): [VeilancePrivateState, Uint8Array] => [
    privateState,
    privateState.newBatchSecret,
  ],

  newCarbonClass: ({ privateState }: Ctx): [VeilancePrivateState, bigint] => [
    privateState,
    privateState.newCarbonClass,
  ],
};
