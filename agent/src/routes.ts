import { isWorkspace, scopeGraph } from "../../shared/graphScope.js";
// Veilance Party Agent — HTTP routes. One Hono app implementing every
// endpoint in agent/API.md.

import { Hono } from "hono";
import { cors } from "hono/cors";

import { checkDevnetHealth } from "../../contract/e2e/lib/health.js";
import * as ledgerV8 from "@midnight-ntwrk/ledger-v8";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { pureCircuits } from "../../contract/src/managed/veilance/contract/index.js";

import { appState } from "./appState.js";
import { AGENT_WALLET, CORS_ORIGINS, DEV_WALLET_ENABLED, NETWORK_ID } from "./config.js";
import { fromHex, toHex } from "./bytes.js";
import { getJob, listJobs } from "./jobs.js";
import { registry } from "./registry.js";
import {
  createWalletSession,
  devBalanceSubmit,
  devIdentity,
  listSessions,
  removeWalletSession,
  submitWalletResult,
} from "./walletHandlers.js";
import { currentLedger } from "../../contract/e2e/lib/party.js";
import { getLedgerSummary, getPolicySummary, getRecentTxs } from "./ledgerRead.js";
import { isPartyName, isVerifierProfileName, type PartyName, type VerifierProfileName } from "./types.js";
import {
  AttestBody,
  IssueBody,
  TransferBody,
  createChallenge,
  getDisclosurePreview,
  getVerifyResult,
  listChallenges,
  listCredentials,
  listOpenChallenges,
  recipientHasEncKey,
  runScan,
  startAttestJob,
  startBootstrapJobs,
  startCertifyOriginJob,
  startCertifySupplierJob,
  startDeployJob,
  startIssueJob,
  startRegisterEncKeyJob,
  startSetCarbonThresholdJob,
  startTransferJob,
} from "./handlers.js";
import { waitForSync } from "../../contract/e2e/lib/wallet.js";
import { buildGraph } from "./graph.js";
import { getExplorerBlock, getExplorerContract, getExplorerLedgerRaw, getExplorerTip, getExplorerTx } from "./explorer.js";

export const app = new Hono();

app.use("*", cors({ origin: CORS_ORIGINS }));

const error = (message: string, code: string) => ({ error: message, code });

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

app.get("/health", async (c) => {
  const health = await checkDevnetHealth();
  return c.json({
    ok: true,
    ready: appState.boot.ready,
    step: appState.boot.step,
    bootError: appState.boot.error,
    devnet: {
      node: health.node.healthy,
      indexer: health.indexer.healthy,
      proofServer: { ok: health.proofServer.healthy, version: health.proofServer.detail.trim() },
    },
    contractAddress: appState.contractAddress,
    deployed: appState.contractAddress !== undefined,
    // false = this process owns no wallet; every job needs a connected browser wallet.
    agentWallet: AGENT_WALLET,
    // v1.4 addendum: the web UI needs this to hint the right network to
    // `window.midnight[<wallet>].connect(networkId)` and to refuse a
    // connection on the wrong network before ever calling POST /wallet/session.
    networkId: NETWORK_ID,
  });
});

app.post("/deploy", async (c) => {
  if (appState.contractAddress) {
    return c.json({ contractAddress: appState.contractAddress }, 200);
  }
  if (!appState.boot.ready) return c.json(error("agent not ready yet", "not_ready"), 503);
  const job = startDeployJob();
  return c.json(job, 202);
});

