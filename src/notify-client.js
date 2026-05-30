// notify-client.js — 통일 알림 클라이언트 (모든 엔진 공용)
// maint 중앙 허브(localhost:9000)를 통해 Discord로 전송
const MAINT = 'http://localhost:9000/api/notify/send';

const REASON_LABELS = {
  take_profit:   '익절',
  stop_loss:     '손절',
  next_day_open: 'D+1 시초가',
  daily_close:   '당일 마감',
  time_stop:     '시간 청산',
  manual:        '수동',
};

async function _send(projectId, payload) {
  try {
    await fetch(MAINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'trade', projectId, ...payload }),
    });
  } catch {}
}

// ── 매수 체결 ─────────────────────────────────────────────────
async function buy({ engine, mode, stocks = [], theme }) {
  if (mode === 'paper') return;
  if (!stocks.length) return;
  const modeTag = mode === 'real' ? '실전' : '모의';
  const total = stocks.reduce((s, t) =>
    s + (t.qty || 0) * (t.price || t.close || t.buy_price || 0), 0);

  const fields = [
    { name: '엔진', value: engine, inline: true },
    { name: '모드', value: modeTag, inline: true },
  ];

  if (stocks.length === 1) {
    const s = stocks[0];
    const price = s.price || s.close || s.buy_price || 0;
    const th = s.theme || theme;
    fields.push({ name: '종목', value: `${s.name}(${s.code}) × ${s.qty}주`, inline: false });
    fields.push({ name: '매수가', value: `${price.toLocaleString()}원`, inline: true });
    fields.push({ name: '금액',   value: `${(s.qty * price).toLocaleString()}원`, inline: true });
    if (th) fields.push({ name: '테마', value: th, inline: true });
  } else {
    const list = stocks.map(s => `${s.name}(${s.code}) ×${s.qty}`).join('\n');
    fields.push({ name: `종목 ${stocks.length}개`, value: list, inline: false });
    fields.push({ name: '총 금액', value: `${total.toLocaleString()}원`, inline: true });
  }

  await _send(engine, { title: `📈 매수 체결 · ${modeTag}`, level: 'info', fields });
}

// ── 단일 매도 ─────────────────────────────────────────────────
async function sell({ engine, mode, trade }) {
  if (mode === 'paper') return;
  if (!trade) return;
  const modeTag  = mode === 'real' ? '실전' : '모의';
  const pnl      = trade.pnl || trade.profit || 0;
  const pnlPct   = trade.pnlPct || trade.return_pct || 0;
  const rawReason = trade.reason || trade.exit_reason || '';
  const reason   = REASON_LABELS[rawReason] || rawReason;
  const sign     = pnl >= 0 ? '+' : '';
  const emoji    = pnl >= 0 ? '✅' : '❌';
  const buyPrice  = trade.buyPrice  || trade.buy_price  || 0;
  const sellPrice = trade.sellPrice || trade.sell_price || 0;

  const fields = [
    { name: '엔진', value: engine,  inline: true },
    { name: '모드', value: modeTag, inline: true },
    { name: '종목', value: `${trade.name}(${trade.code}) × ${trade.qty}주`, inline: false },
    { name: '매수가', value: `${buyPrice.toLocaleString()}원`,  inline: true },
    { name: '매도가', value: `${sellPrice.toLocaleString()}원`, inline: true },
    { name: '손익',   value: `${sign}${pnl.toLocaleString()}원 (${sign}${(pnlPct * 100).toFixed(2)}%)`, inline: true },
  ];
  if (reason) fields.push({ name: '사유', value: reason, inline: true });

  await _send(engine, {
    title: `${emoji} ${reason ? reason + ' ' : ''}매도 · ${modeTag}`,
    level: pnl >= 0 ? 'success' : 'error',
    fields,
  });
}

// ── 다수 매도 정산 (일일 마감) ────────────────────────────────
async function sellReport({ engine, mode, results = [], dailyPnl }) {
  if (mode === 'paper') return;
  if (!results.length) return;
  const modeTag = mode === 'real' ? '실전' : '모의';
  const sign    = (dailyPnl || 0) >= 0 ? '+' : '';
  const emoji   = (dailyPnl || 0) >= 0 ? '✅' : '❌';
  const list    = results.map(r => `${r.name}(${r.code || ''}) ×${r.qty}`).join('\n');

  const fields = [
    { name: '엔진', value: engine, inline: true },
    { name: '모드', value: modeTag, inline: true },
    { name: '종목 수', value: `${results.length}개`, inline: true },
    { name: `${emoji} 일일 손익`, value: `${sign}${(dailyPnl || 0).toLocaleString()}원`, inline: true },
    { name: '종목 목록', value: list || '-', inline: false },
  ];

  await _send(engine, { title: `${emoji} 매도 정산 · ${modeTag}`, level: (dailyPnl || 0) >= 0 ? 'success' : 'error', fields });
}

// ── 오류 ─────────────────────────────────────────────────────
async function error({ engine, title, detail }) {
  const fields = [
    { name: '엔진', value: engine, inline: true },
    { name: '내용', value: String(detail || '').slice(0, 500), inline: false },
  ];
  await _send(engine, { title: `🚨 ${title || '오류'}`, level: 'error', fields });
}

// ── 점검 / 공지 ───────────────────────────────────────────────
async function check({ engine, title, message }) {
  const fields = [
    { name: '엔진', value: engine, inline: true },
    { name: '내용', value: message || '-', inline: false },
  ];
  await _send(engine, { title: `🔍 ${title}`, level: 'warn', fields });
}

// ── 매수 차단 (금지일 / 휴장) ────────────────────────────────
async function blocked({ engine, reason, detail }) {
  const fields = [
    { name: '엔진', value: engine, inline: true },
    { name: '사유', value: reason || '-', inline: true },
  ];
  if (detail) fields.push({ name: '상세', value: detail, inline: false });
  await _send(engine, { title: '⛔ 매수 차단', level: 'warn', fields });
}

module.exports = { buy, sell, sellReport, error, check, blocked };
