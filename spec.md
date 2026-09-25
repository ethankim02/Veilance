# 🛡️ Veilance 기능명세서 (v1)

이 문서는 landing.md §9 의 48시간 MVP 범위(Mine → Refiner → Battery Manufacturer, Circuit 3종)에 대한 상세 명세입니다.
Semiconductor / Medical Device 확장과 quantity conservation 은 추후 별도 명세 추가 예정.

**작성: Veilance 팀 · 최종 수정: 2026-09-04 · 관련 문서: [landing.md](landing.md), [ERD.md](ERD.md), [CONTRACT_DESIGN.md](CONTRACT_DESIGN.md)**

---

### 📋 문서 사용법

- **유저 스토리**: "누가, 무엇을, 왜 하는지" 한 줄 요약
- **화면 구성**: 라우트 단위 영역 / 구성요소. 🔒 표시는 해당 값이 화면에만 있고 온체인에 올라가지 않는다는 뜻
- **기능 요구사항(FR)**: 구현 단위. `circuit` 열은 호출하는 컨트랙트 circuit (없으면 off-chain)
- **데이터 요구사항**: 어느 레이어에 무엇이 저장되는지. L1 = Midnight ledger, L2 = 참여자 로컬 private state, L3 = 앱 DB (ERD.md 기준)
- **엣지케이스**: 정상 흐름 외에 처리해야 할 상황. 컨트랙트 테스트로 이미 보장되는 항목은 ✅ 표시
- **❓ 미정**: 디자인 / 기획 확정 필요

### 🏗️ 배치 결정 (2026-09-09, DApp 착수 시)

| 구성 | 내용 |
|---|---|
| **Party Agent** (`agent/`) | 기업별로 실행하는 Node 서비스. partySecret, X25519 비밀키, 지갑, private state provider(level), midnight-js provider 를 보유하고 컨트랙트를 호출한다. 데모에서는 한 프로세스가 4개 party 를 호스팅하고, 프로덕션에서는 기업당 하나 |
| **Web UI** (`web/`) | 브라우저 앱. Party Agent 의 HTTP API (`agent/API.md`) 만 호출한다. 지갑·키·private state 를 갖지 않는다 |
| **Verifier** | 지갑 없이 UI 의 검증 페이지만 사용. attestation 조회는 public ledger 읽기 |

근거: 데모는 한 사람이 4개 역할을 오가며 circuit 당 20~45초 걸리는 증명을 시연한다. 브라우저 확장 지갑 4개를 로컬 devnet 에 연결하는 방식은 시연 리스크가 크고, 기업 공급망 시스템에서 키와 private state 를 기업 서버에 두는 배치가 오히려 자연스럽다. devnet 에서 검증된 `contract/e2e/lib` 코드를 그대로 재사용한다. 이에 따라 §0 의 "브라우저 IndexedDB 저장" 은 "Party Agent 의 level provider 저장" 으로 바뀐다. 저장 방식(levelPrivateStateProvider + export/import 백업) 자체는 동일하고, 위치만 브라우저에서 agent 로 이동한다. Lace 연결 경로는 UI 의 API 추상화 뒤에 남겨 둔다.

### 🖥️ 화면 구조 v2 (2026-09-09, 개편 결정)

v1 은 폼 페이지 9개로 구성된 프로토콜 콘솔이었고, 글이 많고 복잡하다는 피드백을 받았다. 실제 공급망 담당자는 lot/batch 의 흐름, 파트너, 인증·준수 상태를 보고, 암호학적 세부는 "증빙" 을 열었을 때만 본다. v2 는 그 관점으로 뒤집는다.

| 표면 | 내용 |
|---|---|
| **공급망 캔버스** (`/`, 유일한 메인 화면) | 노드 = 기업 (Mine → Refiner → Battery Mfr → Verifier/OEM, Admin 은 작게 별도), 간선 = batch 이동 (`GET /graph`). 간선 라벨은 재료와 상태 (ISSUED → DELIVERED → CONSUMED). attestation 은 holder 노드 아래 배지 |
| **전역 상태 바** (항상 표시) | 추상 상태만: "Idle" / "Proving: transferProvenance (EuroRefine → VoltCell) · 23 s" + 진행 바 + 경과 초, 큐 길이, chain tip 높이, policy chip, 컨트랙트 short-hash (→ explorer) |
| **상세 드로어** (노드·간선 클릭) | 노드 → 기업 정보 + 그 기업의 액션 폼 (발행 / 스캔 / 전달 / 증명 / 정책). 간선 → batch 의 상태 타임라인 (각 단계 tx 링크) + 접힌 "Proof evidence" (commitment, nullifier, inbox index) + 접힌 disclosure preview. job 진행 stepper 는 드로어 안에서 |
| **Explorer 패널** (`/explorer`, 모든 해시에서 모달로) | Contract / Transaction / Block 탭. agent 가 indexer 를 프록시하는 `GET /explorer/*` 로 실제 체인 데이터를 보여줌. `VITE_EXPLORER_URL_TEMPLATE` 설정 시 외부 explorer 링크 병행 |
| **Presenter 오버레이** (`/demo`) | 다음에 클릭할 노드·간선을 하이라이트. 단계당 한 줄 |

**v3 (같은 날 재개편)**: v2 도 여전히 복잡하다는 피드백으로, 역할 스위처·데모 버튼·presenter·설명문을 전부 제거하고 단일 화면(지도 + 상태 바 + 드로어 + explorer 모달)으로 재정의했다. 용어도 운영자 언어로 통일한다 (credential → Lot, attestation → Compliance proof, challenge → Request proof). 확정 스펙은 [web/UX_V3.md](web/UX_V3.md) 이며 이 문서의 §0~§4 화면 구성 표는 v1 기록으로만 남긴다.

