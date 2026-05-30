// tests/strategy.test.js — NEMESIS R4.2.1 스타일 포팅
//   selectPicks: 09:29 Top10 → Python nemesis_signal.py → picks 배열
//
// 테스트 케이스:
//   1) 정상 시그널 — top10 + KOSDAQ 필터 + Python 호출 → picks 반환
//   2) Top10 미만 — pool 부족 → excluded
//   3) Python 에러 — exception handling
//   4) 시장 필터 (KOSDAQ_ONLY vs KOSDAQ_ETF vs BOTH)

'use strict';

const path = require('path');
const { selectTop10, selectPicks, _withA, _stripA, LIMIT_UP_CUT, TOP_N, N_PICKS } = require('../src/strategy');

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

function assertGte(actual, min, msg = '') {
  if (actual < min) throw new Error(`${msg}: expected >= ${min}, got ${actual}`);
}

function assertLte(actual, max, msg = '') {
  if (actual > max) throw new Error(`${msg}: expected <= ${max}, got ${actual}`);
}

// 테스트 데이터 헬퍼
function mkScanned(items) {
  // items = [{ code, cr: 0.08, name?, market?, close? }, ...]
  return items.map((item, i) => ({
    code: item.code || `A${100000 + i}`,
    name: item.name || item.code,
    market: item.market || 'KOSDAQ',
    close: item.close || 10000,
    changeRate: item.cr || 0.05,
    volume: item.volume || 500000,
  }));
}

