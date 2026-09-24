---
name: card-reference-by-number
description: Amikor kanban kártyát nevezel meg (Telegram, komment, commit, PR, jelentés, másik ágensnek küldött üzenet), MINDIG a kártya sorszámát írd (#369), ne a 8 karakteres belső azonosítót. A tulajdonos a táblán a sorszámot látja.
scope: global
---

# Kártyára mindig a sorszámával hivatkozz (#N)

## Mikor használd
Minden olyan szövegben, amiben egy kanban kártya szerepel: kész-jelzés,
haladási üzenet, kanban-komment, commit-üzenet, PR-cím, napi napló,
inter-agent üzenet.

## Eljárás
1. Ha csak a belső azonosítód van (pl. `27410f1b`), kérdezd le a sorszámot:
   ```bash
   curl -s -H "Authorization: Bearer $(cat {{PROJECT_ROOT}}/store/.dashboard-token)" \
     http://localhost:{{WEB_PORT}}/api/kanban | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const c of JSON.parse(d))if(c.id.startsWith(process.argv[1]))console.log("#"+c.seq,c.title)})' 27410f1b
   ```
   vagy az adatbázisból: `sqlite3 store/claudeclaw.db "select rowid from kanban_cards where id like '27410f1b%'"`.
2. A szövegbe a sorszám megy: `#369`.
3. Ha egy parancshoz vagy másik ágenshez a belső azonosító is kell, az csak
   zárójelben, a sorszám UTÁN állhat: `#369 (27410f1b)`.

## Buktatók
- A csupasz belső azonosító a tulajdonosnak értelmezhetetlen: nem tudja, melyik
  kártyáról van szó, és nem is keres rá. Ugyanaz a hiba, mint amikor egy commit
  hash-t írt be a kanban-keresőbe.
- A sorszámot ne emlékezetből írd: kérdezd le, mielőtt kiírod.

## Ellenőrzés
- Az elküldött szövegben minden kártya-hivatkozás `#<szám>` alakú; 8
  karakteres azonosító legfeljebb zárójelben, egy `#<szám>` után áll.
