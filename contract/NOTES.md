# Veilance contract — implementation notes

Honest record of what was built, where the design spec had to bend to Compact
reality, and exactly what was run.

---

## 1. Toolchain

Upgraded before writing any code, via the `midnight-tooling:compact-cli` skill.

```
$ compact --version                    # Compact CLI (the management tool)
compact 0.5.1

$ compact check
compact: x86_64-unknown-linux-musl -- Update Available -- 0.31.0
compact: Latest version available: 0.34.0.

$ compact update
compact: x86_64-unknown-linux-musl -- 0.34.0 -- installed
compact: x86_64-unknown-linux-musl -- 0.34.0 -- default.
```

Everything in this directory is written against, and compiled with:

| Component | Version |
|---|---|
| Compact CLI | `0.5.1` |
| **Compact compiler** | **`0.34.0`** (was `0.31.0`) |
| **Compact language version** | **`0.26.0`** (was `0.23.0`) — the contract's pragma is `>= 0.26` |
| Ledger | `ledger-9.1.0.0-rc.3` |
| `@midnight-ntwrk/compact-runtime` | `0.19.0` (the version the 0.34.0 compiler targets) |
| Node | `v24.14.1` |

No `.npmrc`, registry override, or private-registry configuration was added.
`@midnight-ntwrk/compact-runtime@0.19.0` resolves from the public npm registry.

**Superseded** — see §9. This table records what was true when this section
was first written. The project has since moved to Compact compiler `0.31.1` /
language version `0.23` / `compact-runtime 0.16.0`, to match the stable
generation the official support matrix and this project's devnet actually
use. §9 records why and exactly what changed.

---

## 2. Layout

```
contract/
├── package.json          npm install / npm run compile / npm test
├── tsconfig.json
├── vitest.config.ts
├── NOTES.md              this file
├── src/
│   ├── veilance.compact  the contract
│   ├── witnesses.ts      witness implementations + VeilancePrivateState
│   └── managed/veilance/ compiler output (gitignored)
└── test/
    ├── network.ts        multi-party simulator over @midnight-ntwrk/compact-runtime
    └── demo.test.ts      the 4-step demo + attack + negative cases
```

---

## 3. Where the design spec had to change, and why

### D-1. `assert()` is not a disclosure boundary in compiler 0.34.0 — 7 `disclose()` calls removed

The spec asks for `disclose()` "only where genuinely needed". The first draft
wrapped every witness-derived boolean fed to an `assert` in `disclose(...)`
(the `disclose(x == y)` idiom in the skills). I then mechanically tested every
one of the 24 `disclose()` sites by deleting it and recompiling:

```
line  154: required  :: partyIdOf(adminSecret())            # ledger write
line  167: COMPILES-WITHOUT :: partyIdOf(adminSecret()) == adminId
line  177: COMPILES-WITHOUT :: path.leaf == certLeafOf(partyId, certId())
line  182: required  :: merkleTreePathRoot<8, Bytes<32>>(path)   # arg to checkRoot
line  192: COMPILES-WITHOUT :: path.leaf == originId
line  208: COMPILES-WITHOUT :: cred.ownerId == partyIdOf(secret)
line  216: COMPILES-WITHOUT :: path.leaf == commitment
line  342: COMPILES-WITHOUT :: cred.carbonClass <= carbonThreshold
line  354: COMPILES-WITHOUT :: cred.carbonClass <= carbonThreshold
...  (all remaining 15 sites: required)
```

**Reason:** in 0.34.0 a bare `assert` on witness-derived data is not a public
boundary — only ledger operations, exported-circuit returns, and cross-contract
calls are. A conditional (`if`) containing a ledger write still is. All 7
redundant wrappers were removed. This does not change the transcript (`disclose`
is a compile-time annotation), but a spurious `disclose()` on a large expression
is exactly the thing that hides a real leak later.

The 17 remaining `disclose()` sites are: the admin id (constructor ledger
write), 4 Merkle roots passed to `checkRoot`, the two admin allow-list inserts
and the threshold, the challenge (2 uses), the nullifier (3 uses in
`transferProvenance`, 1 in `attestRegulator`), and the commitments (issue: 2,
transfer: 2). Each carries an inline comment saying why.

### D-2. `MerkleTreePath` witnesses take no arguments

The skill's canonical pattern is `witness findItem(item: Field): MerkleTreePath<...>`.
Here the path witnesses (`certPath`, `originPath`, `commitmentPath`) take no
arguments and recompute the leaf on the TypeScript side from private state,
because the leaf is itself derived from private data (`certLeafOf(partyId, certId)`,
`commitmentOf(heldCredential)`). Passing it in as a circuit-level argument would
have made no difference to privacy but would have duplicated the derivation. The
circuit still **binds** the returned path to the expected leaf
(`assert(path.leaf == ...)`) — without that binding a prover could present any
certified party's path.

### D-3. "Not from a restricted source" is an allow-list, not a deny-list

`certifiedOrigins` is a `MerkleTree<8, Bytes<32>>` of *permitted* origins, and
`originNotRestricted` is proven as `originId ∈ certifiedOrigins`. A Merkle
**non**-membership proof (sorted-leaf / sparse-Merkle range proof) is out of
scope for the MVP, as the design spec itself states. Consequence: an origin that
nobody has ever certified is treated identically to a sanctioned one. A real
deny-list would need a sparse Merkle tree with neighbour proofs.

### D-4. `HistoricMerkleTree` was used, and is genuinely needed

`provenanceTree` is `HistoricMerkleTree<16, Bytes<32>>`. `MerkleTree.checkRoot`
accepts only the *current* root, so a path generated before another party's
insert lands would stop verifying. `transferProvenance` also inserts into the
same tree it just proved against, so the historic variant is what makes proofs
survive concurrent activity. The witness implementation always builds paths
against the *current* tree, so in practice the current root is what is disclosed
(see S-6).

### D-5. The Battery Manufacturer must also be certified — demo script amended

The written demo has the admin certify only the Mine and the Refiner, and then
has the Battery Manufacturer call `attestProcurement` and `attestRegulator`.
Those two circuits require `owner certLeaf ∈ certifiedSuppliers`, so as written
the demo cannot pass. `bootstrap()` in the test therefore also runs
`certifySupplier(batteryMfrId, certC)`. This is a fix to the demo script, not a
weakening of the contract.

### D-6. `carbonClass` is packed into the commitment via `Field`

`Uint<8>` is cast `(c.carbonClass as Field) as Bytes<32>` so the commitment is a
`persistentHash` over a uniform `Vector<6, Bytes<32>>`. Both cast steps are
accepted by 0.34.0; the intermediate `Field` is not strictly required but is
kept for readability.

### D-7. `VerifierProfile` is an enum, stored as `Uint<8>`

The ledger type stays `Map<Bytes<32>, Uint<8>>` as specified (codes 1/2/3), but
the contract writes `VerifierProfile.consumer as Uint<8>` etc. so the codes are
named in exactly one place. `VerifierProfile.none = 0` exists only to make 1/2/3
line up with the spec's codes.

### D-8. Added beyond the spec: carbon class may not decrease across a transfer

`transferProvenance` asserts `newClass >= cred.carbonClass`. See finding **S-2**
below for the reasoning. This is one extra `assert`; delete it for strict
`landing.md` fidelity.

### D-9. Not implemented (ERD entities deliberately out of MVP scope)

