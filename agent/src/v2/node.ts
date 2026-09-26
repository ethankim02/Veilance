// Veilance B-2 — the node: tenants, their contract handles, and every v2
// operation as a queued job (docs/PLATFORM_LAYER.md, agent/API_V2.md).
//
// Jobs run strictly one at a time for the whole node: the sponsor balances
// one transaction at a time anyway, and sequential jobs keep each tenant's
// vault consistent with the order its transactions landed in.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";

import { ledger as ledgerOf, pureCircuits, type Ledger } from "../../../contract/src/managed/veilance_v2/contract/index.js";
import {
  CUSTODY,
  accountAfterConsume,
  createV2PrivateState,
  forAttest,
  forConsume,
  forDeclare,
  forIssue,
  forIssueRecycled,
  forOpenPeriod,
  forProcess,
  forTransfer,
  issuedOrigins,
  lotAfterProcess,
  lotsAfterTransfer,
  maxDeclarableBps,
  openedAccount,
  partyIdOf,
  rotatedLot,
  unionOrigins,
  type IssueSpec,
  type Lot,
  type V2PrivateState,
} from "../../../contract/src/witnesses_v2.js";
import { generateEncKeypair, scanLotInbox, sealLot } from "../../../contract/src/sealed-entry-v2.js";
import { checkDevnetHealth } from "../../../contract/e2e/lib/health.js";
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK_ID } from "../../../contract/e2e/lib/config.js";
import { bytes32FromLabel, fromHex, labelFromBytes32, toHex } from "../bytes.js";
import { ZK_V2_DIR } from "./config.js";
import {
  V2_PRIVATE_STATE_ID,
  buildV2Providers,
  deployV2Staged,
  findV2,
  type V2Contract,
  type V2Providers,
} from "./contractV2.js";
import { createSponsoredProvider, fetchSponsorIdentity } from "./sponsorClient.js";
import {
  accountFromJson,
  accountToJson,
  adminKeyPath,
  hashApiKey,
  loadDeploymentV2,
  loadTenants,
  lotFromJson,
  lotToJson,
  newApiKey,
  saveDeploymentV2,
  saveTenant,
  type PendingOp,
  type StoredAccount,
  type StoredLot,
  type TenantFile,
  type TenantRole,
  type V2Job,
} from "./store.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Runtime = {
  file: TenantFile;
  providers: V2Providers;
  contract?: V2Contract;
  privateState: V2PrivateState;
};

export const nodeState: { ready: boolean; step: string; error?: string; contractAddress?: string } = {
  ready: false,
  step: "starting",
};

const runtimes = new Map<string, Runtime>();
const jobsById = new Map<string, V2Job>();
let walletProvider: ReturnType<typeof createSponsoredProvider> | null = null;
const publicData = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (u: Uint8Array) => toHex(u);

export const tenantByApiKey = (key: string): Runtime | undefined => {
  const h = hashApiKey(key);
  for (const rt of runtimes.values()) if (rt.file.apiKeyHash === h) return rt;
  return undefined;
};
export const tenantById = (id: string): Runtime | undefined => runtimes.get(id);
export const allTenants = (): Runtime[] => [...runtimes.values()];
export const getJob = (id: string): V2Job | undefined => jobsById.get(id);
export const partyIdHex = (rt: Runtime) => hex(partyIdOf(fromHex(rt.file.partySecret)));

const contractAddressOrThrow = () => {
  if (!nodeState.contractAddress) throw new ApiError("v2 contract not deployed yet — POST /v2/admin/deploy", 409, "not_deployed");
  return nodeState.contractAddress;
};
const contractOrThrow = (rt: Runtime): V2Contract => {
  contractAddressOrThrow();
  if (!rt.contract) throw new ApiError("tenant not connected to the contract yet", 409, "not_connected");
  return rt.contract;
};

export const readLedger = async (): Promise<Ledger> => {
  const state = await publicData.queryContractState(contractAddressOrThrow());
  if (state === null) throw new ApiError("v2 contract not found on chain", 502, "not_found");
  return ledgerOf(state.data);
};

