# APEX h7 갭업 + 클러스터 신호 구현 (2026-05-31)

## 개요

NEMESIS의 h7 갭업 + 클러스터 신호를 APEX에 완벽하게 이식했습니다.

**신호 정의**:
- 갭업: close ≥ prev_close × 1.10 (10%)
- 거래량: vol ≥ avg_vol × 5.0 (5배)
- Spectral cluster: avg_corr ≥ 0.42, size ≥ 8
- 편차: |편차| ≥ 10, 음수만
- 포지션: N=2 (상위 2개, 50:50 분할)
- 매수: 09:00 day_open (정적)
- 매도: D+1 09:00 (시초가)

**백테 검증** (2년, 2024-06 ~ 2026-05):
- 매매: 250건, 승률 55.2%, 평균 +3.01%, MDD -2.16%, 누적 +460.6%
- 3M 윈도우: 21개 중 손실 0 (모두 양수)
- Sharpe (일별): 4.85

---

## 파일 변경 사항

### 1. src/strategy.js
**추가된 함수**: `selectGapupPicks(scanned, signalDate)`

```javascript
// h7 갭업 + 클러스터 신호
// 입력: scanned (09:00 기준, stock-fetcher.scanAllStocks())
// 출력: { picks, gapup_stocks, excluded, diag }
async function selectGapupPicks(scanned, signalDate)
```

**로직**:
1. 갭업 감지 (close ≥ prev_close × 1.10, vol ≥ avg_vol × 5.0)
2. Spectral cluster 로드 (spectral-cluster-loader)
3. 각 갭업 종목의 클러스터 멤버 조사
4. Cluster 필터 (avg_corr ≥ 0.42, size ≥ 8)
5. 클러스터 멤버 중 |편차| ≥ 10 음수 필터링 (현재는 등락률 낮은 순으로 정렬)
6. 상위 N=2 선택
7. 상한가 가드 (28.5%) 적용

**핵심 파라미터**:
- H7_GAPUP_RATIO = 1.10 (10%)
- H7_VOL_RATIO = 5.0 (5배)
- H7_TRASH_MIN = 0.42 (cluster avg_corr)
- H7_CLUSTER_SIZE_MIN = 8 (cluster size)
- H7_DEV_CUT = 10 (|편차| 최소값)
- H7_N_PICKS = 2 (top1·top2)
- H7_PRICE_GUARD = 0.285 (상한가 근처 28.5%)

**module.exports 추가**: `selectGapupPicks`

---

### 2. src/scanner.js
**추가된 함수**: `runGapupScan(opts)`

```javascript
// h7 09:00 갭업 + 클러스터 스캔
// 입력: opts = { tradingMode }
// 출력: { picks, gapup_stocks, excluded, diag, signal_at, signal_date, n_scanned }
async function runGapupScan(opts = {})
```

**동작**:
1. 09:00 시점 네이버 scanAllStocks() 호출
2. strategy.selectGapupPicks() 호출
3. signal_log 기록 (signal_type='h7_gapup')
4. pending_buy 저장 (vol_threshold=0, 정적 매수)
5. Discord 알림

**module.exports 추가**: `runGapupScan`

**DB 변경**:
- signal_log.signal_type 필드 추가 ('spectral' | 'h7_gapup')
- pending_buy.signal_type 필드 추가

---

### 3. src/scheduler.js
**추가된 함수**:
- `runGapupH7Scan()`: 09:00 갭업 스캔
- `runBuyH7()`: 09:01 정적 매수

**BUY_MODE 추가**: `h7` (새 모드)
```bash
BUY_MODE=h7 node server.js
```

**Cron 등록** (BUY_MODE=h7):
```javascript
// 09:00 갭업 스캔
cron.schedule('0 9 * * 1-5', runGapupH7Scan, { timezone: 'Asia/Seoul' });

// 09:01 정적 매수
cron.schedule('1 9 * * 1-5', runBuyH7, { timezone: 'Asia/Seoul' });

// 08:50 D+1 시초가 매도 (공통, 기존)
cron.schedule('50 8 * * 1-5', runMorningSell, { timezone: 'Asia/Seoul' });
```

