---
name: voice-message-never-lost
description: Egy Telegram hangüzenet nem kapott automatikus "[Hang átirat]:" injektálást (mid-turn érkezett, nem indított új promptot). Ne mondd hogy "nem tudom átírni" -- hívd meg közvetlenül a /api/voice/directive végpontot.
---

# Hangüzenet sosem vész el

## Mikor használd

Amikor egy `<channel source="plugin:telegram:telegram" ... attachment_kind="voice"
attachment_file_id="...">` blokk érkezik, és utána NEM jön egy
`UserPromptSubmit hook success: [Hang átirat]: ...` system-reminder.

Ez azért történik, mert a `scripts/hooks/voice-reply-directive.py` hook
CSAK akkor fut le, ha a hangüzenet egy VALÓDI új promptot indít (UserPromptSubmit
esemény). Ha a hangüzenet middig érkezik -- amíg épp más feladaton dolgozol,
és csak beékelődik a kontextusba -- a hook ki sem hívódik rá, a transzkripció
elmarad, és a nyers `.oga` fájl Read-del NEM olvasható értelmesen (bináris audio).

**NE mondd a felhasználónak hogy "nincs bekötve átiratkészítés" vagy "nem tudom
elolvasni" -- ez tévedés, csak a hook nem futott le automatikusan rá.**

## Eljárás

1. A `<channel>` tag-ből szedd ki: `attachment_file_id`, `chat_id`.
2. Az agent saját nevét (a te working directory-d alapján, vagy CLAUDE.md-ből).
3. Hívd meg UGYANAZT a végpontot amit a hook is hív:
   ```bash
   curl -s "http://localhost:3420/api/voice/directive?agent=<AGENT_ID>&chat=<CHAT_ID>&file=<FILE_ID>&kind=voice" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     --max-time 60
   ```
   Válasz: `{"directive":null,"transcript":"<szöveg>"}`. A `transcript` mező a
   Groq Whisper (vagy fallback faster-whisper) átirat, ugyanaz mintha a hook
   futtatta volna le.
4. Használd az átiratot szövegként, válaszolj rá normálisan.
5. Ha `transcript` null/üres: valódi STT-hiba (Groq kulcs hiányzik, hang
   sérült, stb.) -- ilyenkor tényleg mondd meg hogy nem sikerült, és kérdezd
   meg lehet-e szövegben.

## Buktatók

- Ha egyszerre TÖBB hangüzenet érkezik mid-turn (pl. Boss egymás után küld
  3-at), mindegyikre KÜLÖN hívd meg a végpontot a saját `file_id`-jével --
  ne csak az utolsóra.
- Ne próbáld a `Read` tool-lal beolvasni a letöltött `.oga` fájlt, az bináris,
  nem ad értelmes szöveget (max a fájlméretről árulkodik).
- A végpont a szerver oldali letöltést + Groq/whisper hívást is elvégzi,
  szóval nem kell előtte `download_attachment`-et hívni -- a `file` paraméter
  elég neki.
- 2026-08-07: pont ez a hiányosság okozott zavart (Boss nem értette miért nem
  jött át 2 hangüzenete), miközben a Groq STT valójában működik, csak a
  hook-időzítés hagyta ki őket. Lásd [[groq-stt-hook-timing]] ha lesz belőle
  külön memória.

## Ellenőrzés

- A curl válasz `transcript` mezője nem null és nem üres.
- A felhasználó tényleges szöveget kap vissza a hangüzenetére, nem
  "nem tudom elolvasni" típusú választ.
