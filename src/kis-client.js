// ═══════════════════════════════════════════════════════════════
// 테이아 KIS API 클라이언트 — 시세 조회 전용
// (번트 account-service.js 베이스, 다종목현재가 추가)
//
// ⚠️ 매수/매도 주문 함수는 의도적으로 미포함.
// paper-self 모드: 시세는 실전 KIS API로 진짜 가져오고, 주문은 자체 simulate.
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TOKEN_FILE_REAL = path.join(DATA_DIR, 'token-real.json');

// 실전 환경 (시세는 실전 API로 호출 — 모의투자 환경 시세는 지연/sim)
const HOST_REAL = 'openapi.koreainvestment.com';
const PORT_REAL = 9443;

// ── KIS Rate Limit (계정당 초당 20건) ──────────────────────────
//   55ms 간격 → 초당 ~18건 (10% 여유)
const KIS_MIN_INTERVAL_MS = 55;
let _kisLastCallAt = 0;
let _kisQueueTail = Promise.resolve();

function _kisThrottle() {
  const next = _kisQueueTail.then(async () => {
    const wait = KIS_MIN_INTERVAL_MS - (Date.now() - _kisLastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _kisLastCallAt = Date.now();
  });
  _kisQueueTail = next.catch(() => {});
  return next;
}

// ── KIS API 요청 헬퍼 ────────────────────────────────────────
// 만료 토큰 응답이면 1회 강제 재발급 후 재시도 (모든 호출에 공통 적용)
function _isExpiredTokenResponse(res) {
  if (!res) return false;
  if (res.msg_cd === 'EGW00123') return true;            // KIS '기간이 만료된 token'
  return /만료된\s*token/.test(res.msg1 || res.msg || '');
}

async function kisRequest(method, apiPath, params, opts = {}) {
  const res = await _kisRequestOnce(method, apiPath, params, opts);
  if (_isExpiredTokenResponse(res) && opts.appKey && opts.appSecret && !opts._retried) {
    const fresh = await ensureToken(opts.appKey, opts.appSecret, { forceRefresh: true });
    return _kisRequestOnce(method, apiPath, params, { ...opts, token: fresh, _retried: true });
  }
  return res;
}

async function _kisRequestOnce(method, apiPath, params, { token, appKey, appSecret, trId, body: reqBody } = {}) {
  await _kisThrottle();
  return new Promise((resolve, reject) => {
    const query = method === 'GET' && params ? '?' + new URLSearchParams(params).toString() : '';
    const bodyStr = method === 'POST' && reqBody ? JSON.stringify(reqBody) : null;
    const hdrs = {
      'content-type': 'application/json; charset=utf-8',
      'authorization': `Bearer ${token}`,
      'appkey': appKey,
      'appsecret': appSecret,
      'tr_id': trId,
    };
    if (bodyStr) hdrs['content-length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: HOST_REAL,
      port: PORT_REAL,
      path: apiPath + query,
      method,
      headers: hdrs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('응답 파싱 실패: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('KIS API 타임아웃')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── 토큰 발급/갱신 (번트와 동일 token-real.json 파일 공유) ──────
// 토큰 + 실제 만료시각(ms)을 함께 반환 — 메모리 캐시가 실제 만료를 따르도록.
async function _resolveToken(appKey, appSecret, { forceRefresh = false } = {}) {
  // 캐시된 토큰 확인
  if (!forceRefresh && fs.existsSync(TOKEN_FILE_REAL)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_FILE_REAL, 'utf8'));
      if (cached.token && cached.expires && new Date(cached.expires) > new Date()) {
        return { token: cached.token, expiresMs: new Date(cached.expires).getTime() };
      }
    } catch {}
  }

  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret });
    const req = https.request({
      hostname: HOST_REAL,
      port: PORT_REAL,
      path: '/oauth2/tokenP',
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('토큰 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (!result.access_token) throw new Error(result.message || result.error_description || '토큰 발급 실패');

  const expires = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
  // symlink 따라 번트 파일에 쓰기 (실제로는 fs.writeFile이 symlink 따라가서 원본에 씀)
  fs.writeFileSync(TOKEN_FILE_REAL, JSON.stringify({ token: result.access_token, expires }, null, 2), 'utf8');
  return { token: result.access_token, expiresMs: new Date(expires).getTime() };
}

async function getToken(appKey, appSecret, opts = {}) {
  return (await _resolveToken(appKey, appSecret, opts)).token;
}

// 토큰 메모리 캐시 + 자동 갱신 wrapper
// 만료시각은 토큰의 실제 만료(파일 expires)를 따른다 — 호출 시점 기준 +23h로 잡으면
// 파일에 이미 발급돼 있던 토큰(만료 임박)을 메모리가 과대 연장해 죽은 토큰을 재사용하는 버그 발생.
const TOKEN_SAFETY_MARGIN_MS = 10 * 60 * 1000;  // 실제 만료 10분 전 선제 갱신
let _cachedToken = null;
let _cachedTokenExpires = 0;

async function ensureToken(appKey, appSecret, { forceRefresh = false } = {}) {
  if (!forceRefresh && _cachedToken && Date.now() < _cachedTokenExpires) return _cachedToken;
  const { token, expiresMs } = await _resolveToken(appKey, appSecret, { forceRefresh });
  _cachedToken = token;
  _cachedTokenExpires = expiresMs - TOKEN_SAFETY_MARGIN_MS;
  return _cachedToken;
}

// ── 단일종목 현재가 ────────────────────────────────────────────
//   FHKST01010100: 종목 현재가 (실시간)
async function getCurrentPrice(token, appKey, appSecret, code) {
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
    { token, appKey, appSecret, trId: 'FHKST01010100' }
  );
  if (result.rt_cd !== '0') throw new Error(`${code}: ${result.msg1 || '현재가 조회 실패'}`);
  const o = result.output;
  return {
    code,
    price: parseInt(o.stck_prpr) || 0,
    open: parseInt(o.stck_oprc) || 0,
    high: parseInt(o.stck_hgpr) || 0,
    low: parseInt(o.stck_lwpr) || 0,
    prevClose: parseInt(o.stck_sdpr) || 0,
    changeRate: parseFloat(o.prdy_ctrt) / 100 || 0,
    volume: parseInt(o.acml_vol) || 0,
    tradingValue: parseInt(o.acml_tr_pbmn) || 0,
    marketCap: parseInt(o.hts_avls) * 100_000_000 || 0,
  };
}

// ── 다종목 현재가 (한 번에 30종목) ─────────────────────────────
//   FHKST11300006 (일부 문서) / FHPST01010100 / 직접 확인 필요.
//   실제 다중종목 시세 API: KIS는 단일종목만 공식. 워크어라운드:
//   - 단일종목 API를 batch로 (rate limit 감안)
//   - 또는 등락률 순위 API (FHPST01710000) 활용
//
// 여기선 안전하게 단일종목 API를 batch (10개 동시) + rate limit throttle.
// 30개씩 묶고 그 안에서 rate-limit 자동 throttle.
async function fetchMultPrices(token, appKey, appSecret, codes, { batchSize = 10, onProgress = null } = {}) {
  const out = {};
  const errors = [];
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(code => getCurrentPrice(token, appKey, appSecret, code))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        out[batch[j]] = r.value;
      } else {
        errors.push({ code: batch[j], reason: r.reason?.message || String(r.reason) });
      }
    }
    if (onProgress) onProgress({ done: Math.min(i + batchSize, codes.length), total: codes.length, errors: errors.length });
  }
  return { prices: out, errors };
}

