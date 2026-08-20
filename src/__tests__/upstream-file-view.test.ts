// A "Mi valtozott az upstreamben?" fajl-nezet felulet-szerzodese.
//
// Boss, 2026-08-20: "A mi valtozott tetel lista gomb nem mukodik." A gomb es a
// kiszolgalo is jo volt; a lista NEM latszott. Valodi bongeszoben lemerve a
// modal .active lett, 112 sort ki is rajzolt -- de a Kapcsolatok oldal
// belsejeben allt, az pedig display:none, amig nem az az aktiv oldal. Egy
// display:none szulo alatt a legszebb modal is lathatatlan.
//
// Az itteni allitasok mind egy-egy MERT hibat rogzitenek:
//   1. a modal helye (rejtett szulo),
//   2. a modal magassaga (11419 px magas tartalom egy fuggolegesen kozepre
//      igazito overlay-ben: a fejlec es a fulek a kepernyo FOLE csusztak),
//   3. a "csak osszefesuleskor valtozott" mondat, ami hianyzo forditasnal is
//      kijott (azaz allitott valamit, ami nem volt igaz),
//   4. a bedrotozott commit-kategoria lista,
//   5. a nem letezo CSS szinvaltozok (a bongeszo ilyenkor eldobja a szabalyt).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const cssRaw = readFileSync(join(WEB, 'style.css'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')
// A kommentek nelkuli valtozat: egy magyarazo sor, ami IDEZI a regi hibas
// alakot, nem buktathatja meg a javitast.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')

/** Egy fuggveny torzse, kapcsos zarojel szerint kivagva. */
function fnBody(decl: string): string {
  const start = app.indexOf(decl)
  expect(start, `${decl} nincs a web/app.js-ben`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1)
  }
  throw new Error(`parositatlan kapcsos zarojel: ${decl}`)
}

/** Egy `selector { ... }` szabaly torzse a stiluslapbol. */
function ruleBody(selector: string): string | null {
  const idx = css.indexOf(selector)
  if (idx < 0) return null
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return css.slice(open + 1, close)
}

describe('upstream fajl-nezet: a modal a body-n all', () => {
  it('a modal a </main> UTAN van, nem egy oldal belsejeben', () => {
    const mainEnd = html.indexOf('</main>')
    const modal = html.indexOf('id="upstreamChangesModal"')
    expect(mainEnd, 'nincs </main> a web/index.html-ben').toBeGreaterThan(-1)
    expect(modal, 'nincs upstreamChangesModal a web/index.html-ben').toBeGreaterThan(-1)
    // Ez a sorrend a lenyeg: a <main>-en belul minden .page display:none, amig
    // nem az az aktiv oldal, es a modalt az ATTEKINTES oldal gombja nyitja.
    expect(modal).toBeGreaterThan(mainEnd)
  })

  it('a gomb, ami megnyitja, tenyleg egy masik oldalon van', () => {
    // Ha ez valaha megvaltozna (a gomb a Kapcsolatok oldalra kerulne), a fenti
    // allitas indoka szunne meg -- akkor is helyes marad, de tudni kell rola.
    expect(html).toContain('id="overviewUpstreamChangesBtn"')
    const btn = html.indexOf('id="overviewUpstreamChangesBtn"')
    const mainEnd = html.indexOf('</main>')
    expect(btn).toBeLessThan(mainEnd)
  })
})

describe('upstream fajl-nezet: a modal elfer a kepernyon', () => {
  // 191 fajlsor eseten a tartalom 11419 px magas volt (merve), a fejlec teteje
  // -5349 px-en allt: a cim, a bezaro gomb, a ket ful es a kereso a kepernyo
  // fole kerult. Odagorgetni nem lehetett, mert az overlay position:fixed.
  it('van max-height a modalon', () => {
    const body = ruleBody('.upstream-changes-modal {')
    expect(body, '.upstream-changes-modal szabaly nincs a web/style.css-ben').not.toBeNull()
    expect(body!).toMatch(/max-height\s*:/)
    expect(body!).toMatch(/flex-direction\s*:\s*column/)
  })

  it('a lista gordul belul, nem a modal no meg', () => {
    const body = ruleBody('.upstream-changes-modal #upstreamChangesBody {')
    expect(body, 'nincs belso gorgeteses kontener a listahoz').not.toBeNull()
    expect(body!).toMatch(/overflow-y\s*:\s*auto/)
    // min-height:0 nelkul egy flex-elem nem zsugorodik a tartalma ala, tehat a
    // gorgetes soha nem indulna el.
    expect(body!).toMatch(/min-height\s*:\s*0/)
  })
})

