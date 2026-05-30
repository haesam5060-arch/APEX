// tests/cluster-loader.test.js — cluster JSON 로더 단위 테스트
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadClusters } = require('../src/cluster-loader');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-test-'));
function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

console.log('cluster-loader');

t('정상 파일 로드', () => {
  const p = tmpFile('ok.json', {
    asof_date: '20260530', refit_date: '20260529',
    n_clusters: 20, n_codes: 3,
    mapping: { A000020: 5, A012345: 12, A067890: 7 },
  });
  const r = loadClusters({ path: p, todayYmd: '20260530' });
  assert.ok(r.clusters);
  assert.strictEqual(r.clusters.get('A000020'), 5);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.meta.refit_date, '20260529');
});

t('A 접두 없는 코드도 찾을 수 있음', () => {
  const p = tmpFile('ab.json', {
    asof_date: '20260530', refit_date: '20260529',
    n_clusters: 20, n_codes: 1,
    mapping: { A012345: 12 },
  });
  const r = loadClusters({ path: p, todayYmd: '20260530' });
  assert.strictEqual(r.clusters.get('A012345'), 12);
  assert.strictEqual(r.clusters.get('012345'), 12);
});

t('파일 없으면 null + V0 fallback OK', () => {
  const r = loadClusters({ path: '/nonexistent/path/foo.json', todayYmd: '20260530' });
  assert.strictEqual(r.clusters, null);
  assert.strictEqual(r.meta, null);
});

t('JSON 손상 → null', () => {
  const p = tmpFile('bad.json', '{"asof_date": "20260530",');
  const r = loadClusters({ path: p, todayYmd: '20260530' });
  assert.strictEqual(r.clusters, null);
});

t('mapping 비어있으면 null', () => {
  const p = tmpFile('empty.json', {
    asof_date: '20260530', refit_date: '20260529',
    n_clusters: 0, n_codes: 0,
    mapping: {},
  });
  const r = loadClusters({ path: p, todayYmd: '20260530' });
  assert.strictEqual(r.clusters, null);
});

t('refit이 8일 전이면 stale=true', () => {
  const p = tmpFile('stale.json', {
    asof_date: '20260530', refit_date: '20260520',   // 10일 전
    n_clusters: 20, n_codes: 1,
    mapping: { A000020: 1 },
  });
  const r = loadClusters({ path: p, todayYmd: '20260530' });
  assert.ok(r.clusters);
  assert.strictEqual(r.stale, true);
});

t('refit이 5일 전이면 stale=false', () => {
  const p = tmpFile('fresh.json', {
    asof_date: '20260530', refit_date: '20260525',
    n_clusters: 20, n_codes: 1,
    mapping: { A000020: 1 },
  });
  const r = loadClusters({ path: p, todayYmd: '20260530' });
  assert.ok(r.clusters);
  assert.strictEqual(r.stale, false);
});

console.log(`\ncluster-loader: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
