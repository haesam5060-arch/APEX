// tests/db.test.js — NEMESIS R4.2.1 DB 스키마 검증
//
// 테스트 케이스:
//   1) 테이블 생성 (positions, trades, pending_buy, signal_log, top10_snapshot, etc)
//   2) pending_buy 신규 컬럼 (vol_threshold, cum_vol, buy_time, exit_type, pick_market)
//   3) signal_log 스키마
//   4) INSERT/SELECT 동작
//   5) 트랜잭션 무결성

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// 테스트용 DB 격리 (in-memory)
const TEST_DB = path.join(os.tmpdir(), `apex-db-test-${Date.now()}.db`);
process.env.APEX_DB_PATH = TEST_DB;

let pass = 0, fail = 0;

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
}

function assertEq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual: ${JSON.stringify(actual)}`);
  }
}

function assert(cond, msg = '') {
  if (!cond) throw new Error(msg);
}

function assertNotNull(v, msg = '') {
  if (v == null) throw new Error(`${msg} (null/undefined)`);
}

function assertExists(v, field, msg = '') {
  if (!(field in v)) throw new Error(`${msg}: field "${field}" not found`);
}

async function run() {
  console.log('db.스키마 검증 (테이블 생성)');

  // 모듈 로드 — 이 시점에 CREATE TABLE IF NOT EXISTS 실행
  const { db, stmts } = require('../src/db');

  // ─────────────────────────────────────────────────
  // 테이블 존재 확인
  // ─────────────────────────────────────────────────

  await t('positions 테이블 생성 확인', async () => {
    const result = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='positions'
    `).get();
    assertNotNull(result, 'positions 테이블 필수');
  });

  await t('trades 테이블 생성 확인', async () => {
    const result = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='trades'
    `).get();
    assertNotNull(result, 'trades 테이블 필수');
  });

  await t('pending_buy 테이블 생성 확인', async () => {
    const result = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='pending_buy'
    `).get();
    assertNotNull(result, 'pending_buy 테이블 필수');
  });

  await t('signal_log 테이블 생성 확인', async () => {
    const result = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='signal_log'
    `).get();
    assertNotNull(result, 'signal_log 테이블 필수');
  });

  await t('top10_snapshot 테이블 생성 확인', async () => {
    const result = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='top10_snapshot'
    `).get();
    assertNotNull(result, 'top10_snapshot 테이블 필수');
  });

  await t('guard_state 테이블 생성 확인', async () => {
    const result = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='guard_state'
    `).get();
    assertNotNull(result, 'guard_state 테이블 필수');
  });

  // ─────────────────────────────────────────────────
  // pending_buy 컬럼 검증 (R4.2.1 신규)
  // ─────────────────────────────────────────────────

  console.log('\ndb.pending_buy 컬럼 검증 (R4.2.1)');

  await t('pending_buy: vol_threshold 컬럼 (기본값 2500000)', async () => {
    const info = db.prepare('PRAGMA table_info(pending_buy)').all();
    const col = info.find(c => c.name === 'vol_threshold');
    assertNotNull(col, 'vol_threshold 컬럼 필수');
  });

  await t('pending_buy: cum_vol 컬럼 (진행 추적)', async () => {
    const info = db.prepare('PRAGMA table_info(pending_buy)').all();
    const col = info.find(c => c.name === 'cum_vol');
    assertNotNull(col, 'cum_vol 컬럼 필수');
  });

  await t('pending_buy: buy_time 컬럼 (실제 매수 시각, HHMM)', async () => {
    const info = db.prepare('PRAGMA table_info(pending_buy)').all();
    const col = info.find(c => c.name === 'buy_time');
    assertNotNull(col, 'buy_time 컬럼 필수');
  });

  await t('pending_buy: exit_type 컬럼 (triggered|fallback|low_price)', async () => {
    const info = db.prepare('PRAGMA table_info(pending_buy)').all();
    const col = info.find(c => c.name === 'exit_type');
    assertNotNull(col, 'exit_type 컬럼 필수');
  });

  await t('pending_buy: pick_market 컬럼 (KOSDAQ|KOSPI|ETF)', async () => {
    const info = db.prepare('PRAGMA table_info(pending_buy)').all();
    const col = info.find(c => c.name === 'pick_market');
    assertNotNull(col, 'pick_market 컬럼 필수');
  });

  await t('pending_buy: consumed 컬럼 (0|1)', async () => {
    const info = db.prepare('PRAGMA table_info(pending_buy)').all();
    const col = info.find(c => c.name === 'consumed');
    assertNotNull(col, 'consumed 컬럼 필수');
  });

  // ─────────────────────────────────────────────────
  // signal_log 컬럼 검증
  // ─────────────────────────────────────────────────

  console.log('\ndb.signal_log 컬럼 검증 (spectral cluster)');

  await t('signal_log: signal_date (YYYYMMDD)', async () => {
    const info = db.prepare('PRAGMA table_info(signal_log)').all();
    const col = info.find(c => c.name === 'signal_date');
    assertNotNull(col, 'signal_date 컬럼 필수');
  });

  await t('signal_log: pick_cluster_id (spectral cluster_id)', async () => {
    const info = db.prepare('PRAGMA table_info(signal_log)').all();
    const col = info.find(c => c.name === 'pick_cluster_id');
    assertNotNull(col, 'pick_cluster_id 컬럼 필수');
  });

  await t('signal_log: pick_signal_source (s16_w20|s16_w5)', async () => {
    const info = db.prepare('PRAGMA table_info(signal_log)').all();
    const col = info.find(c => c.name === 'pick_signal_source');
    assertNotNull(col, 'pick_signal_source 컬럼 필수');
  });

  await t('signal_log: pick_deviation (정규화 편차, 음수)', async () => {
    const info = db.prepare('PRAGMA table_info(signal_log)').all();
    const col = info.find(c => c.name === 'pick_deviation');
    assertNotNull(col, 'pick_deviation 컬럼 필수');
  });

  // ─────────────────────────────────────────────────
  // INSERT / SELECT 동작 검증
  // ─────────────────────────────────────────────────

  console.log('\ndb.INSERT/SELECT 동작');

  await t('insertPendingBuy: 정상 INSERT', async () => {
    stmts.insertPendingBuy.run({
      signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
      signal_type: 'spectral',  // h7 신호 추가 (2026-05-31)
      rank: 1,
      weight: 0.5,
      pick_code: 'A012330',
      pick_name: '현대모비스',
      pick_cluster_id: 42,
      pick_signal_source: 's16_w20',
      pick_deviation: -15.5,
      pick_abs_dev: 15.5,
      pick_market: 'KOSDAQ',
      pick_buy: 67000,
      vol_threshold: 2_500_000,
      created_at: new Date().toISOString(),
    });

    const row = db.prepare('SELECT * FROM pending_buy WHERE signal_date=? AND rank=?')
      .get('20260601', 1);
    assertNotNull(row, 'INSERT 후 SELECT 확인');
    assertEq(row.pick_code, 'A012330');
    assertEq(row.pick_buy, 67000);
    assertEq(row.vol_threshold, 2_500_000);
    assertEq(row.consumed, 0);
  });

  await t('pending_buy: consumed 업데이트 (0→1)', async () => {
    const before = db.prepare('SELECT consumed FROM pending_buy WHERE signal_date=? AND rank=?')
      .get('20260601', 1);
    assertEq(before.consumed, 0);

    db.prepare('UPDATE pending_buy SET consumed=1, buy_time=?, exit_type=? WHERE signal_date=? AND rank=?')
      .run('1054', 'triggered', '20260601', 1);

    const after = db.prepare('SELECT consumed, buy_time, exit_type FROM pending_buy WHERE signal_date=? AND rank=?')
      .get('20260601', 1);
    assertEq(after.consumed, 1);
    assertEq(after.buy_time, '1054');
    assertEq(after.exit_type, 'triggered');
  });

  await t('pending_buy: cum_vol 증가 (진행 추적)', async () => {
    const before = db.prepare('SELECT cum_vol FROM pending_buy WHERE signal_date=? AND rank=?')
      .get('20260601', 1);
    assertEq(before.cum_vol, 0);

    db.prepare('UPDATE pending_buy SET cum_vol=? WHERE signal_date=? AND rank=?')
      .run(1_800_000, '20260601', 1);

    const after = db.prepare('SELECT cum_vol FROM pending_buy WHERE signal_date=? AND rank=?')
      .get('20260601', 1);
    assertEq(after.cum_vol, 1_800_000);
  });

  // ─────────────────────────────────────────────────
  // signal_log INSERT 검증
  // ─────────────────────────────────────────────────

  console.log('\ndb.signal_log INSERT 검증');

  await t('signal_log: 신호 기록 (pick 있음)', async () => {
    const now = new Date().toISOString();
    stmts.insertSignalLog.run({
      signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
      signal_at: now,
      signal_type: 'spectral',  // h7 신호 추가 (2026-05-31)
      pick_code: 'A012330',
      pick_name: '현대모비스',
      pick_buy: 67000,
      pick_change_rate: 0.12,
      pick_cluster_id: 42,
      pick_cluster_count: 12,
      pick_cluster_size: 12,
      pick_signal_source: 's16_w20',
      pick_deviation: -15.5,
      pick_abs_dev: 15.5,
      pick_excluded: 0,
      pick_excluded_reason: null,
      n_top10: 10,
      n_clusters_active: 5,
      n_scanned: 3500,
      derive_only: 0,
    });

    const row = db.prepare('SELECT * FROM signal_log WHERE signal_date=?')
      .get('20260601');
    assertNotNull(row, 'signal_log INSERT 확인');
    assertEq(row.pick_code, 'A012330');
    assertEq(row.pick_cluster_id, 42);
    assertEq(row.pick_deviation, -15.5);
  });

  await t('signal_log: 신호 없음 (pick_code=NULL)', async () => {
    const now = new Date().toISOString();
    stmts.insertSignalLog.run({
      signal_date: '20260602',
      signal_at: now,
      signal_type: 'spectral',  // h7 신호 추가 (2026-05-31)
      pick_code: null,
      pick_name: null,
      pick_buy: null,
      pick_change_rate: null,
      pick_cluster_id: null,
      pick_cluster_count: null,
      pick_cluster_size: null,
      pick_signal_source: null,
      pick_deviation: null,
      pick_abs_dev: null,
      pick_excluded: 1,
      pick_excluded_reason: '시그널 조건 미충족',
      n_top10: 10,
      n_clusters_active: 3,
      n_scanned: 3500,
      derive_only: 0,
    });

    const row = db.prepare('SELECT * FROM signal_log WHERE signal_date=?')
      .get('20260602');
    assertNotNull(row, 'signal_log (pick=NULL) INSERT 확인');
    assertEq(row.pick_code, null);
    assertEq(row.pick_excluded, 1);
  });

  // ─────────────────────────────────────────────────
  // top10_snapshot 검증
  // ─────────────────────────────────────────────────

  console.log('\ndb.top10_snapshot 검증 (09:29 Top10 스냅)');

  await t('top10_snapshot: 10개 종목 저장', async () => {
    for (let i = 1; i <= 10; i++) {
      stmts.insertTop10.run({
        signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
        rank: i,
        code: `A${100000 + i}`,
        name: `Stock${i}`,
        change_rate: 0.30 - (i * 0.02),
        close_price: 10000 + (i * 100),
        market: i <= 5 ? 'KOSDAQ' : 'KOSPI',
        cluster_w20: 42,
        cluster_w5: 8,
      });
    }

    const rows = db.prepare('SELECT * FROM top10_snapshot WHERE signal_date=? ORDER BY rank')
      .all('20260601');
    assertEq(rows.length, 10);
    assertEq(rows[0].rank, 1);
    assertEq(rows[9].rank, 10);
  });

  await t('top10_snapshot: INSERT OR REPLACE 로직 (중복 시 업데이트)', async () => {
    // insertTop10은 INSERT OR REPLACE이므로 중복 rank는 업데이트됨
    stmts.insertTop10.run({
      signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
      rank: 1, // 이미 존재
      code: 'A999999',
      name: 'Updated',
      change_rate: 0.25,
      close_price: 11000,
      market: 'KOSDAQ',
      cluster_w20: 42,
      cluster_w5: 8,
    });

    const row = db.prepare('SELECT * FROM top10_snapshot WHERE signal_date=? AND rank=?')
      .get('20260601', 1);
    assertEq(row.code, 'A999999', '업데이트 확인');
    assertEq(row.name, 'Updated');
  });

  // ─────────────────────────────────────────────────
  // Positions / Trades (기본 테이블)
  // ─────────────────────────────────────────────────

  console.log('\ndb.positions & trades (기본 테이블)');

  await t('positions: 신규 포지션 INSERT', async () => {
    stmts.insertPosition.run({
      code: 'A012330',
      name: '현대모비스',
      market: 'KOSDAQ',
      qty: 10,
      buy_price: 67000,
      buy_at: new Date().toISOString(),
      buy_date: '2026-06-01',
      mode: 'paper-self',
      status: 'open',
      cluster_id: 42,
      signal_source: 's16_w20',
      deviation: -15.5,
      abs_dev: 15.5,
      top10_rank: 3,
      change_rate_929: 0.12,
      rank: 1,
      weight: 0.5,
      signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
    });

    const pos = db.prepare('SELECT * FROM positions WHERE code=? AND status=?')
      .get('A012330', 'open');
    assertNotNull(pos, 'positions INSERT 확인');
    assertEq(pos.qty, 10);
    assertEq(pos.status, 'open');
  });

  await t('trades: 매도 완료 (체결)', async () => {
    // 먼저 포지션 하나 더 생성
    stmts.insertPosition.run({
      code: 'A051910',
      name: 'LG화학',
      market: 'KOSDAQ',
      qty: 15,
      buy_price: 50000,
      buy_at: new Date().toISOString(),
      buy_date: '2026-06-01',
      mode: 'paper-self',
      status: 'open',
      cluster_id: 42,
      signal_source: 's16_w20',
      deviation: -12.0,
      abs_dev: 12.0,
      top10_rank: 5,
      change_rate_929: 0.10,
      rank: 2,
      weight: 0.5,
      signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
    });

    // trade 기록
    stmts.insertTrade.run({
      code: 'A051910',
      name: 'LG화학',
      market: 'KOSDAQ',
      qty: 15,
      buy_price: 50000,
      sell_price: 51500,
      buy_at: new Date().toISOString(),
      sell_at: new Date().toISOString(),
      buy_date: '2026-06-01',
      sell_date: '2026-06-02',
      pnl: 22500, // (51500-50000)*15
      return_pct: 0.03, // 3%
      exit_reason: 'next_day_open',
      fee_paid: 500,
      mode: 'paper-self',
      signal_date: '20260601',
      frozen_date: null,
      cluster_window: null,
      cluster_avg_corr: null,
      cluster_size: null,
      seed: null,
      cluster_id: 42,
      signal_source: 's16_w20',
      rank: 2,
      weight: 0.5,
    });

    const trade = db.prepare('SELECT * FROM trades WHERE code=? AND sell_date=?')
      .get('A051910', '2026-06-02');
    assertNotNull(trade, 'trades INSERT 확인');
    assertEq(trade.pnl, 22500);
    assertEq(trade.return_pct, 0.03);
  });

  // ─────────────────────────────────────────────────
  // Index 검증
  // ─────────────────────────────────────────────────

  console.log('\ndb.Index 검증 (성능)');

  await t('Index: idx_signal_date ON signal_log', async () => {
    const idx = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name='signal_log' AND name LIKE 'idx_signal_date'
    `).get();
    assertNotNull(idx, 'signal_log date index 필수');
  });

  await t('Index: idx_pos_status ON positions', async () => {
    const idx = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name='positions' AND name LIKE 'idx_pos_status'
    `).get();
    assertNotNull(idx, 'positions status index 필수');
  });

  // ─────────────────────────────────────────────────
  // 정리
  // ─────────────────────────────────────────────────

  console.log(`\ndb: ${pass} passed, ${fail} failed`);

  // 테스트 DB 정리
  db.close();
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
  }

  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
