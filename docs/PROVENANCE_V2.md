# Veilance v2 — 수량 · 혼합 · 주문 연결 설계

상태: 컨트랙트(`contract/src/veilance_v2.compact`), 증인(`witnesses_v2.ts`), 봉인 형식(`sealed-entry-v2.ts`), 시뮬레이터 테스트(`test/v2.test.ts`, 시나리오 전체 + 거부 사례, 재활용 함량 포함 17개)까지. 에이전트 · 웹 연결은 다음 단계.
빌드: `npm run compile:v2` (테스트용) / `npm run compile:zk:v2` (증명 키 포함).
v1 컨트랙트(`veilance.compact`)는 그대로 두고 실행 중인 앱이 계속 쓴다.

## 1. 원칙

- **인터페이스는 넓게, 컨트랙트는 시나리오 하나.** 데이터 형식과 작업 종류는 개별 보존 · 분리 · 물질 수지를 모두 담을 수 있게 정하고, 컨트랙트는 아래 데모 시나리오가 요구하는 만큼만 구현한다. Compact 회로는 크기가 고정이라 일반화 비용을 모든 증명이 내고, 회로가 바뀌면 어차피 재배포가 필요하다.
- **기록 단위는 로트, 주장 단위는 수량.** 증명서 한 장 = 로트 하나, 로트는 수량을 가진다. 모든 작업은 수량 보존(물질 수지)을 회로로 강제한다.
- **입력의 진실성은 범위 밖.** 발행자가 입력한 수량 · 원산지가 실물과 맞는지는 체인 밖 계량 · 감사의 몫이다. 회로는 입력 이후의 보존만 보장한다.

## 2. 데모 시나리오

1. 광산 A가 수산화코발트 100 t, 광산 B가 60 t 로트를 가공사에 발행한다.
2. 가공사가 A 로트를 50 t / 50 t로 나눈다(자기 자신에게 전달).
3. 가공사가 A 50 t + B 60 t 를 합쳐 황산코발트로 가공한다. 정책 수율 상한 20 % → 최대 22 t. 원산지 목록 = {A, B}.
4. 가공사가 배터리 제조사에 10 t 를 전달하고 12 t 는 잔량으로 남긴다.
5. OEM이 주문(요청 코드 + 주문 수량 5 t)을 보낸다. 배터리 제조사는 값 공개 없이 "보유 ≥ 5 t, 모든 원산지 승인, 탄소 등급 ≤ 상한, 미소비"를 증명한다.
6. 배터리 제조사가 5 t 를 OEM에 전달한다. OEM만 원산지 구성 · 발행자 · 수량을 연다. 같은 5 t 는 다시 팔 수 없다.

## 3. 데이터 형식

```text
Lot {
  ownerId       Bytes<32>   H("veilance:id", partySecret)
  materialType  Bytes<32>
  quantity      Uint<32>    kg (최대 약 429만 t)
  carbonClass   Uint<8>     숫자 분류, 흐름을 따라 나빠지기만 함
  custody       Uint<8>     1 개별 보존 · 2 분리 · 3 물질 수지 (숫자가 클수록 약한 주장)
  origins       Vector<2, OriginSlot>   빈 칸 = 0 바이트
  recycledEuKg, recycledOtherKg  Uint<32>  재활용분 (PLATFORM_LAYER.md)
  batchSecret   Bytes<32>   commitment 을 숨기는 무작위값
}
OriginSlot { originId Bytes<32>, issuerId Bytes<32> }
```

- `issuerId` 는 발행 회로가 발행자 비밀키에서 직접 계산해 넣는다. 이후 전달 · 가공은 슬롯을 그대로 옮기거나 입력 슬롯의 합집합만 허용하므로, 받은 쪽이 보는 발행자는 위조할 수 없다.
- 원산지별 비율은 담지 않는다. 주장은 "이 로트의 모든 물량은 이 원산지들에서 왔고, 모두 승인 원산지"이다.
- K = 2. 세 곳 이상 섞으려면 K 를 늘린 새 버전이 필요하다.

commitment = `persistentHash([ "veilance:v2:cm", ownerId, materialType, quantity, carbonClass, custody, o0.originId, o0.issuerId, o1.originId, o1.issuerId, recycledEuKg, recycledOtherKg, batchSecret ])`.

## 4. 작업 인터페이스

