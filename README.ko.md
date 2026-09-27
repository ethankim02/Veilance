# Veilance

**거래 정보를 보호하면서 공급망의 출처와 정책 준수를 증명하는 Midnight 기반 데모.**

**한국어** | [English](README.en.md)

Veilance는 광산 → 정제사 → 배터리 제조사로 이어지는 원자재 공급망에서 출처 증명서를 발행하고 전달하며, 영지식 증명으로 검증자에게 필요한 조건의 충족 여부를 보여줍니다. 원본 증명서는 수신자에게 암호화해 전달하고, 컨트랙트는 공개된 커밋먼트와 정책을 바탕으로 검증합니다.

## 주요 기능

- **출처 증명서 발행·전달**: 원자재 이력을 커밋먼트 트리에 기록하고, 전달 시 기존 증명서의 nullifier를 기록해 재사용을 방지합니다.
- **선택적 공개**: 소비자, 조달 담당자, 규제기관별로 다른 정책 조건을 증명합니다.
- **암호화된 수신함**: 수신자가 자신의 키로 증명서를 복호화하고 로컬 보관함에 저장합니다.
- **기업별 작업 공간**: 재고, 송수신 기록, 직접 거래, OEM 검증 요청과 전체 운영 그래프를 제공합니다.
- **증명 진행 상황과 탐색기**: 작업 상태, 트랜잭션, 블록, 컨트랙트 정보를 확인합니다.
- **한국어·영어 UI**: 화면 상단에서 언어를 전환할 수 있습니다.

| 검증 프로필 | 증명하는 조건 |
| --- | --- |
| Consumer | 인증된 원산지 |
| Procurement | 인증된 원산지 + 현재 보유자 인증 + 탄소 등급이 정책 임계값 이하 |
| Regulator | Procurement 조건 + 증명서가 아직 소비되지 않았음 |

## 구성

```text
web/       React + Vite + TypeScript 웹 UI, HTTP/모의 API 어댑터
agent/     Party Agent: 웹 UI가 연결하는 HTTP 백엔드 (Midnight SDK, contract/node_modules 공유)
contract/  Compact 컨트랙트, witness, 암호화 유틸리티, 테스트
shared/    기업별 그래프 범위 처리와 테스트
```

이 저장소에는 웹 UI, Party Agent, 컨트랙트, 독립 실행형 E2E 스크립트가 포함됩니다. 웹 UI는 모의 모드로 바로 실행할 수 있고, 실제 체인과 연결하려면 로컬 devnet(또는 Preprod)에 대해 `agent/`를 실행한 뒤 웹 UI를 그 주소에 연결합니다. 컨트랙트의 체인 시나리오는 `contract/e2e/`에서 직접 실행할 수 있습니다.

## 빠른 시작: 모의 UI

Node.js 22와 npm을 기준으로 아래 명령을 실행합니다. 모의 모드는 Docker, 지갑, Compact 컴파일러 없이 사용할 수 있습니다.

```bash
git clone https://github.com/lejuho/Veilance.git
cd Veilance/web
npm ci
VITE_MOCK=1 npm run dev
```

`http://localhost:5173`에서 확인합니다. 모의 데이터는 브라우저의 `localStorage`에 저장되며, 실제 체인 트랜잭션이나 영지식 증명을 생성하지 않습니다. `VITE_API_URL`을 설정하지 않아도 모의 모드가 기본으로 선택됩니다.

## 로컬 Midnight 체인 연결

### 1. 사전 준비

저장소가 사용하는 버전은 Compact 컴파일러 `0.31.1`, Compact Runtime `0.16.0`, Midnight.js `4.1.1`입니다. 로컬 네트워크 구성은 노드 `0.22.5`, Indexer `4.2.1`, 증명 서버 `8.1.0`을 기준으로 합니다.

Docker와 Compact CLI를 별도로 설치하고, 해당 버전의 로컬 devnet을 준비해야 합니다. Docker Compose 파일은 이 저장소에 포함되어 있지 않습니다. 기존 환경의 실행 예시와 버전 설명은 [E2E 안내](contract/e2e/README.md)를 참고하세요.

### 2. 컨트랙트 설치 및 실행

저장소 루트에서 실행합니다.

```bash
cd contract
npm ci
npm run compile:zk
npm run e2e:dry-run
# 로컬 devnet이 실행 중일 때 전체 시나리오 실행
npm run e2e
```

`compile:zk`는 실제 체인 실행에 필요한 증명 키를 생성합니다. `e2e:dry-run`은 네트워크 호출 없이 키와 provider 구성을 확인합니다. `e2e`는 관리자 초기화 → 광산 발행 → 정제사 전달 → 배터리 제조사 증명 → 중복 사용 거부 시나리오를 실제 체인에서 실행합니다.

### 3. Party Agent 실행과 웹 UI 연결

