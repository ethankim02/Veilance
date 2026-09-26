// Veilance B-2 — end-to-end scenario over the HTTP API only, against a running
// node (and its sponsor) on the local devnet. What a platform integration does.
//
//   npm run v2:e2e            # node at http://localhost:4100
//
// Recycled nickel: an EU recycler and a mine issue to a refiner; the refiner
// merges and sends to a cell maker with the recycled share allocated; the cell
// maker proves an OEM order, delivers part of it, then declares its plant's
// recycled share and hands the auditor package to the notified body.

import fs from "node:fs";
import { adminKeyPath } from "./store.js";

const NODE = process.env.VEILANCE_V2_NODE_URL ?? "http://localhost:4100";
const adminKey = fs.readFileSync(adminKeyPath(), "utf8").trim();

type Job = { id: string; stage: string; error?: string; elapsedMs?: number; result?: Record<string, unknown> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`  [${ok ? "x" : " "}] ${name}`);
};

const call = async <T>(key: string | null, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${NODE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error}`);
  return json;
};

const wait = async (key: string, job: Job, label: string): Promise<Job> => {
  for (;;) {
    const j = await call<Job>(key, "GET", `/v2/jobs/${job.id}`);
    if (["confirmed", "rejected", "failed"].includes(j.stage)) {
      console.log(`${label}: ${j.stage}${j.error ? ` — ${j.error}` : ""} (${((j.elapsedMs ?? 0) / 1000).toFixed(1)} s)`);
      return j;
    }
    await sleep(2_000);
  }
};
/** Runs one job. Anything but "confirmed" stops the scenario unless the step expects a rejection. */
const run = async (key: string, method: string, path: string, body: unknown, label: string, expectRejection = false) => {
  const j = await wait(key, await call<Job>(key, method, path, body), label);
  if (!expectRejection && j.stage !== "confirmed") throw new Error(`${label} did not confirm: ${j.error}`);
  return j;
};

type Tenant = { id: string; partyId: string; certId: string; apiKey: string; registerJob?: Job };
type LotView = { id: string; status: string; quantityKg: number; recycledEuKg: number; recycledOtherKg: number; material: string; origins: { origin: string; issuer: string }[]; memo?: string };

const main = async () => {
  for (;;) {
    const h = await call<{ ready: boolean; step: string; contractAddress?: string }>(null, "GET", "/v2/health");
    if (h.ready) break;
    console.log(`node: ${h.step}`);
    await sleep(5_000);
  }
  const health = await call<{ contractAddress?: string }>(null, "GET", "/v2/health");
  if (!health.contractAddress) await run(adminKey, "POST", "/v2/admin/deploy", {}, "deploy v2 contract");

  const make = async (name: string) => {
    const t = await call<Tenant>(adminKey, "POST", "/v2/admin/tenants", { name });
    if (t.registerJob) {
      const j = await wait(t.apiKey, t.registerJob, `register receiving key · ${name}`);
      if (j.stage !== "confirmed") throw new Error(`receiving key for ${name} did not confirm: ${j.error}`);
    }
    return t;
  };
  const recycler = await make("HU Recycler");
  const mine = await make("Nickel Mine");
  const refiner = await make("Refiner");
  const cell = await make("Cell Maker");
  const oem = await make("OEM");

  await run(adminKey, "POST", "/v2/admin/origins", { label: "recycler-hu" }, "certify origin recycler-hu");
  await run(adminKey, "POST", "/v2/admin/origins", { label: "ni-mine" }, "certify origin ni-mine");
  for (const [t, n] of [[recycler, "recycler"], [mine, "mine"], [refiner, "refiner"], [cell, "cell maker"]] as const) {
    await run(adminKey, "POST", "/v2/admin/suppliers", { partyId: t.partyId, certId: t.certId }, `certify supplier · ${n}`);
  }
  await run(adminKey, "POST", "/v2/admin/recyclers", { partyId: recycler.partyId, certId: recycler.certId, isEu: true }, "certify EU recycler");
  await run(adminKey, "POST", "/v2/admin/rules", { inMaterial: "nickel", outMaterial: "nickel", yieldPct: 100 }, "rule nickel→nickel 100%");
  await run(adminKey, "POST", "/v2/admin/threshold", { value: 9 }, "carbon threshold 9");

  console.log("\n— supply chain —");
  await run(recycler.apiKey, "POST", "/v2/lots/issue", { recipient: refiner.partyId, origin: "recycler-hu", material: "nickel", quantityKg: 30_000, recycled: true, isEu: true, carbonClass: 1 }, "recycler issues 30 t recycled Ni");
  await run(mine.apiKey, "POST", "/v2/lots/issue", { recipient: refiner.partyId, origin: "ni-mine", material: "nickel", quantityKg: 70_000, carbonClass: 2 }, "mine issues 70 t primary Ni");
  const refinerLots = await call<LotView[]>(refiner.apiKey, "GET", "/v2/lots?status=ACTIVE");
  check("refiner received both lots", refinerLots.length === 2);

  const merged = await run(refiner.apiKey, "POST", "/v2/lots/process", { lotIds: refinerLots.map((l) => l.id), outMaterial: "nickel", yieldPct: 100, quantityKg: 100_000 }, "refiner merges 100 t");
  const mergedId = merged.result?.lotId as string;
  const t1 = await run(refiner.apiKey, "POST", `/v2/lots/${mergedId}/transfer`, { recipient: cell.partyId, quantityKg: 50_000, recycledEuKg: 30_000, recycledOtherKg: 0 }, "refiner sends 50 t with all 30 t recycled");
  check("transfer confirmed", t1.stage === "confirmed");

  const [cellLot] = await call<LotView[]>(cell.apiKey, "GET", "/v2/lots?status=ACTIVE");
  check("cell maker holds 50 t, 30 t EU-recycled", cellLot?.quantityKg === 50_000 && cellLot.recycledEuKg === 30_000);
  check("both issuers visible to the holder", new Set(cellLot?.origins.map((o) => o.origin)).size === 2);

  console.log("\n— order —");
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  await run(cell.apiKey, "POST", `/v2/lots/${cellLot.id}/attest-order`, { challenge, minQuantityKg: 20_000 }, "cell maker proves a 20 t order");
  const att = await call<{ attested: boolean; fresh?: boolean }>(null, "POST", "/v2/public/attestation", { challenge, owner: cell.partyId, minQuantityKg: 20_000 });
  check("OEM finds the attestation from its own challenge", att.attested && att.fresh === true);
  const wrongQty = await call<{ attested: boolean }>(null, "POST", "/v2/public/attestation", { challenge, owner: cell.partyId, minQuantityKg: 21_000 });
  check("a different order size finds nothing", !wrongQty.attested);

  const d = await run(cell.apiKey, "POST", `/v2/lots/${cellLot.id}/transfer`, { recipient: oem.partyId, quantityKg: 20_000, recycledEuKg: 12_000, recycledOtherKg: 0, memo: "PO-2028-0042" }, "cell maker delivers 20 t to the OEM");
  const [oemLot] = await call<LotView[]>(oem.apiKey, "GET", "/v2/lots?status=ACTIVE");
  check("OEM received 20 t with the order memo", d.stage === "confirmed" && oemLot?.quantityKg === 20_000 && oemLot.memo === "PO-2028-0042");

  console.log("\n— plant/period declaration —");
  const open = await run(cell.apiKey, "POST", "/v2/periods", { plant: "cell-eu-1", period: 2028, material: "nickel" }, "open plant/period account");
  const accountId = open.result?.accountId as string;
  const [remaining] = await call<LotView[]>(cell.apiKey, "GET", "/v2/lots?status=ACTIVE");
  check("change lot is 30 t with 18 t recycled", remaining?.quantityKg === 30_000 && remaining.recycledEuKg === 18_000);
  const consumed = await run(cell.apiKey, "POST", `/v2/periods/${accountId}/consume`, { lotId: remaining.id }, "consume 30 t into the period");
  check("max declarable share is 78.00 %", consumed.result?.maxDeclarableBps === 7800);

  const over = await run(cell.apiKey, "POST", `/v2/periods/${accountId}/declare`, { shareBps: 7801 }, "declare 78.01 % (overclaim)", true);
  check("overclaim rejected by the contract", over.stage === "rejected");
  const ok = await run(cell.apiKey, "POST", `/v2/periods/${accountId}/declare`, { shareBps: 7800 }, "declare 78.00 %");
  check("declaration confirmed", ok.stage === "confirmed");

  const pkg = await call<{ owner: string; plant: string; period: number; material: string; totalKg: number; salt: string }>(cell.apiKey, "GET", `/v2/periods/${accountId}/auditor-package`);
  const nb = await call<{ declared: boolean; shareBps?: number; totalMatches?: boolean }>(null, "POST", "/v2/public/declaration", pkg);
  check("notified body reads 78.00 % and the total matches", nb.declared && nb.shareBps === 7800 && nb.totalMatches === true);
  const lie = await call<{ totalMatches?: boolean }>(null, "POST", "/v2/public/declaration", { ...pkg, totalKg: 25_000 });
  check("a different total does not match", lie.totalMatches === false);

  const ledger = await call<Record<string, string>>(null, "GET", "/v2/public/ledger");
  console.log("\nledger:", ledger);
  const failed = checks.filter(([, v]) => !v);
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : `\nall ${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
