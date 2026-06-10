// ═══════════════════════════════════════════════════════════════
// regime-guard.js — APEX 14:30 클러스터 laggard 엔진 레짐 안전장치 (2026-06-01)
//
// 백테 근거: backtest/analysis/out/ap28_apex_engine_spec_regime_summary.md
//   - 레짐 ON = 2025-09-01 (이전 횡보·손실). 굿레짐 롤링63 최저 +31%, MDD -13%.
//   - 배드레짐(2024) 롤링40 최저 -17%, MDD -19%.
//
// 2단 구조:
//   L1 (자동 임시휴면): 직전 L1_TRAIL_DAYS(40) 매매일 누적 < 0 → 실매수 휴면.
//                       표본 1개부터 작동 (백테 ap29 가드 `len(p)<1 or sum>=0`와 동일, APEX#9).
//                       ★ 휴면 중에도 scheduler가 신호·그림자 체결(shadow_trades)을 기록해
//                       guard_daily 시계열이 계속 굴러감 → 누적 ≥ 0 복귀 시 자동 재개.
//                       (구버전: daily_pnl 입력 + 휴면 시 신규 행 없음 → 영구휴면 결함)
//   L2 (레짐붕괴 킬스위치, 자동재개 X): 롤링 L2_ROLL_DAYS(63) 매매일 누적 < L2_ROLL_CUT(-8%)
//                       OR 피크대비 드로다운 < L2_DD_CUT(-15%)
//                       → 매매 중단 + 경보 + "레짐 기반 재설계" 트리거.
//                       래치(JSON 파일)되어 수동 reset() 전까지 유지.
//                       L2는 백테에 없는 운영 추가 안전장치라 콜드스타트 보호(표본 하한) 유지.
//
// 임계 근거: 굿레짐은 절대 안 건드리고(롤링63 +31%/MDD -13%) 배드레짐은 확실히 잡도록
//            둘 사이(-8% / -15%)에 설정.
//
// 일별 수익 입력 = guard_daily.r (신호일 키, 실현 real + 그림자 shadow 통합, 비용 차감 — APEX#9).
//   백테 r 시계열(cap2 매매 평균, 신호일 인덱스)과 동일 의미.
// ═══════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const L1_TRAIL_DAYS = parseInt(process.env.REGIME_L1_TRAIL_DAYS || '40', 10);
const L2_ROLL_DAYS = parseInt(process.env.REGIME_L2_ROLL_DAYS || '63', 10);
const L2_ROLL_CUT = parseFloat(process.env.REGIME_L2_ROLL_CUT || '-0.08'); // 롤링63 누적 컷
const L2_DD_CUT = parseFloat(process.env.REGIME_L2_DD_CUT || '-0.15');     // 피크 드로다운 컷

const HALT_FILE = path.resolve(__dirname, '..', 'data', 'regime_halt.json');

// ── 순수 평가 로직 (테스트 용이) ─────────────────────
/**
 * @param {number[]} rets - 매매일별 실현 수익률(소수, 예 +0.018), 시간순(오래된→최신)
 * @returns {{
 *   l1Dormant: boolean, l2Breach: boolean,
 *   trailingSum: number, rolling: number, drawdown: number,
 *   reasons: string[]
 * }}
 */
function evaluate(rets) {
  const reasons = [];
  const n = rets.length;

  // L1: 직전 L1_TRAIL_DAYS 누적 (단순합 ≈ 로그누적, 작은 값에서 동등)
  const trail = rets.slice(Math.max(0, n - L1_TRAIL_DAYS));
  const trailingSum = trail.reduce((s, r) => s + r, 0);
  // ★ 백테(ap29/aprev2b 가드: len(p)<1 or sum>=0)와 동일 — 표본 1개부터 작동 (APEX#9).
  //   (구버전 n>=40 콜드스타트 보호는 백테에 없는 임의 완화였음. 휴면 중에도
  //    그림자 추적(guard_daily kind=shadow)이 시계열을 굴려 자동 재개 가능.)
  const l1Dormant = n >= 1 && trailingSum < 0;
  if (l1Dormant) reasons.push(`L1: 직전 ${Math.min(n, L1_TRAIL_DAYS)}매매일 누적 ${(trailingSum * 100).toFixed(1)}% < 0 → 임시휴면(그림자 추적)`);

  // L2-A: 롤링 L2_ROLL_DAYS 복리누적
  const roll = rets.slice(Math.max(0, n - L2_ROLL_DAYS));
  const rolling = roll.reduce((eq, r) => eq * (1 + r), 1) - 1;
  const l2Roll = n >= L2_ROLL_DAYS && rolling < L2_ROLL_CUT;
  if (l2Roll) reasons.push(`L2-A: 롤링 ${L2_ROLL_DAYS}매매일 누적 ${(rolling * 100).toFixed(1)}% < ${(L2_ROLL_CUT * 100).toFixed(0)}% → 레짐붕괴`);

  // L2-B: 전체 equity 피크대비 드로다운
  let eq = 1, peak = 1, drawdown = 0;
  for (const r of rets) {
    eq *= (1 + r);
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < drawdown) drawdown = dd;
  }
  // 드로다운 컷도 콜드스타트 보호: 최소 L1_TRAIL_DAYS 표본 확보 후에만 작동
  const l2Dd = n >= L1_TRAIL_DAYS && drawdown < L2_DD_CUT;
  if (l2Dd) reasons.push(`L2-B: 피크대비 드로다운 ${(drawdown * 100).toFixed(1)}% < ${(L2_DD_CUT * 100).toFixed(0)}% → 레짐붕괴`);

  return { l1Dormant, l2Breach: l2Roll || l2Dd, trailingSum, rolling, drawdown, reasons };
}

