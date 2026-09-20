# Veilance — browser wallet connection (Lace / DApp Connector)

How the delegated wallet works, what was verified about the DApp Connector
API and where, how to test with the dev wallet, and how to test with real
Lace against Preprod. See also `agent/API.md`'s "Delegated wallet (v1.4
addendum)" section for the HTTP contract itself.

## 1. What moves to the browser, what stays in the agent

Nothing about proving changes. The agent still:

- holds every party's `partySecret`, X25519 inbox keypair, held credentials,
  and job history (`agent/.state/<party>/agent.json`);
- runs the witness code (`contract/src/witnesses.ts`) and builds the
  circuit's private inputs;
- calls the local proof server and produces the ZK proof.

Only **fee balancing and submission** — the two steps that touch NIGHT/DUST,
never a witness value — move to a connected browser wallet, and only for
whichever party's organisation chooses to connect one. Every other party
keeps using the agent's own headless wallet exactly as before; nothing about
the non-delegated path in `contract/e2e/lib/wallet.ts` changed except that
its `balanceTx`/submission logic was extracted into a reusable function
(`balanceUnboundTransaction`) so the agent's dev-wallet endpoint could call
the identical code instead of a fork of it.

```
Job's circuit call (e.g. issueProvenance)
  │
  ├─ witness + proof (agent, unchanged) ──────────────► UnboundTransaction
  │                                                       (proven, unbalanced)
  │
  ├─ no wallet connected for this party?
  │     └─ balanceTx → agent's own headless wallet (unchanged)
  │
  └─ wallet connected for this party?
        └─ balanceTx → parks {txHex} on the job, stage="awaiting_wallet"
              │
              ▼ (browser polls GET /jobs/:id, sees walletRequest)
        connectedApi.balanceUnsealedTransaction(txHex)
              │
              ▼ (browser posts { balancedTxHex } back)
        POST /jobs/:id/wallet-result
              │
              ▼
        agent deserializes → FinalizedTransaction
              │
              ▼
        agent submits it itself, through its own node connection
              (see §3 for why — not the browser)
```

## 2. Verified DApp Connector API facts (v4.0.1) — and where they came from

The task brief flagged prior research as unreliable and asked for every name
and encoding to be re-verified. Everything below was checked against the
actual published package, not memory:

```
npm pack @midnight-ntwrk/dapp-connector-api@4.0.1
```
extracted and read directly (`dist/api.d.ts`, `dist/globals.d.ts`,
`dist/errors.d.ts`, `dist/index.mjs`) — `4.0.1` is the version the support
matrix names, and it is a plain TypeScript-types-plus-one-const-object
package (`ErrorCodes`), zero runtime dependencies, no WASM.

