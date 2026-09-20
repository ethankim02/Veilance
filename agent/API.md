# Veilance Party Agent — HTTP API contract (v1)

The agent is a Node service that hosts one or more **parties** (each with its own
partySecret, X25519 key, wallet, private state provider, and midnight-js
providers) and talks to the Veilance contract on the local devnet. For the demo
one process hosts all four parties; in production each enterprise runs its own
agent with exactly one party. The web UI only ever talks to this API.

Base URL: `http://localhost:4000`. All bodies JSON. All `bytes` are lowercase hex
without `0x`. All `bigint` are decimal strings. Errors: `{ "error": string,
"code": string }` with 4xx/5xx.

## Roles / parties

`PartyName = "admin" | "mine" | "refiner" | "batteryMfr"`. Verifiers are not
parties (no wallet); the verify endpoints are unauthenticated reads.

## Long-running calls → jobs

Every circuit call takes 20–45 s (proving + balancing + submit + finality).
Circuit endpoints therefore return **202** with a job, and the UI polls it.

```
Job {
  id: string
  party: PartyName
  circuit: "deploy"|"registerEncKey"|"certifyOrigin"|"certifySupplier"|"setCarbonThreshold"
         |"issueProvenance"|"transferProvenance"|"attestConsumer"|"attestProcurement"|"attestRegulator"
  stage: "queued"|"preparing"|"proving"|"submitting"|"confirmed"|"rejected"|"failed"
  startedAt: string (ISO)   finishedAt?: string
  elapsedMs?: number
  txHash?: string  blockHeight?: number
  result?: object            // circuit-specific, see below
  error?: string             // for rejected/failed. "rejected" = contract assert failed (e.g. "credential already consumed")
}
```

- `GET  /jobs/:id` → Job
- `GET  /jobs?party=` → Job[] (newest first)

## System

- `GET /health` → `{ ok, devnet: { node, indexer, proofServer: { ok, version } }, contractAddress?: string, deployed: boolean }`
- `POST /deploy` (admin) → 202 Job. Deploys the contract; address persisted in `agent/.state/deployment.json`. Idempotent: if already deployed returns the existing address with 200 `{ contractAddress }`.
- `GET /parties` → `[{ name, partyId, encPk?: string, certified: boolean, encKeyRegistered: boolean, night: string, dust: string }]`

## Ledger (public, via indexer)

- `GET /ledger` →
```
{
  contractAddress, blockHeight,
  adminId, policyVersion: string, carbonThreshold: number,
  provenanceLeafCount: number, nullifierCount: number,
  attestationCount: number, inboxCount: number, encKeyCount: number,
  certifiedOriginCount: number, certifiedSupplierCount: number
}
```
- `GET /ledger/policy` → `{ policyVersion, carbonThreshold, origins: [{ originId, label? }], suppliers: [{ partyId, certId, label?, partyName?: PartyName, org?: string }] }` — labels come from the agent's local registry (L3), never from chain.
- `GET /ledger/txs` → recent contract tx list from the indexer `[{ txHash, blockHeight, circuit?, timestamp? }]` (best effort).

## Admin (party=admin)

- `POST /admin/origins` `{ label: string, originId?: hex }` → 202 Job (certifyOrigin). If `originId` omitted the agent generates a random 32-byte id and stores `label ↔ originId` locally.
- `POST /admin/suppliers` `{ partyName: PartyName, certId?: hex, certLabel?: string }` → 202 Job (certifySupplier). Uses the party's known partyId and its configured certId if omitted.
- `POST /admin/carbon-threshold` `{ threshold: number }` → 202 Job.
- `POST /admin/bootstrap` → 202 `{ jobs: Job[] }` — convenience: certify default origin, certify mine/refiner/batteryMfr, set threshold 5, registerEncKey for all four. Runs sequentially; each a separate job.

## Party (party = mine | refiner | batteryMfr | admin)

