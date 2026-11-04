#!/usr/bin/env bash
# ─── easy-wiki 启动脚本 ─────────────────────────────────────────
# 用法：./start.sh
#
# 作用：后台启动服务，日志写入 log/server.log
#       如果 node_modules 不存在，自动安装依赖
#       如果端口已被占用，提示使用 restart.sh

set -e
cd "$(dirname "$0")"

# 自动安装依赖（首次运行）
if [ ! -d "node_modules" ]; then
    echo "==> 首次运行，安装依赖..."
    npm install
    echo "    依赖安装完成 ✓"
fi

# 读取端口（从 web.config）
PORT=$(grep -E '"port"' web.config 2>/dev/null | grep -oE '[0-9]+' | head -1)
PORT=${PORT:-82}

# 检查端口是否已被占用
if command -v lsof >/dev/null 2>&1; then
    if lsof -ti :"$PORT" >/dev/null 2>&1; then
        echo "==> 端口 $PORT 已被占用"
        echo "    如需重启，请使用: ./restart.sh"
        exit 1
    fi
elif command -v fuser >/dev/null 2>&1; then
    if fuser "$PORT/tcp" >/dev/null 2>&1; then
        echo "==> 端口 $PORT 已被占用"
        echo "    如需重启，请使用: ./restart.sh"
        exit 1
    fi
fi

# 后台启动
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
    echo "    停止命令: kill $NEW_PID"
else
    echo "==> 启动失败，请查看日志：$LOGFILE"
    tail -20 "$LOGFILE" 2>/dev/null || true
    exit 1
fi
