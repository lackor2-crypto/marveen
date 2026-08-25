#!/usr/bin/env python3
"""PreToolUse hook: append-only audit trail of everything an agent does.

Boss, 2026-08-25 (voice 479): once the coordination *brakes* were taken off
(the file-claim gate no longer blocks anyone), every agent can touch anything,
so the safety net becomes traceability -- "log everything, especially deletes,
edits and moves, down to the smallest step, so we can always trace who did what
and where a mistake was introduced".

This hook fires on every change-making tool (Edit/Write/NotebookEdit/MultiEdit
and Bash) and appends one JSON line per action to store/agent-audit.jsonl:
who (agent), when (iso), which tool, what kind of operation, and the target
(file path, or the Bash command). Bash commands are classified so deletes and
moves stand out (op = delete / move / edit / write / bash).

NEVER BLOCKS, NEVER FAILS. Exit code is always 0. Every uncertainty -- bad
input, unwritable log, unknown agent -- resolves to "carry on". A pure logger
must not be able to stop the fleet from working (this repo has already survived
one silent fleet-freeze caused by a misbehaving hook; see
scripts/hooks/file-claim-gate.py).
"""
import datetime
import json
import os
import re
import sys

CHANGE_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit", "Bash"}

# Bash command classifiers. First match wins; order matters (delete before move
# so `rm` never reads as anything else). These are best-effort labels for the
# audit view, not a security filter -- a cleverly obfuscated command may slip a
# label, and that is fine: it is still logged verbatim under op="bash".
_DELETE_RE = re.compile(r"\b(rm|rmdir|unlink|shred|git\s+rm|find\b[^|;&]*-delete|truncate\s+-s\s*0)\b")
_MOVE_RE = re.compile(r"\b(mv|rename|git\s+mv)\b")


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


def resolve_agent(install_dir, cwd):
    """Best-effort agent id for the editing process. Same logic as
    file-claim-gate.py: an agent lives either at <install>/agents/<name> or in
    its own worktree <install>/.worktrees/<name>; otherwise it is the main
    agent named in .env (MAIN_AGENT_ID)."""
    try:
        abs_cwd = os.path.realpath(cwd)
    except Exception:
        abs_cwd = cwd or ""
    for parent in (os.path.join(install_dir, "agents"),
                   os.path.join(install_dir, ".worktrees")):
        root = parent + os.sep
        if abs_cwd.startswith(root):
            return abs_cwd[len(root):].split(os.sep)[0]
    return (os.environ.get("MAIN_AGENT_ID")
            or read_env_value(os.path.join(install_dir, ".env"), "MAIN_AGENT_ID")
            or "unknown")


def classify_bash(command):
    if not command:
        return "bash"
    if _DELETE_RE.search(command):
        return "delete"
    if _MOVE_RE.search(command):
        return "move"
    return "bash"


def main():
    # Kill switch, mirroring MARVEEN_FILE_CLAIMS: an operator can silence the
    # trail without touching the template.
    if os.environ.get("MARVEEN_AUDIT_LOG", "1").strip().lower() in ("0", "false", "no", "off"):
        sys.exit(0)

    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = payload.get("tool_name")
    if tool not in CHANGE_TOOLS:
        sys.exit(0)

    # Install root from THIS script's location, never a fixed path (open source).
    install_dir = os.path.realpath(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    cwd = payload.get("cwd") or os.getcwd()
    agent = resolve_agent(install_dir, cwd)
    tool_input = payload.get("tool_input") or {}

    if tool == "Bash":
        command = (tool_input.get("command") or "")
        op = classify_bash(command)
        # Cap the stored command so one pathological line cannot bloat the log.
        target = command if len(command) <= 2000 else command[:2000] + "...(truncated)"
    else:
        target = tool_input.get("file_path") or tool_input.get("path") or ""
        op = "write" if tool == "Write" else "edit"

    entry = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "agent": agent,
        "tool": tool,
        "op": op,
        "target": target,
        "cwd": cwd,
    }

    try:
        store = os.path.join(install_dir, "store")
        os.makedirs(store, exist_ok=True)
        with open(os.path.join(store, "agent-audit.jsonl"), "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
