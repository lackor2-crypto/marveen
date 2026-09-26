#!/bin/bash
# owner-chat.sh -- the shell twin of src/owner-chat.ts resolveOwnerChatId().
#
# CHATID0 (rebuilt from upstream 3e807fe4): the installer writes
# ALLOWED_CHAT_ID=0 when no chat is bound yet, and an install that was paired
# later through the channel plugin KEEPS that placeholder -- the real owner id
# lives only in the channel's access.json allowFrom. Every shell sender tested
# the value for emptiness, and "0" is not empty, so the alert went to chat_id=0
# and the Bot API refused it ("chat not found"). The TypeScript side already
# falls back to access.json; this library gives the shell senders the same
# answer, so the fallback alert path reaches the owner on exactly the installs
# where it used to go nowhere.
#
#   resolve_owner_chat_id INSTALL_DIR [CHANNEL_ENV_FILE]
#
# Order (same as the TS resolver):
#   1. .env ALLOWED_CHAT_ID, unless empty or the "0" placeholder
#   2. TELEGRAM_CHAT_ID in the channel .env (legacy), same rule
#   3. access.json: first non-placeholder allowFrom entry, then groups keys
# Prints the id and returns 0; prints nothing and returns 1 when the install
# has no owner chat. "None" is a real answer -- callers skip the send, they
# never pass a placeholder on to the API.
#
# Bash 3.2 compatible. Source it, do not execute it.

# normalize_chat_id VALUE -- prints VALUE without CR/quotes/spaces, or nothing
# when it is empty or the "0" placeholder.
normalize_chat_id() {
  local v
  v="$(printf '%s' "${1:-}" | tr -d '\r"'"'"' ')"
  [ -z "$v" ] && return 1
  [ "$v" = "0" ] && return 1
  printf '%s' "$v"
}

# owner_chat_state_dir INSTALL_DIR -- the main agent's telegram channel state
# dir: $TELEGRAM_STATE_DIR, then the install-scoped dir, then the pre-#915
# shared dir (mirrors channelStateDir in src/channel-provider.ts).
owner_chat_state_dir() {
  local install_dir="$1" d
  if [ -n "${TELEGRAM_STATE_DIR:-}" ]; then printf '%s' "$TELEGRAM_STATE_DIR"; return 0; fi
  d="$install_dir/.claude/channels/telegram"
  if [ -f "$d/.env" ] || [ -f "$d/access.json" ]; then printf '%s' "$d"; return 0; fi
  d="$HOME/.claude/channels/telegram"
  if [ -f "$d/.env" ] || [ -f "$d/access.json" ]; then printf '%s' "$d"; return 0; fi
  printf '%s' "$install_dir/.claude/channels/telegram"
}

resolve_owner_chat_id() {
  local install_dir="${1:-}" chan_env="${2:-}" raw id state access
  [ -z "$install_dir" ] && return 1
  raw="$(grep -E '^ALLOWED_CHAT_ID=' "$install_dir/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if id="$(normalize_chat_id "$raw")"; then printf '%s' "$id"; return 0; fi
  state="$(owner_chat_state_dir "$install_dir")"
  [ -z "$chan_env" ] && chan_env="$state/.env"
  raw="$(grep -E '^TELEGRAM_CHAT_ID=' "$chan_env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if id="$(normalize_chat_id "$raw")"; then printf '%s' "$id"; return 0; fi
  access="$state/access.json"
  [ -f "$access" ] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  raw="$(python3 - "$access" <<'PY' 2>/dev/null
import json, sys
try:
    a = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
def ok(v):
    v = str(v).strip()
    return v if v and v != "0" else ""
for e in (a.get("allowFrom") or []):
    if ok(e):
        print(ok(e)); sys.exit(0)
g = a.get("groups")
if isinstance(g, dict):
    for k in g:
        if ok(k):
            print(ok(k)); sys.exit(0)
PY
)"
  if id="$(normalize_chat_id "$raw")"; then printf '%s' "$id"; return 0; fi
  return 1
}
