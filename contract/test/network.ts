// A minimal multi-party simulator for the Veilance contract, driven directly
// through @midnight-ntwrk/compact-runtime — no external simulator framework.
//
// The chain is shared: one ledger state that every party mutates. Each party
// keeps its OWN private state (its secret, its credential, its pending
// operation), exactly as it would in production. `net.issueProvenance(mine)`
// runs the circuit with that party's witnesses bound.

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  type ChargedState,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  ledger,
  type Ledger,
} from "../src/managed/veilance/contract/index.js";
import { witnesses, type VeilancePrivateState } from "../src/witnesses.js";

const CONTRACT_ADDRESS = dummyContractAddress();
const COIN_PK = "0".repeat(64);

/** A participant: a name plus its local private state. */
export class Party {
  constructor(
    readonly name: string,
    public privateState: VeilancePrivateState,
  ) {}
}

/** Swap in a malicious/instrumented witness for a security test. */
export type WitnessOverrides = Partial<typeof witnesses>;

export class VeilanceNetwork {
  private readonly contract: Contract<VeilancePrivateState>;

  private constructor(
    private state: ChargedState,
    overrides: WitnessOverrides,
  ) {
    this.contract = new Contract<VeilancePrivateState>({ ...witnesses, ...overrides });
  }

  /** Deploy the contract. The deployer's secret becomes `adminId`. */
  static async deploy(
    admin: Party,
    overrides: WitnessOverrides = {},
  ): Promise<VeilanceNetwork> {
    const contract = new Contract<VeilancePrivateState>({ ...witnesses, ...overrides });
    const result = await contract.initialState(
      createConstructorContext(admin.privateState, COIN_PK),
    );
    return new VeilanceNetwork(result.currentContractState.data, overrides);
  }

  /** Current public ledger view — everything an outside observer can see. */
  ledger(): Ledger {
    return ledger(this.state);
  }

  /**
   * Run `circuitId` as `party`. On success the shared ledger state and the
   * party's private state are committed; on failure NOTHING is committed, which
   * is what a rejected transaction looks like on chain.
   */
  async call<R>(circuitId: string, party: Party, ...args: unknown[]): Promise<R> {
    // NOTE: compact-runtime 0.16.0's `createCircuitContext` dropped the
    // leading `circuitId` parameter that the previous toolchain (compiler
    // 0.34.0 / runtime 0.19.0) took — confirmed against
    // node_modules/@midnight-ntwrk/compact-runtime/dist/circuit-context.d.ts.
    // The circuit is still selected by name below via `circuits[circuitId]`;
    // the context itself just no longer carries that name.
    const ctx = createCircuitContext<VeilancePrivateState>(
      CONTRACT_ADDRESS,
      COIN_PK,
      this.state,
      party.privateState,
    );
    // NOTE: compact-runtime 0.16.0's `CircuitContext` is flat — no
    // `callContext` wrapper around `currentQueryContext` /
    // `currentPrivateState` the way the previous toolchain's shape had.
    // Confirmed against
    // node_modules/@midnight-ntwrk/compact-runtime/dist/circuit-context.d.ts.
    const circuits = this.contract.circuits as unknown as Record<
      string,
      (
        c: typeof ctx,
        ...a: unknown[]
      ) => Promise<{
        result: R;
        context: {
          currentQueryContext: { state: ChargedState };
          currentPrivateState: VeilancePrivateState;
        };
      }>
    >;
    const res = await circuits[circuitId](ctx, ...args);
    this.state = res.context.currentQueryContext.state;
    party.privateState = res.context.currentPrivateState;
    return res.result;
  }

  // --- typed convenience wrappers -----------------------------------------

  certifyOrigin(admin: Party, originId: Uint8Array): Promise<[]> {
    return this.call("certifyOrigin", admin, originId);
  }

  certifySupplier(admin: Party, partyId: Uint8Array, certId: Uint8Array): Promise<[]> {
    return this.call("certifySupplier", admin, partyId, certId);
  }

  setCarbonThreshold(admin: Party, t: bigint): Promise<[]> {
    return this.call("setCarbonThreshold", admin, t);
  }

  registerEncKey(party: Party, encPk: Uint8Array): Promise<[]> {
    return this.call("registerEncKey", party, encPk);
  }

  issueProvenance(party: Party, entry: Uint8Array): Promise<Uint8Array> {
    return this.call("issueProvenance", party, entry);
  }

  transferProvenance(party: Party, entry: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    return this.call("transferProvenance", party, entry);
  }

  /**
   * Rotate-on-attest: every attest* circuit spends the held credential and
   * re-mints it under `newBatchSecret`. Like a real holder, pick fresh
   * randomness before the call and, only if the call succeeds, keep the
   * rotated credential as the one now held. Returns [nullifier, newCommitment].
   */
  private async attest(circuit: string, party: Party, challenge: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    const held = party.privateState.held;
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    party.privateState = { ...party.privateState, newBatchSecret: fresh };
    const out = await this.call<[Uint8Array, Uint8Array]>(circuit, party, challenge);
    if (held) party.privateState = { ...party.privateState, held: { ...held, batchSecret: fresh } };
    return out;
  }

  attestConsumer(party: Party, challenge: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    return this.attest("attestConsumer", party, challenge);
  }

  attestProcurement(party: Party, challenge: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    return this.attest("attestProcurement", party, challenge);
  }

  attestRegulator(party: Party, challenge: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    return this.attest("attestRegulator", party, challenge);
  }
}

/** A deterministic 32-byte value derived from a label — readable test fixtures. */
export const bytes32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  const src = new TextEncoder().encode(label);
  if (src.length > 32) throw new Error(`label too long for Bytes<32>: ${label}`);
  out.set(src);
  return out;
};

export const hex = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");

/** Everything publicly observable — used for "the ledger did not change" assertions. */
export const snapshot = (l: Ledger) => ({
  adminId: hex(l.adminId),
  policyVersion: l.policyVersion,
  carbonThreshold: l.carbonThreshold,
  certifiedOriginsRoot: l.certifiedOrigins.root().field,
  certifiedSuppliersRoot: l.certifiedSuppliers.root().field,
  provenanceRoot: l.provenanceTree.root().field,
  provenanceLeafCount: l.provenanceTree.firstFree(),
  nullifierCount: l.nullifiers.size(),
  attestationCount: l.attestations.size(),
  encKeyCount: l.partyEncKeys.size(),
  inboxCount: l.credentialInboxCount,
  // The inbox itself, byte for byte — a rejected call must not append.
  inbox: [...l.credentialInbox].map(([i, e]) => `${i}:${hex(e)}`),
});
