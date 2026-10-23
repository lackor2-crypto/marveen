---
name: browser-control
description: Weboldal megnyitása, kitöltése, szöveg kiolvasása, képernyőkép vagy PDF készítése a Marveen saját (Playwright/Chromium) böngészőjével, a dashboard /api/browser/* végpontjain át. Akkor használd, ha egy feladathoz weboldalt kell ténylegesen böngészni (bejelentkezés mögötti portál, űrlap, oldal PDF-be mentése). A visszafordíthatatlan lépés (küldés, fizetés, törlés) külön végpont és külön megerősítés.
scope: global
---

# Böngésző-vezérlés (Marveen, kártya #165)

A böngésző a dashboard szolgáltatása: EGY hosszabb életű Chromium, tétlenség
után magától leáll. A képesség alapból BE (a tulajdonos a dashboard
**Böngésző** oldalán tudja kikapcsolni). Ha a válasz `code: "disabled"` (valaki
kikapcsolta) vagy `code: "no_chromium"` (még nincs letöltve), NE kerülgesd:
mondd meg {{OWNER_NAME}}nak, hogy a Böngésző oldalon kapcsolja be / töltse le.

```bash
TOKEN=$(cat {{PROJECT_ROOT}}/store/.dashboard-token)
B=http://localhost:{{WEB_PORT}}/api/browser
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
curl -s "${H[@]}" $B/status
```

## Kicsi, egyértelmű műveletek (mind POST, JSON törzs)

| Végpont | Törzs | Mit ad |
|---|---|---|
| `/api/browser/open` | `{"session":"bank"}` vagy `{"session":null}` | böngésző mentett bejelentkezéssel / anélkül |
| `/api/browser/navigate` | `{"url":"https://..."}` | `title`, `url`, `screenshot` (base64 PNG), `sessionExpired` |
| `/api/browser/click` | `{"selector":"text=Tovább"}` | képernyőkép; kockázatos gombnál `needsConfirm:true` |
| `/api/browser/click_xy` | `{"x":420,"y":260}` | kattintás viewport-koordinátára (a képernyőkép pixelei); kockázatos elemnél `needsConfirm:true` |
| `/api/browser/type` | `{"value":"szoveg"}` | a fókuszált mezőbe gépel (előtte kattints a mezőre) |
| `/api/browser/key` | `{"value":"Enter"}` | egy billentyű (Enter, Tab, Backspace, ...) |
| `/api/browser/scroll` | `{"dy":500}` | görgetés függőlegesen (+ le, - fel) |
| `/api/browser/fill` | `{"selector":"#email","value":"..."}` | képernyőkép |
| `/api/browser/wait` | `{"selector":"#lista"}` vagy `{"ms":2000}` | -- |
| `/api/browser/text` | `{"selector":"main"}` (üres = egész oldal) | `text` |
| `/api/browser/screenshot` | `{}` | `screenshot` |
| `/api/browser/pdf` | `{}` | `pdf` (base64) |
| `/api/browser/save_session` | `{"name":"bank"}` | a bejelentkezés titkosítva a Széfbe kerül |
| `/api/browser/stop` | `{}` | leállítja a böngészőt |
| `/api/browser/tabs` | `{}` | a nyitott fülek (index, url, cím) |
| `/api/browser/tab_new` | `{"url":"https://..."}` | új fül (url nélkül üres) |
| `/api/browser/tab_switch` | `{"value":"1"}` | átvált a megadott indexű fülre |
| `/api/browser/tab_close` | `{"value":"1"}` | bezárja (érték nélkül az aktuálisat) |
| `/api/browser/upload` | `{"selector":"input[type=file]","value":"szamla.pdf"}` | feltöltés; a fájl CSAK a `store/browser/uploads/` mappából jöhet, sima fájlnévvel |
| `/api/browser/downloads` | `{}` | a letöltött fájlok (`store/browser/downloads/`) |
| `/api/browser/dialogs` | `{}` | a látott alert/confirm/prompt ablakok |
| `/api/browser/dialog_policy` | `{"value":"accept"}` | alapból `dismiss` (elutasít): a "Törlöd?" elfogadása visszafordíthatatlan lehet, elfogadni csak kifejezett kérésre |
| `/api/browser/clipboard_write` / `clipboard_read` | `{"value":"szöveg"}` / `{}` | vágólap (megnyitott http(s) oldalon) |
| `/api/browser/key` | `{"value":"Control+V"}` | billentyű / gyorsbillentyű |
| `DELETE /api/browser/profile` | - | kijelentkezés mindenhonnan: leállítja a böngészőt és törli a tartós profilt |

Tartós profil (#762): név nélküli `open`/alapértelmezett böngésző egy valódi Chromium-profilt használ (`store/browser/profile/`), tehát a bejelentkezések és sütik újraindítás után is megmaradnak. A mappa titkosítatlan fájl (csak a tulajdonos olvashatja), mentésből és repóból kizárt. Ha egy másik Chromium-folyamat fogja a profilt, a válasz 409 `profile_in_use`. Névvel mentett munkamenet (`open` + `session`) továbbra is külön, a Vaultban titkosított.

## VESZÉLYES művelet: `/api/browser/submit`

Űrlap elküldése / fizetés / törlés. A `submit` (és a kockázatos feliratú
`click`) megerősítés nélkül NEM hajtódik végre: `needsConfirm:true` +
képernyőkép jön vissza. `"confirm":true`-t CSAK akkor küldhetsz, ha
{{OWNER_NAME}} ezt a konkrét lépést kifejezetten jóváhagyta.

## Hibák

- A `error` mező a TÉNYLEGES Playwright-üzenet (timeout, net::ERR_..., selector
  nem található) -- ezt idézd, ne találj ki okot.
- `sessionExpired:true` = a mentett bejelentkezés elszállt (a belépő oldalra
  dobott). Ezt hangosan jelezd, ne adj vissza üres eredményt.
- Nincs mentett munkamenet: az NEM hiba.
