#!/bin/zsh

set -u

LABEL="com.sol-codex.run-in-codex-poc-publish"
DOMAIN="gui/$(id -u)"
JOB="$DOMAIN/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_HOME="$HOME/.sol-codex-run-in-codex-poc-publish"

/bin/launchctl bootout "$JOB" >/dev/null 2>&1 || true
/bin/rm -f "$PLIST"
/bin/rm -rf "$APP_HOME"

print -r -- "发布版 Bridge 已卸载干净。"
print -r -- "已移除：$JOB、$PLIST、$APP_HOME"
print -r -- "共享 Pairing Token 未修改。"
