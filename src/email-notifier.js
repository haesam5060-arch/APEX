// Gmail 제거 — notify-client 통일 포맷으로 전환
const notify = require('./notify-client');
const ENGINE = 'APEX';

function init() {}

// notify-client 경유라 항상 사용 가능 (scheduler 로그용)
function isReady() { return true; }

async function send(subject, html) {
  const text = String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const isError = /오류|error|실패/i.test(subject);
  if (isError) {
    await notify.error({ engine: ENGINE, title: subject, detail: text });
  } else {
    await notify.check({ engine: ENGINE, title: subject, message: text.slice(0, 300) });
  }
}

function toHtml(content) { return content; }
function inferSubject(content) { return content?.split('\n')[0] || ENGINE; }

module.exports = { init, send, toHtml, inferSubject, isReady };
