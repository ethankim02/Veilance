# Veilance Contract Design

> landing.md §9 (48h MVP) 와 ERD.md 를 Midnight Compact 컨트랙트로 구체화한 설계.
> 실제 컴파일·실행으로 검증된 코드는 `contract/` 디렉토리와 이 문서 §9 에 있다.

---

## 1. 설계 원칙

Compact 은 세 가지 맥락을 엄격히 구분한다. Veilance 설계는 이 경계를 기준으로 삼는다.

| 맥락 | Veilance 에서의 의미 | 예 |
|---|---|---|
| **ledger** | 모든 참여자가 공유하는 공개 상태. landing §6 의 shared state | commitment tree, nullifier set, policy roots, attestations |
| **circuit** | "이 transition 이 규칙을 만족한다"를 증명하는 로직 | issue / transfer / attest |
| **witness** | 각 기업 로컬에만 있는 private 데이터. ERD L2 | ownerSecret, originId, batchSecret, Merkle path |

원칙:

1. **공개는 명시적**: `disclose()` 는 nullifier, 새 commitment, verifier challenge, admin 이 게시하는 policy 값에만 쓴다. 그 외 witness 값은 ledger 에 닿지 않는다.
2. **upstream 링크는 온체인에 없다**: transfer 시 소비되는 upstream commitment 는 Merkle path 로 *in-circuit* 멤버십 증명만 한다. `Set.member(disclose(cm))` 방식은 nullifier ↔ commitment 를 공개적으로 연결하므로 금지.
3. **Provenance Core 와 Policy 를 분리**: commitment / nullifier / tree 는 산업 무관. 산업별 predicate 는 attest circuit 과 policy 값(allow-list root, threshold)에만 존재.
4. **admin 인증은 secret-knowledge 로**: `ownPublicKey()` 류의 호출자 정보 대신 `H(adminSecret) == adminId` 를 증명한다. (witness 는 호출자가 임의로 제공하므로 호출자 정보 자체는 신뢰 근거가 될 수 없다.)

---

## 2. 암호 규약

모든 id / hash 는 `Bytes<32>`. 해시는 stdlib persistent hash, 각 용도마다 도메인 prefix 로 분리한다.

| 값 | 정의 | 누가 아는가 |
|---|---|---|
| `partyId` | `H("veilance:id" ‖ partySecret)` | 공개 (pseudonymous). secret 은 본인만 |
| `certLeaf` | `H("veilance:cert" ‖ partyId ‖ certId)` | 공개 (certifiedSuppliers tree 의 leaf) |
| `commitment` | `H("veilance:cm" ‖ ownerId ‖ originId ‖ materialType ‖ carbonClass ‖ batchSecret)` | 값은 공개, pre-image 는 owner + issuer 만 |
| `nullifier` | `H("veilance:nf" ‖ commitment ‖ ownerSecret)` | 소비 시 공개. owner 만 계산 가능 |

Credential (ERD `PRIVATE_CREDENTIAL`) 의 in-circuit 표현:

```text
Credential {
  ownerId      : Bytes<32>   // 수신자의 partyId
  originId     : Bytes<32>   // 광산/산지 식별자 해시 (PRIVATE)
  materialType : Bytes<32>   // cobalt 등 (PRIVATE)
  carbonClass  : Uint<8>     // 탄소 등급 (PRIVATE, 범위 증명용)
  batchSecret  : Bytes<32>   // 무작위 salt (PRIVATE)
}
```

왜 이렇게 나누는가:

- `ownerId` 를 commitment 에 넣으면 **issuer 가 recipient 에게 발행**하는 모델이 된다. Mine 이 Refiner 의 id 로 credential 을 만들면 Refiner 만 (ownerSecret 으로) 소비할 수 있다.
- `nullifier` 에 `ownerSecret` 이 들어가므로 pre-image 를 아는 issuer 도 nullifier 를 계산할 수 없다. 즉 발행자가 수신자의 credential 을 대신 소비하거나 추적할 수 없다.
- `batchSecret` 이 없으면 같은 origin/material/owner 조합이 같은 commitment 로 충돌한다.
- `carbonClass` 를 commitment 에 포함해야 attest 시 "commitment 안의 carbonClass ≤ threshold" 를 증명할 수 있다.

---

## 3. Ledger State

| 필드 | 타입 | ERD 대응 | 변경 주체 | 설명 |
|---|---|---|---|---|
| `adminId` | `Bytes<32>` | — | constructor | policy 관리자 pseudonymous id |
| `policyVersion` | `Counter` | `POLICY_VERSION.version` | admin circuits | policy 변경마다 +1 |
| `carbonThreshold` | `Uint<8>` | `POLICY_VERSION.params` | `setCarbonThreshold` | OEM procurement predicate 의 임계값 |
| `certifiedOrigins` | `MerkleTree<8, Bytes<32>>` | `RESTRICTED_SOURCE` (allow-list 로 반전) | `certifyOrigin` | leaf = originId |
| `certifiedSuppliers` | `MerkleTree<8, Bytes<32>>` | `CERTIFICATION` + `REQUIRED_CERTIFICATION` | `certifySupplier` | leaf = certLeaf |
| `provenanceTree` | `HistoricMerkleTree<16, Bytes<32>>` | `LEDGER_COMMITMENT` | `issueProvenance`, `transferProvenance` | leaf = commitment |
| `nullifiers` | `Set<Bytes<32>>` | `LEDGER_NULLIFIER` | `transferProvenance` | 소비된 credential |
| `attestations` | `Map<Bytes<32>, Attestation>` | `VERIFICATION_REQUEST/RESULT` | `attest*` | `H("veilance:att", challenge, ownerId, profile)` → `{profile, policyVersion}` |
| `partyEncKeys` | `Map<Bytes<32>, Bytes<32>>` | `ORGANIZATION.enc_public_key` | `registerEncKey` | partyId → X25519 공개키. 덮어쓰기 = 키 교체 |
| `credentialInbox` | `Map<Uint<64>, Bytes<192>>` | `CREDENTIAL_INBOX` | `issueProvenance`, `transferProvenance` | 순번 → 봉인된 credential pre-image |
| `credentialInboxCount` | `Counter` | — | 위와 동일 | inbox 길이 |

