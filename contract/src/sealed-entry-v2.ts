// Veilance v2 — sealed lot delivery (docs/PROVENANCE_V2.md §5).
//
// Same construction as v1's sealed-entry.ts (ephemeral X25519 → HKDF-SHA256 →
// AES-256-GCM, trial decryption by recipients), with a larger plaintext:
//
//   entry (332 B) = ver 1 | suite 1 | ephPk 32 | nonce 12 | tag 16 | ct 270
//   plaintext (270 B) = materialType 32 | quantity 4 (BE) | carbonClass 1 | custody 1
//                     | origins 2×(originId 32, issuerId 32) | batchSecret 32
//                     | commitment 32 | memo 32 | recycledEuKg 4 | recycledOtherKg 4
//
// `memo` is NOT part of the commitment: an index (e.g. an order-number hash),
// never evidence.

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { pureCircuits, type Ledger, type Lot, type OriginSlot } from "./managed/veilance_v2/contract/index.js";

export { generateEncKeypair, type EncKeypair } from "./sealed-entry.js";

export const ENTRY_BYTES_V2 = 332;
const PLAINTEXT_BYTES = 270;
const VERSION = 2;
const SUITE = 1;

const OFF_VER = 0;
const OFF_SUITE = 1;
const OFF_EPH_PK = 2;
const OFF_NONCE = 34;
const OFF_TAG = 46;
const OFF_CT = 62;

const P_MATERIAL = 0;
const P_QUANTITY = 32;
const P_CARBON = 36;
const P_CUSTODY = 37;
const P_ORIGINS = 38; // 2 × 64
const P_BATCH = 166;
const P_COMMITMENT = 198;
const P_MEMO = 230;
const P_REC_EU = 262;
const P_REC_OTHER = 266;

const HKDF_INFO = new TextEncoder().encode("veilance:lot:v2");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const publicKeyFromRaw = (raw: Uint8Array) =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
const privateKeyFromRaw = (raw: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]), format: "der", type: "pkcs8" });
const deriveKey = (shared: Uint8Array, ephPk: Uint8Array, recipientPk: Uint8Array): Buffer =>
  Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(ephPk), Buffer.from(recipientPk)]), HKDF_INFO, 32));
const aad = () => Buffer.from([VERSION, SUITE]);

/** Everything but the owner (the recipient knows who it is), plus commitment and memo. */
export type SealableLot = Omit<Lot, "ownerId"> & { readonly commitment: Uint8Array; readonly memo?: Uint8Array };

const pack = (l: SealableLot): Buffer => {
  const p = Buffer.alloc(PLAINTEXT_BYTES);
  if (l.quantity < 0n || l.quantity > 0xffffffffn) throw new Error(`sealLot: quantity ${l.quantity} does not fit Uint<32>`);
  if (l.carbonClass < 0n || l.carbonClass > 255n) throw new Error(`sealLot: carbonClass ${l.carbonClass} does not fit Uint<8>`);
  if (l.origins.length !== 2) throw new Error("sealLot: exactly 2 origin slots expected");
  Buffer.from(l.materialType).copy(p, P_MATERIAL);
  p.writeUInt32BE(Number(l.quantity), P_QUANTITY);
  p[P_CARBON] = Number(l.carbonClass);
  p[P_CUSTODY] = Number(l.custody);
  l.origins.forEach((s, i) => {
    Buffer.from(s.originId).copy(p, P_ORIGINS + i * 64);
    Buffer.from(s.issuerId).copy(p, P_ORIGINS + i * 64 + 32);
  });
  Buffer.from(l.batchSecret).copy(p, P_BATCH);
  Buffer.from(l.commitment).copy(p, P_COMMITMENT);
  if (l.memo) Buffer.from(l.memo).copy(p, P_MEMO);
  p.writeUInt32BE(Number(l.recycledEuKg), P_REC_EU);
  p.writeUInt32BE(Number(l.recycledOtherKg), P_REC_OTHER);
  return p;
};

/** Seal a lot pre-image to `recipientPk` as the contract's `Bytes<332>` inbox cell. */
export const sealLot = (recipientPk: Uint8Array, lot: SealableLot): Uint8Array => {
  if (recipientPk.length !== 32) throw new Error(`sealLot: recipientPk must be 32 bytes, got ${recipientPk.length}`);
  const { publicKey: ephPub, privateKey: ephSec } = generateKeyPairSync("x25519");
  const ephSpki = ephPub.export({ type: "spki", format: "der" });
  const ephPk = new Uint8Array(ephSpki.subarray(ephSpki.length - 32));
  const key = deriveKey(diffieHellman({ privateKey: ephSec, publicKey: publicKeyFromRaw(recipientPk) }), ephPk, recipientPk);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad());
  const ct = Buffer.concat([cipher.update(pack(lot)), cipher.final()]);
  const entry = Buffer.alloc(ENTRY_BYTES_V2);
  entry[OFF_VER] = VERSION;
  entry[OFF_SUITE] = SUITE;
  Buffer.from(ephPk).copy(entry, OFF_EPH_PK);
  nonce.copy(entry, OFF_NONCE);
  cipher.getAuthTag().copy(entry, OFF_TAG);
  ct.copy(entry, OFF_CT);
  return new Uint8Array(entry);
};

