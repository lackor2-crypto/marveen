#!/usr/bin/env bash
# STT wrapper for the fleet. Transcribes (Hungarian) a Telegram voice message or any audio/video file on disk.
# Usage: stt.sh <file_id | path to an audio or video file> [state_dir]
# state_dir defaults to the agent's own telegram channel dir (cwd-based) or global.
set -euo pipefail
# #986: the code comes from this checkout (so updates take effect), the runtime (venv, voices) from beside the
# script when it has one, otherwise from the installed toolkit. A checkout never has its own venv.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLED="${MARVEEN_VOICE_DIR:-$HOME/.local/share/marveen-voice}"
CODE="$SCRIPT_DIR/_vtools.py"
[[ -f "$CODE" ]] || CODE="$INSTALLED/_vtools.py"
DEST="$SCRIPT_DIR"
[[ -x "$DEST/venv/bin/python" ]] || DEST="$INSTALLED"
FID="${1:?usage: stt.sh <file_id | file> [state_dir]}"
# #915: arg, then env override, then install-scoped once migrated, then legacy.
STATE_DIR="${2:-${TELEGRAM_STATE_DIR:-}}"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$(cd "$(dirname "$0")/../.." && pwd)/.claude/channels/telegram"
  [ -f "$STATE_DIR/.env" ] || STATE_DIR="$HOME/.claude/channels/telegram"
fi
if [[ ! -x "$DEST/venv/bin/python" ]]; then
  echo "A hangfelismero nincs telepitve (Beallitasok / Hang: telepites). / The voice toolkit is not installed (Settings / Voice: install). [$DEST]" >&2
  exit 1
fi
exec "$DEST/venv/bin/python" "$CODE" transcribe "$FID" "$STATE_DIR"
