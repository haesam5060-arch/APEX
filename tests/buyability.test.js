// tests/buyability.test.js — 체결가능 가드 단위 테스트
'use strict';
const assert = require('assert');
const { isBuyable } = require('../src/buyability');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('buyability.isBuyable');

// 상한가 잠김 (전일 10000 → 상한가 13000, 현재가 13000) → 매수 불가
t('상한가 잠김이면 ok=false', () => {
  const r = isBuyable(13000, 10000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'limit_up_locked');
  assert.strictEqual(r.locked, true);
});

// 상한가 0.5% 이내 (12940 >= 13000*0.995=12935) → 잠김 판정
t('상한가 0.5% 이내도 잠김', () => {
  const r = isBuyable(12940, 10000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.locked, true);
});

// 등락률 29% (12900) → cr_too_high (12900 < 12935 이므로 잠김은 아님, cr=29%>=29%)
t('등락률 29%면 cr_too_high', () => {
  const r = isBuyable(12900, 10000);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('cr_too_high'));
  assert.strictEqual(r.locked, false);
});

// 적당주 +12% (11200) → 매수 가능
t('등락률 12% 적당주는 ok', () => {
  const r = isBuyable(11200, 10000);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.cr - 0.12) < 1e-9);
});

// 경계: cr 정확히 28.9% (12890) → 통과 (< 29%)
t('등락률 28.9%는 통과', () => {
  const r = isBuyable(12890, 10000);
  assert.strictEqual(r.ok, true);
});

// 현재가 없음 → no_price
t('현재가 0이면 no_price', () => {
  const r = isBuyable(0, 10000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_price');
});

// 전일종가 없음 → 보수적 통과 (상한가 판정 불가)
t('전일종가 null이면 통과(가드 skip)', () => {
  const r = isBuyable(11200, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'no_prev_close_skip_limit_check');
});

// crCap 커스텀
t('crCap 0.15로 낮추면 18%는 차단', () => {
  const r = isBuyable(11800, 10000, { crCap: 0.15 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('cr_too_high'));
});

console.log(`\nbuyability: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
