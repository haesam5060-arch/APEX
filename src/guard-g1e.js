// ═══════════════════════════════════════════════════════════════
// APEX G1e'' 자기진단 가드 (NEMESIS 룰 포팅 — P2 분할 시퀀스용)
//
// 동작:
//   - 트리거: 직전 N=4 매매일의 일별 가중 수익률 누적 ≤ -4%
//     수식: (1+rd1)(1+rd2)(1+rd3)(1+rd4) - 1 ≤ -0.04
//     매매일 = trades 테이블의 sell_date 단위 (같은 sell_date의 여러 매매는 단순 평균
//             — P2 50:50 분할이라 단순 평균 = 가중 평균)
//   - skip: 트리거 발생한 매매일부터 K=3 매매일 skip (pending_buy 생성 안 함)
//   - cooldown: skip 카운터 0이 된 후 다음 K=3 매매일 동안 재트리거 면제
//
// 호출 위치:
//   src/scanner.js runScan() 안, picks가 결정된 직후·pending_buy 생성 직전.
//
// 백테 일치 (CLAUDE.md §8.4):
//   - 백테 analysis/s49_g1e_retune.py (P2 입력 grid sweep)와 동일 정의
//   - 상수 4개: TRIGGER_N=4, TRIGGER_CUM=-0.04, SKIP_K=3, COOLDOWN_K=3
//   - 카운트 단위: 매매일 (sell_date) — 한 매매일에 2종목 매매해도 1매매일로 카운트
//   - 트리거 판정 데이터 = trades 테이블의 mode 일치 최근 N 매매일의 매매당 평균
// ═══════════════════════════════════════════════════════════════
const { db } = require('./db');

// ── 가드 상수 (백테 s49/s53과 반드시 동일) ──────────────────
const TRIGGER_N = 4;        // 직전 N 매매일 (체결된 매매일 기준)
const TRIGGER_CUM = -0.04;  // 누적 -4%
const SKIP_K = 3;           // 트리거 시 다음 K 매매일 skip
const COOLDOWN_K = 3;       // 가드 해제 후 K 매매일 동안 재트리거 면제

// ── 스키마 초기화 ────────────────────────────────────────────
// ★ db.js 스키마와 동일하게 유지 (싱글톤 guard_state)
// 이미 db.js에서 테이블 생성, 여기서는 SELECT/UPDATE 쿼리만 사용
// db.exec(`CREATE TABLE ...`)은 호출하지 않음 (중복 정의 방지)

// db.js 스키마 확인:
//   CREATE TABLE IF NOT EXISTS guard_state (
//     id INTEGER PRIMARY KEY CHECK (id = 1),
//     mode TEXT NOT NULL,
//     skip_remaining INTEGER DEFAULT 0,
//     cooldown_remaining INTEGER DEFAULT 0,
//     last_trigger_date TEXT,
//     last_signal_date TEXT,
//     cum_return_4d REAL DEFAULT 0.0,
//     updated_at TEXT NOT NULL
//   );

// ── 내부 statements ──────────────────────────────────────────
const _stm = {
  get: db.prepare(`SELECT * FROM guard_state WHERE id = 1`),
  // ★ db.js 스키마와 일치: mode, skip_remaining, cooldown_remaining, last_trigger_date,
  //   last_signal_date, cum_return_4d, updated_at
  update: db.prepare(`
    UPDATE guard_state SET
      mode = @mode,
      skip_remaining = @skip_remaining,
      cooldown_remaining = @cooldown_remaining,
      last_trigger_date = @last_trigger_date,
      last_signal_date = @last_signal_date,
      cum_return_4d = @cum_return_4d,
      updated_at = datetime('now', 'localtime')
    WHERE id = 1
  `),
  // 직전 N 매매일의 매매당 평균 (P2 50:50 분할이라 단순 평균 = 가중 평균)
  // 향후 불균등 분할 도입 시 trades 테이블에 weight 컬럼 추가 + WEIGHTED AVG로 변경
  lastNDays: db.prepare(`
    SELECT sell_date, AVG(return_pct) AS day_avg_ret, COUNT(*) AS n_picks
    FROM trades
    WHERE mode = ?
    GROUP BY sell_date
    ORDER BY sell_date DESC
    LIMIT ?
  `),
  resetState: db.prepare(`
    UPDATE guard_state SET
      skip_remaining = 0,
      cooldown_remaining = 0,
      updated_at = datetime('now', 'localtime')
    WHERE id = 1
  `),
};

