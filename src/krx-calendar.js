// ═══════════════════════════════════════════════════════════════
// KRX 거래일 캘린더 — cron 가드용
//
// 목적: 한국거래소(KRX) 거래 없는 날에 cron(스캔/매수/매도) 자체를 skip.
// SSoT: data/krx_closed_days.json (매년 업데이트)
//
// 매수 금지 캘린더(no-buy-calendar.js)와 별개 — 그쪽은 분기말/배당락
// 같은 "거래일이지만 매수 차단"용. 이쪽은 "거래일 아님" 자체.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const CALENDAR_PATH = path.join(__dirname, '..', 'data', 'krx_closed_days.json');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(CALENDAR_PATH, 'utf8');
  _cache = JSON.parse(raw);
  return _cache;
}

function _todayKstYmd() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// 주말 (KRX 자연 폐장)
function _isWeekend(ymd) {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10) - 1;
  const d = parseInt(ymd.slice(6, 8), 10);
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay();  // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

/**
 * KRX 거래 없는 날인지 판정
 * @param {string} [ymd] - YYYYMMDD (생략 시 오늘 KST)
 * @returns {{closed: boolean, reason: string|null, name: string|null}}
 */
function isKrxClosed(ymd) {
  const target = ymd || _todayKstYmd();

  if (_isWeekend(target)) {
    return { closed: true, reason: 'weekend', name: null };
  }

  const data = _load();
  const entry = data.closed_days?.[target];
  if (entry) {
    return { closed: true, reason: 'holiday', name: entry.name };
  }

  return { closed: false, reason: null, name: null };
}

module.exports = { isKrxClosed };