const setPrivateState = async (rt: Runtime, state: V2PrivateState) => {
  rt.privateState = state;
  await rt.providers.privateStateProvider.set(V2_PRIVATE_STATE_ID, state);
};
const baseState = (rt: Runtime) => createV2PrivateState(fromHex(rt.file.partySecret), fromHex(rt.file.certId));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const attach = (file: TenantFile): Runtime => {
  if (!walletProvider) throw new Error("wallet provider not ready");
  const rt: Runtime = {
    file,
    providers: buildV2Providers(file.id, walletProvider),
    privateState: createV2PrivateState(fromHex(file.partySecret), fromHex(file.certId)),
  };
  runtimes.set(file.id, rt);
  for (const j of file.jobs) jobsById.set(j.id, j);
  return rt;
};

const connect = async (rt: Runtime, address: string) => {
  rt.providers.privateStateProvider.setContractAddress(address);
  rt.contract = await findV2(rt.providers, address, rt.privateState);
};

const createTenantFile = (name: string, role: TenantRole, apiKey: string, partySecret?: string, certId?: string): TenantFile => {
  const enc = generateEncKeypair();
  return {
    id: randomUUID().slice(0, 8),
    name,
    role,
    apiKeyHash: hashApiKey(apiKey),
    partySecret: partySecret ?? hex(crypto.getRandomValues(new Uint8Array(32))),
    certId: certId ?? hex(crypto.getRandomValues(new Uint8Array(32))),
    encPk: hex(enc.encPk),
    encSk: hex(enc.encSk),
    lots: [],
    accounts: [],
    inboxCursor: "0",
    jobs: [],
    pending: null,
    createdAt: now(),
  };
};

export const bootNode = async (): Promise<void> => {
  try {
    nodeState.step = "checking the v2 ZK build";
    if (!fs.existsSync(path.join(ZK_V2_DIR, "keys", "issueLot.prover"))) {
      throw new Error(`v2 ZK build missing at ${ZK_V2_DIR} — run \`npm run compile:zk:v2\` in contract/`);
    }
    nodeState.step = "waiting for devnet health";
    for (;;) {
      if ((await checkDevnetHealth()).allHealthy) break;
      await sleep(3_000);
    }
    setNetworkId(NETWORK_ID);

    const identity = await fetchSponsorIdentity((s) => (nodeState.step = s));
    walletProvider = createSponsoredProvider(identity);

    nodeState.step = "loading tenants";
    for (const f of loadTenants()) attach(f);
    if (![...runtimes.values()].some((r) => r.file.role === "admin")) {
      const key = newApiKey();
      const admin = createTenantFile("Policy admin", "admin", key);
      saveTenant(admin);
      attach(admin);
      fs.writeFileSync(adminKeyPath(), key + "\n", { mode: 0o600 });
      console.log(`Created the admin tenant. Admin API key written to ${adminKeyPath()}`);
    }

    const deployment = loadDeploymentV2();
    if (deployment) {
      nodeState.step = "connecting tenants to the v2 contract";
      nodeState.contractAddress = deployment.contractAddress;
      for (const rt of runtimes.values()) await connect(rt, deployment.contractAddress);
      console.log(`v2 contract at ${deployment.contractAddress}`);
    }
    nodeState.ready = true;
    nodeState.step = "ready";
    console.log("v2 node ready.");
  } catch (err) {
    nodeState.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    nodeState.step = "boot failed";
    console.error("v2 node boot failed:", nodeState.error);
  }
};

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

type Outcome = { txHash?: string; blockHeight?: number; result?: Record<string, unknown> };
type Work = { rt: Runtime; job: V2Job; exec: (job: V2Job) => Promise<Outcome> };

const queue: Work[] = [];
let draining = false;

const FAILED_ASSERT = "failed assert: ";
const assertMessage = (msg: string) => {
  const i = msg.indexOf(FAILED_ASSERT);
  return i === -1 ? null : msg.slice(i + FAILED_ASSERT.length).split(" | cause: ")[0].trim();
};

