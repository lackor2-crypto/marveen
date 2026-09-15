---
name: telegram-proactive-message-no-inbound
description: Amikor Telegram-uzenetet kell kuldeni (pl. ebredes-koszones, proaktiv jelzes), de a session-ben NINCS inbound <channel source="telegram"> blokk, tehat nincs ismert chat_id a reply toolhoz. Trigger -- scheduled-task/heartbeat ebresztes utan az elso koszones, vagy barmilyen onindiitasu Telegram-uzenet, ahol nem valasz-e egy bejovo uzenetre.
scope: global
---
# Telegram proaktiv uzenet inbound chat_id nelkul

## Mikor hasznald
- Session-inditaskor a FELEBREDESKOR-koszones szabaly miatt kell irni, de nincs
  bejovo Telegram-uzenet ebben a fordulban (nincs `<channel source="telegram">`
  blokk), tehat nincs `chat_id` amit a `reply` MCP toolnak at lehetne adni.
- Barmilyen mas onindiitasu (nem valasz) Telegram-kuldes.

## Buktato -- a `chat_id: 0` NEM mukodik altalanosan
A fo-agens (Marvin/lackor2-bot) CLAUDE.md-je azt irja, hogy proaktiv
reggeli uzenetnel `chat_id: 0`-t hasznal. Ez A FO AGENS sajat bot-jara
lehet igaz, de MAS agens (pl. lackor3/@segedmunkas_bot) sajat Telegram
plugin-peldanyanal a `reply` tool `chat 0 is not allowlisted -- add via
/telegram:access` hibaval utasitja el. NE talalgasd ala hogy "biztos ugyanaz
mint Marvinnal" -- teszteld/ellenorizd sajat magad forrasabol.

## Eljaras
1. Hatarozd meg az allapot-konyvtarat:
   `echo "${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}"`
   (tipikusan az agent sajat munkakonyvtaraban: `<agent-dir>/.claude/channels/telegram`)
2. Olvasd (CSAK olvasd, ne modositsd) az `access.json`-t ebben a mappaban.
3. Az `allowFrom` tomb elso/egyetlen bejegyzese a tulajdonos Telegram sender-id-je.
   Magan (DM) chat eseten a Telegram chat_id EGYENLO a user_id-vel, tehat ez
   kozvetlenul hasznalhato `chat_id`-kent a `reply` hivasban.
4. Ha `allowFrom` ures vagy tobb bejegyzes van (nem egyertelmu melyik a
   tulajdonos): NE talalgass, kerdezz vissza vagy varj bejovo uzenetre.

## Ellenorzes
- A `reply` hivas `sent (id: N)`-nel ter vissza sikernel; `chat X is not
  allowlisted` hibaval, ha rossz/talalt id-t hasznalsz.
