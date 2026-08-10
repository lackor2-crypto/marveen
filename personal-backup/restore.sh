#!/bin/bash
# Restore from personal-backup/ after a fresh `git clone` on a new machine.
# Run this AFTER install.sh has finished the base install (so ~/.claude,
# store/, and the repo layout already exist) -- this only overlays the
# personal config/behavior/secrets on top.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"
BACKUP_DIR="$REPO_ROOT/personal-backup"
AGE_BIN="$(command -v age || echo "$HOME/.local/bin/age")"

if [ ! -x "$AGE_BIN" ]; then
  echo "age nem talalhato. Telepitsd elobb: https://github.com/FiloSottile/age" >&2
  exit 1
fi

echo "== 1/2: config/behavior visszaallitasa =="
[ -f "$BACKUP_DIR/config/CLAUDE.md" ] && cp "$BACKUP_DIR/config/CLAUDE.md" "$REPO_ROOT/CLAUDE.md" && echo "  CLAUDE.md"
[ -f "$BACKUP_DIR/config/SOUL.md" ] && cp "$BACKUP_DIR/config/SOUL.md" "$REPO_ROOT/SOUL.md" && echo "  SOUL.md"
if [ -f "$BACKUP_DIR/config/claude-settings.json" ]; then
  mkdir -p "$HOME/.claude"
  cp "$BACKUP_DIR/config/claude-settings.json" "$HOME/.claude/settings.json"
  echo "  ~/.claude/settings.json"
fi
if [ -d "$BACKUP_DIR/claude-skills" ]; then
  mkdir -p "$HOME/.claude/skills"
  rsync -a "$BACKUP_DIR/claude-skills/" "$HOME/.claude/skills/"
  echo "  ~/.claude/skills/"
fi
if [ -d "$BACKUP_DIR/scheduled-tasks" ]; then
  mkdir -p "$HOME/.claude/scheduled-tasks"
  rsync -a "$BACKUP_DIR/scheduled-tasks/" "$HOME/.claude/scheduled-tasks/"
  echo "  ~/.claude/scheduled-tasks/"
fi

echo ""
echo "== 2/2: titkok visszafejtese =="
if [ -f "$BACKUP_DIR/secrets.tar.age" ]; then
  echo "Add meg a backup.sh-nal hasznalt jelszot:"
  TMP_OUT="$(mktemp -d)"
  trap 'rm -rf "$TMP_OUT"' EXIT
  "$AGE_BIN" -d "$BACKUP_DIR/secrets.tar.age" | tar -C "$TMP_OUT" -xzf -
  [ -d "$TMP_OUT/repo" ] && cp -a "$TMP_OUT/repo/." "$REPO_ROOT/"
  if [ -d "$TMP_OUT/home" ]; then
    mkdir -p "$HOME/.claude/channels/telegram"
    cp -a "$TMP_OUT/home/." "$HOME/"
  fi
  chmod 600 "$REPO_ROOT/.env" 2>/dev/null || true
  chmod 700 "$HOME/.claude" 2>/dev/null || true
  echo "  Titkok visszaallitva."
else
  echo "  Nincs secrets.tar.age -- futtasd elobb a backup.sh-t egy mukodo gepen."
fi

echo ""
echo "Kesz. Ellenorizd: bash scripts/doctor.sh (ha van), majd inditsd a szolgaltatasokat."
