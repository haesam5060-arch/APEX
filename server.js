// ═══════════════════════════════════════════════════════════════
// APEX — h7 갭업 + 클러스터 당일익절 엔진 (2026-05-31)
// 09:00 갭업(10%) + 거래량(5배) + cluster(avg_corr≥0.42) → 09:01 정적 매수 → [당일 +5% 익절 OR D+1 시초가 매도]
// NEMESIS 호환 API (대시보드 공용)
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const scheduler = require('./src/scheduler');
const { db, log, stmts } = require('./src/db');
const { isBuyBlocked, todayYmd } = require('./src/no-buy-calendar');
const { pollPrices } = require('./src/stock-fetcher');

const PORT           = parseInt(process.env.PORT) || 3100;
const TRADING_MODE   = process.env.TRADING_MODE || 'paper-self';
const TOTAL_CAPITAL  = parseInt(process.env.TOTAL_CAPITAL) || 500000;

const config = {
  version: '2.0.0',
  label:   'APEX v2.0.0 (h7 갭업 + 클러스터 + 당일익절 | 09:01 매수 → 당일+5%익절 OR D+1 시초가 매도)',
  tradingMode: TRADING_MODE,
  perStockBudget: Math.floor(TOTAL_CAPITAL / 2),  // nPicks=2 기준 50:50
  slots: 2,
  strategy: {
    totalCapital:          TOTAL_CAPITAL,
    clusterStrengthMin:    1.10,   // cluster_strength > 1.10 (10% 이상 돌파)
    changeRateMin:         0.25,   // OR change_rate > 25%
    changeRateExcludeMin:  0.20,   // 제외 구간 하한 (20%)
    changeRateExcludeMax:  0.25,   // 제외 구간 상한 (25% 미만)
    nPicks:                2,      // Top2 선정
    feeRoundTrip:          0.0035, // 왕복 수수료 (0.015% + 0.215% 세금)
  },
  schedule: {
    morning_sell:     '08:50',
    morning_snapshot: '09:31',
    afternoon_scan:   '14:30',
    buy:              '14:50',
  },
  kis: {
    appKey:        process.env.KIS_APP_KEY        || '',
    appSecret:     process.env.KIS_APP_SECRET     || '',
    cano:          process.env.KIS_CANO           || '',
    acntPrdtCd:    process.env.KIS_ACNT_PRDT_CD   || '01',
    paperAppKey:   process.env.KIS_PAPER_APP_KEY  || '',
    paperAppSecret:process.env.KIS_PAPER_APP_SECRET || '',
    paperCano:     process.env.KIS_PAPER_CANO     || '',
  },
  email: {
    enabled:     process.env.EMAIL_ENABLED === 'true',
    to:          process.env.EMAIL_TO          || 'haesam5060@gmail.com',
    from:        process.env.EMAIL_FROM        || process.env.EMAIL_TO || 'haesam5060@gmail.com',
    appPassword: process.env.EMAIL_APP_PASSWORD || '',
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },
};

// ── UI 모달에서 저장한 시크릿 머지 (data/config.json > .env) ──
const SECRETS_PATH = path.join(__dirname, 'data', 'config.json');

