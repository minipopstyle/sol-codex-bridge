#!/bin/bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.sol-codex.local-bridge.plist"
launchctl bootout "gui/$(id -u)/com.sol-codex.local-bridge" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "已停止并移除 LaunchAgent。"
echo "用户配置仍保留在 ~/.sol-codex-bridge；如需完全删除可手动移除该目录。"
read -n 1 -s -r -p "按任意键关闭…"
echo