// ── L2 래치 영속화 (수동 reset 전까지 유지) ─────────────────────
function _readHalt() {
  try {
    if (fs.existsSync(HALT_FILE)) return JSON.parse(fs.readFileSync(HALT_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return null;
}
function _writeHalt(obj) {
  try {
    fs.mkdirSync(path.dirname(HALT_FILE), { recursive: true });
    fs.writeFileSync(HALT_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { /* ignore */ }
}

function isHalted() { return !!_readHalt(); }
function reset() {
  try { if (fs.existsSync(HALT_FILE)) fs.unlinkSync(HALT_FILE); } catch (e) { /* ignore */ }
}

/**
 * daily_pnl 기반 레짐 판정 + L2 래치.
 * @param {{ stmts: object, mode?: string, now?: string }} opts
 * @returns {{
 *   canTrade: boolean, dormant: boolean, halted: boolean,
 *   layer: 'OK'|'L1'|'L2', metrics: object, reasons: string[]
 * }}
 */
function checkRegime({ stmts, mode = 'paper-self', now = null }) {
  // 이미 L2 래치 상태면 즉시 중단
  const latched = _readHalt();
  if (latched) {
    return {
      canTrade: false, dormant: false, halted: true, layer: 'L2',
      metrics: latched.metrics || {}, reasons: [`L2 래치됨(${latched.at}): ${(latched.reasons || []).join('; ')} — 수동 reset 필요`],
    };
  }

  // 최근 일별수익 로드 (충분히 길게: max(L1,L2)+여유)
  //   ★ 입력 = guard_daily (실현 real + 그림자 shadow 통합, 신호일 키) — APEX#9.
  //   휴면 중에도 shadow 행이 쌓여 시계열이 굴러감 (구 daily_pnl 입력은 휴면 시 동결 → 영구휴면).
  const limit = Math.max(L1_TRAIL_DAYS, L2_ROLL_DAYS) + 10;
  const rows = (stmts.recentGuardDaily.all(limit) || []).slice().reverse(); // 오래된→최신
  const rets = rows.map(r => (typeof r.r === 'number' ? r.r : 0));

  const ev = evaluate(rets);

  if (ev.l2Breach) {
    const at = now || new Date(Date.now() + 9 * 3600 * 1000).toISOString();
    const payload = { at, mode, metrics: { rolling: ev.rolling, drawdown: ev.drawdown }, reasons: ev.reasons };
    _writeHalt(payload);
    return {
      canTrade: false, dormant: false, halted: true, layer: 'L2',
      metrics: payload.metrics, reasons: ev.reasons,
    };
  }
  if (ev.l1Dormant) {
    return {
      canTrade: false, dormant: true, halted: false, layer: 'L1',
      metrics: { trailingSum: ev.trailingSum }, reasons: ev.reasons,
    };
  }
  return {
    canTrade: true, dormant: false, halted: false, layer: 'OK',
    metrics: { trailingSum: ev.trailingSum, rolling: ev.rolling, drawdown: ev.drawdown }, reasons: [],
  };
}

module.exports = {
  evaluate,
  checkRegime,
  isHalted,
  reset,
  L1_TRAIL_DAYS,
  L2_ROLL_DAYS,
  L2_ROLL_CUT,
  L2_DD_CUT,
  HALT_FILE,
};
