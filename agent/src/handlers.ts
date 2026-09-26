// Veilance Party Agent — circuit call handlers.
//
// One function per circuit endpoint in agent/API.md. Each synchronously
// creates and enqueues a Job (see jobs.ts) and returns it immediately; the
// actual proving/submission happens later, inside the executor, when the
// shared sequential queue reaches it. Witness priming (`setPrivateState` +
// `forIssue`/`forTransfer`/`forHold`) and ledger reads
// (`currentLedger`/`scanInbox`) are the exact same functions
// contract/e2e/run.ts uses — reused, not forked.

import { setPrivateState, currentLedger } from "../../contract/e2e/lib/party.js";
import { forAttest, forIssue, forTransfer, type VeilancePrivateState } from "../../contract/src/witnesses.js";
import { sealCredential, scanInbox, type SealableCredential } from "../../contract/src/sealed-entry.js";
import { pureCircuits, type Credential } from "../../contract/src/managed/veilance/contract/index.js";

import { appState } from "./appState.js";
import { deployVeilance, findVeilance } from "./contractSetup.js";
import { enqueueJob } from "./jobs.js";
import { registry } from "./registry.js";
import { HOSTED_PARTIES, type PartyName } from "./config.js";
import { savePartyFile, saveDeployment, saveChallenges } from "./state.js";
import { predicatesFor, emptyPredicates, type Predicate } from "./predicates.js";
import { disclosurePreview } from "./disclosure.js";
import { bytes32FromLabel, fromHex, labelFromBytes32, randomHex32, toHex } from "./bytes.js";
import {
  CIRCUIT_FOR_PROFILE,
  PROFILE_CODE,
  toPublicCredential,
  type HeldCredential,
  type IssuedEntry,
  type Job,
  type PublicCredential,
  type StoredChallenge,
  type VerifierProfileName,
} from "./types.js";

const credentialToWitness = (h: HeldCredential): Credential => ({
  ownerId: fromHex(h.ownerId),
  originId: fromHex(h.originId),
  materialType: fromHex(h.materialType),
  carbonClass: BigInt(h.carbonClass),
  batchSecret: fromHex(h.batchSecret),
});

// ---------------------------------------------------------------------------
// System / admin
// ---------------------------------------------------------------------------

export const startDeployJob = (): Job =>
  enqueueJob("admin", "deploy", async ({ setStage }) => {
    setStage("preparing");
    const admin = appState.partyOrThrow("admin");
    setStage("proving");
    const deployed = await deployVeilance(admin.party);
    const contractAddress = deployed.deployTxData.public.contractAddress;
    admin.contract = deployed;

    for (const name of HOSTED_PARTIES) {
      if (name === "admin") continue;
      const p = appState.partyOrThrow(name);
      p.party.providers.privateStateProvider.setContractAddress(contractAddress);
      p.contract = await findVeilance(p.party, contractAddress);
    }

    appState.contractAddress = contractAddress;
    saveDeployment({ contractAddress });

    return {
      txHash: deployed.deployTxData.public.txHash,
      blockHeight: deployed.deployTxData.public.blockHeight,
      result: { contractAddress },
    };
  });

export const startCertifyOriginJob = (label: string, originIdHex?: string): { job: Job; originId: string } => {
  const originId = originIdHex ?? randomHex32();
  registry.addOrigin(originId, label);
  const job = enqueueJob("admin", "certifyOrigin", async ({ setStage }) => {
    setStage("preparing");
    const admin = appState.contractOrThrow("admin");
    setStage("proving");
    const res = await admin.callTx.certifyOrigin(fromHex(originId));
    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: { originId, label },
    };
  });
  return { job, originId };
};

/**
 * The party being certified need not be hosted by this process: admin
 * certifies OTHER companies' partyId, which in a separated deployment lives
 * only in their own agent's `.state/`. If this process hosts that party
 * (today's demo, or an admin+company combo agent), its partyId is computed
 * locally as before. Otherwise it comes from `registry.json`'s `parties`
 * directory — see registry.ts and `agent/src/cli/print-identity.ts`, which
 * prints the (partyId, certId) pair a company pastes in there once.
 */
