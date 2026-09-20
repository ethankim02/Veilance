// Veilance Party Agent — the job queue.
//
// Every circuit call is proving + balancing + submit + finality (20-45s per
// contract/e2e/REPORT.md). The local proof server can only usefully do one
// proof at a time, so ALL circuit calls — across all four parties — share
// ONE global, strictly sequential queue. Handlers return 202 with the queued
// Job immediately; this module drains the queue in the background and
// persists every stage transition to the acting party's agent.json.

import { randomUUID } from "node:crypto";
import { appState } from "./appState.js";
import { upsertJob } from "./state.js";
import type { Job, JobCircuit, JobStage, PartyName, WalletRequest } from "./types.js";

const FAILED_ASSERT_MARKER = "failed assert: ";

/**
 * Contract assert failures surface as a thrown Error whose message looks
 * like: `Unexpected error executing scoped transaction '<unnamed>': Error:
 * failed assert: veilance: credential already consumed` (verified against
 * the real devnet — see contract/e2e/REPORT.md's attack-path entry). Returns
 * the text after the marker, or `null` if this was not an assert failure.
 */
export const extractAssertMessage = (errorMessage: string): string | null => {
  const idx = errorMessage.indexOf(FAILED_ASSERT_MARKER);
  if (idx === -1) return null;
  return errorMessage.slice(idx + FAILED_ASSERT_MARKER.length).trim();
};

export type JobOutcome = {
  readonly result?: Record<string, unknown>;
  readonly txHash?: string;
  readonly blockHeight?: number;
};

/**
 * `jobId` was added for the v1.1 addendum's `issued[]` vault (agent/API.md):
 * `startIssueJob`/`startTransferJob` need the id of the job they are
 * currently running inside, to stamp it onto the `IssuedEntry` they append
 * to the issuer's vault — before this, an executor had no way to learn its
 * own job's id (it closed over `party`/`circuit`/the request body only).
 * Additive: existing executors that destructure only `{ setStage }` are
 * unaffected.
 */
export type JobContext = { readonly setStage: (stage: JobStage) => void; readonly jobId: string };
export type JobExecutor = (ctx: JobContext) => Promise<JobOutcome>;

const persistJob = (job: Job): void => {
  const appParty = appState.partyOrThrow(job.party);
  upsertJob(job.party, appParty.file, job);
  appState.registerJob(job);
};

type QueueEntry = { readonly job: Job; readonly executor: JobExecutor };

const queue: QueueEntry[] = [];
let draining = false;
/**
 * The job the drain loop is currently inside `executor(...)` for, if any.
 * Exists so `GET /graph`'s `activeJob` reflects THIS process's real queue
 * state rather than scanning persisted job history for a non-terminal
 * stage — a job left "proving" by a crashed previous process would
 * otherwise look active forever after a restart (see graph.ts).
 */
let currentJob: Job | undefined;

const setStage = (job: Job, stage: JobStage): void => {
  job.stage = stage;
  persistJob(job);
};

/**
 * Parks `job` in `awaiting_wallet` with `request` attached — called by
 * delegatedWallet.ts's `balanceTx` right before it starts waiting on the
 * browser. The job stays queued-out (this process's drain loop is blocked
 * `await`ing the same promise the browser will resolve), so `currentJob`
 * above still correctly reports it as the active job.
 */
export const beginAwaitingWallet = (job: Job, request: WalletRequest): void => {
  job.walletRequest = request;
  setStage(job, "awaiting_wallet");
};

/**
 * Clears `walletRequest` once the browser has responded (or the request
 * timed out) — called from both the success and failure paths of
 * delegatedWallet.ts's `balanceTx`, so a finished job never keeps showing a
 * stale `walletRequest` the web UI would otherwise try to act on again.
 * Does not change `stage`: the caller sets that separately (success moves on
 * to `submitting`; failure lets the thrown error reach `drain()`'s own
 * catch, which sets `failed` via `finish()`).
 */
export const clearJobWalletRequest = (job: Job): void => {
  job.walletRequest = undefined;
  persistJob(job);
};

/** Moves `job` to `submitting` — called once a delegated `balanceTx` has a finalized transaction in hand, mirroring the stage the agent's own wallet path implicitly passes through before `midnightProvider.submitTx`. */
export const setSubmitting = (job: Job): void => setStage(job, "submitting");

const finish = (job: Job, patch: Partial<Job>): void => {
  Object.assign(job, patch);
  job.finishedAt = new Date().toISOString();
  job.elapsedMs = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
  persistJob(job);
};

const drain = async (): Promise<void> => {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) continue;
      const { job, executor } = entry;
      currentJob = job;
      try {
        const outcome = await executor({ setStage: (stage) => setStage(job, stage), jobId: job.id });
        finish(job, { stage: "confirmed", ...outcome });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const assertMessage = extractAssertMessage(message);
        if (assertMessage !== null) {
          finish(job, { stage: "rejected", error: assertMessage });
        } else {
          finish(job, { stage: "failed", error: message });
        }
      } finally {
        currentJob = undefined;
      }
    }
  } finally {
    draining = false;
  }
};

/**
 * Creates a job in the `queued` stage, persists it, appends it to the shared
 * sequential queue, and kicks off draining (fire-and-forget — the caller
 * gets the `queued` Job back immediately for the 202 response).
 */
export const enqueueJob = (party: PartyName, circuit: JobCircuit, executor: JobExecutor): Job => {
  const job: Job = {
    id: randomUUID(),
    party,
    circuit,
    stage: "queued",
    startedAt: new Date().toISOString(),
  };
  persistJob(job);
  queue.push({ job, executor });
  void drain();
  return job;
};

export const listJobs = (party?: PartyName): Job[] => {
  const all = party
    ? appState.partyOrThrow(party).file.jobs
    : Array.from(appState.parties.values()).flatMap((p) => p.file.jobs);
  return [...all].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
};

export const getJob = (id: string): Job | undefined => appState.jobsById.get(id);

/** The job currently being worked on by the drain loop (this process only), for `GET /graph`'s `activeJob`. */
export const getActiveJob = (): Job | undefined => currentJob;

/** Jobs still waiting in the queue (this process only, `queued` stage), for `GET /graph`'s `queue`. */
export const getQueuedJobs = (): Job[] => queue.map((entry) => entry.job);
