#!/usr/bin/env python3
"""UserPromptSubmit hook: rate-limit self-guard (kanban ef06b18d, follow-up).

The Overview dashboard widget (src/rate-limit-status.ts,
src/web/rate-limit-status-io.ts) shows the plan usage % to Boss, but Boss
pointed out (2026-08-08) that the warning is USELESS if only he sees it on a
webpage -- the agent itself needs to know its own usage % while it works, so
it can actually behave differently (>=90% small tasks only, >=95% no
programming, info/search only).

This hook reads the same snapshot statusline.py maintains
(store/rate-limit-status/<agent>.json) at the start of every turn and, only
when usage has crossed a threshold, prints a short directive to stdout --
that text becomes a "UserPromptSubmit hook success" context note the agent
sees immediately, the same channel staleness-guard.py and friends already
use. Silent (no output) below the caution threshold, so it adds zero noise
on a normal day. Zero token/API cost: this is a local file read, not a
model call.

Mirrors the thresholds in src/rate-limit-status.ts (CAUTION_THRESHOLD_PCT /
CRITICAL_THRESHOLD_PCT) -- keep both in sync if Boss ever changes them.
"""
import json
import os
import sys
import time

CAUTION_THRESHOLD_PCT = 90
CRITICAL_THRESHOLD_PCT = 95
STALE_AFTER_MS = 30 * 60_000


def read_env_value(env_path, key):
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line.startswith(key + '='):
                    continue
                v = line[len(key) + 1:]
                if v[:1] in ('"', "'") and v[-1:] == v[:1]:
                    v = v[1:-1]
                return v
    except OSError:
        pass
    return None


def find_project_root(cwd):
    """Walk upward from cwd looking for the Marveen project root, identified
    by a .env file containing MAIN_AGENT_ID. __file__ can't do this job here
    either -- same bug as statusline.py, this script is also copied into
    ~/.claude/hooks/ at install time, detached from the repo it came from,
    so the old "__file__ is two dirs below project root" assumption pointed
    at the wrong directory once installed there (Boss, 2026-08-09: the
    self-guard warning silently never fired for the same reason)."""
    if not cwd:
        return None
    d = os.path.abspath(cwd)
    while True:
        env_path = os.path.join(d, '.env')
        if os.path.isfile(env_path) and read_env_value(env_path, 'MAIN_AGENT_ID') is not None:
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def main():
    cwd = os.getcwd()
    project_root = find_project_root(cwd)
    if not project_root:
        return

    agent_id = None
    if os.path.abspath(cwd) == os.path.abspath(project_root):
        agent_id = read_env_value(os.path.join(project_root, '.env'), 'MAIN_AGENT_ID') or 'main'
    else:
        agents_base = os.path.abspath(os.path.join(project_root, 'agents')) + os.sep
        if os.path.abspath(cwd).startswith(agents_base):
            agent_id = os.path.abspath(cwd)[len(agents_base):].split(os.sep)[0]
    if not agent_id:
        return

    snapshot_path = os.path.join(project_root, 'store', 'rate-limit-status', f'{agent_id}.json')
    try:
        with open(snapshot_path) as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return

    now_ms = time.time() * 1000

    updated_at = snap.get('updatedAt')
    if not isinstance(updated_at, (int, float)):
        return
    if now_ms - updated_at >= STALE_AFTER_MS:
        return  # stale -- agent has been idle/off since last statusline tick, don't trust the number

    def pct_of(window):
        w = snap.get(window)
        if not isinstance(w, dict):
            return None
        # resetsAt is the authority, not updatedAt freshness -- same rule as the
        # TS side (src/rate-limit-status.ts, snapshotShowsQuotaExhausted). Within
        # a window usedPct only grows until the reset, so it stays true only as
        # long as resetsAt is in the FUTURE. Once resetsAt has passed the window
        # has rolled over and usedPct belongs to that ELAPSED window, not the
        # current one -- and right after a reset the snapshot can still hold the
        # old (high) usedPct with a fresh updatedAt, so the updatedAt-age guard
        # above does NOT catch it. Treat a past-reset window as unknown rather
        # than warn on a stale number (Boss, 2026-09-07: the guard announced 98%
        # moments after the 5h window had reset to ~28%, and the agent restated
        # it). A missing/unknown resetsAt is left as-is: the updatedAt guard is
        # the only staleness signal we have then, and a fresh high reading still
        # warrants the warning.
        resets_at = w.get('resetsAt')
        if isinstance(resets_at, (int, float)) and resets_at <= now_ms:
            return None
        p = w.get('usedPct')
        return p if isinstance(p, (int, float)) else None

    five = pct_of('fiveHour')
    seven = pct_of('sevenDay')
    worst = five  # Only fiveHour (5-hour) plan window counts for rate-limit behavior; sevenDay is display-only
    if worst is None:
        return

    if worst >= CRITICAL_THRESHOLD_PCT:
        print(
            f"KERET-FIGYELMEZTETES: az 5 ORAS terv-keret {round(worst)}%-on all (>= {CRITICAL_THRESHOLD_PCT}%). "
            "A tulajdonos szabalya: most NE vegezz kodolast/programozast -- csak info, kereses, egyeztetes. "
            "Ha kodolasi feladatot kernek, jelezd hogy a keret miatt most csak arra van mod hogy megbeszeljetek/felkesziljetek ra."
        )
    elif worst >= CAUTION_THRESHOLD_PCT:
        print(
            f"KERET-FIGYELMEZTETES: az 5 ORAS terv-keret {round(worst)}%-on all (>= {CAUTION_THRESHOLD_PCT}%). "
            "A tulajdonos szabalya: csak kisebb, gyors feladatokba fogj bele, nagy/hosszu munkat most ne kezdj el."
        )


if __name__ == '__main__':
    main()