원칙: 기본 화면의 글자량은 v1 의 1/3 이하. 버튼은 동사, 카드는 명사. 설명은 "i" 아이콘이나 드로어의 접힌 섹션에만. v1 의 페이지들은 드로어에서 "advanced" 로만 도달하거나 삭제.

로컬 devnet 에는 호스팅 explorer 가 없으므로 agent 가 indexer GraphQL 을 프록시한다 (`agent/API.md` v1.1 addendum). preview / mainnet 배포 시 외부 explorer URL 템플릿으로 전환한다.

### 👥 역할

| 역할 | 데모 참여자 | 할 수 있는 것 |
|---|---|---|
| Admin | 정책 관리자 (규제기관 / 컨소시엄) | 인증 origin·supplier 등록, carbon threshold 설정 |
| Root Issuer | Mine | credential 발행 |
| Holder | Refiner, Battery Manufacturer | credential 전달·변환, 정책 attestation |
| Verifier | OEM, Consumer, Regulator | challenge 발급, attestation 결과 조회. 지갑 불필요 |

---

## 0. 🔑 참여자 온보딩 (공통)

### 0.1 유저 스토리

- **모든 참여자**로서, 지갑을 연결하고 나의 pseudonymous id 를 만들어 공급망에 참여하고 싶다
- **참여자**로서, 내 partyId 를 Admin 에게 전달해 인증받고 싶다 (실명은 온체인에 남지 않게)
- **참여자**로서, 내 private state 가 유실되면 credential 을 잃는다는 것을 명확히 안내받고 싶다

### 0.2 화면 구성

### 0.2.1 온보딩 화면 (`/onboarding`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| 지갑 연결 | Midnight 지갑 연결 버튼, 연결 상태 | ❓ 지갑 종류 미정 (§0.6) |
| 역할 선택 | Admin / Mine / Refiner / Battery Manufacturer / Verifier | 데모용. 실제로는 Admin 인증으로 결정 |
| 조직 정보 | 조직명, 역할 | L3 에만 저장, 온체인 미기록 |
| 저장소 잠금 | private state 암호 입력 (16자 이상, 4종 중 3종 문자) | SDK `levelPrivateStateProvider` 의 비밀번호 정책 |
| 신원 생성 | "partySecret 생성" 버튼 → partyId 표시 + 복사 | 🔒 `crypto.getRandomValues` 32byte. 화면 표시 안 함 |
| 수신 키 등록 | X25519 키쌍 생성 → 공개키를 온체인 등록하는 tx | 🔒 비밀키는 private state. credential 수신에 필요 |
| 백업 강제 | "암호화 백업 다운로드" 버튼. 완료 전 "계속" 비활성 | `exportPrivateStates` 결과 JSON |
| 안내 | ① 이 브라우저의 IndexedDB 에 암호화 저장됨, 사이트 데이터 삭제·다른 기기에서는 사라짐 ② 지갑 시드는 이 값을 백업하지 않음 ③ credential 을 받을 때마다 백업을 다시 받을 것 |  |
| 복원 경로 | "백업이 있어요" → 파일 선택 + 암호 → `importPrivateStates` | 충돌 시 명시적 덮어쓰기 확인 |

### 0.2.2 대시보드 (`/`)

| 영역 | 구성요소 |
| --- | --- |
| 헤더 | 조직명, 역할 뱃지, partyId 축약 표시, 네트워크 상태 |
| 인증 상태 | certified 여부 (Admin 이 certifySupplier 했는지 ledger 에서 확인) |
| 요약 카드 | 보유 credential 수 / 소비된 credential 수 / 받은 attestation 요청 수 |
| 정책 | 현재 policyVersion, carbonThreshold |
| 바로가기 | 역할별 주요 액션 (발행 / 전달 / 검증) |

### 0.3 기능 요구사항

| ID | 기능 | 상세 | circuit |
| --- | --- | --- | --- |
| FR-O-01 | 지갑 연결 | Midnight 지갑 연결, 주소·네트워크 확인 | — |
| FR-O-02 | partySecret 생성 | `crypto.getRandomValues` 32byte. 접근은 `getPartySecret()` 하나로 감싸 추후 지갑 파생(MIP-0015) 으로 교체 가능하게 | — |
| FR-O-03 | partyId 유도 | `partyIdOf(partySecret)` 를 pure circuit 으로 로컬 계산 | `partyIdOf` (pure) |
| FR-O-04 | 조직 등록 | 조직명·역할·partyId 를 L3 에 저장 | — |
| FR-O-05 | 인증 상태 조회 | `certifiedSuppliers` tree 에서 내 certLeaf 존재 여부 확인 | — (ledger read) |
| FR-O-06 | private state 백업 / 복원 | `exportPrivateStates({password})` JSON 다운로드, `importPrivateStates(json, {password, conflictStrategy:'error'})` 복원. 온보딩 직후와 credential 변경 후 재백업 유도 | — |
| FR-O-07 | private state 저장소 | `levelPrivateStateProvider` (브라우저에서 IndexedDB, AES-256-GCM). 스킬 예제의 in-memory provider 사용 금지 | — |
| FR-O-08 | 저장소 잠금 해제 | 세션 시작 시 사용자 암호 입력, 메모리에만 보관 | — |
| FR-O-09 | 수신 키 등록 | X25519 키쌍 생성(비밀키는 private state), 공개키를 `partyEncKeys[partyId]` 에 등록. ownerSecret 증명으로 본인 partyId 에만 등록 가능 | `registerEncKey` |