- `POST /parties/:party/enc-key` → 202 Job (registerEncKey). Generates the X25519 keypair if missing (persisted in private state dir).
- `GET  /parties/:party/credentials` → `[{ id, commitment, originId, originLabel?, materialType, materialLabel?, carbonClass, status: "ACTIVE"|"CONSUMED", receivedAt, inboxIndex?, issuedBy?: PartyName }]` — the party's L2 held credentials. Pre-image fields are returned because this is the party's own agent.
- `POST /parties/:party/scan` → `{ found: number, credentials: [...] }` — scan the inbox from `lastSeenInboxIndex`, trial-decrypt, verify against tree, store.
- `POST /parties/:party/issue` `{ recipient: PartyName, originId: hex, materialType: string, carbonClass: number, note?: string }` → 202 Job (issueProvenance). Agent generates batchSecret, seals the entry to `partyEncKeys[recipientId]`, runs the circuit. Job.result: `{ commitment, inboxIndex, recipient }`. 400 if recipient has no registered enc key.
- `POST /parties/:party/credentials/:id/transfer` `{ recipient: PartyName, carbonClass: number }` → 202 Job (transferProvenance). Job.result: `{ nullifier, newCommitment, inboxIndex }`. On contract rejection the job is `rejected` with the assert message (this is the demo attack path: transferring a CONSUMED credential).
- `POST /parties/:party/credentials/:id/attest` `{ profile: "consumer"|"procurement"|"regulator", challenge: hex }` → 202 Job. Job.result: `{ attestationKey, profile, policyVersion }`.
- `GET  /parties/:party/disclosure-preview?op=issue|transfer|attest&profile=` → `{ public: string[], private: string[] }` — static text for the UI's "what goes on chain" panel.

## Verify (no party)

- `POST /verify/challenges` `{ profile, holder: PartyName }` → `{ challenge: hex, attestationKey: hex, profile, holder, createdAt }` — generates a 32-byte CSPRNG challenge and precomputes `attestationKeyOf(challenge, holderPartyId, profileCode)` via pureCircuits. Stored locally so the UI can list them.
- `GET  /verify/challenges` → list.
- `GET  /verify/:challenge?holder=&profile=` → `{ status: "PENDING"|"PASSED"|"STALE", attestation?: { profile, policyVersion }, currentPolicyVersion, predicates: [{ key, label, passed: boolean|null }], private: string[] }`. STALE = attestation exists but policyVersion ≠ current. Predicates per profile follow spec.md §4.2.3.
- All three routes above resolve `holder`'s partyId via `resolvePartyId` (local secret if hosted, else `registry.json`'s public `parties` directory) and read the ledger via `appState.anyPartyOrThrow()` (any hosted party's provider — this is a public read), not `holder`'s own provider specifically — see the "independent verifier" addendum below for why that distinction matters and `src/cli/verify-independent.ts` for a version that skips this HTTP API (and any running agent) entirely.

## Independent verification (v1.3 addendum — no agent required at all)

The three `/verify/*` routes above run *inside* a Party Agent process, so
using them still means trusting that process. `src/cli/verify-independent.ts`
is the standalone version: a script an OEM or regulator runs on their own
machine, needing only

- the network's public indexer GraphQL endpoint (`indexerPublicDataProvider`
  built from two URLs — no wallet, no proof server, no party secret, no
  agent process of any kind, running or otherwise);
- `registry.json`'s public `parties` directory, for the holder's partyId;
- the compiled contract's public `pureCircuits`/`ledger` decoder — an open
  build artifact anyone can reproduce from `src/veilance.compact` with
  `compact compile +0.31.1`, not something only the demo agent has.

```bash
cd agent
set -a && . ./.env.preprod && set +a   # or export VEILANCE_INDEXER_HTTP_URL/_WS_URL yourself
npx tsx src/cli/verify-independent.ts batteryMfr procurement <challengeHex>
```

Prints the same `{ status, attestation?, currentPolicyVersion, predicates }`
shape as `GET /verify/:challenge`, computed from a direct indexer read.
Verified on Preprod (2026-09-13, HANDOFF.md §0): with every local Party
Agent process stopped, this script alone reproduced the exact PASSED verdict
and predicate table the web UI shows for an existing attestation, and
correctly reported PENDING for an unseen challenge.

Not handled yet: authenticating that the `holder` name a caller supplies is
who they claim (same caveat as every other party name in this demo — see
README.md's "demo scope" section) and a UI wrapper around this script (it's
CLI-only for now).

## Notes for implementers

