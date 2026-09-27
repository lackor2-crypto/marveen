#!/bin/bash
# owner-lang.sh -- the owner's language for every text a script sends to the
# owner's channel (Telegram). It follows the INSTALL language, never a literal.
# Owner, 2026-09-27: an English fresh install must never get a Hungarian
# message on Telegram.
#
# Same resolution as readInstallLang() in src/config.ts and install_lang() in
# scripts/hooks/rate_limit_status_lib.py: MARVEEN_LANG (environment >
# store/config-overrides.json > .env), then the .lang file, default Hungarian.
# An 'en' prefix ("en", "en-US") is English, anything else Hungarian.
#
#   . "$INSTALL_DIR/scripts/lib/owner-lang.sh"
#   msg="$(ol "Magyar szoveg" "English text")"
#
# Bash 3.2 compatible (macOS system bash). Source it, do not execute it.

_owner_lang_norm() {
  local v
  v="$(printf '%s' "$1" | tr -d '[:space:]"'"'" | tr '[:upper:]' '[:lower:]')"
  [ -z "$v" ] && return 1
  case "$v" in en*) echo en ;; *) echo hu ;; esac
}

owner_lang() {
  local root="${OWNER_LANG_ROOT:-${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}" v
  if v="$(_owner_lang_norm "${MARVEEN_LANG:-}")"; then echo "$v"; return; fi
  if [ -f "$root/store/config-overrides.json" ]; then
    v="$(sed -n 's/.*"MARVEEN_LANG"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/store/config-overrides.json" 2>/dev/null | head -1 || true)"
    if v="$(_owner_lang_norm "$v")"; then echo "$v"; return; fi
  fi
  if [ -f "$root/.env" ]; then
    v="$(grep -E '^MARVEEN_LANG=' "$root/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    if v="$(_owner_lang_norm "$v")"; then echo "$v"; return; fi
  fi
  if [ -f "$root/.lang" ]; then
    if v="$(_owner_lang_norm "$(cat "$root/.lang" 2>/dev/null)")"; then echo "$v"; return; fi
  fi
  echo hu
}

# ol HU EN -- print the text in the owner's language.
ol() {
  if [ "$(owner_lang)" = "en" ]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}
