---
name: no-freeze-development
description: KÖTELEZŐ minden Marveen-fejlesztésnél, mielőtt szinkron lemez-, hálózati vagy CPU-munkát írsz a dashboard szerver kódjába. Marveennek lassú gépen és lassú meghajtón is működnie kell, és sosem fagyaszthatja le a gépet.
scope: global
---

> Teljes leírás / Full description: Marveen sosem fagyaszthatja le a számítógépet, és lassú gépen is működnie kell. A dashboard fő szálán tilos a szinkron lemez- és CPU-munka.

# Ne fagyaszd le a gépet

Mérés (2026-11-20): a lassú Windows-meghajtón (`/mnt/<betű>`, 9p) egy `stat`/`realpath` ~10 ms. Ezer hívás = 10 másodperc, és ennyi ideig áll a dashboard.

## Mielőtt kódot írsz
1. Fut-e a kód a fő szálon kérésenként (route, időzítő, indulás)? Ha igen, nincs benne szinkron lemezhívás ciklusban.
2. Mennyi hívás lesz sok elemnél? Ha elemenként egy fájlrendszer-hívás van, kell gyorsítótár, vagy aszinkron/háttérmunka, korlátos hívásszámmal.
3. Tilos a fő szálon: `statSync`/`realpathSync`/`readdirSync`/`readFileSync` ciklusban, `scryptSync`, nagy `JSON.parse`, külső program szinkron várása (`execSync`).
4. Az írás után a gyorsítótár eldobása kötelező, hogy a felhasználó azonnal lássa a saját módosítását (példa: `clearProjectPlacesCache`, #949).

## Mérés fejlesztés közben
- `GET /api/perf/stalls` (mi tartotta a főszálat), `GET /api/perf/slow-fs` (melyik mappán hány lemezhívás ment).
- Lassú lemezen is próbáld ki, ne csak gyors SSD-n.

## Javításhoz
Regressziós teszt ugyanabban a commitban (javítás nélkül piros), lásd R40/R42 a `marveen-learned-rules` skillben.
