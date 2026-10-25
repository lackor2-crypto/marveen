#!/usr/bin/env python3
"""Session-start token budget (#799).

When the 5-hour quota resets, several sessions wake at once and each one pays
its whole start (~100k tokens measured on 2026-10-25) before doing anything.
STARTUP_TOKEN_CEILING (Settings page / .env, default 50000) is a hard ceiling on
that start. This module answers two questions, in one place, for every hook and
for the CLI measurer below:

  * what does the start cost, split into the FIXED part (CLAUDE.md chain,
    MEMORY.md, SessionStart hook blocks) and the CONVERSATION part;
  * how many bytes the conversation part may take so the sum fits the ceiling.

Tokens here are an ESTIMATE: characters / CHARS_PER_TOKEN (3.5). Hungarian text
with accents tokenizes denser, so the real count is higher; the measurer prints
the figure as an estimate and never as a measurement. The harness's own part
(system prompt, tool schemas, skill list) is NOT visible from here and is not
counted -- the report says so.

Pure stdlib, fail-open: any problem -> the old fixed byte budget keeps working.
"""
import json
import os
import re
import sys

CHARS_PER_TOKEN = 3.5
DEFAULT_CEILING_TOKENS = 50_000
# The conversation part never drops below this, so the freshest turn(s) always
# survive even when the fixed part alone is over the ceiling (that case is
# REPORTED, not hidden, and never cut away silently).
MIN_CONVERSATION_BYTES = 1500


def project_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _read_env_file(path, key):
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\s*" + re.escape(key) + r"\s*=\s*(.*?)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def ceiling_tokens(root=None):
    """Effective ceiling: env > store/config-overrides.json > .env > default.
    0 means no ceiling. An unparsable value falls back to the default."""
    root = root or project_root()
    raw = os.environ.get("STARTUP_TOKEN_CEILING")
    if raw is None or raw.strip() == "":
        try:
            ov = json.load(open(os.path.join(root, "store", "config-overrides.json"), encoding="utf-8"))
            v = ov.get("STARTUP_TOKEN_CEILING")
            raw = None if v is None else str(v)
        except Exception:
            raw = None
    if raw is None or raw.strip() == "":
        raw = _read_env_file(os.path.join(root, ".env"), "STARTUP_TOKEN_CEILING")
    if raw is None or raw.strip() == "":
        return DEFAULT_CEILING_TOKENS
    try:
        n = int(float(raw))
    except ValueError:
        return DEFAULT_CEILING_TOKENS
    return n if n >= 0 else DEFAULT_CEILING_TOKENS


def est_tokens(chars):
    return int(round(chars / CHARS_PER_TOKEN))


def claude_md_chain(cwd, home=None):
    """The CLAUDE.md files Claude Code loads for `cwd`: every CLAUDE.md from cwd up to the
    filesystem root, plus the user-level ~/.claude/CLAUDE.md. Existing files only."""
    home = home or os.path.expanduser("~")
    found, seen = [], set()
    d = os.path.abspath(cwd or os.getcwd())
    while True:
        p = os.path.join(d, "CLAUDE.md")
        if os.path.isfile(p) and p not in seen:
            seen.add(p)
            found.append(p)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    user = os.path.join(home, ".claude", "CLAUDE.md")
    if os.path.isfile(user) and user not in seen:
        found.append(user)
    return found


def _chars(path):
    try:
        return len(open(path, encoding="utf-8", errors="replace").read())
    except OSError:
        return 0