설계 근거:

- **allow-list 방식**: landing 의 "restricted source 아님" 은 MVP 에서 "certified origin allow-list 에 속함" 으로 모델링한다. Merkle non-membership 증명은 range proof 가 필요해 48h 범위 밖이다. 제재 목록 추가 = 새 allow-list 를 게시(재구성)하는 것으로 처리한다.
- **HistoricMerkleTree**: 다른 참여자가 동시에 insert 해서 root 가 바뀌어도, 증명 생성 시점의 root 로 만든 path 가 유효하도록 과거 root 를 허용한다. 동시성이 있는 multi-party 시스템에서 필수. 사용 불가 시 `MerkleTree` + 재시도 로 대체.
- **attestations 키 = H(challenge, ownerId, profile)**: challenge 는 verifier 가 무작위로 만든 값이라 credential 과 아무 연결이 없고, ownerId 는 회로 안에서 증명된 credential 에서 가져오므로 호출자가 고를 수 없다. verifier 는 거래 상대의 partyId 를 알고 있으니 같은 키를 재계산해 조회한다. challenge 를 가로챈 제3자가 자기 credential 로 증명하면 다른 키에 기록되어 verifier 의 조회에 걸리지 않는다 (거부가 아니라 조회로 바인딩). 값에는 증명 시점의 policyVersion 을 함께 기록해 verifier 가 신선도를 판단한다.
- **credentialInbox 를 순번으로 키잉**: Midnight 컨트랙트 호출 tx 에는 memo 필드가 없고, Zswap ciphertext 슬롯은 `ShieldedCoinInfo` 전용이며 컨트랙트 출력에는 금지되어 있다. DApp Connector 는 지갑 암호화 공개키만 노출하고 복호화 수단을 주지 않는다. 따라서 pre-image 전달은 컨트랙트 상태를 통해야 하고, MIP-0012 / midnightntwrk/passport 의 inbox 패턴을 그대로 따른다. recipientId 로 키잉하면 수신자가 공개되고, commitment 로 키잉하면 얻는 게 없으므로 순번을 쓴다. 수신자는 시도 복호화로 자기 항목을 찾는다.

---

## 4. Circuit 명세

### 4.1 Admin

| circuit | 인자 (public) | witness | 검증 | 효과 |
|---|---|---|---|---|
| `certifyOrigin(originId)` | originId | adminSecret | `H(id‖adminSecret) == adminId` | `certifiedOrigins.insert(originId)`, `policyVersion++` |
| `certifySupplier(partyId, certId)` | partyId, certId | adminSecret | 동일 | `certifiedSuppliers.insert(certLeaf(partyId, certId))`, `policyVersion++` |
| `setCarbonThreshold(t)` | t | adminSecret | 동일 | `carbonThreshold = t`, `policyVersion++` |

인자는 admin 이 의도적으로 게시하는 값이므로 공개가 맞다. certified supplier 목록은 pseudonymous id 기준으로 공개된다 (실명 매핑은 off-chain).

### 4.1.1 `registerEncKey(encPk)` — 모든 참여자

| 항목 | 내용 |
|---|---|
| witness | `ownerSecret` |
| 효과 | `partyEncKeys.insert(partyIdOf(ownerSecret), encPk)` |
| 인가 | 별도 검사 없음. 키가 호출자 secret 에서 유도되므로 남의 슬롯에는 쓸 수 없다 |
| 공개 | partyId (이미 certifySupplier 로 공개됨), X25519 공개키 |
| policyVersion | 올리지 않음. 정책 변경이 아니고, 올리면 키 교체마다 기존 attestation 이 stale 로 보임 |

### 4.2 `issueProvenance(entry: Bytes<192>): Bytes<32>` — Mine (root)

| 항목 | 내용 |
|---|---|
| 호출자 | `can_issue_root` role (Mine / Fab / Component Supplier) |
| witness | `issuerSecret`, `issuerCertId`, `issuerCertPath`, `recipientId`, `originId`, `originPath`, `materialType`, `carbonClass`, `batchSecret` |
| 검증 | ① `certLeaf(H(issuerSecret), issuerCertId)` 가 `certifiedSuppliers` 의 유효한 root 로 이어짐 ② `originId` 가 `certifiedOrigins` 의 유효한 root 로 이어짐 |
| 효과 | `cm = commitment(recipientId, originId, materialType, carbonClass, batchSecret)`; `provenanceTree.insert(cm)`; `credentialInbox.insert(count, entry)`; `count++` |
| 공개 | `cm` 과 봉인된 `entry` (192byte ciphertext). issuer 가 누구인지, origin 이 어디인지, 수신자가 누구인지 모두 비공개 |

Mine 이 자기 credential 을 만드는 게 아니라 **Refiner 에게 발행**한다. pre-image (originId, materialType, carbonClass, batchSecret, commitment) 는 Refiner 의 X25519 공개키 (`partyEncKeys[recipientId]`) 로 봉인해 `entry` 인자로 넘기고, 같은 tx 에서 inbox 에 기록된다. 컨트랙트는 entry 내용을 검증하지 않는다 (검증하려면 회로 안에서 AEAD 를 돌려야 함). 발행자가 쓰레기를 넣으면 그 credential 은 아무도 소비할 수 없을 뿐 다른 피해는 없다.

### 4.3 `transferProvenance(entry: Bytes<192>): [Bytes<32>, Bytes<32>]` — Refiner (Circuit 2)