app.get("/parties", async (c) => {
  const result = [];
  for (const [name, appParty] of appState.parties) {
    const partyId = pureCircuits.partyIdOf(fromHex(appParty.file.partySecret));
    let certified = false;
    let encKeyRegistered = false;
    if (appState.contractAddress) {
      const ledger = await currentLedger(appParty.party.providers, appState.contractAddress);
      encKeyRegistered = ledger.partyEncKeys.member(partyId);
      const certIdHex = registry.supplierCertId(name);
      if (certIdHex) {
        const certLeaf = pureCircuits.certLeafOf(partyId, fromHex(certIdHex));
        certified = ledger.certifiedSuppliers.findPathForLeaf(certLeaf) !== undefined;
      }
    }
    // Wallet-less mode has no agent wallet: balances/address are the browser wallet's business.
    let night: string | null = null;
    let dust: string | null = null;
    let unshieldedAddress: string | null = null;
    const w = appParty.party.wallet;
    if (w) {
      const state = await waitForSync(w);
      night = (state.unshielded.balances[ledgerV8.unshieldedToken().raw] ?? 0n).toString();
      dust = state.dust.balance(new Date()).toString();
      const addr = await w.facade.unshielded.getAddress();
      unshieldedAddress = UnshieldedAddress.codec.encode(NETWORK_ID as never, addr).asString();
    }
    result.push({
      name,
      partyId: toHex(partyId),
      encPk: appParty.file.encPk,
      certified,
      encKeyRegistered,
      night,
      dust,
      unshieldedAddress,
    });
  }
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

app.get("/ledger", async (c) => {
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  return c.json(await getLedgerSummary(appState.contractAddress));
});

app.get("/ledger/policy", async (c) => {
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  return c.json(await getPolicySummary(appState.contractAddress));
});

app.get("/ledger/txs", (c) => c.json(getRecentTxs()));

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

app.post("/admin/origins", async (c) => {
  const body = await c.req.json<{ label: string; originId?: string }>();
  if (!body?.label) return c.json(error("label is required", "bad_request"), 400);
  const { job } = startCertifyOriginJob(body.label, body.originId);
  return c.json(job, 202);
});

app.post("/admin/suppliers", async (c) => {
  const body = await c.req.json<{ partyName: PartyName; certId?: string; certLabel?: string }>();
  if (!body?.partyName || !isPartyName(body.partyName)) {
    return c.json(error("partyName must be one of admin|mine|refiner|batteryMfr", "bad_request"), 400);
  }
  const job = startCertifySupplierJob(body.partyName, body.certId, body.certLabel);
  return c.json(job, 202);
});

app.post("/admin/carbon-threshold", async (c) => {
  const body = await c.req.json<{ threshold: number }>();
  if (typeof body?.threshold !== "number" || body.threshold < 0 || body.threshold > 255) {
    return c.json(error("threshold must be a number in [0, 255]", "bad_request"), 400);
  }
  const job = startSetCarbonThresholdJob(body.threshold);
  return c.json(job, 202);
});

app.post("/admin/bootstrap", (c) => {
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  const jobs = startBootstrapJobs();
  return c.json({ jobs }, 202);
});

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

const partyParam = (c: { req: { param: (k: string) => string } }): PartyName | null => {
  const raw = c.req.param("party");
  return isPartyName(raw) ? raw : null;
};

app.post("/parties/:party/enc-key", (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  const job = startRegisterEncKeyJob(party);
  return c.json(job, 202);
});

app.get("/parties/:party/credentials", (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  return c.json(listCredentials(party));
});

app.post("/parties/:party/scan", async (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  return c.json(await runScan(party));
});

app.post("/parties/:party/issue", async (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  const body = await c.req.json<IssueBody>();
  if (!body?.recipient || !isPartyName(body.recipient)) {
    return c.json(error("recipient must be one of admin|mine|refiner|batteryMfr", "bad_request"), 400);
  }
  if (!body.originId || !body.materialType || typeof body.carbonClass !== "number") {
    return c.json(error("originId, materialType and carbonClass are required", "bad_request"), 400);
  }
  if (!(await recipientHasEncKey(party, body.recipient))) {
    return c.json(error(`recipient "${body.recipient}" has no registered encryption key`, "no_enc_key"), 400);
  }
  const job = startIssueJob(party, body);
  return c.json(job, 202);
});

app.post("/parties/:party/credentials/:id/transfer", async (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  const id = c.req.param("id");
  const body = await c.req.json<TransferBody>();
  if (!body?.recipient || !isPartyName(body.recipient) || typeof body.carbonClass !== "number") {
    return c.json(error("recipient and carbonClass are required", "bad_request"), 400);
  }
  // Deliberately no ACTIVE/CONSUMED pre-check here — see handlers.ts's
  // startTransferJob doc comment: this is the demo's attack path, and the
  // contract's own assert is what must reject a replay.
  const job = startTransferJob(party, id, body);
  return c.json(job, 202);
});

app.post("/parties/:party/credentials/:id/attest", async (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  const id = c.req.param("id");
  const body = await c.req.json<AttestBody>();
  if (!body?.profile || !isVerifierProfileName(body.profile) || !body.challenge) {
    return c.json(error("profile (consumer|procurement|regulator) and challenge are required", "bad_request"), 400);
  }
  const job = startAttestJob(party, id, body);
  return c.json(job, 202);
});

app.get("/parties/:party/disclosure-preview", (c) => {
  const party = partyParam(c);
  if (!party) return c.json(error("unknown party", "bad_request"), 400);
  const op = c.req.query("op");
  if (op !== "issue" && op !== "transfer" && op !== "attest") {
    return c.json(error("op must be issue|transfer|attest", "bad_request"), 400);
  }
  const profileRaw = c.req.query("profile");
  const profile: VerifierProfileName | undefined =
    profileRaw && isVerifierProfileName(profileRaw) ? profileRaw : undefined;
  return c.json(getDisclosurePreview(op, profile));
});

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

app.post("/verify/challenges", async (c) => {
  const body = await c.req.json<{ profile: VerifierProfileName; holder: PartyName }>();
  if (!body?.profile || !isVerifierProfileName(body.profile)) {
    return c.json(error("profile must be consumer|procurement|regulator", "bad_request"), 400);
  }
  if (!body.holder || !isPartyName(body.holder)) {
    return c.json(error("holder must be one of admin|mine|refiner|batteryMfr", "bad_request"), 400);
  }
  return c.json(createChallenge(body.profile, body.holder));
});

app.get("/verify/challenges", async (c) => {
  const holderRaw = c.req.query("holder");
  const openRaw = c.req.query("open");
  // Plain `GET /verify/challenges` (no query) keeps its original behavior —
  // this only branches when the v1.1 `holder`/`open` addendum params appear.
  if (holderRaw === undefined && openRaw === undefined) {
    return c.json(listChallenges());
  }
  if (!holderRaw || !isPartyName(holderRaw)) {
    return c.json(error("holder must be one of admin|mine|refiner|batteryMfr", "bad_request"), 400);
  }
  if (openRaw !== "true") {
    return c.json(error("open must be 'true' when provided alongside holder", "bad_request"), 400);
  }
  return c.json(await listOpenChallenges(holderRaw));
});

app.get("/verify/:challenge", async (c) => {
  const challenge = c.req.param("challenge");
  const holder = c.req.query("holder");
  const profile = c.req.query("profile");
  if (!holder || !isPartyName(holder)) {
    return c.json(error("holder query param must be one of admin|mine|refiner|batteryMfr", "bad_request"), 400);
  }
  if (!profile || !isVerifierProfileName(profile)) {
    return c.json(error("profile query param must be consumer|procurement|regulator", "bad_request"), 400);
  }
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  return c.json(await getVerifyResult(challenge, holder, profile));
});

// ---------------------------------------------------------------------------
// Graph (v1.1 addendum)
// ---------------------------------------------------------------------------

app.get("/graph", async (c) => {
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  const viewer = c.req.query("viewer") ?? "batteryMfr";
  if (!isWorkspace(viewer)) return c.json(error("unknown workspace", "bad_request"), 400);
  return c.json(scopeGraph(await buildGraph(), viewer));
});

// ---------------------------------------------------------------------------
// Explorer (v1.1 addendum)
// ---------------------------------------------------------------------------

app.get("/explorer/tip", async (c) => c.json(await getExplorerTip()));

app.get("/explorer/block/:height", async (c) => {
  const height = Number(c.req.param("height"));
  if (!Number.isInteger(height) || height < 0) {
    return c.json(error("height must be a non-negative integer", "bad_request"), 400);
  }
  const block = await getExplorerBlock(height);
  if (!block) return c.json(error(`no block at height ${height}`, "not_found"), 404);
  return c.json(block);
});

app.get("/explorer/tx/:hash", async (c) => {
  const hash = c.req.param("hash");
  // The indexer rejects a malformed hash (wrong length) with a GraphQL
  // error rather than an empty result — validate first so that case is a
  // 400, not the onError handler's generic 500.
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    return c.json(error("hash must be 64 lowercase hex characters", "bad_request"), 400);
  }
  const tx = await getExplorerTx(hash);
  if (!tx) return c.json(error(`unknown transaction ${hash}`, "not_found"), 404);
  return c.json(tx);
});

app.get("/explorer/contract", async (c) => {
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  return c.json(await getExplorerContract());
});

app.get("/explorer/ledger-raw", async (c) => {
  if (!appState.contractAddress) return c.json(error("contract not deployed yet", "not_deployed"), 409);
  return c.json(await getExplorerLedgerRaw());
});

// ---------------------------------------------------------------------------
// Delegated wallet (v1.4 addendum) — see agent/API.md and docs/WALLET.md.
// ---------------------------------------------------------------------------

app.post("/wallet/session", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = createWalletSession(body);
  if (!result.ok) {
    const status = result.error.code === "network_mismatch" || result.error.code === "unknown_party" ? 409 : 400;
    return c.json(error(result.error.message, result.error.code), status);
  }
  return c.json(result.session, 200);
});

