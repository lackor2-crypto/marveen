#!/bin/bash
# Claude credential mirror: WSL  <-->  Windows.
#
# Problem it solves (real incident 2026-08-04): Boss hit a usage limit and
# logged into another Claude account from PowerShell. That rewrote the WINDOWS
# credentials file (C:\Users\<user>\.claude\.credentials.json). Marvin runs
# under WSL and reads a COMPLETELY SEPARATE file (~/.claude/.credentials.json),
# so the successful Windows login changed nothing here -- Marvin stayed wedged
# on the exhausted account and Boss had to log in a second time, inside Ubuntu.
#
# This script makes either side enough: whichever side holds the NEWEST OAuth
# grant wins and is mirrored to the other side.
#
# Winner rule -- deliberately NOT mtime-based:
#   * act only when the two files carry a DIFFERENT refreshToken (a genuine
#     re-login / account switch). A routine accessToken auto-refresh keeps the
#     same refreshToken -> nothing to do -> no cross-filesystem churn.
#   * among differing grants, the larger expiresAt is the newer login.
#   This is deterministic and cannot flip-flop, which an mtime race could
#   (DrvFs and ext4 clocks are not the same clock).
#
# Restarting the channels service is NOT this script's job. It only lands the
# fresh grant in ~/.claude/.credentials.json; cred-switch-watchdog.sh sees the
# changed grant and does the restart with its own cooldown logic.
#
# Lives in store/ (gitignored) so a followed-code update never overwrites it.
# Zero Claude tokens (plain bash + python3 stdlib, no network).
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/cred-sync.log"
# Both paths are overridable so the mirror logic can be exercised end-to-end on
# throwaway files -- testing it against the LIVE credentials would hand the
# running agent a bogus token.
WSL_CRED="${CRED_SYNC_WSL:-$HOME/.claude/.credentials.json}"
WIN_HOME_CACHE="$STORE/.win-home"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }

# --- Locate the Windows user profile. Cached, because cmd.exe costs ~200ms and
# this runs every couple of seconds. /mnt/c/Users has several mojibake sibling
# directories (L szl˘, Lúszl“, ...) from old profile encodings, so guessing by
# name is not safe -- ask Windows itself, and only fall back to a scan.
win_home(){
  local cached; cached="$(cat "$WIN_HOME_CACHE" 2>/dev/null)"
  if [ -n "$cached" ] && [ -d "$cached/.claude" ]; then echo "$cached"; return 0; fi
  local up wp
  up="$(cd /mnt/c 2>/dev/null && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r\n')"
  if [ -n "$up" ]; then
    wp="$(wslpath -u "$up" 2>/dev/null)"
    if [ -n "$wp" ] && [ -d "$wp/.claude" ]; then echo "$wp" > "$WIN_HOME_CACHE"; echo "$wp"; return 0; fi
  fi
  # Fallback: newest .credentials.json under /mnt/c/Users/*/.claude/
  wp="$(ls -t /mnt/c/Users/*/.claude/.credentials.json 2>/dev/null | head -1)"
  [ -n "$wp" ] || return 1
  wp="$(dirname "$(dirname "$wp")")"
  echo "$wp" > "$WIN_HOME_CACHE"; echo "$wp"
}

if [ -n "${CRED_SYNC_WIN:-}" ]; then
  WIN_CRED="$CRED_SYNC_WIN"; WIN_HOME="$(dirname "$(dirname "$WIN_CRED")")"
else
  WIN_HOME="$(win_home)" || exit 0
  WIN_CRED="$WIN_HOME/.claude/.credentials.json"
fi
[ -f "$WSL_CRED" ] || [ -f "$WIN_CRED" ] || exit 0

# --- Decide the winner. Prints: NOOP | ONLY_A | ONLY_B | A_WINS | B_WINS | ERR
DECISION="$(python3 - "$WSL_CRED" "$WIN_CRED" <<'PY' 2>/dev/null
import json, sys

def grant(path):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    o = d.get("claudeAiOauth") or {}
    rt = o.get("refreshToken")
    if not isinstance(rt, str) or not rt:
        return None
    try:
        exp = int(o.get("expiresAt") or 0)
    except Exception:
        exp = 0
    return rt, exp