| 항목 | 내용 |
|---|---|
| 호출자 | 현재 owner |
| witness | `ownerSecret`, upstream `Credential` 전체, `upstreamPath` (provenanceTree), `ownerCertId`, `ownerCertPath`, `recipientId`, `newBatchSecret`, `newCarbonClass` |
| 검증 (landing §9 Circuit 2 의 4조건) | |
| ① upstreamCredentialValid | `cred.ownerId == H(id‖ownerSecret)` ∧ `upstreamPath.leaf == commitment(cred)` ∧ `provenanceTree.checkRoot(root(upstreamPath))` |
| ② supplierCertified | `certLeaf(ownerId, ownerCertId)` ∈ `certifiedSuppliers` |
| ③ originNotRestricted | `cred.originId` ∈ `certifiedOrigins` (현재 policy 로 재검증) |
| ④ credentialNotConsumed | `nf = nullifier(commitment(cred), ownerSecret)`; `!nullifiers.member(nf)` |
| ⑤ (구현 추가) | `newCarbonClass >= cred.carbonClass` — 등급 초기화 방지 (§9.3 S-2) |
| 효과 | `nullifiers.insert(nf)`; `cm' = commitment(recipientId, cred.originId, cred.materialType, newCarbonClass, newBatchSecret)`; `provenanceTree.insert(cm')`; inbox 에 `entry` 기록 |
| 공개 | `nf`, `cm'`, 봉인된 `entry` |
| 비공개 | upstream commitment, originId, materialType, 양쪽 carbonClass, owner / recipient id |

`originId` 와 `materialType` 은 **그대로 상속**된다. 이것이 "downstream 은 upstream 데이터를 보지 않고 validity 만 상속한다" 의 구현이다. 하류 참여자는 originId 값을 witness 로 받지만 (pre-image 전달), 온체인에는 절대 올라가지 않는다.

`carbonClass` 는 각 단계가 자기 공정의 값을 새로 넣되, **upstream 값보다 낮출 수 없다**. 이 단조성 제약이 없으면 하류가 등급을 0 으로 초기화해 procurement predicate 를 무력화할 수 있다. 정확한 누적 계산은 확장 범위 (§8).

### 4.4 `attest*(challenge)` — 현재 owner → verifier (Circuit 3)

landing §5.2 Selective Policy Disclosure 를 **profile 별 circuit** 으로 구현한다. 어느 circuit 을 호출했는지가 곧 "무엇을 증명했는지" 이므로 별도 predicate mask 가 필요 없고, 회로 안에 조건 분기가 없다.

| circuit | 증명하는 predicate | 추가 공개 | attestation 값 |
|---|---|---|---|
| `attestConsumer(ch)` | ownership ∧ tree membership ∧ origin certified | 없음 | 1 |
| `attestProcurement(ch)` | Consumer + owner certified ∧ `carbonClass ≤ carbonThreshold` | 없음 (carbonClass 비공개, 부등식만 증명) | 2 |
| `attestRegulator(ch)` | Procurement + `nf ∉ nullifiers` | **nullifier 공개** | 3 |

공통: `key = H("veilance:att", ch, cred.ownerId, code)` 를 회로 안에서 계산해 공개하고, `!attestations.member(key)` 확인 후 `attestations.insert(key, {profile: code, policyVersion: policyVersion.read()})`. 같은 holder·challenge·profile 재사용은 거부, 같은 challenge 로 다른 profile 은 허용 (verifier 가 두 profile 을 함께 요청할 수 있음). raw challenge 는 저장도 공개도 되지 않는다.

흐름:

1. Verifier (OEM 등) 가 random `ch` 를 생성해 holder 에게 전달.
2. Holder 가 해당 profile circuit 을 실행.
3. Verifier 가 `attestationKeyOf(ch, holderPartyId, profile)` 를 로컬에서 재계산해 ledger 의 `attestations[key]` 를 읽고, profile 과 policyVersion 이 현재 값과 일치하는지 확인.

`attestRegulator` 의 nullifier 공개는 의도된 trade-off 다. "아직 소비되지 않음" 을 증명하려면 `Set.member` 를 호출해야 하고 그 인자는 공개된다. 이후 이 credential 이 transfer 되면 같은 nullifier 가 다시 등장하므로 attestation 과 transfer 가 연결된다. Regulator 는 그 정도 linkage 를 감수할 수 있는 verifier 이므로 이 profile 에만 둔다.

---

## 5. Disclosure 분석 (온체인 관찰자 관점)

| 이벤트 | 관찰자가 보는 것 | 관찰자가 볼 수 없는 것 |
|---|---|---|
| `certifyOrigin` | originId 해시가 allow-list 에 추가됨 | 해시의 pre-image (위치 이름). 단, 후보가 적으면 사전 공격 가능 → originId 는 salted id 로 발급 |
| `certifySupplier` | partyId, certId 가 certified 됨 | partyId ↔ 실명 |
| `registerEncKey` | partyId, X25519 공개키, 등록·교체 시점 | 없음. 단 교체 직전의 전달은 anonymity set 이 1 줄어듦 → 교체는 이벤트가 아니라 주기로 |
| `issueProvenance` | tree 에 leaf 하나 추가, inbox 에 192byte ciphertext 하나 추가, tx 제출자 주소 | leaf 의 pre-image 전부, 누가 받았는지 (ephemeral 송신키라 ciphertext 에서 수신자·송신자 식별 불가) |
| `transferProvenance` | nullifier 1개, 새 leaf 1개, inbox 항목 1개, tx 제출자 주소 | 어떤 leaf 가 소비되었는지 (anonymity set = tree 전체), origin, material, carbonClass, 수신자 |
| `attestConsumer/Procurement` | attestation key (opaque 32byte), profile code, policyVersion, tx 제출자 주소 | 어떤 credential 인지, 누가 증명했는지 (challenge 를 모르면 ownerId 를 사전 공격할 수 없음. challenge 는 128bit 이상 CSPRNG 필수) |
| `attestRegulator` | + nullifier | 어떤 commitment 인지 (nullifier ↔ commitment 는 여전히 비공개) |

