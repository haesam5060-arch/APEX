// ═══════════════════════════════════════════════════════════════
// APEX 스케줄러 — h7 갭업 클러스터 엔진 (2026-06-01)
//   + NEMESIS R4.2 호환 (spectral cluster + 동적 매수)
//
// 매일 KST (평일):
//   [h7 모드]
//     08:50         - 전일 미체결 지정가 취소 + D+1 시초가 매도
//     09:00         - 갭업 스캔 (10% + vol 5배 + cluster)
//     09:01         - 정적 매수 + 지정가 주문 생성 (buy_price × 1.05)
//     [당일익절]    - 지정가로 자동 체결 (폴링 불필요)
//
//   [NEMESIS R4.2 호환 모드 (BUY_MODE=dynamic_v2500k)]
//     08:50         - 전일 매수 포지션 D+1 시초가 매도
//     09:29         - 스캔 → Top10 → spectral cluster
//     09:36~14:29   - cum_vol 폴링 → 2.5M 트리거 시 시장가 매수
//     14:30         - fallback 매수
//     D+1 09:00     - 시초가 매도
// ═══════════════════════════════════════════════════════════════

'use strict';

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { runScan, runGapupScan } = require('./scanner');
const paperBroker = require('./paper-broker');
// real-broker는 paper-self 모드에서 불필요 (조건부 로드)
let realBroker = null;
try {
  realBroker = require('./real-broker');
} catch (e) {
  // real-broker 없음 (paper-self 모드에서는 사용 안 함)
}
const { fetchStockDetail, scanAllStocks, pollPrices, fetchEtfCodes } = require('./stock-fetcher');
const { isBuyBlocked } = require('./no-buy-calendar');
const { isKrxClosed } = require('./krx-calendar');
const { PRICE_GUARD_PCT, selectClusterLaggard1430, selectClusterLaggard1430Live, _spawnMorningChange, _withA } = require('./strategy');
const regimeGuard = require('./regime-guard');

// cluster_laggard_1430 라이브: 14:30 신호 → 14:50 매수 (그 사이 픽 보관)
const APEX_PRICE_LO = parseInt(process.env.APEX_PRICE_LO || '10000', 10);
const APEX_PRICE_HI = parseInt(process.env.APEX_PRICE_HI || '50000', 10);
const APEX_DAILY_CAP = parseInt(process.env.APEX_DAILY_CAP || '2', 10);
let _laggardPending = null;  // { date, picks:[...] }

// ETF 매수후보 제외용 현행 ETF 리스트 (aprev1 B안, APEX#13)
//   14:30 신호 직전 일 1회 갱신. 실패 시 기존 파일 유지 (stale 허용 — 신규상장 ETF만 늦게 반영).
//   apex_laggard_signal.py run_live가 이 파일을 읽어 bottom_n에서 ETF를 후보 제외.
const ETF_CODES_PATH = path.resolve(__dirname, '..', 'data', 'etf_codes.json');

async function _refreshEtfCodes() {
  try {
    const codes = await fetchEtfCodes();
    fs.writeFileSync(ETF_CODES_PATH, JSON.stringify({
      updated_at: new Date().toISOString(),
      source: 'naver etfItemList',
      etf_codes: codes,
    }));
    log.info('SCHED', `ETF 리스트 갱신 — ${codes.length}개 (${ETF_CODES_PATH})`);
    return true;
  } catch (e) {
    const exists = fs.existsSync(ETF_CODES_PATH);
    log.warn('SCHED', `ETF 리스트 갱신 실패 — ${exists ? '기존 파일 사용' : '파일 없음(ETF 필터 미작동)'}: ${e.message}`);
    if (!exists) await discord.sendError?.(`ETF 리스트 없음 — 오늘 laggard ETF 후보 제외 필터가 작동하지 않습니다`);
    return false;
  }
}
const discord = require('./discord-notifier');
const mail = require('./email-notifier');
const { db, log, stmts } = require('./db');

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

// 동적매수/G1e는 dynamic_v2500k·static_1101 모드만 필요 (조건부 로드)
//   h7·cluster_laggard_1430 은 불필요 (cluster_laggard는 자체 레짐가드 사용)
const _NEEDS_DYNAMIC = (BUY_MODE === 'dynamic_v2500k' || BUY_MODE === 'static_1101');
let dynBuyer = null;
if (_NEEDS_DYNAMIC) {
  dynBuyer = require('./dynamic-buyer');
}
const VOL_THRESHOLD = dynBuyer ? parseInt(process.env.VOL_THRESHOLD || `${dynBuyer.DEFAULT_V_THRESHOLD}`, 10) : 0;

let guardG1e = null;
if (_NEEDS_DYNAMIC) {
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

// ── KST 시간창 가드 (APEX#11) — 수동 트리거 오발 방지 ──
//   실사례: 2026-06-05 16:00 수동 스캔이 장마감 시세로 스테일 픽 생성.
//   APEX_TIME_GUARD=0 으로 해제 (크론 시각을 옮기면 창도 함께 조정할 것).
const TIME_GUARD_ON = process.env.APEX_TIME_GUARD !== '0';

function _kstHHMM() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCHours() * 100 + d.getUTCMinutes();
}

function _inKstWindow(start, end) {
  const t = _kstHHMM();
  return t >= start && t <= end;
}

function todayKstYmd() {
  return todayKstDate().replace(/-/g, '');
}

