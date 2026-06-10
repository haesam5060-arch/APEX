// ═══════════════════════════════════════════════════════════════
// 그림자 추적 + guard_daily 통합 테스트 (APEX#9, 2026-06-10)
//   1) shadow_trades insert → open 조회 → close 라운드트립
//   2) guard_daily upsert (real/shadow) → regime-guard checkRegime 연동
//   3) 영구휴면 해소 시나리오: 음수 1표본 휴면 → 그림자 양수 누적 → 자동 재개
//   실행: APEX_DB_PATH=/tmp/test.db node tests/shadow-guard.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

process.env.APEX_DB_PATH = process.env.APEX_DB_PATH || `/tmp/apex_shadow_test_${process.pid}.db`;
const { db, stmts } = require('../src/db');
const rg = require('../src/regime-guard');
const fs = require('fs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
}
function cleanupHalt() { try { if (fs.existsSync(rg.HALT_FILE)) fs.unlinkSync(rg.HALT_FILE); } catch (e) {} }

console.log('\nshadow-guard: shadow_trades 라운드트립');

t('가상 진입 insert → open 조회 (signal_date < 오늘)', () => {
  db.prepare(`DELETE FROM shadow_trades`).run();
  stmts.insertShadowTrade.run({ signal_date: '20990101', code: '232140', lag_rank: 0, entry: 15000, created_at: 'T' });
  stmts.insertShadowTrade.run({ signal_date: '20990101', code: '095340', lag_rank: 1, entry: 20000, created_at: 'T' });
  const open = stmts.openShadowTrades.all('20990102');
  eq(open.length, 2);
  eq(open[0].status, 'open');
});

t('가상 청산 close → ret 기록 + open에서 제외', () => {
  const open = stmts.openShadowTrades.all('20990102');
  for (const sh of open) {
    const exitPx = sh.entry * 1.02;
    stmts.closeShadowTrade.run({ id: sh.id, exit: exitPx, ret: exitPx / sh.entry - 1 - 0.003, closed_at: 'T2' });
  }
  eq(stmts.openShadowTrades.all('20990102').length, 0);
  const closed = db.prepare(`SELECT * FROM shadow_trades WHERE status='closed'`).all();
  eq(closed.length, 2);
  if (Math.abs(closed[0].ret - 0.017) > 1e-9) throw new Error(`ret=${closed[0].ret}`);
});

console.log('\nshadow-guard: guard_daily + checkRegime 연동 (APEX#9 영구휴면 해소)');

t('음수 1표본 → L1 휴면 (백테 콜드스타트 정합)', () => {
  cleanupHalt();
  db.prepare(`DELETE FROM guard_daily`).run();
  stmts.upsertGuardDaily.run({ date: '20990101', r: -0.0035, kind: 'real' });
  const r = rg.checkRegime({ stmts });
  eq(r.canTrade, false);
  eq(r.dormant, true);
  eq(r.halted, false);
});

t('휴면 중 그림자 양수 누적 → 자동 재개 (구버전이면 영구휴면이던 시나리오)', () => {
  // 그림자 2일이 굴러 누적이 양수로 복귀
  stmts.upsertGuardDaily.run({ date: '20990102', r: +0.002, kind: 'shadow' });
  stmts.upsertGuardDaily.run({ date: '20990103', r: +0.004, kind: 'shadow' });
  const r = rg.checkRegime({ stmts });
  eq(r.canTrade, true, '누적 +0.25% ≥ 0 → 재개돼야');
  eq(r.layer, 'OK');
});

t('그림자 손실 지속이면 휴면 유지', () => {
  stmts.upsertGuardDaily.run({ date: '20990104', r: -0.05, kind: 'shadow' });
  const r = rg.checkRegime({ stmts });
  eq(r.dormant, true);
  cleanupHalt();
});

t('upsert — 같은 날짜 갱신 (shadow→real 승격)', () => {
  stmts.upsertGuardDaily.run({ date: '20990105', r: 0.01, kind: 'shadow' });
  stmts.upsertGuardDaily.run({ date: '20990105', r: 0.012, kind: 'real' });
  const row = db.prepare(`SELECT * FROM guard_daily WHERE date='20990105'`).get();
  eq(row.kind, 'real');
  if (Math.abs(row.r - 0.012) > 1e-9) throw new Error(`r=${row.r}`);
});

console.log('\nshadow-guard: laggard 픽 영속화 (APEX#11)');

t('insertLaggardPending → getLaggardPendings 복구 → consume', () => {
  db.prepare(`DELETE FROM pending_buy`).run();
  stmts.insertLaggardPending.run({
    signal_date: '20990101', rank: 1, weight: 1.0, pick_code: '232140', pick_name: '와이씨',
    pick_cluster_id: 65, pick_deviation: -32.5, pick_market: 'KOSDAQ', pick_buy: 15000,
    created_at: 'T', shadow: 1, pick_lag_rank: 0, pick_frozen_date: '20981231',
    pick_cluster_window: 20, pick_cluster_corr: 0.19, pick_cluster_size: 9,
    pick_seed: JSON.stringify([{ code: 'A036930', ret: 0.195 }]),
  });
  const rows = stmts.getLaggardPendings.all('20990101');
  eq(rows.length, 1);
  eq(rows[0].shadow, 1);
  eq(rows[0].pick_lag_rank, 0);
  eq(JSON.parse(rows[0].pick_seed)[0].code, 'A036930');
  stmts.consumeLaggardPendings.run('20990101');
  eq(stmts.getLaggardPendings.all('20990101').length, 0);
});

console.log(`\nshadow-guard: ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail > 0 ? 1 : 0);