### 0.4 데이터 요구사항

**L2 (로컬)** — `VeilancePrivateState`, `levelPrivateStateProvider` 에 `privateStateId='veilancePrivateState'`, `setContractAddress(veilance)` 로 스코프

- partySecret 🔒, encSecretKey 🔒 (X25519), certId, held (보유 credential), issueSpec, recipientId, newCarbonClass, newBatchSecret, lastSeenInboxIndex
- `accountId` = 지갑 주소 (SDK 가 SHA-256 으로 스코프), 비밀번호 = 사용자 입력 (공개키 기반 비밀번호 금지)

**L3** — `ORGANIZATION`

- id, name, midnight_address, party_id, role_id, status, created_at

### 0.5 엣지케이스

- 같은 브라우저에서 partySecret 을 다시 생성 → 기존 credential 접근 불가. 재생성 전 경고 + 백업 강제
- 백업 시점 이후 받은 credential 은 백업에 없음 → credential 변경 시 "백업 갱신" 배지 표시
- partySecret 은 있으나 held 가 유실됨 → 발행자 로컬 이력에서 전달 패키지 재생성으로 복구 (§2.5). 발행자도 유실했으면 복구 불가
- 지갑(Lace / 1AM) 시드 복원 → Veilance 상태는 복원되지 않음. 온보딩 안내 ② 로 명시
- 지갑은 연결됐지만 partySecret 이 없는 상태 → 모든 액션 버튼 비활성화, 온보딩으로 유도
- 인증 전 상태에서 발행 / 전달 시도 → UI 에서 사전 차단 (컨트랙트도 거부하지만 실패 tx 는 DUST 낭비)
- partyId 를 Admin 에게 전달하는 채널 → ❓ 미정 (§0.6)

### 0.6 ❓ 미정 사항

- [x]  partySecret 저장 방식 → **확정: `levelPrivateStateProvider` (암호화 IndexedDB) + 사용자 암호 + export/import 백업.** 지갑 파생은 현재 불가: DApp Connector 의 `signData` 는 서명이 매 호출 무작위(ledger `signData` 가 `OsRng` 사용)라 결정적 파생이 안 되고, Lace 는 `signData` 자체를 구현하지 않음. 결정적 파생을 위한 `deriveSecret` 은 MIP-0015 로 제안 단계(2026-08-18). 근거: midnight-js `level-private-state-provider` README, docs `guides/deploy-and-operate`, `guides/security-best-practices`, dapp-connector `SPECIFICATION.md`, MIP-0015
- [ ]  지갑: Lace vs 1AM (dust-free) vs 데모용 내장 키 — 1AM 의 `signData` 지원 여부는 문서에 없음. 어느 쪽이든 위 결정은 동일
- [ ]  partyId ↔ 실명 매핑을 어디에 두는가 (Admin 로컬 vs L3 서버)
- [ ]  데모에서 4개 역할을 한 브라우저 탭 전환으로 할지, 별도 세션으로 할지

---

## 1. ⚖️ 정책 관리 (Admin)

### 1.1 유저 스토리

- **Admin**으로서, 인증된 원산지 목록을 등록해 어떤 origin 이 허용되는지 정하고 싶다
- **Admin**으로서, 인증된 supplier (partyId + 인증서 id) 를 등록해 누가 발행·전달할 수 있는지 정하고 싶다
- **Admin**으로서, carbon threshold 를 설정해 OEM procurement predicate 의 기준을 정하고 싶다
- **모든 참여자**로서, 현재 정책 버전과 내용을 확인하고 싶다

### 1.2 화면 구성

### 1.2.1 정책 대시보드 (`/admin/policy`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| 헤더 | policyVersion, 마지막 변경 시각, "Admin 인증됨" 표시 | adminSecret 없으면 읽기 전용 |
| Carbon threshold | 현재 값 + 수정 폼 (0~255) |  |
| 인증 origin | 목록 (originId, 표시명 🔒, 등록일) + "origin 추가" | 표시명은 L3 에만 |
| 인증 supplier | 목록 (partyId, 조직명 🔒, certId, 등록일) + "supplier 추가" | 조직명은 L3 에만 |
| tx 히스토리 | 정책 변경 tx 목록 (circuit, 상태, block) |  |

### 1.2.2 origin 추가 모달

| 영역 | 구성요소 |
| --- | --- |
| 표시명 | 자유 텍스트 (예: "DRC Mine X") — L3 저장 |
| originId | 자동 생성 (salt 포함 32byte) 또는 직접 입력 |
| 확인 | "온체인에는 originId 해시만 기록됩니다" 안내 + 실행 버튼 |

### 1.2.3 supplier 추가 모달

| 영역 | 구성요소 |
| --- | --- |
| 조직 선택 | L3 에 등록된 조직 드롭다운 (partyId 자동 채움) 또는 partyId 직접 입력 |
| certId | 인증서 식별자 (32byte) + 인증 종류 표시명 🔒 |
| 확인 | 실행 버튼 |

### 1.3 기능 요구사항