// ── 호가 조회 (분봉 모니터 시 사용 가능) ─────────────────────
async function getOrderbook(token, appKey, appSecret, code) {
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
    { token, appKey, appSecret, trId: 'FHKST01010200' }
  );
  if (result.rt_cd !== '0') throw new Error(`${code}: ${result.msg1 || '호가 조회 실패'}`);
  const o = result.output1;
  if (!o) throw new Error('호가 데이터 없음');
  const asks = [];
  const bids = [];
  for (let i = 1; i <= 10; i++) {
    asks.push({ price: parseInt(o[`askp${i}`]) || 0, qty: parseInt(o[`askp_rsqn${i}`]) || 0 });
    bids.push({ price: parseInt(o[`bidp${i}`]) || 0, qty: parseInt(o[`bidp_rsqn${i}`]) || 0 });
  }
  return { code, asks, bids, raw: o };
}

// ═══════════════════════════════════════════════════════════════
// 실전 매매 — 주문 / 잔고 (real 모드 전용)
//   주문 tr_id:
//     TTTC0802U: 실전 주식 매수
//     TTTC0801U: 실전 주식 매도
//     VTTC0802U: 모의 주식 매수 (드라이런용)
//     VTTC0801U: 모의 주식 매도 (드라이런용)
//   잔고 조회 tr_id:
//     TTTC8434R: 실전 주식 잔고 조회
//     VTTC8434R: 모의 주식 잔고 조회
// ═══════════════════════════════════════════════════════════════

