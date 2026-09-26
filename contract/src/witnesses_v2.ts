// Veilance v2 — TypeScript witnesses (docs/PROVENANCE_V2.md).
//
// Same rules as v1's witnesses.ts: everything here runs on the prover's own
// machine and reaches the chain only where a circuit disclose()s it. Use the
// `for*` helpers to prime the private state for one operation.

import type { MerkleTreePath, WitnessContext } from "@midnight-ntwrk/compact-runtime";
import {
  pureCircuits,
  type IssueSpec,
  type Ledger,
  type Lot,
  type OriginSlot,
  type PeriodAccount,
} from "./managed/veilance_v2/contract/index.js";

export type { IssueSpec, Lot, OriginSlot, PeriodAccount };

export const ZERO_32 = (): Uint8Array => new Uint8Array(32);
export const EMPTY_SLOT = (): OriginSlot => ({ originId: ZERO_32(), issuerId: ZERO_32() });

export const CUSTODY = { identityPreserved: 1n, segregated: 2n, massBalance: 3n } as const;

export type ProcessingRule = { inMaterial: Uint8Array; outMaterial: Uint8Array; yieldPct: bigint };

export type V2PrivateState = {
  readonly partySecret: Uint8Array;
  readonly certId: Uint8Array;
  /** The lot being spent/proven (transfer, attest) or the first input (process). */
  readonly held: Lot | null;
  /** Second input of processLots. */
  readonly second: Lot | null;
  readonly issueSpec: IssueSpec | null;
  readonly recipientId: Uint8Array;
  readonly outQuantity: bigint;
  readonly newCarbonClass: bigint;
  readonly newBatchSecret: Uint8Array;
  readonly changeBatchSecret: Uint8Array;
  readonly outMaterial: Uint8Array;
  readonly outCustody: bigint;
  readonly outOrigins: OriginSlot[];
  readonly rule: ProcessingRule | null;
  /** Which origin slots `originPaths` proves for the current operation. */
  readonly proveOrigins: OriginSlot[] | null;
  /** issueRecycledLot: the EU flag on this party's recycler certificate. */
  readonly recyclerIsEu: boolean;
  /** Recycled share assigned to the sent (transfer) or produced (process) lot. */
  readonly outRecycledEu: bigint;
  readonly outRecycledOther: bigint;
  /** consumeIntoPeriod / declareShare: the account being spent. */
  readonly account: PeriodAccount | null;
  /** declareShare: salt of the total commitment, later handed to the notified body. */
  readonly declareSalt: Uint8Array;
};

export const createV2PrivateState = (partySecret: Uint8Array, certId: Uint8Array = ZERO_32()): V2PrivateState => ({
  partySecret,
  certId,
  held: null,
  second: null,
  issueSpec: null,
  recipientId: ZERO_32(),
  outQuantity: 0n,
  newCarbonClass: 0n,
  newBatchSecret: ZERO_32(),
  changeBatchSecret: ZERO_32(),
  outMaterial: ZERO_32(),
  outCustody: 0n,
  outOrigins: [EMPTY_SLOT(), EMPTY_SLOT()],
  rule: null,
  proveOrigins: null,
  recyclerIsEu: false,
  outRecycledEu: 0n,
  outRecycledOther: 0n,
  account: null,
  declareSalt: ZERO_32(),
});

export const partyIdOf = (partySecret: Uint8Array): Uint8Array => pureCircuits.partyIdOf(partySecret);

/** The origin slots issueLot will write: the issuer's own id in slot 0. */
export const issuedOrigins = (spec: IssueSpec, issuerSecret: Uint8Array): OriginSlot[] => [
  { originId: spec.originId, issuerId: partyIdOf(issuerSecret) },
  EMPTY_SLOT(),
];

export const forIssue = (base: V2PrivateState, spec: IssueSpec, recipientId: Uint8Array): V2PrivateState => ({
  ...base,
  held: null,
  second: null,
  issueSpec: spec,
  recipientId,
  proveOrigins: issuedOrigins(spec, base.partySecret),
});