const resolvePartyId = (partyName: PartyName): string => {
  const hosted = appState.parties.get(partyName);
  if (hosted) return toHex(pureCircuits.partyIdOf(fromHex(hosted.file.partySecret)));
  const known = registry.partyId(partyName);
  if (known) return known;
  throw new Error(
    `partyId for "${partyName}" is unknown: this agent doesn't host it (AGENT_PARTIES) and it isn't in ` +
      `registry.json's "parties" directory. Run "npx tsx src/cli/print-identity.ts" on ${partyName}'s own ` +
      `agent and add the printed partyId to registry.json, or host it on this agent.`,
  );
};

export const startCertifySupplierJob = (
  partyName: PartyName,
  certIdHex?: string,
  certLabel?: string,
): Job => {
  const partyId = fromHex(resolvePartyId(partyName));
  const certId = certIdHex ?? registry.supplierCertId(partyName) ?? randomHex32();
  const label = certLabel ?? registry.supplierCertLabel(partyName);

  return enqueueJob("admin", "certifySupplier", async ({ setStage }) => {
    setStage("preparing");
    const admin = appState.contractOrThrow("admin");
    setStage("proving");
    const res = await admin.callTx.certifySupplier(partyId, fromHex(certId));
    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: { partyName, partyId: toHex(partyId), certId, label },
    };
  });
};

export const startSetCarbonThresholdJob = (threshold: number): Job =>
  enqueueJob("admin", "setCarbonThreshold", async ({ setStage }) => {
    setStage("preparing");
    const admin = appState.contractOrThrow("admin");
    setStage("proving");
    const res = await admin.callTx.setCarbonThreshold(BigInt(threshold));
    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: { threshold },
    };
  });

export const startRegisterEncKeyJob = (partyName: PartyName): Job =>
  enqueueJob(partyName, "registerEncKey", async ({ setStage }) => {
    setStage("preparing");
    const appParty = appState.partyOrThrow(partyName);
    const contract = appState.contractOrThrow(partyName);
    if (!appParty.file.encPk) {
      throw new Error("enc keypair missing — this should not happen after bootstrap");
    }
    setStage("proving");
    const res = await contract.callTx.registerEncKey(fromHex(appParty.file.encPk));
    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: { party: partyName, encPk: appParty.file.encPk },
    };
  });

/** POST /admin/bootstrap — origin, 3 supplier certs, threshold, 4 enc-key registrations. All separate jobs, all queued at once (the shared sequential queue runs them one after another). */
export const startBootstrapJobs = (): Job[] => {
  const jobs: Job[] = [];
  const origin = registry.defaultOrigin();
  jobs.push(startCertifyOriginJob(origin.label, origin.originId).job);
  for (const name of ["mine", "refiner", "batteryMfr"] as const) {
    jobs.push(startCertifySupplierJob(name));
  }
  jobs.push(startSetCarbonThresholdJob(5));
  for (const name of HOSTED_PARTIES) jobs.push(startRegisterEncKeyJob(name));
  return jobs;
};

// ---------------------------------------------------------------------------
// Issue / transfer / attest
// ---------------------------------------------------------------------------

export type IssueBody = {
  recipient: PartyName;
  originId: string;
  materialType: string;
  carbonClass: number;
  note?: string;
};

/**
 * Pre-check used by the route before enqueueing (fast UX 400), re-verified
 * inside the job at prep time regardless. `recipient` need not be hosted by
 * this process (separated deployment, HANDOFF.md §4) — its partyId comes
 * from `resolvePartyId` (local secret if hosted, else registry.json's public
 * directory). The ledger read itself is public, so any hosted party's
 * providers work; it uses `caller`'s (the route's own `party` param), which
 * this process is guaranteed to host.
 */
