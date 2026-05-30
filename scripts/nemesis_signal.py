#!/usr/bin/env python3
"""
nemesis_signal.py — APEX 시그널 계산기 (Node.js 엔진에서 child_process로 호출)

입력 (stdin JSON):
  {
    "signal_date": "YYYYMMDD",   # D일
    "top10": [
      {"code": "A012330", "name": "현대모비스", "change_rate": 0.024},
      ...
    ],
    "kosdaq_codes": ["A012330", ...]  # 시장 사전 필터 (None이면 필터 없음)
  }

출력 (stdout JSON):
  {
    "ok": true,
    "picks": [
      {
        "code": "A012330",
        "name": "현대모비스",
        "rank": 1,
        "weight": 0.5,
        "cluster_id": 99,
        "cluster_count": 2,
        "cluster_size": 9,
        "signal_source": "s16_w20",
        "deviation": -23.62,
        "abs_dev": 23.62,
        "avg_corr": 0.34
      },
      { ...rank 2... }
    ],
    "diag": { ... }
  }

룩어헤드 보장:
  spectral_clusters / returns_5min은 D-1 시점까지의 데이터만 사용
  (서랍 빌더가 D-1 18:00에 빌드해서 D일 09:29 매매에 안전)

전략 (TRASH=0.30, MIN_CS=8 변형):
  1. top10 종목 → W=20 / W=5 spectral cluster 후보 풀
  2. 활성 cluster: avg_corr ≥ 0.30 (NEMESIS 0.34 vs APEX 0.30)
  3. cluster_size ≥ 8
  4. 후보 풀의 5분봉 returns로 편차 계산
  5. |편차|≥10 음수 중 |편차| 큰 순 top1·top2 반환
"""
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

# ─── 경로 ───
SEORAB = Path('/Users/sean/Desktop/project/서랍')
SPECTRAL_PATH = SEORAB / 'out' / 'spectral_clusters.parquet'
RETURNS_5M_PATH = SEORAB / 'out' / 'returns_5min.parquet'

# ─── 파라미터 (APEX = TRASH=0.30, MIN_CS=8) ───
TRASH = 0.30          # cluster avg_corr 임계 (APEX 변형: 0.30)
DEV_CUT = 10.0        # |편차| 컷
MIN_CLUSTER_SIZE = 8  # cluster 멤버 ≥ 8
N_PICKS = 2           # 반환할 ranked picks 수
WEIGHTS = [0.5, 0.5]  # 자본 분할 비율
WINDOW = 20           # spectral W=20
DEV_END_BAR = 930     # D일 09:30까지의 5분봉 사용


def load_spectral_window(window):
    df = pd.read_parquet(SPECTRAL_PATH)
    df = df[df['window'] == window].copy()
    df['date'] = df['date'].astype(str)
    return df


def load_returns_5m():
    rets = pd.read_parquet(RETURNS_5M_PATH)
    idx_str = rets.index.astype(str)
    dates_arr = np.array([s[:8] for s in idx_str])
    times_arr = np.array([int(s[9:]) for s in idx_str])
    sorted_dates = sorted(pd.unique(dates_arr).tolist())
    return rets, dates_arr, times_arr, sorted_dates


def compute_deviations(members, rets, dates_arr, times_arr, sorted_dates, date_d, window):
    """D일 09:30 까지 5분봉으로 정규화 누적 가격 + 편차"""
    if date_d not in sorted_dates:
        return None
    idx_d = sorted_dates.index(date_d)
    start_i = max(0, idx_d - window + 1)
    window_dates = set(sorted_dates[start_i: idx_d + 1])
    mask_window = np.isin(dates_arr, list(window_dates))
    mask_d_partial = (dates_arr != date_d) | (times_arr <= DEV_END_BAR)
    mask = mask_window & mask_d_partial
    if not mask.any():
        return None
    members_in = [c for c in members if c in rets.columns]
    if len(members_in) < 2:
        return None
    sub = rets.loc[mask, members_in].fillna(0)
    daily_idx = pd.Series(sub.index.astype(str)).str[:8].values
    daily_rets = sub.groupby(daily_idx).sum()
    if len(daily_rets) == 0:
        return None
    norm = 100.0 * np.exp(daily_rets.cumsum())
    last = norm.iloc[-1]
    mean_last = float(last.mean())
    return {code: float(last[code] - mean_last) for code in members_in}


