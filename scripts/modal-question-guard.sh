#!/bin/bash
# PANEL-MENU OR: feloldja, ha a fo agens sajat valasztos kerdese blokkolja.
#
# VALOS INCIDENS (2026-08-08 23:53): A fo agens feltett egy valasztos kerdest a
# paneljeben ("Melyik modszert csinaljam? 1. Gyors / 2. Pontos ... Enter to
# select - Esc to cancel"). Ez MODALIS allapot: amig nyilakkal + Enterrel nem
# valasztanak egy sort, semmi mast nem dolgoz fel. A Boss kozben Telegramon
# kuldott negy hangzenetet, egy dokumentumot, egy fotot es a "te most
# dolgozol?" kerdest -- mind megerkezett, mind sorba allt a menu mogott.
#
# A LENYEG, amit a Boss megfogalmazott: "az a kerdeses panel nem jelent meg
# nalam a telegramon". A kerdes CSAK a panelben letezett. O nem valaszolni nem
# akart -- meg sem latta, mit kerdeztek tole. Kivulrol ez lefagyasnak latszik.
#
# Ezert ez az orszem nem egyszeruen Esc-et nyom (az eldobna a kerdest, es a
# Boss tovabbra sem tudna, mit akartak tole), hanem:
#   1. KIMENTI a kerdes szoveget es elkuldi TELEGRAMRA -- igy a Boss latja,
#   2. utana oldja fel a menut (Esc),
#   3. es megmondja a fo agensnek, hogy a valaszt Telegramon varja, ne panel-menuben.
#
# Turelmi ido: csak akkor lep kozbe, ha ugyanaz a menu MAR MASODSZOR is ott van
# (kb. 2-4 perc), hogy egy epp keletkezo/eltuno menut ne kapkodjon el.
#
# Korabban csak a referencia-gep store/-jaban elt, fix /home/... uttal -- egy
# friss telepitesen ez az orszem egyaltalan nem letezett (audit #358). Most a
# repoban van, az install-guard-units.sh koti be (Linux systemd + macOS launchd).
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/modal-guard.log"
STATE="$STORE/.modal-guard-seen"
NOTIFY="$INSTALL_DIR/scripts/notify.sh"
# shellcheck source=lib/owner-lang.sh
. "$INSTALL_DIR/scripts/lib/owner-lang.sh"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
env_val(){ grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' "; }
MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"
# A megszolitas a telepites sajat agens-neve, nem egy beegetett nev.
BOT_NAME="$(env_val BOT_NAME)"; BOT_NAME="${BOT_NAME:-$MAIN_AGENT_ID}"

tmux has-session -t "$SESSION" 2>/dev/null || exit 0

# -a MINDENHOL: a panel vezerlokaraktereket tartalmaz, es grep enelkul
# "binary file matches"-t ir es ELNYELI a talalatot (ez a hiba nemitotta el
# honapokig a limit-figyelot is).
PANE="$(tmux capture-pane -p -t "$SESSION" 2>/dev/null)"
[ -n "$PANE" ] || exit 0

# A modalis menu labléce. Mindketto kell, hogy egy chatben emlitett "Esc" ne
# valtsa ki.
printf '%s' "$PANE" | grep -aq "Enter to select" || { rm -f "$STATE" 2>/dev/null; exit 0; }
printf '%s' "$PANE" | grep -aq "Esc to cancel"   || { rm -f "$STATE" 2>/dev/null; exit 0; }

# A kerdes szovege: az "Enter to select" sor FOLOTTI resz, felfele addig, amig
# ures sort vagy a TUI keretet nem talaljuk (max 25 sor).
QUESTION="$(printf '%s\n' "$PANE" | python3 -c '
import sys, re
lines = sys.stdin.read().split("\n")
end = next((i for i,l in enumerate(lines) if "Enter to select" in l), None)
if end is None:
    sys.exit(0)
out = []
for l in reversed(lines[max(0,end-25):end]):
    s = l.rstrip()
    if re.match(r"^[\s─━-]*$", s):        # ures vagy csak keret
        if out: break
        continue
    if "──" in s:                          # TUI keret-sor
        if out: break
        continue
    out.append(s.strip())
print("\n".join(reversed(out))[:900])
' 2>/dev/null)"
[ -n "$QUESTION" ] || QUESTION="(a kerdes szoveget nem sikerult kiolvasni)"

FP="$(printf '%s' "$QUESTION" | cksum | awk '{print $1"-"$2}')"
PREV="$(cat "$STATE" 2>/dev/null | awk '{print $1}')"

if [ "$FP" != "$PREV" ]; then
  echo "$FP $(date +%s)" > "$STATE"
  log "menu eszlelve, turelmi ido inditva: $(printf '%s' "$QUESTION" | head -1 | cut -c1-70)"
  exit 0
fi

# Masodik eszleles ugyanarrol -> kozbelepunk.
log "a menu meg mindig fent van -> tovabbitom Telegramra es feloldom"

if [ -x "$NOTIFY" ]; then
  bash "$NOTIFY" "$(ol "❓ $BOT_NAME egy VALASZTOS KERDESEN allt meg a paneljeben, ami Telegramra nem ment ki -- ezert nem valaszolt semmire. A kerdes:

$QUESTION

A menut feloldottam, $BOT_NAME dolgozik tovabb. Ha donteni akarsz, valaszolj ide egy mondatban (pl. \"az elso\" / \"a pontosat\")." \
"❓ $BOT_NAME stopped on a MULTIPLE-CHOICE QUESTION in its panel, which did not go out to Telegram -- so it answered nothing. The question:

$QUESTION

I closed the menu, $BOT_NAME keeps working. If you want to decide, answer here in one sentence (e.g. \"the first one\" / \"the precise one\").")" >/dev/null 2>&1 \
    && log "kerdes elkuldve Telegramra" || log "a Telegram-ertesites nem ment el"
fi

tmux send-keys -t "$SESSION" Escape 2>/dev/null
sleep 3

# Megmondjuk a fo agensnek, mi tortent es mit csinaljon maskepp.
MSG="$(ol "A panelben feltett valasztos kerdesedet feloldottam, mert az BLOKKOLTA az egesz munkamenetet: a tulajdonos Telegramon van, oda a menu NEM megy ki, tehat o nem is latta a kerdest -- csak azt latta, hogy nem valaszolsz. A kerdest tovabbitottam neki Telegramon. Mostantol ha dontes kell tole, KERDEZD MEG A CSATORNADON (reply tool) szamozott lehetosegekkel, es addig folytasd azt, ami e nelkul is haladhat. Panel-menut ne nyiss." \
  "I closed the multiple-choice question you asked in the panel, because it BLOCKED the whole session: the owner is on Telegram, the menu does NOT go out there, so they never saw the question -- they only saw that you do not answer. I forwarded the question to them on Telegram. From now on, when you need a decision from them, ASK ON YOUR CHANNEL (reply tool) with numbered options, and meanwhile continue whatever can progress without it. Do not open a panel menu.")"
tmux send-keys -t "$SESSION" -l "$MSG" 2>/dev/null
sleep 1
tmux send-keys -t "$SESSION" Enter 2>/dev/null
rm -f "$STATE" 2>/dev/null
log "feloldva, a fo agens ertesitve"
exit 0