`LEDGER_REVOCATION` (certificate / commitment revocation), `QUANTITY_ALLOCATION`
(confidential quantity conservation, `landing.md` §7), and pinning each
commitment to the `policyVersion` it was issued under. Origin and supplier
membership are instead re-checked against the *current* allow-lists on every
transfer and every attestation, which covers most of what policy-version pinning
would give.

---

## 4. Privacy / security audit (`midnight-security` checklist)

Run against the finished contract. Severity is my own judgement.

### What an on-chain observer actually sees

| Circuit | Public transcript |
|---|---|
| `certifyOrigin(originId)` | that the admin acted; the `originId` argument |
| `certifySupplier(partyId, cid)` | that the admin acted; **both arguments** |
| `setCarbonThreshold(t)` | the new threshold |
| `registerEncKey(encPk)` | the caller's partyId and X25519 public key |
| `issueProvenance(entry)` | the new commitment; the two Merkle roots checked; **192 bytes of opaque sealed entry at the next inbox ordinal** |
| `transferProvenance(entry)` | the nullifier, the new commitment, the roots checked; **192 bytes of opaque sealed entry at the next inbox ordinal** |
| `attestConsumer/Procurement(ch)` | the **attestation key** `H("veilance:att", ch, ownerId, profile)`, the profile code, the policy version written, the roots checked. **Not** the raw challenge, and **not** `ownerId` |
| `attestRegulator(ch)` | the above **plus the credential's nullifier** |

Never on chain: `partySecret`, `encSk`, `batchSecret`, `materialType`,
`carbonClass`, `originId` of any credential, the identity of the acting party,
**and the edge from a consumed commitment to the nullifier that consumed it**.
(The credential pre-image now travels on chain, but only inside AEAD ciphertext
under an ephemeral X25519 key — see the v3 change log.) That last one is
the whole product, and it is why `provenanceTree` is a Merkle tree proved by
private path rather than a `Set<Bytes<32>>` with a disclosed membership test.

### Findings

**S-1 — MEDIUM (accepted, spec-mandated). `commitment` is a hash-based
commitment whose hiding rests entirely on `batchSecret`.**
`commitment = persistentHash("veilance:cm", ownerId, originId, materialType,
carbonClass, batchSecret)`. Four of those five fields are drawn from small,
*publicly enumerable* sets: `originId` appears verbatim as a `certifyOrigin`
argument, `partyId` appears verbatim as a `certifySupplier` argument,
`carbonClass` has 256 values, and `materialType` is a short enumeration in
practice. So the commitment is only hiding because `batchSecret` is a nonce.
This is the checklist's "hash without nonce over a small value space" pattern,
saved by the nonce. **`batchSecret` MUST be ≥128 bits of fresh CSPRNG entropy per
credential.** The contract cannot enforce this — it is a witness value.
The demo's readable `batch:1/mine->refiner` fixtures are trivially brute-forcible
and are test fixtures only.
*Alternative not taken:* `persistentCommit<T>(value, rand)` makes the hiding
property structural (and clears witness taint, removing two `disclose()` calls).
It was not used because the design spec pins the exact hash construction. One
`commitmentOf` body is the only thing that would change.

**S-2 — HIGH (fixed). A holder could reset `carbonClass` downwards.**
The spec's witness list for `transferProvenance` includes `newCarbonClass` with
no constraint. Any holder could therefore take a class-9 credential and mint a
class-0 successor carrying the same certified provenance, making
`carbonClass <= carbonThreshold` in `attestProcurement`/`attestRegulator`
meaningless. Fixed with `assert(newClass >= cred.carbonClass, ...)` — carbon can
only get worse down the chain. Covered by
`"carbon class may not be reset downwards across a transfer"`.

**S-3 — HIGH (fixed during review). A witness could answer differently on two
calls.**
The first draft of `transferProvenance` called `newCarbonClass()` twice — once
for the monotonicity check, once for the payload. A witness is untrusted code
and may return a different value each time, so a prover could pass the check
with 9 and commit to 0. Every witness is now bound to a `const` before use
(`newClass`, `newSecret`, `recipient`). Regression test:
`"a witness that changes its answer between calls cannot split check from commit"`
asserts the witness is evaluated exactly once and that the committed class is the
checked one.

**S-4 — MEDIUM. FIXED by rotate-on-attest (CONTRACT_DESIGN.md §9): every
attest circuit now SPENDS the credential whose nullifier it publishes and
re-mints it under a fresh secret, so that nullifier never reappears and the
attestation links to nothing later. Original finding, kept for history:
`attestRegulator` discloses the nullifier of a credential that is *not* being spent.**
`nullifiers` is a public `Set`, and `Set.member(v)` reveals `v`. Proving
"not consumed" therefore necessarily publishes the nullifier. Consequence: a
regulator attestation is **linkable to the later spend of the same credential** —
an observer who saw `attestRegulator` recognises the same nullifier when it is
inserted by a future `transferProvenance`. The linkage is nullifier↔nullifier,
not nullifier↔commitment, so the supplier graph is still not exposed; but the
"this holder attested, then passed it on" edge becomes public. Mitigations for a
later version: prove non-membership against a sparse Merkle nullifier tree
instead of a `Set`, or derive a per-verifier nullifier
`H("nf-att", commitment, secret, challenge)` and keep a separate attestation
nullifier set.

**S-5 — MEDIUM. FIXED by rotate-on-attest (CONTRACT_DESIGN.md §9); now
covered by `"every profile rejects a consumed credential"` and
`"an attestation rotates the credential..."`. Original finding, kept for history:
`attestConsumer` and `attestProcurement` do not check the nullifier set.**
Per the spec only the regulator profile checks consumption, so an already-spent
credential still satisfies the consumer and procurement profiles. This is a real
double-claim surface for those two verifier profiles. Demonstrated by
`"KNOWN LIMITATION: a consumed credential still passes the consumer profile"`,
which also shows `attestRegulator` correctly rejecting the same credential.
Closing it would mean giving those profiles the same nullifier disclosure that
S-4 describes — the spec's split is a deliberate privacy/soundness trade.

**S-6 — LOW. `HistoricMerkleTree.checkRoot` discloses *which* root was used.**
Proving against an older root narrows down when the credential was created. The
witness implementation always uses the current tree, so the current root is what
is disclosed and nothing is leaked; a different witness implementation could leak
timing. Worth a comment in any production wallet.

**S-7 — LOW. Anonymity set = tree contents.** A Merkle membership proof hides
*which* leaf only to the extent that the tree has leaves. In the demo the
provenance tree has 2 leaves, so "one of two". This is inherent, not a bug, but
it means early participants in a real deployment have weak anonymity.

**S-8 — LOW. No revocation, no admin rotation, no capacity check.**
`adminId` is `sealed`, so the admin cannot be rotated and a compromised
`adminSecret` is terminal. `MerkleTree` has no removal, so a certificate cannot
be revoked. `isFull()` is never checked: `certifiedOrigins` and
`certifiedSuppliers` hold 256 leaves each, `provenanceTree` 65 536; inserting
past capacity is a runtime error. All acceptable for an MVP, all needed before
production.

**S-9 — LOW. Calling a circuit reveals intent.** `attestRegulator` being called
tells observers a regulator-grade proof happened. Unavoidable on Midnight —
circuit identity is public.

