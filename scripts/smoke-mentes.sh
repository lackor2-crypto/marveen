#!/bin/bash
# A #47 mentes-kartya felulet-tesztje.
#
# Miert kell hozza kulon szkript? Mert a tokent futasidoben kell beolvasni. Ha
# egy burkolat kozben kifejti a `$(...)`-t, ures token kerul a kornyezetbe, es a
# teszt a BEJELENTKEZO KEPERNYOT nezi vegig 20 masodpercig -- a bukas pedig ugy
# nez ki, mintha a kartya romlott volna el. (Pontosan ez tortent 2026-08-29-en.)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f store/.dashboard-token ]; then
  echo "NINCS store/.dashboard-token -- eloszor inditsd el a dashboardot." >&2
  exit 1
fi

DASHBOARD_TOKEN="$(cat store/.dashboard-token)"
export DASHBOARD_TOKEN
if [ -z "$DASHBOARD_TOKEN" ]; then
  echo "A store/.dashboard-token URES." >&2
  exit 1
fi

exec npx playwright test --config=playwright.config.ts "${@:-tests/smoke/depo-mentes-kartya.spec.ts}"