**잔여 메타데이터 노출**: tx 제출자 주소와 timing 은 Midnight 레벨에서 보인다. 즉 "Refiner 주소가 이 블록에 transfer 를 했다" 는 관찰 가능하다. 완화책은 DApp 레이어의 relayer / 별도 지갑 사용이며 컨트랙트 범위 밖이다.

---

## 6. 위협 모델

| 위협 | landing 대응 | 대응 메커니즘 |
|---|---|---|
| Double claim (같은 upstream 을 두 번 소비) | §7, §10 Step 4 | nullifier set. 두 번째 transfer 는 ④ 에서 실패 → tx REJECTED |
| 존재하지 않는 upstream 위조 | §4 | Merkle path 가 유효 root 로 이어져야 함. tree 에 없는 commitment 는 증명 불가 |
| 남의 credential 소비 | — | nullifier 와 ownership check 모두 `ownerSecret` 필요 |
| 미인증 supplier 의 발행/전달 | §5.1 | certLeaf 멤버십 증명 실패 |
| 제재 원산지 | §5.1 | originId 가 allow-list 에 없음 → 증명 실패. 기존 credential 도 transfer 시 재검증되므로 policy 변경이 하류에 즉시 반영 |
| Issuer 가 recipient credential 추적/소비 | — | nullifier 에 ownerSecret 포함. issuer 는 commitment 는 알지만 nullifier 는 계산 불가 |
| 가짜 admin | — | `H(adminSecret) == adminId` |
| Attestation replay | — | (holder, challenge, profile) 조합당 1회 (`member` 체크) |
| Challenge 가로채기 | — | 키에 증명된 ownerId 가 포함되어 제3자의 attestation 은 다른 키에 기록됨. verifier 는 기대한 holder 의 키만 조회 |
| 오래된 attestation 재사용 | — | 값에 policyVersion 기록. verifier 가 현재 버전과 비교 |
| Witness 조작 | — | witness 는 신뢰하지 않는다. 모든 witness 값은 ledger 값(root, set, threshold) 에 대한 constraint 로 검증된다 |
| Front-running | — | transfer 는 ownerSecret 없이 재현 불가. attestation 은 challenge 에 묶여 있어 가로채도 의미 없음 |

---

## 7. 데모 시퀀스 (landing §10)

```text
Admin      certifyOrigin(originX)            policyVersion=1
Admin      certifySupplier(mineId,  certA)   policyVersion=2
Admin      certifySupplier(refId,   certB)   policyVersion=3
Admin      certifySupplier(bmId,    certC)   policyVersion=4   (attest 에 holder 인증 필요)
Admin      setCarbonThreshold(5)             policyVersion=5
각 참여자  registerEncKey(pk)                 (policyVersion 불변)

Mine       issueProvenance()
           witness: to=refId, origin=originX, carbon=3, batch=s1
           entry = seal(refinerPk, {originX, material, 3, s1, cA})
           → cA inserted, inbox[0] = entry    [public: cA, entry]
Refiner    scanInbox(): inbox[0] 복호화 성공 → commitment 재계산 = cA ∈ tree → held = A

Refiner    transferProvenance()
           witness: ownerSecret=refSecret, cred=A, path(cA), to=bmId, carbon=4, batch=s2
           ① cA ∈ tree ② refiner certified ③ originX certified ④ nA ∉ nullifiers
           entry = seal(bmPk, {…, s2, cB})
           → nA inserted, cB inserted, inbox[1] = entry   [public: nA, cB, entry]
BatteryMfr scanInbox(): inbox[0] 실패(남의 것), inbox[1] 성공 → held = B

BatteryMfr attestConsumer(ch1)      → attestations[H(ch1,bmId,1)] = {1, v5}
BatteryMfr attestProcurement(ch2)   → attestations[H(ch2,bmId,2)] = {2, v5}   (4 ≤ 5)
BatteryMfr attestRegulator(ch3)     → attestations[H(ch3,bmId,3)] = {3, v5}   [public: nB]

Refiner    transferProvenance()  (같은 cred=A 재사용)
           ④ nA ∈ nullifiers → assert 실패 → REJECTED, ledger 불변
```

OEM 화면 (landing Step 3) 매핑:

| 화면 | 근거 |
|---|---|
| Responsible sourcing ✓ | attest profile ≥ 1 (origin certified) |
| Valid chain of custody ✓ | tree membership (issue 와 transfer 가 각각 검증한 결과의 누적) |
| Restricted source ✗ | origin certified = allow-list 포함 |
| Duplicate claim ✗ | 모든 attest profile 이 증명에 쓴 credential 을 소비하고 새 secret 으로 재발행 (rotate-on-attest, §9) |

---

## 8. 한계와 확장

| 항목 | MVP | 확장 |
|---|---|---|
| Restricted source | allow-list 멤버십 | sorted Merkle tree non-membership 또는 accumulator 로 deny-list |
| Revocation | allow-list 재게시 | `revoked: Set` + 소비 시 non-membership (nullifier 처럼 disclosed 검사) |
| Quantity conservation (landing §7) | credential 1:1 transfer | 1:N split: `quantity` 를 commitment 에 넣고 `Σ out ≤ in` 을 range check 로 증명, nullifier 1 → commitment N |
| Carbon 누적 | 단계별 독립 값 | upstream carbon 을 witness 로 받아 `new ≥ upstream + own` 증명 |
| Vertical 확장 (Semi / Medical) | EV 전용 attest 3종 | attest circuit 세트를 policy module 별로 추가. core circuit (issue / transfer) 은 그대로 |
| Metadata leakage (tx 제출자) | 없음 | relayer / 지갑 분리 |
| 수신 키 교체 중 전달 | 이전 비밀키로 열림 (테스트 없음) | 교체 시 이전 비밀키 보관 안내 |

