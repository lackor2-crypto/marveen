#!/usr/bin/env python3
"""PreToolUse hook: refuse to edit a file another agent is holding.

Layer C of kanban 37129602 (Boss, 2026-08-11: "oldjuk meg hogy az agentek ne
utkozzenek ossze"). Several agents share ONE checkout; before this, two of them
could open the same file and the second write silently won. The registry
(/api/file-claims) knows who holds what; this hook consults it on every
Edit/Write and denies the ones that would overwrite someone else's live work.

FAIL OPEN, ALWAYS. Every uncertainty -- dashboard down, timeout, unparseable
input, missing agent id, path outside the repo -- resolves to "allowed". This
repo has already survived one silent fleet-freeze caused by a hook that exited
non-zero (see _TMP_PREFIXES in src/web/agent-scaffold.ts), and a coordination
nicety must never be able to stop the fleet from working. The kill switch is
MARVEEN_FILE_CLAIMS=0.

Exit codes (Claude Code contract): 0 = allow, 2 = deny with stderr shown to the
model. Nothing else is ever returned.
"""
import json
import os
import sys
import urllib.request

TIMEOUT_S = 2.0
GUARDED_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}


def allow():
    sys.exit(0)


def deny(message):
    sys.stderr.write(message + "\n")
    sys.exit(2)


def read_env_value(env_path, key):
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line[len(key) + 1:].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def post_claim(install_dir, body, method="POST"):
    """Talk to the claim registry. Returns the parsed answer, or None on ANY
    problem -- every caller treats None as 'carry on'."""
    try:
        with open(os.path.join(install_dir, "store", ".dashboard-token")) as f:
            token = f.read().strip()
    except OSError:
        return None
    port = os.environ.get("WEB_PORT") or read_env_value(os.path.join(install_dir, ".env"), "WEB_PORT") or "3420"
    req = urllib.request.Request(
        "http://localhost:%s/api/file-claims" % port,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def resolve_agent(install_dir, cwd):
    """(agent id, own-directory prefix) for the process that is editing."""
    agents_root = os.path.join(install_dir, "agents") + os.sep
    abs_cwd = os.path.abspath(cwd)
    if abs_cwd.startswith(agents_root):
        agent = abs_cwd[len(agents_root):].split(os.sep)[0]
        return agent, os.path.join("agents", agent) + os.sep
    main_id = os.environ.get("MAIN_AGENT_ID") or read_env_value(os.path.join(install_dir, ".env"), "MAIN_AGENT_ID")
    return main_id, None


def main():
    if os.environ.get("MARVEEN_FILE_CLAIMS", "1").strip().lower() in ("0", "false", "no", "off"):
        allow()

    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()

    # Stop hook: the turn is over, so release everything this agent held rather
    # than making the next agent wait out the TTL. Without this, finishing a file
    # still blocks a colleague for up to twenty minutes for no reason.
    if "--release" in sys.argv:
        install_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        agent, _ = resolve_agent(install_dir, payload.get("cwd") or os.getcwd())
        if agent:
            post_claim(install_dir, {"agent": agent}, method="DELETE")
        allow()

    if payload.get("tool_name") not in GUARDED_TOOLS:
        allow()

    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("path") or ""
    cwd = payload.get("cwd") or os.getcwd()
    if not file_path:
        allow()

    # The install root is derived from THIS script's location, never a fixed
    # path: Marveen is open source and $HOME/marveen is one machine's layout.
    install_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    abs_path = os.path.abspath(os.path.join(cwd, file_path))
    if not abs_path.startswith(install_dir + os.sep):
        allow()  # outside the shared checkout: not shared work
    rel_path = os.path.relpath(abs_path, install_dir)

    # Who am I? The agent directory name, or the configured main agent id when
    # working from the install root. An unknown identity must not block anyone.
    agent, own_prefix = resolve_agent(install_dir, cwd)
    if not agent:
        allow()

    # Same exclusions as src/file-claims.ts (isGuardedPath). Kept in sync by
    # hand deliberately: the hook must not need to import the TypeScript.
    if own_prefix and rel_path.startswith(own_prefix):
        allow()
    for prefix in ("store/", "logs/", "log/", "node_modules/", ".git/"):
        if rel_path.startswith(prefix):
            allow()
    if rel_path.endswith(".log") or os.path.basename(rel_path) in (".env", "HANDOFF.md"):
        allow()

    data = post_claim(install_dir, {"path": rel_path, "agent": agent})
    if data is None:
        allow()  # registry unreachable -> never block work

    if data.get("allowed") is False:
        deny(
            "[fajl-utkozes] " + (data.get("message") or
                                 "Ezt a fajlt egy masik agens tartja eppen.")
        )
    allow()


if __name__ == "__main__":
    main()
