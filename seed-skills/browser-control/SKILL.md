---
name: browser-control
description: Weboldal megnyitása, kitöltése, szöveg kiolvasása, képernyőkép vagy PDF készítése a Marveen saját (Playwright/Chromium) böngészőjével, a dashboard /api/browser/* végpontjain át. Akkor használd, ha egy feladathoz weboldalt kell ténylegesen böngészni (bejelentkezés mögötti portál, űrlap, oldal PDF-be mentése). A visszafordíthatatlan lépés (küldés, fizetés, törlés) külön végpont és külön megerősítés.
scope: global
---

# Böngésző-vezérlés (Marveen, kártya #165)

A böngésző a dashboard szolgáltatása: EGY hosszabb életű Chromium, tétlenség
után magától leáll. A képesség alapból KI -- a tulajdonos a dashboard
**Böngésző** oldalán kapcsolja be. Ha a válasz `code: "disabled"` vagy
`code: "no_chromium"`, NE kerülgesd: mondd meg {{OWNER_NAME}}nak, hogy a
Böngésző oldalon kapcsolja be / töltse le.

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
