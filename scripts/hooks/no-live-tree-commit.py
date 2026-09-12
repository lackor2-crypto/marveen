#!/usr/bin/env python3
"""PreToolUse kapu: SOHA ne commitolj/stage-elj kozvetlenul az ELO tree-ben.

Boss, 2026-09-12: "sohasem dolgozunk kozvetlenul az elo tree ben! claude md be
es mindenhova."

A MERT EZ MEGTORTENT (2026-09-12, meresbol). Egy VS Code Claude Code session
(Opus 5, git-identitas "T") KOZVETLENUL az elo checkoutban (a fo PROJECT_ROOT
munkafa, amibol a dashboard fut) dolgozott: a lokalis main branchre commitolt
(92494c4) es 58 fajlt stagelt. Mivel a valtoztatasok eltertek origin/main-tol,
a scripts/deploy-live.sh MINDEN korben "REFUSING to deploy"-t irt (helyesen, nem
clobberol kezi munkat), tehat a futo app beragadt es a jovobeni landolasok sem
jutottak ki, amig a fat valaki vissza nem allitotta tiszta origin/main-re.

MIT CSINAL: ha egy `git commit` / `git add` / `git stage` parancs KOZVETLENUL az
elo checkout gyokerebol futna, megallitja, es megmondja a helyes utat (izolalt
worktree + land-pr.sh). Ez ugyanaz a filozofia mint a no-stray-files kapu: nem
munkat vesz el (a munka a worktree-ben elvegezheto), hanem cimet javit.

MIERT BLOKKOL (szemben a file-claim-gate-tel, ami csak naploz): itt a kar
visszafordithatatlan es NEMA -- a beragadt deploy utan senki nem latja, hogy a
futo app elavult, amig valaki kezzel helyre nem allitja a fat. A blokk nem
allitja meg az agenst: a worktree egy parancs (scripts/agent-worktree.sh), es
ott azonnal dolgozhat tovabb.

BIZTONSAGI SZELEPEK (barmi bizonytalansag -> ATENGED):
 - csak a Bash eszkozt nezi;
 - csak akkor, ha a session CWD-je pontosan az elo checkout GYOKERE (nem
   worktree, amit a git-common-dir vs show-toplevel osszevetese dont el, gep-
   fuggetlenul);
 - csak akkor, ha az elo checkoutban van .worktrees/ mappa (azaz ez tenyleg
   worktree-alapu flotta-host) -- egy egyszeru/friss telepitest, ahol nincs
   worktree-munkafolyamat, SOSE blokkol;
 - ha a parancs `cd`-zik valahova vagy `git -C <ut>`-at hasznal, a cel
   bizonytalan -> ATENGED (valoszinuleg worktree-t celoz);
 - barmilyen git-hiba, idotullepes, hianyzo mezo -> ATENGED.
Kikapcsolo: MARVEEN_NO_LIVE_TREE_GATE=0.
"""
import json
import os
import re
import subprocess
import sys

# A git-alparancsok, amik az elo tree indexet/tortenetet irnak.
GIT_WRITE_RX = re.compile(r"\bgit\b(?:\s+-[cC]\s+\S+|\s+--\S+)*\s+(commit|add|stage|am)\b")
# Ha a parancs maga cd-zik vagy `git -C <ut>`-ot ad, a cel bizonytalan.
CD_RX = re.compile(r"(^|[;&|]|\balias\b)\s*cd\s+\S")
GIT_C_RX = re.compile(r"\bgit\s+-[cC]\s+\S")


def allow():
    sys.exit(0)


def deny(msg):
    sys.stderr.write(msg)
    sys.exit(2)


def git_out(cwd, *args):
    """git parancs a cwd-ben; None barmilyen hiba eseten (fail-open)."""
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return r.stdout.strip()


UZENET = (
    "\n[no-live-tree kapu] TILOS kozvetlenul az ELO checkoutban commitolni/"
    "stage-elni ({root}).\n"
    "Ez a munkafa amibol a dashboard fut; a kozvetlen commit megallitja az "
    "auto-deploy-t (a deploy nem clobberol kezi munkat), es a futo app "
    "beragad.\n\n"
    "HELYETTE:\n"
    "  1. scripts/agent-worktree.sh <nev>     # sajat izolalt worktree + branch\n"
    "  2. ott szerkessz, tesztelj, commitolj\n"
    "  3. scripts/land-pr.sh \"commit cim\"      # branch -> PR -> CI zold -> merge\n"
    "A landolt kodot a scripts/deploy-live.sh viszi ki magatol az elo peldanyra.\n"
    "(Ha tenyleg kell: MARVEEN_NO_LIVE_TREE_GATE=0 kikapcsolja ezt a kaput.)\n"
)


def main():
    if os.environ.get("MARVEEN_NO_LIVE_TREE_GATE") == "0":
        allow()

    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()

    if payload.get("tool_name") != "Bash":
        allow()

    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        allow()

    # Nem iras-parancs -> atengedjuk.
    if not GIT_WRITE_RX.search(command):
        allow()

    # A cel bizonytalan (masik konyvtarat celoz) -> fail-open.
    if CD_RX.search(command) or GIT_C_RX.search(command):
        allow()

    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        allow()
    if not os.path.isdir(cwd):
        allow()

    # A session munkafajanak gyokere.
    toplevel = git_out(cwd, "rev-parse", "--show-toplevel")
    if not toplevel:
        allow()

    # A KOZOS .git (minden worktree ugyanazt osztja): a fo checkout ennek a
    # szuloje. Gep-fuggetlen -- nincs beegetett ut.
    common = git_out(cwd, "rev-parse", "--git-common-dir")
    if not common:
        allow()
    if not os.path.isabs(common):
        common = os.path.join(cwd, common)
    live_root = os.path.dirname(os.path.realpath(common))

    # Ez a CWD az elo checkout gyokere? (worktree eseten a toplevel a
    # .worktrees/<nev>, tehat nem egyezik.)
    if os.path.realpath(toplevel) != live_root:
        allow()

    # Csak worktree-alapu flotta-hoston blokkolunk; egy egyszeru/friss
    # telepitesen (nincs .worktrees/) sose allunk utba.
    if not os.path.isdir(os.path.join(live_root, ".worktrees")):
        allow()

    deny(UZENET.format(root=live_root))


if __name__ == "__main__":
    main()
