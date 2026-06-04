// ═══════════════════════════════════════════════════════════════
// APEX 대시보드 프론트엔드
// 모닝 클러스터 오버나잇 전략: 14:30 스캔 → 14:50 매수 → T+1 09:01 매도
// ═══════════════════════════════════════════════════════════════

const API = '';
let refreshInterval = null;
let countdown = 30;
let currentMode = 'paper-self';
let realAutoTrading = false;
let _openDetailDate = null;
let _refreshSeq = 0;

function fmtTradeMD(dateStr) {
  if (!dateStr) return '-';
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '-';
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

const MODE_LABEL = {
  'paper-self': { badge: 'PAPER', title: '시뮬레이션', tooltip: '자체 매매 simulate (실주문 X)' },
  'real':       { badge: 'REAL',  title: '실전',       tooltip: 'KIS 실계좌 자동매매' },
};

// ── API 호출 ─────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { window.location.href = '/'; return null; }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      console.warn(`API 비정상 응답 [${path}] status=${res.status} ct=${ct}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`API 에러 [${path}]:`, e);
    return null;
  }
}

// ── 토스트 알림 ──────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── 버튼 로딩 상태 ──────────────────────────────────────────
function setLoading(btn, loading) {
  if (loading) {
    btn._origText = btn.textContent;
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.textContent = btn._origText || btn.textContent;
    btn.disabled = false;
  }
}

// ── paper-self 보유 종목 렌더링 ──────────────────────────────
function renderPaperPositions(positions) {
  const posBody = document.getElementById('positionsTable');
  if (!posBody) return;

  if (!positions || positions.length === 0) {
    posBody.innerHTML = '<tr><td colspan="6" class="empty-msg">보유 종목 없음 — T+1 09:01 매도 대기</td></tr>';
    return;
  }

  let totalBuyAmt = 0, totalPnlAmt = 0;
  const rows = positions.map(p => {
    const buyAmt = p.buy_amt || (p.buy_price * p.qty);
    const pnlPct = p.pnl_pct;
    const pnlAmt = p.pnl_amt;
    const hasPrice = p.cur_price && p.cur_price > 0;
    totalBuyAmt += buyAmt;
    if (hasPrice) totalPnlAmt += (pnlAmt || 0);

    const pnlClass = !hasPrice ? '' : (pnlAmt >= 0 ? 'pnl-pos' : 'pnl-neg');
    const pnlPctStr = !hasPrice ? '-' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
    const pnlAmtStr = !hasPrice ? '시세 조회 중' : `${pnlAmt >= 0 ? '+' : ''}${Math.round(pnlAmt).toLocaleString()}원`;

    const clusterLabel = p.cluster_strength
      ? `<span style="font-size:10.5px;color:var(--accent);">x${Number(p.cluster_strength).toFixed(2)}</span>`
      : '-';

    const curPriceStr = hasPrice ? p.cur_price.toLocaleString() : '--';

    return `<tr style="white-space:nowrap;">
      <td style="max-width:96px;">
        <span class="stock-link" data-code="${p.code}" data-name="${p.name}" title="${p.name}" style="display:inline-block;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;">${p.name}</span>
        <br><span style="font-size:11px;color:var(--dim);">${p.code}</span>
      </td>
      <td style="max-width:70px;">${clusterLabel}</td>
      <td>${p.qty}</td>
      <td>${(p.buy_price || 0).toLocaleString()}<br><span style="font-size:11px;color:var(--dim);">→ ${curPriceStr}</span></td>
      <td>${buyAmt.toLocaleString()}원</td>
      <td class="${pnlClass}">${pnlPctStr}<br><span style="font-size:11px;">${pnlAmtStr}</span></td>
    </tr>`;
  }).join('');

  const totalPnlClass = totalPnlAmt >= 0 ? 'pnl-pos' : 'pnl-neg';
  posBody.innerHTML = rows + `<tr style="border-top:2px solid var(--border);font-weight:700;white-space:nowrap;">
    <td colspan="4" style="text-align:right;color:var(--dim);">합계</td>
    <td>${totalBuyAmt.toLocaleString()}원</td>
    <td class="${totalPnlClass}">${totalPnlAmt >= 0 ? '+' : ''}${Math.round(totalPnlAmt).toLocaleString()}원 (평가)</td></tr>`;
}

// ── 상태 업데이트 ────────────────────────────────────────────
async function refreshStatus() {
  const mySeq = _refreshSeq;
  const data = await api('/api/status');
  if (!data) return;
  if (mySeq !== _refreshSeq) return;

  currentMode = data.mode || 'paper-self';
  realAutoTrading = data.realAutoTrading || false;
  document.body.className = currentMode === 'real' ? 'mode-real' : 'mode-paper-self';

  const modeBadge = document.getElementById('modeBadge');
  if (modeBadge) {
    const info = MODE_LABEL[currentMode] || MODE_LABEL['paper-self'];
    modeBadge.textContent = info.badge;
    modeBadge.title = info.tooltip;
  }
  const autoStatusText = document.getElementById('realTradingStatusText');
  if (autoStatusText) {
    autoStatusText.textContent = currentMode === 'paper-self'
      ? 'SIM'
      : (realAutoTrading ? 'ON' : 'OFF');
  }
  document.title = currentMode === 'paper-self'
    ? '🟡 [SIM] APEX'
    : (realAutoTrading ? '🔵 [실전 ON] APEX' : '⬜ [실전 OFF] APEX');

  const realBtn = document.getElementById('realTradingBtn');
  if (realBtn) {
    realBtn.classList.toggle('on', realAutoTrading);
    realBtn.classList.toggle('off', !realAutoTrading);
    const label = document.getElementById('realTradingBtnLabel');
    if (label) label.textContent = realAutoTrading ? 'ON' : 'OFF';
  }

  // 예산 설정 hydrate
  hydrateSettingsReadonly(data);

  // 보유 종목
  let positions = data.positions || [];
  const posBody = document.getElementById('positionsTable');
  if (posBody) {
    if (currentMode === 'paper-self') {
      renderPaperPositions(positions);
    }
    const pc = document.getElementById('positionCount');
    if (pc) pc.textContent = `${positions.length}종목`;
  }

  // 누적 손익 KPI
  const totalPnl = data.total_pnl || 0;
  const totalEl = document.getElementById('totalPnl');
  if (totalEl) {
    totalEl.textContent = `${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}원`;
    totalEl.className = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
  }

  // 스캔 현황 KPI
  const scanLog = data.scanLog || data.scan_log || [];
  const scanEl = document.getElementById('scanSummaryCount');
  const scanSubEl = document.getElementById('scanSummarySub');
  if (scanEl) {
    const total = scanLog.length;
    const bought = scanLog.filter(s => s.status === 'bought' || s.filled).length;
    const pending = scanLog.filter(s => s.status === 'pending' || (s.pending && !s.filled)).length;
    scanEl.innerHTML = `${total}<small>건</small>`;
    if (scanSubEl) {
      scanSubEl.innerHTML = `<span class="mini pos">매수 ${bought}</span><span class="sep">·</span><span class="mini">대기 ${pending}</span>`;
    }
  }

  // 당일 스캔 흐름 — scan_flow(scan_log) 단일 소스 렌더 (09:31 스냅샷 → 14:30 스캔 → 14:50 매수)
  renderApexSignals(data.scan_log || data.scanLog || []);

  // 당일 손익
  await _renderTodayPnlAndKpi(data);
}

