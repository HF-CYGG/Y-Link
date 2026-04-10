#!/bin/sh
set -e

mkdir -p /app/data /run/nginx

export PORT="${PORT:-3001}"
export LOG_COLOR="${LOG_COLOR:-true}"
export FORCE_COLOR="${FORCE_COLOR:-1}"
export DB_TYPE="${DB_TYPE:-sqlite}"
export SQLITE_DB_PATH="${SQLITE_DB_PATH:-/app/data/y-link.sqlite}"
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-3306}"
export DB_USER="${DB_USER:-root}"
export DB_PASSWORD="${DB_PASSWORD:-}"
export DB_NAME="${DB_NAME:-y_link}"
export DB_SYNC="${DB_SYNC:-false}"
export INIT_ADMIN_USERNAME="${INIT_ADMIN_USERNAME:-admin}"
export INIT_ADMIN_PASSWORD="${INIT_ADMIN_PASSWORD:-Admin@123456}"
export INIT_ADMIN_DISPLAY_NAME="${INIT_ADMIN_DISPLAY_NAME:-系统管理员}"

# 统一替换 nginx 反向代理端口，确保与后端实际监听端口保持一致。
sed "s/__BACKEND_PORT__/${PORT}/g" /etc/nginx/conf.d/default.conf > /etc/nginx/conf.d/default.runtime.conf
mv /etc/nginx/conf.d/default.runtime.conf /etc/nginx/conf.d/default.conf

echo "[onebox] starting backend on 127.0.0.1:${PORT}"
node /app/backend/dist/index.js &
BACKEND_PID=$!

echo "[onebox] starting nginx on 0.0.0.0:80"
nginx -g "daemon off;" &
NGINX_PID=$!

# 容器收到停止信号时，优先优雅停止两个进程，避免残留僵尸进程。
cleanup() {
  echo "[onebox] received stop signal, shutting down..."
  kill -TERM "$NGINX_PID" 2>/dev/null || true
  kill -TERM "$BACKEND_PID" 2>/dev/null || true
  wait "$NGINX_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}

trap cleanup INT TERM

# 进程守护：任一关键进程退出，都让容器退出并交给平台自动重启。
while :; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[onebox] backend exited unexpectedly"
    kill -TERM "$NGINX_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
    exit 1
  fi

  if ! kill -0 "$NGINX_PID" 2>/dev/null; then
    echo "[onebox] nginx exited unexpectedly"
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    exit 1
  fi

  sleep 1
done
