# Veilance

### Confidential Provenance Infrastructure for Regulated Supply Chains

## 1. 한 줄 소개

**Veilance는 기업이 공급망의 민감한 정보를 공개하지 않으면서도 제품의 출처, 규제 준수, 공급망 연속성을 증명할 수 있게 하는 Midnight 기반 Confidential Provenance Protocol이다.**

> **Prove the chain without revealing the chain.**

첫 번째 데모 버티컬은 **EV Battery Supply Chain**이며, 이후 Semiconductor와 Medical Device 공급망으로 확장한다.

---

# 2. Problem

규제 산업의 공급망에서는 두 요구가 동시에 존재한다.

### 기업은 공급망 정보를 증명해야 한다.

기업은 규제기관, 고객, OEM, 감사기관 등에 다음과 같은 사실을 입증해야 한다.

* 원재료가 승인된 출처에서 왔는가?
* 제재 대상 공급자가 포함되어 있지 않은가?
* 필요한 certification을 모든 단계에서 통과했는가?
* 동일한 인증 자산이 여러 제품에 중복 claim되지 않았는가?
* upstream provenance가 최종 제품까지 끊기지 않고 이어지는가?

그러나 이를 증명하기 위한 원본 데이터에는 기업이 공개하고 싶지 않은 정보가 포함된다.

### 기업은 공급망 자체는 공개하고 싶지 않다.

예:

* supplier identity
* supplier graph
* sourcing locations
* exact quantities
* purchase volumes
* material composition
* manufacturing route
* commercial relationship

이 정보들은 단순 개인정보가 아니라 **기업 경쟁력과 직결되는 commercial intelligence**다.

따라서 현재 공급망 transparency에는 근본적인 tension이 존재한다.

**Need to prove where it came from.
Cannot reveal where it came from.**

Veilance는 이 충돌을 해결한다.

---

# 3. Why Now — EV Battery

Veilance의 첫 번째 vertical은 EV Battery다.

EU에서는 특정 EV·산업용 배터리에 대해 **2027년 2월 18일부터 Battery Passport가 의무화될 예정**이며, Battery Passport는 material, sustainability, lifecycle 등 복잡한 공급망 정보를 다루게 된다.

EU의 Digital Product Passport 체계 역시 제품 데이터를 모든 사람에게 동일하게 공개하는 단순 공개 DB가 아니라, 소비자·경제주체·수리업체·재활용업체·공공기관 등 서로 다른 이해관계자에게 필요한 정보에 접근시키는 방향으로 설계되고 있다.

문제는 현재 방식이 기본적으로 여전히 다음 질문에 집중한다는 것이다.

> **Who is allowed to see the data?**

Veilance는 이를 다른 문제로 바꾼다.

> **Do they need to see the data at all?**

Verifier가 필요한 사실만 Zero-Knowledge Proof로 증명할 수 있다면 underlying commercial data 자체를 제공할 필요가 없다.

---

# 4. Solution

EV battery supply chain을 다음처럼 가정한다.

```text
Certified Mine
      ↓
   Refiner
      ↓
Material Producer
      ↓
Cell Manufacturer
      ↓
Battery OEM
```

각 단계의 참여자는 자신의 private supply-chain information을 보유한다.

예를 들어 Refiner는 다음 정보를 알고 있다.

```text
Private

upstreamSupplier
mineLocation
materialAmount
purchasePrice
certification
batchId
commercialTerms
```

Refiner는 이 데이터를 공개하지 않고 Veilance를 통해 다음을 증명한다.

```text
Public Proof

✓ upstream credential is valid
✓ upstream supplier satisfies required policy
✓ material is not from a restricted source
✓ required certification is valid
✓ this provenance has not been duplicated
```

그 결과 새로운 provenance commitment가 생성된다.

다음 participant는 upstream 데이터를 볼 필요 없이 그 commitment의 validity만 상속받는다.

```text
Mine
  │ private attestation
  ▼
Commitment A
  │
Refiner
  │ ZK transition
  ▼
Commitment B
  │
Material Producer
  │ ZK transition
  ▼
Commitment C
  │
Cell Manufacturer
  ▼
Commitment D
  │
Battery OEM
  ▼

Valid compliant provenance ✓
```

최종 verifier는 전체 supplier graph를 보는 것이 아니라 필요한 property만 확인한다.

---

# 5. 핵심 기능

## 5.1 Confidential Provenance

전체 provenance를 공개하는 대신 각 단계의 valid transition만 증명한다.

Verifier:

```text
Entire upstream chain valid       ✓
Responsible sourcing policy       ✓
Required certifications valid     ✓
```

Verifier가 볼 수 없는 것:

```text
Supplier A                        PRIVATE
Supplier B                        PRIVATE
Mine location                     PRIVATE
Exact material amount             PRIVATE
Commercial relationship           PRIVATE
```

