#!/bin/bash
set +e
DATA_HOME="$HOME/.sol-codex-bridge"
PLIST="$HOME/Library/LaunchAgents/com.sol-codex.local-bridge.plist"
LABEL="com.sol-codex.local-bridge"
DOMAIN="gui/$(id -u)"
PORT=37821

echo "=== Sol → Codex Bridge Diagnose v0.2.11 ==="
echo "date: $(date)"
echo "macOS: $(sw_vers -productVersion 2>/dev/null || uname -a)"
echo "node: $(command -v node 2>/dev/null) $(node --version 2>/dev/null)"
echo "shell codex: $(command -v codex 2>/dev/null)"
echo "saved codex: $(cat "$DATA_HOME/codex-bin" 2>/dev/null)"

echo
echo "=== Bridge health ==="
curl -sS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>&1; echo

echo
echo "=== LaunchAgent ==="
plutil -lint "$PLIST" 2>&1
launchctl print "$DOMAIN/$LABEL" 2>&1 | tail -80

echo
echo "=== Manual fallback ==="
if [[ -s "$DATA_HOME/manual.pid" ]]; then
  pid="$(cat "$DATA_HOME/manual.pid")"; echo "manual.pid=$pid"; ps -p "$pid" -o pid,ppid,state,lstart,command 2>&1
else
  echo "manual.pid: none"
fi

echo
echo "=== Port $PORT ==="
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>&1

echo
echo "=== Known Codex binaries ==="
for p in \
  "$(command -v codex 2>/dev/null)" \
  "/Applications/Codex.app/Contents/Resources/codex" \
  "$HOME/Applications/Codex.app/Contents/Resources/codex" \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" \
  "/opt/homebrew/bin/codex" \
  "/usr/local/bin/codex" \
  "$HOME/.npm-global/bin/codex" \
  "$HOME/.local/bin/codex" \
  "$HOME/.cargo/bin/codex" \
  "$HOME/Library/pnpm/codex"; do
  [[ -z "$p" ]] && continue
  if [[ -x "$p" ]]; then
    echo "FOUND: $p"
    "$p" --version 2>&1 | head -1
    HELP="$($p --help 2>&1)"
    for cmd in queue fork app; do
      if printf '%s\n' "$HELP" | awk '/^Commands:/{on=1;next} on && $1=="'"$cmd"'"{found=1} END{exit found?0:1}'; then
        echo "  $cmd: yes"
      else
        echo "  $cmd: no"
      fi
    done
  fi
done

echo

echo "=== Codex Desktop ==="
DESKTOP_FOUND=0
DESKTOP_PATH=""
DESKTOP_BUNDLE=""
for APP in "/Applications/ChatGPT.app" "/Applications/Codex.app" "$HOME/Applications/ChatGPT.app" "$HOME/Applications/Codex.app"; do
  [[ -d "$APP" ]] || continue
  BID=$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist" 2>/dev/null)
  EMBEDDED="$APP/Contents/Resources/codex"
  if [[ "$BID" == "com.openai.codex" || ( -x "$EMBEDDED" && "$BID" == com.openai.* ) ]]; then
    echo "Desktop: FOUND $APP ($BID)"
    if [[ "$DESKTOP_FOUND" == "0" || "$BID" == "com.openai.codex" ]]; then
      DESKTOP_FOUND=1
      DESKTOP_PATH="$APP"
      DESKTOP_BUNDLE="$BID"
    fi
  fi
done
INJECTOR_APP="$DATA_HOME/Sol Codex Bridge.app"
if [[ -d "$INJECTOR_APP" ]]; then
  echo "Accessibility helper: $INJECTOR_APP"
  echo "在系统设置 → 隐私与安全性 → 辅助功能中允许“Sol Codex Bridge”。"
else
  echo "Accessibility helper: not installed（请重新运行 install-bridge.command）"
fi

echo "=== Codex local storage ==="
echo "CODEX_HOME=${CODEX_HOME:-$HOME/.codex}"
SOCK="${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
if [[ -S "$SOCK" ]]; then echo "app-server socket: FOUND $SOCK"; else echo "app-server socket: not found ($SOCK)"; fi
ls -lh "${CODEX_SQLITE_HOME:-${CODEX_HOME:-$HOME/.codex}}/state_5.sqlite" 2>/dev/null || echo "state_5.sqlite: not found"