---

## 9. 검증된 구현

위 스펙을 실제로 구현하고, 컴파일러 업그레이드 후 시뮬레이터에서 실행까지 확인한 결과다. 코드는 `contract/` 에 있다.

| 항목 | 값 |
|---|---|
| Compact compiler | **0.31.1** (`compact compile +0.31.1` 로 고정). 처음엔 0.34.0 으로 빌드했으나 §9.6 의 이유로 안정 세대로 이동 |
| Compact language version | 0.23.0 (`pragma language_version >= 0.23`) |
| `@midnight-ntwrk/compact-runtime` | 0.16.0 (ledger-v8 8.1.0, midnight-js 4.1.1, wallet-sdk-facade 4.1.0 과 같은 세대) |
| 컨트랙트 | [contract/src/veilance.compact](contract/src/veilance.compact) |
| witness | [contract/src/witnesses.ts](contract/src/witnesses.ts) |
| 테스트 | [contract/test/demo.test.ts](contract/test/demo.test.ts) (27 tests, 전부 통과) |
| 구현 노트 / 보안 감사 | [contract/NOTES.md](contract/NOTES.md) |

실행:

```bash
cd contract
npm install
npm run compile      # --skip-zk, ~1s
npm test             # vitest, 27 passed
npm run compile:zk   # 전체 ZK 빌드, ~76s, 회로별 prover/verifier key 생성
npm run e2e:dry-run  # 네트워크 없이 지갑·봉인·프로바이더 구성 확인
npm run e2e          # 로컬 devnet 필요 (contract/e2e/README.md)
```

### 9.1 파일 구조

```text
contract/
├── src/veilance.compact     컨트랙트 (ledger 11 필드, witness 11개, pure circuit 5개, export circuit 9개)
├── src/witnesses.ts         witness 구현 + VeilancePrivateState
├── src/sealed-entry.ts      X25519 봉인 / 개봉 / inbox 스캔 헬퍼
├── test/network.ts          multi-party 시뮬레이터 (compact-runtime 위)
└── test/demo.test.ts        데모 4단계 + 공격 + negative case
```

### 9.2 스펙 대비 변경점

| # | 변경 | 이유 |
|---|---|---|
| D-1 | `assert` 안의 witness 비교식에는 `disclose()` 를 쓰지 않음 | 0.34.0 에서 `assert` 는 disclosure boundary 가 아니다. ledger 쓰기, export circuit 반환값, `checkRoot` 인자만 boundary. 각 사이트를 삭제·재컴파일로 확인. 최종 `disclose()` 17곳 모두 주석으로 근거 명시 |
| D-2 | path witness (`certPath`, `originPath`, `commitmentPath`) 는 인자 없음 | leaf 자체가 private 데이터에서 유도되므로 TS 쪽에서 계산. 대신 circuit 이 `path.leaf == 기대값` 으로 바인딩해 남의 path 사용을 차단 |
| D-3 | restricted source = allow-list 멤버십 | 스펙대로. 미인증 origin 과 제재 origin 은 구분되지 않음 |
| D-4 | `HistoricMerkleTree<16>` 사용 | `MerkleTree.checkRoot` 는 현재 root 만 허용. transfer 가 자기 증명 대상 tree 에 insert 하므로 historic 이 필수 |
| D-5 | 데모에서 Battery Manufacturer 도 certifySupplier | `attestProcurement` / `attestRegulator` 가 holder 인증을 요구하므로 스펙 데모 스크립트로는 통과 불가. 컨트랙트는 그대로 |
| D-6 | `carbonClass` 는 `(Uint<8> as Field) as Bytes<32>` 로 패킹 | commitment 를 `Vector<6, Bytes<32>>` 단일 해시로 유지 |
| D-7 | profile code 는 `enum VerifierProfile` 로 명명 후 `Uint<8>` 저장 | 1/2/3 을 한 곳에서 정의 |
| D-8 | **추가 제약**: `newCarbonClass >= cred.carbonClass` | 아래 S-2. 없으면 holder 가 매 hop 마다 등급을 0 으로 초기화 가능 |
| D-9 | 미구현: revocation, quantity conservation, policyVersion 핀 | §8 확장 항목. origin / supplier 는 매 transfer·attest 마다 현재 allow-list 로 재검증되므로 policy 변경은 즉시 하류에 반영됨 |

설계의 근거가 된 stdlib 동작 3가지는 별도 최소 컨트랙트로 컴파일·실행해 확인했다 (컴파일러 0.34.0).

| 근거 | 확인 방법 | 결과 |
|---|---|---|
| D-4: `HistoricMerkleTree.checkRoot` 는 이전 root 로 만든 path 를 받아주고, `MerkleTree.checkRoot` 는 현재 root 만 받음 | leaf A 삽입 → path 저장 → leaf B 삽입 → 저장한 path 로 검증 | plain: 실패, historic: 통과 |
| `insert()` ↔ `merkleTreePathRoot` 짝이 맞고, `insertHash()` ↔ `merkleTreePathRootNoLeafHash` 와 섞으면 검증 실패 | 4가지 조합 실행 | 맞는 짝 2개 통과, 교차 2개 실패. TS 의 `findPathForLeaf` 는 `insert()` 짝에만 동작 |
| D-1: `assert` 는 disclosure boundary 가 아니고, ledger 연산·export 반환·`checkRoot` 인자는 boundary | `disclose()` 없는 assert 컨트랙트 컴파일 성공, ledger insert / checkRoot / return 은 컴파일 실패 후 `disclose()` 추가 시 성공 | 확인 |

### 9.2.1 v2 변경 (holder 바인딩 attestation, policyVersion 기록)

