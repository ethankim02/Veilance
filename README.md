# Veilance

**A Midnight-based demo for proving supply-chain provenance and policy compliance while protecting transaction details.**

[한국어](README.md) | **English**

Veilance issues and transfers provenance credentials along a mine → refiner → battery manufacturer supply chain. Zero-knowledge proofs demonstrate the conditions a verifier needs to check. Credential contents are encrypted for the recipient, while the contract verifies commitments and policy conditions.

## Features

- **Issue and transfer provenance credentials**: record commitments in a provenance tree and record a nullifier on transfer to prevent reuse.
- **Selective disclosure**: prove different policy conditions for consumers, procurement teams, and regulators.
- **Encrypted inbox**: recipients decrypt credentials with their own keys and store them in a local vault.
- **Company workspaces**: inventory, received/sent records, direct transactions, OEM verification requests, and an operations graph.
- **Proof progress and explorer**: inspect job status, transactions, blocks, and contract state.
- **Korean and English UI**: switch languages in the header.

| Verification profile | Proven conditions |
| --- | --- |
| Consumer | Certified origin |
| Procurement | Certified origin + certified current holder + carbon class at or below the policy threshold |
| Regulator | Procurement conditions + credential has not been consumed |

## Architecture

```text
web/       React + Vite + TypeScript UI, HTTP and mock API adapters
agent/     Party Agent: the HTTP backend the UI connects to (Midnight SDK, shares contract/node_modules)
contract/  Compact contract, witnesses, encryption helpers, and tests
shared/    Company graph scoping and tests
```

This repository includes the web UI, the Party Agent, the contract, and a standalone E2E script. The UI runs directly in mock mode; to connect it to a real chain, run `agent/` against a local devnet (or Preprod) and point the UI at it. Contract scenarios can run directly through `contract/e2e/`.

## Quick start: mock UI

Use Node.js 22 and npm for the commands below. Mock mode runs without Docker, wallets, or a Compact compiler.

```bash
git clone https://github.com/lejuho/Veilance.git
cd Veilance/web
npm ci
VITE_MOCK=1 npm run dev
```

Open `http://localhost:5173`. Mock data persists in browser `localStorage`; this mode creates no actual chain transactions or zero-knowledge proofs. Mock mode is also the default when `VITE_API_URL` is unset.

## Connect to a local Midnight chain

### 1. Prerequisites

The repository uses Compact compiler `0.31.1`, Compact Runtime `0.16.0`, and Midnight.js `4.1.1`. Its local network configuration targets node `0.22.5`, Indexer `4.2.1`, and proof server `8.1.0`.

Install Docker and the Compact CLI separately, and prepare a local devnet with those versions. A Docker Compose file is not included in this repository. See the [E2E guide](contract/e2e/README.md) for the existing environment's startup example and version notes.

### 2. Install and run the contract

Run from the repository root:

```bash
cd contract
npm ci
npm run compile:zk
npm run e2e:dry-run
# Run the full scenario with the local devnet running
npm run e2e
```

`compile:zk` generates proving keys needed for actual chain execution. `e2e:dry-run` checks keys and provider setup without network calls. `e2e` runs admin initialization → mine issuance → refiner transfer → battery manufacturer attestations → double-use rejection against the real chain.

### 3. Run the Party Agent and connect the UI

`agent/` holds the four demo parties' keys and wallets in one process and calls the contract on their behalf. `agent/node_modules` is a symlink to `contract/node_modules` (this avoids a second copy of the WASM runtime, so `agent` has no independent install step) — create it once after the contract is installed and `compile:zk` has produced the proving keys.

```bash
ln -s "$(pwd)/contract/node_modules" agent/node_modules   # once
cd agent
npm run dev                # http://localhost:4000, watch /health (ready:false -> true)
curl -X POST http://localhost:4000/deploy            # deploy the contract (or reconnect to an existing one)
curl -X POST http://localhost:4000/admin/bootstrap   # register the demo policy: origin, 3 supplier certs, threshold, 4 inbox keys
```

```bash
cd web
VITE_MOCK=0 VITE_API_URL=http://localhost:4000 npm run dev
```

Network selection uses the same `VEILANCE_*` variables as the E2E script. See the [agent guide](agent/README.md) and [API](agent/API.md) for connecting to Preprod and detailed run/verification transcripts.

The required interface is defined in the [API client](web/src/api/client.ts) and [HTTP adapter](web/src/api/http.ts).

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `VITE_API_URL` | Unset selects mock mode; set to the Agent URL for a real connection |
| `PORT` | Agent only. HTTP port, default 4000 |
| `CORS_ORIGIN` | Agent only. Comma-separated allowed origins, defaults to the local web UI |
| `VITE_MOCK` | `1` or `true` forces mock mode |
| `VEILANCE_NETWORK_ID` | Default `undeployed` |
| `VEILANCE_NODE_URL` / `VEILANCE_NODE_WS_URL` | Default `http://localhost:9944` / `ws://localhost:9944` |
| `VEILANCE_INDEXER_HTTP_URL` | Default `http://localhost:8088/api/v4/graphql` |
| `VEILANCE_INDEXER_WS_URL` | Default `ws://localhost:8088/api/v4/graphql/ws` |
| `VEILANCE_PROOF_SERVER_URL` | Default `http://localhost:6300` |

See the [E2E configuration](contract/e2e/lib/config.ts) for additional network and funding options, and the [web guide](web/README.md) for explorer settings.

## Development and verification

Run these commands from the repository root:

```bash
(cd contract && npm test && npm run typecheck)
(cd web && npm run build)
(cd agent && npm run typecheck)
node --import ./contract/node_modules/tsx/dist/loader.mjs shared/graphScope.test.ts

# Check proving keys and provider setup without network calls
(cd contract && npm run compile:zk && npm run e2e:dry-run)

# Exercise the full scenario and double-use rejection against a running devnet
(cd contract && npm run e2e)
```

`npm test` first compiles with `--skip-zk`. Run `compile:zk` before actual chain execution to ensure the proving keys are available.

## Demo scope and public information

The workspace selector changes the demo's presentation scope and does not implement login or access control. The E2E script also manages demo parties' keys in one process. Separate company deployments require authentication, authorization, and isolated party key storage.

The public ledger contains commitments, nullifiers, policies, attestations, and encrypted inbox entries. In particular, the nullifier disclosed by a Regulator attestation can be linked to a later transaction that consumes the same credential. Quantity conservation and verification of real-world origin data are outside the current demo's guarantees.

## Documentation

- [Web guide](web/README.md)
- [Agent guide](agent/README.md) · [Agent API](agent/API.md)
- [E2E guide](contract/e2e/README.md)
- [Contract source](contract/src/veilance.compact)
- [Company graph scoping](shared/graphScope.ts)

Component documents also contain historical designs. Use each package's `package.json` and source code as the reference for commands and dependencies.
