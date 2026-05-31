# h7 엔진 로직 상세 설명

> APEX에서 h7 (09:00 갭업 + Spectral Cluster)을 완벽하게 이해하기 위한 가이드

---

## 핵심 요약 (30초)

```
09:00 갭업 감지 (10% + 5배 거래량)
  ↓
갭업 종목의 Spectral Cluster 찾기
  ↓
클러스터 멤버 중 "약한 종목" (낮은 수익률) 찾기
  ↓
등락률 낮은 N=2 선택 + 상한가 가드
  ↓
09:01 정적 매수 → D+1 09:00 시초가 매도
```

**결과**: 250매매, +3.01% 평균, MDD -2.16% (매우 안전)

---

## 📊 Spectral Cluster란?

### 정의
서랍(Seorab) 엔진에서 **매일 D-1 18:00**에 생성하는 데이터:
- KOSDAQ 1,815개 종목을 자동으로 같은 움직임을 보이는 **그룹으로 분류**
- 각 그룹: `cluster_id`, `avg_corr` (상관도), `members` (멤버 코드 배열)

### 예시

```javascript
// 반도체 클러스터 (cluster_id = 5)
{
  cluster_id: 5,
  avg_corr: 0.48,        // 이 그룹 내 평균 상관도 (0~1, 1에 가까울수록 동조)
  size: 12,              // 멤버 12개
  members: [
    'A000660',  // SK하이닉스
    'A005930',  // 삼성전자
    'A093370',  // 갤럭시아전자
    'A092310',  // LG이노텍
    ...
  ]
}

// 2차전지 클러스터 (cluster_id = 12)
{
  cluster_id: 12,
  avg_corr: 0.51,
  size: 8,
  members: ['A066570', 'A247540', ...]
}
```

---

## 🎯 h7 로직 7단계 (상세)

### Step 1️⃣: 갭업 + 거래량 이중 필터

**코드** (src/strategy.js:424-442)
```javascript
const gapupStocks = [];
for (const s of scanned) {
  if (!s.code || !s.close || !s.prevClose || !s.volume || !s.avgVolume) continue;

  const gapupRatio = s.close / s.prevClose;        // 갭업 비율
  const volRatio = s.volume / s.avgVolume;          // 거래량 비율

  if (gapupRatio >= 1.10 && volRatio >= 5.0) {     // 10% AND 5배
    gapupStocks.push({
      code: s.code,
      close: s.close,
      prevClose: s.prevClose,
      gapupRatio: gapupRatio - 1,  // 0.10 = 10%
      volRatio,
    });
  }
}
```

**목적**:
- `gapupRatio >= 1.10` = close가 전일종가의 110% 이상
- `volRatio >= 5.0` = 거래량이 평균의 5배 이상
- **둘 다 만족** = 진정한 모멘텀 (상한가 편향 자동 차단)

**결과**: 일평균 1.3개 갭업 종목 필터링

---

### Step 2️⃣: 각 갭업 종목의 클러스터 찾기

**코드** (src/strategy.js:453-487)
```javascript
// spectral cluster 로드 (서랍 D-1 데이터)
const spectralData = await spectralLoader.loadSpectralClusters();

// 갭업 각 종목에 대해
for (const gapup of gapupStocks) {
  const gapupCodeWithA = _withA(gapup.code);  // 'A012330' 형식
  
  // "이 종목이 어느 클러스터에 속하는가?"
  const clusterInfo = spectralData.codeToCluster.get(gapupCodeWithA);
  
  if (!clusterInfo) {
    continue;  // 클러스터 정보 없음 → skip
  }
  
  const clusterId = clusterInfo.cluster_id;
  const clusterData = spectralData.clusterToMembers.get(clusterId);
  
  // 클러스터 필터: 강한 동조도 + 충분한 멤버
  if (clusterData.avg_corr < 0.42 || clusterData.members.length < 8) {
    continue;  // 약한 클러스터 → skip
  }
  
  // 통과! 이 클러스터에서 멤버를 선택할 것임
}
```

**예시**:
```
SK하이닉스(A000660) 갭업 → codeToCluster.get('A000660')
  ↓
{ cluster_id: 5, avg_corr: 0.48, size: 12, ... }
  ↓
clusterId = 5
clusterData = clusterToMembers.get(5)
  ↓
{
  members: ['A000660', 'A005930', 'A093370', ...],
  avg_corr: 0.48,
  size: 12
}
  ↓
avg_corr (0.48) >= 0.42? ✅
size (12) >= 8? ✅
→ 통과!
```

---

### Step 3️⃣: 클러스터 멤버 조사 (09:00 현재가 기준)

