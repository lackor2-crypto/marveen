---
name: fleet-mjs-script-with-vitest
description: Amikor egy uj, onallo scripts/*.mjs fleet-scriptet irsz, aminek van nem-trivialis tiszta logikaja (parse, aggregacio, meres) es unit-tesztet kell ra irni. Hogyan strukturald ugy, hogy importalhato es teszthelheto legyen, es milyen kapukkal ellenorizd landolas elott.
scope: global
---
# Onallo fleet .mjs script vitest-teszttel

## Mikor hasznald
- Uj `scripts/<nev>.mjs` CLI-t irsz (pl. egy meres/monitor/analizis script), aminek
  van tiszta, deterministikus logikaja (JSONL-parse, token-osszegzes, becsles), es
  ezt unit-teszttel kell fedni a projekt vitest suite-jaban.
- A scriptet host-agnosztikusan kell megirni (nem beegetve ut/port/nev).

## Eljaras
1. **Exportald a tiszta segedfuggvenyeket** (`export function ...`) -- a parse,
   osszegzes, becsles, sema-normalizalas legyen mellekhatas-mentes es kulon
   tesztelheto. Az I/O-t (fajlolvasas, fetch) tartsd kulon, es a report-epito
   fuggvenybe INJEKTALD a beolvasot (fuggveny-parameter), hogy fixture-rel
   tesztelheto legyen filesystem nelkul.
2. **A CLI belepot ovd meg**, hogy az import NE futtassa a scriptet:
   ```js
   const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
   if (invokedDirectly) { main().catch(e => { console.error(e.message); process.exitCode = 1 }) }
   ```
   Kulonben a vitest import mellekhatast valt ki / lefuttatja a CLI-t.
3. **Host-agnosztikus config:** projekt-gyoker a script sajat mappajabol
   (`join(dirname(fileURLToPath(import.meta.url)), '..')`), port a `.env`-bol,
   token a `store/.dashboard-token`-bol, transcript `~/.claude/projects`
   (`CLAUDE_CONFIG_DIR`-t is figyelve). Semmi beegetett ertek.
4. **A teszt `.ts`, es a tiszta helpereket a `.mjs`-bol importalja:**
   ```ts
   import { parseUsageText, sumUsage } from '../../scripts/<nev>.mjs'
   ```
   Ez mukodik, es a `tsc --noEmit` is atengedi. Inline fixture-oket epits
   (pl. JSONL sorokat egy helper fuggvennyel), ne olvass a lemezrol.

## Buktatok
- **Beagyazott backtick egy template literalban syntax-hiba** -- pl. egy
  ``console.log(`... `sessions` ...`)`` sor eltori a fajlt. A `tsc --noEmit`
  a `.ts` teszten NEM feltetlenul fogja meg (a `.mjs` maga nem ugyanugy
  tipus-ellenorzott, es a hiba egy stringen belul van). Ezert **kotelezo
  `node --check scripts/<nev>.mjs` landolas elott.**
- **Az import mellekhatas** -- ha nincs `process.argv[1]`-ores, a teszt-import
  elinditja a CLI-t (fetch/exit). Mindig ovd a belepot (2. lepes).
- **A mapped-de-nem-talalt bemenet NEM nulla** -- ha egy bemenet (session,
  fiok, fajl) meg van adva, de nem talalod, azt KULON jelezd a kimenetben, ne
  0-fogyasztaskent (fresh-install-usable: a nulla ket dolgot jelenthet). A
  fresh-install-on ures gyoker eseten kulon mondd ki: "meg nincs" vs "nem
  lattam oda".
- **Turn-onkenti dedup** -- ha Claude Code JSONL `message.usage`-t osszegzel,
  egy tool-hivasos turn tobb sorban ismetli ugyanazt a usage-objektumot;
  `message.id` szerint vond ossze (max per mezo), kulonben ~2x-es inflacio.
  Kanoni logika: `src/web/token-usage.ts` collapseByMessageId.

## Ellenorzes
- `node --check scripts/<nev>.mjs` -> nincs syntax-hiba.
- `npx vitest run src/__tests__/<nev>.test.ts` -> zold.
- `npx tsc --noEmit` -> exit 0.
- CLI smoke: futtasd a fo alparancsot egyszer (pl. help + egy read-only lekerdezes),
  hogy a runtime is bizonyitottan mukodik, ne csak a tesztek.
