#!/usr/bin/env bash
# Marveen esemeny-log -- egy sor minden fontos futasnal.
# Formatum:  YYYY-MM-DD HH:MM:SS | muvelet | STATUSZ | rovid hibauzenet
# Visszanezes:  tail -n 40 store/event-log.txt   (vagy a dashboard)
#
# Hasznalat:  bash scripts/eventlog.sh "muvelet-neve" ok|error|warn "opcionalis rovid uzenet"
LOG="/home/boss/marveen/store/event-log.txt"
ts="$(date '+%Y-%m-%d %H:%M:%S')"
op="${1:-?}"
status="$(printf '%s' "${2:-?}" | tr '[:lower:]' '[:upper:]')"
msg="${3:-}"
# egy sorba tomoritjuk (ujsor -> szokoz), hogy grep-elheto maradjon
msg="$(printf '%s' "$msg" | tr '\n' ' ' | cut -c1-200)"
printf '%s | %-22s | %-5s | %s\n' "$ts" "$op" "$status" "$msg" >> "$LOG"
