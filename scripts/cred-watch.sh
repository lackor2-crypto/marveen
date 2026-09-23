#!/bin/bash
# Credential watcher: reacts to a Claude login within seconds, from EITHER side.
#
# Why a polling daemon instead of a systemd .path unit / inotify: the Windows
# credentials file lives on /mnt/c (DrvFs), and DrvFs delivers NO inotify
# events -- a .path unit there would simply never fire. Polling two small stat()
# calls every couple of seconds is free (no network, no Claude tokens), and it
# is the only thing that actually sees a PowerShell login.
#
# Per tick:
#   1. either credentials file changed  -> run cred-sync.sh (mirror newest grant)
#   2. the WSL file changed             -> kick cred-switch-watchdog.service,
#                                          which restarts channels IF the OAuth
#                                          grant really changed (its own logic).
# Both steps are idempotent, so a routine accessToken refresh costs one quiet
# no-op pass and nothing else.
#
# Lives in store/ (gitignored) so a followed-code update never overwrites it.
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/cred-watch.log"
WSL_CRED="$HOME/.claude/.credentials.json"
WIN_HOME_CACHE="$STORE/.win-home"
SYNC="$INSTALL_DIR/scripts/cred-sync.sh"
INTERVAL="${CRED_WATCH_INTERVAL:-2}"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
sig(){ stat -c '%Y:%s' "$1" 2>/dev/null || echo "-"; }

env_val(){ grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' "; }
MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SERVICE_ID="$(env_val SERVICE_ID)"; SERVICE_ID="${SERVICE_ID//[^a-zA-Z0-9_-]/}"; SERVICE_ID="${SERVICE_ID:-$MAIN_AGENT_ID}"
SWITCH_UNIT="${SERVICE_ID}-cred-switch.service"

# Startup: sync once, so a login that happened while this daemon was down is
# picked up immediately instead of waiting for the next file change.
bash "$SYNC"
log "started (interval ${INTERVAL}s, switch unit $SWITCH_UNIT)"

win_cred(){ local h; h="$(cat "$WIN_HOME_CACHE" 2>/dev/null)"; [ -n "$h" ] && echo "$h/.claude/.credentials.json"; }

PREV_W="$(sig "$WSL_CRED")"
PREV_C="$(sig "$(win_cred)")"

while :; do
  sleep "$INTERVAL"
  CUR_W="$(sig "$WSL_CRED")"
  CUR_C="$(sig "$(win_cred)")"

  if [ "$CUR_W" != "$PREV_W" ] || [ "$CUR_C" != "$PREV_C" ]; then
    [ "$CUR_C" != "$PREV_C" ] && log "windows credentials changed ($PREV_C -> $CUR_C)"
    [ "$CUR_W" != "$PREV_W" ] && log "wsl credentials changed ($PREV_W -> $CUR_W)"
    bash "$SYNC"
    AFTER_W="$(sig "$WSL_CRED")"
    if [ "$AFTER_W" != "$PREV_W" ]; then
      # The live credentials moved. Let the watchdog decide whether this is a
      # real account switch worth a channels restart.
      systemctl --user start "$SWITCH_UNIT" 2>>"$LOG" \
        && log "kicked $SWITCH_UNIT" || log "kick FAILED: $SWITCH_UNIT"
    fi
    PREV_W="$AFTER_W"
    PREV_C="$(sig "$(win_cred)")"
  fi
done