- Reuse `contract/e2e/lib/*` (wallet, providers, health, zk, config) and `contract/src/{witnesses,sealed-entry}.ts` — do not fork them. Move shared code into `contract/e2e/lib` or import across packages; the agent may depend on `../contract` as a workspace/file dependency.
- Party private state = the level provider + a small JSON sidecar (`agent/.state/<party>/agent.json`) for enc keypair, held credentials with labels, lastSeenInboxIndex, job history, and (v1.1) an `issued[]` list of every `issueProvenance`/`transferProvenance` call this party made as issuer (`{ commitment, recipient, circuit, inboxIndex?, txHash?, blockHeight?, carbonClass?, materialLabel?, originLabel?, createdAt, jobId }`) — what `GET /graph` builds edges from, so they survive a restart without re-deriving them from job history every request.
- Attack demo: the UI needs to be able to call transfer on a CONSUMED credential; the agent must not block it client-side (it warns via `disclosure-preview`/UI, but executes), so the contract assert is what rejects.
- Labels (origin name, material name, org name) are L3 data: keep them in `agent/registry.json`, seed with demo values ("DRC Mine X", "Cobalt", org names).
- (v1.3) `GET /graph`'s `edges[].provingMs` comes from looking up `ev.jobId` in this process's job history (`getJob`, appState.jobsById — populated from persisted `agent.json` job history at boot, see bootstrap.ts) at request time, not a persisted field on the edge itself — so it can be absent for an old edge whose job history has aged out, while `verifierKeyFingerprint` (a hash of the compiled `keys/<circuit>.verifier` file, not per-job data — see `verifierKeys.ts`) is always present once `compile:zk` has run.

## Per-company agents (v1.2 addendum — one party per process)

The opening paragraph's "in production each enterprise runs its own agent
with exactly one party" is now a real config knob, not just intent:

- `AGENT_PARTIES` (env, comma-separated `PartyName`s; default: all four) —
  restricts which parties this process builds wallets/providers for and
  serves. A party this process does not host behaves exactly as if it didn't
  exist: `GET /parties` omits it, and any `:party` route for it errors. This
  is the only thing that changes between the demo (unset) and a real
  single-company deployment (`AGENT_PARTIES=mine`).
- `AGENT_CONTRACT_ADDRESS` (env) — a single-company agent never calls
  `POST /deploy` (only `admin` does); on first boot, with no
  `.state/.../deployment.json` yet, this address is what it attaches its
  hosted part(ies) to instead. Persisted after that, so the env var only
  matters once.
- `POST /admin/suppliers` (and `POST /admin/bootstrap`'s three
  `certifySupplier` calls), `POST /parties/:party/issue`, and
  `POST /parties/:party/credentials/:id/transfer` all still work when the
  *other* party in the call (the certified company; the issue/transfer
  recipient) isn't hosted by this agent: its `partyId` — public once
  certified on-chain anyway — is read from `agent/registry.json`'s `parties`
  directory instead of being computed locally from a secret this agent never
  has. A company populates its own entry there by running
  `npx tsx src/cli/print-identity.ts <party>` on the agent that actually
  holds that party's secret, and shares the printed `partyId` (never the
  secret) for every other agent's `registry.json` to include.
- Not handled by this addendum: authenticating who is allowed to act as a
  hosted party over this agent's own HTTP API (still none — same caveat as
  README.md's "demo scope" section), and how a verifier authenticates
  reads (roadmap milestone 2, HANDOFF.md §4).

## Explorer (v1.1 addendum — public chain reads, proxied from the indexer)

Local devnets have no hosted block explorer, so the agent exposes read-only
explorer endpoints backed by the indexer GraphQL API. The web UI renders an
in-app explorer panel from these and, when `VITE_EXPLORER_URL_TEMPLATE` is set
(e.g. `https://<explorer>/tx/{hash}` for preview/mainnet), also offers an
"open in external explorer" link.

- `GET /explorer/tip` → `{ blockHeight, blockHash, timestamp }` — chain tip (poll for a live "chain" indicator).
- `GET /explorer/block/:height` → `{ height, hash, parentHash?, timestamp, txCount, txHashes: string[] }`. 404 if unknown.
- `GET /explorer/tx/:hash` → `{ hash, blockHeight, blockHash, timestamp, status?: "applied"|"failed", contractActions: [{ address, kind: "deploy"|"call"|"update", entryPoint?: string }], identifiers?: string[], source: "indexer" }`. 404 if unknown (400 if `:hash` isn't 64 hex chars). Everything on this shape comes straight from the indexer, `entryPoint` included — no job-history fill needed here (see agent/README.md's "Explorer & graph").
- `GET /explorer/contract` → `{ address, deployTxHash, deployBlockHeight, latestBlockHeight, actionCount, actions: [{ txHash, blockHeight, timestamp?, kind, entryPoint?, party?: PartyName, circuit?: string, jobId?: string, source: "indexer"|"agent" }] }` — merges the indexer's contract actions with the agent's job history (party is agent-known, never on chain; `circuit` likewise, though it equals `entryPoint` for every circuit this contract defines). The indexer has no per-address action list (only "latest" or "at this offset"), so `actions[]` is built from job history and independently cross-verified against the chain's own current latest action for one row only — that row is tagged `source: "indexer"`, the rest `source: "agent"` (see agent/README.md).
- `GET /explorer/ledger-raw` → the decoded ledger object (counts + roots + threshold + version), for a "what the chain actually holds" panel.

