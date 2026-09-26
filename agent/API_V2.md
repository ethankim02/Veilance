# Veilance v2 API — for traceability platforms

Design: [docs/PLATFORM_LAYER.md](../docs/PLATFORM_LAYER.md) · contract: [docs/PROVENANCE_V2.md](../docs/PROVENANCE_V2.md)

## Roles

| Process | Run by | Holds | Does |
|---|---|---|---|
| **node** | a platform or a company | each tenant's party secret, lots, period accounts | builds and proves every transaction, submits it |
| **sponsor** | the operator | the fee wallet only | adds DUST fees to a proven transaction (`/sponsor/balance`) and submits it (`/sponsor/submit`) |

A node owns no funds; the sponsor never sees a secret or a witness, and cannot change a proven transaction without breaking its proof. Submission runs through the sponsor's wallet so that a transaction the chain rejects releases the DUST it booked (`revertTransaction`) instead of locking it until the TTL expires.

```bash
# both roles in one process (local dev), port 4100
npm run v2
# split: operator sponsor + platform node
VEILANCE_V2_ROLE=sponsor VEILANCE_V2_PORT=4200 npm run v2
VEILANCE_V2_ROLE=node VEILANCE_V2_PORT=4100 VEILANCE_SPONSOR_URL=http://localhost:4200 npm run v2
# full scenario over HTTP
npm run v2:e2e
```

| Env | Default | Meaning |
|---|---|---|
| `VEILANCE_V2_ROLE` | `both` | `node` · `sponsor` · `both` |
| `VEILANCE_V2_PORT` | `4100` | HTTP port |
| `VEILANCE_V2_STATE_DIR` | `agent/.state/v2` | tenants, private state, sponsor wallet |
| `VEILANCE_SPONSOR_URL` | this process | where a node reaches its sponsor |
| `VEILANCE_SPONSOR_TOKEN` | dev token on the local devnet | bearer token a node presents to the sponsor |
| `VEILANCE_SPONSOR_SEED` | dev seed on the local devnet | fee wallet seed (fund it from the faucet elsewhere) |

Prerequisite: `npm run compile:zk:v2` in `contract/`.

## Auth

Every tenant has an API key, shown once when the tenant is created: `Authorization: Bearer vk_…`.
On first boot the node creates the **admin tenant** (policy authority) and writes its key to `<state>/v2/admin-api-key`.

All write operations return `202` with a job; poll `GET /v2/jobs/:id` until `stage` is `confirmed`, `rejected` (contract assert, with its message) or `failed`. Jobs run one at a time per node.

## Admin

| Method | Path | Body | |
|---|---|---|---|
| POST | `/v2/admin/deploy` | — | deploy the v2 contract |
| POST | `/v2/admin/tenants` | `{ name, partySecret?, certId? }` | → `{ id, partyId, certId, apiKey, registerJob }`. Omit `partySecret` to have the node generate it. Registers the receiving key automatically. |
| GET | `/v2/admin/tenants` | — | tenant list |
| POST | `/v2/admin/origins` | `{ label }` | approve an origin (mine site or recycling facility) |
| POST | `/v2/admin/suppliers` | `{ partyId, certId }` | certify a supplier |
| POST | `/v2/admin/recyclers` | `{ partyId, certId, isEu }` | certify a recycler; `isEu` decides the 1.3× column |
| POST | `/v2/admin/rules` | `{ inMaterial, outMaterial, yieldPct }` | processing rule (a same-material merge is `in = out`, 100) |
| POST | `/v2/admin/threshold` | `{ value }` | carbon-class threshold |

## Company tenants

| Method | Path | Body | |
|---|---|---|---|
| GET | `/v2/me` | — | `{ id, name, partyId, certId, … }` |
| GET | `/v2/directory` | — | company names and party ids on this node |
| GET | `/v2/lots?status=ACTIVE` | — | vault lots (quantities in kg, recycled EU / other, origins with issuer ids) |
| POST | `/v2/inbox/scan` | — | pull deliveries (also runs after every confirmed job) |
| POST | `/v2/lots/issue` | `{ recipient, origin, material, quantityKg, carbonClass?, custody?, recycled?, isEu?, memo? }` | issue; `recycled: true` needs a recycler certificate |
| POST | `/v2/lots/:id/transfer` | `{ recipient, quantityKg, carbonClass?, recycledEuKg?, recycledOtherKg?, memo? }` | send part or all; the rest stays as a change lot. Recycled share defaults to proportional. |
| POST | `/v2/lots/process` | `{ lotIds: [a, b], outMaterial, yieldPct, quantityKg, carbonClass?, custody? }` | merge two lots under a registered rule |
| POST | `/v2/lots/:id/attest-order` | `{ challenge, minQuantityKg }` | prove the lot covers an order; order size stays hidden |
| POST | `/v2/periods` | `{ plant, period, material }` | open the single plant/period account |
| POST | `/v2/periods/:id/consume` | `{ lotId }` | add a lot to production for that period |
| POST | `/v2/periods/:id/declare` | `{ shareBps? }` | declare the recycled share (default: the maximum provable) |
| GET | `/v2/periods` | — | accounts with totals and `maxDeclarableBps` |
| GET | `/v2/periods/:id/auditor-package` | — | `{ owner, plant, period, material, totalKg, salt }` — give this to the notified body only |

`recipient` is a party id (64 hex). `material`, `origin`, `plant`, `memo` are labels of at most 32 bytes.

## Public (no auth)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v2/public/ledger` | — | contract address, counts, policy version |
| POST | `/v2/public/declaration` | `{ owner, plant, period, material, totalKg?, salt? }` | `{ declared, shareBps, totalCommit, totalMatches? }` — the notified body's check |
| POST | `/v2/public/attestation` | `{ challenge, owner, minQuantityKg }` | `{ attested, policyVersion, fresh }` — the buyer's check |

## Deploy

All 14 verifier keys in one deploy transaction is ~31.5 KB and the node rejects it (`1010: Transaction would exhaust the block limits`). `POST /v2/admin/deploy` therefore deploys with 7 circuits and inserts the other 7 verifier keys with maintenance transactions signed by the contract's maintenance key, which stays in the admin tenant's private state store. On the local devnet this takes about 3 minutes.

## Crash safety

Before proving, a job writes what it expects to change (`pending`) into the tenant file. If the process dies after the transaction lands, the next job for that tenant looks for the expected nullifiers or commitments on chain and adopts the result; if none landed, it drops the expectation. Declaration salts are stored before the proof for the same reason.

## Limits

- One node process per state directory; jobs are sequential per node.
- The sponsor token is a single shared secret; per-node keys, quotas and billing are future work.
- The sponsor's wallet checkpoint can fail to restore (indexer `Internal Server Error` on sync); moving `<state>/v2/sponsor-wallet` aside and resyncing fixes it on the local devnet.
- Tenant secrets are stored unencrypted in the node's state directory — acceptable for a node the company or platform runs itself, not for a shared operator-hosted node.