**코드** (src/strategy.js:489-532)
```javascript
const candidates = [];

// 클러스터 각 멤버에 대해
for (const memberCode of clusterData.members) {
  const memberCode6 = _stripA(memberCode);  // 'A012330' → '012330'
  
  // 09:00 스캔 데이터에서 현재가 조회
  const scannedRow = codeToScanned.get(memberCode6);
  if (!scannedRow) continue;
  
  // 후보에 추가 (등락률 정보 포함)
  candidates.push({
    code: memberCode6,
    close: scannedRow.close,
    changeRate: scannedRow.changeRate,  // 09:00 기준 등락률
    name: scannedRow.name,
  });
}

// 등락률 낮은 순 정렬 (클러스터 내 "약한 종목" = 평균회귀 대상)
candidates.sort((a, b) => a.changeRate - b.changeRate);
```

**예시** (반도체 클러스터, 09:00 현재):
```
SK하이닉스(A000660)      +12% ← 갭업 종목 (이미 올랐음, 제외)
삼성전자(A005930)        +5%  ← 낮음
LG이노텍(A092310)        +2%  ← 매우 낮음!
갤럭시아전자(A093370)    +3%  ← 낮음
케이씨텍(A036930)        +4%  ← 낮음

정렬 후:
1️⃣ LG이노텍         +2%  (가장 약함)
2️⃣ 갤럭시아전자     +3%
3️⃣ 케이씨텍         +4%
4️⃣ 삼성전자         +5%  (가장 강함)
```

**알파 메커니즘**:
```
"SK는 +12% 올랐는데, 같은 클러스터의 다른 종목들은 +2~5%?"
"뭔가 이상한데? 평균회귀 신호!"
"LG이노텍과 갤럭시아전자가 따라올 것!"
→ D+1 시초가 평균 +3% 수익
```

---

### Step 4️⃣: 상위 N=2 선택

**코드** (src/strategy.js:514-532)
```javascript
// 정렬된 candidates에서 상위 2개만 선택
const picked = candidates.slice(0, 2);

for (const p of picked) {
  allPicks.push({
    code: p.code,
    name: p.name,
    close: p.close,
    changeRate: p.changeRate,
    cluster_id: clusterId,
    cluster_avg_corr: clusterData.avg_corr,
    rank: allPicks.length + 1,
  });
}
```

**결과** (50:50 분할):
```
Pick #1: LG이노텍(A092310)     +2%  (weight: 0.5, 자본 50,000원)
Pick #2: 갤럭시아전자(A093370) +3%  (weight: 0.5, 자본 50,000원)
```

---

### Step 5️⃣: 자본 분할 정규화

**코드** (src/strategy.js:535-542)
```javascript
let finalPicks = allPicks.slice(0, 2);  // N=2 고정
const totalWeight = finalPicks.length;   // 2

for (const p of finalPicks) {
  p.weight = 1.0 / totalWeight;  // 각각 0.5
}

// 결과:
// Pick #1: weight = 0.5 (자본 200k × 0.5 = 100k)
// Pick #2: weight = 0.5 (자본 200k × 0.5 = 100k)
```

---

### Step 6️⃣: 상한가 가드 (28.5%)

**코드** (src/strategy.js:544-552)
```javascript
const H7_PRICE_GUARD = 0.285;  // 28.5%

const guarded = [];
for (const p of finalPicks) {
  // 상한가 임계값 계산
  const guardThreshold = (p.scannedRow?.prevClose || p.close) * (1 + H7_PRICE_GUARD);
  
  // 현재가 < 상한가 임계값이면 매수 가능
  if (p.close < guardThreshold) {
    guarded.push(p);
  }
}
```

**예시**:
```
LG이노텍:
  현재가: 15,000원
  전일종가: 13,500원
  상한가: 13,500 × 1.285 = 17,347원
  
  15,000 < 17,347? ✅ 통과 → 매수
  
갤럭시아전자:
  현재가: 28,000원
  전일종가: 22,000원
  상한가: 22,000 × 1.285 = 28,270원
  
  28,000 < 28,270? ✅ 통과 → 매수
```

**목적**: 상한가 근처 종목은 체결 불가능 → 제외

---

### Step 7️⃣: 최종 신호 생성 및 매매