export type OpenedLot = Omit<Lot, "ownerId"> & { readonly commitment: Uint8Array; readonly memo: Uint8Array };

/** Try to open one inbox entry. `null` (never a throw) when it is not ours or is malformed. */
export const openLot = (encSk: Uint8Array, entry: Uint8Array): OpenedLot | null => {
  try {
    if (entry.length !== ENTRY_BYTES_V2) return null;
    const buf = Buffer.from(entry);
    if (buf[OFF_VER] !== VERSION || buf[OFF_SUITE] !== SUITE) return null;
    const ephPk = new Uint8Array(buf.subarray(OFF_EPH_PK, OFF_EPH_PK + 32));
    const sk = privateKeyFromRaw(encSk);
    const ownSpki = createPublicKey(sk).export({ type: "spki", format: "der" });
    const ownPk = new Uint8Array(ownSpki.subarray(ownSpki.length - 32));
    const key = deriveKey(diffieHellman({ privateKey: sk, publicKey: publicKeyFromRaw(ephPk) }), ephPk, ownPk);
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(OFF_NONCE, OFF_NONCE + 12));
    decipher.setAAD(aad());
    decipher.setAuthTag(buf.subarray(OFF_TAG, OFF_TAG + 16));
    const pt = Buffer.concat([decipher.update(buf.subarray(OFF_CT, OFF_CT + PLAINTEXT_BYTES)), decipher.final()]);
    const slot = (i: number): OriginSlot => ({
      originId: new Uint8Array(pt.subarray(P_ORIGINS + i * 64, P_ORIGINS + i * 64 + 32)),
      issuerId: new Uint8Array(pt.subarray(P_ORIGINS + i * 64 + 32, P_ORIGINS + i * 64 + 64)),
    });
    return {
      materialType: new Uint8Array(pt.subarray(P_MATERIAL, P_MATERIAL + 32)),
      quantity: BigInt(pt.readUInt32BE(P_QUANTITY)),
      carbonClass: BigInt(pt[P_CARBON]),
      custody: BigInt(pt[P_CUSTODY]),
      origins: [slot(0), slot(1)],
      batchSecret: new Uint8Array(pt.subarray(P_BATCH, P_BATCH + 32)),
      commitment: new Uint8Array(pt.subarray(P_COMMITMENT, P_COMMITMENT + 32)),
      memo: new Uint8Array(pt.subarray(P_MEMO, P_MEMO + 32)),
      recycledEuKg: BigInt(pt.readUInt32BE(P_REC_EU)),
      recycledOtherKg: BigInt(pt.readUInt32BE(P_REC_OTHER)),
    };
  } catch {
    return null;
  }
};

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

export type ReceivedLot = { lot: Lot; commitment: Uint8Array; memo: Uint8Array; inboxIndex: bigint };

/**
 * Scan the v2 inbox from `fromIndex` and return the lots addressed to
 * `ownerId`, keeping only those that pass the checks a recipient (e.g. the
 * OEM) needs before trusting a delivery (docs/PROVENANCE_V2.md §6):
 * the sealed commitment matches the opened fields, is in the provenance tree,
 * every origin is on the certified allow-list, and the lot is unspent.
 */
export const scanLotInbox = (
  ledger: Ledger,
  encSk: Uint8Array,
  ownerId: Uint8Array,
  ownerSecret: Uint8Array,
  fromIndex = 0n,
): { lots: ReceivedLot[]; nextIndex: bigint } => {
  const lots: ReceivedLot[] = [];
  const count = ledger.lotInboxCount;
  for (let i = fromIndex; i < count; i++) {
    if (!ledger.lotInbox.member(i)) continue;
    const opened = openLot(encSk, ledger.lotInbox.lookup(i));
    if (!opened) continue;
    const { commitment, memo, ...fields } = opened;
    const lot: Lot = { ownerId, ...fields };
    const recomputed = pureCircuits.commitmentOf(lot);
    if (hex(recomputed) !== hex(commitment)) continue;
    if (!ledger.provenanceTree.findPathForLeaf(commitment)) continue;
    const originsOk = lot.origins.every((s) => s.originId.every((b) => b === 0) || !!ledger.certifiedOrigins.findPathForLeaf(s.originId));
    if (!originsOk) continue;
    if (ledger.nullifiers.member(pureCircuits.nullifierOf(commitment, ownerSecret))) continue;
    lots.push({ lot, commitment, memo, inboxIndex: i });
  }
  return { lots, nextIndex: count };
};