function _loadSecretsFromDisk() {
  if (!fs.existsSync(SECRETS_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    if (raw.kis)     Object.assign(config.kis, raw.kis);
    if (raw.email) {
      Object.assign(config.email, raw.email);
      if (raw.email.appPassword) config.email.enabled = true;
    }
    if (raw.discord) Object.assign(config.discord, raw.discord);
  } catch (e) {
    console.error('[CONFIG] data/config.json 로드 실패 (무시하고 .env 사용):', e.message);
  }
}

function _saveSecretsToDisk() {
  const dataDir = path.dirname(SECRETS_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const payload = {
    kis: {
      appKey: config.kis.appKey, appSecret: config.kis.appSecret, cano: config.kis.cano,
      acntPrdtCd: config.kis.acntPrdtCd,
      paperAppKey: config.kis.paperAppKey, paperAppSecret: config.kis.paperAppSecret,
      paperCano: config.kis.paperCano,
    },
    email:   { ...config.email },
    discord: { ...config.discord },
    _saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(payload, null, 2));
  try { fs.chmodSync(SECRETS_PATH, 0o600); } catch {}
}

_loadSecretsFromDisk();

// ── verifyConfig ─────────────────────────────────────────────
function verifyConfig() {
  const errs = [];
  if (config.tradingMode === 'real') {
    if (!config.kis.appKey || !config.kis.appSecret || !config.kis.cano)
      errs.push('TRADING_MODE=real 인데 KIS_APP_KEY/SECRET/CANO 미설정');
  }
  if (config.tradingMode === 'paper') {
    if (!config.kis.paperAppKey || !config.kis.paperAppSecret || !config.kis.paperCano)
      errs.push('TRADING_MODE=paper 인데 KIS_PAPER_APP_KEY/SECRET/CANO 미설정');
  }
  return errs;
}

// ── enrich positions (현재가 조회 후 P&L 계산) ───────────────
async function _enrichPositions(rawPositions) {
  if (rawPositions.length === 0) return [];
  const codes = rawPositions.map(p => p.code);
  let priceMap = {};
  try { priceMap = await pollPrices(codes); } catch (_) {}
  return rawPositions.map(p => {
    const buyAmt  = p.buy_price * p.qty;
    const tick    = priceMap[p.code];
    const cur     = tick?.close || p.buy_price;
    const evalAmt = cur * p.qty;
    const pnlAmt  = evalAmt - buyAmt;
    const pnlPct  = buyAmt > 0 ? (pnlAmt / buyAmt) * 100 : 0;
    return {
      ...p,
      buy_amt:       buyAmt,
      cur_price:     cur,
      price_session: tick?.session || 'regular',
      eval_amt:      evalAmt,
      pnl_amt:       pnlAmt,
      pnl_pct:       pnlPct,
    };
  });
}

// ── 당일 이벤트 조립 (대시보드 "최근 시그널" 카드) ──────────
// signal_log + pending_buy + trades를 시간순 평탄화
// NEMESIS 스타일 이벤트 모델:
//   'signal' / 'triggered_buy' / 'fallback_buy' / 'buy_skip' / 'excluded' / 'guard_skip' / 'progress'
//
// APEX는 현재 14:50 정적 매수만 지원하므로:
//   signal → pending_buy 생성 (매수 후보 대기)
//   → trade 체결 (14:50 매수 완료) = 'buy' 이벤트
//   → buy_skip (미체결)
function _buildTodayEvents() {
  const now         = new Date(Date.now() + 9 * 3600 * 1000);
  const todayYmdStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const todayIso    = now.toISOString().slice(0, 10);

  const signals  = stmts.signalsByDate.all(todayYmdStr);
  const pendings = stmts.getPendingsByDate.all(todayYmdStr);
  const trades   = stmts.tradesByBuyDate.all(todayIso);

  const events = [];

  // 스냅샷 건수 (당일)
  const snapCount = stmts.getMorningSnapshotCount.get(todayYmdStr);

  if (snapCount?.cnt > 0) {
    events.push({
      time_kst: `${todayIso}T09:31:00.000Z`,
      event:    'morning_snapshot',
      n_stocks: snapCount.cnt,
    });
  }

  // 스캔 결과 → signal 이벤트 (pick_code 있는 signal_log 행)
  const selectedSignals = signals.filter(s => s.pick_code);
  const tradeByCode = {};
  for (const t of trades) tradeByCode[t.code] = t;

  // 매수 후보 없음 (selected=0인데 try했거나 조건 미충족)
  if (selectedSignals.length === 0 && pendings.length === 0 && signals.length > 0) {
    // 아직 신호 발생 전이므로 skipped 처리 없음 (추후 로직 확장)
  }

  // 신호가 있는 경우: pending별로 signal + (체결 시) buy 또는 buy_skip
  const signalByCode = {};
  for (const sig of selectedSignals) {
    signalByCode[sig.pick_code] = sig;
  }

  for (const p of pendings) {
    const code = p.pick_code;
    const name = p.pick_name;
    const sig  = signalByCode[code] || selectedSignals[0]; // pending 연계 신호

    // 신호 이벤트 (rank별 1행)
    events.push({
      time_kst:         sig?.signal_at || p.created_at,
      event:            'signal',
      rank:             p.rank,
      code,
      name,
      change_rate:      sig?.pick_change_rate,
      cluster_corr:     sig?.pick_cluster_corr,
      market:           p.pick_market,
    });

    // 체결 또는 미체결 (consumed=1 → 체결, exit_type=blocked/failed → skip, 그 외 대기)
    const trade = tradeByCode[code];
    if (trade) {
      events.push({
        time_kst:    trade.buy_at,
        event:       'buy',
        rank:        p.rank,
        code,
        name,
        price:       trade.buy_price,
        qty:         trade.qty,
      });
    } else if (p.consumed && (p.exit_type === 'blocked' || p.exit_type === 'failed' || p.exit_type === 'low_price')) {
      // 미체결 (상한가 가드/차단/실패)
      events.push({
        time_kst:    p.buy_time ? `${todayIso}T${p.buy_time.slice(0,2)}:${p.buy_time.slice(2,4)}:00.000Z` : p.created_at,
        event:       'buy_skip',
        rank:        p.rank,
        code,
        name,
        reason:      p.exit_type,
      });
    } else if (!p.consumed) {
      // 매수 대기 중 (미체결 pending)
      events.push({
        time_kst:    p.created_at,
        event:       'pending',
        rank:        p.rank,
        code,
        name,
      });
    }
  }

  // 시간순 정렬 (동시각은 rank 오름차순)
  events.sort((a, b) => {
    if (a.time_kst !== b.time_kst) return a.time_kst < b.time_kst ? -1 : 1;
    return (a.rank || 0) - (b.rank || 0);
  });

  return events;
}

// ── Express ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 헬스체크
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: config.version, service: 'apex' });
});

