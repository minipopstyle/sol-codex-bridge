#!/bin/bash
set -u
DATA_HOME="$HOME/.sol-codex-bridge"
APP_HOME="$DATA_HOME/app"
PLIST="$HOME/Library/LaunchAgents/com.sol-codex.local-bridge.plist"
LABEL="com.sol-codex.local-bridge"
DOMAIN="gui/$(id -u)"
PORT=37821

find_node() {
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
    [[ -n "$c" && -x "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
health() { /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
listener_pids() { /usr/sbin/lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true; }

kill_stale_bridge_listeners() {
  local pid cmd
  for pid in $(listener_pids); do
    cmd="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cmd" == *"$DATA_HOME/app/server.mjs"* ]]; then
      echo "清理旧 Bridge 进程 PID $pid"
      /bin/kill "$pid" >/dev/null 2>&1 || true
    else
      echo "⚠️ 端口 $PORT 被非 Bridge 进程占用：PID $pid"
      echo "   $cmd"
      return 2
    fi
  done

  for _ in {1..20}; do
    [[ -z "$(listener_pids)" ]] && return 0
    sleep .1
  done

  for pid in $(listener_pids); do
    cmd="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cmd" == *"$DATA_HOME/app/server.mjs"* ]]; then
      echo "强制清理旧 Bridge 进程 PID $pid"
      /bin/kill -9 "$pid" >/dev/null 2>&1 || true
    else
      return 2
    fi
  done
  sleep .15
  [[ -z "$(listener_pids)" ]]
}

stop_all_bridge_owners() {
  # 先撤销 LaunchAgent，避免我们清理端口时 KeepAlive 又立刻拉起新进程。
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  /bin/launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true

  if [[ -s "$DATA_HOME/manual.pid" ]]; then
    local pid
    pid="$(cat "$DATA_HOME/manual.pid" 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] && /bin/kill "$pid" >/dev/null 2>&1 || true
    rm -f "$DATA_HOME/manual.pid"
  fi

  sleep .2
  kill_stale_bridge_listeners
}

if ! stop_all_bridge_owners; then
  echo "❌ 无法安全清理端口 $PORT；上面显示的是占用该端口的非 Bridge 进程。"
  read -n 1 -s -r -p "按任意键关闭…"; echo; exit 1
fi

: > "$DATA_HOME/bridge.error.log"

# RunAtLoad 会在 bootstrap 后自动启动；不要再立即 kickstart -k，避免双启动竞态。
if [[ -f "$PLIST" ]]; then
  /bin/launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
fi
for i in {1..20}; do health && break; sleep .25; done

if ! health; then
  # 如果 LaunchAgent 没起来，先彻底撤销它，再启动唯一的手工 fallback。
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  /bin/launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  kill_stale_bridge_listeners >/dev/null 2>&1 || true

  NODE_BIN="$(find_node || true)"
  if [[ -z "$NODE_BIN" || ! -f "$APP_HOME/server.mjs" ]]; then
    echo "Bridge 未安装完整，请重新运行 install-bridge.command"
    read -n 1 -s -r -p "按任意键关闭…"; echo; exit 1
  fi
  NODE_NO_WARNINGS=1 /usr/bin/nohup "$NODE_BIN" "$APP_HOME/server.mjs" >>"$DATA_HOME/bridge.log" 2>>"$DATA_HOME/bridge.error.log" </dev/null &
  echo $! > "$DATA_HOME/manual.pid"
  for i in {1..20}; do health && break; sleep .25; done
fi

if health; then
  echo "✅ Bridge 已启动"
  if [[ -s "$DATA_HOME/manual.pid" ]]; then
    echo "启动方式：manual fallback"
  else
    echo "启动方式：LaunchAgent"
  fi
  /usr/bin/curl -sS "http://127.0.0.1:$PORT/api/health"; echo
  echo "监听进程："
  /usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || true
else
  echo "❌ Bridge 启动失败"
  tail -40 "$DATA_HOME/bridge.error.log" 2>/dev/null
fi
read -n 1 -s -r -p "按任意键关闭…"; echo
