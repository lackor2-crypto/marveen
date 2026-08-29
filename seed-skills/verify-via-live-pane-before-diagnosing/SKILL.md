---
name: verify-via-live-pane-before-diagnosing
description: Amikor {{OWNER_NAME}} egy dashboard/UI-jelenseget kerdojelez meg (pl. "miert nem latszik X az OpenRouter oldalon", "miert varakozik a jelzo miskozben dolgozom"), NE csak a kodból/grep-ből vezesd le a diagnozist -- ellenorizd a valodi elo allapotot (tmux capture-pane az erintett agent session-jen) MIELOTT elkulditi a magyarazatot. Trigger: "miert nem latom", "miert mutat X-et", agent-statusz/aktivitas-megjelenites megkerdojelezese.
---

# Élő pane ellenőrzés diagnózis előtt

## Mikor használd

Amikor {{OWNER_NAME}} megkérdőjelez egy dashboard-jelenséget ami egy AGENT
élő állapotához kötődik (aktivitás-jelző, hibaüzenet hiánya egy
listából, "miért nem dolgozik" típusú kérdés) -- MIELŐTT elküldenéd
a diagnózist {{OWNER_NAME}}-nak.

## Buktató amit ez a skill megelőz

2026-08-09: {{OWNER_NAME}} megkérdezte miért nem látszik egy ügynök (fizetős
OpenRouter agent) a dashboard OpenRouter-usage oldalán. A KÓDBÓL
(grep + Explore sub-agent) az a téves elmélet jött ki, hogy a
konfigban lévő "~" karakter (`~openai/gpt-latest`) érvénytelen
model-id-t okoz, ezért minden hívása némán elbukik. VALÓJÁBAN: egy
`tmux capture-pane -t agent-<nev> -p` egyetlen paranccsal kiderült a
VALÓDI ok -- 402 "insufficient credits" hiba, a "~" teljesen
rendben van, az OpenRouter elfogadja. Ha a kód-alapú elméletet
küldtem volna el {{OWNER_NAME}}-nak javaslatként (fixáld a configot), az idő-
pazarlás lett volna egy nem létező hibára.

Ugyanebben a beszélgetésben egy másik eset: {{OWNER_NAME}} szerint a saját
("Marvin") aktivitás-jelzője "várakozik"-ot mutatott, miközben
láthatóan dolgozott. A `tmux capture-pane -t {{MAIN_AGENT_ID}}-channels`
megmutatta: mindkét állítás igaz egyszerre (a pörgő "Zigzagging"
jelző ÉS az üres, szabad promptmező is látszott) -- ez a Claude Code
"háttérfeladat + szabad prompt" funkciója, nem hiba. Élő capture
nélkül ezt nem lehetett volna pontosan elmagyarázni.

## Eljárás

1. Azonosítsd az érintett agent tmux session nevét (`tmux list-sessions`,
   vagy `agent-<nev>` minta, fő-ágensnél `{{MAIN_AGENT_ID}}-channels` /
   MAIN_CHANNELS_SESSION).
2. `tmux capture-pane -t <session> -p -S -60` -- nézd meg a VALÓDI,
   élő tartalmat (hibaüzenet, spinner, promptmező állapota).
3. Csak EZUTÁN vond le a diagnózist -- ha a kód-alapú elmélet és az
   élő pane ellentmond egymásnak, az élő pane az igazság forrása.
4. Ha a jelenség egy backend-detektor (pl. `detectPaneState`)
   viselkedéséhez köthető, olvasd el a detektor kódját IS, de a
   végső magyarázatot az élő capture-rel támaszd alá, ne csak
   elmélettel.

## Buktatók

- Grep/statikus kód-elemzés önmagában tévútra vihet ha a valódi
  hibaüzenet/állapot csak futásidőben derül ki (pl. API hibakód,
  UI állapot-átfedés).
- Sub-agent (Explore) által visszaadott "valószínű ok" NEM helyettesíti
  az élő ellenőrzést, ha van rá mód (a sub-agent maga sem futtatott
  tmux capture-t ebben az esetben).

## Ellenőrzés

- A {{OWNER_NAME}}-nak elküldött magyarázat egy VALÓDI, frissen capture-elt
  pane-tartalomra vagy log-sorra hivatkozik, nem csak feltételezésre.
