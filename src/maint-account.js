// maint-account.js — maint 계정 store(SSoT)에서 KIS 키를 로컬 해석.
// 엔진엔 accountRef(id)만 저장하고, 실제 appKey/secret/cano 는 부팅 때 이 맥에서
// `maint account get <id>` CLI 로 해석한다. 평문 키는 HTTP/공개 터널에 절대 안 나감.
// 해석 실패 시 null → 호출부에서 .env/config.json 키로 폴백 (운영 중 엔진 안 깨짐).
//
// 같은 패턴이 POLLUX 등 다른 엔진에도 복사됨 (no-buy-calendar.js 처럼 엔진별 동일 코드).
const { execFileSync } = require('child_process');

const MAINT_BIN = process.env.MAINT_BIN
  || '/Users/sean/Desktop/project/maintence/bin/maint.js';

function _run(args) {
  return execFileSync(process.execPath, [MAINT_BIN, 'account', ...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'], // stderr 캡처(로그 오염 방지), stdout 만 파싱
  });
}

// 드롭다운용 — 시크릿 없는 목록 [{id,name,type,mode,cano,last4}]
function listAccounts() {
  try {
    const arr = JSON.parse(_run(['list', '--json']));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 해석 — accountRef → {id,name,type,mode,appKey,appSecret,cano,acntPrdtCd} | null
function resolveAccount(ref) {
  if (!ref || typeof ref !== 'string') return null;
  try {
    const acc = JSON.parse(_run(['get', ref, '--json']));
    return acc && acc.appKey ? acc : null;
  } catch {
    return null;
  }
}

module.exports = { listAccounts, resolveAccount, MAINT_BIN };
