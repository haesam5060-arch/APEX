# APEX (Adaptive Precision Execution Xcluster) — Claude 개발 가이드

> NEMESIS의 spectral clustering 알고리즘을 **14:30 스캔**으로 운영하는 2번째 엔진

---

## ★ 운영 상태 (2026-05-30 기준)

- **모드**: `TRADING_MODE=paper-self` (시뮬레이션, 개발 단계)
- **자본**: `TOTAL_CAPITAL=200,000원` (2종목 분할, NEMESIS와 별도)
- **현재 규칙**: **R1.0 개발용 (14:30 spectral scan, 14:50 매수, T+1 09:00 매도, TRASH=0.30)**
- **env 토글**: `NEMESIS_MARKET_FILTER` = `KOSDAQ_ETF` (기본)
- **포트폴리오 역할**: 
  - NEMESIS: 09:29 pick, TRASH=0.34 (CLEAN, **안정적 운영**)
  - APEX: 14:30 pick, TRASH=0.30 (**개발용, 매매 빈도 높음**)

---

## 30초 요약

- **무엇**: 14:30 등락률 **Top10** → **강한 동조 cluster (TRASH=0.30, 엄격함) 음수 편차 종목** → **14:50 시장가 매수** → T+1 09:00 시초가 매도
- **매매 구조**: **높은 빈도** (일평균 1.83건, NEMESIS 2.14% 대비 -15%), 신호 많음 (189건/2년 vs NEMESIS 127건)
- **자본**: 분할 50:50 (예: 신호 2개 각 100k)
- **포트**: 3100 (maint `real` 범위)
- **개발 목표**: TRASH=0.30 버전의 수익성 개선 (현재 +1.83% → CLEAN 수준 +2.14%까지)
- **알파 메커니즘**: spectral clustering으로 시간대 분산 (NEMESIS 09:29 vs APEX 14:30)

---

## ⚠️ **중대 주의: 상한가 잠김 함정**

### 문제 정의

APEX의 백테 결과(`ap2_apex_robustness`):
- **명목 성과**: 910건 매매, 승률 57.8%, 평균 +1.789%, 누적 **+5188.7%**, Sharpe 4.84
- **실제 성과**: 상한가 잠김 종목 **43~54%**
  - 상한가 잠김 = 14:50에 매수 호가 없음 = 백테 "14:50 종가 체결" 가정은 불가능
  - 실제 체결 가능 종목만: 승률 45.2%, 평균 **-0.105%** (음수!)

### 근본 원인

`cluster_strength > 1.10 OR change_rate > 25%` 신호가 **상한가 근처 종목을 과도하게 선정**:
- 등락률 25% 이상 = 상한가 부근 (p90 30.0%)
- 오후 거래 소멸 (volume_ratio < 0.005) = 상한가 잠김의 결과
- 두 조건이 같은 현상을 이중으로 포착 → **상한가 편향**

### 운영 시 필수 안전장치

```javascript
// dynamic-buyer.js 또는 매수 직전
if (currentPrice >= prevClose * 1.295) {  // 상한가 근처
  skip(code, 'high_price_guard');
  return;
}

// 추가: 14:50 호가창 확인 (네이버 orderbook)
const orderbook = await fetchOrderbook(code);
if (!orderbook || orderbook.asks.length === 0) {
  skip(code, 'no_ask_volume');  // 매도 호가 없음
  return;
}
```

---

## 흐름 (R1.0 — TRASH=0.30, 개발용)

