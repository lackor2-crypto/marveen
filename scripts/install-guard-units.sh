#!/bin/bash
# install-guard-units.sh -- the independent guards that run NEXT TO the dashboard.
#
# Why this exists (fresh-install audit f97acc32, 2026-09-23): on the reference
# install fourteen watchdog/backup timers ran that no installer ever created --
# they were set up by hand over the months, a few from scripts that lived only
# in store/. A fresh install had none of them: no backup, no dashboard-wedge
# restart, no rate-limit alert to the owner, no retry for a sub-agent stuck on
# a provider error. Nothing said so, because a missing timer produces nothing.
#
# What it does: writes one timer (+ oneshot service) per guard, named
# <SERVICE_ID>-<guard>, on Linux as systemd --user units, on macOS as launchd
# agents (com.<SERVICE_ID>.<guard>). Guards that need Linux-only tools
# (systemctl, /proc) are skipped on macOS -- launchd KeepAlive and the
# dashboard's in-process watchers cover those roles there. The WSL credential
# mirror is installed only under WSL, where a Windows-side login exists.
#
# NEVER overwrites an existing unit/plist: an install may have tuned one by hand,
# and a guard that is already running is not this script's to replace. Re-run
# is safe and only fills the gaps.
#
# Usage: scripts/install-guard-units.sh [--dry-run]
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

env_val(){ grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' "; }
MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SERVICE_ID="$(env_val SERVICE_ID)"; SERVICE_ID="${SERVICE_ID//[^a-zA-Z0-9_-]/}"
SERVICE_ID="${SERVICE_ID:-${MAIN_AGENT_ID:-marveen}}"

OS="$(uname -s)"
IS_WSL=0; { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; } && IS_WSL=1

# name | command (relative to INSTALL_DIR unless absolute) | schedule | platforms | description
#   schedule: every:<seconds>  or  daily:<HH:MM>  (+ boot run after 2 min)
#   platforms: all | linux | wsl
GUARDS=(
  "backup|bash scripts/backup.sh|every:21600|all|local data backup (kanban/memory/config snapshot)"
  "dashboard-health|scripts/dashboard-health-guard.sh|every:60|linux|dashboard health guard (restart if it stops answering)"
  "channel-watchdog|scripts/channel-watchdog.sh|every:300|linux|channels watchdog (independent of the dashboard)"
  "channel-keepalive-probe|scripts/channel-keepalive-probe.sh|every:180|all|token-free channel keepalive probe"
  "memgate-shed|scripts/fleet-memory-gate.sh --shed|every:60|linux|memory gate (park an idle agent under hard memory pressure)"
  "telegram-progress-watchdog|python3 scripts/hooks/telegram_progress_watchdog.py|every:60|all|Telegram progress-indicator watchdog"
  "ratelimit-alert|bash scripts/ratelimit-telegram-alert.sh|every:60|all|rate-limit alert to the owner (90%/99%)"
  "subagent-retry|bash scripts/subagent-retry.sh|every:600|all|retry sub-agents stuck on a provider error"
  "agent-wake|scripts/agent-wake.sh|daily:07:15|all|wake the logged-in accounts so rate-limit figures refresh"
  "upstream-check|bash scripts/upstream-divergence-check.sh scheduled|every:604800|all|upstream divergence check"
  "cred-switch|bash scripts/cred-switch-watchdog.sh|every:60|wsl|credential-switch limit-recovery watchdog"
)

say(){ echo "  $*"; }
written=0; skipped=0; present=0

want_platform() {
  case "$1" in
    all) return 0 ;;
    linux) [ "$OS" = "Linux" ] ;;
    wsl) [ "$OS" = "Linux" ] && [ "$IS_WSL" = 1 ] ;;
    *) return 1 ;;
  esac
}

abs_cmd() {
  # First word: an interpreter on PATH (bash/python3) or a repo-relative script.
  local first rest
  first="${1%% *}"; rest=""; [ "$first" != "$1" ] && rest=" ${1#* }"
  case "$first" in
    bash|python3)
      local bin; bin="$(command -v "$first" 2>/dev/null || echo "/usr/bin/$first")"
      local script="${rest# }"; local sfirst="${script%% *}"; local srest=""
      [ "$sfirst" != "$script" ] && srest=" ${script#* }"
      echo "$bin $INSTALL_DIR/$sfirst$srest" ;;
    *) echo "$INSTALL_DIR/$first$rest" ;;
  esac
}

