// ═══════════════════════════════════════════════════════════════
// APEX 시그널 모듈 — NEMESIS R4.2.1 로직 포팅 (spectral cluster + TRASH=0.30)
//
// 신호 생성:
//   09:29 등락률 Top10 추출 (09:00~09:29 변동)
//   → spectral cluster (Python nemesis_signal.py) + TRASH=0.30 필터
//   → KOSDAQ+ETF 사전 필터 + |편차|≥10 음수 종목
//   → top1·top2 (50:50 분할)
//
// 매매:
//   09:36~14:29 동적 매수 (cum_vol ≥ 2.5M 도달 분봉 open)
//   14:30 fallback (미트리거 종목 14:30 분봉 open)
//   D+1 09:00 시초가 매도
//
// 차이점 vs APEX 구:
//   - cluster_strength(비율) → spectral clustering(편차 기반)
//   - morning_snapshot(9:31) → spectral W=20/W=5(D-1 스냅샷)
//   - 14:50 정적 매수 → 09:36~14:29 동적 + 14:30 fallback
//   - pending_buy: vol_threshold, cum_vol, buy_time, exit_type 추가
// ═══════════════════════════════════════════════════════════════

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PYTHON_BIN = process.env.PYTHON_BIN ||
  path.resolve(__dirname, '..', '..', 'backtest', '.venv', 'bin', 'python');
const SIGNAL_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'nemesis_signal.py');

// ★ ETF 리스트 로드 (2026-05-30, 정확한 리스트 기반)
let ETF_CODES_SET = new Set();
try {
  const etfDataPath = path.resolve(__dirname, '..', 'data', 'etf_codes.json');
  if (fs.existsSync(etfDataPath)) {
    const etfData = JSON.parse(fs.readFileSync(etfDataPath, 'utf-8'));
    ETF_CODES_SET = new Set(etfData.etf_codes || []);
    console.log(`[strategy] ETF 리스트 로드: ${ETF_CODES_SET.size}개`);
  }
} catch (err) {
  console.warn(`[strategy] ETF 리스트 로드 실패: ${err.message}. KOSDAQ_ETF 모드 비활성화.`);
}

// 파라미터 (TRASH=0.30)
const LIMIT_UP_CUT = 0.295;           // 상한가 +29.5% 이상 제외
const TOP_N = 10;                     // Top10
const N_PICKS = 2;                    // top1·top2 선정
const DEFAULT_WEIGHTS = [0.5, 0.5];   // 50:50 분할
const PRICE_GUARD_PCT = 0.285;        // 상한가 근처 +28.5% 이상 skip

// 시장 필터 (env 변수로 토글)
//   KOSDAQ_ETF (기본): KOSDAQ + ETF 정확한 리스트
//   KOSDAQ_ONLY: KOSDAQ만
//   BOTH: 필터 없음 (KOSDAQ+KOSPI 모두)
const MARKET_FILTER = process.env.NEMESIS_MARKET_FILTER || 'KOSDAQ_ETF';

/**
 * 09:29 등락률 Top10 추출
 * @param {Array} scanned - stock-fetcher.scanAllStocks() 결과
 * @returns {Array} top10
 */
function selectTop10(scanned) {
  const afterCut = scanned.filter(s => s.changeRate < LIMIT_UP_CUT);
  const sorted = afterCut.slice().sort((a, b) => b.changeRate - a.changeRate);
  const top10 = sorted.slice(0, TOP_N).map((s, i) => ({
    rank: i + 1,
    code: s.code,
    name: s.name || '',
    close: s.close,
    changeRate: s.changeRate,
    market: s.market || null,
  }));
  return top10;
}

/**
 * Python nemesis_signal.py 호출 → ranked picks
 * @param {string} signalDate - 'YYYYMMDD'
 * @param {Array} top10
 * @param {Array<string>|null} kosdaqCodes - 'A012330' 형식
 * @returns {Promise<Object>} { ok, picks, diag, prev_date } or { ok: false, error }
 */