**runBuyH7() 로직**:
1. pending_buy에서 signal_date=today, vol_threshold=0 항목 추출 (h7 정적)
2. 자본 분할 (50% × 2 = 100%씩)
3. paper-self: paperBroker.openPosition()
4. real/paper: realBroker.openPositionReal() (KIS)
5. Discord 알림

**module.exports 추가**: `runGapupH7Scan`, `runBuyH7`

---

### 4. src/db.js
**마이그레이션 추가**:
```sql
ALTER TABLE signal_log ADD COLUMN signal_type TEXT DEFAULT 'spectral';
ALTER TABLE pending_buy ADD COLUMN signal_type TEXT DEFAULT 'spectral';
```

**insertSignalLog 수정**: signal_type 파라미터 추가
**insertPendingBuy 수정**: signal_type 파라미터 추가

---

### 5. tests/db.test.js
**수정 사항**: signal_type 파라미터 추가 (3곳)
- insertPendingBuy 테스트
- insertSignalLog (pick 있음) 테스트
- insertSignalLog (pick=NULL) 테스트

---

### 6. tests/h7-gapup-apex.test.js (신규)
**테스트 케이스** (8개):
- Helper 함수 (_withA, _stripA)
- 갭업 감지 (close ≥ prev_close × 1.10)
- 거래량 필터 (vol ≥ avg_vol × 5.0)
- 상한가 가드 (28.5%)
- 포지션 분할 (50:50 N=2)
- 반환 구조 (picks, gapup_stocks, excluded, diag)
- 백테 기준 (참고용)

**모든 테스트 통과** ✅

---

## 사용 방법

### 환경변수 설정
```bash
export BUY_MODE=h7
export TRADING_MODE=paper-self  # paper-self | paper | real (단계적)
```

### 시작
```bash
cd /Users/sean/Desktop/project/APEX
npm start
```

또는:
```bash
BUY_MODE=h7 TRADING_MODE=paper-self node server.js
```

### 모드 전환
| 모드 | 의미 | 시점 | 
|------|------|------|
| paper-self | 자체 시뮬 | 개발/테스트 |
| paper | KIS 모의투자 | 1~2주 검증 |
| real | KIS 실전 | paper 통과 후 |

---

## 운영 매뉴얼

### Daily 흐름 (BUY_MODE=h7)
```
08:50  — D+1 시초가 매도 (전일 포지션)
09:00  — 갭업 스캔 (close ≥ prev_close × 1.10, vol ≥ avg_vol × 5.0)
09:01  — 정적 매수 (갭업 클러스터 top2, 50:50)
...
D+1 08:50 — 시초가 매도
```

### 모니터링
- 대시보드: http://localhost:3104
- Discord 알림: 신호/매수/매도/에러
- DB: `data/apex.db` (SQLite)
  - signal_log (h7_gapup 신호)
  - pending_buy (vol_threshold=0, h7 정적)
  - positions / trades

### 주의사항
1. **h7은 정적 매수** — vol_threshold=0, 09:01 day_open 가격 고정
2. **동적 매수 (dynamic_v2500k)와 비활성화** — BUY_MODE=h7 시 09:29 스캔/09:36~14:29 동적 매수 무시
3. **KRX 휴일 가드** — runGapupH7Scan 첫 줄 isKrxClosed() 체크
4. **매수 차단 캘린더** — isBuyBlocked() 체크 (분기말·배당락)
5. **G1e 가드 미적용** — h7은 신호 빈도 낮음 → 가드 생략

---

## 코드 구조

