#!/bin/bash
# Personal disaster-recovery backup for THIS install (Boss, 2026-08-07).
#
# Goal: if this machine dies, `git clone` the repo on a new one, run
# restore.sh, and get back to a fully working, personally-configured
# Marveen -- same persona (CLAUDE.md/SOUL.md), same learned skills, same
# scheduled tasks, same hook wiring (~/.claude/settings.json), same live
# credentials -- without redoing the whole onboarding flow.
#
# Two tiers, handled differently on purpose:
#   1. Config/behavior (NOT secret) -- copied here as plain files, tracked
#      normally in git. Safe even if this repo is ever made public.
#   2. Live credentials (tokens, API keys, OAuth) -- bundled into ONE
#      tarball and encrypted with `age` (passphrase-based) BEFORE it ever
#      touches git. Git history is effectively permanent, so these must
#      never be committed in plaintext, even to a private repo.
#
# Run this manually whenever you want to refresh the backup (not on a
# schedule -- it prompts for a passphrase interactively).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"
BACKUP_DIR="$REPO_ROOT/personal-backup"
AGE_BIN="$(command -v age || echo "$HOME/.local/bin/age")"

if [ ! -x "$AGE_BIN" ]; then
  echo "age nem talalhato (varva: \$PATH-ban vagy ~/.local/bin/age). Telepitsd: https://github.com/FiloSottile/age" >&2
  exit 1
fi

echo "== 1/3: config/behavior (nem titkos, sima git) =="
mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/claude-skills" "$BACKUP_DIR/scheduled-tasks"

[ -f "$REPO_ROOT/CLAUDE.md" ] && cp "$REPO_ROOT/CLAUDE.md" "$BACKUP_DIR/config/CLAUDE.md" && echo "  CLAUDE.md"
[ -f "$REPO_ROOT/SOUL.md" ] && cp "$REPO_ROOT/SOUL.md" "$BACKUP_DIR/config/SOUL.md" && echo "  SOUL.md"
[ -f "$HOME/.claude/settings.json" ] && cp "$HOME/.claude/settings.json" "$BACKUP_DIR/config/claude-settings.json" && echo "  ~/.claude/settings.json"

if [ -d "$HOME/.claude/skills" ]; then
  rsync -a --delete "$HOME/.claude/skills/" "$BACKUP_DIR/claude-skills/"
  echo "  ~/.claude/skills/ ($(find "$BACKUP_DIR/claude-skills" -mindepth 1 -maxdepth 1 -type d | wc -l) skill)"
fi

if [ -d "$HOME/.claude/scheduled-tasks" ]; then
  rsync -a --delete "$HOME/.claude/scheduled-tasks/" "$BACKUP_DIR/scheduled-tasks/"
  echo "  ~/.claude/scheduled-tasks/ ($(find "$BACKUP_DIR/scheduled-tasks" -mindepth 1 -maxdepth 1 -type d | wc -l) feladat)"
fi

echo ""
echo "== 2/3: titkok osszegyujtese titkositas elott =="
SECRET_FILES=(
  ".env"
  "store/.dashboard-token"
  "store/.github-tokens.json"
  "store/.vault-key"
  "store/vault.json"
  "store/google-oauth-client.json"
  "store/google-token.json"
  "store/.cred-backup-win.json"
  "store/.cred-backup-wsl.json"
)
EXTRA_SECRET_FILES=(
  "$HOME/.claude/.credentials.json"
  "$HOME/.claude/channels/telegram/.env"
  "$HOME/.claude/channels/telegram/access.json"
)

TMP_STAGE="$(mktemp -d)"
trap 'rm -rf "$TMP_STAGE"' EXIT

for f in "${SECRET_FILES[@]}"; do
  if [ -f "$REPO_ROOT/$f" ]; then
    mkdir -p "$TMP_STAGE/repo/$(dirname "$f")"
    cp "$REPO_ROOT/$f" "$TMP_STAGE/repo/$f"
    echo "  + $f"
  fi
done
for f in "${EXTRA_SECRET_FILES[@]}"; do
  if [ -f "$f" ]; then
    rel="${f#$HOME/}"
    mkdir -p "$TMP_STAGE/home/$(dirname "$rel")"
    cp "$f" "$TMP_STAGE/home/$rel"
    echo "  + ~/${rel}"
  fi
done

echo ""
echo "== 3/3: titkositas (age, jelszavas) =="
echo "Add meg a titkositasi jelszot -- EZT JEGYEZD MEG / TARDD BIZTONSAGOSAN,"
echo "ez nem kerul sehova elmentve, csak ezzel fejtheto vissza a backup."
tar -C "$TMP_STAGE" -czf - . | "$AGE_BIN" -p -o "$BACKUP_DIR/secrets.tar.age"

echo ""
echo "Kesz. A $BACKUP_DIR mappa most mar tartalmazza a teljes backupot."
echo "Nezd at 'git status'-szal, majd commit + push ha rendben van."
