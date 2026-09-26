// Veilance B-2 — tenants and their vaults, persisted as one JSON file per
// tenant under V2_STATE_DIR/tenants/<id>/tenant.json. The party secret lives
// here, on the node's disk: whoever runs the node holds the keys.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Lot, PeriodAccount } from "../../../contract/src/witnesses_v2.js";
import { fromHex, toHex } from "../bytes.js";
import { V2_STATE_DIR } from "./config.js";

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

export const saveTenant = (t: TenantFile): void => {
  if (t.jobs.length > MAX_JOBS) t.jobs = t.jobs.slice(-MAX_JOBS);
  writeJsonAtomic(tenantPath(t.id), t);
};

export const loadTenants = (): TenantFile[] => {
  if (!fs.existsSync(tenantsDir())) return [];
  return fs
    .readdirSync(tenantsDir())
    .filter((d) => fs.existsSync(tenantPath(d)))
    .map((d) => JSON.parse(fs.readFileSync(tenantPath(d), "utf8")) as TenantFile);
};

const deploymentPath = () => path.join(V2_STATE_DIR, "deployment.json");
export const loadDeploymentV2 = (): { contractAddress: string } | null =>
  fs.existsSync(deploymentPath()) ? (JSON.parse(fs.readFileSync(deploymentPath(), "utf8")) as { contractAddress: string }) : null;
export const saveDeploymentV2 = (d: { contractAddress: string }) => writeJsonAtomic(deploymentPath(), d);

/** Local-dev convenience: the admin API key, written once when the admin tenant is created. */
export const adminKeyPath = () => path.join(V2_STATE_DIR, "admin-api-key");
