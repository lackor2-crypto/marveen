#!/usr/bin/env python3
"""PreToolUse kapu: az ELO store/claudeclaw.db-t semmilyen torlo parancs ne erje el.

A MERT ESET (2026-10-03 02:28, a tulajdonos adata ment el): egy tesztelo
parancslanc `cd <worktree> && ...; rm -rf store/claudeclaw.db*` alakban futott.
A worktree kozben mar nem letezett, a `cd` elbukott, es a pontosvessző utani
torles az ELO checkoutban futott le (a session cwd-je ott volt). Az elo
adatbazis (kanban, memoria, projektek, jovahagyasok) kiurult; a legutobbi jo
mentes ~23 oras volt.

MIT CSINAL: egy Bash parancsot, ami torli/athelyezi/csonkolja a claudeclaw.db-t
(rm, unlink, shred, truncate, mv), megallit, HA a celpont az elo store/.
 - abszolut utnal: csak akkor, ha az az ELO store/ (a worktree sajat store/-ja,
   pl. egy teszt-peldany torlese, szabad);
 - relativ utnal: ha a session cwd-je az elo checkout gyokere -- AKKOR IS, ha a
   parancs `cd`-zik (a cd el is bukhat, pont ez volt a hiba);
 - worktree-cwd-bol relativ utnal atengedi.
Egy teszt-peldany torlese: `rm -rf /abs/ut/.worktrees/<nev>/store/claudeclaw.db*`
(abszolut ut, ami nem az elo store), vagy a worktree-ben dolgozo session.

BIZTONSAGI SZELEPEK (bizonytalansag -> ATENGED): csak Bash; barmilyen git-hiba,
hianyzo mezo, nem worktree-alapu host (nincs .worktrees/) -> atengedi.
Kikapcsolo: MARVEEN_NO_LIVE_STORE_GATE=0.
"""
import json
import os
import re
import shlex
import subprocess
import sys

DESTROY_RX = re.compile(r"(^|[;&|(`\s])(rm|unlink|shred|truncate|mv)\b")


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
    "\n[no-live-store kapu] TILOS az ELO adatbazist torolni/athelyezni/csonkolni "
    "({store}/claudeclaw.db*).\n"
    "2026-10-03-an egy `cd <worktree> && ...; rm -rf store/claudeclaw.db*` lanc cd-je "
    "elbukott, a torles az elo fan futott le, es ~23 ora adat ment el.\n\n"
    "HELYETTE: teszt-peldany adatbazisat ABSZOLUT uttal torold, ami a worktree store/-ja:\n"
    "  rm -rf /abs/ut/.worktrees/<nev>/store/claudeclaw.db*\n"
    "(vagy dolgozz a worktree-bol indított sessionben). Az eloben a torles csak a "
    "tulajdonos dontesevel, visszaallitasi folyamatban tortenhet.\n"
    "(Ha tenyleg kell: MARVEEN_NO_LIVE_STORE_GATE=0 kikapcsolja ezt a kaput.)\n"
)


def main():
    if os.environ.get("MARVEEN_NO_LIVE_STORE_GATE") == "0":
        allow()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
    if payload.get("tool_name") != "Bash":
        allow()
    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or "claudeclaw.db" not in command:
        allow()
    if not DESTROY_RX.search(command):
        allow()

    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        allow()
    toplevel = git_out(cwd, "rev-parse", "--show-toplevel")
    common = git_out(cwd, "rev-parse", "--git-common-dir")
    if not toplevel or not common:
        allow()
    if not os.path.isabs(common):
        common = os.path.join(cwd, common)
    live_root = os.path.dirname(os.path.realpath(common))
    if not os.path.isdir(os.path.join(live_root, ".worktrees")):
        allow()  # nem worktree-alapu host
    live_store = os.path.join(live_root, "store")
    cwd_is_live = os.path.realpath(toplevel) == live_root

    try:
        tokens = shlex.split(command.replace(";", " ; ").replace("&&", " && "), posix=True)
    except Exception:
        tokens = command.split()
    hits = [t for t in tokens if "claudeclaw.db" in t]
    if not hits:
        allow()
    for t in hits:
        t = t.strip("\"'")
        if os.path.isabs(t):
            if os.path.realpath(os.path.dirname(t)) == os.path.realpath(live_store):
                deny(MSG.format(store=live_store))
        else:
            if cwd_is_live:
                deny(MSG.format(store=live_store))
    allow()


if __name__ == "__main__":
    main()