/** Prime issueRecycledLot. `isEu` must match the recycler certificate, or the circuit rejects. */
export const forIssueRecycled = (base: V2PrivateState, spec: IssueSpec, recipientId: Uint8Array, isEu: boolean): V2PrivateState => ({
  ...forIssue(base, spec, recipientId),
  recyclerIsEu: isEu,
});

/** Recycled share proportional to the sent quantity (floor) — the default allocation. */
export const proportionalRecycled = (held: Lot, quantity: bigint): { eu: bigint; other: bigint } => ({
  eu: held.quantity === 0n ? 0n : (held.recycledEuKg * quantity) / held.quantity,
  other: held.quantity === 0n ? 0n : (held.recycledOtherKg * quantity) / held.quantity,
});

export const forTransfer = (
  base: V2PrivateState,
  held: Lot,
  recipientId: Uint8Array,
  outQuantity: bigint,
  newCarbonClass: bigint,
  newBatchSecret: Uint8Array,
  changeBatchSecret: Uint8Array,
  recycled: { eu: bigint; other: bigint } = proportionalRecycled(held, outQuantity),
): V2PrivateState => ({
  ...base,
  held,
  second: null,
  issueSpec: null,
  recipientId,
  outQuantity,
  newCarbonClass,
  newBatchSecret,
  changeBatchSecret,
  outRecycledEu: recycled.eu,
  outRecycledOther: recycled.other,
  proveOrigins: held.origins,
});

export const forProcess = (
  base: V2PrivateState,
  a: Lot,
  b: Lot,
  out: {
    material: Uint8Array;
    quantity: bigint;
    carbonClass: bigint;
    custody: bigint;
    origins: OriginSlot[];
    batchSecret: Uint8Array;
    recycledEu?: bigint;
    recycledOther?: bigint;
  },
  rule: ProcessingRule,
): V2PrivateState => ({
  ...base,
  held: a,
  second: b,
  issueSpec: null,
  // Default: the largest share the circuit's ratio cap allows.
  outRecycledEu: out.recycledEu ?? ((a.recycledEuKg + b.recycledEuKg) * out.quantity) / (a.quantity + b.quantity),
  outRecycledOther: out.recycledOther ?? ((a.recycledOtherKg + b.recycledOtherKg) * out.quantity) / (a.quantity + b.quantity),
  outMaterial: out.material,
  outQuantity: out.quantity,
  newCarbonClass: out.carbonClass,
  outCustody: out.custody,
  outOrigins: out.origins,
  newBatchSecret: out.batchSecret,
  rule,
  proveOrigins: out.origins,
});

export const forAttest = (base: V2PrivateState, held: Lot, newBatchSecret: Uint8Array): V2PrivateState => ({
  ...base,
  held,
  second: null,
  issueSpec: null,
  newBatchSecret,
  proveOrigins: held.origins,
});

/** openPeriod: `newBatchSecret` becomes the fresh account's secret. */
export const forOpenPeriod = (base: V2PrivateState, secret: Uint8Array): V2PrivateState => ({ ...base, newBatchSecret: secret });

export const forConsume = (base: V2PrivateState, held: Lot, account: PeriodAccount, newSecret: Uint8Array): V2PrivateState => ({
  ...base,
  held,
  second: null,
  issueSpec: null,
  account,
  newBatchSecret: newSecret,
});

export const forDeclare = (base: V2PrivateState, account: PeriodAccount, salt: Uint8Array): V2PrivateState => ({ ...base, account, declareSalt: salt });

/** What a notified body runs after the manufacturer hands over (totalKg, salt). */
export const checkDeclaredTotal = (totalCommit: Uint8Array, totalKg: bigint, salt: Uint8Array): boolean =>
  Buffer.from(pureCircuits.totalCommitOf(totalKg, salt)).equals(Buffer.from(totalCommit));

export const openedAccount = (ownerId: Uint8Array, plantId: Uint8Array, period: bigint, materialType: Uint8Array, secret: Uint8Array): PeriodAccount => ({
  ownerId,
  plantId,
  period,
  materialType,
  totalKg: 0n,
  recycledEuKg: 0n,
  recycledOtherKg: 0n,
  secret,
});

