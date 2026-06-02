#!/usr/bin/env python
"""
apex_laggard_signal.py — APEX 14:30 클러스터 laggard 신호 (운영용)
================================================================================
검증 대상 백테: backtest/analysis/ap22_cluster_laggard_midprice.py (운영 셀)
  - 채택 스펙(ap28): corr≥0.15 · cluster_size≥8 · 진입가 10,000~50,000 · bottom_n=3 · cap2
  - 14:30 신호 / 14:50 close 진입 / T+1 첫분봉 청산 / 상한가잠김 제외

★ 백테-운영 byte 정합 (글로벌 §8.4.1):
  ap21/ap22가 쓰는 동일 기계(s10.load_spectral / load_returns_5m / pick_drawer /
  ap21.compute_dev_cut)를 그대로 import. 분봉 SSoT = backtest/parquet, 클러스터 = 서랍.
  → 같은 날짜를 주면 백테와 동일 픽이 나온다.

입력(stdin JSON): {"signal_date": "YYYYMMDD"}
출력(stdout 마지막 줄 JSON):
  { "ok": true, "signal_date": "...", "prev_date": "...",
    "picks": [ {code, entry, lag_rank, deviation, avg_corr, cluster_size, weight} ],
    "diag": {...} }
  실패 시 { "ok": false, "error": "...", "diag": {...} }

사용(엔진 strategy.js가 spawn):
  echo '{"signal_date":"20260529"}' | python apex_laggard_signal.py
"""
import sys, json
from pathlib import Path

# backtest 프로젝트 경로 (검증된 백테 기계 import)
BACKTEST = Path("/Users/sean/Desktop/project/backtest")
sys.path.insert(0, str(BACKTEST))
sys.path.insert(0, str(BACKTEST / "analysis"))

# ── 운영 셀 파라미터 (ap28 채택) ─────────────────────
CORR_MIN = 0.15
SIZE_MIN = 8
PRICE_LO = 10000
PRICE_HI = 50000
BOTTOM_N = 3      # laggard 후보 수집 (편차 최저 N)
DAILY_CAP = 2     # 하루 최대 매수 (lag_rank 오름차순 head)
CUTOFF = 1430     # 14:30 신호
ENTRY_T = 1450    # 14:50 close 진입
LIMIT_TOL = 0.995


def _fail(msg, diag=None):
    print(json.dumps({"ok": False, "error": msg, "diag": diag or {}}, ensure_ascii=False))
    sys.exit(0)


def _A(c):
    c = str(c).upper().strip()
    return c if c.startswith("A") else f"A{c}"


