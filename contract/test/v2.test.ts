// Veilance v2 — the demo scenario from docs/PROVENANCE_V2.md §2, end to end,
// plus the rejection cases each operation must enforce.

import { beforeAll, describe, expect, it } from "vitest";
import { pureCircuits, type Lot } from "../src/managed/veilance_v2/contract/index.js";
import {
  CUSTODY,
  EMPTY_SLOT,
  createV2PrivateState,
  forAttest,
  forIssue,
  forProcess,
  forTransfer,
  forIssueRecycled,
  forOpenPeriod,
  forConsume,
  forDeclare,
  openedAccount,
  accountAfterConsume,
  maxDeclarableBps,
  checkDeclaredTotal,
  issuedOrigins,
  lotAfterProcess,
  lotsAfterTransfer,
  partyIdOf,
  rotatedLot,
  unionOrigins,
  type IssueSpec,
  type ProcessingRule,
} from "../src/witnesses_v2.js";
import { generateEncKeypair, scanLotInbox, sealLot, type EncKeypair } from "../src/sealed-entry-v2.js";
import { NetworkV2, PartyV2 } from "./network_v2.js";

const bytes32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label));
  return out;
};
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const rand = () => crypto.getRandomValues(new Uint8Array(32));
const t = (tons: number) => BigInt(tons * 1000); // kg

const HYDROXIDE = bytes32("material:cobalt-hydroxide");
const SULFATE = bytes32("material:cobalt-sulfate");
const NICKEL = bytes32("material:nickel");
const ORIGIN_A = bytes32("origin:mine-a");
const ORIGIN_B = bytes32("origin:mine-b");
const ORIGIN_X = bytes32("origin:uncertified");

const RULE_REFINE: ProcessingRule = { inMaterial: HYDROXIDE, outMaterial: SULFATE, yieldPct: 20n };
const RULE_MERGE_SULFATE: ProcessingRule = { inMaterial: SULFATE, outMaterial: SULFATE, yieldPct: 100n };

type Actor = { party: PartyV2; id: Uint8Array; keys: EncKeypair; secret: Uint8Array; inboxFrom: bigint };

const actor = (name: string, certLabel?: string): Actor => {
  const secret = bytes32(`secret:${name}`);
  return {
    party: new PartyV2(name, createV2PrivateState(secret, certLabel ? bytes32(certLabel) : undefined)),
    id: partyIdOf(secret),
    keys: generateEncKeypair(),
    secret,
    inboxFrom: 0n,
  };
};

/** Everything an honest sender does to issue: seal the pre-image, prime witnesses, call. */
async function issue(net: NetworkV2, issuer: Actor, to: Actor, spec: IssueSpec): Promise<Lot> {
  const lot: Lot = { ownerId: to.id, ...spec, origins: issuedOrigins(spec, issuer.secret), recycledEuKg: 0n, recycledOtherKg: 0n };
  const { ownerId: _o, ...fields } = lot;
  const entry = sealLot(to.keys.encPk, { ...fields, commitment: pureCircuits.commitmentOf(lot) });
  issuer.party.privateState = forIssue(issuer.party.privateState, spec, to.id);
  await net.issueLot(issuer.party, entry);
  return lot;
}

/** Recipient-side: decrypt, verify against the ledger, return new lots. */
function receive(net: NetworkV2, who: Actor) {
  const { lots, nextIndex } = scanLotInbox(net.ledger(), who.keys.encSk, who.id, who.secret, who.inboxFrom);
  who.inboxFrom = nextIndex;
  return lots;
}

async function transfer(
  net: NetworkV2,
  from: Actor,
  held: Lot,
  to: Actor,
  quantity: bigint,
  carbonClass = held.carbonClass,
  memo?: Uint8Array,
  recycled?: { eu: bigint; other: bigint },
) {
  from.party.privateState = forTransfer(from.party.privateState, held, to.id, quantity, carbonClass, rand(), rand(), recycled);
  const { out, change } = lotsAfterTransfer(held, from.party.privateState);
  const { ownerId: _o, ...fields } = out;
  const entry = sealLot(to.keys.encPk, { ...fields, commitment: pureCircuits.commitmentOf(out), memo });
  const [nullifier, outCm, changeCm] = await net.transferLot(from.party, entry);
  expect(hex(outCm)).toBe(hex(pureCircuits.commitmentOf(out)));
  expect(hex(changeCm)).toBe(hex(pureCircuits.commitmentOf(change)));
  return { out, change, nullifier };
}