export const accountAfterConsume = (account: PeriodAccount, lot: Lot, newSecret: Uint8Array): PeriodAccount => ({
  ...account,
  totalKg: account.totalKg + lot.quantity,
  recycledEuKg: account.recycledEuKg + lot.recycledEuKg,
  recycledOtherKg: account.recycledOtherKg + lot.recycledOtherKg,
  secret: newSecret,
});

/** The largest share (basis points) declareShare will accept for this account. */
export const maxDeclarableBps = (a: PeriodAccount): bigint =>
  a.totalKg === 0n ? 0n : ((a.recycledOtherKg * 10n + a.recycledEuKg * 13n) * 10000n) / (a.totalKg * 10n);

// ---------------------------------------------------------------------------
// Lot arithmetic mirrored from the circuits, for callers that must know the
// lots they will hold afterwards.
// ---------------------------------------------------------------------------

export const lotsAfterTransfer = (held: Lot, s: V2PrivateState): { out: Lot; change: Lot } => ({
  out: {
    ...held,
    ownerId: s.recipientId,
    quantity: s.outQuantity,
    carbonClass: s.newCarbonClass,
    recycledEuKg: s.outRecycledEu,
    recycledOtherKg: s.outRecycledOther,
    batchSecret: s.newBatchSecret,
  },
  change: {
    ...held,
    quantity: held.quantity - s.outQuantity,
    recycledEuKg: held.recycledEuKg - s.outRecycledEu,
    recycledOtherKg: held.recycledOtherKg - s.outRecycledOther,
    batchSecret: s.changeBatchSecret,
  },
});

export const lotAfterProcess = (a: Lot, s: V2PrivateState): Lot => ({
  ownerId: a.ownerId,
  materialType: s.outMaterial,
  quantity: s.outQuantity,
  carbonClass: s.newCarbonClass,
  custody: s.outCustody,
  origins: s.outOrigins,
  recycledEuKg: s.outRecycledEu,
  recycledOtherKg: s.outRecycledOther,
  batchSecret: s.newBatchSecret,
});

export const rotatedLot = (held: Lot, newBatchSecret: Uint8Array): Lot => ({ ...held, batchSecret: newBatchSecret });

