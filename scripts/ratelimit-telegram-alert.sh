#!/bin/bash
# ELOZETES TELEGRAM VESZJELZES a hasznalati keret kifogyasa elott.
#
# MIERT KELL (Boss, 2026-08-09 este): a dashboard/statusline mar mutatja a
# keret %-at, es a rate-limit-guard.py hook mar szol MAGANAK az agensnek ha
# 90/95%-nal jar (hogy fogja vissza magat) -- de Boss-nak, aki Telegramon
# kovet mindent, EDDIG semmi nem ment errol. Ha a keret menetkozben fogy el,
# a fo session lefagy/ujraindul (lasd cred-switch-watchdog.sh), es Boss
# csak a csendbol vette eszre -- ma este pl. 20:34 es 23:37 kozt.
#
# Boss kifejezett kerese: "99%-nal mar el kene kuldeni... addig, mig el tudod
# kuldeni, addig kuld el". Ezert ez a szkript FUGGETLENUL fut (systemd timer,
# 60mp-enkent), NEM a fo session belsejebol -- igy akkor is szol, ha a fo
# agens epp haldoklik/nem kap tobb fordulot.
#
# Adatforras: store/rate-limit-status/<agent>.json, amit a statusline.py hook
# mar amugy is karban tart minden CLI-renderkor -- nulla plusz tokenkoltseg,
# tisztan helyi fajlolvasas (Boss 2026-08-08: elutasitotta a gyakoribb
# heartbeatet a tokenkoltseg miatt -- ez nem az, ez nem hiv modellt).
#
# Csak a FO agenst (MAIN_AGENT_ID) figyeli, nem a szabad flottat -- Bossnak
# a sajat kerete szamit, nem a Nemotronoke.
#
# store/-ban el (gitignore), egy kovetett-kod frissites nem torli.
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/ratelimit-alert.log"
STATE="$STORE/.ratelimit-alert-state.json"
NOTIFY="$INSTALL_DIR/scripts/notify.sh"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
env_val(){ grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' "; }

MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
SNAPSHOT="$STORE/rate-limit-status/${MAIN_AGENT_ID}.json"
[ -s "$SNAPSHOT" ] || exit 0

# A dontes + Telegram-kuldes + state-frissites egyben, Pythonban -- a bash
# oldal csak a fajlutvonalakat adja at. STALE_AFTER_MS ugyanaz mint amit
# src/rate-limit-status.ts hasznal (30 perc): egy regi, allo pillanatkepre
# ne riasszunk (az agens lehet csak tetlen/leallt, nem kifutoban van).
python3 - "$SNAPSHOT" "$STATE" "$LOG" "$NOTIFY" <<'PY'
import json, os, subprocess, sys, time

snapshot_path, state_path, log_path, notify_path = sys.argv[1:5]
STALE_AFTER_MS = 30 * 60_000
# Sorrend szandekos: elobb a sulyosabbat probaljuk, hogy egy 99%-os
# atugrast (pl. egy nagy tool-hivas kozben 88% -> 99%) ne csak "90%"-kent
# jelentsunk -- igy legalabb a legsulyosabb szintet biztosan megkapja Boss.
THRESHOLDS = [
    (99, 'urgent', "\U0001F6A8 VESZJELZES"),
    (90, 'caution', "⚠️ Figyelmeztetes"),
]

def log(msg):
    with open(log_path, 'a') as f:
        f.write(time.strftime('%Y-%m-%d %H:%M:%S') + ' ' + msg + '\n')

try:
    snap = json.load(open(snapshot_path))
except Exception as e:
    log(f"snapshot olvasasi hiba: {e}")
    sys.exit(0)

now_ms = time.time() * 1000
if now_ms - snap.get('updatedAt', 0) >= STALE_AFTER_MS:
    log("snapshot regi (>30 perc) -- kihagyva")
    sys.exit(0)

try:
    state = json.load(open(state_path))
except Exception:
    state = {}

WINDOW_LABELS = {'fiveHour': '5 orás', 'sevenDay': 'heti'}
changed = False

for window_key, label in WINDOW_LABELS.items():
    window = snap.get(window_key)
    if not window or window.get('usedPct') is None:
        continue
    pct = window['usedPct']
    resets_at = window.get('resetsAt')
    # A state kulcsa a resetsAt -- amint az ablak tenylegesen forog (uj
    # resetsAt), a regi ertesitesek automatikusan ervenyuket vesztik, ujra
    # riaszthatunk a kovetkezo ciklusban is.
    key = f"{window_key}:{resets_at}"
    already = state.get(key, 0)

    for threshold, level, prefix in THRESHOLDS:
        if pct < threshold:
            continue
        if already >= threshold:
            break  # mar kuldtunk erre (vagy sulyosabbra) a jelen ablakhoz
        reset_txt = ""
        if resets_at:
            reset_txt = " Ujraindul kb.: " + time.strftime(
                '%H:%M', time.localtime(resets_at / 1000)
            )
        text = (
            f"{prefix}: a {label} keretem {pct}%-on all.{reset_txt} "
            f"Ha ez tovabb fogy, a session automatikusan ujraindul/varakozik -- "
            f"nem kell semmit tenned, csak jelzem elore, hogy tudd miert csendesedem el."
        )
        try:
            subprocess.run([notify_path, text], check=False,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            log(f"kuldve ({window_key} {pct}% >= {threshold}%): {text[:80]}")
        except Exception as e:
            log(f"notify.sh hiba ({window_key}): {e}")
        state[key] = threshold
        changed = True
        break

if changed:
    tmp = state_path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, state_path)
PY