async function processLots(
  net: NetworkV2,
  who: Actor,
  a: Lot,
  b: Lot,
  rule: ProcessingRule,
  out: { quantity: bigint; carbonClass: bigint; custody: bigint; origins?: Lot["origins"]; recycledEu?: bigint; recycledOther?: bigint },
) {
  who.party.privateState = forProcess(
    who.party.privateState,
    a,
    b,
    {
      material: rule.outMaterial,
      quantity: out.quantity,
      carbonClass: out.carbonClass,
      custody: out.custody,
      origins: out.origins ?? unionOrigins(a, b),
      batchSecret: rand(),
      recycledEu: out.recycledEu,
      recycledOther: out.recycledOther,
    },
    rule,
  );
  const expected = lotAfterProcess(a, who.party.privateState);
  const [, , outCm] = await net.processLots(who.party);
  expect(hex(outCm)).toBe(hex(pureCircuits.commitmentOf(expected)));
  return expected;
}

async function attest(net: NetworkV2, who: Actor, held: Lot, challenge: Uint8Array, minQuantity: bigint) {
  const fresh = rand();
  who.party.privateState = forAttest(who.party.privateState, held, fresh);
  const [nullifier] = await net.attestOrder(who.party, challenge, minQuantity);
  return { rotated: rotatedLot(held, fresh), nullifier };
}

