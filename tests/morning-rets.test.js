// ═══════════════════════════════════════════════════════════════
// 09:31 morning_rets 확정 수집 테스트 (APEX#8, 2026-06-10)
//   morning_change 테이블 stmts 라운드트립 + vi_ok 필터 의미
//   실행: APEX_DB_PATH=/tmp/test.db node tests/morning-rets.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

process.env.APEX_DB_PATH = process.env.APEX_DB_PATH || `/tmp/apex_morning_test_${process.pid}.db`;
const { stmts, db } = require('../src/db');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
}

console.log('\nmorning-rets: morning_change stmts');

const D = '20991231';

t('insert + byDate 라운드트립', () => {
  stmts.clearMorningChange.run(D);
  stmts.insertMorningChange.run({ signal_date: D, code: '232140', ret: 0.153, vi_ok: 1, first_open: 14000, last_close: 16140, polled_at: '2099-12-31T00:31:00Z' });
  stmts.insertMorningChange.run({ signal_date: D, code: '000020', ret: 0.021, vi_ok: 0, first_open: 1000, last_close: 1021, polled_at: '2099-12-31T00:31:00Z' });
  const rows = stmts.morningChangeByDate.all(D);
  eq(rows.length, 2);
});

t('vi_ok=1만 신호 입력으로 사용 (scheduler 로직 의미)', () => {
  const rows = stmts.morningChangeByDate.all(D);
  const m = {};
  for (const r of rows) if (r.vi_ok) m[r.code] = r.ret;
  eq(Object.keys(m), ['232140']);
  eq(m['232140'], 0.153);
});

t('INSERT OR REPLACE — 같은 (date,code) 갱신', () => {
  stmts.insertMorningChange.run({ signal_date: D, code: '232140', ret: 0.2, vi_ok: 1, first_open: null, last_close: null, polled_at: null });
  const rows = stmts.morningChangeByDate.all(D);
  eq(rows.length, 2);
  eq(rows.find(r => r.code === '232140').ret, 0.2);
});

t('clearMorningChange — 날짜 단위 삭제', () => {
  stmts.clearMorningChange.run(D);
  eq(stmts.morningChangeByDate.all(D).length, 0);
});

console.log(`\nmorning-rets: ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail > 0 ? 1 : 0);
