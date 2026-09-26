// Multi-party simulator for the v2 contract — same approach as network.ts:
// one shared ledger state, each party with its own private state, driven
// directly through @midnight-ntwrk/compact-runtime.

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  type ChargedState,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger, type Ledger } from "../src/managed/veilance_v2/contract/index.js";
import { witnessesV2, type V2PrivateState } from "../src/witnesses_v2.js";

const CONTRACT_ADDRESS = dummyContractAddress();
const COIN_PK = "0".repeat(64);

export class PartyV2 {
  constructor(
    readonly name: string,
    public privateState: V2PrivateState,
  ) {}
}

export class NetworkV2 {
  private readonly contract: Contract<V2PrivateState>;

  private constructor(private state: ChargedState) {
    this.contract = new Contract<V2PrivateState>(witnessesV2);
  }

  static async deploy(admin: PartyV2): Promise<NetworkV2> {
    const contract = new Contract<V2PrivateState>(witnessesV2);
    const result = await contract.initialState(createConstructorContext(admin.privateState, COIN_PK));
    return new NetworkV2(result.currentContractState.data);
  }

  ledger(): Ledger {
    return ledger(this.state);
  }

  /** Runs `circuitId` as `party`; commits ledger + private state only on success. */
  async call<R>(circuitId: string, party: PartyV2, ...args: unknown[]): Promise<R> {
    const ctx = createCircuitContext<V2PrivateState>(CONTRACT_ADDRESS, COIN_PK, this.state, party.privateState);
    const circuits = this.contract.circuits as unknown as Record<
      string,
      (c: typeof ctx, ...a: unknown[]) => Promise<{
        result: R;
        context: { currentQueryContext: { state: ChargedState }; currentPrivateState: V2PrivateState };
      }>
    >;
    const res = await circuits[circuitId](ctx, ...args);
    this.state = res.context.currentQueryContext.state;
    party.privateState = res.context.currentPrivateState;
    return res.result;
  }

  registerEncKey = (p: PartyV2, pk: Uint8Array) => this.call<[]>("registerEncKey", p, pk);
  certifyOrigin = (admin: PartyV2, originId: Uint8Array) => this.call<[]>("certifyOrigin", admin, originId);
  certifySupplier = (admin: PartyV2, partyId: Uint8Array, certId: Uint8Array) => this.call<[]>("certifySupplier", admin, partyId, certId);
  setCarbonThreshold = (admin: PartyV2, t: bigint) => this.call<[]>("setCarbonThreshold", admin, t);
  addProcessingRule = (admin: PartyV2, inMat: Uint8Array, outMat: Uint8Array, yieldPct: bigint) =>
    this.call<[]>("addProcessingRule", admin, inMat, outMat, yieldPct);
  issueLot = (p: PartyV2, entry: Uint8Array) => this.call<Uint8Array>("issueLot", p, entry);
  transferLot = (p: PartyV2, entry: Uint8Array) => this.call<[Uint8Array, Uint8Array, Uint8Array]>("transferLot", p, entry);
  processLots = (p: PartyV2) => this.call<[Uint8Array, Uint8Array, Uint8Array]>("processLots", p);
  certifyRecycler = (admin: PartyV2, partyId: Uint8Array, certId: Uint8Array, isEu: boolean) =>
    this.call<[]>("certifyRecycler", admin, partyId, certId, isEu);
  issueRecycledLot = (p: PartyV2, entry: Uint8Array) => this.call<Uint8Array>("issueRecycledLot", p, entry);
  openPeriod = (p: PartyV2, plantId: Uint8Array, period: bigint, material: Uint8Array) =>
    this.call<Uint8Array>("openPeriod", p, plantId, period, material);
  consumeIntoPeriod = (p: PartyV2) => this.call<[Uint8Array, Uint8Array, Uint8Array]>("consumeIntoPeriod", p);
  declareShare = (p: PartyV2, plantId: Uint8Array, period: bigint, material: Uint8Array, bps: bigint) =>
    this.call<[]>("declareShare", p, plantId, period, material, bps);
  attestOrder = (p: PartyV2, challenge: Uint8Array, minQuantity: bigint) =>
    this.call<[Uint8Array, Uint8Array]>("attestOrder", p, challenge, minQuantity);
}
