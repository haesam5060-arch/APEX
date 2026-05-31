// ═══════════════════════════════════════════════════════════════
// spectral-cluster-loader.js — APEX R2.0 highcluster_laggard 신호용
//
// 데이터 소스: /Users/sean/Desktop/project/서랍/out/spectral_clusters.parquet
// D-1 18:00 스냅샷, spectral clustering 결과
//
// 스키마:
//   cluster_id: int (0~100)
//   code: str (A로 시작, 예: 'A012330')
//   size: int (클러스터 멤버 수)
//   avg_corr: float (클러스터 내 평균 상관도)
//   window: int (5 또는 20)
//   date: str (YYYYMMDD, 최신값 사용)
//   members: object (멤버 코드 배열)
//
// 주요 함수:
//   loadSpectralClusters(date?) → Map (code → {cluster_id, avg_corr, size, members})
//   getClusterMembers(clusterId, date?) → [{code, avg_corr, size}]
//   getClusterIdByCode(code, date?) → cluster_id | null
// ═══════════════════════════════════════════════════════════════

'use strict';

const path = require('path');
const fs = require('fs');

const SPECTRAL_PATH = '/Users/sean/Desktop/project/서랍/out/spectral_clusters.parquet';

// Python 로드 함수 (메모리 효율성 위해 매번 호출하지 않고 캐싱)
let _cache = null;
let _cacheDate = null;

/**
 * Python으로 parquet 로드 및 JSON 변환
 * @param {string} [date] 'YYYYMMDD' (기본: 최신)
 * @returns {Promise<Object>} {
 *   code_to_cluster: { 'A012330': { cluster_id, avg_corr, size, ... } },
 *   cluster_to_members: { 0: [{code, avg_corr}, ...], ... },
 *   date: 'YYYYMMDD'
 * }
 */
async function loadSpectralClustersInternal(date = null) {
  const dateArg = date ? `'${date}'` : 'None';
  const pyScript = `
import pandas as pd
import json
import sys

clusters_path = '${SPECTRAL_PATH}'
target_date = ${dateArg}

try:
    df = pd.read_parquet(clusters_path)

    # 최신 date 선택 (target_date 미지정 시)
    if target_date is None:
        target_date = str(df['date'].max())

    # 필터: date + window=20 (W=5는 fallback)
    df_filtered = df[(df['date'] == target_date) & (df['window'] == 20)]
    if df_filtered.empty:
        # fallback: window=5
        df_filtered = df[(df['date'] == target_date) & (df['window'] == 5)]

    if df_filtered.empty:
        print(json.dumps({'error': f'No data for date {target_date}'}))
        sys.exit(1)

    # code → cluster 매핑
    code_to_cluster = {}
    for _, row in df_filtered.iterrows():
        code = str(row['code'])
        code_to_cluster[code] = {
            'cluster_id': int(row['cluster_id']),
            'avg_corr': float(row['avg_corr']),
            'size': int(row['size']),
            'window': int(row['window'])
        }

    # cluster → members 매핑
    cluster_to_members = {}
    for _, row in df_filtered.iterrows():
        cid = int(row['cluster_id'])
        if cid not in cluster_to_members:
            cluster_to_members[cid] = {
                'members': [],
                'avg_corr': float(row['avg_corr']),
                'size': int(row['size'])
            }
        member_code = str(row['code'])
        cluster_to_members[cid]['members'].append(member_code)

    result = {
        'code_to_cluster': code_to_cluster,
        'cluster_to_members': cluster_to_members,
        'date': target_date
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
`;

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pythonPath = process.env.PYTHON_BIN || '/Users/sean/Desktop/project/backtest/.venv/bin/python';

    const proc = spawn(pythonPath, ['-c', pyScript], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Python spawn 실패: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python 종료 ${code}: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          return reject(new Error(`Python 오류: ${result.error}`));
        }
        resolve(result);
      } catch (e) {
        reject(new Error(`JSON 파싱 실패: ${e.message}\nstdout: ${stdout}`));
      }
    });
  });
}

/**
 * spectral cluster 데이터 로드 (메모리 캐싱)
 * @param {string} [date] 'YYYYMMDD'
 * @returns {Promise<Object>} {
 *   codeToCluster: Map<string, object>,
 *   clusterToMembers: Map<number, object>,
 *   date: string
 * }
 */
async function loadSpectralClusters(date = null) {
  // 캐시 확인 (date 미지정 또는 동일한 경우)
  if (_cache && (!date || date === _cacheDate)) {
    return _cache;
  }

  const result = await loadSpectralClustersInternal(date);

  // Map으로 변환
  const codeToCluster = new Map();
  for (const [code, data] of Object.entries(result.code_to_cluster)) {
    codeToCluster.set(code, data);
    // A 없는 버전도 등록 (호환성)
    const codeNoA = code.startsWith('A') ? code.slice(1) : code;
    codeToCluster.set(codeNoA, data);
  }

  const clusterToMembers = new Map();
  for (const [cid, data] of Object.entries(result.cluster_to_members)) {
    clusterToMembers.set(parseInt(cid), data);
  }

  _cache = {
    codeToCluster,
    clusterToMembers,
    date: result.date,
  };
  _cacheDate = result.date;

  console.log(`[spectral-loader] spectral clusters 로드: ${codeToCluster.size}종목, ` +
    `${clusterToMembers.size}개 cluster (date=${result.date})`);

  return _cache;
}

/**
 * 종목 코드로부터 cluster_id 조회
 * @param {string} code 'A012330' 또는 '012330'
 * @param {string} [date]
 * @returns {Promise<number|null>}
 */
async function getClusterIdByCode(code, date = null) {
  const data = await loadSpectralClusters(date);
  const normCode = code.startsWith('A') ? code : `A${code}`;
  const info = data.codeToCluster.get(normCode);
  return info ? info.cluster_id : null;
}

/**
 * cluster_id로부터 멤버 리스트 조회
 * @param {number} clusterId
 * @param {string} [date]
 * @returns {Promise<Array>} [{code, avg_corr, size}, ...]
 */
async function getClusterMembers(clusterId, date = null) {
  const data = await loadSpectralClusters(date);
  const clusterData = data.clusterToMembers.get(clusterId);
  if (!clusterData) {
    return [];
  }
  return clusterData.members.map(code => ({
    code,
    avg_corr: clusterData.avg_corr,
    size: clusterData.size,
  }));
}

/**
 * 여러 cluster_id로부터 멤버 리스트 조회
 * @param {Set<number>} clusterIds
 * @param {string} [date]
 * @returns {Promise<Map<number, Array>>} {cluster_id: [{code, ...}, ...]}
 */
async function getClusterMembersMulti(clusterIds, date = null) {
  const data = await loadSpectralClusters(date);
  const result = new Map();
  for (const cid of clusterIds) {
    const clusterData = data.clusterToMembers.get(cid);
    if (clusterData) {
      result.set(cid, clusterData.members.map(code => ({
        code,
        avg_corr: clusterData.avg_corr,
        size: clusterData.size,
      })));
    }
  }
  return result;
}

/**
 * 캐시 초기화 (테스트용)
 */
function clearCache() {
  _cache = null;
  _cacheDate = null;
}

module.exports = {
  loadSpectralClusters,
  getClusterIdByCode,
  getClusterMembers,
  getClusterMembersMulti,
  clearCache,
  SPECTRAL_PATH,
};