---

## 5.2 Selective Policy Disclosure

모든 verifier가 같은 정보를 요구할 필요도 없다.

같은 provenance에 대해 verifier마다 다른 predicate를 검증할 수 있다.

### Consumer

```text
responsibleSourcing == true
```

### OEM Procurement Team

```text
responsibleSourcing == true
certificationValid == true
carbonClass <= threshold
```

### Regulator

```text
allRequiredAttestations == true
restrictedSource == false
```

즉 하나의 private provenance에 대해 필요한 정보만 선택적으로 증명한다.

---

# 6. Blockchain이 필요한 이유

Veilance는 단순히 private document를 검증하는 ZK 앱이 아니다.

핵심은 **서로 독립적인 기업들이 동일한 provenance state를 공유한다는 것**이다.

```text
Mine
Refiner
Material Producer
Cell Manufacturer
OEM
Auditor
```

어느 하나의 기업도 전체 공급망을 소유하지 않는다.

각 기업은 자신의 private state를 유지하면서 다음 기업에게 cryptographic provenance를 전달한다.

Midnight는 이들 사이에서 다음 shared state를 유지한다.

```text
provenance commitment
credential validity
revocation state
nullifier / consumption state
policy version
```

따라서 하나의 중앙 공급망 사업자가 모든 commercial information을 소유할 필요가 없다.

---

# 7. Double Claim Prevention

단순 provenance 인증의 또 다른 문제는 **인증된 input의 중복 claim**이다.

예를 들어 인증된 cobalt 1,000kg을 확보했다고 가정한다.

악의적인 participant가 이를 다음과 같이 claim할 수 있다.

```text
Battery A:
800kg compliant cobalt

Battery B:
800kg compliant cobalt
```

그러면 실제 1,000kg input으로 1,600kg의 compliant output이 생성된다.

Veilance는 private quantity를 공개하지 않으면서 conservation constraint를 증명하는 방향으로 확장할 수 있다.

```text
private:

inputQuantity
outputQuantityA
outputQuantityB

prove:

outputA + outputB <= input
```

MVP에서는 단순화하여 provenance credential마다 nullifier를 사용해 동일 credential의 duplicate consumption을 차단한다.

향후 confidential quantity accounting으로 확장한다.

---

# 8. Midnight가 필요한 이유

Veilance에서 privacy는 부가 기능이 아니라 문제의 핵심이다.

일반적인 public blockchain에 supplier provenance를 기록하면:

```text
supplier relationships
transaction graph
batch linkage
production relationships
```

가 그대로 노출되어 새로운 commercial surveillance layer가 될 수 있다.

반대로 모든 데이터를 중앙 DB에 저장하면:

```text
trusted database operator
```

가 전체 공급망 데이터를 볼 수 있는 새로운 single point of trust가 된다.

Veilance는 Midnight를 이용하여:

```text
Private enterprise data
        +
Shared provenance state
        +
Zero-Knowledge policy verification
```

을 동시에 가능하게 한다.

즉:

**Blockchain → shared multi-party state**

**ZK → confidential verification**

**Selective disclosure → verifier-specific compliance**

라는 역할 분리가 존재한다.

---

# 9. 48시간 Hackathon MVP

MVP에서는 EV battery supply chain 전체를 구현하지 않는다.

다음 3개 participant만 사용한다.

```text
Mine
 ↓
Refiner
 ↓
Battery Manufacturer
```

## Circuit 1 — Issue Provenance

Mine이 private material credential을 생성한다.

Private witness:

```text
supplierSecret
origin
certification
batchSecret
```

Public result:

```text
provenanceCommitment
```

---

## Circuit 2 — Transfer / Transform Provenance

Refiner가 upstream credential을 보유하고 있음을 증명한다.

검증 조건:

```text
upstreamCredentialValid
AND
supplierCertified
AND
originNotRestricted
AND
credentialNotConsumed
```

성공하면:

```text
newProvenanceCommitment
upstreamNullifier
```

를 생성한다.

---

## Circuit 3 — Verify Policy

Battery Manufacturer 또는 verifier가 특정 predicate를 요청한다.

```text
Responsible sourcing     ✓
Valid upstream chain     ✓
No restricted source     ✓
No duplicate provenance  ✓
```

underlying supply chain은 공개되지 않는다.

---

# 10. 3분 Demo

### Step 1 — 공급망 등록

Mine이 cobalt credential을 발행한다.

UI에는 실제 값이 표시된다.

```text
Mine: Democratic Republic of ...
Supplier: █████████
Quantity: █████████
Certification: Verified
```

---

### Step 2 — Refiner

Refiner가 이 credential을 사용해 새로운 provenance를 생성한다.

화면:

```text
Upstream supplier
PRIVATE

Origin
PRIVATE

Policy verification
PASSED ✓
```

---

### Step 3 — Battery OEM

