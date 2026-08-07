---
name: autonomous-diagnose-repair
description: Onallo hibakereso-es-javito uzemmod a gepen. Eloszor szabadon diagnosztizal es biztonsagosan javit, es CSAK kockazatos lepesnel (telepites, systemd/service, sudo, rendszerconfig, reboot) kal engedelyt, gazdag leirassal. Trigger: "valami nem megy / deritsd ki mi a baj / javitsd meg", service/csatorna/environment hiba.
---
# Onallo diagnosztizalo es javito asszisztens

## Mikor használd
Barmi elromlik a gepen vagy a flottaban: csatorna nemul, service elszall, valami "nem megy", "deritsd ki mi a baj", "javitsd meg". Ez a default uzemmod ilyenkor.

## Alapelv: felderit -> ert -> biztonsagosan javit -> csak a kockazatosnal all meg
A szinteket a `store/autonomy-config.json` szabja meg. KEZDD ezzel: olvasd ki az erintett kategoria szintjet.
```bash
jq -r '.categories[]|select(.key=="KULCS")|"\(.key) level=\(.level) max=\(.maxLevel) locked=\(.locked)"' store/autonomy-config.json
```
- level 3 -> autonom, csinald meg, utana naplozd/jelentsd.
- level 2 -> ENGEDELYKERES elotte (lasd sablon).
- level 1 -> csak jelezd, ne csinald.
- locked=true -> maxLevel=1, sose emeld.

## Eljárás
1. **Diagnosztika (SZABAD, `system_diagnostics` = level 3, csak olvasas).** Meritsd ki mielott barmit modositasz:
   - `claude-env doctor`, `claude-env status`
   - `systemctl --user status/is-active/is-enabled <unit>`, `journalctl --user -u <unit> -n 100`, `journalctl -t claude-env -n 50`
   - `tmux ls`, `ps aux | grep ...`, `ss -tlnp` / `curl -sS localhost:PORT`
   - logok: `tail -n 200 store/*.log store/*.error.log`; config: `.env` (KULCS-ok, NEM ertekek), unit fajlok, PATH
   - Fogalmazz meg egy konkret hipotezist az okrol, mielott javitasz.
2. **Biztonsagos javitas (`system_safe_fix` = level 3, engedely NELKUL).** Csak visszafordithato, sajat-hatokoru:
   - sajat user-service restart (`claude-env restart`, `systemctl --user restart <sajat unit>`)
   - beragadt/duplikalt sajat tmux session rendezese, retry, cache/lockfile amit te hoztal letre
   - sajat fajl jogosultsag javitasa a projektben (`chmod u+rwx store`)
   - Javitas utan ELLENORIZD (`doctor`/`is-active`), es naplozd.
3. **Kockazatos lepes -> ENGEDELYKERES (level 2), BATCH-elve.** Ha a javitashoz ez kell, ALLJ MEG es kerj engedelyt EGY korben az OSSZES szukseges kockazatos lepesre:
   - `package_install` (apt/pip/npm/snap) | `service_systemd_change` (unit szerkesztes, enable/disable, daemon-reload) | `privileged_sudo` (root/sudo) | `system_config_change` (rendszerfajl, PATH-profil, halozati config) | `system_reboot`
4. **Jovahagyas utan: VEGIG csinald.** A jovahagyott lepest teljesen hajtsd vegre, majd folytasd a javitast a kovetkezo kockazatos kapuig vagy a megoldasig. Ne allj meg feluton.
5. **Naplozz** minden fontos lepest (daily-log), es hiba eseten emberi, ertheto magyar uzenetet adj (mi tortent, mi az ok, mi a kovetkezo lepes).

## Engedelykeres sablon (Telegram reply Boss-nak, vagy /api/approvals)
Sose csak "permission needed". Mindig:
```
[ENGEDELYKERES]
Mit: <a konkret muvelet>
Miert: <milyen problemat old meg>
Hatas: <mi valtozik, visszafordithato-e, mit erint>
Pontosan mire kerek engedelyt: <a pontos parancs(ok)>
Kockazat: <alacsony/kozepes/magas>
```
Tobb kockazatos lepest egy uzenetben sorolj fel (batch), ne kerdezz kulon apronkent.

## Buktatók
- NE kerj engedelyt trivialis, olvasasi vagy sajat-hatokoru visszafordithato lepesre -- az level 3.
- NE nyulj a stabil maghoz (`scripts/channels.sh`) es ne inditsd kezzel a channels sessiont (409 Conflict).
- `data_delete`, `permission_change`, `payment`, `publish_content`, `external_message`: level 2, maxLevel 2 (jovahagyasos, sose autonom). Ezekre MINDIG kulon, explicit engedely kell a teljes sablonnal -- ne olvaszd bele egy nagy batch-be, es sose feltetelezd a jovahagyast.
- WSL: a "reboot" a WSL distro ujrainditasa; jelezd hogy ez az egesz kornyezetet lekapcsolja.
- Titkot (token, jelszo) SOSE irj ki logba/uzenetbe; `.env`-nel csak a kulcs neveket nezd.
- **100% CPU processz elott ellenorizd a PPID-t!** Egy busy-loopolo bun/node lehet ARVA, beragadt peldany egy regi sessionbol (PPID=1 vagy a systemd user manager, pl. 255), NEM az aktiv szolgaltatas. Ilyenkor a sima `kill <PID>` biztonsagos es NEM szakitja meg az elo csatornat -- nincs szukseg a teljes service restartra (ami viszont a sajat sessionodet is ujrainditana). Kulonitsd el: `ps -eo pid,ppid,pcpu,etime,args --sort=-pcpu | grep server.ts`. Az aktiv plugin PPID-je egy elo claude/tmux lanc; az arva-e egy regi etime + systemd szulo. Busy-loop gyakran ignoralja a SIGTERM-et -> `kill -9` kell.
- `sudo` gyakran JELSZOT ker (`sudo -n true` -> "password required"). Headless nem tudod megcsinalni es a jelszohoz NE nyulj. Add at Bossnak a pontos parancsot, hogy o futtassa (Telegramon a `! sudo ...` prefixszel a sajat sessionjeben, vagy terminalban).
- Ha az engedely elutasitva/timeout -> ne csinald, naplozd az okot, es adj alternativat ha van.

## Ellenőrzés
- Javitas utan a `claude-env doctor` / `systemctl --user is-active` zold.
- A kockazatos lepesek elott volt engedelykeres a teljes sablonnal, batch-elve.
- A fontos lepesek a daily-log-ban visszanezhetok.
