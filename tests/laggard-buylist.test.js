// ═══════════════════════════════════════════════════════════════
// 14:50 매수 후보 확정 테스트 (APEX#7, 2026-06-10)
//   selectLaggardBuyList — 가격필터 경계 · 상한가잠김 · lag_rank 순서 · cap
//   백테(aprev2b) 필터와 동일 의미론 검증.
//   실행: APEX_DB_PATH=/tmp/test.db node tests/laggard-buylist.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

process.env.APEX_DB_PATH = process.env.APEX_DB_PATH || `/tmp/apex_buylist_test_${process.pid}.db`;
process.env.BUY_MODE = 'cluster_laggard_1430';  // dynamic-buyer(real-broker hard-require) 로드 회피
const { selectLaggardBuyList } = require('../src/scheduler');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
}

const OPTS = { lo: 10000, hi: 50000, cap: 2, limitTol: 0.995 };

console.log('\nlaggard-buylist: 가격필터 (양끝 포함 — 백테 PRICE_LO<=e<=PRICE_HI 동일)');

t('경계값: 9,999 제외 / 10,000·50,000 포함 / 50,001 제외', () => {
  const picks = [
    { code: 'A1', lag_rank: 0 }, { code: 'B2', lag_rank: 1 },
    { code: 'C3', lag_rank: 2 }, { code: 'D4', lag_rank: 3 },
  ];
  const px = { A1: 9999, B2: 10000, C3: 50000, D4: 50001 };
  const { buyList, skipped } = selectLaggardBuyList(picks, px, {}, OPTS);
  eq(buyList.map(p => p.code), ['B2', 'C3']);
  eq(skipped.map(s => s.code), ['A1']);  // D4는 cap2 도달로 평가 전 종료
});

t('폴가 없으면 14:30 참고가(buy) 폴백', () => {
  const picks = [{ code: 'A1', lag_rank: 0, buy: 15000 }];
  const { buyList } = selectLaggardBuyList(picks, {}, {}, OPTS);
  eq(buyList[0].entry, 15000);
});

console.log('\nlaggard-buylist: 상한가잠김 가드 (APEX#7 — round(pc×1.30)×0.995)');

t('상한가 잠김 — 진입가 ≥ 상한가×0.995 skip', () => {
  // prevClose 10,000 → 상한가 13,000, 컷 12,935
  const picks = [{ code: 'A1', lag_rank: 0 }, { code: 'B2', lag_rank: 1 }];
  const px = { A1: 12935, B2: 12934 };
  const pc = { A1: 10000, B2: 10000 };
  const { buyList, skipped } = selectLaggardBuyList(picks, px, pc, OPTS);
  eq(buyList.map(p => p.code), ['B2']);
  eq(skipped.length, 1);
  if (!skipped[0].reason.includes('상한가잠김')) throw new Error('사유 표기 누락');
});

t('prevClose 없으면 상한가 가드 생략 (백테 `if pc and ...` 동일 — fail-open)', () => {
  const picks = [{ code: 'A1', lag_rank: 0 }];
  const { buyList } = selectLaggardBuyList(picks, { A1: 49000 }, {}, OPTS);
  eq(buyList.map(p => p.code), ['A1']);
});

console.log('\nlaggard-buylist: lag_rank 순서·cap');

t('lag_rank 오름차순 정렬 후 cap2 (필터 통과분만)', () => {
  const picks = [
    { code: 'C3', lag_rank: 2 }, { code: 'A1', lag_rank: 0 }, { code: 'B2', lag_rank: 1 },
  ];
  const px = { A1: 9000, B2: 20000, C3: 30000 };  // lag0은 가격필터 탈락
  const { buyList } = selectLaggardBuyList(picks, px, {}, OPTS);
  eq(buyList.map(p => p.code), ['B2', 'C3']);  // 다음 순위가 승계 (백테 head(CAP) 동일)
});

t('cap=1이면 최저 lag_rank 1종목만', () => {
  const picks = [{ code: 'A1', lag_rank: 0 }, { code: 'B2', lag_rank: 1 }];
  const { buyList } = selectLaggardBuyList(picks, { A1: 20000, B2: 20000 }, {}, { ...OPTS, cap: 1 });
  eq(buyList.map(p => p.code), ['A1']);
});

console.log(`\nlaggard-buylist: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