def run_live(payload):
    """★ 라이브 원시(raw) 모드 (ap29 검증). 장중 14:30 실시간.
    입력: { signal_date, morning_rets:{code6:ret}, today_change:{code6:changeRate} }
      - morning_rets: poll_morning_change (09:00~09:29 장중 등락률) → 아침 Top10 → 클러스터
      - today_change: scanAllStocks (14:30 전일대비 등락률) → 원시 편차 today-piece
    편차 = parquet 원시 일별 로그수익 20일(D-1까지) + 오늘 ln(1+today_change). [중립화 안 씀]
    """
    import numpy as np, pandas as pd
    signal_date = str(payload.get("signal_date") or "").strip()
    if len(signal_date) != 8:
        _fail("signal_date 필요")
    morning_rets = payload.get("morning_rets") or {}
    today_change = payload.get("today_change") or {}
    if not morning_rets:
        _fail("morning_rets 비어있음 (poll_morning_change 실패?)")

    import s10_seorab_morning_topbot as s10
    s10.SPECTRAL_PATH = BACKTEST.parent / "서랍" / "out" / "spectral_clusters.parquet"
    from s10_seorab_morning_topbot import load_spectral, all_trading_dates, pick_drawer, WINDOW
    from analysis.loader import day_close

    c2c, m2c, a2c = load_spectral(WINDOW)
    spec_dates = set(c2c.keys())
    tds = all_trading_dates()
    if signal_date not in tds:
        _fail("거래일 아님")
    i = tds.index(signal_date)
    prev = next((tds[j] for j in range(i-1, -1, -1) if tds[j] in spec_dates), None)
    if prev is None:
        _fail("직전 spectral 스냅샷 없음")

    # 아침 Top10 (장중 등락률 내림차순)
    top = sorted(morning_rets.items(), key=lambda kv: -kv[1])[:TOP_N_MORNING_LIVE]
    top10 = pd.DataFrame({"code": [_A(c) for c, _ in top]})
    pick = pick_drawer(top10, c2c.get(prev, {}), m2c.get(prev, {}), a2c.get(prev, {}))
    if pick is None:
        print(json.dumps({"ok": True, "signal_date": signal_date, "prev_date": prev,
                          "picks": [], "diag": {"reason": "활성 클러스터 없음"}}, ensure_ascii=False)); return
    cid, cnt = pick
    members = m2c[prev][cid]
    avg_corr = float(a2c.get(prev, {}).get(cid, float("nan")))
    if (avg_corr == avg_corr and avg_corr < CORR_MIN) or len(members) < SIZE_MIN:
        print(json.dumps({"ok": True, "signal_date": signal_date, "prev_date": prev, "picks": [],
                          "diag": {"reason": f"클러스터 필터 미달 corr={avg_corr:.3f} size={len(members)}"}},
                         ensure_ascii=False)); return

    # 20일 원시 일별 로그수익 (D-1까지 parquet) + 오늘 ln(1+today_change)
    win = [d for d in tds if d < signal_date][-WINDOW:]   # D-WINDOW..D-1
    panel = {}
    for d in win:
        for mk in ("kospi", "kosdaq"):
            try:
                s = day_close(d, market=mk)
                for code in members:
                    if code in s.index and s[code] > 0:
                        panel.setdefault(code, {})[d] = float(s[code])
            except Exception:
                pass
    rows = {}
    for code in members:
        tc = today_change.get(code[1:]) if code[1:] in today_change else today_change.get(code)
        if tc is None:
            continue
        closes = [panel.get(code, {}).get(d) for d in win]
        closes = [c for c in closes if c]
        if len(closes) < 2:
            continue
        rets = [np.log(closes[k]/closes[k-1]) for k in range(1, len(closes))]
        rets.append(np.log(1.0 + float(tc)))   # 오늘 14:30 (전일대비)
        rows[code] = float(100.0 * np.exp(np.cumsum(rets))[-1])
    if len(rows) < 2:
        _fail("편차 계산 멤버 부족 (today_change/history 매칭 실패)")
    last = pd.Series(rows); dev = (last - float(last.mean())).sort_values(ascending=False)
    lag = list(dev.items())[::-1][:BOTTOM_N]   # 편차 최저 N
    picks = [{"code": code[1:], "deviation": float(dv), "lag_rank": r,
              "avg_corr": avg_corr, "cluster_size": len(members),
              "today_change": today_change.get(code[1:], today_change.get(code))}
             for r, (code, dv) in enumerate(lag)]
    print(json.dumps({"ok": True, "signal_date": signal_date, "prev_date": prev, "picks": picks,
                      "diag": {"cluster_id": int(cid), "avg_corr": avg_corr, "cluster_size": len(members),
                               "n_candidates": len(picks), "mode": "live_raw"}},
                     ensure_ascii=False, default=str))