| 변경 | 내용 | 검증 |
|---|---|---|
| attestation 키 | raw challenge → `attestationKeyOf(challenge, cred.ownerId, profile)` (도메인 `veilance:att`). pure circuit 으로 export 해 TS 에서 재계산 | 테스트: 두 holder 가 같은 challenge 에 답하면 독립된 두 레코드. 같은 holder·challenge·profile 재사용은 거부, 다른 profile 은 허용 |
| attestation 값 | `Uint<8>` → `struct Attestation { profile: Uint<8>; policyVersion: Uint<64> }`. `Counter.read()` 가 회로 안에서 동작해 struct 에 넣을 수 있음을 최소 컨트랙트로 확인 | 테스트: 증명 후 admin 이 정책을 바꿔도 저장된 버전은 증명 당시 값 |
| disclosure | `disclose()` 17 → 16. challenge 의 member/insert 2곳 제거, key 1곳 추가. export circuit 의 파라미터도 witness 취급이므로 raw challenge 는 transcript 에서 사라짐 | 컴파일러의 disclosure 경로 메시지로 확인 |
| 비용 | `attestRegulator` prover key 9.6 MB → 19 MB (해시 1회 추가로 PLONK 크기 경계 초과). Consumer / Procurement 는 변화 없음 | 전체 ZK 빌드 |
| 테스트 | 16 → 20 통과 | |

### 9.2.2 v3 변경 (온체인 암호화 inbox)

| 변경 | 내용 | 검증 |
|---|---|---|
| ledger | `partyEncKeys: Map<Bytes<32>, Bytes<32>>`, `credentialInbox: Map<Uint<64>, Bytes<192>>`, `credentialInboxCount: Counter` 추가 | 컴파일 |
| circuit | `registerEncKey(encPk)` 추가. `issueProvenance` / `transferProvenance` 가 `entry: Bytes<192>` 인자를 받아 tree insert 와 같은 tx 에서 inbox 에 기록 (`deliverSealedEntry`) | 테스트: 거부된 호출은 inbox 도 불변 |
| 봉인 헬퍼 | [contract/src/sealed-entry.ts](contract/src/sealed-entry.ts): X25519(ephemeral) + HKDF-SHA256 (salt = ephPk‖recipientPk, info = `veilance:credential:v1`) + AES-256-GCM (AAD = ver‖suite). 평문 129byte, 컨테이너 192byte. `openCredential` 은 실패 시 throw 대신 null | 테스트: 수신자만 열림, 송신자 본인도 못 염 |
| 스캔 | `scanInbox(ledger, encSk, myPartyId, fromIndex)`: AEAD 성공 + `commitmentOf(ownerId=나, …)` == 내장 commitment + tree 에 존재, 3중 검사 | 테스트: 체인 데이터만으로 credential 복구, 로컬 유실 후 index 0 부터 재스캔 복구, tree 에 없는 정합 entry 는 폐기 |
| 미검증 entry | 컨트랙트는 entry 를 검증하지 않음. 발행자가 쓰레기를 넣으면 commitment 는 들어가지만 아무도 소비 못 함 (가치 생성 없음) | 테스트: garbage entry |
| 비용 | `issueProvenance` 9.6 MB, `transferProvenance` 19 MB — **변화 없음** (entry 는 해시·비교 없이 ledger 셀로 직행). `registerEncKey` 2.7 MB 신규 | 전체 ZK 빌드, 9 circuit |
| 테스트 | 20 → 27 통과 | |

### 9.3 보안 감사 결과 (`midnight-security` 체크리스트)

| # | 심각도 | 내용 | 상태 |
|---|---|---|---|
| S-1 | MEDIUM | commitment 의 hiding 은 전적으로 `batchSecret` 에 의존. 나머지 필드(ownerId, originId, carbonClass, materialType) 는 열거 가능한 값 공간 | 수용. **batchSecret 은 반드시 128bit 이상 CSPRNG**. DApp 레이어 책임. 대안: `persistentCommit` |
| S-2 | HIGH | holder 가 transfer 시 carbonClass 를 낮춰 재발행 가능 → procurement predicate 무력화 | **수정** (D-8). 테스트로 회귀 방지 |
| S-3 | HIGH | witness 를 두 번 호출하면 검사용 값과 커밋용 값이 다를 수 있음 | **수정**. 모든 witness 를 `const` 로 1회 바인딩. 테스트 "witness that changes its answer" 로 확인 |
| S-4 | MEDIUM | (이전) `attestRegulator` 가 소비하지 않는 credential 의 nullifier 를 공개 → 이후 transfer 와 연결 | **수정** (rotate-on-attest, §9). 공개된 nullifier 의 credential 은 같은 tx 에서 소멸하므로 다시 나타나지 않음 |
| S-5 | MEDIUM | (이전) `attestConsumer` / `attestProcurement` 가 이미 소비된 credential 도 통과 | **수정** (rotate-on-attest, §9). 테스트 "every profile rejects a consumed credential" |
| S-6 | LOW | `HistoricMerkleTree.checkRoot` 는 어느 root 로 증명했는지 공개 → 오래된 root 사용 시 생성 시점 유추 가능 | witness 구현이 항상 현재 tree 로 path 생성 |
| S-7 | LOW | anonymity set = tree 의 leaf 수. 초기 참여자는 익명성 약함 | 구조적 한계 |
| S-8 | LOW | admin rotation 불가 (`sealed`), revocation 불가, tree 용량 미검사 (256 / 256 / 65536) | 프로덕션 전 필요 |
| S-9 | LOW | 어느 circuit 을 호출했는지는 공개 | Midnight 구조상 불가피 |
| S-11 | INFO | 생성된 TS 타입에서 Merkle path 는 길이 미지정 배열이라 tree depth (8 / 16) 가 타입으로 강제되지 않음. `witnesses.ts` 의 depth 상수는 수동 유지 | `.compact` 의 depth 변경 시 컴파일은 통과하고 proving 시점에만 실패. 상수 동기화 주석으로 표시 |
| S-10 | INFO | `recipientId` 무제약. 자기 자신에게 transfer 해 재익명화 가능 | 가치 생성은 없음 (1:1 nullify). quantity conservation 확장 시 재검토 |