// ── APEX 스캔 로그 렌더링 ────────────────────────────────────
// scan_log 항목: { time, code, name, cluster_strength, change_rate, entry_price, status }
function renderApexSignals(items) {
  const body = document.getElementById('signalsTable');
  const cnt = document.getElementById('signalsCount');
  if (!body) return;
  const arr = Array.isArray(items) ? items : [];
  if (cnt) cnt.textContent = `${arr.length}건`;

  if (arr.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-msg">대기 중 — 평일 09:31 모닝 스냅샷 → 14:30 클러스터 스캔 → 14:50 매수 순으로 누적됩니다</td></tr>';
    return;
  }

  const fmtTime = (v) => {
    if (!v) return '--';
    if (typeof v === 'string' && v.length === 5) return v; // HH:MM
    const t = new Date(v);
    if (isNaN(t)) return v;
    const kst = new Date(t.getTime() + 9 * 3600 * 1000);
    return `${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`;
  };
  const fmtChg = (v) => {
    if (v == null) return '-';
    const n = Number(v);
    const pct = Math.abs(n) > 1 ? n : n * 100; // 소수 or 퍼센트 자동 판별
    const sign = pct >= 0 ? '+' : '';
    const color = pct >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${color};font-weight:600;">${sign}${pct.toFixed(2)}%</span>`;
  };
  const fmtStrength = (v) => {
    if (v == null) return '-';
    const n = Number(v);
    const color = n >= 1.25 ? 'var(--green)' : n >= 1.1 ? 'var(--accent)' : 'var(--dim)';
    return `<span style="color:${color};font-weight:700;">×${n.toFixed(2)}</span>`;
  };
  const fmtPrice = (v) => v != null ? Number(v).toLocaleString() + '원' : '-';

  const STATUS_META = {
    'snapshot': { label: '9:31 스냅샷', color: '#60a5fa',       bg: 'rgba(96,165,250,0.08)',  border: '#60a5fa' },
    'scanned':  { label: '14:30 스캔',  color: 'var(--accent)',  bg: 'rgba(34,211,238,0.06)',  border: 'var(--accent)' },
    'selected': { label: '매수 선정',   color: 'var(--yellow)',  bg: 'rgba(251,191,36,0.08)',  border: 'var(--yellow)' },
    'bought':   { label: '매수 완료',   color: 'var(--green)',   bg: 'rgba(74,222,128,0.10)',  border: 'var(--green)' },
    'pending':  { label: '체결 대기',   color: 'var(--yellow)',  bg: 'rgba(251,191,36,0.08)',  border: 'var(--yellow)' },
    'sold':     { label: 'T+1 매도',    color: 'var(--accent)',  bg: 'rgba(34,211,238,0.10)',  border: 'var(--accent)' },
    'excluded': { label: '제외',        color: 'var(--dim)',     bg: 'rgba(148,163,184,0.04)', border: '#64748b' },
  };

  function getStatusMeta(s) {
    const st = (s.status || '').toLowerCase();
    if (STATUS_META[st]) return STATUS_META[st];
    if (s.filled || s.sold) return { label: 'T+1 매도', color: 'var(--accent)', bg: 'rgba(34,211,238,0.10)', border: 'var(--accent)' };
    if (s.pending) return { label: '체결 대기', color: 'var(--yellow)', bg: 'rgba(251,191,36,0.08)', border: 'var(--yellow)' };
    return { label: st || '--', color: 'var(--dim)', bg: '', border: 'transparent' };
  }

  body.innerHTML = arr.map(s => {
    const meta = getStatusMeta(s);
    const rowStyle = `background:${meta.bg};border-left:3px solid ${meta.border};`;
    const badge = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;background:${meta.bg};color:${meta.color};border:1px solid ${meta.border};">${meta.label}</span>`;
    const changeRate = s.change_rate ?? s.changeRate ?? s.chg;
    const clusterStrength = s.cluster_strength ?? s.clusterStrength;
    const entryPrice = s.entry_price ?? s.entryPrice ?? s.buy_price ?? s.buyPrice;

    return `<tr style="${rowStyle}">
      <td class="mono">${fmtTime(s.time || s.ts || s.timestamp)}</td>
      <td>
        <span class="stock-link" data-code="${s.code || ''}" data-name="${s.name || s.code || ''}">${s.name || s.code || '--'}</span>
        <br><span style="color:var(--dim);font-size:10px;">${s.code || ''}</span>
      </td>
      <td class="num">${fmtStrength(clusterStrength)}</td>
      <td class="num">${fmtChg(changeRate)}</td>
      <td class="num">${fmtPrice(entryPrice)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join('');
}

// ── 당일 손익 패널 + KPI ─────────────────────────────────────
async function _renderTodayPnlAndKpi(data) {
  const dailyPnl = (data.recent_daily || data.dailyPnl || []).map(d => ({
    date: d.date || d.sell_date,
    stocks: d.stocks ?? d.n_trades,
    buyTotal: d.buyTotal ?? d.buy_total,
    pnl: d.pnl,
    avgPct: d.avgPct ?? d.avg_pct,
    n_stopped: d.n_stopped,
  }));
  await renderTodayPnl(dailyPnl[0], data.scanLog || data.scan_log || []);

  const totalPnl = data.total_pnl ?? data.totalPnl ?? 0;
  const pnlEl = document.getElementById('totalPnl');
  if (pnlEl) {
    pnlEl.className = `kpi-value ${totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : ''}`;
    pnlEl.textContent = `${totalPnl > 0 ? '+' : ''}${totalPnl.toLocaleString()}원`;
  }

  const todaySoldCountEl = document.getElementById('todaySoldCount');
  const todaySoldSubEl = document.getElementById('todaySoldSub');
  const todayRealizedEl = document.getElementById('todayRealized');
  const todayRealizedSubEl = document.getElementById('todayRealizedSub');
  const today0 = dailyPnl[0];
  const _d = new Date();
  const _todayStr = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  const hasDate = today0 && today0.date;
  const dateChipPlain = hasDate ? `<span class="mini dim">${today0.date.slice(5)}</span>` : '';
  const isPastDate = hasDate && today0.date !== _todayStr;
  const dateChipSep = isPastDate ? `<span class="mini dim">${today0.date.slice(5)}</span><span class="sep">·</span>` : '';

  if (todayRealizedEl) {
    const pnl = today0 ? today0.pnl : 0;
    todayRealizedEl.textContent = pnl ? `${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원` : '0원';
    todayRealizedEl.className = `kpi-value ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}`;
  }
  if (todayRealizedSubEl) todayRealizedSubEl.innerHTML = dateChipPlain;

  if (todaySoldCountEl && todaySoldSubEl) {
    if (today0 && today0.stocks > 0) {
      todaySoldCountEl.innerHTML = `${today0.stocks}<small>종목</small>`;
      todaySoldCountEl.className = 'kpi-value';
      const avgPct = today0.avgPct != null ? Number(today0.avgPct) : (today0.buyTotal ? today0.pnl / today0.buyTotal * 100 : 0);
      const avgCls = avgPct > 0 ? 'pos' : avgPct < 0 ? 'neg' : 'dim';
      const pnlCls = today0.pnl > 0 ? 'pos' : today0.pnl < 0 ? 'neg' : 'dim';
      todaySoldSubEl.innerHTML = `${dateChipSep}<span class="mini ${avgCls}">평균 ${avgPct > 0 ? '+' : ''}${avgPct.toFixed(2)}%</span><span class="sep">·</span><span class="mini ${pnlCls}">손익 ${today0.pnl > 0 ? '+' : ''}${Math.round(today0.pnl).toLocaleString()}</span>`;
    } else {
      todaySoldCountEl.innerHTML = `0<small>종목</small>`;
      todaySoldCountEl.className = 'kpi-value dim';
      todaySoldSubEl.innerHTML = '<span class="mini dim">매도 이력 없음</span>';
    }
  }

  window._dailyPnl = dailyPnl;
}

// ── 당일 손익 카드 렌더링 ────────────────────────────────────
async function renderTodayPnl(today0, scanLog = []) {
  const dateLabelEl = document.getElementById('todayDateLabel');
  const totalMetaEl = document.getElementById('todayTotalMeta');
  const summaryEl = document.getElementById('todaySummary');
  const tableEl = document.getElementById('todayTable');
  if (!tableEl) return;

  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  })();
  const date = today0 ? today0.date : todayStr;
  if (dateLabelEl) dateLabelEl.textContent = date;

  if (!today0 || !today0.stocks) {
    if (totalMetaEl) totalMetaEl.innerHTML = '<span class="dim">오늘 매도 없음</span>';
    if (summaryEl) summaryEl.innerHTML = '';
    tableEl.innerHTML = '<tr><td colspan="10" class="empty-msg">오늘 매도 내역 없음 (T+1 09:01 매도)</td></tr>';
    return;
  }

  const pnl = today0.pnl || 0;
  const avgPct = today0.avgPct != null
    ? Number(today0.avgPct)
    : (today0.buyTotal ? pnl / today0.buyTotal * 100 : 0);
  const pnlCls = pnl > 0 ? 'pnl-pos' : pnl < 0 ? 'pnl-neg' : 'dim';
  const avgCls = avgPct > 0 ? 'pnl-pos' : avgPct < 0 ? 'pnl-neg' : 'dim';

  if (totalMetaEl) {
    totalMetaEl.innerHTML = `<span class="${pnlCls}">${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원</span> <span class="dim" style="margin-left:6px;">· 평균 <span class="${avgCls}">${avgPct > 0 ? '+' : ''}${avgPct.toFixed(2)}%</span></span>`;
  }
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="sum-kpi"><div class="k">매도 종목</div><div class="v">${today0.stocks}<small style="font-size:10px;color:var(--dim);font-weight:500;margin-left:3px;">종목</small></div></div>
      <div class="sum-kpi"><div class="k">매수금액 합계</div><div class="v">${today0.buyTotal ? Math.round(today0.buyTotal).toLocaleString() : '-'}<small style="font-size:10px;color:var(--dim);font-weight:500;margin-left:3px;">${today0.buyTotal ? '원' : ''}</small></div></div>
      <div class="sum-kpi"><div class="k">실현 손익</div><div class="v ${pnlCls}">${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}<small style="font-size:10px;color:var(--dim);font-weight:500;margin-left:3px;">원</small></div></div>
      <div class="sum-kpi"><div class="k">평균 수익률</div><div class="v ${avgCls}">${avgPct > 0 ? '+' : ''}${avgPct.toFixed(2)}<small style="font-size:10px;color:var(--dim);font-weight:500;margin-left:3px;">%</small></div></div>
    `;
  }

  const trades = await api(`/api/trades?date=${date}`);
  if (!trades || trades.length === 0) {
    tableEl.innerHTML = '<tr><td colspan="10" class="empty-msg">매도 체결 기록 없음</td></tr>';
    return;
  }

  const scanMap = {};
  for (const s of scanLog) scanMap[s.code] = s;
  const isToday = date === todayStr;

  const sells = trades.map(t => {
    const buyPrice = t.buy_price ?? t.buyPrice ?? 0;
    const sellPrice = t.sell_price ?? t.sellPrice ?? 0;
    const qty = t.qty || 0;
    const pnlVal = t.pnl || 0;
    const buyAmt = buyPrice * qty;
    const pnlPct = buyAmt > 0 ? (pnlVal / buyAmt * 100) : 0;
    const exitReason = t.exit_reason ?? t.exitReason ?? '';
    let phase = 'overnight';
    if (exitReason === 'stop_loss') phase = 'stopLoss';
    else if (exitReason && exitReason.startsWith('manual_')) phase = 'manualSell';
    return { ...t, buyPrice, sellPrice, qty, pnl: pnlVal, pnlPct, phase };
  });

  let totalQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0;
  const rowsHtml = sells.map(s => {
    const qty = s.qty || 0;
    const pnl = s.pnl || 0;
    const pct = s.pnlPct || 0;
    const buyAmt = Math.round((s.buyPrice || 0) * qty);
    const sellAmt = Math.round((s.sellPrice || 0) * qty);
    const liveScan = isToday ? scanMap[s.code] : null;
    const chgRate = (liveScan && liveScan.prevClose > 0)
      ? ((liveScan.close - liveScan.prevClose) / liveScan.prevClose) * 100
      : null;
    totalQty += qty; totalBuyAmt += buyAmt; totalSellAmt += sellAmt; totalPnl += pnl;
    const pnlCls = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const pctCls = pct >= 0 ? 'pnl-pos' : 'pnl-neg';
    const chgCls = chgRate == null ? 'dim' : chgRate >= 0 ? 'pnl-pos' : 'pnl-neg';
    const chgText = chgRate == null ? '-' : `${chgRate > 0 ? '+' : ''}${chgRate.toFixed(1)}%`;
    let badgeLabel, badgeCls;
    if (s.phase === 'stopLoss')    { badgeLabel = '손절'; badgeCls = 'badge-stopLoss'; }
    else if (s.phase === 'manualSell') { badgeLabel = '수동매도'; badgeCls = 'badge-manual'; }
    else                           { badgeLabel = 'T+1 시가매도'; badgeCls = 'badge-overnight'; }
    return `
      <tr>
        <td class="stock-name"><span class="stock-link" data-code="${s.code}" data-name="${s.name || s.code}">${s.name || s.code}</span></td>
        <td><span class="badge ${badgeCls}">${badgeLabel}</span></td>
        <td class="num">${qty}</td>
        <td class="num dim">${Math.round(s.buyPrice || 0).toLocaleString()}<small style="font-size:10px;color:var(--dim);font-weight:500;margin-left:2px;">원</small><small style="font-size:10px;color:var(--dim);font-weight:400;margin-left:3px;">(${fmtTradeMD(s.buy_date)})</small></td>
        <td class="num dim">${buyAmt.toLocaleString()}</td>
        <td class="num">${Math.round(s.sellPrice || 0).toLocaleString()}<small style="font-size:10px;color:var(--dim);font-weight:500;margin-left:2px;">원</small><small style="font-size:10px;color:var(--dim);font-weight:400;margin-left:3px;">(${fmtTradeMD(s.sell_date)})</small></td>
        <td class="num">${sellAmt.toLocaleString()}</td>
        <td class="num ${chgCls}">${chgText}</td>
        <td class="num ${pnlCls}">${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원</td>
        <td class="num ${pctCls}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</td>
      </tr>`;
  }).join('');
  const totalPnlCls = totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg';
  const totalFooter = sells.length > 1 ? `
    <tr style="border-top:2px solid var(--border);font-weight:700;">
      <td class="dim">합계</td><td></td>
      <td class="num">${totalQty}</td><td></td>
      <td class="num dim">${totalBuyAmt.toLocaleString()}</td><td></td>
      <td class="num">${totalSellAmt.toLocaleString()}</td><td></td>
      <td class="num ${totalPnlCls}">${totalPnl > 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}원</td><td></td>
    </tr>` : '';
  tableEl.innerHTML = rowsHtml + totalFooter;
}

// ── 통계 갱신 ────────────────────────────────────────────────
async function refreshStats() {
  const data = await api('/api/stats');
  if (!data) return;

  const sign = n => (n > 0 ? '+' : '');
  const cls = n => (n > 0 ? 'positive' : n < 0 ? 'negative' : '');
  const set = (id, text, className) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (className !== undefined) el.className = className;
  };
  const setSub = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  setSub('totalPnlSub', data.totalDays > 0 ? `${data.totalDays}거래일 · 승일 ${data.wins} / 패일 ${data.losses}` : '거래 없음');

  const avgR = data.avgReturnPct;
  const avgEl = document.getElementById('avgReturn');
  if (avgEl) {
    avgEl.textContent = avgR != null ? `${sign(avgR)}${avgR}%` : '--%';
    avgEl.className = `stat-value ${cls(avgR)}`;
  }
  setSub('avgReturnSub', data.totalDays > 0 ? `종목 평균 · 승률 ${data.winRate}%` : '종목 평균');

  const avgPnl = data.avgPnl;
  const avgPnlEl = document.getElementById('avgPnl');
  if (avgPnlEl) {
    avgPnlEl.textContent = data.totalDays > 0 ? `${sign(avgPnl)}${avgPnl.toLocaleString()}원` : '--';
    avgPnlEl.className = `stat-value ${cls(avgPnl)}`;
  }
  const avgDR = data.avgDailyReturnPct;
  const avgDREl = document.getElementById('avgDailyReturn');
  if (avgDREl) {
    avgDREl.textContent = data.totalDays > 0 ? `${sign(avgDR)}${avgDR}%` : '--%';
  }

  const cr = data.cumReturnCompoundPct;
  set('cumReturnCompound',
    (cr === null || cr === undefined) ? '--%' : `${cr >= 0 ? '+' : ''}${cr}%`,
    `stat-value ${cr > 0 ? 'positive' : cr < 0 ? 'negative' : ''}`);
  set('maxLoss', data.maxLossPct != null && data.maxLossPct !== 0 ? `${data.maxLossPct}%` : '--%',
    `stat-value ${data.maxLossPct < 0 ? 'negative' : ''}`);

  const pf = data.profitFactor;
  const pfEl = document.getElementById('profitFactor');
  if (pfEl) {
    const display = pf === 999 ? '∞' : (pf > 0 ? pf.toFixed(2) : '--');
    pfEl.textContent = display;
    pfEl.className = `stat-value ${pf >= 1.5 ? 'positive' : pf >= 1.0 ? '' : pf > 0 ? 'warn' : 'negative'}`;
  }
  setSub('profitFactorSub', pf >= 1.5 ? '건전 (≥1.5)' : pf >= 1.0 ? '유지 (≥1.0)' : pf > 0 ? '주의 (<1.0)' : '이익÷손실');

  const mdd = data.maxDD || 0;
  const mddEl = document.getElementById('maxDD');
  if (mddEl) {
    mddEl.textContent = mdd > 0 ? `-${mdd.toLocaleString()}원` : '0원';
    mddEl.className = `stat-value ${mdd > 0 ? 'negative' : ''}`;
  }

  const losses = data.currentLossStreak || 0;
  const lossMax = data.maxLossStreak || 0;
  const lossEl = document.getElementById('lossStreak');
  if (lossEl) {
    lossEl.textContent = losses > 0 ? `${losses}일` : '0일';
    lossEl.className = `stat-value ${losses >= 3 ? 'negative' : losses >= 2 ? 'warn' : ''}`;
  }
  setSub('lossStreakSub', lossMax > 0 ? `역대 최장 ${lossMax}일` : '역대 최장 0일');

  set('tradingDays', `${data.totalDays}일`);
  setSub('winRate', `승률 ${data.winRate}%`);

  const avgStocks = data.avgStocksPerDay;
  set('avgStocks', data.totalDays > 0 && avgStocks != null ? `${avgStocks}종목` : '--');

  // 스파크라인
  const dailyPnl = window._dailyPnl || [];
  if (dailyPnl.length > 0) {
    renderSparkline('sparkPnl', dailyPnl.map(p => p.pnl).reverse(), { unit: 'currency' });
  }
}

// ── 스파크라인 ───────────────────────────────────────────────
function renderSparkline(elId, values, { unit = 'currency' } = {}) {
  const el = document.getElementById(elId);
  if (!el || values.length === 0) return;
  const w = el.clientWidth || 200;
  const h = 28;
  const pad = 2;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const toY = v => h - pad - ((v - min) / range) * (h - pad * 2);
  const last = values[values.length - 1];
  const color = last >= 0 ? '#4caf50' : '#ef5350';
  const zeroY = toY(0);

  let path = `M ${pad} ${toY(values[0])}`;
  for (let i = 1; i < values.length; i++) path += ` L ${pad + step * i} ${toY(values[i])}`;
  const areaPath = path + ` L ${pad + step * (values.length - 1)} ${zeroY} L ${pad} ${zeroY} Z`;

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="grad-${elId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="#333" stroke-width="0.5" stroke-dasharray="2,2"/>
      <path d="${areaPath}" fill="url(#grad-${elId})" stroke="none"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"/>
    </svg>
  `;
}

// ── 잔고 갱신 ────────────────────────────────────────────────
async function refreshBalance() {
  if (currentMode === 'paper-self') {
    const realSection = document.getElementById('realHoldingsSection');
    if (realSection) realSection.style.display = 'none';
    const status = await api('/api/status');
    if (status) {
      const slots = status.slots || 2;
      const initial = (status.perStockBudget || 500000) * slots;
      const usedBuy = (status.positions_summary?.buy_total) || 0;
      const available = Math.max(0, initial - usedBuy);
      const depEl = document.getElementById('deposit');
      if (depEl) depEl.textContent = `${available.toLocaleString()}원 (가상)`;
    }
    return;
  }

  const data = await api('/api/balance');
  if (data && !data.error) {
    const totalHolding = (data.holdings || []).reduce((s, h) => s + (h.evalAmt || 0), 0);
    const cash = (data.evalTotal || 0) - totalHolding;
    const pendingAmt = data.pendingOrderAmt || 0;
    const available = cash - pendingAmt;
    const depEl = document.getElementById('deposit');
    if (depEl) depEl.textContent = `${available.toLocaleString()}원`;
  } else {
    const depEl = document.getElementById('deposit');
    if (depEl) depEl.textContent = '--';
  }

  const realSection = document.getElementById('realHoldingsSection');
  if (!realSection) return;

  if (currentMode === 'real' && data && data.holdings) {
    window._latestPrices = {};
    for (const h of data.holdings) {
      if (h.code && h.curPrice) window._latestPrices[h.code] = h.curPrice;
    }
    const posBody = document.getElementById('positionsTable');
    const holdings = data.holdings.filter(h => h.qty > 0);
    const posCountEl = document.getElementById('positionCount');
    if (posCountEl) posCountEl.textContent = `${holdings.length}종목`;

    if (holdings.length > 0 && posBody) {
      let totalBuyAmt = 0, totalPnlAmt = 0;
      const posRows = holdings.map(h => {
        const buyAmt = (h.avgPrice || 0) * (h.qty || 0);
        totalBuyAmt += buyAmt;
        totalPnlAmt += h.pnlAmt || 0;
        const pnlClass = h.pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg';
        return `<tr style="white-space:nowrap;">
          <td style="max-width:96px;"><span class="stock-link" data-code="${h.code}" data-name="${h.name}" title="${h.name}" style="display:inline-block;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;">${h.name}</span></td>
          <td style="font-size:11px;color:var(--accent);">오버나잇</td>
          <td>${h.qty}</td>
          <td>${(h.avgPrice || 0).toLocaleString()}</td>
          <td>${buyAmt.toLocaleString()}원</td>
          <td class="${pnlClass}">${h.pnlPct >= 0 ? '+' : ''}${(h.pnlPct || 0).toFixed(2)}%<br><span style="font-size:11px;">${h.pnlAmt >= 0 ? '+' : ''}${(h.pnlAmt || 0).toLocaleString()}원</span></td>
        </tr>`;
      }).join('');
      const totalPnlClass = totalPnlAmt >= 0 ? 'pnl-pos' : 'pnl-neg';
      posBody.innerHTML = posRows + `<tr style="border-top:2px solid var(--border);font-weight:700;white-space:nowrap;">
        <td colspan="4" style="text-align:right;color:var(--dim);">합계</td>
        <td>${totalBuyAmt.toLocaleString()}원</td>
        <td class="${totalPnlClass}">${totalPnlAmt >= 0 ? '+' : ''}${totalPnlAmt.toLocaleString()}원</td></tr>`;
    } else if (posBody) {
      posBody.innerHTML = '<tr><td colspan="6" class="empty-msg">보유 종목 없음</td></tr>';
    }
    realSection.style.display = 'none';
  } else {
    if (realSection) realSection.style.display = 'none';
  }
}

// ── 최근 시그널 렌더링 (NEMESIS 스타일) ──────────────────
// 이벤트 타입: signal / buy / buy_skip / excluded / pending / morning_snapshot
function renderRecentSignals(events) {
  const body = document.getElementById('signalsTable');
  const cnt = document.getElementById('signalsCount');
  if (!body) return;

  const arr = Array.isArray(events) ? events : [];
  if (cnt) cnt.textContent = `${arr.length}건`;

  if (arr.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty-msg">아직 오늘 시그널 없음 — 평일 14:30 스캔 대기</td></tr>';
    return;
  }

  const kstHHMM = (iso) => {
    if (!iso) return '--';
    const t = new Date(iso);
    const kst = new Date(t.getTime() + 9 * 3600 * 1000);
    return `${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`;
  };

  const fmtInt = (v) => v != null ? Number(v).toLocaleString() : '-';
  const fmtChg = (v) => {
    if (v == null) return '-';
    const sign = v >= 0 ? '+' : '';
    const color = v >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${color};font-weight:600;">${sign}${(Number(v) * 100).toFixed(2)}%</span>`;
  };

  // 이벤트 타입별 배지 + row 강조
  const eventMeta = {
    signal:           { label: '시그널',     color: '#60a5fa',      bg: 'rgba(96,165,250,0.10)',  border: '#60a5fa' },
    buy:              { label: '매수',       color: 'var(--green)', bg: 'rgba(74,222,128,0.12)',  border: 'var(--green)' },
    buy_skip:         { label: '매수 skip',  color: '#94a3b8',      bg: 'rgba(148,163,184,0.10)', border: '#94a3b8' },
    excluded:         { label: '후보 없음',   color: 'var(--dim)',   bg: 'rgba(148,163,184,0.06)', border: '#64748b' },
    pending:          { label: '대기 중',    color: '#fbbf24',      bg: 'rgba(251,191,36,0.10)',  border: '#fbbf24' },
    morning_snapshot: { label: '스냅샷',     color: '#22d3ee',      bg: 'rgba(34,211,238,0.06)',  border: '#22d3ee' },
  };

  const stockCell = (e) => {
    if (!e.code) return '<span class="dim">--</span>';
    const rankBadge = e.rank
      ? `<span style="display:inline-block;padding:0px 4px;margin-left:4px;border-radius:3px;font-size:9px;background:rgba(148,163,184,0.18);color:var(--dim);">r${e.rank}</span>`
      : '';
    return `<span class="stock-link" data-code="${e.code}" data-name="${e.name || e.code}">${e.name || e.code}</span>${rankBadge}<div class="dim2" style="font-size:10px;font-family:'SF Mono',monospace;">${e.code}</div>`;
  };

  const memoCell = (e) => {
    switch (e.event) {
      case 'signal':
        return `<span class="dim2">14:50 매수 대기</span>`;
      case 'buy': {
        const price = e.price ? Number(e.price).toLocaleString() : '-';
        return `<span class="dim2">체결 ${price}원 (${e.qty}주)</span>`;
      }
      case 'buy_skip':
        return `<span class="dim2">${e.reason || 'not_filled'}</span>`;
      case 'excluded':
        return `<span class="dim2">${e.reason || 'unknown'}</span>`;
      case 'pending':
        return `<span class="dim2">14:50 체결 대기 중</span>`;
      case 'morning_snapshot':
        return `<span class="dim2">09:31 스냅샷 ${e.n_stocks}개</span>`;
      default: return '-';
    }
  };

  body.innerHTML = arr.map(e => {
    const meta = eventMeta[e.event] || { label: e.event, color: 'var(--dim)', bg: '', border: 'transparent' };
    const t = kstHHMM(e.time_kst);
    const rowStyle = `background:${meta.bg};border-left:3px solid ${meta.border};`;
    const badge = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;background:${meta.bg};color:${meta.color};border:1px solid ${meta.border};">${meta.label}</span>`;
    const marketBadge = e.market
      ? `<span style="font-size:9px;color:var(--dim);margin-left:4px;">(${e.market})</span>`
      : '';

    return `<tr style="${rowStyle}">
      <td class="mono">${t}</td>
      <td>${badge}</td>
      <td>${stockCell(e)}</td>
      <td class="num">${fmtChg(e.change_rate)}</td>
      <td class="num">${e.cluster_strength ? `x${Number(e.cluster_strength).toFixed(2)}` : '-'}</td>
      <td>${marketBadge}</td>
      <td>${memoCell(e)}</td>
    </tr>`;
  }).join('');
}

// ── 로그 갱신 ────────────────────────────────────────────────
async function refreshLogs() {
  const logs = await api('/api/logs');
  if (!logs) return;
  const box = document.getElementById('logBox');
  if (!box) return;
  box.innerHTML = logs.map(l => {
    const cat = l.category ? `<span style="color:var(--dim2);margin:0 6px;">${l.category}</span>` : '';
    return `<div class="log-${l.level}">[${l.ts}]${cat}${l.message ?? ''}</div>`;
  }).join('');
}

// ── 주문 현황 갱신 ───────────────────────────────────────────
async function refreshOrdersLive() {
  const data = await api('/api/orders-live');
  const tbody = document.getElementById('ordersLiveTable');
  const countEl = document.getElementById('ordersLiveCount');
  if (!tbody) return;
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--dim);">오늘 주문 없음</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  const pending = data.filter(o => o.status !== '체결');
  if (pending.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--dim);">체결 대기 종목 없음</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = `${pending.length}건 대기 중`;

  tbody.innerHTML = pending.map(o => {
    const sideColor = o.side === 'BUY' ? 'var(--accent)' : 'var(--green)';
    const sideText = o.side === 'BUY' ? '매수' : '매도';
    return `<tr>
      <td style="font-size:12px;">${o.time}</td>
      <td><span class="stock-link" data-code="${o.code}">${o.name}</span></td>
      <td style="color:${sideColor};font-weight:600;">${sideText}</td>
      <td>${o.curPrice > 0 ? o.curPrice.toLocaleString() + '원' : '-'}</td>
      <td>${o.qty}주</td>
      <td style="font-weight:600;">${o.curPrice > 0 ? (o.curPrice * o.qty).toLocaleString() + '원' : '-'}</td>
    </tr>`;
  }).join('');
}

