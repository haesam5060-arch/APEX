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

module.exports = {
  selectTop10,
  selectPicks,
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