별도 witness 검증 (midnight-verify witness-verifier): 선언 11개 ↔ 구현 11개 이름 일치, 반환 tuple 형태 타입 검사 통과 (strict 검사 포함), private state 불변, 부작용 없음, 8개 circuit 전부 실행하며 11개 witness 모두 호출됨. 결과 Confirmed. 단 `--skip-zk` 실행이라 실제 증명 생성은 `npm run compile:zk` 의 key 생성까지만 확인했고, devnet E2E 는 미실행.

통과 항목: 도메인 분리 4종 (`veilance:id/cert/cm/nf`), 모두 `persistentHash`, 모든 witness 출력이 ledger 값에 대한 constraint 로 검증됨, circuit 인자로 민감값 없음, challenge 1회용, 실패 tx 는 ledger 를 바꾸지 않음 (테스트에서 public state 스냅샷 비교).

### 9.4 회로 비용 (prover key 크기 기준)

| circuit | prover key | 지배 항 |
|---|---|---|
| `setCarbonThreshold`, `certifyOrigin`, `registerEncKey` | 2.7 MB | 해시 1회 |
| `certifySupplier` | 5.0 MB | + certLeaf 해시 |
| `issueProvenance` | 9.6 MB | Merkle path 2개 (depth 8 + 8) |
| `attestConsumer/Procurement` | 9.6 MB | Merkle path 2개 (depth 16 + 8) |
| `attestRegulator` | 19 MB | + attestation key 해시로 PLONK 크기 경계 초과 |
| `transferProvenance` | 19 MB | Merkle path 3개 (depth 16 + 8 + 8) |

Merkle path 검증이 비용을 지배한다. tree depth 를 줄이면 비용은 내려가지만 용량과 anonymity set 이 함께 줄어든다.

### 9.5 툴체인 세대 결정 (devnet E2E 준비 중 발견)

| | 차세대 (처음 빌드) | 안정 세대 (최종) |
|---|---|---|
| Compact compiler | 0.34.0 (language 0.26) | **0.31.1** (language 0.23) |
| compact-runtime | 0.19.0 → `@midnightntwrk/onchain-runtime-v4`, ledger-v9 | **0.16.0** → onchain-runtime-v3, ledger-v8 8.1.0 |
| midnight-js | 5.0.0-beta.7 만 호환 | **4.1.1** (npm latest) |
| wallet SDK | facade 5.0.0-beta.3 | **facade 4.1.0** |
| proof server 이미지 | 9.0.0-rc.* 만 존재 | **8.1.0** |
| node / indexer 이미지 | 로컬 devnet 용 검증된 태그 없음 | **0.22.5 / 4.2.1** (devnet 스킬 기본값) |
| 공식 지원 매트릭스 (Preview/Preprod/Mainnet) | 해당 없음 | 이 조합 |

컨트랙트는 pragma 한 줄만 낮추고 그대로 컴파일된다. prover key 크기도 두 컴파일러에서 바이트 단위로 동일하다. 시뮬레이터 하네스(`test/network.ts`)만 `createCircuitContext` 시그니처와 `CircuitResults.context` 형태 차이로 두 곳 수정했고, witness 와 컨트랙트는 무변경. "assert 는 disclosure boundary 가 아니다" (D-1) 는 0.31.1 에서도 삭제·재컴파일 실험으로 동일하게 확인했다.

### 9.6 devnet E2E 준비 상태

| 항목 | 상태 |
|---|---|
| devnet compose | `~/.midnight-expert/devnet/devnet.yml` 생성 (node 0.22.5 / indexer 4.2.1 / proof-server 8.1.0, network `undeployed`) |
| E2E 스크립트 | [contract/e2e/run.ts](contract/e2e/run.ts): health check → 지갑 4개 + DUST → 배포 → registerEncKey ×4 → 정책 4건 → 발행 → inbox 스캔 → 전달 → 스캔 → attest ×3 → 재사용 공격 실패 확인 → indexer 로 최종 ledger 검증 → circuit 별 시간 리포트 |
| 네트워크 없이 검증됨 | tsc, 27 tests, dry-run (키 유도, 봉인 왕복, 프로바이더 구성, verifier key 무결성) |
| **devnet 실행 결과 (2026-09-09)** | 전 과정 통과. 배포 tx `d3c193e9…3f81` (block 796), 컨트랙트 `8ba7edf8…e131`. 최종 ledger: tree leaf 2, nullifier 1, attestation 3, inbox 2, encKeys 4. 재사용 공격은 로컬 회로 실행 단계에서 `credential already consumed` assert 로 거부되어 tx 자체가 제출되지 않음 |

실측 시간 (WSL2, 4 core, proof server 8.1.0, 실제 PLONK 증명 생성 포함, 지갑 balancing + 제출 + 블록 확정까지):

| circuit | 총 소요 |
|---|---|
| deploy | 21.7 s |
| `certifyOrigin` / `certifySupplier` / `setCarbonThreshold` | 17 – 24 s |
| `registerEncKey` | 17 – 19 s |
| `issueProvenance` | 30.5 s |
| `transferProvenance` | **41.2 s** (가장 무거움, Merkle path 3개) |
| `attestConsumer` | 23.9 s |
| `attestProcurement` | 29.5 s |
| `attestRegulator` | 30.7 s |

proof server 최대 메모리 사용량 약 2.1 GB. 데모 흐름(Step 1 발행 → Step 2 전달 → Step 3 attest 3종 → Step 4 공격)만 따지면 순차 실행 시 약 2.5 분이며, 정책 등록과 키 등록은 데모 전에 미리 끝내 두어야 한다.