/** Union of two lots' non-empty origin slots, for building a processLots output. Throws if more than 2. */
export const unionOrigins = (a: Lot, b: Lot): OriginSlot[] => {
  const key = (s: OriginSlot) => Buffer.from(s.originId).toString("hex") + Buffer.from(s.issuerId).toString("hex");
  const seen = new Map<string, OriginSlot>();
  for (const s of [...a.origins, ...b.origins]) if (s.originId.some((x) => x !== 0)) seen.set(key(s), s);
  const slots = [...seen.values()];
  if (slots.length > 2) throw new Error("veilance v2: more than 2 distinct origins — needs a larger K");
  while (slots.length < 2) slots.push(EMPTY_SLOT());
  return slots;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Tree = { findPathForLeaf(leaf: Uint8Array): MerkleTreePath<Uint8Array> | undefined };

const ALLOWLIST_DEPTH = 8;
const PROVENANCE_DEPTH = 16;

const absentPath = (leaf: Uint8Array, depth: number): MerkleTreePath<Uint8Array> => ({
  leaf,
  path: Array.from({ length: depth }, () => ({ sibling: { field: 0n }, goes_left: false })),
});

const pathFor = (tree: Tree, leaf: Uint8Array, depth: number): MerkleTreePath<Uint8Array> =>
  tree.findPathForLeaf(leaf) ?? absentPath(leaf, depth);

const need = <T>(v: T | null, who: string): T => {
  if (v === null) throw new Error(`veilance v2 witness: ${who} is not set in private state`);
  return v;
};

const isEmpty = (s: OriginSlot) => s.originId.every((x) => x === 0);

type Ctx = WitnessContext<Ledger, V2PrivateState>;

export const witnessesV2 = {
  adminSecret: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.partySecret],
  ownerSecret: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.partySecret],
  certId: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.certId],

  certPath: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>] => {
    const leaf = pureCircuits.certLeafOf(partyIdOf(privateState.partySecret), privateState.certId);
    return [privateState, pathFor(ledger.certifiedSuppliers, leaf, ALLOWLIST_DEPTH)];
  },

  // An empty slot re-proves slot 0 (the circuit expects exactly that).
  originPaths: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>[]] => {
    const slots = need(privateState.proveOrigins, "proveOrigins");
    const paths = slots.map((s) => pathFor(ledger.certifiedOrigins, (isEmpty(s) ? slots[0] : s).originId, ALLOWLIST_DEPTH));
    return [privateState, paths];
  },

  heldLot: ({ privateState }: Ctx): [V2PrivateState, Lot] => [privateState, need(privateState.held, "held")],
  heldPath: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>] => [
    privateState,
    pathFor(ledger.provenanceTree, pureCircuits.commitmentOf(need(privateState.held, "held")), PROVENANCE_DEPTH),
  ],
  secondLot: ({ privateState }: Ctx): [V2PrivateState, Lot] => [privateState, need(privateState.second, "second")],
  secondPath: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>] => [
    privateState,
    pathFor(ledger.provenanceTree, pureCircuits.commitmentOf(need(privateState.second, "second")), PROVENANCE_DEPTH),
  ],

  issuedMaterial: ({ privateState }: Ctx): [V2PrivateState, IssueSpec] => [privateState, need(privateState.issueSpec, "issueSpec")],
  recipientId: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.recipientId],
  outQuantity: ({ privateState }: Ctx): [V2PrivateState, bigint] => [privateState, privateState.outQuantity],
  newCarbonClass: ({ privateState }: Ctx): [V2PrivateState, bigint] => [privateState, privateState.newCarbonClass],
  newBatchSecret: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.newBatchSecret],
  changeBatchSecret: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.changeBatchSecret],
  outMaterial: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.outMaterial],
  outCustody: ({ privateState }: Ctx): [V2PrivateState, bigint] => [privateState, privateState.outCustody],
  outOrigins: ({ privateState }: Ctx): [V2PrivateState, OriginSlot[]] => [privateState, privateState.outOrigins],

  ruleYield: ({ privateState }: Ctx): [V2PrivateState, bigint] => [privateState, need(privateState.rule, "rule").yieldPct],

  recyclerIsEu: ({ privateState }: Ctx): [V2PrivateState, boolean] => [privateState, privateState.recyclerIsEu],
  recyclerPath: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>] => {
    const leaf = pureCircuits.recyclerLeafOf(partyIdOf(privateState.partySecret), privateState.certId, privateState.recyclerIsEu);
    return [privateState, pathFor(ledger.certifiedRecyclers, leaf, ALLOWLIST_DEPTH)];
  },
  outRecycledEu: ({ privateState }: Ctx): [V2PrivateState, bigint] => [privateState, privateState.outRecycledEu],
  outRecycledOther: ({ privateState }: Ctx): [V2PrivateState, bigint] => [privateState, privateState.outRecycledOther],
  declareSalt: ({ privateState }: Ctx): [V2PrivateState, Uint8Array] => [privateState, privateState.declareSalt],
  periodAccount: ({ privateState }: Ctx): [V2PrivateState, PeriodAccount] => [privateState, need(privateState.account, "account")],
  periodPath: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>] => [
    privateState,
    pathFor(ledger.provenanceTree, pureCircuits.accountCommitmentOf(need(privateState.account, "account")), PROVENANCE_DEPTH),
  ],
  rulePath: ({ ledger, privateState }: Ctx): [V2PrivateState, MerkleTreePath<Uint8Array>] => {
    const r = need(privateState.rule, "rule");
    return [privateState, pathFor(ledger.processingRules, pureCircuits.ruleLeafOf(r.inMaterial, r.outMaterial, r.yieldPct), ALLOWLIST_DEPTH)];
  },
};