// 메인 상태 (대시보드 폴링)
app.get('/api/status', async (req, res) => {
  const rawPositions  = stmts.getOpenPositions.all();
  const positions     = await _enrichPositions(rawPositions);
  const todayEvents   = _buildTodayEvents();
  const recentTrades  = stmts.recentTrades.all(20);
  const recentDaily   = stmts.recentDailyPnl.all(30);
  const totalPnl      = recentDaily.reduce((s, d) => s + d.pnl, 0);
  const evalTotal     = positions.reduce((s, p) => s + (p.eval_amt || 0), 0);
  const buyTotal      = positions.reduce((s, p) => s + p.buy_amt, 0);
  const pnlTotal      = positions.reduce((s, p) => s + (p.pnl_amt || 0), 0);

  // 당일 스냅샷 건수
  const todayYmdStr   = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const snapCount     = stmts.getMorningSnapshotCount.get(todayYmdStr);

  res.json({
    mode:             config.tradingMode,
    label:            config.label,
    version:          config.version,
    perStockBudget:   config.perStockBudget,
    slots:            config.slots,
    strategy:         config.strategy,
    schedule:         config.schedule,
    scan_log: {
      snapshot_date:  todayYmdStr,
      n_snapshot:     snapCount?.cnt ?? 0,
    },
    positions,
    positions_summary: {
      n:           positions.length,
      buy_total:   buyTotal,
      eval_total:  evalTotal,
      pnl_total:   pnlTotal,
    },
    recent_signals:  todayEvents,
    recent_trades:   recentTrades,
    recent_daily:    recentDaily,
    total_pnl:       totalPnl,
    buy_blocked:     isBuyBlocked(),
    server_time:     new Date().toISOString(),
  });
});

// 로그
app.get('/api/logs', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  res.json(stmts.recentLogs.all(limit));
});

// 체결 이력
app.get('/api/trades', (req, res) => {
  if (req.query.date) return res.json(stmts.tradesByDate.all(req.query.date));
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  res.json(stmts.recentTrades.all(limit));
});

// 보유 포지션
app.get('/api/positions', (req, res) => {
  res.json(stmts.getOpenPositions.all());
});