Every job (`Job.txHash`, `Job.blockHeight`) is linkable to `/explorer/tx/:hash`; the deployment to `/explorer/contract`.

## Graph (v1.1 addendum — the supply-chain view)

- `GET /graph` →
```
{
  nodes: [{ id: PartyName|"verifier", org: string, role: string, certified: boolean, encKeyRegistered: boolean,
            held: number, consumed: number, attestations: number, lastActivityAt?: string }],
  edges: [{ id: string, from: PartyName, to: PartyName, credentialId: string, commitment: string,
            status: "ISSUED"|"DELIVERED"|"CONSUMED", circuit: "issueProvenance"|"transferProvenance",
            txHash?: string, blockHeight?: number, inboxIndex?: number, carbonClass?: number, materialLabel?: string,
            originLabel?: string, createdAt: string, jobId?: string,
            lotNumber: number,                        // 1-based, edge-creation order — "Cobalt · lot 2"
            nullifier?: string, consumedTxHash?: string, consumedBlockHeight?: number, deliveredAt?: string,
            provingMs?: number,                       // v1.3: this edge's own circuit call, end to end — absent if this process's job history no longer has it (see jobs.ts)
            verifierKeyFingerprint?: string }],        // v1.3: sha256(keys/<circuit>.verifier), first 16 hex chars — same value for every proof of that circuit, see verifierKeys.ts
  attestations: [{ holder: PartyName, profile, attestationKey, policyVersion, txHash?, blockHeight?, challenge?: string, createdAt }],
  activeJob?: Job,           // the job currently running (for the global progress bar)
  queue: Job[]               // queued jobs
}
```
Edges are derived from the agent's vaults (issuer's own persisted `issued[]`
list — see "Notes for implementers" below — falling back to job history +
held credentials + inbox decryption for anything predating that vault): an
issue job creates an edge ISSUED; the recipient's scan turns it DELIVERED; a
transfer job marks the upstream edge CONSUMED (and stamps its
`consumedTxHash`/`consumedBlockHeight`/`nullifier` onto that same edge) and
creates the next edge. `nullifier`/`consumedTxHash`/`consumedBlockHeight`/
`deliveredAt` are additive enrichment, not required by any client. Labels/orgs
are L3 (registry). Sensitive pre-image fields are only returned because the
demo agent hosts every party; a single-party agent returns only its own
edges' private fields.

Requests without a fresh PASSED attestation ("open" requests) list separately:
`GET /verify/challenges?holder=<PartyName>&open=true` → `StoredChallenge[]`
(same shape as the plain `GET /verify/challenges`), newest first — feeds the
holder's "Prove compliance" form's auto-fill. "Open" = PENDING (never
attested) or STALE (attested under an older `policyVersion` than current).

### Workspace graph projection

`GET /graph?viewer=mine|refiner|batteryMfr|verifier|admin` returns a presentation
scope for the demo workspace (default `batteryMfr`; invalid values return 400).
Company scopes include only direct material transfers and their own attestations
and jobs. Other companies' inventory counts and activity are removed from nodes;
senders do not receive later consumption transaction links for a recipient's lot.
OEM receives no inventory edges. `viewer=admin` returns the full operations graph.
This query parameter is not an authenticated identity or authorization boundary;
the single-process demo's other routes remain unchanged and unauthenticated.

## Delegated wallet (v1.4 addendum — browser wallet connection)

Proving and every witness secret (`partySecret`, X25519 inbox keys, held
credentials) stay in the agent, exactly as before. This addendum only moves
**fee balancing and submission** for a job's circuit call to a browser
wallet (Lace or any other `@midnight-ntwrk/dapp-connector-api` v4.0.1
wallet), when one is connected for that job's party. See `docs/WALLET.md`
for the verified DApp Connector facts this is built on, sources, and how to
test it (with the dev wallet or with real Lace on Preprod).

