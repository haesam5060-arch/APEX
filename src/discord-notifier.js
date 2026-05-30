// ═══════════════════════════════════════════════════════════════
// 헬리오스 디스코드 알림 — 매수/매도/오류 시
// DISCORD_WEBHOOK_URL이 없으면 no-op
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const { URL } = require('url');
const mail = require('./email-notifier');

let _webhookUrl = null;

function init(webhookUrl) {
  _webhookUrl = webhookUrl || null;
}

// 디스코드 단독 발송 (내부 사용)
function _sendDiscord(content, username) {
  if (!_webhookUrl) return Promise.resolve(false);
  return new Promise((resolve) => {
    let url;
    try { url = new URL(_webhookUrl); } catch { return resolve(false); }
    const body = JSON.stringify({ content, username });
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// 통합 send — 디스코드 + 메일 병행 호출.
//   webhook이 없으면 디스코드는 no-op, 메일만 발송.
//   각 채널 독립적으로 결과 처리 (한 쪽 실패해도 나머지 발송 계속).
function send(content, { username = '네메시스', subject } = {}) {
  const discordPromise = _sendDiscord(content, username);
  const mailPromise = mail.send(subject || mail.inferSubject(content), mail.toHtml(content)).catch(() => ({ ok: false }));
  return Promise.all([discordPromise, mailPromise])
    .then(([d, m]) => d || (m && m.ok));
}

function sendBuy(pick, opened, mode) {
  if (!pick || !opened) return Promise.resolve(false);
  const msg = [
    `📈 **매수** [${mode}]`,
    `${pick.name}(${pick.code}) — 테마: ${pick.theme}`,
    `${opened.qty}주 @ ${opened.buy_price.toLocaleString()}원 (총 ${(opened.qty * opened.buy_price).toLocaleString()}원)`,
    `09:01 등락률: ${(pick.change_rate_901*100).toFixed(2)}%`,
  ].join('\n');
  return send(msg);
}

function _reasonLabel(exitReason) {
  switch (exitReason) {
    case 'take_profit':   return '🎯 익절 +10%';
    case 'stop_loss':     return '🛑 손절 -7%';
    case 'next_day_open': return '🕐 D+1 시초가';
    default:              return exitReason || 'unknown';
  }
}

function sendSell(trade, mode) {
  if (!trade) return Promise.resolve(false);
  const emoji = trade.pnl >= 0 ? '✅' : '❌';
  const reason = _reasonLabel(trade.exit_reason);
  const msg = [
    `${emoji} **매도** [${mode}] ${reason}`,
    `${trade.name}(${trade.code}) — 테마: ${trade.theme}`,
    `${trade.qty}주: ${trade.buy_price.toLocaleString()} → ${trade.sell_price.toLocaleString()}원`,
    `PnL ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toLocaleString()}원 (${(trade.return_pct*100).toFixed(2)}%)`,
  ].join('\n');
  return send(msg);
}

function sendError(message) {
  return send(`🚨 **오류**\n${message}`);
}

function sendBuyBlocked(blockInfo) {
  return send(`⛔ **매수 금지일** — ${blockInfo.desc} (${blockInfo.reason}) / 매수 차단`);
}

function sendBuySkipped(pending, info) {
  if (info?.reason === 'price_guard') {
    const cutPct = (info.guardCut * 100).toFixed(0);
    return send(
      `⚠️ **매수 skip (상한가 가드)** — ${pending.pick_name}(${pending.pick_code})\n` +
      `11:01 가격 ${info.curPrice.toLocaleString()}원 (전일종가 ${info.prevClose.toLocaleString()}원 대비 **+${info.pctVsPrev}%**) ≥ +${cutPct}% 컷\n` +
      `→ 상한가 잔량 부족 위험으로 매수 안 함`
    );
  }
  return send(`⚠️ **매수 skip** — ${pending.pick_name}(${pending.pick_code}) / 사유: ${info?.reason || 'unknown'}`);
}

// ── G1e 자기진단 가드 알림 ───────────────────────────────────────
// 발동·매 skip 모두 알림 (사용자 결정: "항상 알림").
function sendGuardSkip(pick, guard) {
  if (!pick || !guard) return Promise.resolve(false);

  const stateAfter = guard.stateAfter || {};
  const totalTrig = stateAfter.total_trigger_count ?? '?';

  if (guard.action === 'skip_triggered') {
    // 가드 새로 발동 (직전 N건 누적 손실 트리거)
    const cumPct = guard.recent3Cum != null ? (guard.recent3Cum * 100).toFixed(2) : '?';
    const recentStr = guard.recent3Pnls
      ? guard.recent3Pnls.map(r => `${(r * 100).toFixed(2)}%`).join(' / ')
      : '?';
    const skipLeft = stateAfter.skip_remaining ?? '?';
    return send(
      `🛡️ **[G1e 가드 발동]** 직전 3건 누적 손실 감지\n` +
      `직전 3건: ${recentStr} → 누적 **${cumPct}%** (≤ -5%)\n` +
      `시그널 발생 종목: ${pick.name}(${pick.code}) — **매수 skip**\n` +
      `이후 ${skipLeft}건 추가 skip + 해제 후 3건 cooldown 예정 (누적 발동 ${totalTrig}회)`
    );
  }

  if (guard.action === 'skip_active') {
    const skipLeft = stateAfter.skip_remaining ?? '?';
    return send(
      `🛡️ **[G1e 가드 skip]** ${pick.name}(${pick.code}) — 매수 skip\n` +
      `남은 skip: ${skipLeft}건 (누적 발동 ${totalTrig}회)`
    );
  }

  return Promise.resolve(false);
}

// 가드 정상 통과 (재발동 안 됨)·cooldown 종료·전체 해제 등 정보성 알림.
// scanner는 매번 보내진 않고, scheduler에서 cooldown→pass 전환 같은 이벤트만 보냄.
function sendGuardRelease(info) {
  return send(`🛡️ **[G1e 가드 해제]** 누적 발동 ${info?.total_trigger_count ?? '?'}회 / 다음 시그널부터 정상 매매 재개`);
}

module.exports = {
  init, send,
  sendBuy, sendSell, sendError,
  sendBuyBlocked, sendBuySkipped,
  sendGuardSkip, sendGuardRelease,
};