/** Error message plus its cause chain — SDK errors often wrap the useful part. */
const describeError = (err: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 5; i++) {
    parts.push(cur instanceof Error ? cur.message : typeof cur === "object" ? JSON.stringify(cur) : String(cur));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join(" | cause: ");
};

const enqueue = (rt: Runtime, op: string, exec: (job: V2Job) => Promise<Outcome>): V2Job => {
  const job: V2Job = { id: randomUUID(), tenant: rt.file.id, op, stage: "queued", createdAt: now() };
  rt.file.jobs.push(job);
  jobsById.set(job.id, job);
  saveTenant(rt.file);
  queue.push({ rt, job, exec });
  void drain();
  return job;
};

const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const { rt, job, exec } = queue.shift()!;
      const started = Date.now();
      job.stage = "proving";
      try {
        const out = await exec(job);
        Object.assign(job, out, { stage: "confirmed" as const });
      } catch (err) {
        const msg = describeError(err);
        const rejected = assertMessage(msg);
        job.stage = rejected !== null ? "rejected" : err instanceof ApiError ? "rejected" : "failed";
        job.error = rejected ?? msg;
        // A contract rejection never lands, so its pending expectations are void.
        if (rejected !== null && rt.file.pending?.jobId === job.id) rt.file.pending = null;
      } finally {
        job.finishedAt = now();
        job.elapsedMs = Date.now() - started;
        saveTenant(rt.file);
      }
      if ((job.stage as V2Job["stage"]) === "confirmed") await scanAll().catch((e) => console.warn("post-job inbox scan failed:", e));
    }
  } finally {
    draining = false;
  }
};

// ---------------------------------------------------------------------------
// Pending (crash-safe vault updates)
// ---------------------------------------------------------------------------

const lotById = (rt: Runtime, id: string): StoredLot => {
  const l = rt.file.lots.find((x) => x.id === id);
  if (!l) throw new ApiError(`lot ${id} not found in this tenant's vault`, 404, "not_found");
  return l;
};
const activeLot = (rt: Runtime, id: string): StoredLot => {
  const l = lotById(rt, id);
  if (l.status !== "ACTIVE") throw new ApiError(`lot ${id} is ${l.status}`, 409, "lot_consumed");
  return l;
};
const accountById = (rt: Runtime, id: string): StoredAccount => {
  const a = rt.file.accounts.find((x) => x.id === id);
  if (!a) throw new ApiError(`account ${id} not found`, 404, "not_found");
  return a;
};

const applyPending = (rt: Runtime, jobId: string) => {
  const p = rt.file.pending;
  if (!p) return;
  const at = now();
  for (const id of p.spendLots) {
    const l = rt.file.lots.find((x) => x.id === id);
    if (l) Object.assign(l, { status: "CONSUMED", consumedAt: at, consumedByJob: jobId });
  }
  if (p.spendAccount) {
    const a = rt.file.accounts.find((x) => x.id === p.spendAccount);
    if (a && p.mintAccount && p.mintAccount.id === a.id) Object.assign(a, p.mintAccount);
  } else if (p.mintAccount) {
    rt.file.accounts.push(p.mintAccount);
  }
  for (const l of p.mintLots) if (!rt.file.lots.some((x) => x.commitment === l.commitment)) rt.file.lots.push(l);
  if (p.rotate) {
    const l = rt.file.lots.find((x) => x.id === p.rotate!.lotId);
    if (l) Object.assign(l, { commitment: p.rotate.commitment, lot: p.rotate.lot });
  }
  rt.file.pending = null;
};

const nullifierOfLot = (rt: Runtime, s: StoredLot) => hex(pureCircuits.nullifierOf(fromHex(s.commitment), fromHex(rt.file.partySecret)));

/**
 * Adopt a pending op whose effects reached the chain; drop one that never
 * landed. Also recovers declarations made just before a crash.
 */