describe("Veilance v2 — demo scenario", () => {
  let net: NetworkV2;
  const admin = actor("admin");
  const mineA = actor("mine-a", "cert:mine-a");
  const mineB = actor("mine-b", "cert:mine-b");
  const refiner = actor("refiner", "cert:refiner");
  const battery = actor("battery", "cert:battery");
  const oem = actor("oem"); // receives, never certified

  let refinerA: Lot, refinerB: Lot, refinerA50: Lot, sulfate: Lot, batteryLot: Lot, oemLot: Lot;
  const CHALLENGE = rand();

  beforeAll(async () => {
    net = await NetworkV2.deploy(admin.party);
    await net.certifyOrigin(admin.party, ORIGIN_A);
    await net.certifyOrigin(admin.party, ORIGIN_B);
    for (const [who, cert] of [[mineA, "cert:mine-a"], [mineB, "cert:mine-b"], [refiner, "cert:refiner"], [battery, "cert:battery"]] as const) {
      await net.certifySupplier(admin.party, who.id, bytes32(cert));
    }
    await net.setCarbonThreshold(admin.party, 5n);
    await net.addProcessingRule(admin.party, RULE_REFINE.inMaterial, RULE_REFINE.outMaterial, RULE_REFINE.yieldPct);
    await net.addProcessingRule(admin.party, RULE_MERGE_SULFATE.inMaterial, RULE_MERGE_SULFATE.outMaterial, RULE_MERGE_SULFATE.yieldPct);
    for (const who of [mineA, mineB, refiner, battery, oem]) {
      who.party.privateState = { ...who.party.privateState };
      await net.registerEncKey(who.party, who.keys.encPk);
    }
  });

  it("1 — two mines issue hydroxide lots; the refiner receives and verifies them", async () => {
    await issue(net, mineA, refiner, { originId: ORIGIN_A, materialType: HYDROXIDE, quantity: t(100), carbonClass: 2n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    await issue(net, mineB, refiner, { originId: ORIGIN_B, materialType: HYDROXIDE, quantity: t(60), carbonClass: 3n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    const got = receive(net, refiner);
    expect(got).toHaveLength(2);
    [refinerA, refinerB] = got.map((r) => r.lot);
    expect(refinerA.quantity).toBe(t(100));
    // The issuer slot is the issuing mine's id, written by the circuit.
    expect(hex(refinerA.origins[0].issuerId)).toBe(hex(mineA.id));
    expect(hex(refinerB.origins[0].issuerId)).toBe(hex(mineB.id));
  });

  it("2 — the refiner splits lot A 50/50 by transferring to itself", async () => {
    const { out, change } = await transfer(net, refiner, refinerA, refiner, t(50));
    expect(receive(net, refiner).map((r) => hex(r.commitment))).toEqual([hex(pureCircuits.commitmentOf(out))]);
    refinerA50 = out;
    expect(change.quantity).toBe(t(50));
  });

  it("3 — merge + refine A50 and B60 into sulfate under the 20 % yield rule", async () => {
    // 110 t × 20 % = 22 t. One kilogram more is rejected, and nothing is committed.
    const before = net.ledger().provenanceTree.firstFree();
    await expect(processLots(net, refiner, refinerA50, refinerB, RULE_REFINE, { quantity: t(22) + 1n, carbonClass: 3n, custody: CUSTODY.segregated }))
      .rejects.toThrow(/exceeds the processing yield/);
    expect(net.ledger().provenanceTree.firstFree()).toBe(before);

    sulfate = await processLots(net, refiner, refinerA50, refinerB, RULE_REFINE, { quantity: t(22), carbonClass: 3n, custody: CUSTODY.segregated });
    expect(sulfate.origins.map((s) => hex(s.originId)).sort()).toEqual([hex(ORIGIN_A), hex(ORIGIN_B)].sort());
    expect(sulfate.custody).toBe(CUSTODY.segregated);
  });

  it("4 — the refiner sends 10 t to the battery maker and keeps 12 t", async () => {
    const { out, change } = await transfer(net, refiner, sulfate, battery, t(10));
    expect(change.quantity).toBe(t(12));
    const got = receive(net, battery);
    expect(got).toHaveLength(1);
    batteryLot = got[0].lot;
    expect(hex(pureCircuits.commitmentOf(batteryLot))).toBe(hex(pureCircuits.commitmentOf(out)));
  });

  it("5 — order-bound attestation: covers 5 t without disclosing any quantity", async () => {
    const { rotated } = await attest(net, battery, batteryLot, CHALLENGE, t(5));
    batteryLot = rotated;
    const l = net.ledger();
    // The OEM recomputes the key from ITS challenge and order size.
    expect(l.attestations.member(pureCircuits.attestationKeyOf(CHALLENGE, battery.id, t(5)))).toBe(true);
    // A different order size is a different key — nothing about the quantity is readable otherwise.
    expect(l.attestations.member(pureCircuits.attestationKeyOf(CHALLENGE, battery.id, t(6)))).toBe(false);

    await expect(attest(net, battery, batteryLot, rand(), t(20))).rejects.toThrow(/does not cover the ordered quantity/);
  });

  it("6 — the battery maker delivers 5 t to the OEM, which verifies origins and issuers", async () => {
    const orderRef = bytes32("PO-2026-0042");
    const before = batteryLot;
    const { change } = await transfer(net, battery, batteryLot, oem, t(5), batteryLot.carbonClass, orderRef);
    batteryLot = change;

    const got = receive(net, oem);
    expect(got).toHaveLength(1);
    oemLot = got[0].lot;
    expect(hex(got[0].memo)).toBe(hex(orderRef));
    expect(oemLot.quantity).toBe(t(5));
    expect(hex(oemLot.materialType)).toBe(hex(SULFATE));
    const issuers = oemLot.origins.map((s) => hex(s.issuerId)).sort();
    expect(issuers).toEqual([hex(mineA.id), hex(mineB.id)].sort());

    // The same 5 t cannot be sold again: the pre-delivery lot is spent.
    await expect(transfer(net, battery, before, oem, t(5))).rejects.toThrow(/lot already consumed/);
  });

  it("the OEM, not a certified supplier, cannot pass the lot on", async () => {
    await expect(transfer(net, oem, oemLot, battery, t(1))).rejects.toThrow(/supplier is not certified/);
  });

  it("rejects a transfer larger than the lot", async () => {
    await expect(transfer(net, battery, batteryLot, oem, batteryLot.quantity + 1n)).rejects.toThrow(/exceeds the lot quantity/);
  });

  it("rejects processing without a registered rule, or across materials", async () => {
    const x = await issue(net, mineA, refiner, { originId: ORIGIN_A, materialType: NICKEL, quantity: t(10), carbonClass: 1n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    const y = await issue(net, mineB, refiner, { originId: ORIGIN_B, materialType: NICKEL, quantity: t(10), carbonClass: 1n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    receive(net, refiner);
    const noRule: ProcessingRule = { inMaterial: NICKEL, outMaterial: SULFATE, yieldPct: 100n };
    await expect(processLots(net, refiner, x, y, noRule, { quantity: t(1), carbonClass: 1n, custody: CUSTODY.segregated }))
      .rejects.toThrow(/no processing rule/);

    const h = await issue(net, mineA, refiner, { originId: ORIGIN_A, materialType: HYDROXIDE, quantity: t(10), carbonClass: 1n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    receive(net, refiner);
    await expect(processLots(net, refiner, x, h, RULE_REFINE, { quantity: t(1), carbonClass: 1n, custody: CUSTODY.segregated }))
      .rejects.toThrow(/same material/);
  });

  it("rejects a merge that claims identity preservation, drops an origin, or invents one", async () => {
    const a = await issue(net, mineA, refiner, { originId: ORIGIN_A, materialType: SULFATE, quantity: t(4), carbonClass: 1n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    const b = await issue(net, mineB, refiner, { originId: ORIGIN_B, materialType: SULFATE, quantity: t(4), carbonClass: 1n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    receive(net, refiner);
    const base = { quantity: t(8), carbonClass: 1n };
    await expect(processLots(net, refiner, a, b, RULE_MERGE_SULFATE, { ...base, custody: CUSTODY.identityPreserved }))
      .rejects.toThrow(/custody model may only weaken/);
    await expect(processLots(net, refiner, a, b, RULE_MERGE_SULFATE, { ...base, custody: CUSTODY.massBalance, origins: [a.origins[0], EMPTY_SLOT()] }))
      .rejects.toThrow(/input origin is missing/);
    await expect(processLots(net, refiner, a, b, RULE_MERGE_SULFATE, { ...base, custody: CUSTODY.massBalance, origins: [a.origins[0], { originId: ORIGIN_X, issuerId: mineB.id }] }))
      .rejects.toThrow(/not present in the inputs|input origin is missing/);
    // A forged issuer on a real origin is also "not present in the inputs".
    await expect(processLots(net, refiner, a, b, RULE_MERGE_SULFATE, { ...base, custody: CUSTODY.massBalance, origins: [a.origins[0], { originId: ORIGIN_B, issuerId: mineA.id }] }))
      .rejects.toThrow(/not present in the inputs|input origin is missing/);
    // The honest merge works, as mass balance.
    const merged = await processLots(net, refiner, a, b, RULE_MERGE_SULFATE, { ...base, custody: CUSTODY.massBalance });
    expect(merged.quantity).toBe(t(8));
  });

  it("rejects issuing from an uncertified origin", async () => {
    await expect(issue(net, mineA, refiner, { originId: ORIGIN_X, materialType: HYDROXIDE, quantity: t(1), carbonClass: 1n, custody: CUSTODY.identityPreserved, batchSecret: rand() }))
      .rejects.toThrow(/origin is not certified/);
  });

  it("the ledger holds no quantity, material, origin or order size in the clear", () => {
    const l = net.ledger();
    const needles = [HYDROXIDE, SULFATE, ORIGIN_A, ORIGIN_B, bytes32("PO-2026-0042")].map(hex);
    const values: string[] = [];
    for (const [, v] of l.lotInbox) values.push(hex(v));
    for (const [k] of l.attestations) values.push(hex(k));
    for (const v of l.nullifiers) values.push(hex(v));
    for (const n of needles) expect(values.some((v) => v.includes(n.replace(/0+$/, "")))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recycled content (docs/PLATFORM_LAYER.md): certified recyclers, mass-balance
// allocation, and a plant/period declaration a notified body can check on
// the ledger alone.
// ---------------------------------------------------------------------------

const NICKEL_RULE: ProcessingRule = { inMaterial: NICKEL, outMaterial: NICKEL, yieldPct: 100n };
const FACILITY_EU = bytes32("origin:recycler-hu");
const FACILITY_X = bytes32("origin:recycler-other");
const MINE_NI = bytes32("origin:nickel-mine");
const PLANT = bytes32("plant:cell-eu-1");
const PERIOD = 2028n;

async function issueRecycled(net: NetworkV2, recycler: Actor, to: Actor, spec: IssueSpec, isEu: boolean): Promise<Lot> {
  const lot: Lot = {
    ownerId: to.id,
    materialType: spec.materialType,
    quantity: spec.quantity,
    carbonClass: spec.carbonClass,
    custody: spec.custody,
    origins: issuedOrigins(spec, recycler.secret),
    recycledEuKg: isEu ? spec.quantity : 0n,
    recycledOtherKg: isEu ? 0n : spec.quantity,
    batchSecret: spec.batchSecret,
  };
  const { ownerId: _o, ...fields } = lot;
  const entry = sealLot(to.keys.encPk, { ...fields, commitment: pureCircuits.commitmentOf(lot) });
  recycler.party.privateState = forIssueRecycled(recycler.party.privateState, spec, to.id, isEu);
  await net.issueRecycledLot(recycler.party, entry);
  return lot;
}

describe("Veilance v2 — recycled content across platforms", () => {
  let net: NetworkV2;
  const admin = actor("admin");
  const recyclerEu = actor("recycler-eu", "cert:recycler-eu");
  const recyclerX = actor("recycler-x", "cert:recycler-x");
  const mine = actor("ni-mine", "cert:ni-mine");
  const refiner = actor("refiner", "cert:refiner");
  const cellMaker = actor("cell-maker", "cert:cell-maker");

  let recycledIn: Lot, primaryIn: Lot, refined: Lot, cellLot: Lot, account: ReturnType<typeof openedAccount>;

  beforeAll(async () => {
    net = await NetworkV2.deploy(admin.party);
    for (const o of [FACILITY_EU, FACILITY_X, MINE_NI]) await net.certifyOrigin(admin.party, o);
    for (const [who, cert] of [[recyclerEu, "cert:recycler-eu"], [recyclerX, "cert:recycler-x"], [mine, "cert:ni-mine"], [refiner, "cert:refiner"], [cellMaker, "cert:cell-maker"]] as const) {
      await net.certifySupplier(admin.party, who.id, bytes32(cert));
    }
    await net.certifyRecycler(admin.party, recyclerEu.id, bytes32("cert:recycler-eu"), true);
    await net.certifyRecycler(admin.party, recyclerX.id, bytes32("cert:recycler-x"), false);
    await net.addProcessingRule(admin.party, NICKEL_RULE.inMaterial, NICKEL_RULE.outMaterial, NICKEL_RULE.yieldPct);
    await net.setCarbonThreshold(admin.party, 9n);
    for (const who of [recyclerEu, recyclerX, mine, refiner, cellMaker]) await net.registerEncKey(who.party, who.keys.encPk);
  });

  it("only certified recyclers issue recycled lots, and the EU flag comes from the certificate", async () => {
    const spec = { originId: FACILITY_EU, materialType: NICKEL, quantity: t(30), carbonClass: 1n, custody: CUSTODY.massBalance, batchSecret: rand() };
    // A mine is a certified supplier but not a recycler.
    await expect(issueRecycled(net, mine, refiner, { ...spec, originId: MINE_NI }, true)).rejects.toThrow(/not a certified recycler/);
    // A non-EU recycler cannot claim the EU column.
    await expect(issueRecycled(net, recyclerX, refiner, { ...spec, originId: FACILITY_X }, true)).rejects.toThrow(/not a certified recycler/);

    await issueRecycled(net, recyclerEu, refiner, spec, true);
    await issue(net, mine, refiner, { originId: MINE_NI, materialType: NICKEL, quantity: t(70), carbonClass: 2n, custody: CUSTODY.identityPreserved, batchSecret: rand() });
    const got = receive(net, refiner).map((r) => r.lot);
    expect(got.map((l) => [l.quantity, l.recycledEuKg, l.recycledOtherKg])).toEqual([
      [t(30), t(30), 0n],
      [t(70), 0n, 0n],
    ]);
    [recycledIn, primaryIn] = got;
  });

  it("merging caps the recycled share at the inputs' ratio", async () => {
    // 30 t EU-recycled of 100 t in → at most 30 t of a 100 t output.
    await expect(processLots(net, refiner, recycledIn, primaryIn, NICKEL_RULE, { quantity: t(100), carbonClass: 2n, custody: CUSTODY.massBalance, recycledEu: t(30) + 1n }))
      .rejects.toThrow(/EU-recycled share exceeds the inputs' ratio/);
    refined = await processLots(net, refiner, recycledIn, primaryIn, NICKEL_RULE, { quantity: t(100), carbonClass: 2n, custody: CUSTODY.massBalance });
    expect([refined.quantity, refined.recycledEuKg]).toEqual([t(100), t(30)]);
  });

  it("a transfer may allocate recycled share freely between the parts, but never create it", async () => {
    await expect(transfer(net, refiner, refined, cellMaker, t(50), refined.carbonClass, undefined, { eu: t(30) + 1n, other: 0n }))
      .rejects.toThrow(/allocates more recycled material than the lot holds/);
    // All 30 t recycled goes with the 50 t sent (mass-balance allocation); the change keeps none.
    const { change } = await transfer(net, refiner, refined, cellMaker, t(50), refined.carbonClass, undefined, { eu: t(30), other: 0n });
    expect([change.quantity, change.recycledEuKg]).toEqual([t(50), 0n]);
    [cellLot] = receive(net, cellMaker).map((r) => r.lot);
    expect([cellLot.quantity, cellLot.recycledEuKg]).toEqual([t(50), t(30)]);

    // The same recycled credit cannot be handed to anyone else: the pre-transfer lot is spent.
    await expect(transfer(net, refiner, refined, recyclerX, t(50), refined.carbonClass, undefined, { eu: t(30), other: 0n }))
      .rejects.toThrow(/lot already consumed/);
  });

  it("the cell maker declares its plant/period recycled share; overclaiming is rejected", async () => {
    const openSecret = rand();
    cellMaker.party.privateState = forOpenPeriod(cellMaker.party.privateState, openSecret);
    await net.openPeriod(cellMaker.party, PLANT, PERIOD, NICKEL);
    account = openedAccount(cellMaker.id, PLANT, PERIOD, NICKEL, openSecret);
    // One account per plant/period/material.
    await expect(net.openPeriod(cellMaker.party, PLANT, PERIOD, NICKEL)).rejects.toThrow(/already open/);

    const next = rand();
    cellMaker.party.privateState = forConsume(cellMaker.party.privateState, cellLot, account, next);
    await net.consumeIntoPeriod(cellMaker.party);
    account = accountAfterConsume(account, cellLot, next);

    // 30 t EU-recycled × 1.3 over 50 t = 78.00 %.
    expect(maxDeclarableBps(account)).toBe(7800n);
    const salt = rand();
    cellMaker.party.privateState = forDeclare(cellMaker.party.privateState, account, salt);
    await expect(net.declareShare(cellMaker.party, PLANT, PERIOD, NICKEL, 7801n)).rejects.toThrow(/declared share exceeds/);
    await expect(net.declareShare(cellMaker.party, PLANT, PERIOD + 1n, NICKEL, 7000n)).rejects.toThrow(/does not match the declared/);
    await net.declareShare(cellMaker.party, PLANT, PERIOD, NICKEL, 7800n);

    // A notified body reads the declaration straight from the ledger.
    const key = pureCircuits.declarationKeyOf(cellMaker.id, PLANT, PERIOD, NICKEL);
    const declared = net.ledger().declarations.lookup(key);
    expect(declared.shareBps).toBe(7800n);
    // The total is hidden on chain; the notified body checks it against production
    // records once the manufacturer hands over (total, salt).
    expect(checkDeclaredTotal(declared.totalCommit, t(50), salt)).toBe(true);
    expect(checkDeclaredTotal(declared.totalCommit, t(40), salt)).toBe(false);
  });

  it("a declared period is closed: the lot and the account cannot be counted again", async () => {
    cellMaker.party.privateState = forConsume(cellMaker.party.privateState, cellLot, account, rand());
    await expect(net.consumeIntoPeriod(cellMaker.party)).rejects.toThrow(/lot already consumed/);
    cellMaker.party.privateState = forDeclare(cellMaker.party.privateState, account, rand());
    await expect(net.declareShare(cellMaker.party, PLANT, PERIOD, NICKEL, 1n)).rejects.toThrow(/lot already consumed|already declared/);
  });
});