describe('upstreamFileRow', () => {
  const body = fnBody('function upstreamFileRow(')

  it('a "csak osszefesuleskor valtozott" mondat CSAK ures commit-listanal jelenik meg', () => {
    expect(body).toMatch(/shas\.length === 0/)
    // A regi alak a MEGJELENITHETO MONDATOK uressegehez kototte a mondatot,
    // vagyis egy meg le nem forditott commit eseten is azt allitotta, hogy a
    // fajlhoz nem tartozik commit. Ez nem hianyos informacio volt, hanem hamis.
    expect(body).not.toMatch(/:\s*`<div class="upstream-file-merge">/)
  })

  it('a "+N tovabbi" szam a meglevo mondatokbol szamol, nem a commitokbol', () => {
    // shas.slice(0,3) mellett a 3 kivalasztott commitbol nehany magyar szoveg
    // nelkul is lehet: ilyenkor kevesebb sor latszott, a "+N tovabbi" viszont
    // a teljes commit-szamhoz kepest szamolt, tehat rossz szamot mutatott.
    expect(body).not.toMatch(/shas\.slice\(0,\s*3\)/)
    expect(body).toMatch(/mondatok\.slice\(0,\s*3\)/)
  })
})

describe('renderUpstreamFiles', () => {
  const body = fnBody('function renderUpstreamFiles(')

  it('a commit-kategoriakat a szervertol kapott kulcsokbol olvassa', () => {
    // Bedrotozott listaval egy jovobeli negyedik kategoria commitjai csendben
    // kimaradnanak, es a hozzajuk tartozo fajlok magyarazat nelkul allnanak --
    // pont az az allapot, ami miatt ez a nezet keszult.
    expect(body).toContain('Object.keys(data.groups')
    expect(body).not.toMatch(/\['javitas',\s*'fejlesztes',\s*'egyeb'\]/)
  })
})

describe('a fajl-nezet szovegei mindket nyelven megvannak', () => {
  const kulcsok = [
    'upstream.view.changes', 'upstream.view.files',
    'upstream.files.intro', 'upstream.files.conflicting', 'upstream.files.clean',
    'upstream.files.more', 'upstream.files.merge_only', 'upstream.files.pending',
    'app.updated.text', 'app.updated.btn',
  ]
  it.each(kulcsok)('%s', (kulcs) => {
    expect(app, `${kulcs} nincs hasznalva a web/app.js-ben`).toContain(kulcs)
    expect(hu, `${kulcs} hianyzik a magyar szotarbol`).toContain(`'${kulcs}'`)
    expect(en, `${kulcs} hianyzik az angol szotarbol`).toContain(`'${kulcs}'`)
  })
})

describe('CSS: minden hivatkozott szinvaltozo letezik', () => {
  // Marvin uj szabalyai --fg / --muted / --ok / --warn / --warn-bg /
  // --danger-bg / --bg-hover nevekre hivatkoztak; a paletta viszont --text /
  // --text-muted / --success / --info / --info-soft / --danger-soft /
  // --bg-card-hover neven definialja oket. Definialatlan valtozonal a bongeszo
  // ELDOBJA az egesz deklaraciot: a "halvany" sor a szulo szinet orokli, a
  // hatter atlatszo lesz. Semmi nem jelez hibat -- csak nem ugy nez ki.
  it('nincs var(--x) definialatlan valtozora, fallback nelkul', () => {
    const defined = new Set<string>()
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
    // A JS is definialhat valtozot futasidoben: style.setProperty('--chip-color')
    // vagy inline style="--prio-color:...". Ezek nem hianyzo definiciok.
    for (const m of app.matchAll(/setProperty\('(--[\w-]+)'/g)) defined.add(m[1])
    for (const m of app.matchAll(/style="\s*(--[\w-]+)/g)) defined.add(m[1])

    const missing = new Set<string>()
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      // A vesszo utan fallback all: az a szabaly ervenyes marad.
      if (m[2] === ')' && !defined.has(m[1])) missing.add(m[1])
    }
    expect([...missing].sort()).toEqual([])
  })
})