const reconcile = async (rt: Runtime) => {
  const p = rt.file.pending;
  const openWithSalt = rt.file.accounts.filter((a) => a.status === "OPEN" && a.salt);
  if (!p && openWithSalt.length === 0) return;
  const l = await readLedger();
  if (p) {
    const onChain = (c: string) => !!l.provenanceTree.findPathForLeaf(fromHex(c));
    const landed =
      p.spendNullifiers.some((n) => l.nullifiers.member(fromHex(n))) ||
      p.mintLots.some((m) => onChain(m.commitment)) ||
      (p.mintAccount !== undefined && onChain(p.mintAccount.commitment)) ||
      (p.rotate !== undefined && onChain(p.rotate.commitment));
    if (landed) applyPending(rt, p.jobId);
    else rt.file.pending = null;
  }
  for (const a of openWithSalt) {
    const acct = accountFromJson(a.account);
    const key = pureCircuits.declarationKeyOf(acct.ownerId, acct.plantId, acct.period, acct.materialType);
    if (l.declarations.member(key)) Object.assign(a, { status: "DECLARED", declaredBps: Number(l.declarations.lookup(key).shareBps) });
  }
  saveTenant(rt.file);
};

const setPending = (rt: Runtime, p: PendingOp) => {
  rt.file.pending = p;
  saveTenant(rt.file);
};

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const scanTenant = async (rt: Runtime, ledgerNow?: Ledger): Promise<StoredLot[]> => {
  const l = ledgerNow ?? (await readLedger());
  const { lots, nextIndex } = scanLotInbox(l, fromHex(rt.file.encSk), fromHex(partyIdHex(rt)), fromHex(rt.file.partySecret), BigInt(rt.file.inboxCursor));
  const added: StoredLot[] = [];
  for (const r of lots) {
    const c = hex(r.commitment);
    if (rt.file.lots.some((x) => x.commitment === c || x.id === c)) continue;
    const stored: StoredLot = {
      id: c,
      commitment: c,
      lot: lotToJson(r.lot),
      status: "ACTIVE",
      source: "inbox",
      memo: r.memo.some((b) => b !== 0) ? labelFromBytes32(r.memo) : undefined,
      inboxIndex: r.inboxIndex.toString(),
      createdAt: now(),
    };
    rt.file.lots.push(stored);
    added.push(stored);
  }
  rt.file.inboxCursor = nextIndex.toString();
  saveTenant(rt.file);
  return added;
};

const scanAll = async () => {
  if (!nodeState.contractAddress) return;
  const l = await readLedger();
  for (const rt of runtimes.values()) if (rt.file.role === "company") await scanTenant(rt, l);
};

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const requireAdmin = (rt: Runtime) => {
  if (rt.file.role !== "admin") throw new ApiError("admin only", 403, "forbidden");
};

export const createTenant = (
  admin: Runtime,
  body: { name?: string; partySecret?: string; certId?: string },
): { id: string; partyId: string; certId: string; apiKey: string; registerJob?: V2Job } => {
  requireAdmin(admin);
  if (!body.name) throw new ApiError("name is required", 400, "bad_request");
  const key = newApiKey();
  const file = createTenantFile(body.name, "company", key, body.partySecret, body.certId);
  saveTenant(file);
  const rt = attach(file);
  let registerJob: V2Job | undefined;
  if (nodeState.contractAddress) {
    const address = nodeState.contractAddress;
    registerJob = enqueue(rt, "registerEncKey", async () => {
      await connect(rt, address);
      return registerEncKeyTx(rt);
    });
  }
  return { id: file.id, partyId: partyIdHex(rt), certId: file.certId, apiKey: key, registerJob };
};

const registerEncKeyTx = async (rt: Runtime): Promise<Outcome> => {
  await setPrivateState(rt, baseState(rt));
  const res = await contractOrThrow(rt).callTx.registerEncKey(fromHex(rt.file.encPk));
  return { txHash: res.public.txHash, blockHeight: res.public.blockHeight };
};

export const deploy = (admin: Runtime): V2Job => {
  requireAdmin(admin);
  if (nodeState.contractAddress) throw new ApiError(`already deployed at ${nodeState.contractAddress}`, 409, "already_deployed");
  return enqueue(admin, "deploy", async (job) => {
    const deployed = await deployV2Staged(admin.providers, baseState(admin), (step) => (job.result = { step }));
    const address = deployed.contractAddress;
    saveDeploymentV2({ contractAddress: address });
    nodeState.contractAddress = address;
    for (const rt of runtimes.values()) await connect(rt, address);
    // Existing company tenants still need their receiving key on the new contract.
    for (const rt of runtimes.values()) if (rt.file.role === "company") enqueue(rt, "registerEncKey", () => registerEncKeyTx(rt));
    return { txHash: deployed.txHash, blockHeight: deployed.blockHeight, result: { contractAddress: address, verifierKeysInserted: deployed.inserted } };
  });
};