**S-10 — INFO. `recipientId` is unconstrained.** Nothing proves the recipient
exists, consented, or differs from the sender. A holder can transfer to
themselves (with a fresh `batchSecret`, producing an unlinkable new commitment).
This does not create value out of nothing — the old credential is still nullified
1:1 — but it does let a holder re-anonymise a credential at will. Conservation of
*quantity* (`landing.md` §7) is the future work that would matter here.

### Checklist items that pass cleanly

- **Domain separation:** five distinct separators — `veilance:id`,
  `veilance:cert`, `veilance:cm`, `veilance:nf`, `veilance:att`. Commitment,
  nullifier and attestation key use different domains, so no collision and no
  cross-purpose key reuse. All five derivations live in exactly one
  `pure circuit` each.
- **Persistent, not transient:** every hash that reaches the ledger is
  `persistentHash`; no `transientHash`/`transientCommit` anywhere.
- **Every witness output is validated before use:** `adminSecret` against
  `adminId`; `ownerSecret` against `cred.ownerId`; `certId`+`certPath` against
  `certLeafOf(...)` and `checkRoot`; `originPath` against `cred.originId` and
  `checkRoot`; `heldCredential`/`commitmentPath` against `commitmentOf` and
  `checkRoot`; `newCarbonClass` against monotonicity. The three genuinely free
  witnesses are `recipientId` (S-10), `newBatchSecret` (S-1) and the
  `materialType` inside `issuedMaterial` — all of which the issuer is entitled to
  choose.
- **No sensitive value is passed as a circuit argument.** The only exported
  circuit parameters are `originId`/`partyId`/`cid`/`t` on admin circuits (public
  policy by design) and `challenge` on the attest circuits (chosen by the
  verifier, public by construction). Everything credential-shaped arrives by
  witness.
- **Replay:** each credential has exactly one nullifier, derivable only by the
  owner; each (challenge, holder, profile) triple is single-use
  (`assert(!attestations.member(attestationKeyOf(...)))`). See the v2 change log
  for why the key, and not the raw challenge, is the unit of replay protection.
- **Failed transactions leave no trace:** every rejection path is a plain
  `assert` before or alongside the ledger writes; the tests assert a full
  public-state snapshot is byte-identical after each rejected call.
- **No coin/token operations**, so the guaranteed/fallible partial-success trap
  does not apply here.

---

## 5. Commands run, and their results

All from `/home/user/Veilance/contract`.

```
$ compact check
compact: x86_64-unknown-linux-musl -- Update Available -- 0.31.0
compact: Latest version available: 0.34.0.

$ compact update
compact: x86_64-unknown-linux-musl -- 0.34.0 -- installed
compact: x86_64-unknown-linux-musl -- 0.34.0 -- default.

$ compact compile --version && compact compile --language-version
0.34.0
0.26.0

$ npm install
added 53 packages in 8s

$ compact format src/veilance.compact
(no output — reformatted in place)

$ compact compile --skip-zk src/veilance.compact src/managed/veilance
(no output — success; emits contract/, compiler/, zkir/)

$ npx tsc --noEmit
(no output — clean)

$ npx vitest run --reporter=verbose
 ✓ Veilance demo > deploys with the deployer's pseudonymous id as admin
 ✓ Veilance demo > step 1 — admin registers the supply chain policy
 ✓ Veilance demo > rejects a non-admin trying to change policy
 ✓ Veilance demo > step 2 — the Mine issues a cobalt credential to the Refiner
 ✓ Veilance demo > step 3 — the Refiner transforms it and passes it to the Battery Manufacturer
 ✓ Veilance demo > step 4 — the Battery Manufacturer proves policy to three verifier profiles
 ✓ Veilance demo > rejects a replayed verifier challenge
 ✓ Veilance demo > step 5 — ATTACK: the Refiner replays the already-consumed credential
 ✓ Veilance demo > selective disclosure — procurement fails once the carbon threshold drops below the (private) class
 ✓ Veilance negative cases > an uncertified party cannot issue provenance
 ✓ Veilance negative cases > a certified supplier cannot issue provenance for an uncertified origin
 ✓ Veilance negative cases > a party cannot spend a credential it does not own
 ✓ Veilance negative cases > carbon class may not be reset downwards across a transfer
 ✓ Veilance negative cases > KNOWN LIMITATION: a consumed credential still passes the consumer profile
 ✓ Veilance negative cases > a witness that changes its answer between calls cannot split check from commit
 ✓ Veilance negative cases > a credential that was never issued cannot be transferred

 Test Files  1 passed (1)
      Tests  16 passed (16)
```

Full ZK build (proving/verifying keys actually generated, not just `--skip-zk`):

```
$ compact compile src/veilance.compact <build-dir>
ZK_COMPILE_SECONDS=76.28
exit=0   # 16 files in keys/ — a .prover and a .verifier per exported circuit

$ ls <build-dir>/keys
attestConsumer.prover     attestConsumer.verifier
attestProcurement.prover  attestProcurement.verifier
attestRegulator.prover    attestRegulator.verifier
certifyOrigin.prover      certifyOrigin.verifier
certifySupplier.prover    certifySupplier.verifier
issueProvenance.prover    issueProvenance.verifier
setCarbonThreshold.prover setCarbonThreshold.verifier
transferProvenance.prover transferProvenance.verifier
```

`npm run compile` uses `--skip-zk` (~1 s) because the simulator does not need
proving keys; `npm run compile:zk` does the full ~76 s build.

Proving-key sizes give a rough circuit-cost ranking (each Merkle path proof is
the dominant term):

```
 2.7M  setCarbonThreshold.prover     (admin auth only)
 2.7M  certifyOrigin.prover
 5.0M  certifySupplier.prover
 9.6M  issueProvenance.prover        (2 paths: depth 8 + depth 8)
 9.6M  attestConsumer.prover         (2 paths: depth 16 + depth 8)
 9.6M  attestProcurement.prover
 9.6M  attestRegulator.prover
  19M  transferProvenance.prover     (3 paths: depth 16 + depth 8 + depth 8)
```

Verifier keys are 2119 bytes for every circuit.

### Clean-room check

The whole tree (minus `node_modules` and `src/managed`) was copied to an empty
directory and the documented sequence run from scratch:

```
$ npm install && npm run compile && npm test
added 53 packages
> compact compile --skip-zk src/veilance.compact src/managed/veilance
> vitest run
 ✓ test/demo.test.ts (16 tests) 958ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

### Issues hit along the way

1. **`pathForLeaf(0n, leaf)` throws on an empty tree** —
   `invalid index into sparse merkle tree: 0`. The witness originally fell back
   to `pathForLeaf(0n, leaf)` when `findPathForLeaf` returned `undefined`, which
   turned "credential not in the tree" into a *local crash* instead of a circuit
   rejection. Fixed by synthesising a well-formed all-zero-sibling path
   (`absentPath`), so the failure surfaces as the contract's own
   `"credential is not in the provenance tree"`.
2. **Circuits are `async` in runtime 0.19.0.** `Contract.initialState` and every
   generated circuit return a `Promise`. The older simulator examples in the
   skills call them synchronously; the simulator here `await`s.
3. **Updated state lives at `result.context.callContext.currentQueryContext.state`**
   in this runtime version (a `ChargedState`), not `result.context.currentQueryContext.state`.
4. `Sourcemap ... points to missing source files` warning from vitest — the
   generated `index.js.map` points at the `.compact` source. Cosmetic.

---

## 6. Test coverage

`test/demo.test.ts`, 16 tests, all passing.

**The demo (one ordered scenario on one shared chain):**
1. deploy → `adminId == H("veilance:id", adminSecret)`
2. admin registers policy → `policyVersion == 5`, threshold 5, origin on the
   allow-list, an uncertified origin is not
3. non-admin policy change → rejected, ledger byte-identical
4. Mine `issueProvenance()` → `cA` matches `commitmentOf(credA)`, 1 leaf, 0 nullifiers
5. Refiner `transferProvenance()` → `nA` matches `nullifierOf(cA, refinerSecret)`,
   `cB` matches `commitmentOf(credB)`, `nA` in the nullifier set, `cB` in the tree,
   2 leaves; asserts the nullifier set contains exactly `nA` and that `nA != cA`
6. replayed challenge → rejected, ledger unchanged
7. BatteryMfr `attestConsumer/Procurement/Regulator` → `attestations[ch1]=1`,
   `[ch2]=2`, `[ch3]=3`
8. **ATTACK** — Refiner replays `cA` → rejected with
   `"credential already consumed"`, full public-state snapshot unchanged,
   still 1 nullifier and 2 leaves
9. selective disclosure — threshold dropped to 2, `attestProcurement` rejected
   (`carbonClass` 4 stays private throughout), `attestConsumer` still passes,
   threshold restored and procurement then succeeds

**Negative / security cases (fresh chain each):**
- uncertified party cannot `issueProvenance` → `"supplier is not certified"`
- certified supplier cannot issue for an uncertified origin → `"origin is not certified"`
- a party cannot spend a credential it does not own → `"does not own this credential"`
- carbon class may not be reset downwards (S-2)
- every profile rejects a consumed credential (S-5, fixed by rotate-on-attest)
- an attestation rotates the credential: the old one is dead, the new one still
  transfers, and the attestation and transfer nullifiers differ (S-4)
- a flip-flopping witness cannot split check from commit (S-3)
- a credential that was never issued cannot be transferred →
  `"not in the provenance tree"`

Every rejection test also asserts the full public-state snapshot (admin id,
policy version, threshold, all three Merkle roots, leaf count, nullifier count,
attestation count) is unchanged.

---

## 7. Change log v2: holder-bound, versioned attestations

Two changes to Circuit 3 (`attest*`). Nothing else moved: `issueProvenance`,
`transferProvenance`, the admin circuits, the four original hash derivations,
`HistoricMerkleTree` usage, the carbon-monotonicity assert (S-2) and **all
eleven witnesses** are byte-for-byte unchanged. No new witness was needed —
`ownerId` already arrives inside `heldCredential()`, the profile is a
compile-time constant per circuit, and the challenge is a circuit parameter.

### Change A — the attestation key binds the challenge to the holder

**The problem.** `attestations` was `Map<Bytes<32>, Uint<8>>` keyed by the
verifier's raw `challenge`, and the raw challenge was `disclose()`d twice
(`member`, `insert`). A challenge is a bearer value: the verifier hands it to a
holder over some out-of-band channel, and anyone who overhears it can call
`attestConsumer(ch)` with **their own** perfectly valid credential. The map then
says "profile 1 was proven for `ch`" and the verifier has no way to tell whose
credential produced it. Worse, the honest holder's later call would be *rejected*
as a replay, so the hijack is also a denial of service.

**The fix.** A fifth domain-separated derivation:

```compact
export pure circuit attestationKeyOf(challenge: Bytes<32>, ownerId: Bytes<32>, profile: Uint<8>): Bytes<32> {
  return persistentHash<Vector<4, Bytes<32>>>(
           [pad(32, "veilance:att"), challenge, ownerId, (profile as Field) as Bytes<32>]
           );
}
```

`recordAttestation` now computes this key **inside the circuit** from
`cred.ownerId` — the ownerId of the credential that `provenCredential()` just
proved the caller owns, so the caller cannot choose it freely — and uses it as
the map key. The raw challenge is no longer stored and is no longer disclosed
anywhere on chain.

**Binding is by lookup, not by rejection.** The contract still cannot reject the
hijacker: it has no idea which party the verifier expected, and both proofs are
valid. What changes is that the two attestations land on **different keys**. The
verifier knows the partyId of the counterparty it handed the challenge to, so it
recomputes `attestationKeyOf(ch, thatPartyId, profile)` off-chain via the
exported `pureCircuits.attestationKeyOf` and looks *that* up. A hijacker's record
exists but is invisible to that lookup, and — because the keys differ — the
honest holder is no longer DoS'd out of answering. Both properties are covered by
the two `hijack —` tests.

**Replay semantics changed, deliberately.** The unit of single-use is now the
triple `(challenge, holder, profile)`, not the challenge alone:

| repeat | outcome |
|---|---|
| same holder, same challenge, same profile | **rejected** — `"veilance: challenge already used by this holder for this profile"` |
| same holder, same challenge, different profile | **allowed** — different key |
| different holder, same challenge, same profile | **allowed** — different key (this is Change A's whole point) |

The middle row is intended: a verifier may legitimately ask one holder for both a
consumer-grade and a procurement-grade proof under a single challenge and read
the two results back separately. Covered by the `replay —` test.

#### Disclosure analysis for the attestation key

The key is the only new public value, and it replaces a value (the raw challenge)
that used to be public, so the disclosure surface is strictly *smaller* than
before — but the shape is different and worth spelling out.

`key = H("veilance:att", challenge, ownerId, profile)` over a preimage-resistant
`persistentHash`. Of the three inputs:

- `profile` is public — 3 values, and the circuit that was called already reveals
  which one.
- `ownerId` is **publicly enumerable**. Party ids appear verbatim as the first
  argument to `certifySupplier`, so the candidate set is exactly the set of
  certified suppliers, and it is small.
- `challenge` is the only high-entropy input, and it is now **never disclosed**.

Consequently:

- An observer who does **not** know the challenge learns nothing. The key is an
  opaque 32-byte value: unlinkable to a party, to a credential, and to any other
  attestation by the same party.
- An observer who **does** know the challenge — i.e. the verifier that issued it —
  can confirm `ownerId` by recomputing the key over the enumerable candidate set.
  That is precisely the intended function, and that party already knows who it is
  dealing with.

**Therefore `challenge` MUST be ≥128 bits of fresh CSPRNG output, generated by
the verifier, one per request.** A guessable, sequential, or reused challenge
collapses the key into a dictionary attack over the certified-supplier list and
de-anonymises the attester to the entire chain. The contract cannot enforce this:
the challenge is supplied by the verifier and the circuit has no way to measure
its entropy. This is the same class of requirement as `batchSecret` in finding
S-1, and it belongs in the verifier-side SDK, not in the circuit. The demo's
readable `challenge:consumer` fixtures are test fixtures only and are trivially
brute-forcible.

*Cross-check against S-4 (`attestRegulator` discloses a nullifier).* v2 publishes
the key and the nullifier in the same transaction where v1 published the challenge
and the nullifier. To the public both pairs are (opaque, opaque) — no change. To
the verifier, v2 additionally confirms which party attested, but the verifier
already knew that party and could already attribute the nullifier to the
transaction answering its own challenge. So S-4 is neither widened nor narrowed by
Change A; it stays MEDIUM/accepted as written.

*Residual, unchanged from v1:* the transaction submitter's address and the
identity of the circuit called are visible at the Midnight layer regardless.

### Change B — the attestation records the policy version it was proven under

`attestations` values are now a struct:

```compact
export struct Attestation {
  profile: Uint<8>;
  policyVersion: Uint<64>;
}
```

and `recordAttestation` writes `policyVersion.read()` at attestation time. A
verifier reading an attestation later can compare its `policyVersion` against the
ledger's current one and see whether the allow-lists or the carbon threshold have
moved since the proof was made. Covered by the `freshness —` test, which attests
at version 5, has the admin call `setCarbonThreshold`, and then asserts the
stored record still says 5 while the ledger says 6.

This is a partial answer to deviation **D-9** ("pinning each commitment to the
policyVersion it was issued under"): attestations are now pinned, credentials
still are not. `transferProvenance` continues to re-check origin and supplier
membership against the *current* allow-lists, which is what covers the credential
side.

`Uint<64>` was chosen because that is exactly what `Counter.read()` returns — see
below.

### The `Counter`-read question, and the evidence

The brief asked whether a `Counter`'s value can be read inside a circuit and
placed in a struct written to a `Map`, and to replace it with a plain
`export ledger policyVersion: Uint<64>` if not.

**It can. `policyVersion` stays a `Counter`.** The `compact-ledger` skill
documents `Counter.read()` as returning `Uint<64>`
(`skills/compact-ledger/references/types-and-operations.md`, "Read returns
`Uint<64>`"), but skills can be stale, so this was checked against the compiler
before touching the contract. Minimal probe:

```compact
pragma language_version >= 0.26;
import CompactStandardLibrary;