a, b = grant(sys.argv[1]), grant(sys.argv[2])
if a is None and b is None: print("ERR")
elif b is None:             print("ONLY_A")
elif a is None:             print("ONLY_B")
elif a[0] == b[0]:          print("NOOP")
elif a[1] >= b[1]:          print("A_WINS")
else:                       print("B_WINS")
PY
)"
[ "$DECISION" = "NOOP" ] && exit 0

# --- Atomic copy. Write a temp file in the DESTINATION directory, then rename,
# so a reader never sees a half-written credentials file. The previous content
# is kept as a backup: an account switch must stay undoable.
copy_cred(){ # $1=src $2=dst $3=label
  local src="$1" dst="$2" label="$3" tmp bak
  tmp="$dst.cred-sync.tmp.$$"
  bak="$STORE/.cred-backup-$label.json"
  [ -f "$dst" ] && cp -f "$dst" "$bak" 2>/dev/null && chmod 600 "$bak" 2>/dev/null
  if cp -f "$src" "$tmp" 2>>"$LOG"; then
    chmod 600 "$tmp" 2>/dev/null   # no-op on DrvFs, required on ext4
    if mv -f "$tmp" "$dst" 2>>"$LOG"; then return 0; fi
  fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

# --- MARVIN_FUGGETLEN (2026-08-09, Boss dontese) -------------------------
# Boss celja: "a VS Code es Marvin ne fuggjenek egymastol semmilyen modon".
#
# Ez a tukrozes EGY fiokkal letfontossagu volt: az volt az EGYETLEN ut, ahogy
# egy Windows-oldali ujra-bejelentkezes eljutott Marvinhoz. HAROM fiokkal
# viszont pont ellene dolgozik: 2026-08-09-en NEGYSZER irta felul Marvin
# fiokjat a VS Code-e (14:32, 16:59, 20:34, 23:37), es amikor a VS Code-ban
# eppen a kimerult USA-lackor volt beallitva, Marvin AZT orokolte -- ezert
# "nem tudott felallni".
#
# A masik ket fiok (lackor3, usalackor) mar sajat CLAUDE_CONFIG_DIR-ben fut,
# oket ez sosem erintette. Marvin az egyetlen, aki a kozos ~/.claude-on ul,
# mert a claude-plans funkcio fo-agens bekotese meg nem keszult el (lasd
# src/web/claude-plans.ts fejlec: "It does NOT wire the main agent").
#
# Ezert a tukrozes mostantol ALAPBOL KI van kapcsolva, MINDKET iranyban.
# Ha egyszer SZANDEKOSAN at akarod vinni az egyik oldal bejelentkezeset a
# masikra, hozd letre a kapcsolo-fajlt, es a kovetkezo korben megtortenik:
#     touch <install-dir>/store/.allow-cred-sync
# (utana torold, kulonben megint osszekapcsolodnak)
SYNC_FLAG="$STORE/.allow-cred-sync"
if [ ! -f "$SYNC_FLAG" ]; then
  case "$DECISION" in
    A_WINS|ONLY_A|B_WINS|ONLY_B)
      log "tukrozes KIHAGYVA ($DECISION) -- Marvin es a VS Code fuggetlen. Engedelyezes: touch $SYNC_FLAG"
      ;;
  esac
  exit 0
fi
log "FIGYELEM: $SYNC_FLAG letezik -> a tukrozes ENGEDELYEZETT ebben a korben"

case "$DECISION" in
  A_WINS|ONLY_A)
    mkdir -p "$WIN_HOME/.claude" 2>/dev/null
    if copy_cred "$WSL_CRED" "$WIN_CRED" win; then
      log "wsl -> windows: newer grant mirrored to $WIN_CRED ($DECISION)"
    else
      log "wsl -> windows FAILED ($DECISION)"
    fi ;;
  B_WINS|ONLY_B)
    if copy_cred "$WIN_CRED" "$WSL_CRED" wsl; then
      log "windows -> wsl: newer grant mirrored to $WSL_CRED ($DECISION)"
    else
      log "windows -> wsl FAILED ($DECISION)"
    fi ;;
  *)
    log "no usable credentials on either side ($DECISION)" ;;
esac
exit 0