const adminCall = (admin: Runtime, op: string, call: (c: V2Contract) => Promise<{ public: { txHash: string; blockHeight: number } }>, result?: Record<string, unknown>) => {
  requireAdmin(admin);
  contractOrThrow(admin);
  return enqueue(admin, op, async () => {
    await setPrivateState(admin, baseState(admin));
    const res = await call(contractOrThrow(admin));
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result };
  });
};

export const certifyOrigin = (admin: Runtime, label: string) =>
  adminCall(admin, "certifyOrigin", (c) => c.callTx.certifyOrigin(bytes32FromLabel(label)), { origin: label });
export const certifySupplier = (admin: Runtime, partyId: string, certId: string) =>
  adminCall(admin, "certifySupplier", (c) => c.callTx.certifySupplier(fromHex(partyId), fromHex(certId)));
export const certifyRecycler = (admin: Runtime, partyId: string, certId: string, isEu: boolean) =>
  adminCall(admin, "certifyRecycler", (c) => c.callTx.certifyRecycler(fromHex(partyId), fromHex(certId), isEu));
export const addProcessingRule = (admin: Runtime, inMaterial: string, outMaterial: string, yieldPct: number) =>
  adminCall(admin, "addProcessingRule", (c) =>
    c.callTx.addProcessingRule(bytes32FromLabel(inMaterial), bytes32FromLabel(outMaterial), BigInt(yieldPct)),
  );
export const setCarbonThreshold = (admin: Runtime, value: number) =>
  adminCall(admin, "setCarbonThreshold", (c) => c.callTx.setCarbonThreshold(BigInt(value)));

// ---------------------------------------------------------------------------
// Company operations
// ---------------------------------------------------------------------------

const requireCompany = (rt: Runtime) => {
  if (rt.file.role !== "company") throw new ApiError("company tenants only", 403, "forbidden");
};

const recipientKey = (l: Ledger, partyId: string): Uint8Array => {
  const id = fromHex(partyId);
  if (!l.partyEncKeys.member(id)) throw new ApiError(`recipient ${partyId} has no registered receiving key`, 409, "no_enc_key");
  return l.partyEncKeys.lookup(id);
};

const sealTo = (pk: Uint8Array, lot: Lot, memo?: string) => {
  const { ownerId: _o, ...fields } = lot;
  return sealLot(pk, { ...fields, commitment: pureCircuits.commitmentOf(lot), memo: memo ? bytes32FromLabel(memo) : undefined });
};

const quantity = (kg: unknown, what = "quantityKg"): bigint => {
  if (typeof kg !== "number" || !Number.isInteger(kg) || kg <= 0 || kg > 0xffffffff) throw new ApiError(`${what} must be a positive integer (kg)`, 400, "bad_request");
  return BigInt(kg);
};

export type IssueBody = {
  recipient: string;
  origin: string;
  material: string;
  quantityKg: number;
  carbonClass?: number;
  custody?: number;
  recycled?: boolean;
  isEu?: boolean;
  memo?: string;
};