export struct Rec { profile: Uint<8>; policyVersion: Uint<64>; }

export ledger pv: Counter;
export ledger recs: Map<Bytes<32>, Rec>;

export circuit put(k: Bytes<32>, p: Uint<8>): [] {
  const v = pv.read();
  recs.insert(disclose(k), Rec { profile: disclose(p), policyVersion: v });
  pv.increment(1);
}
```

```
$ compact compile --skip-zk countertest.compact ctout
exit=0

$ find ctout -maxdepth 2
ctout/zkir/put.zkir
ctout/compiler/contract-info.json
ctout/compiler/contract-manifest.json
ctout/contract/index.d.ts
ctout/contract/index.js

$ grep -n "pv\|recs\|Rec" ctout/contract/index.d.ts
3:export type Rec = { profile: bigint; policyVersion: bigint };
24:  readonly pv: bigint;
29:    lookup(key_0: Uint8Array): Rec;
```

So: `Counter.read()` is legal in a circuit body, its `Uint<64>` result assigns
directly into a struct field, and that struct is a legal `Map` value. No
replacement was needed and the exported ledger name `policyVersion` is unchanged,
so `l.policyVersion` still reads as a `bigint` in TypeScript exactly as before.

The probe also produced an unrelated but useful finding: **parameters of an
exported circuit are witness-tainted**, not public. The first version of the probe
failed with

```
potential witness-value disclosure must be declared but is not:
  witness value potentially disclosed:
    the value of parameter k of exported circuit put at line 9 char 20
  nature of the disclosure:
    ledger operation might disclose the witness value
```

That is why *removing* the ledger write of the raw challenge genuinely removes it
from the public transcript, rather than merely moving it: a circuit parameter that
is never disclosed never becomes public.

### The one new `disclose()`, and proof that it is required

v1 had 17 `disclose()` sites; v2 has 16. Two went away (`member(challenge)` and
`insert(challenge, ...)`) and one appeared: a single binding in
`recordAttestation`.

```compact
const key = disclose(attestationKeyOf(challenge, ownerId, profile as Uint<8>));
```

Deleting that one `disclose` and recompiling — the same mechanical test applied to
every site in v1 (deviation D-1) — fails, and the compiler names the exact leak
path it is annotating:

```
$ compact compile --skip-zk nodisc.compact nodiscout
Exception: nodisc.compact line 281 char 23:
  potential witness-value disclosure must be declared but is not:
    witness value potentially disclosed:
      the return value of witness heldCredential at line 117 char 1
    nature of the disclosure:
      ledger operation might disclose a hash of the witness value
    via this path through the program:
      the binding of cred at line 239 char 9
      ...
      the second argument to recordAttestation at line 404 char 3
      the second argument to attestationKeyOf at line 280 char 15
      the argument to persistentHash at line 178 char 10
      the binding of key at line 280 char 9
      the argument to member at line 281 char 23
```

Note what the compiler is tracking: not the challenge, but `heldCredential()` →
`cred.ownerId` → `persistentHash` → a ledger `member`/`insert`. That is precisely
the disclosure the analysis above reasons about, and it is annotated exactly once,
at the point where the hash is formed.

### Files touched

| File | Change |
|---|---|
| `src/veilance.compact` | `Attestation` struct, `attestations` value type, `attestationKeyOf`, rewritten `recordAttestation`, three updated call sites |
| `src/witnesses.ts` | **none** |
| `test/network.ts` | **none** |
| `test/demo.test.ts` | step 4 / selective-disclosure / KNOWN-LIMITATION assertions rewritten against `pureCircuits.attestationKeyOf`; 4 new tests |

### Commands run for v2

```
$ compact compile --version && compact compile --language-version
0.34.0
0.26.0

$ compact format src/veilance.compact
(no output — reformatted in place)

$ compact compile --skip-zk src/veilance.compact src/managed/veilance
(no output — success)

$ npx tsc --noEmit
(no output — clean)

$ npx vitest run --reporter=verbose
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

20 tests: the 16 from v1 (all still passing, with step 4, the selective-disclosure
step and the KNOWN-LIMITATION case updated to look up the new key and assert the
new struct value) plus 4 new ones:

- `hijack — a second holder replaying the challenge lands on a DIFFERENT key, so
  binding is by lookup, not by rejection` (on the shared demo chain)
- `replay — same holder + same challenge + same profile is rejected; a different
  profile is allowed`
- `freshness — the attestation keeps the policy version it was made under while
  the ledger moves on`
- `hijack — two holders answering one challenge produce two independent records`

### Full ZK build for v2

```
$ compact compile src/veilance.compact <scratch-build-dir>
Compiling 8 circuits:
exit=0
ZK_COMPILE_SECONDS=109

$ ls <scratch-build-dir>/keys
attestConsumer.prover     attestConsumer.verifier
attestProcurement.prover  attestProcurement.verifier
attestRegulator.prover    attestRegulator.verifier
certifyOrigin.prover      certifyOrigin.verifier
certifySupplier.prover    certifySupplier.verifier
issueProvenance.prover    issueProvenance.verifier
setCarbonThreshold.prover setCarbonThreshold.verifier
transferProvenance.prover transferProvenance.verifier
```

Keys still generate for all 8 exported circuits. Verifier keys unchanged in size.

**One real cost regression, worth flagging.** Comparing prover-key sizes against the
v1 table in §5:

| circuit | v1 | v2 | |
|---|---|---|---|
| `setCarbonThreshold`, `certifyOrigin` | 2.7 MB | 2.7 MB | — |
| `certifySupplier` | 5.0 MB | 5.0 MB | — |
| `issueProvenance` | 9.6 MB | 9.6 MB | — |
| `attestConsumer` | 9.6 MB | 9.6 MB | — |
| `attestProcurement` | 9.6 MB | 9.6 MB | — |
| **`attestRegulator`** | **9.6 MB** | **19 MB** | **doubled** |
| `transferProvenance` | 19 MB | 19 MB | — |

