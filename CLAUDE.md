# APEX — 14:30 클러스터 laggard 오버나이트 엔진 (Claude 개발 가이드)

> "오늘 아침 강했던 클러스터에서, 14:30까지 가장 덜 오른 멤버(laggard)를 14:50에 사서 다음날 시초가에 판다."
> 알파 = 클러스터 동조 평균회귀 (오버나이트 갭). 손절 없음 — 손익의 96%가 오버나이트 갭이라 장중 트리거 무의미(ap30).

---

## ★ 운영 상태 (2026-06-11)

- **모드**: `TRADING_MODE=paper-self` (네이버 실시세 + 자체 체결 시뮬, 자금 영향 0) · 포트 3100 · pm2 `apex`
- **BUY_MODE**: `cluster_laggard_1430` · **자본**: 200,000원 (cap2 균등분할, NEMESIS와 독립 병행)
- **공식 기준 백테**: `backtest/analysis/out/aprev2b_live_def_*` — **운영 의미론과 1:1** (아래 "정합 원칙")
- GitHub 이슈 #1~#14 전부 클로즈 (2026-06-11). 결함 이력은 이슈가 SSoT.

## 30초 요약 — 매매 흐름

```
[D 08:50] runMorningSell — T+1 시초가 매도 (전일 매수분 + 그림자 청산)
  └─ 09:00:30 대기 후 시초가 폴 → 매도 → daily_pnl + guard_daily(real) 갱신
[D 09:31] runMorningSnapshotJob — Top10 스냅샷(표시용)
  └─ ★ morning_rets 확정 수집(#8): 전일대비 상위400 ∪ 거래대금 상위200 (~560종목, ~5초)
     → poll_morning_change(09:00~09:29 장중등락) → morning_change 테이블 저장
[D 14:30] runLaggardSignal14 — 신호 (시간창 14:25~14:45)
  ├─ 가드: KRX휴장 → 시간창 → 무매수캘린더 → 레짐(L2 중단 / L1이면 그림자 모드)
  ├─ ETF 리스트 갱신(naver etfItemList → data/etf_codes.json)
  ├─ scanAllStocks(14:30 전일대비) + 저장된 morning_rets(vi_ok, ≥30종목; 부족 시 레거시 폴백)
  └─ apex_laggard_signal.py --live: 아침Top10 → pick_drawer(최다 멤버 클러스터, corr≥0.15·size≥8)
     → 원시 편차(20일 일별수익(완전이력 필수 #14) + 당일 14:30) → bottom3 → ETF 후보 제외(#13)
     → _laggardPending + pending_buy 영속화(#11)
[D 14:50] runLaggardBuy1450 — 매수 (시간창 14:45~15:10)
  ├─ 메모리 픽 없으면 DB 복구(#11)
  ├─ selectLaggardBuyList: 14:50 폴가 → 가격필터 10,000~50,000(양끝포함)
  │  → 상한가잠김 제외(≥ round(prevClose×1.30)×0.995, #7) → lag_rank순 cap2
  └─ 일반: paperBroker 매수 / L1 그림자 모드: shadow_trades 가상기록만(#9)
[T+1 08:50] 시초가 매도 (그림자는 가상청산 → guard_daily(shadow))
```

## 공식 기준 백테 — aprev2b (2024-06 ~ 2026-06, 2년)

| 지표 | 값 |
|---|---|
| 누적 (가드40·비용0.3%·ETF필터) | **+121.5%** |
| MDD | **-11.8%** |
| Sharpe (full / 레짐ON 2025-09~) | 3.73 / **5.82** |
| per-trade (개별주) | +0.62% (승률 64%) |
| 비용 민감도 | 0.5% 왕복까지 L2 안전(롤링63 최저 -2.7%) · **~0.8%부터 L2-A 발동 위험** |

