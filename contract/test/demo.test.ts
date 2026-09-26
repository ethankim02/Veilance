// Veilance — the 3-minute demo from landing.md §10, executed end to end.
//
//   Mine  ──issueProvenance──▶  cA (Refiner owns)
//   Refiner ──transferProvenance──▶ nA consumed, cB (BatteryMfr owns)
//   BatteryMfr ──attest{Consumer,Procurement,Regulator}──▶ 3 attestations
//     (filed under attestationKeyOf(challenge, holderId, profile), not the
//      raw challenge — see "Change log v2" in NOTES.md)
//   Refiner replays cA ──▶ REJECTED (already consumed)
//
// Everything runs through the real compiled circuits via
// @midnight-ntwrk/compact-runtime, against a shared ledger.

import { beforeAll, describe, expect, it } from "vitest";
import {
  Party,
  VeilanceNetwork,
  bytes32,
  hex,
  snapshot,
} from "./network.js";
import type { VeilancePrivateState } from "../src/witnesses.js";
import {
  createVeilancePrivateState,
  forHold,
  forIssue,
  forTransfer,
  partyIdOf,
  type Credential,
} from "../src/witnesses.js";
import { pureCircuits } from "../src/managed/veilance/contract/index.js";
import {
  ENTRY_BYTES,
  generateEncKeypair,
  openCredential,
  scanInbox,
  sealCredential,
} from "../src/sealed-entry.js";

// --- fixtures --------------------------------------------------------------

const ADMIN_SECRET = bytes32("secret:admin");
const MINE_SECRET = bytes32("secret:mine");
const REFINER_SECRET = bytes32("secret:refiner");
const BATTERY_SECRET = bytes32("secret:batteryMfr");

const CERT_A = bytes32("cert:A/mine");
const CERT_B = bytes32("cert:B/refiner");
const CERT_C = bytes32("cert:C/batteryMfr");

const ORIGIN_CONGO_MINE_X = bytes32("origin:congo-mine-x");
const ORIGIN_UNCERTIFIED = bytes32("origin:sanctioned-mine-z");
const MATERIAL_COBALT = bytes32("material:cobalt");

const BATCH_1 = bytes32("batch:1/mine->refiner");
const BATCH_2 = bytes32("batch:2/refiner->battery");

const CH1 = bytes32("challenge:consumer");
const CH2 = bytes32("challenge:procurement");
const CH3 = bytes32("challenge:regulator");
const CH4 = bytes32("challenge:procurement-2");

/** Profile codes, mirroring `VerifierProfile` in veilance.compact. */
const CONSUMER = 1n;
const PROCUREMENT = 2n;
const REGULATOR = 3n;

/**
 * What a verifier does off-chain: it knows the partyId of the counterparty it
 * handed the challenge to, so it recomputes the attestation key itself and
 * looks that up. A different holder answering the same challenge lands on a
 * different key and is simply not found here.
 */
const attKey = (challenge: Uint8Array, holderId: Uint8Array, profile: bigint) =>
  pureCircuits.attestationKeyOf(challenge, holderId, profile);

// X25519 inbox keypairs. `encPk` goes on chain via registerEncKey; `encSk`
// never leaves the party. Freshly generated per test run — nothing in the
// protocol depends on them being deterministic.
const ADMIN_KEYS = generateEncKeypair();
const MINE_KEYS = generateEncKeypair();
const REFINER_KEYS = generateEncKeypair();
const BATTERY_KEYS = generateEncKeypair();

const MINE_ID = partyIdOf(MINE_SECRET);
const REFINER_ID = partyIdOf(REFINER_SECRET);
const BATTERY_ID = partyIdOf(BATTERY_SECRET);

const newAdmin = () => new Party("admin", createVeilancePrivateState(ADMIN_SECRET));
const newMine = () => new Party("mine", createVeilancePrivateState(MINE_SECRET, CERT_A));
const newRefiner = () => new Party("refiner", createVeilancePrivateState(REFINER_SECRET, CERT_B));
const newBattery = () => new Party("batteryMfr", createVeilancePrivateState(BATTERY_SECRET, CERT_C));

/**
 * What an honest sender puts in the inbox: the credential's pre-image sealed to
 * the recipient's registered X25519 key, with the commitment the chain will hold.
 */
const seal = (recipientPk: Uint8Array, cred: Credential): Uint8Array =>
  sealCredential(recipientPk, {
    originId: cred.originId,
    materialType: cred.materialType,
    carbonClass: cred.carbonClass,
    batchSecret: cred.batchSecret,
    commitment: pureCircuits.commitmentOf(cred),
  });

/** Seal `cred` to its own `ownerId`'s registered key, read off the ledger. */
const sealTo = (net: VeilanceNetwork, cred: Credential): Uint8Array =>
  seal(net.ledger().partyEncKeys.lookup(cred.ownerId), cred);

/** Admin bootstrap shared by every scenario: origin + three certified suppliers. */
async function bootstrap(net: VeilanceNetwork, admin: Party) {
  await net.certifyOrigin(admin, ORIGIN_CONGO_MINE_X);
  await net.certifySupplier(admin, MINE_ID, CERT_A);
  await net.certifySupplier(admin, REFINER_ID, CERT_B);
  // NOTE (deviation from the written demo script): the Battery Manufacturer
  // must also be a certified supplier, otherwise attestProcurement /
  // attestRegulator — which both require `owner certLeaf ∈ certifiedSuppliers`
  // — can never succeed for it. See NOTES.md.
  await net.certifySupplier(admin, BATTERY_ID, CERT_C);

  // Every party publishes its inbox key. registerEncKey needs no certification
  // and does NOT bump policyVersion — it is not a policy change.
  await net.registerEncKey(admin, ADMIN_KEYS.encPk);
  await net.registerEncKey(newMine(), MINE_KEYS.encPk);
  await net.registerEncKey(newRefiner(), REFINER_KEYS.encPk);
  await net.registerEncKey(newBattery(), BATTERY_KEYS.encPk);

  await net.setCarbonThreshold(admin, 5n);
}