```
[D 08:50] runMorningSell — 전일 매수 포지션(보통 2~4 종목) T+1 시초가 매도
  └─ KRX 휴일 가드: 주말/폐장일 skip
  └─ positions에서 buy_date < today 조건 매도

[D 14:30] runAfternoonScan ★ 핵심 신호 생성
  └─ stock-fetcher.scanAllStocks() 
       — KOSDAQ+KOSPI 전종목 14:00~14:29 등락률 (14:29:00 cutoff)
  
  └─ strategy.selectCandidates() ★ TRASH=0.30 필터 (엄격함)
       ├─ Top10 추출: 등락률 상위 10개 (상한가 +29.5% 컷)
       ├─ cluster_strength 계산:
       │  └─ cluster_strength > 1.10 (10% 이상) OR change_rate > 25% 통과
       ├─ 제외 구간: 20~25% skip (신뢰도 낮음)
       ├─ n(신호 수): 평균 1.83건/일 (NEMESIS 2.14 대비 -15%)
       └─ picks 배열: rank, weight, cluster_strength
  
  └─ signal_log 기록: Top1 정보 + 스냅샷 저장
  └─ pending_buy 저장: vol_threshold=0 (정적 매수)

[D 14:50] runBuy — 정적 시장가 매수 ★ 가드 강화 필요
  └─ KRX 휴일 가드: 폐장일 skip
  └─ FOR each pending:
       ├─ ★ 상한가 가드 (prevClose × 1.285 이상 skip) — 상한가 함정 방지
       ├─ ★ 호가 가드 (ask volume > 0) — CRITICAL (아직 구현 중)
       │  └─ 호가 없음 = 상한가 잠김 = 매수 불가능
       ├─ 매수: paper-self | paper | real 모드 선택
       │  └─ qty = floor(capitalShare × weight / currentPrice)
       └─ positions INSERT, pending_buy.consumed=1

[D+1 08:50] runMorningSell — 매매 청산
  └─ getOpenPositions().filter(buy_date < today)
  └─ FOR each position:
       ├─ 09:00:30까지 대기 → day_open 가격 수집
       ├─ 매도: paper-self | paper | real 모드
       │  └─ ★ 시초가 시장가 매도 (T+1 09:00)
       └─ daily_pnl upsert, trades INSERT
```

**특이점 (NEMESIS R4.2.1과 비교)**:
- ⏰ 시간대: 09:29 (NEMESIS) → **14:30 (APEX)**
- 🔍 파라미터: TRASH=0.34 (NEMESIS) → **TRASH=0.30 (APEX, 더 엄격)**
- 📊 매매: 127건/2년 → **189건/2년 (+49%)**
- 📈 수익률: +2.144% → **+1.828% (-15%)** ⚠️ 개선 중
- 🎯 역할: 메인 엔진 → **개발 엔진 (최적화 진행 중)**

---

## 신호 정의 (R1.0 — TRASH=0.30)

| 파라미터 | APEX (현재) | 설명 | 상태 |
|---|---|---|---|
| **신호 시점** | 14:30 | 14:00~14:29 등락률 (14:29:00 cutoff) | ✅ |
| **Top N** | 10 | 상위 10개 선정 | ✅ |
| **TRASH** | **0.30** | cluster 상관도 임계 (NEMESIS 0.34보다 엄격) | 🔧 개발 중 |
| **cluster_strength_min** | 1.10 | 10% 이상 돌파 (상한가 근처) | ⚠️ 높음 |
| **change_rate_min** | 0.25 | OR 등락률 25% 이상 (상한가 근처) | ⚠️ 높음 |
| **exclude_range** | 20~25% | 신뢰도 낮은 구간, skip | ✅ |
| **n_picks (신호수/일)** | 1.83개 | 일평균 신호 (NEMESIS 2.14 대비 -15%) | 📊 고유 특성 |
| **매매 월 기준** | +1.828% | 일평균 수익률 (NEMESIS +2.144 대비 -31%) | ⚠️ 개선 필요 |
| **매수 시점** | 14:50 | 고정, 시장가 | ✅ |
| **★ 상한가 가드** | <28.5% | prevClose 대비 (상한가 함정 방지) | ✅ |
| **★ 호가 가드** | ask > 0 | 매도호가 존재 여부 확인 | 🔧 구현 중 |
| **매도 시점** | T+1 09:00 | 시초가 시장가 매도 (자동 청산) | ✅ |

**⚠️ 현재 문제점**:
1. **수익성 낮음** (-31%): TRASH=0.30이 과도하게 엄격할 가능성
2. **3M 손실 발생** (2/21): 특정 구간 신호 신뢰도 문제
3. **상한가 함정** (미해결): 호가 없는 종목 매수 → 실제 체결 불가
4. **G1e 가드 높음** (7회): 손실 구간 많음

---

## 모드 (TRADING_MODE)

| 모드 | 시세 | 매매 | 자금 |
|---|---|---|---|
| `paper-self` (기본) | 실전 네이버 | 자체 simulate | 0 |
| `paper` | 실전 KIS | KIS 모의 | 0 |
| `real` | 실전 KIS | KIS 실전 | **사용자 자금** |

**단계**: paper-self (1~2주) → paper (1~2주) → real

---

## 디렉토리

