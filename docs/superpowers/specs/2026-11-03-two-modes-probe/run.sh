#!/usr/bin/env bash
# Probe only. Runs the two-modes probe on a Linux box with Debian Chromium:
# a private Xvfb with an X auth cookie, a throwaway HOME and profile, local
# *.localhost sites, the probe relay, and Chromium with the probe extension.
# Usage: PW_DIR=<folder with playwright-core, @playwright/mcp and ws> RUN=<scratch folder> ./run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${PW_DIR:?set PW_DIR}"
: "${RUN:?set RUN to an empty scratch folder}"
DISPLAY_N="${DISPLAY_N:-117}"
# A Unix socket path holds at most 107 bytes, so the socket lives in the runtime folder.
SOCK="${SOCK:-${XDG_RUNTIME_DIR:-/tmp}/ab-v16-probe-$$.sock}"
RES="$HERE/results"
mkdir -p "$RUN" "$RES" "$RUN/home/Downloads" "$RUN/dl" "$RUN/mcp-out"
chmod 700 "$RUN"
cp -r "$HERE/ext" "$RUN/ext"           # Chromium writes _metadata/ into the folder
# NO_FRAME_GUARD=1 is the control run: it leaves out the frame rule (id 3) of the copy.
if [ "${NO_FRAME_GUARD:-}" = 1 ]; then
  python3 -c 'import json,sys; p=sys.argv[1]; r=[x for x in json.load(open(p)) if x["id"]!=3]; json.dump(r,open(p,"w"))' "$RUN/ext/rules.json"
  RES="$RUN/results-control"; mkdir -p "$RES"
fi
printf 'probe upload body\n' > "$RUN/upload.txt"
: > "$RUN/site-log.jsonl"; : > "$RUN/relay-log.jsonl"

# The X auth file: one FamilyWild MIT-MAGIC-COOKIE-1 entry, 0600; the cookie is never in an argv.
python3 - "$RUN/xauth" "$DISPLAY_N" <<'PY'
import os, sys
path, display = sys.argv[1], sys.argv[2]
f = lambda b: len(b).to_bytes(2, "big") + b
entry = (0xFFFF).to_bytes(2, "big") + f(b"") + f(display.encode()) + f(b"MIT-MAGIC-COOKIE-1") + f(os.urandom(16))
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, entry); os.close(fd)
PY

# Refuse to start when the display or a port is taken: Chromium would join a foreign
# X server, or the extension would take calls from a foreign process on 8790.
if [ -e "/tmp/.X11-unix/X$DISPLAY_N" ] || [ -e "/tmp/.X$DISPLAY_N-lock" ]; then echo "display :$DISPLAY_N is taken" >&2; exit 1; fi
for port in 8781 8790; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "port $port is taken" >&2; exit 1; fi
done
# Over loopback TCP a CDP client must send this token; it goes in the environment, never in argv.
RELAY_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export RELAY_TOKEN

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

Xvfb ":$DISPLAY_N" -nolisten tcp -auth "$RUN/xauth" -screen 0 1280x900x24 >"$RUN/xvfb.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 20); do [ -S "/tmp/.X11-unix/X$DISPLAY_N" ] && break; sleep 0.25; done
[ -S "/tmp/.X11-unix/X$DISPLAY_N" ] || { echo "Xvfb did not start" >&2; exit 1; }
SITE_LOG="$RUN/site-log.jsonl" node "$HERE/site.mjs" & PIDS+=($!)
PW_DIR="$PW_DIR" RELAY_SOCK="$SOCK" RELAY_LOG="$RUN/relay-log.jsonl" node "$HERE/relay.mjs" & PIDS+=($!)
sleep 1

env -i PATH="$PATH" HOME="$RUN/home" LANG=en_US.UTF-8 DISPLAY=":$DISPLAY_N" XAUTHORITY="$RUN/xauth" \
  /usr/bin/chromium --user-data-dir="$RUN/profile" --no-first-run --no-default-browser-check \
  --password-store=basic --load-extension="$RUN/ext" --silent-debugger-extension-api \
  --enable-unsafe-swiftshader --lang=en-US --window-position=0,0 --window-size=1280,900 about:blank \
  >"$RUN/chromium.log" 2>&1 & PIDS+=($!)

for _ in $(seq 1 60); do
  if curl -s http://127.0.0.1:8790/status | grep -q '"extension":true'; then break; fi
  sleep 0.5
done
curl -s http://127.0.0.1:8790/status; echo

# The baseline: a tab that the extension opens, with no debugger and no client.
# The probe's control calls go over the relay's 0600 Unix socket only.
curl -s --unix-socket "$SOCK" -X POST http://relay/control -d '{"method":"tabs.create","params":[{"url":"http://a.localhost:8781/","active":true}]}' >/dev/null
sleep 3

echo "== matrix"; RELAY_SOCK="$SOCK" OUT="$RES/matrix.json" UPLOAD_FILE="$RUN/upload.txt" DL_DIR="$RUN/dl" node "$HERE/matrix.mjs"
echo "== playwright over loopback TCP"; PW_DIR="$PW_DIR" ENDPOINT="ws://127.0.0.1:8790/devtools/browser/pw-tcp" OUT="$RES/pw-tcp.json" UPLOAD_FILE="$RUN/upload.txt" RUN_DIR="$RUN" node "$HERE/pw-probe.mjs"
echo "== playwright over the Unix socket"; PW_DIR="$PW_DIR" ENDPOINT="ws+unix://$SOCK:/devtools/browser/pw-unix" OUT="$RES/pw-unix.json" UPLOAD_FILE="$RUN/upload.txt" RUN_DIR="$RUN" node "$HERE/pw-probe.mjs"
echo "== playwright mcp"; PW_DIR="$PW_DIR" ENDPOINT="ws+unix://$SOCK:/devtools/browser/mcp" OUT="$RES/mcp.json" MCP_OUT_DIR="$RUN/mcp-out" node "$HERE/mcp-probe.mjs"
echo "== concurrent clients and scopes"; PW_DIR="$PW_DIR" RELAY_SOCK="$SOCK" OUT="$RES/concurrency.json" node "$HERE/concurrency.mjs"
sleep 1
echo "== chromium still runs after every client's browser.close:"; curl -s http://127.0.0.1:8790/status; echo
pgrep -f -- "--user-data-dir=$RUN/profile" >/dev/null && echo "chromium alive" || echo "chromium gone"

if [ "${NO_FRAME_GUARD:-}" = 1 ]; then exit 0; fi
cp "$RUN/site-log.jsonl" "$RES/site-log.jsonl"
cp "$RUN/relay-log.jsonl" "$RES/relay-log.jsonl"
cd "$HERE" && node summarize.mjs