// 시그널 로그
app.get('/api/signals', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  res.json(stmts.recentSignals.all(limit));
});

// 일별 손익
app.get('/api/daily-pnl', (req, res) => {
  const limit = Math.min(120, parseInt(req.query.limit) || 30);
  res.json(stmts.recentDailyPnl.all(limit));
});

// 통계 요약
app.get('/api/stats', (req, res) => {
  const trades    = stmts.recentTrades.all(500);
  const pnls      = stmts.recentDailyPnl.all(120);
  const totalDays = pnls.length;
  const wins      = pnls.filter(p => p.pnl > 0).length;
  const losses    = pnls.filter(p => p.pnl < 0).length;
  const totalPnl  = pnls.reduce((s, p) => s + (p.pnl || 0), 0);
  const avgPnl    = totalDays > 0 ? totalPnl / totalDays : 0;
  const avgDailyReturnPct = totalDays > 0
    ? +(pnls.reduce((s, p) => s + (p.avg_pct || 0), 0) / totalDays).toFixed(2) : 0;
  const avgStocksPerDay = totalDays > 0
    ? +(pnls.reduce((s, p) => s + (p.n_trades || 0), 0) / totalDays).toFixed(1) : 0;

  let peak = 0, maxDD = 0, cumPnl = 0;
  for (let i = pnls.length - 1; i >= 0; i--) {
    cumPnl += pnls[i].pnl || 0;
    if (cumPnl > peak) peak = cumPnl;
    if (peak - cumPnl > maxDD) maxDD = peak - cumPnl;
  }

  let maxProfitPct = 0, maxLossPct = 0, stockWins = 0, profitSum = 0, lossSum = 0, avgReturnPct = 0;
  if (trades.length > 0) {
    const pcts   = trades.map(t => (t.return_pct || 0) * 100);
    maxProfitPct = Math.max(...pcts);
    maxLossPct   = Math.min(...pcts);
    stockWins    = trades.filter(t => t.pnl > 0).length;
    profitSum    = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    lossSum      = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    avgReturnPct = +(pcts.reduce((s, v) => s + v, 0) / trades.length).toFixed(2);
  }

  let cumReturnCompoundPct = 0;
  if (pnls.length > 0) {
    const compound = pnls.reduce((acc, p) => acc * (1 + (p.avg_pct || 0) / 100), 1);
    cumReturnCompoundPct = +((compound - 1) * 100).toFixed(2);
  }

  const stockWinRate  = trades.length > 0 ? +(stockWins / trades.length * 100).toFixed(1) : 0;
  const profitFactor  = lossSum > 0 ? +(profitSum / lossSum).toFixed(2) : (profitSum > 0 ? 999 : 0);

  const kst           = new Date(Date.now() + 9 * 3600 * 1000);
  const todayStr      = kst.toISOString().slice(0, 10);
  const todayRealized = trades.filter(t => t.sell_date === todayStr).reduce((s, t) => s + (t.pnl || 0), 0);

  let currentLossStreak = 0;
  for (const p of pnls) { if (p.pnl < 0) currentLossStreak++; else break; }
  let maxLossStreak = 0, cur = 0;
  for (const p of pnls) { if (p.pnl < 0) { cur++; if (cur > maxLossStreak) maxLossStreak = cur; } else cur = 0; }

  res.json({
    ok: true, totalDays, wins, losses, draws: totalDays - wins - losses,
    totalPnl: Math.round(totalPnl), avgPnl: Math.round(avgPnl),
    avgReturnPct, avgDailyReturnPct, avgStocksPerDay,
    winRate: stockWinRate,
    maxProfitPct: +maxProfitPct.toFixed(2), maxLossPct: +maxLossPct.toFixed(2),
    cumReturnCompoundPct, maxDD: Math.round(maxDD), profitFactor,
    currentLossStreak, maxLossStreak, todayRealized: Math.round(todayRealized),
    n_trades: trades.length, n_days: totalDays,
    total_pnl: Math.round(totalPnl), win_rate: stockWinRate / 100, avg_pct: avgReturnPct,
  });
});

