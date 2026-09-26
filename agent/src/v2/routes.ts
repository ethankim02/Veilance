// Veilance B-2 — HTTP API for platforms (agent/API_V2.md).
//
//   /v2/admin/*   admin tenant (policy authority): deploy, tenants, policy
//   /v2/*         company tenants, authenticated with their API key
//   /v2/public/*  no auth: what a notified body or buyer checks on the ledger

import type { Context, Hono } from "hono";

import { pureCircuits } from "../../../contract/src/managed/veilance_v2/contract/index.js";
import { checkDeclaredTotal } from "../../../contract/src/witnesses_v2.js";
import { bytes32FromLabel, fromHex, toHex } from "../bytes.js";
import {
  ApiError,
  accountView,
  addProcessingRule,
  allTenants,
  attestOrder,
  auditorPackage,
  certifyOrigin,
  certifyRecycler,
  certifySupplier,
  consumeIntoPeriod,
  createTenant,
  declareShare,
  deploy,
  getJob,
  issue,
  lotView,
  nodeState,
  openPeriod,
  processLots,
  profileView,
  readLedger,
  scanTenant,
  setCarbonThreshold,
  tenantByApiKey,
  tenantView,
  tenantsWithStatus,
  transfer,
  type Runtime,
} from "./node.js";

type Handler = (c: Context, rt: Runtime) => Promise<Response> | Response;

const fail = (c: Context, err: unknown) => {
  if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status as 400);
  return c.json({ error: err instanceof Error ? err.message : String(err), code: "error" }, 500);
};

/** Resolves the tenant from `Authorization: Bearer <api key>`. */
const authed =
  (handler: Handler) =>
  async (c: Context): Promise<Response> => {
    if (!nodeState.ready) return c.json({ error: "node not ready", code: "not_ready", step: nodeState.step }, 503);
    const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const rt = key ? tenantByApiKey(key) : undefined;
    if (!rt) return c.json({ error: "unknown or missing API key", code: "unauthorized" }, 401);
    try {
      return await handler(c, rt);
    } catch (err) {
      return fail(c, err);
    }
  };

const pid = (c: Context): string => c.req.param("id") ?? "";
const body = async <T>(c: Context): Promise<T> => (await c.req.json().catch(() => ({}))) as T;
const accepted = (c: Context, job: unknown) => c.json(job, 202);

