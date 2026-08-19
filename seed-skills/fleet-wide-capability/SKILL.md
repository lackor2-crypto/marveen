---
name: fleet-wide-capability
description: Use when adding, changing or debugging any agent capability (hook, skill, gate, tool wiring) so that EVERY agent gets it, not just the one you were working on. Triggers - "kosd be a hookot", "adj hozza egy hookot", "csak Marvinnal mukodik", "a sub-agensnel nem megy", installing a hook script, editing settings.json, or noticing two agents behave differently.
---
# Fleet-wide capability (agens-paritás)

## Mikor használd
- Új hookot, gate-et, skillt vagy bármilyen ágens-képességet kötsz be
- Egy funkció "az egyik ágensnél működik, a másiknál nem"
- Bármikor, amikor egy `settings.json`-t szerkesztenél kézzel

## A szabály
Ami az egyik ágensnek jár, az mindnek jár, UGYANABBAN a munkamenetben.
Kivétel csak indoklással létezik (`src/agent-parity.ts`).

## Eljárás
1. **Állapítsd meg a típust**: hook / ensure-kód / skill / kivétel.
2. **Hook** -> `templates/settings.json.template`. Ez az egyetlen forrás; az
   `ensureAgentHooks()` minden dashboard-induláskor kiosztja MINDEN ágensnek
   (a fő ágens is benne van a körben). Fail-open forma kötelező:
   `bash -c '[ -f {{PROJECT_ROOT}}/scripts/hooks/X ] && exec python3 {{PROJECT_ROOT}}/scripts/hooks/X; exit 0'`
3. **Ágensenként épített parancs** -> `ensure*()` a `src/web/agent-scaffold.ts`-ben,
   a `[MAIN_AGENT_ID, ...listAgentNames()]` körben hívva, plusz felvétel a
   `FLEET_WIDE_BY_CODE` listába indoklással.
4. **Skill** -> `~/.claude/skills/`, ne egy ágens sajátjába.
5. **Kivétel** -> `MAIN_ONLY_HOOKS` / `SUBAGENT_ONLY_HOOKS`, kötelező `why`.
6. **Ellenőrizd** (lásd lent), majd indítsd újra a dashboardot, hogy a
   kiosztás lefusson.

## Buktatók
- **Önálló telepítő szkript a `~/.claude`-ba**: pontosan így vesztek el a
  kép-kicsinyítő és a rate-limit-guard hookok a sub-ágenseknél
  (2026-08-11). Egy `install-*.sh` csak a fő ágenst éri el.
- **A fiók-ágensek `CLAUDE_CONFIG_DIR`-je más** (`store/accounts/<fiok>/`), ott
  csak a statusLine van. A hookjaik a PROJEKT szintű
  `agents/<nev>/.claude/settings.json`-ből jönnek, amit a sablon táplál.
- **Nem minden hook illik mindenkihez**: pl. az inbox-drain a fő ágensre való
  (a router a sub-ágenseknek közvetlenül injektál). Az ilyet deklaráld
  kivételként (`MAIN_ONLY_HOOKS` / `SUBAGENT_ONLY_HOOKS`, kötelező `why`), ne
  hagyd sodródni. Megjegyzés: a kormányzási gate-ek (email-send-gate,
  self-pace-gate) 2026-08-20-án megszűntek (Boss döntése) -- ezek voltak az
  egyetlen sub-ágens-only hookok, most a `SUBAGENT_ONLY_HOOKS` üres.
- **A sablon-hook nem duplikálódik**, ha az ágensnél már ott van ugyanaz a
  szkript más formában: az `upgradeLegacyHookCommands()` átírja a sablon
  alakjára.

## Ellenőrzés
```bash
npx vitest run src/__tests__/agent-parity.test.ts   # elhasal, ha bárki kimarad
```
Plusz a dashboard induláskor lefuttatja a `checkAgentParity()`-t: eltérésnél
figyelmeztet a logban és szól a tulajdonosnak a csatornán.

Kézi ellenőrzés, hogy egy hook tényleg kiosztódott:
```bash
python3 - <<'PY'
import json, glob
for f in ['~/.claude/settings.json'] + sorted(glob.glob('agents/*/.claude/settings.json')):
    import os; p=os.path.expanduser(f)
    d=json.load(open(p))
    names=set()
    for arr in d.get('hooks',{}).values():
        if isinstance(arr,list):
            for e in arr:
                for h in e.get('hooks',[]):
                    c=h.get('command','')
                    if '/' in c: names.add(c.split('/')[-1].split()[0].strip("'"))
    print(p, sorted(names))
PY
```

## Kapcsolódó: ágens-ütközés (kanban 37129602)
Ha ketten ugyanazt a fájlt szerkesztenétek, három réteg véd:
- `scripts/agent-worktree.sh <agens>` -- saját munkakönyvtár nagy munkához
- `/api/file-claims` -- ki tartja épp a fájlt (20 perces lejárat, forduló végén felszabadul)
- `file-claim-gate.py` PreToolUse hook -- megtagadja a felülírást, megmondja ki és mióta

A kapu bizonytalanságnál MINDIG enged (dashboard nem elérhető, `store/`, saját
ágens-mappa, repón kívüli fájl). Kikapcsoló: `MARVEEN_FILE_CLAIMS=0`.
Tiltásnál ne kerüld meg: várj, egyeztess, vagy worktree-zz.
