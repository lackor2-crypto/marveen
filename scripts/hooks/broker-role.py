#!/usr/bin/env python3
"""SessionStart hook: tell each agent what its role is in the context pipeline.

Why this file exists (2026-08-14). The "one agent assembles the context and
hands out the work" design was built as a checkbox that writes a name into
store/context-broker.json -- and nothing else. resolveEffectiveBroker() had two
callers, both of them the settings route's own GET and POST. No runtime read it,
no hook mentioned it, no agent was ever told the role existed. So the pipeline
Boss described (the planner assembles, the implementer implements, the checker
checks) could not have been running, whatever the card showed.

This hook is what closes that gap: at every session start it reads the
designation and prints the role, so the agent begins the session knowing whether
it hands work out or receives it.

Two rules Boss added on 2026-08-14 ride along:

  - Clean start. Before the FIRST command of a new task, the generator gives the
    delegate a fresh window. This is the piece that makes the role pay for
    itself -- a curated packet is worth little if the receiver is still carrying
    the previous task -- and a handover is the one moment where dropping context
    is safe, because the replacement arrives with it. Guarded: never the
    generator itself, never a busy agent, and never without the packet
    following immediately.

  - Hand back long work. The expensive agent runs SHORT commands only; anything
    longer goes back to the generator. Long output is what actually fills a
    window, and it costs the same to produce on a cheap model as on an
    expensive one.

Fail-open everywhere: a hook that cannot read its config prints nothing and
exits 0. Losing the role notice costs one session's efficiency; blocking the
session start costs the session.
"""
import json
import os
import sys


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _env_value(key, default):
    v = os.environ.get(key)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return default


def _agent_id_from_cwd(cwd):
    """agents/<name>/... -> <name>; the project root -> the main agent."""
    if not cwd:
        return None
    parts = os.path.normpath(cwd).split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    if os.path.normpath(cwd) == os.path.normpath(_project_root()):
        return _env_value("MAIN_AGENT_ID", "marveen")
    return None


ROLE_LABELS = {
    "planner": "tervezo",
    "implementer": "megvalosito",
    "checker": "ellenorzo",
}


def _roles(cfg):
    """The role -> agent map as the owner ticked it on the cards."""
    raw = cfg.get("roles")
    if not isinstance(raw, dict):
        return {}
    out = {}
    for role in ROLE_LABELS:
        v = raw.get(role)
        if isinstance(v, str) and v.strip():
            out[role] = v.strip()
    return out


def _roster(me, roles):
    """Who can be given work right now, with the role each card was given.

    Read from disk at every session start rather than written into a prompt,
    because the fleet is not a fixed trio and must not be described as one
    (Boss, 2026-08-14: "ha en behozok egy chatgpt t vagy egy teljesen mas
    modelt akkor azokat is tudja ez a kontextusgeneralo rendszer hasznalni.
    nehogy mindig csak ezt a 3 parost keresse fixen"). This install already runs
    GPT, Gemma, Ling, Nemotron, Laguna and Cohere agents beside the Claude ones;
    a hardcoded list would have hidden all of them.

    The model is printed as INFORMATION only. What an agent is allowed to do
    comes from the checkbox on its card and nothing else (Boss, same day: "az
    hogy a kartya alatt milyen model van az ne szamitson"). A rule that ranked
    model names would go stale the day a new provider arrives, and would keep
    overriding the owner's own choice -- which is the opposite of a checkbox.
    """
    root = _project_root()
    holders = {}
    for role, agent in roles.items():
        holders.setdefault(agent, []).append(ROLE_LABELS[role])

    def row(name, model):
        return "  - %-16s [%s]  (%s)" % (name, ", ".join(holders.get(name, [])) or "-", model)

    rows = []
    # The main agent is a card like any other -- listBrokerCandidateNames() is
    # [MAIN_AGENT_ID, ...agents/*] -- but it has no agents/<name>/ directory, so
    # scanning that directory alone would silently drop it from the roster and
    # the generator would never think to delegate to it.
    main = _env_value("MAIN_AGENT_ID", "marveen")
    if main != me:
        rows.append(row(main, "fo agens"))
    try:
        names = sorted(os.listdir(os.path.join(root, "agents")))
    except Exception:
        names = []
    for name in names:
        if name == me or name == main:
            continue
        try:
            with open(os.path.join(root, "agents", name, "agent-config.json"), encoding="utf-8") as f:
                model = json.load(f).get("model") or "?"
        except Exception:
            continue
        rows.append(row(name, model))
    return "\n".join(rows)


def _config():
    path = os.path.join(_project_root(), "store", "context-broker.json")
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return None
    if not isinstance(cfg, dict):
        return None
    return cfg


