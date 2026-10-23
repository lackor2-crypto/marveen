#!/bin/bash
# #766: silent check of the DEPLOYED code. Every Vault id it reads must have a setup-wizard row
# (SetupItem.vaultIds) or a reasoned exception in governance/external-deps-exceptions.json.
# Silent when green; a Telegram message (Hungarian, via notify.sh) only for ids not reported before.
# Usage: bash scripts/external-deps-watch.sh [--report-only]
set -uo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${MARVEEN_STORE:-$BASE/store}"
LOG="$STORE/external-deps-watch.log"
STATE="$STORE/external-deps-watch.state"
REPORT_ONLY=0; [ "${1:-}" = "--report-only" ] && REPORT_ONLY=1
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

[ -f "$BASE/dist/external-deps-scan.js" ] && [ -f "$BASE/dist/web/setup-wizard-registry.js" ] || { log "dist not built, skipped"; exit 0; }

MISSING="$(BASE="$BASE" node --input-type=module -e '
import { readFileSync } from "node:fs"
const b = process.env.BASE
const { scanVaultIds } = await import(b + "/dist/external-deps-scan.js")
const { SETUP_ITEMS } = await import(b + "/dist/web/setup-wizard-registry.js")
let ex = []
try { ex = JSON.parse(readFileSync(b + "/governance/external-deps-exceptions.json", "utf8")).exceptions.map(e => e.vaultId) } catch { console.log("PARSE_ERROR"); process.exit(0) }
const covered = new Set(SETUP_ITEMS.flatMap(i => i.vaultIds ?? []))
for (const [id, file] of scanVaultIds(b + "/src", b)) if (!covered.has(id) && !ex.includes(id)) console.log(id + "\t" + file)
' 2>&1)"

if [ "$MISSING" = "PARSE_ERROR" ] || echo "$MISSING" | grep -q "Error"; then log "scan failed: $(echo "$MISSING" | head -1)"; exit 0; fi
if [ -z "$MISSING" ]; then log "OK"; : > "$STATE"; exit 0; fi

NEW="$(echo "$MISSING" | cut -f1 | sort | comm -23 - <(sort "$STATE" 2>/dev/null))"
log "missing: $(echo "$MISSING" | cut -f1 | tr '\n' ' ')new: $(echo "$NEW" | tr '\n' ' ')"
[ -z "$NEW" ] && exit 0
LIST="$(echo "$MISSING" | while IFS=$'\t' read -r id file; do echo "$NEW" | grep -qx "$id" && echo "- $id ($file)"; done)"
MSG="Uj kulso fuggoseg a kodban, ami nincs a Beallitasok varazslojaban es az Attekintes onellenorzeseben:
$LIST
Felvegyem fejlesztesi kartyaként a varázsló- és önellenőrzés-sort?"
if [ "$REPORT_ONLY" = 1 ]; then echo "$MSG"; exit 0; fi
bash "$BASE/scripts/notify.sh" "$MSG" >/dev/null 2>&1 && echo "$MISSING" | cut -f1 | sort > "$STATE" || log "notify failed"
