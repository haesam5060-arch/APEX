// ═══════════════════════════════════════════════════════════════
// 당일 확정 시초가 선택 테스트 (APEX#18, 2026-07-04)
//   _selectTodayOpen — "당일자 & open>0"만 채택, 전일 종가 폴백 금지.
//   버그 재현: 09:00 직후 open=null이면 예전엔 close(전일종가)로 폴백 → 시가 +2~4.8% 뻥튀김.
//   실행: node tests/opening-price.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { _selectTodayOpen } = require('../src/stock-fetcher');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
}

const TODAY = '2026-07-02';

console.log('\nopening-price: 당일 확정 시초가만 채택');

t('당일자 & open>0 → 채택 (basic 우선)', () => {
  const r = _selectTodayOpen([
    { open: 12100, date: '2026-07-02T09:00:10+09:00', source: 'basic' },
    { open: 12100, date: '2026-07-02', source: 'price' },
  ], TODAY);
  eq(r, { open: 12100, source: 'basic' });
});

t('basic open=null(미갱신) → 다음 후보(일봉 당일) 채택', () => {
  const r = _selectTodayOpen([
    { open: 0, date: '2026-07-02T09:00:05+09:00', source: 'basic' },
    { open: 12100, date: '2026-07-02', source: 'price' },
  ], TODAY);
  eq(r, { open: 12100, source: 'price' });
});

t('★버그방지: open=null인데 date가 전일이면 절대 채택 안 함 (stale 폴백 금지)', () => {
  // 예전 close 폴백이 잡던 12,550(전일종가) 시나리오 — date가 어제라 전부 거부
  const r = _selectTodayOpen([
    { open: 0,     date: '2026-07-01T16:10:00+09:00', source: 'basic' },
    { open: 12350, date: '2026-07-01', source: 'price' }, // 전일 캔들 open — 거부돼야 함
  ], TODAY);
  eq(r, null);
});

t('open>0이어도 date가 전일이면 거부 (data[0]가 아직 어제 캔들)', () => {
  const r = _selectTodayOpen([
    { open: 12550, date: '2026-07-01', source: 'price' },
  ], TODAY);
  eq(r, null);
});

t('후보 전무 → null', () => {
  eq(_selectTodayOpen([], TODAY), null);
  eq(_selectTodayOpen([null, undefined], TODAY), null);
});

t('open 음수/0 방어', () => {
  eq(_selectTodayOpen([{ open: -1, date: '2026-07-02', source: 'basic' }], TODAY), null);
});

console.log(`\nopening-price: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