`attestationKeyOf` adds one `persistentHash` over a `Vector<4, Bytes<32>>` to all
three attest circuits. Consumer and procurement absorb it inside their existing
PLONK circuit size; `attestRegulator` was already the most expensive of the three
(two Merkle paths + the nullifier hash + a `Set.member`) and the extra hash tips
it over the next power-of-two boundary, so its proving key doubles. Proving time
for a regulator attestation roughly doubles with it.

That is the price of Change A on the heaviest attest profile. It is not avoidable
by moving the hash — the key must be computed in-circuit from `cred.ownerId`, or
the binding is not a binding. It could be reduced by dropping `profile` from the
key (one fewer field in the hash, at the cost of the "one challenge, two profiles"
property), or by using `transientHash` for the key — but the key is written to the
ledger and compared across transactions, so it must be `persistentHash`.

---

## 8. Change log v3: on-chain encrypted credential inbox

Built on v2. Nothing from v1 or v2 was weakened: the attestation binding, the
carbon-monotonicity assert, the nullifier scheme, the Merkle usage and all eleven
witnesses are unchanged, and **no new witness was added**.

### The problem

A Veilance credential is only useful to its recipient if the recipient learns its
**pre-image** (`originId`, `materialType`, `carbonClass`, `batchSecret`). Up to
v2 the tests handed the credential over "out of band" — a comment that quietly
papered over the fact that the protocol had no delivery mechanism at all. On a
real deployment `transferProvenance` would nullify the sender's credential and
mint a commitment the recipient could never spend.

Midnight offers no transport for it:

- contract-call transactions have **no memo field**;
- the Zswap ciphertext slot is restricted to `ShieldedCoinInfo` and is
  **forbidden on contract outputs**;
- the DApp connector exposes only the wallet's encryption **public** key — there
  is no decrypt operation to borrow.

So delivery has to go through contract state. The precedent is MIP-0012 /
`midnightntwrk/passport`: an append-only inbox of fixed-size opaque sealed
entries, plus a per-party X25519 public key registered on-ledger.

### Contract surface added

```compact
export ledger partyEncKeys: Map<Bytes<32>, Bytes<32>>;      // partyId -> X25519 pk
export ledger credentialInbox: Map<Uint<64>, Bytes<192>>;   // ordinal -> sealed entry
export ledger credentialInboxCount: Counter;

export circuit registerEncKey(encPk: Bytes<32>): [];
export circuit issueProvenance(entry: Bytes<192>): Bytes<32>;
export circuit transferProvenance(entry: Bytes<192>): [Bytes<32>, Bytes<32>];
```

plus one internal helper:

```compact
circuit deliverSealedEntry(entry: Bytes<192>): [] {
  credentialInbox.insert(credentialInboxCount.read(), disclose(entry));
  credentialInboxCount.increment(1);
}
```

`Map<Uint<64>, Bytes<192>>` compiles on 0.34.0; the generated TS accessor is
`credentialInbox: { member(key: bigint): boolean; lookup(key: bigint): Uint8Array; ... }`.

**Delivery is atomic with creation.** `deliverSealedEntry` is called inside
`issueProvenance` and `transferProvenance`, after the tree insert. A commitment
therefore cannot appear on chain without a delivery in the same transaction, and
a rejected call appends nothing (covered by the snapshot test, and the snapshot
helper now includes the full inbox contents byte for byte).

### Why the inbox is keyed by an ordinal

Two obvious alternatives, both rejected:

| key | why not |
|---|---|
| `recipientId` | publishes exactly the thing the protocol exists to hide — who received what. Also breaks on a second delivery to the same party. |
| `commitment` | adds nothing: the commitment is already inside the sealed payload, and it turns the inbox into a second public index of the provenance tree, letting an observer correlate "commitment X was delivered at time T". |

An ordinal leaks only "this was the Nth credential ever created", which
`provenanceTree.firstFree()` already leaks. Recipients find their own entries by
**trial decryption**, which is what keeps the addressing private.

### Disclosure analysis

**`entry` (192 bytes, public).** Parameters of an exported circuit are
witness-tainted, so the ledger write needs an explicit `disclose()`. What becomes
public is AES-256-GCM output under a key derived from an *ephemeral* X25519
sender key. To anyone without the recipient's private key it is indistinguishable
from random. Specifically it does **not** reveal:

- the recipient — no recipient identifier appears in the container, and the
  ephemeral public key is fresh per entry;
- the sender — the long-term sender key is never used;
- whether two entries share a recipient, or a sender, or a credential.

The only public facts are the ordinal, the length (fixed at 192, so it carries no
information), and that an insertion happened — which the tree insert in the same
transaction already announced. The `ver`/`suite` header bytes are public by
design and are bound as AEAD associated data so a suite downgrade cannot be
forged onto an existing ciphertext.

*Residual:* an observer sees the inbox grow in lockstep with the tree, and the
transaction submitter's address is visible at the Midnight layer as always. So
"this address created credential #N" remains observable, exactly as in v2.

**`partyEncKeys` (partyId -> encPk, public).** An X25519 public key is public by
definition — publishing it is the entire point. `partyId` is already public for
any certified supplier (it appears verbatim as a `certifySupplier` argument). The
real cost is a small **linkability** one: an observer sees "this partyId
registered a key at time T" and sees rotations as discrete events. Neither
reveals anything about the party's credentials, but a party that rotates its key
immediately before receiving a delivery narrows the anonymity set of that
delivery by one. Rotate on a schedule, not on an event.

**`registerEncKey` authorisation.** There is none beyond the derivation, and none
is needed: the map key is `partyIdOf(ownerSecret())`, computed in-circuit, so a
caller can only ever write the slot belonging to the secret it actually holds.
The circuit takes no `partyId` parameter to aim elsewhere. Overwrite is allowed
(that is rotation); deletion is not possible. Covered by the `registerEncKey —`
test, which has an impostor call it and shows the write landing under the
impostor's own id with the victim's slot untouched.

### The sealed-entry container

`src/sealed-entry.ts`. Suite byte 1 = ephemeral X25519 -> HKDF-SHA256 ->
AES-256-GCM, per MIP-0012 §6.4.

```
ikm    = X25519(ephSk, recipientPk)          32 bytes
salt   = ephPk || recipientPk                64 bytes
info   = utf8("veilance:credential:v1")
key    = HKDF-SHA256(ikm, salt, info, 32)
aad    = [ver, suite]                         2 bytes
nonce  = 12 fresh random bytes
```

I chose `salt = ephPk || recipientPk` (rather than a fixed or empty salt) so the
derived key is bound to that exact (ephemeral, recipient) pair: a shared secret
can never be reused across recipients even if an ephemeral key were repeated.

Plaintext, 129 bytes:

```
offset  size  field
     0    32  originId
    32    32  materialType
    64     1  carbonClass       (Uint<8>)
    65    32  batchSecret
    97    32  commitment
```

`ownerId` is deliberately **not** transmitted — the recipient is the only party
that can decrypt, so it already knows the credential is addressed to itself and
fills in its own partyId. `commitment` **is** transmitted so a scanner can
validate an entry cheaply before trusting any field.

Container, 192 bytes (= `Bytes<192>`):