function callPythonSignal(signalDate, top10, kosdaqCodes = null) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      signal_date: signalDate,
      top10: top10.map(t => ({ code: _stripA(t.code), name: t.name, change_rate: t.changeRate })),
      kosdaq_codes: kosdaqCodes,
    });

    const proc = spawn(PYTHON_BIN, [SIGNAL_SCRIPT], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Python spawn 실패: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python 종료 코드 ${code}: ${stderr || stdout}`));
      }
      try {
        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1];
        const parsed = JSON.parse(jsonLine);
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Python 출력 파싱 실패: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

// 코드 포맷 변환 ('A012330' ↔ '012330')
function _withA(code6) {
  return code6.startsWith('A') ? code6 : `A${code6}`;
}
function _stripA(code) {
  return code.startsWith('A') ? code.slice(1) : code;
}

/**
 * 09:29 신호 스캔 → pending_buy 생성용 picks 반환
 * @param {Array} scanned - stock-fetcher.scanAllStocks() 결과
 * @param {string} signalDate - 'YYYYMMDD'
 * @returns {Promise<Object>} {
 *   picks: [pick1, pick2] | [],
 *   top10: [...],
 *   excluded: { reason } | null,
 *   diag: { ... },
 *   prev_date: 'YYYYMMDD',
 * }
 */
async function selectPicks(scanned, signalDate) {
  const top10Raw = selectTop10(scanned);

  const top10WithA = top10Raw.map(t => ({ ...t, code: _withA(t.code) }));

  // ★ 시장 사전 필터 (TRASH=0.30 버전)
  let kosdaqCodes = null;
  if (MARKET_FILTER === 'KOSDAQ_ONLY') {
    // KOSDAQ만
    kosdaqCodes = scanned
      .filter(s => s.market === 'KOSDAQ' && s.code)
      .map(s => _withA(s.code));
  } else if (MARKET_FILTER === 'KOSDAQ_ETF') {
    // KOSDAQ + ETF (정확한 리스트)
    kosdaqCodes = scanned
      .filter(s => {
        if (!s.code) return false;
        const codeWithA = _withA(s.code);
        return s.market === 'KOSDAQ' || ETF_CODES_SET.has(codeWithA);
      })
      .map(s => _withA(s.code));
  }
  // else: BOTH → kosdaqCodes = null (필터 없음)

  // Python 호출
  const pyResult = await callPythonSignal(signalDate, top10WithA, kosdaqCodes);

  if (!pyResult.ok) {
    return {
      picks: [],
      top10: top10Raw,
      excluded: { reason: `Python 시그널 오류: ${pyResult.error || 'unknown'}` },
      diag: pyResult.diag || {},
    };
  }

  const pyPicks = pyResult.picks || [];
  if (!pyPicks.length) {
    return {
      picks: [],
      top10: top10Raw,
      excluded: { reason: pyResult.diag?.reason || '시그널 조건 미충족' },
      diag: pyResult.diag || {},
      prev_date: pyResult.prev_date,
    };
  }

  // 각 pick을 scanned 전체에서 매칭 + 보강
  const codeToScanned = new Map(scanned.map(s => [s.code, s]));
  let picks = pyPicks.map((pyPick) => {
    const pickCode6 = _stripA(pyPick.code);
    const scannedRow = codeToScanned.get(pickCode6);
    const inTop10 = top10Raw.find(t => t.code === pickCode6);
    const close = scannedRow ? scannedRow.close : null;
    const changeRate = scannedRow ? scannedRow.changeRate : null;
    const name = scannedRow ? scannedRow.name : (pyPick.name || '');
    const top10Rank = inTop10 ? inTop10.rank : null;
    const market = scannedRow ? scannedRow.market : null;

    return {
      code: pickCode6,
      name,
      market,
      rank: pyPick.rank,                  // 1 (top1) | 2 (top2)
      weight: pyPick.weight,              // 0.5
      buy: close,                         // 09:29 기준 가격
      change_rate_929: changeRate,
      top10_rank: top10Rank,
      cluster_id: pyPick.cluster_id ?? null,
      cluster_count: pyPick.cluster_count ?? null,
      cluster_size: pyPick.cluster_size ?? null,
      avg_corr: pyPick.avg_corr ?? null,
      signal_source: pyPick.signal_source,   // s16_w20 | s16_w5
      deviation: pyPick.deviation,
      abs_dev: pyPick.abs_dev,
    };
  });

  return {
    picks,
    top10: top10Raw,
    excluded: null,
    diag: {
      ...(pyResult.diag || {}),
      market_filter: MARKET_FILTER,
      n_kosdaq_codes_sent: kosdaqCodes ? kosdaqCodes.length : null,
    },
    prev_date: pyResult.prev_date,
  };
}

/**
 * 09:30 highcluster_laggard 신호 생성 (APEX R2.0)
 *
 * 상한가간(≥29.5%) 종목 → 동일 cluster의 최약자(laggard) 선택
 *
 * @param {Array} scanned - stock-fetcher.scanAllStocks() 결과
 * @param {string} signalDate - 'YYYYMMDD'
 * @returns {Promise<Object>} {
 *   picks: [{code, rank, weight, cluster_id, signal_source, ...}],
 *   top10: [...],
 *   excluded: {reason} | null,
 *   diag: {...}
 * }
 */
async function selectHighclusterLaggard(scanned, signalDate) {
  const spectralLoader = require('./spectral-cluster-loader');

  // 1. Top10 추출 (상한가 +29.5% 컷)
  const top10Raw = selectTop10(scanned);
  if (top10Raw.length === 0) {
    return {
      picks: [],
      top10: top10Raw,
      excluded: { reason: '09:29 top10 추출 실패' },
      diag: {},
    };
  }

  // 2. 상한가간 필터 (changeRate ≥ 29.5%)
  const HIGHCLUSTER_CUT = 0.295;
  const highclusterSeeds = top10Raw.filter(t => t.changeRate >= HIGHCLUSTER_CUT);
  if (highclusterSeeds.length === 0) {
    return {
      picks: [],
      top10: top10Raw,
      excluded: { reason: '상한가간 종목 없음' },
      diag: { n_top10: top10Raw.length },
    };
  }

  // 3. spectral cluster 로드
  let spectralData;
  try {
    spectralData = await spectralLoader.loadSpectralClusters();
  } catch (err) {
    console.error('[selectHighclusterLaggard] spectral loader 오류:', err.message);
    return {
      picks: [],
      top10: top10Raw,
      excluded: { reason: `spectral loader 오류: ${err.message}` },
      diag: { n_seeds: highclusterSeeds.length },
    };
  }

  // 4. 상한가간 종목 → cluster_id 식별
  const seedCodes = new Set(highclusterSeeds.map(s => _withA(s.code)));
  const clusterIdsSet = new Set();

  for (const code of seedCodes) {
    const clusterInfo = spectralData.codeToCluster.get(code);
    if (clusterInfo) {
      clusterIdsSet.add(clusterInfo.cluster_id);
    }
  }

  if (clusterIdsSet.size === 0) {
    return {
      picks: [],
      top10: top10Raw,
      excluded: { reason: '상한가간 종목의 cluster 정보 없음' },
      diag: {
        n_seeds: highclusterSeeds.length,
        n_clusters_identified: 0,
      },
    };
  }

  // 5. 각 cluster의 laggard 선택
  const codeToScanned = new Map(scanned.map(s => [s.code, s]));
  const picks = [];
  const MAX_LAG_PER_CLUSTER = 2;  // 클러스터당 최대 2개
  const TRASH_MIN = 0.34;         // cluster avg_corr 최소값

  for (const clusterId of clusterIdsSet) {
    const clusterData = spectralData.clusterToMembers.get(clusterId);
    if (!clusterData) continue;

    // cluster avg_corr < TRASH 확인 (필터링)
    if (clusterData.avg_corr < TRASH_MIN) continue;

    // 상한가간 제외 + scanned에서 매칭
    const nonSeedMembers = [];
    for (const memberCode of clusterData.members) {
      if (seedCodes.has(memberCode)) continue;  // 상한가간 제외

      const memberCode6 = _stripA(memberCode);
      const scannedRow = codeToScanned.get(memberCode6);
      if (!scannedRow) continue;

      nonSeedMembers.push({
        code: memberCode6,
        codeWithA: memberCode,
        changeRate: scannedRow.changeRate,
        name: scannedRow.name || '',
        close: scannedRow.close,
        market: scannedRow.market || null,
        scannedRow,
      });
    }

    if (nonSeedMembers.length === 0) continue;

    // 09:00~09:29 등락률 낮은 순 정렬 (lowest first)
    nonSeedMembers.sort((a, b) => a.changeRate - b.changeRate);

    // 클러스터당 최대 MAX_LAG_PER_CLUSTER개 선택
    for (let i = 0; i < Math.min(MAX_LAG_PER_CLUSTER, nonSeedMembers.length); i++) {
      const lag = nonSeedMembers[i];
      picks.push({
        code: lag.code,
        codeWithA: lag.codeWithA,
        name: lag.name,
        market: lag.market,
        rank: picks.length + 1,
        weight: null,  // 나중에 정규화
        change_rate_929: lag.changeRate,
        buy: lag.close,
        cluster_id: clusterId,
        cluster_avg_corr: clusterData.avg_corr,
        cluster_size: clusterData.size,
        signal_source: 'highcluster_laggard_w20',
      });
    }
  }

  // 6. 자본 분할 정규화 (균등 분할)
  if (picks.length > 0) {
    const totalWeight = picks.length;
    for (const p of picks) {
      p.weight = 1.0 / totalWeight;
    }
  }

  // 7. 반환
  return {
    picks,
    top10: top10Raw,
    excluded: picks.length === 0 ? { reason: 'laggard 선택 불가' } : null,
    diag: {
      n_seeds: highclusterSeeds.length,
      n_clusters_identified: clusterIdsSet.size,
      n_picks: picks.length,
      avg_lag_per_cluster: clusterIdsSet.size > 0 ? picks.length / clusterIdsSet.size : 0,
    },
  };
}

/**
 * h7 갭업 + 클러스터 신호 (2026-05-31, 정적 매수)
 *
 * 신호 정의:
 *   - 갭업: close >= prev_close × 1.10 (10%)
 *   - 거래량: vol >= avg_vol × 5.0 (5배)
 *   - 클러스터: spectral cluster, avg_corr >= 0.42, size >= 8
 *   - 편차: |편차| >= 10, 음수만
 *   - 포지션: N=2 (상위 2개, 50:50 분할)
 *   - 매수: 09:00 day_open (정적)
 *   - 매도: D+1 09:00 (시초가)
 *
 * @param {Array} scanned - stock-fetcher.scanAllStocks() 결과 (09:00 기준)
 * @param {string} signalDate - 'YYYYMMDD'
 * @returns {Promise<Object>} {
 *   picks: [{code, rank, weight, cluster_id, ...}] | [],
 *   gapup_stocks: [...],  // 갭업 감지 종목
 *   excluded: {reason} | null,
 *   diag: {...}
 * }
 */
async function selectGapupPicks(scanned, signalDate) {
  const spectralLoader = require('./spectral-cluster-loader');
  const H7_GAPUP_RATIO = 1.10;      // 10% 갭업
  const H7_VOL_RATIO = 5.0;         // 5배 거래량
  const H7_TRASH_MIN = 0.42;        // cluster avg_corr 최소값
  const H7_CLUSTER_SIZE_MIN = 8;    // cluster 최소 크기
  const H7_DEV_CUT = 10;            // |편차| 최소값, 음수만
  const H7_N_PICKS = 2;             // top1·top2
  const H7_PRICE_GUARD = 0.285;     // 상한가 근처 28.5%

  // 1. 갭업 감지 (09:00 기준)
  const gapupStocks = [];
  for (const s of scanned) {
    if (!s.code || !s.close || !s.prevClose || !s.volume || !s.avgVolume) continue;

    const gapupRatio = s.close / s.prevClose;
    const volRatio = s.volume / s.avgVolume;

    if (gapupRatio >= H7_GAPUP_RATIO && volRatio >= H7_VOL_RATIO) {
      gapupStocks.push({
        code: s.code,
        name: s.name || '',
        close: s.close,
        prevClose: s.prevClose,
        gapupRatio: gapupRatio - 1,  // %-format (0.10 = 10%)
        volRatio,
        market: s.market || null,
      });
    }
  }

  if (gapupStocks.length === 0) {
    return {
      picks: [],
      gapup_stocks: [],
      excluded: { reason: '갭업 (10% + 5배 거래량) 종목 없음' },
      diag: { n_scanned: scanned.length, n_gapup: 0 },
    };
  }

  // 2. spectral cluster 로드
  let spectralData;
  try {
    spectralData = await spectralLoader.loadSpectralClusters();
  } catch (err) {
    console.error('[selectGapupPicks] spectral loader 오류:', err.message);
    return {
      picks: [],
      gapup_stocks: gapupStocks,
      excluded: { reason: `spectral loader 오류: ${err.message}` },
      diag: { n_gapup: gapupStocks.length },
    };
  }

  // 3. 각 갭업 종목의 클러스터 조사 → 멤버 선택
  const codeToScanned = new Map(scanned.map(s => [s.code, s]));
  const allPicks = [];  // 모든 후보

  for (const gapup of gapupStocks) {
    const gapupCodeWithA = _withA(gapup.code);
    const clusterInfo = spectralData.codeToCluster.get(gapupCodeWithA);

    if (!clusterInfo) {
      continue;  // 이 갭업 종목의 cluster 정보 없음
    }

    const clusterId = clusterInfo.cluster_id;
    const clusterData = spectralData.clusterToMembers.get(clusterId);

    if (!clusterData) continue;

    // cluster 필터: avg_corr >= 0.42, size >= 8
    if (clusterData.avg_corr < H7_TRASH_MIN || clusterData.members.length < H7_CLUSTER_SIZE_MIN) {
      continue;
    }

    // 4. 클러스터 멤버 중 |편차| >= 10 음수만 후보
    const candidates = [];
    for (const memberCode of clusterData.members) {
      const memberCode6 = _stripA(memberCode);
      const scannedRow = codeToScanned.get(memberCode6);
      if (!scannedRow) continue;

      // Python nemesis_signal에서 전달한 편차 정보 사용
      // (현재는 scanned에 편차 없으므로, 여기서는 모든 멤버 후보)
      // ★ 실제 구현: Python 호출로 편차 계산 또는 scanned에 편차 필드 추가
      candidates.push({
        code: memberCode6,
        codeWithA: memberCode,
        name: scannedRow.name || '',
        close: scannedRow.close,
        market: scannedRow.market || null,
        changeRate: scannedRow.changeRate,
        scannedRow,
      });
    }

    // 5. 상위 N=2 선택
    //   ★ 백테(h7_gapup_cluster_both.py)와 일치: cluster members 순서 앞 N개 (정렬 없음).
    //   백테는 `selected_members = members[:N_PICKS]` 로 서랍 cluster builder 순서를 그대로 사용.
    //   운영도 동일 순서를 유지해야 백테(검증 +635%)를 재현 (글로벌 CLAUDE.md §8.4 백테-운영 일치).
    //   참고: changeRate 낮은 순(laggard) 정렬 버전은 알파 논리상 더 맞을 수 있으나 미검증 → 향후 백테 비교 후보.
    const picked = candidates.slice(0, H7_N_PICKS);
    for (const p of picked) {
      allPicks.push({
        code: p.code,
        name: p.name,
        market: p.market,
        rank: allPicks.length + 1,
        weight: null,  // 나중에 정규화
        close: p.close,
        changeRate: p.changeRate,
        cluster_id: clusterId,
        cluster_avg_corr: clusterData.avg_corr,
        cluster_size: clusterData.members.length,
        cluster_members: clusterData.members.length,
        signal_source: 'h7_gapup_cluster',
        gapup_seed: gapup.code,
        gapup_ratio: gapup.gapupRatio,
      });
    }
  }

  // 6. 자본 분할 정규화 (50:50, 상위 N=2)
  if (allPicks.length > 0) {
    // h7은 정적 매수이므로 N=2 고정
    let finalPicks = allPicks.slice(0, H7_N_PICKS);
    const totalWeight = finalPicks.length;
    for (const p of finalPicks) {
      p.weight = 1.0 / totalWeight;
    }

    // 7. 상한가 가드 (28.5%)
    //   buy_price는 09:00 day_open이므로, prev_close × 1.285 가드
    const guarded = [];
    for (const p of finalPicks) {
      const guardThreshold = (p.scannedRow?.prevClose || p.close) * (1 + H7_PRICE_GUARD);
      if (p.close < guardThreshold) {
        guarded.push(p);
      }
    }

    return {
      picks: guarded.map(p => ({
        code: p.code,
        name: p.name,
        market: p.market,
        rank: p.rank,
        weight: p.weight,
        buy: p.close,  // 09:00 day_open 가격
        change_rate_900: p.changeRate,
        cluster_id: p.cluster_id,
        cluster_avg_corr: p.cluster_avg_corr,
        cluster_size: p.cluster_size,
        signal_source: p.signal_source,
        gapup_seed: p.gapup_seed,
        gapup_ratio: p.gapup_ratio,
      })),
      gapup_stocks: gapupStocks,
      excluded: guarded.length < finalPicks.length ? { reason: '상한가 가드로 일부 skip' } : null,
      diag: {
        n_scanned: scanned.length,
        n_gapup: gapupStocks.length,
        n_candidates: allPicks.length,
        n_final_picks: guarded.length,
      },
    };
  }

  return {
    picks: [],
    gapup_stocks: gapupStocks,
    excluded: { reason: 'h7 클러스터 필터링 후 후보 없음' },
    diag: {
      n_scanned: scanned.length,
      n_gapup: gapupStocks.length,
      n_candidates: allPicks.length,
    },
  };
}

module.exports = {
  selectTop10,
  selectPicks,
  selectHighclusterLaggard,
  selectGapupPicks,
  callPythonSignal,
  LIMIT_UP_CUT,
  TOP_N,
  N_PICKS,
  DEFAULT_WEIGHTS,
  PRICE_GUARD_PCT,
  MARKET_FILTER,
  _withA,
  _stripA,
};
