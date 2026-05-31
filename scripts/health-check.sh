#!/bin/bash
# APEX 헬스체크 (5분마다)
port=3101
while true; do
  if ! curl -s http://localhost:$port/api/status > /dev/null 2>&1; then
    echo "$(date) [ALERT] APEX 서버 다운! 재시작 중..."
    pkill -f "node server.js"
    sleep 2
    npm start > logs/apex-$(date +%Y%m%d).log 2>&1 &
  fi
  sleep 300
done
