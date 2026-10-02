---
name: isolated-web-only-instance-browser-test
description: Fejlesztett dashboard-funkció kipróbálása böngészőben (Playwright) egy KÜLÖN, üres adatú web-only példányon, az élő rendszer érintése nélkül. Akkor használd, ha egy ellenőrzés "böngészős próbát" kér, vagy egy UI-funkciót valódi oldalon kell végigvinni.
scope: global
---

# Böngészős próba külön, üres példányon

## Mikor használd
Egy kártya UI-funkcióját a felületen is ki kell próbálni (nem csak a source-contract
teszttel), és az élő dashboardhoz, az élő adatokhoz nem szabad nyúlni. A kifogás
"kockázatos, ezért kihagyom" NEM elég: Boss ezt visszakérdezte (2026-10-02, #460).
Ez az eljárás a kockázatot szűkíti, a próbát nem hagyja ki.

## Eljárás
1. Izolált worktree: `scripts/agent-worktree.sh <nev>` (a `store/` a worktree-é, üres, tehát friss telepítés).
2. Tesztadat egy ideiglenes raktárba: `D=<scratch>/depot; mkdir -p $D/Projektek/teszt`, benne a médiafájlok (ffmpeg `testsrc` / `sine`).
3. Példány indítása, KÜLÖN porton, csak a web-réteggel (nincs ágens-indítás, router, wake-watcher):
   `MARVEEN_DEPOT=$D WEB_ONLY=true WEB_PORT=3499 npx tsx -e "Promise.all([import('./src/db.ts'),import('./src/web.ts')]).then(([d,m])=>{d.initDatabase();m.startWebServer(3499)})"`
   Az `initDatabase()` nélkül minden DB-s route `Cannot read properties of undefined (reading 'exec')`-et ad.
4. Token: a worktree `store/.dashboard-token` fájlja; belépés `http://127.0.0.1:3499/?token=...#projects`.
5. Adat: projekt `POST /api/projects`, mappa `PUT /api/projects/<id>` (`folder_path`), munkadarab a tesztekkel azonos módon `createWorkItem()`-mel egy tsx-szkriptből.
6. Playwright (a worktree `node_modules/playwright`), szkript a scratch-könyvtárba. Képernyőképet nézz meg, ne csak a logot.
7. A végén: `lsof -ti :3499 | xargs -r kill` (CSAK a saját port), worktree eltávolítás, a raktár és a logok törlése.

## Buktatók
- Az első indításkor megjelenik a "Marveen beállítása" varázsló modal: `Escape` zárja.
- A szám- és szövegmezők `readonly` + `data-af-locked` állapotúak, amíg rájuk nem kattintasz (böngésző-kitöltés elleni védelem). A Playwright `fill()` ezen 30 mp-et vár és elbukik: `click()` + `Control+A` + `keyboard.type()` kell. Ez nem hiba az alkalmazásban.
- A sidebar csoportjai összecsukottak, a menüpontra `click()` nem megy: `location.hash='#projects'`.
- A `window.prompt()` (pl. vágás ideje) a Playwrightnál `page.on('dialog', d => d.accept('2'))`.
- Állapot-újrahasználatnál egy no-op művelet (pl. már beállított képarány) nem ír vissza-vonási lépést: a visszavonás-próbát két KÜLÖNBÖZŐ értékkel végezd.
- Ha a port foglalt, a szerver megpróbálja felszabadítani: ellenőrizd, hogy a régi példányodat állítottad le (a `pkill -f` mintája nem biztos, hogy illeszkedik, a `lsof -ti :<port>` biztos).
- A teljes suite ugyanígy futtatható izoláltan: `nice -n 19 npx vitest run --maxWorkers=2 > <scratch>/full.log 2>&1 &` (860 fájl ~9,5 perc).

## Ellenőrzés
- Minden lépésre `OK`/`FAIL` sor, `pageerror` számláló 0, és a kimenetet mérd (pl. `ffprobe` a renderelt videóra), ne a gomb állapotából következtess.
- A jelentésben nevezd meg, mit NEM mértél (telefonos nézet, stb.).