export const issue = (rt: Runtime, body: IssueBody): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  const q = quantity(body.quantityKg);
  return enqueue(rt, body.recycled ? "issueRecycledLot" : "issueLot", async () => {
    await reconcile(rt);
    const l = await readLedger();
    const spec: IssueSpec = {
      originId: bytes32FromLabel(body.origin),
      materialType: bytes32FromLabel(body.material),
      quantity: q,
      carbonClass: BigInt(body.carbonClass ?? 0),
      custody: BigInt(body.custody ?? (body.recycled ? CUSTODY.massBalance : CUSTODY.identityPreserved)),
      batchSecret: crypto.getRandomValues(new Uint8Array(32)),
    };
    const isEu = !!body.isEu;
    const lot: Lot = {
      ownerId: fromHex(body.recipient),
      ...spec,
      origins: issuedOrigins(spec, fromHex(rt.file.partySecret)),
      recycledEuKg: body.recycled && isEu ? q : 0n,
      recycledOtherKg: body.recycled && !isEu ? q : 0n,
    };
    const entry = sealTo(recipientKey(l, body.recipient), lot, body.memo);
    const recipientId = fromHex(body.recipient);
    await setPrivateState(rt, body.recycled ? forIssueRecycled(baseState(rt), spec, recipientId, isEu) : forIssue(baseState(rt), spec, recipientId));
    const c = contractOrThrow(rt);
    const res = body.recycled ? await c.callTx.issueRecycledLot(entry) : await c.callTx.issueLot(entry);
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result: { commitment: hex(pureCircuits.commitmentOf(lot)) } };
  });
};

export type TransferBody = {
  recipient: string;
  quantityKg: number;
  carbonClass?: number;
  recycledEuKg?: number;
  recycledOtherKg?: number;
  memo?: string;
};

export const transfer = (rt: Runtime, lotId: string, body: TransferBody): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  const q = quantity(body.quantityKg);
  activeLot(rt, lotId);
  return enqueue(rt, "transferLot", async (job) => {
    await reconcile(rt);
    const stored = activeLot(rt, lotId);
    const held = lotFromJson(stored.lot);
    const l = await readLedger();
    const pk = recipientKey(l, body.recipient);
    const recycled =
      body.recycledEuKg !== undefined || body.recycledOtherKg !== undefined
        ? { eu: BigInt(body.recycledEuKg ?? 0), other: BigInt(body.recycledOtherKg ?? 0) }
        : undefined;
    const state = forTransfer(
      baseState(rt),
      held,
      fromHex(body.recipient),
      q,
      BigInt(body.carbonClass ?? Number(held.carbonClass)),
      crypto.getRandomValues(new Uint8Array(32)),
      crypto.getRandomValues(new Uint8Array(32)),
      recycled,
    );
    const { out, change } = lotsAfterTransfer(held, state);
    const changeCommitment = hex(pureCircuits.commitmentOf(change));
    // An empty change lot is still minted on chain (uniform transcript) but not kept.
    setPending(rt, {
      jobId: job.id,
      spendLots: [stored.id],
      spendNullifiers: [nullifierOfLot(rt, stored)],
      mintLots: change.quantity > 0n ? [{ id: changeCommitment, commitment: changeCommitment, lot: lotToJson(change), status: "ACTIVE", source: "change", createdAt: now() }] : [],
    });
    await setPrivateState(rt, state);
    const res = await contractOrThrow(rt).callTx.transferLot(sealTo(pk, out, body.memo));
    applyPending(rt, job.id);
    const [nullifier] = res.private.result as [Uint8Array, Uint8Array, Uint8Array];
    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: { nullifier: hex(nullifier), sentCommitment: hex(pureCircuits.commitmentOf(out)), changeLotId: change.quantity > 0n ? changeCommitment : null },
    };
  });
};

export type ProcessBody = {
  lotIds: [string, string];
  outMaterial: string;
  yieldPct: number;
  quantityKg: number;
  carbonClass?: number;
  custody?: number;
};