| ID | 기능 | 상세 | circuit |
| --- | --- | --- | --- |
| FR-P-01 | 컨트랙트 배포 | Admin 이 adminSecret 으로 배포, adminId 고정 (sealed) | constructor |
| FR-P-02 | origin 인증 등록 | originId 를 certifiedOrigins tree 에 삽입, policyVersion +1 | `certifyOrigin` |
| FR-P-03 | supplier 인증 등록 | certLeaf(partyId, certId) 삽입, policyVersion +1 | `certifySupplier` |
| FR-P-04 | carbon threshold 설정 | 값 변경, policyVersion +1 | `setCarbonThreshold` |
| FR-P-05 | 정책 조회 | ledger 에서 version / threshold / tree 상태 읽기 (모든 역할) | — |
| FR-P-06 | 정책 변경 이력 | tx 인덱스에서 circuit 별 이력 표시 | — |
| FR-P-07 | 표시명 매핑 관리 | originId·partyId 의 사람이 읽을 이름을 L3 에 저장 | — |

### 1.4 데이터 요구사항

**L1** — `adminId`, `policyVersion`, `carbonThreshold`, `certifiedOrigins`, `certifiedSuppliers`

**L3** — `POLICY_VERSION`, `RESTRICTED_SOURCE` (allow-list 로 해석), `CERTIFICATION`, `TX_RECORD`

- 표시명(origin 이름, 조직명, 인증 종류)은 전부 L3. 온체인에는 해시 / id 만

### 1.5 엣지케이스

- Admin 이 아닌 사람이 정책 circuit 호출 → ✅ 컨트랙트 거부 (테스트: rejects a non-admin)
- 같은 originId 를 두 번 등록 → tree 에 중복 leaf. 컨트랙트는 막지 않음. UI 에서 L3 조회로 사전 차단
- tree 용량 초과 (origins / suppliers 각 256) → 런타임 에러. UI 에서 잔여 슬롯 표시, 임계치 경고
- 정책 변경 중 다른 참여자가 transfer 진행 → 이미 제출된 증명은 이전 root 로 검증되므로 영향 없음 (HistoricMerkleTree). allow-list 는 현재 root 로 검증되므로 origin 이 제거된 직후 transfer 는 실패
- adminSecret 유실 → 정책 변경 영구 불가 (rotation 미지원). 배포 시 백업 강제

### 1.6 ❓ 미정 사항

- [ ]  origin 인증 취소 (revocation): allow-list 재배포 vs 컨트랙트 확장
- [ ]  originId 생성 규칙: 사전 공격 방지를 위한 salt 포함 여부와 salt 보관 주체
- [ ]  Admin 이 1명(단일 키)인지, multi-sig 형태가 필요한지
- [ ]  policyVersion 을 commitment 에 핀할지 (현재는 매 transfer 마다 현재 정책으로 재검증)

---

## 2. ⛏️ Provenance 발행 (Mine)

### 2.1 유저 스토리

- **Mine**으로서, 채굴한 원재료의 credential 을 Refiner 앞으로 발행해 공급망의 시작점을 만들고 싶다
- **Mine**으로서, 원산지·수량·계약조건 같은 정보가 온체인에 올라가지 않는다는 것을 확인하고 싶다
- **Refiner**로서, Mine 이 발행한 credential 을 내 보관함에서 받고 싶다

### 2.2 화면 구성

### 2.2.1 발행 화면 (`/issue`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| 헤더 | "Provenance 발행", 내 인증 상태 | 미인증이면 폼 비활성 |
| 수신자 | 조직 드롭다운 → recipientId 자동 채움, 또는 partyId 직접 입력 | 🔒 |
| 원산지 | 인증 origin 드롭다운 (표시명) → originId | 🔒 |
| 재료 | materialType 선택 (Cobalt / Lithium / Nickel …) | 🔒 |
| Carbon class | 0~255 입력 | 🔒 |
| 참고 정보 | quantity, 단가, 계약 메모 | 🔒 L2 메모용. MVP 컨트랙트 미포함 |
| 공개 범위 미리보기 | "온체인 공개: commitment 1개" / "비공개: 위 항목 전부" 두 열 | 데모 핵심 화면 |
| 실행 | "발행" 버튼 → tx 상태 (증명 생성 중 / 제출 / 확정) |  |

### 2.2.2 발행 완료 화면 (`/issue/[txHash]`)

| 영역 | 구성요소 |
| --- | --- |
| 결과 | commitment (축약), inbox index, block, tx 링크 |
| 안내 | "수신자가 체인을 스캔하면 자동으로 credential 을 받습니다. 별도 전달 불필요" |
| 예비 | 같은 192byte sealed entry 를 파일 / QR 로 export (수신자가 체인 스캔을 못 할 때) |

### 2.2.3 credential 수신 — 자동 (`/credentials`, 백그라운드)

| 단계 | 동작 |
| --- | --- |
| 구독 | indexer 로 컨트랙트 상태 구독, `credentialInbox` 에 새 항목이 생기면 `lastSeenInboxIndex` 이후 항목을 순회 |
| 시도 복호화 | 각 entry 를 내 X25519 비밀키로 복호화 시도. AEAD tag 불일치면 남의 것 → skip |
| 검증 | 복호화 성공 시 `commitmentOf(ownerId=내 partyId, …)` 재계산 → provenanceTree 에 존재 확인 |
| 저장 | 보관함에 추가 (status ACTIVE), `lastSeenInboxIndex` 갱신 |
| 복구 | private state 유실 시 partySecret + encSecretKey 만 있으면 inbox 전체 재스캔으로 보유 credential 복구 가능 |

### 2.2.4 credential 수신 — 수동 (`/credentials/import`)

| 영역 | 구성요소 |
| --- | --- |
| 입력 | export 된 sealed entry 붙여넣기 / 파일 |
| 검증·저장 | §2.2.3 과 동일 |

### 2.3 기능 요구사항