```
offset  size  field
     0     1  ver       = 1
     1     1  suite     = 1
     2    32  ephPk
    34    12  nonce
    46    16  tag
    62   129  ct
   191     1  reserved  = 0
```

`reserved` exists because 62 + 129 = 191 and the ledger cell is a fixed 192; it
is checked to be zero on open so it cannot quietly become a covert channel.

Implemented on `node:crypto`, but only through primitives WebCrypto also has and
entirely over raw byte arrays, so the browser port is mechanical
(`generateKeyPairSync('x25519')` -> `subtle.generateKey({name:'X25519'})`,
`diffieHellman` -> `deriveBits`, `hkdfSync` -> HKDF `deriveBits`, `createCipheriv`
-> `subtle.encrypt`). The tag is stored in its own slot rather than appended to
the ciphertext, so the two implementations produce byte-identical entries despite
WebCrypto's concatenated-tag convention.

### `scanInbox` — the three checks

A recipient keeps an entry only if **all three** hold:

1. it opens under `encSk` (AEAD authenticates the ciphertext);
2. `commitmentOf({ownerId: myPartyId, ...fields})` equals the commitment embedded
   in the plaintext — so a sender cannot make us believe in fields that do not
   hash to what it claims, and in particular cannot seal a credential minted for
   a *different* ownerId;
3. that commitment is present in `provenanceTree` — so a sender cannot make us
   believe in a credential the chain never recorded.

Check 3 has its own test (`scan rejects a well-formed entry whose commitment is
not in the provenance tree`): the Mine issues `real` but delivers a sealed
`phantom`. The entry opens and is internally consistent, and is still dropped.

`openCredential` returns `null` rather than throwing on failure. Scanning an
inbox means failing to open almost every entry in it; an exception would make
"not mine" indistinguishable from "broken client".

### Accepted trade-off: the contract never validates the entry

It cannot. Validating would mean putting the recipient's public key and an AEAD
inside the circuit, and Compact has no equality on cells that large in any case.
So a misbehaving issuer can insert a real commitment alongside a garbage
delivery. The consequence is bounded and self-inflicted: **nobody** can ever
spend that credential, because spending requires the pre-image. No value is
created, no other party is harmed, and the tree simply carries one dead leaf.
Demonstrated by the `garbage entry —` test, which passes 192 bytes of noise, gets
a valid commitment inserted, and shows the intended recipient recovering nothing
(silently, not by exception).

### Capacity

- `credentialInbox` is a `Map`, which is **unbounded** — unlike
  `provenanceTree` (`HistoricMerkleTree<16>`, 65 536 leaves) and the two
  allow-list trees (`MerkleTree<8>`, 256 leaves each). Since exactly one entry is
  appended per tree insertion, the inbox can never outgrow the tree: the tree's
  65 536-leaf ceiling binds first, and finding *that* ceiling is still the open
  item from finding S-8.
- `credentialInboxCount` is a `Counter`, i.e. `Uint<64>` — not a practical bound.
- **Scan cost is O(inbox size).** A recipient joining late trial-decrypts every
  entry from 0. `scanInbox` returns `nextIndex` precisely so a wallet can persist
  it and scan incrementally; only a wiped device pays the full cost. At the tree's
  65 536-entry ceiling a full rescan is ~65k X25519 + AEAD attempts, a few seconds
  — acceptable, and it is the same shape of cost every shielded-pool wallet pays.

### What in the spec had to change

- **`issueProvenance` and `transferProvenance` gained a parameter.** Both are
  breaking signature changes for any caller, including `test/network.ts`, whose
  wrappers were updated. The design docs describe them as no-argument circuits.
- **The tests' "received out of band from the Mine" comment is now false, and
  that is the point.** Three tests (`receive-by-scan`, `recovery`,
  and the scan half of `non-recipient`) construct the holder's credential
  *exclusively* from `scanInbox` output and then use that object to transfer and
  to attest, proving the delivered pre-image is actually usable.
- **`registerEncKey` does not bump `policyVersion`.** It is not a policy change,
  and bumping it would make every v2 attestation look stale whenever any party
  rotated a key. `bootstrap()` in the tests therefore still ends at
  `policyVersion == 5`.
- **The public-state snapshot helper grew three fields** (`encKeyCount`,
  `inboxCount`, and the full `inbox` contents), so "a rejected call changes
  nothing" now also covers the inbox byte for byte.
- **`CONTRACT_DESIGN.md` §4.4 and §5 are now out of date** with respect to the
  inbox — I did not edit them, since the brief scoped this to the contract, the
  helper, the tests and NOTES.md.

### Full ZK build for v3, and the prover-key deltas

```
$ compact compile src/veilance.compact <scratch-build-dir>
Compiling 9 circuits:
exit=0
ZK_COMPILE_SECONDS=77

$ ls <scratch-build-dir>/keys
attestConsumer.prover     attestConsumer.verifier
attestProcurement.prover  attestProcurement.verifier
attestRegulator.prover    attestRegulator.verifier
certifyOrigin.prover      certifyOrigin.verifier
certifySupplier.prover    certifySupplier.verifier
issueProvenance.prover    issueProvenance.verifier
registerEncKey.prover     registerEncKey.verifier
setCarbonThreshold.prover setCarbonThreshold.verifier
transferProvenance.prover transferProvenance.verifier

$ du -h <scratch-build-dir>/keys/*.prover | sort -h
2.7M  certifyOrigin.prover
2.7M  registerEncKey.prover
2.7M  setCarbonThreshold.prover
5.0M  certifySupplier.prover
9.6M  attestConsumer.prover
9.6M  attestProcurement.prover
9.6M  issueProvenance.prover
19M   attestRegulator.prover
19M   transferProvenance.prover
```

| circuit | v2 | v3 | delta |
|---|---|---|---|
| `certifyOrigin`, `setCarbonThreshold` | 2.7 MB | 2.7 MB | — |
| **`registerEncKey`** | — | **2.7 MB** | new (one hash + one map insert) |
| `certifySupplier` | 5.0 MB | 5.0 MB | — |
| `issueProvenance` | 9.6 MB | 9.6 MB | **no change** |
| `attestConsumer` | 9.6 MB | 9.6 MB | — |
| `attestProcurement` | 9.6 MB | 9.6 MB | — |
| `attestRegulator` | 19 MB | 19 MB | — |
| `transferProvenance` | 19 MB | 19 MB | **no change** |

The result worth stating plainly: **carrying 192 bytes of ciphertext through the
circuit costs nothing measurable.** The entry is never hashed, compared or
decomposed — it is copied from a parameter straight into a ledger cell — so it
adds only wire assignments, and both `issueProvenance` and `transferProvenance`
stay inside the PLONK circuit size they already occupied. The Merkle path proofs
still dominate everything. This is the cheap half of the design; the expensive
half (the AEAD) deliberately lives entirely off-circuit in `sealed-entry.ts`.

---

## 9. Toolchain: moved from 0.34.0/runtime 0.19.0 to 0.31.1/runtime 0.16.0

