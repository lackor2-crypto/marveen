#!/usr/bin/env python3
"""PreToolUse guard: agents on a free (":free") model are READ-ONLY inside the
install folder.

Owner, 2026-09-28 (kanban #436): "az ingyeneseket korlatozd! nem szerkeszthetnek
bele a marvinba. csak ellenorzesre hasznaljuk oket! kizarolag! ... csak olvasoi
jogot adunk az ingyeneseknek mostantol." Decision 1A/2A/3A:
  1A  "free" = the agent's CURRENT configured model ends in ":free"
      (agents/<name>/agent-config.json). Switch the model and the right follows.
  2A  the machine stops the step (exit 2 = deny); the agent keeps running and
      can still read, run tests and use the kanban/message API.
  3A  the whole install folder: Edit/Write/NotebookEdit/MultiEdit on any file
      under it, and in Bash: file-changing commands aimed inside it, git
      commands that change a checkout/branch/history, `gh pr checkout|create|
      merge`, and the landing/deploy helpers.
Trigger: a free agent ran `gh pr checkout` in the live checkout and flipped the
running app's tree onto a foreign branch.

This overrides the 2026-08-27 "the model is not a trust boundary" stance for
WRITES only; free agents keep every read right.

Safety valves (same spirit as the other hooks):
  * FAIL OPEN on anything uncertain: bad payload, unknown agent, missing or
    unreadable agent-config.json, no model field -> allow.
  * Only sessions started in agents/<name>/ are candidates; the main agent
    (session at the install root) is never touched here.
  * Kill switch: MARVEEN_FREE_READONLY=0.
The Bash parsing is best-effort: it stops the ordinary ways an agent edits a
file or moves a branch. It is a brake, not a sandbox.
"""
import datetime
import json
import os
import re
import shlex
import sys

EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}

# git subcommands that change the working tree, index, branch or history.
GIT_WRITE_SUBCMDS = {
    "checkout", "switch", "commit", "push", "merge", "rebase", "reset", "add",
    "stage", "am", "apply", "cherry-pick", "revert", "restore", "rm", "mv",
    "pull", "stash", "clean", "worktree", "branch", "tag",
}
GH_WRITE = {("pr", "checkout"), ("pr", "create"), ("pr", "merge"), ("pr", "close"),
            ("pr", "edit"), ("pr", "review"), ("repo", "sync")}
# Helpers that land or deploy code.
HELPER_RX = re.compile(r"(?:^|/)(land-pr|agent-worktree|deploy-live)\.sh$")

# Commands whose path arguments get created/changed/removed.
PATH_WRITERS = {"rm", "rmdir", "unlink", "shred", "mv", "cp", "touch", "mkdir",
                "tee", "ln", "install", "chmod", "chown", "truncate", "rsync", "patch"}
# Commands that write only with an in-place flag (-i), onto EXISTING files.
INPLACE_EDITORS = {"sed", "perl", "ruby"}
PKG_WRITERS = {("npm", "install"), ("npm", "i"), ("npm", "ci"), ("npm", "uninstall"),
               ("npm", "update"), ("npm", "link"), ("pnpm", "install"), ("pnpm", "add"),
               ("yarn", "add"), ("yarn", "install")}

MSG = (
    "TILTVA / BLOCKED (kanban #436): ingyenes (:free) modellen futo agens a Marvin\n"
    "mappaban csak olvashat. Szerkesztes, fajl-modositas es git-/PR-valtas nem\n"
    "megengedett. Olvasni, tesztet futtatni, a kanban- es uzenet-API-t hasznalni szabad.\n"
    "Ha javitani kellene valamit: ird meg a kartyara kommentben, vagy kuldd at uzenetben\n"
    "egy nem ingyenes agensnek.\n"
    "An agent on a free (:free) model is read-only inside the Marvin folder: no edits,\n"
    "no file changes, no git/PR switching. Reading, running tests and the kanban/message\n"
    "API stay allowed. To get something fixed, comment on the card or message a paid agent.\n"
    "Blokkolt lepes / blocked step: {what}"
)

SEP_RX = re.compile(r"\|\||&&|[;|&\n]|\$\(|`|\(|\)")
REDIR_RX = re.compile(r"(?:^|[^<>&0-9])(?:[0-9]?>>?|&>>?)\s*([^\s;|&<>()]+)")


def allow():
    sys.exit(0)


def install_dir():
    # Install root from THIS script's location, never a fixed path (open source).
    return os.path.realpath(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def session_agent(root):
    """The agent whose session this is. Only a session started in
    agents/<name>/ counts; everything else is not ours to restrict."""
    pd = os.environ.get("CLAUDE_PROJECT_DIR", "").strip()
    if not pd:
        return None
    try:
        pd = os.path.realpath(pd)
    except Exception:
        return None
    base = os.path.join(root, "agents") + os.sep
    if not pd.startswith(base):
        return None
    name = pd[len(base):].split(os.sep)[0]
    return name or None


def agent_model(root, agent):
    try:
        with open(os.path.join(root, "agents", agent, "agent-config.json")) as f:
            cfg = json.load(f)
        m = cfg.get("model")
        return m.strip() if isinstance(m, str) else ""
    except Exception:
        return ""


def is_free_model(model):
    return model.lower().endswith(":free")


def inside(root, path, cwd):
    if not path:
        return False
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(cwd, p)
    try:
        p = os.path.realpath(p)
    except Exception:
        p = os.path.normpath(p)
    return p == root or p.startswith(root + os.sep)


def segments(command):
    return [s.strip() for s in SEP_RX.split(command) if s and s.strip()]


def tokens(seg):
    try:
        toks = shlex.split(seg, comments=False, posix=True)
    except ValueError:
        toks = seg.split()
    # Drop leading VAR=value assignments and wrappers.
    while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0])
                    or toks[0] in ("sudo", "env", "command", "exec", "nohup", "time")):
        toks = toks[1:]
    return toks