| ID | 기능 | 상세 | circuit |
| --- | --- | --- | --- |
| FR-I-01 | 발행 폼 | 수신자 / origin / material / carbonClass 입력, 인증 origin 만 선택 가능 | — |
| FR-I-02 | batchSecret 생성 | 32byte CSPRNG. 사용자 입력 불가 | — |
| FR-I-03 | sealed entry 생성 | 수신자 공개키를 `partyEncKeys[recipientId]` 에서 읽고, pre-image 를 X25519(ephemeral) + HKDF-SHA256 + AES-256-GCM 으로 봉인한 192byte entry 생성 | — |
| FR-I-04 | 발행 tx | witness 구성 (issueSpec, recipientId, certPath, originPath) + sealed entry 를 인자로 증명 생성·제출. commitment 삽입과 inbox 기록이 한 tx 에서 원자적 | `issueProvenance(entry)` |
| FR-I-05 | 공개 범위 미리보기 | 제출 전 공개 / 비공개 항목 표시. 공개: commitment, 봉인된 entry(내용 불가독) | — |
| FR-I-06 | 발행 이력 | 내가 발행한 credential 목록 (commitment, 수신자 🔒, inbox index, 일시) — L2 | — |
| FR-I-07 | inbox 스캔 | 새 entry 시도 복호화 → commitment 재계산·tree 존재 확인 → 보관함 추가 | — (ledger read + pure circuit) |
| FR-I-08 | 수동 import | export 된 entry 로 FR-I-07 과 동일 처리 | — |

### 2.4 데이터 요구사항

**L1** — `provenanceTree` leaf 1개, `credentialInbox[count]` = sealed entry (Bytes<192>), `credentialInboxCount` +1

- sealed entry 형식: `ver(1) ‖ suite(1) ‖ ephPk(32) ‖ nonce(12) ‖ tag(16) ‖ ct(129)`. 평문 = `originId ‖ materialType ‖ carbonClass ‖ batchSecret ‖ commitment`. HKDF info = `"veilance:credential:v1"`. 수신자 식별자는 entry 에 없음 (ephemeral 키라 누구 앞인지 알 수 없음)

**L2 (Mine)** — 발행 이력: commitment, recipientId, originId, materialType, carbonClass, batchSecret, inbox_index, tx_hash, issued_at

**L2 (Refiner)** — `PRIVATE_CREDENTIAL`: ownerId(=본인), originId, materialType, carbon_class, batchSecret, commitment, status=ACTIVE, upstream_credential_id=null

**L3** — `TX_RECORD` (circuit=ISSUE_PROVENANCE, status, block). commitment 값은 tx 에 공개되므로 인덱싱 가능

### 2.5 엣지케이스

- 미인증 Mine 이 발행 → ✅ 컨트랙트 거부 (an uncertified party cannot issue)
- 미인증 origin 으로 발행 → ✅ 컨트랙트 거부 (uncertified origin)
- 수신자 partyId 오타 → 컨트랙트는 검증하지 않음 (recipientId 무제약). 아무도 소비 못 하는 credential 이 됨. UI 에서 L3 조직 목록과 대조해 경고
- 수신자가 수신 키를 아직 등록하지 않음 → `partyEncKeys` 조회 실패. 발행 폼에서 수신자 선택 시 사전 확인, 미등록이면 발행 차단
- 수신자가 나중에 수신 키를 바꿈 → 이전 entry 는 이전 비밀키로만 열림. 키 교체 시 이전 비밀키도 보관하도록 안내
- 발행자가 잘못된 공개키로 봉인 → commitment 는 유효하나 아무도 못 염. 컨트랙트는 검증 불가. 발행자 로컬 이력에서 재봉인 후 재발행이 아니라 **재전달 불가** (commitment 는 이미 tree 에 있음) → 발행자가 entry 를 파일로 export 해 수동 전달 (§2.2.4)
- 증명 생성 중 브라우저 종료 → tx 미제출. 재시도 시 batchSecret 재사용 여부 ❓
- 같은 내용으로 두 번 발행 → batchSecret 이 다르므로 commitment 2개. 컨트랙트는 정상 처리. 의도된 이중 발행인지 UI 확인

### 2.6 ❓ 미정 사항

- [x]  전달 채널 → **확정: 온체인 inbox (`credentialInbox: Map<Uint<64>, Bytes<192>>`), 발행·전달 circuit 이 sealed entry 를 인자로 받아 commitment 삽입과 같은 tx 에서 기록.** 근거: Midnight 트랜잭션(`Transaction` / `Intent` / `ContractCall`) 에는 memo·attachment 필드가 없음. Zswap 의 ciphertext 슬롯은 `ShieldedCoinInfo` 전용이고 컨트랙트 출력에는 금지("Can't have ciphertexts for contracts", ledger `spec/zswap.md`). 컨트랙트 이벤트(`emit`, MIP-0002) 는 아직 미출시. 공식 선례는 MIP-0012 + `midnightntwrk/passport` 의 `inbox: Map<Uint<64>, Bytes<192>>`. `Bytes<192>` Map 은 compact 0.34.0 에서 컴파일 확인. 파일 / QR export 는 예비 경로로 유지
- [x]  암호화 키 → **확정: Veilance 전용 X25519 키쌍. 공개키는 `partyEncKeys[partyId]` 에 등록, 비밀키는 private state.** 지갑의 `shieldedEncryptionPublicKey` 는 DApp Connector 가 공개키만 노출하고 대응 비밀키·범용 decrypt 를 제공하지 않아 사용 불가. 키를 `signData` 로 파생하는 것도 서명이 무작위라 불가 (§0.6). 암호 스위트는 MIP-0012 §6.4 와 동일 (X25519 + HKDF-SHA256 + AES-256-GCM, ephemeral 송신키)
- [ ]  quantity 를 L2 메모로만 둘지, 화면에서 아예 뺄지 (landing 데모 화면에는 "Quantity: █████" 로 등장)
- [ ]  materialType 코드 체계 (자유 문자열 해시 vs 고정 enum)