While building the devnet e2e harness (`contract/e2e/`), checking the actual
npm dependency graphs of `@midnight-ntwrk/midnight-js-contracts` and
`@midnight-ntwrk/wallet-sdk-facade` against what this contract's compiled
output required turned up a real problem: **no published version of
`midnight-js-contracts` — stable or prerelease — depended on exactly
`compact-runtime@0.19.0`.** The stable line (`4.1.1`, npm `latest`) pins
`compact-runtime@0.16.0` exactly; the closest prerelease line
(`5.0.0-beta.7`) depended on the release candidate `0.19.0-rc.0`, one
prerelease behind. Cross-checking `compact-runtime`'s own dependency
(`@midnight-ntwrk/onchain-runtime-v3` for `0.15.0`/`0.16.0` vs.
`@midnightntwrk/onchain-runtime-v4` for `0.18.0+`) showed the split was
generational, not incidental: `0.19.0` is the next-generation (ledger-v9)
line, and the official support matrix
(`docs.midnight.network/relnotes/support-matrix`) as well as the devnet
images given for this task (`midnight-node:0.22.5`, `proof-server:8.1.0`)
are both on the *current stable* (ledger-v8) line.

**Decision: move the whole project to the stable generation** —
Compact compiler `0.31.1` (language version `0.23`), `compact-runtime
0.16.0`, `midnight-js-*` `4.1.1`, `wallet-sdk-facade` `4.1.0` — rather than
carry a prerelease pin that the official support matrix, the devnet images
given for this task, and every reference skill's worked examples all
disagree with. This is a reversal of the decision recorded when `e2e/`
was first built (see `e2e/README.md`'s version history); that decision
optimized for "matches what the contract's *newest possible* compiler
output needs" and this one optimizes for "matches what is actually stable,
documented, and deployed" — the latter is the right target for a contract
meant to run against a real devnet rather than a hypothetical future one.

### What changed, and what didn't

- `src/veilance.compact`: `pragma language_version >= 0.26` → `>= 0.23`.
  **Nothing else in the contract changed.** It compiles unchanged under
  `compact +0.31.1`, `--skip-zk` and full ZK build alike.
- `package.json`: `compile`/`compile:zk`/`format` now pin `compact compile
  +0.31.1 ...` explicitly, so the build is deterministic regardless of
  whatever the `compact` CLI's default version happens to be on a given
  machine (`0.34.0` remains installed and reachable via `+0.34.0` if ever
  needed again). Dependencies dropped every `@midnightntwrk/*` (no-hyphen,
  next-gen) package and the `overrides` block that forced them to a single
  version — none of that is needed once everything in the tree is the
  stable generation, which `npm ls` confirms dedupes to one
  `compact-runtime@0.16.0` and one `@midnight-ntwrk/ledger-v8@8.1.0` with no
  `overrides` at all.
- `test/network.ts` (the `compact-runtime`-driven simulator) needed two
  real fixes for the API difference between runtime `0.19.0` and `0.16.0`,
  found by reading the installed `.d.ts` rather than guessing:
  - `createCircuitContext` dropped its leading `circuitId` parameter
    (`circuit-context.d.ts` in `0.16.0` takes `(contractAddress,
    coinPublicKey, contractState, privateState, gasLimit?, costModel?,
    time?)` — five to seven positional args, no name). The circuit is still
    selected by name via `circuits[circuitId]`; only the context
    construction call itself needed the argument dropped and reordered.
  - `CircuitResults.context` is flat in `0.16.0`
    (`{currentPrivateState, currentQueryContext, ...}`) — the
    `callContext` wrapper the code read `res.context.callContext...`
    through does not exist in this runtime version.
  - `createConstructorContext(initialPrivateState, coinPublicKey)` was
    **unchanged** between the two versions — no fix needed there.
- `src/witnesses.ts` needed **no changes at all**. Its Merkle accessors
  (`findPathForLeaf`, tree depth constants) and `WitnessContext` usage are
  identical between `compact-runtime` `0.19.0` and `0.16.0` — confirmed by
  `npx tsc --noEmit` staying clean and all 27 tests passing with zero edits
  to that file.
- `e2e/lib/wallet.ts` and `e2e/lib/providers.ts` were rewritten against the
  stable `wallet-sdk-facade@4.1.0` / `midnight-js-*@4.1.1` APIs, following
  the `midnight-js` skill's §5–§8 wiring and `example-counter`'s
  `counter-cli/src/api.ts` almost verbatim (HD-derive Zswap/NightExternal/
  Dust keys, `ShieldedWallet(...).startWithSecretKeys(...)`,
  `UnshieldedWallet(...).startWithPublicKey(...)`,
  `DustWallet(...).startWithSecretKey(...)`, `WalletFacade.init` +
  `.start(shieldedSecretKeys, dustSecretKey)`, and the documented
  `signTransactionIntents` workaround for the "Failed to clone intent" SDK
  bug). This is considerably simpler than the prerelease line it replaces:
  no protocol-version "handle" wrapping
  (`WalletTransaction.adopt`/`unwrapWithin`), no independent re-derivation
  of the unshielded keystore to work around a facade that never exposes
  its own, no fork-schedule configuration — transactions are plain
  `ledger-v8` objects throughout.
- `e2e/lib/health.ts`'s proof-server version check is now inverted: it
  warns if the proof server it finds is **not** `8.x` (previously: warned
  if it *was* `8.x`, back when the project was pinned to the next-gen line).

### Re-checking D-1 ("`assert` is not a disclosure boundary") on 0.31.1

D-1 was established by mechanical testing against compiler `0.34.0`: every
`disclose()`-wrapped `assert` on witness-derived data compiled fine with
the wrapper removed, while ledger writes, `checkRoot` arguments, and
export-circuit returns did not. That finding predates this toolchain
switch, so it needed re-confirming against `0.31.1` rather than assumed to
still hold.

Two checks, both against the real `+0.31.1` compiler:

1. **The shipped contract, as-is, has zero `disclose()` wrapping any bare
   `assert`** (all such wrapping was already removed per D-1's original
   findings) **and compiles cleanly** — `--skip-zk` and the full 9-circuit
   ZK build both exit 0. If `0.31.1` treated a bare `assert` on
   witness-derived data as a disclosure boundary, this would have failed
   at, for example, `assertAdmin`'s `assert(partyIdOf(adminSecret()) ==
   adminId, ...)` — it did not.
2. To test the other direction — that `0.31.1` still treats a **ledger
   write** as a boundary — `issueProvenance`'s
   `provenanceTree.insert(disclose(commitment))` was changed to
   `provenanceTree.insert(commitment)` (disclose removed) in a throwaway
   copy and recompiled with `+0.31.1 --skip-zk`. It failed, exactly as the
   original D-1 experiment predicted for a required site:

   ```
   Exception: veilance.compact line 409 char 17:
     potential witness-value disclosure must be declared but is not:
       witness value potentially disclosed:
         the return value of witness issuedMaterial at line 145 char 1
       nature of the disclosure:
         ledger operation might disclose a hash of the witness value
       via this path through the program:
         the binding of spec at line 396 char 9
         the binding of cred at line 399 char 9
         the argument to commitmentOf at line 404 char 22
         the argument to persistentHash at line 169 char 10
         the binding of commitment at line 404 char 9
         the argument to insert at line 409 char 17
   ```

   (A second, near-identical error fired for `recipientId`'s witness value
   flowing through the same `commitment` binding — both correctly caught.)
   The change was reverted immediately after; `src/veilance.compact` is
   byte-for-byte what it was before this experiment.

**`0.31.1` agrees with `0.34.0` on both counts.** `assert` is still not a
disclosure boundary, and ledger operations still are, on the compiler this
project now actually ships with.