export const recipientHasEncKey = async (caller: PartyName, recipient: PartyName): Promise<boolean> => {
  const recipientId = fromHex(resolvePartyId(recipient));
  const ledgerNow = await currentLedger(
    appState.partyOrThrow(caller).party.providers,
    appState.contractAddressOrThrow(),
  );
  return ledgerNow.partyEncKeys.member(recipientId);
};

export const startIssueJob = (partyName: PartyName, body: IssueBody): Job =>
  enqueueJob(partyName, "issueProvenance", async ({ setStage, jobId }) => {
    setStage("preparing");
    const issuer = appState.partyOrThrow(partyName);
    const contract = appState.contractOrThrow(partyName);
    // See resolvePartyId's doc comment: body.recipient need not be hosted here.
    const recipientId = fromHex(resolvePartyId(body.recipient));

    const originIdBytes = fromHex(body.originId);
    const materialTypeBytes = bytes32FromLabel(body.materialType);
    const carbonClass = BigInt(body.carbonClass);
    const batchSecret = crypto.getRandomValues(new Uint8Array(32));

    await setPrivateState(
      issuer.party,
      forIssue(
        issuer.party.privateState,
        { originId: originIdBytes, materialType: materialTypeBytes, carbonClass, batchSecret },
        recipientId,
      ),
    );

    const ledgerNow = await currentLedger(issuer.party.providers, appState.contractAddressOrThrow());
    if (!ledgerNow.partyEncKeys.member(recipientId)) {
      throw new Error(`recipient "${body.recipient}" has no registered encryption key`);
    }
    const recipientPk = ledgerNow.partyEncKeys.lookup(recipientId);
    const inboxIndexAtCall = ledgerNow.credentialInboxCount;

    const newCred: Credential = {
      ownerId: recipientId,
      originId: originIdBytes,
      materialType: materialTypeBytes,
      carbonClass,
      batchSecret,
    };
    const commitment = pureCircuits.commitmentOf(newCred);
    const sealable: SealableCredential = {
      originId: originIdBytes,
      materialType: materialTypeBytes,
      carbonClass,
      batchSecret,
      commitment,
    };
    const entry = sealCredential(recipientPk, sealable);

    setStage("proving");
    const res = await contract.callTx.issueProvenance(entry);

    const commitmentHex = toHex(commitment);
    const issuedEntry: IssuedEntry = {
      commitment: commitmentHex,
      recipient: body.recipient,
      circuit: "issueProvenance",
      inboxIndex: Number(inboxIndexAtCall),
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      carbonClass: Number(carbonClass),
      materialLabel: body.materialType,
      originLabel: registry.originLabel(body.originId),
      createdAt: new Date().toISOString(),
      jobId,
    };
    issuer.file.issued.push(issuedEntry);

    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: {
        commitment: commitmentHex,
        inboxIndex: Number(inboxIndexAtCall),
        recipient: body.recipient,
      },
    };
  });

export type TransferBody = { recipient: PartyName; carbonClass: number };

/**
 * ATTACK PATH: this runs the real circuit even when `heldRecord.status` is
 * already CONSUMED — the agent does not pre-block a replay client-side. The
 * contract's own `!nullifiers.member(nullifier)` assert is what rejects it
 * ("veilance: credential already consumed"); the resulting job comes back
 * `rejected` with that exact text (see jobs.ts's `extractAssertMessage`).
 */
