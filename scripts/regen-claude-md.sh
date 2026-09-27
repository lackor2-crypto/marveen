#!/usr/bin/env bash
# Regenerate the main agent's CLAUDE.md from templates/CLAUDE.md.template.
#
# CLAUDE.md is a gitignored, generated artifact: on a fresh install the
# installer (install-linux.sh) produces it once from the template with
# placeholder substitution. Over time the live file drifts from the template
# (rules hand-added, never mirrored back). This script makes the template the
# single source again: it re-runs the SAME substitution the installer uses, so
# the live file becomes reproducible from the committed template.
#
# Host-agnostic: every identity value is read from .env (never hardcoded), and
# the repo root is derived from this script's own location -- so it works on any
# install, not just the author's machine. The previous CLAUDE.md is backed up
# outside the repo tree before it is overwritten.
#
# Usage:  scripts/regen-claude-md.sh [--dry-run]
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$BASE/templates/CLAUDE.md.template"
OUT="$BASE/CLAUDE.md"
ENV_FILE="$BASE/.env"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ ! -f "$TEMPLATE" ]; then
  echo "HIBA: nincs template: $TEMPLATE" >&2
  exit 1
fi

# Read a key from .env without sourcing it (values may contain characters that
# would break `source`). Returns the raw value, or the fallback if absent.
env_get() {
  local key="$1" fallback="${2:-}"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
  if [ -z "$line" ]; then
    printf '%s' "$fallback"
    return
  fi
  # strip `KEY=`, then surrounding single/double quotes if present
  local val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

OWNER_NAME="$(env_get OWNER_NAME "")"
BOT_NAME="$(env_get BOT_NAME "")"
MAIN_AGENT_ID="$(env_get MAIN_AGENT_ID "")"
WEB_PORT="$(env_get WEB_PORT 3420)"
# The installer's {{CHAT_ID}} maps to the allowed owner chat id.
CHAT_ID="$(env_get ALLOWED_CHAT_ID 0)"

missing=""
[ -z "$OWNER_NAME" ] && missing="$missing OWNER_NAME"
[ -z "$BOT_NAME" ] && missing="$missing BOT_NAME"
[ -z "$MAIN_AGENT_ID" ] && missing="$missing MAIN_AGENT_ID"
if [ -n "$missing" ]; then
  echo "HIBA: hianyzo azonosito a .env-bol:$missing -- toltsd ki, mielott regeneralsz." >&2
  exit 1
fi

# Same substitution set as install-linux.sh. `|` delimiter for path values so a
# slash in the path does not break the sed expression.
render() {
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
    -e "s|{{INSTALL_DIR}}|$BASE|g" \
    -e "s|{{PROJECT_ROOT}}|$BASE|g" \
    -e "s/{{CHAT_ID}}/$CHAT_ID/g" \
    -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
    -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
    -e "s/{{WEB_PORT}}/$WEB_PORT/g" \
    "$TEMPLATE"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] a generalt CLAUDE.md ($(render | wc -l) sor) NEM lett kiirva. Kulonbseg a jelenlegihez:"
  if [ -f "$OUT" ]; then
    diff <(render) "$OUT" || true
  else
    echo "[dry-run] jelenleg nincs $OUT"
  fi
  exit 0
fi

# Back up the current file OUTSIDE the repo tree (no clutter, recoverable).
if [ -f "$OUT" ]; then
  BACKUP="${TMPDIR:-/tmp}/marveen-CLAUDE.md.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$OUT" "$BACKUP"
  echo "Biztonsagi mentes: $BACKUP"
fi

render >"$OUT"
echo "CLAUDE.md ujragenerava a template-bol ($(wc -l <"$OUT") sor): $OUT"
