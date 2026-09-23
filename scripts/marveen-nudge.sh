#!/bin/bash
# "Ebreszto" a fo agens (Marvin) sessionjenek egy ujraindulas UTAN.
#
# MIERT KELL (2026-08-08, meressel):
# Amikor a hasznalati korlat lejar, a cred-switch-watchdog (C) szekcioja
# ujrainditja a channels service-t. Ettol Marvin ismet MUKODOKEPES -- de nem
# csinal semmit, mert egy friss Claude Code session addig ul a prompton, amig
# input nem erkezik. Ezert ebresztette fel eddig CSAK egy uj Telegram-uzenet.
#
# A tudas viszont mar ott van nala: a ledger-replay.py SessionStart hook minden
# indulaskor beinjektalja a legutobbi beszelgetest ES a "NYITOTT KERDEST" (a
# legutolso valasz nelkuli Boss-uzenetet). Ellenorizve: 6595 karakternyi
# kontextust ad vissza, benne a kotelezo direktivaval.
#
# Tehat NEM kell ujra atadni az uzeneteket -- csak KIVALTANI egy fordulot.
# Ez a szkript pontosan ennyit tesz: megvarja, amig a session hasznalhato,
# majd bekuld egy rovid utasitast.
#
# Miert kulon szkript es miert systemd-run inditja: a cred-switch service
# Type=oneshot + KillMode=control-group, tehat amint a watchdog fofolyamata
# kilep, systemd megolne minden hatterben hagyott gyereket. A systemd-run
# sajat, fuggetlen tranziens unitban inditja ezt, igy tuleli.
#
# store/-ban el (gitignore), egy kovetett-kod frissites nem torli.
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/cred-switch-watchdog.log"
REASON="${1:-ismeretlen}"

log(){ echo "$(date '+%F %T') nudge: $*" >> "$LOG"; }
env_val(){ grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' "; }

MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

# A friss session inditasa nem azonnali: a channels.sh vegigviszi az onboardingot,
# a /name-et es a /mcp feloldast. Amig ezek mennek, egy bekuldott szoveg elveszne
# vagy epp egy menut valasztana ki -- ezert a keszenletre VARUNK, nem idozitunk.
# Keszenlet jele a TUI labléce, ami csak akkor latszik, ha a prompt hasznalhato.
READY_MARK="bypass permissions on"

# KOTELEZO ALSO VARAKOZAS -- 2026-08-09, valos incidens utan.
# A "bypass permissions on" lablec ONMAGABAN NEM jelenti, hogy szabad beszolni:
# a channels.sh az indulas utan meg VEGIGVISZI a sajat post-init szekvenciajat,
# ami `sleep 15` utan ESCAPE-et kuld, majd /mcp-t nyit, navigal es megint
# Escape-el (channels.sh 675-710. sor). Ha az ebreszto ez ELE erkezik, Marvin
# nekiall dolgozni, es a post-init Escape-je FELBESZAKITJA.
# Pontosan ez tortent: 23:37:44 restart -> 23:37:53 ebreszto -> "Ran 2 shell
# commands" -> "Interrupted". A post-init legrosszabb esete kb. 31 mp
# (15+1+3+1+2+4 plusz az onboarding lepesek), ezert varunk 45-ot.
MIN_WAIT=45
sleep "$MIN_WAIT"

DEADLINE=$(( $(date +%s) + 240 ))
ready=0
prev=""
stable=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 5
  pane="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -n 8)"
  [ -z "$pane" ] && continue
  # Ne kuldjunk be semmit, amig egy elso-inditasi kepernyo van fent.
  if printf '%s' "$pane" | grep -aqiE "select login method|use the url below to sign in"; then stable=0; prev=""; continue; fi
  # Ne szoljunk bele egy epp nyitott menube sem (az sajat modalis allapot).
  if printf '%s' "$pane" | grep -aq "Enter to select"; then stable=0; prev=""; continue; fi
  if ! printf '%s' "$pane" | grep -aq "$READY_MARK"; then stable=0; prev=""; continue; fi
  # STABILITAS: a post-init alatt a panel valtozik (menu nyilik/zarul). Csak
  # akkor szolunk be, ha ket egymas utani mintavetel UGYANAZ -- vagyis mar
  # tenyleg nem tortenik semmi.
  if [ "$pane" = "$prev" ]; then
    stable=$(( stable + 1 ))
    if [ "$stable" -ge 1 ]; then ready=1; break; fi
  else
    stable=0
  fi
  prev="$pane"
done

if [ "$ready" != "1" ]; then
  log "a session nem lett kesz 240 mp alatt -- nem kuldok be semmit ($REASON)"
  exit 0
fi

# Ha a korlat MEG mindig el (pl. rosszul olvastuk az idot), ne kezdjunk fordulot:
# az csak ujabb limit-hibat gyartana.
pane_full="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -n 25)"
if printf '%s' "$pane_full" | grep -aqiE "hit your (session|usage) limit|usage limit reached"; then
  log "a panelen MEG mindig limit-uzenet all -- nem ebresztek ($REASON)"
  exit 0
fi

# HA MAR DOLGOZIK, NE EBRESSZUK. Ez pontosan az a cel, amiert az ebreszto letezik:
# ha barmi mas (egy beerkezo Telegram-uzenet, egy utemezett feladat) mar elinditott
# egy fordulot, akkor Marvin MAR folytatja a munkat -- ilyenkor a mi uzenetunk csak
# sorba allna es feleslegesen megszakitana a gondolatmenetet.
# A Claude Code TUI a labléceben csak MUNKA KOZBEN irja ki az "esc to interrupt"-ot.
if printf '%s' "$pane_full" | grep -aq "esc to interrupt"; then
  log "mar dolgozik -- nincs szukseg ebresztore ($REASON)"
  exit 0
fi

sleep 3
# Szandekosan ROVID: a tenyleges tennivalot a ledger-replay altal beinjektalt
# kontextus (kotelezo direktiva + NYITOTT KERDES) hordozza. Ez csak a kivalto.
MSG="Ujraindultal, es ismet tudsz dolgozni (${REASON}). A session-inditasi kontextusodban ott a legutobbi beszelgetes es a NYITOTT KERDES. Nezd at, valaszolj a tulajdonos megvalaszolatlan uzenetere, es folytasd a felbehagyott munkat. Ha tenyleg nincs semmi teendo, ne irj Telegramra."

tmux send-keys -t "$SESSION" -l "$MSG" 2>/dev/null || { log "send-keys FAILED ($REASON)"; exit 1; }
sleep 1
tmux send-keys -t "$SESSION" Enter 2>/dev/null || { log "Enter FAILED ($REASON)"; exit 1; }
log "ebreszto elkuldve ($REASON)"
exit 0