---

## 3. 🔁 Provenance 전달 / 변환 (Refiner)

### 3.1 유저 스토리

- **Refiner**로서, 받은 upstream credential 을 소비하고 내 공정을 거친 새 credential 을 Battery Manufacturer 에게 전달하고 싶다
- **Refiner**로서, 전달 시 upstream supplier 나 원산지가 공개되지 않는다는 것을 확인하고 싶다
- **Refiner**로서, 이미 사용한 credential 을 실수로 다시 쓰지 않도록 보관함에서 상태를 보고 싶다
- **관찰자(데모 진행자)**로서, 같은 credential 을 두 번 쓰려는 시도가 온체인에서 거부되는 것을 보여주고 싶다

### 3.2 화면 구성

### 3.2.1 보관함 (`/credentials`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| 필터 | 상태 (ACTIVE / CONSUMED) |  |
| 리스트 | credential 카드 |  |

**credential 카드에 표시할 정보**

- commitment (축약)
- 재료 🔒, 원산지 표시명 🔒, carbon class 🔒
- 상태 뱃지 (ACTIVE / CONSUMED)
- 받은 일시, 발행자 🔒 (있는 경우)
- 액션: "전달" (ACTIVE 만), "정책 증명" (ACTIVE 만)

### 3.2.2 전달 화면 (`/credentials/[id]/transfer`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| upstream 요약 | 소비할 credential 정보 (전부 🔒 표시) |  |
| 수신자 | 조직 드롭다운 → recipientId | 🔒 |
| 새 carbon class | 입력. 하한 = upstream carbon class | 컨트랙트 단조성 제약 반영 |
| 사전 검사 | ① tree 존재 ② 내 인증 ③ origin 인증 ④ 미소비 — 4개 체크 표시 | ledger 읽기로 로컬 사전 검증 |
| 공개 범위 미리보기 | 공개: nullifier, 새 commitment / 비공개: upstream commitment, 원산지, 재료, 수신자 |  |
| 실행 | "전달" 버튼 → tx 상태 |  |

### 3.2.3 전달 완료 화면 (`/credentials/[id]/transfer/[txHash]`)

| 영역 | 구성요소 |
| --- | --- |
| 결과 | nullifier, 새 commitment, block |
| 전달 | inbox index. 수신자는 체인 스캔으로 자동 수신 (§2.2.3) |
| 상태 변경 | upstream credential → CONSUMED |

### 3.2.4 거부 화면 (데모 Step 4)

| 영역 | 구성요소 |
| --- | --- |
| 에러 | "Provenance already consumed — REJECTED" 큰 배너 |
| 근거 | 해당 nullifier 가 이미 ledger 에 존재함, 최초 소비 tx 링크 |
| 안내 | ledger 상태는 변경되지 않았음 |

### 3.3 기능 요구사항

| ID | 기능 | 상세 | circuit |
| --- | --- | --- | --- |
| FR-T-01 | 보관함 조회 | L2 credential 목록 + ledger 와 대조한 상태 표시 | — |
| FR-T-02 | 사전 검사 | tree 멤버십, certLeaf, origin, nullifier 4항목을 ledger 읽기로 로컬 확인 | — |
| FR-T-03 | 전달 tx | witness 구성 (held, commitmentPath, certPath, originPath, recipientId, newBatchSecret, newCarbonClass) + 새 credential 의 sealed entry 를 인자로 증명·제출 | `transferProvenance(entry)` |
| FR-T-04 | 상태 갱신 | 성공 시 upstream → CONSUMED, 새 credential 이력 저장, nullifier 기록 | — |
| FR-T-05 | sealed entry 생성 | FR-I-03 과 동일 (수신자 공개키로 봉인) | — |
| FR-T-06 | 거부 처리 | tx 실패 사유를 컨트랙트 assert 메시지에서 파싱해 표시 | — |
| FR-T-07 | 데모용 재사용 버튼 | CONSUMED credential 에서 "다시 전달 시도" (경고 후 실행) — 공격 시나리오 재현 | `transferProvenance` |
| FR-T-08 | 공개 범위 미리보기 | §2 와 동일 | — |

### 3.4 데이터 요구사항

**L1** — `nullifiers` +1, `provenanceTree` leaf +1, `credentialInbox` +1

**L2 (Refiner)** — `TRANSITION`: upstream_credential_id, new_credential_id, upstream_nullifier, new_commitment, tx_hash, created_at. upstream `PRIVATE_CREDENTIAL.status=CONSUMED`

**L2 (Battery Mfr)** — 새 `PRIVATE_CREDENTIAL` (import 후)

**L3** — `TX_RECORD` (circuit=TRANSFER_PROVENANCE). 실패 시 status=REJECTED, rejection_reason

### 3.5 엣지케이스