// ---------------------------------------------------------------------------
// The demo, run as one ordered scenario against one shared chain.
// ---------------------------------------------------------------------------

describe("Veilance demo", () => {
  let net: VeilanceNetwork;
  const admin = newAdmin();
  const mine = newMine();
  const refiner = newRefiner();
  const battery = newBattery();

  // The credentials as their holders know them (layer L2 — never on chain).
  const credA: Credential = {
    ownerId: REFINER_ID,
    originId: ORIGIN_CONGO_MINE_X,
    materialType: MATERIAL_COBALT,
    carbonClass: 3n,
    batchSecret: BATCH_1,
  };
  const credB: Credential = {
    ownerId: BATTERY_ID,
    originId: ORIGIN_CONGO_MINE_X,
    materialType: MATERIAL_COBALT,
    carbonClass: 4n,
    batchSecret: BATCH_2,
  };

  let cA: Uint8Array;
  let nA: Uint8Array;
  let cB: Uint8Array;

  beforeAll(async () => {
    net = await VeilanceNetwork.deploy(admin);
  });

  it("deploys with the deployer's pseudonymous id as admin", () => {
    const l = net.ledger();
    expect(hex(l.adminId)).toBe(hex(partyIdOf(ADMIN_SECRET)));
    expect(l.policyVersion).toBe(0n);
    expect(l.carbonThreshold).toBe(0n);
  });

  it("step 1 — admin registers the supply chain policy", async () => {
    await bootstrap(net, admin);
    const l = net.ledger();
    expect(l.policyVersion).toBe(5n); // 1 origin + 3 suppliers + 1 threshold
    expect(l.carbonThreshold).toBe(5n);
    expect(l.certifiedOrigins.findPathForLeaf(ORIGIN_CONGO_MINE_X)).toBeDefined();
    expect(l.certifiedOrigins.findPathForLeaf(ORIGIN_UNCERTIFIED)).toBeUndefined();
    expect(
      l.certifiedSuppliers.findPathForLeaf(pureCircuits.certLeafOf(MINE_ID, CERT_A)),
    ).toBeDefined();
  });

  it("rejects a non-admin trying to change policy", async () => {
    const before = snapshot(net.ledger());
    await expect(net.setCarbonThreshold(refiner, 99n)).rejects.toThrow(
      /caller is not the admin/,
    );
    expect(snapshot(net.ledger())).toEqual(before);
  });

  it("step 2 — the Mine issues a cobalt credential to the Refiner", async () => {
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 3n,
        batchSecret: BATCH_1,
      },
      REFINER_ID,
    );

    // The Mine seals credential A to the Refiner's REGISTERED key, read off the
    // ledger — it needs no channel to the Refiner beyond the chain itself.
    const refinerPk = net.ledger().partyEncKeys.lookup(REFINER_ID);
    cA = await net.issueProvenance(mine, seal(refinerPk, credA));

    expect(hex(cA)).toBe(hex(pureCircuits.commitmentOf(credA)));
    const l = net.ledger();
    expect(l.provenanceTree.firstFree()).toBe(1n);
    expect(l.provenanceTree.findPathForLeaf(cA)).toBeDefined();
    expect(l.nullifiers.size()).toBe(0n);
    // One delivery, atomically with the commitment.
    expect(l.credentialInboxCount).toBe(1n);
    expect(l.credentialInbox.lookup(0n).length).toBe(ENTRY_BYTES);
  });

  it("step 3 — the Refiner transforms it and passes it to the Battery Manufacturer", async () => {
    refiner.privateState = forTransfer(
      refiner.privateState,
      credA, // received out of band from the Mine
      BATTERY_ID,
      4n,
      BATCH_2,
    );

    const batteryPk = net.ledger().partyEncKeys.lookup(BATTERY_ID);
    [nA, cB] = await net.transferProvenance(refiner, seal(batteryPk, credB));

    expect(hex(nA)).toBe(hex(pureCircuits.nullifierOf(cA, REFINER_SECRET)));
    expect(hex(cB)).toBe(hex(pureCircuits.commitmentOf(credB)));

    const l = net.ledger();
    // nA present, cB present — the two public outputs of the transition.
    expect(l.nullifiers.member(nA)).toBe(true);
    expect(l.nullifiers.size()).toBe(1n);
    expect(l.provenanceTree.findPathForLeaf(cB)).toBeDefined();
    expect(l.provenanceTree.firstFree()).toBe(2n);
    expect(l.credentialInboxCount).toBe(2n);
    expect(l.credentialInbox.lookup(1n).length).toBe(ENTRY_BYTES);

    // PRIVACY: nothing on chain links nA to cA. The nullifier set contains one
    // opaque hash; the tree contains two opaque hashes; the edge cA -> nA lives
    // only in the Refiner's local state.
    expect([...l.nullifiers].map(hex)).toEqual([hex(nA)]);
    expect(hex(nA)).not.toBe(hex(cA));
  });

  it("step 4 — the Battery Manufacturer proves policy to three verifier profiles", async () => {
    battery.privateState = forHold(battery.privateState, credB);

    await net.attestConsumer(battery, CH1);
    await net.attestProcurement(battery, CH2);
    await net.attestRegulator(battery, CH3);

    const l = net.ledger();
    // policyVersion is 5 after bootstrap (1 origin + 3 suppliers + 1 threshold)
    // and nothing since step 1 has touched policy.
    expect(l.policyVersion).toBe(5n);

    // Each attestation is filed under the HOLDER-BOUND key, and carries the
    // policy version that was in force when it was proven.
    expect(l.attestations.lookup(attKey(CH1, BATTERY_ID, CONSUMER))).toEqual({
      profile: CONSUMER,
      policyVersion: 5n,
    });
    expect(l.attestations.lookup(attKey(CH2, BATTERY_ID, PROCUREMENT))).toEqual({
      profile: PROCUREMENT,
      policyVersion: 5n,
    });
    expect(l.attestations.lookup(attKey(CH3, BATTERY_ID, REGULATOR))).toEqual({
      profile: REGULATOR,
      policyVersion: 5n,
    });
    expect(l.attestations.size()).toBe(3n);

    // The raw challenge is NOT a key any more — it is never written to the
    // ledger and never disclosed.
    expect(l.attestations.member(CH1)).toBe(false);
    expect(l.attestations.member(CH2)).toBe(false);
    expect(l.attestations.member(CH3)).toBe(false);
  });

  it("rejects a replayed verifier challenge", async () => {
    const before = snapshot(net.ledger());
    await expect(net.attestConsumer(battery, CH1)).rejects.toThrow(
      /challenge already used by this holder for this profile/,
    );
    expect(snapshot(net.ledger())).toEqual(before);
  });

  it("step 5 — ATTACK: the Refiner replays the already-consumed credential", async () => {
    const before = snapshot(net.ledger());

    // Exactly the same upstream credential cA, a different downstream recipient.
    refiner.privateState = forTransfer(
      refiner.privateState,
      credA,
      MINE_ID,
      1n,
      bytes32("batch:3/double-claim"),
    );

    await expect(
      net.transferProvenance(
        refiner,
        seal(net.ledger().partyEncKeys.lookup(MINE_ID), {
          ownerId: MINE_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 1n,
          batchSecret: bytes32("batch:3/double-claim"),
        }),
      ),
    ).rejects.toThrow(/credential already consumed/);

    // The ledger is untouched: no new commitment, no new nullifier.
    expect(snapshot(net.ledger())).toEqual(before);
    expect(net.ledger().nullifiers.size()).toBe(before.nullifierCount);
    expect(net.ledger().provenanceTree.firstFree()).toBe(before.provenanceLeafCount);
  });

  it("selective disclosure — procurement fails once the carbon threshold drops below the (private) class", async () => {
    // credB.carbonClass is 4 and stays private throughout.
    await net.setCarbonThreshold(admin, 2n);

    await expect(net.attestProcurement(battery, CH4)).rejects.toThrow(
      /carbon class exceeds the policy threshold/,
    );
    expect(net.ledger().attestations.member(attKey(CH4, BATTERY_ID, PROCUREMENT))).toBe(
      false,
    );

    // Consumer profile does not check carbon at all — it still passes.
    await net.attestConsumer(battery, bytes32("challenge:consumer-2"));
    expect(net.ledger().attestations.size()).toBe(4n);

    await net.setCarbonThreshold(admin, 5n);
    await net.attestProcurement(battery, CH4);
    expect(net.ledger().policyVersion).toBe(7n); // 5 + two threshold changes
    expect(net.ledger().attestations.lookup(attKey(CH4, BATTERY_ID, PROCUREMENT))).toEqual(
      { profile: PROCUREMENT, policyVersion: 7n },
    );
  });

  // Change A. The verifier's challenge is a bearer secret only until it is used;
  // anyone who overhears it can call attest* with THEIR OWN credential. The
  // contract cannot reject that — it has no idea who the verifier expected. What
  // it CAN do is file the two attestations under different keys, so the
  // verifier's own lookup only ever returns the party it handed the challenge to.
  it("hijack — a second holder replaying the challenge lands on a DIFFERENT key, so binding is by lookup, not by rejection", async () => {
    const sizeBefore = net.ledger().attestations.size();

    // Give the Refiner a fresh, live credential (its credA was consumed in
    // step 3, and every profile now rejects consumed credentials), so this is a
    // perfectly valid consumer-profile proof by a DIFFERENT holder.
    const credHijack: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 1n,
      batchSecret: bytes32("batch:hijacker"),
    };
    mine.privateState = forIssue(
      mine.privateState,
      { originId: credHijack.originId, materialType: credHijack.materialType, carbonClass: 1n, batchSecret: credHijack.batchSecret },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, credHijack));
    refiner.privateState = forHold(refiner.privateState, credHijack);

    // CH1 is the very challenge the Battery Manufacturer already answered.
    await expect(net.attestConsumer(refiner, CH1)).resolves.toBeDefined();

    const l = net.ledger();
    const batteryKey = attKey(CH1, BATTERY_ID, CONSUMER);
    const refinerKey = attKey(CH1, REFINER_ID, CONSUMER);

    // Two records, one challenge, two different keys.
    expect(hex(batteryKey)).not.toBe(hex(refinerKey));
    expect(l.attestations.size()).toBe(sizeBefore + 1n);

    // The verifier recomputes the key for the party it is dealing with. It sees
    // exactly the Battery Manufacturer's record, made under policyVersion 5,
    // completely unaffected by the hijack.
    expect(l.attestations.lookup(batteryKey)).toEqual({
      profile: CONSUMER,
      policyVersion: 5n,
    });
    // The hijacker's attestation exists, but as a separate record under its own
    // key, made under the current policy version.
    expect(l.attestations.lookup(refinerKey)).toEqual({
      profile: CONSUMER,
      policyVersion: 7n,
    });
  });
});