// 주식 잔고 조회 (예수금 + 보유 종목)
//   cano: 종합계좌번호 8자리, acntPrdtCd: 상품코드 (기본 '01')
//   options.simulated: true면 모의투자 tr_id 사용
async function inquireBalance(token, appKey, appSecret, cano, acntPrdtCd = '01', { simulated = false } = {}) {
  const trId = simulated ? 'VTTC8434R' : 'TTTC8434R';
  const params = {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    AFHR_FLPR_YN: 'Y',            // 시간외단일가 여부 — 마감 후 보유 P&L을 시간외단일가로 평가(표시용, 주문 무관)
    OFL_YN: '',                   // 오프라인 여부
    INQR_DVSN: '02',              // 조회 구분 (02 = 종목별)
    UNPR_DVSN: '01',              // 단가 구분
    FUND_STTL_ICLD_YN: 'N',       // 펀드 결제분 포함
    FNCG_AMT_AUTO_RDPT_YN: 'N',   // 융자 자동 상환
    PRCS_DVSN: '00',              // 처리 구분 (00 = 전일매매 포함)
    CTX_AREA_FK100: '',
    CTX_AREA_NK100: '',
  };
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/trading/inquire-balance',
    params,
    { token, appKey, appSecret, trId }
  );
  if (result.rt_cd !== '0') throw new Error(`잔고 조회 실패: ${result.msg1 || result.msg_cd}`);

  // output1: 보유 종목 list, output2: 예수금 등 종합
  const holdings = (result.output1 || []).map(h => ({
    code: h.pdno,
    name: h.prdt_name,
    qty: parseInt(h.hldg_qty) || 0,
    avgPrice: parseFloat(h.pchs_avg_pric) || 0,
    curPrice: parseInt(h.prpr) || 0,
    evalAmt: parseInt(h.evlu_amt) || 0,
    pnlAmt: parseInt(h.evlu_pfls_amt) || 0,
    pnlPct: parseFloat(h.evlu_pfls_rt) || 0,
  })).filter(h => h.qty > 0);

  const sum = result.output2?.[0] || {};
  return {
    holdings,
    deposit: parseInt(sum.dnca_tot_amt) || 0,           // 예수금 총금액 (D)
    nextDayDeposit: parseInt(sum.nxdy_excc_amt) || 0,   // 익일 정산금액 (D+1 예수금)
    d2Deposit: parseInt(sum.prvs_rcdl_excc_amt) || 0,   // D+2 예수금 (실제 출금 가능 금액)
    totalEval: parseInt(sum.tot_evlu_amt) || 0,          // 총 평가금액
    totalPnl: parseInt(sum.evlu_pfls_smtl_amt) || 0,     // 총 평가손익
    raw: { output1: result.output1, output2: result.output2 },
  };
}

