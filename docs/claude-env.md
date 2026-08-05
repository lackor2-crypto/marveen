# Claude Code környezet indítása és kezelése (Ubuntu / WSL)

A lackor2_bot Claude Code környezete systemd **user** service-ként fut, és
bejelentkezés / boot után automatikusan elindul (`loginctl enable-linger`
miatt login nélkül is). Nem kell kézzel indítgatni.

## Komponensek

| Mi | Hol |
|----|-----|
| Indító script | `scripts/channels.sh` (a repón belül, nem az asztalon) |
| systemd service (Claude + Telegram) | `lackor2-bot-channels.service` |
| systemd service (web dashboard) | `lackor2-bot-dashboard.service` |
| tmux session | `lackor2-bot-channels` |
| Kényelmi parancs (PATH-ból) | `~/.local/bin/claude-env` |
| Channels log | `store/channels.log`, `store/channels.error.log` |

A unit fájlok itt élnek: `~/.config/systemd/user/`.

## `claude-env` parancsok

Bárhonnan futtatható (PATH-ban van a `~/.local/bin`):

```
claude-env status     # enabled/active állapot + tmux sessionök (alapértelmezett)
claude-env doctor     # teljes diagnosztika: 6 hibaosztály, emberi üzenettel + javaslattal
claude-env start      # indítás előfeltétel-ellenőrzéssel (no-op ha már fut)
claude-env stop       # leállítás
claude-env restart    # újraindítás + állapot-ellenőrzés
claude-env attach     # rácsatlakozás a Claude tmux sessionre
claude-env logs [N]   # élő log követése (utolsó N sor, default 40)
claude-env enable     # autostart bekapcsolása boot/login-ra + linger
claude-env disable    # autostart kikapcsolása
```

## Emberi hibakezelés (doctor + start)

A `claude-env start` és `claude-env doctor` minden fő lépés előtt/után
státuszüzenetet ír (`==> ...`, `[OK] ...`), és hiba esetén **azonnal megáll**
egy emberi, magyar nyelvű hibablokkal:

```
[HIBA] <cím>
   Mi a baj: <konkrét ok>
   Javaslat: <mit kell javítani>
```

Ugyanez az üzenet bekerül a **systemd journalba** is (`journalctl -t claude-env`),
és ha a dashboard fut, egy rövid összefoglaló `hot` memóriaként megjelenik ott is.

Külön, érthető hibák ezekre:

| Hibaosztály | Mit néz | Példa javaslat |
|-------------|---------|----------------|
| Hiányzó binary / PATH | `claude`, `tmux`, `node`, `systemctl` a PATH-ban | tedd a `~/.local/bin`-t a PATH-ba |
| Már fut a service/session | systemd active + tmux session | no-op, nem indít duplán |
| tmux session hiba | szerver él-e, session létezik-e | `claude-env restart` |
| Telegram token / pairing | `.env` token, `access.json`, 401/409 a logban | új token a BotFather-től / `/telegram:access` |
| Permission hiba | `store/` írható-e, token olvasható-e | `chmod u+rwx store` |
| Autostart / systemd | unit telepítve, `enabled`, linger | `claude-env enable`, `loginctl enable-linger` |

Ellenőrzés, hogy a hibák tényleg megjelennek:

```
claude-env doctor                      # terminál: minden lépés + esetleges [HIBA] blokk
journalctl -t claude-env -n 50         # ugyanaz a systemd naplóban visszanézve
# Szimulált hiba (nem tesz kárt, csak a hibaüzenetet mutatja):
PATH=/nonexistent bash ~/.local/bin/claude-env doctor
```

### Attach / detach

```
claude-env attach
```

Kilépés a sessionből a Claude leállítása **nélkül**: `Ctrl-b` majd `d` (detach).
Kézzel, `claude-env` nélkül ugyanez: `tmux attach -t lackor2-bot-channels`.

### Újraindítás

```
claude-env restart
```

Vagy közvetlenül: `systemctl --user restart lackor2-bot-channels.service`.

### Log nézése

```
claude-env logs        # store/channels.log élőben
claude-env logs 200    # utolsó 200 sortól
```

systemd journal: `journalctl --user -u lackor2-bot-channels.service -f`.

## Ha a Telegram kapcsolat megáll

Tünet: nem érkeznek üzenetek, vagy a Claude nem válaszol Telegramon.

1. **Állapot ellenőrzése:**
   ```
   claude-env status
   ```
   Ha a `lackor2-bot-channels.service` nem `active`, indítsd: `claude-env start`.

2. **Nézd meg mit ír a session:** `claude-env attach` (majd detach `Ctrl-b d`).
   A "MCP" plugin sorban a `plugin:telegram:telegram` legyen `connected`, ne
   `failed` / `disconnected`.

3. **Újraindítás** (ez oldja meg az esetek nagy részét):
   ```
   claude-env restart
   ```

4. **Log a hibáról:**
   ```
   claude-env logs 200
   tail -n 100 store/channels.error.log
   ```

5. **409 Conflict a logban** = két folyamat pollozza ugyanazt a botot. Csak
   EGY channels sessionnek szabad futnia. Ellenőrizd nincs-e duplikált tmux
   session ugyanarra az agentre (`tmux ls`), és ne indíts kézzel másikat -- a
   systemd service már futtatja.

## Fontos

- **Ne** indíts külön/duplikált tmux sessiont a channelshez: két Telegram
  poller ugyanazon a boton 409 Conflict loopot okoz, a csatorna némul.
- A `claude-env start` és a `systemctl --user start` idempotens: ha már fut,
  nem csinál semmit.
- Reboot / login után magától feláll, kézi beavatkozás nélkül.
