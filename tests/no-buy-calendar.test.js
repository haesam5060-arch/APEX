// APEX — 매수 금지 캘린더 단위 테스트
'use strict';

const { isBuyBlocked, BLOCK_DATES } = require('../src/no-buy-calendar');

const tests = [];

function test(name, fn) {
  try { fn(); tests.push({ name, ok: true }); }
  catch (e) { tests.push({ name, ok: false, error: e.message }); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── 차단일 테스트 ──
test('분기말 (2026Q1 = 2026-03-31) 차단', () => {
  const r = isBuyBlocked('20260331');
  assert(r.blocked === true, 'blocked=true 여야 함');
  assert(r.reason === 'quarter_end', `reason=quarter_end (실제: ${r.reason})`);
});

test('2026 배당락일 (12-29) 차단', () => {
  const r = isBuyBlocked('20261229');
  assert(r.blocked === true, 'blocked=true 여야 함');
  assert(r.reason === 'ex_dividend', `reason=ex_dividend (실제: ${r.reason})`);
});

test('2026 연말 폐장 (12-30) 차단', () => {
  const r = isBuyBlocked('20261230');
  assert(r.blocked === true, 'blocked=true 여야 함');
  assert(r.reason === 'quarter_end', `reason=quarter_end (실제: ${r.reason})`);
});

// ── 평상일 통과 테스트 ──
test('평상일 (2026-05-15) 통과', () => {
  const r = isBuyBlocked('20260515');
  assert(r.blocked === false, `blocked=false 여야 함 (실제: ${r.blocked})`);
});

test('평상일 (2026-10-01) 통과', () => {
  const r = isBuyBlocked('20261001');
  assert(r.blocked === false, `blocked=false 여야 함`);
});

// ── BLOCK_DATES 일관성 ──
test('BLOCK_DATES 2026년 5개 날짜 존재', () => {
  const expected2026 = ['20260331', '20260630', '20260930', '20261229', '20261230'];
  for (const k of expected2026) {
    assert(BLOCK_DATES[k] !== undefined, `BLOCK_DATES[${k}] 누락`);
  }
});

test('BLOCK_DATES 2027년 5개 날짜 존재', () => {
  const expected2027 = ['20270331', '20270630', '20270930', '20271229', '20271230'];
  for (const k of expected2027) {
    assert(BLOCK_DATES[k] !== undefined, `BLOCK_DATES[${k}] 누락`);
  }
});

test('isBuyBlocked 반환값에 date 필드 포함', () => {
  const blocked = isBuyBlocked('20260331');
  assert(blocked.date === '20260331', `date 필드 불일치 (실제: ${blocked.date})`);
  const free = isBuyBlocked('20260601');
  assert(free.date === '20260601', `date 필드 불일치 (실제: ${free.date})`);
});

test('매도는 차단 안 됨 — isBuyBlocked는 매수만 차단 (설명 검증)', () => {
  // 이 테스트는 isBuyBlocked가 "매수" 전용임을 명시적으로 확인.
  // scheduler.js에서 runMorningSell은 isBuyBlocked를 호출하지 않는다.
  const r = isBuyBlocked('20260331');
  // 금지일이어도 "매도 금지"가 아님 — blocked 필드가 매도 로직에 사용되지 않는 게 정책.
  assert(r.blocked === true, '분기말은 매수 차단 확인');
  assert(r.reason === 'quarter_end', '사유 확인');
  // 매도는 scheduler.runMorningSell 안에서 isBuyBlocked를 체크하지 않음 (정책 준수).
});

// ── 결과 출력 ──
let ok = 0, fail = 0;
for (const t of tests) {
  if (t.ok) { console.log(`✓ ${t.name}`); ok++; }
  else       { console.error(`✗ ${t.name}\n   ${t.error}`); fail++; }
}
console.log(`\n${ok}/${tests.length} 통과`);
process.exit(fail > 0 ? 1 : 0);
