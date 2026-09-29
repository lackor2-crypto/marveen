#!/usr/bin/env python3
"""PreToolUse gate: no agent may write a SKILL.md without a decided `scope:`.

Owner, 2026-09-28 (kanban #438): the Overview self-check kept asking to
classify skills (PR-INVESTIGATION-WORKTREE, typescript-verification-patterns).
"Skillt csak ugy lehessen letrehozni problemamentesen, kesobb ne okozzon
problemat. Egyebkent tilos skillt letrehozni."

The skill endpoints already refuse a skill without scope (skill_scope_required,
src/web/skill-scope.ts). Both offending skills bypassed them: an agent wrote the
file straight to ~/.claude/skills/ with Write / `cat > ... << EOF`, following the
old "Automatikus skill generalas" instructions that never mentioned scope.

What this gate stops (exit 2 = deny, the agent keeps working):
  * Write of a .../skills/**/SKILL.md whose front matter has no
    `scope: personal` or `scope: global` -- read exactly the way the Overview
    self-check reads it (readSkillScope), so what passes here is never asked
    about there.
  * Edit/MultiEdit of a SKILL.md whose RESULT has no valid scope line
    (personal/global/review): patching a machine-written `review` skill stays
    allowed, removing the line or patching an unscoped skill without adding one
    does not.
  * Bash that writes a SKILL.md by redirection/tee without such a line in the
    command, or copies one in (cp/mv/install) from a file without it.
`review` is reserved for the machine path (reflection/import in TypeScript,
which never goes through a tool call), so an agent cannot park a skill there.

Safety valves: fail open on bad input or anything unparseable; only paths with
a `skills` directory component count; kill switch MARVEEN_SKILL_SCOPE_GATE=0.
"""
import os
import re
import shlex
import sys
import json

AGENT_SCOPES = ("personal", "global")
ALL_SCOPES = ("personal", "global", "review")
# An exact mirror of readSkillScope/frontmatterOf in src/web/skill-scope.ts --
# the reader the Overview self-check and the global-skill seeder use. A skill
# this gate lets through must never be one the self-check then asks about
# (a quoted `"global"` or a front matter not on the first line used to pass
# here and nag there). The parity test in skill-scope-gate-hook.test.ts runs
# the same inputs through both.
SCOPE_LINE_RX = re.compile(r"^\s*scope:\s*([a-z]+)\s*$", re.M | re.I)
OPEN_RX = re.compile(r"---\s*\r?\n")
# Bash: the first front matter block the command writes (a heredoc line, or
# right after the opening quote of echo/printf).
BASH_FRONT_RX = re.compile(r"(?:^|['\"])(---[ \t]*\r?\n.*)", re.M | re.S)

MSG = (
    "TILTVA / BLOCKED (kanban #438): SKILL.md csak eldontott `scope:` sorral irhato.\n"
    "Tedd a fejlecbe (a --- blokkba, ami a fajl LEGELSO sora), a name/description melle,\n"
    "idezojel nelkul:\n"
    "  scope: personal   -- konkret emberre, fiokra, maganugyre szol; ezen a gepen marad\n"
    "  scope: global     -- barkinek hasznos; a rendszer atviszi a seed-skills/ ala\n"
    "A `review` a gepi ute, agens nem valaszthatja. Ha nem tudod eldonteni, kerdezd meg a\n"
    "tulajdonost a csatornajan, es addig ne hozd letre a skillt.\n"
    "A SKILL.md needs a decided, unquoted `scope:` line in its front matter (the --- block\n"
    "that opens the file on its very first line): `scope: personal` (about a specific\n"
    "person/account, stays on this machine) or `scope: global` (useful to anyone, shipped\n"
    "via seed-skills/). `review` is for the machine path only.\n"
    "Blokkolt lepes / blocked step: {what}"
)

SEP_RX = re.compile(r"\|\||&&|[;|&]")
REDIR_RX = re.compile(r"(?:^|[^<>&0-9])(?:[0-9]?>>?|&>>?)\s*(\"[^\"]+\"|'[^']+'|[^\s;|&<>()]+)")


def allow():
    sys.exit(0)


