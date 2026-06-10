'use strict';
// regime-guard 단위 테스트 — L1 임시휴면 / L2 레짐붕괴 래치
//   실행: node tests/regime-guard.test.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// 테스트용 임시 halt 파일 격리
const TMP_HALT = path.resolve(__dirname, '..', 'data', 'regime_halt.test.json');
process.env.REGIME_L1_TRAIL_DAYS = '40';
process.env.REGIME_L2_ROLL_DAYS = '63';
process.env.REGIME_L2_ROLL_CUT = '-0.08';
process.env.REGIME_L2_DD_CUT = '-0.15';

const rg = require('../src/regime-guard');
// HALT_FILE 경로를 테스트용으로 가리킬 수 없으므로(상수), 실제 파일 사용 후 정리
function cleanup() { try { if (fs.existsSync(rg.HALT_FILE)) fs.unlinkSync(rg.HALT_FILE); } catch (e) {} }

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log('[regime-guard] evaluate() 순수 로직');

t('표본 0 → 가드 미작동(첫 매매 허용, 백테 len(p)<1 동일)', () => {
  const ev = rg.evaluate([]);
  assert.strictEqual(ev.l1Dormant, false);
  assert.strictEqual(ev.l2Breach, false);
});

t('★ APEX#9: 표본 1개 음수 → 즉시 L1 휴면 (백테 콜드스타트 정합)', () => {
  const ev = rg.evaluate([-0.0035]);
  assert.strictEqual(ev.l1Dormant, true);
  assert.strictEqual(ev.l2Breach, false, 'L2 콜드스타트 보호는 유지');
});

t('표본 1개 양수 → 휴면 아님', () => {
  const ev = rg.evaluate([0.01]);
  assert.strictEqual(ev.l1Dormant, false);
});

t('표본<40 연속 손실 → L1 휴면 + L2(롤링·DD)는 콜드스타트 보호 유지', () => {
  const ev = rg.evaluate(Array(10).fill(-0.05));
  assert.strictEqual(ev.l1Dormant, true);
  assert.strictEqual(ev.l2Breach, false);
});

t('굿레짐(40일 평균 +1%) → 휴면/붕괴 없음', () => {
  const ev = rg.evaluate(Array(70).fill(0.01));
  assert.strictEqual(ev.l1Dormant, false);
  assert.strictEqual(ev.l2Breach, false);
  assert.ok(ev.trailingSum > 0);
});

t('L1: 직전 40매매일 누적<0 → 임시휴면 (드로다운 -15%·롤링 -8% 이내로 격리)', () => {
  // 앞 30일 +0.5%(peak +16%), 최근 40일 -0.2% → 직전40 누적 -8%<0, 드로다운 -8%(>-15%), 롤링63 +3.5%(>-8%)
  const rets = [...Array(30).fill(0.005), ...Array(40).fill(-0.002)];
  const ev = rg.evaluate(rets);
  assert.strictEqual(ev.l1Dormant, true, 'L1 휴면이어야');
  assert.strictEqual(ev.l2Breach, false, `L2까진 아님 (rolling=${(ev.rolling*100).toFixed(1)}% dd=${(ev.drawdown*100).toFixed(1)}%)`);
});

t('L1 경계: 직전 40매매일 누적 정확히 0 이상이면 휴면 아님', () => {
  const rets = [...Array(40).fill(0.0), ...Array(40).fill(0.0)];
  const ev = rg.evaluate(rets);
  assert.strictEqual(ev.l1Dormant, false);
});

t('L2-A: 롤링63 누적 < -8% → 레짐붕괴', () => {
  // 63일 평균 -0.2%/일 → 누적 약 -12%
  const ev = rg.evaluate(Array(63).fill(-0.002));
  assert.strictEqual(ev.l2Breach, true);
  assert.ok(ev.rolling < -0.08);
});

t('L2-B: 큰 드로다운(>15%) → 레짐붕괴 (표본≥40)', () => {
  // 40일 +1%(peak) 후 12일 -2.5% → 피크대비 약 -26%, n=52≥40
  const rets = [...Array(40).fill(0.01), ...Array(12).fill(-0.025)];
  const ev = rg.evaluate(rets);
  assert.ok(ev.drawdown < -0.15, `drawdown=${(ev.drawdown*100).toFixed(1)}%`);
  assert.strictEqual(ev.l2Breach, true);
});

t('굿레짐 실측 근사(롤링63 +31% 수준) → 붕괴 없음', () => {
  // 평균 +0.4%/일 × 63 ≈ +28%
  const ev = rg.evaluate(Array(80).fill(0.004));
  assert.strictEqual(ev.l2Breach, false);
  assert.strictEqual(ev.l1Dormant, false);
});

console.log('[regime-guard] checkRegime() + L2 래치 (db stub)');

function stubStmts(rets) {
  // recentGuardDaily.all(limit) → 최신순 rows [{date, r(소수), kind}] — APEX#9
  const rows = rets.map((r, i) => ({ date: `202601${String(i + 1).padStart(2, '0')}`, r, kind: 'real' }));
  return { recentGuardDaily: { all: () => rows.slice().reverse() } };
}

t('checkRegime: 굿레짐 → canTrade=true', () => {
  cleanup();
  const r = rg.checkRegime({ stmts: stubStmts(Array(70).fill(0.01)) }); // +1%/일
  assert.strictEqual(r.canTrade, true);
  assert.strictEqual(r.layer, 'OK');
  cleanup();
});

t('checkRegime: L1 → dormant(canTrade=false, halted=false)', () => {
  cleanup();
  // 소수 단위 — L1 격리: 앞30일 +0.5%, 최근40일 -0.2%
  const r = rg.checkRegime({ stmts: stubStmts([...Array(30).fill(0.005), ...Array(40).fill(-0.002)]) });
  assert.strictEqual(r.canTrade, false);
  assert.strictEqual(r.dormant, true);
  assert.strictEqual(r.halted, false);
  assert.strictEqual(r.layer, 'L1');
  cleanup();
});

t('checkRegime: L2 → halted + 래치(다음 호출도 중단)', () => {
  cleanup();
  const r1 = rg.checkRegime({ stmts: stubStmts(Array(63).fill(-0.002)), now: '2026-02-01T15:00:00' });
  assert.strictEqual(r1.halted, true);
  assert.strictEqual(r1.layer, 'L2');
  assert.strictEqual(rg.isHalted(), true, '래치 파일 생성돼야');
  // 래치 후엔 굿레짐 데이터여도 계속 중단
  const r2 = rg.checkRegime({ stmts: stubStmts(Array(70).fill(0.01)) });
  assert.strictEqual(r2.halted, true, '래치 유지');
  // reset 후 재개
  rg.reset();
  assert.strictEqual(rg.isHalted(), false);
  const r3 = rg.checkRegime({ stmts: stubStmts(Array(70).fill(0.01)) });
  assert.strictEqual(r3.canTrade, true, 'reset 후 재개');
  cleanup();
});

console.log(`\n[regime-guard] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