CONFIG_TOML="${CODEX_HOME:-$HOME/.codex}/config.toml"
echo
echo "=== Codex config quick check ==="
if [[ -f "$CONFIG_TOML" ]]; then
  echo "config.toml: $CONFIG_TOML"
  MODEL_PROVIDER="$(awk -F= '/^[[:space:]]*model_provider[[:space:]]*=/{gsub(/[[:space:]\"'\'' ]/,"",$2); print $2; exit}' "$CONFIG_TOML")"
  echo "model_provider: ${MODEL_PROVIDER:-default}"
  if [[ -n "$MODEL_PROVIDER" && "$MODEL_PROVIDER" != "openai" ]]; then
    if grep -Eq "^[[:space:]]*\\[model_providers\\.${MODEL_PROVIDER//./\\.}\\][[:space:]]*$" "$CONFIG_TOML"; then
      echo "provider table: found [model_providers.$MODEL_PROVIDER]"
    else
      echo "provider table: MISSING [model_providers.$MODEL_PROVIDER]"
      echo "⚠️  这会导致 codex queue / 会话重新加载时报 Model provider '$MODEL_PROVIDER' not found。"
    fi
  fi
else
  echo "config.toml: not found (using defaults)"
fi

DB_PATH="${CODEX_SQLITE_HOME:-${CODEX_HOME:-$HOME/.codex}}/state_5.sqlite"
echo
echo "=== Durable queue schema ==="
if [[ -f "$DB_PATH" && -x "$(command -v node 2>/dev/null)" ]]; then
  NODE_NO_WARNINGS=1 node - "$DB_PATH" <<'NODE'
const dbPath = process.argv[2];
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT type,name FROM sqlite_master WHERE name IN ('queued_items','queued_thread_revisions','queued_items_revision_after_insert') ORDER BY type,name").all();
  console.log(rows.length ? rows.map(r => `${r.type}: ${r.name}`).join('\n') : 'queue schema: not found');
  db.close();
} catch (e) {
  console.log(`queue schema check unavailable: ${e.message}`);
}
NODE
else
  echo "queue schema check unavailable"
fi

echo
if [[ -S "$SOCK" ]]; then
  HAS_SOCK=1
else
  HAS_SOCK=0
fi
if [[ -f "$DB_PATH" && -x "$(command -v node 2>/dev/null)" ]]; then
  if NODE_NO_WARNINGS=1 node - "$DB_PATH" <<'NODE' >/tmp/sol-codex-queue-check.$$ 2>/dev/null
const dbPath = process.argv[2];
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='trigger'").all().map(r => r.name));
  const ok = names.has('queued_items') && names.has('queued_thread_revisions') && names.has('queued_items_revision_after_insert');
  console.log(ok ? '1' : '0');
  db.close();
} catch {
  console.log('0');
}
NODE
  then
    HAS_QUEUE_SCHEMA=$(cat /tmp/sol-codex-queue-check.$$)
    rm -f /tmp/sol-codex-queue-check.$$
  else
    HAS_QUEUE_SCHEMA=0
  fi
else
  HAS_QUEUE_SCHEMA=0
fi

echo "=== Existing-thread handoff ==="
if [[ "$HAS_SOCK" == "1" ]]; then
  echo "handoff: app-server daemon"
elif [[ "$HAS_QUEUE_SCHEMA" == "1" ]]; then
  echo "handoff: durable queue"
elif [[ "$DESKTOP_FOUND" == "1" && -d "$INJECTOR_APP" ]]; then
  echo "handoff: Desktop UI fallback installed（需允许 Sol Codex Bridge 辅助功能）"
  echo "Desktop path: $DESKTOP_PATH"
  echo "Desktop bundle: $DESKTOP_BUNDLE"
elif [[ "$DESKTOP_FOUND" == "1" ]]; then
  echo "handoff: Desktop found, accessibility helper missing"
else
  echo "handoff: unavailable (Codex Desktop not found)"
fi

echo
echo "=== bootstrap.error.log ==="
tail -50 "$DATA_HOME/bootstrap.error.log" 2>/dev/null

echo
echo "=== bridge.log ==="
tail -50 "$DATA_HOME/bridge.log" 2>/dev/null

echo
echo "=== bridge.error.log ==="
tail -80 "$DATA_HOME/bridge.error.log" 2>/dev/null

echo
read -n 1 -s -r -p "按任意键关闭…"; echo
