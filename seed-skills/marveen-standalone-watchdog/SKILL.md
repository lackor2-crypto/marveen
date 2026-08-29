---
name: marveen-standalone-watchdog
description: Amikor {{OWNER_NAME}}-nak olyan figyelő/riasztó kell ami AKKOR IS működjön ha a fő agent session épp nem fut/haldoklik/menübe akadt -- pl. "szólj Telegramon ha X" úgy hogy ne a session sajat fordulojaban dőljön el. Trigger -- proaktív Telegram-riasztás, önálló systemd-timer watchdog, "akkor is szóljon ha lefagyok".
---
# Önálló (session-független) watchdog Telegram-riasztáshoz

## Mikor használd
{{OWNER_NAME}} olyan figyelést kér, aminek AKKOR IS működnie kell, ha a fő agent (Marvin) session
épp nem kap fordulót -- kifogyott a keret, menübe akadt, épp újraindul. Ha a megoldás a
saját válaszodból küldene Telegramot, az NEM ér semmit, mert pont akkor nem fut le,
amikor a legjobban kellene (pl. "szólj mielőtt kifogy a kereted" -- ha a session már
kifogyott, nem tud szólni).

Ne keverd össze a `marveen-service-setup` skillel: az a CHANNELS+DASHBOARD alap-bootstrap
(a fő tmux session maga). Ez itt egy KIEGÉSZÍTŐ, kis, önálló systemd timer, ami a session
mellett/nélkül fut.

## Meglévő minták (ne duplikáld, nézd meg előbb ezeket)
A flottában már több ilyen önálló őrszem fut, mind ugyanazt a vázat követi:
- `store/cred-switch-watchdog.sh` -- limit-reset / fiókváltás után újraindítja a sessiont
- `store/marveen-modal-guard.sh` -- kimenti Telegramra a panelben ragadt választós menüt
- `store/ratelimit-telegram-alert.sh` -- 90%/99%-nál Telegram-riasztás a keretről
- `~/.claude/hooks/telegram_progress_watchdog.py` -- elakadt "dolgozom" placeholder felismerése

## Eljárás
1. **Adatforrás, NE modellhívás.** A watchdog helyi fájlt olvasson (pl.
   `store/rate-limit-status/<agent>.json`, amit a statusline.py hook amúgy is karbantart),
   VAGY `tmux capture-pane`-t. SOHA ne induljon LLM-hívás a watchdogból magából -- ez a
   [[heartbeat-frequency-cost-tradeoff]] szabály: {{OWNER_NAME}} elutasította a token-fogyasztó
   gyakori pollingot, de a helyi fájlolvasás/curl nem az.
2. **Telegram küldés:** ne írj újra Bot API hívást, hívd meg `scripts/notify.sh "szöveg"`-et
   (bash) -- ez már kezeli a tokent, chat_id-t, sender-attribúciót és a teszt-jelölést.
3. **Dedup, ne spammelj.** Tarts egy állapotfájlt (`store/.<nev>-state.json`), és csak
   akkor küldj újra, ha a kulcs (pl. az ablak `resetsAt`-ja) megváltozott -- így egy
   forgó ablaknál (új limit-ciklus) magától nullázódik az emlékezet, de ugyanabban a
   ciklusban nem szól minden percben.
4. **store/-ban él, gitignore-olt.** SOHA ne tedd `src/`-be vagy `scripts/`-be, ha ez
   {{OWNER_NAME}}-specifikus/kísérleti automatizálás -- a `store/` könyvtár nem követett, egy
   upstream-merge nem törli és nem ütközik vele ([[marveen-fork-conflict-minimization]]).
5. **systemd user timer**, mintázat:
   ```
   ~/.config/systemd/user/{{MAIN_AGENT_ID}}-<nev>.service  (Type=oneshot, ExecStart=/bin/bash store/<nev>.sh)
   ~/.config/systemd/user/{{MAIN_AGENT_ID}}-<nev>.timer    (OnBootSec=90, OnUnitActiveSec=60, AccuracySec=15)
   ```
   `systemctl --user daemon-reload && systemctl --user enable --now {{MAIN_AGENT_ID}}-<nev>.timer`
6. **Tesztelés élesítés előtt:** izoláld a python/logika-magot (pl. `exec()` a bash
   heredoc python blokkján kívül egy tesztfájlból), szimulálj kritikus %-ot/állapotot,
   ellenőrizd: (a) küld-e amikor kellene, (b) NEM küld-e duplán újrafutáskor, (c) csendben
   marad-e stale/normál adaton. Csak utána `systemctl --user enable --now`.

## Buktatók
- Ne feledd frissíteni `store/marveen-start.sh` idozítő-listáját is, ha azt akarod hogy
  az indító gomb is felügyelje (lásd a `modal-guard` bekötését mintaként).
- 30 perces staleness-küszöb ajánlott a pillanatkép-alapú watchdogoknál (ha az agent
  régóta nem futott, a fájl állott -- ne riassz rá, mint élő állapotra).

## Ellenőrzés
- `systemctl --user status {{MAIN_AGENT_ID}}-<nev>.timer` aktív.
- Egy kézi `systemctl --user start {{MAIN_AGENT_ID}}-<nev>.service` futás után a log
  (`store/<nev>.log`) tartalmazza amit vártál, és `git status store/` NEM mutat semmit
  (gitignore-olt marad).
