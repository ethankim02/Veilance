import { scopeGraph } from '../../../shared/graphScope';
/**
 * In-browser mock of the party agent (agent/API.md). Same timing shape as the real one:
 * jobs go queued → preparing → proving → submitting → confirmed | rejected, one at a time.
 * State is persisted in localStorage so a reload keeps the chain.
 */
import type { VeilanceApi } from './client';
import { CHAIN, PARTIES, PROFILE_CODE } from '@/lib/registry';
import {
  ApiError,
  type Challenge,
  type Circuit,
  type Credential,
  type GraphEdge,
  type Job,
  type JobStage,
  type PartyName,
  type Profile,
  type VerifyPredicate,
  type VerifyResult,
} from './types';

const STORAGE_KEY = 'veilance.mock.v3';
const ALL: PartyName[] = ['admin', 'mine', 'refiner', 'batteryMfr'];
const BLOCK_MS = 6000;
const MATERIAL_LABEL: Record<string, string> = {
  cobalt: 'Cobalt',
  lithium: 'Lithium',
  nickel: 'Nickel',
  graphite: 'Graphite',
  manganese: 'Manganese',
};
/** Same encoding as agent/registry.json's default origin. */
const ORIGIN_ID = '7665696c616e63652d6167656e743a6f726967696e3a6472632d6d696e652d78';

function randomHex(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a expanded to 32 bytes. Stable for attestation keys / party ids. Not cryptographic. */
function fakeHash(...parts: (string | number)[]): string {
  const s = parts.join('|');
  let out = '';
  for (let round = 0; round < 8; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

const PARTY_ID = Object.fromEntries(ALL.map((p) => [p, fakeHash('veilance:id', p)])) as Record<PartyName, string>;
const CERT_ID = Object.fromEntries(ALL.map((p) => [p, fakeHash('cert', p)])) as Record<PartyName, string>;
/**
 * Evidence panel field (agent's verifierKeys.ts equivalent): the real agent
 * fingerprints the actual compiled verifier key bytes; the mock has none, so
 * it fakes a stable per-circuit value the same way it fakes party ids — same
 * circuit always shows the same "key", never changes across a session.
 */
const VERIFIER_KEY_FINGERPRINT: Partial<Record<Circuit, string>> = {
  issueProvenance: fakeHash('verifier-key', 'issueProvenance').slice(0, 16),
  transferProvenance: fakeHash('verifier-key', 'transferProvenance').slice(0, 16),
};

interface Tx {
  txHash: string;
  blockHeight: number;
  circuit: Circuit;
  party: PartyName;
  timestamp: string;
  jobId: string;
}
interface Lot extends GraphEdge {
  originId: string;
  materialType: string;
}
interface Attestation {
  holder: PartyName;
  profile: Profile;
  attestationKey: string;
  policyVersion: string;
  txHash: string;
  blockHeight: number;
  challenge: string;
  createdAt: string;
  nullifier?: string;
}
interface MockState {
  contractAddress: string;
  genesisAt: number;
  baseHeight: number;
  policyVersion: number;
  carbonThreshold: number;
  origins: { originId: string; label: string }[];
  suppliers: { partyId: string; certId: string; label: string; partyName: PartyName }[];
  encKeys: Partial<Record<PartyName, string>>;
  lots: Lot[];
  attestations: Attestation[];
  jobs: Job[];
  challenges: Challenge[];
  txs: Tx[];
}

/** A chain that already has policy v5: one origin, three certified organisations, threshold 5, four keys. */
function seed(): MockState {
  const genesisAt = Date.now();
  const baseHeight = 1400 + Math.floor(Math.random() * 60);
  const S: MockState = {
    contractAddress: '0200' + randomHex(30),
    genesisAt,
    baseHeight,
    policyVersion: 0,
    carbonThreshold: 0,
    origins: [],
    suppliers: [],
    encKeys: {},
    lots: [],
    attestations: [],
    jobs: [],
    challenges: [],
    txs: [],
  };
  let h = baseHeight - 640;
  const past = (party: PartyName, circuit: Circuit, result: Record<string, unknown>, apply: () => void) => {
    h += 3 + Math.floor(Math.random() * 9);
    const t = new Date(genesisAt - (baseHeight - h) * BLOCK_MS).toISOString();
    const job: Job = {
      id: 'job_' + randomHex(6),
      party,
      circuit,
      stage: 'confirmed',
      startedAt: t,
      finishedAt: t,
      elapsedMs: 31000 + Math.floor(Math.random() * 9000),
      txHash: randomHex(32),
      blockHeight: h,
      result,
    };
    S.jobs.unshift(job);
    S.txs.unshift({ txHash: job.txHash!, blockHeight: h, circuit, party, timestamp: t, jobId: job.id });
    apply();
  };
  past('admin', 'deploy', { contractAddress: S.contractAddress }, () => {});
  past('admin', 'certifyOrigin', { originId: ORIGIN_ID, label: 'DRC Mine X' }, () => {
    S.origins.push({ originId: ORIGIN_ID, label: 'DRC Mine X' });
    S.policyVersion += 1;
  });
  for (const p of CHAIN)
    past('admin', 'certifySupplier', { partyId: PARTY_ID[p], certId: CERT_ID[p], partyName: p }, () => {
      S.suppliers.push({ partyId: PARTY_ID[p], certId: CERT_ID[p], label: 'Supplier certification', partyName: p });
      S.policyVersion += 1;
    });
  past('admin', 'setCarbonThreshold', { carbonThreshold: 5 }, () => {
    S.carbonThreshold = 5;
    S.policyVersion += 1;
  });
  for (const p of ALL) {
    const pk = fakeHash('x25519', p);
    past(p, 'registerEncKey', { encPk: pk }, () => void (S.encKeys[p] = pk));
  }
  return S;
}

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as MockState;
      for (const j of s.jobs) {
        if (!['confirmed', 'rejected', 'failed'].includes(j.stage)) {
          j.stage = 'failed';
          j.error = 'agent restarted';
          j.finishedAt = new Date().toISOString();
        }
      }
      return s;
    }
  } catch {
    /* ignore */
  }
  return seed();
}

