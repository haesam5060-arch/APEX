// ═══════════════════════════════════════════════════════════════
// cluster-loader.js — V3 전략용 cluster_id 매핑 로더
//
// ap12 검증으로 채택된 V3 전략은 KOSDAQ 종목의 60일 rolling
// correlation 기반 cluster_id가 필요. cluster는 backtest 환경
// (CLAUDE.md §8.4.2 분봉/시계열 데이터 SSoT)에서 매주 refit되어
// JSON으로 APEX에 sync된다.
//
// 파일 위치: data/clusters/latest.json  (APEX-local, sync 결과)
// 스키마: {
//   asof_date: "YYYYMMDD",
//   refit_date: "YYYYMMDD",     // 마지막 refit 시점 (이전 월요일)
//   n_clusters: 20,
//   n_codes:    1700,
//   mapping:    { "A012345": 5, "A067890": 12, ... }
// }
//
// loadClusters() 는 다음을 보장한다:
//   - 파일 없으면 null 반환 → strategy.js 가 V0 fallback 동작
//   - asof_date 가 오래되면 (7일 초과) warning 후 사용 (cron 실패 추적용)
//   - 파일 손상되면 null + error 로그
// ═══════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./db');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'clusters', 'latest.json');
const STALE_DAYS_WARN = 7;   // refit이 7일 이상 오래되면 경고

function parseYmd(ymd) {
  if (!ymd || ymd.length !== 8) return null;
  return new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}T00:00:00+09:00`);
}

function daysBetween(a, b) {
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * loadClusters(opts) — cluster 매핑 로드
 *
 * @param {object} [opts]
 * @param {string} [opts.path]            기본: APEX/data/clusters/latest.json
 * @param {string} [opts.todayYmd]        today (테스트용)
 * @returns {{ clusters: Map<string, number>|null, meta: object|null, stale: boolean }}
 *
 *   clusters: null이면 strategy.js 가 V0 fallback. 사용 가능하면 Map.
 *   meta: 파일에서 읽은 asof_date / refit_date 등.
 *   stale: true면 refit이 STALE_DAYS_WARN 이상 오래됨.
 */
function loadClusters(opts = {}) {
  const filePath = opts.path || DEFAULT_PATH;
  const todayYmd = opts.todayYmd || (() => {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  })();

  if (!fs.existsSync(filePath)) {
    log.warn?.('CLUSTER', `cluster 파일 없음 — V0 fallback. 경로: ${filePath}`);
    return { clusters: null, meta: null, stale: false };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    log.error?.('CLUSTER', `cluster JSON 파싱 실패 (${filePath}): ${e.message}`);
    return { clusters: null, meta: null, stale: false };
  }

  const mapping = raw.mapping;
  if (!mapping || typeof mapping !== 'object' || Object.keys(mapping).length === 0) {
    log.warn?.('CLUSTER', 'cluster mapping 비어있음 — V0 fallback');
    return { clusters: null, meta: raw, stale: false };
  }

  // stale 체크
  const refitDate = parseYmd(raw.refit_date);
  const today = parseYmd(todayYmd);
  let stale = false;
  if (refitDate && today) {
    const ageDays = daysBetween(refitDate, today);
    if (ageDays > STALE_DAYS_WARN) {
      stale = true;
      log.warn?.('CLUSTER', `cluster refit이 ${ageDays}일 전 — sync cron 확인 필요`);
    }
  }

  // Map 으로 변환 — code 정규화 (A 접두 일관성)
  const clusters = new Map();
  for (const [code, cid] of Object.entries(mapping)) {
    if (typeof cid !== 'number') continue;
    const normCode = code.startsWith('A') ? code : `A${code}`;
    clusters.set(normCode, cid);
    // APEX scanner는 일부 코드를 A 없이 다룰 수 있어 양쪽 다 등록
    clusters.set(code.replace(/^A/, ''), cid);
  }

  log.info?.('CLUSTER',
    `cluster 로드 — ${clusters.size}종목 (refit=${raw.refit_date}, asof=${raw.asof_date}` +
    (stale ? ', STALE' : '') + ')');

  return { clusters, meta: raw, stale };
}

module.exports = { loadClusters, DEFAULT_PATH };
