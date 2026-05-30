// ═══════════════════════════════════════════════════════════════
// buyability.js — 14:50 매수 직전 "체결 가능성" 가드
//
// 배경 (백테 ap6 검증, 2026-05-30):
//   고점근처/오후거래소멸 종목을 고르면 상당수가 상한가(+30%) "잠김" 상태.
//   상한가 잠김 = 매도 호가만 있고 매수 체결 불가 → 백테 수익은 허구.
//   실전에서 이런 종목에 매수 주문을 내면 미체결로 자본만 묶이거나
//   다음 호가에 끌려 슬리피지 폭증.
//
// 정책: 매수 직전, 현재가가 상한가 근처(잠김)이거나 등락률이 과도하면 매수 skip.
//   - 상한가 = 전일종가 × 1.30 (KOSPI/KOSDAQ 가격제한). 잠김 판정 허용오차 0.5%.
//   - cr(등락률) >= CR_CAP(기본 0.29)도 skip (백테 검증: 5~20% 적당주가 엣지).
//
// ⚠️ 매수 전용. 매도/손절/익절에는 절대 적용하지 않는다(보유 청산은 정상 동작해야 함).
// ═══════════════════════════════════════════════════════════════

'use strict';

const LIMIT_TOL = 0.995;   // 상한가 잠김 판정 (close >= upper_limit * 0.995)
const CR_CAP    = 0.29;    // 등락률 상한 (이상이면 상한가 근처로 간주, 매수 skip)

/**
 * isBuyable(curPrice, prevClose, opts) → { ok, reason, cr, upperLimit, locked }
 *
 * @param {number} curPrice  14:50 현재가
 * @param {number} prevClose 전일 종가 (상한가 계산 기준)
 * @param {object} [opts]
 * @param {number} [opts.crCap=0.29]    등락률 상한
 * @param {number} [opts.limitTol=0.995] 잠김 허용오차
 * @returns {{ok:boolean, reason:string, cr:number|null, upperLimit:number|null, locked:boolean}}
 */
function isBuyable(curPrice, prevClose, opts = {}) {
  const crCap   = opts.crCap   ?? CR_CAP;
  const limitTol = opts.limitTol ?? LIMIT_TOL;

  if (!curPrice || curPrice <= 0) {
    return { ok: false, reason: 'no_price', cr: null, upperLimit: null, locked: false };
  }
  if (!prevClose || prevClose <= 0) {
    // 전일종가 없으면 상한가 판정 불가 → 보수적으로 통과시키되 사유 기록
    return { ok: true, reason: 'no_prev_close_skip_limit_check', cr: null, upperLimit: null, locked: false };
  }

  const upperLimit = Math.round(prevClose * 1.30);
  const cr = (curPrice - prevClose) / prevClose;
  const locked = curPrice >= upperLimit * limitTol;

  if (locked) {
    return { ok: false, reason: 'limit_up_locked', cr, upperLimit, locked: true };
  }
  if (cr >= crCap) {
    return { ok: false, reason: `cr_too_high(${(cr * 100).toFixed(1)}%>=${(crCap * 100).toFixed(0)}%)`, cr, upperLimit, locked: false };
  }
  return { ok: true, reason: 'ok', cr, upperLimit, locked: false };
}

module.exports = { isBuyable, LIMIT_TOL, CR_CAP };
