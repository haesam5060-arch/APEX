// ═══════════════════════════════════════════════════════════════
// APEX 09:29 스캐너 — spectral cluster 신호 (NEMESIS 포팅, TRASH=0.30)
//
// 트리거 시점: 09:29:00 KST (cron)
//   1) scanAllStocks() = KOSDAQ+KOSPI 전종목 09:00~09:29 등락률
//   2) strategy.selectPicks() → Python nemesis_signal.py 호출 (TRASH=0.30)
//      → spectral cluster 기반 |편차|≥10 음수 종목 top1·top2 (50:50 분할)
//   3) G1e'' 가드 체크 (picks가 있을 때만, 매매일 단위 1회)
//   4) pending_buy 테이블에 picks 각 row 저장 (rank 1, 2, vol_threshold)
//   5) signal_log + top10_snapshot DB 기록
// ═══════════════════════════════════════════════════════════════

'use strict';

const { scanAllStocks } = require('./stock-fetcher');
const { selectPicks, selectHighclusterLaggard, selectGapupPicks, TOP_N } = require('./strategy');
const { log, stmts } = require('./db');
// h7 모드에서는 G1e 가드 불필요 (정적 매수)
const BUY_MODE = process.env.BUY_MODE || 'static_1101';
const guardG1e = BUY_MODE === 'h7' ? null : require('./guard-g1e');

// 신호 타입: 'spectral' (기본, R1.0) | 'highcluster_laggard' (R2.0)
const SIGNAL_TYPE = process.env.APEX_SIGNAL_TYPE || 'spectral';

// 호환성: HELIOS와 같은 인터페이스
function ensureMapping() { return { ready: true }; }
function reloadMapping() { return ensureMapping(); }

/**
 * 시그널 스캔 (네이버 scanAllStocks → strategy.selectPicks → DB 저장)
 *   opts.deriveOnly=true : 매수 트리거 X, signal_log에 derive_only=1로 기록만
 *   opts.deriveOnly=false: 09:29 매수 시그널 (기본), pending_buy + top10_snapshot 적재
 *   opts.volThreshold : 동적 매수 임계 (0=정적, >0=동적)
 *   opts.tradingMode : paper-self | paper | real
 * @returns {Promise<{picks, top10, excluded, n_scanned, signal_at, signal_date, derive_only, guard}>}
 */
