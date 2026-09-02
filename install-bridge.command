#!/bin/bash
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="$HOME/.sol-codex-bridge/app"
DATA_HOME="$HOME/.sol-codex-bridge"
PLIST="$HOME/Library/LaunchAgents/com.sol-codex.local-bridge.plist"
LABEL="com.sol-codex.local-bridge"
DOMAIN="gui/$(id -u)"
PORT="37821"

pause_exit() {
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  echo
  exit "${1:-0}"
}

find_node() {
  local c=""
  for c in \
    "$(command -v node 2>/dev/null || true)" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "$HOME/.local/bin/node"; do
    [[ -n "$c" && -x "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

codex_has_command() {
  local bin="$1" cmd="$2" help=""
  [[ -x "$bin" ]] || return 1
  help="$("$bin" --help 2>&1 || true)"
  printf '%s\n' "$help" | /usr/bin/awk -v wanted="$cmd" '
    /^Commands:[[:space:]]*$/ { on=1; next }
    on && $1==wanted { found=1 }
    END { exit found ? 0 : 1 }
  '
}

find_codex() {
  local c="" first="" shell_codex=""
  local -a candidates=()

  # Explicit force remains available for debugging, but ordinary CODEX_BIN is
  # only a candidate. Prefer a queue-capable CLI for existing-session handoff.
  if [[ "${SOL_CODEX_FORCE_BIN:-0}" == "1" && -n "${CODEX_BIN:-}" && -x "${CODEX_BIN}" ]]; then
    printf '%s' "$CODEX_BIN"; return
  fi

  shell_codex="$(command -v codex 2>/dev/null || true)"
  candidates+=(
    "${CODEX_BIN:-}"
    "/Applications/Codex.app/Contents/Resources/codex"
    "$HOME/Applications/Codex.app/Contents/Resources/codex"
    "/Applications/ChatGPT.app/Contents/Resources/codex"
    "$HOME/Applications/ChatGPT.app/Contents/Resources/codex"
    "$shell_codex"
    "/opt/homebrew/bin/codex"
    "/usr/local/bin/codex"
    "$HOME/.npm-global/bin/codex"
    "$HOME/.local/bin/codex"
    "$HOME/.cargo/bin/codex"
    "$HOME/Library/pnpm/codex"
  )

  for c in "${candidates[@]}"; do
    [[ -n "$c" && -x "$c" ]] || continue
    [[ -z "$first" ]] && first="$c"
    if codex_has_command "$c" queue; then
      printf '%s' "$c"; return
    fi
  done
  [[ -n "$first" ]] && printf '%s' "$first"
}

health_ok() {
  /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
}

wait_health() {
  local i
  for i in {1..20}; do
    health_ok && return 0
    sleep 0.25
  done
  return 1
}

listener_pids() {
  /usr/sbin/lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true
}

kill_stale_bridge_listeners() {
  local pid cmd
  for pid in $(listener_pids); do
    cmd="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cmd" == *"$DATA_HOME/app/server.mjs"* ]]; then
      echo "清理旧 Bridge 进程 PID $pid"
      /bin/kill "$pid" >/dev/null 2>&1 || true
    else
      echo "❌ 端口 $PORT 被非 Bridge 进程占用：PID $pid"
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
    [[ "$cmd" == *"$DATA_HOME/app/server.mjs"* ]] || return 2
    /bin/kill -9 "$pid" >/dev/null 2>&1 || true
  done
  sleep .15
  [[ -z "$(listener_pids)" ]]
}

stop_previous() {
  # 先撤销 LaunchAgent，避免 KeepAlive 在端口清理期间立即重新拉起旧进程。
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

start_manual_fallback() {
  echo "⚠️ LaunchAgent 未能拉起 Bridge，自动切换为本次登录会话的后台启动模式。"
  # fallback 前必须先撤销 LaunchAgent，否则 KeepAlive 会和 fallback 争抢同一端口。
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  /bin/launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  kill_stale_bridge_listeners >/dev/null 2>&1 || true
  NODE_NO_WARNINGS=1 /usr/bin/nohup "$NODE_BIN" "$APP_HOME/server.mjs" >>"$DATA_HOME/bridge.log" 2>>"$DATA_HOME/bridge.error.log" </dev/null &
  echo $! > "$DATA_HOME/manual.pid"
  wait_health
}

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ 未找到 Node.js。请先安装 Node.js 18+。"
  pause_exit 1
fi

NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "❌ Node.js 版本过低：$($NODE_BIN --version 2>/dev/null)，需要 18+。"
  pause_exit 1
fi

CODEX_DETECTED="$(find_codex || true)"
mkdir -p "$APP_HOME" "$DATA_HOME" "$HOME/Library/LaunchAgents"
cp -R "$HERE/bridge/." "$APP_HOME/"
INJECTOR_APP="$DATA_HOME/Sol Codex Bridge.app"
if ! /usr/bin/osacompile -o "$INJECTOR_APP" "$APP_HOME/desktop-injector.applescript"; then
  echo "❌ 无法创建 Sol Codex Bridge.app。"
  pause_exit 1
fi

if [[ -n "$CODEX_DETECTED" ]]; then
  printf '%s\n' "$CODEX_DETECTED" > "$DATA_HOME/codex-bin"
fi

TOKEN_FILE="$DATA_HOME/token"
if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  TOKEN="$(openssl rand -hex 24)"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
fi
TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"

LAUNCH_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/Library/pnpm"
CODEX_ENV_XML=""
if [[ -n "$CODEX_DETECTED" ]]; then
  # Paths are normal macOS paths; escape XML-sensitive characters defensively.
  CODEX_XML="$(printf '%s' "$CODEX_DETECTED" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
  CODEX_ENV_XML="<key>CODEX_BIN</key><string>$CODEX_XML</string>"
fi
NODE_XML="$(printf '%s' "$NODE_BIN" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
APP_XML="$(printf '%s' "$APP_HOME/server.mjs" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
PATH_XML="$(printf '%s' "$LAUNCH_PATH" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
OUT_XML="$(printf '%s' "$DATA_HOME/bridge.log" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
ERR_XML="$(printf '%s' "$DATA_HOME/bridge.error.log" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$APP_XML</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_XML</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
    $CODEX_ENV_XML
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$OUT_XML</string>
  <key>StandardErrorPath</key><string>$ERR_XML</string>
</dict>
</plist>
PLIST

if ! /usr/bin/plutil -lint "$PLIST" >/dev/null; then
  echo "❌ LaunchAgent plist 无效：$PLIST"
  /usr/bin/plutil -lint "$PLIST"
  pause_exit 1
fi

if ! stop_previous; then
  echo "❌ 无法安全清理旧 Bridge 进程或端口 $PORT。"
  pause_exit 1
fi
: > "$DATA_HOME/bridge.error.log"

BOOTSTRAP_OUT="$DATA_HOME/bootstrap.error.log"
: > "$BOOTSTRAP_OUT"
# RunAtLoad 会在 bootstrap 后自动启动。不要紧接着 kickstart -k；那会制造双启动竞态。
/bin/launchctl bootstrap "$DOMAIN" "$PLIST" >"$BOOTSTRAP_OUT" 2>&1 || true

if ! wait_health; then
  # launchctl can fail during upgrades (stale registration / transient GUI domain issues).
  # A manual background fallback keeps the bridge testable immediately instead of leaving the extension offline.
  if ! start_manual_fallback; then
    echo
    echo "❌ Bridge 仍未启动。以下是自动诊断信息："
    echo "--- launchctl ---"
    /bin/launchctl print "$DOMAIN/$LABEL" 2>&1 | tail -40 || true
    echo "--- bootstrap ---"
    tail -30 "$BOOTSTRAP_OUT" 2>/dev/null || true
    echo "--- bridge.error.log ---"
    tail -40 "$DATA_HOME/bridge.error.log" 2>/dev/null || true
    echo "--- port $PORT ---"
    /usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || true
    pause_exit 1
  fi
fi

printf '%s' "$TOKEN" | pbcopy

HEALTH="$(/usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
echo
echo "✅ Sol → Codex Local Bridge v0.2.10 已启动"
echo "Bridge: http://127.0.0.1:${PORT}"
if [[ -s "$DATA_HOME/manual.pid" ]]; then
  echo "启动方式: 后台 fallback（本次登录会话有效；restart-bridge.command 可重新拉起）"
else
  echo "启动方式: macOS LaunchAgent"
fi
if [[ -n "$CODEX_DETECTED" ]]; then
  echo "Codex CLI: $CODEX_DETECTED"
  "$CODEX_DETECTED" --version 2>/dev/null | head -1 || true
else
  echo "⚠️ 安装器暂未找到 Codex CLI；Bridge 启动后还会继续检测 Codex.app 内置 CLI。"
fi
echo "Health: ${HEALTH:0:220}"
echo "Pairing Token 已复制到剪贴板。"
echo "已有会话发送使用 Codex Resume/Queue，不需要辅助功能权限。"
echo
echo "回到 ChatGPT 插件侧栏，点击右上角刷新。无需重新加载扩展。"
pause_exit 0