app.get("/wallet/session", (c) => c.json(listSessions()));

app.delete("/wallet/session/:party", (c) => {
  const party = c.req.param("party");
  const removed = removeWalletSession(party);
  if (!removed) return c.json(error(`no wallet session for party "${party}"`, "not_found"), 404);
  return c.json({ ok: true });
});

if (DEV_WALLET_ENABLED) {
  // Dev-only, gated by VEILANCE_DEV_WALLET=1 — see config.ts's doc comment
  // and web/src/lib/devWallet.ts.
  app.post("/wallet/dev-balance-submit", async (c) => {
    const body = await c.req.json().catch(() => null);
    const result = await devBalanceSubmit(body);
    if (!result.ok) return c.json(error(result.error.message, result.error.code), 400);
    return c.json({ tx: result.tx });
  });

  app.get("/wallet/dev-identity/:party", async (c) => {
    const result = await devIdentity(c.req.param("party"));
    if (!result.ok) return c.json(error(result.error.message, result.error.code), 400);
    const { ok: _ok, ...rest } = result;
    return c.json(rest);
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

app.get("/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json(error("job not found", "not_found"), 404);
  return c.json(job);
});

app.get("/jobs", (c) => {
  const partyRaw = c.req.query("party");
  const party = partyRaw && isPartyName(partyRaw) ? partyRaw : undefined;
  return c.json(listJobs(party));
});

app.post("/jobs/:id/wallet-result", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const outcome = submitWalletResult(id, body);
  if (outcome.status === "not_found") return c.json(error(outcome.message, "not_found"), 404);
  if (outcome.status === "bad_request") return c.json(error(outcome.message, "bad_request"), 400);
  return c.json({ ok: true });
});

app.onError((err, c) => {
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  return c.json(error(message, "internal_error"), 500);
});
