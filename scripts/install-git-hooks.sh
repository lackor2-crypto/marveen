#!/usr/bin/env bash
# Telepiti a verziozott git-hookokat (scripts/git-hooks/) a repo KOZOS
# hook-konyvtaraba.
#
# Fontos: a .git/hooks a munkafak kozott KOZOS. Ezert egyetlen telepites
# minden ugynok munkafajara ervenyes -- azokra is, amiket csak ezutan
# hozunk letre. Uj ugynok felvetelekor nincs teendo.
#
# Futtatas:  scripts/install-git-hooks.sh   (barmelyik munkafabol)
set -euo pipefail

SRC="$(cd "$(dirname "$0")/git-hooks" && pwd)"
DST="$(cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$DST/pre-commit.d"

install -m 755 "$SRC/pre-commit" "$DST/pre-commit"
for h in "$SRC"/pre-commit.d/*; do
  [ -f "$h" ] || continue
  install -m 755 "$h" "$DST/pre-commit.d/$(basename "$h")"
done

echo "Hookok telepitve ide: $DST"
ls -1 "$DST/pre-commit" "$DST/pre-commit.d/" | sed 's/^/  /'