export function createMockApi(): VeilanceApi {
  const S = load();
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
    } catch {
      /* ignore */
    }
  };

  const envProve = Number(import.meta.env.VITE_MOCK_PROVE_MS);
  const PROVE_MS = Number.isFinite(envProve) && envProve > 0 ? envProve : 3000;
  const ADMIN_PROVE_MS = Math.max(400, Math.round(PROVE_MS * 0.4));

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const blockHeight = () => S.baseHeight + Math.floor((Date.now() - S.genesisAt) / BLOCK_MS);
  const blockTime = (h: number) => new Date(S.genesisAt + (h - S.baseHeight) * BLOCK_MS).toISOString();
  const blockHash = (h: number) => fakeHash('block', S.contractAddress, h);
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const terminal = (j: Job) => ['confirmed', 'rejected', 'failed'].includes(j.stage);

  class Reject extends Error {}

  const isCertified = (p: PartyName) => S.suppliers.some((s) => s.partyId === PARTY_ID[p]);
  const originCertified = (originId: string) => S.origins.some((o) => o.originId === originId);
  const originLabel = (originId: string) => S.origins.find((o) => o.originId === originId)?.label;
  const attKey = (challenge: string, holder: PartyName, profile: Profile) =>
    fakeHash('veilance:att', challenge, PARTY_ID[holder], PROFILE_CODE[profile]);
  const nullifierOf = (commitment: string) => fakeHash('veilance:nf', commitment);

  // ---------- job runner: one job at a time, like the shared proof server ----------

  type Check = () => { result?: Record<string, unknown>; apply: (job: Job) => void };
  let chain: Promise<void> = Promise.resolve();

  function run(party: PartyName, circuit: Circuit, check: Check, proveMs: number): Job {
    const job: Job = { id: 'job_' + randomHex(6), party, circuit, stage: 'queued', startedAt: new Date().toISOString() };
    S.jobs.unshift(job);
    save();
    const setStage = (stage: JobStage) => {
      job.stage = stage;
      save();
    };
    chain = chain.then(async () => {
      const started = Date.now();
      job.startedAt = new Date(started).toISOString();
      setStage('preparing');
      await sleep(250);
      setStage('proving');
      let outcome: ReturnType<Check> | null = null;
      let error: string | null = null;
      let failed = false;
      try {
        outcome = check();
      } catch (e) {
        error = e instanceof Reject ? e.message : `internal: ${(e as Error).message}`;
        failed = !(e instanceof Reject);
      }
      if (!failed) await sleep(proveMs);
      if (error) {
        job.stage = failed ? 'failed' : 'rejected';
        job.error = error;
        job.finishedAt = new Date().toISOString();
        job.elapsedMs = Date.now() - started;
        save();
        return;
      }
      setStage('submitting');
      await sleep(700);
      job.txHash = randomHex(32);
      job.blockHeight = blockHeight() + 1;
      job.result = outcome!.result ?? {};
      job.stage = 'confirmed';
      job.finishedAt = new Date().toISOString();
      job.elapsedMs = Date.now() - started;
      S.txs.unshift({ txHash: job.txHash, blockHeight: job.blockHeight, circuit, party, timestamp: job.finishedAt, jobId: job.id });
      outcome!.apply(job);
      save();
    });
    return clone(job);
  }

  // ---------- circuits ----------

  function certifyOrigin(label: string, originId?: string): Job {
    const id = originId ?? randomHex(32);
    return run(
      'admin',
      'certifyOrigin',
      () => ({
        result: { originId: id, label },
        apply: () => {
          S.origins.push({ originId: id, label });
          S.policyVersion += 1;
        },
      }),
      ADMIN_PROVE_MS,
    );
  }
  function certifySupplier(partyName: PartyName, certId?: string, certLabel?: string): Job {
    const cid = certId ?? CERT_ID[partyName];
    return run(
      'admin',
      'certifySupplier',
      () => ({
        result: { partyId: PARTY_ID[partyName], certId: cid, partyName },
        apply: () => {
          S.suppliers.push({ partyId: PARTY_ID[partyName], certId: cid, label: certLabel ?? 'Supplier certification', partyName });
          S.policyVersion += 1;
        },
      }),
      ADMIN_PROVE_MS,
    );
  }
  function setThreshold(threshold: number): Job {
    return run(
      'admin',
      'setCarbonThreshold',
      () => {
        if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Reject('veilance: threshold out of range');
        return {
          result: { carbonThreshold: threshold },
          apply: () => {
            S.carbonThreshold = threshold;
            S.policyVersion += 1;
          },
        };
      },
      ADMIN_PROVE_MS,
    );
  }
  function registerEncKey(party: PartyName): Job {
    return run(
      party,
      'registerEncKey',
      () => {
        const pk = S.encKeys[party] ?? fakeHash('x25519', party);
        return { result: { encPk: pk }, apply: () => void (S.encKeys[party] = pk) };
      },
      ADMIN_PROVE_MS,
    );
  }

  function addLot(job: Job, from: PartyName, to: PartyName, circuit: Lot['circuit'], fields: Pick<Lot, 'originId' | 'materialType' | 'carbonClass'>) {
    const commitment = String(job.result?.newCommitment ?? job.result?.commitment);
    const material = fields.materialType.toLowerCase();
    S.lots.push({
      id: 'lot_' + commitment.slice(0, 12),
      from,
      to,
      credentialId: 'cred_' + commitment.slice(0, 12),
      commitment,
      status: 'ISSUED',
      circuit,
      txHash: job.txHash,
      blockHeight: job.blockHeight,
      inboxIndex: S.lots.length,
      carbonClass: fields.carbonClass,
      materialLabel: MATERIAL_LABEL[material] ?? fields.materialType,
      originLabel: originLabel(fields.originId),
      createdAt: job.finishedAt ?? new Date().toISOString(),
      jobId: job.id,
      originId: fields.originId,
      materialType: material,
      provingMs: job.elapsedMs,
      verifierKeyFingerprint: VERIFIER_KEY_FINGERPRINT[circuit],
    });
  }

  function issue(party: PartyName, input: { recipient: PartyName; originId: string; materialType: string; carbonClass: number }): Job {
    if (!S.encKeys[input.recipient]) throw new ApiError(`${PARTIES[input.recipient].org} has no receiving key`, 'NO_ENC_KEY', 400);
    if (!Number.isInteger(input.carbonClass) || input.carbonClass < 0 || input.carbonClass > 255)
      throw new ApiError('carbon class must be 0..255', 'BAD_INPUT', 400);
    return run(
      party,
      'issueProvenance',
      () => {
        if (!isCertified(party)) throw new Reject('veilance: supplier not certified');
        if (!originCertified(input.originId)) throw new Reject('veilance: origin not certified');
        const commitment = randomHex(32);
        return {
          result: { commitment, inboxIndex: S.lots.length, recipient: input.recipient },
          apply: (job) => addLot(job, party, input.recipient, 'issueProvenance', input),
        };
      },
      PROVE_MS,
    );
  }

  const heldLot = (party: PartyName, credentialId: string) => {
    const lot = S.lots.find((l) => l.to === party && l.credentialId === credentialId && l.status !== 'ISSUED');
    if (!lot) throw new ApiError('credential not found', 'NOT_FOUND', 404);
    return lot;
  };

  function transfer(party: PartyName, credentialId: string, input: { recipient: PartyName; carbonClass: number }): Job {
    const lot = heldLot(party, credentialId);
    if (!S.encKeys[input.recipient]) throw new ApiError(`${PARTIES[input.recipient].org} has no receiving key`, 'NO_ENC_KEY', 400);
    return run(
      party,
      'transferProvenance',
      () => {
        const nullifier = nullifierOf(lot.commitment);
        if (lot.status === 'CONSUMED') throw new Reject('veilance: credential already consumed');
        if (!isCertified(party)) throw new Reject('veilance: supplier not certified');
        if (!originCertified(lot.originId)) throw new Reject('veilance: origin not certified');
        if (input.carbonClass < (lot.carbonClass ?? 0)) throw new Reject('veilance: carbon class must not decrease');
        const newCommitment = randomHex(32);
        return {
          result: { nullifier, newCommitment, inboxIndex: S.lots.length, recipient: input.recipient },
          apply: (job) => {
            lot.status = 'CONSUMED';
            lot.nullifier = nullifier;
            lot.consumedTxHash = job.txHash;
            lot.consumedBlockHeight = job.blockHeight;
            addLot(job, party, input.recipient, 'transferProvenance', { originId: lot.originId, materialType: lot.materialType, carbonClass: input.carbonClass });
          },
        };
      },
      PROVE_MS,
    );
  }

  function attest(party: PartyName, credentialId: string, input: { profile: Profile; challenge: string }): Job {
    const lot = heldLot(party, credentialId);
    if (!/^[0-9a-f]{64}$/i.test(input.challenge)) throw new ApiError('request code must be 64 hex characters', 'BAD_INPUT', 400);
    const circuit: Circuit =
      input.profile === 'consumer' ? 'attestConsumer' : input.profile === 'procurement' ? 'attestProcurement' : 'attestRegulator';
    return run(
      party,
      circuit,
      () => {
        const challenge = input.challenge.toLowerCase();
        const key = attKey(challenge, party, input.profile);
        if (S.attestations.some((a) => a.attestationKey === key)) throw new Reject('veilance: attestation already recorded');
        if (!originCertified(lot.originId)) throw new Reject('veilance: origin not certified');
        if (input.profile !== 'consumer') {
          if (!isCertified(party)) throw new Reject('veilance: supplier not certified');
          if ((lot.carbonClass ?? 0) > S.carbonThreshold) throw new Reject('veilance: carbon class exceeds threshold');
        }
        // Rotate-on-attest: every profile spends the credential, so a consumed one fails them all.
        if (lot.status === 'CONSUMED') throw new Reject('veilance: credential already consumed');
        const policyVersion = String(S.policyVersion);
        const nullifier = nullifierOf(lot.commitment);
        const rotatedCommitment = fakeHash('veilance:cm', lot.commitment, key);
        return {
          result: { attestationKey: key, profile: input.profile, policyVersion, nullifier, rotatedCommitment },
          apply: (job) => {
            // Same card (credentialId), new current commitment.
            lot.commitment = rotatedCommitment;
            S.attestations.push({
              holder: party,
              profile: input.profile,
              attestationKey: key,
              policyVersion,
              txHash: job.txHash!,
              blockHeight: job.blockHeight!,
              challenge,
              createdAt: job.finishedAt!,
              nullifier,
            });
          },
        };
      },
      PROVE_MS,
    );
  }

  const toCredential = (l: Lot): Credential => ({
    id: l.credentialId,
    commitment: l.commitment,
    originId: l.originId,
    originLabel: l.originLabel,
    materialType: l.materialType,
    materialLabel: l.materialLabel,
    carbonClass: l.carbonClass ?? 0,
    status: l.status === 'CONSUMED' ? 'CONSUMED' : 'ACTIVE',
    receivedAt: l.deliveredAt ?? l.createdAt,
    inboxIndex: l.inboxIndex,
    issuedBy: l.from,
  });

  function scan(party: PartyName) {
    const found = S.lots.filter((l) => l.to === party && l.status === 'ISSUED');
    const now = new Date().toISOString();
    for (const l of found) {
      l.status = 'DELIVERED';
      l.deliveredAt = now;
    }
    save();
    return { found: found.length, credentials: found.map(toCredential) };
  }

  function verify(challenge: string, holder: PartyName, profile: Profile): VerifyResult {
    const key = attKey(challenge.toLowerCase(), holder, profile);
    const att = S.attestations.find((a) => a.attestationKey === key);
    const current = String(S.policyVersion);
    const applies: Record<string, boolean> = {
      responsibleSourcing: true,
      chainOfCustody: true,
      supplierCertification: profile !== 'consumer',
      carbonThreshold: profile !== 'consumer',
      restrictedSource: true,
      duplicateClaim: true,
    };
    const labels: Record<string, string> = {
      responsibleSourcing: 'Responsible sourcing',
      chainOfCustody: 'Chain of custody',
      supplierCertification: 'Supplier certification',
      carbonThreshold: 'Carbon class ≤ threshold',
      restrictedSource: 'No restricted source',
      duplicateClaim: 'No duplicate claim',
    };
    const predicates: VerifyPredicate[] = Object.keys(labels).map((k) => ({
      key: k,
      label: labels[k],
      passed: att && applies[k] ? true : null,
    }));
    return {
      status: !att ? 'PENDING' : att.policyVersion === current ? 'PASSED' : 'STALE',
      attestation: att ? { profile: att.profile, policyVersion: att.policyVersion } : undefined,
      currentPolicyVersion: current,
      predicates,
      private: ['Upstream supplier', 'Origin', 'Quantity', 'Commercial terms'],
    };
  }

  const explorerTxOf = (t: Tx) => ({
    hash: t.txHash,
    blockHeight: t.blockHeight,
    blockHash: blockHash(t.blockHeight),
    timestamp: t.timestamp,
    status: 'applied' as const,
    contractActions: [{ address: S.contractAddress, kind: t.circuit === 'deploy' ? ('deploy' as const) : ('call' as const), entryPoint: t.circuit }],
    party: t.party,
    circuit: t.circuit,
  });

  return {
    mode: 'mock',
    async health() {
      return {
        ok: true,
        devnet: { node: true, indexer: true, proofServer: { ok: true, version: 'mock' } },
        contractAddress: S.contractAddress,
        deployed: true,
        networkId: 'mock',
      };
    },
    async parties() {
      return ALL.map((name) => ({
        name,
        partyId: PARTY_ID[name],
        encPk: S.encKeys[name],
        certified: isCertified(name),
        encKeyRegistered: !!S.encKeys[name],
        night: '1000000000000',
        dust: '250000000',
      }));
    },
    async ledger() {
      return {
        contractAddress: S.contractAddress,
        blockHeight: blockHeight(),
        adminId: PARTY_ID.admin,
        policyVersion: String(S.policyVersion),
        carbonThreshold: S.carbonThreshold,
        provenanceLeafCount: S.lots.length,
        nullifierCount: S.lots.filter((l) => l.status === 'CONSUMED').length,
        attestationCount: S.attestations.length,
        inboxCount: S.lots.length,
        encKeyCount: Object.keys(S.encKeys).length,
        certifiedOriginCount: S.origins.length,
        certifiedSupplierCount: S.suppliers.length,
      };
    },
    async policy() {
      return {
        policyVersion: String(S.policyVersion),
        carbonThreshold: S.carbonThreshold,
        origins: clone(S.origins),
        suppliers: S.suppliers.map((s) => ({ ...s, org: PARTIES[s.partyName].org })),
      };
    },
    async job(id) {
      const j = S.jobs.find((x) => x.id === id);
      if (!j) throw new ApiError('job not found', 'NOT_FOUND', 404);
      return clone(j);
    },
    async jobs(party) {
      return clone(party ? S.jobs.filter((j) => j.party === party) : S.jobs);
    },
    async addOrigin({ label, originId }) {
      if (originId && originCertified(originId)) throw new ApiError('origin already certified', 'DUPLICATE', 409);
      return certifyOrigin(label, originId);
    },
    async addSupplier({ partyName, certId, certLabel }) {
      return certifySupplier(partyName, certId, certLabel);
    },
    async setCarbonThreshold(threshold) {
      return setThreshold(threshold);
    },
    async registerEncKey(party) {
      return registerEncKey(party);
    },
    async credentials(party) {
      return S.lots.filter((l) => l.to === party && l.status !== 'ISSUED').map(toCredential);
    },
    async scan(party) {
      await sleep(600);
      return scan(party);
    },
    async issue(party, input) {
      return issue(party, input);
    },
    async transfer(party, id, input) {
      return transfer(party, id, input);
    },
    async attest(party, id, input) {
      return attest(party, id, input);
    },
    async createChallenge({ profile, holder }) {
      const challenge = randomHex(32);
      const c: Challenge = { challenge, attestationKey: attKey(challenge, holder, profile), profile, holder, createdAt: new Date().toISOString() };
      S.challenges.unshift(c);
      save();
      return clone(c);
    },
    async challenges() {
      return clone(S.challenges);
    },
    async openRequests(holder) {
      return clone(S.challenges.filter((c) => c.holder === holder && !S.attestations.some((a) => a.attestationKey === c.attestationKey)));
    },
    async verify(challenge, holder, profile) {
      return verify(challenge, holder, profile);
    },
    async graph(viewer = 'batteryMfr') {
      const running = S.jobs.find((j) => !terminal(j) && j.stage !== 'queued');
      return scopeGraph({
        nodes: [
          ...CHAIN.map((p) => ({
            id: p,
            org: PARTIES[p].org,
            role: PARTIES[p].role,
            certified: isCertified(p),
            encKeyRegistered: !!S.encKeys[p],
            held: S.lots.filter((l) => l.to === p && l.status === 'DELIVERED').length,
            consumed: S.lots.filter((l) => l.to === p && l.status === 'CONSUMED').length,
            attestations: S.attestations.filter((a) => a.holder === p).length,
            lastActivityAt: S.jobs.find((j) => j.party === p)?.finishedAt,
          })),
          { id: 'verifier' as const, org: 'OEM', role: 'Verifier', certified: false, encKeyRegistered: false, held: 0, consumed: 0, attestations: S.attestations.length },
        ],
        edges: S.lots.map(({ originId: _o, materialType: _m, ...edge }, index) => ({ ...clone(edge), lotNumber: edge.lotNumber ?? index + 1 })),
        attestations: S.attestations.map(({ nullifier: _n, ...a }) => clone(a)),
        activeJob: running ? clone(running) : undefined,
        queue: clone(S.jobs.filter((j) => j.stage === 'queued').reverse()),
      }, viewer);
    },
    async explorerTip() {
      const h = blockHeight();
      return { blockHeight: h, blockHash: blockHash(h), timestamp: blockTime(h) };
    },
    async explorerBlock(height) {
      if (!Number.isInteger(height) || height < 0 || height > blockHeight()) throw new ApiError('block not found', 'NOT_FOUND', 404);
      const txs = S.txs.filter((t) => t.blockHeight === height);
      return { height, hash: blockHash(height), parentHash: blockHash(height - 1), timestamp: blockTime(height), txCount: txs.length, txHashes: txs.map((t) => t.txHash) };
    },
    async explorerTx(hash) {
      const t = S.txs.find((x) => x.txHash === hash.toLowerCase());
      if (!t) throw new ApiError('transaction not found', 'NOT_FOUND', 404);
      return explorerTxOf(t);
    },
    async explorerContract() {
      const deploy = S.txs.find((t) => t.circuit === 'deploy');
      return {
        address: S.contractAddress,
        deployTxHash: deploy?.txHash,
        deployBlockHeight: deploy?.blockHeight,
        latestBlockHeight: blockHeight(),
        actionCount: S.txs.length,
        actions: S.txs.map((t) => ({
          txHash: t.txHash,
          blockHeight: t.blockHeight,
          timestamp: t.timestamp,
          kind: t.circuit === 'deploy' ? ('deploy' as const) : ('call' as const),
          entryPoint: t.circuit,
          party: t.party,
          circuit: t.circuit,
          jobId: t.jobId,
        })),
      };
    },
    async explorerLedgerRaw() {
      return {
        policyVersion: S.policyVersion,
        carbonThreshold: S.carbonThreshold,
        provenanceLeafCount: S.lots.length,
        provenanceRoot: fakeHash('root', S.lots.length),
        nullifierCount: S.lots.filter((l) => l.status === 'CONSUMED').length,
        attestationCount: S.attestations.length,
        inboxCount: S.lots.length,
        encKeyCount: Object.keys(S.encKeys).length,
        certifiedOriginCount: S.origins.length,
        certifiedSupplierCount: S.suppliers.length,
      };
    },
    // ---------- v1.4 addendum: delegated wallet ----------
    // The mock never proves anything for real, so it never has a proven-but-
    // unbalanced transaction to hand a wallet — delegation is not simulated
    // here. These exist only so `VeilanceApi` type-checks against one
    // implementation for both modes; the dev-wallet round trip (docs/WALLET.md)
    // is exercised against the real agent instead, not mock mode.
    async walletSessions() {
      return [];
    },
    async connectWallet() {
      throw new ApiError('Wallet delegation is not simulated in mock mode', 'NOT_SUPPORTED', 501);
    },
    async disconnectWallet() {
      /* no sessions ever exist in mock mode */
    },
    async postWalletResult() {
      throw new ApiError('Wallet delegation is not simulated in mock mode', 'NOT_SUPPORTED', 501);
    },
  };
}