// ── 누적 수익률 계산: (1+r1)(1+r2)(1+r3)(1+r4) - 1 ──────────────
function compoundReturn(rets) {
  return rets.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

// ── 현재 상태 조회 (테스트·디버깅용) ──────────────────────────
function getState() {
  return _stm.get.get();
}

// ── 상태 초기화 (테스트용 또는 운영 중 가드 해제) ─────────────
function reset() {
  _stm.resetState.run();
}

/**
 * 가드 체크 및 상태 업데이트.
 *
 * 호출 시점: 시그널이 발생한 매매일 (picks가 비어있지 않은 경우).
 * 시그널 미발생일은 호출 안 함 (가드 카운터 차감 안 함).
 *
 * @param {string} mode - 'paper-self' | 'paper' | 'real'
 * @param {string} signalDate - 'YYYYMMDD'
 * @returns {Object} {
 *   action: 'pass' | 'skip_active' | 'skip_triggered',
 *   stateBefore: {...},
 *   stateAfter: {...},
 *   recentDays: {sell_date, day_avg_ret, n_picks}[] | null,
 *   recentCum: number | null,
 *   reason: string,
 * }
 */
function checkAndApply(mode, signalDate) {
  // ★ db.js 스키마와 일치: id, mode, skip_remaining, cooldown_remaining,
  //   last_trigger_date, last_signal_date, cum_return_4d, updated_at
  const before = _stm.get.get() || {
    id: 1,
    mode: mode,
    skip_remaining: 0,
    cooldown_remaining: 0,
    last_trigger_date: null,
    last_signal_date: null,
    cum_return_4d: 0,
    updated_at: new Date().toISOString(),
  };

  // ─── 1) skip 활성 중 ───────────────────────────────────────
  if (before.skip_remaining > 0) {
    const newSkip = before.skip_remaining - 1;
    const newCooldown = (newSkip === 0) ? COOLDOWN_K : before.cooldown_remaining;
    _stm.update.run({
      mode: mode,
      skip_remaining: newSkip,
      cooldown_remaining: newCooldown,
      last_trigger_date: before.last_trigger_date,
      last_signal_date: before.last_signal_date || signalDate,
      cum_return_4d: before.cum_return_4d || 0,
    });
    return {
      action: 'skip_active',
      stateBefore: before,
      stateAfter: _stm.get.get(),
      recentDays: null,
      recentCum: null,
      reason: `skip 활성 (남은 skip ${newSkip} 매매일${newSkip === 0 ? `, cooldown 활성화 ${COOLDOWN_K} 매매일` : ''})`,
    };
  }

  // ─── 2) cooldown 중 → 정상 매매 + cooldown 차감, 트리거 체크 안 함 ───
  if (before.cooldown_remaining > 0) {
    _stm.update.run({
      mode: mode,
      skip_remaining: 0,
      cooldown_remaining: before.cooldown_remaining - 1,
      last_trigger_date: before.last_trigger_date,
      last_signal_date: signalDate,
      cum_return_4d: recentCum || 0,
    });
    return {
      action: 'pass',
      stateBefore: before,
      stateAfter: _stm.get.get(),
      recentDays: null,
      recentCum: null,
      reason: `cooldown 진행 중 (남은 ${before.cooldown_remaining - 1} 매매일)`,
    };
  }

  // ─── 3) skip=0, cooldown=0 → 직전 N 매매일 누적 체크 ───────
  const rows = _stm.lastNDays.all(mode, TRIGGER_N);  // 최신순 N개 매매일
  if (rows.length < TRIGGER_N) {
    return {
      action: 'pass',
      stateBefore: before,
      stateAfter: before,
      recentDays: rows,
      recentCum: null,
      reason: `매매일 이력 부족 (체결 ${rows.length} 매매일 < ${TRIGGER_N})`,
    };
  }

  const recentDayRets = rows.map(r => r.day_avg_ret);
  const cum = compoundReturn(recentDayRets);

  if (cum <= TRIGGER_CUM) {
    // 트리거! 현재 매매일이 첫 skip이므로 newSkip = SKIP_K - 1
    const newSkip = SKIP_K - 1;
    const newCooldown = (newSkip === 0) ? COOLDOWN_K : 0;
    _stm.update.run({
      mode: mode,
      skip_remaining: newSkip,
      cooldown_remaining: newCooldown,
      last_trigger_date: signalDate,
      last_signal_date: signalDate,
      cum_return_4d: cum,
    });
    return {
      action: 'skip_triggered',
      stateBefore: before,
      stateAfter: _stm.get.get(),
      recentDays: rows,
      recentCum: cum,
      reason: `가드 트리거 (직전 ${TRIGGER_N} 매매일 누적 ${(cum * 100).toFixed(2)}% ≤ ${(TRIGGER_CUM * 100).toFixed(0)}%) — 본 매매일 포함 ${SKIP_K} 매매일 skip`,
    };
  }

  // ─── 4) 트리거 안 됨 → 정상 진행 ─────────────────────────
  return {
    action: 'pass',
    stateBefore: before,
    stateAfter: before,
    recentDays: rows,
    recentCum: cum,
    reason: `정상 (직전 ${TRIGGER_N} 매매일 누적 ${(cum * 100).toFixed(2)}% > ${(TRIGGER_CUM * 100).toFixed(0)}%)`,
  };
}

module.exports = {
  checkAndApply,
  getState,
  reset,
  compoundReturn,
  TRIGGER_N,
  TRIGGER_CUM,
  SKIP_K,
  COOLDOWN_K,
};
