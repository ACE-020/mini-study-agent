#!/bin/sh
# 容器入口：只开一个 worker（任务表在进程内存里），并发交给线程。
#
# 端口约定：
#   微信云托管 → 监听 80（平台默认，且会注入 PORT=80）
#   自建 / docker compose → 用 PORT=8766，前面挂 Nginx
set -eu

PORT="${PORT:-80}"
DATA="${WX_API_DATA_DIR:-/data}"

mkdir -p "$DATA" 2>/dev/null || true
if [ ! -w "$DATA" ]; then
  echo "警告：$DATA 不可写，用户的笔记和错题会在实例重启后丢失。请挂载持久存储。" >&2
fi

echo "启动 study-agent-wx: port=$PORT data=$DATA"
exec gunicorn \
  --bind "0.0.0.0:${PORT}" \
  --workers 1 \
  --threads 16 \
  --timeout 0 \
  --graceful-timeout 30 \
  --access-logfile - \
  'wx_api:create_api()'
