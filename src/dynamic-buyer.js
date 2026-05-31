// ═══════════════════════════════════════════════════════════════
// APEX dynamic-buyer — D1 동적 매수 코어 (NEMESIS R4.2.1 포팅)
//
// 메커니즘 (백테 nem3m_d1_finer.py V=2,500,000 + nem3m_r4_2_1_v2patch.py 검증):
//   - 09:35부터 분봉 누적 거래량 추적 (cum_vol = Σ volume from 0935)
//   - cum_vol ≥ vol_threshold (default 2.5M) 도달 첫 분봉의 open 가격에 시장가 매수
//   - 14:30까지 미트리거 시 14:30 분봉 open에 시장가 매수 (fallback)
//
// 데이터 출처 (SSoT — CLAUDE.md §8.4.2):
//   backtest/collector/poll_minute_vol.py (collect.py의 fetch_minute 재사용)
//   매분 spawn으로 호출 → JSON stdout 파싱
//
// 백테 결과 (R4.2.1, 2년, KOSDAQ 사전 필터, V=2.5M):
//   매매 126 / 매매당 +1.21% / 일평균 +2.30% / MDD -10.77% / Sharpe 6.23 / 누적 +561% / 6M loss 0/18
// ═══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const { db, log, stmts } = require('./db');
const paperBroker = require('./paper-broker');
const realBroker = require('./real-broker');
const { fetchOrderbook, estimateFillPrice } = require('./stock-fetcher');
const { PRICE_GUARD_PCT } = require('./strategy');

const UV_BIN = process.env.UV_BIN || '/opt/homebrew/bin/uv';
const COLLECTOR_DIR = path.resolve(__dirname, '..', '..', 'backtest', 'collector');
const POLL_SCRIPT_NAME = 'poll_minute_vol.py';

const DEFAULT_V_THRESHOLD = 2_500_000;
const WATCH_START_HHMM = 935;
const WATCH_END_HHMM = 1430;

// 저가주 가드 — R4.2.2 도입 (2026-05-27 백테 검증)
//   매수가 < LOW_PRICE_GUARD 면 매수 skip (exit_type='low_price_blocked').
//   기본 1000원 — backtest/analysis/nem3m_r4_2_1_low_price_guard 결과:
//     baseline 대비 Sharpe(캘린더) 2.45→3.08 (+26%), MDD -10.77%→-6.70% (-38%), G1e 3회→1회
//   env LOW_PRICE_GUARD로 override (0 = 가드 끔, 옛 R4.2.1 동작)
const LOW_PRICE_GUARD = parseInt(process.env.LOW_PRICE_GUARD || '1000', 10);

// 매수 진행 중인 종목 lock (중복 매수 방지)
//   real-broker _waitForFill polling이 95초까지 길어질 수 있어서,
//   다음 1분 cron이 같은 pending에 또 매수 시도하지 못하게 막음.
//   add → executeBuy (체결 polling 포함) → finally delete 패턴.
const _inProgressBuys = new Set();
function _resetInProgress() { _inProgressBuys.clear(); }

// 테스트/시뮬용 polling 함수 대체 hook (default = 실제 spawn)
let _pollImpl = null;
function _setPollImpl(fn) { _pollImpl = fn; }
function _resetPollImpl() { _pollImpl = null; }

/**
 * collector/poll_minute_vol.py 호출 → JSON 결과 반환.
 * @param {string[]} codes - 'A123456' 형식
 * @param {string} signalDate - 'YYYYMMDD'
 * @param {number} watchStart - 기본 935
 * @returns {Promise<{ok: boolean, data: Object}>}
 */
function pollMinuteVol(codes, signalDate, watchStart = WATCH_START_HHMM) {
  if (_pollImpl) return _pollImpl(codes, signalDate, watchStart);
  return _spawnPollMinuteVol(codes, signalDate, watchStart);
}