// 잔고 (paper-self)
app.get('/api/balance', async (req, res) => {
  const recent   = stmts.recentDailyPnl.all(120);
  const totalPnl = recent.reduce((s, d) => s + d.pnl, 0);

  const paperBroker   = require('./src/paper-broker');
  const pb            = paperBroker.getPaperBalance();
  const openPositions = paperBroker.getOpenPositions();
  const holdings = openPositions.map(p => ({
    code:      p.code,
    name:      p.name,
    qty:       p.qty,
    avgPrice:  p.buy_price,
    curPrice:  p.buy_price,
    evalAmt:   p.buy_price * p.qty,
    pnlAmt:    0,
    pnlPct:    0,
  }));
  const holdingsEval = holdings.reduce((s, h) => s + h.evalAmt, 0);
  const cash = pb?.cash ?? config.perStockBudget;

  res.json({
    ok: true, mode: config.tradingMode,
    deposit: cash, d2Deposit: cash,
    evalTotal: cash + holdingsEval, pnlTotal: totalPnl,
    holdings, total: totalPnl,
    paper: { cash, total: totalPnl },
    real:  { cash: 0, total: 0 },
    initialCapital:     pb?.initial_capital ?? config.strategy.totalCapital,
    realInitialCapital: 0,
  });
});

