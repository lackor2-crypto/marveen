#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bring every live settings.json up to the template's hook set.

The template is the single source of truth, but only for agents SCAFFOLDED
after a change -- the 15 that already exist keep whatever they were created
with. That is why the broken PreCompact hook survived a fix to the template,
and why agent-parity fails right now.

This merges rather than overwrites. Each live file keeps every hook it has, in
place; only hooks the template defines and the file lacks are appended, matched
by script BASENAME so a differently-quoted or differently-wrapped invocation of
the same script is recognised as already present. Nothing is removed: a hook
somebody added by hand for one agent is not this script's to delete.

Every file is backed up next to itself before it is touched, and the result is
parsed as JSON before it is written -- an invalid settings.json stops that agent
from starting at all.
"""
import io
import json
import os
import re
import shutil
import sys
import time

# Derived, never written down: this script edits the settings of whichever
# install it ships with, and a baked-in path would quietly migrate the wrong
# fleet on a second install (scripts/ -> repo root).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "templates", "settings.json.template")
STAMP = time.strftime("%Y%m%d-%H%M%S")


def main_agent_id():
    """Same source as src/config.ts: MAIN_AGENT_ID from .env, else 'marveen'.

    Writing the local value ('lackor2-bot') into the script would put this
    install's bot name into every other install's settings.json.
    """
    try:
        for line in io.open(os.path.join(ROOT, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("MAIN_AGENT_ID="):
                return line.split("=", 1)[1].strip().strip('"').strip("'") or "marveen"
    except Exception:
        pass
    return "marveen"


MAIN_AGENT = main_agent_id()

DRY = "--apply" not in sys.argv


def script_name(cmd):
    """The .py/.sh basename a hook command runs, or None."""
    m = re.findall(r"([A-Za-z0-9_.-]+\.(?:py|sh))", cmd or "")
    return m[-1] if m else None


def render(agent_id, agent_dir):
    raw = io.open(TPL, encoding="utf-8").read()
    raw = (raw.replace("{{PROJECT_ROOT}}", ROOT)
              .replace("{{INSTALL_DIR}}", ROOT)
              .replace("{{AGENT_ID}}", agent_id)
              .replace("{{MAIN_AGENT_ID}}", MAIN_AGENT)
              .replace("{{AGENT_DIR}}", agent_dir))
    left = re.findall(r"\{\{[A-Z_]+\}\}", raw)
    if left:
        print("  ! kitoltetlen helyorzo: %s" % sorted(set(left)))
        return None
    return json.loads(raw)


def merge(live, tpl):
    """Append template hooks the live file is missing. Returns the added names."""
    added = []
    live_hooks = live.setdefault("hooks", {})
    for event, tpl_groups in (tpl.get("hooks") or {}).items():
        live_groups = live_hooks.setdefault(event, [])
        have = set()
        for g in live_groups:
            for h in (g.get("hooks") or []):
                n = script_name(h.get("command"))
                if n:
                    have.add(n)
        for g in tpl_groups:
            missing = [h for h in (g.get("hooks") or []) if script_name(h.get("command")) not in have]
            if not missing:
                continue
            # Keep the template's own grouping (its matcher belongs with it)
            # rather than folding the hook into an existing group with a
            # different matcher, which would change WHEN it fires.
            newg = {k: v for k, v in g.items() if k != "hooks"}
            newg["hooks"] = missing
            live_groups.append(newg)
            added += [script_name(h.get("command")) for h in missing]
    return added


# The main agent's fleet hooks live in the USER settings file, not in the
# project one. Both exist and both load, but they hold different sets:
# ~/.claude/settings.json carries the same thirteen hooks every sub-agent has,
# while marveen/.claude/settings.json holds an older, unrelated group (ledger-*,
# inbox-drain) that is not the template's business. Writing the template into
# the project file would have added a SECOND copy of every hook to the main
# agent -- each one firing twice -- which is why this is spelled out rather than
# inferred from the directory layout.
targets = [(main_agent_id(), os.path.join(os.path.expanduser("~"), ".claude", "settings.json"), ROOT)]
for name in sorted(os.listdir(os.path.join(ROOT, "agents"))):
    p = os.path.join(ROOT, "agents", name, ".claude", "settings.json")
    if os.path.isfile(p):
        targets.append((name, p, os.path.join(ROOT, "agents", name)))

print("%s -- %d settings.json" % ("PROBA (nem ir)" if DRY else "ELES", len(targets)))
changed = 0
for agent_id, path, agent_dir in targets:
    tpl = render(agent_id, agent_dir)
    if tpl is None:
        print("  %-16s KIHAGYVA (sablon nem renderelheto)" % agent_id); continue
    try:
        live = json.loads(io.open(path, encoding="utf-8").read())
    except Exception as e:
        print("  %-16s KIHAGYVA (olvashatatlan: %s)" % (agent_id, e)); continue
    added = merge(live, tpl)
    if not added:
        print("  %-16s rendben, nincs hianyzo hook" % agent_id); continue
    changed += 1
    print("  %-16s + %s" % (agent_id, ", ".join(added)))
    if DRY:
        continue
    out = json.dumps(live, indent=2, ensure_ascii=False) + "\n"
    json.loads(out)  # never write a settings.json that cannot be parsed back
    shutil.copy2(path, "%s.bak-%s" % (path, STAMP))
    io.open(path, "w", encoding="utf-8").write(out)

print("%d fajl %s" % (changed, "modosulna" if DRY else "modositva"))
if DRY:
    print("eles futtatas: python3 %s --apply" % sys.argv[0])
