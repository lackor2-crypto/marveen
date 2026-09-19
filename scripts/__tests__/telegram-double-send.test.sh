#!/bin/bash
# Contract tests: an orphaned Telegram answer is delivered EXACTLY ONCE.
# Run: bash scripts/__tests__/telegram-double-send.test.sh
#
# Card 40227dc9: the owner received the same message twice. Measured cause: two
# systemd timers ran telegram_progress_watchdog.py in the same second, both read
# the same pending file and both sent the answer (debug.log carried every
# "orphan handled (wedged-backstop)" line twice). A second path: several
# placeholders of one turn in the same chat each carried a copy of the answer.
# The Stop-hook fallback (telegram_progress_clear.py) races the watchdog the
# same way. The fix: every sender claims the pending file with an atomic rename
# before sending, and sends at most one answer per chat.
#
# Fully hermetic: HOME and MARVEEN_ROOT are pinned to a temp tree so the
# watchdog only ever scans test dirs (never the real ~/.claude), and all Bot API
# traffic is routed to a local stub via TELEGRAM_API_BASE.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py"
STOPHOOK="$INSTALL_DIR/scripts/hooks/telegram_progress_clear.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub (logs "<method> <body>" per request) -----------------
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        out = {"ok": True, "result": {"message_id": 9001}}
        payload = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as f: f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[ -z "$PORT" ] && { echo "FATAL: stub did not start"; exit 1; }
API_BASE="http://127.0.0.1:$PORT"

CHAT="10000000001"
CHAT2="10000000002"
ANSWER="EZ_A_VALODI_VALASZ amit a usernek latnia kell"