// ── 전체 갱신 ────────────────────────────────────────────────
async function refreshAll() {
  countdown = 30;
  await Promise.all([refreshStatus(), refreshStats(), refreshLogs()]);
  refreshBalance();
  refreshOrdersLive();
}

// ── 자동 새로고침 ─────────────────────────────────────────────
function startAutoRefresh() {
  countdown = 30;
  refreshInterval = setInterval(() => {
    countdown--;
    const timerEl = document.getElementById('refreshTimer');
    if (timerEl) timerEl.textContent = `${countdown}s`;
    if (countdown <= 0) {
      countdown = 30;
      refreshAll();
    }
  }, 1000);
}

// ── 수동 스캔 ────────────────────────────────────────────────
async function manualScan(btn) {
  setLoading(btn, true);
  const result = await api('/api/scan', { method: 'POST' });
  setLoading(btn, false);
  if (result && result.ok) {
    showToast('스캔 완료 — 14:50 매수 예정');
  } else {
    showToast('스캔 실패');
  }
  refreshAll();
}

// ── 실전 자동매매 ON/OFF ──────────────────────────────────────
async function toggleRealTrading() {
  if (!realAutoTrading) {
    if (!confirm('⚠️ 실전 자동매매를 시작합니다.\n실제 자금으로 매매가 실행됩니다.\n\n정말 시작하시겠습니까?')) return;
    if (!confirm('🔵 최종 확인: 실전 자동매매 ON?')) return;
    await api('/api/toggle-real-trading', { method: 'POST', body: { enable: true } });
    showToast('🔵 실전 자동매매 ON');
  } else {
    await api('/api/toggle-real-trading', { method: 'POST', body: { enable: false } });
    showToast('⬜ 실전 자동매매 OFF');
  }
  refreshAll();
}