OEM은 공급망을 볼 수 없다.

대신:

```text
Responsible sourcing     ✓
Valid chain of custody   ✓
Restricted source        ✗
Duplicate claim          ✗
```

를 확인한다.

---

### Step 4 — 공격 시나리오

Refiner가 이미 사용한 upstream provenance를 다시 사용하려 한다.

```text
Provenance already consumed

REJECTED
```

이를 통해 단순 selective disclosure뿐 아니라 shared provenance state의 필요성까지 보여준다.

---

# 11. 경쟁 방식과 차별점

기존 Digital Product Passport는 product information을 구조화하고 participant들에게 필요한 데이터를 제공하는 데 초점을 둔다.

실제로 EU에서도 DPP는 공급망 transparency와 interoperability를 목적으로 확대되고 있으며, battery가 첫 주요 적용 분야다.

UN Transparency Protocol 역시 서로 다른 산업의 product credential을 하나의 확장 가능한 DPP model로 표현하는 방향을 제시하고 있다.

Veilance의 차별점은 데이터를 더 잘 공유하는 것이 아니다.

**Veilance minimizes the amount of data that must be shared at all.**

```text
Traditional provenance

Share data
→ control access
→ audit


Veilance

Keep data private
→ prove required property
→ share proof
```

---

# 12. 제품 포지셔닝

Veilance를 다음과 같이 정의한다.

> **A privacy layer for multi-party product provenance.**

또는 보다 기술적으로:

> **A confidential state-transition protocol for regulated supply chains.**

제품이 아닌 산업별 passport 이름으로 정의하지 않는 것이 중요하다.

따라서:

**X — Battery Passport**

**X — Material Passport**

보다

**O — Veilance: Confidential Provenance Infrastructure**

가 장기 확장성을 더 잘 반영한다.

---

# 13. Roadmap

## Phase 1 — EV Battery

핵심 primitive:

```text
material provenance
responsible sourcing
private quantity
double-claim prevention
```

EV battery를 선택하는 이유는 Battery Passport가 2027년 의무 적용을 앞두고 있어 실제 provenance infrastructure 문제가 현재 진행형이기 때문이다.

---

## Phase 2 — Semiconductor

EV에서 만든 generic provenance core를 유지한다.

다만 material conservation 중심 policy 대신 **authenticated lineage**를 추가한다.

```text
Fab
 ↓
OSAT
 ↓
Distributor
 ↓
OEM
```

Private:

```text
fab identity
customer
manufacturing route
process information
commercial relationships
```

Proof:

```text
Authorized fabrication       ✓
Valid manufacturing lineage  ✓
Restricted entity absent     ✓
No duplicated provenance     ✓
```

즉 EV의:

```text
private mass provenance
```

에서 semiconductor의:

```text
private authenticated lineage
```

로 확장한다.

---

## Phase 3 — Medical Devices

다음으로 safety-critical regulated manufacturing으로 확장한다.

```text
Component Supplier
 ↓
Device Manufacturer
 ↓
Sterilization Provider
 ↓
Distributor
 ↓
Hospital
```

Private:

```text
BOM
supplier network
manufacturing site
commercial relationships
```

Proof:

```text
All critical suppliers valid  ✓
Sterilization completed        ✓
No revoked component           ✓
Valid manufacturing lineage    ✓
```

EV → Semiconductor → Medical Device 모두 동일한 provenance core를 공유한다.

산업마다 달라지는 부분은 policy module이다.

---

# 14. Architecture Vision

```text
                    Veilance

┌────────────────────────────────────────┐
│            Provenance Core             │
│                                        │
│ commitments                            │
│ parent → child lineage                 │
│ nullifiers                             │
│ credential validity                    │
│ revocation                             │
└────────────────────────────────────────┘

                   ↓

┌────────────────────────────────────────┐
│          Midnight Privacy Layer        │
│                                        │
│ private witnesses                      │
│ ZK verification                        │
│ selective disclosure                   │
│ confidential state transition          │
└────────────────────────────────────────┘

                   ↓

┌────────────────────────────────────────┐
│             Policy Modules             │
│                                        │
│ EV Battery                             │
│ → sourcing + material conservation     │
│                                        │
│ Semiconductor                          │
│ → authenticated lineage                │
│                                        │
│ Medical Device                         │
│ → component/process compliance         │
└────────────────────────────────────────┘
```

---

# 15. 핵심 메시지

Veilance가 해결하려는 문제는 단순히:

> “공급망을 blockchain에 기록하자.”

가 아니다.

오히려 그 반대다.

> **Supply chains need verifiability, not universal visibility.**

기업이 규제 준수를 위해 경쟁정보까지 공개해야 하는 구조 대신, Veilance는 필요한 사실만 cryptographically prove한다.

### Final tagline

**Veilance**

**Prove the chain. Keep the chain private.**