export const startTransferJob = (partyName: PartyName, credentialId: string, body: TransferBody): Job =>
  enqueueJob(partyName, "transferProvenance", async ({ setStage, jobId }) => {
    setStage("preparing");
    const holder = appState.partyOrThrow(partyName);
    const contract = appState.contractOrThrow(partyName);
    const heldRecord = holder.file.heldCredentials.find((c) => c.id === credentialId);
    if (!heldRecord) throw new Error(`credential "${credentialId}" not found in ${partyName}'s vault`);

    // A crashed attestation may have rotated this credential on chain already.
    const ledgerForSettle = await currentLedger(holder.party.providers, appState.contractAddressOrThrow());
    if (settlePendingRotation(heldRecord, ledgerForSettle, holder.party.privateState.partySecret)) savePartyFile(partyName, holder.file);

    // See resolvePartyId's doc comment: body.recipient need not be hosted here.
    const recipientId = fromHex(resolvePartyId(body.recipient));
    const newCarbonClass = BigInt(body.carbonClass);
    const newBatchSecret = crypto.getRandomValues(new Uint8Array(32));

    const heldWitness = credentialToWitness(heldRecord);
    await setPrivateState(
      holder.party,
      forTransfer(holder.party.privateState, heldWitness, recipientId, newCarbonClass, newBatchSecret),
    );

    const ledgerNow = await currentLedger(holder.party.providers, appState.contractAddressOrThrow());
    if (!ledgerNow.partyEncKeys.member(recipientId)) {
      throw new Error(`recipient "${body.recipient}" has no registered encryption key`);
    }
    const recipientPk = ledgerNow.partyEncKeys.lookup(recipientId);
    const inboxIndexAtCall = ledgerNow.credentialInboxCount;

    const newCred: Credential = {
      ownerId: recipientId,
      originId: heldWitness.originId,
      materialType: heldWitness.materialType,
      carbonClass: newCarbonClass,
      batchSecret: newBatchSecret,
    };
    const newCommitment = pureCircuits.commitmentOf(newCred);
    const sealable: SealableCredential = {
      originId: newCred.originId,
      materialType: newCred.materialType,
      carbonClass: newCarbonClass,
      batchSecret: newBatchSecret,
      commitment: newCommitment,
    };
    const entry = sealCredential(recipientPk, sealable);

    setStage("proving");
    const res = await contract.callTx.transferProvenance(entry);
    const [nullifier, newCommitmentOut] = res.private.result as [Uint8Array, Uint8Array];

    // Only reached on success (a thrown assert short-circuits above, caught
    // by jobs.ts's drain loop) — mark the upstream credential CONSUMED. No
    // separate save() call needed: `heldRecord` is the same object living
    // inside `holder.file.heldCredentials`, and jobs.ts persists the whole
    // party file right after this executor returns.
    heldRecord.status = "CONSUMED";
    heldRecord.consumedNullifier = toHex(nullifier);
    heldRecord.consumedTxHash = res.public.txHash;
    heldRecord.consumedBlockHeight = res.public.blockHeight;
    heldRecord.consumedAt = new Date().toISOString();
    heldRecord.consumedByJobId = jobId;

    // See startIssueJob's matching push — `holder` is this edge's issuer.
    const newCommitmentHex = toHex(newCommitmentOut);
    const issuedEntry: IssuedEntry = {
      commitment: newCommitmentHex,
      recipient: body.recipient,
      circuit: "transferProvenance",
      inboxIndex: Number(inboxIndexAtCall),
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      carbonClass: Number(newCarbonClass),
      materialLabel: heldRecord.materialLabel,
      originLabel: heldRecord.originLabel,
      createdAt: heldRecord.consumedAt,
      jobId,
    };
    holder.file.issued.push(issuedEntry);

    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: {
        nullifier: toHex(nullifier),
        newCommitment: newCommitmentHex,
        recipient: body.recipient,
        inboxIndex: Number(inboxIndexAtCall),
      },
    };
  });

export type AttestBody = { profile: VerifierProfileName; challenge: string };

/**
 * Rotate-on-attest recovery. If an earlier attest call chose a secret and the
 * process died before recording the result, the rotated commitment may be on
 * chain while the vault still holds the old secret. Adopt the pending secret
 * iff its commitment is in the provenance tree; otherwise drop it (the call
 * never landed). Returns true if the record changed.
 */