async function runScan(opts = {}) {
  const deriveOnly = !!opts.deriveOnly;
  const signalAt = new Date().toISOString();
  const tag = deriveOnly ? 'derive' : '09:29 시그널';

  log.info('SCANNER', `시세 스캔 시작 [${tag}] (네이버 scanAllStocks)`);
  const t0 = Date.now();
  const scanned = await scanAllStocks();
  const elapsed = Date.now() - t0;
  log.info('SCANNER', `스캔 완료 ${scanned.length}종목 (${elapsed}ms)`);

  const signalDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  let result;
  try {
    // 신호 타입에 따라 다른 함수 호출
    if (SIGNAL_TYPE === 'highcluster_laggard') {
      log.info('SCANNER', `신호 생성 — highcluster_laggard (R2.0)`);
      result = await selectHighclusterLaggard(scanned, signalDate);
    } else {
      log.info('SCANNER', `신호 생성 — spectral (R1.0/R4.2.1, TRASH=0.30)`);
      result = await selectPicks(scanned, signalDate);
    }
  } catch (e) {
    log.error('SCANNER', `신호 생성 실패 (type=${SIGNAL_TYPE}): ${e.message}`);
    return {
      picks: [], top10: [], excluded: { reason: e.message },
      n_scanned: scanned.length, signal_at: signalAt, signal_date: signalDate, derive_only: deriveOnly,
    };
  }

  const picks = result.picks || [];
  const pick1 = picks[0] || null;  // signal_log 대표값으로 사용

  // signal_log 기록 (picks[0]을 대표로, picks 전체는 별도 메타로)
  const logRow = {
    signal_date: signalDate,
    signal_at: signalAt,
    signal_type: 'spectral',  // R1.0/R4.2.1 spectral cluster
    pick_code: pick1?.code || null,
    pick_name: pick1?.name || null,
    pick_buy: pick1?.buy || null,
    pick_change_rate: pick1?.change_rate_929 || null,
    pick_cluster_id: pick1?.cluster_id ?? null,
    pick_cluster_count: pick1?.cluster_count ?? null,
    pick_cluster_size: pick1?.cluster_size ?? null,
    pick_signal_source: pick1?.signal_source || null,
    pick_deviation: pick1?.deviation ?? null,
    pick_abs_dev: pick1?.abs_dev ?? null,
    pick_excluded: result.excluded ? 1 : 0,
    pick_excluded_reason: result.excluded?.reason || null,
    n_top10: result.top10.length,
    n_clusters_active: result.diag?.n_active_clusters_w20 ?? result.diag?.n_clusters_active ?? 0,
    n_scanned: scanned.length,
    derive_only: deriveOnly ? 1 : 0,
  };
  try { stmts.insertSignalLog.run(logRow); }
  catch (e) { log.warn('SCANNER', `signal_log insert 실패: ${e.message}`); }

  // top10 snapshot + pending_buy (derive-only는 스킵)
  if (!deriveOnly) {
    try {
      for (const stk of result.top10) {
        stmts.insertTop10.run({
          signal_date: signalDate,
          rank: stk.rank,
          code: stk.code,
          name: stk.name || '',
          change_rate: stk.changeRate,
          close_price: stk.close,
          market: stk.market || '',
          cluster_w20: null,
          cluster_w5: null,
        });
      }
    } catch (e) { log.warn('SCANNER', `top10 snapshot insert 실패: ${e.message}`); }

    // pending_buy: picks 있으면 매매일 단위 G1e 가드 체크 후 각 pick row 저장
    if (picks.length > 0) {
      const tradingMode = opts.tradingMode || 'paper-self';
      // ★ G1e'' 가드: h7 모드는 스킵 (정적 매수이므로 가드 불필요)
      let guardResult = { action: 'allow', reason: 'h7 mode (no guard)' };
      if (guardG1e) {
        guardResult = guardG1e.checkAndApply(tradingMode, signalDate);
      }
      result.guard = guardResult;

      if (guardResult.action === 'skip_active' || guardResult.action === 'skip_triggered') {
        const codes = picks.map(p => `${p.name}(${p.code})`).join(', ');
        log.warn('SCANNER',
          `[GUARD G1e''] pending_buy 전체 skip — ${codes} | ${guardResult.reason}`);
        // picks는 result에 유지 (signal_log 분석용). pending_buy는 안 만듦.
      } else {
        // picks 순회하면서 각 row insert
        let nInserted = 0;
        for (const p of picks) {
          try {
            stmts.insertPendingBuy.run({
              signal_date: signalDate,
              signal_type: 'spectral',  // R1.0/R4.2.1 spectral cluster
              rank: p.rank,
              weight: p.weight,
              pick_code: p.code,
              pick_name: p.name,
              pick_cluster_id: p.cluster_id ?? null,
              pick_signal_source: p.signal_source,
              pick_deviation: p.deviation,
              pick_abs_dev: p.abs_dev,
              pick_market: p.market || null,  // KOSDAQ | KOSPI | ETF
              pick_buy: p.buy ?? null,  // 매수 참고가
              vol_threshold: opts.volThreshold || 0,  // 0 = 정적, >0 = 동적
              created_at: signalAt,
            });
            nInserted++;
          } catch (e) {
            log.warn('SCANNER', `pending_buy insert 실패 (rank=${p.rank}): ${e.message}`);
          }
        }
        const codeList = picks.map(p =>
          `${p.name}(${p.code}, rank=${p.rank}, w=${(p.weight * 100).toFixed(0)}%, dev=${p.deviation?.toFixed(2)})`
        ).join(' / ');
        log.info('SCANNER',
          `pending_buy ${nInserted}건 저장 — ${codeList} | ${guardResult.reason}`);
      }
    }
  }

  // 콘솔 요약
  const label = deriveOnly ? '[derive]' : '[09:29 picks]';
  if (picks.length > 0) {
    const summaryLine = picks.map(p => {
      const cidStr = p.cluster_id !== null
        ? `cluster#${p.cluster_id}(cs=${p.cluster_size},corr=${p.avg_corr?.toFixed(2)})`
        : p.signal_source;
      return `${p.name}(${p.code}) rank=${p.rank} ${cidStr} dev=${p.deviation?.toFixed(2)}`;
    }).join(' | ');
    log.info('SCANNER', `${label} ${picks.length}종목 — ${summaryLine}`);
  } else {
    log.warn('SCANNER', `${label} 매수 후보 없음 — ${result.excluded?.reason || '시그널 조건 미충족'}`);
  }

  return { ...result, n_scanned: scanned.length, signal_at: signalAt, signal_date: signalDate, derive_only: deriveOnly };
}

