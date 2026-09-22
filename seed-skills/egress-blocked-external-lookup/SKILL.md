---
name: egress-blocked-external-lookup
description: Akkor hasznald, ha egy kulso tenyet (ar, hivatalos adat, dokumentacio) kellene lekerned, de a WebFetch vagy a quarantine-reader "Egress TILTOTT" / "domain not on ... allowlist" hibat ad. Megmondja, hogyan add meg a valaszt bizonyitva vagy bizonyitatlanul jelolve, es hogyan kerj ra engedelyt ahelyett, hogy magad irnad at a listat.
scope: global
---
# Kulso adat lekerese, amikor az egress-kapu tilt

## Mikor hasznald

A tulajdonos egy KULSO tenyt ker (havi ar, hivatalos csomagtabla, gyarto
dokumentacio), es a lekeres a kapuba utkozik. A ket konkret hibauzenet:

- `PreToolUse:WebFetch hook error: Egress TILTOTT (egress-gate hook)`
- a `quarantine-reader` sub-agens valasza: `domain not on quarantine-reader fetch allowlist`

Ez NEM hiba a kodban: szandekos kapu. A lista helye: `{{PROJECT_ROOT}}/store/egress-allowlist.json`
(`{"domains":[...]}`).

## Eljaras

1. **Ne ird at magad a listat.** Az allowlist bovitese `permission_change`
   kategoria, ami az autonomia-configban tipikusan level 2 = jovahagyas-koteles.
   Eloszor merd le, ne feltetelezd:
   ```bash
   python3 -c "import json;d=json.load(open('{{PROJECT_ROOT}}/store/autonomy-config.json'));print([c for c in d['categories'] if c['key']=='permission_change'])"
   ```
2. **Kozben szallitsd ki azt, ami a jovahagyas nelkul is megvan.** Keress
   masodlagos forrast (WebSearch a sajtora, gyarto sugo-oldalai, amik esetleg
   engedettek), es a szamot/tenyt ADD MEG -- de kulon mondatban mondd ki, hogy
   ez NEM a hivatalos forrasbol van, es miert nem tudtad ellenorizni.
   A "legutobb X volt" es az "X" ket kulonbozo mondat.
3. **Terheld meg a valoszinuseget mereskel, ne erzessel.** Pl. arnal: van-e
   tobb, egymastol fuggetlen forras ugyanarra a szamra; szerepel-e az orszag a
   gyarto aremelesi kozlemenyeiben. Ezeket ird le, hogy a tulajdonos maga is
   tudja mertekelni.
4. **Kerj jovahagyast, egy konkret domain-listaval es indokkal:**
   ```bash
   curl -s -X POST http://localhost:{{WEB_PORT}}/api/approvals \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat {{PROJECT_ROOT}}/store/.dashboard-token)" \
     -d '{"agent_id":"<sajat-id>","category":"permission_change","action_description":"<mely domain, mire, miert visszafordithato>","timeout_seconds":3600}'
   ```
   A leirasba ird bele a kapcsolodo kartya azonositojat is -- a jovahagyas-kereso
   a leirasban keres.
5. **Ajanlj masodik utat is**, ami nem igenyel engedelyt: a tulajdonos kuldhet
   kepernyokepet a hivatalos oldalrol. Sokszor ez gyorsabb, mint a jovahagyas.
6. Jovahagyas utan vedd fel a domaint, kerd le, **majd mondd meg, ha a lekert
   oldal nem adott hasznalhato adatot** (lasd Buktatok), es ha mar nem kell,
   vedd ki a listabol.

## Buktatok

- **A JS-bol rajzolt oldal ures marad.** Sok arlista (pl. csomag-valaszto
  oldalak) bongeszoben szamolja ki a szamokat; a nyers lekeres HTML-je nem
  tartalmazza az arat. Ha ez tortenik, NE kovetkeztess a hianybol -- mondd meg,
  hogy az oldal nem adott szoveges arat, es ajanld a kepernyokepet vagy a
  bongeszo-automatizalast (az utobbi kulon szabalyokhoz kotott).
- **A WebSearch `allowed_domains` is tud elbukni**, sajat hibauzenettel:
  `The following domains are not accessible to our user agent: ['<domain>']`.
  Ilyenkor vedd ki azt az egy domaint a listabol es futtasd ujra -- ne a teljes
  keresest dobd el.
- **A tulajdonos a szamot akarja, nem a magyarazatot.** Valos korrekcio:
  "jo sokat dumaltal, de a lenyeget meg mindig nem tudom". Az elso sorban
  alljon a konkret szam/tablazat, a forras es a bizonytalansag UTANA jojjon.
- **Az evszam szamit.** Ha a tulajdonos kimondja, hogy "most, nem 2021-ben",
  akkor a talalat datumat is ellenorizd, es ird ki, melyik evbol valo a forras.

## Ellenorzes

- A valasz elso sora tartalmaz konkret szamot vagy tenyt.
- Kulon mondat mondja ki, bizonyitott-e vagy sem, es melyik forrasbol.
- Ha jovahagyast kertel, a valaszban ott a jovahagyas azonositoja es az, hogy
  mi tortenik utana.
- Az `store/egress-allowlist.json` fajlt NEM modositottad engedely nelkul:
  ```bash
  cd {{PROJECT_ROOT}} && git status --porcelain store/egress-allowlist.json
  ```

## Kapcsolodo

- `approval-request-handling` -- a masik oldal: mit csinal a fo-agens, amikor a
  jovahagyas-keresed megerkezik hozza.
