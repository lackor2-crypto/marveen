#!/usr/bin/env bash
# Weekly self-test for the voice stack: Piper synthesizes a known Hungarian
# sentence, faster-whisper transcribes it straight back, and the transcript
# is compared to the expected text. Purely local -- no Telegram/network call,
# never touches stt.sh/tts.sh's live state. Exits 0 on pass, 1 on fail/mismatch.
# Usage: canary.sh [voice] [expected text...]   (voice: imre|anna|<path-to-onnx>, default imre)
set -euo pipefail
# #986: the code comes from this checkout (so updates take effect), the runtime (venv, voices) from beside the
# script when it has one, otherwise from the installed toolkit. A checkout never has its own venv.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLED="${MARVEEN_VOICE_DIR:-$HOME/.local/share/marveen-voice}"
CODE="$SCRIPT_DIR/_vtools.py"
[[ -f "$CODE" ]] || CODE="$INSTALLED/_vtools.py"
DEST="$SCRIPT_DIR"
[[ -x "$DEST/venv/bin/python" ]] || DEST="$INSTALLED"
# Graceful skip when the (opt-in) voice stack is not installed: a missing venv
# must read as "nothing to test", not as a weekly false-alarm regression.
if [[ ! -x "$DEST/venv/bin/python" ]]; then
  echo "skip: voice stack not installed (no venv at $DEST)"
  exit 0
fi
VOICE_ARG="${1:-imre}"
if [[ $# -gt 0 ]]; then shift; fi
TEXT="${*:-Ez egy heti hangteszt, minden rendben van.}"
case "$VOICE_ARG" in
  imre)  ONNX="$DEST/voices/hu_HU-imre-medium.onnx" ;;
  anna)  ONNX="$DEST/voices/hu_HU-anna-medium.onnx" ;;
  /*)    ONNX="$VOICE_ARG" ;;
  *)     echo "Unknown voice alias: $VOICE_ARG (use: imre, anna, or absolute path)" >&2; exit 1 ;;
esac
exec "$DEST/venv/bin/python" "$CODE" canary "$ONNX" "$TEXT"
