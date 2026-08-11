# Kontextus-méret figyelő (agens-beszélgetésekhez)

Boss kérése (2026-08-11): legyen egy figyelőrendszer, ami méri, hogy amikor Boss
az agensekkel beszél, mekkora méretű kontextus megy fel a modellhez. Mentsük md-be.

> Állapot: TERV. A kód megírása keret-100% miatt még nem futott. Kanban: 1aad386f
> testvereként külön kártya (lásd lent). Ez a fájl a specifikáció, nem a kész rendszer.

## Mit jelent pontosan

Minden alkalommal, amikor Boss küld egy üzenetet egy agensnek (Telegramon), az
agens következő modell-hívásához felmegy a teljes kontextus: rendszer-prompt +
CLAUDE.md + betöltött skillek + a beszélgetés eddigi története + az új üzenet.
Boss ennek a MÉRETÉT akarja látni fordulónként és agensenként -- mennyi token
megy fel, és hogyan nő a beszélgetés során.

## Mi VAN már meg (adatforrás, ellenőrizve 2026-08-11)

Nem nulláról indulunk. A `store/claudeclaw.db`-ben:

- **`token_usage` tábla (15917 sor):** fordulónkénti bontás. Oszlopok:
  `agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, thinking_tokens, model, content_preview, tool_name,
  task_title, project`.
  - A **felmenő kontextus** fordulónként ≈ `input_tokens + cache_read_tokens +
    cache_creation_tokens` (a cache-elt rész is a kontextus, csak olcsóbban megy
    fel). Ezt kell "mennyi ment fel" alatt érteni, nem csak a nyers input_tokens-t.
- **`contextTokens` (élő mérő):** a `/api/agents` végpont agensenként visszaadja
  az aktuális session-kontextus méretét (pl. mérve most: lackor3 259091, Szakértő
  96868). Ez a pillanatnyi "hol tart a kontextus-ablak" szám, a statusline
  "Ctx %"-a is ebből jön.

## Mi HIÁNYZIK (amit meg kell építeni)

1. **Boss-üzenet -> forduló összekötés.** A `token_usage` nem jelöli, melyik
   fordulót Boss Telegram-üzenete váltotta ki. Kell egy jelölés/korreláció
   (timestamp-egyezés a bejövő Telegram-üzenettel, vagy egy flag), hogy szűrni
   lehessen: "amikor ÉN beszélek vele".
2. **Megjelenítés.** Dashboard-panel: agensenként idővonal a felmenő kontextus
   méretéről, kiemelve a Boss-üzenettel induló fordulókat, és a beszélgetésen
   belüli növekedés (első forduló vs. sokadik).
3. **Riasztás-küszöb (opcionális).** Ha egy beszélgetés kontextusa átlép egy
   határt (pl. 150K, ahol a model-suggest is Opus-t javasol), jelezzen -- ez a
   drágulás/lassulás pontja.
4. **md-export (Boss külön kérte "mentsük md-be"):** a mérés eredménye
   exportálható/menthető md-be is, ne csak a dashboardon éljen.

## Javasolt megközelítés (fork-barát, host-agnostic)

- **Adat:** ne új tárolás, a meglévő `token_usage` tábla aggregálása. A Boss-forduló
  jelöléshez a bejövő Telegram-üzenet timestamp-jét kell a legközelebbi rákövetkező
  `token_usage` sorral párosítani agensenként (a `conversation_log` a fő agensnél
  már megvan; a sub-agens csatornákhoz a párosítás timestamp-alapú).
- **Backend:** egy `/api/context-usage?agent=&since=` végpont, ami a `token_usage`
  aggregátumát adja vissza (fordulónkénti felmenő méret + Boss-flag).
- **Frontend:** külön kártya/panel a dashboardon, HU/EN i18n-nel (kötelező),
  mobil-nézetben is (kötelező, lásd mobile-parity-check).
- **Semmi beégetett azonosító** (host-agnostic-development): agens-id, útvonal,
  port config/.env-ből.

## Eldöntött kérdés (Boss, 2026-08-11)

- A cache-elt részt IS beleszámoljuk a felmenő kontextusba ("szerintem számold
  bele"). Tehát a megjelenített szám = `input_tokens + cache_read_tokens +
  cache_creation_tokens`, a cache-elt részt külön színnel/bontásban jelölve, hogy
  a valódi új szöveg is látszódjon.

## Ellenőrzés (amikor épül)

- HU/EN teljesség (i18n-final-verification skill).
- Mobil-nézet (mobile-parity-check skill).
- A megjelenített szám egyezzen egy agens statusline "Ctx %"-ával egy adott
  pillanatban (kereszt-ellenőrzés az élő mérővel).
