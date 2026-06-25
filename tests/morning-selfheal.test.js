// ═══════════════════════════════════════════════════════════════
// 09:31 모닝수집 self-heal 가드 테스트 (APEX#17, 2026-06-25)
//   node-cron 단일 fire 누락 대비 09:31~09:40 다중 fire + 멱등 가드.
//   가드 결정 입력 = _countMorningViOk(today) >= MORNING_MIN 이면 skip.
//   계기: 2026-06-25 09:31 미발화 → 14:30 레거시 폴백 발산(뉴인텍 @1,116 후보).
//   실행: node tests/morning-selfheal.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

process.env.APEX_DB_PATH = process.env.APEX_DB_PATH || `/tmp/apex_selfheal_test_${process.pid}.db`;
process.env.BUY_MODE = 'cluster_laggard_1430';  // real-broker hard-require 로드 회피 (laggard 테스트 관례)

const { _countMorningViOk, runMorningSnapshotJobGuarded, MORNING_MIN } = require('../src/scheduler');
const { db, stmts } = require('../src/db');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected=${b} got=${a}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

const D = '29991231';  // 실데이터와 충돌 없는 고정 테스트일
function seed(nViOk, nNotOk) {
  db.transaction(() => {
    stmts.clearMorningChange.run(D);
    for (let i = 0; i < nViOk; i++)
      stmts.insertMorningChange.run({ signal_date: D, code: `V${i}`, ret: 0.001 * i, vi_ok: 1, first_open: 100, last_close: 101, polled_at: 't' });
    for (let j = 0; j < nNotOk; j++)
      stmts.insertMorningChange.run({ signal_date: D, code: `N${j}`, ret: 0, vi_ok: 0, first_open: 100, last_close: 100, polled_at: 't' });
  })();
}

console.log('\nmorning-selfheal: 가드 결정 입력 (_countMorningViOk · MORNING_MIN)');

t('빈 수집 → 0', () => { seed(0, 0); eq(_countMorningViOk(D), 0); });

t('vi_ok 30건 → 30 (>= MORNING_MIN → 가드 skip)', () => {
  seed(30, 0);
  eq(_countMorningViOk(D), 30);
  assert(_countMorningViOk(D) >= MORNING_MIN, '30건인데 skip 임계 미달');
});

t('vi_ok=0 행은 미집계 (충분성은 vi_ok 기준)', () => { seed(0, 5); eq(_countMorningViOk(D), 0); });

t('혼합 20 vi_ok + 10 비vi_ok → 20 (< MORNING_MIN → 가드 수집 진행)', () => {
  seed(20, 10);
  eq(_countMorningViOk(D), 20);
  assert(_countMorningViOk(D) < MORNING_MIN, '20건인데 수집 진행 임계 초과');
});

t('경계: 29 → 수집 진행 / 30 → skip (14:30 신호 >=30과 동일)', () => {
  seed(29, 0); assert(_countMorningViOk(D) < MORNING_MIN, '29 < 30 위반');
  seed(30, 0); assert(_countMorningViOk(D) >= MORNING_MIN, '30 >= 30 위반');
});

t('MORNING_MIN 기본 30 (14:30 신호 충분성 임계와 공용)', () => { eq(MORNING_MIN, 30); });

t('재집계 멱등 — 같은 날 재시드 후에도 정확 (clear+재삽입)', () => {
  seed(40, 5); eq(_countMorningViOk(D), 40);
  seed(10, 0); eq(_countMorningViOk(D), 10);  // 이전분 잔존 없이 갱신
});

t('runMorningSnapshotJobGuarded 익스포트 (async 래퍼)', () => {
  assert(typeof runMorningSnapshotJobGuarded === 'function', '가드 래퍼 미익스포트');
});

t('카운트 오류 시 0 폴백 (잘못된 인자도 throw 안 함)', () => {
  // morningChangeByDate가 빈 결과/이상 인자에도 throw 없이 0
  eq(_countMorningViOk('00000000'), 0);
});

console.log(`\nmorning-selfheal: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