export const mountNode = (app: Hono): void => {
  app.get("/v2/health", (c) => c.json(nodeState));

  // --- admin -----------------------------------------------------------------
  app.post("/v2/admin/deploy", authed((c, rt) => accepted(c, deploy(rt))));
  app.post(
    "/v2/admin/tenants",
    authed(async (c, rt) => c.json(createTenant(rt, await body(c)), 201)),
  );
  app.get(
    "/v2/admin/tenants",
    authed(async (c, rt) => {
      if (rt.file.role !== "admin") throw new ApiError("admin only", 403, "forbidden");
      return c.json(await tenantsWithStatus());
    }),
  );
  app.post("/v2/admin/origins", authed(async (c, rt) => accepted(c, certifyOrigin(rt, (await body<{ label: string }>(c)).label))));
  app.post(
    "/v2/admin/suppliers",
    authed(async (c, rt) => {
      const b = await body<{ partyId: string; certId: string }>(c);
      return accepted(c, certifySupplier(rt, b.partyId, b.certId));
    }),
  );
  app.post(
    "/v2/admin/recyclers",
    authed(async (c, rt) => {
      const b = await body<{ partyId: string; certId: string; isEu: boolean }>(c);
      return accepted(c, certifyRecycler(rt, b.partyId, b.certId, !!b.isEu));
    }),
  );
  app.post(
    "/v2/admin/rules",
    authed(async (c, rt) => {
      const b = await body<{ inMaterial: string; outMaterial: string; yieldPct: number }>(c);
      return accepted(c, addProcessingRule(rt, b.inMaterial, b.outMaterial, b.yieldPct));
    }),
  );
  app.post("/v2/admin/threshold", authed(async (c, rt) => accepted(c, setCarbonThreshold(rt, (await body<{ value: number }>(c)).value))));

  // --- company ---------------------------------------------------------------
  app.get("/v2/me", authed(async (c, rt) => c.json(await profileView(rt))));
  app.get("/v2/jobs", authed((c, rt) => c.json([...rt.file.jobs].reverse().slice(0, 50))));
  app.get("/v2/directory", authed((c) => c.json(allTenants().filter((t) => t.file.role === "company").map((t) => ({ name: t.file.name, partyId: tenantView(t).partyId })))));
  app.get("/v2/jobs/:id", authed((c, rt) => {
    const job = getJob(pid(c));
    if (!job || job.tenant !== rt.file.id) throw new ApiError("job not found", 404, "not_found");
    return c.json(job);
  }));
  app.get("/v2/lots", authed((c, rt) => {
    const status = c.req.query("status");
    return c.json(rt.file.lots.filter((l) => !status || l.status === status).map(lotView));
  }));
  app.post("/v2/inbox/scan", authed(async (c, rt) => c.json((await scanTenant(rt)).map(lotView))));
  app.post("/v2/lots/issue", authed(async (c, rt) => accepted(c, issue(rt, await body(c)))));
  app.post("/v2/lots/process", authed(async (c, rt) => accepted(c, processLots(rt, await body(c)))));
  app.post("/v2/lots/:id/transfer", authed(async (c, rt) => accepted(c, transfer(rt, pid(c), await body(c)))));
  app.post("/v2/lots/:id/attest-order", authed(async (c, rt) => accepted(c, attestOrder(rt, pid(c), await body(c)))));
  app.get("/v2/periods", authed((c, rt) => c.json(rt.file.accounts.map(accountView))));
  app.post("/v2/periods", authed(async (c, rt) => accepted(c, openPeriod(rt, await body(c)))));
  app.post(
    "/v2/periods/:id/consume",
    authed(async (c, rt) => accepted(c, consumeIntoPeriod(rt, pid(c), (await body<{ lotId: string }>(c)).lotId))),
  );
  app.post("/v2/periods/:id/declare", authed(async (c, rt) => accepted(c, declareShare(rt, pid(c), await body(c)))));
  app.get("/v2/periods/:id/auditor-package", authed((c, rt) => c.json(auditorPackage(rt, pid(c)))));

  // --- public (no auth): verification from the ledger alone -----------------
  const pub = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await handler(c);
    } catch (err) {
      return fail(c, err);
    }
  };

  app.get(
    "/v2/public/ledger",
    pub(async (c) => {
      const l = await readLedger();
      return c.json({
        contractAddress: nodeState.contractAddress,
        policyVersion: l.policyVersion.toString(),
        carbonThreshold: l.carbonThreshold.toString(),
        lotLeaves: l.provenanceTree.firstFree().toString(),
        nullifiers: l.nullifiers.size().toString(),
        attestations: l.attestations.size().toString(),
        declarations: l.declarations.size().toString(),
        inbox: l.lotInboxCount.toString(),
      });
    }),
  );

  // A notified body looks a declaration up by who/where/when, and — once the
  // manufacturer hands it the auditor package — checks the hidden total.
  app.post(
    "/v2/public/declaration",
    pub(async (c) => {
      const b = await body<{ owner: string; plant: string; period: number; material: string; totalKg?: number; salt?: string }>(c);
      if (!b.owner || !b.plant || !Number.isInteger(b.period) || !b.material) throw new ApiError("owner, plant, period, material are required", 400, "bad_request");
      const key = pureCircuits.declarationKeyOf(fromHex(b.owner), bytes32FromLabel(b.plant), BigInt(b.period), bytes32FromLabel(b.material));
      const l = await readLedger();
      if (!l.declarations.member(key)) return c.json({ declared: false });
      const d = l.declarations.lookup(key);
      const out: Record<string, unknown> = { declared: true, shareBps: Number(d.shareBps), totalCommit: toHex(d.totalCommit) };
      if (b.totalKg !== undefined && b.salt) out.totalMatches = checkDeclaredTotal(d.totalCommit, BigInt(b.totalKg), fromHex(b.salt));
      return c.json(out);
    }),
  );

  // A buyer checks an order-bound attestation from the challenge it issued.
  app.post(
    "/v2/public/attestation",
    pub(async (c) => {
      const b = await body<{ challenge: string; owner: string; minQuantityKg: number }>(c);
      const key = pureCircuits.attestationKeyOf(fromHex(b.challenge), fromHex(b.owner), BigInt(b.minQuantityKg));
      const l = await readLedger();
      if (!l.attestations.member(key)) return c.json({ attested: false });
      const a = l.attestations.lookup(key);
      return c.json({
        attested: true,
        policyVersion: a.policyVersion.toString(),
        currentPolicyVersion: l.policyVersion.toString(),
        fresh: a.policyVersion === l.policyVersion,
      });
    }),
  );
};