const settlePendingRotation = (
  record: HeldCredential,
  ledgerNow: Awaited<ReturnType<typeof currentLedger>>,
  partySecret: Uint8Array,
): boolean => {
  if (!record.pendingBatchSecret) return false;
  const candidate = pureCircuits.commitmentOf({ ...credentialToWitness(record), batchSecret: fromHex(record.pendingBatchSecret) });
  if (ledgerNow.provenanceTree.findPathForLeaf(candidate)) {
    const spent = pureCircuits.nullifierOf(fromHex(record.commitment), partySecret);
    record.batchSecret = record.pendingBatchSecret;
    record.commitment = toHex(candidate);
    record.rotations = [...(record.rotations ?? []), { nullifier: toHex(spent), commitment: record.commitment, at: new Date().toISOString() }];
  }
  delete record.pendingBatchSecret;
  return true;
};

/**
 * Attest = prove the held credential meets `profile`, then (in the same
 * circuit) spend it and re-mint it to ourselves under a fresh secret. The
 * credential keeps its `id` (so the wallet shows the same card and graph
 * edges still match); its current commitment and secret move on.
 *
 * Like transfer, this does not pre-block a CONSUMED credential: the
 * contract's nullifier check is what rejects it, for every profile.
 */
export const startAttestJob = (partyName: PartyName, credentialId: string, body: AttestBody): Job => {
  const circuit = CIRCUIT_FOR_PROFILE[body.profile];
  return enqueueJob(partyName, circuit, async ({ setStage, jobId }) => {
    setStage("preparing");
    const holder = appState.partyOrThrow(partyName);
    const contract = appState.contractOrThrow(partyName);
    const heldRecord = holder.file.heldCredentials.find((c) => c.id === credentialId);
    if (!heldRecord) throw new Error(`credential "${credentialId}" not found in ${partyName}'s vault`);

    const ledgerBefore = await currentLedger(holder.party.providers, appState.contractAddressOrThrow());
    if (settlePendingRotation(heldRecord, ledgerBefore, holder.party.privateState.partySecret)) savePartyFile(partyName, holder.file);

    const heldWitness = credentialToWitness(heldRecord);
    const newBatchSecret = crypto.getRandomValues(new Uint8Array(32));
    // Persist the secret before proving: once the transaction lands, this is
    // the only copy of the rotated credential's pre-image.
    heldRecord.pendingBatchSecret = toHex(newBatchSecret);
    savePartyFile(partyName, holder.file);
    await setPrivateState(holder.party, forAttest(holder.party.privateState, heldWitness, newBatchSecret));

    const challengeBytes = fromHex(body.challenge);

    setStage("proving");
    let res;
    try {
      res =
        body.profile === "consumer"
          ? await contract.callTx.attestConsumer(challengeBytes)
          : body.profile === "procurement"
            ? await contract.callTx.attestProcurement(challengeBytes)
            : await contract.callTx.attestRegulator(challengeBytes);
    } catch (err) {
      // A contract rejection never lands, so the pending secret is dead. Any
      // other failure (timeout, disconnect) might have landed — keep it for
      // settlePendingRotation to resolve against the ledger next time.
      if (/veilance:/.test(err instanceof Error ? err.message : String(err))) delete heldRecord.pendingBatchSecret;
      throw err;
    }
    const [nullifier, newCommitment] = res.private.result as [Uint8Array, Uint8Array];

    heldRecord.batchSecret = toHex(newBatchSecret);
    heldRecord.commitment = toHex(newCommitment);
    delete heldRecord.pendingBatchSecret;
    heldRecord.rotations = [
      ...(heldRecord.rotations ?? []),
      { nullifier: toHex(nullifier), commitment: heldRecord.commitment, txHash: res.public.txHash, blockHeight: res.public.blockHeight, at: new Date().toISOString(), jobId },
    ];

    const attestationKey = pureCircuits.attestationKeyOf(
      challengeBytes,
      heldWitness.ownerId,
      PROFILE_CODE[body.profile],
    );
    const ledgerAfter = await currentLedger(holder.party.providers, appState.contractAddressOrThrow());
    const recorded = ledgerAfter.attestations.lookup(attestationKey);

    return {
      txHash: res.public.txHash,
      blockHeight: res.public.blockHeight,
      result: {
        attestationKey: toHex(attestationKey),
        profile: body.profile,
        policyVersion: recorded.policyVersion.toString(),
        nullifier: toHex(nullifier),
        rotatedCommitment: heldRecord.commitment,
      },
    };
  });
};

