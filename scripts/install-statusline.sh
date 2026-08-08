#!/bin/bash
# Install the rate-limit / usage-window monitoring (kanban ef06b18d).
#
# What you get:
#   1. Claude Code's built-in statusLine mechanism ticks scripts/hooks/statusline.py
#      on every render (a local CLI event, zero token/API cost). The script writes
#      store/rate-limit-status/<agent>.json (5h + 7d plan-usage %, context %) for
#      the dashboard Overview widget, and prints a short status line back so the
#      TUI keeps showing model/context/usage at a glance.
#   2. A UserPromptSubmit hook (scripts/hooks/rate-limit-guard.py) reads that same
#      snapshot at the start of every turn and, only once usage crosses 90%/95%,
#      injects a directive so the AGENT ITSELF sees the warning and scales down
#      work -- not just a dashboard page a human might not be looking at.
#
# What it does:
#   1. Copies scripts/hooks/statusline.py and rate-limit-guard.py to ~/.claude/hooks/
#   2. Patches ~/.claude/settings.json idempotently:
#        top-level "statusLine" key -> statusline.py
#        UserPromptSubmit -> rate-limit-guard.py
#
# Idempotent: safe to re-run.
#
# Usage:
#   bash scripts/install-statusline.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/hooks"
DEST_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

for f in statusline.py rate-limit-guard.py; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "❌ Source script not found: $SRC_DIR/$f" >&2
    exit 1
  fi
done

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "❌ python3 not found in PATH" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC_DIR/statusline.py" "$DEST_DIR/statusline.py"
cp "$SRC_DIR/rate-limit-guard.py" "$DEST_DIR/rate-limit-guard.py"
chmod +x "$DEST_DIR/statusline.py" "$DEST_DIR/rate-limit-guard.py"
echo "✓ statusline.py + rate-limit-guard.py installed in $DEST_DIR"

if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

"$PY" - "$SETTINGS" "$PY" "$DEST_DIR/statusline.py" "$DEST_DIR/rate-limit-guard.py" <<'PYEOF'
import json, sys

settings_path, py, statusline_script, guard_script = sys.argv[1:5]
with open(settings_path) as f:
    cfg = json.load(f)

changed = False

# 1. statusLine (top-level key, not under "hooks")
command = f"{py} {statusline_script}"
desired = {"type": "command", "command": command, "padding": 0}
if cfg.get("statusLine") != desired:
    cfg["statusLine"] = desired
    changed = True
    print("✓ settings.json statusLine configured")
else:
    print("⊙ settings.json statusLine already up to date — skipping")

# 2. UserPromptSubmit -> rate-limit-guard.py (idempotent append)
guard_cmd = f"{py} {guard_script}"
hooks = cfg.setdefault("hooks", {})
ups = hooks.setdefault("UserPromptSubmit", [])
already = any(
    h.get("command") == guard_cmd
    for g in ups
    for h in g.get("hooks", [])
)
if already:
    print("⊙ settings.json rate-limit-guard hook already installed — skipping")
else:
    grp = next((g for g in ups if "matcher" not in g), None)
    if grp is None:
        grp = {"hooks": []}
        ups.append(grp)
    grp.setdefault("hooks", []).append(
        {"type": "command", "command": guard_cmd, "timeout": 10})
    changed = True
    print("✓ settings.json rate-limit-guard hook installed (UserPromptSubmit)")

if changed:
    with open(settings_path, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
PYEOF

echo ""
echo "Done. Restart (or open a new pane of) any running agent for the new"
echo "statusLine + guard hook to take effect -- Claude Code reads settings.json"
echo "hooks at session start."