def git_verb(toks):
    """(subcommand, rest, -C dir) of a git invocation, skipping global options."""
    i, cdir = 1, None
    while i < len(toks):
        t = toks[i]
        if t in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            if t == "-C" and i + 1 < len(toks):
                cdir = toks[i + 1]
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t, toks[i + 1:], cdir
    return None, [], cdir


def git_is_write(sub, rest):
    if sub not in GIT_WRITE_SUBCMDS:
        return False
    flags = [r for r in rest if r.startswith("-")]
    pos = [r for r in rest if not r.startswith("-")]
    if sub == "branch":
        if any(f in ("--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
                     "--list", "-l", "--show-current") for f in flags):
            return False
        return bool(pos) or any(f.split("=")[0] in (
            "-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy",
            "--force", "--set-upstream-to", "--unset-upstream", "--edit-description") for f in flags)
    if sub == "tag":
        return bool(pos) and not any(f in ("-l", "--list", "-v", "--verify") for f in flags)
    if sub in ("worktree", "stash"):
        return not (pos and pos[0] in ("list", "show"))
    return True


def check_bash(root, command, cwd):
    """Return a description of the first blocked step, or None."""
    eff = cwd
    for m in REDIR_RX.finditer(command):
        target = m.group(1)
        if target.startswith("&") or target.startswith("/dev/"):
            continue
        if inside(root, target, eff):
            return "> " + target
    for seg in segments(command):
        toks = tokens(seg)
        if not toks:
            continue
        cmd = os.path.basename(toks[0])
        args = toks[1:]
        if cmd == "cd":
            if args:
                tgt = os.path.expanduser(args[0])
                eff = tgt if os.path.isabs(tgt) else os.path.join(eff, tgt)
            continue
        if cmd == "git":
            sub, rest, cdir = git_verb(toks)
            gdir = eff
            if cdir:
                gdir = cdir if os.path.isabs(cdir) else os.path.join(eff, cdir)
            if sub and git_is_write(sub, rest) and inside(root, gdir, eff):
                return seg
            continue
        if cmd == "gh":
            pos = [a for a in args if not a.startswith("-")]
            if len(pos) >= 2 and (pos[0], pos[1]) in GH_WRITE:
                return seg
            continue
        if HELPER_RX.search(toks[0]) or (cmd in ("bash", "sh") and args and HELPER_RX.search(args[0])):
            return seg
        pos = [a for a in args if not a.startswith("-")]
        if (cmd, pos[0] if pos else "") in PKG_WRITERS and inside(root, eff, eff):
            return seg
        if cmd in PATH_WRITERS:
            targets = [pos[-1]] if cmd in ("cp", "install", "ln", "rsync") and pos else pos
            if cmd in ("chmod", "chown") and pos:
                targets = pos[1:]
            for a in targets:
                if inside(root, a, eff):
                    return seg
            continue
        if cmd in INPLACE_EDITORS and any(a == "-i" or (a.startswith("-i") and cmd == "sed")
                                          or (a.startswith("-") and not a.startswith("--") and "i" in a[1:] and cmd in ("perl", "ruby"))
                                          or a.startswith("--in-place") for a in args):
            for a in pos:
                full = a if os.path.isabs(a) else os.path.join(eff, a)
                if os.path.exists(full) and inside(root, a, eff):
                    return seg
            continue
        if cmd in ("curl", "wget"):
            for i, a in enumerate(args):
                if a in ("-o", "--output", "-O", "--output-document") and i + 1 < len(args):
                    if inside(root, args[i + 1], eff):
                        return seg
            continue
    return None


def log_deny(root, agent, model, tool, what, cwd):
    try:
        entry = {
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "agent": agent,
            "tool": tool,
            "op": "free-readonly-deny",
            "target": what if len(what) <= 2000 else what[:2000] + "...(truncated)",
            "model": model,
            "cwd": cwd,
        }
        store = os.path.join(root, "store")
        os.makedirs(store, exist_ok=True)
        with open(os.path.join(store, "agent-audit.jsonl"), "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def main():
    if os.environ.get("MARVEEN_FREE_READONLY", "1").strip().lower() in ("0", "false", "no", "off"):
        allow()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
    tool = payload.get("tool_name")
    if tool not in EDIT_TOOLS and tool != "Bash":
        allow()

    root = install_dir()
    agent = session_agent(root)
    if not agent:
        allow()
    model = agent_model(root, agent)
    if not model or not is_free_model(model):
        allow()

    cwd = payload.get("cwd") or os.getcwd()
    tool_input = payload.get("tool_input") or {}
    try:
        if tool in EDIT_TOOLS:
            target = tool_input.get("file_path") or tool_input.get("notebook_path") or tool_input.get("path") or ""
            what = f"{tool} {target}" if target and inside(root, target, cwd) else None
        else:
            what = check_bash(root, tool_input.get("command") or "", cwd)
    except Exception:
        allow()
    if not what:
        allow()

    log_deny(root, agent, model, tool, what, cwd)
    sys.stderr.write(MSG.format(what=what) + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
