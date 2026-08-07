---
name: marveen-service-setup
description: Amikor a user "automatizált Claude Code setupot / autostart / boot utan induljon / systemd service / indito scriptet" ker a marveen flottahoz. ELOSZOR nezd meg mi fut mar, ne duplikalj.
---
# Marveen autostart / service setup

## Mikor használd
A user teljes "inditems magatol", "boot/login utan induljon", "tmux + Claude Code + Telegram automatikusan", "systemd service", "indito script" kerest ad a marveen flottahoz.

## KRITIKUS elv
Ez a setup MAR LETEZIK es FUT minden marveen installon. A beszelgetes maga is abban zajlik. SOHA ne epits parhuzamosat -- dupla tmux session + ket Telegram getUpdates ugyanazon a boton = 409 Conflict loop, a csatorna nemul.

## Eljárás
1. Allapotfelmeres ELOSZOR:
   - `tmux ls` -> van-e `<MAIN_AGENT_ID>-channels` session
   - `systemctl --user is-enabled/is-active <MAIN_AGENT_ID>-channels.service <MAIN_AGENT_ID>-dashboard.service`
   - `loginctl show-user "$USER" | grep Linger` -> linger=yes kell a boot-autostarthoz
   - `ls ~/.config/systemd/user/` -> mar telepitett unitok
2. A meglevo komponensek:
   - Indito script: `scripts/channels.sh` (idempotens: kill-sessions sajat session elott, majd new-session)
   - Unit: `<MAIN_AGENT_ID>-channels.service` (WantedBy=default.target, Restart=on-failure, KillMode=process)
3. Ha mind fut+enabled+linger on -> KESZ. Ne csinalj uj service-t.
4. Additiv ertek kockazat nelkul: PATH-parancs a unitok FOLE: `~/.local/bin/claude-env`
   (start/stop/restart/status/attach/logs/enable/disable), ami csak `systemctl --user`-t wrappeli.
5. Emberi hibakezeles CSAK a wrapperben (claude-env doctor), SOHA a channels.sh magban:
   - lepesenkenti statusz (`==> ` / `[OK]`), hiba eseten megall (exit 1) emberi magyar blokkal
     (`[HIBA] cim / Mi a baj / Javaslat`).
   - ugyanaz journalba: `printf ... | systemd-cat -t claude-env -p <pri>` -> `journalctl -t claude-env`.
   - dashboard-osszefoglalo best-effort: hot memoria POST a /api/memories-re, `--max-time` + `|| true`.
   - 6 hibaosztaly: hianyzo binary/PATH, mar futo (no-op), tmux session, Telegram token/pairing
     (401=token, 409=dupla poller), permission (store irhato?), autostart/systemd (enabled+linger).

## Buktatók
- NE `set -a && source .env`: exportalna a TELEGRAM_BOT_TOKEN-t a tmux szerver globalis envjebe -> minden sub-agent ugyanazt a tokent hasznalna, 409 Conflict. A channels.sh grep-cut-tal olvas soronkent.
- KillMode=process KELL: a shared tmux szerver a unit cgroupjaban el, control-group kill mode az egesz flottat kiloni restart-kor.
- WSL2 HIANYZO LANCSZEM: a WSL distro NEM indul magatol a Windowssal. A linger csak akkor hoz fel barmit, ha a distro mar fut -- de Windows boot/login utan a distro alapból leall. Emiatt reboot utan "nem valaszol az agent" tunet, kezi `wsl` inditasig. Javitas: egy launcher a Windows Startup mappaba (`/mnt/c/Users/<winuser>/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/marveen-wsl-autostart.vbs`), tartalma egy VBScript ami window style 0-val (rejtett) futtatja `C:\Windows\System32\wsl.exe -d <distro> -u <user> --exec /bin/true`. Innen a systemd (`wsl.conf` [boot] systemd=true) + linger felhozza a szolgaltatasokat. Distro nevet `wsl.exe -l -v`-bol, a pontos Startup path-t `ls -d "/mnt/c/Users/"*/AppData/.../Startup` wildcarddal. FIGYELEM: a Startup login-kor fut, nem tiszta boot-idoben -- jelszavas Windows loginnál a bejelentkezes pillanataban all fel. Tiszta boot kell -> Windows Task Scheduler "At startup" trigger (schtasks.exe).
- systemctl --user start = no-op ha mar fut, ezert biztonsagos idempotens indito.

## Ellenőrzés
- `claude-env status` -> mindket unit enabled/active, es lathato a channels tmux session.
- Nincs uj/duplikalt tmux session ugyanarra az agentre.