script_of() { local c; c="$(abs_cmd "$1")"; for w in $c; do case "$w" in "$INSTALL_DIR"/*) echo "$w"; return;; esac; done; }

PATH_LINE="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

install_systemd() {
  local name="$1" cmd="$2" sched="$3" desc="$4"
  local dir="$HOME/.config/systemd/user" unit="${SERVICE_ID}-${name}"
  if [ -e "$dir/$unit.service" ] || [ -e "$dir/$unit.timer" ]; then present=$((present+1)); return; fi
  local timer_body
  case "$sched" in
    every:*) timer_body="OnBootSec=2min
OnUnitActiveSec=${sched#every:}s
AccuracySec=15s" ;;
    daily:*) timer_body="OnBootSec=2min
OnCalendar=*-*-* ${sched#daily:}:00
Persistent=true
AccuracySec=1min" ;;
  esac
  if [ "$DRY" = 1 ]; then say "[dry-run] $unit -> $cmd ($sched)"; written=$((written+1)); return; fi
  mkdir -p "$dir"
  cat >"$dir/$unit.service" <<EOF
[Unit]
Description=${SERVICE_ID} ${desc}

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=$(abs_cmd "$cmd")
Environment=PATH=$PATH_LINE
Environment=HOME=$HOME
Environment=MARVEEN_ROOT=$INSTALL_DIR
EOF
  cat >"$dir/$unit.timer" <<EOF
[Unit]
Description=${SERVICE_ID} ${desc} (timer)

[Timer]
$timer_body
Unit=$unit.service

[Install]
WantedBy=timers.target
EOF
  written=$((written+1))
  ENABLE+=("$unit.timer")
}

install_launchd() {
  local name="$1" cmd="$2" sched="$3" desc="$4"
  local dir="$HOME/Library/LaunchAgents" label="com.${SERVICE_ID}.${name}"
  if [ -e "$dir/$label.plist" ]; then present=$((present+1)); return; fi
  local when
  case "$sched" in
    every:*) when="  <key>StartInterval</key><integer>${sched#every:}</integer>" ;;
    daily:*) local hm="${sched#daily:}"
             when="  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$((10#${hm%%:*}))</integer><key>Minute</key><integer>$((10#${hm##*:}))</integer></dict>" ;;
  esac
  if [ "$DRY" = 1 ]; then say "[dry-run] $label -> $cmd ($sched)"; written=$((written+1)); return; fi
  mkdir -p "$dir" "$INSTALL_DIR/store/logs"
  local args="" w
  for w in $(abs_cmd "$cmd"); do args="$args    <string>$w</string>
"; done
  cat >"$dir/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_LINE</string>
    <key>HOME</key><string>$HOME</string>
    <key>MARVEEN_ROOT</key><string>$INSTALL_DIR</string>
  </dict>
$when
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$INSTALL_DIR/store/logs/$name.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_DIR/store/logs/$name.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$dir/$label.plist" 2>/dev/null \
    || launchctl load "$dir/$label.plist" 2>/dev/null || true
  written=$((written+1))
}

ENABLE=()
for g in "${GUARDS[@]}"; do
  IFS='|' read -r name cmd sched plat desc <<<"$g"
  want_platform "$plat" || { skipped=$((skipped+1)); continue; }
  s="$(script_of "$cmd")"
  if [ -n "$s" ] && [ ! -f "$s" ]; then say "! $name: $s hianyzik -- kihagyva"; skipped=$((skipped+1)); continue; fi
  if [ "$OS" = "Darwin" ]; then install_launchd "$name" "$cmd" "$sched" "$desc"
  else install_systemd "$name" "$cmd" "$sched" "$desc"; fi
done

# WSL credential mirror: a long-running poller, not a timer (DrvFs has no inotify).
if [ "$OS" = "Linux" ] && [ "$IS_WSL" = 1 ] && [ -f "$INSTALL_DIR/scripts/cred-watch.sh" ]; then
  dir="$HOME/.config/systemd/user"; unit="${SERVICE_ID}-cred-watch"
  if [ -e "$dir/$unit.service" ]; then present=$((present+1))
  elif [ "$DRY" = 1 ]; then say "[dry-run] $unit (simple, Restart=always)"; written=$((written+1))
  else
    mkdir -p "$dir"
    cat >"$dir/$unit.service" <<EOF
[Unit]
Description=${SERVICE_ID} credential watcher (WSL <-> Windows login mirror)
After=default.target

[Service]
Type=simple
Environment=CRED_WATCH_INTERVAL=2
Environment=PATH=$PATH_LINE
Environment=HOME=$HOME
ExecStart=$(command -v bash) $INSTALL_DIR/scripts/cred-watch.sh
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=default.target
EOF
    written=$((written+1)); ENABLE+=("$unit.service")
  fi
fi

if [ "$OS" = "Linux" ] && [ "$DRY" = 0 ] && [ "${#ENABLE[@]}" -gt 0 ]; then
  if systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable --now "${ENABLE[@]}" 2>/dev/null \
      || say "! systemctl enable nem sikerult: ${ENABLE[*]}"
  else
    say "! systemd --user nem elerheto -- a unitok a helyukon vannak, a kovetkezo inditasnal aktivak"
  fi
fi

say "orszemek: $written uj, $present mar megvolt, $skipped nem erre a platformra valo"
exit 0