// ── 운영 모드 전환 ────────────────────────────────────────────
async function changeMode(targetMode, btn) {
  if (!btn) return;
  const old = btn.textContent;
  let confirmReal = false;
  if (targetMode === 'real') {
    const msg = `⚠️ 실전 모드 전환\n\n실제 KIS 계좌에 시장가 매수·매도 주문이 발사됩니다.\n다음 매매일 14:50 첫 매수가 진짜 자금으로 실행됩니다.\n\n정말 진행할까요?`;
    if (!confirm(msg)) return;
    confirmReal = true;
  }
  btn.disabled = true; btn.textContent = '전환 중...';
  try {
    const r = await fetch('/api/toggle-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: targetMode, confirmReal }),
    });
    const j = await r.json();
    if (!j.ok) {
      alert(`전환 실패: ${j.error || '알 수 없는 오류'}`);
      btn.textContent = old; btn.disabled = false;
      return;
    }
    showToast(`모드 전환: ${targetMode} (서버 재시작 중...)`, 4000);
    btn.textContent = '✅ ' + targetMode;
    setTimeout(() => window.location.reload(), 5000);
  } catch (e) {
    alert(`전환 실패: ${e.message}`);
    btn.textContent = old; btn.disabled = false;
  }
}

// ── KIS 연결 테스트 ───────────────────────────────────────────
async function testKisHealth(btn) {
  const result = document.getElementById('kisHealthResult');
  if (!btn || !result) return;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '조회 중...';
  result.style.display = 'block';
  result.style.background = 'rgba(154,154,165,0.10)';
  result.style.color = 'var(--dim)';
  result.style.border = '1px solid var(--border)';
  result.textContent = 'KIS 잔고 조회 중...';
  try {
    const r = await fetch('/api/kis/health-check');
    const j = await r.json();
    if (!j.ok) {
      result.style.background = 'rgba(248,113,113,0.10)';
      result.style.color = '#f87171';
      result.style.border = '1px solid rgba(248,113,113,0.30)';
      result.innerHTML = `<strong>❌ 실패</strong><br>${j.error || '알 수 없는 오류'}${j.hint ? '<br><span style="color:var(--dim);">힌트: '+j.hint+'</span>' : ''}`;
    } else {
      result.style.background = 'rgba(74,222,128,0.08)';
      result.style.color = 'var(--text)';
      result.style.border = '1px solid rgba(74,222,128,0.30)';
      const fmt = n => Number(n || 0).toLocaleString();
      result.innerHTML =
        `<strong style="color:var(--green);">✅ 연결 OK · KIS 응답 정상</strong><br>` +
        `예수금 (D): <strong>${fmt(j.deposit)}원</strong><br>` +
        `총평가: ${fmt(j.totalEval)}원<br>` +
        `보유 종목 ${j.holdingsCount}개<br>` +
        `<br><span style="color:var(--accent);">→ real 전환 시 종목당 예산 ${fmt(j.estimatedPerStockBudget)}원 × 2슬롯 = ${fmt(j.estimatedTotalUse)}원 사용 예상</span>`;
    }
    btn.textContent = '✅ ' + (j.ok ? '성공' : '실패');
  } catch (e) {
    result.style.background = 'rgba(248,113,113,0.10)';
    result.style.color = '#f87171';
    result.style.border = '1px solid rgba(248,113,113,0.30)';
    result.textContent = `❌ 요청 실패: ${e.message}`;
    btn.textContent = '⚠️ 실패';
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2500);
  }
}

