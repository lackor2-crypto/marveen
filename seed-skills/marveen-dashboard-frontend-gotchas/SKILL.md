---
name: marveen-dashboard-frontend-gotchas
description: Ismert buktatók a Marveen dashboard vanilla JS/CSS frontendjén (web/app.js, web/style.css, web/index.html) -- a `hidden` attribútum csendes felülírása, DOM-elem újraszülőzés amikor egy másik függvény insertBefore-referenciaként használja, grid-divider minták. Nézd át MIELŐTT egy agent-kártya/lista/rács jellegű UI-t módosítasz.
scope: global
---

# Marveen dashboard frontend -- ismert buktatók

## Mikor használd

Bármikor a `web/app.js`/`web/style.css`/`web/index.html` UI-t módosítod,
különösen ha: (1) egy elemet dinamikusan el akarsz rejteni/megjeleníteni,
(2) egy meglévő DOM-elemet más helyre akarsz mozgatni (re-parent), (3) egy
rács-/lista-nézetet két csoportra akarsz bontani (pl. vizuális elválasztó).

## Buktatók

### 1. A `hidden` HTML attribútum NEM garantáltan rejt el semmit

A böngésző alapértelmezett `[hidden] { display: none }` szabálya NEM
`!important`. Ha az elemnek van BÁRMILYEN class-alapú CSS szabálya ami
explicit `display`-t állít be (pl. `.agent-card { display: flex; }`), az a
szabály CSENDBEN felülírja a `hidden` attribútumot -- az elem simán
látszik tovább, semmilyen hibaüzenet nincs, és a `Ctrl+F5`/cache-törlés
sem segít (2026-08-08: órákig kerestük a "cache-hibát", ami valójában ez
volt).

**Megoldás:** ha egy elemet `hidden` attribútummal akarsz rejteni, és az
elemnek van saját `display`-t állító class-a, adj hozzá egy explicit
felülíró szabályt:
```css
#elemId[hidden] { display: none !important; }
```
Vagy egyszerűbben: ne a `hidden` attribútumra hagyatkozz, hanem egy saját
class-szal (`.is-hidden { display: none !important; }`) rejtsd el.

### 2. DOM-elem újraszülőzése eltörheti a MÁSIK függvény `insertBefore`-referenciáját

Ha egy elemet (pl. egy "+ új elem" gombot) egy render-függvény ismételten
`insertBefore(newNode, referenceNode)` mintával használ REFERENCIAKÉNT
(ahol `referenceNode` egy fix, mindig-jelenlévő elem, mint egy "+ hozzáadás"
gomb), és egy KÉSŐBBI kód-rész ezt a referenceNode-ot egy MÁSIK elem
GYERMEKÉVE teszi (pl. `divider.appendChild(addBtn)` egy vizuális
elválasztóhoz), akkor a KÖVETKEZŐ render-körben `insertBefore(x, addBtn)`
**DOMException-t dob** (`NotFoundError: the node before which the new node
is to be inserted is not a child of this node`), mert `addBtn` már nem
direkt gyereke annak a konténernek amin az `insertBefore`-t hívod.

Ez CSENDES, katasztrofális hibát okoz: a render-függvény a hiba helyén
megszakad, és minden utána következő elem (pl. az összes agent-kártya)
egyszerűen NEM jön létre -- 2026-08-08: ez törölte ki az egész Ügynökök
rácsot, csak a "+ új ügynök" gomb maradt látszódva.

**Megoldás:** minden render-függvény ELEJÉN, mielőtt bármilyen
`insertBefore(x, referenceNode)` hívás történne, garantáld hogy
`referenceNode` direkt gyereke a konténernek:
```js
container.appendChild(referenceNode)  // visszahozza, ha korábban elköltözött
container.querySelectorAll('.stale-wrapper-class').forEach(el => el.remove())
```
majd csak EZUTÁN építsd újra a listát, és csak a render-függvény LEGVÉGÉN
told el `referenceNode`-ot a végleges helyére (ha kell).