def is_skill_md(path):
    if not path:
        return False
    p = os.path.normpath(os.path.expanduser(str(path).strip("'\"")))
    parts = p.split(os.sep)
    return parts[-1].lower() == "skill.md" and any(x in ("skills", "seed-skills") for x in parts[:-1])


def front_matter(text):
    """frontmatterOf: from the opening --- on the first line to the first \\n---."""
    if not isinstance(text, str) or not OPEN_RX.match(text):
        return None
    end = text.find("\n---", 4)
    return None if end == -1 else text[:end]


def scope_of(text, allowed):
    """The scope in the front matter if it is one of `allowed`, else None."""
    fm = front_matter(text)
    if fm is None:
        return None
    s = SCOPE_LINE_RX.search(fm)
    if not s:
        return None
    v = s.group(1).lower()
    return v if v in allowed else None


def read(path):
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def apply_edits(text, edits):
    for e in edits:
        old = e.get("old_string") or ""
        new = e.get("new_string") or ""
        if e.get("replace_all"):
            text = text.replace(old, new)
        else:
            text = text.replace(old, new, 1)
    return text


def check_edit_tool(tool, ti):
    path = ti.get("file_path") or ""
    if not is_skill_md(path):
        return None
    if tool == "Write":
        return None if scope_of(ti.get("content"), AGENT_SCOPES) else f"Write {path}"
    current = read(path)
    if current is None:
        return None  # nothing to patch: Claude Code itself will refuse the edit
    edits = ti.get("edits") if tool == "MultiEdit" else [ti]
    try:
        result = apply_edits(current, edits or [])
    except Exception:
        return None
    return None if scope_of(result, ALL_SCOPES) else f"{tool} {path}"


def abs_in(path, cwd):
    p = os.path.expanduser(path.strip("'\""))
    return p if os.path.isabs(p) else os.path.join(cwd, p)


def check_bash(command, cwd):
    if "skill" not in command.lower():
        return None
    # Redirection / tee: the content is in the command (heredoc/echo).
    targets = [m.group(1) for m in REDIR_RX.finditer(command)]
    for seg in SEP_RX.split(command):
        try:
            toks = shlex.split(seg, posix=True)
        except ValueError:
            toks = seg.split()
        if not toks:
            continue
        cmd = os.path.basename(toks[0])
        args = [a for a in toks[1:] if not a.startswith("-")]
        if cmd == "tee":
            targets += args
        elif cmd in ("cp", "mv", "install") and len(args) >= 2:
            dest = args[-1]
            for src in args[:-1]:
                s_abs = abs_in(src, cwd)
                d_abs = abs_in(dest, cwd)
                if os.path.isdir(s_abs):
                    s_md = os.path.join(s_abs, "SKILL.md")
                    d_md = os.path.join(d_abs, "SKILL.md") if not os.path.isdir(d_abs) \
                        else os.path.join(d_abs, os.path.basename(s_abs.rstrip(os.sep)), "SKILL.md")
                else:
                    s_md = s_abs
                    d_md = os.path.join(d_abs, os.path.basename(s_abs)) if os.path.isdir(d_abs) else d_abs
                if is_skill_md(d_md) and os.path.exists(s_md) and not scope_of(read(s_md), AGENT_SCOPES):
                    return seg.strip()
    body = command.replace("\\n", "\n")
    m = BASH_FRONT_RX.search(body)
    has_scope = bool(m and scope_of(m.group(1), AGENT_SCOPES))
    for t in targets:
        if is_skill_md(t) and not has_scope:
            return command if len(command) <= 300 else command[:300] + "..."
    return None


def main():
    if os.environ.get("MARVEEN_SKILL_SCOPE_GATE", "1").strip().lower() in ("0", "false", "no", "off"):
        allow()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
    tool = payload.get("tool_name")
    ti = payload.get("tool_input") or {}
    cwd = payload.get("cwd") or os.getcwd()
    try:
        if tool in ("Write", "Edit", "MultiEdit"):
            what = check_edit_tool(tool, ti)
        elif tool == "Bash":
            what = check_bash(ti.get("command") or "", cwd)
        else:
            what = None
    except Exception:
        allow()
    if not what:
        allow()
    sys.stderr.write(MSG.format(what=what) + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