# make_case <name> <pending-json-entries...>: one agent dir with a wedged turn
# (hung reply, real answer in the transcript), backdated past every threshold.
make_case() {
    local name="$1"; shift
    local sdir="$TMP/root/agents/$name/.claude/channels/telegram"
    local pdir="$sdir/progress"
    mkdir -p "$pdir"
    printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$sdir/.env"
    local tr="$sdir/transcript.jsonl"
    { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"}]}}';
      printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuReply1","name":"mcp__plugin_telegram_telegram__reply"}]}}'; } > "$tr"
    local entries="" e
    for e in "$@"; do
        # e = chat_id:message_id
        entries="$entries${entries:+,}{\"chat_id\":\"${e%%:*}\",\"message_id\":${e##*:},\"transcript_path\":\"$tr\"}"
    done
    printf '[%s]\n' "$entries" > "$pdir/SID.json"
    python3 - "$pdir/SID.json" "$tr" <<'PY'
import os, sys, time
when = time.time() - 1000
for p in sys.argv[1:]:
    os.utime(p, (when, when))
PY
    echo "$pdir"
}
count() { grep -c "^$1 " "$REQLOG" 2>/dev/null; }
count_chat() { grep "^sendMessage " "$REQLOG" 2>/dev/null | grep -c "\"chat_id\": \"$1\""; }
wd_env() {
    HOME="$TMP" MARVEEN_ROOT="$TMP/root" TELEGRAM_API_BASE="$API_BASE" \
      TELEGRAM_WATCHDOG_FORCE_AGENT_UP=1 TELEGRAM_WATCHDOG_WEDGED_UP_SEC=1 "$@"
}
left_over() { ls "$1" | grep -c '\.json' ; }

echo "telegram-double-send tests"
echo "=========================="

# (a) Several watchdog instances at the same moment (the two-timer host) ->
# exactly one sendMessage. Eight parallel runs make the race real.
echo ""
echo "(a) Parallel watchdog instances deliver once"
: > "$REQLOG"
PA="$(make_case da "$CHAT:555")"
# Wait on these PIDs only: a bare `wait` would also block on the stub server.
PIDS=""
for _ in 1 2 3 4 5 6 7 8; do wd_env python3 "$WATCHDOG" & PIDS="$PIDS $!"; done
wait $PIDS
assert_eq "exactly one sendMessage across 8 concurrent watchdogs" "1" "$(count sendMessage)"
assert_eq "placeholder deleted exactly once" "1" "$(count deleteMessage)"
assert_eq "no pending or claimed file left behind" "0" "$(left_over "$PA")"
rm -rf "$TMP/root/agents/da"

# (b) Two placeholders of one turn in the SAME chat -> one answer, both
# placeholders cleared.
echo ""
echo "(b) Same chat, two placeholders: one answer"
: > "$REQLOG"
PB="$(make_case db "$CHAT:555" "$CHAT:556")"
wd_env python3 "$WATCHDOG"
assert_eq "one sendMessage for one chat" "1" "$(count sendMessage)"
assert_eq "both placeholders deleted" "2" "$(count deleteMessage)"
rm -rf "$TMP/root/agents/db"

# (c) Two DIFFERENT chats still each get the answer (the dedup is per chat, not
# per turn).
echo ""
echo "(c) Two chats: each gets the answer once"
: > "$REQLOG"
PC="$(make_case dc "$CHAT:555" "$CHAT2:777")"
wd_env python3 "$WATCHDOG"
assert_eq "chat 1 got one answer" "1" "$(count_chat "$CHAT")"
assert_eq "chat 2 got one answer" "1" "$(count_chat "$CHAT2")"
rm -rf "$TMP/root/agents/dc"

# (d) Stop-hook fallback after the watchdog already claimed the file -> it
# stands down (no second send), and cleans its enforce marker.
echo ""
echo "(d) Stop-hook fallback yields to a claimed file"
: > "$REQLOG"
PD="$(make_case dd "$CHAT:555")"
SD="$(dirname "$PD")"
touch "$PD/enforce-SID.marker"
mv "$PD/SID.json" "$PD/SID.json.claimed.99999"   # the watchdog holds it
printf '{"session_id":"SID","transcript_path":"%s","stop_hook_active":true}' "$SD/transcript.jsonl" \
  | HOME="$TMP" TELEGRAM_STATE_DIR="$SD" TELEGRAM_API_BASE="$API_BASE" python3 "$STOPHOOK"
assert_eq "no send from the Stop hook" "0" "$(count sendMessage)"
assert_eq "enforce marker removed" "no" "$([ -f "$PD/enforce-SID.marker" ] && echo yes || echo no)"
rm -rf "$TMP/root/agents/dd"

# (e) Stop-hook fallback racing the watchdog on the same file -> one send total.
echo ""
echo "(e) Stop-hook fallback + watchdog concurrently: one send"
: > "$REQLOG"
PE="$(make_case de "$CHAT:555")"
SE="$(dirname "$PE")"
touch "$PE/enforce-SID.marker"
printf '{"session_id":"SID","transcript_path":"%s","stop_hook_active":true}' "$SE/transcript.jsonl" \
  | HOME="$TMP" TELEGRAM_STATE_DIR="$SE" TELEGRAM_API_BASE="$API_BASE" python3 "$STOPHOOK" &
PIDS="$!"
wd_env python3 "$WATCHDOG" & PIDS="$PIDS $!"
wd_env python3 "$WATCHDOG" & PIDS="$PIDS $!"
wait $PIDS
assert_eq "exactly one sendMessage between Stop hook and two watchdogs" "1" "$(count sendMessage)"
assert_eq "no pending or claimed file left behind" "0" "$(left_over "$PE")"
rm -rf "$TMP/root/agents/de"

# (f) A claimed file abandoned by a crashed sender is swept after an hour, and
# never delivered a second time.
echo ""
echo "(f) Stale claimed file: swept, not re-sent"
: > "$REQLOG"
PF="$(make_case df "$CHAT:555")"
mv "$PF/SID.json" "$PF/SID.json.claimed.4242"
python3 -c "import os,time,sys; t=time.time()-7200; os.utime(sys.argv[1],(t,t))" "$PF/SID.json.claimed.4242"
wd_env python3 "$WATCHDOG"
assert_eq "stale claim not delivered again" "0" "$(count sendMessage)"
assert_eq "stale claim swept" "0" "$(left_over "$PF")"

echo ""
echo "=========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