```
APEX/
├── CLAUDE.md (이 파일)
├── README.md
├── package.json
├── server.js
├── .env.sample
├── data/
│   └── apex.db
├── logs/
├── public/
│   ├── index.html
│   └── app.js
├── src/
│   ├── db.js                  # sqlite schema
│   ├── scanner.js             # 14:30 스캔 (selectCandidates)
│   ├── strategy.js            # Top10 + cluster 필터
│   ├── scheduler.js           # cron (08:50/14:30/14:50)
│   ├── stock-fetcher.js       # 네이버 API
│   ├── paper-broker.js        # paper-self 시뮬
│   ├── kis-client.js          # KIS API
│   ├── no-buy-calendar.js     # 매수금지 캘린더
│   ├── krx-calendar.js        # KRX 휴일 가드
│   └── discord-notifier.js    # 디스코드 알림
└── tests/
    ├── strategy.test.js
    ├── scheduler.test.js
    └── db.test.js
```

---

## 백테스트 결과 (2년, 2024-04-22 ~ 2026-05-27)

### APEX (TRASH=0.30) vs NEMESIS (TRASH=0.34, CLEAN)

| 지표 | **NEMESIS** (기준) | **APEX** (개발중) | 차이 | 상태 |
|---|---|---|---|---|
| **매매 수** | 127건 | **189건** | +49% ↑ | 매매 빈도 높음 |
| **매매일** | 92일 | 132일 | +43% ↑ | — |
| **일평균 수익률** | **+2.144%** | +1.828% | -31% ↓ | ⚠️ 개선 필요 |
| **매매당 수익률** | +2.089% | ? | — | 추정 -20% |
| **누적 수익률** | +514% ✅ | +832% | +62% ↑ | 매매 수 증가 효과 |
| **MDD** | -10.77% | -11.49% | -6.6% ↓ | 미미한 악화 |
| **Sharpe(매매일)** | 5.90 | 5.59 | -5% ↓ | 거의 동등 |
| **3M 손실율** | **0/21** ✅ | **2/21** ❌ | — | ⚠️ 위험 신호 |
| **6M 손실율** | 0/18 ✅ | 0/18 ✅ | — | 동일 |
| **12M 손실율** | 0/12 ✅ | 0/12 ✅ | — | 동일 |
| **G1e'' 가드** | 3회 | 7회 | +4회 | ⚠️ 불안정 |

### 현재 상태

**APEX (TRASH=0.30)는 개발 단계 버전**:
- ✅ **매매 빈도 높음** (+49%) → 더 많은 신호 포착
- ❌ **수익성 낮음** (-31%) → **개선 필요**
- ⚠️ **안정성 떨어짐** (3M 손실, G1e 7회) → **개선 필요**
- 🎯 **목표**: 일평균 수익률을 +2.14% (NEMESIS 수준)까지 개선

### 개선 방향

1. **상한가 함정 해결** (우선순위 1)
   - 호가 확인 가드 추가
   - 매도 호가 부재 시 skip

2. **필터 재조정** (우선순위 2)
   - change_rate > 25% → < 24% 검토
   - cluster_strength 임계값 재평가

3. **신호 정제** (우선순위 3)
   - 불수익 종목군 분석
   - 3M 손실 구간 원인 파악

---

## 즉시 적용 사항 (R1.0 → R1.1 upgrade)

### 1. 상한가 가드 강화 (필수)

```javascript
// src/paper-broker.js openPosition()
const PRICE_GUARD_PCT = 0.285;  // prevClose 대비 28.5% 이상 skip
if (currentPrice >= prevClose * (1 + PRICE_GUARD_PCT)) {
  log.warn('BROKER', `상한가 가드 발동 ${pick.name}(${pick.code})`);
  return null;  // skip
}
```

### 2. 호가 확인 가드 (필수)

```javascript
// src/stock-fetcher.js 또는 paper-broker.js
const orderbook = await fetchOrderbook(code);
if (!orderbook || orderbook.asks.length === 0) {
  log.warn('BROKER', `호가 없음(상한가 잠김) ${code}`);
  return null;
}

// ask1 잔량 vs 주문 규모 비교
const ask1Qty = orderbook.asks[0].qty;
const orderQty = Math.floor(budget / currentPrice);
if (orderQty > ask1Qty * 10) {  // 호가의 10배 이상 주문 → 슬리피지
  log.warn('BROKER', `호가 부족 ${code}: ask=${ask1Qty}, order=${orderQty}`);
  return null;
}
```

### 3. 신호 필터 review

- `change_rate > 25%` → 상한가 편향 심함, `< 24%`로 조정 고려
- `cluster_strength > 1.10` 도 재평가 필요

---

## 검증 기록

