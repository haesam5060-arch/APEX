// ═══════════════════════════════════════════════════════════════
// 테이아 시세 조회 — 네이버 모바일 API (무료, 번트 scanner.js 베이스)
// ═══════════════════════════════════════════════════════════════
//
// scanAllStocks()       → KOSPI+KOSDAQ 전종목 (~3500) 등락률·시총·거래량 한 번
// fetchStockDetail(code)→ 개별 종목 OHLC + 호가
// pollPrice(code)       → 실시간 호가 (분봉 모니터링용, 손절 트리거)
//
// ═══════════════════════════════════════════════════════════════
const https = require('https');

const MARKET_VALUE_URL_KOSDAQ = 'https://m.stock.naver.com/api/stocks/marketValue/KOSDAQ';
const MARKET_VALUE_URL_KOSPI = 'https://m.stock.naver.com/api/stocks/marketValue/KOSPI';
const PRICE_URL = 'https://m.stock.naver.com/api/stock';
const PAGE_SIZE = 100;

function parseNum(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  return parseInt(String(val).replace(/,/g, ''), 10) || 0;
}

function fetchJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${url}`)), timeout);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode === 429) return reject(new Error(`Rate limited (429): ${url}`));
        if (res.statusCode >= 500) return reject(new Error(`Server error ${res.statusCode}: ${url}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`Parse error: ${url}`)); }
      });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// retry with exponential backoff (3회, 0.5s/1s/2s)
