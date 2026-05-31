// ═══════════════════════════════════════════════════════════════
// APEX 스케줄러 — spectral cluster + 동적 매수 (NEMESIS 포팅, TRASH=0.30)
//
// 매일 KST (평일):
//   08:50           - 전일 매수 포지션 D+1 동시호가 매도 (09:00 시초가 체결)
//   09:29           - 스캔 → Top10 → 서랍 시그널 (TRASH=0.30) → pending_buy 저장 (매수 X)
//   09:36~14:29     - 매분 cum_vol 폴링 → 2.5M 도달 시 시장가 매수 (triggered)
//   14:30           - 미트리거 pending 일괄 매수 (fallback)
//   D+1 09:00       - 시초가 매도
//
// 차이점 vs 구 APEX:
//   - cluster_strength (비율) → spectral clustering (편차)
//   - 14:50 정적 매수 → 09:36~14:29 동적 + 14:30 fallback
//   - pending_buy: vol_threshold, cum_vol, buy_time, exit_type 추가
// ═══════════════════════════════════════════════════════════════

'use strict';

const cron = require('node-cron');
const { runScan, runGapupScan } = require('./scanner');
const paperBroker = require('./paper-broker');
// real-broker는 paper-self 모드에서 불필요 (조건부 로드)
let realBroker = null;
try {
  realBroker = require('./real-broker');
} catch (e) {
  // real-broker 없음 (paper-self 모드에서는 사용 안 함)
}
const { fetchStockDetail } = require('./stock-fetcher');
const { isBuyBlocked } = require('./no-buy-calendar');
const { isKrxClosed } = require('./krx-calendar');
const { PRICE_GUARD_PCT } = require('./strategy');
const discord = require('./discord-notifier');
const mail = require('./email-notifier');
const { log, stmts } = require('./db');

let _config = null;

// 매매 모드 — env로 제어
//   BUY_MODE=static_1101 (default, 옛 R4.1'' 호환) : 11:01 정적 매수 (spectral cluster)
//   BUY_MODE=dynamic_v2500k : 09:36~14:30 동적 매수 (R4.2 D1 백테 검증, spectral cluster)
//   BUY_MODE=h7 : 09:00 갭업 + 클러스터 신호 → 09:01 정적 매수 (2026-05-31 신규, 당일 익절 ON)
const BUY_MODE = process.env.BUY_MODE || 'static_1101';

// h7 당일 익절 설정 (env로 제어)
//   H7_INTRADAY_TARGET=1.05 (기본, +5% 익절)
//   H7_INTRADAY_TARGET=0 (비활성화, D+1 09:00 매도만 사용)
const H7_INTRADAY_TARGET = parseFloat(process.env.H7_INTRADAY_TARGET || '1.05');

// h7 모드에서는 동적 매수 불필요 (조건부 로드)
let dynBuyer = null;
if (BUY_MODE !== 'h7') {
  dynBuyer = require('./dynamic-buyer');
}
const VOL_THRESHOLD = dynBuyer ? parseInt(process.env.VOL_THRESHOLD || `${dynBuyer.DEFAULT_V_THRESHOLD}`, 10) : 0;

// h7 모드에서는 G1e 가드 불필요 (조건부 로드)
let guardG1e = null;
if (BUY_MODE !== 'h7') {
  guardG1e = require('./guard-g1e');
}

// D-1 종가 메모리 캐시 (signal_date → { code: prevClose })
//   09:29 스캔 직후 picks의 prevClose 수집해서 저장
//   dynamic-buyer 호출 시 prevCloseMap으로 전달 (상한가 가드용)
const _prevCloseCache = new Map();

function _isRealMode() {
  return _config?.tradingMode === 'real' || _config?.tradingMode === 'paper';
}

function _kisCfg() {
  const mode = _config.tradingMode;
  if (mode === 'paper') {
    return {
      appKey: _config.kis.paperAppKey,
      appSecret: _config.kis.paperAppSecret,
      cano: _config.kis.paperCano,
      acntPrdtCd: _config.kis.acntPrdtCd || '01',
      simulated: true,
    };
  }
  return {
    appKey: _config.kis.appKey,
    appSecret: _config.kis.appSecret,
    cano: _config.kis.cano,
    acntPrdtCd: _config.kis.acntPrdtCd || '01',
    simulated: false,
  };
}

