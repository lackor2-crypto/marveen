#!/usr/bin/env bash
# TTS wrapper for the fleet. Synthesizes Hungarian speech and sends it as a
# Telegram voice message via the agent's own bot token.
# Usage: tts.sh <voice> <chat_id> <text...>   (voice: imre|anna|<path-to-onnx>)
# Optional env: VOICE_STATE_DIR (defaults to global telegram channel dir).
set -euo pipefail
# #986: the code comes from this checkout (so updates take effect), the runtime (venv, voices) from beside the
# script when it has one, otherwise from the installed toolkit. A checkout never has its own venv.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLED="${MARVEEN_VOICE_DIR:-$HOME/.local/share/marveen-voice}"
CODE="$SCRIPT_DIR/_vtools.py"
[[ -f "$CODE" ]] || CODE="$INSTALLED/_vtools.py"
DEST="$SCRIPT_DIR"
[[ -x "$DEST/venv/bin/python" ]] || DEST="$INSTALLED"
VOICE_ARG="${1:?usage: tts.sh <voice> <chat_id> <text...>}"; shift
CHAT_ID="${1:?missing chat_id}"; shift
TEXT="$*"
# #915: env overrides, then install-scoped once migrated, then legacy shared.
STATE_DIR="${VOICE_STATE_DIR:-${TELEGRAM_STATE_DIR:-}}"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$(cd "$(dirname "$0")/../.." && pwd)/.claude/channels/telegram"
  [ -f "$STATE_DIR/.env" ] || STATE_DIR="$HOME/.claude/channels/telegram"
fi
case "$VOICE_ARG" in
  imre)  ONNX="$DEST/voices/hu_HU-imre-medium.onnx" ;;
  anna)  ONNX="$DEST/voices/hu_HU-anna-medium.onnx" ;;
  /*)    ONNX="$VOICE_ARG" ;;
  *)     echo "Unknown voice alias: $VOICE_ARG (use: imre, anna, or absolute path)" >&2; exit 1 ;;
esac
if [[ ! -x "$DEST/venv/bin/python" ]]; then
  echo "A hangfelismero nincs telepitve (Beallitasok / Hang: telepites). / The voice toolkit is not installed (Settings / Voice: install). [$DEST]" >&2
  exit 1
fi
exec "$DEST/venv/bin/python" "$CODE" speak "$ONNX" "$STATE_DIR" "$CHAT_ID" "$TEXT"
