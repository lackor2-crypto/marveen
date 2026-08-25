#!/usr/bin/env python3
"""PreToolUse hook: advisory file-claim registry (NO LONGER BLOCKS).

Layer C of kanban 37129602 (Boss, 2026-08-11: "oldjuk meg hogy az agentek ne
utkozzenek ossze"). Several agents share ONE checkout; before this, two of them
could open the same file and the second write silently won. The registry
(/api/file-claims) knows who holds what; this hook consults it on every
Edit/Write.

Boss, 2026-08-25 (rule #13 removal + voice 479): the BLOCK is gone. An online
agent must never sit idle because a rule refuses its Edit/Write -- "olyan nem
tortenhet meg hogy egy agent online all es senki nem csinal semmit". So on a
collision this hook no longer denies; it records the claim (so a colleague can
still SEE who holds what -- the silent-overwrite protection Boss asked to keep)
and appends one line to the audit trail (store/agent-audit.jsonl), then lets the
edit through. The real protection for big/risky work stays the git worktree
(layer A); comprehensive traceability lives in agent-audit-log.py.

FAIL OPEN, ALWAYS. Every uncertainty -- dashboard down, timeout, unparseable
input, missing agent id, path outside the repo -- resolves to "allowed". This
repo has already survived one silent fleet-freeze caused by a hook that exited
non-zero (see _TMP_PREFIXES in src/web/agent-scaffold.ts). The kill switch is
MARVEEN_FILE_CLAIMS=0.

Exit code is now ALWAYS 0 (allow). The deny path (exit 2) was removed with
rule #13.
"""
import json
import os
import sys
import urllib.request

TIMEOUT_S = 2.0
GUARDED_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}


def allow():
    sys.exit(0)


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
    """(agent id, own-directory prefix) for the process that is editing.

    Both homes an agent can have are recognised: <install>/agents/<name> and its
    own worktree <install>/.worktrees/<name>. Missing the worktree case was a
    real hole (lackor3's second review): the agent was then taken for the MAIN
    agent, which claimed files under the wrong name, walked straight through the
    main agent's own claims on "own" grounds, and -- worst -- released ALL of the
    main agent's claims at the end of every turn.
    """
    abs_cwd = os.path.realpath(cwd)
    for parent, owns_dir in ((os.path.join(install_dir, "agents"), True),
                             (os.path.join(install_dir, ".worktrees"), False)):
        root = parent + os.sep
        if abs_cwd.startswith(root):
            agent = abs_cwd[len(root):].split(os.sep)[0]
            # A worktree is a separate checkout: nothing in the live tree is
            # "its own directory", so it gets no exemption.
            own = os.path.join("agents", agent) + os.sep if owns_dir else None
            return agent, own
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
    install_dir = os.path.realpath(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    # realpath, not abspath: the agents' .claude/skills are SYMLINKS to one
    # shared library, so two agents editing the same physical file arrived here
    # with two different paths and never collided (lackor3's second review).
    # Resolving first gives one key per real file.
    abs_path = os.path.realpath(os.path.join(cwd, file_path))
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
        # Fail open, but not silently: a registry that is down means the whole
        # protection is off, and "only visible in a log" is how the parity bug
        # stayed invisible for weeks. One line per occurrence, best-effort.
        try:
            with open(os.path.join(install_dir, "store", "file-claim-gate.log"), "a") as f:
                f.write("%s fail-open agent=%s path=%s\n" % (__import__("datetime").datetime.now().isoformat(timespec="seconds"), agent, rel_path))
        except OSError:
            pass
        allow()

    if data.get("allowed") is False:
        # Rule #13 removed (Boss 2026-08-25): DO NOT block. Record the collision
        # to the audit trail so an overwrite is never silent -- traceable after
        # the fact -- then allow. The colleague's claim is not destroyed; both
        # agents are now visible in the registry and in the log.
        try:
            with open(os.path.join(install_dir, "store", "agent-audit.jsonl"), "a") as f:
                f.write(json.dumps({
                    "ts": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
                    "agent": agent,
                    "tool": payload.get("tool_name"),
                    "op": "claim-collision",
                    "target": rel_path,
                    "note": data.get("message") or "another agent holds this file; edit allowed anyway",
                }, ensure_ascii=False) + "\n")
        except OSError:
            pass
    allow()


if __name__ == "__main__":
    main()