export const processLots = (rt: Runtime, body: ProcessBody): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  if (!Array.isArray(body.lotIds) || body.lotIds.length !== 2) throw new ApiError("lotIds must list exactly two lots", 400, "bad_request");
  const q = quantity(body.quantityKg);
  body.lotIds.forEach((id) => activeLot(rt, id));
  return enqueue(rt, "processLots", async (job) => {
    await reconcile(rt);
    const [sa, sb] = body.lotIds.map((id) => activeLot(rt, id));
    const a = lotFromJson(sa.lot);
    const b = lotFromJson(sb.lot);
    const custody = BigInt(body.custody ?? Math.max(2, Number(a.custody), Number(b.custody)));
    const carbon = BigInt(body.carbonClass ?? Math.max(Number(a.carbonClass), Number(b.carbonClass)));
    const state = forProcess(
      baseState(rt),
      a,
      b,
      { material: bytes32FromLabel(body.outMaterial), quantity: q, carbonClass: carbon, custody, origins: unionOrigins(a, b), batchSecret: crypto.getRandomValues(new Uint8Array(32)) },
      { inMaterial: a.materialType, outMaterial: bytes32FromLabel(body.outMaterial), yieldPct: BigInt(body.yieldPct) },
    );
    const out = lotAfterProcess(a, state);
    const c = hex(pureCircuits.commitmentOf(out));
    setPending(rt, { jobId: job.id, spendLots: [sa.id, sb.id], spendNullifiers: [nullifierOfLot(rt, sa), nullifierOfLot(rt, sb)], mintLots: [{ id: c, commitment: c, lot: lotToJson(out), status: "ACTIVE", source: "process", createdAt: now() }] });
    await setPrivateState(rt, state);
    const res = await contractOrThrow(rt).callTx.processLots();
    applyPending(rt, job.id);
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result: { lotId: c } };
  });
};

export const attestOrder = (rt: Runtime, lotId: string, body: { challenge: string; minQuantityKg: number }): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  if (!/^[0-9a-f]{64}$/i.test(body.challenge ?? "")) throw new ApiError("challenge must be 64 hex characters", 400, "bad_request");
  const min = quantity(body.minQuantityKg, "minQuantityKg");
  activeLot(rt, lotId);
  return enqueue(rt, "attestOrder", async (job) => {
    await reconcile(rt);
    const stored = activeLot(rt, lotId);
    const held = lotFromJson(stored.lot);
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    const rotated = rotatedLot(held, fresh);
    const rc = hex(pureCircuits.commitmentOf(rotated));
    setPending(rt, { jobId: job.id, spendLots: [], spendNullifiers: [nullifierOfLot(rt, stored)], mintLots: [], rotate: { lotId: stored.id, commitment: rc, lot: lotToJson(rotated) } });
    await setPrivateState(rt, forAttest(baseState(rt), held, fresh));
    const res = await contractOrThrow(rt).callTx.attestOrder(fromHex(body.challenge), min);
    applyPending(rt, job.id);
    const key = pureCircuits.attestationKeyOf(fromHex(body.challenge), held.ownerId, min);
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result: { attestationKey: hex(key) } };
  });
};

export const openPeriod = (rt: Runtime, body: { plant: string; period: number; material: string }): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  if (!body.plant || !body.material || !Number.isInteger(body.period)) throw new ApiError("plant, period and material are required", 400, "bad_request");
  return enqueue(rt, "openPeriod", async (job) => {
    await reconcile(rt);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const owner = fromHex(partyIdHex(rt));
    const plantId = bytes32FromLabel(body.plant);
    const material = bytes32FromLabel(body.material);
    const account = openedAccount(owner, plantId, BigInt(body.period), material, secret);
    const id = hex(pureCircuits.periodMarkerOf(owner, plantId, BigInt(body.period), material));
    const commitment = hex(pureCircuits.accountCommitmentOf(account));
    setPending(rt, {
      jobId: job.id,
      spendLots: [],
      spendNullifiers: [],
      mintLots: [],
      mintAccount: { id, plant: body.plant, period: body.period, material: body.material, commitment, account: accountToJson(account), status: "OPEN" },
    });
    await setPrivateState(rt, forOpenPeriod(baseState(rt), secret));
    const res = await contractOrThrow(rt).callTx.openPeriod(plantId, BigInt(body.period), material);
    applyPending(rt, job.id);
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result: { accountId: id } };
  });
};

