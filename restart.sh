#!/usr/bin/env bash
# ─── easy-wiki 重启脚本 ─────────────────────────────────────────
# 用法：bash restart.sh  或  ./restart.sh
#
# 作用：停止已有 server.js 进程，后台启动新的。
# 日志：log/server.log（自动创建 log 目录）

set -e
cd "$(dirname "$0")"

# 端口（从 web.config 读，缺省 82）
PORT=$(node -e "try{const c=require('./web.config');console.log(c.port||82)}catch(e){console.log(82)}" 2>/dev/null || echo 82)
# node 读取 web.config 会失败（带注释），改用 grep 兜底
if ! echo "$PORT" | grep -qE '^[0-9]+$'; then
  PORT=$(grep -E '"port"' web.config 2>/dev/null | grep -oE '[0-9]+' | head -1)
  PORT=${PORT:-82}
fi

# 停掉占用该端口的 node 进程
echo "==> 查找并停止 port=$PORT 上的 node 进程..."
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT/tcp" 2>/dev/null && echo "    已停止旧进程" || echo "    未发现运行中的进程"
elif command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    echo "    已停止 PID: $pids"
  else
    echo "    未发现运行中的进程"
  fi
else
  # 兜底：按进程名匹配
  pids=$(pgrep -f "node.*server\.js" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    echo "    已停止 PID: $pids"
  else
    echo "    未发现运行中的进程"
  fi
fi
sleep 1

# 启动
mkdir -p log
LOGFILE="log/server.log"
nohup node server.js >> "$LOGFILE" 2>&1 &
NEW_PID=$!
sleep 1

if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "==> easy-wiki 已启动 ✓"
  echo "    PID:      $NEW_PID"
  echo "    端口:     $PORT"
  echo "    日志:     $LOGFILE"
  echo "    停止命令: kill $NEW_PID  或再次运行 ./restart.sh"
else
  echo "==> 启动失败，请查看日志：$LOGFILE"
  tail -20 "$LOGFILE" 2>/dev/null || true
  exit 1
fi
