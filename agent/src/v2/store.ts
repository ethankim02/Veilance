// Veilance B-2 — tenants and their vaults, persisted as one JSON file per
// tenant under V2_STATE_DIR/tenants/<id>/tenant.json. The party secret lives
// here, on the node's disk: whoever runs the node holds the keys.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Lot, PeriodAccount } from "../../../contract/src/witnesses_v2.js";
import { fromHex, toHex } from "../bytes.js";
import { IS_LOCAL_DEVNET } from "../../../contract/e2e/lib/config.js";
import { MASTER_KEY_HEX, V2_STATE_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// JSON shapes (bigint → decimal string, bytes → hex)
// ---------------------------------------------------------------------------

export type SlotJson = { originId: string; issuerId: string };
export type LotJson = {
  ownerId: string;
  materialType: string;
  quantity: string;
  carbonClass: string;
  custody: string;
  origins: SlotJson[];
  recycledEuKg: string;
  recycledOtherKg: string;
  batchSecret: string;
};
export type AccountJson = {
  ownerId: string;
  plantId: string;
  period: string;
  materialType: string;
  totalKg: string;
  recycledEuKg: string;
  recycledOtherKg: string;
  secret: string;
};

export const lotToJson = (l: Lot): LotJson => ({
  ownerId: toHex(l.ownerId),
  materialType: toHex(l.materialType),
  quantity: l.quantity.toString(),
  carbonClass: l.carbonClass.toString(),
  custody: l.custody.toString(),
  origins: l.origins.map((s) => ({ originId: toHex(s.originId), issuerId: toHex(s.issuerId) })),
  recycledEuKg: l.recycledEuKg.toString(),
  recycledOtherKg: l.recycledOtherKg.toString(),
  batchSecret: toHex(l.batchSecret),
});
export const lotFromJson = (j: LotJson): Lot => ({
  ownerId: fromHex(j.ownerId),
  materialType: fromHex(j.materialType),
  quantity: BigInt(j.quantity),
  carbonClass: BigInt(j.carbonClass),
  custody: BigInt(j.custody),
  origins: j.origins.map((s) => ({ originId: fromHex(s.originId), issuerId: fromHex(s.issuerId) })),
  recycledEuKg: BigInt(j.recycledEuKg),
  recycledOtherKg: BigInt(j.recycledOtherKg),
  batchSecret: fromHex(j.batchSecret),
});
export const accountToJson = (a: PeriodAccount): AccountJson => ({
  ownerId: toHex(a.ownerId),
  plantId: toHex(a.plantId),
  period: a.period.toString(),
  materialType: toHex(a.materialType),
  totalKg: a.totalKg.toString(),
  recycledEuKg: a.recycledEuKg.toString(),
  recycledOtherKg: a.recycledOtherKg.toString(),
  secret: toHex(a.secret),
});
export const accountFromJson = (j: AccountJson): PeriodAccount => ({
  ownerId: fromHex(j.ownerId),
  plantId: fromHex(j.plantId),
  period: BigInt(j.period),
  materialType: fromHex(j.materialType),
  totalKg: BigInt(j.totalKg),
  recycledEuKg: BigInt(j.recycledEuKg),
  recycledOtherKg: BigInt(j.recycledOtherKg),
  secret: fromHex(j.secret),
});

// ---------------------------------------------------------------------------
// Vault records
// ---------------------------------------------------------------------------

export type LotStatus = "ACTIVE" | "CONSUMED";

export type StoredLot = {
  /** The commitment the lot first appeared with. Stable across attestation rotations. */
  id: string;
  /** Current commitment. */
  commitment: string;
  lot: LotJson;
  status: LotStatus;
  /** How this vault got it. */
  source: "inbox" | "change" | "process" | "rotation";
  memo?: string;
  inboxIndex?: string;
  createdAt: string;
  consumedAt?: string;
  consumedByJob?: string;
};

export type StoredAccount = {
  /** Period marker hex — unique per (owner, plant, period, material). */
  id: string;
  plant: string;
  period: number;
  material: string;
  commitment: string;
  account: AccountJson;
  status: "OPEN" | "DECLARED";
  declaredBps?: number;
  /** Opening of the on-chain total commitment — handed to the notified body only. */
  salt?: string;
  declaredTx?: string;
};

export type V2JobStage = "queued" | "proving" | "confirmed" | "rejected" | "failed";
export type V2Job = {
  id: string;
  tenant: string;
  op: string;
  stage: V2JobStage;
  createdAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  txHash?: string;
  blockHeight?: number;
  result?: Record<string, unknown>;
  error?: string;
};

/**
 * What an in-flight operation expects to change. Written BEFORE the proof so
 * that, if the process dies after the transaction lands, the next operation
 * can recognise the minted commitments on chain and adopt them.
 */
export type PendingOp = {
  jobId: string;
  spendLots: string[]; // StoredLot ids
  /** Nullifiers the op will publish — how a landed op with no new commitment of ours is recognised. */
  spendNullifiers: string[];
  spendAccount?: string; // StoredAccount id
  mintLots: StoredLot[];
  mintAccount?: StoredAccount;
  rotate?: { lotId: string; commitment: string; lot: LotJson };
};

export type TenantRole = "admin" | "company";

export type TenantFile = {
  id: string;
  name: string;
  role: TenantRole;
  apiKeyHash: string;
  partySecret: string;
  certId: string;
  encPk: string;
  encSk: string;
  lots: StoredLot[];
  accounts: StoredAccount[];
  inboxCursor: string;
  jobs: V2Job[];
  pending: PendingOp | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const tenantsDir = () => path.join(V2_STATE_DIR, "tenants");
const tenantPath = (id: string) => path.join(tenantsDir(), id, "tenant.json");

const writeJsonAtomic = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const newApiKey = () => `vk_${randomBytes(24).toString("hex")}`;

const MAX_JOBS = 200;

// ---------------------------------------------------------------------------
// Secrets at rest: partySecret and encSk are sealed with the node master key
// (AES-256-GCM, fresh IV per write, tenant id as AAD so a sealed value cannot
// be moved into another tenant's file). In memory they stay plain hex.
// ---------------------------------------------------------------------------

const masterKeyPath = () => path.join(V2_STATE_DIR, "master-key");
let masterKey: Buffer | null = null;
const getMasterKey = (): Buffer => {
  if (masterKey) return masterKey;
  let hex = MASTER_KEY_HEX;
  if (!hex && fs.existsSync(masterKeyPath())) hex = fs.readFileSync(masterKeyPath(), "utf8").trim();
  if (!hex) {
    if (!IS_LOCAL_DEVNET) throw new Error("VEILANCE_V2_MASTER_KEY (64 hex) is required outside the local devnet");
    hex = randomBytes(32).toString("hex");
    fs.mkdirSync(V2_STATE_DIR, { recursive: true });
    fs.writeFileSync(masterKeyPath(), hex + "\n", { mode: 0o600 });
    console.log(`Generated a local node master key at ${masterKeyPath()}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("node master key must be 64 hex characters");
  masterKey = Buffer.from(hex, "hex");
  return masterKey;
};

const SEALED = "enc:v1:";
const seal = (tenantId: string, plainHex: string): string => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  c.setAAD(Buffer.from(tenantId));
  const ct = Buffer.concat([c.update(Buffer.from(plainHex, "hex")), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
};
const unseal = (tenantId: string, value: string): string => {
  if (!value.startsWith(SEALED)) return value; // written before encryption at rest existed
  const raw = Buffer.from(value.slice(SEALED.length), "base64");
  const d = createDecipheriv("aes-256-gcm", getMasterKey(), raw.subarray(0, 12));
  d.setAAD(Buffer.from(tenantId));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("hex");
};

export const saveTenant = (t: TenantFile): void => {
  if (t.jobs.length > MAX_JOBS) t.jobs = t.jobs.slice(-MAX_JOBS);
  writeJsonAtomic(tenantPath(t.id), { ...t, partySecret: seal(t.id, t.partySecret), encSk: seal(t.id, t.encSk) });
};

export const loadTenants = (): TenantFile[] => {
  if (!fs.existsSync(tenantsDir())) return [];
  return fs
    .readdirSync(tenantsDir())
    .filter((d) => fs.existsSync(tenantPath(d)))
    .map((d) => {
      const t = JSON.parse(fs.readFileSync(tenantPath(d), "utf8")) as TenantFile;
      const plaintextOnDisk = !t.partySecret.startsWith(SEALED) || !t.encSk.startsWith(SEALED);
      const open = { ...t, partySecret: unseal(t.id, t.partySecret), encSk: unseal(t.id, t.encSk) };
      if (plaintextOnDisk) saveTenant(open); // migrate older files
      return open;
    });
};

const deploymentPath = () => path.join(V2_STATE_DIR, "deployment.json");
export const loadDeploymentV2 = (): { contractAddress: string } | null =>
  fs.existsSync(deploymentPath()) ? (JSON.parse(fs.readFileSync(deploymentPath(), "utf8")) as { contractAddress: string }) : null;
export const saveDeploymentV2 = (d: { contractAddress: string }) => writeJsonAtomic(deploymentPath(), d);

/** Local-dev convenience: the admin API key, written once when the admin tenant is created. */
export const adminKeyPath = () => path.join(V2_STATE_DIR, "admin-api-key");