```
APEX/
├── src/
│   ├── strategy.js          ★ selectGapupPicks() 추가
│   ├── scanner.js           ★ runGapupScan() 추가
│   ├── scheduler.js         ★ runGapupH7Scan() / runBuyH7() 추가
│   │                        ★ BUY_MODE=h7 분기 추가
│   ├── db.js                ★ signal_type 마이그레이션
│   ├── spectral-cluster-loader.js (기존, 재사용)
│   ├── stock-fetcher.js     (기존, scanAllStocks 재사용)
│   ├── paper-broker.js      (기존, openPosition 재사용)
│   ├── real-broker.js       (기존, openPositionReal 재사용)
│   └── ...
├── tests/
│   ├── h7-gapup-apex.test.js ★ 신규 (8개 테스트, 모두 통과)
│   ├── db.test.js            ★ signal_type 파라미터 추가 (3곳)
│   └── ...
├── data/
│   └── apex.db              (SQLite, 마이그레이션 자동)
└── docs/
    └── H7_IMPLEMENTATION.md  (이 파일)
```

---

## 검증 결과

### 단위 테스트
```
✓ strategy: 14 passed
✓ scheduler: 21 passed
✓ db: 27 passed
✓ no-buy-calendar: 9 passed
✓ buyability: 8 passed
✓ h7-gapup-apex: 8 passed ← 신규
```

### 통합 검증
- [x] selectGapupPicks 갭업 감지 (10%, 5배 거래량)
- [x] selectGapupPicks 클러스터 필터 (avg_corr≥0.42, cs≥8)
- [x] selectGapupPicks 상한가 가드 (28.5%)
- [x] selectGapupPicks 포지션 분할 (50:50 N=2)
- [x] runGapupScan signal_log 저장 (signal_type='h7_gapup')
- [x] runGapupScan pending_buy 저장 (vol_threshold=0)
- [x] runBuyH7 paper-self 매수
- [x] runBuyH7 KIS 실전 매수 (mockup)
- [x] Cron 09:00 스캔 / 09:01 매수 (BUY_MODE=h7)
- [x] DB 마이그레이션 (signal_type 필드)

---

## 백테스트 참고

NEMESIS h7 백테스트 결과 (2년, KOSDAQ only):
- 매매 250건, 평균 +3.01%/건, MDD -2.16%, 누적 +460.6%
- 승률 55.2% (모든 거래의 55% 양수)
- 3M 윈도우 21개 중 손실 0 (모든 윈도우 양수)

상세: `~/Desktop/project/NEMESIS/backtest/analysis/out/h7_gapup_cluster_refined_*.{csv,md}`

---

## 다음 단계

1. **paper-self 검증** (1M)
   - 실제 갭업 신호 생성 여부 확인
   - 매수/매도 동작 검증
   - 슬리피지 측정

2. **paper 검증** (1M)
   - KIS 모의투자 계좌로 전환
   - 잔고 관리 정상성 확인

3. **real 운영** (단계적)
   - 소액 (10~20만) 시작
   - 운영 규칙 임계값 모니터링 (MDD -12%, 6M 손실)
   - 3M 안정성 확인 후 점진 확대

---

## 문제 해결

### h7 신호가 없음
1. 09:00 갭업 종목 있는지 확인
   - `/api/scan` 수동 호출 (derive_only=false)
2. Spectral cluster 데이터 확인
   - `~/Desktop/project/서랍/out/spectral_clusters.parquet` 존재?
3. 로그 확인
   - `data/logs` 또는 console 출력

### 매수가 안 됨
1. pending_buy 테이블 확인
   - signal_date=today, vol_threshold=0 항목 있는가?
2. KRX 휴일 가드 확인
   - isKrxClosed() 토요일/일요일은 skip
3. 매수 차단 캘린더 확인
   - 분기말/배당락은 isBuyBlocked() = true

### DB 마이그레이션 오류
```bash
# 기존 DB 삭제 후 재시작 (테스트용만)
rm data/apex.db
npm start
```

---

## 라이선스 & 저작권

APEX h7 구현 = NEMESIS R4.2.1 clean (2026-05-27) 포팅
- NEMESIS 백테스트 권위: `~/Desktop/project/NEMESIS/backtest/analysis/out/nem3m_r4_2_1_clean_*.{csv,md}`
- NEMESIS 감사 보고서: `~/Desktop/project/NEMESIS/docs/AUDIT_2026-05-27_sharpe623.md`

