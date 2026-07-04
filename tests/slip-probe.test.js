// ═══════════════════════════════════════════════════════════════
// 슬리피지 프로브 테스트 (APEX#18, 2026-07-04)
//   estimateFillPrice(매수)·estimateSellFill(매도) 호가 소진 + slippage_probe 왕복 완성.
//   실행: APEX_DB_PATH=/tmp/x node tests/slip-probe.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

process.env.APEX_DB_PATH = process.env.APEX_DB_PATH || `/tmp/apex_slipprobe_test_${process.pid}.db`;
process.env.BUY_MODE = 'cluster_laggard_1430';

const { estimateFillPrice, estimateSellFill } = require('../src/stock-fetcher');
const { db, stmts } = require('../src/db');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
}

// 호가: best ask 10,000(잔량10) → 10,050(20) → 10,100(30)
const ASKS = [{ price: 10000, qty: 10 }, { price: 10050, qty: 20 }, { price: 10100, qty: 30 }];
// bid: best 9,950(15) → 9,900(20) → 9,850(30)
const BIDS = [{ price: 9950, qty: 15 }, { price: 9900, qty: 20 }, { price: 9850, qty: 30 }];

console.log('\nslip-probe: 매수 호가 소진 (estimateFillPrice)');
t('소액(1주)이면 best_ask 그대로', () => {
  eq(estimateFillPrice(ASKS, 10000), 10000);
});
t('best_ask 잔량 초과 시 다음 호가로 walk-up (VWAP↑)', () => {
  // 30만원 → 10,000×10=10만, 남20만 → 10,050×19=190,950 … 총 29주 근사
  const est = estimateFillPrice(ASKS, 300000);
  if (!(est > 10000 && est < 10100)) throw new Error(`walk-up VWAP 범위 밖: ${est}`);
});
t('빈 호가 → null', () => { eq(estimateFillPrice([], 100000), null); });

console.log('\nslip-probe: 매도 호가 소진 (estimateSellFill)');
t('잔량 내 매도는 best_bid', () => { eq(estimateSellFill(BIDS, 10), 9950); });
t('best_bid 잔량 초과 시 walk-down (VWAP↓)', () => {
  const est = estimateSellFill(BIDS, 30); // 15@9950 + 15@9900
  eq(est, Math.round((15 * 9950 + 15 * 9900) / 30));
});
t('qty=0 / 빈 bid → null', () => {
  eq(estimateSellFill(BIDS, 0), null);
  eq(estimateSellFill([], 5), null);
});

console.log('\nslip-probe: slippage_probe 왕복 완성 (insert→update, 게이트 math)');
t('buy_only 적재 → sell 완성 → roundtrip = buy_slip − sell_slip, status=complete', () => {
  const date = '20260702', code = '999999';
  db.prepare(`DELETE FROM slippage_probe WHERE date=? AND code=?`).run(date, code);
  stmts.insertSlippageBuy.run({
    date, code, name: '테스트', ref_price: 10000, best_ask: 10000, est_fill_price: 10012,
    order_amount: 100000, buy_slip_bps: 12.0, ask_depth_json: '[]',
    bought_at: '2026-07-01T05:50:00Z',
  });
  const buyRow = stmts.getSlippageAll.all().find(r => r.date === date && r.code === code);
  eq(buyRow.status, 'buy_only');
  eq(buyRow.buy_slip_bps, 12.0);

  // 매도: est_sell 9,992 vs sell_open 10,000 → sell_slip -8bp → roundtrip 12-(-8)=20
  const sellSlip = -8.0;
  const roundtrip = Math.round((buyRow.buy_slip_bps - sellSlip) * 100) / 100;
  stmts.updateSlippageSell.run({
    date, code, buy_price: 10000, sell_open: 10000,
    sell_slip_bps: sellSlip, roundtrip_bps: roundtrip, sold_at: '2026-07-02T00:00:30Z',
  });
  const done = stmts.getSlippageAll.all().find(r => r.date === date && r.code === code);
  eq(done.status, 'complete');
  eq(done.roundtrip_bps, 20.0, '왕복 = 매수12 + 매도8 비용');
});

console.log(`\nslip-probe: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
