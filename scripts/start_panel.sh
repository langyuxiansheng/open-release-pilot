#!/usr/bin/env bash
set -euo pipefail

# Open Release Pilot 本地启动脚本。
#
# 设计目标：
# 1. 默认以前台方式启动服务，方便在终端直接看到服务端日志。
# 2. 启动前检查端口占用，避免 node 报 EADDRINUSE 时用户不知道该杀哪个进程。
# 3. 只在用户明确传 --kill-port / --stop 时才终止进程，避免误杀其它项目的服务。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
KILL_PORT=0
STATUS_ONLY=0
STOP_ONLY=0

usage() {
  cat <<EOF
Open Release Pilot 启动脚本

用法：
  ./start.sh
  ./start.sh --port 8788
  ./start.sh --kill-port
  ./start.sh --status
  ./start.sh --stop

参数：
  --port <port>    指定启动端口，默认 8787。
  --kill-port      如果端口已被占用，先终止占用进程再启动。
  --status         只查看当前端口占用，不启动服务。
  --stop           终止当前端口上的 open-release-pilot 服务，不启动服务。
  -h, --help       查看帮助。

环境变量：
  PORT             等同 --port。
  HOST             服务监听地址，默认 0.0.0.0。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --kill-port)
      KILL_PORT=1
      shift
      ;;
    --status)
      STATUS_ONLY=1
      shift
      ;;
    --stop)
      STOP_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$PORT" || ! "$PORT" =~ ^[0-9]+$ ]]; then
  echo "端口必须是数字：${PORT}"
  exit 1
fi

port_pids() {
  lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
}

process_cwd() {
  local pid="$1"
  lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

print_port_status() {
  local pids
  pids="$(port_pids)"
  if [[ -z "$pids" ]]; then
    echo "端口 ${PORT} 当前未被占用。"
    return
  fi

  echo "端口 ${PORT} 当前被以下进程占用："
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
  echo
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    echo "PID ${pid} 工作目录：$(process_cwd "$pid")"
  done <<< "$pids"
}

kill_port_processes() {
  local pids
  pids="$(port_pids)"
  [[ -z "$pids" ]] && return

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    local cwd
    cwd="$(process_cwd "$pid")"
    if [[ "$cwd" != "$PANEL_ROOT" ]]; then
      echo "拒绝自动终止 PID ${pid}：工作目录不是当前项目。"
      echo "工作目录：${cwd}"
      echo "如确认要杀，请手动执行：kill ${pid}"
      exit 1
    fi
    echo "终止旧服务 PID ${pid}..."
    kill "$pid"
  done <<< "$pids"

  # 给 Node 进程一点退出时间，避免端口短时间仍处于占用状态。
  sleep 1
}

cd "$PANEL_ROOT"

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  print_port_status
  exit 0
fi

if [[ "$STOP_ONLY" -eq 1 ]]; then
  kill_port_processes
  echo "已处理端口 ${PORT} 上的 open-release-pilot 服务。"
  exit 0
fi

if [[ -n "$(port_pids)" ]]; then
  print_port_status
  if [[ "$KILL_PORT" -eq 1 ]]; then
    kill_port_processes
  else
    echo
    echo "端口 ${PORT} 已被占用。可以执行："
    echo "  ./start.sh --kill-port"
    echo "或换端口："
    echo "  ./start.sh --port 8788"
    exit 1
  fi
fi

echo "启动 Open Release Pilot..."
echo "项目目录：${PANEL_ROOT}"
echo "监听地址：${HOST}:${PORT}"
exec env HOST="$HOST" PORT="$PORT" node server.js