- 이미 소비한 credential 재전달 → ✅ 컨트랙트 거부, ledger 불변 (ATTACK 테스트). UI 는 사전 검사 ④ 에서 먼저 경고
- 남의 credential 로 전달 시도 → ✅ 거부 (cannot spend a credential it does not own)
- 발행된 적 없는 credential → ✅ 거부 (never issued cannot be transferred)
- carbon class 를 upstream 보다 낮게 입력 → ✅ 거부. UI 입력 하한으로 사전 차단
- 전달 도중 origin 인증이 취소됨 → ③ 에서 실패. 사전 검사는 통과했는데 tx 가 실패할 수 있음 → 재검사 후 사유 표시
- 증명 생성 중 다른 참여자가 tree 에 insert → HistoricMerkleTree 덕에 증명 유효. 별도 처리 불필요
- 같은 브라우저에서 전달 tx 를 두 번 빠르게 제출 → 첫 번째만 성공, 두 번째는 nullifier 중복으로 실패. 버튼 중복 클릭 방지
- 전달 후 Refiner 로컬이 유실 → 수신자는 inbox 에서 자동 수신하므로 영향 없음. Refiner 의 CONSUMED 이력만 유실 (nullifier set 으로 재구성 가능)

### 3.6 ❓ 미정 사항

- [ ]  1:N split (한 credential 을 여러 하류로 나눠 전달) — quantity conservation 과 함께 Phase 2
- [ ]  carbon class 를 상속 + 증가 로 할지, 누적 계산식을 넣을지
- [ ]  tx 실패 시 DUST 소모를 사용자에게 어떻게 보여줄지
- [x]  전달 채널 → §2.6 과 동일하게 온체인 inbox 로 확정

---

## 4. ✅ 정책 검증 / Attestation (Holder → Verifier)

### 4.1 유저 스토리

- **OEM 구매팀**으로서, 공급망을 보지 않고도 responsible sourcing·인증·carbon 기준 충족을 확인하고 싶다
- **Consumer**로서, 이 배터리가 responsible sourcing 인지 한 가지만 확인하고 싶다
- **Regulator**로서, 모든 attestation 과 미소비 상태까지 확인하고 싶다
- **Battery Manufacturer**로서, verifier 가 요청한 항목만 증명하고 나머지는 비공개로 두고 싶다

### 4.2 화면 구성

### 4.2.1 검증 요청 화면 — Verifier (`/verify`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| 프로필 선택 | Consumer / OEM Procurement / Regulator | 각 프로필이 검증하는 predicate 목록 표시 |
| 대상 holder | 조직 드롭다운 → holder partyId | attestation 키 재계산에 필요 |
| challenge 생성 | 32byte CSPRNG → 표시 + 복사 + 공유 링크 | 지갑 불필요. 128bit 이상 엔트로피 필수 (§4.5) |
| 대기 | "holder 가 증명을 제출하면 여기에 결과가 표시됩니다" + ledger polling |  |
| 결과 | §4.2.3 |  |

### 4.2.2 증명 제출 화면 — Holder (`/credentials/[id]/attest`)

| 영역 | 구성요소 | 비고 |
| --- | --- | --- |
| challenge 입력 | verifier 가 준 값 붙여넣기 (또는 공유 링크로 자동 채움) |  |
| 프로필 | challenge 에 붙은 프로필 표시, 변경 가능 |  |
| 증명 항목 미리보기 | 프로필별 predicate 체크리스트 + 로컬 사전 검사 결과 | carbon class 는 "≤ threshold" 여부만 표시 |
| 공개 범위 미리보기 | Consumer / Procurement: challenge, 프로필 코드 / Regulator: + nullifier | Regulator 선택 시 linkability 경고 |
| 실행 | "증명 제출" → tx 상태 |  |

### 4.2.3 검증 결과 화면 — Verifier (`/verify/[challenge]`)

| 영역 | 구성요소 |
| --- | --- |
| 헤더 | 프로필, 증명 시점 policyVersion vs 현재 policyVersion (다르면 "재검증 필요" 배지), 확정 block, tx 링크 |
| 결과 표 | landing Step 3 형식 |

**결과 표 (프로필별)**

| 항목 | Consumer | Procurement | Regulator |
|---|---|---|---|
| Responsible sourcing | ✓ | ✓ | ✓ |
| Valid chain of custody | ✓ | ✓ | ✓ |
| Supplier certification | — | ✓ | ✓ |
| Carbon class ≤ threshold | — | ✓ (값 비공개) | ✓ (값 비공개) |
| Restricted source | ✗ | ✗ | ✗ |
| Duplicate claim | — | — | ✗ |

| 비공개 항목 | 표시 |
|---|---|
| Upstream supplier | PRIVATE |
| Origin | PRIVATE |
| Material amount | PRIVATE |
| Commercial relationship | PRIVATE |

### 4.3 기능 요구사항

| ID | 기능 | 상세 | circuit |
| --- | --- | --- | --- |
| FR-V-01 | challenge 생성 | 32byte CSPRNG, 프로필·대상 holder partyId 와 함께 L3 에 `VERIFICATION_REQUEST` 저장 | — |
| FR-V-02 | challenge 공유 | 링크 / QR / 복사 | — |
| FR-V-03 | Consumer 증명 | ownership + tree 멤버십 + origin 인증 | `attestConsumer` |
| FR-V-04 | Procurement 증명 | + supplier 인증 + carbonClass ≤ threshold | `attestProcurement` |
| FR-V-05 | Regulator 증명 | + nullifier 미소비 (nullifier 공개) | `attestRegulator` |
| FR-V-06 | 결과 polling | `attestationKeyOf(challenge, holderPartyId, profile)` 를 pure circuit 으로 재계산해 `attestations[key]` 조회. `{profile, policyVersion}` 확인 | `attestationKeyOf` (pure) |
| FR-V-10 | 신선도 표시 | 저장된 policyVersion 과 현재 ledger 값 비교. 다르면 재검증 요청 버튼 | — |
| FR-V-07 | 결과 렌더링 | 프로필 코드 → predicate 체크 표 + 비공개 항목 표 | — |
| FR-V-08 | 사전 검사 | holder 측에서 predicate 를 로컬로 미리 평가해 실패 예상 시 경고 | — |
| FR-V-09 | 요청 이력 | verifier 별 요청 목록·상태 (PENDING / PASSED / FAILED) | — |