/**
 * h7 09:00 갭업 + 클러스터 스캔
 *   갭업: close >= prev_close × 1.10 (10%)
 *   거래량: vol >= avg_vol × 5.0 (5배)
 *   클러스터: avg_corr >= 0.42, size >= 8
 *   포지션: N=2 (50:50 분할)
 *   매수: 09:00 정적 (09:01 runBuyH7)
 *   매도: D+1 09:00 (기존 로직)
 * @returns {Promise<{picks, gapup_stocks, excluded, diag, signal_at, signal_date, n_scanned}>}
 */
async function runGapupScan(opts = {}) {
  const signalAt = new Date().toISOString();
  const tag = 'h7 09:00 갭업';

  log.info('SCANNER', `h7 갭업 스캔 시작 (09:00, 네이버 scanAllStocks)`);
  const t0 = Date.now();
  const scanned = await scanAllStocks();
  const elapsed = Date.now() - t0;
  log.info('SCANNER', `스캔 완료 ${scanned.length}종목 (${elapsed}ms)`);

  const signalDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  let result;
  try {
    log.info('SCANNER', `h7 신호 생성 — 갭업 + spectral cluster (avg_corr≥0.42, cs≥8)`);
    result = await selectGapupPicks(scanned, signalDate);
  } catch (e) {
    log.error('SCANNER', `h7 신호 생성 실패: ${e.message}`);
    return {
      picks: [],
      gapup_stocks: [],
      excluded: { reason: e.message },
      n_scanned: scanned.length,
      signal_at: signalAt,
      signal_date: signalDate,
    };
  }

  const picks = result.picks || [];
  const pick1 = picks[0] || null;

  // h7 signal_log 기록 (별도 signal_type='h7')
  const logRow = {
    signal_date: signalDate,
    signal_at: signalAt,
    signal_type: 'h7_gapup',
    pick_code: pick1?.code || null,
    pick_name: pick1?.name || null,
    pick_buy: pick1?.buy || null,
    pick_change_rate: pick1?.change_rate_900 || null,
    pick_cluster_id: pick1?.cluster_id ?? null,
    pick_cluster_size: pick1?.cluster_size ?? null,
    pick_cluster_corr: pick1?.cluster_avg_corr ?? null,
    pick_signal_source: pick1?.signal_source || null,
    pick_excluded: result.excluded ? 1 : 0,
    pick_excluded_reason: result.excluded?.reason || null,
    n_gapup: result.gapup_stocks?.length || 0,
    n_scanned: scanned.length,
    derive_only: 0,
  };
  try {
    stmts.insertSignalLog.run(logRow);
  } catch (e) {
    log.warn('SCANNER', `h7 signal_log insert 실패: ${e.message}`);
  }

  // pending_buy 저장 (h7은 정적 매수이므로 vol_threshold=0)
  if (picks.length > 0) {
    const tradingMode = opts.tradingMode || 'paper-self';
    // ★ h7은 G1e 가드 생략 (정적 신호이고 빈도 낮음)
    let nInserted = 0;
    for (const p of picks) {
      try {
        stmts.insertPendingBuy.run({
          signal_date: signalDate,
          signal_type: 'h7_gapup',
          rank: p.rank,
          weight: p.weight,
          pick_code: p.code,
          pick_name: p.name,
          pick_cluster_id: p.cluster_id ?? null,
          pick_signal_source: p.signal_source,
          pick_deviation: p.deviation ?? null,
          pick_abs_dev: p.abs_dev ?? null,
          pick_market: p.market || null,
          pick_buy: p.buy ?? null,  // ★ 09:00 close — 매수 qty 계산용
          vol_threshold: 0,  // h7은 정적 매수 (09:01)
          created_at: signalAt,
        });
        nInserted++;
      } catch (e) {
        log.warn('SCANNER', `h7 pending_buy insert 실패 (rank=${p.rank}): ${e.message}`);
      }
    }
    const codeList = picks.map(p =>
      `${p.name}(${p.code}, gapup_ratio=${(p.gapup_ratio * 100).toFixed(1)}%, cluster_corr=${p.cluster_avg_corr?.toFixed(2)})`
    ).join(' / ');
    log.info('SCANNER', `h7 pending_buy ${nInserted}건 저장 — ${codeList}`);
  } else {
    log.warn('SCANNER', `h7 갭업 후보 없음 — ${result.excluded?.reason || '조건 미충족'}`);
  }

  return {
    ...result,
    n_scanned: scanned.length,
    signal_at: signalAt,
    signal_date: signalDate,
  };
}

module.exports = { runScan, runGapupScan, ensureMapping, reloadMapping, TOP_N };