// ---------------------------------------------------------------------------
// Negative cases, each on a fresh chain.
// ---------------------------------------------------------------------------

describe("Veilance negative cases", () => {
  it("an uncertified party cannot issue provenance", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const rogueSecret = bytes32("secret:rogue-supplier");
    const rogue = new Party(
      "rogue",
      createVeilancePrivateState(rogueSecret, bytes32("cert:X/forged")),
    );
    rogue.privateState = forIssue(
      rogue.privateState,
      {
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 1n,
        batchSecret: bytes32("batch:rogue"),
      },
      REFINER_ID,
    );

    const before = snapshot(net.ledger());
    await expect(
      net.issueProvenance(
        rogue,
        seal(net.ledger().partyEncKeys.lookup(REFINER_ID), {
          ownerId: REFINER_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 1n,
          batchSecret: bytes32("batch:rogue"),
        }),
      ),
    ).rejects.toThrow(/supplier is not certified/);
    expect(snapshot(net.ledger())).toEqual(before);
  });

  it("a certified supplier cannot issue provenance for an uncertified origin", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: ORIGIN_UNCERTIFIED,
        materialType: MATERIAL_COBALT,
        carbonClass: 1n,
        batchSecret: bytes32("batch:bad-origin"),
      },
      REFINER_ID,
    );

    const before = snapshot(net.ledger());
    await expect(
      net.issueProvenance(
        mine,
        seal(net.ledger().partyEncKeys.lookup(REFINER_ID), {
          ownerId: REFINER_ID,
          originId: ORIGIN_UNCERTIFIED,
          materialType: MATERIAL_COBALT,
          carbonClass: 1n,
          batchSecret: bytes32("batch:bad-origin"),
        }),
      ),
    ).rejects.toThrow(/origin is not certified/);
    expect(snapshot(net.ledger())).toEqual(before);
  });

  it("a party cannot spend a credential it does not own", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 3n,
        batchSecret: BATCH_1,
      },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    }));

    // The Battery Manufacturer knows cA's contents but not the Refiner's secret.
    const thief = newBattery();
    thief.privateState = forTransfer(
      thief.privateState,
      {
        ownerId: REFINER_ID,
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 3n,
        batchSecret: BATCH_1,
      },
      BATTERY_ID,
      4n,
      BATCH_2,
    );

    const before = snapshot(net.ledger());
    await expect(
      net.transferProvenance(
        thief,
        sealTo(net, {
          ownerId: BATTERY_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 4n,
          batchSecret: BATCH_2,
        }),
      ),
    ).rejects.toThrow(/does not own this credential/);
    expect(snapshot(net.ledger())).toEqual(before);
  });

  it("carbon class may not be reset downwards across a transfer", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 4n,
        batchSecret: BATCH_1,
      },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 4n,
      batchSecret: BATCH_1,
    }));

    const refiner = newRefiner();
    const held: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 4n,
      batchSecret: BATCH_1,
    };

    // Laundering attempt: carry the provenance forward but claim class 0.
    refiner.privateState = forTransfer(refiner.privateState, held, BATTERY_ID, 0n, BATCH_2);
    const before = snapshot(net.ledger());
    const downgraded = sealTo(net, {
      ownerId: BATTERY_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 0n,
      batchSecret: BATCH_2,
    });
    await expect(net.transferProvenance(refiner, downgraded)).rejects.toThrow(
      /carbon class may not decrease/,
    );
    expect(snapshot(net.ledger())).toEqual(before);

    // Keeping or worsening the class is allowed.
    refiner.privateState = forTransfer(refiner.privateState, held, BATTERY_ID, 4n, BATCH_2);
    await expect(
      net.transferProvenance(
        refiner,
        sealTo(net, {
          ownerId: BATTERY_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 4n,
          batchSecret: BATCH_2,
        }),
      ),
    ).resolves.toBeDefined();
  });

  // Rotate-on-attest (CONTRACT_DESIGN.md). Every attest* circuit spends the
  // proven credential and re-mints it to the same owner, so:
  //   - a credential already passed downstream fails EVERY profile;
  //   - the nullifier an attestation publishes is never published again, so
  //     the attestation cannot be linked to the holder's later transfer.
  it("every profile rejects a consumed credential", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    const credential: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    mine.privateState = forIssue(
      mine.privateState,
      { originId: ORIGIN_CONGO_MINE_X, materialType: MATERIAL_COBALT, carbonClass: 3n, batchSecret: BATCH_1 },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, credential));

    const refiner = newRefiner();
    refiner.privateState = forTransfer(refiner.privateState, credential, BATTERY_ID, 4n, BATCH_2);
    await net.transferProvenance(
      refiner,
      sealTo(net, { ownerId: BATTERY_ID, originId: ORIGIN_CONGO_MINE_X, materialType: MATERIAL_COBALT, carbonClass: 4n, batchSecret: BATCH_2 }),
    );

    refiner.privateState = forHold(refiner.privateState, credential);
    const before = snapshot(net.ledger());
    await expect(net.attestConsumer(refiner, bytes32("challenge:stale-consumer"))).rejects.toThrow(/credential already consumed/);
    await expect(net.attestProcurement(refiner, bytes32("challenge:stale-procurement"))).rejects.toThrow(/credential already consumed/);
    await expect(net.attestRegulator(refiner, bytes32("challenge:stale-regulator"))).rejects.toThrow(/credential already consumed/);
    expect(snapshot(net.ledger())).toEqual(before);
  });

  it("an attestation rotates the credential: the old one is dead, the new one still transfers, and nothing links the two", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    const credential: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    mine.privateState = forIssue(
      mine.privateState,
      { originId: ORIGIN_CONGO_MINE_X, materialType: MATERIAL_COBALT, carbonClass: 3n, batchSecret: BATCH_1 },
      REFINER_ID,
    );
    const issued = await net.issueProvenance(mine, sealTo(net, credential));

    const refiner = newRefiner();
    refiner.privateState = forHold(refiner.privateState, credential);
    const leavesBefore = net.ledger().provenanceTree.firstFree();
    const [attNullifier, rotatedCommitment] = await net.attestProcurement(refiner, bytes32("challenge:rotate"));

    // One nullifier and one fresh leaf were added; the rotated commitment is a
    // new, unrelated value (same owner/origin/material/class, fresh secret).
    expect(net.ledger().nullifiers.member(attNullifier)).toBe(true);
    expect(net.ledger().provenanceTree.firstFree()).toBe(leavesBefore + 1n);
    expect(hex(rotatedCommitment)).not.toBe(hex(issued));
    const rotated = refiner.privateState.held!;
    expect(hex(pureCircuits.commitmentOf(rotated))).toBe(hex(rotatedCommitment));
    expect(rotated.carbonClass).toBe(3n);

    // The pre-rotation credential is dead for every operation.
    const stale = new Party("stale-refiner", forHold(refiner.privateState, credential));
    await expect(net.attestConsumer(stale, bytes32("challenge:reuse-old"))).rejects.toThrow(/credential already consumed/);

    // The rotated credential still transfers, and its transfer publishes a
    // DIFFERENT nullifier from the attestation's — no on-chain link between them.
    refiner.privateState = forTransfer(refiner.privateState, rotated, BATTERY_ID, 4n, BATCH_2);
    const [transferNullifier] = await net.transferProvenance(
      refiner,
      sealTo(net, { ownerId: BATTERY_ID, originId: ORIGIN_CONGO_MINE_X, materialType: MATERIAL_COBALT, carbonClass: 4n, batchSecret: BATCH_2 }),
    );
    expect(hex(transferNullifier)).not.toBe(hex(attNullifier));
  });

  // Witnesses are untrusted code that may return a DIFFERENT value on every
  // call. transferProvenance therefore binds each witness to a const before use:
  // one evaluation checked, the same evaluation committed.
  it("a witness that changes its answer between calls cannot split check from commit", async () => {
    let calls = 0;
    const flipFlop = {
      // First call claims a compliant class 9 (>= upstream 3, so the monotonicity
      // check passes); a second call would claim 0 for the payload.
      newCarbonClass: ({
        privateState,
      }: {
        privateState: VeilancePrivateState;
      }): [VeilancePrivateState, bigint] => {
        calls += 1;
        return [privateState, calls === 1 ? 9n : 0n];
      },
    };

    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin, flipFlop);
    await bootstrap(net, admin);

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 3n,
        batchSecret: BATCH_1,
      },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    }));

    const refiner = newRefiner();
    refiner.privateState = forTransfer(
      refiner.privateState,
      {
        ownerId: REFINER_ID,
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 3n,
        batchSecret: BATCH_1,
      },
      BATTERY_ID,
      0n, // ignored: the override supplies the value
      BATCH_2,
    );

    // The honest sender seals what it actually intends to commit: class 9.
    const entry = sealTo(net, {
      ownerId: BATTERY_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 9n,
      batchSecret: BATCH_2,
    });

    calls = 0;
    const [, newCommitment] = await net.transferProvenance(refiner, entry);

    // Exactly one evaluation, and the committed class is the one that was checked.
    expect(calls).toBe(1);
    expect(hex(newCommitment)).toBe(
      hex(
        pureCircuits.commitmentOf({
          ownerId: BATTERY_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 9n,
          batchSecret: BATCH_2,
        }),
      ),
    );
  });

  it("a credential that was never issued cannot be transferred", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const refiner = newRefiner();
    refiner.privateState = forTransfer(
      refiner.privateState,
      {
        ownerId: REFINER_ID,
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 3n,
        batchSecret: bytes32("batch:never-issued"),
      },
      BATTERY_ID,
      4n,
      BATCH_2,
    );

    const before = snapshot(net.ledger());
    await expect(
      net.transferProvenance(
        refiner,
        sealTo(net, {
          ownerId: BATTERY_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 4n,
          batchSecret: BATCH_2,
        }),
      ),
    ).rejects.toThrow(/not in the provenance tree/);
    expect(snapshot(net.ledger())).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Change log v2 — holder-bound, versioned attestations. Each on a fresh chain.
// ---------------------------------------------------------------------------

describe("Veilance attestation binding (v2)", () => {
  /** Fresh chain, bootstrapped, with the Battery Manufacturer holding a class-3 credential. */
  async function chainWithBatteryHolding(): Promise<{
    net: VeilanceNetwork;
    admin: Party;
    battery: Party;
  }> {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    const spec = {
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    mine.privateState = forIssue(mine.privateState, spec, BATTERY_ID);
    await net.issueProvenance(mine, sealTo(net, { ownerId: BATTERY_ID, ...spec }));

    const battery = newBattery();
    battery.privateState = forHold(battery.privateState, {
      ownerId: BATTERY_ID,
      ...spec,
    });
    return { net, admin, battery };
  }

  // The key is H("veilance:att", challenge, ownerId, profile), so a replay is
  // only a replay when all three match. Same challenge under a DIFFERENT profile
  // is a different key and is intentionally allowed: a verifier may legitimately
  // ask one holder for both a consumer-grade and a procurement-grade proof under
  // a single challenge, and read the two results back separately.
  it("replay — same holder + same challenge + same profile is rejected; a different profile is allowed", async () => {
    const { net, battery } = await chainWithBatteryHolding();
    const ch = bytes32("challenge:replay-probe");

    await net.attestConsumer(battery, ch);
    expect(net.ledger().attestations.lookup(attKey(ch, BATTERY_ID, CONSUMER))).toEqual({
      profile: CONSUMER,
      policyVersion: 5n,
    });

    // Exact replay — rejected, and the ledger is byte-identical afterwards.
    const before = snapshot(net.ledger());
    await expect(net.attestConsumer(battery, ch)).rejects.toThrow(
      /challenge already used by this holder for this profile/,
    );
    expect(snapshot(net.ledger())).toEqual(before);

    // Same holder, same challenge, DIFFERENT profile — allowed by design.
    await expect(net.attestProcurement(battery, ch)).resolves.toBeDefined();
    expect(net.ledger().attestations.lookup(attKey(ch, BATTERY_ID, PROCUREMENT))).toEqual({
      profile: PROCUREMENT,
      policyVersion: 5n,
    });
    expect(net.ledger().attestations.size()).toBe(2n);
  });

  // Change B. An attestation records the policy version it was proven under, so
  // a verifier reading it later can tell whether the policy has moved since.
  it("freshness — the attestation keeps the policy version it was made under while the ledger moves on", async () => {
    const { net, admin, battery } = await chainWithBatteryHolding();
    const ch = bytes32("challenge:freshness");

    const versionAtProof = net.ledger().policyVersion;
    expect(versionAtProof).toBe(5n);

    await net.attestProcurement(battery, ch);
    const key = attKey(ch, BATTERY_ID, PROCUREMENT);
    expect(net.ledger().attestations.lookup(key)).toEqual({
      profile: PROCUREMENT,
      policyVersion: versionAtProof,
    });

    // The admin changes policy. The stored attestation must NOT follow it.
    await net.setCarbonThreshold(admin, 7n);

    expect(net.ledger().policyVersion).toBe(versionAtProof + 1n);
    expect(net.ledger().attestations.lookup(key)).toEqual({
      profile: PROCUREMENT,
      policyVersion: versionAtProof, // stale — the verifier can now detect this
    });
    // The verifier's staleness test, spelled out.
    expect(net.ledger().attestations.lookup(key).policyVersion).not.toBe(
      net.ledger().policyVersion,
    );
  });

  // Same challenge, same profile, two different holders: both calls succeed and
  // both records exist, under two different keys, on a chain where neither party
  // has any prior attestation.
  it("hijack — two holders answering one challenge produce two independent records", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const mine = newMine();
    const specR = {
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    mine.privateState = forIssue(mine.privateState, specR, REFINER_ID);
    await net.issueProvenance(mine, sealTo(net, { ownerId: REFINER_ID, ...specR }));

    const specB = { ...specR, batchSecret: BATCH_2 };
    mine.privateState = forIssue(mine.privateState, specB, BATTERY_ID);
    await net.issueProvenance(mine, sealTo(net, { ownerId: BATTERY_ID, ...specB }));

    const refiner = newRefiner();
    refiner.privateState = forHold(refiner.privateState, { ownerId: REFINER_ID, ...specR });
    const battery = newBattery();
    battery.privateState = forHold(battery.privateState, { ownerId: BATTERY_ID, ...specB });

    const ch = bytes32("challenge:issued-to-battery");

    // The verifier issued `ch` to the Battery Manufacturer. The Refiner overhears
    // it and front-runs with its own perfectly valid credential.
    await expect(net.attestConsumer(refiner, ch)).resolves.toBeDefined();
    // The intended holder answers afterwards — NOT blocked, because the key differs.
    await expect(net.attestConsumer(battery, ch)).resolves.toBeDefined();

    const l = net.ledger();
    expect(l.attestations.size()).toBe(2n);
    expect(hex(attKey(ch, BATTERY_ID, CONSUMER))).not.toBe(
      hex(attKey(ch, REFINER_ID, CONSUMER)),
    );
    // The verifier looks up the key for the party it dealt with, and finds it.
    expect(l.attestations.lookup(attKey(ch, BATTERY_ID, CONSUMER))).toEqual({
      profile: CONSUMER,
      policyVersion: 5n,
    });
    expect(l.attestations.lookup(attKey(ch, REFINER_ID, CONSUMER))).toEqual({
      profile: CONSUMER,
      policyVersion: 5n,
    });
    // And the raw challenge is not a key at all.
    expect(l.attestations.member(ch)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Change log v3 — on-chain encrypted credential inbox.
//
// The property under test: a recipient can reconstruct a credential's PRE-IMAGE
// from public chain data plus its own two secrets (partySecret, encSk) and
// nothing else. No out-of-band channel anywhere in these tests.
// ---------------------------------------------------------------------------

describe("Veilance encrypted inbox (v3)", () => {
  it("registerEncKey — every party publishes a key, and can only ever write its own slot", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const l = net.ledger();
    expect(l.partyEncKeys.size()).toBe(4n);
    expect(hex(l.partyEncKeys.lookup(MINE_ID))).toBe(hex(MINE_KEYS.encPk));
    expect(hex(l.partyEncKeys.lookup(REFINER_ID))).toBe(hex(REFINER_KEYS.encPk));
    expect(hex(l.partyEncKeys.lookup(BATTERY_ID))).toBe(hex(BATTERY_KEYS.encPk));
    expect(hex(l.partyEncKeys.lookup(partyIdOf(ADMIN_SECRET)))).toBe(hex(ADMIN_KEYS.encPk));

    // The circuit takes only a public key — there is no partyId parameter to
    // aim at someone else's slot. An impostor's write lands under the partyId
    // derived from ITS OWN secret, leaving the victim's entry untouched.
    const impostorSecret = bytes32("secret:impostor");
    const impostor = new Party("impostor", createVeilancePrivateState(impostorSecret));
    const impostorKeys = generateEncKeypair();
    await net.registerEncKey(impostor, impostorKeys.encPk);

    const after = net.ledger();
    expect(after.partyEncKeys.size()).toBe(5n);
    // The Refiner's key is exactly what the Refiner registered.
    expect(hex(after.partyEncKeys.lookup(REFINER_ID))).toBe(hex(REFINER_KEYS.encPk));
    // The impostor's key is under the impostor's own id.
    expect(hex(after.partyEncKeys.lookup(partyIdOf(impostorSecret)))).toBe(
      hex(impostorKeys.encPk),
    );

    // Re-registering rotates in place: same slot, new key, no new entry.
    const rotated = generateEncKeypair();
    await net.registerEncKey(newRefiner(), rotated.encPk);
    expect(net.ledger().partyEncKeys.size()).toBe(5n);
    expect(hex(net.ledger().partyEncKeys.lookup(REFINER_ID))).toBe(hex(rotated.encPk));
  });

  it("receive-by-scan — the Refiner and BatteryMfr recover their credentials from chain data alone", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const credA: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    const credB: Credential = {
      ownerId: BATTERY_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 4n,
      batchSecret: BATCH_2,
    };

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: credA.originId,
        materialType: credA.materialType,
        carbonClass: credA.carbonClass,
        batchSecret: credA.batchSecret,
      },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, credA));

    expect(net.ledger().credentialInboxCount).toBe(1n);
    expect(net.ledger().credentialInbox.lookup(0n).length).toBe(ENTRY_BYTES);

    // THE POINT: the Refiner has never been told anything out of band. It has
    // its partySecret (hence REFINER_ID), its encSk, and the public ledger.
    const scanA = scanInbox(net.ledger(), REFINER_KEYS.encSk, REFINER_ID, 0n);
    expect(scanA.credentials).toHaveLength(1);
    expect(scanA.nextIndex).toBe(1n);
    expect(scanA.credentials[0]).toEqual(credA);

    // ...and the recovered credential is USABLE: transfer with it, not with the
    // out-of-band copy.
    const recoveredA = scanA.credentials[0];
    const refiner = newRefiner();
    refiner.privateState = forTransfer(
      refiner.privateState,
      recoveredA,
      BATTERY_ID,
      credB.carbonClass,
      credB.batchSecret,
    );
    const [, cB] = await net.transferProvenance(refiner, sealTo(net, credB));
    expect(hex(cB)).toBe(hex(pureCircuits.commitmentOf(credB)));
    expect(net.ledger().credentialInboxCount).toBe(2n);

    // The Battery Manufacturer does the same, from a cold start.
    const scanB = scanInbox(net.ledger(), BATTERY_KEYS.encSk, BATTERY_ID, 0n);
    expect(scanB.credentials).toHaveLength(1);
    expect(scanB.credentials[0]).toEqual(credB);
    expect(scanB.nextIndex).toBe(2n);

    // ...and attests with the SCANNED credential.
    const battery = newBattery();
    battery.privateState = forHold(battery.privateState, scanB.credentials[0]);
    await net.attestProcurement(battery, bytes32("challenge:scanned"));
    expect(
      net.ledger().attestations.lookup(
        attKey(bytes32("challenge:scanned"), BATTERY_ID, PROCUREMENT),
      ),
    ).toEqual({ profile: PROCUREMENT, policyVersion: 5n });
  });

  it("non-recipient — nobody but the addressee can open an entry, not even its sender", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const credA: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: credA.originId,
        materialType: credA.materialType,
        carbonClass: credA.carbonClass,
        batchSecret: credA.batchSecret,
      },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, credA));

    const entry0 = net.ledger().credentialInbox.lookup(0n);

    // The Battery Manufacturer is a legitimate, certified, key-registered party.
    // Entry #0 is simply not for it.
    expect(openCredential(BATTERY_KEYS.encSk, entry0)).toBeNull();
    expect(
      scanInbox(net.ledger(), BATTERY_KEYS.encSk, BATTERY_ID, 0n).credentials,
    ).toHaveLength(0);

    // The MINE sealed this entry and still cannot reopen it: the X25519 sender
    // key was ephemeral and was discarded inside sealCredential.
    expect(openCredential(MINE_KEYS.encSk, entry0)).toBeNull();
    expect(scanInbox(net.ledger(), MINE_KEYS.encSk, MINE_ID, 0n).credentials).toHaveLength(0);

    // The admin, who can read everything on chain, gets nothing either.
    expect(openCredential(ADMIN_KEYS.encSk, entry0)).toBeNull();

    // The addressee does open it.
    expect(openCredential(REFINER_KEYS.encSk, entry0)).not.toBeNull();
  });

  it("recovery — a holder that loses its local state entirely rebuilds it by rescanning from 0", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const credA: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    const credB: Credential = {
      ownerId: BATTERY_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 4n,
      batchSecret: BATCH_2,
    };

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: credA.originId,
        materialType: credA.materialType,
        carbonClass: credA.carbonClass,
        batchSecret: credA.batchSecret,
      },
      REFINER_ID,
    );
    await net.issueProvenance(mine, sealTo(net, credA));

    const refiner = newRefiner();
    refiner.privateState = forTransfer(refiner.privateState, credA, BATTERY_ID, 4n, BATCH_2);
    await net.transferProvenance(refiner, sealTo(net, credB));

    // Disaster: the Battery Manufacturer's device is wiped. All it kept is its
    // partySecret and its encSk (the two things a wallet backs up).
    const wiped = newBattery();
    expect(wiped.privateState.held).toBeNull();

    const recovered = scanInbox(net.ledger(), BATTERY_KEYS.encSk, BATTERY_ID, 0n);
    expect(recovered.credentials).toHaveLength(1);
    expect(recovered.credentials[0]).toEqual(credB);

    // And the rebuilt state works.
    wiped.privateState = forHold(wiped.privateState, recovered.credentials[0]);
    await net.attestRegulator(wiped, bytes32("challenge:after-recovery"));
    expect(
      net.ledger().attestations.lookup(
        attKey(bytes32("challenge:after-recovery"), BATTERY_ID, REGULATOR),
      ),
    ).toEqual({ profile: REGULATOR, policyVersion: 5n });

    // Resuming from nextIndex finds nothing new.
    expect(
      scanInbox(net.ledger(), BATTERY_KEYS.encSk, BATTERY_ID, recovered.nextIndex).credentials,
    ).toHaveLength(0);
  });

  // ACCEPTED TRADE-OFF. The contract never inspects the entry — it cannot, and
  // validating it would mean putting the recipient's key and an AEAD inside the
  // circuit. So a misbehaving issuer can insert a commitment with a garbage
  // "delivery". The consequence is bounded: NOBODY can ever spend that
  // credential, because spending requires the pre-image. No value is created,
  // and no other party is harmed. It is the issuer burning its own act.
  it("garbage entry — the contract accepts it, the commitment is real, and scanners simply skip it", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const credA: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: credA.originId,
        materialType: credA.materialType,
        carbonClass: credA.carbonClass,
        batchSecret: credA.batchSecret,
      },
      REFINER_ID,
    );

    // 192 bytes of noise instead of a sealed credential.
    const garbage = new Uint8Array(ENTRY_BYTES);
    for (let i = 0; i < ENTRY_BYTES; i += 1) garbage[i] = (i * 37 + 11) % 256;

    const cA = await net.issueProvenance(mine, garbage);

    // The contract did its job: the commitment is genuinely in the tree.
    const l = net.ledger();
    expect(hex(cA)).toBe(hex(pureCircuits.commitmentOf(credA)));
    expect(l.provenanceTree.findPathForLeaf(cA)).toBeDefined();
    // ...and the garbage is on chain verbatim.
    expect(l.credentialInboxCount).toBe(1n);
    expect(hex(l.credentialInbox.lookup(0n))).toBe(hex(garbage));

    // The intended recipient gets nothing: no exception, just no credential.
    expect(openCredential(REFINER_KEYS.encSk, garbage)).toBeNull();
    expect(scanInbox(l, REFINER_KEYS.encSk, REFINER_ID, 0n).credentials).toHaveLength(0);

    // So the credential is unspendable by anyone, which is the whole cost.
    // (The Refiner cannot construct the pre-image it was never given.)
  });

  // A well-formed entry sealed to the right party but describing a credential
  // whose commitment was never inserted must also be rejected — otherwise a
  // sender could make a scanner believe in a credential that does not exist.
  it("scan rejects a well-formed entry whose commitment is not in the provenance tree", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const real: Credential = {
      ownerId: REFINER_ID,
      originId: ORIGIN_CONGO_MINE_X,
      materialType: MATERIAL_COBALT,
      carbonClass: 3n,
      batchSecret: BATCH_1,
    };
    // Same shape, never issued.
    const phantom: Credential = { ...real, batchSecret: bytes32("batch:phantom") };

    const mine = newMine();
    mine.privateState = forIssue(
      mine.privateState,
      {
        originId: real.originId,
        materialType: real.materialType,
        carbonClass: real.carbonClass,
        batchSecret: real.batchSecret,
      },
      REFINER_ID,
    );
    // The Mine issues `real` but delivers a sealed `phantom`.
    await net.issueProvenance(mine, sealTo(net, phantom));

    // The entry opens — it is correctly addressed and internally consistent...
    const opened = openCredential(REFINER_KEYS.encSk, net.ledger().credentialInbox.lookup(0n));
    expect(opened).not.toBeNull();
    expect(hex(opened!.batchSecret)).toBe(hex(phantom.batchSecret));

    // ...but scanInbox drops it, because that commitment is not in the tree.
    expect(
      scanInbox(net.ledger(), REFINER_KEYS.encSk, REFINER_ID, 0n).credentials,
    ).toHaveLength(0);
  });

  it("a rejected call appends nothing to the inbox", async () => {
    const admin = newAdmin();
    const net = await VeilanceNetwork.deploy(admin);
    await bootstrap(net, admin);

    const rogue = new Party(
      "rogue",
      createVeilancePrivateState(bytes32("secret:rogue-supplier"), bytes32("cert:X/forged")),
    );
    rogue.privateState = forIssue(
      rogue.privateState,
      {
        originId: ORIGIN_CONGO_MINE_X,
        materialType: MATERIAL_COBALT,
        carbonClass: 1n,
        batchSecret: bytes32("batch:rogue"),
      },
      REFINER_ID,
    );

    const before = snapshot(net.ledger());
    expect(before.inboxCount).toBe(0n);

    await expect(
      net.issueProvenance(
        rogue,
        sealTo(net, {
          ownerId: REFINER_ID,
          originId: ORIGIN_CONGO_MINE_X,
          materialType: MATERIAL_COBALT,
          carbonClass: 1n,
          batchSecret: bytes32("batch:rogue"),
        }),
      ),
    ).rejects.toThrow(/supplier is not certified/);

    // The whole public state, inbox contents included, is byte-identical.
    expect(snapshot(net.ledger())).toEqual(before);
    expect(net.ledger().credentialInboxCount).toBe(0n);
    expect(net.ledger().credentialInbox.isEmpty()).toBe(true);
  });
});