TOP_N_MORNING_LIVE = 10


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        _fail(f"입력 파싱 실패: {e}")
    if payload.get("mode") == "live":
        return run_live(payload)
    signal_date = str(payload.get("signal_date") or "").strip()
    if len(signal_date) != 8:
        _fail(f"signal_date(YYYYMMDD) 필요: {signal_date!r}")

    try:
        import numpy as np, pandas as pd  # noqa
        import s10_seorab_morning_topbot as s10
        s10.SPECTRAL_PATH = BACKTEST.parent / "서랍" / "out" / "spectral_clusters.parquet"
        s10.RETURNS_5M_PATH = BACKTEST.parent / "서랍" / "out" / "returns_5min.parquet"
        from s10_seorab_morning_topbot import (
            load_spectral, load_returns_5m, load_day_minutes, all_trading_dates,
            compute_morning_change, pick_drawer, WINDOW, TOP_N_MORNING,
        )
        from ap21_laggard_timing import compute_dev_cut, close_at, prev_close_map
    except Exception as e:
        _fail(f"백테 모듈 import 실패: {e}")

    # 데이터 로드
    c2c, m2c, a2c = load_spectral(WINDOW)
    spec_dates = set(c2c.keys())
    rets, dates_arr, times_arr, sorted_dates = load_returns_5m()
    sd_set = set(sorted_dates)

    if signal_date not in sd_set:
        _fail("returns_5m에 해당 날짜 5분봉 없음 (장중·미수집)", {"signal_date": signal_date})

    # 직전 spectral 스냅샷 날짜 (D-1 이전 중 가장 최근)
    tds = all_trading_dates()
    if signal_date not in tds:
        _fail("거래일 캘린더에 없음", {"signal_date": signal_date})
    i = tds.index(signal_date)
    prev = None
    for j in range(i - 1, -1, -1):
        if tds[j] in spec_dates:
            prev = tds[j]; break
    if prev is None:
        _fail("직전 spectral 스냅샷 없음", {"signal_date": signal_date})

    df_d = load_day_minutes(signal_date)
    if df_d is None or df_d.empty:
        _fail("당일 분봉 없음 (backtest parquet 미수집)", {"signal_date": signal_date})

    # 1) 아침 Top10 → drawer 클러스터
    morn = compute_morning_change(df_d)
    if morn.empty:
        _fail("morning change 계산 실패")
    top10 = morn.sort_values("ret", ascending=False).head(TOP_N_MORNING)
    pick = pick_drawer(top10, c2c.get(prev, {}), m2c.get(prev, {}), a2c.get(prev, {}))
    if pick is None:
        print(json.dumps({"ok": True, "signal_date": signal_date, "prev_date": prev,
                          "picks": [], "diag": {"reason": "활성 클러스터 없음"}}, ensure_ascii=False))
        return
    cid, cnt = pick
    members = m2c[prev][cid]
    avg_corr = float(a2c.get(prev, {}).get(cid, float("nan")))

    # 2) 클러스터 필터 (avg_corr≥0.15, size≥8)
    if (avg_corr == avg_corr and avg_corr < CORR_MIN) or len(members) < SIZE_MIN:
        print(json.dumps({"ok": True, "signal_date": signal_date, "prev_date": prev,
                          "picks": [], "diag": {"reason": f"클러스터 필터 미달 corr={avg_corr:.3f} size={len(members)}"}},
                         ensure_ascii=False))
        return

    # 3) 14:30 편차 → laggard(편차 최저) bottom_n
    dev = compute_dev_cut(members, rets, dates_arr, times_arr, sorted_dates, signal_date, CUTOFF)
    if dev is None or len(dev) < 2:
        _fail("편차 계산 실패 또는 멤버 부족")
    lag = dev.tail(BOTTOM_N).iloc[::-1].reset_index(drop=True)  # rank0=가장 laggard

    df_prev = load_day_minutes(prev)
    pcm = prev_close_map(df_prev)

    cands = []
    for lag_rank, row in lag.iterrows():
        code = str(row["code"]); dv = float(row["deviation"])
        entry = close_at(df_d, code, ENTRY_T)  # 14:50 close
        if entry is None:
            continue
        # 가격대 필터
        if not (PRICE_LO <= entry <= PRICE_HI):
            continue
        # 상한가 잠김 제외
        pc = pcm.get(code)
        if pc and entry >= round(pc * 1.30) * LIMIT_TOL:
            continue
        cands.append({"code": code, "entry": entry, "lag_rank": int(lag_rank),
                      "deviation": dv, "avg_corr": avg_corr, "cluster_size": len(members)})

    # 4) cap2 (lag_rank 오름차순 head)
    cands.sort(key=lambda x: x["lag_rank"])
    picks = cands[:DAILY_CAP]
    w = round(1.0 / len(picks), 6) if picks else 0
    for p in picks:
        p["weight"] = w

    print(json.dumps({
        "ok": True, "signal_date": signal_date, "prev_date": prev,
        "picks": picks,
        "diag": {"cluster_id": int(cid), "cluster_count": int(cnt), "avg_corr": avg_corr,
                 "cluster_size": len(members), "n_candidates": len(cands), "n_picks": len(picks)},
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