function todayKstDate() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function todayKstYmd() {
  return todayKstDate().replace(/-/g, '');
}

function getOpenPositions() {
  return paperBroker.getOpenPositions();
}

// ── h7 09:00 갭업 스캔 ─────────────────────
async function runGapupH7Scan() {
  const krx = isKrxClosed();
  if (krx.closed) {
    log.info('SCHED', `[KRX 폐장] 09:00 h7 갭업 스캔 skip — ${krx.reason}${krx.name ? ` (${krx.name})` : ''}`);
    return;
  }
  log.info('SCHED', `09:00 h7 갭업 스캔 시작`);

  const blockCheck = isBuyBlocked();
  if (blockCheck.blocked) {
    log.warn('SCHED', `매수 금지일 — ${blockCheck.desc}. 스캔만 실행 (매수 안 함)`);
    await discord.sendBuyBlocked?.(blockCheck);
  }

  try {
    const result = await runGapupScan({
      tradingMode: _config.tradingMode,
    });

    if (!result.picks || result.picks.length === 0) {
      log.info('SCHED', `09:00 h7 스캔 — 갭업 후보 없음. 오늘 노매매.`);
      await discord.sendNoSignal?.(result);
    } else {
      const summary = result.picks.map(p =>
        `${p.name}(${p.code}, gapup=${(p.gapup_ratio * 100).toFixed(1)}%, corr=${p.cluster_avg_corr?.toFixed(2)})`
      ).join(' / ');
      log.info('SCHED',
        `09:00 h7 갭업 신호 — ${result.picks.length} 종목: ${summary}`);
      await discord.sendSignal?.(result);
    }
  } catch (e) {
    log.error('SCHED', `h7 갭업 스캔 실패: ${e.message}`);
    await discord.sendError?.(`09:00 h7 갭업 스캔 실패: ${e.message}`);
  }
}

// ── h7 09:01 정적 매수 ─────────────────────
async function runBuyH7() {
  const krx = isKrxClosed();
  if (krx.closed) {
    log.info('SCHED', `[KRX 폐장] 09:01 h7 매수 skip — ${krx.reason}${krx.name ? ` (${krx.name})` : ''}`);
    return;
  }
  log.info('SCHED', `09:01 h7 정적 매수 시작`);

  const blockCheck = isBuyBlocked();
  if (blockCheck.blocked) {
    log.warn('SCHED', `매수 금지일 — ${blockCheck.desc}. 매수 skip`);
    return;
  }

  try {
    const today = todayKstDate();
    const todayYmd = today.replace(/-/g, '');
    // pending_buy에서 signal_date=today, vol_threshold=0 (h7 정적) 항목 추출
    const allPending = stmts.getPendingsByDate.all(todayYmd) || [];
    // vol_threshold=0 (h7 정적) + 미체결(consumed=0)만
    const h7Pending = allPending.filter(p => p.vol_threshold === 0 && !p.consumed);

    if (h7Pending.length === 0) {
      log.info('SCHED', `09:01 h7 매수 — pending_buy 없음`);
      return;
    }

    log.info('SCHED', `09:01 h7 매수 — ${h7Pending.length}건`);
    for (const pending of h7Pending) {
      try {
        const capital = Math.floor(_config.strategy.totalCapital * (pending.weight || 0.5));
        log.info('SCHED', `  h7 매수 대기: ${pending.pick_name}(${pending.pick_code}) @${pending.pick_buy} 자본=${capital}`);

        if (_isRealMode()) {
          // 실전 매수 (KIS)
          const buyResult = await realBroker.openPositionReal(
            { code: pending.pick_code, name: pending.pick_name },
            { rank: pending.rank, weight: pending.weight },
            capital,
            _config.strategy,
            _kisCfg(),
            'h7_gapup'
          );
          if (buyResult.success) {
            stmts.markPendingBought.run('0901', 'h7_static', 0, pending.id);
            log.info('SCHED', `  [KIS] h7 매수 성공: ${pending.pick_name}(${pending.pick_code}) @${buyResult.price}`);
            // sendBuy(pick, opened, mode) — opened에 qty/buy_price 필요
            await discord.sendBuy?.(
              { code: pending.pick_code.replace(/^A/, ''), name: pending.pick_name, theme: 'h7', change_rate_901: null },
              { qty: buyResult.qty ?? 0, buy_price: buyResult.price ?? 0 },
              _config.tradingMode
            );
          } else {
            log.error('SCHED', `  [KIS] h7 매수 실패: ${pending.pick_name}(${pending.pick_code}) — ${buyResult.error}`);
            await discord.sendError?.(`h7 매수 실패: ${pending.pick_name}(${pending.pick_code}): ${buyResult.error}`);
          }
        } else {
          // paper-self 매수 — openPosition(pick, budget) 시그니처에 맞춰 호출
          // pick.buy가 있어야 qty = floor(budget / pick.buy) 계산됨 (NaN 방지)
          const opened = paperBroker.openPosition(
            {
              code:          pending.pick_code,
              name:          pending.pick_name,
              market:        pending.pick_market || 'KOSDAQ',
              buy:           pending.pick_buy,
              rank:          pending.rank,
              weight:        pending.weight,
              cluster_id:    pending.pick_cluster_id,
              signal_source: pending.pick_signal_source || 'h7_gapup',
              signal_date:   pending.signal_date,
            },
            capital
          );
          stmts.markPendingBought.run('0901', 'h7_static', 0, pending.id);
          log.info('SCHED', `  [paper] h7 매수 성공: ${pending.pick_name}(${pending.pick_code}) @${pending.pick_buy}`);
          // sendBuy(pick, opened, mode) — opened에 qty/buy_price 필요
          await discord.sendBuy?.(
            { code: pending.pick_code.replace(/^A/, ''), name: pending.pick_name, theme: 'h7', change_rate_901: null },
            opened,
            _config.tradingMode
          );
        }
      } catch (e) {
        log.error('SCHED', `  h7 매수 오류 (${pending.pick_code}): ${e.message}`);
        await discord.sendError?.(`h7 매수 오류: ${pending.pick_name}(${pending.pick_code}): ${e.message}`);
      }
    }
  } catch (e) {
    log.error('SCHED', `h7 매수 함수 오류: ${e.message}`);
    await discord.sendError?.(`09:01 h7 매수 오류: ${e.message}`);
  }
}