`agent/`는 네 데모 참여자의 키와 지갑을 한 프로세스에서 관리하며 컨트랙트를 대신 호출합니다. `agent/node_modules`는 `contract/node_modules`의 심볼릭 링크이며(WASM 클래스 중복 방지를 위한 설계이므로 `agent`에서 `npm install`을 따로 실행하지 않습니다), 컨트랙트 설치와 `compile:zk`가 끝난 뒤 만들어 둡니다.

```bash
ln -s "$(pwd)/contract/node_modules" agent/node_modules   # 최초 1회
cd agent
npm run dev                # http://localhost:4000, /health 로 부팅 진행 확인 (ready:false → true)
curl -X POST http://localhost:4000/deploy      # 계약 배포 (또는 기존 배포에 자동 재연결)
curl -X POST http://localhost:4000/admin/bootstrap   # 데모 정책 일괄 등록 (원산지, 공급자 인증 3건, 임계값, 수신 키 4건)
```

```bash
cd web
VITE_MOCK=0 VITE_API_URL=http://localhost:4000 npm run dev
```

네트워크 선택은 E2E 스크립트와 같은 `VEILANCE_*` 변수를 사용합니다. Preprod 등 공개 테스트넷 연결과 상세한 실행·검증 기록은 [Agent 안내](agent/README.md)와 [API 명세](agent/API.md)를 참고하세요.

요구되는 인터페이스는 [API 클라이언트](web/src/api/client.ts)와 [HTTP 어댑터](web/src/api/http.ts)에 정의되어 있습니다.

## 환경 설정

| 변수 | 기본값 / 용도 |
| --- | --- |
| `VITE_API_URL` | 미설정 시 모의 모드. 실제 연결 시 Agent 주소 |
| `PORT` | Agent 전용. HTTP 포트, 기본 4000 |
| `CORS_ORIGIN` | Agent 전용. 허용 origin 목록(콤마 구분), 기본 로컬 웹 UI |
| `VITE_MOCK` | `1` 또는 `true`로 모의 모드 강제 |
| `VEILANCE_NETWORK_ID` | 기본 `undeployed` |
| `VEILANCE_NODE_URL` / `VEILANCE_NODE_WS_URL` | 기본 `http://localhost:9944` / `ws://localhost:9944` |
| `VEILANCE_INDEXER_HTTP_URL` | 기본 `http://localhost:8088/api/v4/graphql` |
| `VEILANCE_INDEXER_WS_URL` | 기본 `ws://localhost:8088/api/v4/graphql/ws` |
| `VEILANCE_PROOF_SERVER_URL` | 기본 `http://localhost:6300` |

네트워크·자금 공급 관련 추가 설정은 [E2E 설정 코드](contract/e2e/lib/config.ts), 웹 탐색기 설정은 [웹 안내](web/README.md)를 참고하세요.

## 개발 및 검증

아래 명령은 저장소 루트 기준입니다.

```bash
(cd contract && npm test && npm run typecheck)
(cd web && npm run build)
(cd agent && npm run typecheck)
node --import ./contract/node_modules/tsx/dist/loader.mjs shared/graphScope.test.ts

# 증명 키와 provider 구성 등을 네트워크 호출 없이 확인
(cd contract && npm run compile:zk && npm run e2e:dry-run)

# 실행 중인 devnet에서 전체 시나리오와 중복 사용 거부 확인
(cd contract && npm run e2e)
```

`npm test`는 `--skip-zk` 컴파일을 먼저 실행합니다. 실제 체인 실행 전에는 `compile:zk`를 실행해 증명 키가 준비되어 있는지 확인하세요.

## 데모 범위와 공개 정보

현재 작업 공간 선택은 화면 표시 범위를 전환하는 데모 기능이며 로그인이나 접근 제어가 아닙니다. E2E 스크립트도 데모 참여자의 키를 한 프로세스에서 관리합니다. 기업별 운영에는 별도의 인증·권한 검증과 참여자별 키 저장소 분리가 필요합니다.

공개 원장에는 커밋먼트, nullifier, 정책, attestation, 암호화된 수신함 등이 남습니다. 특히 Regulator 증명에서 공개하는 nullifier는 이후 같은 증명서를 사용하는 트랜잭션과 연결될 수 있습니다. 수량 보존과 실제 원산지 데이터의 진위 확인은 현재 데모가 보장하는 범위에 포함되지 않습니다.

## 관련 문서

- [웹 안내](web/README.md)
- [Agent 안내](agent/README.md) · [Agent API](agent/API.md)
- [E2E 안내](contract/e2e/README.md)
- [컨트랙트 소스](contract/src/veilance.compact)
- [기업별 그래프 범위 처리](shared/graphScope.ts)

하위 문서에는 이전 설계에 대한 기록도 있습니다. 실행 명령과 의존성은 각 패키지의 `package.json` 및 소스 코드를 기준으로 확인하세요.
