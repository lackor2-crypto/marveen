#!/usr/bin/env python3
"""PreToolUse kapu: az ELO checkoutban (a fo munkafa) NINCS torles, athelyezes, csonkolas.

A MERT ESET (2026-10-03 02:28, a tulajdonos adata ment el): egy tesztelo
parancslanc `cd <worktree> && ...; rm -rf store/<adatbazis>*` alakban futott;
a cd elbukott, a pontosvessző utani torles az ELO fan futott le, es ~23 ora
adat (kartyak, memoriak, projektek, jovahagyasok, a tulajdonos prezentacioja es
nevjegye) ment el. Az adatbazisra mar van kulon kapu (no-live-store-delete);
ez a kapu az egesz elo fara kiterjeszti. Tulajdonos: "egyik agent se tudjon
torolni az elo mappaban".

MIT CSINAL: egy Bash parancsot (rm, unlink, shred, truncate, mv, find -delete,
git clean), amelynek barmelyik celpontja az ELO checkout alatt van, megallit --
kiveve a kidobhato teruleteket (.worktrees/, store/tmp/, node_modules/, dist/,
agents/). Relativ utat a session cwd-jehez kepest is, es a parancsban szereplo
`cd` celjahoz kepest is megnez: a `cd` el is bukhat, pont ez volt a hiba.

BIZTONSAGI SZELEPEK (bizonytalansag -> ATENGED): csak Bash; hibas payload,
hianyzo mezo, git-hiba, nem worktree-alapu host (nincs .worktrees/) -> atengedi.
Kikapcsolo: MARVEEN_NO_LIVE_TREE_DELETE_GATE=0.
"""
import json
import os
import re
import shlex
import subprocess
import sys

DESTROY_RX = re.compile(r"(^|[;&|(`\s])(rm|unlink|shred|truncate|mv)\b|\bfind\b[^;&|]*\s-delete\b|\bgit\s+clean\b")
SKIP_WORDS = {";", "&&", "||", "|", "cd", "rm", "unlink", "shred", "truncate", "mv", "find", "git", "clean", "echo", "sudo", "xargs", "then", "do", "done", "if", "fi"}
ALLOW_PREFIXES = (".worktrees", "store/tmp", "node_modules", "dist", "agents")


def allow():
    sys.exit(0)


def deny(msg):
    sys.stderr.write(msg)
    sys.exit(2)


def git_out(cwd, *args):
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    return r.stdout.strip() if r.returncode == 0 else None


MSG = (
    "\n[no-live-tree-delete kapu] TILOS az ELO checkoutban ({root}) torolni/athelyezni/csonkolni: {hit}\n"
    "2026-10-03-an egy `cd <worktree> && ...; rm -rf store/<adatbazis>*` lanc cd-je elbukott, "
    "a torles az elo fan futott le, es ~23 ora adat ment el.\n\n"
    "HELYETTE: dolgozz `scripts/agent-worktree.sh <nev>` worktree-ben, es ott torolj ABSZOLUT uttal "
    "(rm -rf /abs/ut/.worktrees/<nev>/...). Ideiglenes fajl: /tmp vagy a session scratch-konyvtara. "
    "Az elo fan torles csak a tulajdonos dontesevel.\n"
    "(Kikapcsolo: MARVEEN_NO_LIVE_TREE_DELETE_GATE=0.)\n"
)


def under(path, root):
    path = os.path.realpath(path)
    return path == root or path.startswith(root + os.sep)


def allowed(path, root):
    rel = os.path.relpath(os.path.realpath(path), root)
    return any(rel == p or rel.startswith(p + os.sep) for p in ALLOW_PREFIXES)


def main():
    if os.environ.get("MARVEEN_NO_LIVE_TREE_DELETE_GATE") == "0":
        allow()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
    if payload.get("tool_name") != "Bash":
        allow()
    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not DESTROY_RX.search(command):
        allow()
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        allow()
    common = git_out(cwd, "rev-parse", "--git-common-dir")
    if not common:
        allow()
    if not os.path.isabs(common):
        common = os.path.join(cwd, common)
    root = os.path.dirname(os.path.realpath(common))
    if not os.path.isdir(os.path.join(root, ".worktrees")):
        allow()  # not a worktree-based host

    try:
        tokens = shlex.split(re.sub(r"(;|&&|\|\||\|)", r" \1 ", command), posix=True)
    except Exception:
        tokens = command.split()
    # bases a relative target may resolve against: the cwd and every `cd <dir>` target
    bases = [os.path.realpath(cwd)]
    for i, t in enumerate(tokens):
        if t == "cd" and i + 1 < len(tokens):
            d = os.path.expanduser(tokens[i + 1].strip("\"'"))
            bases.append(os.path.realpath(d if os.path.isabs(d) else os.path.join(cwd, d)))
    if re.search(r"\bgit\s+clean\b", command) and any(os.path.realpath(b) == root for b in bases):
        deny(MSG.format(root=root, hit="git clean"))
    # Only the arguments AFTER a destructive verb are targets (so `printf x; rm /tmp/a` does not
    # judge `printf` as a path). A segment ends at ; && || |.
    VERBS = {"rm", "unlink", "shred", "truncate", "mv"}
    segs, cur = [], []
    for t in tokens:
        if t in (";", "&&", "||", "|"):
            segs.append(cur)
            cur = []
        else:
            cur.append(t)
    segs.append(cur)
    for seg in segs:
        active = False
        for t in seg:
            if not active:
                if t in VERBS or (t == "find" and "-delete" in seg):
                    active = True
                continue
            t = os.path.expanduser(t.strip("\"'"))
            if not t or t.startswith("-") or t in SKIP_WORDS:
                continue
            cands = [t] if os.path.isabs(t) else [os.path.join(b, t) for b in bases]
            for c in cands:
                if under(c, root) and not allowed(c, root):
                    deny(MSG.format(root=root, hit=t))
    allow()


if __name__ == "__main__":
    main()