**신호 저장** (src/scanner.js:185~280):
```javascript
async function runGapupScan(opts = {}) {
  // 1. 전종목 스캔
  const scanned = await scanAllStocks();
  
  // 2. h7 신호 생성
  const result = await selectGapupPicks(scanned, signalDate);
  
  // 3. signal_log 저장
  stmts.insertSignalLog.run({
    signal_date: signalDate,
    signal_type: 'h7_gapup',
    pick_code: result.picks[0]?.code,
    pick_gapup_ratio: result.picks[0]?.gapup_ratio,
    ...
  });
  
  // 4. pending_buy 저장 (정적 매수, vol_threshold=0)
  for (const pick of result.picks) {
    stmts.insertPendingBuy.run({
      signal_date: signalDate,
      code: pick.code,
      buy_price: pick.close,  // 09:00 day_open
      weight: pick.weight,     // 0.5
      vol_threshold: 0,        // 정적 (동적 X)
      signal_type: 'h7_gapup',
    });
  }
}
```

**매매 실행** (src/scheduler.js:122~200):
```javascript
async function runBuyH7() {
  const krx = isKrxClosed();
  if (krx.closed) {
    log.info('SCHED', `[KRX 폐장] 09:01 h7 매수 skip`);
    return;
  }
  
  // pending_buy에서 h7 신호 조회
  const pending = stmts.getPendingBuyByType.all('h7_gapup');
  
  for (const p of pending) {
    // paper-self | paper | real 모드별 매수 실행
    const filled = await paperBroker.openPosition({
      code: p.code,
      quantity: Math.floor((TOTAL_CAPITAL * p.weight) / p.buy_price),
      price: p.buy_price,
      mode: TRADING_MODE,
    });
    
    // DB 기록
    stmts.insertTrade.run({
      signal_date: p.signal_date,
      code: p.code,
      buy_date: today,
      buy_price: filled.price,
      quantity: filled.quantity,
      signal_type: 'h7_gapup',
    });
  }
  
  // D+1 08:50에 자동 매도됨 (runMorningSell)
}
```

---

## 📈 h7의 특징 (2026-05-31 최신화)

### 백테스트 결과 (2024-06 ~ 2026-05, 2년)
```
매매: 250건
  ├─ 당일 +5% 익절: 51건 (20.4%)
  └─ D+1 시초가 매도: 199건 (79.6%)

승률: 64.8% (매매당)
일평균 수익: +3.01%
중앙값: +1.75%
MDD: -2.16%
누적: +460.6%

3M 윈도우: 0/21 손실 (100% 양수, 최악 +2.15%)
6M 윈도우: 0/18 손실 (100% 양수)
12M 윈도우: 0/12 손실 (최악 +103.92%)
```

### 당일익절 메커니즘 (★ 2026-05-31 신규)
```
D일 매수가: entry_price
당일 익절: close >= entry_price × 1.05 (5%)
익절 시점: 첫 충족 분봉 close
익절 비율: 매매당 20.4% (연평균)
  → 강한 모멘텀은 당일 익절
  → 약한 흐름은 D+1 보유
```

### vs NEMESIS (09:29 편차 신호)
```
수익률: h7 +3.01% > NEMESIS +2.14% (+40% 우수)
MDD: h7 -2.16% < NEMESIS -10.77% (-80% 안전!)
매매수: h7 250 > NEMESIS 127 (2배)
포트폴리오 역할: h7 고수익 보조, NEMESIS 안정 메인
```

---

## 🔑 핵심 이해사항

| 개념 | 의미 | 예시 |
|---|---|---|
| **갭업** | close >= prev_close × 1.10 | 13,500 → 15,000원 (11% 상승) |
| **거래량 5배** | volume >= avgVolume × 5.0 | 평균 100만주 → 500만주 |
| **Cluster** | 같은 움직임을 보이는 그룹 | 반도체, 2차전지, 금융 등 |
| **avg_corr 0.42** | 클러스터 내 상관도 (강함) | NEMESIS 0.34보다 보수적 |
| **Laggard** | 클러스터 내 약한 종목 | +12% 갭업 중에 +2~5%만 오른 종목 |
| **평균회귀** | 약한 종목이 따라올 것이라는 가설 | D+1 평균 +3% 수익 |
| **상한가 가드 28.5%** | 상한가 근처 제외 | prev_close × 1.285 초과면 skip |

---

## 🚀 운영 체크리스트

- [ ] spectral_clusters.parquet 파일 존재 확인 (~/Desktop/project/서랍/out/)
- [ ] BUY_MODE=h7 환경변수 설정
- [ ] TRADING_MODE=paper-self 또는 paper 설정
- [ ] paper-self 4주 신호 안정성 검증
- [ ] paper 2주 KIS API 테스트
- [ ] MDD -12% 임계값 모니터링 설정

---

**이제 h7을 완벽하게 이해할 수 있습니다!** 🎯
