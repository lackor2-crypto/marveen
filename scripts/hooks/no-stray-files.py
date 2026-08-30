#!/usr/bin/env python3
"""PreToolUse kapu: az eletfa NEM szemeteslerakat.

Boss, 2026-08-30: "onmagatol ne keletkezzen semmilyen fajl (...) te, Marvin, az
agentek senki nem tehet plusz fajlt ebbe az eletfaba ezt nem szeretem, ha tele
van szemetelve es akkor kesobb itt kiderul, hogy na egyebkent meg 8 darab fajl
ott van." -- es kulon: "hogyha ideiglenesen, vagy a fejleszteshez kell
letrehozni egy fajlt, akkor azt utana, amikor a fejlesztes keszen van, utana
torolni kell."

A MERT EZ MEGTORTENT (2026-08-29 18:34:18 - 18:37:05, meresbol). Nyolc fajl
keletkezett a repo gyokereben harom perc alatt: negy Playwright-probaszkript
(.tmp-check-marvin{,2,3,4}.mjs) es a kimeneteik (.tmp-info.json, .tmp-shot1.png,
.tmp-shot2.png, .tmp-claudepart.html). NEM a repo kodja irta oket -- egy
asszisztens-menet irta a projekt gyokerebe, ahelyett hogy egy eldobhato
munkakonyvtarba tette volna, es a munka vegen egyik sem lett letorolve. Egy
napig ott alltak, mert az egyetlen figyelo (uncommitted-work-runner.ts) a
nem-kovetett fajlokat SZANDEKOSAN eldobja ("a scratch file nobody has staged is
not work at risk"). Ket retegen csuszott at ugyanaz a szemet: senki nem
akadalyozta meg a keletkezeset, es senki nem vette eszre utana.

MIERT BLOKKOL EZ, AMIKOR A file-claim-gate NEM (Boss, 2026-08-25, #13):
ott a tiltas azt jelentette volna, hogy az agens ALL, mert nincs hova irnia --
"olyan nem tortenhet meg hogy egy agent online all es senki nem csinal semmit".
Itt nincs ilyen: a kapu megnevezi a HELYES utat (eldobhato -> /tmp, projekthez
tartozo -> alkonyvtar + git add), az agens egy masodperc mulva ujra ir, csak jo
helyre. A tiltas nem munkat vesz el, hanem cimet javit.

BIZTONSAGI SZELEPEK. Barmilyen bizonytalansag -> ATENGED (hibas bemenet, hianyzo
git, idotullepes, gyokeren kivuli ut). Kikapcsolo: MARVEEN_STRAY_FILE_GATE=0.
A kovetett (git ls-files) gyoker-fajlok szerkesztese mindig szabad, kulonben a
package.json vagy a README szerkesztese akadna el.
"""
import json
import os
import re
import subprocess
import sys

GUARDED_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}

# Nevek, amik barhol a fan belul eldobhato munkafajlt jelentenek. Szuk lista
# szandekosan: minden mintanak egy ismert, valodi szemet-fajtat kell fednie.
TEMP_NAME_RX = re.compile(
    r"^(?:\.tmp-|tmp-|tmp\.|scratch[-_.]|debug[-_.])"
    r"|(?:\.tmp|\.bak|\.orig|\.rej|~)$",
    re.IGNORECASE,
)

# Amit a gyokerben a git nem kovet, megis oda valo egy mukodo telepitesen.
ROOT_ALWAYS_OK = {
    ".env", ".env.local", ".mcp.json",
    "CLAUDE.md", "SOUL.md", "AGENTS.md", "HEARTBEAT.md",
}


def allow():
    sys.exit(0)


def deny(msg):
    sys.stderr.write(msg)
    sys.exit(2)


def project_root():
    root = os.environ.get("CLAUDE_PROJECT_DIR", "").strip()
    if root and os.path.isdir(root):
        return os.path.realpath(root)
    # scripts/hooks/no-stray-files.py -> a repo gyokere
    return os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def tracked_root_files(root):
    """A gyokerben (melyseg 0) kovetett fajlok neve. None = nem tudtam megkerdezni.

    A NULLA KET DOLGOT JELENTHET: ha a git nem valaszol, NEM ures halmazt adunk
    vissza (abbol minden gyoker-iras tiltott lenne), hanem None-t -- es a hivo
    ilyenkor atenged."""
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files", "--full-name"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return {p for p in out.stdout.split("\n") if p and "/" not in p}


UZENET_GYOKER = """\
[eletfa-kapu] MEGALLITVA: uj fajl a projekt GYOKERBE -- "{name}"

Az eletfat nem szemeteljuk tele. A gyokerbe csak az kerul, ami a projekt resze
es commitolva van; probaszkript, kepernyokep, dump, ideiglenes kimenet SOHA.

Hova ird helyette:
  * eldobhato munkafajl (proba, dump, kepernyokep)  ->  /tmp/  vagy a session
    sajat scratch-konyvtara -- ES A MUNKA VEGEN TOROLD LE;
  * a projekthez tartozo uj fajl  ->  a temanak megfelelo alkonyvtarba
    (src/, scripts/, docs/, web/, seed-skills/) -- es commitold;
  * ha tenyleg a gyokerbe valo (uj telepito, uj konfig): hozd letre, majd
    azonnal `git add {name}` -- a kapu a kovetett gyoker-fajlokat atengedi.

Kikapcsolas (csak indokolt esetben): MARVEEN_STRAY_FILE_GATE=0
"""

UZENET_TEMP = """\
[eletfa-kapu] MEGALLITVA: ideiglenes fajl a projekt fajan belul -- "{rel}"

A "{name}" nev eldobhato munkafajlt jelol (.tmp-, tmp-, scratch-, .bak, ...).
Ilyen a repoban nem maradhat: egy nap mulva mar senki nem tudja, kell-e meg.

Ird inkabb /tmp/ ala (vagy a session scratch-konyvtaraba), es a munka vegen
TOROLD LE. Ha a fajl a projekt valodi resze, adj neki rendes nevet es helyet,
es commitold.

Kikapcsolas (csak indokolt esetben): MARVEEN_STRAY_FILE_GATE=0
"""


def main():
    if os.environ.get("MARVEEN_STRAY_FILE_GATE") == "0":
        allow()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
    if payload.get("tool_name") not in GUARDED_TOOLS:
        allow()
    raw = (payload.get("tool_input") or {}).get("file_path")
    if not isinstance(raw, str) or not raw.strip():
        allow()

    root = project_root()
    try:
        target = os.path.realpath(os.path.join(root, raw))
    except Exception:
        allow()
    if target == root or not target.startswith(root + os.sep):
        allow()  # a fan kivul: nem a mi dolgunk

    rel = os.path.relpath(target, root)
    name = os.path.basename(target)

    # 1) Eldobhato nev BARHOL a fan belul.
    if TEMP_NAME_RX.search(name):
        deny(UZENET_TEMP.format(rel=rel, name=name))

    # 2) Uj fajl kozvetlenul a gyokerben.
    if os.sep not in rel:
        if name in ROOT_ALWAYS_OK:
            allow()
        tracked = tracked_root_files(root)
        if tracked is None:
            allow()  # nem lattam oda -> nem tiltok
        if name not in tracked:
            deny(UZENET_GYOKER.format(name=name))

    allow()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        allow()
