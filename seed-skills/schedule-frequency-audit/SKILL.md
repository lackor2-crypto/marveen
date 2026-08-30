---
name: schedule-frequency-audit
description: {{OWNER_NAME}} arra kér, hogy nézd át/ritkítsd az ütemezett feladatokat (~/.claude/scheduled-tasks/), mert sok/gyakori automatizálás fut, vagy session-limitbe ütköztünk. Feltárja a leírás-vs-cron eltéréseket és a duplikált gyakoriságokat.
scope: global
---

# Ütemezett feladatok gyakoriság-audit

## Mikor használd

- {{OWNER_NAME}} panaszkodik hogy sokat fogyott a session-limit / túl sok háttér-aktivitás fut.
- {{OWNER_NAME}} kifejezetten kéri: "nézd át az ütemezéseket, ritkítsd ami nem fontos".
- Új heartbeat/scheduled-task hozzáadása előtt (megelőzésképp: nem lesz-e duplikált egy meglévővel).

## Eljárás

1. Listázd az összes task-configot:
   ```bash
   for d in ~/.claude/scheduled-tasks/*/; do
     echo "=== $(basename "$d") ==="
     cat "$d/task-config.json"
   done
   ```
2. Nézd meg mindegyik SKILL.md leírását is -- a `description` mező gyakran
   ELTÉR a tényleges cron-tól (pl. "30 percenként" szöveg, de a cron
   ténylegesen `*/15 * * * *`). Ez konkrét, néma hiba: a leírás és a
   beállítás szétcsúszott valamikor egy korábbi szerkesztésnél.
3. Csoportosítsd gyakoriság szerint. Ha KETTŐ VAGY TÖBB `type: heartbeat`
   task ugyanazon a percenkénti/óránkénti ütemen fut (pl. mindkettő
   `*/15 * * * *`), az duplázza a heartbeat-terhelést minden körben --
   ez volt a 2026-08-07-i session-limit-túllépés fő oka.
4. Minden feladatnál mérlegeld: időérzékeny-e a funkciója?
   - IGEN (pl. "van-e meeting 1 órán belül" sürgősség-check) -> maradjon
     gyakori, de a check-ablak (pl. "1 órán belüli", "az elmúlt órában")
     mindig legyen SZÉLESEBB mint az ellenőrzési köz, így az ablak
     lefedettsége teljes marad ritkább ellenőrzés mellett is (pl. 30 perces
     köz + 60 perces ablak = semmi nem csúszhat át a résen, csak késleltetve
     derül ki).
   - NEM (memória-összegzés, skill-reflexió, napi/heti riport) -> nyugodtan
     ritkítható óránkénti/napi szintre, nincs érdemi funkcióvesztés.
5. A `~/.claude/scheduled-tasks/<nev>/task-config.json` `schedule` mezeje
   szabadon szerkeszthető (Edit tool) -- ez gitignore-olt, per-install fájl,
   NEM esik a Marveen-kód-módosítás STOP-szabálya alá.
6. Jelentsd a tulajdonosnak ({{OWNER_NAME}}) tömören: mit találtál (különösen a leírás-vs-cron
   eltéréseket, mert azok VALÓDI hibák, nem csak optimalizálás), mit
   változtattál, és miért nem veszít funkcionalitást a ritkítás.

## Buktatók

- Ne ritkíts vakon mindent egyformán -- a sürgősség-érzékeny check-ek
  (meeting/email/határidő) és a háttér-adminisztráció (memória, skill-tanulás)
  más-más toleranciát bírnak.
- A cron `*/N * * * *` minta helyett kerüld a kerek `0`/`30` perceket ha
  más feladat is ott fut ugyanabban a percben (pl. `12 * * * *` a `0 8,12,...`
  helyett), hogy ne torlódjanak egy pillanatra.
- A `description` mezőben írt szöveg NEM vezérel semmit, csak dokumentáció --
  ha eltér a cronétól, az konkrétan azt jelenti hogy valaki korábban
  módosította a cront a leírás frissítése nélkül. Mindkettőt szinkronba kell
  hozni, ne csak a cront.

## Ellenőrzés

- `cat ~/.claude/scheduled-tasks/<nev>/task-config.json` a módosítás után
  visszaadja az új `schedule` értéket.
- A SKILL.md leírás (ha van benne konkrét időintervallum-szöveg) egyezik a
  tényleges cronnal.
- {{OWNER_NAME}} kapott egy rövid, konkrét összefoglalót (mi változott, mennyivel
  csökken a terhelés, miért nem veszít funkcióból).