// 시장가 매수 주문
//   qty 정수, 시장가는 unit_price=0
//   options.simulated: true면 모의 tr_id
async function orderBuyMarket(token, appKey, appSecret, cano, acntPrdtCd, code, qty, { simulated = false } = {}) {
  const trId = simulated ? 'VTTC0802U' : 'TTTC0802U';
  const body = {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    PDNO: code,
    ORD_DVSN: '01',           // 01 = 시장가
    ORD_QTY: String(qty),
    ORD_UNPR: '0',            // 시장가는 0
  };
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-cash',
    null,
    { token, appKey, appSecret, trId, body }
  );
  if (result.rt_cd !== '0') {
    throw new Error(`매수 주문 실패 (${code}, qty=${qty}): ${result.msg1 || result.msg_cd}`);
  }
  // output: KRX_FWDG_ORD_ORGNO + ODNO + ORD_TMD (KRX 주문 원번호는 취소/정정 시 필요)
  return {
    orderNo: result.output?.ODNO,
    orderTime: result.output?.ORD_TMD,
    krxFwdgOrdOrgno: result.output?.KRX_FWDG_ORD_ORGNO,
    raw: result.output,
    msg: result.msg1,
  };
}

// 시장가 매도 주문
async function orderSellMarket(token, appKey, appSecret, cano, acntPrdtCd, code, qty, { simulated = false } = {}) {
  const trId = simulated ? 'VTTC0801U' : 'TTTC0801U';
  const body = {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    PDNO: code,
    ORD_DVSN: '01',
    ORD_QTY: String(qty),
    ORD_UNPR: '0',
  };
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-cash',
    null,
    { token, appKey, appSecret, trId, body }
  );
  if (result.rt_cd !== '0') {
    throw new Error(`매도 주문 실패 (${code}, qty=${qty}): ${result.msg1 || result.msg_cd}`);
  }
  return {
    orderNo: result.output?.ODNO,
    orderTime: result.output?.ORD_TMD,
    krxFwdgOrdOrgno: result.output?.KRX_FWDG_ORD_ORGNO,
    raw: result.output,
    msg: result.msg1,
  };
}

// 주문 취소 (전량) — _waitForFill 후 잔량 남으면 호출
//   tr_id: TTTC0803U (실전 정정/취소) / VTTC0803U (모의)
//   QTY_ALL_ORD_YN='Y' + ORD_QTY='0' = 전량 취소
//   RVSE_CNCL_DVSN_CD='02' = 취소 (01=정정)
//   원주문의 ORD_DVSN(주문구분)과 동일하게 — 시장가 매수/매도는 '01'
async function cancelOrder(token, appKey, appSecret, cano, acntPrdtCd, krxFwdgOrdOrgno, origOrderNo, { simulated = false, ordDvsn = '01' } = {}) {
  const trId = simulated ? 'VTTC0803U' : 'TTTC0803U';
  if (!krxFwdgOrdOrgno || !origOrderNo) {
    throw new Error(`취소 파라미터 부족: krxFwdgOrdOrgno=${krxFwdgOrdOrgno}, origOrderNo=${origOrderNo}`);
  }
  const body = {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    KRX_FWDG_ORD_ORGNO: krxFwdgOrdOrgno,
    ORGN_ODNO: origOrderNo,
    ORD_DVSN: ordDvsn,                  // 원주문 구분 동일
    RVSE_CNCL_DVSN_CD: '02',            // 02 = 취소
    ORD_QTY: '0',                       // 전량 취소면 0
    ORD_UNPR: '0',
    QTY_ALL_ORD_YN: 'Y',                // Y = 잔량 전부 취소
  };
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-rvsecncl',
    null,
    { token, appKey, appSecret, trId, body }
  );
  if (result.rt_cd !== '0') {
    throw new Error(`취소 실패 (orig=${origOrderNo}): ${result.msg1 || result.msg_cd}`);
  }
  return {
    cancelOrderNo: result.output?.ODNO,
    cancelTime: result.output?.ORD_TMD,
    msg: result.msg1,
  };
}

