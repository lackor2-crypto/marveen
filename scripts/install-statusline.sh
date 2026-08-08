#!/bin/bash
# Install the rate-limit / usage-window statusLine hook (kanban ef06b18d).
#
# What you get:
#   Claude Code's built-in statusLine mechanism ticks scripts/hooks/statusline.py
#   on every render (a local CLI event, zero token/API cost). The script writes
#   store/rate-limit-status/<agent>.json (5h + 7d plan-usage %, context %) for
#   the dashboard Overview widget, and prints a short status line back so the
#   TUI keeps showing model/context/usage at a glance.
#
# What it does:
#   1. Copies scripts/hooks/statusline.py to ~/.claude/hooks/
#   2. Patches ~/.claude/settings.json idempotently: top-level "statusLine" key
#
# Idempotent: safe to re-run.
#
# Usage:
#   bash scripts/install-statusline.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/hooks"
DEST_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_NAME="statusline.py"

if [ ! -f "$SRC_DIR/$SCRIPT_NAME" ]; then
  echo "❌ Source script not found: $SRC_DIR/$SCRIPT_NAME" >&2
  exit 1
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "❌ python3 not found in PATH" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC_DIR/$SCRIPT_NAME" "$DEST_DIR/$SCRIPT_NAME"
chmod +x "$DEST_DIR/$SCRIPT_NAME"
echo "✓ statusline.py installed in $DEST_DIR"

if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

"$PY" - "$SETTINGS" "$PY" "$DEST_DIR/$SCRIPT_NAME" <<'PYEOF'
import json, sys

settings_path, py, script_path = sys.argv[1:4]
with open(settings_path) as f:
    cfg = json.load(f)

command = f"{py} {script_path}"
desired = {"type": "command", "command": command, "padding": 0}

current = cfg.get("statusLine")
if current == desired:
    print("⊙ settings.json statusLine already up to date — skipping")
else:
    cfg["statusLine"] = desired
    with open(settings_path, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print("✓ settings.json statusLine configured")
PYEOF

echo ""
echo "Done. Restart (or open a new pane of) any running agent for the new"
echo "statusLine to take effect -- Claude Code reads it at session start."