### 3. Rács-nézet két csoportra bontása vizuális elválasztóval (pl. fizetős/ingyenes)

Bevált minta (lásd `.agent-tier-divider` a style.css-ben): egy CSS grid
gyerekelem `grid-column: 1 / -1`-gyel teljes szélességben átível a rácson,
így egy hard-break-ként olvasható, nem csak egy újabb celleként. Flex
list-eknél (nem grid) ugyanez a class simán működik, a `grid-column` csak
figyelmen kívül marad, ártalmatlanul.

Ha egy gombot/interaktív elemet magára a vonalra akarsz tenni (fele-fele
átlógással mindkét szekcióba), tedd az elválasztó elem GYERMEKÉVE, és
`position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%)`-val
középre. VIGYÁZZ: ha az elemnek van saját `:hover` transform-szabálya
MÁSHOL (pl. `.agent-card:hover { transform: translateY(-2px) }`), az
egyenlő specificitásnál felülírja (nem összeadja!) a centering transform-ot
-- hover-re "elugrik" a helyéről. Írj egy dedikált, magasabb specificitású
hover-szabályt ami a teljes transform-láncot (`translate(-50%,-50%)
translateY(-2px)`) tartalmazza.

### 4. Kereső/szűrő input, ami csak `submit`-re reagál, "teljesen halottnak" tűnik

Ha egy `<input>`-hoz csak a form `submit` eseményét (Enter / gomb) kötöd be,
{{OWNER_NAME}} élő/inkrementális szűrést vár (Gmail-szerű: gépelés közben szűkül a
lista) -- gépelés közben semmi nem történik, és ő ezt "nem működik, ki
próbáltam" jelentésként küldi be, még ha a backend maga (pl. himalaya
`envelope search`) helyesen működik is. 2026-08-09: az email-keresőnél a
szerver oldal első próbálkozásra jól visszaadta a találatokat curl-lel
tesztelve, a hiba kizárólag a frontendben volt (nincs `input`-listener).

**Megoldás:** a `submit` listener MELLÉ (nem helyette) tégy egy debounce-olt
`input` listenert, ami a valós hálózati hívást (nem ingyenes memória-szűrés)
~250-300ms után indítja csak el, hogy ne terhelje túl a backendet minden
billentyűleütésnél:
```js
let searchDebounceTimer = null
input.addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer)
  const value = e.currentTarget.value
  searchDebounceTimer = setTimeout(() => applyQuery(value), 300)
})
```

### 5. `web/app.js`-t/CSS-t módosítottál, de a böngésző 24 órára cache-eli

A statikus asset-ek (`src/web/routes/static.ts`) `Cache-Control: private,
max-age=86400`-zal mennek ki (`serveFile(..., { cacheSeconds: 86400 })`) --
egy szerver-oldali fájlmódosítás AZONNAL hatályos (nincs build-lépés, disk-ről
olvas kérésenként), de {{OWNER_NAME}} böngészője simán visszaadhatja a 24 órával
korábbi cache-elt verziót F5-re is. **Mielőtt {{OWNER_NAME}}-nak jelented hogy "kész,
próbáld ki", mondd meg neki hogy kemény frissítés (Ctrl+Shift+R) kell** --
különben ő egy még-mindig-hibás oldalt fog látni és azt hiszi a javítás nem
ment át.

## Ellenőrzés

- Egy elrejtett elem TÉNYLEG nem látszik a végleges renderelt oldalon
  (nem csak DOM-ban `hidden=true`, hanem `getComputedStyle(el).display`
  is `none`).
- Két egymást követő render-hívás (pl. F5 majd egy adatfrissülés) UGYANAZT
  az eredményt adja, nincs "második körtől eltűnik minden" hiba.
- Böngésző konzolban nincs `NotFoundError`/`DOMException` a render során.
