---
name: telegram-inbox-stuck-triage
description: Amikor egy [TELEGRAM-INBOX-STUCK] rendszer-figyelmeztetés érkezik (inter-agent üzenet from_agent "system", vagy <untrusted source="agent:system"> csomagolásban) egy másik ágens Telegram-üzenetének kézbesítési elakadásáról. Trigger -- "idle probe reports the session as busy", "X másodperce vár kézbesítésre".
---

# Telegram-inbox-stuck triázs

## Mikor használd
A háttér-watchdog jelez, hogy egy ágenshez (pl. egy kollega-ugynokhoz) érkezett Telegram
üzenet N másodperce nem jut be a munkamenetébe, mert az idle probe "busy"-nak
látja a sessiont. Ez lehet valódi fagyás VAGY hamis riasztás (a session tényleg
aktívan dolgozik, csak épp nem idle).

## Eljárás
1. **Csak olvasva nézd meg az érintett ágens tmux paneljét** (SOHA ne írj bele
   parancsot vagy Enter-t -- lásd CLAUDE.md "idegen ágens vezérlése" szabály):
   ```bash
   tmux capture-pane -t agent-<nev> -p -S -60 2>&1 | tail -80
   ```
   Nézd meg: `Baking…`/`Crunched for…`/aktív kimenet = ÉLŐ, dolgozik.
   Üres prompt régi időbélyeggel, vagy hibaüzenet/crash a képernyőn = valóban
   elakadt.
2. Ismételd meg pár másodperc után (`date` + újra capture-pane), hogy lásd
   nő-e az időzítő ("Baking… Xm Ys") -- ha nő, a session ÉL, csak épp nem
   ideiglenesen szabad.
3. Nézd meg, a sorban álló Telegram-üzenet közben bekerült-e már a
   kontextusba (pl. `[telegram-wake]` sor a pane historyban, majd az ágens
   érdemi választ adott rá) -- ha igen, a probléma magától megoldódott, mire
   te odaértél.
4. Ha ÉL és a drain már behúzta/megválaszolta -> nincs teendő, ne zavard
   {{OWNER_NAME}}-t. Zárd le a rendszerüzenetet:
   ```bash
   curl -s -X PUT "http://localhost:{{WEB_PORT}}/api/messages/<id>" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{"status":"done","result":"Ellenorizve: busy!=stuck, ... (rovid indoklas)"}'
   ```
5. Ha TÉNYLEG fagyott (nincs kimeneti aktivitás percek óta, régi időbélyeg) ->
   akkor szólj {{OWNER_NAME}}-nak Telegramon tömören, MELYIK ágens, mióta, és mit
   javasolsz (pl. újraindítás -- de azt NE te indítsd el egy másik ágens
   munkamenetében, kérdezd meg {{OWNER_NAME}}-t).

## Buktatók
- Az idle probe "busy" jelzése ÖNMAGÁBAN nem bizonyítja az elakadást --
  gyakran csak azt jelenti, hogy az ágens épp aktívan számol (pl. hosszú
  vizsgálat, "Baking… 10m+"). A valódi teszt a pane-en látott mozgás/időzítő
  növekedése, nem a probe egyetlen mérése.
- Ne írj be semmit a másik ágens tmux paneljébe, még "csak megnézem"
  szándékkal se -- a `capture-pane -p` olvasásra elég, nincs szükség
  `send-keys`-re.
- Az `id` amit lezársz, az az inter-agent rendszerüzenet azonosítója
  (`/api/messages`), NEM a Telegram üzenet maga -- azt nem tudod innen
  lezárni, csak a saját magad felé küldött figyelmeztetést.

## Ellenőrzés
- `curl ... /api/messages?agent=<sajat_neved>&status=pending` már nem
  tartalmazza a lezárt üzenet id-ját.
