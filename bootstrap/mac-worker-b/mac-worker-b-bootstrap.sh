#!/bin/bash
set -Eeuo pipefail
APP="$HOME/Library/Application Support/SpikeWorkerB"; PLIST="$HOME/Library/LaunchAgents/com.spikehome.worker-b.plist"; LOG="$APP/logs/bootstrap.log"
STAGE=bootstrap_start
trap 'rc=$?; printf "%s stage=ERR line=%s exit=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LINENO" "$rc" >> "$LOG" 2>/dev/null || true; exit "$rc"' ERR
stage() { STAGE="$1"; printf "%s stage=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAGE" >> "$LOG"; }
BRIDGE_URL='__BRIDGE_URL__'; PAIRING_SECRET='__PAIRING_SECRET__'; PORT='__MAC_PORT__'
mkdir -p "$APP/state" "$APP/logs" "$HOME/Library/LaunchAgents"
stage dirs_ready
EXACT_CODEX='/Applications/ChatGPT.app/Contents/Resources/codex'; if [ -x "$EXACT_CODEX" ]; then CODEX="$EXACT_CODEX"; else CODEX="$(command -v codex || true)"; fi
EXACT_PYTHON='/Library/Frameworks/Python.framework/Versions/3.9/bin/python3'; if [ -x "$EXACT_PYTHON" ]; then PYTHON3="$EXACT_PYTHON"; else PYTHON3="$(command -v python3 || true)"; fi
if [ -z "$CODEX" ] || [ -z "$PYTHON3" ]; then echo 'codex and python3 are required; nothing installed' >&2; exit 1; fi
stage runtimes_resolved
VERSION="$($CODEX --version 2>/dev/null | head -n 1 | tr -cd '[:print:]' | cut -c1-128 || true)"; [ -n "$VERSION" ] || { echo 'Codex version check failed; nothing installed.' >&2; exit 1; }; stage codex_version_ok
LOGIN_RAW="$($CODEX login status 2>/dev/null | head -n 1 | tr -cd '[:print:]' | cut -c1-128 || true)"
if printf '%s' "$LOGIN_RAW" | grep -Eiq 'not[[:space:]-]+logged|logged[[:space:]-]+out|not[[:space:]-]+authenticated|unauthenticated'; then echo 'Codex is not logged in; auth untouched.' >&2; exit 1; fi
if ! printf '%s' "$LOGIN_RAW" | grep -Eiq 'logged.?in|authenticated|active'; then echo 'Codex login status unknown; auth untouched.' >&2; exit 1; fi
LOGIN_STATUS=logged_in; stage login_status_ok
HELP="$($CODEX exec --help 2>/dev/null || true)"; for flag in '--json' '--output-last-message' '--model' '--cd' '--sandbox'; do printf '%s' "$HELP" | grep -F -- "$flag" >/dev/null || { echo "Codex CLI lacks verified flag: $flag; nothing installed." >&2; exit 1; }; done; stage exec_help_ok
WORKER_TMP="$APP/worker.py.tmp.$$"; WORKER="$APP/worker.py"; stage decode_worker_start
"$PYTHON3" -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read(), validate=True))' > "$WORKER_TMP" <<'SPIKE_WORKER_B64_END'
__DAEMON_B64__
SPIKE_WORKER_B64_END
if [ ! -s "$WORKER_TMP" ]; then echo 'Decoded worker is empty; nothing installed.' >&2; exit 1; fi
chmod 700 "$WORKER_TMP"
"$PYTHON3" -m py_compile "$WORKER_TMP"
mv -f "$WORKER_TMP" "$WORKER"; stage decode_worker_ok
stage plist_write_start
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.spikehome.worker-b</string><key>ProgramArguments</key><array><string>$PYTHON3</string><string>$APP/worker.py</string></array><key>EnvironmentVariables</key><dict><key>SPIKE_WORKER_B_BRIDGE_URL</key><string>$BRIDGE_URL</string><key>SPIKE_WORKER_B_PAIRING_SECRET</key><string>$PAIRING_SECRET</string><key>SPIKE_WORKER_B_PORT</key><string>$PORT</string><key>SPIKE_WORKER_B_CODEX</key><string>$CODEX</string><key>SPIKE_WORKER_B_LOGIN_STATUS</key><string>$LOGIN_STATUS</string><key>SPIKE_WORKER_B_CODEX_VERSION</key><string>$VERSION</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$APP/logs/stdout.log</string><key>StandardErrorPath</key><string>$APP/logs/stderr.log</string></dict></plist>
EOF
stage plist_write_ok
stage launchagent_start
launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; stage launchagent_ok
stage done; echo 'Spike Worker B installed and registered; Codex auth was not modified.'
