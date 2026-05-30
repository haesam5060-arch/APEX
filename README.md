# APEX — High-Frequency Development Engine (TRASH=0.30)

**14:30 스캔 → 14:50 매수 → T+1 09:00 매도** 자동매매 엔진  
NEMESIS의 spectral clustering 알고리즘을 **TRASH=0.30으로 더 엄격하게 설정**해서 **매매 빈도를 높인 개발용 엔진**

> 📋 **상태**: 개발 중 (TRASH=0.30 버전 최적화 진행)  
> - 매매: +49% 증가 (127 → 189건/2년)
> - 목표: 일평균 수익률 개선 (+1.83% → +2.14%)

---

## 빠른 시작

### 설치
```bash
cd ~/Desktop/project/APEX
npm install
cp .env.sample .env  # API 키 입력
```

### 실행 (paper-self 시뮬레이션)
```bash
TRADING_MODE=paper-self npm start
```

대시보드: http://localhost:3100

### 테스트
```bash
npm test  # 36개 테스트 케이스, 예상 pass 100%
```

---

## 아키텍처

```
[14:30 신호]
  ↓
  scanAllStocks() — 네이버 API (KOSDAQ+KOSPI)
  selectCandidates() — cluster_strength > 1.10 OR change_rate > 25%
  ↓
[14:50 매수]
  ↓
  상한가 가드 (prevClose × 1.285 이상 skip)
  호가 가드 (ask volume = 0 skip) ← 중요
  paperBroker.openPosition() OR realBroker.openPositionReal()
  ↓
[T+1 09:00 매도]
  ↓
  시초가 시장가 매도 (자동)
  daily_pnl 기록
```

---

## 신호

| 파라미터 | 값 | 의미 |
|---|---|---|
| 등락률 윈도우 | 14:00~14:29 | 오후 30분 |
| Top N | 10 | 상위 10개 선정 |
| cluster_strength | >1.10 | 10% 이상 급등 (상한가 근처) |
| change_rate | >25% | 또는 등락률 25% (상한가 근처) |
| exclude_range | 20~25% | 신뢰도 낮음, 제외 |
| 매수 시점 | 14:50 | 고정 시장가 |
| 매도 시점 | T+1 09:00 | 시초가 시장가 |

---

## 성과

### 백테스트 (2024-04-22 ~ 2026-05-27, 2년)

**APEX (TRASH=0.30) vs NEMESIS (TRASH=0.34, CLEAN)**

| 지표 | **NEMESIS** (기준) | **APEX** (개발중) | 평가 |
|---|---|---|---|
| **매매 수** | 127건 | **189건 (+49%)** | ✅ 매매 빈도 높음 |
| **일평균 수익률** | **+2.144%** | +1.828% | ⚠️ -31% (개선 필요) |
| **누적 수익률** | **+514%** | +832% | ✅ 누적은 높지만 일평균 낮음 |
| **MDD** | -10.77% | -11.49% | ⚠️ 미미한 악화 |
| **Sharpe(매매일)** | 5.90 | 5.59 | ⚠️ -5% |
| **3M 손실율** | **0/21** ✅ | **2/21** ❌ | ⚠️ 위험 신호 |
| **6M/12M 손실율** | 0/18, 0/12 ✅ | 0/18, 0/12 ✅ | ✅ 장기 안정성 양호 |
| **G1e'' 가드** | 3회 | 7회 | ⚠️ 불안정성 높음 |

### 현재 평가

**APEX는 매매 빈도는 높지만 개선이 필요한 단계**:
- ✅ **장점**: 신호가 49% 많음 → 더 많은 기회
- ❌ **단점**: 수익성 31% 낮음 + 3M 손실 발생 + G1e 7회
- 🎯 **목표**: 일평균 수익률을 +2.14%까지 개선

### 개선 로드맵

| 우선순위 | 항목 | 목표 |
|---|---|---|
| 1️⃣ | 상한가 함정 제거 (호가 확인) | 명목 신뢰도 ↑ |
| 2️⃣ | 필터 재조정 (change_rate <24%) | 일평균 +2.0% |
| 3️⃣ | 3M 손실 구간 분석 | 0/21 달성 |

→ **Paper-self 검증 중, 지속적 개선 진행**

---

## 설정

### .env 파일

```bash
# 거래 모드
TRADING_MODE=paper-self          # paper-self | paper | real
TOTAL_CAPITAL=200000             # 전체 자본
CAPITAL_SHARE=100000             # 종목당 분할

# 시장 필터
NEMESIS_MARKET_FILTER=KOSDAQ_ETF # KOSDAQ_ONLY | KOSDAQ_ETF | BOTH

# Python & 파이프라인
PYTHON_BIN=/Users/sean/Desktop/project/backtest/.venv/bin/python
UV_BIN=/opt/homebrew/bin/uv

# KIS API (실전)
KIS_APP_KEY=your_key
KIS_APP_SECRET=your_secret
KIS_CANO=your_account_number
KIS_ACNT_PRDT_CD=01

# KIS API (모의)
KIS_PAPER_APP_KEY=your_key
KIS_PAPER_APP_SECRET=your_secret
KIS_PAPER_CANO=your_account_number

# 알림
DISCORD_WEBHOOK_URL=your_webhook_url
GMAIL_USER=your_gmail@gmail.com
GMAIL_APP_PASSWORD=your_app_password

# 기타
TZ=Asia/Seoul
LOG_LEVEL=info
```

