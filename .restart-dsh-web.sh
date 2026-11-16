#!/bin/bash
LOG="$(cd "$(dirname "$0")" && pwd)/.restart-dsh-web.log"
: > "$LOG"
echo "===== $(date '+%F %T') 开始 =====" >> "$LOG"
sleep 3
OLD="${1:-0}"
if [ "$OLD" != "0" ] && kill -0 "$OLD" 2>/dev/null; then
  echo "[$(date '+%F %T')] kill $OLD" >> "$LOG"
  kill "$OLD" 2>/dev/null
fi
for i in $(seq 1 30); do
  if ! lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then echo "[$(date '+%F %T')] 端口已释放（第 ${i} 次探测）" >> "$LOG"; break; fi
  sleep 1
done
cd "$HOME" || { echo "cd HOME 失败" >> "$LOG"; exit 1; }
echo "[$(date '+%F %T')] 启动 dsh web" >> "$LOG"
nohup "$HOME/.local/bin/dsh" web >> "$LOG" 2>&1 &
echo "[$(date '+%F %T')] 新 PID=$!" >> "$LOG"
