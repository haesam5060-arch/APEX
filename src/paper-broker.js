// ═══════════════════════════════════════════════════════════════
// APEX paper-broker — paper-self 모드 매매 시뮬
//
// APEX 전략 특성:
//   - 14:50 매수, T+1 09:01 시초가 매도
//   - 손절/익절 없음
//   - positions 스키마: cluster_strength / change_rate / snapshot_930_price / cluster_top
// ═══════════════════════════════════════════════════════════════

'use strict';

const { db, log, stmts } = require('./db');

function todayKstDate() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function initPaperBalance(initialCapital) {
  stmts.initPaperBalance.run(initialCapital, initialCapital);
}

function getPaperBalance() {
  return stmts.getPaperBalance.get();
}

function _addPaperCash(delta) {
  const cur = getPaperBalance();
  if (!cur) return;
  stmts.updatePaperCash.run(cur.cash + delta);
}

/**
 * openPosition(pick, budget)
 *
 * @param {object} pick - { code, name, market, buy, rank, weight, cluster_id, signal_source, deviation, abs_dev }
 * @param {number} budget - 이 종목에 배정된 자본 (scheduler에서 totalCapital * weight로 계산해서 전달)
 *
 * scheduler.js에서: const budget = totalCapital * weight (예: 200k * 0.5 = 100k)
 */
function openPosition(pick, budget) {
  if (!pick) return null;

  const buyAt   = new Date().toISOString();
  const buyDate = todayKstDate();
  const qty     = Math.max(1, Math.floor(budget / pick.buy));

  const row = {
    code:               pick.code,
    name:               pick.name,
    market:             pick.market || 'KOSDAQ',
    qty,
    buy_price:          pick.buy,
    buy_at:             buyAt,
    buy_date:           buyDate,
    mode:               'paper-self',
    // R4.2.1 포팅: cluster_strength 대신 spectral cluster 속성 저장
    cluster_id:         pick.cluster_id ?? null,
    cluster_size:       pick.cluster_size ?? null,
    signal_source:      pick.signal_source || null,
    deviation:          pick.deviation ?? null,
    abs_dev:            pick.abs_dev ?? null,
  };

  let opened = null;
  db.transaction(() => {
    const info = stmts.insertPosition.run(row);
    _addPaperCash(-(qty * pick.buy));
    opened = { ...row, id: info.lastInsertRowid };
  })();

  log.info('BROKER',
    `매수 (paper-self) ${opened.name}(${opened.code}) ${opened.qty}주 @ ${opened.buy_price.toLocaleString()}원 ` +
    `[rank=${pick.rank}, sig=${pick.signal_source}, dev=${(pick.deviation ?? 0).toFixed(2)}]`);

  return opened;
}

/**
 * closePosition(pos, sellPrice, feeRoundTripPct, exitReason)
 *
 * T+1 09:01 시초가 매도 시뮬
 */
function closePosition(pos, sellPrice, feeRoundTripPct = 0.0035, exitReason = 'next_day_open') {
  const sellAt   = new Date().toISOString();
  const sellDate = todayKstDate();

  const grossPnl  = (sellPrice - pos.buy_price) * pos.qty;
  const fee       = Math.round((pos.buy_price + sellPrice) * pos.qty * feeRoundTripPct / 2);
  const pnl       = grossPnl - fee;
  const returnPct = sellPrice / pos.buy_price - 1 - feeRoundTripPct;

  db.transaction(() => {
    stmts.insertTrade.run({
      code:             pos.code,
      name:             pos.name,
      market:           pos.market || 'KOSDAQ',
      qty:              pos.qty,
      buy_price:        pos.buy_price,
      sell_price:       sellPrice,
      buy_at:           pos.buy_at,
      sell_at:          sellAt,
      buy_date:         pos.buy_date,
      sell_date:        sellDate,
      pnl,
      return_pct:       returnPct,
      exit_reason:      exitReason,
      fee_paid:         fee,
      mode:             'paper-self',
      cluster_strength: pos.cluster_strength ?? null,
      change_rate:      pos.change_rate       ?? null,
    });
    stmts.closePosition.run(pos.id);
    _addPaperCash(sellPrice * pos.qty - fee);
  })();

  log.info('BROKER',
    `매도 (paper-self) ${pos.name}(${pos.code}) ${pos.qty}주 @ ${sellPrice.toLocaleString()}원 ` +
    `[PnL ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}원 (${(returnPct * 100).toFixed(2)}%) reason=${exitReason}]`);

  return { ...pos, sell_price: sellPrice, pnl, return_pct: returnPct, exit_reason: exitReason };
}

function getOpenPositions() {
  return stmts.getOpenPositions.all();
}

module.exports = {
  openPosition,
  closePosition,
  getOpenPositions,
  initPaperBalance,
  getPaperBalance,
};