| 작업 | 회로 | 소비 | 생성 | 강제하는 것 |
|---|---|---|---|---|
| 발행 | `issueLot(entry)` | — | 받는 쪽 로트 1 | 발행자 인증, 원산지 승인, 수량 > 0 |
| 전달 · 나누기 | `transferLot(entry)` | 보유 로트 1 | 받는 쪽 로트 + 자기 잔량 로트 | 0 < 전달량 ≤ 보유량, 잔량 = 보유량 − 전달량, 탄소 등급 비감소, 원산지 · 발행자 · 모델 유지 |
| 합치기 · 가공 | `processLots()` | 보유 로트 2 | 자기 로트 1 | 두 입력 같은 재료, 등록된 가공 규칙(입력 재료 → 출력 재료, 수율 상한)으로 산출량 ≤ (입력 합 × 수율 / 100), 탄소 등급 ≥ 두 입력, 모델 ≥ 분리 · 두 입력, 원산지 = 입력 슬롯의 합집합 |
| 주문 증명 | `attestOrder(challenge, minQuantity)` | 보유 로트 1 | 같은 로트(새 비밀값) | 원산지 승인, 공급업체 인증, 탄소 등급 ≤ 상한, 수량 ≥ 주문 수량, 미소비 |
| 가공 규칙 등록 | `addProcessingRule(in, out, yieldPct)` | — | — | 관리자만, 1 ≤ yield ≤ 100 |

- 전달은 잔량이 0이어도 잔량 로트를 항상 만든다. 전체 전달과 일부 전달이 체인에서 구별되지 않게 하기 위함이다.
- 합치기만 하고 재료가 바뀌지 않는 경우도 규칙(`in = out`, 100 %)으로 등록한다. 회로가 비공개 조건으로 분기하지 않게 하기 위함이다.
- 가공 규칙은 머클 트리 잎 `H(in, out, yield)` 로 저장하고 비공개 경로로 증명한다. 어떤 가공이 일어났는지 체인에 드러나지 않는다.
- 주문 수량은 공개하지 않는다. 증명 기록 키 = `H("veilance:v2:att", challenge, ownerId, minQuantity)` 이고, OEM 은 자기가 아는 요청 코드와 주문 수량으로 키를 다시 계산해 조회한다.
- 모든 소비는 v1 과 같은 사용 식별자 `H(commitment, ownerSecret)` 를 공개한다. 증명은 rotate-on-attest 를 그대로 따른다.

## 5. 봉인 전달 형식

332 바이트 = 헤더 62(버전 · 스위트 · 임시 공개키 · nonce · tag) + 암호문 270.
평문: materialType 32 · quantity 4 · carbonClass 1 · custody 1 · origins 128 · batchSecret 32 · commitment 32 · memo 32 · recycledEuKg 4 · recycledOtherKg 4.
재활용분 필드와 기간 선언은 [PLATFORM_LAYER.md](PLATFORM_LAYER.md) 참고.
`memo` 는 commitment 에 들어가지 않는 참고값이다. OEM 에게 전달할 때 주문 번호 해시를 넣어 어떤 주문의 납품인지 표시한다. 회로가 검증하지 않으므로 증거가 아니라 색인이다.

## 6. OEM 이 받은 로트를 확인하는 방법 (체인 밖)

1. 수신함에서 자기 키로 복호화한다.
2. 평문으로 commitment 을 다시 계산해 봉인된 값과 같은지, 그리고 `provenanceTree` 에 있는지 확인한다.
3. 원산지들이 `certifiedOrigins` 에 있는지 확인한다.
4. 사용 식별자가 아직 없는지(자기 로트이므로 자기 비밀키로 계산) 확인한다.

발행자 인증은 발행 회로가 이미 강제했으므로 OEM 이 다시 확인할 필요가 없다.

## 7. 공개 범위

| 누가 | 무엇을 봄 |
|---|---|
| 체인 관찰자 | 작업 종류(회로 이름), commitment, 사용 식별자, 암호문, 증명 기록 키. 수량 · 재료 · 원산지 · 가공 규칙 · 주문 수량은 볼 수 없음 |
| 로트를 받은 회사 | 그 로트의 전체 내용(원산지 구성 · 발행자 · 수량) |
| 구매 전 OEM | 조건 통과 여부와 정책 버전 |
| 납품 받은 OEM | 받은 로트의 전체 내용 |

## 8. 범위 밖 · 다음 단계

- 원산지별 비율, K > 2, 세 개 이상 입력 합치기.
- 입력 하나만 가공하는 회로. 지금 `processLots` 는 입력이 반드시 두 개다(데모 시나리오는 합치기만 사용).
- 발행자 선택 공개 태그(구매 전 단계에서 OEM 만 발행자를 확인). 납품 단계에서는 로트 전체를 받으므로 이미 해결됨.
- 에이전트: OEM 을 수신 가능한 파티로 추가, 수량 · 합치기 · 주문 API. 웹: 수량 표시, 나누기 · 합치기 화면, OEM 수신함.
- 관리자 키 교체 · 인증 취소.
