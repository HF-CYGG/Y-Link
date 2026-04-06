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

echo "[onebox] starting backend on 127.0.0.1:${PORT}"
node /app/backend/dist/index.js &
BACKEND_PID=$!

echo "[onebox] starting nginx on 0.0.0.0:80"
exec nginx -g "daemon off;"