`Job.stage` gains `"awaiting_wallet"`, between `proving` and `submitting`.
While in that stage, `Job` also carries:

```
walletRequest: {
  id: string
  kind: "balance-and-submit"
  txHex: hex          // proven-but-unbalanced tx, Transaction<SignatureEnabled, Proof, PreBinding>, serialized
  networkId: string
}
```

The browser is expected to call the connected wallet's
`balanceUnsealedTransaction(txHex)` with `walletRequest.txHex` and post the
result back (see below). **The agent always submits the balanced
transaction itself** through its own node connection — the DApp Connector's
`submitTransaction` reports nothing back (not even a transaction id), so a
browser-submitted tx could never fill in `Job.txHash`; see docs/WALLET.md's
"verified facts" for the source. A job stuck in `awaiting_wallet` for more
than 5 minutes fails with `error: "wallet did not respond"` — the same
`stage: "failed"` shape as any other non-assert failure (contract rejections
from an executed circuit call still happen exactly as before, and still
before any wallet involvement — `awaiting_wallet` only happens after a
successful local circuit execution has already produced a proof).

- `POST /wallet/session` `{ party: PartyName, networkId: string, coinPublicKey: string, encryptionPublicKey: string, unshieldedAddress: string }`
  → `200 WalletSession`. Marks `party` (must be one this process hosts —
  `AGENT_PARTIES`) as wallet-delegated: every subsequent job for that party
  has its `balanceTx` delegated to this wallet until disconnected. `409` on
  `networkId` mismatch or an unhosted party. **The three key/address fields
  are named to match the rest of this API's hex convention, but carry the
  DApp Connector's native Bech32m encoding** (`getShieldedAddresses()`'s
  `shieldedCoinPublicKey`/`shieldedEncryptionPublicKey`, and
  `getUnshieldedAddress()`'s `unshieldedAddress`) — the agent decodes them
  (it already depends on `wallet-sdk-address-format`); the browser never
  needs to. In-memory only — lost on restart, like everything else in
  `appState`.
- `GET /wallet/session` → `WalletSession[]` — every party with a connected
  wallet right now, `coinPublicKey`/`encryptionPublicKey` already decoded to
  hex.
- `DELETE /wallet/session/:party` → `{ ok: true }` (404 if none). Reverts
  `party` to the agent's own wallet; any job already `awaiting_wallet` for
  that party still waits for a result (or the 5-minute timeout) — it is not
  cancelled.
- `POST /jobs/:id/wallet-result` `{ requestId: string, balancedTxHex: hex } | { requestId: string, error: string }`
  → `{ ok: true }`. `requestId` must match the job's current
  `walletRequest.id` (404 otherwise — already resolved, timed out, or never
  existed). `balancedTxHex` is the connector's `balanceUnsealedTransaction`
  result, decoding to `Transaction<SignatureEnabled, Proof, Binding>`.
  `error` (e.g. the user rejected the connector's prompt) fails the job with
  that message, `stage: "failed"` (not `"rejected"` — that stage is reserved
  for the contract's own assert failures). Posting `{ txHash }` instead is
  `400` — this API does not support a browser that submits the transaction
  itself (see above).

### Dev wallet (`VEILANCE_DEV_WALLET=1`)

Two additional endpoints, only registered when the agent is started with
`VEILANCE_DEV_WALLET=1` — see docs/WALLET.md for how `web/src/lib/devWallet.ts`
uses them to exercise the full round trip above without a real Lace install.
Neither should ever be enabled against a real deployment's agent.

- `POST /wallet/dev-balance-submit` `{ party: PartyName, txHex: hex }` →
  `{ tx: hex }`. Balances (signs, binds) `txHex` using `party`'s own real
  headless agent wallet — the exact function the agent's non-delegated path
  also calls — and returns the result, WITHOUT submitting it or touching any
  job. Stands in for a real wallet's `balanceUnsealedTransaction`.
- `GET /wallet/dev-identity/:party` → `{ coinPublicKey, encryptionPublicKey, unshieldedAddress, networkId }`,
  all Bech32m — `party`'s own headless wallet's identity, in the same shape
  `POST /wallet/session` expects, so the dev wallet needs no separate
  encoding of its own.