def skill_list_chars(cwd, home=None):
    """Chars of the skill listing the harness shows (name + description of each SKILL.md), from the user-level
    and the project-level skills directory. The listing's exact wrapping is the harness's, so this is
    name + description + a small per-entry overhead."""
    home = home or os.path.expanduser("~")
    total = 0
    seen = set()
    for base in (os.path.join(home, ".claude", "skills"), os.path.join(cwd or "", ".claude", "skills")):
        real = os.path.realpath(base)
        if real in seen:  # an agent's .claude/skills is often a symlink to the user-level directory
            continue
        seen.add(real)
        try:
            names = sorted(os.listdir(base))
        except OSError:
            continue
        for n in names:
            try:
                text = open(os.path.join(base, n, "SKILL.md"), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            m = re.match(r"(?s)---\n(.*?)\n---", text)
            if not m:
                continue
            d = re.search(r"(?ms)^description:\s*(.*?)(?=^\w+:|\Z)", m.group(1))
            total += len(n) + len(re.sub(r"\s+", " ", d.group(1)).strip() if d else "") + 4
    return total


def fixed_parts(cwd, memory_index=None, home=None):
    """[(label, chars)] of the fixed start parts that can be measured from disk."""
    parts = [(p, _chars(p)) for p in claude_md_chain(cwd, home)]
    sk = skill_list_chars(cwd, home)
    if sk:
        parts.append(("skill-list", sk))
    if memory_index and os.path.isfile(memory_index):
        parts.append((memory_index, _chars(memory_index)))
    return parts


def conversation_budget_bytes(cwd, default_bytes, memory_index=None, root=None, home=None):
    """Bytes the conversation block may take so that fixed + conversation fits the ceiling.
    Never above `default_bytes`, never below MIN_CONVERSATION_BYTES. Ceiling 0 -> default."""
    try:
        ceiling = ceiling_tokens(root)
        if ceiling <= 0:
            return default_bytes
        fixed_chars = sum(n for _, n in fixed_parts(cwd, memory_index, home))
        room_chars = int(ceiling * CHARS_PER_TOKEN) - fixed_chars
        # chars -> bytes: accented Hungarian is ~1.1 bytes/char; keep it simple and conservative.
        return max(MIN_CONVERSATION_BYTES, min(default_bytes, room_chars))
    except Exception:
        return default_bytes


def report(cwd, conversation_chars=0, hook_chars=0, memory_index=None, root=None, home=None):
    """Structured breakdown of the measurable start cost (all token figures are ESTIMATES)."""
    fixed = fixed_parts(cwd, memory_index, home)
    fixed_chars = sum(n for _, n in fixed)
    ceiling = ceiling_tokens(root)
    total_chars = fixed_chars + hook_chars + conversation_chars
    return {
        "estimate": True,
        "chars_per_token": CHARS_PER_TOKEN,
        "ceiling_tokens": ceiling,
        "fixed": [{"file": p, "chars": n, "tokens": est_tokens(n)} for p, n in fixed],
        "fixed_chars": fixed_chars,
        "fixed_tokens": est_tokens(fixed_chars),
        "hook_fixed_chars": hook_chars,
        "conversation_chars": conversation_chars,
        "conversation_tokens": est_tokens(conversation_chars),
        "total_tokens": est_tokens(total_chars),
        "fixed_alone_over_ceiling": bool(ceiling) and est_tokens(fixed_chars) > ceiling,
        "over_ceiling": bool(ceiling) and est_tokens(total_chars) > ceiling,
        "not_counted": "harness system prompt, tool schemas, MCP instructions",
    }


def summary(r):
    """The four numbers the owner wants to see, from a report(): total start, the harness part (not
    shrinkable), the controllable part (what the ceiling applies to) and the ceiling. `total` and
    `harness` are None until a REAL measured first-turn figure is supplied -- the harness part cannot be
    read from disk, so it is derived as measured - controllable, never guessed."""
    controllable = r["total_tokens"]
    measured = r.get("measured_total_tokens")
    return {
        "total": measured,
        "harness": None if measured is None else max(0, measured - controllable),
        "controllable": controllable,
        "ceiling": r["ceiling_tokens"],
        "controllable_over_ceiling": r["over_ceiling"],
    }


def render(r):
    """Human-readable table (Hungarian + English labels), figures marked as estimates."""
    sm = summary(r)
    f = lambda v: "ismeretlen / unknown (add meg a mert tokent / pass the measured tokens)" if v is None else f"{v:,}".replace(",", " ")
    lines = [
        f"Osszes indulas / Total start (mert / measured):     {f(sm['total'])}",
        f"  ebbol harness, nem szukitheto / harness (fixed):  {f(sm['harness'])}",
        f"  iranyithato (becsles) / controllable (estimate):  {f(sm['controllable'])}",
        f"      CLAUDE.md + skill-lista + MEMORY.md + hook:   {f(r['fixed_tokens'] + est_tokens(r['hook_fixed_chars']))}",
        f"      beszelgetes / conversation:                   {f(r['conversation_tokens'])}",
        f"Plafon / Ceiling (az iranyithato reszre / on the controllable part): {f(sm['ceiling']) if sm['ceiling'] else '0 = nincs / none'}",
    ]
    if sm["controllable_over_ceiling"]:
        lines.append("FIGYELEM / WARNING: az iranyithato resz tullepi a plafont / the controllable part is over the ceiling")
    lines.append("A token-ertekek kar/3,5 BECSLESEK; a harness = mert - iranyithato. / Token figures are chars/3.5 ESTIMATES; harness = measured - controllable.")
    return "\n".join(lines)


def main(argv):
    # usage: startup_budget_lib.py [--json] [cwd] [MEMORY.md path] [measured first-turn tokens]
    args = [a for a in argv[1:] if a != "--json"]
    as_json = "--json" in argv[1:]
    cwd = args[0] if len(args) > 0 else os.getcwd()
    mem = args[1] if len(args) > 1 else None
    r = report(cwd, memory_index=mem)
    if len(args) > 2:
        # A REAL first-turn figure (from a transcript's usage block) lets the report show how much of the
        # start is NOT visible from disk (system prompt, tool schemas, MCP text) instead of guessing it.
        measured = int(args[2])
        r["measured_total_tokens"] = measured
        r["unexplained_tokens"] = measured - r["total_tokens"]
    r["summary"] = summary(r)
    print(json.dumps(r, ensure_ascii=False, indent=2) if as_json else render(r))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
