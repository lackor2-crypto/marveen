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


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    cwd = os.getcwd()

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

    updated_at = snap.get('updatedAt')
    if not isinstance(updated_at, (int, float)):
        return
    if time.time() * 1000 - updated_at >= STALE_AFTER_MS:
        return  # stale -- agent has been idle/off since last statusline tick, don't trust the number

    def pct_of(window):
        w = snap.get(window)
        if not isinstance(w, dict):
            return None
        p = w.get('usedPct')
        return p if isinstance(p, (int, float)) else None

    five = pct_of('fiveHour')
    seven = pct_of('sevenDay')
    worst = max([p for p in (five, seven) if p is not None], default=None)
    if worst is None:
        return

    if worst >= CRITICAL_THRESHOLD_PCT:
        print(
            f"KERET-FIGYELMEZTETES: a Claude terv-keret {round(worst)}%-on all (>= {CRITICAL_THRESHOLD_PCT}%). "
            "Boss szabalya: most NE vegezz kodolast/programozast -- csak info, kereses, egyeztetes. "
            "Ha kodolasi feladatot kernek, jelezd hogy a keret miatt most csak arra van mod hogy megbeszeljetek/felkesziljetek ra."
        )
    elif worst >= CAUTION_THRESHOLD_PCT:
        print(
            f"KERET-FIGYELMEZTETES: a Claude terv-keret {round(worst)}%-on all (>= {CAUTION_THRESHOLD_PCT}%). "
            "Boss szabalya: csak kisebb, gyors feladatokba fogj bele, nagy/hosszu munkat most ne kezdj el."
        )


if __name__ == '__main__':
    main()
