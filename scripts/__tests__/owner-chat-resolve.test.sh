#!/bin/bash
# CHATID0 (rebuilt from upstream 3e807fe4): scripts/lib/owner-chat.sh must
# never hand the "0" placeholder to a sender, and a later-paired install
# (ALLOWED_CHAT_ID=0 in .env, the real owner only in access.json) must resolve
# to the owner -- the same answer as src/owner-chat.ts resolveOwnerChatId.
# Hermetic: throwaway dirs, no network.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/scripts/lib/owner-chat.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
check() { # name expected-id expected-rc actual-id actual-rc
  if [ "$2" = "$4" ] && [ "$3" = "$5" ]; then PASS=$((PASS+1)); echo "  PASS: $1"
  else FAIL=$((FAIL+1)); echo "  FAIL: $1 (want '$2' rc=$3, got '$4' rc=$5)"; fi
}
case_dir() { local d; d="$(mktemp -d "$TMP/c.XXXXXX")"; mkdir -p "$d/state"; printf '%s' "$d"; }
run() { local out rc; out="$(TELEGRAM_STATE_DIR="$1/state" resolve_owner_chat_id "$1" 2>/dev/null)"; rc=$?; printf '%s|%s' "$out" "$rc"; }

echo "owner-chat resolver"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID=111\n' > "$d/.env"
r="$(run "$d")"; check "configured id wins" 111 0 "${r%|*}" "${r#*|}"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID="222"\r\n' > "$d/.env"
r="$(run "$d")"; check "quotes and CR stripped" 222 0 "${r%|*}" "${r#*|}"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID=0\n' > "$d/.env"
r="$(run "$d")"; check "placeholder, nothing paired -> none" "" 1 "${r%|*}" "${r#*|}"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID=0\n' > "$d/.env"
printf '{"dmPolicy":"allowlist","allowFrom":["0","333"],"groups":{}}' > "$d/state/access.json"
r="$(run "$d")"; check "placeholder + paired -> access.json owner" 333 0 "${r%|*}" "${r#*|}"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID=0\n' > "$d/.env"
printf 'TELEGRAM_CHAT_ID=444\n' > "$d/state/.env"
printf '{"allowFrom":["555"]}' > "$d/state/access.json"
r="$(run "$d")"; check "channel env before access.json" 444 0 "${r%|*}" "${r#*|}"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID=0\n' > "$d/.env"
printf '{"allowFrom":[],"groups":{"-100666":{}}}' > "$d/state/access.json"
r="$(run "$d")"; check "group key when no DM allowlist" -100666 0 "${r%|*}" "${r#*|}"

d="$(case_dir)"; printf 'ALLOWED_CHAT_ID=0\n' > "$d/.env"
printf 'not json' > "$d/state/access.json"
r="$(run "$d")"; check "broken access.json -> none, not a crash" "" 1 "${r%|*}" "${r#*|}"

# notify.sh end to end: a placeholder install with nothing paired must refuse
# BEFORE any network call, with the unchanged operator message.
d="$(case_dir)"; mkdir -p "$d/scripts"; cp -r "$REPO/scripts/lib" "$d/scripts/"; cp "$REPO/scripts/notify.sh" "$d/scripts/"
printf 'TELEGRAM_BOT_TOKEN=x\nALLOWED_CHAT_ID=0\n' > "$d/.env"
out="$(TELEGRAM_STATE_DIR="$d/state" bash "$d/scripts/notify.sh" hi 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "ALLOWED_CHAT_ID nincs beallitva"; then PASS=$((PASS+1)); echo "  PASS: notify.sh refuses the unpaired placeholder"
else FAIL=$((FAIL+1)); echo "  FAIL: notify.sh on unpaired placeholder (rc=$rc): $out"; fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