// ── 비밀번호/KIS 키 저장 ─────────────────────────────────────
async function refreshSecretStatus() {
  if (!document.getElementById('secStatusEmail')) return;
  try {
    const r = await fetch('/api/config/secrets/status');
    if (!r.ok) return;
    const d = await r.json();
    const setDot = (id, ok) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = ok ? '●' : '○';
      el.style.color = ok ? 'var(--green)' : 'var(--dim2)';
    };
    setDot('secStatusEmail', d.email);
    setDot('secStatusKisKey', d.kis_app_key);
    setDot('secStatusKisSecret', d.kis_app_secret);
    setDot('secStatusKisCano', d.kis_cano);

    const modeBadge = document.getElementById('currentModeBadge');
    if (modeBadge && d.mode) {
      const colors = {
        'paper-self': { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24' },
        'real':       { bg: 'rgba(34,211,238,0.15)', fg: 'var(--accent)' },
      };
      const c = colors[d.mode] || colors['paper-self'];
      modeBadge.textContent = d.mode;
      modeBadge.style.background = c.bg;
      modeBadge.style.color = c.fg;
    }
    document.querySelectorAll('.mode-btn').forEach(b => {
      const active = b.dataset.mode === d.mode;
      b.style.borderColor = active ? 'var(--accent)' : 'var(--border2)';
      b.style.fontWeight = active ? '800' : '600';
      b.style.background = active ? 'rgba(34,211,238,0.10)' : 'var(--card2)';
    });
  } catch {}
}

