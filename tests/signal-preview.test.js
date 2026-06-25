// ═══════════════════════════════════════════════════════════════
// 14:30 신호 알림 가격필터 미리보기 테스트 (2026-06-25)
//   buildSignalMessage — result.price_band 기준 '예상 제외' 표기 / 헤더 전환.
//   selectLaggardBuyList(14:50 실필터)와 동일 밴드 의미론(양끝 포함)을 14:30 참고가로 미리보기.
//   계기: 뉴인텍(012340) @1,116원이 '14:50 매수 예정'으로 통보됐다가 가격필터로 빠져 혼란.
//   실행: node tests/signal-preview.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { buildSignalMessage } = require('../src/discord-notifier');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

const BAND = { lo: 10000, hi: 50000 };
const base = (picks, extra = {}) => ({ picks, prev_date: '20260624', window: 20, seed: [], ...extra });

console.log('\nsignal-preview: 가격필터 미리보기 (밴드 밖 → 예상 제외)');

t('동전주(1,116원) → 라인 예상 제외 + 헤더 매수 예정 없음 (실제 케이스 재현)', () => {
  const msg = buildSignalMessage(base(
    [{ code: '012340', name: '뉴인텍', lag_rank: 2, deviation: -16.3, buy: 1116, cluster_avg_corr: 0.37, cluster_size: 15 }],
    { price_band: BAND }
  ));
  assert(msg.includes('⚠️ 가격필터 예상 제외'), '라인 예상 제외 태그 누락');
  assert(msg.includes('매수 예정 없음'), '헤더 매수 예정 없음 전환 실패');
  assert(msg.includes('@1,116원'), '참고가 표기 유지 실패');
});

t('밴드 안(15,000원) → 예상 제외 없음 + 헤더 매수 예정', () => {
  const msg = buildSignalMessage(base([{ code: 'A1', name: '가가', lag_rank: 0, buy: 15000 }], { price_band: BAND }));
  assert(!msg.includes('예상 제외'), '오탐: 밴드 안인데 제외 표기');
  assert(msg.includes('14:50 매수 예정') && !msg.includes('매수 예정 없음'), '헤더 매수 예정 유지 실패');
});

t('경계 양끝(10,000·50,000) 포함 — 제외 안 됨 (selectLaggardBuyList 양끝 포함과 동일)', () => {
  const msg = buildSignalMessage(base(
    [{ code: 'LO', name: '로', lag_rank: 0, buy: 10000 }, { code: 'HI', name: '하이', lag_rank: 1, buy: 50000 }],
    { price_band: BAND }
  ));
  assert(!msg.includes('예상 제외'), '경계값이 제외됨 (양끝 포함 위반)');
  assert(msg.includes('14:50 매수 예정') && !msg.includes('매수 예정 없음'), '헤더 매수 예정 유지 실패');
});

t('경계 밖 한 틱(9,999·50,001) → 둘 다 예상 제외', () => {
  const msg = buildSignalMessage(base(
    [{ code: 'LO', name: '로', lag_rank: 0, buy: 9999 }, { code: 'HI', name: '하이', lag_rank: 1, buy: 50001 }],
    { price_band: BAND }
  ));
  assert(/로\(LO\)[^\n]*예상 제외/.test(msg), 'LO 예상 제외 누락');
  assert(/하이\(HI\)[^\n]*예상 제외/.test(msg), 'HI 예상 제외 누락');
  assert(msg.includes('매수 예정 없음'), '전부 밖인데 헤더 전환 실패');
});

t('일부만 밴드 밖 → 통과분 있으면 헤더는 매수 예정 유지', () => {
  const msg = buildSignalMessage(base(
    [{ code: 'OUT', name: '아웃', lag_rank: 0, buy: 9999 }, { code: 'IN', name: '인', lag_rank: 1, buy: 20000 }],
    { price_band: BAND }
  ));
  assert(/아웃\(OUT\)[^\n]*예상 제외/.test(msg), 'OUT 예상 제외 누락');
  assert(!/인\(IN\)[^\n]*예상 제외/.test(msg), 'IN 오탐 제외');
  assert(msg.includes('14:50 매수 예정') && !msg.includes('매수 예정 없음'), '헤더 매수 예정 유지 실패');
});

t('price_band 없으면 기존 동작 유지 (미리보기 비활성)', () => {
  const msg = buildSignalMessage(base([{ code: '012340', name: '뉴인텍', lag_rank: 2, buy: 1116 }]));
  assert(!msg.includes('예상 제외'), 'band 없는데 제외 표기');
  assert(msg.includes('14:50 매수 예정') && !msg.includes('매수 예정 없음'), '기존 헤더 유지 실패');
});

t('그림자(L1 휴면) 헤더 유지 + 밴드 밖이면 라인 태그는 표기', () => {
  const msg = buildSignalMessage(base(
    [{ code: '012340', name: '뉴인텍', lag_rank: 2, buy: 1116 }],
    { price_band: BAND, shadow: true }
  ));
  assert(msg.includes('L1 휴면'), '그림자 헤더 누락');
  assert(!msg.includes('매수 예정 없음'), '그림자에 매수 예정 없음 헤더 오적용');
  assert(msg.includes('예상 제외'), '그림자에서도 라인 태그 필요');
});

t('가격 미상(buy=null) → 제외 단정 안 함 (14:50 폴가까지 미정)', () => {
  const msg = buildSignalMessage(base([{ code: 'A1', name: '미상', lag_rank: 0 }], { price_band: BAND }));
  assert(!msg.includes('예상 제외'), '가격 미상을 제외로 단정');
  assert(msg.includes('14:50 매수 예정') && !msg.includes('매수 예정 없음'), '미상인데 매수 예정 없음 단정');
});

t('빈/누락 result → null (no-op, 기존 방어 유지)', () => {
  assert(buildSignalMessage(base([])) === null, '빈 picks null 아님');
  assert(buildSignalMessage(null) === null, 'null result null 아님');
  assert(buildSignalMessage({}) === null, 'picks 누락 null 아님');
});

console.log(`\nsignal-preview: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