// ---------------------------------------------------------------------------
// Credentials / scan (no proving — plain reads/writes)
// ---------------------------------------------------------------------------

export const listCredentials = (partyName: PartyName): PublicCredential[] =>
  appState.partyOrThrow(partyName).file.heldCredentials.map(toPublicCredential);

export const runScan = async (
  partyName: PartyName,
): Promise<{ found: number; credentials: PublicCredential[] }> => {
  const appParty = appState.partyOrThrow(partyName);
  if (!appParty.file.encSk || !appState.contractAddress) {
    return { found: 0, credentials: [] };
  }

  const ledgerNow = await currentLedger(appParty.party.providers, appState.contractAddress);
  const myPartyId = pureCircuits.partyIdOf(fromHex(appParty.file.partySecret));
  const fromIndex = BigInt(appParty.file.lastSeenInboxIndex);
  const scanResult = scanInbox(ledgerNow, fromHex(appParty.file.encSk), myPartyId, fromIndex);

  const alreadyKnown = new Set(appParty.file.heldCredentials.map((c) => c.id));
  const newlyFound: HeldCredential[] = [];

  scanResult.credentials.forEach((cred, i) => {
    const commitmentHex = toHex(pureCircuits.commitmentOf(cred));
    if (alreadyKnown.has(commitmentHex)) return; // idempotent rescans
    const originHex = toHex(cred.originId);
    newlyFound.push({
      id: commitmentHex,
      commitment: commitmentHex,
      ownerId: toHex(cred.ownerId),
      originId: originHex,
      originLabel: registry.originLabel(originHex),
      materialType: toHex(cred.materialType),
      materialLabel: labelFromBytes32(cred.materialType),
      carbonClass: Number(cred.carbonClass),
      batchSecret: toHex(cred.batchSecret),
      status: "ACTIVE",
      receivedAt: new Date().toISOString(),
      inboxIndex: scanResult.inboxIndices[i] === undefined ? undefined : Number(scanResult.inboxIndices[i]),
    });
  });

  appParty.file.heldCredentials.push(...newlyFound);
  appParty.file.lastSeenInboxIndex = scanResult.nextIndex.toString();
  savePartyFile(partyName, appParty.file);

  return { found: newlyFound.length, credentials: newlyFound.map(toPublicCredential) };
};

export const getDisclosurePreview = (op: "issue" | "transfer" | "attest", profile?: VerifierProfileName) =>
  disclosurePreview(op, profile);

// ---------------------------------------------------------------------------
// Verify (no party / no wallet)
// ---------------------------------------------------------------------------

export const createChallenge = (profile: VerifierProfileName, holder: PartyName): StoredChallenge => {
  // resolvePartyId, not appState.partyOrThrow: holder's partyId is public
  // once known (it's a one-way hash of their secret, and the challenge/
  // attestationKey derived from it are meant to be handed to a verifier who
  // never holds anyone's secret) — see resolvePartyId's doc comment and
  // HANDOFF.md §4-2. Computing it from a local secret this process happens
  // to hold was never necessary and blocked a holder-less verifier agent
  // from creating challenges for parties it doesn't host.
  const holderPartyId = fromHex(resolvePartyId(holder));
  const challenge = randomHex32();
  const attestationKey = toHex(
    pureCircuits.attestationKeyOf(fromHex(challenge), holderPartyId, PROFILE_CODE[profile]),
  );
  const entry: StoredChallenge = { challenge, attestationKey, profile, holder, createdAt: new Date().toISOString() };
  appState.challenges.push(entry);
  saveChallenges(appState.challenges);
  return entry;
};