async function saveSecrets(btn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '저장 중...';

  const body = {};
  const emailPw = document.getElementById('secEmailPw')?.value.trim();
  const kisKey = document.getElementById('secKisAppKey')?.value.trim();
  const kisSecret = document.getElementById('secKisAppSecret')?.value.trim();
  const kisCano = document.getElementById('secKisCano')?.value.trim();
  if (emailPw) body.emailAppPassword = emailPw;
  if (kisKey) body.kisAppKey = kisKey;
  if (kisSecret) body.kisAppSecret = kisSecret;
  if (kisCano) body.kisCano = kisCano;

  if (Object.keys(body).length === 0) {
    btn.textContent = '입력 없음';
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1500);
    return;
  }

  try {
    const r = await fetch('/api/config/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '저장 실패');

    if (document.getElementById('secEmailPw')) document.getElementById('secEmailPw').value = '';
    if (document.getElementById('secKisAppKey')) document.getElementById('secKisAppKey').value = '';
    if (document.getElementById('secKisAppSecret')) document.getElementById('secKisAppSecret').value = '';
    if (document.getElementById('secKisCano')) document.getElementById('secKisCano').value = '';

    btn.textContent = '✅ 저장됨';
    showToast(`저장 완료 (${j.updated.join(', ')})`, 3000);
    refreshSecretStatus();
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1500);
  } catch (e) {
    btn.textContent = '⚠️ 실패';
    alert('저장 실패: ' + e.message);
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2000);
  }
}

