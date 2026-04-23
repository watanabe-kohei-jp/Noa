#!/bin/bash
# FastAPI サーバーを確実に再起動するスクリプト
# Usage: bash restart.sh [port]

PORT=${1:-8001}

echo "[restart] Killing all processes on port $PORT..."
for pid in $(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $NF}' | sort -u); do
  taskkill //PID "$pid" //F 2>/dev/null && echo "  Killed PID $pid" || true
done

# Python プロセスがまだ残っている場合
sleep 1
remaining=$(netstat -ano 2>/dev/null | grep ":$PORT.*LISTENING" | wc -l)
if [ "$remaining" -gt 0 ]; then
  echo "[restart] Port still in use, killing all python.exe..."
  taskkill //IM python.exe //F 2>/dev/null || true
  sleep 2
fi

echo "[restart] Starting uvicorn on port $PORT..."
cd "$(dirname "$0")"
# --timeout-keep-alive 75: dev rewrite proxy (Node http.Agent) が再利用する idle socket を
# uvicorn が 5 秒（デフォルト）で閉じると、proxy 側の再利用で ECONNRESET が発生する (Issue #124)。
# Node 標準と整合的にするため 75 秒に延長。
python -m uvicorn main:app --host 0.0.0.0 --port "$PORT" --reload --timeout-keep-alive 75 &
sleep 3

# 確認
status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/docs" 2>/dev/null)
if [ "$status" = "200" ]; then
  echo "[restart] Server running on port $PORT (HTTP $status)"
else
  echo "[restart] WARNING: Server may not be ready (HTTP $status)"
fi