// 주문 체결 조회 (실제 체결가·체결수량 확인용)
//   당일 주문 한 건 조회
async function inquireOrderDetail(token, appKey, appSecret, cano, acntPrdtCd, orderNo, { simulated = false } = {}) {
  const trId = simulated ? 'VTTC8001R' : 'TTTC8001R';
  // 당일 주문 조회 — 주문일자 = 오늘 KST
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const params = {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    INQR_STRT_DT: today,
    INQR_END_DT: today,
    SLL_BUY_DVSN_CD: '00',     // 00 = 전체
    INQR_DVSN: '01',           // 01 = 역순 (최근 주문부터)
    PDNO: '',
    CCLD_DVSN: '00',           // 00 = 전체
    ORD_GNO_BRNO: '',
    ODNO: orderNo,
    INQR_DVSN_3: '00',
    INQR_DVSN_1: '',
    CTX_AREA_FK100: '',
    CTX_AREA_NK100: '',
  };
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
    params,
    { token, appKey, appSecret, trId }
  );
  if (result.rt_cd !== '0') throw new Error(`주문 조회 실패: ${result.msg1 || result.msg_cd}`);
  const o = (result.output1 || [])[0];
  if (!o) return null;
  return {
    orderNo,
    code: o.pdno,
    qtyOrdered: parseInt(o.ord_qty) || 0,
    qtyFilled: parseInt(o.tot_ccld_qty) || 0,
    avgPrice: parseFloat(o.avg_prvs) || 0,           // 평균 체결가
    remainQty: parseInt(o.rmn_qty) || 0,
    sellBuy: o.sll_buy_dvsn_cd,                      // 01=매도, 02=매수
    raw: o,
  };
}

// ── 당일 분봉 조회 (최대 30개 분봉 = 30분치) ────────────────
//   tr_id: FHKST03010200 (당일 분봉, 실전/모의 동일)
//   endpoint: /uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice
//   inputHour='153000' 같이 지정하면 그 시각 이전 30분 (역순) 반환.
//   비워두면 가장 최근.
//
//   ⚠️ 활성화 안 됨 (poll_minute_vol.py + 네이버 분봉이 SSoT). naver-vs-kis 비교 / 향후 전환 검토용.
//   사용 시: 종목당 1회 호출 → 분당 호출 부하 작음.
async function getMinuteCandles(token, appKey, appSecret, code, { inputHour = '' } = {}) {
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
    {
      FID_ETC_CLS_CODE: '',
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_HOUR_1: inputHour,   // HHMMSS 또는 빈 문자열
      FID_PW_DATA_INCU_YN: 'N',      // N = 과거데이터 미포함 (당일만)
    },
    { token, appKey, appSecret, trId: 'FHKST03010200' }
  );
  if (result.rt_cd !== '0') throw new Error(`${code}: ${result.msg1 || '분봉 조회 실패'}`);
  // output1 = summary, output2 = bars[]
  const bars = (result.output2 || []).map(b => ({
    time: b.stck_cntg_hour,                            // HHMMSS
    open: parseInt(b.stck_oprc) || 0,
    high: parseInt(b.stck_hgpr) || 0,
    low: parseInt(b.stck_lwpr) || 0,
    close: parseInt(b.stck_prpr) || 0,
    volume: parseInt(b.cntg_vol) || 0,                 // 분봉 체결 수량
    value: parseInt(b.acml_tr_pbmn) || 0,              // 누적 거래대금
  })).reverse();                                       // 응답은 역순 → 시간순으로 정렬
  return {
    code,
    bars,                                              // 시간 오름차순
    prevClose: parseInt(result.output1?.stck_prdy_clpr) || 0,  // D-1 종가 (summary)
    open: parseInt(result.output1?.stck_oprc) || 0,
  };
}

module.exports = {
  getToken,
  ensureToken,
  getCurrentPrice,
  fetchMultPrices,
  getOrderbook,
  getMinuteCandles,
  inquireBalance,
  orderBuyMarket,
  orderSellMarket,
  cancelOrder,
  inquireOrderDetail,
  KIS_MIN_INTERVAL_MS,
};