### ap1 (기본, 2026-05-30)
- 매매 910 / 승률 57.8% / 평균 1.789% / 누적 +5188.7%
- ⚠️ 상한가 잠김 43.8%

### ap2 (robustness, 2026-05-30)
- 월별 손실일 0/26 (100% 양수)
- OOS 성과 (250거래일 후): 승률 57.7% / 평균 2.067% / Sharpe 5.26
- ⚠️ 여전히 상한가 함정 미해결

### ap6 (clean filter 시도, 2026-05-30)
- 명목 +2.28% → 실제 -0.403% (상한가 제외)
- **결론**: 필터가 상한가 셀렉터만 한다

---

## 운영 매뉴얼 (R1.1 가드 적용 후 예상)

| 임계 | 트리거 | 액션 |
|---|---|---|
| 3M 누적 -3% | 알파 약화 의심 | paper 다운그레이드 검토 |
| 6M 누적 손실 | 즉시 정지 | 원인 분석 |
| MDD -15% | 비중 축소 | 자본 50% 감축 |
| 상한가 매수율 > 20% | 신호 신뢰도 ↓ | 필터 재조정 |
| 호가 없음 skip > 10% | 슬리피지 리스크 | vol_threshold 재평가 |

---

## 자주 막히는 함정

1. **상한가 잠김을 실거래로 착각** — 백테 명목치만 믿지 말 것
2. **호가 확인 안 함** — 14:50 매수호가 미존재 → 체결 0
3. **cluster_strength 인플레** — 14:30 등락률이 크면 임계값 자동 상승
4. **네이버 API 실패** — 14:30 스캔 API가 느리면 신호 놓침
5. **신호 시간대 혼동** — APEX는 14:30, NEMESIS는 09:29 (다름!)

---

## 다음 단계

### Phase 1: 코드 검증 (1시간)
```bash
npm test  # 36개 테스트, 상한가/호가 가드 검증
```

### Phase 2: Paper-self 운영 (1~2주)
- 14:30 신호 매일 발생 확인
- 상한가 가드/호가 가드 동작 확인
- 실제 체결 가능 성과 측정 (명목치 vs 실제)

### Phase 3: 필터 재조정 (1주)
- change_rate 임계값 < 25% 검토
- cluster_strength 재평가
- n_picks 분할 비율 최적화

### Phase 4: Real 진입 (승인 후)
- Paper 모드 1주 추가 검증
- KIS 실전 자본 할당 (최소 100k)

---

## NEMESIS vs APEX 상세 비교

| 항목 | **NEMESIS** (TRASH=0.34) | **APEX** (TRASH=0.30) | 비고 |
|---|---|---|---|
| **신호 시점** | 09:29 | 14:30 | 시간대 분산 |
| **TRASH 임계** | 0.34 (관대) | **0.30 (엄격)** | APEX가 더 강한 cluster만 선택 |
| **데이터 소스** | spectral (D-1 18:00) | 네이버 실시간 | APEX는 당일 14:30 기준 |
| **매매 수 (2년)** | **127건** | **189건 (+49%)** | APEX가 매매 빈도 높음 |
| **매매일** | **92일** | **132일 (+43%)** | APEX가 더 자주 신호 발생 |
| **일평균 수익률** | **+2.144%** ✅ | +1.828% | NEMESIS 수익성 31% 높음 |
| **누적 수익률** | +514% ✅ | +832% | 매매 수 많음으로 인한 복리 효과 |
| **MDD** | -10.77% ✅ | -11.49% | NEMESIS가 6% 더 안전 |
| **3M 손실율** | **0/21 ✅** | **2/21 ❌** | NEMESIS 100% 안정, APEX 위험 |
| **Sharpe(매매일)** | 5.90 | 5.59 | 거의 동등 |
| **G1e 가드 발동** | 3회 | 7회 | APEX가 더 불안정 |
| **포트폴리오 역할** | 메인 엔진 (신뢰도 높음) | 개발 엔진 (최적화 진행 중) | NEMESIS는 운영, APEX는 개선 |
| **상태** | ✅ 안정적 운영 | 🔧 개발 중 (수익성 개선 목표) | APEX 목표: 수익률 +2.14% 달성 |

**전략**:
- **NEMESIS**: 핵심 수익원, 안정적 운영
- **APEX**: 보조 엔진, 매매 빈도 높음, 지속 개선 중

---

**⚠️ 상한가 함정 해결 전 REAL 진입 금지**  
Paper-self에서 실제 체결 가능 성과 확인 후 진행.

*Last updated: 2026-05-30 (상한가 함정 문서화)*