function _spawnPollMinuteVol(codes, signalDate, watchStart) {
  return new Promise((resolve, reject) => {
    if (!codes.length) {
      return resolve({ ok: true, data: {} });
    }
    const args = [
      'run', '--quiet', POLL_SCRIPT_NAME,
      ...codes,
      '--date', signalDate,
      '--watch-start', String(watchStart),
    ];
    const proc = spawn(UV_BIN, args, { cwd: COLLECTOR_DIR });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`spawn 실패: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`poll exit ${code}: ${stderr || stdout}`));
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) {
        reject(new Error(`poll JSON 파싱 실패: ${e.message}\nstdout: ${stdout}`));
      }
    });
  });
}

/**
 * 매분 호출: 활성 pending 종목들 polling → 임계 도달 시 매수.
 * @param {string} signalDate
 * @param {Object} opts - { tradingMode, totalCapital, prevCloseMap (optional, code → prevClose), kisCfg, feeRoundTrip }
 * @returns {Promise<{active, polled, triggered, errors}>}
 */
async function checkAndTrigger(signalDate, opts = {}) {
  const tradingMode = opts.tradingMode || 'paper-self';
  const totalCapital = opts.totalCapital || 500_000;
  const prevCloseMap = opts.prevCloseMap || {};

  const pendings = stmts.getAllPendingBuys.all(signalDate)
    .filter((p) => (p.vol_threshold || 0) > 0);
  if (!pendings.length) return { active: 0, polled: 0, triggered: [], errors: [] };

  const codes = pendings.map((p) => p.pick_code);
  let pollResult;
  try {
    pollResult = await pollMinuteVol(codes, signalDate);
  } catch (e) {
    log.error('DYN_BUY', `polling 실패: ${e.message}`);
    return { active: pendings.length, polled: 0, triggered: [], errors: [e.message] };
  }
  if (!pollResult.ok) {
    log.error('DYN_BUY', `poll ok=false: ${JSON.stringify(pollResult)}`);
    return { active: pendings.length, polled: 0, triggered: [], errors: ['poll_not_ok'] };
  }

  const triggered = [];
  const errors = [];
  for (const p of pendings) {
    const vol = pollResult.data?.[p.pick_code];
    if (!vol || vol.error) {
      const reason = vol?.error || 'no_data';
      log.warn('DYN_BUY', `polling 결과 없음 ${p.pick_name}(${p.pick_code}): ${reason}`);
      errors.push({ code: p.pick_code, reason });
      continue;
    }
    // cum_vol 진행 업데이트
    stmts.updatePendingCumVol.run(vol.cum_vol_from_start || 0, p.id);

    // ★ prev_close auto-cache (poll 응답에서 받음, SSoT = backtest parquet D-1)
    //   opts.prevCloseMap은 scheduler가 빈 객체로 전달 → 첫 poll에 자동 채워짐.
    //   다음 분 호출에서도 같은 객체 참조라 캐시 유지.
    if (vol.prev_close != null && prevCloseMap[p.pick_code] == null) {
      prevCloseMap[p.pick_code] = vol.prev_close;
    }

    if ((vol.cum_vol_from_start || 0) >= (p.vol_threshold || DEFAULT_V_THRESHOLD)) {
      // ★ 중복 매수 방지 lock — _waitForFill (~95초) 중에 다음 cron 진입 가능
      if (_inProgressBuys.has(p.pick_code)) {
        log.info('DYN_BUY', `[LOCK] ${p.pick_name}(${p.pick_code}) 매수 진행 중 — 이 cron tick skip`);
        continue;
      }
      _inProgressBuys.add(p.pick_code);
      try {
        const result = await executeBuy(p, vol.last_price, 'triggered', vol.last_bar, vol.cum_vol_from_start, {
          tradingMode, totalCapital, prevClose: prevCloseMap[p.pick_code],
          kisCfg: opts.kisCfg, feeRoundTrip: opts.feeRoundTrip,
        });
        if (result) triggered.push({ code: p.pick_code, buy_time: vol.last_bar, price: vol.last_price });
      } catch (e) {
        log.error('DYN_BUY', `매수 실패 ${p.pick_name}: ${e.message}`);
        errors.push({ code: p.pick_code, reason: e.message });
      } finally {
        _inProgressBuys.delete(p.pick_code);
      }
    } else {
      // 미트리거 — 진행률만 기록 (DB cum_vol 업데이트는 위에서 이미)
      const pct = ((vol.cum_vol_from_start || 0) / (p.vol_threshold || DEFAULT_V_THRESHOLD) * 100).toFixed(0);
      log.info('DYN_BUY',
        `${p.pick_name}(${p.pick_code}) cum_vol ${(vol.cum_vol_from_start || 0).toLocaleString()} / ` +
        `임계 ${p.vol_threshold.toLocaleString()} (${pct}%, bar=${vol.last_bar})`);
    }
  }
  return { active: pendings.length, polled: Object.keys(pollResult.data || {}).length, triggered, errors };
}

/**
 * 14:30 fallback: 미트리거 pending 일괄 매수.
 * 14:30 시점 분봉 close 가격으로 매수.
 */
async function runFallbackBuy(signalDate, opts = {}) {
  const tradingMode = opts.tradingMode || 'paper-self';
  const totalCapital = opts.totalCapital || 500_000;
  const prevCloseMap = opts.prevCloseMap || {};

  const pendings = stmts.getAllPendingBuys.all(signalDate)
    .filter((p) => (p.vol_threshold || 0) > 0);
  if (!pendings.length) return { active: 0, bought: [], errors: [] };

  const codes = pendings.map((p) => p.pick_code);
  let pollResult;
  try {
    pollResult = await pollMinuteVol(codes, signalDate, WATCH_END_HHMM);
  } catch (e) {
    log.error('DYN_BUY', `fallback polling 실패: ${e.message}`);
    return { active: pendings.length, bought: [], errors: [e.message] };
  }

  const bought = [];
  const errors = [];
  for (const p of pendings) {
    const vol = pollResult.data?.[p.pick_code];
    if (!vol || vol.error || vol.last_price == null) {
      errors.push({ code: p.pick_code, reason: vol?.error || 'no_data' });
      continue;
    }
    // ★ prev_close auto-cache (fallback도 동일 — 14:30 첫 poll에서 받음)
    if (vol.prev_close != null && prevCloseMap[p.pick_code] == null) {
      prevCloseMap[p.pick_code] = vol.prev_close;
    }
    // ★ 중복 매수 방지 lock — 14:29 트리거가 아직 진행 중일 가능성 (95초 polling이 14:30 넘김)
    if (_inProgressBuys.has(p.pick_code)) {
      log.info('DYN_BUY', `[LOCK] fallback ${p.pick_name}(${p.pick_code}) 이미 매수 진행 중 — skip`);
      continue;
    }
    _inProgressBuys.add(p.pick_code);
    try {
      const result = await executeBuy(p, vol.last_price, 'fallback', WATCH_END_HHMM, vol.cum_vol_from_start, {
        tradingMode, totalCapital, prevClose: prevCloseMap[p.pick_code],
        kisCfg: opts.kisCfg, feeRoundTrip: opts.feeRoundTrip,
      });
      if (result) bought.push({ code: p.pick_code, price: vol.last_price });
    } catch (e) {
      log.error('DYN_BUY', `fallback 매수 실패 ${p.pick_name}: ${e.message}`);
      errors.push({ code: p.pick_code, reason: e.message });
    } finally {
      _inProgressBuys.delete(p.pick_code);
    }
  }
  return { active: pendings.length, bought, errors };
}

/**
 * 실제 매수 실행. 상한가 가드(+28.5%) 체크 → broker 호출 → DB markPendingBought.
 * @returns {Object|null} - 매수된 position 또는 null (가드 skip)
 */
async function executeBuy(pending, currentPrice, exitType, buyTime, cumVol, opts) {
  const { tradingMode, totalCapital, prevClose } = opts;

  // ★ 저가주 가드 — R4.2.2 (2026-05-27 백테 검증, env LOW_PRICE_GUARD=0이면 비활성)
  //   동전주 1틱 슬리피지 + 상한가 락 후 폭락 패턴 회피
  if (LOW_PRICE_GUARD > 0 && currentPrice > 0 && currentPrice < LOW_PRICE_GUARD) {
    log.warn('DYN_BUY',
      `[LOW_PRICE_GUARD] ${pending.pick_name}(${pending.pick_code}) skip — ` +
      `매수가 ${currentPrice.toLocaleString()}원 < ${LOW_PRICE_GUARD.toLocaleString()}원 (R4.2.2)`);
    stmts.markPendingBought.run(buyTime, `${exitType}_low_price`, cumVol, pending.id);
    return null;
  }

  // 상한가 가드 — 종목별 독립 적용
  if (prevClose != null && prevClose > 0 && currentPrice >= prevClose * (1 + PRICE_GUARD_PCT)) {
    log.warn('DYN_BUY',
      `[PRICE_GUARD] ${pending.pick_name}(${pending.pick_code}) skip — ` +
      `매수가 ${currentPrice.toLocaleString()} >= D-1종가 ${prevClose.toLocaleString()} × 1.285 ` +
      `(+${((currentPrice / prevClose - 1) * 100).toFixed(2)}%)`);
    stmts.markPendingBought.run(buyTime, `${exitType}_blocked`, cumVol, pending.id);
    return null;
  }

  // ★ 호가 가드 (R1.1 신규) — 매도 호가 부재 = 상한가 잠김 = 체결 불가능
  //   상한가 함정 해결: 43~54% 종목이 호가 없어서 체결되지 않는 현상 방지
  let orderbook = null;
  try {
    orderbook = await fetchOrderbook(pending.pick_code);
  } catch (e) {
    log.warn('DYN_BUY',
      `[ASK_GUARD] 호가 조회 실패 ${pending.pick_name}(${pending.pick_code}): ${e.message}`);
    // 호가 조회 실패 = 네트워크 이슈 → pending 유지 (재시도 가능)
    throw e;
  }

  if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) {
    log.warn('DYN_BUY',
      `[ASK_GUARD] ${pending.pick_name}(${pending.pick_code}) skip — ` +
      `매도호가 없음 (상한가 잠김, 체결 불가능)`);
    stmts.markPendingBought.run(buyTime, `${exitType}_no_ask`, cumVol, pending.id);
    return null;
  }

  // ask1 잔량 vs 주문 규모 비교 (슬리피지 검사)
  const capital = totalCapital * (pending.weight || 1.0);
  const estimatedQty = Math.floor(capital / currentPrice);
  const ask1Qty = orderbook.asks[0].qty;

  if (estimatedQty > ask1Qty * 10) {
    // ask1의 10배 이상 → 슬리피지 심각, 여러 단계 호가 뚫려야 함
    const estimatedFill = estimateFillPrice(orderbook.asks, capital);
    log.warn('DYN_BUY',
      `[ASK_GUARD] ${pending.pick_name}(${pending.pick_code}) skip — ` +
      `호가 부족 (주문량=${estimatedQty.toLocaleString()}주 > ask1=${ask1Qty.toLocaleString()}주×10) ` +
      `추정 체결가=${estimatedFill?.toLocaleString() || 'null'}원`);
    stmts.markPendingBought.run(buyTime, `${exitType}_slippage`, cumVol, pending.id);
    return null;
  }

  const pick = {
    code: pending.pick_code,
    name: pending.pick_name,
    buy: currentPrice,
    cluster_id: pending.pick_cluster_id ?? null,
    cluster_count: null,
    cluster_size: null,
    signal_source: pending.pick_signal_source || null,
    deviation: pending.pick_deviation ?? null,
    abs_dev: pending.pick_abs_dev ?? null,
    top10_rank: null,
    change_rate_929: null,
    rank: pending.rank ?? 1,
    weight: pending.weight ?? 1.0,
    signal_date: pending.signal_date,
  };

  let opened = null;
  if (tradingMode === 'paper-self') {
    opened = paperBroker.openPosition(pick, capital);
  } else if (tradingMode === 'paper' || tradingMode === 'real') {
    // KIS 실주문 (Phase 3a — real-broker 통합)
    if (!opts.kisCfg) {
      throw new Error(`dynamic-buyer: ${tradingMode} 모드는 kisCfg 필요`);
    }
    const strategyCfg = {
      totalCapital, capitalShare: capital,
      feeRoundTrip: opts.feeRoundTrip || 0.0035,
    };
    const result = await realBroker.openPositionReal(pick, strategyCfg, opts.kisCfg);
    if (result.opened) {
      opened = result.opened;
    } else if (result.failed) {
      log.error('DYN_BUY', `${tradingMode} 매수 실패 ${pending.pick_name}: ${result.failed.error}`);
      // 가드/예수금 실패 등 — pending 소비 처리 (재시도 안 함)
      stmts.markPendingBought.run(buyTime, `${exitType}_failed`, cumVol, pending.id);
      return null;
    }
  } else {
    throw new Error(`dynamic-buyer: unknown tradingMode '${tradingMode}'`);
  }

  if (opened) {
    stmts.markPendingBought.run(buyTime, exitType, cumVol, pending.id);
    log.info('DYN_BUY',
      `${exitType.toUpperCase()} 매수 [${tradingMode}] ${pending.pick_name}(${pending.pick_code}) ` +
      `@ ${currentPrice.toLocaleString()} (bar=${buyTime}, cum_vol=${cumVol.toLocaleString()})`);
  }
  return opened;
}

module.exports = {
  pollMinuteVol,
  checkAndTrigger,
  runFallbackBuy,
  executeBuy,
  DEFAULT_V_THRESHOLD,
  WATCH_START_HHMM,
  WATCH_END_HHMM,
  LOW_PRICE_GUARD,
  _setPollImpl,
  _resetPollImpl,
  _resetInProgress,
};