| Fact | Verified how |
|---|---|
| `window.midnight[<id>]: InitialAPI` with `{ rdns, name, icon, apiVersion, connect(networkId): Promise<ConnectedAPI> }` | `globals.d.ts` + `api.d.ts` |
| `ConnectedAPI = WalletConnectedAPI & HintUsage` | `api.d.ts` |
| `connect(networkId)`'s `networkId` is a **hint**, not enforced — doc comment literally says "hinting desired network id" | `api.d.ts` doc comment on `InitialAPI.connect`; **not** independently confirmed against a real wallet (no Lace install in this sandbox) — this is why `connectWallet()` (`web/src/lib/dappConnector.ts`) always re-checks `getConfiguration().networkId` after connecting instead of trusting the hint |
| `getShieldedAddresses(): Promise<{ shieldedAddress, shieldedCoinPublicKey, shieldedEncryptionPublicKey }>`, all **Bech32m** | `api.d.ts` |
| `getUnshieldedAddress(): Promise<{ unshieldedAddress }>`, Bech32m | `api.d.ts` |
| `getDustAddress()`, `getDustBalance()`, `getShieldedBalances()`, `getUnshieldedBalances()`, `getTxHistory()` exist but are unused by this feature (no shielded coin movement, no balance display in TopBar) | `api.d.ts` |
| `balanceUnsealedTransaction(tx: string, options?: { payFees? }): Promise<{ tx: string }>` — input `Transaction<SignatureEnabled, Proof, PreBinding>`, doc comment says the output is "ready for submission" | `api.d.ts` |
| `balanceSealedTransaction(tx, options?)` — input/output both `Transaction<SignatureEnabled, Proof, Binding>`; **not used** by this feature (see §3 — the agent's tx is unbound, not sealed, when handed to the wallet) | `api.d.ts` |
| `submitTransaction(tx: string): Promise<void>` — **returns nothing**, not even a transaction id | `api.d.ts`; this is the fact that drove the "agent always submits" design decision, see §3 |
| `signData`, `getProvingProvider` exist on the interface | `api.d.ts`; task brief states Lace does not implement either — not independently re-verified here (no Lace install), and this feature does not call either |
| `getConfiguration(): Promise<{ indexerUri, indexerWsUri, proverServerUri?, substrateNodeUri, networkId }>` | `api.d.ts` |
| Error shape: `{ type: 'DAppConnectorAPIError', code, reason }`, `ErrorCodes = { InternalError, Rejected, InvalidRequest, PermissionRejected, Disconnected }` | `errors.d.ts` — not specifically branched on in this implementation (errors are shown as their `.message`), noted for a future refinement |

### The `midnight-js` side of the same boundary

Verified by reading the installed packages directly (`contract/node_modules/@midnight-ntwrk/...`, same pinned versions as the rest of this project — `midnight-js-types` 4.1.1, `ledger-v8` 8.1.0):

- `WalletProvider.balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction>` and `MidnightProvider.submitTx(tx: FinalizedTransaction): Promise<TransactionId>` (`midnight-js-types/dist/{wallet-provider,midnight-provider}.d.ts`).
- `UnboundTransaction = Transaction<SignatureEnabled, Proof, PreBinding>` (`midnight-js-types/dist/proof-provider.d.ts`) — **exactly** the type the DApp Connector's `balanceUnsealedTransaction` expects. This is the load-bearing fact that makes the whole design work: the proven-but-unbalanced transaction `balanceTx` receives from midnight-js-contracts is *already* the right shape to hand a wallet's `balanceUnsealedTransaction`, no conversion needed beyond `tx.serialize()` → hex.
- `FinalizedTransaction = Transaction<SignatureEnabled, Proof, Binding>` (`ledger-v8/ledger-v8.d.ts`) — matches what `balanceUnsealedTransaction`'s result decodes to (per its doc comment, see table above) and what `submitTx` expects.
- `Transaction.deserialize<S, P, B>(markerS: S['instance'], markerP: P['instance'], markerB: B['instance'], raw): Transaction<S, P, B>` — the marker arguments are **literal strings** (`'signature'`, `'proof'`, `'binding'`), not runtime property access on a class instance; confirmed both from the `.d.ts` signature and from this exact calling convention already being used elsewhere in this codebase, unmodified, for `Intent.deserialize` (`contract/e2e/lib/wallet.ts`'s `signTransactionIntents`).
- `getCoinPublicKey()`/`getEncryptionPublicKey()` are called **during unproven transaction construction** (`createUnprovenCallTxFromInitialStates` / `createUnprovenDeployTxFromVerifierKeys`), not at balancing time — confirmed by grepping `@midnight-ntwrk/midnight-js-contracts`'s built `dist/index.mjs` for both call sites. **Consequence**: a wallet must be connected (`POST /wallet/session`) *before* a job for that party is started, not merely before it reaches `awaiting_wallet` — `delegatedWalletProvider.getCoinPublicKey()` is read synchronously at job-start time, long before `balanceTx` is ever called. Veilance's circuits never move a shielded coin, but midnight-js-contracts embeds these keys into every call/deploy transaction it builds regardless (their use for a coin-less circuit was not traced further than confirming the call sites exist — see §5's open risks).
- `wallet-sdk-facade`'s `submitTransaction(tx: ledger.FinalizedTransaction): Promise<TransactionIdentifier>` takes a plain `FinalizedTransaction` object, no wrapper — confirmed in `wallet-sdk-facade/dist/index.d.ts`. This is what lets `delegatedWallet.ts`'s `submitTx` reuse the agent's *own* wallet's submission path even for a transaction that wallet never balanced or signed (see §3, and the open risk in §5 about whether the node itself accepts this).
- `ShieldedCoinPublicKey`/`ShieldedEncryptionPublicKey`/`UnshieldedAddress` (`wallet-sdk-address-format`) each have a static `.codec: Bech32mCodec<T>` with `.decode(networkId, MidnightBech32m.parse(str))` and the instances have `.toHexString()` — confirmed in `wallet-sdk-address-format/dist/index.d.ts`, and exercised for real (§4) against locally-generated Bech32m fixtures.

## 3. Design decisions this drove, and why

**The agent always submits, never the browser.** `submitTransaction` returns
`Promise<void>` — no transaction id, nothing to put in `Job.txHash`. Rather
than have the browser separately try to derive an id (or have the UI show a
job that "confirmed" with no linkable hash), the browser only ever calls
`balanceUnsealedTransaction` and posts the balanced hex back; the agent
deserializes it into a `FinalizedTransaction` and submits it itself, through
`delegatedWallet.ts`'s `submitTx`, which — for every party, delegated or
not — is always the SAME fallback (the agent's own headless wallet's
`submitTx`). This is explicitly one of the two options the task brief
pre-authorized ("or — if the connector returns the balanced tx rather than
submitting — the agent submits it through its existing node client"); it was
chosen because the alternative (browser submits) cannot fill in `job.txHash`
at all with the verified API surface.

**`balanceUnsealedTransaction`, not `balanceSealedTransaction`.** The tx
`balanceTx` receives from midnight-js-contracts is `PreBinding` (unbound),
matching `balanceUnsealedTransaction`'s documented input exactly — no
conversion needed. `balanceSealedTransaction` is for a transaction the DApp
has *already* had sealed some other way; not this flow's shape.

**Session identity fields are Bech32m, not hex, despite their plain names.**
`POST /wallet/session`'s `coinPublicKey`/`encryptionPublicKey`/
`unshieldedAddress` carry the connector's native Bech32m strings, decoded by
the agent. This was a deliberate choice, not one the API forced: decoding
Bech32m needs `@midnight-ntwrk/wallet-sdk-address-format`, which itself
depends on `@midnight-ntwrk/ledger-v8` (confirmed via that package's own
`package.json`) — a WASM package. Pulling that into `web/`'s bundle (which
currently has **zero** `@midnight-ntwrk/*` dependencies) would mean adding
`vite-plugin-wasm`, `vite-plugin-top-level-await`, and node polyfills to a
project that has so far kept the browser side of Veilance entirely free of
wallet/crypto code — "UI has no wallet, keys, or private state" is a design
principle already stated in `CODEBASE_MAP.md` §3.1. The agent already
depends on both packages, so it decodes; `web/` only relays strings it never
interprets. Confirmed with a real build: `web/package.json` gained exactly
one dependency (`@midnight-ntwrk/dapp-connector-api`, itself zero-runtime-
dependency and WASM-free — checked via `npm pack` + inspecting its
`dist/index.mjs`), and `npm run build`'s output bundle is unchanged in
character (no new WASM/large chunks — see §4).

**`GET /wallet/dev-identity/:party` exists so the dev wallet needs no
separate encoding.** It returns the same Bech32m shape `POST /wallet/session`
expects, computed from the party's real headless wallet
(`ShieldedCoinPublicKey.codec.encode`/etc — the inverse of the decode above)
— so `devWallet.ts` never needs to know or care that hex exists.

## 4. What was verified end to end, and how

No local devnet or proof server was available in this environment (per the
task's constraints — Docker/devnet stopped, only a proof server container on
`:6300` with nothing to talk to it, and three real agent processes already
running against Preprod on `:4001`–`:4003` that were left untouched
throughout). Verification was therefore split into what a live devnet would
normally cover and what was actually exercised:

| Layer | Exercised how | Result |
|---|---|---|
| `agent`, `contract` TypeScript | `npx tsc --noEmit` in both packages | 0 errors in both (pre-existing baseline was already 0 once `contract/src/managed` — the ZK build — was present; this environment already had it) |
| `web` TypeScript + production build | `npm run build` (`tsc --noEmit && vite build`) | 0 errors, 111 modules, no WASM/plugin additions needed — bundle stayed a normal ~300 kB JS chunk, confirming §3's dependency claim |
| `walletRequests.ts`'s park/resolve/timeout logic | `agent/src/walletRequests.test.ts`, plain `node:assert` + `tsx`, wired into `npm test` (`agent/package.json`) | 6/6 assertions pass: resolve success, resolve with error (rejects the promise with that message), unknown id is a no-op, double-resolve is a no-op, **timeout genuinely fires and rejects with "wallet did not respond"** (found and fixed a real bug here — see §6), concurrent requests stay independent |
| `shared/graphScope.test.ts` | Was written but wired into no npm script anywhere in the repo (confirmed by grep before starting); now `agent`'s `npm test` runs it too (`test:shared`) | Passes (5 assertions, pre-existing test, unmodified) |
| A throwaway agent process, isolated from Preprod | `PORT=4010 AGENT_STATE_DIR=<scratch dir> VEILANCE_DEV_WALLET=1 npx tsx src/index.ts` (the `AGENT_STATE_DIR` env override added in `agent/src/config.ts` for exactly this) — devnet unreachable, so it sat at `ready:false, step:"waiting for devnet health"` indefinitely, same as documented boot behavior | `GET /health` responded immediately with `networkId:"undeployed"` present. `POST /wallet/session` correctly decoded real (offline-generated) Bech32m fixtures to the exact original hex bytes, rejected an unhosted party (409), rejected a network mismatch (409), rejected garbage Bech32m (400, clean error, no crash). `GET`/`DELETE /wallet/session` round-tripped correctly. `POST /jobs/:id/wallet-result` 404'd cleanly for an unknown job. `POST /wallet/dev-balance-submit` and `GET /wallet/dev-identity/:party` both failed with a clean, expected `"unknown or not-yet-built party"` error (they need a fully-booted party, which needs a live devnet) — not a crash. Process was killed afterward; confirmed the three real `:4001`–`:4003` processes were unaffected throughout (`GET /health` on all three still responded, still mid-sync, before and after) |
| The full delegated-provider round trip (agent side, no real proving) | `agent/src/cli/simulate-delegated-wallet.ts` — a plain node script, no Playwright, run against the throwaway `AGENT_STATE_DIR` above. Drives a **real** `Job` through jobs.ts's **real** `enqueueJob`/`drain()` queue, with a **real** `createDelegatedWalletProvider`/wallet session, and only stubs the one thing that cannot exist without a live proof server: the `UnboundTransaction` object itself (only its `.serialize()` is faked) | All 4 cases pass: (1) no session connected → falls straight through to the fallback (agent's own wallet) provider, verified via both getter methods and a rejected `balanceTx`; (2a) a connected session → the job genuinely reaches `stage: "awaiting_wallet"` with `walletRequest.txHex` exactly equal to the (hex-encoded) bytes the stub `UnboundTransaction.serialize()` produced; (2b) `resolveJobWalletRequest` (what `POST /jobs/:id/wallet-result`'s handler calls) is accepted; (2c) the job then finishes `stage: "failed"` with a **real** ledger deserialize error (`"Unable to deserialize Transaction. Error: expected header tag..."`), not the 5-minute-timeout error — proving the whole round trip up to that exact boundary works, and that boundary genuinely cannot be crossed without a real proof server (a `Proof`-typed transaction cannot be constructed offline; there is no way to fake "real enough" bytes) |
| Real Lace against Preprod | **Not exercised** — no Lace install / browser available in this sandbox. See §5 below for exactly what remains unverified as a result |
| The dev wallet's browser-side code (`web/src/lib/devWallet.ts`, `dappConnector.ts`, `wallet.ts`, `WalletConnect.tsx`, `JobRing.tsx`'s handoff) | Typechecked and built as part of `web`'s production build; **not** run in an actual browser (no Playwright per the task's ask, and a full click-through needs a live agent behind a deployed contract, which needs the devnet this sandbox doesn't have) | Compiles and builds; the actual click path (open popover → pick wallet → pick party → connect → see `awaiting_wallet` → approve → see `confirmed`) was not clicked through |

## 5. Deviations from the brief's design, and why

1. **Field names vs. encoding** (§3) — `POST /wallet/session`'s three key
   fields carry Bech32m, not hex, despite hex-matching names. Not forced by
   the verified API (the agent *could* have required hex and pushed the
   decode into the browser) — a deliberate trade against adding WASM
   dependencies to `web/` for a feature whose own stated principle is that
   the UI holds no keys.
2. **`agent/API.md` addendum version** — the brief asked for "a v1.2
   addendum"; `agent/API.md` already has a v1.2 (per-company agents) and a
   v1.3 (independent verification, evidence fields) from prior work. This
   is written as v1.4.
3. **No shared wallet-connection state across parties in one tab** — "the
   user picks which organisation it pays for (single select)" was read as:
   one connected wallet delegates for exactly one party at a time per
   browser tab, matching the phrase's "single select." Switching which
   party a connected wallet pays for means disconnecting and reconnecting
   with a different selection (not building a multi-party session list UI).
4. **Dev wallet's identity is one party at a time, chosen by the same popover
   selection used for a real wallet** — the DApp Connector's `connect()` has
   no notion of "party"; the fake wallet's underlying identity has to come
   from *some* real headless agent wallet, so `web/src/lib/wallet.ts`'s
   `connect()` special-cases the dev wallet's id to call
   `setDevWalletParty()` right before connecting. This is the one place the
   web code is aware `veilanceDev` isn't a generic wallet.

## 6. Test results (summary)

- `contract` typecheck: **0 errors**.
- `agent` typecheck: **0 errors**.
- `web` typecheck + production build: **0 errors**, build succeeds.
- `agent`'s new `npm test` (wired for the first time — previously no
  package in this repo ran either suite from a script):
  `walletRequests.test.ts` **6/6 pass**, `shared/graphScope.test.ts`
  **passes** (now wired in, was previously unwired anywhere).
- `simulate-delegated-wallet.ts`: **4/4 cases pass** (see §4 table).
- Manual HTTP verification against a throwaway, isolated agent instance:
  **all checked endpoints behaved as designed** (see §4 table); the three
  real Preprod-connected agent processes on `:4001`–`:4003` were confirmed
  unaffected before and after.
- **Bug found and fixed during testing**: `walletRequests.ts`'s pending-
  request timer was originally `timer.unref()`'d ("so a parked wallet
  request never keeps the process alive"). In the standalone test script
  this meant the timeout case's `setTimeout` was the *only* thing left for
  Node's event loop to wait on — an unref'd timer doesn't count, so the
  process exited immediately (exit code 0, no output) instead of waiting
  for the 30 ms test timeout to fire. The timer is now left ref'd (the
  default): the real agent is a long-lived HTTP server with its own ref'd
  handles regardless, so this never needed to be unref'd in production —
  it was a pure footgun for anything shorter-lived. See the comment left in
  `walletRequests.ts` at the fix site.