- ETF laggard는 무알파 (per-trade +0.20%·중앙값 -0.11%·승률 43%) + 누적 기여가 레버리지 ETF 단일 테일(20260407 +16.2%)에 집중 → **매수 후보에서 제외** (편차 평균엔 유지, #13). 킬스위치 `APEX_ETF_FILTER=0`.
- 구 백테 수치(ap22 +366%, ap29 +95% 등)는 정합 전 정의(정각분봉·우선주 포함) — 참고용. 채택 수치는 aprev2b만.

## 신호 정의 (운영 파라미터)

| 항목 | 값 | 위치 |
|---|---|---|
| 클러스터 | 서랍 spectral W=20, D-1 스냅샷, avg_corr ≥ 0.15, size ≥ 8 | apex_laggard_signal.py |
| 아침 시드 | 09:00~09:29 장중등락 Top10 (VI필터: first≤905·bars≥20), 우선주 제외(스캔단계) | s10 동일 상수 |
| 편차 | 원시(비중립): 20일 일별 로그수익(완전이력 필수) + ln(1+당일14:30 전일대비) | run_live |
| 후보 | 편차 최저 bottom3 → ETF 제외 → 가격 10,000~50,000 → 상한가잠김 제외 | python+scheduler |
| 실행 | lag_rank 오름차순 cap2, 균등분할, 14:50 시장가(폴가) | selectLaggardBuyList |
| 청산 | T+1 시초가 (손절/익절 없음) | runMorningSell |

## 가드 체계

- **L1 임시휴면** (트레일링40, **표본 1개부터** — 백테 ap29와 동일): 직전 40매매일 guard_daily 누적 < 0 → 실매수 휴면 + **그림자 추적**(신호·가상체결 계속 기록) → 누적 ≥ 0 복귀 시 자동 재개. 휴면=정상 동작이니 당황하지 말 것.
- **L2 레짐붕괴 킬스위치** (래치, 자동재개 X): 롤링63 < -8% OR 피크 DD < -15% → 중단+경보+재설계. `data/regime_halt.json` 수동 삭제로만 reset. L2는 백테에 없는 운영 추가 장치라 콜드스타트 보호(표본 하한) 유지.
- **guard_daily** = 가드 입력 시계열 (신호일 키, real+shadow 통합, 비용차감 평균). daily_pnl 아님!
- 시간창 가드(`APEX_TIME_GUARD=0`로 해제) · 무매수 캘린더(분기말·배당락, no-buy-calendar.js) · KRX 휴장(`data/krx_closed_days.json`, 매년 갱신).

## ★ 백테-운영 정합 원칙 (글로벌 §8.4 — 이 엔진의 제1원칙)

운영 의미론 3종이 백테(aprev2b)에 반영되어 있다. **신호·필터·실행을 수정하면 aprev2b를 같은 정의로 재실행해 재검증할 것**:
1. **last-trade 정의**: 편차 당일조각·진입가 = "t 이하 마지막 체결가" (정각 분봉 아님)
2. **우선주 시드 제외**: scanAllStocks가 이름 정규식으로 제외 → 백테도 코드 끝자리≠0 제외
3. **ETF 후보 제외**: bottom3 산출 후 제거 (lag_rank 보존), 편차 평균엔 유지

검증 이력: 2026-06-10 run_live ↔ 백테기계 5개 날짜 편차 소수점 4자리 일치 / 모닝 프리필터 발산 29%→3%(09:31 수집).

## 디렉토리 구조 (현행 핵심)

```
src/
├── scheduler.js       # cron 5개 + selectLaggardBuyList + 그림자/영속화/시간창 (심장)
├── strategy.js        # selectClusterLaggard1430Live (morning_rets 주입) + _spawnMorningChange
├── db.js              # positions/trades/daily_pnl/guard_daily/shadow_trades/morning_change/pending_buy/scan_flow
├── regime-guard.js    # L1(표본1~, 그림자 입력)/L2(래치) — 입력 = guard_daily
├── stock-fetcher.js   # 네이버: scanAllStocks(우선주 제외)/pollPrices/fetchStockDetail/fetchEtfCodes
├── paper-broker.js    # paper-self 체결 시뮬 (fee 0.35% 왕복)
├── kis-client.js      # KIS 프리미티브 (주문 함수 있음 — 오케스트레이터 real-broker.js는 미구현)
└── (h7 잔재: scanner.js·dynamic-buyer.js·guard-g1e.js 등 — BUY_MODE 분기로 비활성 보존)
scripts/apex_laggard_signal.py   # 신호 (backtest 기계 import — run_live가 운영 경로)
tests/                 # npm test 전체 그린 112건 (laggard-buylist·shadow-guard·morning-rets·etf-filter 등)
data/ (gitignored)     # apex.db·etf_codes.json·krx_closed_days.json·regime_halt.json
```

외부 의존: `backtest/parquet*`(분봉 SSoT) · `서랍/out/spectral_clusters.parquet`(D-1 18:00 launchd) · `backtest/collector/poll_morning_change.py`

## ENV (.env 현행)

| ENV | 값 | 의미 |
|---|---|---|
| BUY_MODE | cluster_laggard_1430 | 엔진 선택 (h7 등은 폐기·보존) |
| TOTAL_CAPITAL | 200000 | cap2 균등분할 |
| APEX_PRICE_LO/HI | 10000/50000 | 진입가 필터 (백테 동일) |
| APEX_DAILY_CAP | 2 | 하루 최대 매수 |
| APEX_SIGNAL_CRON/BUY_CRON | 30 14 / 50 14 | 변경 시 시간창도 함께 조정 |
| APEX_ETF_FILTER | (기본1) | ETF 후보 제외 (#13) |
| APEX_TIME_GUARD | (기본1) | 14:25~14:45/14:45~15:10 창 밖 거부 (#11) |
| MORNING_POLL_N/AMT_N | 400/200 | 09:31 수집 프리필터 (#8) |
| REGIME_L1_TRAIL_DAYS | 40 | L1 트레일링 |
| REGIME_L2_ROLL_DAYS/CUT, L2_DD_CUT | 63/-0.08, -0.15 | L2 (운영 채택값 — ap28 md의 40/-10%는 초안) |

## 자주 막히는 함정

1. **휴면(그림자)은 결함이 아니다** — guard_daily 누적 < 0이면 실매수 없이 가상 추적만. 디스코드에 🕯️ 표기. 자동 재개됨.
2. **신호가 안 나오는 정상 사유**: 활성 클러스터 없음 / corr·size 미달 / bottom3 전부 ETF / 가격필터 전멸 — 매매일은 2년 평균 약 190/489일.
3. **서랍 D-1 스냅샷 의존** — 서랍 빌더(18:00 launchd)가 안 돌면 prev 스냅샷 노후화. `launchctl list | grep seorab`.
4. **09:31 수집 실패 시** 14:30 레거시 폴백(프리필터150) — 동작은 하지만 신호 발산 가능(#8). 로그 warn 확인.
5. **수동 트리거는 시간창 안에서만** — 장외 수동 스캔은 거부됨(#11). 테스트는 `APEX_TIME_GUARD=0`.
6. **종목코드**: 네이버 `012330` ↔ 서랍/백테 `A012330` (`_withA/_stripA`). 신형코드(0163Y0 등) 존재.
7. **분봉 SSoT** — 백테 검증은 backtest/parquet에서만. 엔진에 자체 분봉 캐시 만들지 말 것 (글로벌 §8.4.2).
8. **daily_pnl ≠ guard_daily** — 대시보드 손익은 daily_pnl(매도일 키), 가드는 guard_daily(신호일 키).
9. **pm2 EADDRINUSE 재발 시** — launchd 중복 기동원 확인 (#6 이력: cluster-refit plist가 원인이었음, 현재 .disabled).

## real 전환 게이트 (Phase 2~3 — 전부 충족 전 전환 금지)

1. **real-broker.js 구현** (kis-client 프리미티브는 준비됨; 미구현 상태로 모드 전환 시 기동 차단 안전핀 #10)
2. paper-self 수주 안정 운영 (가드·신호 정상 동작 확인)
3. KIS paper에서 **실왕복슬립 측정 — 중앙값 ≤ 0.5%** (slippage_log 인프라 가동 중; 0.8%↑면 L2 자멸 위험 #3)
4. 사용자 명시 승인 (글로벌 §6)

## 폐기: h7 (09:00 갭업 엔진)

**2026-06-11 폐기 확정** — 백테 +672%는 lookahead(갭업판정 D일 close·거래량 D일 전체) 부풀림, 정직 검증 시 매매당 -1.05% ([#2](https://github.com/haesam5060-arch/APEX/issues/2) wontfix). 코드는 BUY_MODE 분기로 비활성 보존, 과거 문서는 git history (`git show 4afe117:CLAUDE.md`). **h7 lookahead의 교훈: 시점 민감 전략은 신호 시점에 그 데이터를 정말 알 수 있었는지부터 검증할 것.**

---
*Last updated: 2026-06-11 (h7 폐기 확정 + 전면 재작성 — laggard 운영 기준. 결함·검증 이력: GitHub #1~#14)*
