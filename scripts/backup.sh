#!/usr/bin/env bash
# Marveen backup (#396): one encrypted full backup file (.mbk).
#
# The work is done by the backup engine in the dashboard build
# (src/backup/, docs/BACKUP-RESTORE-PLAN.md): a consistent DB snapshot, every
# secret, setting, agent, memory, skill and schedule, packed and encrypted
# with the recovery key from store/.backup-key into store/backups/.
# The same engine runs from the dashboard (Settings -> Backup) and from here
# (the 6-hourly unit installed by scripts/install-guard-units.sh).
#
# Fallback: when dist/backup/cli.js is missing (a broken or not-yet-run build)
# the old plain tar.gz path runs instead, so a broken build never stops
# backups: scripts/backup-legacy.sh.
#
# Exit code 75 from the engine means "skipped" (another backup or a restore is
# running): not a failure for the timer.

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${REPO_ROOT}/dist/backup/cli.js"

if [[ -f "${CLI}" ]] && command -v node >/dev/null 2>&1; then
  set +e
  node "${CLI}" create --kind scheduled "$@"
  rc=$?
  set -e
  if [[ ${rc} -eq 75 ]]; then
    echo "backup: skipped (another backup or a restore is running)"
    exit 0
  fi
  exit ${rc}
fi

echo "backup: ${CLI} is missing -- falling back to scripts/backup-legacy.sh" >&2
exec bash "${REPO_ROOT}/scripts/backup-legacy.sh"
