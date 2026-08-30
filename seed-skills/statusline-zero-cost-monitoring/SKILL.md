---
name: statusline-zero-cost-monitoring
description: Amikor a Marveen dashboardnak élő adatot kell mutatnia a fő-agent (vagy bármely Claude Code session) saját állapotáról -- pl. plan usage %/keret-limit, context-window %, aktuális modell -- ÉS a megoldás NEM fogyaszthat extra tokent/modellhívást. Trigger: "figyeld a keretet/limitet", "keret %", "usage limit dashboardon", vagy bármi ami polling/heartbeat-tel oldható meg DE {{OWNER_NAME}} elutasította a token-költséget.
scope: global
---
# Claude Code statusLine mint nulla-költségű helyi adatforrás

## Mikor használd

Amikor a fő-agent (vagy egy sub-agent) saját futásidejű állapotát (plan
usage %, context %, aktuális modell, session id) be kell kötni a
dashboardba, DE tilos érte extra modellhívást/tokent költeni. Ez pontosan
a helyzet a kártya ef06b18d (idő/keret-limit % figyelés) esetén: {{OWNER_NAME}}
2026-08-08 kifejezetten elutasította a heartbeat-sűrítést ("token zabáló
lenne"), lásd `heartbeat-frequency-cost-tradeoff` memória.

## A trükk

Claude Code CLI a `statusLine` mechanizmuson keresztül minden render-tick
alkalmával (NEM modellhívás, tisztán lokális CLI-esemény) JSON-t pipe-ol egy
külső script stdin-jére, `~/.claude/settings.json` `statusLine` kulcsa
alapján:

```json
{"statusLine": {"type": "command", "command": "python3 /path/to/script.py", "padding": 0}}
```

A stdin JSON tartalmazza (ha a session Claude.ai Pro/Max planon fut, API-key
authnál üres):
- `model.display_name`
- `context_window.used_percentage`
- `rate_limits.five_hour.used_percentage` / `.resets_at` (epoch SECONDS)
- `rate_limits.seven_day.used_percentage` / `.resets_at`
- `cwd` / `workspace.current_dir`, `session_id`

Ez az adat MÁR ki van számolva a CLI oldalán, a script csak kiolvassa --
nulla token/API-költség, tetszőlegesen gyakran hívható anélkül hogy a
limitet, amit épp figyel, ő maga fogyasztaná.

## Keret-reset idopontot SOSE irj le fixen

Ha egy agens keret-reset idopontjara hivatkozol -- valaszban, memoriaban,
kartyan, kodban --, azt MINDIG az adott agens sajat elo forrasabol olvasd ki.
Egy leirt datum a kimondas pillanataban meg igaz, egy het mulva mar hazugsag,
es semmi nem szol, amikor elavul.

Valos eset (2026-08-28): egy memoria azt rogzitette, hogy a Segedmunkas heti
kerete "2026-08-17 21:00"-kor nyilik. A valos idopont ekkor mar augusztus 31
21:00 volt, es ezt a rendszer VEGIG helyesen tudta -- csak senki nem kerdezte
meg tole. A tulajdonos kerese: ne a fix datumot javitsuk at egy masik fix
datumra, hanem a lekerdezes legyen a valasz.

Honnan olvasd (mindketto agensenkent kulon, gepfuggetlen uton):

| forras | mit ad |
|---|---|
| `<repo>/store/rate-limit-status/<agentId>.json` | `sevenDay.resetsAt` es `fiveHour.resetsAt`, epoch **ezredmasodperc** |
| `GET /api/agents` (Bearer token) | az agens sorabol `contextQuota.resetsAt` + ember-olvashato `message` |

A repo gyokeret sose ird be fixen: shellben a script sajat helyebol
szarmaztasd, TypeScriptben `PROJECT_ROOT`. Az agens-azonositot sem: azt a
hivo adja at, vagy a lista adja vissza.

Ket buktato, amibe bele lehet futni:
- **A snapshot-fajl `resetsAt`-ja ezredmasodperc, a statusLine stdin-e
  MASODPERC.** A `statusline.py` valtja at; ha nyers stdin-bol dolgozol,
  neked kell.
- **Hianyzo fajl vagy `null` ket dolgot jelenthet:** az agens meg sosem
  rendereltetett statusline-t (friss telepites -- helyes a csend), VAGY nem
  Pro/Max planon fut, tehat sosem is lesz adata. Kulonboztesd meg, es ha nem
  tudod, mondd meg, hogy nem tudod -- ne tippelj datumot.

## Eljárás

1. A script (`scripts/hooks/<nev>.py`, kövesd a meglévő hook-konvenciót)
   stdin-ről olvassa a JSON-t, `cwd`-ből azonosítja MELYIK agent szólt
   (projekt-gyökér = fő-agent, `agents/<nev>/` = sub-agent -- lásd
   `agentDir()`/`MAIN_AGENT_ID` a `src/config.ts`/`src/web/agent-config.ts`-ben),
   és a kinyert adatot ír egy `store/<valami>/<agent>.json` snapshot-fájlba
   (atomikus write: tmp fájl + `os.replace`).
2. A script stdout-ja lesz a ténylegesen megjelenő TUI-sor -- adj vissza
   valami hasznosat (modell, context%, usage%), NE hagyd üresen, és a script
   SOSE dobjon kivételt kifelé (broken statusLine = üres/törött sáv minden
   pane alján).
3. Telepítő script (`scripts/install-<nev>.sh`, kövesd az
   `install-telegram-progress-hook.sh` mintáját): idempotensen másolja a
   scriptet `~/.claude/hooks/`-ba, és Python-nal patch-eli be a
   `~/.claude/settings.json` top-level `statusLine` kulcsát (NEM a `hooks`
   alá megy, az egy külön top-level kulcs).
4. Backend: pure logic modul (`src/<nev>.ts`, dependency-free, tesztelhető)
   + IO modul (`src/web/<nev>-io.ts`, csak fájlolvasás) + route-ba bekötés
   (pl. `/api/overview`).
5. Frontend: overview-kártya/widget színkódolt sávokkal + i18n (HU+EN,
   `i18n-final-verification` skill kötelező zárólépés).

## Buktatók

- **`~/.claude/settings.json` GLOBÁLIS a Linux userre** -- a `statusLine`
  konfig MINDEN futó Claude Code sessionre vonatkozik ezen a gépen (fő-agent
  + mind a 14 sub-agent), nem csak arra amelyiknek szántad. Ez általában
  ártalmatlan (csak a TUI alsó sora változik), de tudatosan vállald be.
- **A már FUTÓ session nem veszi fel azonnal** -- a docs szerint a
  statusLine session-indításkor olvasódik be, tehát egy élő pane a
  telepítés után is a régi (vagy alapértelmezett) statuslinen fut a
  következő újraindulásig. NE kényszeríts emiatt önmagad-újraindítást csak
  a teszteléshez -- inkább szintetikus JSON-t pipe-olj a scriptbe kézzel
  (`echo '{...}' | python3 script.py`) az end-to-end ellenőrzéshez, és a
  teszt-snapshot fájlt TÖRÖLD a végén, nehogy kitalált szám maradjon élesben
  amíg a valódi adat meg nem érkezik.
- **`resets_at` epoch SECONDS**, a dashboard/JS oldal ms-ban dolgozik --
  szorozz 1000-rel a snapshot-írásnál, különben a "visszaáll" időpont
  1970-ben landol.
- **`egress-gate` blokkolja a nyers WebFetch-et** ismeretlen domainre (pl.
  `code.claude.com`) -- a `quarantine-reader` sub-agens allowlistje is
  szűkebb lehet mint a fő-ágensé. Ha mindkettő blokkol, a `WebSearch` tool
  (nem fetch, hanem keresés) általában kiadja a releváns JSON-mezőneveket
  másod-kézből (blogposztok, GitHub issue-k idézik a hivatalos schemát) --
  ebből a schema elég pontosan rekonstruálható fetch nélkül is.

## Ellenőrzés

- `echo '<szintetikus JSON>' | python3 scripts/hooks/<nev>.py` helyesen írja
  a snapshot-fájlt és értelmes stdout-sort ad.
- A backend route (`curl .../api/overview`) visszaadja az új mezőt a helyes
  tier-számítással.
- A teszt-snapshot törölve van, mielőtt "késznek" jelented -- élesben ne
  kitalált szám látszódjon.