// 수동 트리거
app.post('/api/manual/morning-sell', async (req, res) => {
  try {
    log.info('API', '수동 08:50 매도 trigger');
    await scheduler.runMorningSell();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/manual/snapshot', async (req, res) => {
  try {
    log.info('API', '수동 09:31 스냅샷 trigger');
    await scheduler.runMorningSnapshotJob();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/manual/scan', async (req, res) => {
  try {
    log.info('API', '수동 14:30 스캔 trigger');
    await scheduler.runAfternoonScanJob();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/manual/buy', async (req, res) => {
  try {
    log.info('API', '수동 14:50 매수 trigger');
    await scheduler.runBuy();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 수동 매도 (UI 호환)
app.post('/api/sell', async (req, res) => {
  try {
    await scheduler.runMorningSell();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 수동 스캔 (UI 호환)
app.post('/api/scan', async (req, res) => {
  try {
    log.info('API', '수동 스캔 trigger');
    await scheduler.runAfternoonScanJob();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// NEMESIS 호환 스텁 endpoints (대시보드 에러 방지)
app.get('/api/top20', (req, res) => {
  const date    = req.query.date || todayYmd();
  const ymd     = date.replace(/-/g, '');
  const dateIso = ymd.length === 8
    ? `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`
    : date;
  const rows = stmts.selectedSignalsByDate.all(ymd);
  res.json({ date: dateIso, rows });
});

app.get('/api/top10', (req, res) => {
  const date = req.query.date || todayYmd();
  const ymd  = date.replace(/-/g, '');
  const rows = stmts.selectedSignalsByDate.all(ymd);
  res.json({ date, rows });
});

app.get('/api/orders-live',     (req, res) => res.json({ ok: true, orders: [] }));
app.get('/api/scan-result',     (req, res) => {
  const sigs = stmts.recentSignals.all(1);
  res.json({ ok: true, scanned: [], at: sigs[0]?.scan_at || null, last_signal: sigs[0] || null });
});
app.get('/api/websocket/status',(req, res) => res.json({ ok: true, running: false, message: 'APEX는 WS 미사용' }));
app.post('/api/websocket/start',(req, res) => res.json({ ok: true, message: 'WS 미사용' }));
app.post('/api/websocket/stop', (req, res) => res.json({ ok: true, message: 'WS 미사용' }));
app.get('/api/chart/:code',     (req, res) => res.json({ ok: true, code: req.params.code, candles: [] }));

app.get('/api/preset', (req, res) =>
  res.json({ ok: true, current: 'apex-v01', list: [{ id: 'apex-v01', label: config.label }] }));
app.get('/api/config/per-stock-budget', (req, res) =>
  res.json({ ok: true, value: config.perStockBudget }));
app.post('/api/config/per-stock-budget', (req, res) =>
  res.status(403).json({ ok: false, error: '.env 수정 후 서버 재시작' }));
app.get('/api/config/slots',   (req, res) => res.json({ ok: true, slots: 2 }));
app.post('/api/config/slots',  (req, res) =>
  res.status(403).json({ ok: false, error: 'APEX는 Top2 고정' }));
app.get('/api/config/cash-pct',(req, res) => res.json({ ok: true, value: 100 }));
app.post('/api/config/cash-pct',(req, res) => res.status(403).json({ ok: false }));

app.get('/api/buy-blocked', (req, res) => res.json(isBuyBlocked(req.query.date)));
app.get('/api/kis/health-check', (req, res) =>
  res.json({ ok: true, mode: config.tradingMode, message: 'paper-self는 KIS 미사용' }));
app.post('/api/toggle-mode',        (req, res) =>
  res.status(403).json({ ok: false, error: '.env의 TRADING_MODE 수정 + 재시작' }));
app.post('/api/toggle-real-trading',(req, res) =>
  res.status(403).json({ ok: false, error: '.env의 TRADING_MODE 수정 + 재시작' }));

// 시크릿 상태 조회
app.get('/api/config/secrets/status', (req, res) => {
  const mask = (v) => v ? (v.slice(0, 4) + '...' + v.slice(-4)) : null;
  res.json({
    ok:      true,
    real:    { appKey: !!config.kis.appKey, appSecret: !!config.kis.appSecret, cano: !!config.kis.cano, masked: mask(config.kis.appKey) },
    paper:   { appKey: !!config.kis.paperAppKey, appSecret: !!config.kis.paperAppSecret, cano: !!config.kis.paperCano, masked: mask(config.kis.paperAppKey) },
    discord: { configured: !!config.discord.webhookUrl },
    email: {
      appPassword: !!config.email.appPassword,
      enabled:     !!config.email.enabled,
      to:          config.email.to || null,
      ready:       !!(config.email.enabled && config.email.appPassword && config.email.to),
    },
    mode: config.tradingMode,
  });
});

// 시크릿 저장
app.post('/api/config/secrets', express.json(), (req, res) => {
  try {
    const { emailAppPassword, kisAppKey, kisAppSecret, kisCano } = req.body || {};
    const updated = [];

    if (typeof emailAppPassword === 'string' && emailAppPassword.length > 0) {
      config.email.appPassword = emailAppPassword.replace(/\s+/g, '');
      config.email.enabled     = true;
      updated.push('email');
    }
    if (typeof kisAppKey === 'string' && kisAppKey.length > 0) {
      config.kis.appKey = kisAppKey.trim();
      updated.push('kis_app_key');
    }
    if (typeof kisAppSecret === 'string' && kisAppSecret.length > 0) {
      config.kis.appSecret = kisAppSecret.trim();
      updated.push('kis_app_secret');
    }
    if (typeof kisCano === 'string' && kisCano.length > 0) {
      config.kis.cano = kisCano.trim();
      updated.push('kis_cano');
    }

    if (updated.length === 0)
      return res.status(400).json({ ok: false, error: '변경 사항 없음' });

    _saveSecretsToDisk();
    scheduler.reloadKis(config.kis);

    res.json({ ok: true, updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/mapping/reload', (req, res) =>
  res.json({ ok: true, n_themes: 0, n_companies: 0, n_mappings: 0, loaded_at: new Date().toISOString() }));

// ── 슬리피지 측정 API ──────────────────────────────────────────
// GET /api/slippage         — 전체 raw 기록 + 통계 + 합격 판정
// GET /api/slippage/report  — 판정 요약만 (마크다운 텍스트)
app.get('/api/slippage', (req, res) => {
  try {
    const rows  = stmts.getSlippageAll.all();
    const stats = stmts.getSlippageStats.get();
    const complete = rows.filter(r => r.status === 'complete');
    const rts = complete.map(r => r.roundtrip_bps).filter(v => v != null).sort((a, b) => a - b);
    const median = n => {
      if (!n.length) return null;
      const m = Math.floor(n.length / 2);
      return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
    };
    const p90 = n => n.length ? n[Math.floor(n.length * 0.9)] : null;
    const rtMed = median(rts);
    const rtP90 = p90(rts);

    // 합격 기준: 왕복 중앙값 <20bp(0.2%) → 합격 / 20~30bp → 경계 / >30bp → 불합격
    let gate = 'insufficient';   // 표본 < 30
    if (complete.length >= 30) {
      if (rtMed < 20)      gate = 'PASS';
      else if (rtMed < 30) gate = 'BORDERLINE';
      else                 gate = 'FAIL';
    }

    res.json({
      ok: true,
      gate,
      n_buy: rows.length,
      n_complete: complete.length,
      roundtrip_median_bps: rtMed != null ? Math.round(rtMed * 10) / 10 : null,
      roundtrip_p90_bps:    rtP90 != null ? Math.round(rtP90 * 10) / 10 : null,
      roundtrip_median_pct: rtMed != null ? Math.round(rtMed / 100 * 1000) / 1000 : null,
      note: complete.length < 30
        ? `표본 ${complete.length}/30 — 게이트 판정 대기 중`
        : `판정: ${gate} (중앙값 ${rtMed != null ? (rtMed/100).toFixed(2) : '?'}%)`,
      stats,
      rows: req.query.detail === '1' ? rows : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/slippage/report', (req, res) => {
  try {
    const complete = stmts.getSlippageAll.all().filter(r => r.status === 'complete');
    const rts = complete.map(r => r.roundtrip_bps).filter(v => v != null).sort((a, b) => a - b);
    const median = n => n.length ? (n.length % 2 ? n[Math.floor(n.length/2)] : (n[Math.floor(n.length/2)-1]+n[Math.floor(n.length/2)])/2) : null;
    const rtMed = median(rts);
    const gate = complete.length < 30 ? 'insufficient'
               : rtMed < 20 ? 'PASS' : rtMed < 30 ? 'BORDERLINE' : 'FAIL';
    const lines = [
      `# APEX 슬리피지 측정 리포트`,
      `- 측정 기간: ${complete[complete.length-1]?.date ?? '-'} ~ ${complete[0]?.date ?? '-'}`,
      `- 완료 표본: ${complete.length} / 30 (게이트 기준)`,
      `- 왕복 슬리피지 중앙값: ${rtMed != null ? (rtMed/100).toFixed(2) : '-'}% (${rtMed?.toFixed(1) ?? '-'}bp)`,
      `- 왕복 p90: ${rts.length ? (rts[Math.floor(rts.length*0.9)]/100).toFixed(2) : '-'}%`,
      ``,
      `## 판정: ${gate === 'PASS' ? '✅ PASS — 실전화 진행 가능' : gate === 'BORDERLINE' ? '⚠️ BORDERLINE — 유동성 필터 후 재측정' : gate === 'FAIL' ? '❌ FAIL — 실전화 보류' : '⏳ 표본 부족 ('+complete.length+'/30)'}`,
      ``,
      `기준: 중앙값 <0.20% PASS / 0.20~0.30% BORDERLINE / >0.30% FAIL`,
    ];
    res.type('text/plain').send(lines.join('\n'));
  } catch (e) {
    res.status(500).send('error: ' + e.message);
  }
});

// ── boot ─────────────────────────────────────────────────────
const errs = verifyConfig();
if (errs.length > 0) {
  console.error('=========================================');
  console.error('  APEX 설정 오류 — 서버 시작 차단');
  for (const e of errs) console.error('   - ' + e);
  console.error('=========================================');
  process.exit(1);
}

scheduler.start(config);

// LAN 노출 차단 — 127.0.0.1 only. 외부 접근은 reverse proxy 경유.
app.listen(PORT, '127.0.0.1', () => {
  log.info('SERVER',
    `APEX 가동 — http://127.0.0.1:${PORT} [mode=${config.tradingMode}, capital=${config.strategy.totalCapital.toLocaleString()}원]`);
});
