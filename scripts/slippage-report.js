#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// slippage-report.js — 슬리피지 로그 요약 (실왕복비용 측정용)
//
// 목적: T+1 래치위험·T+2 채택 결정의 입력인 "실제 왕복 슬리피지" 추정.
//
// 주의(정직):
//   - paper-self 모드: ref=fill(폴가)이라 slip_bp≈0 (집행 슬립 측정 불가).
//     → 실집행 슬립은 KIS(paper/real) 모드 필요. real-broker.js + KIS 키 선결.
//   - paper-self에서도 fill_price+ts는 기록됨 → backtest parquet과 교차검증하면
//     "데이터/타이밍 슬립(네이버 폴 vs parquet 14:50/T+1시초)"은 측정 가능(별도).
//
// 실행: node scripts/slippage-report.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { stmts } = require('../src/db');

function pct(arr) {
  if (!arr.length) return { n: 0, mean: null, median: null };
  const s = arr.slice().sort((a, b) => a - b);
  const mean = arr.reduce((x, y) => x + y, 0) / arr.length;
  const median = s[Math.floor(s.length / 2)];
  return { n: arr.length, mean: Math.round(mean * 100) / 100, median: Math.round(median * 100) / 100 };
}

function main() {
  const rows = stmts.recentSlippage.all(5000) || [];
  if (rows.length === 0) {
    console.log('슬리피지 로그 없음 — 아직 거래 미발생(또는 엔진 미가동).');
    console.log('paper-self로 매매가 쌓이면 fill_price가 기록됨. 실집행 슬립은 KIS 모드 필요.');
    return;
  }
  const byMode = {};
  for (const r of rows) (byMode[r.mode] ||= []).push(r);

  console.log(`=== 슬리피지 로그 요약 (총 ${rows.length}건, ${rows[rows.length - 1].ts.slice(0, 10)}~${rows[0].ts.slice(0, 10)}) ===\n`);
  for (const [mode, rs] of Object.entries(byMode)) {
    const buys = rs.filter(r => r.side === 'buy').map(r => r.slip_bp);
    const sells = rs.filter(r => r.side === 'sell').map(r => r.slip_bp);
    const b = pct(buys), s = pct(sells);
    // 왕복 불리 비용(bp) ≈ 매수슬립(양수=불리) - 매도슬립(음수=불리)
    const rtMean = (b.mean != null && s.mean != null) ? Math.round((b.mean - s.mean) * 100) / 100 : null;
    console.log(`[${mode}] 매수 ${b.n}건 (slip 중앙 ${b.median}bp/평균 ${b.mean}bp) | 매도 ${s.n}건 (중앙 ${s.median}bp/평균 ${s.mean}bp)`);
    if (rtMean != null) console.log(`   → 왕복 실슬립 추정 ${rtMean}bp (= ${(rtMean / 100).toFixed(2)}%)  [백테 가정 0.30%=30bp와 비교]`);
    if (mode === 'paper-self') console.log('   ※ paper-self는 slip≈0(설계상). KIS 모드라야 실집행 슬립 측정.');
    console.log('');
  }
  console.log('판정 가이드: 왕복 실슬립 ≤30bp(0.3%) → 현행 T+1 안전·T+2 불필요 / ~50bp(0.5%) → T+1 래치위험 실재 → T+2 디레버 재검토.');
}

main();
