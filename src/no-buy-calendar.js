'use strict';

/**
 * no-buy-calendar.js — 매수 금지일 캘린더
 *
 * SSoT (Single Source of Truth):
 *   ~/Desktop/project/backtest/data/no_buy_calendar.json
 *
 * 근거:
 *   cal1_calendar_anomaly 백테 (KOSDAQ 500일 + KOSPI 493일, 2024-04 ~ 2026-05)
 *   - quarter_end (분기말): 양 시장 평균 -0.4 ~ -0.7%, 하락일 비율 62~75%
 *     단측 t-test p<0.1 (양 시장 모두 유의)
 *   - ex_dividend (배당락일): 양 시장 평균 -0.47% (N=2지만 인과적으로 명백)
 *
 * 정책:
 *   - 신규 매수만 차단. 보유 종목 매도/손절/익절은 정상 동작.
 *   - 실전/모의 모두 차단 (일관성).
 *
 * 매년 1회 한국거래소 폐장 일정 발표 후 동기화 필요.
 *   업데이트 위치: backtest/data/no_buy_calendar.json (SSoT) → 본 파일.
 */

const BLOCK_DATES = {
  '20260331': { reason: 'quarter_end', desc: '2026Q1 분기말' },
  '20260630': { reason: 'quarter_end', desc: '2026Q2 분기말' },
  '20260930': { reason: 'quarter_end', desc: '2026Q3 분기말' },
  '20261229': { reason: 'ex_dividend', desc: '2026 배당락일' },
  '20261230': { reason: 'quarter_end', desc: '2026 연말 폐장 (Q4)' },
  '20270331': { reason: 'quarter_end', desc: '2027Q1 분기말' },
  '20270630': { reason: 'quarter_end', desc: '2027Q2 분기말' },
  '20270930': { reason: 'quarter_end', desc: '2027Q3 분기말' },
  '20271229': { reason: 'ex_dividend', desc: '2027 배당락일' },
  '20271230': { reason: 'quarter_end', desc: '2027 연말 폐장 (Q4)' },
  '20280331': { reason: 'quarter_end', desc: '2028Q1 분기말' },
  '20280630': { reason: 'quarter_end', desc: '2028Q2 분기말' },
  '20280929': { reason: 'quarter_end', desc: '2028Q3 분기말' },
  '20281227': { reason: 'ex_dividend', desc: '2028 배당락일' },
  '20281228': { reason: 'quarter_end', desc: '2028 연말 폐장 (Q4)' },
  '20290330': { reason: 'quarter_end', desc: '2029Q1 분기말' },
  '20290629': { reason: 'quarter_end', desc: '2029Q2 분기말' },
  '20290928': { reason: 'quarter_end', desc: '2029Q3 분기말' },
  '20291227': { reason: 'ex_dividend', desc: '2029 배당락일' },
  '20291228': { reason: 'quarter_end', desc: '2029 연말 폐장 (Q4)' },
  '20300329': { reason: 'quarter_end', desc: '2030Q1 분기말' },
  '20300628': { reason: 'quarter_end', desc: '2030Q2 분기말' },
  '20300930': { reason: 'quarter_end', desc: '2030Q3 분기말' },
  '20301227': { reason: 'ex_dividend', desc: '2030 배당락일' },
  '20301230': { reason: 'quarter_end', desc: '2030 연말 폐장 (Q4)' },
};

/** Asia/Seoul 기준 오늘 날짜 (yyyymmdd) */
function todayYmd() {
  const now = new Date();
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = seoul.getUTCFullYear();
  const m = String(seoul.getUTCMonth() + 1).padStart(2, '0');
  const d = String(seoul.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 매수 금지일 여부 + 사유
 * @param {string} [yyyymmdd] - 미지정 시 Asia/Seoul 오늘 사용
 * @returns {{blocked: boolean, reason?: string, desc?: string, date: string}}
 */
function isBuyBlocked(yyyymmdd) {
  const day = yyyymmdd || todayYmd();
  const hit = BLOCK_DATES[day];
  if (hit) {
    return { blocked: true, reason: hit.reason, desc: hit.desc, date: day };
  }
  return { blocked: false, date: day };
}

module.exports = { isBuyBlocked, todayYmd, BLOCK_DATES };