devnet 에서 실제로 겪고 고친 통합 이슈 (모두 `contract/e2e/` 에 반영):

| 증상 | 원인 | 조치 |
|---|---|---|
| `Wallet.InsufficientFunds` | 참여자당 지급액이 genesis 잔액(2.5e14)의 200배 | 4e13 으로 조정, 재실행 시 이미 자금 있는 지갑은 건너뜀 |
| node error 192 `InputsSignaturesLengthMismatch` | unshielded 전송 recipe 를 서명 없이 제출 | `signRecipe` 단계 추가 |
| `expected instance of StateValue` | `onchain-runtime-v3` 가 3.1.1 과 3.0.0 두 벌 로드되어 WASM 클래스 불일치 | package.json `overrides` 로 3.0.0 단일화 |

### 9.6.1 Midnight Preprod (공개 테스트넷) 실행 결과 (2026-09-10)

| 항목 | 값 |
|---|---|
| 네트워크 | `preprod` (rpc / indexer `*.preprod.midnight.network`), 로컬 proof server 8.1.0 |
| 컨트랙트 | `aef192434994a76b50fde29683420943c4b04c7cd03caa2c0cf67138d9aa2348` — https://preprod.midnightexplorer.com/contracts/aef192434994a76b50fde29683420943c4b04c7cd03caa2c0cf67138d9aa2348 |
| 배포 tx | `aceb3153…c08f`, block 2,484,901, 32 s |
| 정책·키 등록 9 tx | 전부 확정 (block 2,484,913 ~ 2,484,951) |
| 발행 / 전달 / 증명 | 40 s / 38 s / 36 s (증명 + balancing + 제출 + 확정) |
| 재사용 공격 | 컨트랙트 거부 1.9 s (`credential already consumed`) |
| 최종 ledger | leaf 2, nullifier 1, attestation 1, inbox 2, policy v5 |

툴체인은 변경 없음 (Preprod 지원 매트릭스 = Compact 0.31.1 / compact-runtime 0.16.0 / midnight-js 4.1.1 / proof-server 8.1.0). 운영상 배운 것: 공개망에서 새 지갑의 첫 동기화는 DUST 이벤트 약 150만 개를 초당 약 150개로 처리해 **지갑당 약 3시간**이 걸린다. 그래서 지갑 상태를 디스크에 저장해 재시작 시 복원하고, 공개망에서는 4개 기업이 수수료 지갑 하나를 공유한다 (`VEILANCE_SHARED_FEE_WALLET`). 기업 신원은 witness 비밀이므로 프로토콜에는 영향이 없다.

### 9.7 테스트 목록

```text
Veilance demo
  ✓ deploys with the deployer's pseudonymous id as admin
  ✓ step 1 — admin registers the supply chain policy
  ✓ rejects a non-admin trying to change policy
  ✓ step 2 — the Mine issues a cobalt credential to the Refiner
  ✓ step 3 — the Refiner transforms it and passes it to the Battery Manufacturer
  ✓ step 4 — the Battery Manufacturer proves policy to three verifier profiles
  ✓ rejects a replayed verifier challenge
  ✓ step 5 — ATTACK: the Refiner replays the already-consumed credential
  ✓ selective disclosure — procurement fails once the carbon threshold drops below the (private) class
Veilance negative cases
  ✓ an uncertified party cannot issue provenance
  ✓ a certified supplier cannot issue provenance for an uncertified origin
  ✓ a party cannot spend a credential it does not own
  ✓ carbon class may not be reset downwards across a transfer
  ✓ KNOWN LIMITATION: a consumed credential still passes the consumer profile
  ✓ a witness that changes its answer between calls cannot split check from commit
  ✓ a credential that was never issued cannot be transferred
```

---

## 9. Rotate-on-attest

모든 attest circuit(`attestConsumer` / `attestProcurement` / `attestRegulator`)은 조건 검사 후 같은 tx 안에서

1. 증명에 쓴 credential 의 nullifier 가 `nullifiers` 에 없는지 확인하고 추가해 **소비**한다.
2. owner·origin·material·carbonClass 를 그대로 두고 새 `batchSecret` 으로 만든 commitment 를 `provenanceTree` 에 **재발행**한다. 필드는 회로가 고정하므로 재발행으로 credential 이 좋아질 수 없다.
3. attestation 을 기록하고 `[nullifier, rotatedCommitment]` 를 반환한다.

효과:

| 성질 | 이전 | 이후 |
|---|---|---|
| 이미 전달한 credential 로 증명 | consumer/procurement 통과 (S-5) | 모든 profile 거부 |
| 증명 ↔ 이후 transfer 연결 | regulator 증명의 nullifier 가 transfer 때 다시 공개되어 연결 (S-4) | 공개된 nullifier 의 credential 은 소멸. 이후 transfer 는 재발행된 credential 의 다른 nullifier 를 공개 → 연결 불가 |
| 공개 항목 | attestation key (+ regulator 는 nullifier) | attestation key, nullifier, 재발행 commitment |

비용: 증명마다 `provenanceTree` leaf 1개와 nullifier 1개가 늘어난다(트리 용량 65 536). 같은 credential 로 동시에 두 증명을 제출하면 하나는 거부된다(에이전트 job 큐는 순차). regulator profile 은 이제 procurement 와 같은 검사를 하고 기록되는 profile 코드만 다르다.

에이전트: credential 의 `id` 는 처음 받은 commitment 로 고정하고, 현재 commitment·secret 과 회전 이력(`rotations`)을 vault 에 따로 둔다. 새 secret 은 tx 전에 `pendingBatchSecret` 으로 디스크에 먼저 기록하고, 다음 작업 때 그 commitment 가 체인에 있으면 채택한다(`settlePendingRotation`). 회로가 바뀌어 verifier key 가 달라지므로 컨트랙트 재배포가 필요하다.

