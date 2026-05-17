#!/usr/bin/env bash
set -euo pipefail

# 根目录快捷入口。实际启动逻辑集中在 scripts/start_panel.sh，避免多个脚本规则不一致。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/scripts/start_panel.sh" "$@"