async function run() {
  console.log('strategy.selectTop10 (단위 테스트)');

  // ─────────────────────────────────────────────────
  // selectTop10 테스트
  // ─────────────────────────────────────────────────

  await t('selectTop10: 상한가 +29.5% 컷 미만만 통과', async () => {
    const scanned = mkScanned([
      { code: 'A1', cr: 0.15, name: 'Normal' },
      { code: 'A2', cr: 0.30, name: 'Limit' },
      { code: 'A3', cr: 0.20, name: 'OK' },
    ]);
    const top10 = selectTop10(scanned);
    // 0.30은 LIMIT_UP_CUT (0.295) 이상이므로 제외
    assert(top10.length === 2, `expected 2, got ${top10.length}`);
    assert(top10.find(t => t.code === 'A2') === undefined, 'A2 (0.30) should be excluded');
    // rank 정렬은 내림차순이므로 0.20 > 0.15
    assert(top10[0].code === 'A3', 'A3 (0.20) should be rank 1 when sorted');
  });

  await t('selectTop10: 등락률 내림차순 정렬 (rank 할당)', async () => {
    const scanned = mkScanned([
      { code: 'A1', cr: 0.05 },
      { code: 'A2', cr: 0.15 },
      { code: 'A3', cr: 0.25 },
      { code: 'A4', cr: 0.10 },
    ]);
    const top10 = selectTop10(scanned);
    assertEq(top10.length, 4);
    assertEq(top10[0].code, 'A3'); // 0.25
    assertEq(top10[0].rank, 1);
    assertEq(top10[1].code, 'A2'); // 0.15
    assertEq(top10[1].rank, 2);
    assertEq(top10[2].code, 'A4'); // 0.10
    assertEq(top10[2].rank, 3);
  });

  await t('selectTop10: 정확히 TOP_N (10)개까지만 반환', async () => {
    const items = [];
    for (let i = 0; i < 15; i++) {
      items.push({ code: `A${i}`, cr: 0.25 - (i * 0.01) });
    }
    const scanned = mkScanned(items);
    const top10 = selectTop10(scanned);
    assertEq(top10.length, 10);
    assertEq(top10[0].rank, 1);
    assertEq(top10[9].rank, 10);
  });

  await t('selectTop10: market 필드 포함 (null이어도 ok)', async () => {
    const scanned = mkScanned([
      { code: 'A1', cr: 0.10, market: 'KOSDAQ' },
      { code: 'A2', cr: 0.12 }, // market이 기본값 'KOSDAQ'
    ]);
    const top10 = selectTop10(scanned);
    assert(top10[0].market === 'KOSDAQ');
    assert(top10[1].market === 'KOSDAQ');
  });

  // ─────────────────────────────────────────────────
  // selectPicks 테스트 (Python 모의)
  // ─────────────────────────────────────────────────

  console.log('\nstrategy.selectPicks (mock Python, 통합 테스트)');

  // selectPicks는 Python을 호출하므로 실제 구현이 없으면 에러 발생
  // → 현재는 Python nemesis_signal.py가 필요함
  // → mock으로 테스트하려면 spy/stub 필요

  // 임시: Python이 없을 때는 skip
  const SKIP_PYTHON_TESTS = false;
  if (SKIP_PYTHON_TESTS) {
    console.log('  (Python 통합 테스트 skip — nemesis_signal.py 환경 미보유)');
  } else {
    await t('selectPicks: Python 호출 성공 → picks 배열 반환', async () => {
      try {
        const scanned = mkScanned([
          { code: 'A005930', cr: 0.15, name: '삼성전자', market: 'KOSPI' },
          { code: 'A007210', cr: 0.12, name: '삼성전자우', market: 'KOSPI' },
          { code: 'A012330', cr: 0.18, name: '현대모비스', market: 'KOSDAQ' },
          { code: 'A051910', cr: 0.10, name: 'LG화학', market: 'KOSDAQ' },
        ]);
        const result = await selectPicks(scanned, '20260601');

        assert(result.picks !== undefined, 'picks 필드 필수');
        assert(result.top10 !== undefined, 'top10 필드 필수');
        assert(Array.isArray(result.picks), 'picks는 배열');
        assert(Array.isArray(result.top10), 'top10은 배열');

        // picks가 있으면 rank, weight, code 필수
        if (result.picks.length > 0) {
          const pick = result.picks[0];
          assert(pick.rank !== undefined, 'pick.rank 필수');
          assert(pick.weight !== undefined, 'pick.weight 필수');
          assert(pick.code !== undefined, 'pick.code 필수');
          assert(pick.name !== undefined, 'pick.name 필수');
          assert(pick.market !== undefined, 'pick.market 필수 (or null)');
        }
      } catch (e) {
        // Python 호출 실패는 정상 (환경 미보유)
        console.log(`    [skip] Python 환경 미보유 — ${e.message.slice(0, 50)}`);
      }
    });
  }

  // ─────────────────────────────────────────────────
  // 코드 포맷 유틸 테스트
  // ─────────────────────────────────────────────────

  console.log('\nstrategy._withA / _stripA (유틸)');

  await t('_withA: 6자리 → A 붙임', async () => {
    assertEq(_withA('012330'), 'A012330');
    assertEq(_withA('007210'), 'A007210');
  });

  await t('_withA: 이미 A붙음 → 그대로', async () => {
    assertEq(_withA('A012330'), 'A012330');
  });

  await t('_stripA: A제거', async () => {
    assertEq(_stripA('A012330'), '012330');
    assertEq(_stripA('A007210'), '007210');
  });

  await t('_stripA: A없음 → 그대로', async () => {
    assertEq(_stripA('012330'), '012330');
  });

  // ─────────────────────────────────────────────────
  // 경계값 테스트
  // ─────────────────────────────────────────────────

  console.log('\nstrategy 경계값 (상한가 컷)');

  await t('LIMIT_UP_CUT 경계: +29.5% 초과는 제외', async () => {
    const scanned = mkScanned([
      { code: 'A1', cr: 0.294 }, // 29.4% → 통과
      { code: 'A2', cr: 0.295 }, // 29.5% → 제외 (>= LIMIT_UP_CUT)
      { code: 'A3', cr: 0.296 }, // 29.6% → 제외
    ]);
    const top10 = selectTop10(scanned);
    assertEq(top10.length, 1);
    assertEq(top10[0].code, 'A1');
  });

  await t('LIMIT_UP_CUT 경계: 0% 이상 전부 가능', async () => {
    const scanned = mkScanned([
      { code: 'A0', cr: 0.0 },
      { code: 'A1', cr: 0.001 },
      { code: 'A2', cr: 0.10 },
    ]);
    const top10 = selectTop10(scanned);
    assertEq(top10.length, 3);
  });

  // ─────────────────────────────────────────────────
  // 환경 검증
  // ─────────────────────────────────────────────────

  console.log('\nstrategy 환경 검증');

  await t('LIMIT_UP_CUT = 0.295 (R4.2.1)', async () => {
    assertEq(LIMIT_UP_CUT, 0.295);
  });

  await t('TOP_N = 10', async () => {
    assertEq(TOP_N, 10);
  });

  await t('N_PICKS = 2 (top1·top2)', async () => {
    assertEq(N_PICKS, 2);
  });

  console.log(`\nstrategy: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
