import { t } from './i18n';
import type { Circuit, Job, JobStage, PartyName } from '@/api/types';
import { shortName } from './registry';

const ACTIVE = new Set<JobStage>(['queued', 'preparing', 'proving', 'awaiting_wallet', 'submitting']);
export const isActive = (j?: Job | null): boolean => !!j && ACTIVE.has(j.stage);

/** How long a job is expected to take: ~40 s on the devnet, PROVE_MS + 1 s in the mock. */
export function expectedMs(mode: 'mock' | 'http'): number {
  if (mode === 'http') return 40_000;
  const env = Number(import.meta.env.VITE_MOCK_PROVE_MS);
  return (Number.isFinite(env) && env > 0 ? env : 3000) + 1000;
}

export const STAGE_WORD: Record<JobStage, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  proving: 'Proving',
  awaiting_wallet: 'Approve in wallet',
  submitting: 'Submitting',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  failed: 'Failed',
};

const VERB: Record<Circuit, string> = {
  deploy: 'deploy',
  registerEncKey: 'key',
  certifyOrigin: 'origin',
  certifySupplier: 'certify',
  setCarbonThreshold: 'threshold',
  issueProvenance: 'issue',
  transferProvenance: 'transfer',
  attestConsumer: 'proof',
  attestProcurement: 'proof',
  attestRegulator: 'proof',
};

/** `transfer EuroRefine → VoltCell` when the recipient is known, else `transfer EuroRefine`. */
export function jobLabel(job: Job, recipient?: PartyName | 'verifier'): string {
  const verb = t(VERB[job.circuit] ?? job.circuit);
  const to = recipient ?? (job.circuit.startsWith('attest') ? 'verifier' : undefined);
  return to ? `${verb} ${shortName(job.party)} → ${shortName(to)}` : `${verb} ${shortName(job.party)}`;
}

export function elapsedMs(job: Job, now: number): number {
  if (job.elapsedMs != null) return job.elapsedMs;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return Math.max(0, end - Date.parse(job.startedAt));
}