// ── h7 당일 +5% 익절 체크 (09:05~14:30 매분) ─────────────────────
/**
 * h7 당일 익절 체크: 현재 보유 포지션 (h7_gapup 매도) 중
 * exit_type='h7_static'이고 agg_price >= buy_price × 1.05이면 매도
 */
async function runH7IntradayCheck() {
  if (H7_INTRADAY_TARGET <= 1.0) {
    // 당일 익절 비활성화
    return;
  }

  const krx = isKrxClosed();
  if (krx.closed) {
    return;
  }

  try {
    const today = todayKstDate();
    const todayYmd = today.replace(/-/g, '');

    // h7_gapup 신호로 매수한 당일 포지션만
    // status='open' AND signal_source='h7_gapup' AND buy_date=today
    let h7Positions = [];
    try {
      h7Positions = stmts.db.prepare(`
        SELECT * FROM positions
        WHERE status = 'open' AND signal_source = 'h7_gapup' AND buy_date = ?
        ORDER BY buy_price ASC
      `).all(todayYmd) || [];
    } catch (e) {
      log.warn('SCHED', `h7 당일 익절 쿼리 실패: ${e.message}`);
      h7Positions = [];
    }

    if (!h7Positions || h7Positions.length === 0) {
      return;
    }

    // 각 포지션 가격 조회 + 익절 체크
    const soldPositions = [];
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

    for (const pos of h7Positions) {
      try {
        const detail = await fetchStockDetail(pos.code);
        if (!detail || detail.error) {
          log.warn('SCHED', `h7 익절 가격 조회 실패: ${pos.code} — ${detail?.error || 'unknown'}`);
          continue;
        }

        const currentPrice = detail.close || detail.open || 0;
        const targetPrice = pos.buy_price * H7_INTRADAY_TARGET;

        if (currentPrice >= targetPrice && currentPrice > 0) {
          // 익절 조건 달성 — 매도 실행
          log.info('SCHED', `[h7 익절] ${pos.name}(${pos.code}) @ ${currentPrice} >= target ${targetPrice.toFixed(0)}`);

          let sellPrice = currentPrice;
          let success = false;

          if (_isRealMode()) {
            // 실전 매도 (KIS)
            const sellResult = await realBroker.closePositionReal(
              { code: pos.code, name: pos.name },
              pos.qty,
              _config.strategy,
              _kisCfg(),
              'h7_intraday_profit_take'
            );
            if (sellResult.success) {
              sellPrice = sellResult.price || currentPrice;
              success = true;
              log.info('SCHED', `  [KIS] h7 익절 매도 성공: ${pos.name}(${pos.code}) @${sellPrice}`);
              await discord.sendSell?.({ code: pos.code.replace(/^A/, ''), name: pos.name }, { qty: pos.qty, sell_price: sellPrice }, _config.tradingMode);
            } else {
              log.error('SCHED', `  [KIS] h7 익절 매도 실패: ${pos.name}(${pos.code}) — ${sellResult.error}`);
            }
          } else {
            // paper-self 매도
            success = true;
            log.info('SCHED', `  [paper] h7 익절 매도 성공: ${pos.name}(${pos.code}) @${sellPrice} (+${((sellPrice - pos.buy_price) / pos.buy_price * 100).toFixed(2)}%)`);
            await discord.sendSell?.({ code: pos.code.replace(/^A/, ''), name: pos.name }, { qty: pos.qty, sell_price: sellPrice }, _config.tradingMode);
          }

          if (success) {
            // trades 테이블에 거래 기록 (positions → closed, trades INSERT)
            const pnl = (sellPrice - pos.buy_price) * pos.qty;
            const returnPct = (sellPrice - pos.buy_price) / pos.buy_price;

            try {
              // positions 상태 update: open → closed
              stmts.db.prepare(`UPDATE positions SET status = 'closed' WHERE id = ?`).run(pos.id);

              // trades 테이블에 거래 기록
              stmts.db.prepare(`
                INSERT INTO trades (
                  code, name, market, qty, buy_price, sell_price, buy_at, sell_at,
                  buy_date, sell_date, pnl, return_pct, exit_reason, fee_paid, mode,
                  signal_date, cluster_id, signal_source, rank, weight
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                pos.code, pos.name, pos.market, pos.qty, pos.buy_price, sellPrice,
                pos.buy_at, todayYmd + timeStr,
                pos.buy_date, todayYmd, pnl, returnPct, 'h7_intraday_profit_take', 0, pos.mode,
                pos.signal_date, pos.cluster_id, pos.signal_source, pos.rank, pos.weight
              );

              soldPositions.push({ code: pos.code, name: pos.name, buy: pos.buy_price, sell: sellPrice });
            } catch (dbErr) {
              log.error('SCHED', `h7 익절 DB 기록 실패 (${pos.code}): ${dbErr.message}`);
            }
          }
        }
      } catch (e) {
        log.error('SCHED', `h7 익절 처리 오류 (${pos.code}): ${e.message}`);
      }
    }

    if (soldPositions.length > 0) {
      log.info('SCHED', `h7 당일 익절 완료: ${soldPositions.length}건 — ${soldPositions.map(s => `${s.code}(+${((s.sell - s.buy) / s.buy * 100).toFixed(1)}%)`).join(', ')}`);
    }
  } catch (e) {
    log.error('SCHED', `h7 당일 익절 함수 오류: ${e.message}`);
  }
}

// ── 09:29 스캔 (매수는 09:36~14:30 동적 또는 11:01 정적) ─────────────────────
async function runSignalScan() {
  const krx = isKrxClosed();
  if (krx.closed) {
    log.info('SCHED', `[KRX 폐장] 09:29 스캔 skip — ${krx.reason}${krx.name ? ` (${krx.name})` : ''}`);
    return;
  }
  log.info('SCHED', `09:29 스캔 시작 [BUY_MODE=${BUY_MODE}]`);

  const blockCheck = isBuyBlocked();
  if (blockCheck.blocked) {
    log.warn('SCHED', `매수 금지일 — ${blockCheck.desc}. 스캔만 실행 (매수 안 함)`);
    await discord.sendBuyBlocked?.(blockCheck);
  }

  try {
    // 동적 모드면 vol_threshold 전달 (pending_buy에 저장됨)
    const scanOpts = {
      deriveOnly: false,
      tradingMode: _config.tradingMode,
      volThreshold: BUY_MODE === 'dynamic_v2500k' ? VOL_THRESHOLD : 0,
    };
    const result = await runScan(scanOpts);

    // 동적 매수 — D-1 종가 캐시 빈 객체 초기화
    //   dynamic-buyer가 첫 poll_minute_vol 응답의 prev_close를 자동으로 이 객체에 채움.
    //   SSoT = backtest/parquet (글로벌 §8.4.2). 네이버 API 호출 0회.
    if (BUY_MODE === 'dynamic_v2500k' && result.picks && result.picks.length > 0) {
      _prevCloseCache.set(result.signal_date, {});
      log.info('SCHED', `[DYN] prevClose 캐시 초기화 — dynamic-buyer 첫 poll 시 자동 수집 (SSoT parquet)`);
    }

    if (!result.picks || result.picks.length === 0) {
      log.info('SCHED', `09:29 스캔 — 매수 후보 없음. 오늘 노매매.`);
      await discord.sendNoSignal?.(result);
    } else if (result.guard && (result.guard.action === 'skip_active' || result.guard.action === 'skip_triggered')) {
      // 가드로 pending_buy가 만들어지지 않음 → 매수 안 함
      const codes = result.picks.map(p => `${p.name}(${p.code})`).join(', ');
      log.warn('SCHED',
        `09:29 시그널 있었지만 G1e'' 가드로 매수 skip — ${codes} | ${result.guard.reason}`);
      await discord.sendGuardSkip?.(result.picks, result.guard);
    } else {
      const summary = result.picks.map(p =>
        `${p.name}(${p.code}, rank=${p.rank}, dev=${p.deviation?.toFixed(2)})`
      ).join(' / ');
      log.info('SCHED',
        `09:29 시그널 — ${result.picks.length} 종목: ${summary}`);
      await discord.sendSignal?.(result);
    }
  } catch (e) {
    log.error('SCHED', `스캔 실패: ${e.message}`);
    await discord.sendError?.(`09:29 스캔 실패: ${e.message}`);
  }
}

// ── 08:50 D+1 시초가 매도 ─────────────────────
async function runMorningSell() {
  const krx = isKrxClosed();
  if (krx.closed) {
    log.info('SCHED', `[KRX 폐장] 08:50 매도 skip — ${krx.reason}${krx.name ? ` (${krx.name})` : ''}`);
    return;
  }
  log.info('SCHED', '08:50 D+1 시초가 매도 트리거');

  const today = todayKstDate();
  const positions = paperBroker.getOpenPositions().filter(p => p.buy_date < today);

  if (positions.length === 0) {
    log.info('SCHED', '08:50 매도 — 어제 매수한 포지션 없음');
    return;
  }

  for (const pos of positions) {
    try {
      let closed = null;
      if (_isRealMode()) {
        closed = await realBroker.closePositionReal(pos, _config.strategy, _kisCfg(), 'next_day_open');
      } else {
        // paper-self: 09:00:30까지 대기 후 첫 시세
        const waitMs = _waitUntilKst(9, 0, 30);
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        const detail = await fetchStockDetail(pos.code);
        const sellPrice = detail?.open || detail?.close;
        if (!sellPrice) throw new Error('매도가 폴 실패');
        closed = paperBroker.closePosition(pos, sellPrice, _config.strategy.feeRoundTrip || 0.003, 'next_day_open');
      }
      // sendSell(trade, mode) — trade에 sell_price/pnl/return_pct 필요 (close 반환값 사용)
      await discord.sendSell?.(closed || { ...pos }, _config.tradingMode);
    } catch (e) {
      log.error('SCHED', `매도 실패 (${pos.code}): ${e.message}`);
      await discord.sendError?.(`매도 실패: ${pos.name}(${pos.code}): ${e.message}`);
    }
  }

  // daily_pnl upsert
  _updateDailyPnl(today);
}

function _waitUntilKst(h, m, s = 0) {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const tgt = new Date(now);
  tgt.setUTCHours(h, m, s, 0);
  return Math.max(0, tgt.getTime() - now.getTime());
}

function _updateDailyPnl(sellDateIso) {
  const trades = stmts.tradesByDate.all(sellDateIso);
  if (trades.length === 0) return;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const buyTotal = trades.reduce((s, t) => s + t.buy_price * t.qty, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  stmts.upsertDailyPnl.run({
    sell_date: sellDateIso,
    n_trades: trades.length,
    pnl,
    buy_total: buyTotal,
    avg_pct: buyTotal > 0 ? (pnl / buyTotal) * 100 : 0,
    win_rate: trades.length > 0 ? wins / trades.length : 0,
  });
}

// ── 동적 매수 (R4.2 / D1 백테 검증) ──────
// 09:36~14:29 매분 호출 — 누적 거래량 ≥ vol_threshold 도달 종목 매수
async function runDynamicCheck() {
  const krx = isKrxClosed();
  if (krx.closed) {
    // 매분 발화이므로 로그는 노이즈 — silent skip
    return;
  }
  const ymd = todayKstYmd();
  const prevCloseMap = _prevCloseCache.get(ymd) || {};
  try {
    const result = await dynBuyer.checkAndTrigger(ymd, {
      tradingMode: _config.tradingMode,
      totalCapital: _config.strategy.totalCapital,
      prevCloseMap,
      kisCfg: _kisCfg(),
      feeRoundTrip: _config.strategy.feeRoundTrip,
    });
    if (result.triggered && result.triggered.length > 0) {
      log.info('SCHED', `[DYN] 트리거 ${result.triggered.length}건 — ${result.triggered.map(t => `${t.code}@${t.buy_time}`).join(', ')}`);
      for (const t of result.triggered) {
        await discord.sendBuy?.({ code: t.code.replace(/^A/, ''), name: t.code, buy: t.price, rank: 0 }, _config.tradingMode);
      }
    }
    if (result.errors && result.errors.length > 0) {
      log.warn('SCHED', `[DYN] 에러 ${result.errors.length}건: ${JSON.stringify(result.errors)}`);
    }
  } catch (e) {
    log.error('SCHED', `[DYN] checkAndTrigger 실패: ${e.message}`);
  }
}

// 14:30 fallback — 미트리거 pending 일괄 시장가 매수
async function runDynamicFallback() {
  const krx = isKrxClosed();
  if (krx.closed) {
    log.info('SCHED', `[KRX 폐장] 14:30 fallback skip — ${krx.reason}${krx.name ? ` (${krx.name})` : ''}`);
    return;
  }
  const ymd = todayKstYmd();
  const prevCloseMap = _prevCloseCache.get(ymd) || {};
  log.info('SCHED', '[DYN] 14:30 fallback 트리거');
  try {
    const result = await dynBuyer.runFallbackBuy(ymd, {
      tradingMode: _config.tradingMode,
      totalCapital: _config.strategy.totalCapital,
      prevCloseMap,
      kisCfg: _kisCfg(),
      feeRoundTrip: _config.strategy.feeRoundTrip,
    });
    if (result.bought && result.bought.length > 0) {
      log.info('SCHED', `[DYN] fallback 매수 ${result.bought.length}건 — ${result.bought.map(b => b.code).join(', ')}`);
      for (const b of result.bought) {
        await discord.sendBuy?.({ code: b.code.replace(/^A/, ''), name: b.code, buy: b.price, rank: 0 }, _config.tradingMode);
      }
    } else if (result.active > 0) {
      log.warn('SCHED', `[DYN] fallback 매수 0건 (active=${result.active}, errors=${JSON.stringify(result.errors)})`);
    }
    // cache 정리
    _prevCloseCache.delete(ymd);
  } catch (e) {
    log.error('SCHED', `[DYN] fallback 실패: ${e.message}`);
  }
}

// ── 시작 ─────────────────────────────
function start(config) {
  _config = config;
  paperBroker.initPaperBalance(_config.strategy.totalCapital);

  // 알림 초기화
  discord.init(config.discord?.webhookUrl || '');
  if (mail && mail.init) {
    mail.init(config.email || {});
  }
  const mailReady = mail && typeof mail.isReady === 'function' ? mail.isReady() : false;
  log.info('SCHED', `알림 채널 — discord=${!!config.discord?.webhookUrl} / email=${mailReady}`);

  // 08:50 D+1 시초가 매도 (모든 모드 공통)
  cron.schedule('50 8 * * 1-5', runMorningSell, { timezone: 'Asia/Seoul' });

  if (BUY_MODE === 'h7') {
    // ★ h7 갭업 + 클러스터 신호 (2026-05-31 신규, 당일 익절 ON)
    // 09:00 갭업 스캔
    cron.schedule('0 9 * * 1-5', runGapupH7Scan, { timezone: 'Asia/Seoul' });
    // 09:01 정적 매수
    cron.schedule('1 9 * * 1-5', runBuyH7, { timezone: 'Asia/Seoul' });
    // 09:05~14:30 당일 +5% 익절 (H7_INTRADAY_TARGET=1.05)
    if (H7_INTRADAY_TARGET > 1.0) {
      cron.schedule('5-59 9 * * 1-5', runH7IntradayCheck, { timezone: 'Asia/Seoul' });
      cron.schedule('* 10-13 * * 1-5', runH7IntradayCheck, { timezone: 'Asia/Seoul' });
      cron.schedule('0-30 14 * * 1-5', runH7IntradayCheck, { timezone: 'Asia/Seoul' });
    }
    // D+1 08:50 매도 (위에서 등록)

    log.info('SCHED',
      `cron 등록 완료 — 08:50 매도 / ★ H7 GAPUP ★ 09:00 스캔 / 09:01 정적 매수 / ` +
      `당일 익절(target=${H7_INTRADAY_TARGET}) (mode=${config.tradingMode}, BUY_MODE=${BUY_MODE})`);

  } else if (BUY_MODE === 'dynamic_v2500k') {
    // 동적 매수 (R4.2 / D1 백테 검증): 09:29 스캔 + 09:36~14:29 매분 + 14:30 fallback
    cron.schedule('29 9 * * 1-5', runSignalScan, { timezone: 'Asia/Seoul' });
    cron.schedule('36-59 9 * * 1-5', runDynamicCheck, { timezone: 'Asia/Seoul' });
    cron.schedule('* 10-13 * * 1-5', runDynamicCheck, { timezone: 'Asia/Seoul' });
    cron.schedule('0-29 14 * * 1-5', runDynamicCheck, { timezone: 'Asia/Seoul' });
    cron.schedule('30 14 * * 1-5', runDynamicFallback, { timezone: 'Asia/Seoul' });

    log.info('SCHED',
      `cron 등록 완료 — 08:50 매도 / 09:29 스캔 / ★ DYNAMIC ★ 09:36~14:29 분봉 체크 / 14:30 fallback ` +
      `(mode=${config.tradingMode}, BUY_MODE=${BUY_MODE}, V=${VOL_THRESHOLD.toLocaleString()})`);

  } else {
    // 정적 매수 호환성 (11:01, BUY_MODE=static_1101)
    cron.schedule('29 9 * * 1-5', runSignalScan, { timezone: 'Asia/Seoul' });
    // 11:01 정적 매수는 TODO (기존 APEX 방식)

    log.info('SCHED',
      `cron 등록 완료 — 08:50 매도 / 09:29 스캔 / 11:01 정적 매수 (mode=${config.tradingMode}, BUY_MODE=${BUY_MODE})`);
  }
}

// UI 모달에서 secrets 저장 시 server.js가 호출 — 메일 transport 재초기화
function reloadMail(emailCfg) {
  if (_config) _config.email = emailCfg;
  mail.init(emailCfg || {});
  log.info('SCHED', `메일 알림 재초기화 — ready=${mail.isReady()}`);
  return mail.isReady();
}

// UI 모달에서 KIS 키 저장 시 server.js가 호출 — 다음 KIS 호출부터 새 키 사용
function reloadKis(kisCfg) {
  if (_config) _config.kis = { ..._config.kis, ...kisCfg };
  log.info('SCHED', `KIS 키 재초기화 — appKey=${!!kisCfg?.appKey} cano=${!!kisCfg?.cano}`);
}

module.exports = {
  start,
  runSignalScan,
  runMorningSell,
  runDynamicCheck,
  runDynamicFallback,
  runGapupH7Scan,
  runBuyH7,
  runH7IntradayCheck,
  reloadMail,
  reloadKis,
  BUY_MODE,
  VOL_THRESHOLD,
  H7_INTRADAY_TARGET,
};
