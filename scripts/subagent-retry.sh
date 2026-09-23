#!/bin/bash
# Sub-agens ujraproba-orszem.
#
# MIERT (2026-08-08, meressel): a jovahagyas-ellenorzo korben 15 sub-agensbol 5
# szolgaltatoi hibara futott (429 keret, 400, halozat), es utana MIND tetlenul
# ult. Nem haltak meg -- a session elt, a modell mukodott volna, de senki nem
# inditott nekik ujabb fordulot. Ugyanaz a hianyossag, mint a fo agensnel volt
# (lasd marveen-nudge.sh): "el, tudna dolgozni, de nem kezd".
# Kezi ujraprobalasra kettő azonnal visszatert munkaba.
#
# KORLATOZAS -- szandekosan szoros, mert az ujraproba nem ingyen van:
#   * agensenkent legfeljebb MAX_PER_HOUR ujraproba orankent,
#   * a TARTOS konfiguracios hibakat (nincs hozzaferes a modellhez) SOSEM
#     probaljuk ujra -- azokat jelezzuk Bossnak, mert ott modellcsere kell,
#   * aki dolgozik, azt nem zavarjuk meg.
# E nelkul egy tartos HTTP 400 vegtelen korbe kerulne es ontene a kereteket.
#
# store/-ban el (gitignore), egy kovetett-kod frissites nem torli.
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/subagent-retry.log"
STATEDIR="$STORE/.subagent-retry"
DESIRED="$STORE/agents-desired.json"
MAX_PER_HOUR="${SUBAGENT_RETRY_MAX_PER_HOUR:-2}"
NOTIFY="$INSTALL_DIR/scripts/notify.sh"

mkdir -p "$STATEDIR" 2>/dev/null
log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }

[ -f "$DESIRED" ] || exit 0
AGENTS="$(python3 -c 'import json,sys;print("\n".join(json.load(open(sys.argv[1]))))' "$DESIRED" 2>/dev/null)"
[ -n "$AGENTS" ] || exit 0

RETRY_MSG="Az elozo probalkozasod szolgaltatoi hibara futott (nem a te hibad). Probald ujra a legutobbi feladatot ugyanugy. Ha ismet ugyanaz a hiba jon, ne probalkozz tovabb, csak jelezd egy mondatban, hogy mi a hiba."

notify_once(){ # $1=kulcs  $2=uzenet   -- ugyanarrol csak egyszer szolunk / 6 ora
  local key="$STATEDIR/.notified-$1" now last
  now="$(date +%s)"
  last="$(cat "$key" 2>/dev/null | tr -dc '0-9')"; last="${last:-0}"
  if [ $(( now - last )) -lt 21600 ]; then return 0; fi
  echo "$now" > "$key"
  [ -x "$NOTIFY" ] && bash "$NOTIFY" "$2" >/dev/null 2>&1
  log "ertesites elkuldve: $1"
}

for a in $AGENTS; do
  sess="agent-$a"
  tmux has-session -t "$sess" 2>/dev/null || { log "$a: nincs tmux session -- kihagyom"; continue; }

  # -a MINDENHOL: a panel-kimenet vezerlokaraktereket tartalmaz, es a grep
  # kulonben "binary file matches"-t ir es ELNYELI a talalatot. Pontosan ez a
  # hiba butitotta el a limit-figyelot is (2026-08-08).
  pane="$(tmux capture-pane -p -t "$sess" 2>/dev/null)"
  [ -n "$pane" ] || continue

  # 1) Dolgozik? Akkor bekben hagyjuk -- eppen ez a cel.
  if printf '%s' "$pane" | tail -n 4 | grep -aq "esc to interrupt"; then continue; fi

  # 2) TARTOS konfiguracios hiba: ujraproba ertelmetlen, modellcsere kell.
  # A pane EGESZE helyett csak az alja (2026-08-23): a teljes panel a
  # visszagorgetett elozmenyt is tartalmazza, igy barmelyik agens, aki CSAK
  # BEMASOLTA vagy megnezte egy masik agens modell-hibajat, sajat magat
  # jelentette "nem tud elindulni"-nak -- es Boss kapott rola riasztast. Valos
  # eset: a Szakerto, mikozben eppen ezt a hibat vizsgalta. Az elo hiba mindig
  # a panel aljan van, mint a 3) pontnal.
  if printf '%s' "$pane" | tail -n 12 | grep -aqiE "pick a different model|may not have access to it|issue with the selected model"; then
    notify_once "model-$a" "⚠️ A(z) $a sub-agens nem tud elindulni: a beallitott modell nem elerheto vagy nem alkalmas (nincs tool-calling). Ujraprobalas nem segit -- modellt kell cserelni a dashboardon."
    log "$a: TARTOS modell-hiba -- nem probalom ujra"
    continue
  fi

  # 3) Atmeneti szolgaltatoi hiba?
  if ! printf '%s' "$pane" | tail -n 12 | grep -aqiE "API Error: [45][0-9][0-9]|Request rejected \(429\)|Provider returned error|proxy or gateway|429"; then
    continue
  fi

  # 4) Ora-keret ellenorzese
  st="$STATEDIR/$a"
  now="$(date +%s)"
  wstart=0; count=0
  if [ -f "$st" ]; then
    wstart="$(cut -d: -f1 "$st" 2>/dev/null | tr -dc '0-9')"; wstart="${wstart:-0}"
    count="$(cut -d: -f2 "$st" 2>/dev/null | tr -dc '0-9')"; count="${count:-0}"
  fi
  if [ $(( now - wstart )) -ge 3600 ]; then wstart="$now"; count=0; fi

  if [ "$count" -ge "$MAX_PER_HOUR" ]; then
    notify_once "budget-$a" "⚠️ A(z) $a sub-agens ebben az oraban mar $MAX_PER_HOUR ujraprobat elhasznalt, es tovabbra is szolgaltatoi hibara fut. Erdemes megnezni a modelljet."
    log "$a: elfogyott az ora-keret ($count/$MAX_PER_HOUR) -- varok"
    continue
  fi

  echo "$wstart:$(( count + 1 ))" > "$st"
  tmux send-keys -t "$sess" -l "$RETRY_MSG" 2>/dev/null
  sleep 1
  tmux send-keys -t "$sess" Enter 2>/dev/null
  log "$a: ujraproba elkuldve ($(( count + 1 ))/$MAX_PER_HOUR ebben az oraban)"
done
exit 0