// 설정 모달 열릴 때 status 갱신
document.addEventListener('DOMContentLoaded', () => {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    const obs = new MutationObserver(() => {
      if (settingsModal.classList.contains('active')) refreshSecretStatus();
    });
    obs.observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
  }
});

// ── 설정 read-only hydrate ────────────────────────────────────
function hydrateSettingsReadonly(data) {
  const setText = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.textContent = v; };
  setText('cfgBudgetValue', data.perStockBudget != null ? Number(data.perStockBudget).toLocaleString() : null);
  const stateText = document.getElementById('realTradingStatusText');
  if (stateText && data.mode) {
    stateText.textContent = data.mode === 'real'
      ? (data.realAutoTrading ? 'ON' : 'OFF')
      : 'SIM';
  }
}

// ── 차트 모달 ────────────────────────────────────────────────
let _modalChart = null;
let _modalVolChart = null;
let _modalResizeObs = null;

async function openChart(code, name) {
  document.getElementById('chartTitle').innerHTML = `${name} <span style="color:var(--dim);font-size:12px;font-weight:400;margin-left:8px;">${code}</span>`;
  document.getElementById('chartLinkNaver').href = `https://finance.naver.com/item/main.naver?code=${code}`;
  document.getElementById('chartLinkMobile').href = `https://m.stock.naver.com/domestic/stock/${code}/total`;
  document.getElementById('chartOverlay').classList.add('active');
  document.getElementById('chartLoading').style.display = 'block';
  destroyModalChart();

  const result = await api(`/api/chart/${code}`);
  document.getElementById('chartLoading').style.display = 'none';

  if (!result || !result.ok || !result.data || result.data.length === 0) {
    document.getElementById('chartCandleWrap').innerHTML = '<div style="color:var(--dim);text-align:center;padding:40px;">차트 데이터 없음</div>';
    return;
  }

  const data = result.data;
  const candleContainer = document.getElementById('chartCandleWrap');
  const volContainer = document.getElementById('chartVolumeWrap');

  function calcMA(arr, period) {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < period - 1) { out.push(null); continue; }
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += arr[j].close;
      out.push(+(sum / period).toFixed(0));
    }
    return out;
  }
  const ma20 = calcMA(data, 20);
  const ma60 = calcMA(data, 60);

  const candleHeight = candleContainer.clientHeight || (candleContainer.parentElement.clientHeight - 120);
  _modalChart = LightweightCharts.createChart(candleContainer, {
    width: candleContainer.clientWidth,
    height: candleHeight,
    layout: { background: { color: '#040c12' }, textColor: '#6a7470', fontSize: 11 },
    grid: { vertLines: { color: '#0f1d24' }, horzLines: { color: '#0f1d24' } },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#1a2a35' },
    timeScale: { borderColor: '#1a2a35', timeVisible: false },
  });

  const candles = data.map(d => ({ time: d.date, open: d.open, high: d.high, low: d.low, close: d.close }));
  const candleSeries = _modalChart.addCandlestickSeries({
    upColor: '#ef5350', downColor: '#2962FF',
    borderUpColor: '#ef5350', borderDownColor: '#2962FF',
    wickUpColor: '#ef5350', wickDownColor: '#2962FF',
  });
  candleSeries.setData(candles);

  const ma20Data = ma20.map((v, i) => v !== null ? { time: data[i].date, value: v } : null).filter(Boolean);
  if (ma20Data.length) {
    const ma20Series = _modalChart.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ma20Series.setData(ma20Data);
  }
  const ma60Data = ma60.map((v, i) => v !== null ? { time: data[i].date, value: v } : null).filter(Boolean);
  if (ma60Data.length) {
    const ma60Series = _modalChart.addLineSeries({ color: '#e040fb', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ma60Series.setData(ma60Data);
  }

  if (candles.length > 120) {
    _modalChart.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length });
  } else {
    _modalChart.timeScale().fitContent();
  }

  _modalVolChart = LightweightCharts.createChart(volContainer, {
    width: volContainer.clientWidth, height: 80,
    layout: { background: { color: '#040c12' }, textColor: '#6a7470', fontSize: 10 },
    grid: { vertLines: { color: '#0a1620' }, horzLines: { color: '#0a1620' } },
    timeScale: { borderColor: '#1a2a35', timeVisible: false, visible: false },
    rightPriceScale: { borderColor: '#1a2a35' },
  });

  const volSeries = _modalVolChart.addHistogramSeries({ priceFormat: { type: 'volume' } });
  volSeries.setData(data.map(d => ({
    time: d.date, value: d.volume,
    color: d.close >= d.open ? 'rgba(239,83,80,0.4)' : 'rgba(41,98,255,0.4)',
  })));

  _modalChart.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (r && _modalVolChart) _modalVolChart.timeScale().setVisibleLogicalRange(r);
  });
  _modalVolChart.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (r && _modalChart) _modalChart.timeScale().setVisibleLogicalRange(r);
  });

  _modalResizeObs = new ResizeObserver(() => {
    if (_modalChart && candleContainer.clientWidth > 0) _modalChart.applyOptions({ width: candleContainer.clientWidth });
    if (_modalVolChart && volContainer.clientWidth > 0) _modalVolChart.applyOptions({ width: volContainer.clientWidth });
  });
  _modalResizeObs.observe(candleContainer);
}

function destroyModalChart() {
  if (_modalResizeObs) { _modalResizeObs.disconnect(); _modalResizeObs = null; }
  if (_modalChart) { try { _modalChart.remove(); } catch(e){} _modalChart = null; }
  if (_modalVolChart) { try { _modalVolChart.remove(); } catch(e){} _modalVolChart = null; }
}

function closeChart(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('chartOverlay').classList.remove('active');
  destroyModalChart();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChart(); });

// ── 이벤트 위임: stock-link 클릭 ─────────────────────────────
document.addEventListener('click', (e) => {
  const link = e.target.closest('.stock-link');
  if (link) {
    const code = link.dataset.code;
    if (code) window.open(`https://www.tossinvest.com/stocks/A${code}/order`, '_blank');
  }
});

// ── 초기화 ───────────────────────────────────────────────────
refreshAll();
startAutoRefresh();