def cluster_picks(top10_codes, spec_df_prev, dev_map, top_n=N_PICKS, allowed_codes=None):
    """cluster 활성도 ≥ TRASH + cluster_size ≥ MIN_CLUSTER_SIZE + |편차|≥DEV_CUT 음수 중 |편차| 큰 순 top_n

    allowed_codes: 시장 사전 필터. None이면 전체 허용.
    """
    code_to_cid = dict(zip(spec_df_prev['code'], spec_df_prev['cluster_id']))
    cid_to_avgcorr = dict(zip(spec_df_prev['cluster_id'], spec_df_prev['avg_corr']))
    cid_to_members = spec_df_prev.groupby('cluster_id')['code'].apply(list).to_dict()

    # 활성 cluster: top10 멤버가 속한 cluster 중 avg_corr ≥ TRASH
    counter = Counter()
    for c in top10_codes:
        cid = code_to_cid.get(c)
        if cid is None or cid_to_avgcorr.get(cid, 0) < TRASH:
            continue
        counter[cid] += 1
    if not counter:
        return []

    # 활성 cluster의 멤버 중 cluster_size ≥ MIN_CLUSTER_SIZE → |편차|≥DEV_CUT 음수 후보 수집
    candidates = []
    for cid, cnt in counter.items():
        members = cid_to_members.get(cid, [])
        if len(members) < MIN_CLUSTER_SIZE:
            continue
        for code in members:
            if allowed_codes is not None and code not in allowed_codes:
                continue
            d_v = dev_map.get(code)
            if d_v is None or d_v >= 0:
                continue
            abs_d = abs(d_v)
            if abs_d < DEV_CUT:
                continue
            candidates.append({
                'code': code, 'cluster_id': int(cid), 'cluster_count': int(cnt),
                'cluster_size': len(members), 'deviation': d_v, 'abs_dev': abs_d,
                'avg_corr': float(cid_to_avgcorr.get(cid, 0)),
            })
    if not candidates:
        return []
    # 중복 제거
    seen = {}
    for c in candidates:
        if c['code'] not in seen or seen[c['code']]['abs_dev'] < c['abs_dev']:
            seen[c['code']] = c
    uniq = list(seen.values())
    uniq.sort(key=lambda x: -x['abs_dev'])
    return uniq[:top_n]


def get_prev_trading_date(date_d, spec_dates):
    """D 시점에서 사용 가능한 가장 최근 spectral 스냅샷 날짜"""
    candidates = sorted([d for d in spec_dates if d < date_d])
    if not candidates:
        return None
    return candidates[-1]