export const listChallenges = (): StoredChallenge[] => appState.challenges;

/**
 * `GET /verify/challenges?holder=&open=true` (v1.1 addendum) — the requests
 * this `holder` has not yet satisfied with a fresh PASSED attestation
 * (PENDING = never attested; STALE = attested under an older policy
 * version), newest first. Feeds the holder's "Prove compliance" form
 * autofill. One ledger read for all of this holder's challenges, rather than
 * `getVerifyResult`'s one-read-per-challenge (that endpoint is fine for a
 * single lookup; this one is a list).
 */
export const listOpenChallenges = async (holder: PartyName): Promise<StoredChallenge[]> => {
  const forHolder = appState.challenges.filter((ch) => ch.holder === holder);
  if (forHolder.length === 0) return [];
  if (!appState.contractAddress) return sortNewestFirst(forHolder);

  // anyPartyOrThrow, not partyOrThrow(holder): this is a public ledger read
  // (attestations are keyed by attestationKey, not by which party's
  // provider fetched them), so any hosted party's provider works — see
  // appState.anyPartyOrThrow's doc comment. Requiring `holder` specifically
  // broke this for every agent that doesn't host that party (milestone 2,
  // HANDOFF.md §4).
  const ledger = await currentLedger(appState.anyPartyOrThrow().party.providers, appState.contractAddress);
  const currentPolicyVersion = ledger.policyVersion.toString();

  const open = forHolder.filter((ch) => {
    const attestationKey = fromHex(ch.attestationKey);
    if (!ledger.attestations.member(attestationKey)) return true; // PENDING
    const recorded = ledger.attestations.lookup(attestationKey);
    return recorded.policyVersion.toString() !== currentPolicyVersion; // STALE
  });
  return sortNewestFirst(open);
};

const sortNewestFirst = (challenges: StoredChallenge[]): StoredChallenge[] =>
  [...challenges].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

export type VerifyResult = {
  status: "PENDING" | "PASSED" | "STALE";
  attestation?: { profile: VerifierProfileName; policyVersion: string };
  currentPolicyVersion: string;
  predicates: Predicate[];
  private: string[];
};

export const getVerifyResult = async (
  challengeHex: string,
  holder: PartyName,
  profile: VerifierProfileName,
): Promise<VerifyResult> => {
  // resolvePartyId + anyPartyOrThrow, not partyOrThrow(holder) — see
  // createChallenge's and listOpenChallenges's identical comments just
  // above. This is the endpoint the web UI's verifier card actually polls,
  // so it was the most visible instance of milestone 2's bug: a verifier
  // agent hosting none of the four demo parties could not check anyone's
  // compliance status at all.
  const holderPartyId = fromHex(resolvePartyId(holder));
  const attestationKey = pureCircuits.attestationKeyOf(fromHex(challengeHex), holderPartyId, PROFILE_CODE[profile]);

  const ledger = await currentLedger(appState.anyPartyOrThrow().party.providers, appState.contractAddressOrThrow());
  const currentPolicyVersion = ledger.policyVersion.toString();
  const privateFields = disclosurePreview("attest", profile).private;

  if (!ledger.attestations.member(attestationKey)) {
    return { status: "PENDING", currentPolicyVersion, predicates: emptyPredicates(), private: privateFields };
  }

  const recorded = ledger.attestations.lookup(attestationKey);
  const fresh = recorded.policyVersion.toString() === currentPolicyVersion;
  return {
    status: fresh ? "PASSED" : "STALE",
    attestation: { profile, policyVersion: recorded.policyVersion.toString() },
    currentPolicyVersion,
    predicates: predicatesFor(profile),
    private: privateFields,
  };
};