function getOpenPositions() {
  return paperBroker.getOpenPositions();
}

// ── 슬리피지 계측 (2026-06-03, 로깅 전용 — 매매에 절대 영향 없음) ──
//   ref(가정가) vs fill(실체결가) 기록. paper-self는 ref=fill(폴가)이라 slip_bp≈0이지만
//   fill_price+ts를 parquet과 교차검증하면 데이터/타이밍 슬립 측정 가능.
//   KIS(paper/real) 모드에서 ref(폴가) vs fill(체결가) = 실집행 슬립.
function _logSlip({ code, side, refPrice, fillPrice, qty, signalDate }) {
  try {
    if (!fillPrice || fillPrice <= 0) return;
    const ref = refPrice && refPrice > 0 ? refPrice : fillPrice;
    const slipBp = Math.round((fillPrice / ref - 1) * 10000 * 100) / 100;
    stmts.insertSlippage.run({
      ts: new Date().toISOString(),
      signal_date: signalDate || null,
      code: String(code).replace(/^A/, ''),
      side,
      mode: _config?.tradingMode || 'paper-self',
      ref_price: ref,
      fill_price: fillPrice,
      slip_bp: slipBp,
      qty: qty || null,
    });
  } catch (e) { /* 계측 실패는 매매에 영향 없음 (무시) */ }
}

// ── 당일 스캔 흐름 기록 (대시보드 패널용, 2026-06-04, 표시 전용·try/catch) ──
function _logScanFlow(phase, rows) {
  try {
    const today = todayKstYmd();
    const nowIso = new Date().toISOString();
    const mode = _config?.tradingMode || 'paper-self';
    stmts.clearScanFlowPhase.run(today, phase);
    rows.forEach((r, i) => stmts.insertScanFlow.run({
      signal_date: today, ts: nowIso, phase,
      rank: r.rank ?? (i + 1),
      code: String(r.code || '').replace(/^A/, ''),
      name: r.name || r.code || null,
      change_rate: r.change_rate ?? null,
      cluster_strength: r.cluster_strength ?? null,
      entry_price: r.entry_price ?? null,
      mode,
    }));
  } catch (e) { /* 기록 실패는 매매에 영향 없음 */ }
}

// ── 09:31 모닝 장중등락률 확정 수집 (APEX#8) ─────────────────────
//   B안 프리필터: 전일대비 상위 N(400) ∪ 거래대금 상위 M(200) — 14:30 시점 재구성(발산 29%) 대비
//   발산 3%로 축소 (parquet 119일 시뮬). 수집분은 morning_change 테이블에 저장, 14:30 신호가 사용.
const MORNING_POLL_N = parseInt(process.env.MORNING_POLL_N || '400', 10);
const MORNING_POLL_AMT_N = parseInt(process.env.MORNING_POLL_AMT_N || '200', 10);

async function _collectMorningRets(scannedArr, todayYmd) {
  const valid = scannedArr.filter(s => s && s.code);
  const byChg = valid.filter(s => Number.isFinite(s.changeRate))
    .slice().sort((a, b) => b.changeRate - a.changeRate).slice(0, MORNING_POLL_N);
  const byAmt = valid.filter(s => Number.isFinite(s.tradingValue))
    .slice().sort((a, b) => b.tradingValue - a.tradingValue).slice(0, MORNING_POLL_AMT_N);
  const codesA = [...new Set([...byChg, ...byAmt].map(s => _withA(s.code)))];
  if (codesA.length === 0) { log.warn('SCHED', '09:31 morning_rets — 프리필터 후보 0'); return 0; }

  const map = await _spawnMorningChange(codesA, todayYmd);
  const rows = Object.entries(map || {}).filter(([, m]) => m && typeof m.ret === 'number');
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    stmts.clearMorningChange.run(todayYmd);
    for (const [codeA, m] of rows) {
      stmts.insertMorningChange.run({
        signal_date: todayYmd, code: codeA.replace(/^A/, ''),
        ret: m.ret, vi_ok: m.vi_ok ? 1 : 0,
        first_open: m.first_open ?? null, last_close: m.last_close ?? null,
        polled_at: nowIso,
      });
    }
  })();
  const nVi = rows.filter(([, m]) => m.vi_ok).length;
  log.info('SCHED', `09:31 morning_rets 확정 수집 — 폴 ${codesA.length} / 수집 ${rows.length} / vi_ok ${nVi} (APEX#8)`);
  return nVi;
}