---

## 운영 가이드

### Phase 1: Paper-Self (1~2주)

```bash
TRADING_MODE=paper-self npm start
```

**확인 사항**:
- [ ] 14:30에 신호 매일 발생
- [ ] 상한가 가드 동작 (상한가 종목 skip)
- [ ] 호가 가드 동작 (ask volume = 0 skip)
- [ ] 14:50 매수 실행
- [ ] T+1 09:00 매도 실행
- [ ] 실제 체결 가능 성과 측정 (명목 vs 실제 비교)

### Phase 2: Paper (1~2주)

```bash
TRADING_MODE=paper npm start
```

KIS 모의투자 계좌에서 검증

### Phase 3: Real (승인 후)

```bash
TRADING_MODE=real npm start
```

**체크리스트**:
- [ ] API 키 3회 검증
- [ ] 자본 최소 100k로 시작
- [ ] 상한가/호가 가드 확인
- [ ] Discord 알림 설정

---

## 대시보드

### 메인 화면
- 현재 모드 (PAPER / REAL)
- 보유 종목 (P&L 포함)
- 당일 시그널 이벤트
- 누적 손익 KPI

### 최근 시그널 카드
| 이벤트 | 의미 |
|---|---|
| signal | 14:30 스캔 신호 |
| buy | 14:50 매수 체결 |
| excluded | 신호 없음 |

---

## 문제 해결

### "상한가 가도 매수된다"

가드가 동작하지 않을 수 있습니다:
```bash
# 1. 로그 확인
tail -f logs/apex.log | grep "상한가"

# 2. paper-broker.js의 PRICE_GUARD_PCT 검증
# 기본값: 0.285 (28.5%)

# 3. 현재가 업데이트 지연 가능
# → fetchStockDetail() 타이밍 확인
```

### "호가가 없는데 매수된다"

현재 버전은 호가 확인 가드가 미완성입니다:
```bash
# 개발중: src/paper-broker.js의 fetchOrderbook() 호출 추가
# 임시: 14:50 이후 1분 wait로 호가 회복 기다리기
```

### "신호가 안 나온다"

네이버 API 호출 실패일 수 있습니다:
```bash
# 1. 네이워크 확인
curl "https://m.stock.naver.com/api/stocks/marketValue/KOSDAQ?page=1&pageSize=100"

# 2. API 레이트 제한 (429)
# → Retry 로직 있음, 60초 대기 후 재시도

# 3. 스캔 시점 확인
# → 14:30:00 ± 몇 초 내에 실행되는지 확인
```

---

## 테스트

### 전체 테스트
```bash
npm test                         # 36개 테스트
npm test -- --coverage          # 커버리지 리포트
npm test -- tests/strategy.test.js  # 특정 파일
```

### 테스트 내용
- `strategy.test.js` — 신호 생성 로직 (9케이스)
- `scheduler.test.js` — cron 스케줄 (12케이스)
- `db.test.js` — 데이터베이스 스키마 (15케이스)

---

## 상한가 함정 상세 분석

### 백테 결과가 거짓인 이유

1. **상한가 근처 종목 과다 선정**
   - `cluster_strength > 1.10` = 10% 이상 급등 = 거의 상한가
   - `change_rate > 25%` = 등락률 25% = 상한가 기준

2. **상한가 잠김 = 매수 호가 없음**
   ```
   상한가 걸림 → 가격 고정 → 매도만 있음 → ask volume = 0 → 매수 불가
   ```

3. **백테 오류**
   ```
   백테: "14:50 종가(=상한가)에 샀다" 가정 → 수익 계산
   실전: 14:50에 매수호가 없음 → 체결 불가 → -거래비용
   ```

### 진짜 성과 (상한가 제외)
- 승률: 45.2% (<50%)
- 평균 수익: -0.105% (음수)
- **결론**: 현재 신호에 알파가 없음

### 해결 방법
1. **호가 가드** — ask volume > 0 확인
2. **상한가 가드** — prevClose × 1.285 이상 skip
3. **필터 재조정** — change_rate < 24%로 낮추기

---

## 문서

- **CLAUDE.md** — 엔진 로직, 파라미터, 함정 (개발자용)
- **README.md** — 이 파일 (운영자용)

---

## 포트폴리오 전략

| 엔진 | 신호시점 | 매매수 | TRASH | 매매일평균 | MDD | 상태 |
|---|---|---|---|---|---|---|
| **NEMESIS** | 09:29 | 127/2년 | 0.34 | +2.144% | -10.77% | ✅ 안정적 운영 |
| **APEX** | 14:30 | 189/2년 | 0.30 | +1.828% | -11.49% | 🔧 개발 중 |

**포트폴리오 구성**:
- NEMESIS: **메인 엔진** (신뢰도 높음, 핵심 수익)
- APEX: **개발 엔진** (매매 빈도 높음, 개선 중)

**기대효과**:
- ✅ 시간대 분산으로 시장 노출도 ↑
- ✅ 신호 빈도 +49% (기회 증가)
- 🎯 APEX 개선되면 전체 수익성 향상

---

## 라이선스

Internal use only (Copyrighted by sean@example.com)

---

**마지막 업데이트**: 2026-05-30  
**상태**: Paper-Self 검증 단계  
**다음**: 상한가/호가 가드 강화 후 Paper 진입