export const consumeIntoPeriod = (rt: Runtime, accountId: string, lotId: string): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  activeLot(rt, lotId);
  if (accountById(rt, accountId).status !== "OPEN") throw new ApiError("account already declared", 409, "declared");
  return enqueue(rt, "consumeIntoPeriod", async (job) => {
    await reconcile(rt);
    const stored = activeLot(rt, lotId);
    const acct = accountById(rt, accountId);
    const lot = lotFromJson(stored.lot);
    const account = accountFromJson(acct.account);
    const next = crypto.getRandomValues(new Uint8Array(32));
    const updated = accountAfterConsume(account, lot, next);
    setPending(rt, {
      jobId: job.id,
      spendLots: [stored.id],
      spendNullifiers: [nullifierOfLot(rt, stored)],
      spendAccount: acct.id,
      mintLots: [],
      mintAccount: { ...acct, commitment: hex(pureCircuits.accountCommitmentOf(updated)), account: accountToJson(updated) },
    });
    await setPrivateState(rt, forConsume(baseState(rt), lot, account, next));
    const res = await contractOrThrow(rt).callTx.consumeIntoPeriod();
    applyPending(rt, job.id);
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result: { maxDeclarableBps: Number(maxDeclarableBps(updated)) } };
  });
};

export const declareShare = (rt: Runtime, accountId: string, body: { shareBps?: number }): V2Job => {
  requireCompany(rt);
  contractOrThrow(rt);
  if (accountById(rt, accountId).status !== "OPEN") throw new ApiError("account already declared", 409, "declared");
  return enqueue(rt, "declareShare", async () => {
    await reconcile(rt);
    const acct = accountById(rt, accountId);
    const account = accountFromJson(acct.account);
    const bps = BigInt(body.shareBps ?? Number(maxDeclarableBps(account)));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    // Keep the salt before proving: it is the only way to open the on-chain total later.
    acct.salt = hex(salt);
    saveTenant(rt.file);
    await setPrivateState(rt, forDeclare(baseState(rt), account, salt));
    const res = await contractOrThrow(rt).callTx.declareShare(account.plantId, account.period, account.materialType, bps);
    Object.assign(acct, { status: "DECLARED", declaredBps: Number(bps), declaredTx: res.public.txHash });
    return { txHash: res.public.txHash, blockHeight: res.public.blockHeight, result: { shareBps: Number(bps) } };
  });
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const labelOrHex = (h: string) => {
  const label = labelFromBytes32(fromHex(h));
  return /^[\x20-\x7e]+$/.test(label) ? label : h;
};

export const lotView = (s: StoredLot) => {
  const l = s.lot;
  return {
    id: s.id,
    commitment: s.commitment,
    status: s.status,
    source: s.source,
    material: labelOrHex(l.materialType),
    quantityKg: Number(l.quantity),
    recycledEuKg: Number(l.recycledEuKg),
    recycledOtherKg: Number(l.recycledOtherKg),
    carbonClass: Number(l.carbonClass),
    custody: ["", "identity-preserved", "segregated", "mass-balance"][Number(l.custody)] ?? l.custody,
    origins: l.origins.filter((o) => /[^0]/.test(o.originId)).map((o) => ({ origin: labelOrHex(o.originId), issuer: o.issuerId })),
    memo: s.memo,
    createdAt: s.createdAt,
    consumedAt: s.consumedAt,
  };
};

export const accountView = (a: StoredAccount) => ({
  id: a.id,
  plant: a.plant,
  period: a.period,
  material: a.material,
  status: a.status,
  totalKg: Number(a.account.totalKg),
  recycledEuKg: Number(a.account.recycledEuKg),
  recycledOtherKg: Number(a.account.recycledOtherKg),
  maxDeclarableBps: Number(maxDeclarableBps(accountFromJson(a.account))),
  declaredBps: a.declaredBps,
});

/** What the manufacturer hands the notified body, and nobody else. */
export const auditorPackage = (rt: Runtime, accountId: string) => {
  const a = accountById(rt, accountId);
  if (a.status !== "DECLARED" || !a.salt) throw new ApiError("account not declared yet", 409, "not_declared");
  return { owner: partyIdHex(rt), plant: a.plant, period: a.period, material: a.material, totalKg: Number(a.account.totalKg), salt: a.salt };
};

export const tenantView = (rt: Runtime) => ({
  id: rt.file.id,
  name: rt.file.name,
  role: rt.file.role,
  partyId: partyIdHex(rt),
  certId: rt.file.certId,
  encPk: rt.file.encPk,
});