// ── 09:31 모닝 스냅샷 (Top10 표시) + morning_rets 확정 수집 ──
async function runMorningSnapshotJob() {
  const krx = isKrxClosed();
  if (krx.closed) { log.info('SCHED', `[KRX 폐장] 09:31 스냅샷 skip — ${krx.reason}`); return; }
  log.info('SCHED', '09:31 모닝 스냅샷 시작');
  try {
    const scanned = await scanAllStocks();
    const arr = Array.isArray(scanned) ? scanned : [];
    if (arr.length === 0) { log.warn('SCHED', '09:31 스냅샷 — scanAllStocks 빈 결과'); return; }
    const top = arr.filter(s => s && s.changeRate != null)
                   .sort((a, b) => b.changeRate - a.changeRate).slice(0, 10);
    _logScanFlow('snapshot', top.map((s, i) => ({
      rank: i + 1, code: s.code, name: s.name,
      change_rate: s.changeRate, entry_price: s.close,
    })));
    log.info('SCHED', `09:31 스냅샷 기록 — Top${top.length}${top[0] ? ` (1위 ${top[0].name})` : ''}`);

    // ★ morning_rets 확정 수집 (APEX#8) — 실패해도 스냅샷에는 영향 없음 (14:30이 레거시 폴백)
    if (BUY_MODE === 'cluster_laggard_1430') {
      try {
        await _collectMorningRets(arr, todayKstYmd());
      } catch (e) {
        log.error('SCHED', `09:31 morning_rets 수집 오류 (14:30 레거시 폴백 예정): ${e.message}`);
      }
    }
  } catch (e) {
    log.error('SCHED', `09:31 스냅샷 오류: ${e.message}`);
  }
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

            // ★ h7 지정가 매도 주문 생성 (2026-06-01)
            const limitPrice = Math.round(buyResult.price * H7_INTRADAY_TARGET);
            try {
              const limitResult = await realBroker.placeStopLimitOrder?.(
                { code: pending.pick_code, name: pending.pick_name },
                buyResult.qty,
                limitPrice,
                _config.strategy,
                _kisCfg()
              );
              if (limitResult?.success) {
                // 포지션 테이블에 limit_order_price 저장 (추적용)
                db.prepare(`
                  UPDATE positions
                  SET limit_order_price = ?
                  WHERE code = ? AND status = 'open' AND buy_date = ?
                  LIMIT 1
                `).run(limitPrice, pending.pick_code, todayKstDate().replace(/-/g, ''));
                log.info('SCHED',
                  `  [KIS] h7 지정가 매도 주문 생성: ${pending.pick_name}(${pending.pick_code}) 수량=${buyResult.qty} @${limitPrice}`);
              } else {
                log.warn('SCHED',
                  `  [KIS] h7 지정가 주문 생성 실패 (매수는 성공): ${pending.pick_name}(${pending.pick_code})`);
              }
            } catch (e) {
              log.warn('SCHED',
                `  [KIS] h7 지정가 주문 생성 오류: ${pending.pick_name}(${pending.pick_code}) — ${e.message}`);
            }

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

          // ★ h7 지정가 매도 주문 저장 (2026-06-01)
          // 당일 익절: limit_order_price = buy_price × 1.05
          const limitPrice = Math.round(pending.pick_buy * H7_INTRADAY_TARGET);
          db.prepare(`
            UPDATE positions
            SET limit_order_price = ?
            WHERE id = ?
          `).run(limitPrice, opened.id);

          log.info('SCHED',
            `  [paper] h7 매수 성공: ${pending.pick_name}(${pending.pick_code}) @${pending.pick_buy} ` +
            `[지정가 ${limitPrice} (${(H7_INTRADAY_TARGET * 100).toFixed(0)}%)]`);
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

// ── h7 당일 +5% 익절 체크 (paper-self 모드용, 09:05~14:30 매분) ─────────────────────
/**
 * h7 당일 익절 체크 (paper-self 모드만)
 * - KIS 실전/paper: 지정가 주문으로 자동 관리 (폴링 불필요)
 * - paper-self: 네이버 API로 현재가 조회 후 지정가 체결 판단
 */
async function runH7IntradayCheck() {
  if (H7_INTRADAY_TARGET <= 1.0 || _isRealMode()) {
    // KIS 모드에서는 지정가가 자동 관리되므로 skip
    return;
  }

  const krx = isKrxClosed();
  if (krx.closed) {
    return;
  }

  try {
    const today = todayKstDate();
    const todayYmd = today.replace(/-/g, '');

    // h7_gapup 신호로 매수한 당일 포지션 중 미체결 지정가
    const h7Positions = db.prepare(`
      SELECT * FROM positions
      WHERE status = 'open' AND signal_source = 'h7_gapup' AND buy_date = ?
        AND limit_order_price > 0 AND limit_order_filled_at IS NULL
      ORDER BY buy_price ASC
    `).all(todayYmd) || [];

    if (!h7Positions || h7Positions.length === 0) {
      return;
    }

    // 각 포지션 현재가 조회 + 지정가 체결 판정
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

    for (const pos of h7Positions) {
      try {
        const detail = await fetchStockDetail(pos.code);
        if (!detail || detail.error) {
          continue;
        }

        // ★ 판정 기준 = 당일 누적 고가(high) (2026-06-01)
        //   현재가(close)로 판정하면 분봉 사이 순간 터치를 놓쳐 백테(분봉 high)와 괴리.
        //   네이버 detail.high는 당일 누적 최고가이므로, 한 번이라도 limit을 터치했으면 잡힘
        //   → 매분 폴링이어도 백테 지정가 체결 모델과 정합 (글로벌 §8.4 Same Environment).
        const dayHigh = detail.high || 0;

        // 지정가 체결 판정 (당일 고가가 지정가 터치)
        if (dayHigh >= pos.limit_order_price && dayHigh > 0) {
          // 지정가 체결 — paper-self 매도 (체결가 = 지정가, 백테와 동일)
          const sellPrice = pos.limit_order_price; // 지정가로 체결
          const pnl = (sellPrice - pos.buy_price) * pos.qty;
          const returnPct = (sellPrice - pos.buy_price) / pos.buy_price;

          // 포지션 + 거래 기록
          db.transaction(() => {
            db.prepare(`UPDATE positions SET status = 'closed', limit_order_filled_at = ? WHERE id = ?`)
              .run(now.toISOString(), pos.id);
            db.prepare(`
              INSERT INTO trades (
                code, name, market, qty, buy_price, sell_price, buy_at, sell_at,
                buy_date, sell_date, pnl, return_pct, exit_reason, fee_paid, mode,
                signal_date, cluster_id, signal_source, rank, weight
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              pos.code, pos.name, pos.market, pos.qty, pos.buy_price, sellPrice,
              pos.buy_at, todayYmd + timeStr,
              pos.buy_date, todayYmd, pnl, returnPct, 'h7_intraday_limit_filled', 0, 'paper-self',
              pos.signal_date, pos.cluster_id, pos.signal_source, pos.rank, pos.weight
            );
          })();

          log.info('SCHED',
            `[h7 익절] ${pos.name}(${pos.code}) 당일고가 ${dayHigh} >= limit ${pos.limit_order_price} (지정가 체결 @${sellPrice})`);
          await discord.sendSell?.({ code: pos.code.replace(/^A/, ''), name: pos.name },
            { qty: pos.qty, sell_price: sellPrice }, _config.tradingMode);
        }
      } catch (e) {
        log.error('SCHED', `h7 익절 처리 오류 (${pos.code}): ${e.message}`);
      }
    }
  } catch (e) {
    log.error('SCHED', `h7 익절 함수 오류: ${e.message}`);
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
  const todayYmd = today.replace(/-/g, '');
  const positions = paperBroker.getOpenPositions().filter(p => p.buy_date < today);

  if (positions.length === 0) {
    log.info('SCHED', '08:50 매도 — 어제 매수한 포지션 없음');
  }

  for (const pos of positions) {
    try {
      // ★ h7 미체결 지정가 처리 (2026-06-01)
      // limit_order_price가 있으면 h7 지정가 주문이 미체결된 상태
      // → 지정가 취소 + 시초가 시장가 매도
      let closed = null;

      if (pos.limit_order_price && !pos.limit_order_filled_at) {
        // h7 미체결 지정가 존재 → 취소 후 시초가 매도
        log.info('SCHED', `  [h7 지정가 미체결] ${pos.name}(${pos.code}) — 취소하고 시초가 매도`);
        if (_isRealMode()) {
          // KIS: 미체결 지정가 취소 (있으면)
          try {
            await realBroker.cancelLimitOrder?.(
              { code: pos.code, name: pos.name },
              _config.strategy,
              _kisCfg()
            );
            log.info('SCHED', `  [KIS] h7 지정가 취소 완료: ${pos.name}(${pos.code})`);
          } catch (e) {
            log.warn('SCHED', `  [KIS] h7 지정가 취소 실패: ${pos.name}(${pos.code}) — ${e.message}`);
          }
        }
      }

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
      // 슬리피지 계측 (체결가 기록 — paper-self는 폴가, KIS는 체결가)
      _logSlip({ code: pos.code, side: 'sell', refPrice: closed?.sell_price, fillPrice: closed?.sell_price, qty: pos.qty, signalDate: pos.signal_date });
      // sendSell(trade, mode) — trade에 sell_price/pnl/return_pct 필요 (close 반환값 사용)
      await discord.sendSell?.(closed || { ...pos }, _config.tradingMode);
    } catch (e) {
      log.error('SCHED', `매도 실패 (${pos.code}): ${e.message}`);
      await discord.sendError?.(`매도 실패: ${pos.name}(${pos.code}): ${e.message}`);
    }
  }

  // ── 그림자 청산 (APEX#9): T+1 시초가로 가상 수익 확정 → guard_daily(kind=shadow) ──
  try {
    const shadows = stmts.openShadowTrades.all(todayYmd) || [];
    if (shadows.length > 0) {
      const waitMs = _waitUntilKst(9, 0, 30);
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      const fee = _config?.strategy?.feeRoundTrip || 0.003;
      const bySig = {};
      for (const sh of shadows) {
        try {
          const detail = await fetchStockDetail(sh.code);
          const exitPx = detail?.open || detail?.close;
          if (!exitPx) { log.warn('SCHED', `[그림자] ${sh.code} 청산가 폴 실패 — 내일 재시도`); continue; }
          const ret = exitPx / sh.entry - 1 - fee;
          stmts.closeShadowTrade.run({ id: sh.id, exit: exitPx, ret, closed_at: new Date().toISOString() });
          (bySig[sh.signal_date] = bySig[sh.signal_date] || []).push(ret);
          log.info('SCHED', `[그림자 청산] ${sh.code} ${sh.entry}→${exitPx} (${(ret * 100).toFixed(2)}%)`);
        } catch (e) { log.warn('SCHED', `[그림자] ${sh.code} 청산 오류: ${e.message}`); }
      }
      for (const [sd, rets] of Object.entries(bySig)) {
        stmts.upsertGuardDaily.run({ date: sd, r: rets.reduce((s, x) => s + x, 0) / rets.length, kind: 'shadow' });
      }
    }
  } catch (e) { log.error('SCHED', `그림자 청산 처리 오류: ${e.message}`); }

  if (positions.length === 0) return;

  // daily_pnl upsert + 레짐가드 시계열(real) 갱신 (APEX#9)
  _updateDailyPnl(today);
  _updateGuardDailyReal(today);
}

// 오늘 매도된 laggard 실현 거래를 신호일(진입일) 키로 guard_daily에 기록 (APEX#9)
//   백테 r 시계열과 동일 의미: r[신호일] = 그날 cap2 매매 평균 수익률(비용 차감).
function _updateGuardDailyReal(sellDateIso) {
  try {
    const rows = db.prepare(`
      SELECT signal_date, AVG(return_pct) AS r FROM trades
      WHERE sell_date = ? AND signal_source = 'cluster_laggard_1430' AND signal_date IS NOT NULL
      GROUP BY signal_date
    `).all(sellDateIso);
    for (const row of rows) {
      stmts.upsertGuardDaily.run({ date: row.signal_date, r: row.r, kind: 'real' });
    }
    if (rows.length > 0) {
      log.info('SCHED', `guard_daily(real) 갱신 — ${rows.map(r => `${r.signal_date}:${(r.r * 100).toFixed(2)}%`).join(', ')}`);
    }
  } catch (e) { log.warn('SCHED', `guard_daily(real) 갱신 실패: ${e.message}`); }
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

// ── cluster_laggard_1430 라이브: 14:30 신호 (실시간) ─────────────────────
//   scanAllStocks(14:30) + poll_morning_change(09:00~09:29) → 원시 laggard 픽 → _laggardPending 보관.
//   레짐 가드(L1/L2)는 여기서 체크 — 막히면 픽 안 만듦. 청산은 08:50 runMorningSell(T+1) 재사용.
async function runLaggardSignal14() {
  const krx = isKrxClosed();
  if (krx.closed) { log.info('SCHED', `[KRX 폐장] 14:30 신호 skip — ${krx.reason}`); return; }
  if (TIME_GUARD_ON && !_inKstWindow(1425, 1445)) {
    log.warn('SCHED', `14:30 신호 거부 — 시간창(14:25~14:45) 밖 (현재 ${_kstHHMM()}). 수동 트리거 오발 방지 (APEX#11, APEX_TIME_GUARD=0로 해제)`);
    return;
  }
  const blk = isBuyBlocked();
  if (blk.blocked) { log.warn('SCHED', `매수 금지일 — ${blk.desc}. 신호 skip`); await discord.sendBuyBlocked?.(blk); return; }

  // ★ 레짐 가드 — L2는 킬스위치(전면 중단), L1 휴면은 그림자 추적으로 전환 (APEX#9)
  const regime = regimeGuard.checkRegime({ stmts, mode: _config.tradingMode });
  let shadowMode = false;
  if (!regime.canTrade) {
    if (regime.halted) {
      log.warn('SCHED', `[레짐가드] L2 레짐붕괴(중단) — 신호 skip. ${regime.reasons.join('; ')}`);
      await discord.sendError?.(`🛑 [APEX 레짐붕괴 L2] 매매 중단 + 재설계 필요. ${regime.reasons.join('; ')}`);
      return;
    }
    // L1 임시휴면: 실매수는 쉬고 신호·가상체결은 계속 기록 → 가드 시계열이 굴러
    // 누적 ≥ 0 복귀 시 자동 재개 (백테 ap29 가드 동학과 일치, APEX#9)
    shadowMode = true;
    log.warn('SCHED', `[레짐가드] L1 임시휴면 — 그림자 추적 모드 (실매수 없음). ${regime.reasons.join('; ')}`);
    await discord.sendGuardSkip?.([], { action: 'regime_dormant', reason: regime.reasons.join('; ') });
  }

  const todayYmd = todayKstYmd();
  log.info('SCHED', `14:30 cluster_laggard 라이브 신호 시작 (date=${todayYmd})`);
  try {
    await _refreshEtfCodes();  // ETF 매수후보 제외 필터용 (실패해도 신호는 진행)

    // ★ 09:31 확정 수집분 로드 (APEX#8). 30종목 미만이면 수집 실패로 보고 레거시 폴백.
    let morningRets = null;
    try {
      const mornRows = stmts.morningChangeByDate.all(todayYmd) || [];
      const m = {};
      for (const r of mornRows) if (r.vi_ok) m[r.code] = r.ret;
      if (Object.keys(m).length >= 30) {
        morningRets = m;
        log.info('SCHED', `morning_rets 사용 — 09:31 확정 수집분 ${Object.keys(m).length}종목 (APEX#8)`);
      } else {
        log.warn('SCHED', `09:31 수집분 부족(${Object.keys(m).length}) — 14:30 레거시 폴(프리필터 150) 폴백. 신호 발산 가능 (APEX#8)`);
      }
    } catch (e) {
      log.warn('SCHED', `morning_change 로드 실패 — 레거시 폴백: ${e.message}`);
    }

    const scanned = await scanAllStocks();
    const result = await selectClusterLaggard1430Live(scanned, todayYmd, { morningRets });
    if (!result.picks || result.picks.length === 0) {
      log.info('SCHED', `14:30 신호 — 없음 (${result.excluded?.reason || '조건 미충족'})`);
      await discord.sendNoSignal?.(result);
      _laggardPending = null;
      return;
    }
    _laggardPending = {
      date: todayYmd, shadow: shadowMode, picks: result.picks, cluster_id: result.diag?.cluster_id,
      frozen_date: result.prev_date ?? null, window: result.window ?? null, seed: result.seed || [],
      avg_corr: result.picks[0]?.cluster_avg_corr ?? null, size: result.picks[0]?.cluster_size ?? null,
    };
    // 픽 영속화 (APEX#11) — 14:30~14:50 사이 재시작에도 14:50 매수 복구 가능
    try {
      const nowIso = new Date().toISOString();
      db.transaction(() => {
        for (const p of result.picks) {
          stmts.insertLaggardPending.run({
            signal_date: todayYmd, rank: (p.lag_rank ?? 0) + 1, weight: 1.0,
            pick_code: p.code, pick_name: p.name || p.code,
            pick_cluster_id: _laggardPending.cluster_id ?? null,
            pick_deviation: p.deviation ?? null, pick_market: p.market || null,
            pick_buy: p.buy ?? null, created_at: nowIso,
            shadow: shadowMode ? 1 : 0, pick_lag_rank: p.lag_rank ?? null,
            pick_frozen_date: _laggardPending.frozen_date,
            pick_cluster_window: _laggardPending.window,
            pick_cluster_corr: _laggardPending.avg_corr,
            pick_cluster_size: _laggardPending.size,
            pick_seed: _laggardPending.seed?.length ? JSON.stringify(_laggardPending.seed) : null,
          });
        }
      })();
    } catch (e) { log.warn('SCHED', `픽 영속화 실패 (메모리로만 진행): ${e.message}`); }

    const summary = result.picks.map(p =>
      `${p.code}(lag${p.lag_rank}, @${p.buy}, corr=${p.cluster_avg_corr?.toFixed(2)}, size=${p.cluster_size})`).join(' / ');
    const seedStr = (result.seed || []).map(s => `${s.name || s.code}(${(s.ret * 100).toFixed(1)}%)`).join(', ') || '없음';
    log.info('SCHED', `14:30 신호 — ${result.picks.length}후보(${shadowMode ? '그림자 추적' : '14:50 매수 대기'}): ${summary} | 얼린서랍 ${result.prev_date}(W${result.window}) 추종시드: ${seedStr}`);
    result.shadow = shadowMode;  // 디스코드 신호 알림에 휴면 표기 (APEX#11)
    // 대시보드 '당일 스캔 흐름' 기록 (14:30 스캔 후보)
    _logScanFlow('scanned', result.picks.map((p, i) => ({
      rank: (p.lag_rank ?? i) + 1, code: p.code, name: p.name || p.code,
      change_rate: p.change_rate ?? null, cluster_strength: p.cluster_avg_corr ?? null,
      entry_price: p.buy ?? null,
    })));
    await discord.sendSignal?.(result);
  } catch (e) {
    log.error('SCHED', `14:30 신호 오류: ${e.message}`);
    await discord.sendError?.(`14:30 cluster_laggard 신호 오류: ${e.message}`);
  }
}

// ── 14:50 매수 후보 확정 (순수함수 — 백테 aprev2b와 동일 필터·순서, APEX#7) ──
//   가격필터(lo~hi, 양끝 포함) → 상한가잠김(price ≥ round(prevClose×1.30)×0.995 skip,
//   prevClose 없으면 해당 가드 생략 — 백테 `if pc and ...`와 동일) → lag_rank 오름차순 cap.
function selectLaggardBuyList(picks, px, prevCloseMap, opts = {}) {
  const lo = opts.lo ?? APEX_PRICE_LO;
  const hi = opts.hi ?? APEX_PRICE_HI;
  const cap = opts.cap ?? APEX_DAILY_CAP;
  const limitTol = opts.limitTol ?? 0.995;
  const ranked = picks.slice().sort((a, b) => (a.lag_rank ?? 9) - (b.lag_rank ?? 9));
  const buyList = [];
  const skipped = [];
  for (const p of ranked) {
    const price = px[p.code] ?? p.buy;
    if (!price || price < lo || price > hi) {
      skipped.push({ code: p.code, reason: `가격 ${price} (${lo}~${hi} 밖)` });
      continue;
    }
    const pc = prevCloseMap ? prevCloseMap[p.code] : null;
    if (pc && price >= Math.round(pc * 1.30) * limitTol) {
      skipped.push({ code: p.code, reason: `상한가잠김 (${price} ≥ ${Math.round(pc * 1.30)}×${limitTol})` });
      continue;
    }
    buyList.push({ ...p, entry: price });
    if (buyList.length >= cap) break;
  }
  return { buyList, skipped };
}

// ── cluster_laggard_1430 라이브: 14:50 매수 ─────────────────────
//   14:30 후보 → 현재가(14:50) 조회 → 가격필터(1만~5만)·상한가잠김 제외 → lag_rank 순 cap2 균등 매수.
async function runLaggardBuy1450() {
  const krx = isKrxClosed();
  if (krx.closed) return;
  if (TIME_GUARD_ON && !_inKstWindow(1445, 1510)) {
    log.warn('SCHED', `14:50 매수 거부 — 시간창(14:45~15:10) 밖 (현재 ${_kstHHMM()}). 수동 트리거 오발 방지 (APEX#11)`);
    return;
  }
  const todayYmd = todayKstYmd();
  if (!_laggardPending || _laggardPending.date !== todayYmd || !_laggardPending.picks?.length) {
    // DB 복구 (APEX#11) — 14:30~14:50 사이 재시작 시 영속화 픽으로 복원
    let rows = [];
    try { rows = stmts.getLaggardPendings.all(todayYmd) || []; } catch (e) { /* ignore */ }
    if (rows.length > 0) {
      _laggardPending = {
        date: todayYmd, shadow: !!rows[0].shadow,
        cluster_id: rows[0].pick_cluster_id ?? null,
        frozen_date: rows[0].pick_frozen_date ?? null,
        window: rows[0].pick_cluster_window ?? null,
        avg_corr: rows[0].pick_cluster_corr ?? null,
        size: rows[0].pick_cluster_size ?? null,
        seed: (() => { try { return rows[0].pick_seed ? JSON.parse(rows[0].pick_seed) : []; } catch { return []; } })(),
        picks: rows.map(r => ({
          code: r.pick_code, name: r.pick_name, market: r.pick_market,
          lag_rank: r.pick_lag_rank, deviation: r.pick_deviation, buy: r.pick_buy,
          cluster_avg_corr: r.pick_cluster_corr, cluster_size: r.pick_cluster_size, rank: r.rank,
        })),
      };
      log.info('SCHED', `14:50 매수 — 영속화 픽 ${rows.length}건 DB 복구 (재시작 복원, APEX#11)`);
    } else {
      log.info('SCHED', `14:50 매수 — 대기 픽 없음 (신호 없거나 가드 차단)`);
      return;
    }
  }
  log.info('SCHED', `14:50 cluster_laggard ${_laggardPending.shadow ? '그림자 기록' : '매수'} 시작 — 후보 ${_laggardPending.picks.length}`);
  try {
    // 현재가(14:50) 조회 — 가격필터·진입가
    const codes = _laggardPending.picks.map(p => p.code);
    const priceMap = await pollPrices(codes);
    const px = {};
    for (const r of Object.values(priceMap || {})) if (r && r.code) px[r.code.replace(/^A/, '')] = r.close || r.open;

    // 상한가잠김 가드용 전일종가 (APEX#7) — 후보 ≤3이라 개별 조회 부담 없음.
    // 조회 실패 종목은 가드만 생략(가격필터는 유지) — 백테 `if pc and ...` 동일 의미.
    const prevCloseMap = {};
    for (const p of _laggardPending.picks) {
      try {
        const d = await fetchStockDetail(p.code);
        if (d?.prevClose > 0) prevCloseMap[p.code] = d.prevClose;
      } catch (e) { /* 가드 생략 */ }
    }

    const { buyList, skipped } = selectLaggardBuyList(_laggardPending.picks, px, prevCloseMap);
    for (const s of skipped) log.info('SCHED', `  skip ${s.code} — ${s.reason}`);
    if (buyList.length === 0) { log.info('SCHED', `14:50 매수 — 필터 통과 0`); return; }

    // ★ L1 휴면 그림자 모드 (APEX#9): 실매수 없이 가상 진입만 기록 → T+1 08:50 가상 청산 → guard_daily
    if (_laggardPending.shadow) {
      const nowIso = new Date().toISOString();
      db.transaction(() => {
        for (const p of buyList) {
          stmts.insertShadowTrade.run({
            signal_date: todayYmd, code: p.code, lag_rank: p.lag_rank ?? null,
            entry: p.entry, created_at: nowIso,
          });
        }
      })();
      log.info('SCHED', `[그림자] ${buyList.length}건 가상 진입 기록 — ${buyList.map(p => `${p.code}@${p.entry}`).join(', ')} (실매수 없음, APEX#9)`);
      _logScanFlow('shadow', buyList.map((p, i) => ({
        rank: (p.lag_rank ?? i) + 1, code: p.code, name: p.name || p.code,
        change_rate: p.change_rate ?? null, cluster_strength: p.cluster_avg_corr ?? null,
        entry_price: p.entry ?? null,
      })));
      return;
    }

    const weight = 1.0 / buyList.length;
    for (const p of buyList) {
      try {
        const capital = Math.floor(_config.strategy.totalCapital * weight);
        if (_isRealMode()) {
          const r = await realBroker.openPositionReal({ code: p.code, name: p.name || p.code },
            { rank: p.rank, weight }, capital, _config.strategy, _kisCfg(), 'cluster_laggard_1430');
          if (r.success) {
            _logSlip({ code: p.code, side: 'buy', refPrice: p.entry, fillPrice: r.price, qty: r.qty, signalDate: todayYmd });
            log.info('SCHED', `  [KIS] 매수 ${p.code} @${r.price}`);
            await discord.sendBuy?.({ code: p.code, name: p.name || p.code, theme: 'laggard1430' }, { qty: r.qty ?? 0, buy_price: r.price ?? 0 }, _config.tradingMode);
          } else { log.error('SCHED', `  [KIS] 매수 실패 ${p.code}: ${r.error}`); }
        } else {
          const opened = paperBroker.openPosition({
            code: p.code, name: p.name || p.code, market: p.market || 'KOSDAQ', buy: p.entry,
            rank: p.rank, weight, cluster_id: _laggardPending.cluster_id,
            signal_source: 'cluster_laggard_1430', signal_date: todayYmd,
            deviation: p.deviation ?? null,
            frozen_date: _laggardPending.frozen_date ?? null,
            cluster_window: _laggardPending.window ?? null,
            cluster_avg_corr: _laggardPending.avg_corr ?? null,
            cluster_size: _laggardPending.size ?? null,
            seed: _laggardPending.seed ? JSON.stringify(_laggardPending.seed) : null,
          }, capital);
          _logSlip({ code: p.code, side: 'buy', refPrice: p.entry, fillPrice: opened?.buy_price, qty: opened?.qty, signalDate: todayYmd });
          log.info('SCHED', `  [paper] 매수 ${p.code} @${p.entry} (lag${p.lag_rank}, 자본=${capital})`);
          await discord.sendBuy?.({ code: p.code, name: p.name || p.code, theme: 'laggard1430' }, opened, _config.tradingMode);
        }
      } catch (e) { log.error('SCHED', `  매수 오류 ${p.code}: ${e.message}`); }
    }
    // 대시보드 '당일 스캔 흐름' 기록 (14:50 매수)
    _logScanFlow('bought', buyList.map((p, i) => ({
      rank: (p.lag_rank ?? i) + 1, code: p.code, name: p.name || p.code,
      change_rate: p.change_rate ?? null, cluster_strength: p.cluster_avg_corr ?? null,
      entry_price: p.entry ?? p.buy ?? null,
    })));
  } catch (e) {
    log.error('SCHED', `14:50 매수 오류: ${e.message}`);
    await discord.sendError?.(`14:50 cluster_laggard 매수 오류: ${e.message}`);
  } finally {
    _laggardPending = null;
    try { stmts.consumeLaggardPendings.run(todayYmd); } catch (e) { /* ignore */ }
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

  if (BUY_MODE === 'cluster_laggard_1430') {
    // ★ APEX 재설계 엔진 (14:30 클러스터 laggard, 원시/raw, ap29 검증) — 장중 실시간 매매
    //   14:30 신호(scanAllStocks + poll_morning_change) → 14:50 매수(현재가, 가격필터 1만~5만, cap2)
    //   청산: 08:50 runMorningSell(T+1 첫분봉 시초가). 레짐가드 L1/L2는 14:30 신호 단계서 체크.
    const sigCron = process.env.APEX_SIGNAL_CRON || '30 14 * * 1-5';   // 14:30 신호
    const buyCron = process.env.APEX_BUY_CRON || '50 14 * * 1-5';      // 14:50 매수
    cron.schedule('31 9 * * 1-5', runMorningSnapshotJob, { timezone: 'Asia/Seoul' });  // 09:31 모닝 스냅샷(표시용)
    cron.schedule(sigCron, runLaggardSignal14, { timezone: 'Asia/Seoul' });
    cron.schedule(buyCron, runLaggardBuy1450, { timezone: 'Asia/Seoul' });
    log.info('SCHED',
      `cron 등록 완료 — 08:50 매도(T+1) / ★ CLUSTER_LAGGARD_1430 (raw·live) ★ 신호[${sigCron}] + 매수[${buyCron}] ` +
      `(mode=${config.tradingMode}, 가격 ${APEX_PRICE_LO}~${APEX_PRICE_HI}, cap=${APEX_DAILY_CAP}, ` +
      `레짐가드 L1=${regimeGuard.L1_TRAIL_DAYS}일/L2 롤링${regimeGuard.L2_ROLL_DAYS}<${(regimeGuard.L2_ROLL_CUT*100)}%·DD<${(regimeGuard.L2_DD_CUT*100)}%)`);

  } else if (BUY_MODE === 'h7') {
    // ★ h7 갭업 + 클러스터 신호 (2026-06-01 지정가 주문 방식)
    // 09:00 갭업 스캔
    cron.schedule('0 9 * * 1-5', runGapupH7Scan, { timezone: 'Asia/Seoul' });
    // 09:01 정적 매수 + 지정가 주문 생성
    cron.schedule('1 9 * * 1-5', runBuyH7, { timezone: 'Asia/Seoul' });

    // ★ paper-self 모드: 매분 폴링으로 지정가 체결 판정 필요
    // KIS 실전/paper 모드: 지정가가 자동 관리되므로 폴링 불필요
    if (config.tradingMode === 'paper-self' && H7_INTRADAY_TARGET > 1.0) {
      cron.schedule('5-59 9 * * 1-5', runH7IntradayCheck, { timezone: 'Asia/Seoul' });
      cron.schedule('* 10-13 * * 1-5', runH7IntradayCheck, { timezone: 'Asia/Seoul' });
      cron.schedule('0-30 14 * * 1-5', runH7IntradayCheck, { timezone: 'Asia/Seoul' });
      log.info('SCHED',
        `[h7 paper-self] 매분 폴링 등록: 09:05~14:30 (지정가 체결 판정)`);
    }

    // D+1 08:50 매도 + 미체결 지정가 처리 (위에서 등록)
    log.info('SCHED',
      `cron 등록 완료 — 08:50 매도(미체결 처리) / ★ H7 GAPUP ★ 09:00 스캔 / 09:01 정적 매수 ` +
      `(mode=${config.tradingMode}, BUY_MODE=${BUY_MODE}, target=${H7_INTRADAY_TARGET}x)`);

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
  runLaggardSignal14,
  runLaggardBuy1450,
  runMorningSnapshotJob,
  selectLaggardBuyList,
  runAfternoonScanJob: runLaggardSignal14,  // server.js 수동 엔드포인트 별칭
  runBuy: runLaggardBuy1450,                // server.js 수동 엔드포인트 별칭
  reloadMail,
  reloadKis,
  BUY_MODE,
  VOL_THRESHOLD,
  H7_INTRADAY_TARGET,
};