### 4.4 데이터 요구사항

**L1** — `attestations`: `H("veilance:att", challenge, holderPartyId, profile)` → `{profile (1/2/3), policyVersion}`. raw challenge 는 온체인에 없음

**L3** — `VERIFICATION_REQUEST`: id, verifier_org_id, verifier_profile_id, target_holder_party_id, challenge, attestation_key, status, tx_hash, requested_at, completed_at. `VERIFICATION_RESULT`: predicate 별 1행 (프로필 코드에서 파생)

**L2 (Holder)** — attestation 이력: credential_id, challenge, profile, tx_hash

- verifier 는 target commitment 를 알 필요가 없다. `VERIFICATION_REQUEST.target_commitment` 는 ERD 상 nullable 로 변경

### 4.5 엣지케이스

- 같은 holder 가 같은 challenge·프로필로 두 번 제출 → ✅ 컨트랙트 거부. 같은 challenge 로 다른 프로필은 ✅ 허용 (verifier 가 Consumer + Procurement 를 한 challenge 로 요청 가능)
- challenge 를 가로챈 제3자가 자기 credential 로 제출 → ✅ 성공하지만 다른 키에 기록됨. verifier 는 기대한 holder 의 키만 조회하므로 영향 없음 (hijack 테스트)
- 정책 변경 후 이전 attestation 조회 → 저장된 policyVersion ≠ 현재 → "재검증 필요" 표시 (freshness 테스트)
- challenge 엔트로피 부족 (예: 순번) → attestation 키에서 holder partyId 사전 공격 가능. 클라이언트에서 항상 CSPRNG, 사용자 입력 금지
- carbon threshold 가 낮아진 뒤 Procurement 증명 → ✅ 실패 (selective disclosure 테스트). 사전 검사에서 경고
- 이미 소비된 credential 로 Consumer / Procurement 증명 → ⚠️ 통과함 (KNOWN LIMITATION). Regulator 만 거부. verifier 화면에 "Duplicate claim 은 Regulator 프로필에서만 확인됨" 명시
- Regulator 증명은 nullifier 를 공개하므로 이후 같은 credential 의 transfer 와 연결 가능 → holder 제출 화면에 경고
- holder 가 미인증 상태에서 Procurement 이상 요청 → 실패. 데모에서는 Battery Manufacturer 도 certifySupplier 필요
- verifier 가 결과를 확인하기 전 tx 가 pending → PENDING 표시, 확정 후 갱신

### 4.6 ❓ 미정 사항

- [x]  challenge 에 holder partyId 바인딩 → **확정·구현됨.** attestation 키 = `H(challenge, ownerId, profile)` 을 회로 안에서 계산. 근거: Verifiable Presentation 의 nonce + audience 바인딩과 같은 원리. 컨트랙트 v2, 테스트 20개 통과
- [ ]  Verifier 계정을 L3 에 둘지, 완전 익명(링크만)으로 할지
- [ ]  결과 화면을 공개 URL 로 둘지 (challenge 를 아는 사람은 누구나 조회 가능)
- [ ]  Consumer 프로필에도 duplicate claim 검사를 넣을지 (nullifier 공개 범위 확대와 trade-off)
- [x]  attestation 만료 → **확정·구현됨.** attestation 값에 증명 시점 policyVersion 을 기록하고 무효 판단은 verifier 가 함. 컨트랙트는 만료시키지 않음

---

## 5. 📦 데모 시나리오 매핑 (landing §10)

| Step | 화면 | FR | 확인 포인트 |
|---|---|---|---|
| 1. 공급망 등록 | `/admin/policy` → `/issue` | FR-P-02~04, FR-I-03 | 발행 화면의 공개 범위 미리보기: 원산지·수량은 🔒, 온체인은 commitment 하나 |
| 2. Refiner | `/credentials` (자동 수신) → `/credentials/[id]/transfer` | FR-I-07, FR-T-03 | 전달 완료 화면: "Upstream supplier PRIVATE / Origin PRIVATE / Policy verification PASSED" |
| 3. Battery OEM | `/verify` ↔ `/credentials/[id]/attest` → `/verify/[challenge]` | FR-V-01, FR-V-04, FR-V-06 | 결과 표 4항목 ✓ / ✗, 비공개 항목 표 |
| 4. 공격 | `/credentials` (CONSUMED) → 다시 전달 | FR-T-07 | 거부 배너 "Provenance already consumed — REJECTED", ledger 불변 |

---

## 6. 🔧 비기능 요구사항

| 항목 | 요구 | 비고 |
|---|---|---|
| 증명 생성 시간 | transfer ≤ 60s (데모 허용치) | **실측 41s** (로컬 devnet, proof server 8.1.0). issue 30s, attest 24~31s. 데모 UI 는 각 단계에 20~45초 진행 표시 필요 |
| 네트워크 | 로컬 devnet 과 **Preprod 공개 테스트넷** 양쪽에서 데모 전 과정 통과. Preprod 컨트랙트 `aef19243…2348` | proof server 는 항상 로컬 |
| private state 저장 | 브라우저 로컬, 암호화, export 가능 | §0.6 |
| 실패 tx | ledger 불변 보장 (✅ 컨트랙트 테스트) | DUST 소모는 발생 |
| 접근성 | Verifier 화면은 지갑·확장 없이 열람 가능 | ledger read 만 필요 |