async function fetchJsonRetry(url, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      if (i < maxRetries - 1) {
        const wait = 500 * Math.pow(2, i);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// 페이지 동시 호출 제한 (네이버 차단 회피)
const PAGE_BATCH_SIZE = 10;

async function _scanMarket(marketUrl) {
  const first = await fetchJsonRetry(`${marketUrl}?page=1&pageSize=${PAGE_SIZE}`);
  const totalCount = first.totalCount || 1800;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // 1페이지는 이미 받음, 2페이지부터 batch 처리
  const allResults = [{ status: 'fulfilled', value: first }];
  for (let start = 2; start <= totalPages; start += PAGE_BATCH_SIZE) {
    const batch = [];
    for (let p = start; p < start + PAGE_BATCH_SIZE && p <= totalPages; p++) {
      batch.push(fetchJsonRetry(`${marketUrl}?page=${p}&pageSize=${PAGE_SIZE}`));
    }
    const results = await Promise.allSettled(batch);
    allResults.push(...results);
    // batch 사이 짧은 delay (50ms) — 네이버 부담 ↓
    if (start + PAGE_BATCH_SIZE <= totalPages) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  const stocks = [];
  let nFailedPages = 0;
  for (const r of allResults) {
    if (r.status !== 'fulfilled' || !r.value?.stocks) {
      nFailedPages++;
      continue;
    }
    for (const s of r.value.stocks) {
      const code = s.itemCode || s.stockCode;
      const name = s.stockName || s.itemName;
      const close = parseNum(s.closePrice);
      const changeRate = parseFloat(s.fluctuationsRatio) / 100 || 0;
      const marketCap = parseNum(s.marketValueRaw || s.marketValue);
      const volume = parseNum(s.accumulatedTradingVolume);
      const tradingValue = parseNum(s.accumulatedTradingValue) * 1_000_000;

      if (close <= 0) continue;
      // 우선주 제외
      if (/우$|우[B-Z]/.test(name)) continue;
      stocks.push({ code, name, close, changeRate, marketCap, volume, tradingValue });
    }
  }
  if (nFailedPages > 0) {
    console.warn(`[scan] ${marketUrl}: ${nFailedPages}/${allResults.length} 페이지 실패 (네트워크/rate-limit 가능성)`);
  }
  return stocks;
}

// 코스피 + 코스닥 전종목 (각 시장 batched, 시장간 직렬)
async function scanAllStocks() {
  const kosdaq = (await _scanMarket(MARKET_VALUE_URL_KOSDAQ)).map(s => ({ ...s, market: 'KOSDAQ' }));
  const kospi  = (await _scanMarket(MARKET_VALUE_URL_KOSPI)).map(s => ({ ...s, market: 'KOSPI' }));
  return [...kosdaq, ...kospi];
}

// 개별 종목 OHLC
async function fetchStockDetail(code) {
  const data = await fetchJsonRetry(`${PRICE_URL}/${code}/price`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const today = data[0];
  const prev = data[1] || null;
  return {
    code,
    open: parseNum(today.openPrice),
    high: parseNum(today.highPrice),
    low: parseNum(today.lowPrice),
    close: parseNum(today.closePrice),
    volume: parseNum(today.accumulatedTradingVolume),
    prevClose: prev ? parseNum(prev.closePrice) : null,
    tradingDate: today.localTradedAt || null,
  };
}

// 실시간 현재가 (분봉 모니터링용)
async function pollPrice(code) {
  const data = await fetchJsonRetry(`${PRICE_URL}/${code}/basic`);
  if (!data) return null;

  let close = parseNum(data.closePrice);
  let changeRate = parseFloat(data.fluctuationsRatio) / 100 || 0;
  let session = 'regular';

  // 정규장 마감 후 시간외(장후종가·시간외단일가)가 열려 있으면 시간외 실시간가로 갱신.
  // 보유 종목 P&L 라이브 표시 전용 — 매매 결정 경로는 정규장에만 돌아 영향 없음.
  const over = data.overMarketPriceInfo;
  if (data.marketStatus !== 'OPEN' && over && over.overMarketStatus === 'OPEN') {
    const overPrice = parseNum(over.overPrice);
    if (overPrice > 0) {
      close = overPrice;
      changeRate = parseFloat(over.fluctuationsRatio) / 100 || changeRate;
      session = 'afterhours';
    }
  }

  return {
    code,
    close,
    high: parseNum(data.highPrice),
    low: parseNum(data.lowPrice),
    open: parseNum(data.openPrice),
    changeRate,
    session,
    timestamp: new Date().toISOString(),
  };
}

// 여러 종목 polling (보유 포지션은 보통 2종목, batch 5로 안전하게)
async function pollPrices(codes, batchSize = 5) {
  const out = {};
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(c => pollPrice(c)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) out[r.value.code] = r.value;
    }
    if (i + batchSize < codes.length) {
      await new Promise(r => setTimeout(r, 100)); // batch 사이 100ms
    }
  }
  return out;
}

// ── 네이버 호가 (슬리피지 측정용) ────────────────────────────────
// API: /api/stock/{code}/orderbook
// ask1~ask5 호가 + 잔량을 반환. 5단계만 사용 (보통 14:50 KOSDAQ 소형주 충분).
async function fetchOrderbook(code) {
  const data = await fetchJsonRetry(`${PRICE_URL}/${code}/orderbook`);
  if (!data) return null;

  // 네이버 orderbook 스키마: { asks: [{price, volume},...], bids: [...] }
  // 실제 응답 형태가 다를 수 있어 두 가지 경로 모두 처리
  const raw = data;
  const asks = [];
  const bids = [];

  if (Array.isArray(raw.asks)) {
    for (const a of raw.asks.slice(0, 5))
      asks.push({ price: parseNum(a.price), qty: parseNum(a.volume || a.qty || 0) });
  } else {
    // 대안: askp1~askp5 플랫 구조
    for (let i = 1; i <= 5; i++) {
      const p = parseNum(raw[`askp${i}`] || raw[`ask${i}Price`] || 0);
      const q = parseNum(raw[`askp_rsqn${i}`] || raw[`ask${i}Volume`] || raw[`ask${i}Qty`] || 0);
      if (p > 0) asks.push({ price: p, qty: q });
    }
  }
  if (Array.isArray(raw.bids)) {
    for (const b of raw.bids.slice(0, 5))
      bids.push({ price: parseNum(b.price), qty: parseNum(b.volume || b.qty || 0) });
  }

  if (asks.length === 0) return null;
  return { code, asks, bids, best_ask: asks[0]?.price ?? 0, best_bid: bids[0]?.price ?? 0 };
}

// 주문 규모(amount원)를 ask 호가에서 체결 시 추정 가중평균가
function estimateFillPrice(asks, amount) {
  if (!asks || asks.length === 0) return null;
  let remaining = amount;
  let totalCost = 0;
  let totalQty  = 0;
  for (const { price, qty } of asks) {
    if (price <= 0 || remaining <= 0) break;
    const affordable = Math.floor(remaining / price);
    const filled     = Math.min(affordable, qty);
    if (filled <= 0) continue;
    totalCost  += price * filled;
    totalQty   += filled;
    remaining  -= price * filled;
  }
  return totalQty > 0 ? Math.round(totalCost / totalQty) : null;
}

module.exports = {
  scanAllStocks,
  fetchStockDetail,
  fetchOrderbook,
  estimateFillPrice,
  pollPrice,
  pollPrices,
};
