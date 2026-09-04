#!/usr/bin/env python3
"""SessionStart hook: on a FRESH/idle session (restart, crash or watchdog
respawn), inject the agent's pending work from LIVE data (in_progress kanban
cards assigned to the agent + recent hot memories), so it resumes instead of
sitting idle. Kanban #207 (d345eb2c).

Why this exists (distinct from taskstate-replay.py): taskstate-replay only
re-injects from a record WRITTEN by PreCompact. On a restart/crash/respawn
PreCompact never ran, so there is no record -> taskstate-replay is a no-op and
nobody reads the in_progress kanban or hot memory at session start. This hook
fills exactly that gap.

Runs AFTER taskstate-replay (ordering in settings.json.template). The dashboard
side (src/web/pending-work.ts, unit-tested) makes the decision: if an ACTIVE
taskstate exists it returns empty (alreadyReplayed) so we do not double-inject;
if the DB is unreadable it flags `olvashatatlan` (distinct from "no pending
work") -- but either way, when there is nothing to inject additionalContext is
null and this hook stays silent.

Thin by design: the logic + the injection text live in the dashboard. This hook
only prints what the dashboard returns. It NEVER breaks session start (exit 0
everywhere), and it does NOT consume/mutate anything (read-only, idempotent).
"""
import sys
import os
import json
import urllib.request


def _project_root():
    # scripts/hooks/ -> project root is two up.
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
    # Config-driven dashboard port: WEB_PORT env, else .env, default 3420.
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_project_root(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


API = "http://localhost:%s/api" % _web_port()


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token"), "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def _main_agent_id():
    """MAIN_AGENT_ID from env, else .env, else the upstream default."""
    v = os.environ.get("MAIN_AGENT_ID")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return "marveen"


def _agent_id_from_cwd(cwd):
    # agents/<name>/... -> <name>; the project root -> the MAIN agent.
    # Mirrors taskstate-replay.py: the main agent holds the owner-facing threads
    # when a respawn hits, so it must be covered too (not excluded).
    if not cwd:
        return None
    root = os.path.normpath(_project_root())
    norm = os.path.normpath(cwd)
    parts = norm.split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    if norm == root:
        return _main_agent_id()
    return None


def _req(method, path, token):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    agent = _agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        sys.exit(0)  # unknown cwd -> nothing to resume
    token = _token()
    if not token:
        sys.exit(0)

    # READ: the dashboard assembles the pending work (in_progress kanban + hot
    # memory) and applies the alreadyReplayed / olvashatatlan / empty decision.
    try:
        res = _req("GET", "/agents/%s/pending-work" % agent, token)
    except Exception:
        sys.exit(0)  # dashboard unavailable -> no-op (fail-safe)
    inject = (res or {}).get("additionalContext")
    if not inject:
        sys.exit(0)  # nothing to inject (empty, alreadyReplayed, or unreadable)

    # INJECT: emit the SessionStart additionalContext. No consume step: this is
    # read-only, so re-running it next start is harmless (idempotent).
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": inject,
        }
    }, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
