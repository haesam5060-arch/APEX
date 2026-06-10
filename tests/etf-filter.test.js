// ═══════════════════════════════════════════════════════════════
// ETF 매수후보 제외 필터 테스트 (APEX#13, 2026-06-10)
//   1) _parseEtfList — 네이버 etfItemList 응답 파싱 (A-prefix 변환)
//   2) data/etf_codes.json 파일 포맷 — python(_load_etf_set)과 호환
//   실행: node tests/etf-filter.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { _parseEtfList } = require('../src/stock-fetcher');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
}

console.log('\netf-filter: _parseEtfList');

t('정상 응답 — itemcode에 A prefix 붙여 반환', () => {
  const json = { result: { etfItemList: [
    { itemcode: '069500', itemname: 'KODEX 200' },
    { itemcode: '0163Y0', itemname: 'KoAct 코스닥액티브' },
  ] } };
  eq(_parseEtfList(json), ['A069500', 'A0163Y0']);
});

t('신형 영문 코드(0163Y0) 보존', () => {
  const codes = _parseEtfList({ result: { etfItemList: [{ itemcode: '0151P0' }] } });
  eq(codes, ['A0151P0']);
});

t('빈/이상 응답 — 빈 배열 (throw 없음)', () => {
  eq(_parseEtfList({}), []);
  eq(_parseEtfList(null), []);
  eq(_parseEtfList({ result: {} }), []);
});

t('6자리 아닌 itemcode 제외', () => {
  const codes = _parseEtfList({ result: { etfItemList: [{ itemcode: '12345' }, { itemcode: '069500' }, { itemcode: '' }] } });
  eq(codes, ['A069500']);
});

console.log('\netf-filter: data/etf_codes.json 포맷 (python _load_etf_set 호환)');

t('파일 존재 시 etf_codes 배열 + A-prefix', () => {
  const p = path.resolve(__dirname, '..', 'data', 'etf_codes.json');
  if (!fs.existsSync(p)) { console.log('    (파일 없음 — 첫 14:30 갱신 전이면 정상, skip)'); return; }
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(d.etf_codes)) throw new Error('etf_codes 배열 아님');
  if (d.etf_codes.length < 100) throw new Error(`리스트 비정상 (${d.etf_codes.length}개)`);
  if (!d.etf_codes.every(c => /^A[0-9A-Z]{6}$/.test(c))) throw new Error('A-prefix 6자리 형식 위반 항목 존재');
});

console.log(`\netf-filter: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
