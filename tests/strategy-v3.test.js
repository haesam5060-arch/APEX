// tests/strategy-v3.test.js — selectCandidatesV3 (ap12 채택) 단위 테스트
'use strict';
const assert = require('assert');
const { selectCandidatesV3 } = require('../src/strategy');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function snaps(obj) {
  const m = new Map();
  for (const [c, p] of Object.entries(obj)) m.set(c, { price_930: p, change_rate_930: 0.03 });
  return m;
}
function clMap(obj) {
  const m = new Map();
  for (const [c, cid] of Object.entries(obj)) m.set(c, cid);
  return m;
}

console.log('strategy.selectCandidatesV3 (V3 — leader + cluster laggard)');

// V3 정상: leader cr 12%, laggard cr 6% (같은 cluster 0)
t('leader 1 + 같은 cluster laggard 1 반환', () => {
  const scanned = [
    { code: 'A1', name: 'lead', market: 'KOSDAQ', close: 11200, changeRate: 0.12, volume: 200000 },
    { code: 'A2', name: 'lag',  market: 'KOSDAQ', close: 10600, changeRate: 0.06, volume: 200000 },
    { code: 'A3', name: 'oth',  market: 'KOSDAQ', close: 10600, changeRate: 0.06, volume: 200000 },
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000, A2: 10000, A3: 10000 }),
                                    clMap({ A1: 0, A2: 0, A3: 5 }));
  assert.strictEqual(picks.length, 2);
  assert.strictEqual(picks[0].code, 'A1');
  assert.strictEqual(picks[0].role, 'leader');
  assert.strictEqual(picks[1].code, 'A2');
  assert.strictEqual(picks[1].role, 'laggard');
});

// clusters null → V0 fallback (leader Top2)
t('clusters null이면 V0 fallback (leader Top2)', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSDAQ', close: 11200, changeRate: 0.12, volume: 200000 },
    { code: 'A2', name: 'b', market: 'KOSDAQ', close: 10800, changeRate: 0.08, volume: 200000 },
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000, A2: 10000 }), null);
  assert.strictEqual(picks.length, 2);
  assert.strictEqual(picks[0].role, 'leader');
  assert.strictEqual(picks[1].role, 'leader');
});

// leader cluster_id 모르면 V0 fallback
t('leader가 cluster 매핑 없으면 V0 fallback', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSDAQ', close: 11200, changeRate: 0.12, volume: 200000 },
    { code: 'A2', name: 'b', market: 'KOSDAQ', close: 10800, changeRate: 0.08, volume: 200000 },
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000, A2: 10000 }),
                                    clMap({ A2: 5 }));   // A1 미매핑
  assert.strictEqual(picks.length, 2);
  assert.strictEqual(picks[0].code, 'A1');
  assert.strictEqual(picks[1].role, 'leader');   // fallback
});

// 같은 cluster에 laggard 후보 없으면 leader 단독
t('cluster내 laggard 없으면 leader 단독', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSDAQ', close: 11200, changeRate: 0.12, volume: 200000 },
    { code: 'A2', name: 'b', market: 'KOSDAQ', close: 10800, changeRate: 0.08, volume: 200000 },  // 다른 cluster
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000, A2: 10000 }),
                                    clMap({ A1: 0, A2: 5 }));
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].code, 'A1');
});

// Laggard cr 범위 벗어나면 후보 안 됨
t('laggard cr 9% (3~8% 밖)는 후보 제외', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSDAQ', close: 11200, changeRate: 0.12, volume: 200000 },
    { code: 'A2', name: 'b', market: 'KOSDAQ', close: 10900, changeRate: 0.09, volume: 200000 },  // 9% (out)
    { code: 'A3', name: 'c', market: 'KOSDAQ', close: 10500, changeRate: 0.05, volume: 200000 },  // 5% (in)
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000, A2: 10000, A3: 10000 }),
                                    clMap({ A1: 0, A2: 0, A3: 0 }));
  assert.strictEqual(picks.length, 2);
  assert.strictEqual(picks[1].code, 'A3');   // A2 9% 제외, A3 5%만 후보
});

// Laggard cs < 0.97 제외 (오전 대비 너무 빠진 종목)
t('laggard cs<0.97 (오전 대비 약세) 제외', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSDAQ', close: 11200, changeRate: 0.12, volume: 200000 },
    { code: 'A2', name: 'b', market: 'KOSDAQ', close: 10500, changeRate: 0.05, volume: 200000 },
  ];
  // A2 price_930 = 11000 → cs = 10500/11000 = 0.955 < 0.97
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000, A2: 11000 }),
                                    clMap({ A1: 0, A2: 0 }));
  assert.strictEqual(picks.length, 1);   // leader만
});

// 자기 자신은 laggard 후보 안 됨
t('leader 자기 자신은 laggard로 안 들어감', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSDAQ', close: 10600, changeRate: 0.06, volume: 200000 },
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000 }),
                                    clMap({ A1: 0 }));
  // A1 cr 6%인데 leader 게이트 cr>=5% 통과. leader가 됨. laggard 후보 0
  // → leader 단독 반환
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].code, 'A1');
  assert.strictEqual(picks[0].role, 'leader');
});

// KOSPI는 leader/laggard 모두 제외
t('KOSPI 종목은 V3에서도 제외', () => {
  const scanned = [
    { code: 'A1', name: 'a', market: 'KOSPI', close: 11200, changeRate: 0.12, volume: 200000 },
  ];
  const picks = selectCandidatesV3(scanned, snaps({ A1: 10000 }), clMap({ A1: 0 }));
  assert.strictEqual(picks.length, 0);
});

console.log(`\nstrategy-v3: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