## 7. Open risks

1. **Whether Lace specifically implements `balanceUnsealedTransaction`,
   `getShieldedAddresses`, `getUnshieldedAddress`, `getConfiguration` (the
   four calls this feature actually uses) was not independently
   re-verified against a real Lace build in this session** — no Lace
   install or browser available. The task brief's own prior research says
   Lace implements all four and specifically does *not* implement
   `signData`/`getProvingProvider` (neither of which this feature calls
   anyway). Trusted here, not re-confirmed.
2. **Whether a wallet accepts a transaction proven elsewhere is unverified.**
   The whole design assumes a wallet's `balanceUnsealedTransaction` will
   balance a `Transaction<SignatureEnabled, Proof, PreBinding>` it did not
   itself construct or prove — verified only at the type level (the input
   type matches exactly what the agent hands it), not by actually running a
   real wallet against a real agent-produced proof.
3. **Whether the node accepts a transaction submitted through a *different*
   wallet's `submitTransaction` than the one that balanced/signed/bound it
   is unverified.** `delegatedWallet.ts`'s `submitTx` always calls the
   agent's own fallback wallet's `submitTx` — for the delegated path, that
   is a *different* wallet (an agent-held one) than the browser wallet that
   actually balanced and signed the transaction. This is architecturally
   sound (submission is just relaying already-valid bytes to the node's
   transaction pool — nothing about node-level acceptance should care which
   local object called `submitTransaction`), and it's the option the task
   brief pre-authorized, but it was never run against a real node.
