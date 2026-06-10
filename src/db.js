// ═══════════════════════════════════════════════════════════════
// APEX SQLite — 포지션·체결·일별 손익·시그널 로그
//
// NEMESIS R4.2.1 스타일로 마이그레이션 (2026-05-30):
//   09:29 등락률 top10 스캔 → 서랍 spectral 클러스터 신호
//   09:36~14:29 동적 매수 (cum_vol >= 2.5M 트리거) 또는 14:30 fallback
//   T+1 09:00 시초가 매도 (손절/익절 없음)
//
//   pending_buy: vol_threshold / cum_vol / buy_time / exit_type 컬럼 추가
//   signal_log: spectral cluster 메타데이터 + pick_market (KOSDAQ/ETF/KOSPI)
//   top10_snapshot: 09:29 등락률 Top10 기록 (사후 분석)
//   guard_state: G1e'' 가드 상태 (singleton, 매매일 단위 가드)
// ═══════════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
// 테스트가 임시 DB 경로 주입할 수 있게 환경변수 우선 사용
const DB_PATH = process.env.APEX_DB_PATH || path.join(DATA_DIR, 'apex.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- 보유 포지션 (open / closed)
  CREATE TABLE IF NOT EXISTS positions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    code                TEXT NOT NULL,
    name                TEXT NOT NULL,
    market              TEXT NOT NULL,                    -- KOSDAQ | KOSPI | ETF
    qty                 INTEGER NOT NULL,
    buy_price           INTEGER NOT NULL,
    buy_at              TEXT NOT NULL,
    buy_date            TEXT NOT NULL,
    mode                TEXT NOT NULL,                    -- paper-self | paper | real
    status              TEXT NOT NULL DEFAULT 'open',     -- open | closed
    cluster_id          INTEGER,                          -- spectral cluster_id (W=20 or W=5)
    signal_source       TEXT,                             -- s16_w20 | s16_w5
    deviation           REAL,                             -- 정규화 편차 (음수)
    abs_dev             REAL,                             -- |편차| 절대값
    top10_rank          INTEGER,                          -- 09:29 등락률 rank (1-10)
    change_rate_929     REAL,                             -- 09:29 등락률 (소수)
    rank                INTEGER DEFAULT 1,                -- 포지션 순위 (1|2 분할)
    weight              REAL DEFAULT 1.0,                 -- 포지션 비중 (0.5 분할 = 2개)
    signal_date         TEXT                              -- 09:29 신호 발생일 (YYYYMMDD)
  );
  CREATE INDEX IF NOT EXISTS idx_pos_status ON positions(status, buy_date DESC);

  -- 체결 이력 (매수+매도 페어)
  CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    market          TEXT NOT NULL,
    qty             INTEGER NOT NULL,
    buy_price       INTEGER NOT NULL,
    sell_price      INTEGER NOT NULL,
    buy_at          TEXT NOT NULL,
    sell_at         TEXT NOT NULL,
    buy_date        TEXT NOT NULL,
    sell_date       TEXT NOT NULL,
    pnl             INTEGER NOT NULL,
    return_pct      REAL NOT NULL,
    exit_reason     TEXT NOT NULL DEFAULT 'next_day_open',
    fee_paid        INTEGER NOT NULL DEFAULT 0,
    mode            TEXT NOT NULL,
    signal_date     TEXT,                             -- 09:29 신호 발생일 (YYYYMMDD)
    cluster_id      INTEGER,                          -- spectral cluster_id
    signal_source   TEXT,                             -- s16_w20 | s16_w5
    rank            INTEGER DEFAULT 1,                -- 1|2 분할 순위
    weight          REAL DEFAULT 1.0                  -- 포지션 비중
  );
  CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(sell_date DESC);

  -- 일별 손익 정산
  CREATE TABLE IF NOT EXISTS daily_pnl (
    sell_date       TEXT PRIMARY KEY,
    n_trades        INTEGER NOT NULL,
    pnl             INTEGER NOT NULL,
    buy_total       INTEGER NOT NULL,
    avg_pct         REAL NOT NULL,
    win_rate        REAL NOT NULL
  );

  -- 슬리피지 계측 (2026-06-03) — 가정가(ref) vs 실체결가(fill) 기록.
  --   paper-self: ref=fill(폴 가격)이라 slip_bp≈0 — fill_price+ts로 parquet 교차검증(데이터/타이밍 슬립)용.
  --   paper/real(KIS): ref=신호시점 폴가, fill=KIS 체결가 → 실집행 슬립(slip_bp).
  --   목적: 실왕복비용 측정 → T+1 래치위험·T+2 채택 결정의 입력. 매매 로직과 무관(로깅 전용).
  CREATE TABLE IF NOT EXISTS slippage_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,                        -- ISO 타임스탬프 (체결 시점)
    signal_date   TEXT,                                 -- 신호일 YYYYMMDD
    code          TEXT NOT NULL,
    side          TEXT NOT NULL,                        -- buy | sell
    mode          TEXT NOT NULL,                        -- paper-self | paper | real
    ref_price     REAL,                                 -- 가정가 (buy=14:50 폴, sell=T+1 시초 폴)
    fill_price    REAL NOT NULL,                        -- 실체결가 (paper-self=폴, KIS=체결)
    slip_bp       REAL,                                 -- (fill/ref-1)*10000 (buy 양수=불리)
    qty           INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_slip_ts ON slippage_log(ts DESC);

  -- 당일 스캔 흐름 (대시보드 '당일 스캔 흐름' 패널용, 2026-06-04)
  --   09:31 스냅샷(Top10) → 14:30 스캔(클러스터 laggard 후보) → 14:50 매수 흐름 기록.
  --   phase: snapshot | scanned | bought | sold. 표시 전용 — 매매 로직 무관(기록만).
  CREATE TABLE IF NOT EXISTS scan_flow (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_date      TEXT NOT NULL,                     -- YYYYMMDD
    ts               TEXT NOT NULL,                     -- ISO
    phase            TEXT NOT NULL,                     -- snapshot|scanned|bought|sold
    rank             INTEGER,
    code             TEXT,
    name             TEXT,
    change_rate      REAL,
    cluster_strength REAL,                              -- cluster avg_corr (scanned 단계)
    entry_price      REAL,
    mode             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scanflow_date ON scan_flow(signal_date, id);

  -- 09:31 모닝 장중등락률 확정 수집 (APEX#8, 2026-06-10)
  --   09:31 cron: 전일대비 상위 N ∪ 거래대금 상위 M (B안) 종목의 09:00~09:29 장중등락률을
  --   poll_morning_change로 확정 계산해 저장. 14:30 신호는 이 저장분만 사용.
  --   (구 14:30 시점 프리필터 150 재구성은 신호일 29% 발산 — 09:31 수집으로 ~3%)
  CREATE TABLE IF NOT EXISTS morning_change (
    signal_date     TEXT NOT NULL,                     -- YYYYMMDD
    code            TEXT NOT NULL,                     -- 6자리 (A 없음)
    ret             REAL NOT NULL,                     -- 09:00~09:29 장중 등락률
    vi_ok           INTEGER NOT NULL DEFAULT 0,        -- 백테 VI 필터 통과 (first<=905, bars>=20)
    first_open      INTEGER,
    last_close      INTEGER,
    polled_at       TEXT,
    PRIMARY KEY (signal_date, code)
  );

  -- 09:29 Top10 snapshot (사후 분석/리뷰)
  --   매일 09:29 cron: 09:00~09:29 등락률 Top10 저장
  CREATE TABLE IF NOT EXISTS top10_snapshot (
    signal_date     TEXT NOT NULL,
    rank            INTEGER NOT NULL,
    code            TEXT NOT NULL,
    name            TEXT,
    change_rate     REAL NOT NULL,
    close_price     INTEGER NOT NULL,
    market          TEXT,                                 -- KOSDAQ | KOSPI | ETF
    cluster_w20     INTEGER,                              -- 속한 W=20 cluster_id (사후)
    cluster_w5      INTEGER,                              -- 속한 W=5 cluster_id (사후)
    PRIMARY KEY (signal_date, rank)
  );
  CREATE INDEX IF NOT EXISTS idx_top10_date ON top10_snapshot(signal_date DESC);

  -- 09:29/09:00 시그널 로그 (spectral cluster 신호 + h7 갭업)
  --   signal_type: 09:29_spectral | h7_gapup
  --   derive_only=0 : 매수 트리거 신호 (1회)
  --   derive_only=1 : 관찰용 (수동 호출 등)
  CREATE TABLE IF NOT EXISTS signal_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_date     TEXT NOT NULL,                        -- YYYYMMDD (신호 발생일)
    signal_at       TEXT NOT NULL,                        -- ISO 타임스탬프
    signal_type     TEXT DEFAULT '09:29_spectral',        -- 09:29_spectral | h7_gapup
    pick_code       TEXT,                                 -- 선정 종목 코드 (NULL이면 신호 없음)
    pick_name       TEXT,                                 -- 선정 종목 이름
    pick_buy        INTEGER,                              -- 09:29/09:00 기준 참고가
    pick_change_rate REAL,                                -- 09:29 등락률
    pick_cluster_id INTEGER,                              -- 속한 spectral cluster_id
    pick_cluster_count INTEGER,                           -- cluster 멤버 수
    pick_cluster_size INTEGER,                            -- cluster 총 사이즈
    pick_cluster_corr REAL,                               -- h7용: cluster 평균 상관도
    pick_signal_source TEXT,                              -- s16_w20 | s16_w5 | h7_gapup_cluster
    pick_deviation  REAL,                                 -- 정규화 편차 (음수)
    pick_abs_dev    REAL,                                 -- |편차| 절대값
    pick_excluded   INTEGER DEFAULT 0,                    -- 1 = 가드/필터로 제외
    pick_excluded_reason TEXT,                            -- 제외 사유 (가드/차단)
    n_top10         INTEGER,                              -- 09:29 Top10 개수
    n_gapup         INTEGER,                              -- h7용: 갭업 감지 종목 수
    n_clusters_active INTEGER,                            -- 활성 cluster 개수
    n_scanned       INTEGER,                              -- 스캔한 전체 종목 개수
    derive_only     INTEGER NOT NULL DEFAULT 0            -- 1 = 관찰용 (매수X)
  );
  CREATE INDEX IF NOT EXISTS idx_signal_date ON signal_log(signal_date DESC);

  -- 매수 대기열 (09:29 스캔 → 09:36~14:29 동적 트리거 또는 14:30 fallback)
  --   매매일당 2종목(rank=1,2) 보관. consumed=0이면 미체결 pending.
  --   vol_threshold > 0이면 동적 매수, 0이면 정적 매수(호환 모드)
  CREATE TABLE IF NOT EXISTS pending_buy (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_date     TEXT NOT NULL,                        -- YYYYMMDD
    rank            INTEGER NOT NULL DEFAULT 1,           -- 1 | 2 (top2 분할)
    weight          REAL NOT NULL DEFAULT 1.0,            -- 포지션 비중 (0.5 분할)
    pick_code       TEXT NOT NULL,                        -- 선정 종목 코드
    pick_name       TEXT NOT NULL,                        -- 선정 종목 이름
    pick_cluster_id INTEGER,                              -- spectral cluster_id
    pick_signal_source TEXT,                              -- s16_w20 | s16_w5 | h7_gapup_cluster
    pick_deviation  REAL,                                 -- 정규화 편차
    pick_abs_dev    REAL,                                 -- |편차| 절대값
    pick_market     TEXT,                                 -- KOSDAQ | KOSPI | ETF
    pick_buy        INTEGER,                              -- 매수 참고가 (h7: 09:00 close, 매수 qty 계산용)
    vol_threshold   INTEGER DEFAULT 2500000,              -- 동적 매수 트리거 누적 거래량
    cum_vol         INTEGER DEFAULT 0,                    -- 마지막 polling 누적 거래량 (진행 추적)
    buy_time        TEXT,                                 -- 실제 매수 시각 (HHMM, 예: 1055)
    exit_type       TEXT,                                 -- triggered | fallback | low_price | blocked | failed
    created_at      TEXT NOT NULL,                        -- 시그널 생성 시각
    consumed        INTEGER NOT NULL DEFAULT 0,           -- 1 = 매수 완료
    UNIQUE(signal_date, rank)
  );

  -- paper-self 가상 잔고 (싱글톤)
  CREATE TABLE IF NOT EXISTS paper_balance (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    initial_capital INTEGER NOT NULL,
    cash            INTEGER NOT NULL,
    updated_at      TEXT NOT NULL
  );

  -- G1e'' 가드 상태 (singleton, 매매일 단위 가드 통계)
  --   직전 4 매매일 일별 가중 누적 ≤ -4% 면 트리거 → 3 매매일 skip → cooldown
  CREATE TABLE IF NOT EXISTS guard_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    mode            TEXT NOT NULL,                        -- paper-self | paper | real (모드 격리)
    skip_remaining  INTEGER DEFAULT 0,                    -- skip 대기 매매일 수 (0 = 해제)
    cooldown_remaining INTEGER DEFAULT 0,                 -- cooldown 대기 매매일 수
    last_trigger_date TEXT,                               -- 마지막 트리거 날짜 (YYYY-MM-DD)
    last_signal_date TEXT,                                -- 마지막 시그널 날짜 (YYYYMMDD)
    cum_return_4d   REAL DEFAULT 0.0,                     -- 직전 4 매매일 일별 가중 누적 (%)
    updated_at      TEXT NOT NULL
  );

  -- 운영 로그
  CREATE TABLE IF NOT EXISTS logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    level           TEXT NOT NULL,
    category        TEXT,
    message         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);

  -- 슬리피지 측정 (실전화 판단 게이트, 2026-05-30)
  --   09:36~14:29 동적 매수 또는 14:30 fallback 시 호가창 기반 추정 슬리피지
  --   + T+1 09:00 실현 슬리피지 기록. 왕복 슬리피지 중앙값 <0.2% → 합격 / >0.3% → 실전화 보류.
  CREATE TABLE IF NOT EXISTS slippage_probe (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,                     -- YYYYMMDD (매수일)
    code             TEXT NOT NULL,
    name             TEXT NOT NULL,

    -- 매수 슬리피지 (트리거 분봉 또는 14:30, 호가창 추정)
    ref_price        INTEGER,                 -- 트리거 분봉 open 또는 14:30 close
    best_ask         INTEGER,                 -- 1호가 ask
    est_fill_price   INTEGER,                 -- 추정 체결가
    order_amount     INTEGER,                 -- 투입 금액 (원)
    buy_slip_bps     REAL,                    -- 매수 슬리피지 bp
    ask_depth_json   TEXT,                    -- ask 1~5 호가 JSON

    -- 매도 슬리피지 (T+1 09:00, 실현)
    buy_price        INTEGER,                 -- 실제 매수가 (paper-broker 기록)
    sell_open        INTEGER,                 -- T+1 시초가
    sell_slip_bps    REAL,                    -- 매도 슬리피지 bp

    -- 왕복
    roundtrip_bps    REAL,
    status           TEXT NOT NULL DEFAULT 'buy_only',
    bought_at        TEXT,
    sold_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_slip_date ON slippage_probe(date DESC, code);
`);

// ── 마이그레이션: R4.2.1 spectral cluster + 동적 매수 ──
// SQLite는 ADD COLUMN IF NOT EXISTS 미지원 → try/catch 무시
function _safeAlter(sql) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

// 기존 positions 테이블에 spectral cluster 메타 추가
_safeAlter(`ALTER TABLE positions ADD COLUMN cluster_id       INTEGER`);
_safeAlter(`ALTER TABLE positions ADD COLUMN signal_source    TEXT`);
_safeAlter(`ALTER TABLE positions ADD COLUMN deviation        REAL`);
_safeAlter(`ALTER TABLE positions ADD COLUMN abs_dev          REAL`);
_safeAlter(`ALTER TABLE positions ADD COLUMN top10_rank       INTEGER`);
_safeAlter(`ALTER TABLE positions ADD COLUMN change_rate_929  REAL`);
_safeAlter(`ALTER TABLE positions ADD COLUMN rank             INTEGER DEFAULT 1`);
_safeAlter(`ALTER TABLE positions ADD COLUMN weight           REAL DEFAULT 1.0`);
_safeAlter(`ALTER TABLE positions ADD COLUMN signal_date      TEXT`);

// 기존 trades 테이블에 spectral cluster + rank/weight 추가
_safeAlter(`ALTER TABLE trades ADD COLUMN signal_date  TEXT`);
_safeAlter(`ALTER TABLE trades ADD COLUMN cluster_id   INTEGER`);
_safeAlter(`ALTER TABLE trades ADD COLUMN signal_source TEXT`);
_safeAlter(`ALTER TABLE trades ADD COLUMN rank         INTEGER DEFAULT 1`);
_safeAlter(`ALTER TABLE trades ADD COLUMN weight       REAL DEFAULT 1.0`);

// 서랍 추종·딥링크 메타 (2026-06-04) — 얼린서랍 날짜/윈도우/동조도/사이즈/추종 시드주(JSON)
_safeAlter(`ALTER TABLE positions ADD COLUMN frozen_date      TEXT`);     // 사용한 spectral 스냅샷 날짜(=얼린 서랍) YYYYMMDD
_safeAlter(`ALTER TABLE positions ADD COLUMN cluster_window   INTEGER`); // spectral window (5/10/15/20)
_safeAlter(`ALTER TABLE positions ADD COLUMN cluster_avg_corr REAL`);    // 클러스터 평균 동조도
_safeAlter(`ALTER TABLE positions ADD COLUMN cluster_size     INTEGER`); // 클러스터 멤버 수
_safeAlter(`ALTER TABLE positions ADD COLUMN seed             TEXT`);    // 추종 대상(아침 강세 시드주) JSON [{code,name,ret}]
_safeAlter(`ALTER TABLE trades ADD COLUMN frozen_date      TEXT`);
_safeAlter(`ALTER TABLE trades ADD COLUMN cluster_window   INTEGER`);
_safeAlter(`ALTER TABLE trades ADD COLUMN cluster_avg_corr REAL`);
_safeAlter(`ALTER TABLE trades ADD COLUMN cluster_size     INTEGER`);
_safeAlter(`ALTER TABLE trades ADD COLUMN seed             TEXT`);

// h7 갭업 신호 지원 (2026-05-31)
_safeAlter(`ALTER TABLE signal_log ADD COLUMN signal_type TEXT DEFAULT 'spectral'`);  // 'spectral' | 'h7_gapup'
_safeAlter(`ALTER TABLE pending_buy ADD COLUMN signal_type TEXT DEFAULT 'spectral'`);  // 동일
_safeAlter(`ALTER TABLE pending_buy ADD COLUMN pick_buy    INTEGER`);                   // h7 매수 참고가 (qty 계산용)

// h7 지정가 매도 지원 (2026-06-01) — 폴링 제거, 지정가 주문 관리
_safeAlter(`ALTER TABLE positions ADD COLUMN limit_order_price  INTEGER`);              // h7 지정가 가격 (buy_price × 1.05)
_safeAlter(`ALTER TABLE positions ADD COLUMN limit_order_filled_at TEXT`);              // 지정가 체결 시각 (ISO 타임스탬프)

// ── helpers ─────────────────────────────────────
function logMsg(level, category, message) {
  try {
    db.prepare(`INSERT INTO logs (level, category, message) VALUES (?, ?, ?)`).run(level, category, message);
  } catch (_) {}
  const tag = `[${level.toUpperCase()}]${category ? ` [${category}]` : ''}`;
  console.log(`${new Date().toISOString()} ${tag} ${message}`);
}

const log = {
  info:  (cat, msg) => logMsg('info', cat, msg),
  warn:  (cat, msg) => logMsg('warn', cat, msg),
  error: (cat, msg) => logMsg('error', cat, msg),
};

const stmts = {
  // ── positions ──
  insertPosition: db.prepare(`
    INSERT INTO positions
      (code, name, market, qty, buy_price, buy_at, buy_date, mode, status,
       cluster_id, signal_source, deviation, abs_dev, top10_rank, change_rate_929,
       rank, weight, signal_date,
       frozen_date, cluster_window, cluster_avg_corr, cluster_size, seed)
    VALUES
      (@code, @name, @market, @qty, @buy_price, @buy_at, @buy_date, @mode, 'open',
       @cluster_id, @signal_source, @deviation, @abs_dev, @top10_rank, @change_rate_929,
       @rank, @weight, @signal_date,
       @frozen_date, @cluster_window, @cluster_avg_corr, @cluster_size, @seed)
  `),
  closePosition: db.prepare(`UPDATE positions SET status = 'closed' WHERE id = ?`),
  getOpenPositions: db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY buy_at`),
  getOpenPositionsByDate: db.prepare(`SELECT * FROM positions WHERE status = 'open' AND buy_date = ? ORDER BY buy_at`),

  // ── trades ──
  insertTrade: db.prepare(`
    INSERT INTO trades
      (code, name, market, qty, buy_price, sell_price,
       buy_at, sell_at, buy_date, sell_date,
       pnl, return_pct, exit_reason, fee_paid, mode,
       signal_date, cluster_id, signal_source, rank, weight,
       frozen_date, cluster_window, cluster_avg_corr, cluster_size, seed)
    VALUES
      (@code, @name, @market, @qty, @buy_price, @sell_price,
       @buy_at, @sell_at, @buy_date, @sell_date,
       @pnl, @return_pct, @exit_reason, @fee_paid, @mode,
       @signal_date, @cluster_id, @signal_source, @rank, @weight,
       @frozen_date, @cluster_window, @cluster_avg_corr, @cluster_size, @seed)
  `),
  recentTrades: db.prepare(`SELECT * FROM trades ORDER BY sell_at DESC LIMIT ?`),
  tradesByDate: db.prepare(`SELECT * FROM trades WHERE sell_date = ? ORDER BY sell_at`),
  tradesByBuyDate: db.prepare(`SELECT * FROM trades WHERE buy_date = ? ORDER BY buy_at`),

  // ── daily pnl ──
  upsertDailyPnl: db.prepare(`
    INSERT INTO daily_pnl (sell_date, n_trades, pnl, buy_total, avg_pct, win_rate)
    VALUES (@sell_date, @n_trades, @pnl, @buy_total, @avg_pct, @win_rate)
    ON CONFLICT(sell_date) DO UPDATE SET
      n_trades=excluded.n_trades, pnl=excluded.pnl, buy_total=excluded.buy_total,
      avg_pct=excluded.avg_pct, win_rate=excluded.win_rate
  `),
  recentDailyPnl: db.prepare(`SELECT * FROM daily_pnl ORDER BY sell_date DESC LIMIT ?`),

  // ── slippage 계측 ──
  insertSlippage: db.prepare(`
    INSERT INTO slippage_log (ts, signal_date, code, side, mode, ref_price, fill_price, slip_bp, qty)
    VALUES (@ts, @signal_date, @code, @side, @mode, @ref_price, @fill_price, @slip_bp, @qty)
  `),
  recentSlippage: db.prepare(`SELECT * FROM slippage_log ORDER BY ts DESC LIMIT ?`),

  // ── scan_flow (당일 스캔 흐름 패널) ──
  insertScanFlow: db.prepare(`
    INSERT INTO scan_flow (signal_date, ts, phase, rank, code, name, change_rate, cluster_strength, entry_price, mode)
    VALUES (@signal_date, @ts, @phase, @rank, @code, @name, @change_rate, @cluster_strength, @entry_price, @mode)
  `),
  getScanFlowByDate: db.prepare(`SELECT * FROM scan_flow WHERE signal_date = ? ORDER BY id`),
  clearScanFlowPhase: db.prepare(`DELETE FROM scan_flow WHERE signal_date = ? AND phase = ?`),

  // ── morning_change (09:31 확정 수집, APEX#8) ──
  insertMorningChange: db.prepare(`
    INSERT OR REPLACE INTO morning_change (signal_date, code, ret, vi_ok, first_open, last_close, polled_at)
    VALUES (@signal_date, @code, @ret, @vi_ok, @first_open, @last_close, @polled_at)
  `),
  morningChangeByDate: db.prepare(`SELECT * FROM morning_change WHERE signal_date = ?`),
  clearMorningChange: db.prepare(`DELETE FROM morning_change WHERE signal_date = ?`),

  // ── top10_snapshot ──
  insertTop10: db.prepare(`
    INSERT OR REPLACE INTO top10_snapshot
      (signal_date, rank, code, name, change_rate, close_price, market, cluster_w20, cluster_w5)
    VALUES (@signal_date, @rank, @code, @name, @change_rate, @close_price, @market, @cluster_w20, @cluster_w5)
  `),
  top10ByDate: db.prepare(`SELECT * FROM top10_snapshot WHERE signal_date = ? ORDER BY rank`),
  getMorningSnapshotCount: db.prepare(`SELECT COUNT(*) AS cnt FROM top10_snapshot WHERE signal_date = ?`),

  // ── signal_log (R4.2.1 spectral cluster 신호 + h7 갭업) ──
  insertSignalLog: db.prepare(`
    INSERT INTO signal_log
      (signal_date, signal_at, signal_type, pick_code, pick_name, pick_buy, pick_change_rate,
       pick_cluster_id, pick_cluster_count, pick_cluster_size, pick_signal_source,
       pick_deviation, pick_abs_dev, pick_excluded, pick_excluded_reason,
       n_top10, n_clusters_active, n_scanned, derive_only)
    VALUES
      (@signal_date, @signal_at, @signal_type, @pick_code, @pick_name, @pick_buy, @pick_change_rate,
       @pick_cluster_id, @pick_cluster_count, @pick_cluster_size, @pick_signal_source,
       @pick_deviation, @pick_abs_dev, @pick_excluded, @pick_excluded_reason,
       @n_top10, @n_clusters_active, @n_scanned, @derive_only)
  `),
  recentSignals: db.prepare(`SELECT * FROM signal_log ORDER BY signal_at DESC LIMIT ?`),
  signalByDate: db.prepare(`
    SELECT * FROM signal_log
    WHERE signal_date = ? AND derive_only = 0
    ORDER BY id DESC LIMIT 1
  `),
  signalsByDate: db.prepare(`
    SELECT * FROM signal_log
    WHERE signal_date = ? AND derive_only = 0
    ORDER BY signal_at DESC
  `),
  // 대시보드 /api/top10·/api/top20 — 해당일 선정된(pick_code 있는) 신호
  selectedSignalsByDate: db.prepare(`
    SELECT * FROM signal_log
    WHERE signal_date = ? AND pick_code IS NOT NULL AND derive_only = 0
    ORDER BY signal_at DESC
  `),

  // ── pending_buy (R4.2.1 동적 매수 + h7 갭업 정적 매수) ──
  insertPendingBuy: db.prepare(`
    INSERT OR REPLACE INTO pending_buy
      (signal_date, signal_type, rank, weight, pick_code, pick_name, pick_cluster_id, pick_signal_source,
       pick_deviation, pick_abs_dev, pick_market, pick_buy, vol_threshold, created_at, consumed)
    VALUES
      (@signal_date, @signal_type, @rank, @weight, @pick_code, @pick_name, @pick_cluster_id, @pick_signal_source,
       @pick_deviation, @pick_abs_dev, @pick_market, @pick_buy, @vol_threshold, @created_at, 0)
  `),
  getPendingBuy: db.prepare(`SELECT * FROM pending_buy WHERE signal_date = ? AND rank = 1 AND consumed = 0`),
  getAllPendingBuys: db.prepare(`SELECT * FROM pending_buy WHERE signal_date = ? AND consumed = 0 ORDER BY rank`),
  getPendingsByDate: db.prepare(`SELECT * FROM pending_buy WHERE signal_date = ? ORDER BY rank`),
  consumePendingBuy: db.prepare(`UPDATE pending_buy SET consumed = 1 WHERE id = ?`),
  updatePendingCumVol: db.prepare(`UPDATE pending_buy SET cum_vol = ? WHERE id = ?`),
  markPendingBought: db.prepare(`
    UPDATE pending_buy SET consumed = 1, buy_time = ?, exit_type = ?, cum_vol = ?
    WHERE id = ?
  `),

  // ── guard_state (G1e'' 가드) ──
  getGuardState: db.prepare(`SELECT * FROM guard_state WHERE id = 1`),
  initGuardState: db.prepare(`
    INSERT OR IGNORE INTO guard_state (id, mode, updated_at)
    VALUES (1, ?, datetime('now', 'localtime'))
  `),
  updateGuardState: db.prepare(`
    UPDATE guard_state
    SET skip_remaining = ?, cooldown_remaining = ?, last_trigger_date = ?,
        last_signal_date = ?, cum_return_4d = ?, updated_at = datetime('now', 'localtime')
    WHERE id = 1
  `),

  // ── paper_balance ──
  getPaperBalance: db.prepare(`SELECT * FROM paper_balance WHERE id = 1`),
  initPaperBalance: db.prepare(`
    INSERT OR IGNORE INTO paper_balance (id, initial_capital, cash, updated_at)
    VALUES (1, ?, ?, datetime('now', 'localtime'))
  `),
  updatePaperCash: db.prepare(`
    UPDATE paper_balance SET cash = ?, updated_at = datetime('now', 'localtime') WHERE id = 1
  `),

  // ── logs ──
  recentLogs: db.prepare(`SELECT * FROM logs ORDER BY ts DESC LIMIT ?`),

  // ── slippage_probe ──
  insertSlippageBuy: db.prepare(`
    INSERT INTO slippage_probe
      (date, code, name, ref_price, best_ask, est_fill_price, order_amount,
       buy_slip_bps, ask_depth_json, status, bought_at)
    VALUES
      (@date, @code, @name, @ref_price, @best_ask, @est_fill_price, @order_amount,
       @buy_slip_bps, @ask_depth_json, 'buy_only', @bought_at)
  `),
  updateSlippageSell: db.prepare(`
    UPDATE slippage_probe
    SET buy_price = @buy_price, sell_open = @sell_open,
        sell_slip_bps = @sell_slip_bps,
        roundtrip_bps = @roundtrip_bps,
        status = 'complete', sold_at = @sold_at
    WHERE date = @date AND code = @code AND status = 'buy_only'
  `),
  getSlippageAll: db.prepare(`
    SELECT * FROM slippage_probe ORDER BY date DESC, code
  `),
  getSlippageStats: db.prepare(`
    SELECT
      COUNT(*)                                          AS n_buy,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS n_complete,
      ROUND(AVG(buy_slip_bps), 2)                       AS avg_buy_bps,
      ROUND(AVG(sell_slip_bps), 2)                      AS avg_sell_bps,
      ROUND(AVG(roundtrip_bps), 2)                      AS avg_rt_bps,
      ROUND(MIN(roundtrip_bps), 2)                      AS min_rt_bps,
      ROUND(MAX(roundtrip_bps), 2)                      AS max_rt_bps
    FROM slippage_probe WHERE status = 'complete'
  `),
};

module.exports = { db, log, stmts, DB_PATH };
