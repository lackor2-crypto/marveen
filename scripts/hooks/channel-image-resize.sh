#!/bin/bash
# PreToolUse hook: auto-resize channel-received large images before Read.
# Works for any channel provider (Telegram, Slack, etc.) whose plugin
# stores received images under ~/.claude/channels/<provider>/inbox/.
#
# Protection: a >500KB image base64-encoded into the context window would
# force a /compact. Instead this hook:
#   1. Copies the original to `inbox/original/<filename>` (if not there)
#   2. Resizes the inbox copy to max 1024x1024 (sips on macOS)
#   3. Reports the original path via additionalContext so the agent can
#      explicitly read full-res when needed (OCR, detail inspection).
#
# Trigger: PreToolUse hook on the Read tool. Only fires when:
#   - tool_name == "Read"
#   - file_path matches /channels/*/inbox/X.{jpg|jpeg|png|gif|webp}
#     (NOT /inbox/original/X -- originals are left alone)
#   - file_size > 500KB

set -u

# Hooks can run with a minimal PATH; guarantee the interpreters we rely on
# (python3 for JSON-parse + PIL resize) are findable, or the hook silently
# no-ops and images pass through full-size.
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"

INPUT=$(cat)
# Parse tool_name / file_path. jq is NOT present on every host (this Linux/WSL
# box has no jq), and without a parser the hook exited at the first guard and
# never ran at all -- so channel images were never resized. Fall back to
# python3, which is always here.
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
else
  TOOL_NAME=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print(d.get("tool_name",""))' 2>/dev/null)
  FILE_PATH=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("tool_input") or {}).get("file_path","") or (d.get("tool_input") or {}).get("path",""))' 2>/dev/null)
fi

# Csak Read tool-ra reagáljunk
[ "$TOOL_NAME" = "Read" ] || exit 0

# Skip if path is already in the `original/` subfolder
case "$FILE_PATH" in
  */channels/*/inbox/original/*) exit 0 ;;
esac

# Match any channel provider inbox image (top-level only)
case "$FILE_PATH" in
  */channels/*/inbox/*.jpg|*/channels/*/inbox/*.jpeg|\
  */channels/*/inbox/*.png|*/channels/*/inbox/*.gif|\
  */channels/*/inbox/*.webp) ;;
  *) exit 0 ;;
esac

# File léteznie kell
[ -f "$FILE_PATH" ] || exit 0

# Méret-check: csak ha >500KB
SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)
if [ "$SIZE" -le 524288 ]; then
  exit 0
fi

# Original mentés a /original/ subfolder-be (ha még nincs ott)
INBOX_DIR=$(dirname "$FILE_PATH")
ORIG_DIR="$INBOX_DIR/original"
mkdir -p "$ORIG_DIR" 2>/dev/null
ORIG_PATH="$ORIG_DIR/$(basename "$FILE_PATH")"
if [ ! -f "$ORIG_PATH" ]; then
  cp "$FILE_PATH" "$ORIG_PATH" 2>/dev/null || true
fi

# Resize to max 1024 on the long edge (aspect kept). sips is macOS-ONLY -- on a
# Linux/WSL box it does not exist and the resize silently no-op'd (the `|| true`
# hid it), so channel images were never actually shrunk here (Boss 2026-08-10:
# images bloating the context). Prefer PIL (present on this host), then
# ImageMagick, then sips, so the same hook works on every platform.
if command -v python3 >/dev/null 2>&1 && python3 -c 'import PIL' >/dev/null 2>&1; then
  python3 - "$FILE_PATH" >/dev/null 2>&1 <<'PY' || true
import sys
from PIL import Image
p = sys.argv[1]
with Image.open(p) as im:
    im.load()
    w, h = im.size
    m = max(w, h)
    if m > 1024:
        s = 1024.0 / m
        out = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        if p.lower().endswith(('.jpg', '.jpeg')) and out.mode not in ('RGB', 'L'):
            out = out.convert('RGB')
        out.save(p)
PY
elif command -v mogrify >/dev/null 2>&1; then
  mogrify -resize '1024x1024>' "$FILE_PATH" >/dev/null 2>&1 || true
elif command -v sips >/dev/null 2>&1; then
  sips -Z 1024 "$FILE_PATH" >/dev/null 2>&1 || true
fi

NEW_SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)

# Debug log
echo "[channel-image-resize] $FILE_PATH: ${SIZE}B -> ${NEW_SIZE}B; original kept at $ORIG_PATH" >&2

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Note: this channel-received image was auto-resized to max 1024x1024 to protect the context window (was ${SIZE}B, now ${NEW_SIZE}B). The full-resolution original is preserved at: $ORIG_PATH -- Read that path if you need detailed analysis (OCR, fine detail inspection, image editing pre-process)."
  }
}
EOF

exit 0