4. **ledger-v8 8.1.0 vs. the wallet's own tx format.** The simulation script
   (§4) surfaced the deserializer's own expected header tag as
   `midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1])` —
   an internal wire-format version number that does not match the npm
   package's `8.1.0`/"ledger-v8" naming. This is very likely just internal
   wire-format versioning unrelated to the package's semver (nothing in
   this codebase's existing, working, devnet-verified transaction flow
   suggested otherwise), but it was not specifically investigated further,
   and it is the concrete manifestation of the task's own named risk
   ("tx serialization format compatibility between ledger-v8 8.1.0 and the
   wallet") — a real Lace wallet's `balanceUnsealedTransaction` is the only
   way to confirm it decodes a `txHex` this agent produces without error.
5. **`getCoinPublicKey`/`getEncryptionPublicKey`'s exact purpose for a
   coin-less circuit was traced to two call sites in
   `midnight-js-contracts`'s built output, not to their deeper semantic use**
   (§2's table) — confirmed they're read at unproven-tx-construction time,
   not confirmed in detail what specifically consumes them downstream for a
   contract that never calls a zswap primitive.
6. **The full browser click path was never driven end to end** — build and
   typecheck only, no Playwright run and no manual browser session (both
   ruled out by the constraints — no devnet to deploy against, and
   Playwright was explicitly excluded from the CLI verification script).

## 8. How to test

### With the dev wallet (no Lace needed)

Requires a working local devnet + proof server (`docker compose -f
~/.midnight-expert/devnet/devnet.yml up -d`, `compact compile
+0.31.1 src/veilance.compact src/managed/veilance` if `contract/src/managed`
is missing) — this exercises real proving, unlike §4's offline checks.

```bash
# 1. Agent, with the dev wallet endpoints enabled:
cd agent && VEILANCE_DEV_WALLET=1 npm run dev

# 2. Web, pointed at that agent, with the fake wallet installed:
cd web && VITE_API_URL=http://localhost:4000 VITE_DEV_WALLET=1 npm run dev

# 3. In the browser: open the "Connect wallet" control in the TopBar, pick
#    "Veilance Dev Wallet", pick which organisation it pays for, connect.
#    Start an Issue/Transfer/Attest job for that organisation — its ring
#    should show "Approve in wallet" (briefly — the dev wallet completes the
#    round trip automatically, unlike a real wallet's approval prompt) and
#    then proceed to Confirmed exactly like the non-delegated path.
```

### With real Lace, on Preprod

- Lace's network setting → **Preprod**.
- A local proof server on `:6300` is still required even against Preprod —
  node/indexer are Preprod's public endpoints, but proving always happens
  locally (unchanged by this feature; see `CODEBASE_MAP.md` §3.1 and
  `agent/.env.preprod`'s existing setup).
- The Lace wallet needs both **tNIGHT** (to pay fees) and **DUST**
  registered/generated for the connecting account — the same requirement
  the agent's own headless wallets already have (`contract/e2e/lib/wallet.ts`'s
  `ensureDust`); a wallet with NIGHT but no DUST will fail balancing the
  same way an agent-only party would.
- Start the agent against Preprod as usual (`set -a && . ./.env.preprod &&
  set +a && npm start`) — **do not** point a test run at the real
  `agent/.state/preprod` from another verification in progress; use a
  separate checkout or `AGENT_STATE_DIR` override.
- In the web UI, connect Lace, pick a party, and drive a real job. Given
  §7's open risks, the first real signal to watch for is whether
  `balanceUnsealedTransaction` accepts the agent's `txHex` at all.

## 8. Wallet-less agent mode (`VEILANCE_AGENT_WALLET=0`)

The agent owns no wallet: no seed is read, nothing is synced, no checkpoint is
written or restored. Boot is seconds on any network. Every job needs a wallet
session for its party; without one the job fails immediately with
`no wallet connected for "<party>"`.

| Step | Where it runs | Agent wallet needed? |
|---|---|---|
| Build the call, run the circuit locally with witness secrets | agent | no |
| Coin / encryption public keys placed in the unproven tx | connected wallet's keys (sent at `POST /wallet/session`) | no — but a wallet must be connected BEFORE the job starts |
| ZK proof | agent → local proof server | no |
| Fee balancing (DUST), signing, binding | connected wallet (`balanceUnsealedTransaction`) | no |
| Submit to node, wait for finality | agent, `makeDefaultSubmissionService({ relayURL })` from `wallet-sdk-capabilities/submission` | no |
| Read tx data / ledger from the indexer | agent | no |
| `/parties` balances and address | — | returned as `null` in this mode |

Verified on the local devnet (2026-09-21) with `src/cli/external-wallet.ts`, a
separate process holding its own headless wallet that plays the browser wallet's
role over the same HTTP round trip:

1. no session → `issueProvenance` failed in 0.3 s with the explicit error;
2. session for `mine` → `issueProvenance` confirmed (block 11717, 33.7 s; wallet side 1.5 s); ledger leaves 12 → 13, inbox 12 → 13;
3. agent killed and restarted (6 s boot, no `wallets/` directory, sessions empty), new external wallet for `refiner`, inbox scan found the lot, `transferProvenance` confirmed (block 11734, 42.9 s); nullifiers 5 → 6, leaves 13 → 14.

Against Preprod the wallet-less agent boots in 18 s and reads the deployed
contract `aef19243…2348`. **NOT verified: a real transaction with Lace on
Preprod** (Lace was still syncing). Open points for that test: whether Lace
accepts a transaction proven elsewhere, and whether the node accepts a
Lace-balanced transaction relayed by the agent.

The dev wallet (`VEILANCE_DEV_WALLET=1`) needs an agent wallet and is refused
in this mode. The local devnet default (`VEILANCE_AGENT_WALLET=1`) is unchanged.