GENERATOR = """[SZEREP: te vagy a kontextusgenerator]

Te allitod ossze a munkacsomagokat a tobbi agensnek, es te osztod ki a
feladatokat. Ez nem tomorites: nem a sajat beszelgetesedet rovidited, hanem
MASOKNAK epitesz kicsi, pontos kiindulast.

A munkacsomag allapot, nem proza. Amit bele kell tenni:
  - a pontos fajl-utvonalak es fuggvenynevek, amikkel dolgozni kell
  - a hibauzenet SZO SZERINT, sose atfogalmazva
  - a kikotesek (mit nem szabad elrontani, mit mar kiprobaltunk es miert bukott)
  - a szamok, verziok, parancsok pontosan (soha ne kerekits, soha ne irj "kb")
  - EGY konkret kovetkezo lepes
Ami kimaradhat: minden elbeszeles arrol, hogyan jutottunk idaig.

Kinek add: a szerepeket a TULAJDONOS jeloli ki a kartyakon, nem a modell neve
donti el. Ez all most a kartyakon (szogletes zarojelben a szerep, kerekben csak
tajekoztatasul a modell):
{roster}
  tervezo      -> a nehez gondolkodas: terv, dontes, vitas kerdes
  megvalosito  -> a gepies vegrehajtas a terv alapjan
  ellenorzo    -> a kesz munka atnezese, visszajelzes

Amelyik szerep nincs kiosztva (-), azt te dontod el feladatrol feladatra. Ha uj
agens kerul be barmilyen modellel, magatol megjelenik itt, es ugyanugy kaphat
munkat -- ha nem tudod, mire jo, adj neki eloszor kicsi, ellenorizheto feladatot,
es abbol dontsd el. A kiosztott szerepet ne ird felul azzal, hogy egy masik
modellt erosebbnek gondolsz."""

CLEAN_START = """
Tiszta indulas: ha egy UJ feladat elso parancsat adod ki, elotte uritsd ki a
megbizott agens beszelgeteset, hogy tiszta lappal induljon -- kozvetlenul utana
kuldd is at a munkacsomagot, ugyanabban a lepesben.
  POST {base}/api/agents/<agens>/context-action  {{"action":"clear"}}
Harom eset, amikor NEM szabad:
  - sajat magadra (a sajat kontextusod a termek, amit epp elkeszitettel)
  - ha az agens epp dolgozik, vagy van feldolgozatlan uzenete
  - ha nincs keszen a munkacsomag: torles utan csomag nelkul csak amnezia marad
Ha a valasz nem ok, ne torolj es ne is eroltess: kuldd el a csomagot ugy is."""

WORKER = """[SZEREP: a munkacsomagot {broker} allitja ossze neked]

Ha hianyzik valami a munkahoz (fajl tartalma, hibauzenet, korabbi dontes), NE
kezdj el keresgelni: kerd el {broker}-tol. Az o dolga eloszedni, a tied
megoldani."""

# Only printed when the owner ticked a role on THIS agent's card. The wording is
# what the role means, not what the model behind the card is assumed to be good
# at -- a Gemma card ticked as planner plans, and reads the same text a Claude
# card would.
ROLE_NOTE = """
A kartyadon ez a szereped: {roles}.
  tervezo      -> terv, dontes, vitas kerdes; ne kezdj el kodolni, a tervet add vissza
  megvalosito  -> a kapott terv vegrehajtasa; ha a terv rossz, szolj, ne tervezz ujra
  ellenorzo    -> a kesz munka atnezese; te nem javitasz, hanem megtalalod a hibat"""

HANDBACK = """
Rovid parancsok: a gepen csak rovid keresest inditasz (kb. {secs} masodperc
folott mar hosszu). Ha egy parancs ennel tovabb tartana -- teljes build, teljes
tesztfuttatas, nagy naplo atnezese -- ne futtasd le magad, hanem add vissza
{broker}-nak, es o adja vissza az EREDMENYT. A hosszu kimenet az, ami tele
tolti a kontextusablakot, es olcso modellen ugyanaz jon ki belole."""


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    cwd = payload.get("cwd") or os.getcwd()
    me = _agent_id_from_cwd(cwd)
    if not me:
        sys.exit(0)

    cfg = _config()
    if not cfg:
        sys.exit(0)
    raw_designated = cfg.get("designated")
    designated = raw_designated.strip() if isinstance(raw_designated, str) else ""
    roles = _roles(cfg)
    if not designated and not roles:
        # Nothing is assigned. That is a valid, working state -- every agent
        # prepares its own context, exactly as before the feature existed -- so
        # say nothing rather than describing a pipeline that is not running.
        sys.exit(0)

    base = "http://localhost:%s" % _env_value("WEB_PORT", "3420")
    parts = []
    if designated and me == designated:
        roster = _roster(me, roles)
        if not roster:
            roster = "  (nincs mas agens felveve)"
        parts.append(GENERATOR.format(roster=roster))
        if cfg.get("cleanStart") is True:
            parts.append(CLEAN_START.format(base=base))
    elif designated:
        parts.append(WORKER.format(broker=designated))
        secs = cfg.get("handBackAfterSeconds")
        if isinstance(secs, (int, float)) and secs > 0:
            parts.append(HANDBACK.format(broker=designated, secs=int(secs)))

    # My own ticked roles, whether or not a generator is designated -- the two
    # settings are independent, and a role means the same thing either way.
    mine = [ROLE_LABELS[r] for r in ("planner", "implementer", "checker") if roles.get(r) == me]
    if mine:
        parts.append(ROLE_NOTE.format(roles=", ".join(mine)))

    if not parts:
        sys.exit(0)
    sys.stdout.write("\n".join(parts) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
