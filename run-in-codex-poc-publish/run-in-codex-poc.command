#!/bin/zsh

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_URL="http://127.0.0.1:4329"
EXISTING_BRIDGE="${SOL_CODEX_BRIDGE_ROOT:-$PROJECT_DIR/../../ChatGPT-with-Codex/sol-codex-bridge}"
APP_HOME="${SOL_CODEX_POC_HOME:-$HOME/.sol-codex-run-in-codex-poc-publish}"
PROJECT_PATH="${C2C_PROJECT_PATH:-$PROJECT_DIR}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
TOKEN_FILE="${SOL_CODEX_BRIDGE_TOKEN_FILE:-$HOME/.sol-codex-bridge/token}"
LABEL="com.sol-codex.run-in-codex-poc-publish"
DOMAIN="gui/$(id -u)"
JOB="$DOMAIN/$LABEL"
# The checked-in template keeps the historical filename; the installed copy uses the isolated label below.
PLIST="$PROJECT_DIR/com.sol-codex.run-in-codex-poc.plist"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

pause_terminal() {
  if [[ -t 0 ]]; then
    read -r "?按回车关闭窗口..." || true
  fi
}

check_source() {
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    print -r -- "找不到 Node.js，请设置 NODE_BIN。"
    return 1
  fi
  if [[ ! -f "$EXISTING_BRIDGE/bridge/lib/codex-cli.mjs" ]]; then
    print -r -- "找不到已有 sol-codex-bridge：$EXISTING_BRIDGE"
    return 1
  fi
}

sync_runtime() {
  mkdir -p "$APP_HOME" "$HOME/Library/LaunchAgents"
  cp -R "$PROJECT_DIR/bridge" "$APP_HOME/"
  cp -p "$PLIST" "$INSTALLED_PLIST"
  /usr/bin/plutil -remove ProgramArguments "$INSTALLED_PLIST"
  /usr/bin/plutil -insert ProgramArguments -xml '<array></array>' "$INSTALLED_PLIST"
  /usr/bin/plutil -insert "ProgramArguments.0" -string "$NODE_BIN" "$INSTALLED_PLIST"
  /usr/bin/plutil -insert "ProgramArguments.1" -string "$APP_HOME/bridge/server.mjs" "$INSTALLED_PLIST"
  /usr/bin/plutil -replace "WorkingDirectory" -string "$APP_HOME" "$INSTALLED_PLIST"
  /usr/bin/plutil -replace "EnvironmentVariables.SOL_CODEX_BRIDGE_ROOT" -string "$EXISTING_BRIDGE" "$INSTALLED_PLIST"
  /usr/bin/plutil -replace "EnvironmentVariables.C2C_PROJECT_PATH" -string "$PROJECT_PATH" "$INSTALLED_PLIST"
  /usr/bin/plutil -replace "StandardOutPath" -string "$APP_HOME/bridge.log" "$INSTALLED_PLIST"
  /usr/bin/plutil -replace "StandardErrorPath" -string "$APP_HOME/bridge.log" "$INSTALLED_PLIST"
}

stop_job() {
  /bin/launchctl bootout "$JOB" >/dev/null 2>&1 || true
}

wait_for_health() {
  local attempt
  for attempt in {1..20}; do
    if curl -sf "$BRIDGE_URL/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

start_job() {
  sync_runtime
  /bin/launchctl enable "$JOB" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "$DOMAIN" "$INSTALLED_PLIST" >/dev/null 2>&1 || true
  wait_for_health
}

start_or_keep_job() {
  if curl -sf "$BRIDGE_URL/health" >/dev/null 2>&1; then
    return 0
  fi
  start_job
}

restart_job() {
  stop_job
  start_job
}

pause_job() {
  /bin/launchctl disable "$JOB" >/dev/null 2>&1 || true
  stop_job
}

status_job() {
  if curl -sf "$BRIDGE_URL/health" >/dev/null 2>&1; then
    print -r -- "POC Bridge：运行中（$BRIDGE_URL）"
  else
    print -r -- "POC Bridge：未运行"
  fi
  /bin/launchctl print "$JOB" >/dev/null 2>&1 && print -r -- "launchd：已加载" || print -r -- "launchd：未加载或已暂停"
}

show_pairing_token() {
  if [[ -s "$TOKEN_FILE" ]]; then
    local token
    token="$(tr -d '\r\n' < "$TOKEN_FILE")"
    if [[ -n "$token" ]]; then
      if command -v pbcopy >/dev/null 2>&1; then
        printf '%s' "$token" | pbcopy
        print -r -- "Pairing Token 已复制到剪贴板：$TOKEN_FILE"
      else
        print -r -- "Pairing Token：$token"
      fi
      return 0
    fi
  fi
  print -r -- "未找到 Pairing Token：$TOKEN_FILE"
  return 1
}

ACTION="${1:-install}"
case "$ACTION" in
  install|start|restart|resume)
    if ! check_source; then
      pause_terminal
      exit 1
    fi
    ;;
esac

case "$ACTION" in
  install)
    if start_or_keep_job; then
      print -r -- "发布版已安装并启动，POC Bridge 由 macOS 保活。"
      show_pairing_token || true
    else
      print -r -- "首次安装失败。日志：$APP_HOME/bridge.log"
      status_job
      pause_terminal
      exit 1
    fi
    ;;
  start)
    if start_or_keep_job; then
      print -r -- "POC Bridge 已启动并由 macOS 保活。"
      show_pairing_token || true
    else
      print -r -- "POC Bridge 启动失败。日志：$APP_HOME/bridge.log"
      status_job
      pause_terminal
      exit 1
    fi
    ;;
  restart)
    if restart_job; then
      print -r -- "POC Bridge 已重启，已同步最新代码。"
    else
      print -r -- "POC Bridge 重启失败。日志：$APP_HOME/bridge.log"
      status_job
      pause_terminal
      exit 1
    fi
    ;;
  pause)
    pause_job
    print -r -- "POC Bridge 已暂停；不会自动重启。"
    ;;
  resume)
    if start_job; then
      print -r -- "POC Bridge 已恢复并由 macOS 保活。"
    else
      print -r -- "POC Bridge 恢复失败。日志：$APP_HOME/bridge.log"
      status_job
      pause_terminal
      exit 1
    fi
    ;;
  stop)
    stop_job
    print -r -- "POC Bridge 已停止。"
    ;;
  status)
    status_job
    ;;
  *)
    print -r -- "用法：install | start | restart | pause | resume | stop | status"
    pause_terminal
    exit 2
    ;;
esac

print -r -- "关闭这个窗口不会影响 Bridge。"
pause_terminal
