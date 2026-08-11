#!/usr/bin/env python3
"""Claude Code statusLine script (kanban ef06b18d).

Claude Code pipes a JSON blob to this script's stdin on every render tick --
a local CLI event, not a model turn, so this costs zero tokens/quota (Boss
explicitly rejected a polling-based approach over token cost, 2026-08-08).
The JSON includes `rate_limits.five_hour` / `seven_day` (each with
used_percentage 0..100 and resets_at, epoch seconds) whenever the session is
authenticated against a Claude.ai Pro/Max plan, plus `context_window.used_percentage`.

This script writes the latest snapshot to store/rate-limit-status/<agent>.json
for the dashboard's Overview widget (src/web/routes/overview.ts reads it via
src/web/rate-limit-status-io.ts) and prints a short status line back to
stdout so the TUI still shows something useful.

Never raises: a broken statusLine script blanks/breaks the live status line,
so every step is best-effort and swallowed.
"""
import json
import os
import sys
import tempfile
import time


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
    by a .env file containing MAIN_AGENT_ID -- the standard "marker file"
    root-detection pattern (same idea as git/npm/eslint climbing to find
    .git/package.json), used here because __file__ can't do this job: this
    script gets copied into ~/.claude/hooks/ at install time
    (install-statusline.sh), completely detached from the repo it came from.
    A fixed "__file__ is two dirs below project root" assumption pointed at
    the wrong directory once installed there, which is why
    store/rate-limit-status/ stayed empty forever (Boss, 2026-08-09) instead
    of just needing time to fill in."""
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


def resolve_agent_id(cwd, project_root, agents_base):
    if not cwd:
        return None
    norm = os.path.abspath(cwd)
    if norm == os.path.abspath(project_root):
        env_path = os.path.join(project_root, '.env')
        return read_env_value(env_path, 'MAIN_AGENT_ID') or 'main'
    abs_agents_base = os.path.abspath(agents_base) + os.sep
    if norm.startswith(abs_agents_base):
        rest = norm[len(abs_agents_base):]
        return rest.split(os.sep)[0] if rest else None
    return None


def num_or_none(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def window_or_none(w):
    if not isinstance(w, dict):
        return None
    pct = num_or_none(w.get('used_percentage'))
    resets_at = num_or_none(w.get('resets_at'))
    return {
        'usedPct': pct,
        # Claude Code reports resets_at in epoch seconds; the dashboard works in ms.
        'resetsAt': resets_at * 1000 if resets_at is not None else None,
    }


def read_snapshot(out_dir, agent_id):
    """Previous snapshot for this agent, or None. Never raises: a missing or
    corrupt file just means there is nothing to preserve."""
    try:
        with open(os.path.join(out_dir, f'{agent_id}.json')) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_snapshot(out_dir, agent_id, snapshot):
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{agent_id}.json')
    fd, tmp_path = tempfile.mkstemp(dir=out_dir, prefix='.tmp-')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(snapshot, f)
        os.replace(tmp_path, out_path)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        return
    try:
        data = json.loads(raw)
    except Exception:
        print('')
        return
    if not isinstance(data, dict):
        print('')
        return

    model = data.get('model') if isinstance(data.get('model'), dict) else {}
    model_name = model.get('display_name') if isinstance(model.get('display_name'), str) else None

    cwd = data.get('cwd')
    if not isinstance(cwd, str) or not cwd:
        workspace = data.get('workspace') if isinstance(data.get('workspace'), dict) else {}
        cwd = workspace.get('current_dir') if isinstance(workspace.get('current_dir'), str) else None

    context_window = data.get('context_window') if isinstance(data.get('context_window'), dict) else {}
    ctx_pct = num_or_none(context_window.get('used_percentage'))

    rate_limits = data.get('rate_limits') if isinstance(data.get('rate_limits'), dict) else {}
    five_hour = window_or_none(rate_limits.get('five_hour'))
    seven_day = window_or_none(rate_limits.get('seven_day'))

    project_root = find_project_root(cwd)

    try:
        agent_id = resolve_agent_id(cwd, project_root, os.path.join(project_root, 'agents')) if project_root else None
        if agent_id:
            out_dir = os.path.join(project_root, 'store', 'rate-limit-status')
            # Keep the last KNOWN window figures when this refresh carries none.
            #
            # The statusline fires on every prompt render, but rate_limits is only
            # present when Claude actually reported it. Overwriting with None on
            # the empty refreshes wiped a perfectly good reading, and the
            # dashboard then showed "nincs adat" for an agent that was simply
            # idle -- Boss watched lackor3 sit like that all morning and only saw
            # it recover after messaging the agent by hand (2026-08-11).
            #
            # windowsUpdatedAt records when the FIGURES last changed, separately
            # from updatedAt (when this file was last touched), so a consumer can
            # tell a fresh reading from a preserved one instead of guessing.
            prev = read_snapshot(out_dir, agent_id)
            now_ms = int(time.time() * 1000)
            windows_updated_at = now_ms
            if five_hour is None and seven_day is None and prev:
                five_hour = prev.get('fiveHour')
                seven_day = prev.get('sevenDay')
                windows_updated_at = prev.get('windowsUpdatedAt') or prev.get('updatedAt') or now_ms
            snapshot = {
                'agent': agent_id,
                'model': model_name,
                'contextPct': ctx_pct,
                'fiveHour': five_hour,
                'sevenDay': seven_day,
                'updatedAt': now_ms,
                'windowsUpdatedAt': windows_updated_at,
            }
            write_snapshot(out_dir, agent_id, snapshot)
    except Exception:
        pass

    parts = []
    if model_name:
        parts.append(model_name)
    if ctx_pct is not None:
        parts.append(f'Ctx {round(ctx_pct)}%')
    if five_hour and five_hour['usedPct'] is not None:
        parts.append(f"5h {round(five_hour['usedPct'])}%")
    if seven_day and seven_day['usedPct'] is not None:
        parts.append(f"7d {round(seven_day['usedPct'])}%")
    print(' | '.join(parts))


if __name__ == '__main__':
    main()