def main():
    try:
        payload = json.loads(sys.stdin.read())
        signal_date = payload['signal_date']
        top10 = payload['top10']
        top10_codes = [t['code'] for t in top10]
        code_to_name = {t['code']: t.get('name', '') for t in top10}

        # 시장 사전 필터
        allowed_codes_raw = payload.get('kosdaq_codes')
        allowed_codes = set(allowed_codes_raw) if allowed_codes_raw else None

        # 데이터 로드
        spec_w20 = load_spectral_window(20)
        spec_w5 = load_spectral_window(5)
        rets, dates_arr, times_arr, sorted_dates = load_returns_5m()

        # D-1
        spec_dates_w20 = sorted(spec_w20['date'].unique())
        prev_date = get_prev_trading_date(signal_date, spec_dates_w20)
        if prev_date is None:
            print(json.dumps({'ok': False, 'error': f'No spectral snapshot before {signal_date}'}))
            return

        spec_w20_prev = spec_w20[spec_w20['date'] == prev_date]
        spec_w5_prev = spec_w5[spec_w5['date'] == prev_date]

        # 후보 풀
        c2c_w20 = dict(zip(spec_w20_prev['code'], spec_w20_prev['cluster_id']))
        c2c_w5 = dict(zip(spec_w5_prev['code'], spec_w5_prev['cluster_id']))
        members_w20 = spec_w20_prev.groupby('cluster_id')['code'].apply(list).to_dict()
        members_w5 = spec_w5_prev.groupby('cluster_id')['code'].apply(list).to_dict()

        all_pool = set()
        for c in top10_codes:
            cid = c2c_w20.get(c)
            if cid is not None:
                all_pool.update(members_w20.get(cid, []))
            cid = c2c_w5.get(c)
            if cid is not None:
                all_pool.update(members_w5.get(cid, []))
        all_pool = list(all_pool & set(rets.columns))

        if len(all_pool) < 2:
            print(json.dumps({'ok': True, 'picks': [],
                              'prev_date': prev_date,
                              'diag': {'reason': 'pool < 2', 'n_pool_total': len(all_pool)}}))
            return

        # 편차 계산
        dev_map = compute_deviations(all_pool, rets, dates_arr, times_arr, sorted_dates,
                                      signal_date, WINDOW)
        if dev_map is None:
            dev_map = compute_deviations(all_pool, rets, dates_arr, times_arr, sorted_dates,
                                          prev_date, WINDOW)
            if dev_map is None:
                print(json.dumps({'ok': True, 'picks': [],
                                  'prev_date': prev_date,
                                  'diag': {'reason': 'deviation calc failed'}}))
                return

        # 우선순위
        picks_w20 = cluster_picks(top10_codes, spec_w20_prev, dev_map,
                                   top_n=N_PICKS, allowed_codes=allowed_codes)
        picks_w5 = cluster_picks(top10_codes, spec_w5_prev, dev_map,
                                  top_n=N_PICKS, allowed_codes=allowed_codes)

        chosen = []
        signal_source = None
        if picks_w20:
            chosen = picks_w20
            signal_source = 's16_w20'
        elif picks_w5:
            chosen = picks_w5
            signal_source = 's16_w5'

        # rank, weight, signal_source, name 추가
        final_picks = []
        for i, p in enumerate(chosen):
            final_picks.append({
                **p,
                'rank': i + 1,
                'weight': WEIGHTS[i] if i < len(WEIGHTS) else 0.0,
                'signal_source': signal_source,
                'name': code_to_name.get(p['code'], ''),
            })

        # 가중치 재정규화
        if final_picks:
            w_sum = sum(p['weight'] for p in final_picks)
            if w_sum > 0:
                for p in final_picks:
                    p['weight'] = p['weight'] / w_sum

        # 진단
        all_counter = Counter()
        for c in top10_codes:
            cid = c2c_w20.get(c)
            if cid is not None:
                all_counter[cid] += 1
        n_active_w20 = len([cid for cid, cnt in all_counter.items()
                           if dict(zip(spec_w20_prev['cluster_id'],
                                       spec_w20_prev['avg_corr'])).get(cid, 0) >= TRASH])

        out = {
            'ok': True,
            'picks': final_picks,
            'prev_date': prev_date,
            'rules': {
                'TRASH': TRASH,
                'DEV_CUT': DEV_CUT,
                'MIN_CLUSTER_SIZE': MIN_CLUSTER_SIZE,
                'N_PICKS': N_PICKS,
                'WEIGHTS': WEIGHTS,
            },
            'diag': {
                'n_top10': len(top10_codes),
                'n_pool_total': len(all_pool),
                'n_active_clusters_w20': n_active_w20,
                'picks_w20_available': len(picks_w20),
                'picks_w5_available': len(picks_w5),
                'final_n_picks': len(final_picks),
            }
        }
        print(json.dumps(out, ensure_ascii=False))

    except Exception as e:
        import traceback
        print(json.dumps({'ok': False, 'error': str(e), 'traceback': traceback.format_exc()}))


if __name__ == '__main__':
    main()
